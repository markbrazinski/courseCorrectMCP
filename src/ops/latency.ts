// Client-observed MCP latency against a deployed CourseCorrect URL, the way an external MCP client calls it: JSON sign-in for
// a bearer token, then JSON-RPC over HTTPS with no Origin and no cookie. Owner tooling (never part of the deployed service).
//   node src/ops/latency.ts --url <https://…/> --secrets <private/deploy/<env>/secrets.json> [--n 10] [--freetext 0] [--imports 0] [--burst 6] [--out <file>]
// Each sample is checked for the expected result (a fast error is never counted as a cooking decision). Paths that call a
// model are opt-in (--freetext N: N live Nova interpretations, about $0.001 each; --imports N: N live readings of the sample
// PDF, about $0.01 each; both charged to the environment's ledger). An import's acceptance is timed apart from its completion.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadContent } from '../service/content.ts';
import { session } from './session.ts';

const flag = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = (flag('url') ?? '').replace(/\/$/, ''), code = (JSON.parse(readFileSync(flag('secrets')!, 'utf8')) as { accessCode: string }).accessCode;
const N = Number(flag('n', '10')), FREE = Number(flag('freetext', '0')), IMPORTS = Number(flag('imports', '0')), BURST = Number(flag('burst', '0'));
type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads
const content = loadContent(), fx = (id: string) => content.fixtures.get(id)!.actions;
const samples: { path: string; ms: number; ok: boolean; detail: string; t: number; conn: 'reused' | 'new' | 'burst' | 'n/a'; server?: Record<string, number> }[] = [];
let id = 0;
const signIn = async () => (await session(url, code)).token;   // CC_SESSION_FILE: one session for every check
async function rpc(token: string, method: string, params: J = {}) {
  const t0 = performance.now();
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await r.text();
  // Server-Timing (when the server sends it): db, model, app, total in ms
  const server = Object.fromEntries([...(r.headers.get('server-timing') ?? '').matchAll(/(\w+);dur=([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  return { ms: performance.now() - t0, status: r.status, json: body ? JSON.parse(body) as J : null, server };
}
/** One timed call, recorded with whether its result is the expected one. */
async function call(path: string, token: string, name: string, args: J, expect: (out: J) => boolean, conn: 'reused' | 'burst' = 'reused') {
  const t = Date.now(), r = await rpc(token, 'tools/call', { name, arguments: args });
  const out = (r.json?.result?.structuredContent ?? r.json?.error ?? {}) as J;
  const ok = r.status === 200 && expect(out);
  samples.push({ path, ms: r.ms, ok, detail: `${out.outcome ?? ''}${out.code ? ` ${out.code}` : ''}`, t, conn, server: r.server });
  return out;
}
const cmd = (() => { let n = 0; return (p: string) => `lat-${Date.now().toString(36)}-${p}-${++n}`; })();

/** Start a fresh run of an example recipe and bring it to a fixture scene through record_progress (each progress call timed). */
async function cookTo(token: string, recipe: RegExp, fixture: string) {
  const book = (await call('list_recipes', token, 'list_recipes', {}, (o) => o.recipes?.length >= 2)).recipes as J[];
  const r = book.find((x) => recipe.test(x.title))!;
  const active = (await call('get_active_recipe', token, 'get_active_recipe', {}, () => true)).run as J | null;
  const st = await call('start_recipe', token, 'start_recipe', { commandId: cmd('s'), recipeId: r.recipeId, ...(active ? { replace: { runId: active.id, epoch: active.epoch, expectedRevision: active.revision, confirm: true } } : {}) }, (o) => o.outcome === 'started');
  let run = st.run as J;
  for (const a of fx(fixture)) run = (await call('record_progress', token, 'record_progress', { commandId: cmd('p'), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, ...a }, (o) => o.outcome === 'recorded')).run;
  return { run, recipe: st.recipe as J };
}
const ing = (recipe: J, re: RegExp) => (recipe.ingredients as J[]).find((i) => re.test(i.name))!.id as string;

// ---------- cold path: the first request after idle, then a parallel burst that needs new execution environments ----------
const sampleNew = (label: string, token: string) => {   // a new TCP + TLS connection per request (curl), with its timing breakdown
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}', '-X', 'POST', `${url}/mcp`,
    '-H', `authorization: Bearer ${token}`, '-H', 'content-type: application/json', '-H', 'accept: application/json, text/event-stream', '--data', body], { encoding: 'utf8' });
  const [status, dns, connect, tls, ttfb, total] = r.stdout.trim().split(' ');
  samples.push({ path: label, ms: Number(total) * 1000, ok: status === '200', detail: `dns ${(+dns * 1000).toFixed(0)} tcp ${(+connect * 1000).toFixed(0)} tls ${(+tls * 1000).toFixed(0)} ttfb ${(+ttfb * 1000).toFixed(0)} ms`, t: Date.now(), conn: 'new' });
};
const startedAt = Date.now();
const first = await rpc('none', 'tools/list');   // unauthenticated: 401, but it wakes an environment (cold if the function was idle)
samples.push({ path: 'first request after idle (401)', ms: first.ms, ok: first.status === 401, detail: String(first.status), t: Date.now(), conn: 'new' });
const tok = await signIn();
if (BURST) await Promise.all(Array.from({ length: BURST }, () => call('burst list_recipes (new environments)', tok, 'list_recipes', {}, (o) => o.recipes?.length >= 2, 'burst')));

// ---------- warm paths (reused connection) ----------
// one sign-in for every warm sample (each sign-in is a new workspace against the environment's daily cap; 2026-10-13 a run of
// ten used the day's last sign-ins): each iteration starts the example again in the same kitchen (start_recipe replace)
for (let i = 0; i < N; i++) {
  const t = tok;
  for (const m of ['initialize', 'tools/list']) {
    const r = await rpc(t, m, m === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'latency', version: '0' } } : {});
    samples.push({ path: m, ms: r.ms, ok: r.status === 200 && !!r.json?.result, detail: '', t: Date.now(), conn: 'reused' });
  }
  sampleNew('tools/list on a new connection', t);
  // risotto: availability question → proposal after "yes" → acceptance → successive check (another ingredient after the change)
  const { run, recipe } = await cookTo(t, /risotto/i, 'risotto.step5');
  const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
  const q = await call('evaluate_rescue: availability question', t, 'evaluate_rescue', { commandId: cmd('e'), ...base, missingIngredientId: ing(recipe, /wine/i), proposedKindIds: ['lemon-juice'], utterance: { text: 'wine', channel: 'tapped' } }, (o) => o.outcome === 'needsFacts');
  const p = await call('evaluate_rescue: proposal', t, 'evaluate_rescue', { commandId: cmd('e'), ...base, previousEvaluationId: q.id, answers: (q.questions as J[]).map((x) => ({ questionId: x.id, value: 'yes' })) }, (o) => o.outcome === 'proposal');
  const accept = { commandId: cmd('a'), ...base, evaluationId: p.id, candidateId: p.candidates[0].id, planId: p.candidates[0].planId, accepted: true };
  const ap = await call('apply_amendment: accepted', t, 'apply_amendment', accept, (o) => o.outcome === 'applied');
  await call('apply_amendment: repeated command (replay)', t, 'apply_amendment', accept, (o) => o.outcome === 'alreadyApplied');
  await call('get_active_recipe: reconcile command', t, 'get_active_recipe', { commandId: accept.commandId }, (o) => o.command?.status === 'applied');
  const after = ap.run as J;
  await call('evaluate_rescue: successive (another ingredient after a change)', t, 'evaluate_rescue', { commandId: cmd('e'), runId: after.id, epoch: after.epoch, expectedRevision: after.revision, missingIngredientId: ing(recipe, /parm/i), utterance: { text: 'parmesan', channel: 'tapped' } }, (o) => o.outcome === 'refused' || o.outcome === 'proposal' || o.outcome === 'needsFacts');
  // stale proposal: a fresh proposal, then progress, then the apply must be refused
  const s2 = await cookTo(t, /risotto/i, 'risotto.step5');
  const b2 = { runId: s2.run.id, epoch: s2.run.epoch, expectedRevision: s2.run.revision };
  const q2 = await call('evaluate_rescue: availability question', t, 'evaluate_rescue', { commandId: cmd('e'), ...b2, missingIngredientId: ing(s2.recipe, /wine/i), proposedKindIds: ['lemon-juice'], utterance: { text: 'wine', channel: 'tapped' } }, (o) => o.outcome === 'needsFacts');
  const p2 = await call('evaluate_rescue: proposal', t, 'evaluate_rescue', { commandId: cmd('e'), ...b2, previousEvaluationId: q2.id, answers: (q2.questions as J[]).map((x) => ({ questionId: x.id, value: 'yes' })) }, (o) => o.outcome === 'proposal');
  const moved = await call('record_progress', t, 'record_progress', { commandId: cmd('p'), ...b2, stepId: s2.run.currentStepId, progress: 'started' }, (o) => o.outcome === 'recorded');
  await call('apply_amendment: stale proposal (refused)', t, 'apply_amendment', { commandId: cmd('a'), ...b2, expectedRevision: moved.run.revision, evaluationId: p2.id, candidateId: p2.candidates[0].id, planId: p2.candidates[0].planId, accepted: true }, (o) => o.outcome === 'rejected' && (o.code === 'STALE_STATE' || o.code === 'NOT_ACTIONABLE'));
  // refusal: shortcake whipped cream
  const k = await cookTo(t, /shortcake/i, 'shortcake.step6');
  await call('evaluate_rescue: refusal', t, 'evaluate_rescue', { commandId: cmd('e'), runId: k.run.id, epoch: k.run.epoch, expectedRevision: k.run.revision, missingIngredientId: ing(k.recipe, /cream/i), proposedKindIds: ['whole-milk', 'unsalted-butter'], utterance: { text: 'cream', channel: 'tapped' } }, (o) => o.outcome === 'refused');
}
// ---------- opt-in: free text (one live Nova interpretation each) ----------
for (let i = 0; i < FREE; i++) {
  const t = await signIn(), k = await cookTo(t, /shortcake/i, 'shortcake.step6');
  await call('evaluate_rescue: FREE TEXT (Nova interpretation)', t, 'evaluate_rescue', { commandId: cmd('f'), runId: k.run.id, epoch: k.run.epoch, expectedRevision: k.run.revision, utterance: { text: "I'm out of heavy cream. Can I use milk and butter to whip instead?", channel: 'typed' } }, (o) => o.outcome === 'refused');
}
// ---------- opt-in: imports (one live reading each): acceptance, status re-calls, and time to the finished draft ----------
for (let i = 0; i < IMPORTS; i++) {
  const t = await signIn(), pdf = readFileSync(new URL('../../samples/scones-explicit.pdf', import.meta.url));
  const up = await (await fetch(`${url}/uploads`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/pdf', 'x-filename': 'scones-explicit.pdf' }, body: pdf })).json() as J;
  const args = { commandId: cmd('i'), source: { kind: 'upload', sourceDocId: up.sourceDocId } }, t0 = Date.now();
  let out = await call('import_recipe: accepted (acknowledgement only, not an import)', t, 'import_recipe', args, (o) => o.outcome === 'importing' || o.outcome === 'imported');
  while (out.outcome === 'importing' && Date.now() - t0 < 300_000) {
    await new Promise((r) => setTimeout(r, 2000));
    out = await call('import_recipe: status re-call (same commandId)', t, 'import_recipe', args, (o) => o.outcome === 'importing' || o.outcome === 'imported');
  }
  samples.push({ path: 'import_recipe: accepted → imported draft (background, wall clock)', ms: Date.now() - t0, ok: out.outcome === 'imported' && !!out.draft?.draftId, detail: `${out.outcome} ${out.draft?.title ?? out.job?.failure?.code ?? ''}`, t: Date.now(), conn: 'n/a' });
  // the companion's own polls once the reading is done: the job's status, and the finished draft (the review page's payload)
  for (let k = 0; k < 3 && out.draft?.draftId; k++) {
    for (const [label, path, ok] of [['GET /imports/:job (finished)', `/imports/${out.job?.id ?? out.draft.jobId}`, (j: J) => !!j?.job], ['GET /drafts/:id (completed draft)', `/drafts/${out.draft.draftId}`, (j: J) => !!j?.draft?.content]] as const) {
      const a = performance.now(), r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${t}` } }), body = await r.text();
      samples.push({ path: label, ms: performance.now() - a, ok: r.status === 200 && ok(body ? JSON.parse(body) : null), detail: `${r.status} ${body.length} bytes`, t: Date.now(), conn: 'reused' });
    }
  }
}

// ---------- report ----------
const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
const by = new Map<string, typeof samples>();
for (const s of samples) by.set(s.path, [...(by.get(s.path) ?? []), s]);
const rows = [...by.entries()].map(([path, xs]) => {
  const ms = xs.map((x) => x.ms).sort((a, b) => a - b), bad = xs.filter((x) => !x.ok);
  return { path, conn: xs[0].conn, n: xs.length, p50: Math.round(q(ms, 0.5)), p95: Math.round(q(ms, 0.95)), max: Math.round(ms[ms.length - 1]), under500: xs.filter((x) => x.ms < 500).length,
    failures: bad.length, failureDetail: bad.map((x) => x.detail).slice(0, 3), example: xs.find((x) => x.detail)?.detail ?? '',
    server: Object.fromEntries(['total', 'db', 'model', 'app'].flatMap((k) => { const v = xs.map((x) => x.server?.[k]).filter((n): n is number => n !== undefined).sort((a, b) => a - b); return v.length ? [[`${k}P50`, Math.round(q(v, 0.5))]] : []; })) };
});
for (const r of rows) console.log(`${r.path.padEnd(64)} ${r.conn.padEnd(6)} n=${String(r.n).padStart(3)} p50=${String(r.p50).padStart(5)} p95=${String(r.p95).padStart(5)} max=${String(r.max).padStart(5)} <500ms ${r.under500}/${r.n}${r.server.totalP50 !== undefined ? ` · server p50 ${r.server.totalP50} (db ${r.server.dbP50}${r.server.modelP50 !== undefined ? `, model ${r.server.modelP50}` : ''})` : ''}${r.failures ? ` FAIL ${r.failures} ${JSON.stringify(r.failureDetail)}` : ''}${r.conn === 'new' && r.example ? ` · ${r.example}` : ''}`);
if (flag('out')) writeFileSync(flag('out')!, JSON.stringify({ url, startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), n: N, freetext: FREE, imports: IMPORTS, burst: BURST, rows, samples }, null, 2));
