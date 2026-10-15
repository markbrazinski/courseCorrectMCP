// Import hardening (commission 2026-10-13, A1–A5 and B6–B9): page geometry and classes, list markers, transport escapes,
// keys and repeated ingredients, group references. Readings and cards here are hand-written TEST FIXTURES shaped like the
// owner's real PDFs' failures (software evidence, not Nova output, not culinary review).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { buildDraft, type Extractor } from '../../src/authoring/extract.ts';
import type { RawItem } from '../../src/authoring/pdf-worker.ts';
import { buildPages, classifyPage, readPastedText, type SourcePage } from '../../src/authoring/source.ts';
import type { SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { fixFor } from '../../src/authoring/swap-analysis.ts';
import { content, newKv, newWs, vocab } from '../helpers.ts';

const item = (str: string, x: number, y: number, w = str.length * 4.5, h = 9): RawItem => ({ str, x, y, w, h });
const texts = (p: SourcePage) => p.lines.map((l) => l.text);

describe('reading order from geometry', () => {
  it('two columns with offset baselines are read column by column, never glued line to line (Tarragon layout)', () => {
    const left = ['Ingredients', '2 large shallots, thinly sliced', '3 garlic cloves, minced', '¾ cup white wine', '1 cup heavy cream'];
    const right = ['Method', '1. Pat the chicken dry and season it.', 'Transfer the chicken to a plate.', '2. Add the shallots and cook until tender.', 'Stir in the garlic until fragrant.', 'Stir in the wine and cook until reduced.'];
    const items = [...left.map((t, i) => item(t, 178, 643 - i * 19)), ...right.map((t, i) => item(t, 340, 643 - i * 11.6))];
    const [p] = buildPages([{ width: 612, height: 792, items, images: 0, paths: 0 }]);
    expect(p.readingOrder).toBe('COLUMNS');
    expect(texts(p)).toEqual([...left, ...right]);
    expect(p.lines[1].box).toEqual([178, 624, 139.5, 9]);   // where the line is, kept
  });

  it('a table read across (amount | name on the same baselines) stays one line per row', () => {
    const rows = [['1 cup', 'flour'], ['2 tbsp', 'sugar'], ['1 tsp', 'salt'], ['3', 'eggs']];
    const items = rows.flatMap(([a, n], i) => [item(a, 72, 600 - i * 14), item(n, 180, 600 - i * 14)]);
    const [p] = buildPages([{ width: 612, height: 792, items, images: 0, paths: 0 }]);
    expect(p.readingOrder).toBe('SIMPLE');
    expect(texts(p)).toEqual(['1 cup flour', '2 tbsp sugar', '1 tsp salt', '3 eggs']);
  });
});

describe('page classes (documented page selection)', () => {
  const lines = (...t: string[]) => t.map((text, i) => ({ lineId: `l${i}`, text }));
  it('headings over drawn content need recognition; the same headings without graphics, or a page with a recipe body, do not', () => {
    const heads = lines('Marry Me Chicken Gnocchi Soup', 'Serves 6 20 mins prep 30 mins cook 50 mins total', 'What you need', 'How to make');
    expect(classifyPage(heads, { images: 2, paths: 1238 })).toBe('HEADINGS_ONLY');
    expect(classifyPage(heads, { images: 0, paths: 3 })).toBe('TEXT');
    expect(classifyPage([...heads, ...lines('2 cups chicken broth')], { images: 2, paths: 1238 })).toBe('TEXT');
    expect(classifyPage(lines('ab'), { images: 0, paths: 86 })).toBe('NO_TEXT_LAYER');
    expect(classifyPage(lines('  ok'), undefined)).toBe('UNUSABLE_TEXT');
  });
});

describe('verbatim check: list markers and transport escapes, never quantities', () => {
  const src = (t: string[]) => [{ sourceId: 'src1', origin: 'UPLOAD' as const, pages: (readPastedText(new TextEncoder().encode(t.join('\n'))) as { ok: true; source: { pages: SourcePage[] } }).source.pages }];
  const reading = (lines: string[]) => ({ recipeFound: true, title: null, yield: null,
    ingredients: lines.map((line, i) => ({ key: `i${i}`, line, name: ['butter', 'flour'][i], amountText: null, kind: null })),
    steps: [{ key: 's1', text: 'Rub the butter into the flour.', title: 'Rub in', technique: null }],
    uses: [{ ingredientKey: 'i0', stepKey: 's1', quote: 'the butter', amountText: null, functions: [] }, { ingredientKey: 'i1', stepKey: 's1', quote: 'the flour', amountText: null, functions: [] }] });
  const doc = ['● 4 tbsp Unsalted Butter', '▪ 2 cups flour', '1. Rub the butter into the flour.'];
  it('"●" copied as "•", "▪" as "▭", or written as a literal \\u2022 escape, is the same marker', () => {
    for (const lines of [['• 4 tbsp Unsalted Butter', '▭ 2 cups flour'], ['\\u2022 4 tbsp Unsalted Butter', '- 2 cups flour'], ['4 tbsp Unsalted Butter', '2 cups flour']]) {
      expect(buildDraft(reading(lines), vocab, src(doc), 'r', 'ex', 'T').ok).toBe(true);
    }
  });
  it('a changed number is still a different line: markers are normalized, quantities never', () => {
    const b = buildDraft(reading(['• 3 tbsp Unsalted Butter', '• 3 cups flour']), vocab, src(doc), 'r', 'ex', 'T');
    expect(b).toMatchObject({ ok: false, code: 'FIDELITY' });
  });
});

describe('keys and repeated ingredients', () => {
  const doc = ['For the marinade:', '1 tbsp garam masala', '2 tsp salt', 'For the sauce:', '1 tbsp garam masala', '1 cup cream', '1. Mix the garam masala and salt into the chicken.', '2. Simmer the garam masala in the cream.'];
  const src = [{ sourceId: 'src1', origin: 'UPLOAD' as const, pages: (readPastedText(new TextEncoder().encode(doc.join('\n'))) as { ok: true; source: { pages: SourcePage[] } }).source.pages }];
  const ings = [['1 tbsp garam masala', 'garam masala', 'For the marinade:'], ['2 tsp salt', 'salt', 'For the marinade:'], ['1 tbsp garam masala', 'garam masala', 'For the sauce:'], ['1 cup cream', 'cream', 'For the sauce:']];
  const steps = [{ text: 'Mix the garam masala and salt into the chicken.', title: 'Marinate', technique: null }, { text: 'Simmer the garam masala in the cream.', title: 'Simmer', technique: null }];
  it('keys the reading left out are generated; references by a unique name resolve; a name two lines share is refused, not guessed', () => {
    const keyless = (refs: [string, string][]) => ({ recipeFound: true, title: null, yield: null, steps: steps.map((s, i) => ({ ...s, key: `s${i + 1}` })),
      ingredients: ings.map(([line, name, group]) => ({ line, name, group, amountText: null, kind: null })),
      uses: refs.map(([ingredientKey, stepKey]) => ({ ingredientKey, stepKey, quote: ingredientKey === 'salt' ? 'salt' : ingredientKey === 'cream' ? 'the cream' : 'the garam masala', amountText: null, functions: [] })) });
    const ok = buildDraft(keyless([['salt', 's1'], ['cream', 's2']]), vocab, src, 'r', 'ex', 'T');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.body.issues).toContainEqual({ code: 'REFERENCE_BY_NAME', about: 'reading', detail: '2 references named an entry instead of its key; each matched exactly one entry' });
      expect(ok.body.recipe.ingredients.map((i) => i.group)).toEqual(['For the marinade:', 'For the marinade:', 'For the sauce:', 'For the sauce:']);
    }
    const amb = buildDraft(keyless([['garam masala', 's1'], ['salt', 's1']]), vocab, src, 'r', 'ex', 'T');
    expect(amb).toMatchObject({ ok: false, code: 'REFERENCE' });
    expect(!amb.ok && amb.issues[0]).toEqual({ code: 'REFERENCE', about: 'use in s1', detail: 'names "garam masala", which 2 ingredient lines share: ambiguous, not resolved' });
  });
});

describe('group references (B8): "Combine the Rub ingredients"', () => {
  const lines = ['Carnitas', 'Rub', '1 tbsp dried oregano', '2 tsp ground cumin', '1 kg pork shoulder', '1. Combine the Rub ingredients then rub all over the pork.', '2. Slow cook the pork for 8 hours.'];
  const reading = (shared = 'the Rub ingredients') => ({ recipeFound: true, title: 'Carnitas', yield: null,
    ingredients: [{ key: 'o', line: '1 tbsp dried oregano', name: 'dried oregano', amountText: '1 tbsp', kind: null, group: 'Rub' }, { key: 'c', line: '2 tsp ground cumin', name: 'ground cumin', amountText: '2 tsp', kind: null, group: 'Rub' },
      { key: 'p', line: '1 kg pork shoulder', name: 'pork shoulder', amountText: '1 kg', kind: null, group: null }],
    steps: [{ key: 's1', text: 'Combine the Rub ingredients then rub all over the pork.', title: 'Rub', technique: null }, { key: 's2', text: 'Slow cook the pork for 8 hours.', title: 'Cook', technique: null }],
    uses: [{ ingredientKey: 'o', stepKey: 's1', quote: shared, amountText: null, functions: ['FLAVOR'] }, { ingredientKey: 'c', stepKey: 's1', quote: shared, amountText: null, functions: ['FLAVOR'] },
      { ingredientKey: 'p', stepKey: 's1', quote: 'the pork', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 'p', stepKey: 's2', quote: 'the pork', amountText: null, functions: ['STRUCTURE'] }] });
  async function imp(raw: unknown, cards: unknown) {
    const analyzer: SwapAnalyzer = { name: 'SCRIPTED', analyze: async () => ({ ok: true, raw: cards, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }) };
    const extractor: Extractor = { name: 'SCRIPTED', extract: async () => ({ ok: true, raw, extractor: 'SCRIPTED', usage: null, costUsd: 0 }) };
    const auth = new Authoring({ kv: newKv(join(mkdtempSync(join(tmpdir(), 'ccmcp-grp-')), 'db')), ws: newWs(), content, extractor, analyzer });
    const r = await auth.createImport({ kind: 'text', text: lines.join('\n') });
    if (r.status !== 202) throw new Error(JSON.stringify(r));
    await auth.waitForJob(r.job.id);
    return (await auth.coverageOf(r.draftId)).pack!;
  }
  const swapOregano = { useRef: 'U1', role: 'seasons the rub', functions: ['FLAVOR'], verdict: 'swap', swap: { ingredient: 'dried marjoram', kindId: 'unlisted', amountText: '1 tbsp', otherIngredients: [] },
    stepRewrites: [], siblings: [], tradeoff: 'Milder and sweeter.', opinion: 'Use dried marjoram in the rub.' };
  it('the shared words stay plain text, each use records them, and a swap of one needs no rewrite: the group is still combined', async () => {
    const p = await imp(reading(), { cards: [swapOregano] });
    const [o, c] = p.recipe.uses;
    expect([o.groupText, c.groupText, o.displayText]).toEqual(['the Rub ingredients', 'the Rub ingredients', null]);
    expect(p.recipe.steps[0].text).toMatch(/^Combine the Rub ingredients then rub all over \{use:[^}]+\}\.$/);
    expect(p.cards!.find((e) => e.useId === o.useId)).toMatchObject({ status: 'COMPILED' });   // "unlisted": no kind claimed, still provisional
    const b = p.bindings.find((x) => x.card && x.targetUseId === o.useId)!;
    expect(b.ops.map((x) => x.op)).toEqual(['ADD_INGREDIENT', 'REPLACE_USE', 'SET_RESUME']);
    expect((b.ops[1] as { newUse: { groupText?: string } }).newUse.groupText).toBe('the Rub ingredients');   // the replacement is named by the group too
  });
  it('a shared quote that names its ingredients ("salt and pepper") is not a group: no use is placed by it', async () => {
    const p = await imp({ ...reading('dried oregano'), uses: reading('ground cumin and dried oregano').uses }, { cards: [] });
    expect(p.recipe.uses.filter((u) => u.groupText)).toEqual([]);
  });
});

describe('correction round feedback (B9)', () => {
  it('names the exact fix from the rejection, and nothing for reasons it cannot fix', () => {
    expect(fixFor('UNPARSEABLE_AMOUNT: shrimp "2-2.5 pounds"')).toBe('"2-2.5 pounds" for shrimp is not one amount: write a single number and unit (for example "2 pounds", "180 ML"), or exactly "a little". No ranges.');
    expect(fixFor('SWAP_IS_SAME_INGREDIENT: arborio rice resolves to short grain rice')).toBeNull();
  });
});

describe('the same ingredient in two groups (Butter Chicken shape, 2026-10-13)', () => {
  const lines = ['Spiced Chicken', 'For the marinade:', '1 tablespoon garam masala', '2 teaspoons salt', 'For the sauce:', '1 tablespoon plus 2 teaspoons garam masala', '1 tablespoon salt', '1 cup cream',
    '1. To marinate: stir the garam masala and salt into the chicken.', '2. For the sauce: grind the garam masala and salt to a fine powder.', '3. Add the ground spice mixture to the cream.'];
  const reading = { recipeFound: true, title: 'Spiced Chicken', yield: null,
    ingredients: [
      { key: 'g1', line: '1 tablespoon garam masala', name: 'garam masala', amountText: '1 tablespoon', kind: null, group: 'For the marinade:' },
      { key: 's1', line: '2 teaspoons salt', name: 'salt', amountText: '2 teaspoons', kind: null, group: 'For the marinade:' },
      { key: 'g2', line: '1 tablespoon plus 2 teaspoons garam masala', name: 'garam masala', amountText: '1 tablespoon plus 2 teaspoons', kind: null, group: 'For the sauce:' },
      { key: 's2', line: '1 tablespoon salt', name: 'salt', amountText: '1 tablespoon', kind: null, group: 'For the sauce:' },
      { key: 'c', line: '1 cup cream', name: 'cream', amountText: '1 cup', kind: null, group: 'For the sauce:' }],
    steps: [{ key: 'm', text: 'To marinate: stir the garam masala and salt into the chicken.', title: 'Marinate', technique: null },
      { key: 'p', text: 'For the sauce: grind the garam masala and salt to a fine powder.', title: 'Grind', technique: null },
      { key: 'q', text: 'Add the ground spice mixture to the cream.', title: 'Combine', technique: null }],
    uses: [{ ingredientKey: 'g1', stepKey: 'm', quote: 'the garam masala', amountText: null, functions: ['FLAVOR'] }, { ingredientKey: 's1', stepKey: 'm', quote: 'salt', amountText: null, functions: ['FLAVOR'] },
      { ingredientKey: 'g2', stepKey: 'p', quote: 'the garam masala', amountText: null, functions: ['FLAVOR'] }, { ingredientKey: 's2', stepKey: 'p', quote: 'salt', amountText: null, functions: ['FLAVOR'] },
      { ingredientKey: 'g2', stepKey: 'q', quote: 'ground spice mixture', amountText: null, functions: ['FLAVOR'] }, { ingredientKey: 'c', stepKey: 'q', quote: 'the cream', amountText: null, functions: ['LIQUID'] }] };
  const card = (useRef: string, ingredient: string, kindId: string | null) => ({ useRef, role: 'seasons the sauce', functions: ['FLAVOR'], verdict: 'swap', swap: { ingredient, kindId, amountText: '1 tbsp', otherIngredients: [] },
    stepRewrites: [], siblings: [{ useRef: 'U5', handling: 'unchanged', note: 'The ground mixture in step 3 already holds it.' }], tradeoff: 'A different blend of warmth.', opinion: 'Use curry powder in the sauce.' });
  async function imp(cards: unknown) {
    const analyzer: SwapAnalyzer = { name: 'SCRIPTED', analyze: async () => ({ ok: true, raw: cards, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }) };
    const extractor: Extractor = { name: 'SCRIPTED', extract: async () => ({ ok: true, raw: reading, extractor: 'SCRIPTED', usage: null, costUsd: 0 }) };
    const auth = new Authoring({ kv: newKv(join(mkdtempSync(join(tmpdir(), 'ccmcp-dup-')), 'db')), ws: newWs(), content, extractor, analyzer });
    const r = await auth.createImport({ kind: 'text', text: lines.join('\n') });
    if (r.status !== 202) throw new Error(JSON.stringify(r));
    await auth.waitForJob(r.job.id);
    return { pack: (await auth.coverageOf(r.draftId)).pack!, wire: (await auth.getDraft(r.draftId)).draft.content! };
  }
  it('each line stays its own ingredient, with its own group and amount; nothing is merged', async () => {
    const { pack, wire } = await imp({ cards: [] });
    expect(wire.ingredients.map((i) => [i.name, i.group, i.totalAmount.display])).toEqual([['garam masala', 'For the marinade:', '1 tablespoon'], ['salt', 'For the marinade:', '2 teaspoons'],
      ['garam masala', 'For the sauce:', '1 tablespoon plus 2 teaspoons'], ['salt', 'For the sauce:', '1 tablespoon'], ['cream', 'For the sauce:', '1 cup']]);
    const [g1, , g2] = pack.recipe.ingredients;
    expect(pack.recipe.uses.filter((u) => u.ingredientId === g1.ingredientId).map((u) => u.stepId)).toEqual([pack.recipe.steps[0].stepId]);
    expect(pack.recipe.uses.filter((u) => u.ingredientId === g2.ingredientId).map((u) => [u.stepId, u.groupText ?? null])).toEqual([[pack.recipe.steps[1].stepId, null], [pack.recipe.steps[2].stepId, 'ground spice mixture']]);
    expect(pack.recipe.steps[2].text).toMatch(/^Add the ground spice mixture to \{use:[^}]+\}\.$/);   // the mixture is not the garam masala's token
  });
  it("a card offering garam masala for the sauce's garam masala is the same ingredient, though the marinade lists it first", async () => {
    const { pack } = await imp({ cards: [card('U3', 'garam masala', null)] });
    const g2use = pack.recipe.uses[2];
    expect(pack.cards!.find((c) => c.useId === g2use.useId)).toMatchObject({ status: 'INVALID', reason: 'SWAP_IS_SAME_INGREDIENT: garam masala resolves to garam masala' });
  });
});
