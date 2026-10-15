// Knowledge packet 2026-10-13 (PROPOSED, not approved): what it would do on the product service path, as an overlay over the
// approved content. Readings are hand-written TEST FIXTURES shaped like corpus recipes (Fannie Farmer's griddle-cakes and
// tomato soup; a simmered stock); software evidence of engine behaviour only, never culinary validation. The packet is not
// published anywhere: candidate releases are built with `cc knowledge candidate`, and publishing needs the owner's decision.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knowledgeErrors, mergePacket, pendingIn, readKnowledgeDir, releaseIdOfFiles } from '../../src/knowledge/release.ts';
import { loadContent, staticKnowledge } from '../../src/service/content.ts';
import { APPROVED_DIR, kitchen } from '../fixtures/successive.ts';
import { GRIDDLE_FACTS, griddle, importConfirmed, type Fact } from '../fixtures/packet-recipes.ts';
import { ROOT } from '../helpers.ts';

const PACKET = join(ROOT, 'content/proposed/knowledge-packet-2026-10-13');
const withPacket = () => staticKnowledge(loadContent(APPROVED_DIR, [PACKET]));
describe('knowledge packet 2026-10-13 (proposed): candidate release', () => {
  it('merges onto R1 as additions only, validates, and is marked pending throughout', () => {
    const f = mergePacket(readKnowledgeDir(APPROVED_DIR), PACKET);
    expect(knowledgeErrors(f)).toEqual([]);
    expect(pendingIn(f)).toEqual(['vocabulary v4', 'roles', 'evaporated_milk_for_milk@2', 'acidified_milk_for_sour_milk@1', 'btb_chicken_base_for_chicken_stock@1', 'cornstarch_for_flour_slurry@1', 'plain_milk_not_for_sour_milk_with_soda@1']);   // R2's OD-8 is pending too
    expect(f.history.map((h) => h.version)).toContain(3);                     // v3 stays readable for analyses made under it
    expect(releaseIdOfFiles(f)).not.toBe(releaseIdOfFiles(readKnowledgeDir(APPROVED_DIR)));
    expect(() => mergePacket(f, PACKET)).toThrow(/already in the base/);      // never an override
  });
  it('identity: no alias collapses two kinds; ambiguous names stay unresolved', () => {
    const v = loadContent(APPROVED_DIR, [PACKET]).vocab, k = (n: string) => v.kinds.find((x) => [x.label, ...x.aliases].map((s) => s.toLowerCase()).includes(n))?.kindId ?? null;
    expect(['kosher salt', 'table salt', 'salt', 'chicken broth', 'chicken stock', 'olive oil', 'extra-virgin olive oil', 'sour milk', 'buttermilk'].map(k))
      .toEqual(['kosher-salt', 'table-salt', 'salt', 'chicken-broth', 'chicken-stock', 'olive-oil', 'extra-virgin-olive-oil', 'sour-milk', 'buttermilk']);
    expect(['ginger', 'pepper', 'tomatoes', 'cornflour', 'soda', 'cumin seeds'].map(k)).toEqual(Array(6).fill(null));   // counterexamples in the README
  });
});

describe('sour milk (E2, E3) and a successive change on the milk E2 introduced', () => {
  it('out of sour milk: milk soured with lemon juice; then out of milk: evaporated milk replaces the milk the first change added', async () => {
    const k = kitchen(withPacket());
    const saved = await importConfirmed(k, griddle(), GRIDDLE_FACTS);
    await k.start(saved.recipeId);
    await k.change(/sour milk/i);
    expect((await k.run()).appliedAmendments.map((a) => a.title)).toEqual(['Milk soured with lemon juice for sour milk or buttermilk']);
    expect(await k.text(0)).toBe('Mix and sift flour, salt, and soda; add 2 cups milk soured with 2 tbsp lemon juice, and egg well beaten. Stir the lemon juice into the milk first and let it stand for about five minutes, until it thickens slightly, before you add it.');
    const { second } = await k.propose(/^milk$/i, ['evaporated-milk']);
    expect(second).toMatchObject({ outcome: 'proposal' });
    const a2 = await k.apply(second);
    expect(a2.outcome).toBe('applied');
    expect(await k.text(0)).toMatch(/^Mix and sift flour, salt, and soda; add .*evaporated milk.* lemon juice, and egg well beaten\./);
    const run = await k.run();
    expect(run.appliedAmendments.map((a) => a.title)).toEqual(['Milk soured with lemon juice for sour milk or buttermilk', expect.stringMatching(/evaporated milk/i)]);
  });

  it('the cook confirms what step 1 does (one question, no owner fact): E2, then the milk it introduced → evaporated milk', async () => {
    const k = kitchen(withPacket());
    const saved = await k.importAndSave(griddle());
    const d = (await k.auth.getDraft(saved.draftId)).draft;
    expect(d.questions.map((q) => q.prompt)).toEqual(['Does step 1 mix dough?']);   // the reading proposed MIX_DOUGH for the step: asked as a step
    const { draft } = await k.auth.confirm(saved.draftId, { expectedRevision: d.revision, answers: [{ questionId: d.questions[0].id, answer: 'yes' }] });
    await k.start((await k.auth.save(saved.draftId, { expectedRevision: draft.revision })).recipeId);
    await k.change(/sour milk/i);
    await k.change(/^milk$/i);   // the introduced milk carries the cook's answer for the use it replaced
    expect(await k.text(0)).toMatch(/^Mix and sift flour, salt, and soda; add .*evaporated milk mixed with .*water soured with 2 tbsp lemon juice, and egg well beaten\./);
    expect((await k.run()).appliedAmendments[1].dependsOn).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'REPLACES_INTRODUCED' })]));
  });

  it('plain milk alone is refused where the soda depends on the sour milk, and soured milk is offered; before the soda is confirmed, it is not refused', async () => {
    const k = kitchen(withPacket());
    await k.start((await importConfirmed(k, griddle(), GRIDDLE_FACTS)).recipeId);
    const no = await k.ask(/sour milk/i, ['whole-milk']);
    // refused as proposed, with the reason, and the sourced alternative offered instead (its availability question first)
    expect(no.proposalResponse).toMatchObject({ response: 'REFUSED', alternativeOffered: true, text: expect.stringContaining('the baking soda works by reacting with its acid') });
    expect(no.speech.text).toBe('To check this, I need to know: do you have 2 cups milk and 2 tbsp lemon juice?');
    const k2 = kitchen(withPacket());
    await k2.start((await importConfirmed(k2, griddle(), GRIDDLE_FACTS.slice(0, 1))).recipeId);   // "soda" left unconfirmed
    expect((await k2.ask(/sour milk/i, ['whole-milk'])).proposalResponse.response).not.toBe('REFUSED');
  });
});

describe('cornstarch for a flour slurry (E1): its exclusions apply to the corpus soup', () => {
  const soup = (method: string) => {
    const ingredients = [{ key: 'm', line: '1 quart milk', name: 'milk', amountText: '1 quart', kind: null }, { key: 'f', line: '4 tablespoons flour', name: 'flour', amountText: '4 tablespoons', kind: null }];
    const steps = [{ key: 's1', text: method, title: 'Thicken', technique: 'THICKEN_SLURRY' }];
    const uses = [{ ingredientKey: 'm', stepKey: 's1', quote: 'milk', amountText: null, functions: ['LIQUID'] }, { ingredientKey: 'f', stepKey: 's1', quote: 'flour', amountText: null, functions: ['THICKENING'] }];
    return { lines: ['Soup', ...ingredients.map((i) => i.line), method], reading: { recipeFound: true, title: 'Soup', yield: null, ingredients, steps, uses } };
  };
  const facts: Fact[] = [{ name: /^flour$/, kind: 'INGREDIENT', predicate: 'KIND', value: 'plain-flour' }];
  it('a brief boil after thickening: half as much cornstarch, with the slurry instruction', async () => {
    const k = kitchen(withPacket());
    await k.start((await importConfirmed(k, soup('Scald milk, and thicken milk with flour diluted with cold water until thin enough to pour; boil one minute.'), facts)).recipeId);
    await k.change(/flour/i);
    expect(await k.text(0)).toMatch(/^Scald milk, and thicken milk with 2 tbsp cornstarch diluted with cold water .*Stir the cornstarch into the cold liquid/);
  });
  it("Fannie Farmer's tomato soup cooks twenty minutes after thickening: not offered, and the reason says why", async () => {
    const k = kitchen(withPacket());
    await k.start((await importConfirmed(k, soup('Scald milk with onion, and thicken milk with flour diluted with cold water until thin enough to pour; cook twenty minutes, stirring constantly at first.'), facts)).recipeId);
    const e = await k.ask(/flour/i, ['cornstarch']);
    expect(e.outcome).not.toBe('proposal');
    expect(JSON.stringify(e)).toMatch(/thins again with long cooking/);
  });
});

describe('Better Than Bouillon base for simmered chicken stock (E4)', () => {
  it('water with 1 tsp base per cup; product-named, and the tradeoff says other bases differ', async () => {
    const ingredients = [{ key: 'c', line: '1 cup chicken stock', name: 'chicken stock', amountText: '1 cup', kind: null }, { key: 'r', line: '1 cup heavy cream', name: 'heavy cream', amountText: '1 cup', kind: null }];
    const steps = [{ key: 's1', text: 'Stir in the cream and the chicken stock and simmer for 15 minutes.', title: 'Simmer', technique: 'SIMMER' }];
    const uses = [{ ingredientKey: 'r', stepKey: 's1', quote: 'the cream', amountText: null, functions: ['LIQUID', 'FAT'] }, { ingredientKey: 'c', stepKey: 's1', quote: 'the chicken stock', amountText: null, functions: ['LIQUID', 'FLAVOR'] }];
    const k = kitchen(withPacket());
    await k.start((await importConfirmed(k, { lines: ['Sauce', ...ingredients.map((i) => i.line), steps[0].text], reading: { recipeFound: true, title: 'Sauce', yield: null, ingredients, steps, uses } }, [])).recipeId);
    const { second } = await k.propose(/chicken stock/i, ['better-than-bouillon-chicken-base']);
    expect(second.outcome).toBe('proposal');
    expect(JSON.stringify(second)).toContain('cubes and other bases differ');
    await k.apply(second);
    expect(await k.text(0)).toMatch(/^Stir in the cream and 1 cup water with 1 tsp Better Than Bouillon chicken base and simmer for 15 minutes\. Dissolve the base/);
  });
});
