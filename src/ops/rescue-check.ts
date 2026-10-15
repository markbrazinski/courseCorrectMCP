// A reviewed rescue on a real imported recipe, end to end on a deployed URL (owner tooling; never part of the deployed service).
// ONE sign-in (one workspace against the daily cap). Paid: one live import (OCR if the PDF needs it, Nova reading + swap analysis,
// about $0.01–0.04, charged to the environment's ledger).
//   node src/ops/rescue-check.ts --url <https://…/> --secrets <private/deploy/<env>/secrets.json> --file <recipe.pdf|.txt>
//        --ingredient <regex> [--kinds id,id] [--confirm] [--choose <n>] [--option <n>] [--out <file>]
// import (acknowledged before reading) → review: the questions it asks (--confirm answers yes) and the plan for the ingredient →
// save → start → a stale proposal is refused → a fresh run: rescue → explicit acceptance → the same acceptance again is a replay →
// the recipe after a reload: revised quantities and instructions, progress and the amendment kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { session } from './session.ts';

const flag = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const url = (flag('url') ?? '').replace(/\/$/, ''), code = (JSON.parse(readFileSync(flag('secrets')!, 'utf8')) as { accessCode: string }).accessCode;
const file = flag('file')!, target = new RegExp(flag('ingredient')!, 'i'), kinds = flag('kinds')?.split(',') ?? [];
type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads
const results: { check: string; ok: boolean; detail: string }[] = [], timings: { call: string; ms: number }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ check: name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); return ok; };
let n = 0;
const cmd = (p: string) => `rc-${Date.now().toString(36)}-${p}-${++n}`;
const { token } = await session(url, code);   // CC_SESSION_FILE: one session for every check
const H = { authorization: `Bearer ${token}` };
async function web(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const r = await fetch(`${url}${path}`, { method, headers: { ...H, ...(body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers }, body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body) });
  timings.push({ call: `${method} ${path.replace(/[a-z]+_[\w-]+/g, ':id')}`, ms: Math.round(performance.now() - t0) });
  return { status: r.status, data: await r.json() as J };
}
async function tool(name: string, args: J = {}): Promise<J> {
  const t0 = performance.now();
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await r.json() as J;
  timings.push({ call: name, ms: Math.round(performance.now() - t0) });
  return body.result?.structuredContent ?? body.error ?? {};
}
const poll = async (jobId: string) => { for (let j: J; ; await new Promise((ok) => setTimeout(ok, 2000))) { j = (await web('GET', `/imports/${jobId}`)).data.job; if (j.state !== 'queued' && j.state !== 'running') return j; } };

console.log(`Rescue check on ${url} with ${basename(file)}`);
// ---------- import ----------
const source = file.endsWith('.pdf')
  ? { kind: 'upload', sourceDocId: (await web('POST', '/uploads', new Uint8Array(readFileSync(file)), { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent(basename(file)) })).data.sourceDocId }
  : { kind: 'text', text: readFileSync(file, 'utf8') };
const commandId = cmd('import'), t0 = Date.now();
const imp = await tool('import_recipe', { commandId, source });
check('import_recipe acknowledges durable work before any reading', imp.outcome === 'importing' && !!imp.job?.id, `${imp.outcome} in ${timings.at(-1)!.ms} ms`);
let job = await poll(imp.job.id);
if (job.state === 'needsChoice') {
  check('several recipes: none read, the cook is asked to choose', !!job.choices?.length, (job.choices as J[]).map((c) => c.title).join(' | '));
  if (flag('choose') === undefined) { console.log('stopping: pass --choose <n>'); process.exit(0); }
  job = (await web('POST', `/imports/${job.id}/choose`, { index: Number(flag('choose')) })).data.job;
  job = await poll(job.id);
}
check('the reading finished', job.state === 'succeeded' || job.state === 'partial', `${job.state} after ${Math.round((Date.now() - t0) / 1000)} s${job.failure ? ` · ${job.failure.message}` : ''}`);
const again = await tool('import_recipe', { commandId, source });
check('the same commandId reports the draft (no second reading)', again.outcome === 'imported' && again.job?.id === job.id);
// ---------- review ----------
let d = (await web('GET', `/drafts/${job.draftId}`)).data.draft as J;
const uses = () => (d.content.ingredients as J[]).flatMap((i) => i.uses.map((u: J) => ({ i, u })));
const planOf = () => uses().find((x) => target.test(x.i.name))?.u.analysis;
console.log(`  review: ${d.content.title} · ${d.content.ingredients.length} ingredients · ${d.content.steps.length} steps · questions: ${(d.questions as J[]).map((q) => q.prompt).join(' | ') || 'none'}${d.unchecked ? ` · unchecked: ${JSON.stringify(d.unchecked)}` : ''}`);
const statusBefore = planOf();
if (process.argv.includes('--confirm') && d.questions.length) {
  const r = await web('POST', `/drafts/${job.draftId}/confirmations`, { expectedRevision: d.revision, answers: (d.questions as J[]).map((q) => ({ questionId: q.id, answer: 'yes' })) });
  check('the cook\'s answers are recorded', r.status === 200, `${r.status}`);
  d = r.data.draft;
}
// a printed either/or the cook must settle (--option <n> picks it; without it the check stops, as the save would be refused)
for (const b of (d.blockers as J[]).filter((x) => x.kind === 'chooseOption')) {
  console.log(`  choice: ${b.message} · ${(b.resolution.options as J[]).map((o) => `[${o.index}] ${o.text}`).join(' | ')}`);
  if (flag('option') === undefined) { console.log('stopping: pass --option <n>'); process.exit(0); }
  const r = await web('POST', `/drafts/${job.draftId}/choices`, { expectedRevision: d.revision, ingredientId: b.resolution.ingredientId, option: Number(flag('option')) });
  check('the cook\'s choice is recorded', r.status === 200 && !(r.data.draft.blockers as J[]).some((x) => x.id === b.id), `${r.status}`);
  d = r.data.draft;
}
const a = planOf();
check(`the ${target.source} use has a plan`, a?.status === 'available', `${statusBefore?.status} → ${a?.status} · ${a?.plans?.map((p: J) => `${p.provenance.kind}: ${p.title}`).join('; ') ?? a?.reason?.text ?? ''}`);
const reviewed = a?.plans?.[0]?.provenance.kind === 'reviewedRule';
console.log(`    plan basis: ${a?.plans?.[0]?.provenance.basis.join(' / ') ?? '-'}`);
const saved = (await web('POST', `/drafts/${job.draftId}/save`, { expectedRevision: d.revision }, { 'idempotency-key': cmd('save') })).data;
check('saved to the Recipe Book', !!saved.recipeId);
// ---------- cooking ----------
const active = async () => (await tool('get_active_recipe')) as { run: J; recipe: J };
async function startFresh() {
  const cur = (await active()).run;
  const st = await tool('start_recipe', { commandId: cmd('s'), recipeId: saved.recipeId, ...(cur ? { replace: { runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, confirm: true } } : {}) });
  if (st.outcome !== 'started') throw new Error(JSON.stringify(st).slice(0, 300));
  // steps before the target's are done (the plan is offered when its step is the next one)
  const tStep = (st.recipe.ingredients as J[]).find((i) => target.test(i.name))!.uses[0].stepId;
  for (const s of st.run.steps as J[]) { if (s.stepId === tStep) break; const r = (await active()).run; await tool('record_progress', { commandId: cmd('p'), runId: r.id, epoch: r.epoch, expectedRevision: r.revision, stepId: s.stepId, progress: 'done' }); }
  return active();
}
async function ask(): Promise<J> {
  const { run: r, recipe } = await active();
  const base = { runId: r.id, epoch: r.epoch, expectedRevision: r.revision }, id = (recipe.ingredients as J[]).find((i) => target.test(i.name))!.id;
  const first = await tool('evaluate_rescue', { commandId: cmd('e'), ...base, missingIngredientId: id, proposedKindIds: kinds, utterance: { text: 'tapped', channel: 'tapped' } });
  return first.outcome !== 'needsFacts' ? first : tool('evaluate_rescue', { commandId: cmd('e'), ...base, previousEvaluationId: first.id, answers: (first.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
}
const acceptArgs = (r: J, e: J, commandId = cmd('a')) => ({ commandId, runId: r.id, epoch: r.epoch, expectedRevision: e.evaluatedAtRunRevision, evaluationId: e.id, candidateId: e.candidates[0].id, planId: e.candidates[0].planId, accepted: true });

let { run } = await startFresh();
const p1 = await ask();
check('rescue proposed', p1.outcome === 'proposal', `${p1.outcome} · ${p1.candidates?.[0]?.contentLabel ?? p1.speech?.text ?? ''}`);
if (p1.outcome === 'proposal') {
  // stale: the cook reports progress after the plan was shown; that plan can no longer be accepted
  const tStep = (run.steps as J[]).find((s) => s.progress !== 'done')!.stepId;
  await tool('record_progress', { commandId: cmd('p'), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: tStep, progress: 'started' });
  const stale = await tool('apply_amendment', acceptArgs(run, p1));
  check('a stale proposal is refused (progress changed after it was shown)', stale.outcome === 'rejected', `${stale.outcome} ${stale.code ?? ''}`);
  ({ run } = await startFresh());
  const p2 = await ask();
  const args = acceptArgs(run, p2);
  const ap = await tool('apply_amendment', args);
  check('explicit acceptance applies the change', ap.outcome === 'applied', `${ap.outcome} · ${ap.amendment?.title ?? ''}`);
  const replay = await tool('apply_amendment', args);
  check('the same acceptance again is a replay, not a second change', replay.outcome === 'alreadyApplied' && replay.amendment?.id === ap.amendment?.id, replay.outcome);
  const { run: after, recipe } = await active();
  const step = (after.steps as J[]).find((s) => s.changedByAmendmentId === ap.amendment?.id);
  check('after a reload: one amendment, earlier progress kept, the step rewritten', after.appliedAmendments.length === 1 && after.steps.filter((s: J) => s.progress === 'done').length === (run.steps as J[]).filter((s: J) => s.progress === 'done').length && !!step,
    `${step?.effectiveText ?? ''}`);
  const introduced = (recipe.ingredients as J[]).filter((i) => i.uses.some((u: J) => u.introducedBy)).map((i) => `${i.name} ${i.uses.map((u: J) => u.amount.display).join(' + ')}`);
  console.log(`    revised quantities: ${introduced.join('; ') || '-'} · plan was ${reviewed ? 'a reviewed rule' : 'prepared at import (AI)'}`);
  // a second change in the same session (--then <regex>): on the recipe as the first change left it (an ingredient that change
  // introduced, or another one in the same step); applied when a plan is offered, else its refusal is shown
  const then = flag('then');
  if (then) {
    const re = new RegExp(then, 'i'), cur = await active(), id = (cur.recipe.ingredients as J[]).find((i) => re.test(i.name))?.id;
    const base = { runId: cur.run.id, epoch: cur.run.epoch, expectedRevision: cur.run.revision };
    let e = await tool('evaluate_rescue', { commandId: cmd('e'), ...base, missingIngredientId: id, proposedKindIds: flag('then-kinds')?.split(',') ?? [], utterance: { text: 'tapped', channel: 'tapped' } });
    if (e.outcome === 'needsFacts') e = await tool('evaluate_rescue', { commandId: cmd('e'), ...base, previousEvaluationId: e.id, answers: (e.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
    if (e.outcome === 'proposal') {
      const ap2 = await tool('apply_amendment', acceptArgs(cur.run, e));
      const fin = await active();
      check(`second change (${then}) applied on the recipe as the first change left it`, ap2.outcome === 'applied' && fin.run.appliedAmendments.length === 2,
        `${ap2.amendment?.title ?? ap2.code} · depends on ${JSON.stringify(ap2.amendment?.dependsOn ?? [])} · ${(fin.run.steps as J[]).filter((s) => s.changedByAmendmentId).map((s) => s.effectiveText).join(' || ').slice(0, 400)}`);
    } else check(`second change (${then}): ${e.outcome}`, e.outcome === 'refused', `${e.refusal?.kind ?? ''} · ${e.speech?.text ?? ''}`.slice(0, 400));
  }
}
const out = flag('out');
if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), url, file: basename(file), results, timings, draftId: job.draftId }, null, 1));
console.log(`${results.every((r) => r.ok) ? '✓' : '✗'} ${results.filter((r) => r.ok).length}/${results.length} checks`);
