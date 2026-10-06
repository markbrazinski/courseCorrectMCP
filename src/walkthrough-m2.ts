// M2 walkthrough over real HTTP (import/draft routes) and real MCP (cooking). Extraction = REPLAY of the retained live M2
// probe readings plus RECORDED readings of the demo PDFs; swap analysis = hand-written RECORDED card fixtures (no paid
// calls); interpretation = structured/tapped input. No human input on import (owner decisions 2026-10-02): every use's
// role and swap come from its validated card (reviewed rules as cross-check), amounts from the source. The Recipe Book
// shows the imported demo recipes. Engineering content only.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Authoring } from './authoring/drafts.ts';
import { recordedExtractor } from './authoring/extract.ts';
import { recordedAnalyzer } from './authoring/swap-analysis.ts';
import { DEMO, demoPdf, recordedDemo } from '../tests/fixtures/demo-cards.ts';
import { Service } from './service/commands.ts';
import { loadContent } from './service/content.ts';
import { startHttp } from './service/http.ts';
import { noneInterpreter } from './service/interpret.ts';
import { RECIPE } from '../tests/fixtures/ids.ts';

type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads asserted, not typed, here
const root = join(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(root, '.artifacts/walkthrough');
mkdirSync(outDir, { recursive: true });
const inputs = join(root, 'private/probes/m2/inputs');
const token = randomUUID();
const content = loadContent();
const replay = JSON.parse(readFileSync(join(root, '.artifacts/probes/m2-replay.json'), 'utf8')) as Record<string, unknown>;
const rec = await recordedDemo(content.vocab);
const svc = new Service({ dbPath: join(outDir, `m2-${stamp}.db`), content, interpreter: noneInterpreter, fixtureRecipes: false });
const authoring = new Authoring({ store: svc.store, content, extractor: recordedExtractor({ ...replay, ...rec.readings }, 'REPLAY_OF_LIVE_M2_PROBE+RECORDED_FIXTURES'), analyzer: recordedAnalyzer(rec.cards, 'RECORDED_FIXTURES') });
svc.catalog = () => authoring.catalog();
const port = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const server = await startHttp(svc, { port, adminToken: token, authoring });
const client = new Client({ name: 'm2-walkthrough', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const log: J[] = [], failures: string[] = [];
let beat = '';
const check = (ok: boolean, what: string) => { if (!ok) failures.push(`${beat}: ${what}`); console.log(`    ${ok ? 'PASS' : 'FAIL'} ${what}`); };
async function web(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<J> {
  const isPdf = body instanceof Uint8Array;
  const r = await fetch(base + path, { method, headers: { ...(isPdf ? { 'content-type': 'application/pdf' } : body ? { 'content-type': 'application/json' } : {}), ...headers }, body: isPdf ? body : body ? JSON.stringify(body) : undefined });
  const j = { status: r.status, ...(await r.json()) as J };
  log.push({ beat, channel: 'web', method, path, status: r.status, response: j });
  console.log(`  web ${method.padEnd(4)} ${path.padEnd(48)} ${r.status}`);
  return j;
}
const owner = { authorization: `Bearer ${token}` };
async function mcp(tool: string, args: J = {}): Promise<J> {
  const r = await client.callTool({ name: tool, arguments: args });
  const out = (r.structuredContent ?? {}) as J;
  log.push({ beat, channel: 'mcp', tool, args, result: out });
  console.log(`  mcp ${tool.padEnd(18)} ${String(out.outcome ?? 'ok').padEnd(20)} ${((r.content as { text: string }[])[0]?.text ?? '').slice(0, 120)}`);
  return out;
}
async function waitJob(id: string): Promise<J> { for (;;) { const j = await web('GET', `/imports/${id}`); if (!['queued', 'running'].includes(j.job.state)) return j; await new Promise((res) => setTimeout(res, 50)); } }

try {
  beat = 'A-1 scone import'; console.log('\n== A-1 import scone PDF → swap plan at reading → save (no human input; owner decision 2026-10-02)');
  const imp = await web('POST', '/imports', new Uint8Array(readFileSync(join(inputs, 'scones.pdf'))), { 'x-filename': 'scones.pdf', 'idempotency-key': `wk-${stamp}` });
  check(imp.status === 202 && imp.job.stagesCompleted.join() === 'reading', 'accepted; only the "reading" stage reported so far');
  const job = await waitJob(imp.job.id);
  check(job.job.state === 'succeeded' && job.job.stagesCompleted.length === 6, 'six real stages completed');
  let draft = (await web('GET', `/drafts/${imp.draftId}`)).draft;
  const cream = (draft.content.ingredients as J[]).find((i) => /cream/i.test(i.name))!;
  const order = (stepId: string) => (draft.content.steps as J[]).find((s) => s.id === stepId)!.ordinal;
  check(JSON.stringify(cream.uses.map((u: J) => order(u.stepId))) === '[3,6]', 'cream revealed in steps 3 and 6');
  console.log(`    import guessed: ${cream.uses.map((u: J) => u.proposedFunction?.labels?.join('·')).join(' / ')} · role table: ${cream.uses.map((u: J) => u.reviewedFunction?.labels?.join('·')).join(' / ')}`);
  check(JSON.stringify(cream.uses.map((u: J) => u.reviewedFunction?.labels)) === '[["liquid","fat"],["browning"]]', 'roles from the cards, matching the reviewed role table; not the guesses');
  const all = (draft.content.ingredients as J[]).flatMap((i) => i.uses as J[]);
  check(all.every((u) => u.swap.origin && !/^We couldn't/.test(u.swap.text)), `every use has an answer (${all.map((u) => u.swap.origin === 'importCard' ? 'AI' : 'reviewed').join(', ')})`);
  for (const u of cream.uses as J[]) console.log(`    step ${order(u.stepId)}: ${u.swap.text}${u.swap.kind === 'recovery' ? `\n      ${u.swap.details.join('\n      ')}` : ''}`);
  check(cream.uses[0].swap.kind === 'recovery' && cream.uses[0].swap.details.includes('Step 3: 85 g cold butter') && cream.uses[0].swap.details.includes('Step 3: 180 ML milk, plus up to 30 ML more only if needed'), 'dough cream → 85 g butter + 180 ML milk (+30 ML)');
  check(cream.uses[1].swap.kind === 'covered' && /a little milk$/.test(cream.uses[1].swap.text), 'brushing cream → a little milk (no invented amount)');
  check('questions' in draft === false, 'no cook question on the draft');
  const req = await web('GET', `/authoring/drafts/${imp.draftId}/requirements`, undefined, owner);
  const bound = (req.bindings as J[]).find((b) => b.patternId === 'cream_to_butter_milk');
  const m1 = content.packs.get(RECIPE['scones.demo'])!.bindings.find((b) => b.patternId === 'cream_to_butter_milk')!;
  check(!!bound && JSON.stringify(bound.quantities) === JSON.stringify(m1.quantities), 'binding quantities equal the M1 approved scone (85 g / 180 ML / 30 ML)');
  draft = (await web('GET', `/drafts/${imp.draftId}`)).draft;
  const saved = await web('POST', `/drafts/${imp.draftId}/save`, { expectedRevision: draft.revision }, { 'idempotency-key': `save-${stamp}` });
  check(saved.release.kind === 'eligible' && saved.release.coverageSummary === 'Reviewed change on file: heavy cream, step 3 · Prepared at import (AI): a card for 6 of 6 uses', `saved: ${saved.release.coverageSummary ?? JSON.stringify(saved.release)}`);
  for (const d of DEMO.filter((x) => x.name !== 'scones')) {
    const im = await web('POST', '/imports', demoPdf(d.lines), { 'x-filename': `${d.name}.pdf` });
    await waitJob(im.job.id);
    const dr = (await web('GET', `/drafts/${im.draftId}`)).draft;
    const sv = await web('POST', `/drafts/${im.draftId}/save`, { expectedRevision: dr.revision });
    check(sv.release.kind === 'eligible' && /a card for (\d+) of \1 uses$/.test(sv.release.coverageSummary), `${d.name}.pdf imported and saved: ${sv.release.coverageSummary}`);
  }

  beat = '§9.4 rescue on the imported scone'; console.log('\n== cook the imported scone via MCP');
  const book = await mcp('list_recipes');
  check((book.recipes as J[]).some((r) => r.recipeId === saved.recipeId && r.release.kind === 'eligible'), 'listed with engine-computed eligibility');
  check(JSON.stringify((book.recipes as J[]).map((r) => r.title).sort()) === '["Cream Scones","Risotto with Parmesan","Strawberry Shortcake"]', 'the Recipe Book shows the three imported demo recipes (approved recipes are test fixtures)');
  const st = await mcp('start_recipe', { commandId: randomUUID(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId });
  let run = st.run;
  for (const s of (st.recipe.steps as J[]).slice(0, 2)) run = (await mcp('record_progress', { commandId: randomUUID(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' })).run;
  const missingId = (st.recipe.ingredients as J[]).find((i) => /cream/i.test(i.name))!.id;
  const scope = () => ({ runId: run.id, epoch: run.epoch, expectedRevision: run.revision });
  const e1 = await mcp('evaluate_rescue', { commandId: randomUUID(), ...scope(), missingIngredientId: missingId, proposedKindIds: ['whole-milk', 'unsalted-butter'], utterance: { text: 'heavy cream', channel: 'tapped' } });
  check(e1.outcome === 'needsFacts' && e1.questions.length === 2, 'two questions: exact amounts, and brushing milk separately');
  if (e1.outcome !== 'needsFacts') throw new Error('stop: no rescue offered');
  const e2 = await mcp('evaluate_rescue', { commandId: randomUUID(), ...scope(), previousEvaluationId: e1.id, answers: (e1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
  check(e2.outcome === 'proposal', 'proposal');
  const ap = await mcp('apply_amendment', { commandId: randomUUID(), ...scope(), evaluationId: e2.id, candidateId: e2.candidates[0].id, planId: e2.candidates[0].planId, accepted: true });
  check(ap.outcome === 'applied', 'applied');
  const steps = ap.run.steps as J[];
  console.log(`    step 3: ${steps[2].effectiveText}`);
  console.log(`    step 6: ${steps[5].effectiveText}`);
  check(steps[5].effectiveText === 'Brush the tops with a little milk.' && steps[2].progress === 'notStarted', 'brushing rewritten; step 3 not started');

  beat = 'A-2 lemon partial + paste'; console.log('\n== A-2 partial PDF → paste missing steps (C-4)');
  const li = await web('POST', '/imports', new Uint8Array(readFileSync(join(inputs, 'lemon-cake.pdf'))), { 'x-filename': 'lemon-cake.pdf' });
  const lj = await waitJob(li.job.id);
  check(lj.job.state === 'partial', 'job partial (page 2 is a scan; no OCR)');
  let ld = await web('GET', `/drafts/${li.draftId}`);
  check(ld.draft.blockers.length === 1 && ld.draft.blockers[0].kind === 'missingSteps', `blocker: ${ld.draft.blockers[0]?.message}`);
  const ls1 = await web('POST', `/drafts/${li.draftId}/save`, { expectedRevision: ld.draft.revision });
  check(ls1.release.kind === 'ineligible', 'saved but cannot start yet');
  const blocked = await mcp('start_recipe', { commandId: randomUUID(), recipeId: ls1.recipeId, replace: { runId: run.id, epoch: run.epoch, expectedRevision: ap.run.revision, confirm: true } });
  check(blocked.code === 'NOT_ELIGIBLE', 'start_recipe refuses an ineligible saved recipe');
  const app = await web('POST', `/drafts/${li.draftId}/append-text`, { expectedRevision: ld.draft.revision, text: readFileSync(join(inputs, 'lemon-pasted.txt'), 'utf8') });
  check((await waitJob(app.job.id)).job.state === 'succeeded', 're-read with the pasted steps');
  ld = await web('GET', `/drafts/${li.draftId}`);
  check(ld.draft.blockers.length === 0, 'blocker cleared by the backend');
  check(JSON.stringify((ld.sources as J[]).map((s) => s.origin)) === '["upload","cookPasted"]', 'original PDF preserved; pasted text kept as its own cook-pasted source');
  const pastedSteps = Object.entries(ld.draft.sourceRefs as Record<string, J | null>).filter(([k, v]) => k.startsWith('s') && v?.origin === 'COOK_PASTED').length;
  check(pastedSteps >= 4, `${pastedSteps} steps cite the pasted text`);
  const ls2 = await web('POST', `/drafts/${li.draftId}/save`, { expectedRevision: ld.draft.revision });
  check(ls2.release.kind === 'eligible', 'now eligible');

  beat = 'B14 weeknight risotto'; console.log('\n== B14 development case: pattern-local requirement list');
  const wi = await web('POST', '/imports', new Uint8Array(readFileSync(join(inputs, 'weeknight-mushroom-risotto.pdf'))), { 'x-filename': 'weeknight-mushroom-risotto.pdf' });
  await waitJob(wi.job.id);
  const wr = await web('GET', `/authoring/drafts/${wi.draftId}/requirements`, undefined, owner);
  const split = (wr.coverage as J[]).find((c) => c.patternId === 'split');
  for (const m of split?.missing ?? []) console.log(`    ${m.who.padEnd(5)} ${m.predicate.padEnd(12)} ${m.subject.kind}:${m.subject.id} expects ${m.expected} (now ${m.current ?? 'nothing proposed'})`);
  check(split?.status === 'NEEDS_FACTS' && split.missing.length <= 11, `split needs ${split?.missing.length} facts for this rescue (old build: 69 recipe-wide blocks)`);
  const wd = (await web('GET', `/drafts/${wi.draftId}`)).draft;
  const wine = (wd.content.ingredients as J[]).find((i) => /wine/i.test(i.name))!.uses[0];
  console.log(`    wine: ${wine.swap.text}`);
  check(wine.swap.kind === 'needsFacts' && /rice weight in grams/.test(wine.swap.text), 'no swap prepared: needs the rice weight in grams (never inferred)');

  beat = 'activity'; console.log('\n== activity');
  const act = (await (await fetch(`${base}/activity`)).json()) as { entries: J[] };
  check(act.entries.every((e) => e.channel === 'mcp') && act.entries.length === log.filter((l) => l.channel === 'mcp').length, `activity lists only the ${act.entries.length} real MCP calls; web import calls are separate`);
} finally {
  await client.close();
  server.close();
  writeFileSync(join(outDir, `m2-${stamp}.json`), JSON.stringify({ kind: 'cc-m2-walkthrough/2', at: stamp, extractor: 'REPLAY_OF_LIVE_M2_PROBE+RECORDED_FIXTURES', analyzer: 'RECORDED_FIXTURES', interpreter: 'structured/tapped', mode: 'ENGINEERING', failures, calls: log }, null, 2));
  console.log(`\n${failures.length ? `FAILED (${failures.length}):\n  ${failures.join('\n  ')}` : 'ALL CHECKS PASSED'} · artifact .artifacts/walkthrough/m2-${stamp}.json`);
  svc.close();
  process.exitCode = failures.length ? 1 : 0;
}
