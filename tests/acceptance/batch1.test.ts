// Substitution knowledge, batch 1 (OD-7, commission 2026-10-08): B1–B8 and the D-5 oat-flour record through the real
// compiler, import analysis and engine. Readings and cards are hand-written TEST FIXTURES (software evidence, not Nova
// output, not culinary review). Expectations are structural (bindings, statuses, refusal codes, step text), never claims
// about how the food turns out. Case ids (E-xx) follow private/research/substitution-knowledge/evaluation-plan.md.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import type { Extractor } from '../../src/authoring/extract.ts';
import type { SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { refusalWhy } from '../../src/contract/why.ts';
import { identityErrors, kindByName } from '../../src/domain/vocabulary.ts';
import { evaluate } from '../../src/engine/evaluate.ts';
import { Service } from '../../src/service/commands.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { SHORTCAKE_LINES, SHORTCAKE_READING } from '../fixtures/demo-sources.ts';
import { RECIPE } from '../fixtures/ids.ts';
import { cmd, content, doneUpTo, pack, patterns, req, snapshotAfter, vocab } from '../helpers.ts';

const scripted = (raw: unknown): Extractor => ({ name: 'SCRIPTED', extract: async () => ({ ok: true, raw, extractor: 'SCRIPTED', usage: null, costUsd: 0 }) });
async function imp(lines: readonly string[], reading: unknown, cards: unknown = { cards: [] }) {
  const svc = new Service({ dbPath: join(mkdtempSync(join(tmpdir(), 'ccmcp-batch1-')), 'db'), content, interpreter: noneInterpreter, fixtureRecipes: false });
  const analyzer: SwapAnalyzer = { name: 'SCRIPTED', analyze: async () => ({ ok: true, raw: cards, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }) };
  const auth = new Authoring({ store: svc.store, content, extractor: scripted(reading), analyzer });
  svc.catalog = () => auth.catalog();
  const r = await auth.createImport({ kind: 'text', text: lines.join('\n') });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  const job = await auth.waitForJob(r.job.id);
  if (job.state === 'failed') throw new Error(JSON.stringify(job.failure));
  const uses = () => { const x = auth.getDraft(r.draftId).draft.content!; return x.ingredients.flatMap((i) => i.uses.map((u) => ({ name: i.name, step: x.steps.find((s) => s.id === u.stepId)!.ordinal, ...u }))); };
  const use = (name: string, step: number) => uses().find((u) => u.name === name && u.step === step)!;
  const pk = () => auth.coverageOf(r.draftId).pack!;
  const cover = (patternId: string) => pk().coverage.find((e) => e.patternId === patternId);
  /** save, start, mark the first `done` steps done (product path), and an `ask` bound to the run */
  const cook = async (done: number) => {
    const saved = auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId) });
    const st = svc.startRecipe({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId });
    if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
    let run = st.run;
    const progress = (i: number, p: 'done' | 'started') => { const x = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: st.recipe.steps[i].id, progress: p }); if (x.outcome !== 'recorded') throw new Error(x.code); run = x.run; };
    for (let i = 0; i < done; i++) progress(i, 'done');
    const id = (n: string) => st.recipe.ingredients.find((i) => i.name === n)!.id;
    const ask = (missing: string, kinds: string[] = [], prev?: { id: string; questions: { id: string }[] }) => { const cur = svc.getActiveRecipe().run!; return svc.evaluateRescue({ commandId: cmd(), runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision,
      missingIngredientId: id(missing), proposedKindIds: kinds, utterance: { text: 'tapped', channel: 'tapped' }, ...(prev ? { previousEvaluationId: prev.id, answers: prev.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) } : {}) }); };
    const applyArgs = (e: { id: string; candidates: { id: string; planId: string }[] }) => { const cur = svc.getActiveRecipe().run!; return { commandId: cmd(), runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, evaluationId: e.id, candidateId: e.candidates[0].id, planId: e.candidates[0].planId, accepted: true as const }; };
    const apply = (e: { id: string; candidates: { id: string; planId: string }[] }) => svc.applyAmendment(applyArgs(e));
    return { st, ask, apply, applyArgs, progress, run: () => run };
  };
  return { svc, auth, uses, use, pack: pk, cover, cook };
}

// ---------- drop biscuits (development recipe; scripted reading) ----------
type Step = { key: string; text: string; title: string; technique: string | null };
type Use = { ingredientKey: string; stepKey: string; quote: string; amountText: string | null; functions: string[] };
function drop(o: { milk?: string; extraIng?: [string, string, string, string][]; extraSteps?: { after: string; step: Step }[]; extraUses?: Use[]; preheat?: boolean } = {}) {
  const milkLine = o.milk ?? '200 ML milk';
  const ing = (key: string, line: string, name: string, amountText: string) => ({ name, key, line, amountText, kind: null });
  const ingredients = [ing('f', '250 g plain flour', 'plain flour', '250 g'), ing('s', '20 g caster sugar', 'caster sugar', '20 g'), ing('b', '2 tsp baking powder', 'baking powder', '2 tsp'),
    ing('t', '¼ tsp salt', 'salt', '¼ tsp'), ing('m', milkLine, 'milk', milkLine.split(' milk')[0]), ...(o.extraIng ?? []).map(([k, l, n, a]) => ing(k, l, n, a))];
  let steps: Step[] = [
    ...(o.preheat === false ? [] : [{ key: 's0', text: 'Heat the oven to 220 °C.', title: 'Heat oven', technique: 'PREHEAT' }]),
    { key: 's1', text: 'Whisk the flour, sugar, baking powder and salt.', title: 'Mix dry', technique: 'COMBINE_DRY' },
    { key: 's2', text: 'Stir in the milk until a soft dough forms.', title: 'Mix dough', technique: 'MIX_DOUGH' },
    { key: 's3', text: 'Drop onto a tray and bake for 12 minutes.', title: 'Bake', technique: 'BAKE' }];
  for (const x of o.extraSteps ?? []) steps.splice(steps.findIndex((s) => s.key === x.after) + 1, 0, x.step);
  if (o.extraSteps?.some((x) => x.step.key === 's1')) steps = steps.filter((s, i) => !(s.key === 's1' && i > steps.findIndex((y) => y.key === 's1')));
  const use = (k: string, s: string, quote: string, functions: string[]): Use => ({ ingredientKey: k, stepKey: s, quote, amountText: null, functions });
  const uses = [use('f', 's1', 'the flour', ['STRUCTURE']), use('s', 's1', 'sugar', ['SWEETNESS']), use('b', 's1', 'baking powder', ['LEAVENING']), use('t', 's1', 'salt', ['FLAVOR']), use('m', 's2', 'the milk', ['LIQUID']), ...(o.extraUses ?? [])];
  const lines = ['Drop Biscuits', 'Makes 10', ...ingredients.map((i) => i.line), ...steps.map((s, i) => `${i + 1}. ${s.text}`)];
  return { lines, reading: { recipeFound: true, title: 'Drop Biscuits', yield: 'Makes 10', ingredients, steps, uses } };
}
const plan = (u: { analysis: { plans: unknown[] } | null }) => (u.analysis!.plans as import('../../src/contract/analysis.ts').ImportPlan[])[0];
const afterText = (p: import('../../src/contract/analysis.ts').ImportPlan, i = 0) => p.stepEffects[i].after!.map((s) => s.text).join('');

describe('identity: aliases versus distinct forms (vocabulary v3)', () => {
  it('true aliases resolve; regional names and different forms do not collapse', () => {
    const k = (n: string) => kindByName(vocab, n)?.kindId ?? null;
    expect(['powdered sugar', "confectioners' sugar", 'confectioners sugar', 'icing sugar', 'half and half', 'half-and-half', 'light cream', 'evaporated milk', 'unsweetened evaporated milk', 'olive oil', 'vegetable oil', 'oat flour', 'water'].map(k))
      .toEqual(['confectioners-sugar', 'confectioners-sugar', 'confectioners-sugar', 'icing-sugar', 'half-and-half-cream', 'half-and-half-cream', 'light-cream', 'evaporated-milk', 'evaporated-milk', 'olive-oil', 'vegetable-oil', 'oat-flour', 'water']);
    // distinct forms and regional names stay unresolved (never an unconditional alias)
    expect(['light whipping cream', 'double cream', 'single cream', 'sweetened condensed milk', 'condensed milk', 'tartaric acid', 'canola oil', 'extra virgin olive oil', 'shortening', 'cornflour', 'self-raising flour'].map(k)).toEqual(Array(11).fill(null));
    // icing sugar is its own kind; one refusal covers both through the shared class
    expect(vocab.kinds.find((x) => x.kindId === 'icing-sugar')!.classes).toEqual(vocab.kinds.find((x) => x.kindId === 'confectioners-sugar')!.classes);
    expect(identityErrors(vocab)).toEqual([]);
  });
});

describe('B7 evaporated milk + water (positive, coordinated; G6)', () => {
  it('E-03: the plan shows both ingredients, amounts and the mixing, from the server; the cooking candidate is the import plan; apply rewrites once and completes nothing', async () => {
    const x = await imp(drop().lines, drop().reading);
    const p = plan(x.use('milk', 3));
    expect(p).toMatchObject({ ruleId: 'evaporated_milk_for_milk@1', kind: 'replacement', provenance: { kind: 'reviewedRule' } });
    expect(p.replacements.map((r) => [r.ingredientName, r.amount.display])).toEqual([['Evaporated milk', '100 ML'], ['Water', '100 ML']]);
    expect(afterText(p)).toBe('Stir in 100 ML evaporated milk mixed with 100 ML water until a soft dough forms.');
    expect(p.runtimeConditions.filter((c) => c.kind === 'availability').map((c) => c.text)).toEqual(['100 ML evaporated milk', '100 ML water']);
    expect(p.consequence.text).toMatch(/not sweetened condensed milk/);
    const k = await x.cook(2);
    const e1 = await k.ask('milk', ['evaporated-milk']);
    if (e1.outcome !== 'needsFacts') throw new Error(e1.outcome);
    expect(e1.proposalResponse).toMatchObject({ response: 'REALIZED_AS_PROPOSED' });
    expect(e1.previews[0].id).toBe(p.planId);
    const e2 = await k.ask('milk', ['evaporated-milk'], e1);
    if (e2.outcome !== 'proposal') throw new Error(e2.outcome);
    const args = k.applyArgs(e2), ap = x.svc.applyAmendment(args);
    if (ap.outcome !== 'applied') throw new Error(ap.outcome);
    expect(ap.run.steps[2]).toMatchObject({ effectiveText: 'Stir in 100 ML evaporated milk mixed with 100 ML water until a soft dough forms.', progress: 'notStarted' });
    expect(x.svc.applyAmendment(args)).toMatchObject({ outcome: 'alreadyApplied', amendment: { id: ap.amendment.id } });   // the same accepted command replays its receipt; nothing applies twice
    expect(x.svc.getActiveRecipe().run!.appliedAmendments).toHaveLength(1);
  });

  it('E-05: US cups convert exactly once; E-24: a second milk use leaves the listed-total plan unbound', async () => {
    const us = drop({ milk: '1 cup milk' });
    const a = await imp(us.lines, us.reading);
    expect(plan(a.use('milk', 3)).replacements.map((r) => r.amount.display)).toEqual(['118 ML', '118 ML']);   // 236.588… × ½ → 118 (error ≤ ½)
    const two = drop({ extraSteps: [{ after: 's3', step: { key: 's4', text: 'Brush the tops with a little milk.', title: 'Brush', technique: 'BRUSH' } }], extraUses: [{ ingredientKey: 'm', stepKey: 's4', quote: 'a little milk', amountText: 'a little', functions: ['BROWNING'] }] });
    const b = await imp(two.lines, two.reading);
    expect(b.cover('evaporated_milk_for_milk')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED' } });
  });
});

describe('B8 baking soda + cream of tartar (ATK selection; G1 conditions; timing note)', () => {
  it('E-04: binds with the oven heated first; the dry-mix step says to bake straight away; no preheat → not offered', async () => {
    const x = await imp(drop().lines, drop().reading);
    const p = plan(x.use('baking powder', 2));
    expect(p).toMatchObject({ ruleId: 'powder_from_soda_and_tartar@1', contentStatus: { provisional: true } });
    expect(p.replacements.map((r) => [r.ingredientName, r.amount.display])).toEqual([['Baking soda', '½ tsp'], ['Cream of tartar', '1 tsp']]);
    expect(afterText(p)).toBe('Whisk the flour, sugar, ½ tsp baking soda, salt and 1 tsp cream of tartar. Have the oven hot before the liquid goes in: once the dough is wet, the baking soda and cream of tartar start working, so shape it and bake it straight away, without resting or chilling it.');
    const cold = drop({ preheat: false });
    expect((await imp(cold.lines, cold.reading)).cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'SLOT_NONE:preheat' } });
  });

  it('E-32: a recognized hold after mixing excludes it; an unrecognized step leaves it unknown (never proven absence)', async () => {
    const chill = drop({ extraSteps: [{ after: 's2', step: { key: 'sx', text: 'Cover and refrigerate the dough for 30 minutes.', title: 'Chill', technique: 'REST' } }] });
    expect((await imp(chill.lines, chill.reading)).cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'APPLICABILITY' } });
    // a hold worded in a step the reading tagged as something else is still caught by its words
    const hidden = drop({ extraSteps: [{ after: 's2', step: { key: 'sx', text: 'Place on the tray and chill for 20 minutes.', title: 'Tray', technique: 'TRAY' } }] });
    expect((await imp(hidden.lines, hidden.reading)).cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'APPLICABILITY' } });
    // a step CourseCorrect didn't recognize (no cue confirms it) could be a hold: unknown, so the plan waits, never binds
    const odd = drop({ extraSteps: [{ after: 's2', step: { key: 'sx', text: 'Drop spoonfuls onto the lined tray.', title: 'Portion', technique: 'TRAY' } }] });
    const y = await imp(odd.lines, odd.reading);
    expect(y.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NEEDS_FACTS' });
    expect(y.use('baking powder', 2).analysis).toMatchObject({ status: 'blocked', reason: { code: 'missingFact' } });
    expect(y.use('baking powder', 2).analysis!.reason!.text).toMatch(/how step 4 is done/);
  });
});

describe('B8 source completeness (closure 2026-10-08): the whole method from the dry mix to baking must be read', () => {
  const sourceWith = (d: ReturnType<typeof drop>, edit: (l: string) => string) => ({ ...d, lines: d.lines.map(edit) });
  it('regression 1: the reading drops a source sentence requiring chilling → B8 never binds and nothing contradicts the source', async () => {
    const d = sourceWith(drop(), (l) => (l.startsWith('3. Stir in the milk') ? `${l} Chill the dough for 30 minutes.` : l));
    const x = await imp(d.lines, d.reading);
    expect(x.pack().recipe.steps[3].source).toEqual({ located: true, gapBefore: 'chill the dough for 30 minutes' });   // what the reading left out
    expect(x.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'APPLICABILITY' } });
    const bp = x.use('baking powder', 2).analysis!;
    expect(bp.plans.map((p) => p.ruleId)).not.toContain('powder_from_soda_and_tartar@1');
    expect(bp.reason!.text).toMatch(/the recipe rests or chills before baking, and the swap has to be baked straight away/);
    const k = await x.cook(1);
    const e = await k.ask('baking powder', ['baking-soda', 'cream-of-tartar']);
    expect(JSON.stringify(e)).not.toMatch(/REALIZED_AS_PROPOSED/);
    expect(x.svc.getActiveRecipe().recipe!.steps.map((s) => s.text).join(' ')).not.toMatch(/straight away/);   // no instruction was added
  });

  it('a dropped sentence without hold words still blocks: an unread passage is never treated as absent', async () => {
    const d = sourceWith(drop(), (l) => (l.startsWith('3. Stir in the milk') ? `${l} Fold it over twice.` : l));
    const x = await imp(d.lines, d.reading);
    expect(x.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NEEDS_FACTS' });
    expect(x.use('baking powder', 2).analysis).toMatchObject({ status: 'blocked', reason: { code: 'missingFact' } });
    expect(x.use('baking powder', 2).analysis!.reason!.text).toBe("The reading doesn't account for all of the original method (“fold it over twice” before step 4 isn't in the steps as read), so the reviewed alternative (baking soda and cream of tartar for baking powder) can't be offered: it needs the method from mixing to baking read in full.");
  });

  it('regression 2: a compound shaping-and-baking step read only as shaping → no recognized bake step, so B8 is not offered, said about the reading', async () => {
    const shapeBake = { key: 's3', text: 'Pat into rounds and bake for 12 minutes.', title: 'Shape and bake', technique: 'SHAPE' };
    const d = drop(); d.reading.steps[3] = shapeBake; d.lines[d.lines.length - 1] = `4. ${shapeBake.text}`;
    const x = await imp(d.lines, d.reading);
    expect(x.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'SLOT_NONE:bake' } });
    expect(x.use('baking powder', 2).analysis!.reason!.text).toMatch(/this reading has no recognized “bake” step after step 2, which the swap needs/);
    // the same compound step before a separate baking step: its stated time is unresolved, so B8 waits (never binds)
    const later = drop({ extraSteps: [{ after: 's2', step: { key: 'sx', text: 'Pat into rounds and leave for 15 minutes.', title: 'Shape', technique: 'SHAPE' } }] });
    const y = await imp(later.lines, later.reading);
    expect(y.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NEEDS_FACTS' });
    expect(y.use('baking powder', 2).analysis!.reason!.text).toMatch(/the time “15 minutes” in step 4 isn't accounted for/);
  });

  it('regression 3: a fully read, eligible method still gets the plan', async () => {
    const x = await imp(drop().lines, drop().reading);
    expect(x.pack().recipe.steps.slice(1).map((s) => s.source)).toEqual(Array(3).fill({ located: true, gapBefore: '' }));
    expect(x.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'BOUND' });
    expect(plan(x.use('baking powder', 2))).toMatchObject({ ruleId: 'powder_from_soda_and_tartar@1' });
  });
});

describe('B1 / B2: scoped leavening refusals and their twins', () => {
  it('E-06/E-07: soda alone is refused with the alternative offered; soda with cream of tartar is not refused', async () => {
    const k = await (await imp(drop().lines, drop().reading)).cook(1);
    const soda = await k.ask('baking powder', ['baking-soda']);
    expect(soda).toMatchObject({ outcome: 'needsFacts', proposalResponse: { response: 'REFUSED', alternativeOffered: true, text: expect.stringContaining('Baking soda on its own can\'t stand in for the baking powder in this recipe') } });
    expect(await k.ask('baking powder', ['baking-soda', 'cream-of-tartar'])).toMatchObject({ proposalResponse: { response: 'REALIZED_AS_PROPOSED' } });
  });

  it('B1 scope: an acid in the recipe takes it out of scope; an unconfirmed ingredient leaves it unknown, and it still blocks an AI soda card', async () => {
    const acid = drop({ extraIng: [['l', '1 tbsp lemon juice', 'lemon juice', '1 tbsp']], extraSteps: [{ after: 's1', step: { key: 's1b', text: 'Stir the lemon juice into the milk.', title: 'Sour milk', technique: null } }], extraUses: [{ ingredientKey: 'l', stepKey: 's1b', quote: 'the lemon juice', amountText: null, functions: ['ACIDITY'] }] });
    expect((await imp(acid.lines, acid.reading)).cover('soda_alone_for_powder')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'APPLICABILITY' } });
    const sodaCard = { useRef: 'U3', role: 'raises', functions: ['LEAVENING'], verdict: 'swap', swap: { ingredient: 'baking soda', kindId: 'baking-soda', amountText: '2 tsp', otherIngredients: [] },
      stepRewrites: [{ stepRef: 'S2', text: 'Whisk the flour, sugar, 2 tsp baking soda and salt.' }], siblings: [], tradeoff: 'They may taste a little different.', opinion: 'Use 2 tsp baking soda in step 2.' };
    const odd = drop({ extraIng: [['x', '1 tbsp golden syrup', 'golden syrup', '1 tbsp']], extraUses: [{ ingredientKey: 'x', stepKey: 's2', quote: 'the milk', amountText: null, functions: ['SWEETNESS'] }] });
    const y = await imp(odd.lines, odd.reading, { cards: [sodaCard] });
    expect(y.cover('soda_alone_for_powder')).toMatchObject({ status: 'NEEDS_FACTS' });
    expect(y.pack().cards!.find((e) => e.useId === y.use('baking powder', 2).id)!.reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Baking soda on its own for baking powder" refuses this replacement/);
  });

  it('B2: leaving the leavening out is refused (an AI omission fails); a second leavener takes it out of scope', async () => {
    const omit = { useRef: 'U3', role: 'raises', functions: ['LEAVENING'], verdict: 'omit', swap: null, stepRewrites: [{ stepRef: 'S2', text: 'Whisk the flour, sugar and salt.' }], siblings: [], tradeoff: 'Denser.', opinion: 'Leave the baking powder out of step 2.' };
    const x = await imp(drop().lines, drop().reading, { cards: [omit] });
    expect(x.pack().cards!.find((e) => e.useId === x.use('baking powder', 2).id)!.reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Leaving out the leavening" refuses leaving it out/);
    expect(x.use('baking powder', 2).analysis!.status).toBe('available');   // the reviewed soda + cream of tartar plan still shows
    expect(x.use('baking powder', 2).analysis!.ruledOut.map((r) => [r.ruleId, r.omission])).toEqual([['leavening_not_omittable@1', true], ['soda_alone_for_powder@1', false]]);
    const two = drop({ extraIng: [['d', '½ tsp bicarbonate of soda', 'bicarbonate of soda', '½ tsp']], extraUses: [{ ingredientKey: 'd', stepKey: 's1', quote: 'salt', amountText: null, functions: ['LEAVENING'] }] });
    expect((await imp(two.lines, two.reading)).cover('leavening_not_omittable')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'APPLICABILITY' } });
  });
});

describe('B3 / B4 / B5 / D-5 at the stove (approved shortcake): each refusal answers its own proposal only', () => {
  const p = pack(RECIPE['shortcake.demo']);
  const id = (name: RegExp) => p.recipe.ingredients.find((i) => name.test(i.name))!.ingredientId;
  const at = (doneSteps: number, ing: RegExp, kinds: string[]) => evaluate(p, vocab, snapshotAfter(p, doneUpTo(p, doneSteps)), req(id(ing), kinds));
  const why = (doneSteps: number, ing: RegExp, kinds: string[]) => refusalWhy({ pack: p, patterns, v: vocab }, at(doneSteps, ing, kinds), kinds);
  it('E-09: thin creams for whipping refused; light whipping cream (no kind) is not; milk and butter keep the hero answer', () => {
    expect(at(5, /cream/i, ['half-and-half-cream']).proposal).toMatchObject({ response: 'REFUSED', text: expect.stringMatching(/^This catalog doesn't accept half-and-half or light cream/) });
    expect(at(5, /cream/i, ['light-cream']).proposal).toMatchObject({ response: 'REFUSED' });
    expect(at(5, /cream/i, ['whole-milk', 'unsalted-butter']).proposal).toMatchObject({ response: 'REFUSED', text: expect.stringMatching(/^This catalog doesn't accept milk and butter in place of cream that has to be whipped/) });
    // the authored reason is said once (2026-10-08): no second fact restating the job
    expect(why(5, /cream/i, ['whole-milk', 'unsalted-butter']).facts).toEqual(["This catalog doesn't accept milk and butter in place of cream that has to be whipped: a milk-and-butter mixture won't hold air or whip into peaks. This is about that replacement only"]);
    expect(why(5, /cream/i, ['half-and-half-cream']).facts).toEqual(["This catalog doesn't accept half-and-half or light cream in place of cream that has to be whipped: cream needs at least 30 percent fat to hold air, and these have less"]);
    // at the dough step the whipping use is explained once, by its own refusal
    expect(why(3, /cream/i, ['whole-milk', 'unsalted-butter']).facts).toEqual(["In step 4 (Make the dough) the cream is the liquid and fat; milk and butter can do that job", "In step 6 (Whip the cream) the cream is used to whip (whipped topping); milk and butter can't whip"]);
  });
  it('E-10: oil for the rubbed-in butter refused (vegetable or olive); another solid fat is not answered by it', () => {
    for (const k of ['vegetable-oil', 'olive-oil']) expect(at(2, /butter/i, [k]).proposal).toMatchObject({ response: 'REFUSED', text: expect.stringMatching(/^Oil can't stand in for the cold butter/) });
    expect(at(2, /butter/i, ['unsalted-butter']).proposal?.response).not.toBe('REFUSED');
  });
  it('E-12/E-13: powdered (or icing) sugar refused in the dry mix; the same proposal for the whipped-cream sugar is not refused', () => {
    expect(at(1, /sugar/i, ['confectioners-sugar']).proposal).toMatchObject({ response: 'REFUSED', text: expect.stringMatching(/^Powdered \(icing\) sugar can't simply replace/) });
    expect(at(1, /sugar/i, ['icing-sugar']).proposal).toMatchObject({ response: 'REFUSED' });
    expect(at(5, /sugar/i, ['confectioners-sugar']).target!.order).toBe(6);
    expect(at(5, /sugar/i, ['confectioners-sugar']).proposal?.response).not.toBe('REFUSED');
  });
  it('D-5: oat flour for all the flour is not offered, worded as disputed, never as impossible', () => {
    expect(at(1, /flour/i, ['oat-flour']).proposal).toMatchObject({ response: 'REFUSED', text: expect.stringMatching(/^CourseCorrect doesn't offer oat flour in place of all the flour/) });
    const facts = why(1, /flour/i, ['oat-flour']).facts;
    expect(facts.some((f) => /the sources disagree/.test(f))).toBe(true);
    expect(facts.some((f) => /oat flour can't/i.test(f))).toBe(false);
  });
});

describe('G13 on an imported shortcake: a refusal answers its replacement; unrelated AI drafts stay available', () => {
  const card = (useRef: string, role: string, functions: string[], ingredient: string, kindId: string | null, amountText: string, stepRef: string, text: string, tradeoff: string, opinion: string, siblings: unknown[] = []) =>
    ({ useRef, role, functions, verdict: 'swap', swap: { ingredient, kindId, amountText, otherIngredients: [] }, stepRewrites: [{ stepRef, text }], siblings, tradeoff, opinion });
  const cards = { cards: [
    card('U1', 'the structure of the shortcakes', ['STRUCTURE'], 'oat flour', null, '250 g', 'S2', 'Whisk 250 g oat flour, 30 g sugar, 2 tsp baking powder and ½ tsp salt.', 'The shortcakes will be denser and taste of oats.', 'Use 250 g oat flour for the plain flour.'),
    { useRef: 'U3', role: 'makes the shortcakes rise', functions: ['LEAVENING'], verdict: 'omit', swap: null, stepRewrites: [{ stepRef: 'S2', text: 'Whisk 250 g flour, 30 g sugar and ½ tsp salt.' }], siblings: [], tradeoff: 'They will be flatter and denser.', opinion: 'Leave the baking powder out of step 2.' },
    card('U5', 'the fat rubbed into the flour', ['FAT'], 'shortening', null, '85 g', 'S3', 'Rub in 85 g shortening until the mixture looks like coarse crumbs.', 'The shortcakes will be a little less flaky and taste less of butter.', 'Rub in 85 g shortening for the cold butter.'),
    card('U7', 'whipped into the topping', ['AERATION'], 'milk', 'whole-milk', '240 ML', 'S6', 'Whip 240 ML milk with 15 g sugar to soft peaks.', 'The topping will be much thinner.', 'Whip 240 ML milk with the sugar.',
      [{ useRef: 'U6', handling: 'unchanged', note: 'The cream in step 4 is already in the dough by then.' }]),
  ] };
  it('E-11: shortening stays an AI plan beside the oil refusal; oat flour, the omission and milk-for-whipping are refused as drafted', async () => {
    const x = await imp(SHORTCAKE_LINES, SHORTCAKE_READING, cards);
    const reason = (name: string, step: number) => x.pack().cards!.find((e) => e.useId === x.use(name, step).id)!;
    const butter = x.use('butter', 3).analysis!;
    expect(butter).toMatchObject({ status: 'available', plans: [{ ruleId: null, title: 'Shortening for the butter', provenance: { kind: 'aiPrepared' } }] });
    expect(butter.ruledOut.map((r) => r.ruleId)).toEqual(['oil_for_cold_butter_rub_in@1']);
    expect(reason('plain flour', 2).reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Oat flour for all the flour in a dough that rises"/);
    const flour = x.use('plain flour', 2).analysis!;
    expect(flour).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'contradictsReviewedRule' } });
    expect(flour.reason!.text).toMatch(/^The alternative drafted at import \(oat flour for the plain flour\) isn’t offered\. CourseCorrect doesn't offer oat flour/);
    expect(flour.reason!.text).toMatch(/No other alternative was drafted for this use\.$/);
    expect(flour.reason!.detail).toContain('Prepared at import (AI) said: “Use 250 g oat flour for the plain flour.”');   // the original candidate and its reasons are kept
    expect(reason('baking powder', 2).reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Leaving out the leavening" refuses leaving it out/);
    expect(reason('heavy cream', 6).reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Milk and butter for cream that must whip" refuses this replacement/);   // milk alone: part of the refused pair
    // the reading tags step 5 ("Pat … and bake") as shaping, so no step is recognized as baking: soda + cream of tartar is
    // not offered here, and the reason speaks about the reading, not the recipe
    expect(x.cover('powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'SLOT_NONE:bake' } });
    // at the stove: oil is refused, and the AI's shortening plan is offered instead
    const k = await x.cook(2);
    const oil = await k.ask('butter', ['vegetable-oil']);
    expect(oil).toMatchObject({ proposalResponse: { response: 'REFUSED', alternativeOffered: true } });
  });
});

describe('protected work, successive changes, and unchanged heroes', () => {
  it('E-26/E-28: started work refuses the plan; the proposal is still answered', async () => {
    const x = await imp(drop().lines, drop().reading);
    const k = await x.cook(1);
    k.progress(1, 'started');
    const e = await k.ask('baking powder');                       // the plan touches the started step
    expect(e.outcome).toBe('refused');
    expect(JSON.stringify(e)).toMatch(/PROTECTED_WORK/);
    // a proposal is still answered first: soda alone is refused for what it is, not for the started work
    expect(await k.ask('baking powder', ['baking-soda'])).toMatchObject({ outcome: 'refused', proposalResponse: { response: 'REFUSED' } });
    const y = await imp(drop().lines, drop().reading);
    const k2 = await y.cook(2);
    k2.progress(2, 'started');
    const milk = await k2.ask('milk', ['evaporated-milk']);
    expect(milk.outcome).toBe('refused');
    expect(JSON.stringify(milk)).toMatch(/PROTECTED_WORK/);
  });

  it('E-29: two changes to the same dry-mix step: the second is refused (CONFLICTS_WITH_EARLIER_CHANGE), never merged', async () => {
    const k = await (await imp(drop().lines, drop().reading)).cook(1);
    const s1 = await k.ask('caster sugar', ['white-sugar']);
    if (s1.outcome !== 'needsFacts') throw new Error(s1.outcome);
    const s2 = await k.ask('caster sugar', ['white-sugar'], s1);
    if (s2.outcome !== 'proposal') throw new Error(s2.outcome);
    expect(k.apply(s2).outcome).toBe('applied');
    const bp = await k.ask('baking powder', ['baking-soda', 'cream-of-tartar']);
    expect(JSON.stringify(bp)).toMatch(/CONFLICTS_WITH_EARLIER_CHANGE/);
  });

  it('the hero packs keep their bindings and quantities (risotto split; scone cream; shortcake whipping refusal)', () => {
    const risotto = pack(RECIPE['risotto.demo']);
    expect(risotto.bindings.map((b) => b.patternId)).toEqual(['split']);
    expect(risotto.bindings[0].quantities).toEqual({ stock_now: { value: { n: 120, d: 1 }, unit: 'ML' }, acid: { value: { n: 10, d: 1 }, unit: 'ML' } });
    const scone = pack(RECIPE['scones.demo']).bindings.find((b) => b.patternId === 'cream_to_butter_milk')!;
    expect(scone).toMatchObject({ patternVersion: 1, quantities: { butter: { value: { n: 85, d: 1 }, unit: 'G' }, milk: { value: { n: 180, d: 1 }, unit: 'ML' }, milk_extra: { value: { n: 30, d: 1 }, unit: 'ML' } } });
    expect(pack(RECIPE['shortcake.demo']).bindings.filter((b) => b.patternId === 'whip_needs_cream')).toHaveLength(1);
    // the authorized identity fix: the approved scone's caster sugar is caster sugar, so B6 binds there too
    expect(pack(RECIPE['scones.demo']).bindings.map((b) => b.patternId)).toContain('caster_to_granulated');
  });
});

