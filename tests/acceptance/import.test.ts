// Import, import authority (corroboration, source-verified amounts, roles from swap cards cross-checked by the role table),
// swap plan and the partial-PDF flow (ESOD §3, §8.5 + owner decisions 2026-10-02; FE–BE v1 A-1…A-3; B14, B30).
// Uses hand-written RECORDED readings and swap cards: validator evidence only, not Nova evidence.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { buildDraft, recordedExtractor, userMessage } from '../../src/authoring/extract.ts';
import { readPastedText, readPdf, type SourcePage } from '../../src/authoring/source.ts';
import { recordedAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { recordedDemo } from '../fixtures/demo-cards.ts';
import { hash } from '../../src/domain/rational.ts';
import { getStep, renderStep } from '../../src/domain/recipe.ts';
import { evaluate } from '../../src/engine/evaluate.ts';
import { Service } from '../../src/service/commands.ts';
import { recordedInterpreter } from '../../src/service/interpret.ts';
import { LEMON_PAGE1, LEMON_PASTED, LEMON_READING_PAGE1, LEMON_READING_WITH_PASTE, SCONE_LINES, SCONE_PDF_READING, SCONE_READING, SHORTCAKE_LINES, SHORTCAKE_READING } from '../fixtures/demo-sources.ts';
import { makePdf, scanImage } from '../fixtures/pdf.ts';
import { RECORDED_INTENTS } from '../fixtures/recorded-intents.ts';
import { cmd, content, doneUpTo, pack, req, snapshotAfter, vocab } from '../helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const textPages = async (bytes: Uint8Array, pdf: boolean): Promise<SourcePage[]> => {
  const r = pdf ? await readPdf(bytes) : readPastedText(bytes);
  if (!r.ok) throw new Error(r.code);
  return r.source.pages.filter((p) => p.status === 'TEXT');
};
const sconePdf = makePdf([{ lines: SCONE_LINES }]);
const lemonPdf = makePdf([{ lines: LEMON_PAGE1 }, { image: scanImage() }]);

const B14_LINES = ['SYNTHETIC household risotto', 'Serves 4 to 6', '6 cups broth', '1 ½ cups arborio rice', '½ cup dry white wine', '2 tablespoons butter',
  '1. Warm the broth.', '2. Toast the rice.', '3. Pour in the wine and stir until it is absorbed.', '4. Add the broth one ladle at a time.', '5. Off the heat, stir in the butter.'];
const B14_READING = {
  recipeFound: true, title: 'SYNTHETIC household risotto', yield: 'Serves 4 to 6',
  ingredients: [{ key: 'broth', line: '6 cups broth', name: 'Broth', amountText: '6 cups', kind: 'unsalted-vegetable-stock' }, { key: 'rice', line: '1 ½ cups arborio rice', name: 'Arborio rice', amountText: '1 ½ cups', kind: 'arborio-rice' },
    { key: 'wine', line: '½ cup dry white wine', name: 'Dry white wine', amountText: '½ cup', kind: 'dry-white-wine' }, { key: 'butter', line: '2 tablespoons butter', name: 'Butter', amountText: '2 tablespoons', kind: 'unsalted-butter' }],
  steps: [{ key: 'a', text: 'Warm the broth.', title: 'Warm', technique: 'HEAT_STOCK' }, { key: 'b', text: 'Toast the rice.', title: 'Toast', technique: 'TOAST_RICE' },
    { key: 'c', text: 'Pour in the wine and stir until it is absorbed.', title: 'Wine', technique: 'DEGLAZE' }, { key: 'd', text: 'Add the broth one ladle at a time.', title: 'Ladle', technique: 'LADLE_STOCK' },
    { key: 'e', text: 'Off the heat, stir in the butter.', title: 'Finish', technique: 'OFF_HEAT_FINISH' }],
  uses: [{ ingredientKey: 'rice', stepKey: 'b', quote: 'the rice', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 'wine', stepKey: 'c', quote: 'the wine', amountText: null, functions: ['ACIDITY', 'LIQUID', 'FLAVOR'] },
    { ingredientKey: 'broth', stepKey: 'd', quote: 'the broth', amountText: null, functions: ['LIQUID'] }, { ingredientKey: 'butter', stepKey: 'e', quote: 'the butter', amountText: null, functions: ['FAT'] }],
};
/** The scone text, read with no technique for step 3 (as the retained live text reading did). */
const SCONE_TEXT_NO_TECHNIQUE = { ...SCONE_READING, steps: SCONE_READING.steps.map((x) => (x.key === 's3' ? { ...x, technique: null } : x)) };

const demo = await recordedDemo(vocab);
async function setup(c: typeof content = content, sconeText: unknown = SCONE_READING) {
  const rec: Record<string, unknown> = { ...demo.readings };
  rec[hash(userMessage(await textPages(enc(SCONE_LINES.join('\n')), false)))] = sconeText;
  rec[hash(userMessage(await textPages(sconePdf, true)))] = SCONE_PDF_READING;
  rec[hash(userMessage(await textPages(enc(SHORTCAKE_LINES.join('\n')), false)))] = SHORTCAKE_READING;
  rec[hash(userMessage(await textPages(enc(B14_LINES.join('\n')), false)))] = B14_READING;
  const lemon1 = await textPages(lemonPdf, true);
  rec[hash(userMessage(lemon1))] = LEMON_READING_PAGE1;
  const pasted = readPastedText(enc(LEMON_PASTED), 'x');
  if (!pasted.ok) throw new Error('paste');
  rec[hash(userMessage([...lemon1, ...pasted.source.pages]))] = LEMON_READING_WITH_PASTE;
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ccmcp-imp-')), 'db');
  let n = 0;
  const ids = (p: string) => `${p}_${++n}`;
  const svc = new Service({ dbPath, content: c, interpreter: recordedInterpreter(RECORDED_INTENTS), newId: ids });
  const auth = new Authoring({ store: svc.store, content: c, extractor: recordedExtractor(rec), analyzer: recordedAnalyzer(demo.cards), newId: ids });
  svc.catalog = () => auth.catalog();
  return { svc, auth };
}
async function importText(auth: Authoring, text: string) {
  const r = await auth.createImport({ kind: 'text', text });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  return { job: await auth.waitForJob(r.job.id), draftId: r.draftId };
}
async function importPdf(auth: Authoring, bytes: Uint8Array, filename: string) {
  const r = await auth.createImport({ kind: 'pdf', bytes, filename });
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  return { job: await auth.waitForJob(r.job.id), draftId: r.draftId };
}
const usesOf = (auth: Authoring, draftId: string, name: string) => {
  const c = auth.getDraft(draftId).draft.content!;
  return c.ingredients.find((i) => i.name.toLowerCase() === name)!.uses.map((u) => ({ ...u, step: c.steps.find((s) => s.id === u.stepId)!.ordinal }));
};

describe('A-1 scone PDF → swap plan computed at reading → save → cook, with no human input (owner decision 2026-10-02)', () => {
  it('wrong model role guesses: roles come from the swap cards, reviewed where the role table agrees; the guesses stay display-only', async () => {
    const { auth } = await setup();
    const { job, draftId } = await importPdf(auth, sconePdf, 'scones.pdf');
    expect(job).toMatchObject({ state: 'succeeded', stagesCompleted: ['reading', 'recipeFound', 'ingredientsAndSteps', 'uses', 'proposedFunctions', 'coverage'], failure: null });
    const cream = usesOf(auth, draftId, 'heavy cream');
    expect(cream.map((u) => u.step)).toEqual([3, 6]);
    expect(cream.map((u) => u.proposedFunction?.labels)).toEqual([['liquid', 'aeration'], ['fat']]);    // what the model guessed
    expect(cream.map((u) => u.reviewedFunction?.labels)).toEqual([['liquid', 'fat'], ['browning']]);   // the cards, matching the table
    expect(cream.map((u) => u.reviewedFunction?.reviewId)).toEqual(['roles.json', 'roles.json']);
    const fx = auth.effective(draftId)!;
    expect(fx.uses.filter((u) => u.functions.some((f) => f.prov.status === 'REVIEWED')).every((u) => u.functions.every((f) => f.prov.by === 'CONTENT'))).toBe(true);
    expect(fx.ingredients.find((i) => i.name === 'heavy cream')!.listedProv.status).toBe('SOURCE_VERIFIED');
  });

  it('the swap plan: dough cream → 85 g butter + 180 ML milk (+30 ML) (reviewed); brushing cream → a little milk; other uses from their cards', async () => {
    const { auth } = await setup();
    const { draftId } = await importPdf(auth, sconePdf, 'scones.pdf');
    const [dough, brush] = usesOf(auth, draftId, 'heavy cream');
    expect(dough.swap).toMatchObject({ kind: 'recovery', text: 'If you run out: Butter and milk for cream in a dough' });
    expect(dough.swap.details).toEqual([
      'Rub in cold butter and use milk in the dough, and brush with milk instead of cream.',
      'Step 3: 85 g cold butter', 'Step 3: 180 ML milk, plus up to 30 ML more only if needed', 'Step 6: a little milk',
      'These become butter scones: the texture will be a little less rich and tender than cream scones.',
    ]);
    expect(dough.swap).toMatchObject({ origin: 'reviewed', label: 'Reviewed change' });
    expect(brush.swap).toMatchObject({ kind: 'covered', text: 'Covered by step 3’s swap: a little milk'.replace('’', "'"), origin: 'reviewed' });
    expect(usesOf(auth, draftId, 'plain flour')[0].swap).toMatchObject({ kind: 'refusal', origin: 'importCard', label: 'Prepared at import (AI)', text: 'No, because the flour is the structure of the scones; without it there is no dough.' });
    expect(usesOf(auth, draftId, 'caster sugar')[0].swap).toMatchObject({ kind: 'recovery', origin: 'importCard', text: 'If you run out: Leave out the caster sugar' });
    const b = auth.requirements(draftId).bindings.find((x) => x.patternId === 'cream_to_butter_milk')!;
    expect(b.quantities).toEqual(pack(RECIPE['scones.demo']).bindings.find((x) => x.patternId === 'cream_to_butter_milk')!.quantities);
  });

  it('save → eligible → the recipe page reads the same → start → the §9.4 rescue renders exactly as the approved scone', async () => {
    const { svc, auth } = await setup();
    const { draftId } = await importPdf(auth, sconePdf, 'scones.pdf');
    const saved = auth.save(draftId, { expectedRevision: auth.revision(draftId), idempotencyKey: 'save-1' });
    expect(saved.release).toEqual({ kind: 'eligible', coverageSummary: 'Reviewed change on file: heavy cream, step 3 · Prepared at import (AI): a card for 6 of 6 uses' });
    expect(auth.save(draftId, { expectedRevision: 999, idempotencyKey: 'save-1' })).toEqual(saved);   // idempotent
    const page = auth.getRecipe(saved.recipeId).version.content!;
    expect(page.ingredients.flatMap((i) => i.uses.map((u) => u.swap))).toEqual(auth.getDraft(draftId).draft.content!.ingredients.flatMap((i) => i.uses.map((u) => u.swap)));
    expect(svc.listRecipes().recipes.find((r) => r.recipeId === saved.recipeId)?.release.kind).toBe('eligible');
    expect(svc.startRecipe({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId }).outcome).toBe('started');
    const p = auth.catalog().find((c) => c.recipeId === saved.recipeId)!.pack!;
    const snap = snapshotAfter(p, [{ stepId: p.recipe.steps[0].stepId, progress: 'done' }, { stepId: p.recipe.steps[1].stepId, progress: 'done' }]);
    const cream = p.recipe.ingredients.find((i) => i.name === 'heavy cream')!.ingredientId;
    const first = evaluate(p, vocab, snap, req(cream, ['whole-milk', 'unsalted-butter']));
    expect(first.questions).toHaveLength(2);
    const res = evaluate(p, vocab, snap, req(cream, ['whole-milk', 'unsalted-butter'], first.questions.map((x) => ({ questionId: x.questionId, choiceId: 'ENOUGH' as const }))));
    const r = res.candidates[0].resultRecipe;
    expect(renderStep(r, r.steps[2])).toBe('Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 180 ML milk until a soft dough forms. Only if needed: up to 30 ML more milk. Add it 1 tablespoon at a time and stop as soon as no dry flour remains. If the dough is still crumbly after that, press it together with your hands; don\'t add more liquid.');
    expect(renderStep(r, r.steps[5])).toBe('Brush the tops with a little milk.');
    const demo = pack(RECIPE['scones.demo']);
    const ds = snapshotAfter(demo, doneUpTo(demo, 2));
    const d1 = evaluate(demo, vocab, ds, req(ING['cream'], ['whole-milk', 'unsalted-butter']));
    const dres = evaluate(demo, vocab, ds, req(ING['cream'], ['whole-milk', 'unsalted-butter'], d1.questions.map((x) => ({ questionId: x.questionId, choiceId: 'ENOUGH' as const }))));
    expect(res.candidates[0].ledger.map((l) => [l.order, l.after, l.kind])).toEqual(dres.candidates[0].ledger.map((l) => [l.order, l.after, l.kind]));
    expect(res.candidates[0].consequence).toEqual(dres.candidates[0].consequence);
  });

  it('a kind × technique missing from the role table: the reviewed rule can\'t bind (named missing fact); the card\'s own plan is used, labelled AI', async () => {
    const noBrush = { ...content, roles: { ...content.roles, roles: content.roles.roles.filter((x) => x.techniqueId !== 'BRUSH') } };
    const { auth } = await setup(noBrush);
    const { draftId } = await importPdf(auth, sconePdf, 'scones.pdf');
    const [dough, brush] = usesOf(auth, draftId, 'heavy cream');
    expect(brush.reviewedFunction).toBeNull();
    const reviewed = auth.requirements(draftId).coverage.find((c) => c.patternId === 'cream_to_butter_milk')!;
    expect(reviewed.status).toBe('NEEDS_FACTS');
    expect(reviewed.missing).toContainEqual(expect.objectContaining({ predicate: 'FUNCTION', expected: 'BROWNING', have: 'PROPOSED' }));
    expect(dough.swap).toMatchObject({ kind: 'recovery', origin: 'importCard', label: 'Prepared at import (AI)', text: 'If you run out: Milk and cold butter for the heavy cream' });
    expect(brush.swap).toMatchObject({ origin: 'importCard' });
    expect(auth.save(draftId, { expectedRevision: auth.revision(draftId) }).release).toEqual({ kind: 'eligible', coverageSummary: 'No reviewed changes on file · Prepared at import (AI): a card for 6 of 6 uses' });
  });

  it('an uncorroborated technique (none read for step 3): the reviewed rule names what is missing; the card plan is used, labelled AI', async () => {
    const { auth } = await setup(content, SCONE_TEXT_NO_TECHNIQUE);
    const { draftId } = await importText(auth, SCONE_LINES.join('\n'));
    const [dough] = usesOf(auth, draftId, 'heavy cream');
    expect(dough.reviewedFunction).toBeNull();
    expect(auth.requirements(draftId).coverage.find((c) => c.patternId === 'cream_to_butter_milk')!.missing).toContainEqual(expect.objectContaining({ predicate: 'TECHNIQUE', expected: 'MIX_DOUGH' }));
    expect(dough.swap).toMatchObject({ kind: 'recovery', origin: 'importCard' });
  });

  it('a proposed technique without a cue in the step text is not corroborated (no reviewed plan binds)', async () => {
    const wrong = { ...SCONE_READING, steps: SCONE_READING.steps.map((x) => (x.key === 's3' ? { ...x, technique: 'BRUSH' } : x)) };
    const { auth } = await setup(content, wrong);
    const { draftId } = await importText(auth, SCONE_LINES.join('\n'));
    expect(getStep(auth.effective(draftId)!, auth.effective(draftId)!.steps[2].stepId)!.technique!.prov.status).toBe('PROPOSED');
    expect(usesOf(auth, draftId, 'heavy cream')[0].swap.origin).not.toBe('reviewed');
  });

  it('stale revision and stale subject are refused (409); corroboration never records an owner review', async () => {
    const { auth } = await setup();
    const { draftId } = await importText(auth, SCONE_LINES.join('\n'));
    const rev = auth.revision(draftId);
    expect(() => auth.assert(draftId, { expectedRevision: rev + 1, reviewer: 'owner', assertions: [] })).toThrow('STALE_REVISION');
    expect(() => auth.assert(draftId, { expectedRevision: rev, reviewer: 'owner', assertions: [{ subject: { kind: 'STEP', id: 's3' }, predicate: 'TECHNIQUE', value: 'MIX_DOUGH', coreHash: 'wrong' }] })).toThrow('STALE_SUBJECT');
    expect(() => auth.assert(draftId, { expectedRevision: rev, reviewer: '', assertions: [] })).toThrow('REVIEWER_REQUIRED');
    const fx = auth.effective(draftId)!;
    expect([...fx.ingredients.map((i) => i.kind?.prov.by), ...fx.steps.map((s) => s.technique?.prov.by), ...fx.uses.flatMap((u) => u.functions.map((f) => f.prov.by))]).not.toContain('OWNER');
  });
});

describe('shortcake and household risotto imports: no swap, honestly explained', () => {
  it('shortcake: the whipping cream shows the authored refusal; the dough cream is "no for now" with its card\'s step-6 reason', async () => {
    const { auth } = await setup();
    const { draftId } = await importText(auth, SHORTCAKE_LINES.join('\n'));
    const [dough, whip] = usesOf(auth, draftId, 'heavy cream');
    expect(whip.swap).toMatchObject({ kind: 'refusal', text: 'No swap: whipped topping needs cream' });
    expect(whip.swap.details[0]).toMatch(/^This catalog doesn't accept milk and butter in place of cream that has to be whipped/);
    expect(whip.swap.opinion).toMatch(/^No, because this cream has to whip/);                     // the agreeing card is kept beside it
    expect(dough.swap).toMatchObject({ kind: 'refusal', origin: 'importCard', text: "No for now: The cream is also whipped in step 6, and milk and butter can't be whipped." });
  });

  it('B14 household risotto: no swap; it needs the rice weight in grams (never inferred)', async () => {
    const { auth } = await setup();
    const { draftId } = await importText(auth, B14_LINES.join('\n'));
    const [wine] = usesOf(auth, draftId, 'dry white wine');
    expect(wine.swap.kind).toBe('needsFacts');
    expect(wine.swap.text).toMatch(/^We couldn't work out a swap for this one\. A reviewed swap needs .*the rice weight in grams/);   // no recorded analysis here
    expect(auth.save(draftId, { expectedRevision: auth.revision(draftId) }).release).toEqual({ kind: 'eligible', coverageSummary: 'No reviewed changes on file · Prepared at import (AI): a card for 0 of 4 uses' });
    expect(usesOf(auth, draftId, 'butter')[0].swap.text).toBe("We couldn't work out a swap for this one");   // no recorded analysis: fail closed
  });
});

describe('PDF import', () => {
  it('a text-layer PDF reads like the pasted text (same structure, page/line citations)', async () => {
    const { auth } = await setup();
    const r = await auth.createImport({ kind: 'pdf', bytes: sconePdf, filename: 'scones.pdf' });
    if (r.status !== 202) throw new Error('import');
    expect((await auth.waitForJob(r.job.id)).state).toBe('succeeded');
    const d = auth.getDraft(r.draftId);
    expect(d.sources[0]).toMatchObject({ kind: 'pdf', origin: 'upload', displayName: 'scones.pdf', pageCount: 1, pages: [{ index: 1, readable: 'text' }] });
    expect(d.draft.content!.steps).toHaveLength(7);
    expect(d.draft.sourceRefs[d.draft.content!.steps[2].id]).toMatchObject({ page: 1, origin: 'UPLOAD' });
  });

  it('A-3 failures: not a PDF → 400 (nothing created); unreadable scan → failed job; unrecorded document offline → LIVE_EXTRACTION_REQUIRED', async () => {
    const { auth } = await setup();
    expect(await auth.createImport({ kind: 'pdf', bytes: enc('hello'), filename: 'pantry-notes.pdf' })).toMatchObject({ status: 400, error: { code: 'NOT_A_PDF' } });
    const scan = await auth.createImport({ kind: 'pdf', bytes: makePdf([{ image: scanImage() }]), filename: 'scan.pdf' });
    expect(scan.status === 202 && scan.job).toMatchObject({ state: 'failed', failure: { code: 'UNREADABLE' } });
    const other = await importText(auth, 'Toast\n1. Toast the bread.');
    expect(other.job).toMatchObject({ state: 'failed', failure: { code: 'LIVE_EXTRACTION_REQUIRED' } });
  });

  it('idempotency key returns the same job', async () => {
    const { auth } = await setup();
    const a = await auth.createImport({ kind: 'text', text: SCONE_LINES.join('\n') }, 'k-1');
    const b = await auth.createImport({ kind: 'text', text: SCONE_LINES.join('\n') }, 'k-1');
    expect(a.status === 202 && b.status === 202 && a.job.id === b.job.id).toBe(true);
  });
});

describe('A-2 partial PDF + pasted missing steps (C-4)', () => {
  it('page 2 is a scan → partial + missingSteps blocker → save ineligible → paste → blocker cleared by the backend → eligible', async () => {
    const { svc, auth } = await setup();
    const r = await auth.createImport({ kind: 'pdf', bytes: lemonPdf, filename: 'lemon-cake.pdf' });
    if (r.status !== 202) throw new Error('import');
    const job = await auth.waitForJob(r.job.id);
    expect(job.state).toBe('partial');
    let d = auth.getDraft(r.draftId);
    expect(d.sources[0].pages).toEqual([{ index: 1, readable: 'text' }, { index: 2, readable: 'image' }]);
    expect(d.draft.blockers).toEqual([{ id: expect.any(String), kind: 'missingSteps', message: "Steps after step 3 are on page 2, a scanned image that couldn't be read.", resolution: { action: 'appendText', label: 'Paste the missing steps' } }]);
    expect(d.draft.content!.ingredients.find((i) => i.name === 'Self-raising flour')!.uses).toEqual([]);
    const saved1 = auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId) });
    expect(saved1.release).toMatchObject({ kind: 'ineligible', reasons: [{ code: 'MISSING_STEPS', nextAction: 'Paste the missing steps' }] });
    expect(svc.listRecipes().recipes.find((x) => x.recipeId === saved1.recipeId)?.release.kind).toBe('ineligible');
    expect(svc.startRecipe({ commandId: cmd(), recipeId: saved1.recipeId })).toMatchObject({ outcome: 'rejected', code: 'NOT_ELIGIBLE' });

    const appended = auth.appendText(r.draftId, { expectedRevision: auth.revision(r.draftId), text: LEMON_PASTED });
    expect((await auth.waitForJob(appended.job.id)).state).toBe('succeeded');
    d = auth.getDraft(r.draftId);
    expect(d.sources.map((s) => [s.kind, s.origin, s.displayName])).toEqual([['pdf', 'upload', 'lemon-cake.pdf'], ['pastedText', 'cookPasted', 'pasted text']]);
    expect(d.draft.blockers).toEqual([]);
    expect(d.draft.content!.steps).toHaveLength(7);
    expect(d.draft.sourceRefs[d.draft.content!.steps[3].id]).toMatchObject({ origin: 'COOK_PASTED', lineId: 'x1' });
    expect(d.draft.sourceRefs[d.draft.content!.steps[0].id]).toMatchObject({ origin: 'UPLOAD', page: 1 });
    const lemons = d.draft.content!.ingredients.find((i) => i.name === 'Lemons, zest and juice')!;
    expect(lemons.uses.map((u) => [d.draft.content!.steps.find((s) => s.id === u.stepId)!.ordinal, u.proposedFunction?.labels])).toEqual([[4, ['flavor']], [6, ['acidity']]]);
    expect(lemons.uses.every((u) => u.swap.kind === 'none')).toBe(true);
    const saved2 = auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId) });
    expect(saved2.release).toMatchObject({ kind: 'eligible', coverageSummary: expect.stringMatching(/^No reviewed changes on file · Prepared at import \(AI\): a card for 0 of \d+ uses$/) });
    expect(saved2.recipeVersionId).not.toBe(saved1.recipeVersionId);
    expect(svc.startRecipe({ commandId: cmd(), recipeId: saved2.recipeId }).outcome).toBe('started');
  });

  it('facts follow content across re-extraction and retire when their subject is gone', async () => {
    const { auth } = await setup();
    const r = await auth.createImport({ kind: 'pdf', bytes: lemonPdf, filename: 'lemon-cake.pdf' });
    if (r.status !== 202) throw new Error('import');
    await auth.waitForJob(r.job.id);
    const step2 = auth.requirements(r.draftId);   // no rule applies: coverage lists no missing facts
    expect(step2.coverage.flatMap((c) => c.missing)).toEqual([]);
    const core = (await import('../../src/authoring/drafts.ts')).coreHashes(auth.effective(r.draftId)!);
    const step2Id = () => auth.effective(r.draftId)!.steps[1].stepId;   // ids are per reading; facts follow content
    auth.assert(r.draftId, { expectedRevision: auth.revision(r.draftId), reviewer: 'owner', assertions: [{ subject: { kind: 'STEP', id: step2Id() }, predicate: 'TECHNIQUE', value: 'MIX_DOUGH', coreHash: core.get(`STEP|${step2Id()}`)! }] });
    const ap = auth.appendText(r.draftId, { expectedRevision: auth.revision(r.draftId), text: LEMON_PASTED });
    await auth.waitForJob(ap.job.id);
    expect(getStep(auth.effective(r.draftId)!, step2Id())!.technique).toMatchObject({ techniqueId: 'MIX_DOUGH', prov: { status: 'REVIEWED', by: 'OWNER' } });
    // repair changes step 2's text → its fact retires (never silently re-pointed)
    auth.repair(r.draftId, { expectedRevision: auth.revision(r.draftId), edits: [{ kind: 'MERGE_STEPS', stepIds: [step2Id(), auth.effective(r.draftId)!.steps[2].stepId] }] });
    expect(getStep(auth.effective(r.draftId)!, step2Id())!.technique).toBeNull();   // the extraction proposed none; the retired fact no longer applies
    expect(auth.effective(r.draftId)!.steps).toHaveLength(6);
  });
});

describe('validator (buildDraft)', () => {
  const src = (lines: string[]) => { const r = readPastedText(enc(lines.join('\n'))); if (!r.ok) throw new Error('x'); return [{ sourceId: 's', origin: 'UPLOAD' as const, pages: r.source.pages }]; };
  it('schema, reference, no-recipe and fidelity failures create no draft; amounts come only from quoted words', () => {
    expect(buildDraft({ nope: 1 }, vocab, src(SCONE_LINES), 'r', 'e', 'T')).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(buildDraft({ ...SCONE_READING, uses: [{ ...SCONE_READING.uses[0], stepKey: 'zz' }] }, vocab, src(SCONE_LINES), 'r', 'e', 'T')).toMatchObject({ ok: false, code: 'REFERENCE' });
    expect(buildDraft({ ...SCONE_READING, recipeFound: false, steps: [], uses: [] }, vocab, src(SCONE_LINES), 'r', 'e', 'T')).toMatchObject({ ok: false, code: 'NO_RECIPE_FOUND' });
    const invented = { ...SCONE_READING, steps: SCONE_READING.steps.map((s) => ({ ...s, text: `${s.text} Add saffron.` })) };
    expect(buildDraft(invented, vocab, src(SCONE_LINES), 'r', 'e', 'T')).toMatchObject({ ok: false, code: 'FIDELITY' });
    const wrongAmt = { ...SCONE_READING, ingredients: SCONE_READING.ingredients.map((i) => (i.key === 'cream' ? { ...i, amountText: '500 ML' } : i)) };
    const b = buildDraft(wrongAmt, vocab, src(SCONE_LINES), 'r', 'e', 'T');
    expect(b.ok && b.body.recipe.ingredients.find((i) => i.name === 'Heavy cream')!.listed).toEqual({ kind: 'UNSPECIFIED' });
    expect(b.ok && b.body.issues.map((i) => i.code)).toContain('AMOUNT_NOT_IN_QUOTE');
  });

  it('B14 (SYNTHETIC household risotto): exact US conversion; rice weight is a named missing fact, not a guess', () => {
    const lines = ['SYNTHETIC household risotto', 'Serves 4 to 6', '6 cups broth', '1 ½ cups arborio rice', '½ cup dry white wine', '2 tablespoons butter',
      '1. Warm the broth.', '2. Toast the rice.', '3. Pour in the wine and stir until it is absorbed.', '4. Add the broth one ladle at a time.', '5. Off the heat, stir in the butter.'];
    const reading = {
      recipeFound: true, title: 'SYNTHETIC household risotto', yield: 'Serves 4 to 6',
      ingredients: [{ key: 'broth', line: '6 cups broth', name: 'Broth', amountText: '6 cups', kind: 'unsalted-vegetable-stock' }, { key: 'rice', line: '1 ½ cups arborio rice', name: 'Arborio rice', amountText: '1 ½ cups', kind: 'arborio-rice' },
        { key: 'wine', line: '½ cup dry white wine', name: 'Dry white wine', amountText: '½ cup', kind: 'dry-white-wine' }, { key: 'butter', line: '2 tablespoons butter', name: 'Butter', amountText: '2 tablespoons', kind: 'unsalted-butter' }],
      steps: [{ key: 'a', text: 'Warm the broth.', title: 'Warm', technique: 'HEAT_STOCK' }, { key: 'b', text: 'Toast the rice.', title: 'Toast', technique: 'TOAST_RICE' },
        { key: 'c', text: 'Pour in the wine and stir until it is absorbed.', title: 'Wine', technique: 'DEGLAZE' }, { key: 'd', text: 'Add the broth one ladle at a time.', title: 'Ladle', technique: 'LADLE_STOCK' },
        { key: 'e', text: 'Off the heat, stir in the butter.', title: 'Finish', technique: 'OFF_HEAT_FINISH' }],
      uses: [{ ingredientKey: 'rice', stepKey: 'b', quote: 'the rice', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 'wine', stepKey: 'c', quote: 'the wine', amountText: null, functions: ['ACIDITY', 'LIQUID', 'FLAVOR'] },
        { ingredientKey: 'broth', stepKey: 'd', quote: 'the broth', amountText: null, functions: ['LIQUID'] }, { ingredientKey: 'butter', stepKey: 'e', quote: 'the butter', amountText: null, functions: ['FAT'] }],
    };
    const b = buildDraft(reading, vocab, src(lines), 'syn', 'e', 'T');
    if (!b.ok) throw new Error('draft');
    expect(b.body.recipe.volumeSystem).toBe('US');
    const idOf = (name: string) => b.body.recipe.ingredients.find((i) => i.name === name)!.ingredientId;
    const useOf = (name: string) => b.body.recipe.uses.find((u) => u.ingredientId === idOf(name))!.useId;
    const wine = b.body.recipe.uses.find((u) => u.ingredientId === idOf('Dry white wine'))!;
    expect(wine.amount).toMatchObject({ kind: 'EXACT', unit: 'ML', value: { n: 473176473, d: 4000000 }, asWritten: '½ cup' });
    const res = (await_compile(b.body.recipe));
    const cov = res.coverage.find((c) => c.patternId === 'split')!;
    expect(cov.status).toBe('NEEDS_FACTS');
    // 11 facts this rescue reads (9 owner, 2 cook) — versus 69 recipe-wide blocks in the old build
    expect(cov.missing.filter((m) => m.who === 'OWNER')).toHaveLength(9);
    expect(cov.missing.filter((m) => m.who === 'COOK').map((m) => m.subject.id).sort()).toEqual([useOf('Arborio rice'), useOf('Dry white wine')].sort());
    expect(cov.missing.find((m) => m.predicate === 'AMOUNT_EXACT' && m.expected.includes('G'))).toMatchObject({ who: 'COOK', have: 'ML, PROPOSED' });
  });
});

describe('model omissions cannot hide a rule (M2 probe E5 finding)', () => {
  it('a wine use proposed with ACIDITY only still surfaces split as NEEDS_FACTS, listing LIQUID (have: none) for review', () => {
    const lines = ['SYN', 'x', '6 cups broth', '300 g arborio rice', '120 ML dry white wine', '1. Toast the rice.', '2. Pour in the wine.', '3. Add the broth.', '4. Off the heat, rest.'];
    const r = readPastedText(enc(lines.join('\n')));
    if (!r.ok) throw new Error('x');
    const reading = {
      recipeFound: true, title: 'SYN', yield: null,
      ingredients: [{ key: 'b', line: '6 cups broth', name: 'Broth', amountText: '6 cups', kind: null }, { key: 'r', line: '300 g arborio rice', name: 'Arborio rice', amountText: '300 g', kind: 'arborio-rice' },
        { key: 'w', line: '120 ML dry white wine', name: 'Dry white wine', amountText: '120 ML', kind: 'dry-white-wine' }],
      steps: [{ key: 's1', text: 'Toast the rice.', title: 'Toast', technique: 'TOAST_RICE' }, { key: 's2', text: 'Pour in the wine.', title: 'Wine', technique: 'DEGLAZE' },
        { key: 's3', text: 'Add the broth.', title: 'Broth', technique: 'LADLE_STOCK' }, { key: 's4', text: 'Off the heat, rest.', title: 'Finish', technique: 'OFF_HEAT_FINISH' }],
      uses: [{ ingredientKey: 'r', stepKey: 's1', quote: 'the rice', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 'w', stepKey: 's2', quote: 'the wine', amountText: null, functions: ['ACIDITY'] },
        { ingredientKey: 'b', stepKey: 's3', quote: 'the broth', amountText: null, functions: ['LIQUID'] }],
    };
    const b = buildDraft(reading, vocab, [{ sourceId: 's', origin: 'UPLOAD', pages: r.source.pages }], 'syn', 'e', 'T');
    if (!b.ok) throw new Error('draft');
    const cov = await_compile(b.body.recipe).coverage.find((c) => c.patternId === 'split')!;
    expect(cov.status).toBe('NEEDS_FACTS');
    expect(cov.missing).toContainEqual(expect.objectContaining({ predicate: 'FUNCTION', expected: 'LIQUID', have: null, who: 'OWNER' }));
    expect(cov.missing).toContainEqual(expect.objectContaining({ predicate: 'KIND_CLASS', expected: 'cooking-stock', have: null }));   // broth kind unknown to vocabulary
  });
});

import { compile } from '../../src/compile/binder.ts';
import { ING, RECIPE } from '../fixtures/ids.ts';
const await_compile = (r: Parameters<typeof compile>[0]) => compile(r, vocab, content.patterns).pack!;
