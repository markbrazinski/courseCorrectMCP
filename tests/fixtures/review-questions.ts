// TEST FIXTURES (software evidence, not Nova output, not culinary content): scripted readings for the import-review flows added
// 2026-10-13, keyed like every recorded reading (the hash of the reading's message). A popovers-like recipe whose mixing step
// the reading tagged COMBINE_DRY (the review asks one question), and a page holding two recipes (the cook chooses one).
import { userMessage } from '../../src/authoring/extract.ts';
import { readPastedText, type SourcePage } from '../../src/authoring/source.ts';
import { hash } from '../../src/domain/rational.ts';
import { ocrReadingOrder } from '../../src/authoring/ocr.ts';
import { H01_OCR_LINES } from './h01-ocr.ts';
import { H01_FISH_CHOWDER_READING } from './h01-reading.ts';

const pagesOf = (lines: readonly string[]) => { const r = readPastedText(new TextEncoder().encode(lines.join('\n'))); if (!r.ok) throw new Error('fixture'); return r.source.pages; };
const ing = (key: string, line: string, name: string, amountText: string, kind: string | null = null) => ({ key, line, name, amountText, kind });

export const POPOVER_LINES = ['Test Pop-overs', '1 cup flour', '¼ teaspoon salt', '7/8 cup milk', 'Mix salt and flour; add milk gradually, in order to obtain a smooth batter.', 'Bake thirty minutes in a hot oven.'] as const;
const POPOVER_READING = { recipeFound: true, title: 'Test Pop-overs', yield: null, recipes: [{ title: 'Test Pop-overs', titleLineId: 'l1' }],
  ingredients: [ing('f', '1 cup flour', 'flour', '1 cup', 'plain-flour'), ing('t', '¼ teaspoon salt', 'salt', '¼ teaspoon'), ing('m', '7/8 cup milk', 'milk', '7/8 cup')],
  steps: [{ key: 's1', text: POPOVER_LINES[4], title: 'Mix batter', technique: 'COMBINE_DRY' }, { key: 's2', text: POPOVER_LINES[5], title: 'Bake', technique: 'BAKE' }],
  uses: [{ ingredientKey: 'f', stepKey: 's1', quote: 'flour', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 't', stepKey: 's1', quote: 'salt', amountText: null, functions: ['FLAVOR'] },
    { ingredientKey: 'm', stepKey: 's1', quote: 'milk', amountText: null, functions: ['LIQUID'] }] };

export const CHOWDER_LINES = ['A COOK BOOK PAGE', 'Fish Chowder', '4 lb. cod or haddock', 'Cut fish in two-inch pieces and cook with the onion.',
  'Connecticut Chowder', '2½ cups stewed and strained tomatoes', 'Prepare same as Fish Chowder, using tomatoes in place of milk.'] as const;
const CHOWDER_LIST = { recipeFound: true, title: null, yield: null, ingredients: [], steps: [], uses: [], recipes: [{ title: 'Fish Chowder', titleLineId: 'l2' }, { title: 'Connecticut Chowder', titleLineId: 'l5' }] };
const CONNECTICUT = { recipeFound: true, title: 'Connecticut Chowder', yield: null, recipes: [{ title: 'Connecticut Chowder', titleLineId: 'l5' }],
  ingredients: [ing('t', '2½ cups stewed and strained tomatoes', 'stewed and strained tomatoes', '2½ cups')],
  steps: [{ key: 's1', text: CHOWDER_LINES[6], title: 'Prepare', technique: null }], uses: [{ ingredientKey: 't', stepKey: 's1', quote: 'tomatoes', amountText: null, functions: [] }] };

// h01's Fish Chowder pasted as text (its OCR lines in reading order) with the live reading: the wrapped potato line is a choice
const ordered = ocrReadingOrder(H01_OCR_LINES);
export const FISH_CHOWDER_LINES = ordered.slice(ordered.findIndex((l) => l.lineId === 'p1.o10'), ordered.findIndex((l) => l.lineId === 'p1.o38')).map((l) => l.text);

/** The readings, keyed by message: the chosen recipe's message is its own lines only (as the import sends it). */
export function reviewReadings(): Record<string, unknown> {
  const only = (pages: SourcePage[], ids: string[]) => pages.map((p) => ({ ...p, lines: p.lines.filter((l) => ids.includes(l.lineId)) }));
  const chowder = pagesOf(CHOWDER_LINES);
  return {
    [hash(userMessage(pagesOf(POPOVER_LINES)))]: POPOVER_READING,
    [hash(userMessage(chowder))]: CHOWDER_LIST,
    [hash(userMessage(only(chowder, ['l5', 'l6', 'l7'])))]: CONNECTICUT,
    [hash(userMessage(pagesOf(FISH_CHOWDER_LINES)))]: { ...H01_FISH_CHOWDER_READING, recipes: [{ title: 'Fish Chowder', titleLineId: 'l1' }] },
  };
}
