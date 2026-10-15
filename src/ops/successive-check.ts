// Deployed checks for knowledge releases and successive substitutions (owner tooling; never part of the deployed service).
// Drives a deployed URL the way an external MCP client does (JSON sign-in → bearer token → JSON-RPC), times every call, and
// asserts the results:
//   node src/ops/successive-check.ts --url <https://…/> --secrets <private/deploy/<env>/secrets.json> [--import] [--out <file>]
// Paid: one live reading of the sample scones PDF (Add recipe's sample; Nova extraction + swap analysis, ≈ $0.01, charged to the
// environment's ledger). --import adds a pasted cream-biscuit recipe (≈ $0.01), to show whether replacing an ingredient an earlier
// change added is enabled in the ACTIVE release.
import { readFileSync, writeFileSync } from 'node:fs';
import { reusing, session } from './session.ts';

const flag = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const url = (flag('url') ?? '').replace(/\/$/, ''), code = (JSON.parse(readFileSync(flag('secrets')!, 'utf8')) as { accessCode: string }).accessCode;
type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads
const results: { check: string; ok: boolean; detail: string }[] = [], timings: { tool: string; ms: number; server: string | null }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ check: name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); return ok; };
let n = 0;
const cmd = (p: string) => `sc-${Date.now().toString(36)}-${p}-${++n}`;
const signIn = async () => (await session(url, code)).token;   // CC_SESSION_FILE: one session for every check
async function tool(token: string, name: string, args: J = {}): Promise<J> {
  const t0 = performance.now();
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await r.json() as J;
  timings.push({ tool: name, ms: Math.round(performance.now() - t0), server: r.headers.get('server-timing') });
  return body.result?.structuredContent ?? body.error ?? {};
}
const run = async (t: string) => (await tool(t, 'get_active_recipe')) as { run: J; recipe: J };
const ingId = (recipe: J, re: RegExp) => (recipe.ingredients as J[]).find((i) => re.test(i.name))?.id as string;
async function progress(t: string, i: number, p: 'done' | 'partly' = 'done', addedUseIds?: string[]) {
  const { run: r } = await run(t);
  return tool(t, 'record_progress', { commandId: cmd('p'), runId: r.id, epoch: r.epoch, expectedRevision: r.revision, stepId: r.steps[i].stepId, progress: p, ...(addedUseIds ? { addedUseIds } : {}) });
}
/** Tap the ingredient, answer every availability question yes, return the last answer. */
async function propose(t: string, name: RegExp, kinds: string[] = []) {
  const { run: r, recipe } = await run(t);
  const base = { runId: r.id, epoch: r.epoch, expectedRevision: r.revision };
  const first = await tool(t, 'evaluate_rescue', { commandId: cmd('e'), ...base, missingIngredientId: ingId(recipe, name), proposedKindIds: kinds, utterance: { text: 'tapped', channel: 'tapped' } });
  if (first.outcome !== 'needsFacts') return first;
  return tool(t, 'evaluate_rescue', { commandId: cmd('e'), ...base, previousEvaluationId: first.id, answers: (first.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
}
async function accept(t: string, e: J, commandId = cmd('a')) {
  const { run: r } = await run(t);
  return { commandId, runId: r.id, epoch: r.epoch, expectedRevision: r.revision, evaluationId: e.id, candidateId: e.candidates[0].id, planId: e.candidates[0].planId, accepted: true };
}
/** import_recipe (acknowledged at once), its status re-calls with the same commandId, then save: the saved recipe id. */
async function importAndSave(t: string, source: J, label: string) {
  const args = { commandId: cmd('i'), source }, t0 = Date.now();
  let imp = await tool(t, 'import_recipe', args);
  check(`${label}: import_recipe acknowledges before the reading finishes`, imp.outcome === 'importing' && imp.draft === null, `${imp.outcome} in ${timings[timings.length - 1].ms} ms`);
  while (imp.outcome === 'importing' && Date.now() - t0 < 300_000) { await new Promise((r) => setTimeout(r, 2000)); imp = await tool(t, 'import_recipe', args); }
  check(`${label}: the same commandId later reports the finished draft (no second reading)`, imp.outcome === 'imported' && !!imp.draft?.draftId, `${imp.outcome} after ${Date.now() - t0} ms`);
  if (imp.outcome !== 'imported') return null;
  let d = (await (await fetch(`${url}/drafts/${imp.draft.draftId}`, { headers: { authorization: `Bearer ${t}` } })).json() as J).draft;
  // the review's questions about this recipe, answered as the cook would from the recipe (each is true of the sample and the biscuits)
  if (d.questions?.length) {
    const r = await fetch(`${url}/drafts/${imp.draft.draftId}/confirmations`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: d.revision, answers: (d.questions as J[]).map((q) => ({ questionId: q.id, answer: 'yes' })) }) });
    check(`${label}: the review's questions answered from the recipe`, r.ok, (d.questions as J[]).map((q) => q.prompt).join(' | '));
    d = ((await r.json()) as J).draft;
  }
  const saved = await (await fetch(`${url}/drafts/${imp.draft.draftId}/save`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: d.revision }) })).json() as J;
  return saved.recipeId as string;
}
async function start(t: string, title: RegExp | string) {
  const book = (await tool(t, 'list_recipes')).recipes as J[];
  const r = book.find((x) => (typeof title === 'string' ? x.recipeId === title : title.test(x.title)))!;
  const active = (await run(t)).run;
  return tool(t, 'start_recipe', { commandId: cmd('s'), recipeId: r.recipeId, ...(active ? { replace: { runId: active.id, epoch: active.epoch, expectedRevision: active.revision, confirm: true } } : {}) });
}

const health = await (await fetch(`${url}/health`)).json() as J;
console.log(`Successive-substitution checks on ${url} · active knowledge ${health.knowledge}`);
const t = await signIn();

// 1. three successive changes on the sample scones (the Add recipe sample PDF, imported live; two changes in the dry-mix step)
if (reusing()) console.log('  SKIP the scones are not a prepared example · one reused session: this kitchen may already hold an imported sample (verify checks the examples)');
else check('the scones are not a prepared example (they are the sample import)', !((await tool(t, 'list_recipes')).recipes as J[]).some((r) => /scone/i.test(r.title)));
const sample = await fetch(`${url}/sample/scones-explicit.pdf`, { headers: { authorization: `Bearer ${t}` } });
check('the sample PDF is served after sign-in', sample.ok && sample.headers.get('content-type') === 'application/pdf');
const up = await (await fetch(`${url}/uploads`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/pdf', 'x-filename': 'scones-explicit.pdf' }, body: Buffer.from(await sample.arrayBuffer()) })).json() as J;
const scones = await importAndSave(t, { kind: 'upload', sourceDocId: up.sourceDocId }, 'sample scones');
if (!scones) { console.log('✗ the sample import did not finish; nothing more can be checked'); process.exit(1); }
const st = await start(t, scones);
check('the session is pinned to the active release', st.run?.knowledge?.releaseId === health.knowledge && st.run.knowledge.basis === 'PINNED', JSON.stringify(st.run?.knowledge));
await progress(t, 0);
const s1 = await propose(t, /caster sugar/i);
check('change 1 proposed (caster sugar → granulated)', s1.outcome === 'proposal' && s1.basis?.knowledgeReleaseId === health.knowledge, `${s1.outcome} basis ${JSON.stringify(s1.basis)}`);
check('change 1 applied', (await tool(t, 'apply_amendment', await accept(t, s1))).outcome === 'applied');
const s2 = await propose(t, /baking powder/i);
check('change 2 proposed on the step as change 1 left it', s2.outcome === 'proposal' && JSON.stringify(s2.candidates?.[0]?.stepChanges ?? []).includes('40 g granulated'), s2.outcome);
check('change 2 applied', (await tool(t, 'apply_amendment', await accept(t, s2))).outcome === 'applied');
const step2 = (await run(t)).run.steps[1].effectiveText as string;
check('both changes are in step 2', /40 g granulated sugar/.test(step2) && /¾ tsp baking soda/.test(step2) && /1½ tsp cream of tartar/.test(step2) && /without resting or chilling/.test(step2) && !/caster|baking powder/i.test(step2), step2.slice(0, 120));
await progress(t, 1);
const s3 = await propose(t, /heavy cream/i, ['whole-milk', 'unsalted-butter']);
check('change 3 proposed (cream → butter + milk, re-bound after the dry-mix changes)', s3.outcome === 'proposal', s3.outcome);
check('change 3 applied', (await tool(t, 'apply_amendment', await accept(t, s3))).outcome === 'applied');
const after = (await run(t)).run;
check('three amendments, version 4, nothing marked done by them', after.appliedAmendments.length === 3 && after.version === 4 && after.steps.filter((s: J) => s.progress === 'done').length === 2,
  `${after.appliedAmendments.map((a: J) => a.title).join(' | ')}`);
check('change 2 records that it shares change 1\'s step', JSON.stringify(after.appliedAmendments[1].dependsOn) === JSON.stringify([{ amendmentId: after.appliedAmendments[0].id, relation: 'SHARES_STEP' }]));
const brush = (after.steps as J[]).find((x) => /^Brush/.test(x.effectiveText))?.effectiveText ?? '';
check('step 3 and the brushing step carry change 3', /^Rub 85 g cold butter .*180 ML milk/.test(after.steps[2].effectiveText) && /milk/.test(brush) && !/cream/i.test(brush), `${after.steps[2].effectiveText.slice(0, 70)} … ${brush}`);
const recipe = (await run(t)).recipe;
check('introduced ingredients are labelled with the change that brought them', (recipe.ingredients as J[]).filter((i) => i.uses.some((u: J) => u.introducedBy)).length === 5,
  (recipe.ingredients as J[]).filter((i) => i.uses.some((u: J) => u.introducedBy)).map((i) => i.name).join(', '));

// 2. introduced ingredients missing: refused honestly, recipe unchanged
const rev = after.revision;
const butter = await propose(t, /^Butter$/, ['vegetable-oil']);
check('out of the introduced butter: no reviewed change, said plainly', butter.outcome === 'refused' && /as it is used now/.test(butter.refusal?.message ?? ''), butter.speech?.text);
const milk = await propose(t, /^Milk$/, ['evaporated-milk']);
check('out of the introduced milk (it also brushes): refused', milk.outcome === 'refused', milk.speech?.text);
check('refusals changed nothing', (await run(t)).run.revision === rev);

// 3. simultaneous accepts of one proposal: one amendment; the retry replays the original receipt
await start(t, scones);
await progress(t, 0);
const p = await propose(t, /caster sugar/i);
const [a, b] = [await accept(t, p, cmd('race-a')), await accept(t, p, cmd('race-b'))];
const raced = await Promise.all([tool(t, 'apply_amendment', a), tool(t, 'apply_amendment', b), tool(t, 'apply_amendment', a)]);
const winner = raced.find((x) => x.outcome === 'applied');
check('simultaneous accepts: exactly one applied', raced.filter((x) => x.outcome === 'applied').length === 1, raced.map((x) => x.outcome === 'rejected' ? `rejected ${x.code}` : x.outcome).join(', '));
const retry = await tool(t, 'apply_amendment', winner?.amendment.commandId === a.commandId ? a : b);
check('the winner\'s retry returns its original receipt', retry.outcome === 'alreadyApplied' && retry.amendment?.id === winner?.amendment.id);
check('one version written', (await run(t)).run.version === 2);

// 4. replacing an ingredient an earlier change added (paid, --import): enabled only by OD-8 (R2), which is not active
if (process.argv.includes('--import')) {
  const lines = ['Cream Biscuits', 'Makes 8', '250 g plain flour', '20 g granulated sugar', '2 tsp baking powder', '¼ tsp salt', '300 ML heavy cream',
    '1. Heat the oven to 220 °C.', '2. Whisk the flour, sugar, baking powder and salt.', '3. Stir in the cream until a soft dough forms.', '4. Pat out 2 cm thick and cut into rounds.', '5. Bake for 15 minutes, until golden.'];
  const biscuitId = await importAndSave(t, { kind: 'text', text: lines.join('\n') }, 'pasted biscuits');
  if (biscuitId) {
    const saved = { recipeId: biscuitId };
    await start(t, biscuitId);
    await progress(t, 0); await progress(t, 1);
    const c = await propose(t, /cream/i);
    check('imported biscuits: cream → butter + milk proposed', c.outcome === 'proposal', c.outcome);
    if (c.outcome === 'proposal') {
      await tool(t, 'apply_amendment', await accept(t, c));
      const m = await propose(t, /^Milk$/, ['evaporated-milk']);
      const enabled = m.outcome === 'proposal';
      check(`introduced milk → evaporated milk: ${enabled ? 'ENABLED (OD-8 content is active)' : 'refused as undoing the earlier change (OD-8 not active)'}`, health.knowledge === 'kr-9c316aaa001832c0' ? !enabled && m.refusal?.kind === 'earlierChangeConflict' : true, m.speech?.text);
    }
    // 5. delete_recipe: refused while cooking; archives after; history kept
    const book = (await tool(t, 'list_recipes')).recipes as J[], mine = book.find((r) => r.recipeId === saved.recipeId)!;
    const del = { commandId: cmd('d'), recipeId: mine.recipeId, recipeVersionId: mine.currentVersionId, confirm: true };
    check('delete_recipe refused while that recipe is cooking', (await tool(t, 'delete_recipe', del)).code === 'RECIPE_IN_USE');
    await start(t, /Risotto/);
    const gone = await tool(t, 'delete_recipe', { ...del, commandId: cmd('d') });
    check('delete_recipe archives it from the book, history kept', gone.outcome === 'archived' && !((await tool(t, 'list_recipes')).recipes as J[]).some((r) => r.recipeId === mine.recipeId), gone.kept);
  }
} else {
  const book = (await tool(t, 'list_recipes')).recipes as J[], sk = book.find((r) => /Shortcake/.test(r.title))!;
  const gone = await tool(t, 'delete_recipe', { commandId: cmd('d'), recipeId: sk.recipeId, recipeVersionId: sk.currentVersionId, confirm: true });
  check('delete_recipe archives an example from this kitchen\'s book', gone.outcome === 'archived' && !((await tool(t, 'list_recipes')).recipes as J[]).some((r) => r.recipeId === sk.recipeId));
}

const bad = results.filter((r) => !r.ok).length;
const byTool = Object.fromEntries([...new Set(timings.map((x) => x.tool))].map((k) => { const ms = timings.filter((x) => x.tool === k).map((x) => x.ms).sort((p1, p2) => p1 - p2); return [k, { n: ms.length, p50: ms[Math.floor(ms.length / 2)], max: ms[ms.length - 1] }]; }));
console.log(`\n${bad ? `✗ ${bad} of ${results.length} failed` : `✓ all ${results.length} passed`} · client ms per tool ${JSON.stringify(byTool)}`);
if (flag('out')) writeFileSync(flag('out')!, JSON.stringify({ url, knowledge: health.knowledge, at: new Date().toISOString(), results, timings, byTool }, null, 2));
if (bad) process.exitCode = 1;
