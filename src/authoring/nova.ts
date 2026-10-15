// Live Nova boundary: one forced tool call per request, server-side credentials only, every call reserved and settled
// in a ledger that enforces the owner's live authorization (count and dollar caps). Never retries.
// Two ledgers, one contract: the append-only JSONL file (local runs; the owner's spending record since M2) and KvLedger
// (the deployed service: DynamoDB counters reserved atomically across Lambda instances, with per-workspace allowances).
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WriteConflict, wsPk, type Item, type Kv, type Op } from '../service/kv.ts';

export const NOVA = { modelId: 'us.amazon.nova-2-lite-v1:0', region: 'us-east-1', profile: 'coursecorrect-nova', expectedUser: 'coursecorrect-nova' } as const;
/** On-demand list price used in the old project's ledger (AWS Price List API, 2026-09-29). Estimates only. */
export const PRICE = { inputPer1K: 0.00033, outputPer1K: 0.00275 } as const;
export const estimateUsd = (inTok: number, outTok: number) => (inTok * PRICE.inputPer1K + outTok * PRICE.outputPer1K) / 1000;

/** `ocr`: Amazon Textract DetectDocumentText (text only), priced per page (src/authoring/ocr.ts). */
export type Purpose = 'extraction' | 'interpretation' | 'speech' | 'explanation' | 'swapAnalysis' | 'ocr';
export const PURPOSES: Purpose[] = ['extraction', 'interpretation', 'speech', 'explanation', 'swapAnalysis', 'ocr'];
export interface Authorization {
  id: string; grantedBy: string; at: string;
  maxCalls: Partial<Record<Purpose, number>>; maxUsd: number; projectCeilingUsd: number; priorProjectUsd: number;
  /** A dollar cap for one purpose inside maxUsd (e.g. OCR's share of a commission's allowance). */
  maxUsdByPurpose?: Partial<Record<Purpose, number>>;
  /** Local runs: the AWS CLI profile live calls use. Deployed: absent (the function's execution role). */
  profile?: string;
  /** Deployed: each workspace's allowance under this authorization (both caps apply; the global ones still bind). */
  perWorkspace?: { maxCalls: Partial<Record<Purpose, number>>; maxUsd: number };
  /** Deployed: new workspaces (sign-ins and resets) per UTC day. */
  maxNewWorkspacesPerDay?: number;
  /** Deployed: the owner's stop. Every reservation is refused while true. */
  paused?: boolean;
}
interface Entry { at: string; key: string; kind: 'reserve' | 'settle' | 'failed'; purpose: Purpose; usd: number; authorization: string; label: string; inputTokens?: number; outputTokens?: number; characters?: number }
export class BudgetExceeded extends Error {}
/** Which workspace a live call is spent for (set by the HTTP layer and the import worker; read by KvLedger). */
export const spender = new AsyncLocalStorage<string>();

/** What NovaClient and Speaker need from a ledger. A failed call keeps its reservation; a settle replaces it. */
export interface SpendLedger {
  readonly auth: { id: string; profile?: string };
  reserve(purpose: Purpose, key: string, usd: number, label: string): void | Promise<void>;
  settle(purpose: Purpose, key: string, inputTokens: number, outputTokens: number, label: string): void | Promise<void>;
  settleChars(purpose: Purpose, key: string, characters: number, usd: number, label: string): void | Promise<void>;
  failed(purpose: Purpose, key: string, label: string): void | Promise<void>;
  /** The service refused the request before doing any work (Bedrock ThrottlingException: AWS bills no tokens): settled at $0,
   *  with the reason kept on the record. Any other failure keeps its reservation in full (failed). */
  refused(purpose: Purpose, key: string, reason: string): void | Promise<void>;
}

/** Append-only JSONL ledger. A reservation without settlement counts in full; a failed call keeps its reservation. */
export class Ledger implements SpendLedger {
  readonly path: string; readonly auth: Authorization;
  constructor(path: string, auth: Authorization) { this.path = path; this.auth = auth; mkdirSync(dirname(path), { recursive: true }); }
  entries(): Entry[] { try { return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry); } catch { return []; } }
  totals() {
    const byKey = new Map<string, { purpose: Purpose; reserve: number; settle: number | null; auth: string }>();
    for (const e of this.entries()) {
      const x = byKey.get(e.key) ?? { purpose: e.purpose, reserve: 0, settle: null, auth: e.authorization };
      if (e.kind === 'reserve') x.reserve += e.usd; else if (e.kind === 'settle') x.settle = (x.settle ?? 0) + e.usd;
      byKey.set(e.key, x);
    }
    const mine = [...byKey.values()].filter((x) => x.auth === this.auth.id);
    const usd = (xs: typeof mine) => xs.reduce((s, x) => s + (x.settle ?? x.reserve), 0);
    return {
      authorizationUsd: usd(mine), allLedgerUsd: usd([...byKey.values()]),
      usdBy: Object.fromEntries(PURPOSES.map((p) => [p, usd(mine.filter((x) => x.purpose === p))])) as Record<Purpose, number>,
      calls: Object.fromEntries(PURPOSES.map((p) => [p, mine.filter((x) => x.purpose === p).length])) as Record<Purpose, number>,
    };
  }
  reserve(purpose: Purpose, key: string, usd: number, label: string) {
    const t = this.totals();
    const cap = this.auth.maxCalls[purpose] ?? 0;   // a purpose the authorization doesn't name is not authorized
    if (t.calls[purpose] + 1 > cap) throw new BudgetExceeded(`${purpose} call cap ${cap} reached`);
    if (t.authorizationUsd + usd > this.auth.maxUsd) throw new BudgetExceeded(`reservation would exceed $${this.auth.maxUsd} authorization`);
    const pcap = this.auth.maxUsdByPurpose?.[purpose];
    if (pcap !== undefined && t.usdBy[purpose] + usd > pcap) throw new BudgetExceeded(`reservation would exceed the $${pcap} ${purpose} allowance`);
    if (this.auth.priorProjectUsd + t.allLedgerUsd + usd > this.auth.projectCeilingUsd) throw new BudgetExceeded('reservation would exceed the project ceiling');
    this.write({ at: new Date().toISOString(), key, kind: 'reserve', purpose, usd, authorization: this.auth.id, label });
  }
  settle(purpose: Purpose, key: string, inputTokens: number, outputTokens: number, label: string) {
    this.write({ at: new Date().toISOString(), key, kind: 'settle', purpose, usd: estimateUsd(inputTokens, outputTokens), authorization: this.auth.id, label, inputTokens, outputTokens });
  }
  /** Character-priced services (Polly). */
  settleChars(purpose: Purpose, key: string, characters: number, usd: number, label: string) {
    this.write({ at: new Date().toISOString(), key, kind: 'settle', purpose, usd, authorization: this.auth.id, label, characters });
  }
  failed(purpose: Purpose, key: string, label: string) { this.write({ at: new Date().toISOString(), key, kind: 'failed', purpose, usd: 0, authorization: this.auth.id, label }); }
  refused(purpose: Purpose, key: string, reason: string) { this.write({ at: new Date().toISOString(), key, kind: 'settle', purpose, usd: 0, authorization: this.auth.id, label: reason, inputTokens: 0, outputTokens: 0 }); }
  private write(e: Entry) { appendFileSync(this.path, JSON.stringify(e) + '\n'); }
}

// ---------- the deployed ledger: one partition (pk LEDGER) plus each workspace's usage item ----------
export const LEDGER = 'LEDGER';
interface Totals { calls: Partial<Record<Purpose, number>>; usd: number; /** dollars per purpose (absent on totals written before 2026-10-13) */ usdBy?: Partial<Record<Purpose, number>>; v?: number }
interface Reservation { key: string; purpose: Purpose; usd: number; ws: string | null; authorization: string; label: string; at: string; state: 'reserved' | 'settled' | 'failed'; settledUsd?: number; inputTokens?: number; outputTokens?: number; characters?: number; refusedBy?: string; v?: number }
const round = (x: number) => Math.round(x * 1e9) / 1e9;
/** Earlier tables' spending (LEDGER CARRIED: closed lifetimes, see src/ops/lifecycle.ts): for one authorization, and in all. */
function carried(car: Item | undefined, authId: string) {
  const closed = (car?.closed ?? []) as { usd: number; byAuth: Record<string, { calls: Partial<Record<Purpose, number>>; usd: number; usdBy?: Partial<Record<Purpose, number>> }> }[];
  const calls: Partial<Record<Purpose, number>> = {}, usdBy: Partial<Record<Purpose, number>> = {};
  let usd = 0, allUsd = 0;
  for (const c of closed) {
    allUsd += c.usd;
    const a = c.byAuth[authId];
    if (a) {
      usd += a.usd;
      for (const [p, n] of Object.entries(a.calls)) calls[p as Purpose] = (calls[p as Purpose] ?? 0) + (n ?? 0);
      for (const [p, x] of Object.entries(a.usdBy ?? {})) usdBy[p as Purpose] = round((usdBy[p as Purpose] ?? 0) + (x ?? 0));
    }
  }
  return { calls, usdBy, usd: round(usd), allUsd: round(allUsd) };
}

/**
 * Every reservation is one conditional transaction over the authorization, its totals, the project total and the
 * workspace's usage: two Lambdas can't both take the last call or the last cent. The authorization item (owner-edited
 * with `npm run cc -- allowances`) is re-read on every reservation, so caps and the pause apply at once. Contention is
 * retried a few times, then refused: never a call without a reservation.
 */
export class KvLedger implements SpendLedger {
  readonly kv: Kv; readonly auth: { id: string };
  constructor(kv: Kv, auth: { id: string } = { id: 'deployed' }) { this.kv = kv; this.auth = auth; }
  private key = (sk: string) => ({ pk: LEDGER, sk });
  async authorization(): Promise<(Authorization & Item) | undefined> { return await this.kv.get(this.key('AUTH')) as (Authorization & Item) | undefined; }
  async reserve(purpose: Purpose, key: string, usd: number, label: string) {
    const ws = spender.getStore() ?? null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const auth = await this.authorization();
      if (!auth) throw new BudgetExceeded('no live authorization is recorded for this deployment');
      if (auth.paused) throw new BudgetExceeded('paid model work is paused by the owner');
      const totK = this.key(`TOTAL#${auth.id}`), allK = this.key('TOTAL#ALL'), carK = this.key('CARRIED'), useK = ws ? { pk: wsPk(ws), sk: `USAGE#${auth.id}` } : null;
      const [tot, all, use, car] = await Promise.all([this.kv.get(totK), this.kv.get(allK), useK ? this.kv.get(useK) : undefined, this.kv.get(carK)]) as (Totals & Item | undefined)[];
      const t: Totals = { calls: { ...tot?.calls }, usd: tot?.usd ?? 0, usdBy: { ...tot?.usdBy } }, u: Totals = { calls: { ...use?.calls }, usd: use?.usd ?? 0, usdBy: { ...use?.usdBy } };
      const was = carried(car, auth.id);   // spending of this environment's earlier tables (lifecycle.ts): never reset by a rebuild
      const cap = auth.maxCalls[purpose] ?? 0;   // a purpose the authorization doesn't name is not authorized
      if ((t.calls[purpose] ?? 0) + (was.calls[purpose] ?? 0) + 1 > cap) throw new BudgetExceeded(`${purpose} call cap ${cap} reached`);
      if (t.usd + was.usd + usd > auth.maxUsd) throw new BudgetExceeded(`reservation would exceed $${auth.maxUsd} authorization`);
      if (auth.priorProjectUsd + (all?.usd ?? 0) + was.allUsd + usd > auth.projectCeilingUsd) throw new BudgetExceeded('reservation would exceed the project ceiling');
      const pcap = auth.maxUsdByPurpose?.[purpose];
      if (pcap !== undefined && (t.usdBy![purpose] ?? 0) + (was.usdBy[purpose] ?? 0) + usd > pcap) throw new BudgetExceeded(`reservation would exceed the $${pcap} ${purpose} allowance`);
      if (useK && auth.perWorkspace) {
        const wcap = auth.perWorkspace.maxCalls[purpose] ?? 0;
        if ((u.calls[purpose] ?? 0) + 1 > wcap) throw new BudgetExceeded(`this workspace's ${purpose} allowance (${wcap}) is used up`);
        if (u.usd + usd > auth.perWorkspace.maxUsd) throw new BudgetExceeded(`this workspace's $${auth.perWorkspace.maxUsd} allowance is used up`);
      }
      const bump = (x: Totals) => ({ calls: { ...x.calls, [purpose]: (x.calls[purpose] ?? 0) + 1 }, usd: round(x.usd + usd), usdBy: { ...x.usdBy, [purpose]: round((x.usdBy?.[purpose] ?? 0) + usd) } });
      const ops: Op[] = [
        { check: this.key('AUTH'), if: auth.v! },
        { check: carK, if: car?.v ?? 'absent' },
        { put: { ...totK, ...bump(t), v: (tot?.v ?? 0) + 1 }, if: tot?.v ?? 'absent' },
        { put: { ...allK, usd: round((all?.usd ?? 0) + usd), v: (all?.v ?? 0) + 1 }, if: all?.v ?? 'absent' },
        { put: { ...this.key(`R#${key}`), key, purpose, usd, ws, authorization: auth.id, label, at: new Date().toISOString(), state: 'reserved', v: 1 } satisfies Reservation & Item, if: 'absent' },
      ];
      if (useK) ops.push({ put: { ...useK, ...bump(u), v: (use?.v ?? 0) + 1 }, if: use?.v ?? 'absent' });
      try { await this.kv.write(ops); return; }
      catch (e) { if (!(e instanceof WriteConflict)) throw e; await new Promise((r) => setTimeout(r, Math.random() * 20 * (attempt + 1))); }
    }
    throw new BudgetExceeded('the spending ledger is busy; nothing was called');
  }
  /** The settled amount replaces the reservation in every total it was counted in. */
  private async close(key: string, state: 'settled' | 'failed', usd: number | null, extra: Partial<Reservation>) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await this.kv.get(this.key(`R#${key}`)) as (Reservation & Item) | undefined;
      if (!r || r.state !== 'reserved') return;
      const delta = usd === null ? 0 : round(usd - r.usd);
      const totK = this.key(`TOTAL#${r.authorization}`), allK = this.key('TOTAL#ALL'), useK = r.ws ? { pk: wsPk(r.ws), sk: `USAGE#${r.authorization}` } : null;
      const [tot, all, use] = await Promise.all([this.kv.get(totK), this.kv.get(allK), useK ? this.kv.get(useK) : undefined]) as (Totals & Item | undefined)[];
      const ops: Op[] = [{ put: { ...r, state, ...(usd === null ? {} : { settledUsd: usd }), ...extra, v: r.v! + 1 }, if: r.v! }];
      if (delta) {
        const adj = (x: Totals & Item) => ({ ...x, usd: round(x.usd + delta), ...(x.usdBy ? { usdBy: { ...x.usdBy, [r.purpose]: round((x.usdBy[r.purpose] ?? 0) + delta) } } : {}), v: x.v! + 1 });
        ops.push({ put: adj(tot!), if: tot!.v! }, { put: { ...all!, usd: round(all!.usd + delta), v: all!.v! + 1 }, if: all!.v! });
        if (useK && use) ops.push({ put: adj(use), if: use.v! });
      }
      try { await this.kv.write(ops); return; }
      catch (e) { if (!(e instanceof WriteConflict)) throw e; await new Promise((res) => setTimeout(res, Math.random() * 20 * (attempt + 1))); }
    }
    console.error(`ledger: could not settle ${key}; its reservation stays counted in full`);
  }
  settle(_p: Purpose, key: string, inputTokens: number, outputTokens: number) { return this.close(key, 'settled', estimateUsd(inputTokens, outputTokens), { inputTokens, outputTokens }); }
  settleChars(_p: Purpose, key: string, characters: number, usd: number) { return this.close(key, 'settled', usd, { characters }); }
  failed(_p: Purpose, key: string) { return this.close(key, 'failed', null, {}); }
  refused(_p: Purpose, key: string, reason: string) { return this.close(key, 'settled', 0, { inputTokens: 0, outputTokens: 0, refusedBy: reason }); }

  /** Owner view: this table's totals, what earlier tables carried, and one workspace's usage. */
  async usage(ws?: string) {
    const auth = await this.authorization();
    const [tot, all, use, car] = await Promise.all([auth ? this.kv.get(this.key(`TOTAL#${auth.id}`)) : undefined, this.kv.get(this.key('TOTAL#ALL')), auth && ws ? this.kv.get({ pk: wsPk(ws), sk: `USAGE#${auth.id}` }) : undefined, this.kv.get(this.key('CARRIED'))]);
    const was = carried(car as Item | undefined, auth?.id ?? '');
    const thisTable = (all?.usd as number | undefined) ?? 0;
    return { authorization: auth ?? null, totals: tot ?? null, carriedForAuthorization: was, thisTableUsd: thisTable, carriedUsd: was.allUsd,
      projectUsd: (auth?.priorProjectUsd ?? 0) + thisTable + was.allUsd, workspace: use ?? null };
  }
  /** One more workspace today, within the authorization's daily cap (sign-ins and resets). */
  async newWorkspace(): Promise<boolean> {
    const auth = await this.authorization();
    const n = await this.kv.incr(this.key(`WSDAY#${new Date().toISOString().slice(0, 10)}`));
    return n <= (auth?.maxNewWorkspacesPerDay ?? 0);
  }
}

export type ToolCall =
  | { ok: true; input: unknown; usage: { inputTokens: number; outputTokens: number }; latencyMs: number; stopReason: string | undefined }
  | { ok: false; error: 'TIMEOUT' | 'CALL_FAILED' | 'THROTTLED' | 'NO_TOOL_CALL' | 'BUDGET_EXCEEDED' | 'LIVE_DISABLED'; detail: string; usage: { inputTokens: number; outputTokens: number } | null; latencyMs: number };

export interface ToolRequest { purpose: Purpose; key: string; label: string; system: string; user: string; toolName: string; toolDescription: string; schema: object; maxTokens: number; timeoutMs: number; reserveUsd: number }

/**
 * Whose AWS credentials live calls may use: an explicit policy, never "whatever the chain finds".
 * Local: the non-root IAM user `coursecorrect-nova` (its CLI profile). Deployed: the function's own execution role.
 * Env CC_AWS_IDENTITY = user/<name> (default user/coursecorrect-nova) or role/<name>.
 */
export function identityPolicy(spec = process.env.CC_AWS_IDENTITY ?? `user/${NOVA.expectedUser}`) {
  const m = /^(user|role)\/([\w+=,.@-]+)$/.exec(spec);
  if (!m) throw new Error(`CC_AWS_IDENTITY=${spec}: expected user/<name> or role/<name>`);
  return { kind: m[1] as 'user' | 'role', name: m[2] };
}
export function principalOf(arn: string): { ok: boolean; principal: string } & ReturnType<typeof identityPolicy> | { ok: false; principal: string } {
  if (/:root$/.test(arn)) return { ok: false, principal: 'ROOT' };
  const user = /:iam::\d+:user\/(?:.*\/)?([^/]+)$/.exec(arn)?.[1];
  if (user) return { ok: true, principal: `IAM_USER(${user})`, kind: 'user', name: user };
  const role = /:sts::\d+:assumed-role\/([^/]+)\/[^/]+$/.exec(arn)?.[1];
  if (role) return { ok: true, principal: `ROLE(${role})`, kind: 'role', name: role };
  return { ok: false, principal: 'OTHER' };
}
/** Ask STS whose credentials the SDK resolved (no Bedrock request), and hold them to the policy. Prints no secrets or account id. */
export async function verifyIdentity(policy = identityPolicy()): Promise<{ ok: boolean; principal: string }> {
  const arn = (await new STSClient({ region: NOVA.region }).send(new GetCallerIdentityCommand({}))).Arn ?? '';
  const p = principalOf(arn);
  return { ok: p.ok && 'kind' in p && p.kind === policy.kind && p.name === policy.name, principal: p.principal };
}

export class NovaClient {
  private client: BedrockRuntimeClient;
  readonly ledger: SpendLedger;
  constructor(ledger: SpendLedger) {
    if (process.env.CC_LIVE !== '1') throw new Error('live Nova is disabled (set CC_LIVE=1 under a recorded authorization)');
    if (ledger.auth.profile) process.env.AWS_PROFILE = ledger.auth.profile;   // local: only the non-root CourseCorrect profile
    this.client = new BedrockRuntimeClient({ region: NOVA.region, maxAttempts: 1 });   // the SDK retries 3 times by default: a paid call is made once, or not at all
    this.ledger = ledger;
  }
  async call(r: ToolRequest): Promise<ToolCall> {
    const t0 = performance.now();
    try { await this.ledger.reserve(r.purpose, r.key, r.reserveUsd, r.label); }
    catch (e) { return { ok: false, error: 'BUDGET_EXCEEDED', detail: (e as Error).message, usage: null, latencyMs: 0 }; }
    try {
      const out = await this.client.send(new ConverseCommand({
        modelId: NOVA.modelId,
        system: [{ text: r.system }],
        messages: [{ role: 'user', content: [{ text: r.user }] }],
        inferenceConfig: { maxTokens: r.maxTokens, temperature: 0 },
        toolConfig: { tools: [{ toolSpec: { name: r.toolName, description: r.toolDescription, inputSchema: { json: r.schema as never } } }], toolChoice: { tool: { name: r.toolName } } },
      }), { abortSignal: AbortSignal.timeout(r.timeoutMs) });
      const usage = { inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 };
      await this.ledger.settle(r.purpose, r.key, usage.inputTokens, usage.outputTokens, r.label);
      const tool = out.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
      const latencyMs = Math.round(performance.now() - t0);
      return tool ? { ok: true, input: tool.input, usage, latencyMs, stopReason: out.stopReason } : { ok: false, error: 'NO_TOOL_CALL', detail: `stopReason ${out.stopReason}`, usage, latencyMs };
    } catch (e) {
      const name = (e as Error).name;
      // a throttle is refused before inference and isn't billed: its reservation is settled at $0, the reason recorded. Every other
      // failure (a timeout may have run the model) keeps its reservation in full. Busy answers (THROTTLED) may be retried by the caller.
      if (name === 'ThrottlingException') await this.ledger.refused(r.purpose, r.key, `ThrottlingException: refused before inference (${r.label})`);
      else await this.ledger.failed(r.purpose, r.key, r.label);
      const busy = name === 'ThrottlingException' || name === 'ServiceUnavailableException' || name === 'ModelNotReadyException';
      return { ok: false, error: busy ? 'THROTTLED' : name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'CALL_FAILED', detail: `${name}: ${(e as Error).message}`.slice(0, 300), usage: null, latencyMs: Math.round(performance.now() - t0) };
    }
  }
  /** The identity policy check (see verifyIdentity), with this client's credentials. */
  verifyIdentity() { return verifyIdentity(); }
}
