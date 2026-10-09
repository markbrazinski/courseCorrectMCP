// Substitution coverage at its source (commission 2026-10-07): ingredient identity, policies bound by facts, sibling
// accounting, the one bounded correction round, and honest outcomes. Readings and cards here are hand-written TEST
// FIXTURES (software evidence, not Nova output, not culinary review). Batch 1 (OD-7, 2026-10-08) approved the packet's
// sugar, baking-powder and leavening items in revised form, so these tests now run on approved content; the packet's
// salt omission stays proposed (deferred) and is no longer exercised here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring, resolveIdentity } from '../../src/authoring/drafts.ts';
import { buildDraft, type Extractor } from '../../src/authoring/extract.ts';
import { readPastedText } from '../../src/authoring/source.ts';
import type { SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { dropFromUseList } from '../../src/compile/binder.ts';
import { repairRequests } from '../../src/compile/cards.ts';
import type { UseAnalysis } from '../../src/contract/analysis.ts';
import type { RecipePack, Vocabulary } from '../../src/contract/types.ts';
import { identityErrors, kindByName } from '../../src/domain/vocabulary.ts';
import { Service } from '../../src/service/commands.ts';
import { loadContent, type Content } from '../../src/service/content.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING } from '../fixtures/demo-sources.ts';
import { cmd, content, ROOT, vocab } from '../helpers.ts';

// the correction round is about mechanics, not content: run it where batch 1's reviewed plans don't decide the sugar and
// baking powder (harness choice, 2026-10-08), so those uses still go through the round
const BATCH1 = ['soda_alone_for_powder', 'leavening_not_omittable', 'whip_needs_min_fat_cream', 'oil_for_cold_butter_rub_in', 'confectioners_for_sugar_in_dry_mix', 'caster_to_granulated', 'evaporated_milk_for_milk', 'powder_from_soda_and_tartar', 'oat_flour_for_all_flour_not_offered'];
const preBatch: Content = { ...content, patterns: content.patterns.filter((p) => !BATCH1.includes(p.patternId)) };
type Reading = typeof SCONE_EXPLICIT_READING;
const scripted = (raw: unknown): Extractor => ({ name: 'SCRIPTED', extract: async () => ({ ok: true, raw, extractor: 'SCRIPTED', usage: null, costUsd: 0 }) });

/** Import pasted lines with a scripted reading and scripted cards (+ an optional scripted correction round) on a fresh database. */
async function imp(c: Content, lines: readonly string[], reading: unknown, cards: unknown = { cards: [] }, repair?: (message: string) => unknown) {
  const svc = new Service({ dbPath: join(mkdtempSync(join(tmpdir(), 'ccmcp-policy-')), 'db'), content: c, interpreter: noneInterpreter, fixtureRecipes: false });
  const calls = { analyze: 0, repair: 0, messages: [] as string[] };
  const analyzer: SwapAnalyzer = {
    name: 'SCRIPTED', analyze: async () => { calls.analyze++; return { ok: true, raw: cards, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }; },
    ...(repair ? { repair: async (m: string) => { calls.repair++; calls.messages.push(m); const raw = repair(m); return raw === null ? { ok: false as const, error: 'TIMEOUT', detail: 'scripted', analyzer: 'SCRIPTED', usage: null, costUsd: 0 } : { ok: true as const, raw, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }; } } : {}),
  };
  const auth = new Authoring({ store: svc.store, content: c, extractor: scripted(reading), analyzer });
  svc.catalog = () => auth.catalog();
  const r = await auth.createImport({ kind: 'text', text: lines.join('\n') });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  const job = await auth.waitForJob(r.job.id);
  if (job.state === 'failed') throw new Error(JSON.stringify(job.failure));
  const uses = () => { const x = auth.getDraft(r.draftId).draft.content!; return x.ingredients.flatMap((i) => i.uses.map((u) => ({ name: i.name, step: x.steps.find((s) => s.id === u.stepId)!.ordinal, ...u }))); };
  const use = (name: string, step: number) => uses().find((u) => u.name === name && u.step === step)!;
  return { svc, auth, draftId: r.draftId, calls, uses, use, pack: () => auth.coverageOf(r.draftId).pack! };
}
/** A variant of the explicit scone fixture: swap a line (and the reading's matching texts) without touching anything else. */
function variant(edit: { line?: [string, string]; ingredient?: { key: string; name: string; line: string; amountText: string; kind: string | null }; step?: [string, string]; addUse?: Reading['uses'][number] }) {
  const lines = SCONE_EXPLICIT_LINES.map((l) => (edit.line && l === edit.line[0] ? edit.line[1] : edit.step && l.endsWith(edit.step[0]) ? l.replace(edit.step[0], edit.step[1]) : l));
  const reading = structuredClone(SCONE_EXPLICIT_READING) as Reading;
  if (edit.ingredient) reading.ingredients = reading.ingredients.map((i) => (i.key === edit.ingredient!.key ? { ...i, ...edit.ingredient } : i));
  if (edit.step) reading.steps = reading.steps.map((s) => (s.text === edit.step![0] ? { ...s, text: edit.step![1] } : s));
  if (edit.addUse) reading.uses.push(edit.addUse);
  return { lines, reading };
}
const planOf = (u: { analysis: UseAnalysis | null }) => u.analysis!.plans[0];

describe('ingredient identity is separate from substitution', () => {
  it('true aliases name one ingredient; forms, varieties and categories do not', () => {
    const k = (n: string) => kindByName(vocab, n)?.kindId ?? null;
    expect(['All-purpose flour', 'plain flour', 'caster sugar', 'superfine sugar', 'granulated sugar', 'sugar', 'bicarbonate of soda', 'baking powder', 'Cold butter, cubed', 'Strawberries, sliced'].map(k))
      .toEqual(['plain-flour', 'plain-flour', 'caster-sugar', 'caster-sugar', 'white-sugar', 'white-sugar', 'baking-soda', 'baking-powder', 'unsalted-butter', 'strawberry']);
    // a form or a broad category is not the ingredient (vocabulary v2 removed "caster sugar", "flour", "rice", "wine", "stock", "cream", "lemon" as aliases)
    expect(['self-raising flour', 'flour', 'lemons', 'lemon', 'rice', 'wine', 'white wine', 'stock', 'vegetable stock', 'cream', 'double cream', 'whipping cream'].map(k)).toEqual(Array(12).fill(null));
    // sharing a class doesn't make two kinds one ingredient
    expect(vocab.kinds.find((x) => x.kindId === 'caster-sugar')!.classes).toContain('sugar');
    expect(k('caster sugar')).not.toBe(k('granulated sugar'));
    expect(identityErrors(vocab)).toEqual([]);
    const dup: Vocabulary = structuredClone(vocab);
    dup.kinds.find((x) => x.kindId === 'white-sugar')!.aliases.push('caster sugar');
    expect(identityErrors(dup)).toEqual(['vocabulary: "caster sugar" names both white-sugar and caster-sugar']);
  });

  it('a wrong model tag is corrected by the approved name; a name no kind owns keeps its tag, unpromoted (the M2 lemon drizzle cake)', () => {
    const lines = ['Lemon Drizzle Cake', '175 g caster sugar', '175 g self-raising flour', '2 lemons', '85 g granulated sugar', '1. Beat the caster sugar and flour.'];
    const ing = (key: string, name: string, line: string, amountText: string, kind: string) => ({ name, key, line, amountText, kind });
    const raw = { recipeFound: true, title: 'Lemon Drizzle Cake', yield: null, ingredients: [ing('a', 'caster sugar', '175 g caster sugar', '175 g', 'white-sugar'), ing('b', 'self-raising flour', '175 g self-raising flour', '175 g', 'plain-flour'),
      ing('c', 'lemons', '2 lemons', '2', 'lemon-juice'), ing('d', 'granulated sugar', '85 g granulated sugar', '85 g', 'white-sugar')],
      steps: [{ key: 's1', text: 'Beat the caster sugar and flour.', title: 'Beat', technique: null }], uses: [] };
    const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!src.ok) throw new Error('text');
    const b = buildDraft(raw, vocab, [{ sourceId: 's', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T');
    if (!b.ok) throw new Error(b.code);
    const fixed = resolveIdentity(b.body.recipe, vocab, content.roles);
    const kinds = b.body.recipe.ingredients.map((i) => `${i.name}=${i.kind?.kindId}:${i.kind?.prov.status}`);
    expect(kinds).toEqual(['caster sugar=caster-sugar:REVIEWED', 'self-raising flour=plain-flour:PROPOSED', 'lemons=lemon-juice:PROPOSED', 'granulated sugar=white-sugar:REVIEWED']);
    expect(fixed.map((x) => `${x.name}: ${x.proposed} → ${x.kindId}`)).toEqual(['caster sugar: white-sugar → caster-sugar']);
  });

  it('an alias resolves a card to the same ingredient (not a swap); a different form is a swap', async () => {
    const card = (useRef: string, ingredient: string, kindId: string | null, text: string) => ({ useRef, role: 'job', functions: ['STRUCTURE'], verdict: 'swap', swap: { ingredient, kindId, amountText: '300 g', otherIngredients: [] },
      stepRewrites: [{ stepRef: 'S2', text }], siblings: [], tradeoff: 'It will differ a little.', opinion: 'Use it in the dry mix.' });
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, { cards: [
      card('U1', 'all-purpose flour', null, 'Whisk 300 g all-purpose flour, sugar, baking powder and salt.'),
      { ...card('U2', 'granulated sugar', 'white-sugar', 'Whisk the flour, 40 g granulated sugar, baking powder and salt.'), functions: ['SWEETNESS'], swap: { ingredient: 'granulated sugar', kindId: 'white-sugar', amountText: '40 g', otherIngredients: [] } },
    ] });
    const cards = x.pack().cards!;
    expect(cards[0].reason).toBe('SWAP_IS_SAME_INGREDIENT: all-purpose flour resolves to plain flour');
    // granulated is a different form of sugar from caster: a real swap (not SWAP_IS_SAME_INGREDIENT); batch 1's reviewed
    // plan for the same swap supersedes the card, which agrees
    expect(cards[1]).toMatchObject({ status: 'SUPERSEDED', reason: expect.stringMatching(/Granulated sugar for caster sugar in a dry mix.*\(agrees\)/) });
    expect(x.use('caster sugar', 2).analysis!.plans[0]).toMatchObject({ ruleId: 'caster_to_granulated@1' });
  });
});

describe('approved policies bind by facts, not by recipe', () => {
  it('the explicit scone: sugar and baking powder get reviewed-policy plans with sourced amounts', async () => {
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING);
    const sugar = planOf(x.use('caster sugar', 2)), bp = planOf(x.use('baking powder', 2));
    expect(sugar).toMatchObject({ ruleId: 'caster_to_granulated@1', kind: 'replacement' });
    expect(sugar.replacements.map((r) => [r.ingredientName, r.amount.display])).toEqual([['Granulated sugar', '40 g']]);
    expect(bp).toMatchObject({ ruleId: 'powder_from_soda_and_tartar@1' });
    expect(bp.replacements.map((r) => [r.ingredientName, r.amount.display])).toEqual([['Baking soda', '¾ tsp'], ['Cream of tartar', '1½ tsp']]);
    expect(bp.stepEffects[0].after!.map((s) => s.text).join('')).toMatch(/shape it and bake it straight away, without resting or chilling it\.$/);
    expect(x.use('salt', 2).analysis!.plans.every((p) => p.ruleId === null)).toBe(true);   // the salt omission is deferred: no reviewed plan
  });

  it('the same facts in a different recipe bind the same policies, with that recipe\'s amounts', async () => {
    const lines = ['Drop Biscuits', 'Makes 10', '250 g plain flour', '20 g caster sugar', '2 tsp baking powder', '¼ tsp salt', '200 ML milk',
      '1. Whisk the flour, sugar, baking powder and salt.', '2. Stir in the milk until a soft dough forms.', '3. Drop onto a tray and bake for 12 minutes.'];
    const ing = (key: string, line: string, name: string, amountText: string, kind: string | null) => ({ name, key, line, amountText, kind });
    const use = (k: string, s: string, quote: string, functions: string[]) => ({ ingredientKey: k, stepKey: s, quote, amountText: null, functions });
    const reading = { recipeFound: true, title: 'Drop Biscuits', yield: 'Makes 10', ingredients: [ing('f', '250 g plain flour', 'plain flour', '250 g', null), ing('s', '20 g caster sugar', 'caster sugar', '20 g', null),
      ing('b', '2 tsp baking powder', 'baking powder', '2 tsp', null), ing('t', '¼ tsp salt', 'salt', '¼ tsp', null), ing('m', '200 ML milk', 'milk', '200 ML', null)],
      steps: [{ key: 's1', text: 'Whisk the flour, sugar, baking powder and salt.', title: 'Mix dry', technique: 'COMBINE_DRY' }, { key: 's2', text: 'Stir in the milk until a soft dough forms.', title: 'Mix dough', technique: 'MIX_DOUGH' },
        { key: 's3', text: 'Drop onto a tray and bake for 12 minutes.', title: 'Bake', technique: 'BAKE' }],
      uses: [use('f', 's1', 'the flour', ['STRUCTURE']), use('s', 's1', 'sugar', ['SWEETNESS']), use('b', 's1', 'baking powder', ['LEAVENING']), use('t', 's1', 'salt', ['FLAVOR']), use('m', 's2', 'the milk', ['LIQUID'])] };
    const x = await imp(content, lines, reading);
    expect(planOf(x.use('caster sugar', 1)).replacements.map((r) => r.amount.display)).toEqual(['20 g']);
    // no oven-heating step: soda + cream of tartar has to go straight into a hot oven, so it isn't offered here (B8)
    expect(x.pack().coverage.find((e) => e.patternId === 'powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'SLOT_NONE:preheat' } });
    // the same biscuits with the oven heated first: the same policy binds with this recipe's amounts
    const hot = await imp(content, [...lines.slice(0, 7), '1. Heat the oven to 220 °C.', ...lines.slice(7).map((l) => l.replace(/^(\d)\./, (_m, n) => `${Number(n) + 1}.`))],
      { ...reading, steps: [{ key: 's0', text: 'Heat the oven to 220 °C.', title: 'Heat oven', technique: 'PREHEAT' }, ...reading.steps] });
    expect(planOf(hot.use('baking powder', 2)).replacements.map((r) => r.amount.display)).toEqual(['½ tsp', '1 tsp']);   // 2 tsp × ¼ and × ½
  });

  it('changing the form, the technique or the amount changes applicability', async () => {
    // form: granulated sugar is not caster sugar, so the caster rule has no target
    const form = variant({ line: ['40 g caster sugar', '40 g granulated sugar'], ingredient: { key: 'sugar', name: 'granulated sugar', line: '40 g granulated sugar', amountText: '40 g', kind: 'white-sugar' } });
    const a = await imp(content, form.lines, form.reading);
    expect(a.pack().coverage.find((e) => e.patternId === 'caster_to_granulated')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'NO_TARGET' } });
    // technique: "Mix" carries no approved cue for combining dry ingredients, so nothing confirms step 2 and nothing is inferred
    const tech = variant({ step: ['Whisk the flour, sugar, baking powder and salt.', 'Mix the flour, sugar, baking powder and salt.'] });
    const b = await imp(content, tech.lines, tech.reading);
    expect(b.use('caster sugar', 2).analysis).toMatchObject({ status: 'blocked', reason: { code: 'missingFact' } });
    expect(b.use('caster sugar', 2).analysis!.reason!.text).toMatch(/how step 2 is done/);
    // amount: by volume isn't the sourced weight basis; 3 tbsp baking powder is outside the policy's bounds
    const vol = variant({ line: ['40 g caster sugar', '3 tbsp caster sugar'], ingredient: { key: 'sugar', name: 'caster sugar', line: '3 tbsp caster sugar', amountText: '3 tbsp', kind: null } });
    expect((await imp(content, vol.lines, vol.reading)).use('caster sugar', 2).analysis!.status).not.toBe('available');
    const big = variant({ line: ['1 tbsp baking powder', '3 tbsp baking powder'], ingredient: { key: 'bp', name: 'baking powder', line: '3 tbsp baking powder', amountText: '3 tbsp', kind: 'baking-powder' } });
    expect((await imp(content, big.lines, big.reading)).pack().coverage.find((e) => e.patternId === 'powder_from_soda_and_tartar')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: 'QUANTITY_INPUT_OUT_OF_DOMAIN' } });
  });

  it('every use of the missing ingredient is accounted for: an unhandled second use stops a total-based plan; one plan covering two uses is one plan', async () => {
    const two = variant({ step: ['Brush the tops with 15 ML heavy cream.', 'Brush the tops with 15 ML heavy cream and sprinkle with caster sugar.'], addUse: { ingredientKey: 'sugar', stepKey: 's6', quote: 'caster sugar', amountText: null, functions: ['SWEETNESS'] } });
    const a = await imp(content, two.lines, two.reading);
    expect(a.pack().coverage.find((e) => e.patternId === 'caster_to_granulated' && e.status !== 'NOT_APPLICABLE' || e.failedCheck?.code === 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED')).toMatchObject({ failedCheck: { code: 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED' } });
    expect(a.use('caster sugar', 2).analysis!.status).not.toBe('available');
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING);
    const dough = x.use('heavy cream', 3), brush = x.use('heavy cream', 6);
    expect(brush.analysis!.coveredByUseId).toBe(dough.id);
    expect(new Set([planOf(dough), planOf(brush)].map((p) => p.planId)).size).toBe(1);   // two cells, one plan
  });

  it('a failed AI card does not suppress a valid policy plan', async () => {
    const bad = { useRef: 'U2', role: 'sweetens', functions: ['SWEETNESS'], verdict: 'swap', swap: { ingredient: 'granulated sugar', kindId: 'white-sugar', amountText: '40 g', otherIngredients: [] },
      stepRewrites: [{ stepRef: 'S2', text: 'Whisk the flour, granulated sugar, baking powder and salt.' }], siblings: [], tradeoff: 'A little coarser.', opinion: 'Use granulated sugar.' };
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, { cards: [bad] }, () => ({ cards: [] }));
    expect(x.pack().cards!.find((e) => e.useId === x.use('caster sugar', 2).id)).toMatchObject({ status: 'INVALID', reason: "REWRITE_MISSING_AMOUNT: step 2 doesn't say 40 g granulated sugar" });
    expect(x.use('caster sugar', 2).analysis).toMatchObject({ status: 'available', plans: [{ ruleId: 'caster_to_granulated@1' }] });
    expect(x.calls.repair).toBe(1);
    expect(x.calls.messages[0]).not.toContain('U2: rejected');   // reviewed content decides the sugar: it is not sent for correction
  });

  it('an AI omission of the leavening: passed every structural check before batch 1; B2 now refuses it (and only it)', async () => {
    const omitBp = { useRef: 'U3', role: 'raises', functions: ['LEAVENING'], verdict: 'omit', swap: null, stepRewrites: [{ stepRef: 'S2', text: 'Whisk the flour, sugar and salt.' }], siblings: [],
      tradeoff: 'They will be denser.', opinion: 'Leave the baking powder out of step 2.' };
    expect((await imp(preBatch, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, { cards: [omitBp] })).use('baking powder', 2).analysis).toMatchObject({ status: 'available', offer: 'omission' });   // the gap (cards2 shortcake)
    const big = variant({ line: ['1 tbsp baking powder', '3 tbsp baking powder'], ingredient: { key: 'bp', name: 'baking powder', line: '3 tbsp baking powder', amountText: '3 tbsp', kind: 'baking-powder' } });
    const x = await imp(content, big.lines, big.reading, { cards: [{ ...omitBp }] });
    expect(x.pack().cards!.find((e) => e.useId === x.use('baking powder', 2).id)!.reason).toMatch(/^CONTRADICTS_REVIEWED_RULE: "Leaving out the leavening" refuses leaving it out/);
  });
});

describe('one bounded correction round', () => {
  const card = (useRef: string, ingredient: string, kindId: string | null, amountText: string, text: string, functions: string[]) => ({ useRef, role: 'job', functions, verdict: 'swap',
    swap: { ingredient, kindId, amountText, otherIngredients: [] }, stepRewrites: [{ stepRef: 'S2', text }], siblings: [], tradeoff: 'It will differ.', opinion: 'Use it in step 2.' });
  const first = { cards: [
    card('U1', 'all-purpose flour', 'plain-flour', '300 g', 'Whisk 300 g all-purpose flour, sugar, baking powder and salt.', ['STRUCTURE']),   // same ingredient
    card('U2', 'granulated sugar', 'white-sugar', '40 g', 'Whisk the flour, granulated sugar, baking powder and salt.', ['SWEETNESS']),         // amount missing
    card('U3', 'baking soda', 'baking-powder', '1 tsp', 'Whisk the flour, sugar, 1 tsp baking soda and salt.', ['LEAVENING']),                // mislabelled
    { useRef: 'U4', role: 'seasons', functions: ['FLAVOR'], verdict: 'omit', swap: null, stepRewrites: [{ stepRef: 'S2', text: 'Whisk the flour, sugar and baking powder.' }], siblings: [], tradeoff: 'Flatter.', opinion: 'Leave the salt out of step 2.' },
  ] };                                                                                                                                        // U5, U6 (cream): no card; the reviewed rule decides them
  const second = { cards: [
    { useRef: 'U1', role: 'structure', functions: ['STRUCTURE'], verdict: 'no', swap: null, stepRewrites: [], siblings: [], tradeoff: null, opinion: 'No, because the flour is the structure of the scones; nothing else here can build it.' },
    card('U2', 'granulated sugar', 'white-sugar', '40 g', 'Whisk the flour, 40 g granulated sugar, baking powder and salt.', ['SWEETNESS']),
    { ...card('U3', 'baking soda', 'baking-soda', '1 tsp', 'Whisk the flour, sugar, 1 tsp baking soda and salt.', ['LEAVENING']), stepRewrites: [{ stepRef: 'S9', text: 'x' }] },   // still invalid
  ] };

  it('batches the correctable failures once, validates the corrections through the same checks, and keeps both attempts', async () => {
    const x = await imp(preBatch, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, first, () => second);
    expect(x.calls).toMatchObject({ analyze: 1, repair: 1 });
    const m = x.calls.messages[0];
    expect(m).toContain('U1: rejected because SWAP_IS_SAME_INGREDIENT: all-purpose flour resolves to plain flour');
    expect(m).toContain("U2: rejected because REWRITE_MISSING_AMOUNT: step 2 doesn't say 40 g granulated sugar");
    expect(m).toContain('U3: rejected because KIND_MISMATCH: "baking soda" isn\'t baking powder');
    expect(m).toContain('siblings it may list: none; steps it may rewrite: S2');
    expect(m).not.toMatch(/^U[456]: rejected/m);                        // valid, or decided by the reviewed cream rule
    expect(m).toContain('baking-soda: baking soda / bicarbonate of soda');   // the allowed identities
    expect(x.use('plain flour', 2).analysis).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'aiSaysNo' } });
    expect(x.use('caster sugar', 2).analysis).toMatchObject({ status: 'available', plans: [{ ruleId: null }] });
    expect(x.use('caster sugar', 2).analysis!.plans[0].provenance.basis).toContain('Corrected once at import: the first draft was rejected by these checks, and this corrected draft passed the same checks. The correction is not a culinary review.');
    const bp = x.use('baking powder', 2).analysis!;
    expect(bp).toMatchObject({ status: 'failed', reason: { code: 'validationFailed' } });
    expect(bp.reason!.text).toContain('even after one automatic correction');
    expect(bp.reason!.text).toContain('That isn’t a finding that the baking powder can’t be replaced');
    expect(bp.reason!.detail).toMatch(/^import card: REWRITE_UNKNOWN_STEP: S9; correction round: STILL_INVALID, first draft rejected as KIND_MISMATCH/);
    // both attempts kept apart; the first round's cards are unchanged
    const a = x.svc.store.get<{ raw_json: string }>('SELECT raw_json FROM swap_analyses')!, r = x.svc.store.get<{ raw_json: string; status: string; requested_json: string }>('SELECT * FROM swap_repairs')!;
    expect(JSON.parse(a.raw_json)).toEqual(first);
    expect(r).toMatchObject({ status: 'SUCCEEDED' });
    expect(JSON.parse(r.raw_json)).toEqual(second);
    expect((JSON.parse(r.requested_json) as { useRef: string }[]).map((q) => q.useRef)).toEqual(['U1', 'U2', 'U3']);
  });

  it('save and reopen keep the analysis without any new call; the saved recipe cooks its prepared plan', async () => {
    const x = await imp(preBatch, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, first, () => second);
    const before = x.uses().map((u) => [u.id, u.analysis!.status, u.analysis!.plans.map((p) => p.planId)]);
    const saved = x.auth.save(x.draftId, { expectedRevision: x.auth.revision(x.draftId) });
    const page = x.auth.getRecipe(saved.recipeId).version.content!;
    expect(page.ingredients.flatMap((i) => i.uses).map((u) => [u.id, u.analysis!.status, u.analysis!.plans.map((p) => p.planId)])).toEqual(before);
    x.uses(); x.uses();
    expect(x.calls).toMatchObject({ analyze: 1, repair: 1 });          // never a second round, never a regeneration
  });

  it('a failed correction call leaves the uses failed (technical), never "no option"; a correction that omits a card is NOT_RETURNED', async () => {
    const down = await imp(preBatch, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, first, () => null);
    expect(down.use('caster sugar', 2).analysis).toMatchObject({ status: 'failed', reason: { code: 'validationFailed' } });
    expect(down.use('caster sugar', 2).analysis!.reason!.detail).toMatch(/correction round: NOT_RUN \(FAILED_CALL:TIMEOUT\)$/);
    const partial = await imp(preBatch, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING, first, () => ({ cards: [second.cards[1]] }));
    expect(partial.use('caster sugar', 2).analysis!.status).toBe('available');
    expect(partial.use('plain flour', 2).analysis!.reason!.detail).toMatch(/correction round: NOT_RETURNED$/);
  });

  it('authority decisions are never sent for correction', () => {
    const pack = { recipe: { uses: [{ useId: 'u1', ingredientId: 'i', stepId: 's', kind: 'ADD' }], steps: [{ stepId: 's' }] }, bindings: [],
      cards: [{ useId: 'u1', status: 'INVALID', reason: 'CONTRADICTS_REVIEWED_RULE: "Split the wine\'s jobs" answers this replacement differently: …' }] } as unknown as RecipePack;
    expect(repairRequests(pack, { uses: { U1: 'u1' }, steps: { S1: 's' } }, { cards: [] })).toEqual([]);
  });
});

describe('cooking the imported recipe uses its prepared policy plan', () => {
  it('caster sugar → granulated at step 2; baking soda alone is refused while soda + cream of tartar is offered', async () => {
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING);
    const planId = planOf(x.use('caster sugar', 2)).planId;
    const saved = x.auth.save(x.draftId, { expectedRevision: x.auth.revision(x.draftId) });
    const st = x.svc.startRecipe({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId });
    if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
    let run = st.run;
    const step1 = x.svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: st.recipe.steps[0].id, progress: 'done' });
    if (step1.outcome !== 'recorded') throw new Error(step1.code);
    run = step1.run;
    const id = (n: string) => st.recipe.ingredients.find((i) => i.name === n)!.id;
    const ask = async (missing: string, kinds: string[], prev?: { id: string; questions: { id: string }[] }) => x.svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision,
      missingIngredientId: id(missing), proposedKindIds: kinds, utterance: { text: 'tapped', channel: 'tapped' }, ...(prev ? { previousEvaluationId: prev.id, answers: prev.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) } : {}) });
    const soda = await ask('baking powder', ['baking-soda']);
    // the reviewed refusal answers the proposal; the reviewed soda + cream of tartar plan is offered instead
    expect(soda).toMatchObject({ outcome: 'needsFacts', proposalResponse: { response: 'REFUSED', alternativeOffered: true, text: expect.stringContaining("Baking soda on its own can't stand in for the baking powder in this recipe") } });
    if (soda.outcome !== 'needsFacts') throw new Error('soda');
    expect(soda.questions[0].items.map((i) => i.text)).toEqual(['¾ tsp baking soda', '1½ tsp cream of tartar']);
    const both = await ask('baking powder', ['baking-soda', 'cream-of-tartar']);
    expect(both).toMatchObject({ outcome: 'needsFacts', proposalResponse: { response: 'REALIZED_AS_PROPOSED' } });   // the omission refusal refuses no replacement
    const e1 = await ask('caster sugar', ['white-sugar']);
    if (e1.outcome !== 'needsFacts') throw new Error(e1.outcome);
    expect(e1.previews[0].id).toBe(planId);                              // the import's plan is the cooking candidate
    const e2 = await ask('caster sugar', ['white-sugar'], e1);
    if (e2.outcome !== 'proposal') throw new Error(e2.outcome);
    const cur = x.svc.getActiveRecipe().run!;
    const ap = x.svc.applyAmendment({ commandId: cmd(), runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, evaluationId: e2.id, candidateId: e2.candidates[0].id, planId: e2.candidates[0].planId, accepted: true });
    if (ap.outcome !== 'applied') throw new Error(ap.outcome);
    expect(ap.run.steps[1]).toMatchObject({ effectiveText: 'Whisk the flour, 40 g granulated sugar, baking powder and salt.', progress: 'notStarted' });
  });

  it('progress changes applicability: once step 2 has started, the sugar plan protects the started work', async () => {
    const x = await imp(content, SCONE_EXPLICIT_LINES, SCONE_EXPLICIT_READING);
    const saved = x.auth.save(x.draftId, { expectedRevision: x.auth.revision(x.draftId) });
    const st = x.svc.startRecipe({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId });
    if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
    let run = st.run;
    for (const [s, p] of [[0, 'done'], [1, 'started']] as const) {
      const r = x.svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: st.recipe.steps[s].id, progress: p });
      if (r.outcome !== 'recorded') throw new Error(r.code); run = r.run;
    }
    const ev = await x.svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: st.recipe.ingredients.find((i) => i.name === 'caster sugar')!.id, proposedKindIds: ['white-sugar'], utterance: { text: 'tapped', channel: 'tapped' } });
    expect(ev.outcome).toBe('refused');
    expect(JSON.stringify(ev)).toMatch(/PROTECTED_WORK|NOT_APPLICABLE_NOW/);
  });
});

describe('use lists', () => {
  it('drops a use from the list it sits in, or fails closed', () => {
    expect(dropFromUseList('Whisk {use:a}, {use:b}, {use:c} and {use:d}.', 'd')).toBe('Whisk {use:a}, {use:b} and {use:c}.');
    expect(dropFromUseList('Whisk {use:a}, {use:b}, {use:c} and {use:d}.', 'b')).toBe('Whisk {use:a}, {use:c} and {use:d}.');
    expect(dropFromUseList('Whisk {use:a} and {use:b}.', 'a')).toBe('Whisk {use:b}.');
    expect(dropFromUseList('Stir in {use:a} until smooth.', 'a')).toBeNull();
  });
});
