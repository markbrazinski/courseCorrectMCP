// Review fixes (2026-10-09), tested without AWS on the real web handler with sign-in (gate.ts) over the SQLite store:
//  - external MCP clients: a per-workspace bearer token, used by the MCP TypeScript SDK client;
//  - maintenance: new requests get 503 while a request already running finishes; what a backup waits for;
//  - spending lifetimes: a teardown and a rebuild neither reset nor double-count spending (caps and the project ceiling);
//  - paid clients make one attempt (no SDK retries).
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { offExtractor } from '../../src/authoring/extract.ts';
import { BudgetExceeded, KvLedger, LEDGER, NovaClient, spender, type Authorization } from '../../src/authoring/nova.ts';
import { Service } from '../../src/service/commands.ts';
import { Gate } from '../../src/service/gate.ts';
import { app } from '../../src/service/http.ts';
import type { Interpreter } from '../../src/service/interpret.ts';
import { maintenanceMode, wsPk, type Kv } from '../../src/service/kv.ts';
import { SqliteKv } from '../../src/service/kv-sqlite.ts';
import { Speaker } from '../../src/service/speech.ts';
import { carry, closeLifetime, freeze, inflight, knowledgeGaps, openLifetime, planRestore, referencedReleases, restoreKnowledge, unfreeze } from '../../src/ops/lifecycle.ts';
import { publishRelease } from '../../src/knowledge/release.ts';
import { storeKnowledge } from '../../src/service/content.ts';
import type { Item } from '../../src/service/kv.ts';
import { biscuits, kitchen, newKnowledgeKv, r1Files, r2Files } from '../fixtures/successive.ts';
import { content } from '../helpers.ts';
import { RECIPE } from '../fixtures/ids.ts';

const CODE = 'lifecycle-test-code';
const auth = (o: Partial<Authorization> = {}): Authorization => ({ id: 'a1', grantedBy: 't', at: '', maxCalls: { interpretation: 100 }, maxUsd: 1, projectCeilingUsd: 5, priorProjectUsd: 0,
  perWorkspace: { maxCalls: { interpretation: 100 }, maxUsd: 1 }, maxNewWorkspacesPerDay: 1000, ...o });
const recordAuth = async (kv: Kv, a: Authorization) => { const cur = await kv.get({ pk: LEDGER, sk: 'AUTH' }); await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...a, v: (cur?.v ?? 0) + 1 }, if: cur?.v ?? 'absent' }]); };
const newKv = () => new SqliteKv(join(mkdtempSync(join(tmpdir(), 'cc-life-')), 't.kv'));

/** A slow interpreter we can hold open, to have a request in flight when maintenance starts. */
let release: () => void = () => undefined;
const held: Interpreter = { mode: 'NOVA', async interpret() { await new Promise<void>((ok) => { release = ok; }); return { ok: false, reason: 'held', summary: 'held for the test' }; } };

describe('the deployed web handler on a local listener (sign-in on, SQLite store)', () => {
  let server: Server, base = '', kv: SqliteKv;
  beforeAll(async () => {
    kv = newKv();
    await recordAuth(kv, auth());
    const ledger = new KvLedger(kv);
    const gate = new Gate({ kv, ledger, codeHashes: [createHash('sha256').update(CODE).digest('hex')], sessionKey: randomBytes(32), secure: false });
    const workspace = (ws: string) => {
      const svc = new Service({ kv, ws, content, interpreter: held });
      const authoring = new Authoring({ kv, ws, content, extractor: offExtractor });
      svc.catalog = (t) => authoring.catalogIn(t);
      return { svc, authoring };
    };
    const handle = app({ workspace, gate, health: { interpreter: 'NOVA' }, origins: (u) => [u.origin], maintenance: () => maintenanceMode(kv) });
    server = createServer(getRequestListener((r) => handle(r), { overrideGlobalObjects: false }) as never);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });
  const signIn = async () => (await (await fetch(`${base}/signin`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }) })).json()) as { ok: true; endpoint: string; token: string };
  const client = async (token: string) => {
    const c = new Client({ name: 'external-agent', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };

  it('an external MCP client (the SDK) works with a bearer token: initialize, tools/list, tools/call — in its own workspace', async () => {
    const s = await signIn();
    expect(s.endpoint).toBe(`${base}/mcp`);
    const c = await client(s.token);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['apply_amendment', 'delete_recipe', 'evaluate_rescue', 'get_active_recipe', 'import_recipe', 'list_recipes', 'record_progress', 'start_recipe']);
    expect(((await c.callTool({ name: 'list_recipes', arguments: {} })).structuredContent as { recipes: unknown[] }).recipes).toHaveLength(3);
    const started = (await c.callTool({ name: 'start_recipe', arguments: { commandId: 'x1', recipeId: RECIPE['risotto.demo'] } })).structuredContent as { outcome: string };
    expect(started.outcome).toBe('started');
    const other = await client((await signIn()).token);   // another token: another kitchen
    expect(((await other.callTool({ name: 'get_active_recipe', arguments: {} })).structuredContent as { run: unknown }).run).toBeNull();
    await c.close(); await other.close();
  });

  it('a token is only a token: no token, a tampered one, a cookie used as one, or a foreign page all fail; a token cannot reset or mint', async () => {
    const s = await signIn();
    const post = (h: Record<string, string>) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...h }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${s.token.slice(0, -2)}xx` })).status).toBe(401);
    const signed = await fetch(`${base}/signin`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` });
    const cookie = signed.headers.getSetCookie()[0].split(';')[0];
    expect((await post({ authorization: `Bearer ${cookie.split('=')[1]}` })).status).toBe(401);                   // the cookie's value is not a token
    expect((await post({ authorization: `Bearer ${s.token}`, origin: 'https://evil.example' })).status).toBe(403); // a browser page elsewhere
    expect((await post({ authorization: `Bearer ${s.token}` })).status).toBe(200);                                // no Origin: a non-browser client
    expect((await fetch(`${base}/workspace/reset`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } })).status).toBe(403);
    expect((await fetch(`${base}/mcp-token`, { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(403);
    const minted = await (await fetch(`${base}/mcp-token`, { headers: { cookie } })).json() as { token: string; endpoint: string };
    expect([minted.endpoint, (await post({ authorization: `Bearer ${minted.token}` })).status]).toEqual([`${base}/mcp`, 200]);
  });

  it('maintenance: a request already running finishes; new requests get 503 (page or JSON); off again, everything works', async () => {
    const s = await signIn(), c = await client(s.token);
    const st = (await c.callTool({ name: 'start_recipe', arguments: { commandId: 'm1', recipeId: RECIPE['shortcake.demo'] } })).structuredContent as { run: { id: string; epoch: number; revision: number } };
    // an evaluation whose interpreter call is held open: it is "running work" when maintenance starts
    const running = c.callTool({ name: 'evaluate_rescue', arguments: { commandId: 'm2', runId: st.run.id, epoch: st.run.epoch, expectedRevision: st.run.revision, utterance: { text: 'no cream', channel: 'typed' } } });
    for (let i = 0; i < 50 && !(await inflight(kv.scan(), Date.now())).jobs && i < 3; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    await freeze(kv, 'test');
    const blocked = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    expect([blocked.status, ((await blocked.json()) as { error: { code: string } }).error.code]).toEqual([503, 'MAINTENANCE']);
    expect((await fetch(base, { headers: { accept: 'text/html' } })).status).toBe(503);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ maintenance: true });
    release();                                                                                    // the running request settles
    expect(((await running).structuredContent as { outcome: string }).outcome).toBe('needsInterpretation');
    await unfreeze(kv);
    expect(((await c.callTool({ name: 'get_active_recipe', arguments: {} })).structuredContent as { run: { id: string } }).run.id).toBe(st.run.id);
    await c.close();
  });
});

describe('what a backup waits for', () => {
  it('accepted import jobs and unsettled paid calls are in flight until they finish (or their deadline passes)', async () => {
    const kv = newKv(), ws = 'ws_inflightcheck01';
    const a = new Authoring({ kv, ws, content, extractor: offExtractor, dispatch: async () => undefined });   // accepted, not started
    const r = await a.createImport({ kind: 'text', text: 'Pancakes\n1 egg\n1. Mix.' });
    if (r.status !== 202) throw new Error('import');
    await kv.write([{ put: { pk: LEDGER, sk: 'R#k1', key: 'k1', state: 'reserved', at: new Date().toISOString() } }]);
    expect(await inflight(kv.scan())).toEqual({ jobs: [`${wsPk(ws)} ${r.job.id} queued`], reservations: ['k1'] });
    await a.runJob(r.job.id);                                                     // the job runs to its end (reading is off: it fails cleanly)
    await kv.write([{ put: { pk: LEDGER, sk: 'R#k1', key: 'k1', state: 'settled', at: new Date().toISOString() } }]);
    expect(await inflight(kv.scan())).toEqual({ jobs: [], reservations: [] });
    expect(await inflight(kv.scan(), Date.now() + 12 * 60_000)).toEqual({ jobs: [], reservations: [] });
  });
});

describe('spending across teardown, rebuild and restore', () => {
  const spend = async (kv: Kv, n: number, usd: number, ws = 'ws_spenderAAAAAA') => { const l = new KvLedger(kv); for (let i = 0; i < n; i++) await spender.run(ws, async () => { const k = `k${Math.random()}`; await l.reserve('interpretation', k, usd, 't'); await l.settleChars('interpretation', k, 1, usd); }); };   // settled at what it cost

  it('a rebuilt table carries the destroyed one: caps and the ceiling count both; restoring the same backup adds nothing twice', async () => {
    // lifetime 1: 3 calls, then "destroy" records it (and a backup holds the same items)
    const t1 = newKv();
    await recordAuth(t1, auth({ maxCalls: { interpretation: 5 } }));
    await openLifetime(t1, []);
    const l1 = new KvLedger(t1);
    for (let i = 0; i < 3; i++) await spender.run('ws_spenderAAAAAA', async () => { await l1.reserve('interpretation', `a${i}`, 0.1, 't'); await l1.settleChars('interpretation', `a${i}`, 1, 0.1); });
    const closed = await closeLifetime(t1, 'destroy');
    expect(closed).toMatchObject({ usd: 0.3, byAuth: { a1: { calls: { interpretation: 3 }, usd: 0.3 } } });
    const backup: import('../../src/service/kv.ts').Item[] = [];
    for await (const p of t1.scan()) backup.push(...p);
    // lifetime 2 (fresh deploy) carries the history: 2 calls left, not 5
    const t2 = newKv();
    await recordAuth(t2, auth({ maxCalls: { interpretation: 5 } }));
    expect((await openLifetime(t2, [closed])).created).toBe(true);
    await spend(t2, 2, 0.01, 'ws_spenderBBBBBB');
    await expect(spend(t2, 1, 0.01, 'ws_spenderBBBBBB')).rejects.toBeInstanceOf(BudgetExceeded);
    // restoring the backup brings its workspaces back but not its totals: its lifetime is already carried (no double count)
    const plan = planRestore(backup);
    expect(plan.write.some((x) => x.pk === LEDGER && (x.sk === 'AUTH' || x.sk.startsWith('TOTAL#') || x.sk === 'CARRIED' || x.sk === 'LIFETIME'))).toBe(false);
    expect(plan.write.some((x) => x.pk.startsWith('W#'))).toBe(true);
    await carry(t2, plan.carry); await carry(t2, plan.carry);
    const u = await new KvLedger(t2).usage();
    expect(u.carriedForAuthorization).toMatchObject({ calls: { interpretation: 3 }, usd: 0.3 });
    expect(u.projectUsd).toBeCloseTo(0.32, 9);   // 0.3 carried + 0.02 this table: once each
  });

  it('a backup whose table was never recorded (lost history) is carried by its restore, once', async () => {
    const t1 = newKv();
    await recordAuth(t1, auth());
    await openLifetime(t1, []);
    await spend(t1, 2, 0.05);
    const items: import('../../src/service/kv.ts').Item[] = [];
    for await (const p of t1.scan()) items.push(...p);
    const t2 = newKv();
    await recordAuth(t2, auth());
    await openLifetime(t2, []);                       // no history: nothing carried yet
    const plan = planRestore(items);
    await carry(t2, plan.carry); await carry(t2, plan.carry);
    expect((await new KvLedger(t2).usage()).carriedUsd).toBeCloseTo(0.1, 9);
  });

  it('the project ceiling counts spending before Lambda, earlier tables and this one', async () => {
    const kv = newKv();
    await recordAuth(kv, auth({ priorProjectUsd: 4.7, projectCeilingUsd: 5, maxUsd: 1 }));
    await openLifetime(kv, [{ lifetime: 'lt_old', closedAt: '', source: 'destroy', usd: 0.25, byAuth: {} }]);
    await spend(kv, 1, 0.04);
    await expect(spend(kv, 1, 0.02)).rejects.toThrow(/project ceiling/);   // 4.7 + 0.25 + 0.04 + 0.02 > 5
  });

  it('a purpose dollar cap (OCR inside a commission) counts settled amounts and leaves other purposes alone', async () => {
    const kv = newKv(), l = new KvLedger(kv);
    await recordAuth(kv, auth({ maxUsd: 1, maxCalls: { ocr: 10, interpretation: 10 }, maxUsdByPurpose: { ocr: 0.05 } }));
    await l.reserve('ocr', 'o1', 0.03, 't'); await l.settleChars('ocr', 'o1', 0, 0.015);   // reserved 20 pages, Textract billed 10
    await l.reserve('ocr', 'o2', 0.03, 't');                                                   // 0.015 + 0.03 <= 0.05
    await expect(l.reserve('ocr', 'o3', 0.01, 't')).rejects.toThrow(/\$0.05 ocr allowance/);
    await l.reserve('interpretation', 'i1', 0.2, 't');
    expect((await l.usage()).totals).toMatchObject({ usdBy: { ocr: 0.045, interpretation: 0.2 } });
  });
});

describe('paid clients make one attempt (the SDK default is three)', () => {
  it('Bedrock and Polly clients: maxAttempts 1; constructing them makes no call', async () => {
    const was = process.env.CC_LIVE;
    process.env.CC_LIVE = '1';
    try {
      const ledger = new KvLedger(newKv());
      const nova = new NovaClient(ledger) as unknown as { client: { config: { maxAttempts: () => Promise<number> } } };
      const polly = new Speaker(ledger, mkdtempSync(join(tmpdir(), 'cc-sp-'))) as unknown as { client: { config: { maxAttempts: () => Promise<number> } } };
      expect([await nova.client.config.maxAttempts(), await polly.client.config.maxAttempts()]).toEqual([1, 1]);
    } finally { if (was === undefined) delete process.env.CC_LIVE; else process.env.CC_LIVE = was; }
  });
});

describe('knowledge releases across backup, teardown, rebuild and restore (case 13, LOCAL: no AWS)', () => {
  /** what `cc backup` exports: every item of both tables */
  const dump = async (kv: Kv) => { const out: Item[] = []; for await (const p of kv.scan!()) out.push(...p); return out; };

  it('a restore brings back the releases saved recipes and sessions are pinned to, and they decide the same way', async () => {
    const app = await newKnowledgeKv(), know = await newKnowledgeKv();   // fresh tables (DynamoDB Local: created per test)
    const r1 = (await publishRelease(know, r1Files(), { activate: true })).releaseId;
    const k = kitchen(storeKnowledge(know), { kv: app });
    await k.start((await k.importAndSave(biscuits())).recipeId);
    await k.doneUpTo(2);
    await k.change(/heavy cream/i);                                     // pinned to R1
    const r2 = (await publishRelease(know, r2Files(), { activate: true })).releaseId;
    const before = await k.svc.getActiveRecipe(), decidedBefore = await k.ask(/^milk$/i, ['evaporated-milk']);
    const [appItems, knowItems] = [await dump(app), await dump(know)];
    expect(referencedReleases(appItems).pinned).toEqual([r1]);
    // teardown + rebuild: new, empty tables; knowledge first, then the workspace items
    const app2 = await newKnowledgeKv(), know2 = await newKnowledgeKv();
    expect(await restoreKnowledge(know2, knowItems)).toMatchObject({ written: knowItems.length, kept: 0, active: r2 });
    expect(await knowledgeGaps(know2, referencedReleases(appItems))).toEqual([]);
    for (const x of planRestore(appItems).write) await app2.write([{ put: x }]);
    // the reopened session: same recipe, same pin, same history, and the same decision (R1 refuses what R2 would offer)
    const after = kitchen(storeKnowledge(know2), { kv: app2, ws: k.ws });
    const read = await after.svc.getActiveRecipe();
    expect(read.run).toEqual(before.run);
    expect(read.recipe).toEqual(before.recipe);
    const decidedAfter = await after.ask(/^milk$/i, ['evaporated-milk']);
    expect({ outcome: decidedAfter.outcome, speech: decidedAfter.speech.text, basis: decidedAfter.basis }).toEqual({ outcome: decidedBefore.outcome, speech: decidedBefore.speech.text, basis: decidedBefore.basis });
    expect(decidedAfter).toMatchObject({ outcome: 'refused', basis: { knowledgeReleaseId: r1 } });
    // new work after the restore is pinned to the restored ACTIVE release
    expect((await (await after.importAndSave(biscuits())).recipeId)).toBeTruthy();
    expect((await after.auth.catalog()).map((e) => e.pack!.knowledgeReleaseId).sort()).toEqual([r1, r2].sort());
    // restoring the same knowledge twice changes nothing
    expect(await restoreKnowledge(know2, knowItems)).toMatchObject({ written: 0, kept: knowItems.length });
  });

  it('a backup without the knowledge a recipe is pinned to is caught before anything is written', async () => {
    const app = await newKnowledgeKv(), know = await newKnowledgeKv();
    const r1 = (await publishRelease(know, r1Files(), { activate: true })).releaseId;
    const k = kitchen(storeKnowledge(know), { kv: app });
    await k.start((await k.importAndSave(biscuits())).recipeId);
    const empty = await newKnowledgeKv();
    await publishRelease(empty, r2Files(), { activate: true });          // a rebuild that only published today's content
    const gaps = await knowledgeGaps(empty, referencedReleases(await dump(app)));
    expect(gaps).toEqual([`${r1}: knowledge ${r1}: no such release`]);
  });
});
