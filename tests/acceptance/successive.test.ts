// Successive substitutions on the product service path (commission 2026-10-11): Service + Authoring over the store (SQLite, or
// DynamoDB Local with npm run test:dynamodb-local), knowledge from a knowledge table. Every plan below comes from
// content/approved; the one SYNTHETIC rule (the cycle) is marked. Software evidence of engine behaviour, not of taste or texture.
import { describe, expect, it } from 'vitest';
import type { Pattern, RecoveryPattern } from '../../src/contract/types.ts';
import { validateStructure } from '../../src/domain/recipe.ts';
import { compile } from '../../src/compile/binder.ts';
import { publishRelease } from '../../src/knowledge/release.ts';
import { loadContent, staticKnowledge, storeKnowledge, type Content } from '../../src/service/content.ts';
import { K } from '../../src/service/commands.ts';
import { wsPk, type Kv } from '../../src/service/kv.ts';
import { APPROVED_DIR, biscuits, kitchen, newKnowledgeKv, r1Files, r2Files } from '../fixtures/successive.ts';
import { RECIPE } from '../fixtures/ids.ts';
import { content, newKv, newWs } from '../helpers.ts';

const r2 = () => staticKnowledge(content);
type K_ = ReturnType<typeof kitchen>;
/** the run's current recipe version, read straight from the store (what a reopen sees) */
const versionRecipe = async (k: K_) => { const run = await k.run(); return (await k.kv.get({ pk: wsPk(k.ws), sk: K.version(run.id, run.version) }))!.recipe as import('../../src/contract/types.ts').Recipe; };

/** Scones (approved example): caster → granulated and baking powder → soda + tartar in the dry mix (step 2), then cream → butter + milk at step 3. */
async function threeChanges(k: K_) {
  await k.start(RECIPE['scones.demo']);
  await k.doneUpTo(1);
  const a1 = await k.change(/caster/i);
  const a2 = await k.change(/baking powder/i);
  await k.progress(1, 'done');
  const a3 = await k.change(/heavy cream/i, ['whole-milk', 'unsalted-butter']);
  return { a1, a2, a3 };
}

describe('three sequential substitutions (case 4) and a shared step (case 6)', () => {
  it('all three accepted changes stay present and consistent; the two in the dry-mix step compose', async () => {
    const k = kitchen(r2());
    const { a3 } = await threeChanges(k);
    const run = await k.run(), recipe = await versionRecipe(k);
    expect(run.version).toBe(4);
    expect(run.appliedAmendments.map((a) => a.title)).toEqual(['Granulated sugar for caster sugar in a dry mix', 'Baking soda and cream of tartar for baking powder', 'Butter and milk for cream in a dough']);
    // step 2 holds changes 1 and 2 (computed on the step as change 1 left it), step 3 and step 6 hold change 3
    expect(run.steps[1].effectiveText).toBe('Whisk the flour, 40 g granulated sugar, ¾ tsp baking soda, salt and 1½ tsp cream of tartar. Have the oven hot before the liquid goes in: once the dough is wet, the baking soda and cream of tartar start working, so shape it and bake it straight away, without resting or chilling it.');
    expect(run.steps[2].effectiveText).toBe('Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 180 ML milk until a soft dough forms. Only if needed: up to 30 ML more milk. Add it 1 tablespoon at a time and stop as soon as no dry flour remains. If the dough is still crumbly after that, press it together with your hands; don\'t add more liquid.');
    expect(run.steps[5].effectiveText).toBe('Brush the tops with a little milk.');
    // change 3 was re-bound (its frozen plan read the dry-mix step, which changes 1–2 altered); the reviewed amounts are OD-3's
    expect(a3.proposal.trace.deterministic).toMatch(/Butter and milk/);
    // the final recipe is structurally valid; every introduced use records the change that brought it
    expect(validateStructure(recipe, content.vocab, recipe.steps.map((s) => s.stepId))).toEqual([]);
    const introduced = recipe.uses.filter((u) => u.origin).map((u) => [recipe.ingredients.find((i) => i.ingredientId === u.ingredientId)!.name, u.origin!.fromVersion, `${u.origin!.patternId}@${u.origin!.patternVersion}`]);
    expect(introduced).toEqual(expect.arrayContaining([['Granulated sugar', 1, 'caster_to_granulated@1'], ['Baking soda', 2, 'powder_from_soda_and_tartar@1'], ['Cream of tartar', 2, 'powder_from_soda_and_tartar@1'],
      ['Butter', 3, 'cream_to_butter_milk@1'], ['Milk', 3, 'cream_to_butter_milk@1']]));
    expect(introduced).toHaveLength(6);   // milk twice: the dough and the brushing
    // dependencies: change 2 shares change 1's step; change 3 builds on neither
    const [x1, x2, x3] = run.appliedAmendments;
    expect([x1.dependsOn, x2.dependsOn, x3.dependsOn]).toEqual([[], [{ amendmentId: x1.id, relation: 'SHARES_STEP' }], []]);
    // applying completed nothing: only step 1 and 2 (reported) are done
    expect(run.steps.map((s) => s.progress)).toEqual(['done', 'done', 'notStarted', 'notStarted', 'notStarted', 'notStarted', 'notStarted']);
    // the cook sees the cumulative recipe: introduced uses say which change brought them
    const milk = (await k.recipe()).ingredients.find((i) => i.name === 'Milk')!;
    expect(milk.uses.map((u) => u.introducedBy?.title)).toEqual(['Butter and milk for cream in a dough', 'Butter and milk for cream in a dough']);
    expect(milk.uses[0].introducedBy?.replaces).toBe('Heavy cream');
  });
});

describe('replacing an ingredient an earlier change introduced (case 5), its role, and pinning (case 3)', () => {
  async function creamThenMilk(knowledge: ReturnType<typeof r2>) {
    const k = kitchen(knowledge);
    const saved = await k.importAndSave(biscuits());
    await k.start(saved.recipeId);
    await k.doneUpTo(2);
    const a1 = await k.change(/heavy cream/i);
    return { k, a1 };
  }

  it('cream → butter + milk, then out of milk: evaporated milk and water replace the milk the first change added, extra included', async () => {
    const { k } = await creamThenMilk(r2());
    expect(await k.text(2)).toMatch(/^Rub 85 g cold butter into the dry mixture .* then stir in 180 ML milk until a soft dough forms\. Only if needed: up to 30 ML more milk\./);
    const { first, second } = await k.propose(/^milk$/i, ['evaporated-milk']);
    // the availability question: each ingredient's total, with the extra counted (half the earlier 30 ML each)
    expect(first.outcome).toBe('needsFacts');
    expect(first.questions![0].items.map((i) => i.text)).toEqual(['90 ML evaporated milk, plus up to 15 ML more only if needed', '90 ML water, plus up to 15 ML more only if needed']);
    expect(second).toMatchObject({ outcome: 'proposal', proposalResponse: { response: 'REALIZED_AS_PROPOSED' } });
    expect(second.interpretation.display).toContainEqual({ label: 'Came in with', value: 'a change you accepted earlier in this session' });
    const applied = await k.apply(second);
    expect(applied.outcome).toBe('applied');
    const run = await k.run(), recipe = await versionRecipe(k);
    // the butter from change 1 stays; the milk (and its extra) became the mix; nothing else moved
    expect(run.steps[2].effectiveText).toBe('Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 90 ML evaporated milk mixed with 90 ML water until a soft dough forms. Only if needed: up to 15 ML more evaporated milk. Mix it with the same amount of water and add the mix 1 tablespoon at a time; stop as soon as no dry flour remains. If the dough is still crumbly after that, press it together with your hands; don\'t add more liquid.');
    const evap = recipe.uses.find((u) => recipe.ingredients.find((i) => i.ingredientId === u.ingredientId)!.name === 'Evaporated milk')!;
    const milkUse = (await versionRecipeAt(k, 2)).uses.find((u) => u.origin?.patternId === 'cream_to_butter_milk' && u.functions.some((f) => f.functionId === 'LIQUID'))!;
    expect(evap.origin).toEqual({ fromVersion: 2, patternId: 'evaporated_milk_for_milk', patternVersion: 2, knowledgeReleaseId: content.releaseId, replacesUseId: milkUse.useId });
    expect(evap.allowance).toMatchObject({ max: { n: 15, d: 1 }, unit: 'ML' });
    expect(recipe.uses.some((u) => u.useId === milkUse.useId)).toBe(false);
    expect(run.appliedAmendments[1].dependsOn).toEqual([{ amendmentId: run.appliedAmendments[0].id, relation: 'REPLACES_INTRODUCED' }, { amendmentId: run.appliedAmendments[0].id, relation: 'SHARES_STEP' }]);
    expect(run.appliedAmendments.map((a) => a.knowledgeReleaseId)).toEqual([content.releaseId, content.releaseId]);
    expect(run.steps[2].progress).toBe('notStarted');
  });

  it('pinned to R1 (B7 v1), the same request is refused as undoing the earlier change, and nothing changes', async () => {
    const kv = await newKnowledgeKv();
    const r1 = (await publishRelease(kv, r1Files(), { activate: true })).releaseId;
    const { k } = await creamThenMilk(storeKnowledge(kv));
    await publishRelease(kv, r2Files(), { activate: true });   // a newer release later: this session stays on R1
    const before = await k.run();
    const e = await k.ask(/^milk$/i, ['evaporated-milk']);
    expect(e).toMatchObject({ outcome: 'refused', refusal: { kind: 'earlierChangeConflict' }, basis: { knowledgeReleaseId: r1 } });
    expect(e.speech.text).toMatch(/undo part of a change you accepted earlier/);
    expect(e.why.facts).toContain('the reviewed swap would drop the "only if needed" extra milk your earlier change added, and it has no rule for that extra');
    expect(await k.run()).toMatchObject({ revision: before.revision, version: before.version });
  });

  it('out of the butter the first change added: the policy is matched to its current role, and none is reviewed (U1)', async () => {
    const { k } = await creamThenMilk(r2());
    const before = await k.run();
    const e = await k.ask(/^butter$/i, ['vegetable-oil']);
    expect(e).toMatchObject({ outcome: 'refused', refusal: { kind: 'noReviewedRecovery' } });
    expect(e.refusal.message).toBe("There's no reviewed change for butter as it is used now (it came in with a change you accepted earlier). That isn't a judgement that nothing else could work.");
    expect(e.proposalResponse.response).toBe('NOT_COVERED');   // oil is not called suitable, and no rule is borrowed from the cream
    expect(await k.run()).toMatchObject({ revision: before.revision, version: before.version });
  });
});

describe('combined demand (case 7) and the progress boundary (case 8)', () => {
  it('the water a later plan adds is totalled with its extra, and the water already in the recipe stays reserved', async () => {
    const k = kitchen(r2());
    await k.start((await k.importAndSave(biscuits({ waterBrush: true }))).recipeId);
    await k.doneUpTo(2);
    await k.change(/heavy cream/i);
    const { first } = await k.propose(/^milk$/i);
    expect(first.questions![0].items.map((i) => i.text)).toEqual(['90 ML evaporated milk, plus up to 15 ML more only if needed', '90 ML more water, plus up to 15 ML more only if needed']);
    expect(first.note).toBe('The 15 ML water already in the recipe stays reserved for step 5.');
  });

  it('a replacement that would rewrite work already reported is blocked; a used-up ingredient has nothing to change', async () => {
    const k = kitchen(r2());
    await k.start((await k.importAndSave(biscuits())).recipeId);
    await k.doneUpTo(2);
    await k.change(/heavy cream/i);
    const butter = (await k.recipe()).ingredients.find((i) => i.name === 'Butter')!.uses[0].id;
    await k.progress(2, 'partly', [butter]);   // the butter is rubbed in
    const before = await k.run();
    const e = await k.ask(/^milk$/i);
    expect(e).toMatchObject({ outcome: 'refused', refusal: { kind: 'protectedWork', stepId: before.steps[2].stepId } });
    expect(await k.ask(/^butter$/i)).toMatchObject({ outcome: 'refused', refusal: { kind: 'nothingToChange', reason: 'allUsesDone' } });
    expect(await k.run()).toMatchObject({ revision: before.revision, version: before.version });
  });
});

describe('stale proposals (case 9), concurrency and retries (case 10)', () => {
  it('accepting one proposal makes a proposal evaluated against the older revision unusable; re-checking gives a fresh one', async () => {
    const k = kitchen(r2());
    await k.start(RECIPE['scones.demo']);
    await k.doneUpTo(1);
    const sugar = (await k.propose(/caster/i)).second, powder = (await k.propose(/baking powder/i)).second;
    expect(sugar.basis.revision).toBe(powder.basis.revision);
    expect(await k.svc.applyAmendment(await k.applyArgs(sugar))).toMatchObject({ outcome: 'rejected', code: 'NOT_LATEST_EVALUATION' });   // superseded by the newer check
    expect((await k.apply(powder)).outcome).toBe('applied');
    expect(await k.svc.wireEvaluation(sugar.id)).toMatchObject({ actionable: false });
    const stale = await k.applyArgs(sugar);
    expect(await k.svc.applyAmendment({ ...stale, expectedRevision: sugar.basis.revision })).toMatchObject({ outcome: 'rejected', code: 'STALE_STATE' });
    const again = (await k.propose(/caster/i)).second;
    expect(again.basis).toMatchObject({ revision: sugar.basis.revision + 1, version: 2 });
    expect((await k.apply(again)).outcome).toBe('applied');
    expect(await k.text(1)).toMatch(/40 g granulated sugar, ¾ tsp baking soda, salt and 1½ tsp cream of tartar/);
  });

  it('simultaneous accepts of the change to an introduced ingredient: one amendment, one version, retries return the original receipt', async () => {
    const k = kitchen(r2());
    await k.start((await k.importAndSave(biscuits())).recipeId);
    await k.doneUpTo(2);
    await k.change(/heavy cream/i);
    const { second } = await k.propose(/^milk$/i);
    const [x, y] = await Promise.all([k.applyArgs(second, 'cmd-race-a'), k.applyArgs(second, 'cmd-race-b')]);
    const out = await Promise.all([k.svc.applyAmendment(x), k.svc.applyAmendment(y), k.svc.applyAmendment(x)]);
    const applied = out.filter((o) => ['applied', 'alreadyApplied'].includes(o.outcome as string));
    expect(out.filter((o) => o.outcome === 'applied')).toHaveLength(1);
    const run = await k.run();
    expect(run).toMatchObject({ version: 3 });
    expect(run.appliedAmendments).toHaveLength(2);
    // the retry of the winning command returns its original receipt; the loser applied nothing
    const winner = out.find((o) => o.outcome === 'applied') as { amendment: { id: string; commandId: string } };
    const retry = await k.svc.applyAmendment(winner.amendment.commandId === x.commandId ? x : y);
    expect(retry).toMatchObject({ outcome: 'alreadyApplied', amendment: { id: winner.amendment.id }, replayed: true });
    expect(applied.length).toBeGreaterThanOrEqual(1);
    // no partial change: exactly versions 1–3 and amendments 2–3 exist
    const items = await k.kv.query(wsPk(k.ws), { prefix: `RUN#${run.id}#` });
    expect(items.filter((i) => i.sk.includes('#V#')).map((i) => i.sk.slice(-1))).toEqual(['1', '2', '3']);
    expect(items.filter((i) => i.sk.includes('#A#')).map((i) => i.sk.slice(-1))).toEqual(['2', '3']);
  });
});

describe('unsupported chains and cycles (case 11), reopen (case 12)', () => {
  it('a chain no reviewed rule supports is refused with what is missing, and the last valid recipe stays', async () => {
    const k = kitchen(r2());
    await threeChanges(k);
    const before = await k.run();
    // the milk change 3 added also brushes the tops (step 6); the evaporated-milk rule can't cover brushing
    const milk = await k.ask(/^milk$/i, ['evaporated-milk']);
    expect(milk).toMatchObject({ outcome: 'refused' });
    expect(milk.why.facts.join(' | ')).toMatch(/milk is also used in step 6.*can't cover that use/);
    // and the butter it added has no reviewed replacement (U1): said, not guessed. (The chain bound, 4 changes per session, is cards.test's.)
    expect(await k.ask(/^butter$/i)).toMatchObject({ outcome: 'refused', refusal: { kind: 'noReviewedRecovery' } });
    expect(await k.run()).toMatchObject({ revision: before.revision, version: before.version, appliedAmendments: before.appliedAmendments });
  });

  it('a plan that would bring back an ingredient the cook is out of is refused as a cycle (SYNTHETIC reverse rule)', async () => {
    const reverse = structuredClone(loadContent(APPROVED_DIR).patterns.find((p) => p.patternId === 'caster_to_granulated')!) as RecoveryPattern;
    Object.assign(reverse, { patternId: 'syn_granulated_to_caster', title: 'SYNTHETIC: caster sugar for granulated', target: { ...reverse.target, ingredientClass: 'sugar' },
      introduces: [{ local: 'gran', kindId: 'caster-sugar', name: 'Caster sugar' }], proposal: null, evidence: { quantityStatus: 'NONE', basis: 'SYNTHETIC test rule, not content' } });
    const syn: Content = { ...content, releaseId: 'kr-synthetic-cycle', patterns: [...content.patterns, reverse as Pattern] };
    syn.packs = loadContentWith(syn);
    const k = kitchen(staticKnowledge(syn));
    await k.start(RECIPE['scones.demo']);
    await k.doneUpTo(1);
    await k.change(/caster/i);                            // out of caster sugar → granulated
    const before = await k.run();
    const back = await k.ask(/granulated/i);              // out of granulated → the reverse rule would bring caster back
    expect(back).toMatchObject({ outcome: 'refused', refusal: { kind: 'earlierChangeConflict' } });
    expect(back.speech.text).toBe("No. That change would need caster sugar, which you said you're out of, so it can't be used. Your recipe is unchanged. Step 2 still needs 40 g granulated sugar.");
    expect(back.trace.deterministic).toMatch(/REINTRODUCES_UNAVAILABLE/);
    expect(await k.run()).toMatchObject({ revision: before.revision, version: before.version });
  });

  it('a new process sees the same amended recipe, the same pinned release and the same history', async () => {
    const kv: Kv = newKv(), knowledgeKv = await newKnowledgeKv(), ws = newWs();
    await publishRelease(knowledgeKv, r2Files(), { activate: true });
    const k = kitchen(storeKnowledge(knowledgeKv), { kv, ws });
    await threeChanges(k);
    const seen = await k.svc.getActiveRecipe();
    const reopened = kitchen(storeKnowledge(knowledgeKv), { kv, ws });   // fresh caches, as a new Lambda instance
    const again = await reopened.svc.getActiveRecipe();
    expect(again.run).toEqual(seen.run);
    expect(again.recipe).toEqual(seen.recipe);
    expect(again.run!.knowledge).toEqual({ releaseId: content.releaseId, basis: 'PINNED' });
    expect((await reopened.propose(/^milk$/i, ['evaporated-milk'])).second.outcome).toBe('refused');   // and it decides the same way
  });
});

// ---------- helpers ----------
async function versionRecipeAt(k: K_, version: number) {
  const run = await k.run();
  return (await k.kv.get({ pk: wsPk(k.ws), sk: K.version(run.id, version) }))!.recipe as import('../../src/contract/types.ts').Recipe;
}
function loadContentWith(c: Content) {
  return new Map([...c.packs].map(([id, p]) => [id, compile(p.recipe, c.vocab, c.patterns, { releaseId: c.releaseId }).pack!]));
}
