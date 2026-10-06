// M1 walkthrough on the imported demo recipes: real MCP client → Streamable HTTP → service. The three demo PDFs are
// imported first (RECORDED readings + hand-written RECORDED swap cards: test fixtures, no paid calls); every cooking
// answer then comes from the engine over reviewed rules and validated cards. Input is structured (tapped), so no model
// is called at cook time. Writes .artifacts/walkthrough/m1-<timestamp>.json (ignored). Prints one line per call.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEMO, demoPdf, recordedDemo } from '../tests/fixtures/demo-cards.ts';
import { Authoring } from './authoring/drafts.ts';
import { recordedExtractor } from './authoring/extract.ts';
import { recordedAnalyzer } from './authoring/swap-analysis.ts';
import { Service } from './service/commands.ts';
import { loadContent } from './service/content.ts';
import { startHttp } from './service/http.ts';
import { noneInterpreter } from './service/interpret.ts';

type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads are asserted, not typed, here
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(import.meta.dirname, '../.artifacts/walkthrough');
mkdirSync(outDir, { recursive: true });
const adminToken = randomUUID();
const content = loadContent();
const svc = new Service({ dbPath: join(outDir, `m1-${stamp}.db`), content, interpreter: noneInterpreter, fixtureRecipes: false });
const rec = await recordedDemo(content.vocab);
const authoring = new Authoring({ store: svc.store, content, extractor: recordedExtractor(rec.readings, 'RECORDED_FIXTURES'), analyzer: recordedAnalyzer(rec.cards, 'RECORDED_FIXTURES') });
svc.catalog = () => authoring.catalog();
const port = 18000 + Math.floor(Math.random() * 1000);
const server = await startHttp(svc, { port, adminToken, authoring });
const client = new Client({ name: 'm1-walkthrough', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

const log: { beat: string; tool: string; args: unknown; result: J }[] = [];
const failures: string[] = [];
let beat = '';
const check = (ok: boolean, what: string) => { if (!ok) failures.push(`${beat}: ${what}`); console.log(`    ${ok ? 'PASS' : 'FAIL'} ${what}`); };
async function call(tool: string, args: J = {}): Promise<J> {
  const r = await client.callTool({ name: tool, arguments: args });
  const out = (r.structuredContent ?? {}) as J;
  log.push({ beat, tool, args, result: out });
  const text = (r.content as { text: string }[])[0]?.text ?? '';
  console.log(`  ${tool.padEnd(18)} ${String(out.outcome ?? (out.run ? 'ok' : out.recipes ? 'ok' : '-')).padEnd(20)} ${text.slice(0, 150)}`);
  return out;
}
const scope = (run: J) => ({ runId: run.id, epoch: run.epoch, expectedRevision: run.revision });
const ids: Record<string, string> = {};
let recipe: J = {};
/** Start (replacing any active session, explicitly) and report steps 1…n done through record_progress. */
async function cookTo(name: string, done: number): Promise<J> {
  const cur = (await call('get_active_recipe')).run as J | null;
  const st = await call('start_recipe', { commandId: randomUUID(), recipeId: ids[name], ...(cur ? { replace: { runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, confirm: true } } : {}) });
  recipe = st.recipe;
  let run = st.run;
  for (const s of (st.recipe.steps as J[]).slice(0, done)) run = (await call('record_progress', { commandId: randomUUID(), ...scope(run), stepId: s.id, progress: 'done' })).run;
  return run;
}
const ing = (re: RegExp) => (recipe.ingredients as J[]).find((i) => re.test(i.name))!.id as string;
const ask = (run: J, re: RegExp, proposedKindIds: string[] = [], extra: J = {}) =>
  call('evaluate_rescue', { commandId: randomUUID(), ...scope(run), missingIngredientId: ing(re), proposedKindIds, utterance: { text: re.source, channel: 'tapped' }, ...extra });

try {
  const unauth = await fetch(`http://127.0.0.1:${port}/admin/reset`, { method: 'POST', body: '{}' });
  beat = 'setup'; console.log('\n== setup: import the three demo PDFs (RECORDED readings and swap-card fixtures)');
  check(unauth.status === 401, 'admin reset refuses without the bearer token');
  for (const d of DEMO) {
    const r = await authoring.createImport({ kind: 'pdf', bytes: demoPdf(d.lines), filename: `${d.name}.pdf` });
    if (r.status !== 202) throw new Error('import');
    await authoring.waitForJob(r.job.id);
    const saved = authoring.save(r.draftId, { expectedRevision: authoring.revision(r.draftId) });
    ids[d.name] = saved.recipeId;
    console.log(`    ${d.name}: ${saved.release.kind === 'eligible' ? saved.release.coverageSummary : 'ineligible'}`);
  }
  const tools = await client.listTools();
  check(tools.tools.map((t) => t.name).sort().join() === 'apply_amendment,delete_recipe,evaluate_rescue,get_active_recipe,import_recipe,list_recipes,record_progress,start_recipe', 'exactly the eight MCP tools (six cooking + import/archive, owner amendment 2026-10-05)');
  const book = await call('list_recipes');
  check(book.recipes.length === 3 && (book.recipes as J[]).every((r) => /a card for (\d+) of \1 uses$/.test(r.release.coverageSummary)), 'the Recipe Book shows the three imported demo recipes; every use has a valid card');

  beat = '§9.1 risotto'; console.log('\n== §9.1 risotto: reviewed split (cross-check), then a second change from a card');
  let run = await cookTo('risotto', 4);
  const e1 = await ask(run, /wine/i, ['lemon-juice']);
  check(e1.outcome === 'needsFacts' && e1.questions[0].items.length === 2, 'needsFacts: 120 ML stock and 10 ML lemon juice');
  const e2 = await ask(run, /wine/i, ['lemon-juice'], { previousEvaluationId: e1.id, answers: [{ questionId: e1.questions[0].id, value: 'yes' }] });
  check(e2.outcome === 'proposal' && e2.actionable === true && /^Engineering content/.test(e2.candidates[0].contentLabel), 'reviewed proposal, actionable; answering applied nothing');
  const cand = e2.candidates[0];
  const applyArgs = { commandId: randomUUID(), ...scope(run), evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true };
  const ap = await call('apply_amendment', applyArgs);
  check(ap.outcome === 'applied' && ap.run.steps[4].progress === 'notStarted', 'applied; step 5 current and not marked done');
  const recon = await call('get_active_recipe', { commandId: applyArgs.commandId });
  check(recon.command.status === 'applied', 'reconciliation read: applied (server-computed)');
  check((await call('apply_amendment', applyArgs)).outcome === 'alreadyApplied', 'identical retry replays alreadyApplied (one amendment)');
  run = ap.run;
  for (const s of (recipe.steps as J[]).slice(4, 6)) run = (await call('record_progress', { commandId: randomUUID(), ...scope(run), stepId: s.id, progress: 'done' })).run;
  const c1 = await ask(run, /parmesan/i);
  check(c1.outcome === 'refused' && c1.refusal.kind === 'earlierChangeConflict', 'the Parmesan card would rewrite step 7, which the accepted change altered: refused (earlier-change conflict)');
  run = await cookTo('risotto', 6);
  const p1 = await ask(run, /parmesan/i);
  const p2 = await ask(run, /parmesan/i, [], { previousEvaluationId: p1.id, answers: (p1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
  check(p2.outcome === 'proposal' && /^Prepared at import \(AI\)/.test(p2.candidates[0].contentLabel), `fresh run: Parmesan → card plan, labelled: ${p2.candidates?.[0]?.headline}`);
  const ap2 = await call('apply_amendment', { commandId: randomUUID(), ...scope(run), evaluationId: p2.id, candidateId: p2.candidates[0].id, planId: p2.candidates[0].planId, accepted: true });
  check(ap2.outcome === 'applied', 'card plan applied after explicit acceptance');
  console.log(`    step 7 now: ${ap2.run.steps[6].effectiveText}`);
  const salt = await ask(ap2.run, /^salt/i);
  check(salt.outcome === 'refused' && salt.refusal.kind === 'earlierChangeConflict', 'a second card on the changed step 7 is refused (earlier-change conflict)');

  beat = '§9.2 protected'; console.log('\n== §9.2 protected started work');
  run = await cookTo('risotto', 4);
  const st = await call('record_progress', { commandId: randomUUID(), ...scope(run), stepId: recipe.steps[4].id, progress: 'started' });
  const pw = await ask(st.run, /wine/i, ['lemon-juice']);
  check(pw.outcome === 'refused' && pw.refusal.kind === 'protectedWork', 'protected-work refusal; no question, no quantities');

  beat = '§9.3 shortcake'; console.log('\n== §9.3 shortcake: step 4 no for now (card), step 6 no (card and reviewed rule)');
  run = await cookTo('shortcake', 3);
  const k4 = await ask(run, /cream/i, ['whole-milk', 'unsalted-butter']);
  check(k4.outcome === 'refused' && k4.why.verdict === 'no' && (k4.why.facts as string[]).some((f) => /whipped in step 6/.test(f)), `step 4: ${k4.answer?.text}`);
  run = await cookTo('shortcake', 5);
  const k6 = await ask(run, /cream/i);
  check(k6.outcome === 'refused' && k6.refusal.kind === 'functionallyUnsupported' && /^No, because .*whip/.test(k6.answer.text), `step 6: ${k6.answer?.text}`);

  beat = '§9.4 scones'; console.log('\n== §9.4 scones: two cream uses, conditional quantity, separate brushing confirmation');
  run = await cookTo('scones', 2);
  const s1 = await ask(run, /cream/i, ['whole-milk', 'unsalted-butter']);
  check(s1.outcome === 'needsFacts' && s1.questions.length === 2, 'two questions: exact amounts, and brushing milk separately');
  const s2 = await ask(run, /cream/i, ['whole-milk', 'unsalted-butter'], { previousEvaluationId: s1.id, answers: [{ questionId: s1.questions[0].id, value: 'yes' }] });
  check(s2.outcome === 'needsFacts' && s2.questions.length === 1, 'confirming numeric milk does not cover the brushing milk');
  const s3 = await ask(run, /cream/i, ['whole-milk', 'unsalted-butter'], { previousEvaluationId: s1.id, answers: (s1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
  check(s3.outcome === 'proposal', 'both confirmed → proposal (reviewed rule)');
  const sa = await call('apply_amendment', { commandId: randomUUID(), ...scope(run), evaluationId: s3.id, candidateId: s3.candidates[0].id, planId: s3.candidates[0].planId, accepted: true });
  check(sa.outcome === 'applied', 'applied');
  console.log(`    step 3 now: ${sa.run.steps[2].effectiveText}`);
  console.log(`    step 6 now: ${sa.run.steps[5].effectiveText}`);
  run = await cookTo('scones', 5);
  const b1 = await ask(run, /cream/i);
  const b2 = await ask(run, /cream/i, [], { previousEvaluationId: b1.id, answers: (b1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
  check(b2.outcome === 'proposal' && /a little milk/.test(b2.candidates[0].headline) && /^Prepared at import/.test(b2.candidates[0].contentLabel), `brushing cream at step 6 → card: ${b2.candidates?.[0]?.headline}`);

  beat = 'C-3 replacement'; console.log('\n== C-3 explicit run replacement');
  const blocked = await call('start_recipe', { commandId: randomUUID(), recipeId: ids.risotto });
  check(blocked.code === 'ACTIVE_RUN_EXISTS', 'ordinary start refuses while a run is active');
  const cur = (await call('get_active_recipe')).run as J;
  const swapped = await call('start_recipe', { commandId: randomUUID(), recipeId: ids.risotto, replace: { runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, confirm: true } });
  check(swapped.outcome === 'started' && swapped.run.id !== cur.id, 'explicit, confirmed replacement starts a fresh run');

  beat = 'activity'; console.log('\n== activity (server-recorded real MCP calls)');
  const act = (await (await fetch(`http://127.0.0.1:${port}/activity`)).json()) as { entries: J[] };
  check(act.entries.length === log.length, `activity rows (${act.entries.length}) = MCP calls made (${log.length})`);
} catch (e) {
  failures.push(`${beat}: threw ${(e as Error).message}`);
} finally {
  await client.close();
  server.close();
  writeFileSync(join(outDir, `m1-${stamp}.json`), JSON.stringify({ kind: 'cc-m1-walkthrough/2', at: stamp, recipes: 'imported demo PDFs (RECORDED readings + RECORDED card fixtures)', interpreter: 'structured (tapped)', mode: 'ENGINEERING', failures, calls: log }, null, 2));
  console.log(`\n${failures.length ? `FAILED (${failures.length}):\n  ${failures.join('\n  ')}` : 'ALL CHECKS PASSED'} · artifact .artifacts/walkthrough/m1-${stamp}.json`);
  svc.close();
  process.exitCode = failures.length ? 1 : 0;
}
