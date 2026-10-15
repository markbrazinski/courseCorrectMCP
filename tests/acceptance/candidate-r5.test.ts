// Revised candidate (packet 2026-10-13b, PROPOSED, not approved): R1 + the supported subset. Readings and swap cards are
// hand-written TEST FIXTURES shaped like corpus recipes; software evidence of engine behaviour only, never culinary validation.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { kindByName } from '../../src/domain/vocabulary.ts';
import { knowledgeErrors, mergePacket, pendingIn, publishRelease, releaseIdOfFiles, type KnowledgeFiles } from '../../src/knowledge/release.ts';
import { contentOf, staticKnowledge, storeKnowledge } from '../../src/service/content.ts';
import { kitchen, newKnowledgeKv, r1Files } from '../fixtures/successive.ts';
import { GRIDDLE_FACTS, griddle, importConfirmed } from '../fixtures/packet-recipes.ts';
import { newKv, newWs, ROOT } from '../helpers.ts';
import { RECIPE } from '../fixtures/ids.ts';

const PACKET = join(ROOT, 'content/proposed/knowledge-packet-2026-10-13b');
const R5 = () => mergePacket(r1Files(), PACKET);
const know = (f: KnowledgeFiles) => staticKnowledge(contentOf(f, releaseIdOfFiles(f)));
const F_ID = 'oat_flour_for_all_flour_in_steam_raised_batter_not_offered';

describe('candidate R5 = R1 + packet 2026-10-13b', () => {
  it('validates, is pending throughout, and holds only the supported subset (E1, slurry, roux, emulsify, cream × simmer, OD-8 stay out)', () => {
    const f = R5();
    expect(knowledgeErrors(f)).toEqual([]);
    expect(releaseIdOfFiles(f)).toBe('kr-2a017fb8c679aa5a');
    expect(pendingIn(f)).toEqual(['vocabulary v4', 'roles', 'acidified_milk_for_sour_milk@1', 'btb_chicken_base_for_chicken_stock@1', `${F_ID}@1`, 'plain_milk_not_for_sour_milk_with_soda@1', 'limit citrus_juice_as_liquid@1']);
    expect(f.vocabulary.techniques.map((t) => t.techniqueId)).not.toEqual(expect.arrayContaining(['THICKEN_SLURRY']));
    expect(f.vocabulary.techniques.map((t) => t.techniqueId).filter((t) => ['THICKEN_SLURRY', 'MAKE_ROUX', 'EMULSIFY'].includes(t))).toEqual([]);
    expect(f.vocabulary.functions.map((x) => x.functionId).filter((x) => ['THICKENING', 'EMULSIFYING'].includes(x))).toEqual([]);
    expect(f.roles.roles.filter((r) => r.techniqueId === 'SIMMER' || ['sour-milk', 'buttermilk'].includes(r.kindId)).map((r) => `${r.kindId} × ${r.techniqueId}`))
      .toEqual(['chicken-stock × SIMMER', 'chicken-broth × SIMMER', 'sour-milk × MIX_DOUGH', 'buttermilk × MIX_DOUGH']);
    expect(f.patterns.map((p) => `${p.patternId}@${p.version}`)).toContain('evaporated_milk_for_milk@1');
    expect(f.patterns.map((p) => p.patternId)).not.toContain('cornstarch_for_flour_slurry');
    expect(f.patterns.filter((p) => p.patternId === 'evaporated_milk_for_milk').map((p) => p.version)).toEqual([1]);
  });
  it('A2: "butter" no longer names unsalted butter (R1 said it did); "unsalted butter" still does; R1 itself is unchanged', () => {
    expect(kindByName(r1Files().vocabulary, 'butter')?.kindId).toBe('unsalted-butter');
    const v = R5().vocabulary;
    expect([kindByName(v, 'butter'), kindByName(v, 'cold butter'), kindByName(v, 'unsalted butter')?.kindId]).toEqual([undefined, undefined, 'unsalted-butter']);
    expect(releaseIdOfFiles(r1Files())).toBe('kr-9c316aaa001832c0');
  });
});

// ---------- AI cards against the candidate: oat flour (F) and lemon juice as the liquid (L1) ----------
const ing = (key: string, line: string, name: string, amountText: string, kind: string | null = null) => ({ key, line, name, amountText, kind });
type Src = { lines: string[]; reading: { ingredients: { key: string }[]; steps: ({ text: string } & Record<string, unknown>)[] } & Record<string, unknown> };
function batter(o: { eggs: boolean; leavener: boolean; bake: boolean; title: string; liquid?: string }): Src {
  const liquid = o.liquid ?? 'milk';
  const ingredients = [ing('f', '1 cup flour', 'flour', '1 cup', 'plain-flour'), ing('t', '¼ teaspoon salt', 'salt', '¼ teaspoon'), ing('m', `7/8 cup ${liquid}`, liquid, '7/8 cup'),
    ...(o.eggs ? [ing('e', '2 eggs', 'eggs', '2')] : []), ...(o.leavener ? [ing('b', '2 teaspoons baking powder', 'baking powder', '2 teaspoons')] : [])];
  const mix = `Mix ${o.leavener ? 'baking powder, ' : ''}salt and flour; add ${liquid} gradually, in order to obtain a smooth batter.${o.eggs ? ' Add eggs, beaten until light.' : ''}`;
  const cook = o.bake ? 'Bake thirty minutes in a hot oven.' : 'Drop by spoonfuls on a hot greased griddle; turn once.';
  const use = (k: string, quote: string, functions: string[]) => ({ ingredientKey: k, stepKey: 's1', quote, amountText: null, functions });
  return { lines: [o.title, ...ingredients.map((i) => i.line), mix, cook], reading: { recipeFound: true, title: o.title, yield: null, ingredients,
    steps: [{ key: 's1', text: mix, title: 'Mix', technique: 'COMBINE_DRY' }, { key: 's2', text: cook, title: o.bake ? 'Bake' : 'Griddle', technique: null }],
    uses: [use('f', 'flour', ['STRUCTURE']), use('t', 'salt', ['FLAVOR']), use('m', liquid, ['LIQUID']), ...(o.eggs ? [use('e', 'eggs', ['STRUCTURE'])] : []), ...(o.leavener ? [use('b', 'baking powder', ['LEAVENING'])] : [])] } };
}
const POPOVERS = batter({ eggs: true, leavener: false, bake: true, title: 'Popovers' });
const swapCard = (useRef: string, role: string, functions: string[], swap: object, text: string) => ({ cards: [{ useRef, role, functions, verdict: 'swap', swap: { otherIngredients: [], ...swap }, stepRewrites: [{ stepRef: 'S1', text }], siblings: [], tradeoff: 'It will be different.', opinion: 'Use it and expect a different result.' }] });
const oatCard = (s: Src) => swapCard('U1', 'the batter\'s structure', ['STRUCTURE'], { ingredient: 'oat flour', kindId: 'oat-flour', amountText: '1 cup' }, s.reading.steps[0].text.replace('flour', 'oat flour'));
async function analysis(f: KnowledgeFiles, src: Src, cards: unknown, ingredientIndex: number) {
  const a = new Authoring({ kv: newKv(), ws: newWs(), knowledge: know(f), extractor: { name: 'S', extract: async () => ({ ok: true, raw: src.reading, extractor: 'S', usage: null, costUsd: 0 }) },
    analyzer: { name: 'S', analyze: async () => ({ ok: true, raw: cards, analyzer: 'S', usage: null, costUsd: 0 }) } });
  const r = await a.createImport({ kind: 'text', text: src.lines.join('\n') });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  await a.waitForJob(r.job.id);
  return (await a.getDraft(r.draftId)).draft.content!.ingredients[ingredientIndex].uses[0].analysis!;
}
const withoutF = () => { const f = R5(); return { ...f, patterns: f.patterns.filter((p) => p.patternId !== F_ID) }; };

describe('F: oat flour for all the flour in a batter that rises by steam (shipped with the identities)', () => {
  it('popovers: R1 refused the oat-flour card only because "eggs" had no identity; the identities alone would let it through; R5 refuses it with its own reason', async () => {
    const r1 = await analysis(r1Files(), POPOVERS, oatCard(POPOVERS), 0);
    expect(r1.status).not.toBe('available');                                  // R1: leavener presence unknown → the refusal waits → the card is held
    const gap = await analysis(withoutF(), POPOVERS, oatCard(POPOVERS), 0);
    expect(gap.status).toBe('available');                                     // the gap: eggs identified, no leavener → R1's refusal doesn't apply
    const r5 = await analysis(R5(), POPOVERS, oatCard(POPOVERS), 0);
    expect(r5.status).not.toBe('available');
    expect(JSON.stringify(r5)).toContain('it rises by steam in the oven, and the flour is its structure');
  });
  it('allowed: a batter with no egg and no leavener, cooked on a griddle, keeps the AI card (labelled unsupported); a leavened batter is refused by R1\'s own rule, not F', async () => {
    const plain = batter({ eggs: false, leavener: false, bake: false, title: 'Flat Cakes' });
    const ok = await analysis(R5(), plain, oatCard(plain), 0);
    expect(ok.status).toBe('available');
    expect(ok.plans[0].provenance.basis).toContain('Culinary support: none on file. Whether this replacement can do the job here is the AI\'s claim; no source or reviewed rule backs it.');
    const eggsNoBake = batter({ eggs: true, leavener: false, bake: false, title: 'Egg Griddle Cakes' });
    expect((await analysis(R5(), eggsNoBake, oatCard(eggsNoBake), 0)).status).toBe('available');   // eggs, but not baked: F's scope is the oven rise
    const leavened = batter({ eggs: true, leavener: true, bake: true, title: 'Muffins' });
    const r = JSON.stringify(await analysis(R5(), leavened, oatCard(leavened), 0));
    expect(r).toContain('in place of all the flour in this dough');
    expect(r).not.toContain('rises by steam');
  });
});

describe('L1: citrus juice in place of a recipe\'s liquid (the popovers card, 2026-10-13)', () => {
  const lemon = swapCard('U3', 'the batter\'s liquid', ['LIQUID', 'ACIDITY'], { ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '7/8 cup' }, 'Mix salt and flour; add 7/8 cup lemon juice gradually, in order to obtain a smooth batter. Add eggs, beaten until light.');
  it('R1 offers 7/8 cup lemon juice for 7/8 cup milk (labelled unsupported); R5 never offers it and says why, beside the reviewed change still waiting on the cook', async () => {
    expect((await analysis(r1Files(), POPOVERS, lemon, 2)).status).toBe('available');
    const r5 = await analysis(R5(), POPOVERS, lemon, 2);
    expect(r5).toMatchObject({ status: 'blocked', plans: [] });   // the "batter" cue reaches R1's reviewed evaporated-milk change: one cook question
    expect(r5.reason!.text).toContain('The alternative drafted at import (lemon juice for the milk) isn’t offered: The sources use lemon juice to sour or brighten a liquid at no more than 1 tablespoon per cup of it, never as the liquid itself.');
  });
  const WATER = batter({ eggs: true, leavener: false, bake: true, title: 'Water Popovers', liquid: 'water' });
  const forWater = (swap: object, text: string) => swapCard('U3', 'the batter\'s liquid', ['LIQUID'], swap, text);
  it('nothing reviewed for the liquid: the limitation is the answer', async () => {
    const r5 = await analysis(R5(), WATER, forWater({ ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '7/8 cup' }, 'Mix salt and flour; add 7/8 cup lemon juice gradually, in order to obtain a smooth batter. Add eggs, beaten until light.'), 2);
    expect(r5).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'unsupportedByEvidence' }, plans: [] });
  });
  it('milk soured with a tablespoon of lemon juice per cup stays usable; the ceiling is strict (1 tbsp in 7/8 cup is over it)', async () => {
    const cup = batter({ eggs: true, leavener: false, bake: true, title: 'Water Popovers', liquid: 'water' });
    cup.lines[3] = '1 cup water'; Object.assign(cup.reading.ingredients[2], { line: '1 cup water', amountText: '1 cup' });
    const soured = (amount: string) => forWater({ ingredient: 'milk', kindId: 'whole-milk', amountText: amount, otherIngredients: [{ ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '1 tbsp' }] },
      `Mix salt and flour; add ${amount} milk with 1 tbsp lemon juice gradually, in order to obtain a smooth batter. Add eggs, beaten until light.`);
    expect((await analysis(R5(), cup, soured('1 cup'), 2)).status).toBe('available');
    expect((await analysis(R5(), WATER, soured('7/8 cup'), 2)).status).toBe('evaluatedNoOption');   // 15/207 > 1/16: an owner decision (tolerance)
  });
});

describe('E4 (revised): one base, never two', () => {
  const sauce = (extra: boolean) => {
    const ingredients = [ing('c', '1 cup chicken stock', 'chicken stock', '1 cup'), ing('r', '1 cup heavy cream', 'heavy cream', '1 cup'), ...(extra ? [ing('b', '1 tsp chicken Better than Bouillon', 'chicken Better than Bouillon', '1 tsp')] : [])];
    const text = `Stir in the cream${extra ? ', the bouillon' : ''} and the chicken stock and simmer for 15 minutes.`;
    const uses = [{ ingredientKey: 'r', stepKey: 's1', quote: 'the cream', amountText: null, functions: ['LIQUID', 'FAT'] }, { ingredientKey: 'c', stepKey: 's1', quote: 'the chicken stock', amountText: null, functions: ['LIQUID', 'FLAVOR'] },
      ...(extra ? [{ ingredientKey: 'b', stepKey: 's1', quote: 'the bouillon', amountText: null, functions: ['FLAVOR'] }] : [])];
    return { lines: ['Sauce', ...ingredients.map((i) => i.line), text], reading: { recipeFound: true, title: 'Sauce', yield: null, ingredients, steps: [{ key: 's1', text, title: 'Simmer', technique: 'SIMMER' }], uses } };
  };
  it('no base in the recipe: water with 1 tsp Better Than Bouillon chicken base per cup, the product named, its ratio tied to it', async () => {
    const k = kitchen(know(R5()));
    await k.start((await k.importAndSave(sauce(false))).recipeId);
    const { second } = await k.propose(/chicken stock/i, ['better-than-bouillon-chicken-base']);
    expect(second.outcome).toBe('proposal');
    expect(JSON.stringify(second)).toContain('The ratio is for this base only; cubes and other bases differ');
    await k.apply(second);
    expect(await k.text(0)).toMatch(/^Stir in the cream and 1 cup water with 1 tsp Better Than Bouillon chicken base and simmer for 15 minutes\. Dissolve the base/);
  });
  it('the recipe already uses the base (corpus Tarragon): not offered, and the reason says why; no step naming the base twice', async () => {
    const k = kitchen(know(R5()));
    await k.start((await k.importAndSave(sauce(true))).recipeId);
    const e = await k.ask(/chicken stock/i, ['better-than-bouillon-chicken-base']);
    expect(e.outcome).not.toBe('proposal');
    expect(JSON.stringify(e)).toContain('already uses a bouillon or stock base');
  });
});


describe('E2 and E3 together (griddle-cakes, corpus d10)', () => {
  it('one cook question, then milk soured with 1 tbsp lemon juice per cup; plain milk is refused once "soda" is baking soda, with E2 offered', async () => {
    const k = kitchen(know(R5()));
    const saved = await k.importAndSave(griddle());
    const d = (await k.auth.getDraft(saved.draftId)).draft;
    expect(d.questions.map((q) => q.prompt)).toEqual(['Does step 1 mix dough?']);
    const { draft } = await k.auth.confirm(saved.draftId, { expectedRevision: d.revision, answers: [{ questionId: d.questions[0].id, answer: 'yes' }] });
    await k.start((await k.auth.save(saved.draftId, { expectedRevision: draft.revision })).recipeId);
    await k.change(/sour milk/i);
    expect(await k.text(0)).toBe('Mix and sift flour, salt, and soda; add 2 cups milk soured with 2 tbsp lemon juice, and egg well beaten. Stir the lemon juice into the milk first and let it stand for about five minutes, until it thickens slightly, before you add it.');
    const k2 = kitchen(know(R5()));
    await k2.start((await importConfirmed(k2, griddle(), GRIDDLE_FACTS)).recipeId);
    expect((await k2.ask(/sour milk/i, ['whole-milk'])).proposalResponse).toMatchObject({ response: 'REFUSED', alternativeOffered: true });
  });
});

describe('an identity read without the printed qualifier is not that identity (corpus d05: "Yolks 2 eggs" read as "eggs")', () => {
  it('the line names a narrower kind: left unconfirmed; the plain line keeps its identity', async () => {
    const { buildDraft } = await import('../../src/authoring/extract.ts');
    const { readPastedText } = await import('../../src/authoring/source.ts');
    const { resolveIdentity } = await import('../../src/authoring/drafts.ts');
    const f = R5(), lines = ['Sauce', 'Yolks 2 eggs', '2 eggs', '2 cups sour milk', '1 cup milk', '1 teaspoon kosher salt', 'Stir everything.'];
    const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!src.ok) throw new Error('src');
    const b = buildDraft({ recipeFound: true, title: 'Sauce', yield: null, ingredients: [ing('y', lines[1], 'eggs', '2'), ing('e', lines[2], 'eggs', '2'), ing('s', lines[3], 'milk', '2 cups'), ing('m', lines[4], 'milk', '1 cup'), ing('k', lines[5], 'salt', '1 teaspoon')],
      steps: [{ key: 's1', text: lines[6], title: 'Stir', technique: null }], uses: [] }, f.vocabulary, [{ sourceId: 's', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T');
    if (!b.ok) throw new Error(b.code);
    resolveIdentity(b.body.recipe, f.vocabulary, f.roles);
    expect(b.body.recipe.ingredients.map((i) => [i.sourceLine, i.kind?.prov.status === 'REVIEWED' ? i.kind.kindId : null])).toEqual([
      ['Yolks 2 eggs', null], ['2 eggs', 'egg'], ['2 cups sour milk', null], ['1 cup milk', 'whole-milk'], ['1 teaspoon kosher salt', null]]);
  });
});

describe('an opinion naming the recipe\'s own ingredient in other words is not an invented ingredient', () => {
  it('"egg yolks" in an opinion, for a recipe printing "Yolks 2 eggs" (corpus d05)', async () => {
    const src = batter({ eggs: true, leavener: false, bake: true, title: 'Yolk Popovers', liquid: 'water' });
    src.lines[4] = 'Yolks 2 eggs'; Object.assign(src.reading.ingredients[3], { line: 'Yolks 2 eggs' });
    const card = swapCard('U3', 'the batter\'s liquid', ['LIQUID'], { ingredient: 'milk', kindId: 'whole-milk', amountText: '7/8 cup' }, 'Mix salt and flour; add 7/8 cup milk gradually, in order to obtain a smooth batter. Add eggs, beaten until light.');
    (card.cards[0] as { opinion: string }).opinion = 'Milk with the egg yolks makes a richer batter.';
    expect((await analysis(R5(), src, card, 2)).status).toBe('available');
  });
});

describe('L1 sees the card\'s own claim: a liquid the reading gave only acidity (corpus d10, 2 cups lemon juice for 2 cups sour milk)', () => {
  it('the card calling the sour milk "liquid and acidity" is held to the limit; KNOWN GAP: when neither the reading nor the card calls it a liquid (and its step is unconfirmed), the limit cannot see it', async () => {
    const src = batter({ eggs: true, leavener: false, bake: false, title: 'Sour Cakes', liquid: 'sour milk' });
    (src.reading.uses as { ingredientKey: string; functions: string[] }[]).find((u) => u.ingredientKey === 'm')!.functions = ['ACIDITY'];
    const text = 'Mix salt and flour; add 7/8 cup lemon juice gradually, in order to obtain a smooth batter. Add eggs, beaten until light.';
    const lemon = (functions: string[]) => swapCard('U3', 'the batter\'s liquid', functions, { ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '7/8 cup' }, text);
    expect((await analysis(R5(), src, lemon(['LIQUID', 'ACIDITY']), 2)).status).not.toBe('available');
    expect((await analysis(R5(), src, lemon(['ACIDITY']), 2)).status).toBe('available');
  });
});

describe('pinning across the switch to R5 (simulated: activated in a test store only, never published)', () => {
  it('saved under R1 → keeps R1 whether started before or after the switch; imported after it → R5', async () => {
    const kv = await newKnowledgeKv(), store = storeKnowledge(kv);
    const r1 = (await publishRelease(kv, r1Files(), { activate: true })).releaseId;
    const started = kitchen(store), saved = kitchen(store);
    await started.start((await importConfirmed(started, griddle(), GRIDDLE_FACTS)).recipeId);
    const laterId = (await importConfirmed(saved, griddle(), GRIDDLE_FACTS)).recipeId;
    const r5 = (await publishRelease(kv, R5(), { activate: true })).releaseId;
    expect(r5).toBe(releaseIdOfFiles(R5()));
    const before = await started.ask(/sour milk/i, ['whole-milk']);
    expect(before.basis.knowledgeReleaseId).toBe(r1);
    expect(before.proposalResponse?.response).not.toBe('REFUSED');            // E3 isn't in R1
    await saved.start(laterId);
    expect((await saved.ask(/sour milk/i, ['whole-milk'])).basis.knowledgeReleaseId).toBe(r1);
    const fresh = kitchen(store);
    await fresh.start((await importConfirmed(fresh, griddle(), GRIDDLE_FACTS)).recipeId);
    const after = await fresh.ask(/sour milk/i, ['whole-milk']);
    expect(after.basis.knowledgeReleaseId).toBe(r5);
    expect(after.proposalResponse).toMatchObject({ response: 'REFUSED', alternativeOffered: true });
  });
});

describe('the approved examples decide the same way under R5 as under R1', () => {
  it('scones: three successive changes, the same steps and amounts', async () => {
    const run = async (k: ReturnType<typeof kitchen>) => {
      await k.start(RECIPE['scones.demo']); await k.doneUpTo(1);
      await k.change(/caster/i); await k.change(/baking powder/i); await k.progress(1, 'done');
      await k.change(/heavy cream/i, ['whole-milk', 'unsalted-butter']);
      const r = await k.run();
      return { titles: r.appliedAmendments.map((a) => a.title), steps: r.steps.map((s) => s.effectiveText) };
    };
    expect(await run(kitchen(know(R5())))).toEqual(await run(kitchen(know(r1Files()))));
  });
});
