// Live Nova boundary: one forced tool call per request, server-side credentials only, every call reserved and settled
// in an append-only ledger that enforces the owner's live authorization (count and dollar caps). Never retries.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const NOVA = { modelId: 'us.amazon.nova-2-lite-v1:0', region: 'us-east-1', profile: 'coursecorrect-nova', expectedUser: 'coursecorrect-nova' } as const;
/** On-demand list price used in the old project's ledger (AWS Price List API, 2026-09-29). Estimates only. */
export const PRICE = { inputPer1K: 0.00033, outputPer1K: 0.00275 } as const;
export const estimateUsd = (inTok: number, outTok: number) => (inTok * PRICE.inputPer1K + outTok * PRICE.outputPer1K) / 1000;

export type Purpose = 'extraction' | 'interpretation' | 'speech' | 'explanation' | 'swapAnalysis';
export interface Authorization {
  id: string; grantedBy: string; at: string;
  maxCalls: Partial<Record<Purpose, number>>; maxUsd: number; projectCeilingUsd: number; priorProjectUsd: number; profile: string;
}
interface Entry { at: string; key: string; kind: 'reserve' | 'settle' | 'failed'; purpose: Purpose; usd: number; authorization: string; label: string; inputTokens?: number; outputTokens?: number; characters?: number }
export class BudgetExceeded extends Error {}

/** Append-only JSONL ledger. A reservation without settlement counts in full; a failed call keeps its reservation. */
export class Ledger {
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
      calls: Object.fromEntries((['extraction', 'interpretation', 'speech', 'explanation', 'swapAnalysis'] as const).map((p) => [p, mine.filter((x) => x.purpose === p).length])) as Record<Purpose, number>,
    };
  }
  reserve(purpose: Purpose, key: string, usd: number, label: string) {
    const t = this.totals();
    const cap = this.auth.maxCalls[purpose] ?? 0;   // a purpose the authorization doesn't name is not authorized
    if (t.calls[purpose] + 1 > cap) throw new BudgetExceeded(`${purpose} call cap ${cap} reached`);
    if (t.authorizationUsd + usd > this.auth.maxUsd) throw new BudgetExceeded(`reservation would exceed $${this.auth.maxUsd} authorization`);
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
  private write(e: Entry) { appendFileSync(this.path, JSON.stringify(e) + '\n'); }
}

export type ToolCall =
  | { ok: true; input: unknown; usage: { inputTokens: number; outputTokens: number }; latencyMs: number; stopReason: string | undefined }
  | { ok: false; error: 'TIMEOUT' | 'CALL_FAILED' | 'NO_TOOL_CALL' | 'BUDGET_EXCEEDED' | 'LIVE_DISABLED'; detail: string; usage: { inputTokens: number; outputTokens: number } | null; latencyMs: number };

export interface ToolRequest { purpose: Purpose; key: string; label: string; system: string; user: string; toolName: string; toolDescription: string; schema: object; maxTokens: number; timeoutMs: number; reserveUsd: number }

export class NovaClient {
  private client: BedrockRuntimeClient;
  readonly ledger: Ledger;
  constructor(ledger: Ledger) {
    if (process.env.CC_LIVE !== '1') throw new Error('live Nova is disabled (set CC_LIVE=1 under a recorded authorization)');
    process.env.AWS_PROFILE = ledger.auth.profile;          // only the non-root CourseCorrect profile
    this.client = new BedrockRuntimeClient({ region: NOVA.region });
    this.ledger = ledger;
  }
  async call(r: ToolRequest): Promise<ToolCall> {
    const t0 = performance.now();
    try { this.ledger.reserve(r.purpose, r.key, r.reserveUsd, r.label); }
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
      this.ledger.settle(r.purpose, r.key, usage.inputTokens, usage.outputTokens, r.label);
      const tool = out.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
      const latencyMs = Math.round(performance.now() - t0);
      return tool ? { ok: true, input: tool.input, usage, latencyMs, stopReason: out.stopReason } : { ok: false, error: 'NO_TOOL_CALL', detail: `stopReason ${out.stopReason}`, usage, latencyMs };
    } catch (e) {
      this.ledger.failed(r.purpose, r.key, r.label);       // the reservation stays counted in full
      const name = (e as Error).name;
      return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'CALL_FAILED', detail: `${name}: ${(e as Error).message}`.slice(0, 300), usage: null, latencyMs: Math.round(performance.now() - t0) };
    }
  }
  /** Resolve the SDK's credentials, then ask STS whose they are. No Bedrock request. Prints no secrets or account id. */
  async verifyIdentity(): Promise<{ ok: boolean; principal: string }> {
    const creds = await this.client.config.credentials();
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, AWS_REGION: NOVA.region, AWS_PAGER: '', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_ACCESS_KEY_ID: creds.accessKeyId, AWS_SECRET_ACCESS_KEY: creds.secretAccessKey, ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    };
    const arn = (JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], { env, encoding: 'utf8' })) as { Arn: string }).Arn;
    if (/:root$/.test(arn)) return { ok: false, principal: 'ROOT' };
    const user = /:user\/(.+)$/.exec(arn)?.[1] ?? null;
    return { ok: user === NOVA.expectedUser, principal: user ? `IAM_USER(${user})` : 'OTHER' };
  }
}
