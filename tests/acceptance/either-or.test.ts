// Either/or ingredient lines (commission 2026-10-13): a printed choice is one ingredient, never several required together; a
// choice whose amounts differ is the cook's to make before cooking; a wrapped line is one line; an "and" list stays separate; two
// measures of one ingredient are its amount. h01 (Fannie Farmer, 1911, public domain) is the regression case: its live reading.
import { describe, expect, it } from 'vitest';
import { buildDraft } from '../../src/authoring/extract.ts';
import { ocrReadingOrder } from '../../src/authoring/ocr.ts';
import { readPastedText, type SourcePage } from '../../src/authoring/source.ts';
import { releaseIdOfFiles } from '../../src/knowledge/release.ts';
import { contentOf, staticKnowledge } from '../../src/service/content.ts';
import { H01_OCR_LINES } from '../fixtures/h01-ocr.ts';
import { H01_FISH_CHOWDER_READING, H01_FISH_CHOWDER_READING_V4, H01_LIVE_285D957 } from '../fixtures/h01-reading.ts';
import { Authoring } from '../../src/authoring/drafts.ts';
import { newKv, newWs } from '../helpers.ts';
import { kitchen, r1Files } from '../fixtures/successive.ts';
import { vocab } from '../helpers.ts';

// the chosen recipe's span of the page, in reading order (Fish Chowder's title to the line before Connecticut Chowder's)
const ordered = ocrReadingOrder(H01_OCR_LINES), from = ordered.findIndex((l) => l.lineId === 'p1.o10'), to = ordered.findIndex((l) => l.lineId === 'p1.o38');
const FISH: SourcePage = { page: 1, status: 'TEXT', readingOrder: 'SIMPLE', lines: ordered.slice(from, to), method: 'OCR' };
const build = (reading: unknown, pages: SourcePage[]) => {
  const b = buildDraft(reading, vocab, [{ sourceId: 's', origin: 'UPLOAD', pages }], 'r', 'e', 'T');
  if (!b.ok) throw new Error(`${b.code}: ${JSON.stringify(b.issues)}`);
  return b.body;
};
const pasted = (lines: string[]) => { const r = readPastedText(new TextEncoder().encode(lines.join('\n'))); if (!r.ok) throw new Error('src'); return r.source.pages; };
const ing = (key: string, line: string, name: string, amountText: string | null) => ({ key, line, name, amountText, kind: null });
const R1 = () => { const f = r1Files(); return staticKnowledge(contentOf(f, releaseIdOfFiles(f))); };

describe('h01: the wrapped potato choice is one ingredient with two options, never 10 cups of potatoes', () => {
  it('the live reading (four entries: potatoes, "slices, or", potatoes, "3/4-inch cubes") becomes one choice', () => {
    const b = build(H01_FISH_CHOWDER_READING, [FISH]);
    const names = b.recipe.ingredients.map((i) => i.name);
    expect(names).not.toContain('slices');
    expect(names).not.toContain('cubes');
    const potatoes = b.recipe.ingredients.filter((i) => /potatoes/.test(i.name));
    expect(potatoes).toHaveLength(1);
    expect(potatoes[0].options!.map((o) => [o.text, o.amount.kind === 'EXACT' ? o.amount.asWritten : o.amount.kind])).toEqual([
      ['potatoes cut in 1/4-inch slices', '6 cups'], ['potatoes cut in 3/4-inch cubes', '4 cups']]);
    expect(potatoes[0].listed).toEqual({ kind: 'AS_WRITTEN', text: '6 cups or 4 cups' });            // as printed, never summed
    expect(b.recipe.uses.filter((u) => u.ingredientId === potatoes[0].ingredientId)).toHaveLength(1); // the step's one "potatoes"
    expect(b.issues.map((x) => x.code)).toContain('CHOICE_LINE');
    expect(b.recipe.ingredients.find((i) => /cod/.test(i.name))).toMatchObject({ name: 'cod or haddock', listed: { kind: 'EXACT', asWritten: '4 lb.' } });
  });
  it('the live ccmcp-extract-4 reading (the first fragment given a one-item options list) is the same one choice', () => {
    const b = build(structuredClone(H01_FISH_CHOWDER_READING_V4), [FISH]);
    const potatoes = b.recipe.ingredients.filter((i) => /potatoes/.test(i.name));
    expect(potatoes).toHaveLength(1);
    expect(potatoes[0].options!.map((o) => o.text)).toEqual(['potatoes cut in 1/4-inch slices', 'potatoes cut in 3/4-inch cubes']);
    expect(b.recipe.ingredients.find((i) => /cod/.test(i.name))).toMatchObject({ name: 'cod or haddock', options: [{ name: 'cod' }, { name: 'haddock' }] });
  });
  it('the cook chooses before cooking; saving, the review and the cooking session all use that choice', async () => {
    const k = kitchen(R1());
    const saved = await k.importAndSave({ lines: FISH.lines.map((l) => l.text), reading: H01_FISH_CHOWDER_READING });
    expect(saved.release).toMatchObject({ kind: 'ineligible', reasons: [expect.objectContaining({ code: 'CHOICE_NEEDED' })] });
    const d = (await k.auth.getDraft(saved.draftId)).draft;
    const block = d.blockers.find((x) => x.kind === 'chooseOption')!;
    expect(block.message).toBe('Your recipe gives a choice: “6 cups potatoes cut in 1/4-inch slices, or 4 cups potatoes cut in 3/4-inch cubes”. Which will you use?');
    expect(block.resolution).toMatchObject({ action: 'choose', options: [{ index: 0, text: '6 cups potatoes cut in 1/4-inch slices' }, { index: 1, text: '4 cups potatoes cut in 3/4-inch cubes' }] });
    await expect(k.auth.chooseOption(saved.draftId, { expectedRevision: d.revision, ingredientId: (block.resolution as { ingredientId: string }).ingredientId, option: 5 })).rejects.toThrow('NO_SUCH_CHOICE');
    const { draft } = await k.auth.chooseOption(saved.draftId, { expectedRevision: d.revision, ingredientId: (block.resolution as { ingredientId: string }).ingredientId, option: 1 });
    expect(draft.blockers.filter((x) => x.kind === 'chooseOption')).toEqual([]);
    const row = draft.content!.ingredients.find((i) => /potatoes/.test(i.name))!;
    expect([row.name, row.totalAmount.display, row.uses[0].amount.display]).toEqual(['potatoes cut in 3/4-inch cubes', '4 cups', '4 cups']);
    const again = await k.auth.save(saved.draftId, { expectedRevision: draft.revision });
    expect(again.release.kind).toBe('eligible');
    await k.start(again.recipeId);
    const cooking = (await k.recipe()).ingredients.find((i) => /potatoes/.test(i.name))!;
    expect([cooking.totalAmount.display, cooking.uses.map((u) => u.amount.display)]).toEqual(['4 cups', ['4 cups']]);
  });
});

describe('contrasting lines', () => {
  it('two entries copied from one printed "or" line (the earlier merged reading: cod 4 lb, haddock 4 lb) are one choice; equal amounts need no question', () => {
    const lines = ['Fish Chowder', '4 lb. cod or haddock', 'Cut the fish in pieces.'];
    const b = build({ recipeFound: true, title: 'Fish Chowder', yield: null, ingredients: [ing('c', '4 lb. cod or haddock', 'cod', '4 lb.'), ing('h', '4 lb. cod or haddock', 'haddock', '4 lb.')],
      steps: [{ key: 's1', text: 'Cut the fish in pieces.', title: 'Cut', technique: null }], uses: [{ ingredientKey: 'c', stepKey: 's1', quote: 'the fish', amountText: null, functions: [] }, { ingredientKey: 'h', stepKey: 's1', quote: 'the fish', amountText: null, functions: [] }] }, pasted(lines));
    expect(b.recipe.ingredients).toHaveLength(1);
    expect(b.recipe.ingredients[0]).toMatchObject({ name: 'cod or haddock', listed: { kind: 'EXACT', asWritten: '4 lb.' } });
    expect(b.recipe.uses).toHaveLength(1);
  });
  it('a wrapped line that is not a choice is one ingredient ("2½ cups stewed and" / "strained tomatoes")', () => {
    const lines = ['Connecticut Chowder', '2½ cups stewed and', 'strained tomatoes', '3 tablespoons butter', 'Add the tomatoes and butter.'];
    const b = build({ recipeFound: true, title: 'Connecticut Chowder', yield: null, ingredients: [ing('t', '2½ cups stewed and', 'stewed', '2½ cups'), ing('s', 'strained tomatoes', 'tomatoes', null), ing('b', '3 tablespoons butter', 'butter', '3 tablespoons')],
      steps: [{ key: 's1', text: 'Add the tomatoes and butter.', title: 'Add', technique: null }], uses: [{ ingredientKey: 's', stepKey: 's1', quote: 'the tomatoes', amountText: null, functions: [] }, { ingredientKey: 'b', stepKey: 's1', quote: 'butter', amountText: null, functions: [] }] }, pasted(lines));
    expect(b.recipe.ingredients.map((i) => [i.name, i.listed.kind === 'EXACT' ? i.listed.asWritten : i.listed.kind, !!i.options])).toEqual([['stewed and strained tomatoes', '2½ cups', false], ['butter', '3 tablespoons', false]]);
  });
  it('an "and" list stays separate ingredients, each its own line and amount; a line with its own amount never joins the one before', () => {
    const lines = ['Soup', '2/3 cup cracker crumbs', 'Salt and pepper', '1 cup flour and', '1 cup sugar', 'Mix the crumbs, flour and sugar; season with salt and pepper.'];
    const b = build({ recipeFound: true, title: 'Soup', yield: null, ingredients: [ing('c', '2/3 cup cracker crumbs', 'cracker crumbs', '2/3 cup'), ing('s', 'Salt and pepper', 'salt', null), ing('p', 'Salt and pepper', 'pepper', null), ing('f', '1 cup flour and', 'flour', '1 cup'), ing('u', '1 cup sugar', 'sugar', '1 cup')],
      steps: [{ key: 's1', text: lines[5], title: 'Mix', technique: null }], uses: [{ ingredientKey: 'c', stepKey: 's1', quote: 'the crumbs', amountText: null, functions: [] }, { ingredientKey: 'f', stepKey: 's1', quote: 'flour', amountText: null, functions: [] }, { ingredientKey: 'u', stepKey: 's1', quote: 'sugar', amountText: null, functions: [] }, { ingredientKey: 's', stepKey: 's1', quote: 'salt', amountText: null, functions: [] }, { ingredientKey: 'p', stepKey: 's1', quote: 'pepper', amountText: null, functions: [] }] }, pasted(lines));
    expect(b.recipe.ingredients.map((i) => i.name)).toEqual(['cracker crumbs', 'salt', 'pepper', 'flour', 'sugar']);
    expect(b.recipe.ingredients.some((i) => i.options)).toBe(false);
  });
  it('two measures of one ingredient ("150g or 1 large") are its amount, not a choice; a reading\'s own options are kept', () => {
    const lines = ['Sauce', '150g or 1 large yellow onion, small diced', '4 lb. cod or haddock', 'Cook the onion; add the fish.'];
    const b = build({ recipeFound: true, title: 'Sauce', yield: null, ingredients: [ing('o', lines[1], 'yellow onion', '150g or 1 large'),
      { ...ing('f', lines[2], 'cod or haddock', null), options: [{ name: 'cod', amountText: '4 lb.' }, { name: 'haddock', amountText: '4 lb.' }] }],
    steps: [{ key: 's1', text: lines[3], title: 'Cook', technique: null }], uses: [{ ingredientKey: 'o', stepKey: 's1', quote: 'the onion', amountText: null, functions: [] }, { ingredientKey: 'f', stepKey: 's1', quote: 'the fish', amountText: null, functions: [] }] }, pasted(lines));
    expect(b.recipe.ingredients[0]).toMatchObject({ listed: { kind: 'EXACT', unit: 'G', asWritten: '150g or 1 large' } });
    expect(b.recipe.ingredients[0].options).toBeUndefined();
    expect(b.recipe.ingredients[1]).toMatchObject({ listed: { kind: 'EXACT', asWritten: '4 lb.' }, options: [{ name: 'cod' }, { name: 'haddock' }] });
  });
});

describe('an "or" CourseCorrect cannot place is never guessed', () => {
  it('a last line ending in "or" blocks the recipe with a concrete request, and saving says why', async () => {
    const lines = ['Custard', '2 cups milk', '1 cup cream, or', 'Scald the milk and cream.'];
    const reading = { recipeFound: true, title: 'Custard', yield: null, ingredients: [ing('m', lines[1], 'milk', '2 cups'), ing('c', lines[2], 'cream', '1 cup')],
      steps: [{ key: 's1', text: lines[3], title: 'Scald', technique: null }], uses: [{ ingredientKey: 'm', stepKey: 's1', quote: 'the milk', amountText: null, functions: [] }, { ingredientKey: 'c', stepKey: 's1', quote: 'cream', amountText: null, functions: [] }] };
    expect(build(reading, pasted(lines)).issues).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_CHOICE' }));
    const k = kitchen(R1());
    const saved = await k.importAndSave({ lines, reading });
    expect(saved.release).toMatchObject({ kind: 'ineligible', reasons: [expect.objectContaining({ code: 'UNCLEAR_INGREDIENT' })] });
    const block = (await k.auth.getDraft(saved.draftId)).draft.blockers.find((x) => x.kind === 'unclearLine')!;
    expect(block.message).toBe('CourseCorrect couldn\'t tell what the ingredient list means here: "1 cup cream, or". Paste the ingredient list as text to have it read again.');
  });
});

describe('an "or" at a line end pairs only with a line naming the same thing', () => {
  it('h01 read in the old interleaved column order ("…slices, or" then "1 tablespoon salt") is unresolved, never potatoes-or-salt', () => {
    const lines = ['Fish Chowder', '6 cups potatoes cut in 1/4-inch slices, or', '1 tablespoon salt', '4 cups potatoes cut in 3/4-inch cubes', 'Parboil potatoes; season with salt.'];
    const b = build({ recipeFound: true, title: 'Fish Chowder', yield: null, ingredients: [ing('p', lines[1], 'potatoes', '6 cups'), ing('s', lines[2], 'salt', '1 tablespoon'), ing('q', lines[3], 'potatoes', '4 cups')],
      steps: [{ key: 's1', text: lines[4], title: 'Parboil', technique: null }], uses: [{ ingredientKey: 'p', stepKey: 's1', quote: 'potatoes', amountText: null, functions: [] }, { ingredientKey: 's', stepKey: 's1', quote: 'salt', amountText: null, functions: [] }] }, pasted(lines));
    expect(b.recipe.ingredients.some((i) => i.options)).toBe(false);
    expect(b.recipe.ingredients.find((i) => i.name === 'salt')).toMatchObject({ listed: { kind: 'EXACT', asWritten: '1 tablespoon' } });
    expect(b.issues).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_CHOICE', detail: '"6 cups potatoes cut in 1/4-inch slices, or" offers a choice CourseCorrect couldn\'t place' }));
  });
});

describe('alternatives drafted before the cook\'s choice are never offered against it (h01 live, build 285d957)', () => {
  it('the yams card answered "6 cups or 4 cups"; once the cook chooses 4 cups it is withdrawn, and says why', async () => {
    const a = new Authoring({ kv: newKv(), ws: newWs(), knowledge: R1(), extractor: { name: 'S', extract: async () => ({ ok: true, raw: structuredClone(H01_LIVE_285D957.reading), extractor: 'S', usage: null, costUsd: 0 }) },
      analyzer: { name: 'S', analyze: async () => ({ ok: true, raw: structuredClone(H01_LIVE_285D957.cards), analyzer: 'S', usage: null, costUsd: 0 }) } });
    const r = await a.createImport({ kind: 'text', text: FISH.lines.map((l) => l.text).join('\n') });
    if (r.status !== 202) throw new Error(JSON.stringify(r));
    await a.waitForJob(r.job.id);
    const d = (await a.getDraft(r.draftId)).draft;
    const block = d.blockers.find((x) => x.kind === 'chooseOption')!;
    const { draft } = await a.chooseOption(r.draftId, { expectedRevision: d.revision, ingredientId: (block.resolution as { ingredientId: string }).ingredientId, option: 1 });
    const use = draft.content!.ingredients.find((i) => /potatoes/.test(i.name))!.uses[0];
    expect(use.amount.display).toBe('4 cups');
    expect(use.analysis).toMatchObject({ status: 'unexamined', reason: { code: 'contentChanged' }, plans: [] });
    expect(use.analysis!.reason!.text).toMatch(/^The alternatives drafted at import were written before you chose which option to use/);
    expect(draft.content!.ingredients.find((i) => /onion/.test(i.name))!.uses[0].analysis!.status).not.toBe('unexamined');   // other uses keep theirs
  });
});
