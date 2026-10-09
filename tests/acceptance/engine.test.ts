// Pure engine + binder acceptance (ESOD §10). Quantities are engineering/owner-directed values: assert structure and authority.
import { describe, expect, it } from 'vitest';
import type { RecipePack } from '../../src/contract/types.ts';
import { compile } from '../../src/compile/binder.ts';
import { canonicalJson, hash } from '../../src/domain/rational.ts';
import { expandRecipe, getStep, parseAmount, renderStep, validateStructure } from '../../src/domain/recipe.ts';
import { applyOps } from '../../src/engine/apply.ts';
import { evaluate } from '../../src/engine/evaluate.ts';
import { recordedInterpreter, validateIntent } from '../../src/service/interpret.ts';
import { RECORDED_INTENTS } from '../fixtures/recorded-intents.ts';
import { contradictingRefusal, renameIds, splitWithException, synA, synB, synC, synStockOnly, synSwapCheese, withPatterns } from '../fixtures/synthetic.ts';
import { compileSource, content, doneUpTo, evaluateWithEnough, fixtureActions, pack, patterns, req, snapshotAfter, source, synVocab, vocab } from '../helpers.ts';
import { ING, RECIPE, STEP, USE } from '../fixtures/ids.ts';
import { MAX_CHANGES_PER_RUN } from '../../src/contract/types.ts';

const risotto = () => pack(RECIPE['risotto.demo']);
const atStep5 = () => snapshotAfter(risotto(), fixtureActions('risotto.step5'));

describe('risotto split (B1, B2, B3)', () => {
  it('B1: liquid now, acidity at finish, flavor dropped with tradeoff; resume at step 5 not started; prefix byte-identical', () => {
    const snap = atStep5();
    const { second } = evaluateWithEnough(risotto(), snap, ING['wine'], ['lemon-juice']);
    expect(second.status).toBe('CANDIDATES');
    const c = second.candidates[0];
    expect(c.resume).toMatchObject({ stepId: STEP['r.deglaze'], order: 5, title: 'Add the stock', text: 'Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.' });
    expect(snap.stepStatus[STEP['r.deglaze']]).toBe('NOT_STARTED');
    expect(renderStep(c.resultRecipe, getStep(c.resultRecipe, STEP['r.finish'])!)).toBe('Off the heat, stir in 30 g butter, 50 g grated Parmesan and 10 ML lemon juice. Season with salt.');
    for (const id of [STEP['r.heat'], STEP['r.soften'], STEP['r.garlic'], STEP['r.toast']]) expect(canonicalJson(getStep(c.resultRecipe, id))).toBe(canonicalJson(getStep(snap.recipe, id)));
    const byFn = Object.fromEntries(risotto().bindings[0].functionMap.map((e) => [e.functionId, e.disposition]));
    expect(byFn).toEqual({ ACIDITY: 'MOVED', FLAVOR: 'DROPPED_WITH_TRADEOFF', LIQUID: 'RETAINED' });
    expect(c.changes.filter((x) => x.kind === 'CHANGED').map((x) => [x.stepId, x.when])).toEqual([[STEP['r.deglaze'], 'NOW'], [STEP['r.finish'], 'LATER']]);
    expect(second.proposal).toMatchObject({ response: 'ADAPTED', alternativeOffered: true });
  });

  it('B2: availability unknown → CLARIFY for amounts beyond reservations; reserved stock never credited', () => {
    const res = evaluate(risotto(), vocab, atStep5(), req(ING['wine'], ['lemon-juice']));
    expect(res.status).toBe('CLARIFY');
    expect(res.previews).toHaveLength(1);
    const reqs = res.questions.flatMap((q) => (q.kind === 'AVAILABILITY' ? q.requirements : []));
    expect(reqs.map((r) => r.display)).toEqual(['120 ML more hot unsalted vegetable stock', '10 ML lemon juice']);
    expect(reqs[0]).toMatchObject({ qty: { n: 120, d: 1 }, alreadyReserved: { qty: { n: 900, d: 1 }, forSteps: [{ stepId: STEP['r.ladle'], order: 6 }] } });
    expect(res.speech).toBe('To check this, I need to know: do you have 120 ML more hot unsalted vegetable stock and 10 ML lemon juice?');
  });

  it('B3: step 5 started, or wine partly poured → protected-work refusal naming the fact; no question, no quantities', () => {
    for (const extra of [{ stepId: STEP['r.deglaze'], progress: 'started' as const }, { stepId: STEP['r.deglaze'], progress: 'partly' as const, partialUseIds: [USE['r.wine']] }]) {
      const snap = snapshotAfter(risotto(), [...fixtureActions('risotto.step5'), extra]);
      const res = evaluate(risotto(), vocab, snap, req(ING['wine'], ['lemon-juice']));
      expect(res.status).toBe('REFUSED');
      expect(res.refusal!.code).toBe('PROTECTED_WORK');
      expect(res.refusal!.protectedFacts.map((f) => f.kind)).toContain('STEP_STARTED');
      expect(res.questions).toEqual([]);
      expect(res.candidates).toEqual([]);
      expect(res.trace.bindings[0].checks.at(-1)).toMatchObject({ stage: 'HISTORY', result: 'FAIL' });
    }
  });

  it('B2b: NOT_ENOUGH → INSUFFICIENT_AVAILABILITY, recipe unchanged', () => {
    const snap = atStep5();
    const q = evaluate(risotto(), vocab, snap, req(ING['wine'])).questions;
    const res = evaluate(risotto(), vocab, snap, req(ING['wine'], [], q.map((x) => ({ questionId: x.questionId, choiceId: 'NOT_ENOUGH' as const }))));
    expect(res.refusal?.code).toBe('INSUFFICIENT_AVAILABILITY');
  });
});

describe('function decides, not the ingredient name (B7, B8)', () => {
  it('B7: milk+butter for cream that must whip → categorical refusal, authored text, no ops', () => {
    const p = pack(RECIPE['shortcake.demo']);
    const res = evaluate(p, vocab, snapshotAfter(p, fixtureActions('shortcake.step6')), req(ING['cream'], ['whole-milk', 'unsalted-butter']));
    expect(res.status).toBe('REFUSED');
    expect(res.refusal).toMatchObject({ code: 'NOT_FUNCTIONALLY_EQUIVALENT', requiredFunction: { label: 'whipped topping', order: 6 }, unchanged: 'Your recipe is unchanged. Step 6 still needs 240 ML heavy cream.' });
    expect(res.refusal!.message).toContain("won't hold air or whip into peaks");
    expect(res.refusal!.ingredientUses.map((u) => [u.order, u.status])).toEqual([[4, 'ADDED'], [6, 'UNADDED']]);
    expect(res.candidates).toEqual([]);
    expect(p.coverage.find((c) => c.patternId === 'cream_to_butter_milk')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED' } });
  });

  it('B8: the same proposal on dough cream is realized, with a changed method covering both cream uses', () => {
    const p = pack(RECIPE['scones.demo']);
    const { second } = evaluateWithEnough(p, snapshotAfter(p, fixtureActions('scones.step3')), ING['cream'], ['whole-milk', 'unsalted-butter']);
    expect(second.status).toBe('CANDIDATES');
    expect(second.proposal).toMatchObject({ response: 'REALIZED_AS_PROPOSED', alternativeOffered: false });
    const c = second.candidates[0];
    const r = c.resultRecipe;
    expect(renderStep(r, getStep(r, STEP['sc.brush'])!)).toBe('Brush the tops with a little milk.');
    expect(renderStep(r, getStep(r, STEP['sc.dough'])!)).toBe('Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 180 ML milk until a soft dough forms. '
      + "Only if needed: up to 30 ML more milk. Add it 1 tablespoon at a time and stop as soon as no dry flour remains. If the dough is still crumbly after that, press it together with your hands; don't add more liquid.");
    expect(c.resume).toMatchObject({ stepId: STEP['sc.dough'], order: 3 });
    expect(c.noLongerUsed.map((x) => x.name)).toEqual(['Heavy cream']);
    expect(c.changes.map((x) => x.newOrder)).toEqual([1, 2, 3, 4, 5, 6, 7]);   // no renumbering
  });
});

describe('scone brushing boundary (OD-3) and bounded quantity (B13)', () => {
  const p = () => pack(RECIPE['scones.demo']);
  const snap = () => snapshotAfter(p(), fixtureActions('scones.step3'));

  it('the qualitative brushing milk is a separate question, never zero, never in the exact milk total', () => {
    const res = evaluate(p(), vocab, snap(), req(ING['cream'], ['whole-milk', 'unsalted-butter']));
    expect(res.status).toBe('CLARIFY');
    expect(res.questions).toHaveLength(2);
    const [exact, brush] = res.questions.map((q) => (q.kind === 'AVAILABILITY' ? q.requirements : []));
    const milk = exact.find((r) => r.name === 'milk')!;
    expect(milk).toMatchObject({ qty: { n: 210, d: 1 }, includesUpTo: { n: 30, d: 1 }, display: '180 ML milk, plus up to 30 ML more only if needed' });
    expect(brush).toHaveLength(1);
    expect(brush[0]).toMatchObject({ name: 'milk', qty: null, unit: null, forSteps: [{ stepId: STEP['sc.brush'], order: 6 }] });
    expect(brush[0].display).toContain('amount not stated');
    expect(brush[0].display.toLowerCase()).not.toContain('glaz');
  });

  it('confirming only the numeric amounts does not cover brushing: still CLARIFY on the brushing question', () => {
    const first = evaluate(p(), vocab, snap(), req(ING['cream']));
    const exactQ = first.questions[0];
    const res = evaluate(p(), vocab, snap(), req(ING['cream'], [], [{ questionId: exactQ.questionId, choiceId: 'ENOUGH' }]));
    expect(res.status).toBe('CLARIFY');
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].kind === 'AVAILABILITY' && res.questions[0].requirements[0].qty).toBeNull();
  });

  it('B13: allowance rendered as an optional ceiling with stop and exhaustion text; reservations count the maximum', () => {
    const { second } = evaluateWithEnough(p(), snap(), ING['cream']);
    const milkDough = second.candidates[0].resultRecipe.uses.find((u) => u.allowance !== null)!;
    expect(milkDough.allowance).toMatchObject({ max: { n: 30, d: 1 }, unit: 'ML' });
    expect(second.candidates[0].requirements[0].includesUpTo).toEqual({ n: 30, d: 1 });
  });
});

describe('references, notices, modes (B9, B11, B16, B33)', () => {
  it('B9: a stated amount is never used; only reviewed quantities appear', async () => {
    const intent = await recordedInterpreter(RECORDED_INTENTS).interpret('No wine. Can I use 60 ml of lemon?', {
      ingredients: risotto().recipe.ingredients.map((i) => ({ id: i.ingredientId, name: i.name })), kinds: vocab.kinds.map((k) => ({ id: k.kindId, label: k.label, aliases: k.aliases })) });
    expect(intent.ok && intent.intent.statesAmount).toBe(true);
    const res = evaluate(risotto(), vocab, atStep5(), req(ING['wine'], ['lemon-juice'], [], [{ kind: 'STATED_AMOUNT_IGNORED', text: '60 ml' }]));
    expect(res.notices[0].kind).toBe('STATED_AMOUNT_IGNORED');
    const displays = res.questions.flatMap((q) => (q.kind === 'AVAILABILITY' ? q.requirements.map((r) => r.display) : []));
    expect(displays).toContain('10 ML lemon juice');
    expect(displays.join(' ')).not.toMatch(/\b60\b/);
  });

  it('B11: COOK mode without release → NOT_RELEASED before content: no target, no quantities, no question', () => {
    const res = evaluate(risotto(), vocab, snapshotAfter(risotto(), fixtureActions('risotto.step5'), 'COOK'), req(ING['wine']));
    expect(res).toMatchObject({ status: 'NOT_RELEASED', target: null, questions: [], candidates: [], previews: [] });
  });

  it('B16: no resolved reference → closed reference question; nothing else', () => {
    const res = evaluate(risotto(), vocab, atStep5(), req(null));
    expect(res.status).toBe('CLARIFY');
    expect(res.questions[0].kind).toBe('REFERENCE');
    expect(res.candidates).toEqual([]);
  });

  it('B33: a PREPARE use never reserves, targets or sums', () => {
    const r = risotto().recipe;
    expect(r.uses.find((u) => u.useId === USE['r.stock_hot'])!.kind).toBe('PREPARE');
    const res = evaluate(risotto(), vocab, atStep5(), req(ING['stock']));
    expect(res.target?.useId).toBe(USE['r.stock']);
    const reqs = evaluate(risotto(), vocab, atStep5(), req(ING['wine'])).questions.flatMap((q) => (q.kind === 'AVAILABILITY' ? q.requirements : []));
    expect(reqs[0].alreadyReserved!.qty).toEqual({ n: 900, d: 1 });   // not 1800
  });

  it('nothing to change: all uses done, or removed by the accepted amendment', () => {
    const snap = atStep5();
    const done = evaluate(risotto(), vocab, snap, req(ING['rice']));
    expect(done.refusal).toMatchObject({ code: 'NOTHING_TO_CHANGE', reason: 'ALL_USES_DONE' });
    const { second } = evaluateWithEnough(risotto(), snap, ING['wine']);
    const v2 = { ...snap, recipe: second.candidates[0].resultRecipe, version: 2, appliedRescueCount: 1 };
    expect(evaluate(risotto(), vocab, v2, req(ING['wine'])).refusal).toMatchObject({ code: 'NOTHING_TO_CHANGE', reason: 'REPLACED_BY_AMENDMENT' });
    expect(evaluate(risotto(), vocab, v2, req(ING['butter'])).refusal?.code).toBe('NO_SUPPORTED_RECOVERY');   // a later rescue is evaluated, not blocked
    expect(evaluate(risotto(), vocab, { ...v2, appliedRescueCount: MAX_CHANGES_PER_RUN }, req(ING['butter'])).refusal?.code).toBe('SUCCESSIVE_RESCUE_UNSUPPORTED');
  });

  it('several changes per run: a later change applies on the changed recipe, but never rewrites what an earlier change altered (SYNTHETIC)', () => {
    const p = compile(expandRecipe(source(RECIPE['risotto.demo'])), vocab, withPatterns(synSwapCheese())).pack!;
    const at7 = snapshotAfter(p, doneUpTo(p, 6));
    expect(evaluateWithEnough(p, at7, ING['parm']).second.status).toBe('CANDIDATES');   // on its own, the synthetic cheese rule applies at step 7
    const snap = atStep5();
    const { second } = evaluateWithEnough(p, snap, ING['wine']);                       // change 1 (split) rewrites step 7: adds lemon juice
    const r2 = second.candidates[0].resultRecipe, ss = { ...snap.stepStatus }, us = { ...snap.useStatus };
    for (const st of r2.steps.slice(4, 6)) { ss[st.stepId] = 'COMPLETED'; for (const u of r2.uses.filter((x) => x.stepId === st.stepId)) us[u.useId] = 'ADDED'; }
    const v2 = { ...snap, recipe: r2, version: 2, appliedRescueCount: 1, stepStatus: ss, useStatus: us };   // steps 5–6 then done
    const later = evaluateWithEnough(p, v2, ING['parm']).second;                      // change 2 would rewrite step 7 again
    expect(later.refusal?.code).toBe('CONFLICTS_WITH_EARLIER_CHANGE');
    expect(later.trace.bindings[0].checks[0]).toMatchObject({ stage: 'HISTORY', result: 'FAIL', detail: STEP['r.finish'] });
  });
});

describe('no hero branch: synthetic recipes (B6, B15, B17, B18, B19)  — SYNTHETIC SOFTWARE EVIDENCE', () => {
  it('B17: SYN-A renamed, rearranged, different names and kinds, wine 140 → same plan shape, stock 140, acid 12', () => {
    const p = compileSource(synA(), synVocab);
    expect(p.bindings.map((b) => b.patternId)).toEqual(['split']);
    const snap = snapshotAfter(p, doneUpTo(p, 4));
    const { second } = evaluateWithEnough(p, snap, `z.q_${ING['wine']}`, [], synVocab);
    const c = second.candidates[0];
    expect(c.resume.text).toBe('Pour in 140 ML hot mushroom stock and stir until absorbed.');
    expect(renderStep(c.resultRecipe, getStep(c.resultRecipe, `z.q_${STEP['r.finish']}`)!)).toContain('and 12 ML lemon juice');
  });

  it('B17: rename(evaluate(recipe)) ≡ evaluate(rename(recipe)) for random bijections', () => {
    for (let trial = 0; trial < 5; trial++) {
      const ids = new Map<string, string>();
      const map = (id: string) => { if (!ids.has(id)) ids.set(id, `x${trial}${Math.random().toString(36).slice(2, 10)}`); return ids.get(id)!; };
      const renamed = compileSource(renameIds(source(RECIPE['risotto.demo']), map));
      const back = (s: string) => [...ids].reduce((acc, [orig, nu]) => acc.split(nu).join(orig), s);
      const snapA = atStep5(), snapB = snapshotAfter(renamed, fixtureActions('risotto.step5').map((a) => ({ ...a, stepId: map(a.stepId) })));
      const a = evaluateWithEnough(risotto(), snapA, ING['wine'], ['lemon-juice']).second;
      const b = evaluateWithEnough(renamed, snapB, map(ING['wine']), ['lemon-juice']).second;
      const strip = (x: typeof a) => canonicalJson({ status: x.status, proposal: x.proposal, c: x.candidates.map(({ planHash: _p, candidateId: _c, ...rest }) => rest), refusal: x.refusal });
      expect(back(strip(b))).toBe(strip(a));
    }
  });

  it('B6 (SYN-C): an uncovered second remaining use refuses this request only; the pack still compiles', () => {
    const p = compileSource(synC());
    const b = p.bindings.find((x) => x.patternId === 'split')!;
    expect(b.uncoveredSiblingUseIds).toEqual(['r.wine2']);
    const res = evaluate(p, vocab, snapshotAfter(p, fixtureActions('risotto.step5')), req(ING['wine']));
    expect(res.refusal?.code).toBe('AFFECTED_USE_UNACCOUNTED');
    expect(res.refusal?.message).toContain('step 7');
    expect(evaluate(p, vocab, snapshotAfter(p, fixtureActions('risotto.step5')), req(ING['stock'])).refusal?.code).toBe('NO_SUPPORTED_RECOVERY');
  });

  it('SYN-B: pearl barley → split NOT_APPLICABLE; the recipe still compiles and is evaluable', () => {
    const p = compileSource(synB(), synVocab);
    expect(p.bindings).toEqual([]);
    expect(p.coverage.find((c) => c.patternId === 'split')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'SLOT_NONE:rice' } });
    expect(evaluate(p, synVocab, snapshotAfter(p, doneUpTo(p, 4)), req(`z.q_${ING['wine']}`)).refusal?.code).toBe('NO_SUPPORTED_RECOVERY');
  });

  it('B15 (SYN-D): two applicable rules → both shown, never merged or auto-chosen; compile warns', () => {
    const p = compile(expandRecipe(source(RECIPE['risotto.demo'])), vocab, withPatterns(synStockOnly())).pack!;
    expect(p.warnings[0]).toContain(`MULTIPLE_RECOVERIES:${USE['r.wine']}`);
    const { second } = evaluateWithEnough(p, atStep5(), ING['wine']);
    expect(second.status).toBe('CANDIDATES');
    expect(second.candidates.map((c) => p.bindings.find((b) => b.bindingId === c.candidateId)!.patternId)).toEqual(['split', 'syn_stock_only']);   // ordered by rule
    expect(second.candidates.every((c) => /^cand_[0-9a-f]{12}$/.test(c.candidateId))).toBe(true);
    expect(second.speech).toContain('Choose one');
  });

  it('B18 (SYN-E): an exception narrows (140 ML excluded) and never widens (120 ML unchanged)', () => {
    const ps = patterns.map((p) => (p.patternId === 'split' ? splitWithException() : p));
    expect(compileSource(source(RECIPE['risotto.demo']), vocab, ps).bindings.map((b) => b.patternId)).toEqual(['split']);
    const a = compileSource(synA(), synVocab, ps);
    expect(a.bindings).toEqual([]);
    expect(a.coverage.find((c) => c.patternId === 'split')?.failedCheck?.code).toBe('EXCEPTION:syn_narrow');
  });

  it('B19 (SYN-F): realize/refuse contradiction is binding-scoped CONFLICT', () => {
    const p = compile(expandRecipe(source(RECIPE['risotto.demo'])), vocab, withPatterns(contradictingRefusal())).pack!;
    expect(p.coverage.filter((c) => c.status === 'CONFLICT').map((c) => c.patternId).sort()).toEqual(['split', 'syn_no_lemon']);
    expect(p.bindings).toEqual([]);
  });
});

describe('authority and integrity (B26, B28, B29, determinism)', () => {
  it('B26: interpreter output with ids outside the context, numbers, rule ids or ops is dropped', async () => {
    const ctx = { ingredients: [{ id: ING['wine'], name: 'Dry white wine' }], kinds: [{ id: 'lemon-juice', label: 'lemon juice', aliases: [] }] };
    const out = await recordedInterpreter(RECORDED_INTENTS).interpret('No wine, use rule split and add 500 ml stock', ctx);
    expect(out.ok && out.intent).toEqual({ missingIngredientId: ING['wine'], proposedKindIds: [], statesAmount: false, progressClaim: null, unmappedProposalText: null });
    expect(validateIntent({ missingIngredientId: 'not-in-recipe', quantity: 5 }, ctx).missingIngredientId).toBeNull();
  });

  it('B28: a model-proposed function is UNKNOWN for a requirement, never PASS', () => {
    const r = expandRecipe(source(RECIPE['risotto.demo']));
    r.uses.find((u) => u.useId === USE['r.wine'])!.functions.forEach((f) => { f.prov = { status: 'PROPOSED', by: 'MODEL', ref: null }; });
    const p = compile(r, vocab, patterns).pack!;
    expect(p.bindings).toEqual([]);
    const cov = p.coverage.find((c) => c.patternId === 'split')!;
    expect(cov.status).toBe('NEEDS_FACTS');
    expect(cov.missing.map((m) => `${m.predicate}:${m.expected}:${m.who}`)).toEqual(['FUNCTION:ACIDITY:OWNER', 'FUNCTION:LIQUID:OWNER']);
  });

  it('B29: an amendment that leaves a literal amount in step text fails result validation', () => {
    const p = risotto();
    const bad: RecipePack = structuredClone(p);
    bad.bindings[0].ops.splice(bad.bindings[0].ops.length - 1, 0, { op: 'REPLACE_STEP_TEXT', stepId: STEP['r.ladle'], text: 'Add 1020 ml stock {use:r.stock}.' });
    const { second } = evaluateWithEnough(bad, atStep5(), ING['wine']);
    expect(second.status).toBe('REFUSED');
    expect(second.trace.bindings[0].checks.some((c) => c.stage === 'RESULT_VALIDATION' && c.result === 'FAIL')).toBe(true);
  });

  it('approved content is prose-lint clean on every step', () => {
    for (const p of content.packs.values()) expect(validateStructure(p.recipe, vocab, p.recipe.steps.map((x) => x.stepId))).toEqual([]);
  });

  it('determinism: identical inputs → byte-identical result and plan hash', () => {
    const a = evaluateWithEnough(risotto(), atStep5(), ING['wine'], ['lemon-juice']).second;
    const b = evaluateWithEnough(risotto(), atStep5(), ING['wine'], ['lemon-juice']).second;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('protected history proof: applyOps never alters a completed step', () => {
    const snap = atStep5();
    const after = applyOps(snap.recipe, risotto().bindings[0].ops).recipe;
    expect(hash(after.steps.slice(0, 4))).toBe(hash(snap.recipe.steps.slice(0, 4)));
  });

  it('B14 (partial): household volumes convert exactly; mass is never inferred from volume', () => {
    expect(parseAmount('½ cup', 'US')).toMatchObject({ kind: 'EXACT', unit: 'ML', value: { n: 473176473, d: 4000000 }, asWritten: '½ cup' });
    expect(parseAmount('1 ½ cups', 'US')).toMatchObject({ kind: 'EXACT', unit: 'ML', value: { n: 1419529419, d: 4000000 } });   // M2: mixed numbers
    expect(parseAmount('8 oz', 'US')).toMatchObject({ kind: 'EXACT', unit: 'G' });
  });
});

// SYNTHETIC SOFTWARE EVIDENCE (2026-10-07): the proposed rule v2 shape for an explicit-quantity scone, derived here in code from
// the approved v1 (base $target; a $brush slot; brushing milk = the stated brushing amount ×1). Not approved content; the
// amounts are the pending owner decision (private/demo/scone-explicit-proposal/), used only to exercise the engine.
describe('explicit-quantity scone (synthetic v2 shape): dough-based scaling, brushing accounted separately, availability by purpose', async () => {
  const { content, compileSource, source, snapshotAfter, doneUpTo } = await import('../helpers.ts');
  const v1 = content.patterns.find((p) => p.patternId === 'cream_to_butter_milk')!;
  if (v1.kind !== 'RECOVERY') throw new Error('v1');
  const v2 = structuredClone(v1);
  v2.version = 2;
  v2.slots = [...v1.slots, { slot: 'brush', kind: 'USE_AFTER_TARGET', ingredientClass: 'heavy-cream', performsAll: ['BROWNING'], stepTechnique: 'BRUSH' }];
  for (const q of ['butter', 'milk', 'milk_extra']) { const e = v2.quantities[q]; if (e.kind === 'SCALE') e.from = '$target'; }
  v2.quantities.milk_brush = { kind: 'SCALE', from: '$brush', sourceUnit: 'ML', factor: { n: 1, d: 1 }, resultUnit: 'ML', inputDomain: [{ n: 5, d: 1 }, { n: 30, d: 1 }], increment: { n: 1, d: 1 }, maxAbsError: { n: 1, d: 2 }, outputDomain: [{ n: 5, d: 1 }, { n: 30, d: 1 }] };
  v2.siblingHandlers = [{ ...v1.siblingHandlers[0], replaceWith: { ...v1.siblingHandlers[0].replaceWith, qty: 'milk_brush' } }];
  const patterns = [...content.patterns.filter((p) => p.patternId !== 'cream_to_butter_milk'), v1, v2];
  const base = source(content.names.get('scones')!);
  const explicit = structuredClone(base);
  explicit.ingredients.find((i) => i.kind === 'heavy-cream')!.listed = '315 ML';
  const [dough, brush] = explicit.uses.filter((u) => u.ingredient === explicit.ingredients.find((i) => i.kind === 'heavy-cream')!.id);
  dough.amount = '300 ML'; brush.amount = '15 ML';
  const step3 = explicit.steps.find((s) => s.text.includes(`{use:${dough.id}}`))!;
  step3.text = `Stir in {use:${dough.id}} until a soft dough forms.`;

  it('v1 is not applicable to explicit amounts (it carries only "a little"); v2 binds from the dough amount, never the listed total', () => {
    const p = compileSource(explicit, content.vocab, patterns);
    const cov = p.coverage.filter((c) => c.patternId === 'cream_to_butter_milk');
    expect(cov.map((c) => [c.patternVersion, c.status, c.failedCheck?.code ?? null])).toEqual([[1, 'NOT_APPLICABLE', 'CARRY_REQUIRES_AS_WRITTEN'], [2, 'BOUND', null]]);
    const b = p.bindings.find((x) => x.patternId === 'cream_to_butter_milk')!;
    expect(Object.fromEntries(Object.entries(b.quantities).map(([k, q]) => [k, q.value.n / q.value.d]))).toEqual({ butter: 85, milk: 180, milk_extra: 30, milk_brush: 15 });
    expect(b.coveredSiblingUseIds).toEqual([brush.id]);
    const ambiguous = compileSource(base, content.vocab, patterns);   // the original recipe: v1 binds, v2 can't (no stated brushing amount)
    expect(ambiguous.coverage.filter((c) => c.patternId === 'cream_to_butter_milk').map((c) => [c.patternVersion, c.status])).toEqual([[1, 'BOUND'], [2, 'NEEDS_FACTS']]);
  });

  it('one milk question, itemized by purpose (no double counting); the stop condition is kept; started work is protected', () => {
    const p = compileSource(explicit, content.vocab, patterns);
    const cream = p.recipe.ingredients.find((i) => i.kind?.kindId === 'heavy-cream')!.ingredientId;
    const at3 = snapshotAfter(p, doneUpTo(p, 2));
    const e1 = evaluate(p, content.vocab, at3, { missingIngredientId: cream, proposedKindIds: [], answers: [], notices: [] });
    expect(e1.questions.flatMap((q) => (q.kind === 'AVAILABILITY' ? q.requirements.map((r) => r.display) : []))).toEqual([
      '225 ML milk: 180 ML for the dough (step 3) + 15 ML for brushing (step 6) + up to 30 ML extra for the dough, only if needed', '85 g cold butter']);
    // spoken: the total (the conditional extra included, as the requirement's quantity), then what it includes; purposes from techniques
    expect(e1.speech).toBe('Do you have 85 grams of butter and 225 millilitres of milk? That includes milk for brushing and up to 30 millilitres extra, only if the dough needs it.');
    const e2 = evaluate(p, content.vocab, at3, { missingIngredientId: cream, proposedKindIds: [], answers: e1.questions.map((q) => ({ questionId: q.questionId, choiceId: 'ENOUGH' as const })), notices: [] });
    const c = e2.candidates[0];
    expect(c.changes.filter((x) => x.after).map((x) => x.after)).toEqual([
      "Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 180 ML milk until a soft dough forms. Only if needed: up to 30 ML more milk. Add it 1 tablespoon at a time and stop as soon as no dry flour remains. If the dough is still crumbly after that, press it together with your hands; don't add more liquid.",
      'Brush the tops with 15 ML milk.']);
    const started = snapshotAfter(p, [...doneUpTo(p, 2), { stepId: p.recipe.steps[2].stepId, progress: 'started' }]);
    expect(evaluate(p, content.vocab, started, { missingIngredientId: cream, proposedKindIds: [], answers: [], notices: [] }).refusal?.code).toBe('PROTECTED_WORK');
  });
});
