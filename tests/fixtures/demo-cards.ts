// TEST FIXTURES, hand-written: swap cards for the three demo recipes, as the swap-analysis tool would return them.
// They are software evidence of the card validator and compiler only: not Nova output, not culinary review, never
// approved content. Refs (U1…, S1…) follow each recorded reading's use and step order.
import { hash } from '../../src/domain/rational.ts';
import { buildDraft, userMessage } from '../../src/authoring/extract.ts';
import { readPastedText, readPdf, type SourcePage } from '../../src/authoring/source.ts';
import { swapUserMessage } from '../../src/authoring/swap-analysis.ts';
import type { Vocabulary } from '../../src/contract/types.ts';
import { makePdf } from './pdf.ts';
import { DROP_LINES, DROP_READING, RISOTTO_LINES, RISOTTO_READING, SCONE_LINES, SCONE_PDF_READING, SCONE_READING, SHORTCAKE_LINES, SHORTCAKE_READING } from './demo-sources.ts';

type Sib = { useRef: string; handling: 'coveredBy' | 'unchanged' | 'cantCover'; note: string };
type Ing = { ingredient: string; kindId: string | null; amountText: string };
const no = (useRef: string, role: string, functions: string[], opinion: string) =>
  ({ useRef, role, functions, verdict: 'no', swap: null, stepRewrites: [], siblings: [], tradeoff: null, opinion });
const omit = (useRef: string, role: string, functions: string[], [stepRef, text]: [string, string], siblings: Sib[], tradeoff: string, opinion: string) =>
  ({ useRef, role, functions, verdict: 'omit', swap: null, stepRewrites: [{ stepRef, text }], siblings, tradeoff, opinion });
const swap = (useRef: string, role: string, functions: string[], main: Ing, others: Ing[], rewrites: [string, string][], siblings: Sib[], tradeoff: string, opinion: string) =>
  ({ useRef, role, functions, verdict: 'swap', swap: { ...main, otherIngredients: others }, stepRewrites: rewrites.map(([stepRef, text]) => ({ stepRef, text })), siblings, tradeoff, opinion });

/** Scones (fits both the text reading and the M2 PDF reading: same use order). */
export const SCONE_CARDS = { cards: [
  no('U1', 'the structure of the scones', ['STRUCTURE'], 'No, because the flour is the structure of the scones; without it there is no dough.'),
  omit('U2', 'sweetens the dough', ['SWEETNESS'], ['S2', 'Whisk the flour, baking powder and salt.'], [], 'The scones will be less sweet and a little paler.', 'Leave the sugar out of step 2; the scones will be plainer.'),
  no('U3', 'makes the scones rise', ['LEAVENING'], 'No, because the baking powder makes the scones rise; without it they bake flat and dense.'),
  omit('U4', 'seasons the dough', ['FLAVOR'], ['S2', 'Whisk the flour, sugar and baking powder.'], [], 'The scones will taste a little flatter.', 'Leave the salt out of step 2; the scones will taste a little flatter.'),
  swap('U5', 'the liquid and the fat in the dough', ['LIQUID', 'FAT'], { ingredient: 'milk', kindId: 'whole-milk', amountText: '180 ML' }, [{ ingredient: 'cold butter', kindId: 'unsalted-butter', amountText: '85 g' }],
    [['S3', 'Rub 85 g cold butter into the dry mixture, then stir in 180 ML milk until a soft dough forms.']],
    [{ useRef: 'U6', handling: 'coveredBy', note: 'The cream brushed on in step 6 becomes a little milk too.' }],
    'These become butter scones: a little less rich and tender than cream scones.', 'Rub 85 g cold butter into the dry mixture, then stir in 180 ML milk for the cream.'),
  swap('U6', 'browns the tops', ['BROWNING'], { ingredient: 'milk', kindId: 'whole-milk', amountText: 'a little' }, [], [],
    [{ useRef: 'U5', handling: 'unchanged', note: 'The cream in step 3 is already in the dough by then.' }], 'The tops will brown a little less.', 'Brush the tops with a little milk instead of cream.'),
] };

export const SHORTCAKE_CARDS = { cards: [
  no('U1', 'the structure of the shortcakes', ['STRUCTURE'], 'No, because the flour is the structure of the shortcakes; without it there is no dough.'),
  omit('U2', 'sweetens the dough', ['SWEETNESS'], ['S2', 'Whisk 250 g flour, 2 tsp baking powder and ½ tsp salt.'],
    [{ useRef: 'U8', handling: 'unchanged', note: 'The sugar whipped into the cream in step 6 is still needed there.' }], 'The shortcakes will be less sweet.', 'Leave the sugar out of step 2; the strawberries and cream bring the sweetness.'),
  no('U3', 'makes the shortcakes rise', ['LEAVENING'], 'No, because the baking powder makes the shortcakes rise; without it they bake flat and dense.'),
  omit('U4', 'seasons the dough', ['FLAVOR'], ['S2', 'Whisk 250 g flour, 30 g sugar and 2 tsp baking powder.'], [], 'The shortcakes will taste a little flatter.', 'Leave the salt out of step 2; the shortcakes will taste a little flatter.'),
  no('U5', 'fat that makes the shortcakes tender and flaky', ['FAT'], 'No, because the cold butter is what makes the shortcakes tender and flaky; the dough needs it.'),
  swap('U6', 'the liquid and the fat in the dough', ['LIQUID', 'FAT'], { ingredient: 'milk', kindId: 'whole-milk', amountText: '130 ML' }, [{ ingredient: 'melted butter', kindId: 'unsalted-butter', amountText: '50 g' }],
    [['S4', 'Stir in 130 ML milk and 50 g melted butter until just combined.']],
    [{ useRef: 'U7', handling: 'cantCover', note: "The cream is also whipped in step 6, and milk and butter can't be whipped." }],
    'The shortcakes will be a little less rich and tender.', 'Stir in 130 ML milk and 50 g melted butter in place of the cream in step 4.'),
  no('U7', 'whipped into the topping; it has to hold air', ['AERATION'], 'No, because this cream has to whip and hold air for the topping, and nothing else in this recipe can do that.'),
  omit('U8', 'sweetens the whipped cream', ['SWEETNESS'], ['S6', 'Whip 240 ML heavy cream to soft peaks.'],
    [{ useRef: 'U2', handling: 'unchanged', note: 'The sugar in step 2 is already in the dough by then.' }], 'The whipped cream will be unsweetened.', 'Leave the sugar out of step 6; the strawberries bring sweetness.'),
  swap('U9', 'the fruit filling', ['FLAVOR'], { ingredient: 'raspberries', kindId: null, amountText: '500 g' }, [], [], [], 'The filling will be tarter.', 'Fill the shortcakes with 500 g raspberries instead of the strawberries.'),
] };

export const RISOTTO_CARDS = { cards: [
  no('U1', 'the cooking liquid, heated first', ['LIQUID'], "No, because the stock is the risotto's cooking liquid and its savory base; the rice can't cook without it."),
  swap('U2', 'fat to soften the onion in', ['FAT'], { ingredient: 'olive oil', kindId: null, amountText: '2 tbsp' }, [],
    [['S2', 'Heat 2 tbsp olive oil in a wide pan over medium heat. Add the onion and cook until soft, about 5 minutes.']],
    [{ useRef: 'U8', handling: 'unchanged', note: 'The butter stirred in at step 7 is still needed there.' }], 'The onion base will taste a little less rich.', 'Soften the onion in 2 tbsp olive oil instead of the butter in step 2.'),
  omit('U3', 'the flavor base', ['FLAVOR'], ['S2', 'Melt 30 g butter in a wide pan over medium heat.'], [], 'The risotto will have less sweetness and depth.', 'Leave the onion out of step 2; the risotto will be plainer.'),
  omit('U4', 'flavor', ['FLAVOR'], ['S3', 'Stir for 30 seconds.'], [], 'The risotto will have less flavor.', 'Leave the garlic out of step 3; the risotto will be milder.'),
  no('U5', 'the body of the risotto; its starch makes it creamy', ['STRUCTURE'], 'No, because the arborio rice is the risotto itself; its starch is what makes it creamy.'),
  swap('U6', 'liquid, acidity and flavor when deglazing', ['LIQUID', 'ACIDITY', 'FLAVOR'], { ingredient: 'unsalted vegetable stock', kindId: 'unsalted-vegetable-stock', amountText: '120 ML' },
    [{ ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '1 tbsp' }], [['S5', 'Pour in 120 ML unsalted vegetable stock and 1 tbsp lemon juice and stir until absorbed.']], [],
    'The risotto will taste different and lose the aroma of the wine.', 'Pour in 120 ML stock with 1 tbsp lemon juice in place of the wine in step 5.'),
  no('U7', 'the cooking liquid ladled into the rice', ['LIQUID'], "No, because the hot stock is the liquid the rice cooks in and its savory base; the risotto can't cook without it."),
  omit('U8', 'richness at the finish', ['FAT'], ['S7', 'Off the heat, stir in 50 g grated Parmesan. Season with salt.'],
    [{ useRef: 'U2', handling: 'unchanged', note: 'The butter in step 2 is already used by then.' }], 'The risotto will be a little less glossy and rich.', 'Leave the butter out of step 7; the Parmesan still makes it creamy.'),
  swap('U9', 'savory richness at the finish', ['FLAVOR'], { ingredient: 'grated pecorino', kindId: null, amountText: '50 g' }, [], [], [],
    'Pecorino is saltier and sharper, so taste before adding salt.', 'Stir in 50 g grated pecorino in place of the Parmesan in step 7.'),
  omit('U10', 'seasoning', ['FLAVOR'], ['S7', 'Off the heat, stir in 30 g butter and 50 g grated Parmesan.'], [], 'It may taste flat.', 'Leave the salt out of step 7 and taste; the Parmesan is already salty.'),
] };

/** The three demo recipes as frozen probe inputs (PDFs from the current demo texts). */
/** Drop biscuits (batch 1 browser evidence): the AI answers only; reviewed policies supersede the sugar, baking powder and milk,
 *  and the flour card's oat-flour draft meets the D-5 record (shown as "drafted swap not offered"). */
export const DROP_CARDS = { cards: [
  swap('U1', 'the structure of the biscuits', ['STRUCTURE'], { ingredient: 'oat flour', kindId: null, amountText: '250 g' }, [], [['S2', 'Whisk 250 g oat flour, sugar, baking powder and salt.']], [],
    'The biscuits will be denser and taste of oats.', 'Use 250 g oat flour for the plain flour.'),
  omit('U2', 'sweetens the dough', ['SWEETNESS'], ['S2', 'Whisk the flour, baking powder and salt.'], [], 'The biscuits will be less sweet.', 'Leave the sugar out of step 2.'),
  no('U3', 'makes the biscuits rise', ['LEAVENING'], 'No, because the baking powder makes the biscuits rise; without it they bake flat and dense.'),
  omit('U4', 'seasons the dough', ['FLAVOR'], ['S2', 'Whisk the flour, sugar and baking powder.'], [], 'The biscuits will taste a little flatter.', 'Leave the salt out of step 2.'),
  no('U5', 'the liquid in the dough', ['LIQUID'], 'No, because the milk is the liquid that brings the dough together; nothing else in this recipe can do that.'),
] };

export const DEMO = [
  { name: 'risotto', lines: RISOTTO_LINES, reading: RISOTTO_READING, cards: RISOTTO_CARDS },
  { name: 'scones', lines: SCONE_LINES, reading: SCONE_PDF_READING, cards: SCONE_CARDS },
  { name: 'shortcake', lines: SHORTCAKE_LINES, reading: SHORTCAKE_READING, cards: SHORTCAKE_CARDS },
] as const;
export const demoPdf = (lines: readonly string[]) => makePdf([{ lines: [...lines] }]);

const enc = (s: string) => new TextEncoder().encode(s);
async function pages(bytes: Uint8Array, pdf: boolean): Promise<SourcePage[]> {
  const r = pdf ? await readPdf(bytes) : readPastedText(bytes);
  if (!r.ok) throw new Error(r.code);
  return r.source.pages.filter((p) => p.status === 'TEXT');
}
/** Analysis message for a reading of some lines, built exactly as the import pipeline builds it. */
export async function analysisKey(reading: unknown, lines: readonly string[], v: Vocabulary) {
  const p = await pages(enc(lines.join('\n')), false);
  const b = buildDraft(reading, v, [{ sourceId: 's', origin: 'UPLOAD', pages: p }], 'r', 'e', 'T');
  if (!b.ok) throw new Error(`fixture reading invalid: ${b.code}`);
  return hash(swapUserMessage(b.body.recipe, v));
}

/** RECORDED extraction readings (PDF and pasted text of each demo) and RECORDED cards, keyed like the pipeline keys them. */
export async function recordedDemo(v: Vocabulary) {
  const readings: Record<string, unknown> = {}, cards: Record<string, unknown> = {};
  const add = async (reading: unknown, lines: readonly string[], c: unknown) => {
    readings[hash(userMessage(await pages(enc(lines.join('\n')), false)))] = reading;
    readings[hash(userMessage(await pages(demoPdf(lines), true)))] = reading;
    cards[await analysisKey(reading, lines, v)] = c;
  };
  for (const d of DEMO) await add(d.reading, d.lines, d.cards);
  await add(SCONE_READING, SCONE_LINES, SCONE_CARDS);   // the hand-written scone text reading has its own (equivalent) message
  await add(DROP_READING, DROP_LINES, DROP_CARDS);       // batch 1 browser evidence only (not in DEMO)
  readings[hash(userMessage(await pages(demoPdf(SCONE_LINES), true)))] = SCONE_PDF_READING;
  return { readings, cards };
}
