// Frozen probe cards2 (owner authorization cards2-2026-10-07: ≤1 extraction + ≤4 swapAnalysis, ≤$0.05, non-root profile):
// the OD-6 explicit-quantity scone read live once, and swap analysis under prompt ccmcp-swaps-2 for it and the three
// retained probe recipes (their readings replayed from the 2026-10-04 probe; no new extraction for them).
//   node src/probes/cards2-probe.ts freeze    → private/probes/cards2/probe-v1.json (refuses to overwrite)
//   node src/probes/cards2-probe.ts rehearse  → the same import + judging with no calls (RECORDED explicit reading fixture;
//                                               no cards for it; the retained v1 cards for the others)
//   CC_LIVE=1 CC_AUTHORIZATION=live-authorization-cards2.json node src/probes/cards2-probe.ts run
//   node src/probes/cards2-probe.ts revalidate → the kept live output through the current code (no calls; revalidated-v1.json)
//       run → runs ONCE: results-v1.json (every raw output, failures included) and .artifacts/probes/cards2-replay.json (the
//         explicit scone's reading and cards only: existing analyses of the other recipes are not replaced)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, promptIdentity, PROMPT_VERSION, recordedExtractor, userMessage, type Extractor } from '../authoring/extract.ts';
import { Ledger, NOVA, NovaClient, type Authorization } from '../authoring/nova.ts';
import { readPdf } from '../authoring/source.ts';
import { novaAnalyzer, recordedAnalyzer, SWAP_SYSTEM, SWAP_VERSION, swapPromptIdentity, type SwapAnalyzer } from '../authoring/swap-analysis.ts';
import { hash, sha256 } from '../domain/rational.ts';
import { stepOrder } from '../domain/recipe.ts';
import { Service } from '../service/commands.ts';
import { loadContent } from '../service/content.ts';
import { noneInterpreter } from '../service/interpret.ts';
import { SCONE_EXPLICIT_READING } from '../../tests/fixtures/demo-sources.ts';

const root = join(import.meta.dirname, '../..');
const dir = join(root, 'private/probes/cards2');
const probePath = join(dir, 'probe-v1.json'), resultsPath = join(dir, 'results-v1.json'), startedPath = join(dir, 'run-started.json');
const replay1 = join(root, '.artifacts/probes/cards-replay.json'), replayPath = join(root, '.artifacts/probes/cards2-replay.json');
const INPUTS: Record<string, string> = {   // name → file; only 'explicit' is read live
  explicit: 'private/probes/cards2/scones-explicit.pdf', scones: 'private/probes/cards/scones.pdf',
  risotto: 'private/probes/cards/risotto.pdf', shortcake: 'private/probes/cards/shortcake.pdf',
};
const content = loadContent();
const v = content.vocab;
const fileSha = (p: string) => sha256(readFileSync(join(root, p)).toString('latin1'));
const identities = () => ({
  model: NOVA.modelId, region: NOVA.region,
  extraction: { version: PROMPT_VERSION, identity: promptIdentity(v) },
  swapAnalysis: { version: SWAP_VERSION, identity: swapPromptIdentity(v) },
  vocabularyHash: hash(v), patternSetHash: hash(content.patterns.map((p) => hash(p)).sort()), rolesHash: hash(content.roles),
});
const EXPECTATIONS = [
  { id: 'Y1', what: 'Explicit scone reads: job succeeded; 5 ingredients / 7 steps; heavy cream is ONE ingredient with two ADD uses, step 3 = 300 ML and step 6 = 15 ML, both read from the source.' },
  { id: 'Y2', what: 'R-1: both cream uses have MACHINE_CHECKED roles (liquid + fat at step 3, browning at step 6) with no owner action.' },
  { id: 'Y3', what: 'Rule v2 binds (v1 not applicable): both cream uses show the v2 plan: 85 g cold butter, 180 ML milk plus up to 30 ML only if needed, 15 ML milk to brush.' },
  { id: 'Y4', what: 'Cooking the saved import, steps 1–2 done, cream missing: one itemized milk question; explicit acceptance applies the import plan id; step 3 reads 180 ML milk, step 6 "15 ML milk"; step 3 not started.' },
  { id: 'Y5', what: 'Prompt v2 (measured on all four analyses): no KIND_MISMATCH, SWAP_IS_SAME_INGREDIENT, self-sibling or absent-swap repair; every card failure is listed.' },
  { id: 'Y6', what: 'Every use of every recipe has exactly one analysis status.' },
];

async function freeze() {
  if (existsSync(probePath)) throw new Error(`${probePath} exists: the probe is frozen`);
  mkdirSync(dir, { recursive: true });
  const body = {
    kind: 'cc-cards2-probe/1', frozenAt: new Date().toISOString(), status: 'FROZEN · NOT RUN', authorization: 'cards2-2026-10-07',
    ...identities(), swapSystem: SWAP_SYSTEM, inputs: Object.fromEntries(Object.entries(INPUTS).map(([k, f]) => [k, { file: f, sha256: fileSha(f) }])),
    budget: { calls: { extraction: 1, swapAnalysis: 4 }, caps: { extraction: 1, swapAnalysis: 4, maxUsd: 0.05 }, estimatedUsd: 0.022 },
    expectations: EXPECTATIONS,
    rules: 'One live extraction (the explicit scone) and one live swap analysis per recipe, never retried. Every result is kept, including failures. A failed expectation is reported, not tuned: no rerun without owner approval.',
  };
  writeFileSync(probePath, JSON.stringify({ ...body, sha256: sha256(JSON.stringify(body)) }, null, 2));
  console.log(`frozen: ${probePath}`);
}

const pagesOf = async (f: string) => { const r = await readPdf(new Uint8Array(readFileSync(join(root, f)))); if (!r.ok) throw new Error(f); return r.source.pages.filter((p) => p.status === 'TEXT'); };
/** Replay where a reading is retained; otherwise the given extractor (live: only the explicit scone). */
function mixed(readings: Record<string, unknown>, other: Extractor): Extractor {
  const rec = recordedExtractor(readings, 'REPLAY_OF_LIVE_CARD_PROBE');
  return { name: `${rec.name}+${other.name}`, async extract(pages, vv, key, label) { const r = await rec.extract(pages, vv, key, label); return r.ok ? r : other.extract(pages, vv, key, label); } };
}

async function cook(svc: Service, recipeId: string, planId: string | undefined) {
  const st = svc.startRecipe({ commandId: `p2-start-${Date.now()}`, recipeId });
  if (st.outcome !== 'started') return { pass: false, detail: JSON.stringify(st).slice(0, 200) };
  let run = st.run;
  for (const s of st.recipe.steps.slice(0, 2)) { const r = svc.recordProgress({ commandId: `p2-${s.id}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' }); if (r.outcome !== 'recorded') return { pass: false, detail: r.code }; run = r.run; }
  const cream = st.recipe.ingredients.find((i) => /cream/i.test(i.name))!;
  const ask = (prev?: { id: string; answers: { questionId: string; value: 'yes' }[] }) => svc.evaluateRescue({ commandId: `p2-e-${Date.now()}-${Math.random()}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: cream.id, proposedKindIds: ['whole-milk', 'unsalted-butter'], utterance: { text: 'milk and butter', channel: 'tapped' }, ...(prev ? { previousEvaluationId: prev.id, answers: prev.answers } : {}) });
  const e1 = await ask();
  if (e1.outcome !== 'needsFacts') return { pass: false, detail: `first: ${e1.outcome}` };
  const items = e1.questions.flatMap((q) => q.items.map((i) => i.text));
  const e2 = await ask({ id: e1.id, answers: e1.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) });
  if (e2.outcome !== 'proposal') return { pass: false, detail: `second: ${e2.outcome}; items ${items.join(' | ')}` };
  const cur = svc.getActiveRecipe().run!;
  const ap = svc.applyAmendment({ commandId: `p2-a-${Date.now()}`, runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, evaluationId: e2.id, candidateId: e2.candidates[0].id, planId: e2.candidates[0].planId, accepted: true });
  if (ap.outcome !== 'applied') return { pass: false, detail: `apply: ${ap.outcome}` };
  const s3 = ap.run.steps[2], s6 = ap.run.steps[5];
  // the itemized form; step titles are whatever the reading gave (the as-run check pinned the fixture's titles: a harness defect)
  // current wording (2026-10-07 polish): purposes from techniques, the conditional extra apart
  const pass = items[0] === '225 ML milk: 180 ML for the dough (step 3) + 15 ML for brushing (step 6) + up to 30 ML extra for the dough, only if needed'
    && e2.candidates[0].id === planId && /180 ML milk/.test(s3.effectiveText) && s6.effectiveText === 'Brush the tops with 15 ML milk.' && s3.progress === 'notStarted';
  return { pass, detail: `question: ${items.join(' | ')} · candidate ${e2.candidates[0].id} (import plan ${planId}) · step 3: ${s3.effectiveText} · step 6: ${s6.effectiveText} · step 3 ${s3.progress}` };
}

async function importAndJudge(dbPath: string, extractor: Extractor, analyzer: SwapAnalyzer) {
  const svc = new Service({ dbPath, content, interpreter: noneInterpreter, fixtureRecipes: false });
  const auth = new Authoring({ store: svc.store, content, extractor, analyzer });
  svc.catalog = () => auth.catalog();
  const out: Record<string, { draftId: string; recipeId: string | null; job: unknown }> = {};
  for (const [name, f] of Object.entries(INPUTS)) {
    const r = await auth.createImport({ kind: 'pdf', bytes: new Uint8Array(readFileSync(join(root, f))), filename: f.split('/').pop()! });
    if (r.status !== 202) { out[name] = { draftId: '', recipeId: null, job: r }; continue; }
    const job = await auth.waitForJob(r.job.id);
    const saved = job.state === 'failed' ? null : auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId), idempotencyKey: `cards2-${name}` });
    out[name] = { draftId: r.draftId, recipeId: saved?.recipeId ?? null, job };
  }
  const results: Record<string, { pass: boolean; detail: string }> = {};
  const table: unknown[] = [];
  const failures: string[] = [], repairs: string[] = [];
  let everyUse = true;
  for (const [name] of Object.entries(INPUTS)) {
    const d = out[name]; if (!d.draftId) { everyUse = false; continue; }
    const c = auth.getDraft(d.draftId).draft.content;
    const { pack } = auth.coverageOf(d.draftId);
    for (const g of c?.ingredients ?? []) for (const u of g.uses) {
      const e = pack?.cards?.find((x) => x.useId === u.id);
      if (!u.analysis) everyUse = false;
      if (e?.status === 'INVALID') failures.push(`${name} step ${c!.steps.find((s) => s.id === u.stepId)!.ordinal} ${g.name}: ${e.reason}`);
      for (const n of e?.normalized ?? []) repairs.push(`${name} ${g.name}: ${n}`);
      table.push({ recipe: name, step: c!.steps.find((s) => s.id === u.stepId)!.ordinal, ingredient: g.name, amount: u.amount.display, status: u.analysis?.status, offer: u.analysis?.offer, reason: u.analysis?.reason ?? null,
        roles: u.reviewedFunction ?? u.proposedFunction, plans: u.analysis?.plans.map((p) => ({ planId: p.planId, ruleId: p.ruleId, kind: p.kind, provenance: p.provenance.kind, title: p.title, replacements: p.replacements.map((x) => `${x.amount.display} ${x.ingredientName}`) })) ?? [], card: e ?? null });
    }
  }
  const x = out.explicit, job = x.job as { state?: string };
  const r = x.draftId ? auth.effective(x.draftId) : null;
  const cream = r?.ingredients.filter((i) => /cream/i.test(i.name)) ?? [];
  const cu = r && cream.length === 1 ? r.uses.filter((u) => u.ingredientId === cream[0].ingredientId && u.kind === 'ADD') : [];
  const amt = (u: (typeof cu)[number]) => (u.amount.kind === 'EXACT' ? `${u.amount.value.n / u.amount.value.d} ${u.amount.unit} ${u.amountProv.status}` : u.amount.kind);
  results.Y1 = { pass: job?.state === 'succeeded' && r?.ingredients.length === 5 && r?.steps.length === 7 && cu.length === 2 && cu.map((u) => `${stepOrder(r!, u.stepId)}:${amt(u)}`).join(',') === '3:300 ML SOURCE_VERIFIED,6:15 ML SOURCE_VERIFIED',
    detail: `${job?.state} · ${r ? `${r.ingredients.length}/${r.steps.length}` : 'no reading'} · cream ingredients ${cream.length} · uses ${cu.map((u) => `step ${stepOrder(r!, u.stepId)}: ${amt(u)}`).join('; ')}` };
  const wc = x.draftId ? auth.getDraft(x.draftId).draft.content!.ingredients.filter((g) => /cream/i.test(g.name)).flatMap((g) => g.uses) : [];
  results.Y2 = { pass: wc.length === 2 && wc.every((u) => u.reviewedFunction?.authority === 'MACHINE_CHECKED'), detail: wc.map((u) => `${u.reviewedFunction?.labels.join('+') ?? u.proposedFunction?.labels.join('+')} (${u.reviewedFunction?.authority ?? 'unresolved'})`).join('; ') };
  const p0 = wc[0]?.analysis?.plans[0];
  const v1 = x.draftId ? auth.coverageOf(x.draftId).pack?.coverage.find((e) => e.patternId === 'cream_to_butter_milk' && e.patternVersion === 1) : undefined;
  results.Y3 = { pass: wc.length === 2 && wc.every((u) => u.analysis?.status === 'available' && u.analysis.plans[0]?.ruleId === 'cream_to_butter_milk@2') && v1?.status !== 'BOUND'
      && JSON.stringify(p0?.replacements.map((q) => `${q.amount.display} ${q.ingredientName}`).sort()) === JSON.stringify(['15 ML Milk', '180 ML, plus up to 30 ML more if needed Milk', '85 g Butter']),
    detail: `${wc.map((u) => `${u.analysis?.status} ${u.analysis?.plans[0]?.ruleId ?? u.analysis?.reason?.code}`).join('; ')} · v1 ${v1?.status} ${v1?.failedCheck?.code ?? ''} · ${p0?.replacements.map((q) => `${q.amount.display} ${q.ingredientName}`).join(', ') ?? ''}` };
  results.Y4 = x.recipeId && results.Y3.pass ? await cook(svc, x.recipeId, p0?.planId) : { pass: false, detail: 'not cooked: Y3 failed or not saved' };
  const bad = failures.filter((f) => /KIND_MISMATCH|SWAP_IS_SAME_INGREDIENT/.test(f)).concat(repairs);
  results.Y5 = { pass: !bad.length, detail: `failures (${failures.length}): ${failures.join(' | ') || 'none'} · repairs (${repairs.length}): ${repairs.join(' | ') || 'none'}` };
  results.Y6 = { pass: everyUse, detail: `${table.length} uses` };
  return { svc, auth, out, results, table };
}

async function rehearse() {
  const old = JSON.parse(readFileSync(replay1, 'utf8')) as { readings: Record<string, unknown>; cards: Record<string, unknown> };
  const readings = { ...old.readings, [hash(userMessage(await pagesOf(INPUTS.explicit)))]: SCONE_EXPLICIT_READING };
  const j = await importAndJudge(join(root, `.artifacts/probes/cards2-rehearsal-${Date.now()}.db`), recordedExtractor(readings, 'REHEARSAL'), recordedAnalyzer(old.cards, 'REHEARSAL_V1_CARDS'));
  writeFileSync(join(root, '.artifacts/probes/cards2-rehearsal.json'), JSON.stringify({ note: 'REHEARSAL: RECORDED explicit reading (test fixture), retained v1 cards, no calls; prompt-v2 expectations (Y5) are not meaningful here', at: new Date().toISOString(), results: j.results, table: j.table }, null, 2));
  for (const [k, x] of Object.entries(j.results)) console.log(`${k} ${x.pass ? 'PASS' : 'FAIL'} ${x.detail}`);
  j.svc.close();
}

async function run() {
  if (existsSync(resultsPath) || existsSync(startedPath)) throw new Error('the frozen probe runs once: results (or a started run) exist');
  const probe = JSON.parse(readFileSync(probePath, 'utf8')) as Record<string, unknown> & { sha256: string; inputs: Record<string, { file: string; sha256: string }>; authorization: string };
  const { sha256: frozenSha, ...body } = probe;
  if (sha256(JSON.stringify(body)) !== frozenSha) throw new Error('probe-v1.json changed since freezing');
  for (const [k, x] of Object.entries(probe.inputs)) if (fileSha(x.file) !== x.sha256) throw new Error(`frozen input ${k} changed`);
  for (const [k, x] of Object.entries(identities())) if (JSON.stringify(x) !== JSON.stringify(probe[k])) throw new Error(`frozen identity drifted: ${k}`);
  if (process.env.CC_LIVE !== '1') throw new Error('set CC_LIVE=1 (under the recorded authorization) to run the probe');
  const auth = JSON.parse(readFileSync(join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'missing'), 'utf8')) as Authorization;
  if (auth.id !== probe.authorization) throw new Error(`authorization ${auth.id} is not ${probe.authorization}`);
  const ledger = new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), auth);
  const nova = new NovaClient(ledger);
  const id = await nova.verifyIdentity();
  console.log(`AWS identity: ${id.principal}`);
  if (!id.ok) throw new Error(`refusing live calls: AWS identity is ${id.principal}, not the CourseCorrect IAM user`);
  const before = ledger.totals();
  writeFileSync(startedPath, JSON.stringify({ at: new Date().toISOString(), authorization: auth.id, identity: id.principal, ledgerBefore: before }, null, 2));
  const old = JSON.parse(readFileSync(replay1, 'utf8')) as { readings: Record<string, unknown> };
  const db = join(root, `.artifacts/probes/cards2-${Date.now()}.db`);
  let j: Awaited<ReturnType<typeof importAndJudge>> | null = null, error: string | null = null;
  try { j = await importAndJudge(db, mixed(old.readings, novaExtractor(nova)), novaAnalyzer(nova)); } catch (e) { error = (e as Error).message; }
  // keep everything: raw readings, raw cards, validation, the judged table, the spend
  const svc = j?.svc ?? new Service({ dbPath: db, content, interpreter: noneInterpreter, fixtureRecipes: false });
  const raw: Record<string, unknown> = {};
  const replay = { readings: {} as Record<string, unknown>, cards: {} as Record<string, unknown> };
  for (const name of Object.keys(INPUTS)) {
    const d = j?.out[name];
    if (!d?.draftId) { raw[name] = { job: d?.job ?? null }; continue; }
    const ex = svc.store.all<{ extractor: string; status: string; raw_json: string | null; issues_json: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number }>('SELECT extractor, status, raw_json, issues_json, input_tokens, output_tokens, cost_usd FROM extractions WHERE draft_id = ?', d.draftId);
    const sa = svc.store.all<{ analyzer: string; status: string; raw_json: string | null; issues_json: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number; input_hash: string }>('SELECT analyzer, status, raw_json, issues_json, input_tokens, output_tokens, cost_usd, input_hash FROM swap_analyses WHERE draft_id = ?', d.draftId);
    raw[name] = { job: d.job, extraction: ex.map((x) => ({ ...x, raw: x.raw_json ? JSON.parse(x.raw_json) : null, raw_json: undefined, issues: JSON.parse(x.issues_json), issues_json: undefined })),
      swapAnalysis: sa.map((x) => ({ ...x, raw: x.raw_json ? JSON.parse(x.raw_json) : null, raw_json: undefined, issues: x.issues_json ? JSON.parse(x.issues_json) : null, issues_json: undefined })) };
    if (name === 'explicit') {   // the demo replays only the new recipe; the others keep their existing analyses
      if (ex[0]?.raw_json) replay.readings[hash(userMessage(await pagesOf(INPUTS.explicit)))] = JSON.parse(ex[0].raw_json);
      if (sa[0]?.raw_json) replay.cards[sa[0].input_hash] = JSON.parse(sa[0].raw_json);
    }
  }
  const after = ledger.totals();
  const results = { kind: 'cc-cards2-probe-results/1', at: new Date().toISOString(), authorization: auth.id, identity: id.principal, db, error,
    expectations: j?.results ?? {}, coverage: j?.table ?? [], raw, spend: { ledgerBefore: before, ledgerAfter: after, entries: ledger.entries().filter((e) => e.authorization === auth.id) } };
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  mkdirSync(join(root, '.artifacts/probes'), { recursive: true });
  writeFileSync(replayPath, JSON.stringify(replay, null, 2));
  if (error) console.log(`ERROR ${error}`);
  for (const [k, x] of Object.entries(results.expectations)) console.log(`${k} ${x.pass ? 'PASS' : 'FAIL'} ${x.detail}`);
  console.log(`authorization ${auth.id}: $${after.authorizationUsd.toFixed(6)} · calls ${JSON.stringify(after.calls)}`);
  svc.close();
}

/** The kept live output through the current code (no calls). The as-run record stays results-v1.json. */
async function revalidate() {
  const r = JSON.parse(readFileSync(resultsPath, 'utf8')) as { raw: Record<string, { extraction?: { raw: unknown }[]; swapAnalysis?: { raw: unknown; input_hash: string }[] }> };
  const old = JSON.parse(readFileSync(replay1, 'utf8')) as { readings: Record<string, unknown> };
  const readings = { ...old.readings, [hash(userMessage(await pagesOf(INPUTS.explicit)))]: r.raw.explicit.extraction![0].raw };
  const cards = Object.fromEntries(Object.values(r.raw).flatMap((x) => (x.swapAnalysis ?? []).filter((a) => a.raw).map((a) => [a.input_hash, a.raw])));
  const j = await importAndJudge(join(root, `.artifacts/probes/cards2-revalidation-${Date.now()}.db`), recordedExtractor(readings, 'REPLAY_OF_CARDS2_PROBE'), recordedAnalyzer(cards, 'REPLAY_OF_CARDS2_PROBE'));
  writeFileSync(join(dir, 'revalidated-v1.json'), JSON.stringify({ note: 'RE-VALIDATION of the kept live output (results-v1.json) by the code as of this file: no new calls; not the as-run result', at: new Date().toISOString(), results: j.results, coverage: j.table }, null, 2));
  for (const [k, x] of Object.entries(j.results)) console.log(`${k} ${x.pass ? 'PASS' : 'FAIL'} ${x.detail}`);
  j.svc.close();
}

const mode = process.argv[2];
if (mode === 'freeze') await freeze();
else if (mode === 'rehearse') await rehearse();
else if (mode === 'run') await run();
else if (mode === 'revalidate') await revalidate();
else console.log('usage: cards2-probe.ts freeze | rehearse | run');
