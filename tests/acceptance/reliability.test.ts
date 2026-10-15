// Import reliability and reviewed coverage (commission 2026-10-13). Scripted readings and cards (software evidence, not Nova
// output, not culinary content); every reviewed plan comes from the approved content (R1). The h01 page is the holdout's OCR as
// stored, kept as a regression case.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Authoring, BATCH_USES, Conflict, RELIABILITY } from '../../src/authoring/drafts.ts';
import { buildDraft, type Extractor } from '../../src/authoring/extract.ts';
import { ocrReadingOrder } from '../../src/authoring/ocr.ts';
import { joinings, readPastedText, type SourcePage } from '../../src/authoring/source.ts';
import type { AnalyzeResult, SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { checkCards, refsOf } from '../../src/compile/cards.ts';
import { KvLedger, LEDGER, spender, type Authorization } from '../../src/authoring/nova.ts';
import { releaseIdOfFiles } from '../../src/knowledge/release.ts';
import { contentOf, staticKnowledge } from '../../src/service/content.ts';
import { SqliteKv } from '../../src/service/kv-sqlite.ts';
import { biscuits, kitchen, newKnowledgeKv, r1Files } from '../fixtures/successive.ts';
import { H01_OCR_LINES } from '../fixtures/h01-ocr.ts';
import { content, newKv, newWs, vocab } from '../helpers.ts';

const R1 = () => { const f = r1Files(); return staticKnowledge(contentOf(f, releaseIdOfFiles(f))); };
const busy = (name = 'S'): AnalyzeResult & { ok: false } => ({ ok: false, error: 'THROTTLED', detail: 'ThrottlingException: Too many requests', analyzer: name, usage: null, costUsd: 0 });
const pause = RELIABILITY.pauseMs;
beforeEach(() => { RELIABILITY.pauseMs = [1, 1]; });
afterEach(() => { RELIABILITY.pauseMs = pause; });

/** One kitchen's Authoring whose reader and analyzer answer from scripts (each call recorded). */
function scripted(o: { read: (n: number, pages: SourcePage[]) => unknown; analyze?: (n: number, message: string) => AnalyzeResult }) {
  const reads: { key: string; lines: string[] }[] = [], analyses: { key: string; message: string }[] = [];
  const extractor: Extractor = { name: 'S', extract: async (pages, _v, key) => {
    reads.push({ key, lines: pages.flatMap((p) => p.lines.map((l) => l.lineId)) });
    const raw = o.read(reads.length, pages);
    return raw === 'BUSY' ? { ok: false, error: 'THROTTLED', detail: 'ThrottlingException', extractor: 'S', usage: null, costUsd: 0 } : { ok: true, raw, extractor: 'S', usage: null, costUsd: 0 };
  } };
  const analyzer: SwapAnalyzer = { name: 'S', analyze: async (message, _v, key) => { analyses.push({ key, message }); return o.analyze ? o.analyze(analyses.length, message) : { ok: true, raw: { cards: [] }, analyzer: 'S', usage: null, costUsd: 0 }; } };
  const auth = new Authoring({ kv: newKv(), ws: newWs(), content, extractor, analyzer });
  return { auth, reads, analyses };
}
const importText = async (auth: Authoring, lines: string[]) => {
  const r = await auth.createImport({ kind: 'text', text: lines.join('\n') });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  return { draftId: r.draftId, job: await auth.waitForJob(r.job.id) };
};

describe('a busy model service: bounded retries, a recoverable job, nothing read twice', () => {
  it('a reading refused as busy twice is tried again in the same run, each attempt under its own ledger key', async () => {
    const b = biscuits(), s = scripted({ read: (n) => (n <= 2 ? 'BUSY' : b.reading) });
    const { job } = await importText(s.auth, b.lines);
    expect(job.state).toBe('succeeded');
    expect(s.reads.map((x) => x.key)).toHaveLength(RELIABILITY.attempts);
    expect(new Set(s.reads.map((x) => x.key)).size).toBe(RELIABILITY.attempts);
  });

  it('still busy after every attempt: BUSY and retryable; a retry is the same job, and the run limit holds', async () => {
    const b = biscuits();
    let open = false;
    const s = scripted({ read: () => (open ? b.reading : 'BUSY') });
    const { job } = await importText(s.auth, b.lines);
    expect(job).toMatchObject({ state: 'failed', failure: { code: 'BUSY', retryable: true }, canRetry: true, attempt: 1 });
    open = true;
    const again = await s.auth.retryImport(job.id);
    expect(again.id).toBe(job.id);
    const done = await s.auth.waitForJob(job.id);
    expect(done).toMatchObject({ state: 'succeeded', attempt: 2, canRetry: false });
    await expect(s.auth.retryImport(job.id)).rejects.toThrow(Conflict);   // nothing left to retry
    open = false;
    const t = scripted({ read: () => 'BUSY' });
    const x = await importText(t.auth, b.lines);
    await t.auth.retryImport(x.job.id); await t.auth.waitForJob(x.job.id);
    await t.auth.retryImport(x.job.id);
    expect(await t.auth.waitForJob(x.job.id)).toMatchObject({ state: 'failed', attempt: RELIABILITY.runs, canRetry: false });
    await expect(t.auth.retryImport(x.job.id)).rejects.toThrow('RETRY_LIMIT');
  });

  it('the reading succeeds and the analysis stays busy: the draft keeps its reading, its uses read "not checked", and a retry analyses only', async () => {
    const b = biscuits();
    let open = false;
    const s = scripted({ read: () => b.reading, analyze: () => (open ? { ok: true, raw: { cards: [] }, analyzer: 'S', usage: null, costUsd: 0 } : busy()) });
    const { draftId, job } = await importText(s.auth, b.lines);
    expect(job.state).toBe('succeeded');
    const d = (await s.auth.getDraft(draftId)).draft;
    expect(d.content!.ingredients).toHaveLength(5);                          // the reading is kept
    expect(d.unchecked).toMatchObject({ uses: 5, jobId: job.id, canRetry: true });
    // never "no alternative": a reviewed plan, a reviewed change waiting on a fact, or a technical failure
    expect(d.content!.ingredients.flatMap((i) => i.uses).map((u) => u.analysis!).filter((a) => !(a.status === 'available' && a.plans[0].provenance.kind === 'reviewedRule') && a.status !== 'blocked' && a.status !== 'failed')).toEqual([]);
    open = true;
    await s.auth.retryImport(job.id); await s.auth.waitForJob(job.id);
    expect(s.reads).toHaveLength(1);                                         // never read twice
    expect((await s.auth.getDraft(draftId)).draft.unchecked).toBeNull();
  });
});

describe('large recipes: analysis in batches, a partial result said as such', () => {
  const big = (n: number) => {
    const ingredients = Array.from({ length: n }, (_x, i) => ({ key: `i${i}`, line: `${i + 1} g spice ${i}`, name: `spice ${i}`, amountText: `${i + 1} g`, kind: null }));
    const steps = [{ key: 's1', text: `Mix ${ingredients.map((i) => i.name).join(', ')}.`, title: 'Mix', technique: null }];
    const uses = ingredients.map((i) => ({ ingredientKey: i.key, stepKey: 's1', quote: i.name, amountText: null, functions: ['FLAVOR'] }));
    return { lines: ['Spice Mix', ...ingredients.map((i) => i.line), steps[0].text], reading: { recipeFound: true, title: 'Spice Mix', yield: null, ingredients, steps, uses } };
  };
  it(`more than ${BATCH_USES} uses: one call per batch with the whole recipe as context; a batch that stays busy leaves only its uses unchecked`, async () => {
    const r = big(BATCH_USES + 2);
    let open = false;
    const s = scripted({ read: () => r.reading, analyze: (_n, m) => (m.includes('Cards for: U13') && !open ? busy() : { ok: true, raw: { cards: [] }, analyzer: 'S', usage: null, costUsd: 0 }) });
    const { draftId, job } = await importText(s.auth, r.lines);
    const messages = [...new Set(s.analyses.map((a) => a.message))];
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.includes('U14:') && m.includes('U1:'))).toBe(true);   // every batch sees every use
    expect(messages.map((m) => m.split('\n').at(-1))).toEqual([`Cards for: ${Array.from({ length: BATCH_USES }, (_x, i) => `U${i + 1}`).join(', ')}`, 'Cards for: U13, U14']);
    const d = (await s.auth.getDraft(draftId)).draft, why = d.content!.ingredients.map((i) => i.uses[0].analysis!.reason?.code);
    expect(why.slice(BATCH_USES)).toEqual(['analysisError', 'analysisError']);   // the batch that didn't answer: a technical failure
    expect(why.slice(0, BATCH_USES).includes('analysisError')).toBe(false);      // the others were judged (no card was written for them)
    expect(d.unchecked).toMatchObject({ uses: 2, canRetry: true });
    open = true;
    const before = s.analyses.length;
    await s.auth.retryImport(job.id); await s.auth.waitForJob(job.id);
    expect(s.analyses.slice(before).map((a) => a.message.split('\n').at(-1))).toEqual(['Cards for: U13, U14']);   // only that batch again
    expect((await s.auth.getDraft(draftId)).draft.unchecked).toBeNull();
  });
});

describe('a document with several recipes (holdout h01): never combined; the cook chooses one', () => {
  const lines = ['BOSTON COOKING-SCHOOL COOK BOOK', 'Fish Chowder', '4 lb. cod or haddock', '1 sliced onion', 'Cut fish in two-inch pieces and cook with the onion.',
    'Connecticut Chowder', '4 lb. cod or haddock', '2½ cups stewed and strained tomatoes', 'Prepare same as Fish Chowder, using tomatoes in place of milk.'];
  const ct = { recipeFound: true, title: 'Connecticut Chowder', yield: null, recipes: [{ title: 'Connecticut Chowder', titleLineId: 'l6' }],
    ingredients: [{ key: 'c', line: '4 lb. cod or haddock', name: 'cod or haddock', amountText: '4 lb.', kind: null }, { key: 't', line: '2½ cups stewed and strained tomatoes', name: 'stewed and strained tomatoes', amountText: '2½ cups', kind: null }],
    steps: [{ key: 's1', text: 'Prepare same as Fish Chowder, using tomatoes in place of milk.', title: 'Prepare', technique: null }],
    uses: [{ ingredientKey: 't', stepKey: 's1', quote: 'tomatoes', amountText: null, functions: [] }] };
  it('the reading lists two recipes: nothing is read until the cook chooses; then only that recipe’s lines are read', async () => {
    const s = scripted({ read: (n) => (n === 1 ? { recipeFound: true, title: null, yield: null, ingredients: [], steps: [], uses: [], recipes: [{ title: 'Fish Chowder', titleLineId: 'l2' }, { title: 'Connecticut Chowder', titleLineId: 'l6' }] } : ct) });
    const { draftId, job } = await importText(s.auth, lines);
    expect(job).toMatchObject({ state: 'needsChoice', choices: [{ index: 0, title: 'Fish Chowder' }, { index: 1, title: 'Connecticut Chowder' }] });
    expect((await s.auth.getImport(job.id)).draft).toBeNull();
    await expect(s.auth.chooseRecipe(job.id, 5)).rejects.toThrow('NO_CHOICE_PENDING');
    await s.auth.chooseRecipe(job.id, 1);
    expect(await s.auth.waitForJob(job.id)).toMatchObject({ id: job.id, state: 'succeeded' });
    expect(s.reads[1].lines).toEqual(['l6', 'l7', 'l8', 'l9']);           // Connecticut Chowder only
    expect((await s.auth.getDraft(draftId)).draft.content!.title).toBe('Connecticut Chowder');
  });
  it('a v3 reading that names its one recipe only in the recipes list (no title field) is read, with that title', async () => {
    const { title: _t, ...noTitle } = ct;
    const s = scripted({ read: () => noTitle });
    const { draftId, job } = await importText(s.auth, lines);
    expect(job.state).toBe('succeeded');
    expect((await s.auth.getDraft(draftId)).draft.content!.title).toBe('Connecticut Chowder');
  });
  it('one recipe listed twice (the same title line) is one recipe: it is read', async () => {
    const one = { ...ct, recipes: [{ title: 'Connecticut Chowder', titleLineId: 'l6' }, { title: 'Connecticut Chowder', titleLineId: 'l6' }] };
    const s = scripted({ read: () => one });
    expect((await importText(s.auth, lines)).job.state).toBe('succeeded');
  });
  it('a reading that took two recipes as one (the same line twice where the page prints it twice) is refused, never combined', () => {
    const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!src.ok) throw new Error('src');
    const merged = { ...ct, recipes: undefined, title: 'BOSTON COOKING-SCHOOL COOK BOOK', ingredients: [...ct.ingredients, { key: 'c2', line: '4 lb. cod or haddock', name: 'cod or haddock', amountText: '4 lb.', kind: null }] };
    const b = buildDraft(merged, vocab, [{ sourceId: 'x', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T');
    expect(b).toMatchObject({ ok: false, code: 'MULTIPLE_RECIPES' });
  });
  it('the h01 page: the two-column ingredient lists are read column by column; words broken at the margin are matched either way', () => {
    const ordered = ocrReadingOrder(H01_OCR_LINES).map((l) => l.text);
    const at = (t: string) => ordered.indexOf(t);
    expect(at('slices, or')).toBe(at('6 cups potatoes cut in 1/4-inch') + 1);       // a wrapped line stays with its line
    expect(at('3/4-inch cubes')).toBe(at('4 cups potatoes cut in') + 1);
    expect(at('1½-inch cube fat salt pork')).toBe(at('1 sliced onion') + 1);        // the right column after the left
    expect(at('Fish Chowder')).toBe(9);                                           // headings and prose keep their place
    expect(ocrReadingOrder(H01_OCR_LINES.slice(22, 37))).toEqual(H01_OCR_LINES.slice(22, 37));   // one column: Textract's order exactly
    const [asPrinted, hard, soft] = joinings(ordered);
    expect(asPrinted).toContain('turn chow- der into a tureen');
    expect(soft).toContain('turn chowder into a tureen');                         // a word broken at the margin
    expect(hard).toContain('potatoes cut in 3/4-inch cubes');                       // a genuine hyphen kept
    expect(soft).toContain('potatoes cut in 3/4-inch cubes');
    expect(joinings(['add 1-', '2 cups'])[2]).toBe('add 1-2 cups');               // digits are never run together
  });
});

describe('list marks (live, Sloppy Joseph 2026-10-13)', () => {
  it('a reading that copies a printed "▪" as "▷" still finds its line (one list mark), amounts untouched', () => {
    const lines = ['Sloppy Joseph', '▪1lb/.5kg 80/20 ground beef ▪1g or 1/4tsp baking soda', 'Mix the beef with the baking soda.'];
    const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!src.ok) throw new Error('src');
    const b = buildDraft({ recipeFound: true, title: 'Sloppy Joseph', yield: null, ingredients: [{ key: 'b', line: '▷1lb/.5kg 80/20 ground beef', name: '80/20 ground beef', amountText: '1lb/.5kg', kind: null },
      { key: 's', line: '▷1g or 1/4tsp baking soda', name: 'baking soda', amountText: '1g or 1/4tsp', kind: null }],
    steps: [{ key: 's1', text: lines[2], title: 'Mix', technique: null }], uses: [{ ingredientKey: 'b', stepKey: 's1', quote: 'the beef', amountText: null, functions: [] }, { ingredientKey: 's', stepKey: 's1', quote: 'the baking soda', amountText: null, functions: [] }] },
    vocab, [{ sourceId: 'x', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.body.recipe.ingredients.map((i) => [i.listedProv.status, i.listed.kind === 'EXACT' ? i.listed.asWritten : i.listed.kind])).toEqual([['SOURCE_VERIFIED', '1lb/.5kg'], ['SOURCE_VERIFIED', '1g or 1/4tsp']]);
  });
});

describe('measures as printed (corpus d15, Fannie Farmer)', () => {
  it('"1 Cupful" is a US cup, and makes the recipe\'s volume system US (it was read as a 250 ml metric cup)', () => {
    const lines = ['Brown Bread', '1 Cupful Sour Milk', '1 Heaping Teaspoonful Soda', 'Stir the soda into the sour milk.'];
    const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!src.ok) throw new Error('src');
    const b = buildDraft({ recipeFound: true, title: 'Brown Bread', yield: null, ingredients: [{ key: 'm', line: '1 Cupful Sour Milk', name: 'Sour Milk', amountText: '1 Cupful', kind: null },
      { key: 's', line: '1 Heaping Teaspoonful Soda', name: 'Soda', amountText: '1 Heaping Teaspoonful', kind: null }],
    steps: [{ key: 's1', text: 'Stir the soda into the sour milk.', title: 'Mix', technique: null }], uses: [{ ingredientKey: 'm', stepKey: 's1', quote: 'the sour milk', amountText: null, functions: [] }, { ingredientKey: 's', stepKey: 's1', quote: 'the soda', amountText: null, functions: [] }] },
    vocab, [{ sourceId: 'x', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T');
    if (!b.ok) throw new Error('draft');
    expect(b.body.recipe.volumeSystem).toBe('US');
    expect(b.body.recipe.ingredients.map((i) => i.listed)).toMatchObject([{ kind: 'EXACT', unit: 'ML', value: { n: 473176473, d: 2000000 } }, { kind: 'AS_WRITTEN', text: '1 Heaping Teaspoonful' }]);
  });
});

describe('long steps: a targeted change, and unaffected instructions kept', () => {
  const tail = [' Keep the heat low: a hard boil can split the sauce, and it should barely bubble at the edges of the pot.', ' Season with salt, taste, and adjust; keep the pot covered while the potatoes finish cooking through.',
    ' Meanwhile warm the bowls in a low oven and chop the parsley, the chives and the tarragon for the garnish.', ' Check the potatoes with the point of a knife: they should give easily but still hold their shape.',
    ' Remove the bay leaf before serving, and rest the stew for ten minutes so the sauce settles and thickens a little more.', ' Ladle into the warm bowls and scatter the herbs over the top just before it goes to the table.'].join('');
  const lines = ['Stew', '1 cup cream', '1 tsp salt', `1. Add the cream and simmer gently until slightly thickened, stirring often so it doesn't catch.${tail}`];
  const reading = { recipeFound: true, title: 'Stew', yield: null,
    ingredients: [{ key: 'c', line: '1 cup cream', name: 'cream', amountText: '1 cup', kind: null }, { key: 's', line: '1 tsp salt', name: 'salt', amountText: '1 tsp', kind: null }],
    steps: [{ key: 's1', text: lines[3].slice(3), title: 'Simmer', technique: null }],
    uses: [{ ingredientKey: 'c', stepKey: 's1', quote: 'the cream', amountText: null, functions: [] }, { ingredientKey: 's', stepKey: 's1', quote: 'salt', amountText: null, functions: [] }] };
  const src = readPastedText(new TextEncoder().encode(lines.join('\n')));
  const b = src.ok ? buildDraft(reading, vocab, [{ sourceId: 'x', origin: 'UPLOAD', pages: src.source.pages }], 'r', 'e', 'T') : null;
  if (!b?.ok) throw new Error('draft');
  const card = (w: object) => ({ cards: [{ useRef: 'U1', role: 'liquid and fat', functions: ['LIQUID'], verdict: 'swap', swap: { ingredient: 'whole milk', kindId: 'whole-milk', amountText: '1 cup', otherIngredients: [] },
    stepRewrites: [{ stepRef: 'S1', ...w }], siblings: [], tradeoff: 'The sauce will be thinner and less rich.', opinion: 'Use whole milk and simmer it gently.' }] });
  const check = (w: object) => checkCards(card(w), refsOf(b.body.recipe), b.body.recipe, vocab, null).entries[0];
  it(`a step of ${lines[3].length} characters: changing only its first sentence (replaces) keeps the rest as written`, () => {
    expect(lines[3].length).toBeGreaterThan(600);
    const e = check({ replaces: "Add the cream and simmer gently until slightly thickened, stirring often so it doesn't catch.", text: "Add 1 cup whole milk and simmer gently until slightly thickened, stirring often so it doesn't catch." });
    expect(e).toMatchObject({ status: 'COMPILED' });
  });
  it('a whole-step rewrite may be as long as the step, but may not drop or reword an instruction about something else', () => {
    const whole = lines[3].slice(3).replace('the cream', '1 cup whole milk');
    expect(check({ text: whole })).toMatchObject({ status: 'COMPILED' });
    expect(check({ text: whole.replace('Remove the bay leaf before serving, and rest', 'Rest') }).reason).toMatch(/^REWRITE_CHANGES_OTHER_TEXT: step 1 no longer says "Remove the bay leaf/);
    expect(check({ replaces: 'Add the cream and simmer for an hour.', text: 'Add 1 cup whole milk.' }).reason).toMatch(/^REPLACES_NOT_IN_STEP/);
  });
});

describe('reviewed coverage: a cook confirmation, never a guess (corpus d03: popovers)', () => {
  // the reading tagged the mixing step COMBINE_DRY: the step does combine the flour and salt, and it mixes the milk into a batter
  const popovers = () => {
    const ing = (key: string, line: string, name: string, amountText: string, kind: string | null = null) => ({ key, line, name, amountText, kind });
    const ingredients = [ing('f', '1 cup flour', 'flour', '1 cup', 'plain-flour'), ing('t', '¼ teaspoon salt', 'salt', '¼ teaspoon'), ing('m', '1 cup milk', 'milk', '1 cup')];
    const steps = [{ key: 's1', text: 'Mix salt and flour; add milk gradually, in order to obtain a smooth batter.', title: 'Mix batter', technique: 'COMBINE_DRY' },
      { key: 's2', text: 'Bake thirty minutes in a hot oven.', title: 'Bake', technique: 'BAKE' }];
    const uses = [{ ingredientKey: 'f', stepKey: 's1', quote: 'flour', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 't', stepKey: 's1', quote: 'salt', amountText: null, functions: ['FLAVOR'] },
      { ingredientKey: 'm', stepKey: 's1', quote: 'milk', amountText: null, functions: ['LIQUID'] }];
    return { lines: ['Popovers', ...ingredients.map((i) => i.line), ...steps.map((s) => s.text)], reading: { recipeFound: true, title: 'Popovers', yield: null, ingredients, steps, uses } };
  };
  it('the review asks one question in the recipe’s words; "yes" lets the reviewed change apply, and cooking uses it', async () => {
    const k = kitchen(R1());
    const saved = await k.importAndSave(popovers());
    const before = (await k.auth.getDraft(saved.draftId)).draft;
    const milk = before.content!.ingredients.find((i) => i.name === 'milk')!.uses[0];
    expect(milk.analysis?.status).not.toBe('available');
    expect(before.questions.map((q) => q.prompt)).toEqual(['In step 1, is the milk used to mix dough?']);
    expect(before.questions[0]).toMatchObject({ kind: 'technique', quote: 'Mix salt and flour; add milk gradually, in order to obtain a smooth batter.', unlocks: [{ patternId: 'evaporated_milk_for_milk', useId: milk.id }] });
    await expect(k.auth.confirm(saved.draftId, { expectedRevision: before.revision - 1, answers: [{ questionId: before.questions[0].id, answer: 'yes' }] })).rejects.toThrow('STALE_REVISION');
    await expect(k.auth.confirm(saved.draftId, { expectedRevision: before.revision, answers: [{ questionId: 'q_nope', answer: 'yes' }] })).rejects.toThrow('UNKNOWN_QUESTION');
    const { draft } = await k.auth.confirm(saved.draftId, { expectedRevision: before.revision, answers: [{ questionId: before.questions[0].id, answer: 'yes' }] });
    const now = draft.content!.ingredients.find((i) => i.name === 'milk')!.uses[0].analysis!;
    expect(now.status).toBe('available');
    expect(now.plans[0].provenance.kind).toBe('reviewedRule');
    expect(now.plans[0].provenance.basis.join(' ')).toContain('confirmed by you for this recipe');
    expect(draft.questions).toEqual([]);
    const flour = draft.content!.ingredients.find((i) => i.name === 'flour')!.uses[0];
    expect(flour.reviewedFunction).toBeNull();                                // the flour in the same step is untouched
    const re = await k.auth.save(saved.draftId, { expectedRevision: draft.revision });
    await k.start(re.recipeId);
    await k.change(/^milk$/);
    expect(await k.text(0)).toMatch(/^Mix salt and flour; add .*evaporated milk.* gradually, in order to obtain a smooth batter\./);
  });
  it('a step the reading gave no technique, worded with an approved cue, is asked about once as a step: both changes it holds back apply (live scones, 2026-10-13)', async () => {
    const b = biscuits();
    (b.reading.steps.find((x) => x.key === 's2') as { technique: string | null }).technique = null;   // "Stir in the cream until a soft dough forms."
    const k = kitchen(R1());
    const saved = await k.importAndSave(b);
    const d = (await k.auth.getDraft(saved.draftId)).draft;
    expect(d.questions.map((q) => [q.prompt, q.unlocks.map((u) => u.patternId).sort()])).toEqual([['Does step 3 mix dough?', ['cream_to_butter_milk', 'powder_from_soda_and_tartar']]]);
    const { draft } = await k.auth.confirm(saved.draftId, { expectedRevision: d.revision, answers: [{ questionId: d.questions[0].id, answer: 'yes' }] });
    const plan = (name: RegExp) => draft.content!.ingredients.find((i) => name.test(i.name))!.uses[0].analysis!;
    expect([plan(/cream/), plan(/baking powder/)].map((x) => [x.status, x.plans[0]?.provenance.kind])).toEqual([['available', 'reviewedRule'], ['available', 'reviewedRule']]);
  });
  it('"no" changes nothing and isn’t asked again; an unconfirmed recipe offers no reviewed change', async () => {
    const k = kitchen(R1());
    const saved = await k.importAndSave(popovers());
    const q = (await k.auth.getDraft(saved.draftId)).draft;
    const { draft } = await k.auth.confirm(saved.draftId, { expectedRevision: q.revision, answers: [{ questionId: q.questions[0].id, answer: 'no' }] });
    expect(draft.questions).toEqual([]);
    expect(draft.content!.ingredients.find((i) => i.name === 'milk')!.uses[0].analysis!.status).not.toBe('available');
  });
});

describe('AI plans: mechanical validity is not culinary support (the popovers card, 2026-10-13)', () => {
  // TEST content: a sourced-limit record of the shape the candidate proposes (not approved content)
  const LIMIT = { schema: 'cc-limit/1' as const, limitId: 'test_acid_as_liquid', version: 1, title: 'Acid as a liquid', classes: ['citrus-juice'], replacing: ['LIQUID'],
    maxFraction: { n: 1, d: 16 }, reason: 'sources use lemon juice at no more than 1 tablespoon per cup of the liquid it goes into.', evidence: { basis: 'TEST' } };
  const knowledge = (limits: typeof LIMIT[]) => { const f = r1Files(); return staticKnowledge({ ...contentOf(f, releaseIdOfFiles(f)), limits }); };
  const recipe = (liquid: string, line: string, amount: string) => {
    const text = `Mix salt and flour; add ${liquid} gradually, in order to obtain a smooth batter.`;
    return { lines: ['Test Batter', '1 cup flour', '¼ teaspoon salt', line, text], reading: { recipeFound: true, title: 'Test Batter', yield: null,
      ingredients: [{ key: 'f', line: '1 cup flour', name: 'flour', amountText: '1 cup', kind: 'plain-flour' }, { key: 't', line: '¼ teaspoon salt', name: 'salt', amountText: '¼ teaspoon', kind: null }, { key: 'm', line, name: liquid, amountText: amount, kind: null }],
      steps: [{ key: 's1', text, title: 'Mix', technique: 'COMBINE_DRY' }],
      uses: [{ ingredientKey: 'f', stepKey: 's1', quote: 'flour', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 't', stepKey: 's1', quote: 'salt', amountText: null, functions: ['FLAVOR'] },
        { ingredientKey: 'm', stepKey: 's1', quote: liquid, amountText: null, functions: liquid === 'lemon juice' ? ['ACIDITY'] : ['LIQUID'] }] } };
  };
  const card = (functions: string[], swap: object, text: string) => ({ cards: [{ useRef: 'U3', role: 'the batter\'s liquid', functions, verdict: 'swap', swap: { otherIngredients: [], ...swap }, stepRewrites: [{ stepRef: 'S1', text }], siblings: [], tradeoff: 'It will taste different.', opinion: 'Use it and expect a different result.' }] });
  async function review(limits: typeof LIMIT[], src: ReturnType<typeof recipe>, cards: unknown) {
    const a = new Authoring({ kv: newKv(), ws: newWs(), knowledge: knowledge(limits), extractor: { name: 'S', extract: async () => ({ ok: true, raw: src.reading, extractor: 'S', usage: null, costUsd: 0 }) },
      analyzer: { name: 'S', analyze: async () => ({ ok: true, raw: cards, analyzer: 'S', usage: null, costUsd: 0 }) } });
    const { draftId } = await importText(a, src.lines);
    return (await a.getDraft(draftId)).draft.content!.ingredients[2].uses[0].analysis!;
  }
  const lemonForMilk = card(['LIQUID', 'ACIDITY'], { ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '1 cup' }, 'Mix salt and flour; add 1 cup lemon juice gradually, in order to obtain a smooth batter.');
  it('without a sourced limit (R1) the lemon plan is mechanically valid and offered, labelled as unsupported; the card never sets the milk\'s role', async () => {
    const a = await review([], recipe('milk', '1 cup milk', '1 cup'), lemonForMilk);
    expect(a.status).toBe('available');
    expect(a.plans[0].provenance.basis).toContain('Culinary support: none on file. Whether this replacement can do the job here is the AI\'s claim; no source or reviewed rule backs it.');
    // "the milk adds acidity" was the card's claim, not the milk's role: the role line is the reading's, the claim is disclosed beside it
    expect(a.plans[0].provenance.basis.find((x) => x.startsWith('What the milk does'))).toBe('What the milk does in step 1 (liquid): not reviewed');
    expect(a.plans[0].provenance.basis).toContain('Step 1: the swap suggestion described it as LIQUID + ACIDITY; the recipe reading\'s LIQUID is what it does here.');
  });
  it('with the limit: lemon juice at the full volume of the liquid it replaces is an explicit limitation, not a usable plan', async () => {
    const a = await review([LIMIT], recipe('water', '1 cup water', '1 cup'), card(['LIQUID', 'ACIDITY'], { ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '1 cup' }, 'Mix salt and flour; add 1 cup lemon juice gradually, in order to obtain a smooth batter.'));
    expect(a).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'unsupportedByEvidence' }, plans: [] });
    expect(a.reason!.text).toContain('sources use lemon juice at no more than 1 tablespoon per cup of the liquid it goes into.');
  });
  it('with the limit: lemon juice within it (1 tbsp with a cup of milk, for water) and an acid for an acid stay usable', async () => {
    const soured = card(['LIQUID'], { ingredient: 'whole milk', kindId: 'whole-milk', amountText: '1 cup', otherIngredients: [{ ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '1 tbsp' }] },
      'Mix salt and flour; add 1 cup whole milk mixed with 1 tbsp lemon juice gradually, in order to obtain a smooth batter.');
    expect((await review([LIMIT], recipe('water', '1 cup water', '1 cup'), soured)).status).toBe('available');
    const lime = card(['ACIDITY'], { ingredient: 'lime juice', kindId: 'unlisted', amountText: '1 cup' }, 'Mix salt and flour; add 1 cup lime juice gradually, in order to obtain a smooth batter.');
    expect((await review([LIMIT], recipe('lemon juice', '1 cup lemon juice', '1 cup'), lime)).status).toBe('available');   // ACIDITY, not a liquid's job
  });
});

describe('shared reservations across instances (two Lambdas, one table)', () => {
  it('separate ledger instances racing for the last call and the last cent: exactly one is reserved; every retry attempt is a reservation of its own', async () => {
    const kv = await newKnowledgeKv();   // a store of its own (DynamoDB Local: its own table)
    const auth: Authorization = { id: 'race', grantedBy: 'test', at: 'now', maxCalls: { extraction: 3, swapAnalysis: 10 }, maxUsd: 0.05, projectCeilingUsd: 5, priorProjectUsd: 0 };
    await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...auth, v: 1 } }]);
    const [a, b] = [new KvLedger(kv), new KvLedger(kv)];   // two instances: nothing shared but the store
    const race = (purpose: 'extraction' | 'swapAnalysis', usd: number, k: string) => Promise.allSettled([a, b].map((l, i) => spender.run('ws_race', () => l.reserve(purpose, `${k}-${i}`, usd, 'race'))));
    const dollars = await race('swapAnalysis', 0.03, 'usd');                 // $0.03 + $0.03 > $0.05: one only
    expect(dollars.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await Promise.all([a.reserve('extraction', 'e1', 0.001, 'x'), b.reserve('extraction', 'e2', 0.001, 'x')]);
    const calls = await race('extraction', 0.001, 'call');                   // the third and last call: one only
    expect(calls.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await a.usage()).totals).toMatchObject({ calls: { extraction: 3, swapAnalysis: 1 }, usd: 0.033 });
  });
});

describe('the ledger: a throttled call is refused before inference', () => {
  it('settles at $0 with the reason kept; any other failure keeps its reservation', async () => {
    const kv = new SqliteKv(join(mkdtempSync(join(tmpdir(), 'cc-ledger-')), 't.kv'));   // a ledger partition of its own (the LEDGER pk is table-wide)
    const auth: Authorization = { id: 'a', grantedBy: 'test', at: 'now', maxCalls: { extraction: 5 }, maxUsd: 1, projectCeilingUsd: 5, priorProjectUsd: 0 };
    await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...auth, v: 1 } }]);
    const l = new KvLedger(kv);
    await spender.run('ws_t', async () => { await l.reserve('extraction', 'k1', 0.03, 'x'); await l.reserve('extraction', 'k2', 0.03, 'x'); });
    await l.refused('extraction', 'k1', 'ThrottlingException: refused before inference');
    await l.failed('extraction', 'k2');
    const u = await l.usage();
    expect(u.totals).toMatchObject({ usd: 0.03, calls: { extraction: 2 } });
    expect(await kv.get({ pk: LEDGER, sk: 'R#k1' })).toMatchObject({ state: 'settled', settledUsd: 0, refusedBy: 'ThrottlingException: refused before inference' });
  });
});
