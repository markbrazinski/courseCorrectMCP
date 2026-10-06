// Import-time swap-card probe (handoff-import-swap-cards.md; owner authorization cards-2026-10-04: ≤6 extraction + ≤6
// swapAnalysis calls, ≤$0.25, profile coursecorrect-nova). Three demo PDFs, one live import each (extraction + swap analysis).
//   node src/probes/cards-probe.ts freeze  → private/probes/cards/{risotto,scones,shortcake}.pdf + probe-v1.json (refuses to overwrite)
//   CC_LIVE=1 CC_AUTHORIZATION=live-authorization-cards.json node src/probes/cards-probe.ts run
//       → verifies the frozen hashes and the non-root identity, imports each PDF ONCE, keeps every result
//         (private/probes/cards/results-v1.json, .artifacts/probes/cards-replay.json). Refuses to run twice.
//   node src/probes/cards-probe.ts rehearse → the same import + judging code on the RECORDED test fixtures (no calls)
//   node src/probes/cards-probe.ts revalidate → the kept live output (replay) through the current code (no calls); the
//       as-run record stays results-v1.json, this writes revalidated-v1.json
//   node src/probes/cards-probe.ts seed <db> → imports the three PDFs into <db> from the replay (no calls) and keeps them
//       as demo recipes across the practice reset. Run only while no server has <db> open.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, promptIdentity, PROMPT_VERSION, recordedExtractor, userMessage } from '../authoring/extract.ts';
import { Ledger, NOVA, NovaClient, type Authorization } from '../authoring/nova.ts';
import { readPdf } from '../authoring/source.ts';
import { novaAnalyzer, recordedAnalyzer, SWAP_SYSTEM, SWAP_VERSION, swapPromptIdentity, type SwapAnalyzer } from '../authoring/swap-analysis.ts';
import type { Extractor } from '../authoring/extract.ts';
import { hash, sha256 } from '../domain/rational.ts';
import { stepOrder } from '../domain/recipe.ts';
import { Service } from '../service/commands.ts';
import { loadContent } from '../service/content.ts';
import { noneInterpreter } from '../service/interpret.ts';
import { DEMO, demoPdf, recordedDemo } from '../../tests/fixtures/demo-cards.ts';

const root = join(import.meta.dirname, '../..');
const dir = join(root, 'private/probes/cards');
const probePath = join(dir, 'probe-v1.json'), resultsPath = join(dir, 'results-v1.json'), startedPath = join(dir, 'run-started.json');
const replayPath = join(root, '.artifacts/probes/cards-replay.json');
const content = loadContent();
const v = content.vocab;
const fileSha = (p: string) => sha256(readFileSync(p).toString('latin1'));
const NAMES = DEMO.map((d) => d.name);

/** Identities the run must still match: anything that would change what is sent or how it is judged. */
const identities = () => ({
  model: NOVA.modelId, region: NOVA.region,
  extraction: { version: PROMPT_VERSION, identity: promptIdentity(v) },
  swapAnalysis: { version: SWAP_VERSION, identity: swapPromptIdentity(v) },
  vocabularyHash: hash(v), patternSetHash: hash(content.patterns.map((p) => hash(p)).sort()), rolesHash: hash(content.roles),
});

const EXPECTATIONS = [
  { id: 'X1', what: 'Each PDF imports: job succeeded; ingredients/steps = risotto 8/8, scones 5/7, shortcake 7/7.' },
  { id: 'X2', what: 'Every ADD use of each recipe has a valid card (COMPILED, or SUPERSEDED by a reviewed rule) with a verdict and an opinion.' },
  { id: 'X3', what: 'Scones, heavy cream at step 3: verdict swap with milk and butter (by kind or name); the step-6 brushing use is addressed (any handling, coveredBy preferred).' },
  { id: 'X4', what: 'Shortcake, heavy cream at step 6: verdict no; the opinion is about whipping or holding air (/whip|air|peak/).' },
  { id: 'X5', what: 'Shortcake, heavy cream at step 4: cooking with steps 1–3 done, "milk and butter" is refused with a "No" whose facts name step 6 (no-for-now).' },
  { id: 'X6', what: 'Risotto, dry white wine at step 5: verdict swap (at cook time the reviewed split is used).' },
];

async function freeze() {
  if (existsSync(probePath)) throw new Error(`${probePath} exists: the probe is frozen (owner approval needed to change it)`);
  mkdirSync(dir, { recursive: true });
  const inputs: Record<string, string> = {};
  for (const d of DEMO) { const p = join(dir, `${d.name}.pdf`); writeFileSync(p, demoPdf(d.lines)); inputs[`${d.name}.pdf`] = fileSha(p); }
  const body = {
    kind: 'cc-cards-probe/1', frozenAt: new Date().toISOString(), status: 'FROZEN · NOT RUN', authorization: 'cards-2026-10-04',
    ...identities(), swapSystem: SWAP_SYSTEM, inputs,
    budget: { calls: { extraction: 3, swapAnalysis: 3 }, caps: { extraction: 6, swapAnalysis: 6, maxUsd: 0.25 }, estimatedUsd: '0.05–0.10' },
    expectations: EXPECTATIONS,
    rules: 'One live import per PDF (one extraction + one swap-analysis call), never retried. Every result is kept, including failures. A failed expectation is reported, not tuned: no rerun without owner approval.',
  };
  writeFileSync(probePath, JSON.stringify({ ...body, sha256: sha256(JSON.stringify(body)) }, null, 2));
  console.log(`frozen: ${probePath}\n${Object.entries(inputs).map(([k, x]) => `  ${k} ${x}`).join('\n')}`);
}

/** Import every frozen PDF once and judge it. `live` → record the replay. */
async function importAll(dbPath: string, extractor: Extractor, analyzer: SwapAnalyzer, demo: boolean) {
  const svc = new Service({ dbPath, content, interpreter: noneInterpreter, fixtureRecipes: false });
  const auth = new Authoring({ store: svc.store, content, extractor, analyzer });
  svc.catalog = () => auth.catalog();
  const out: Record<string, { draftId: string; recipeId: string | null; job: unknown; save: unknown }> = {};
  for (const name of NAMES) {
    const bytes = new Uint8Array(readFileSync(join(dir, `${name}.pdf`)));
    const r = await auth.createImport({ kind: 'pdf', bytes, filename: `${name}.pdf` });
    if (r.status !== 202) { out[name] = { draftId: '', recipeId: null, job: r, save: null }; continue; }
    const job = await auth.waitForJob(r.job.id);
    let save: unknown = null, recipeId: string | null = null;
    if (job.state !== 'failed') {
      const s = auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId), idempotencyKey: `cards-probe-${name}` });
      save = s; recipeId = s.recipeId;
      if (demo) svc.store.run('INSERT OR IGNORE INTO demo_recipes VALUES (?)', s.recipeId);
    }
    out[name] = { draftId: r.draftId, recipeId, job, save };
  }
  return { svc, auth, out };
}

function judge(svc: Service, auth: Authoring, out: Awaited<ReturnType<typeof importAll>>['out']) {
  const expected: Record<string, [number, number]> = { risotto: [8, 8], scones: [5, 7], shortcake: [7, 7] };
  const results: Record<string, { pass: boolean; detail: string }> = {};
  const table: { recipe: string; step: number; ingredient: string; verdict: string | null; status: string; reason: string | null; role: string | null; opinion: string | null; swap: string }[] = [];
  const cardOf = (name: string, ing: RegExp, step: number) => {
    const d = out[name]; if (!d?.draftId) return null;
    const { pack } = auth.coverageOf(d.draftId);
    const r = pack?.recipe; if (!r) return null;
    const u = r.uses.find((x) => ing.test(r.ingredients.find((i) => i.ingredientId === x.ingredientId)!.name) && stepOrder(r, x.stepId) === step);
    if (!u) return null;
    const a = svc.store.get<{ raw_json: string | null; refs_json: string }>('SELECT raw_json, refs_json FROM swap_analyses WHERE draft_id = ? ORDER BY rowid DESC LIMIT 1', d.draftId);
    const refs = a ? JSON.parse(a.refs_json) as { uses: Record<string, string> } : { uses: {} };
    const ref = Object.entries(refs.uses).find(([, id]) => id === u.useId)?.[0];
    const raw = a?.raw_json ? (JSON.parse(a.raw_json) as { cards?: { useRef?: string }[] }).cards?.find((c) => c?.useRef === ref) as Record<string, any> | undefined : undefined;   // eslint-disable-line @typescript-eslint/no-explicit-any
    return { entry: pack!.cards!.find((e) => e.useId === u.useId)!, raw, use: u, recipe: r };
  };
  const x1 = NAMES.map((n) => {
    const d = out[n]; const job = d.job as { state?: string };
    const r = d.draftId ? auth.effective(d.draftId) : null;
    const ok = job?.state === 'succeeded' && !!r && r.ingredients.length === expected[n][0] && r.steps.length === expected[n][1];
    return { ok, s: `${n}: ${job?.state ?? 'no job'} ${r ? `${r.ingredients.length}/${r.steps.length}` : ''}` };
  });
  results.X1 = { pass: x1.every((x) => x.ok), detail: x1.map((x) => x.s).join('; ') };
  const bad: string[] = [];
  for (const n of NAMES) {
    const d = out[n]; if (!d.draftId) { bad.push(`${n}: no draft`); continue; }
    const { pack } = auth.coverageOf(d.draftId);
    const c = auth.getDraft(d.draftId).draft.content;
    for (const e of pack?.cards ?? []) {
      const u = pack!.recipe.uses.find((x) => x.useId === e.useId)!;
      const ing = pack!.recipe.ingredients.find((i) => i.ingredientId === u.ingredientId)!;
      const w = c?.ingredients.flatMap((i) => i.uses).find((x) => x.id === e.useId);
      table.push({ recipe: n, step: stepOrder(pack!.recipe, u.stepId), ingredient: ing.name, verdict: e.verdict, status: e.status, reason: e.reason, role: e.role, opinion: e.opinion, swap: w ? `${w.swap.label ?? ''}: ${w.swap.text}` : '' });
      if (e.status === 'INVALID' || !e.verdict || !e.opinion) bad.push(`${n} step ${stepOrder(pack!.recipe, u.stepId)} ${ing.name}: ${e.reason}`);
    }
  }
  results.X2 = { pass: !bad.length && table.length > 0, detail: bad.join('; ') || `${table.length} uses, all valid` };
  const sc = cardOf('scones', /cream/i, 3);
  const swapNames = sc?.raw?.swap ? [sc.raw.swap, ...(sc.raw.swap.otherIngredients ?? [])].map((x: { ingredient: string; kindId: string | null }) => `${x.kindId ?? ''} ${x.ingredient}`).join(' | ') : '';
  const brush = sc?.raw?.siblings?.[0]?.handling ?? null;
  results.X3 = { pass: !!sc && sc.entry.status !== 'INVALID' && sc.entry.verdict === 'swap' && /milk/i.test(swapNames) && /butter/i.test(swapNames) && !!brush,
    detail: sc ? `${sc.entry.status} ${sc.entry.verdict}; swap: ${swapNames}; brushing: ${brush}; ${sc.entry.reason ?? ''}` : 'use not found' };
  const kw = cardOf('shortcake', /cream/i, 6);
  results.X4 = { pass: !!kw && kw.entry.status !== 'INVALID' && kw.entry.verdict === 'no' && /whip|air|peak/i.test(kw.entry.opinion ?? ''), detail: kw ? `${kw.entry.status} ${kw.entry.verdict}: ${kw.entry.opinion ?? ''} ${kw.entry.reason ?? ''}` : 'use not found' };
  const rw = cardOf('risotto', /wine/i, 5);
  results.X6 = { pass: !!rw && rw.entry.status !== 'INVALID' && rw.entry.verdict === 'swap', detail: rw ? `${rw.entry.status} ${rw.entry.verdict}: ${rw.entry.opinion ?? ''} ${rw.entry.reason ?? ''}` : 'use not found' };
  return { results, table };
}

/** X5 needs cooking: steps 1–3 done, "milk and butter" for the cream (structured input; no interpreter, no explainer). */
async function cookShortcake(svc: Service, recipeId: string | null) {
  if (!recipeId) return { pass: false, detail: 'not saved' };
  const st = svc.startRecipe({ commandId: `probe-${Date.now()}`, recipeId });
  if (st.outcome !== 'started') return { pass: false, detail: JSON.stringify(st).slice(0, 200) };
  let run = st.run;
  for (const s of st.recipe.steps.slice(0, 3)) {
    const r = svc.recordProgress({ commandId: `probe-p-${s.id}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' });
    if (r.outcome !== 'recorded') return { pass: false, detail: JSON.stringify(r).slice(0, 200) };
    run = r.run;
  }
  const cream = st.recipe.ingredients.find((i) => /cream/i.test(i.name));
  if (!cream) return { pass: false, detail: 'no cream ingredient' };
  const ev = await svc.evaluateRescue({ commandId: `probe-e-${Date.now()}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: cream.id, proposedKindIds: ['whole-milk', 'unsalted-butter'], utterance: { text: 'milk and butter', channel: 'tapped' } });
  if (!('outcome' in ev) || ev.outcome !== 'refused') return { pass: false, detail: `outcome ${'outcome' in ev ? ev.outcome : '?'}` };
  return { pass: ev.why.verdict === 'no' && /^No/.test(ev.answer.text) && ev.why.facts.some((f) => /step 6/.test(f)), detail: ev.answer.text };
}

async function run() {
  if (existsSync(resultsPath) || existsSync(startedPath)) throw new Error('the frozen probe runs once: results (or a started run) exist');
  const probe = JSON.parse(readFileSync(probePath, 'utf8')) as Record<string, unknown> & { sha256: string; inputs: Record<string, string>; authorization: string };
  const { sha256: frozenSha, ...body } = probe;
  if (sha256(JSON.stringify(body)) !== frozenSha) throw new Error('probe-v1.json changed since freezing');
  for (const [f, x] of Object.entries(probe.inputs)) if (fileSha(join(dir, f)) !== x) throw new Error(`frozen input ${f} changed`);
  const now = identities();
  for (const [k, x] of Object.entries(now)) if (JSON.stringify(x) !== JSON.stringify(probe[k])) throw new Error(`frozen identity drifted: ${k}`);
  if (process.env.CC_LIVE !== '1') throw new Error('set CC_LIVE=1 (under the recorded authorization) to run the probe');
  const auth = JSON.parse(readFileSync(join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'missing'), 'utf8')) as Authorization;
  if (auth.id !== probe.authorization || !auth.maxCalls.extraction || !auth.maxCalls.swapAnalysis) throw new Error(`authorization ${auth.id} is not ${probe.authorization} with extraction and swapAnalysis`);
  const ledger = new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), auth);
  const nova = new NovaClient(ledger);
  const id = await nova.verifyIdentity();
  console.log(`AWS identity: ${id.principal}`);
  if (!id.ok) throw new Error(`refusing live calls: AWS identity is ${id.principal}, not the CourseCorrect IAM user`);
  const before = ledger.totals();
  writeFileSync(startedPath, JSON.stringify({ at: new Date().toISOString(), authorization: auth.id, identity: id.principal, ledgerBefore: before }, null, 2));
  const db = join(root, `.artifacts/probes/cards-${Date.now()}.db`);
  const { svc, auth: a, out } = await importAll(db, novaExtractor(nova), novaAnalyzer(nova), false);
  // keep everything: raw readings, raw cards, validation, wire answers, and the replay of what was read
  const replay = { readings: {} as Record<string, unknown>, cards: {} as Record<string, unknown> };
  const raw: Record<string, unknown> = {};
  for (const n of NAMES) {
    const ex = svc.store.all<{ status: string; raw_json: string | null; issues_json: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number }>('SELECT status, raw_json, issues_json, input_tokens, output_tokens, cost_usd FROM extractions WHERE draft_id = ?', out[n].draftId);
    const sa = svc.store.all<{ status: string; raw_json: string | null; issues_json: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number; input_hash: string }>('SELECT status, raw_json, issues_json, input_tokens, output_tokens, cost_usd, input_hash FROM swap_analyses WHERE draft_id = ?', out[n].draftId);
    raw[n] = { job: out[n].job, save: out[n].save, extraction: ex.map((x) => ({ ...x, raw: x.raw_json ? JSON.parse(x.raw_json) : null, issues: JSON.parse(x.issues_json), raw_json: undefined, issues_json: undefined })),
      swapAnalysis: sa.map((x) => ({ ...x, raw: x.raw_json ? JSON.parse(x.raw_json) : null, issues: x.issues_json ? JSON.parse(x.issues_json) : null, raw_json: undefined, issues_json: undefined })) };
    const pdf = await readPdf(new Uint8Array(readFileSync(join(dir, `${n}.pdf`))));
    if (pdf.ok && ex[0]?.raw_json) replay.readings[hash(userMessage(pdf.source.pages.filter((p) => p.status === 'TEXT')))] = JSON.parse(ex[0].raw_json);
    if (sa[0]?.raw_json) replay.cards[sa[0].input_hash] = JSON.parse(sa[0].raw_json);
  }
  let judged: ReturnType<typeof judge>;
  try { judged = judge(svc, a, out); judged.results.X5 = await cookShortcake(svc, out.shortcake.recipeId); }
  catch (e) { judged = { results: { ERROR: { pass: false, detail: (e as Error).message } }, table: [] }; }   // still keep every raw result
  const after = ledger.totals();
  const spend = ledger.entries().filter((e) => e.authorization === auth.id);
  const results = { kind: 'cc-cards-probe-results/1', at: new Date().toISOString(), authorization: auth.id, identity: id.principal, db,
    expectations: Object.fromEntries(Object.entries(judged.results).sort()), coverage: judged.table, raw,
    spend: { ledgerBefore: before, ledgerAfter: after, entries: spend } };
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  mkdirSync(join(root, '.artifacts/probes'), { recursive: true });
  writeFileSync(replayPath, JSON.stringify(replay, null, 2));
  for (const [k, x] of Object.entries(results.expectations)) console.log(`${k} ${x.pass ? 'PASS' : 'FAIL'} ${x.detail}`);
  console.log(`authorization ${auth.id}: $${after.authorizationUsd.toFixed(6)} · calls ${JSON.stringify(after.calls)}`);
  svc.close();
}

async function seed(dbPath: string | undefined) {
  if (!dbPath) throw new Error('usage: cards-probe.ts seed <db>');
  if (!existsSync(replayPath)) throw new Error('no replay: run the probe first');
  const replay = JSON.parse(readFileSync(replayPath, 'utf8')) as { readings: Record<string, unknown>; cards: Record<string, unknown> };
  const { svc, auth, out } = await importAll(dbPath, recordedExtractor(replay.readings, 'REPLAY_OF_LIVE_CARD_PROBE'), recordedAnalyzer(replay.cards, 'REPLAY_OF_LIVE_CARD_PROBE'), true);
  for (const n of NAMES) {
    const s = out[n].save as { release?: { kind: string; coverageSummary?: string } } | null;
    console.log(`${n}: ${(out[n].job as { state?: string }).state} · ${s?.release?.coverageSummary ?? s?.release?.kind ?? 'not saved'}`);
  }
  void auth; svc.close();
}

/** run()'s import and judging without calls: RECORDED fixtures (rehearsal) or the kept live output (re-validation). */
async function rehearse(live: boolean) {
  const rec = live ? JSON.parse(readFileSync(replayPath, 'utf8')) as { readings: Record<string, unknown>; cards: Record<string, unknown> } : await recordedDemo(v);
  const { svc, auth, out } = await importAll(join(root, `.artifacts/probes/cards-${live ? 'revalidation' : 'rehearsal'}-${Date.now()}.db`), recordedExtractor(rec.readings), recordedAnalyzer(rec.cards), false);
  const judged = judge(svc, auth, out);
  judged.results.X5 = await cookShortcake(svc, out.shortcake.recipeId);
  const note = live ? 'RE-VALIDATION of the kept live output (results-v1.json) by the code as of this file: no new calls; not the as-run result' : 'RECORDED test fixtures, not Nova';
  writeFileSync(live ? join(dir, 'revalidated-v1.json') : join(root, '.artifacts/probes/cards-rehearsal.json'), JSON.stringify({ note, at: new Date().toISOString(), ...judged }, null, 2));
  for (const [k, x] of Object.entries(judged.results).sort()) console.log(`${k} ${x.pass ? 'PASS' : 'FAIL'} ${x.detail}`);
  svc.close();
}

const mode = process.argv[2];
if (mode === 'freeze') await freeze();
else if (mode === 'run') await run();
else if (mode === 'rehearse') await rehearse(false);
else if (mode === 'revalidate') await rehearse(true);
else if (mode === 'seed') await seed(process.argv[3]);
else console.log('usage: cards-probe.ts freeze | run | rehearse | revalidate | seed <db>');
