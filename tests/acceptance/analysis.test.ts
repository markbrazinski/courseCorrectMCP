// Per-use import analysis (FE–BE Contract v1 Amendment 1, reconciled 2026-10-06). RECORDED readings and hand-written card
// fixtures (validator/compiler evidence, not Nova evidence, not culinary review). Every use has exactly one status; plans are
// the engine's own previews; the import plan id is the id the cooking engine offers for the same plan.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { recordedExtractor } from '../../src/authoring/extract.ts';
import { recordedAnalyzer, type SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { Service } from '../../src/service/commands.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { DEMO, demoPdf, recordedDemo, SCONE_CARDS } from '../fixtures/demo-cards.ts';
import { SCONE_PDF_READING } from '../fixtures/demo-sources.ts';
import { cmd, content, vocab, newKv, newWs } from '../helpers.ts';

const rec = await recordedDemo(vocab);
const scone = DEMO.find((d) => d.name === 'scones')!;

async function importScone(analyzer: SwapAnalyzer = recordedAnalyzer(rec.cards), wait = true, readings = rec.readings) {
  const svc = new Service({ kv: newKv(join(mkdtempSync(join(tmpdir(), 'ccmcp-analysis-')), 'db')), ws: newWs(), content, interpreter: noneInterpreter, fixtureRecipes: false });
  const auth = new Authoring({ kv: svc.kv, ws: svc.ws, content, extractor: recordedExtractor(readings), analyzer });
  svc.catalog = (t) => auth.catalogIn(t);
  const r = await auth.createImport({ kind: 'pdf', bytes: demoPdf(scone.lines), filename: 'scones.pdf' });
  if (r.status !== 202) throw new Error('import');
  if (wait) await auth.waitForJob(r.job.id);
  const uses = async () => {
    const c = (await auth.getDraft(r.draftId)).draft.content!;
    return c.ingredients.flatMap((i) => i.uses.map((u) => ({ name: i.name, step: c.steps.find((s) => s.id === u.stepId)!.ordinal, ...u })));
  };
  return { svc, auth, draftId: r.draftId, jobId: r.job.id, uses };
}
const at = <T extends { name: string; step: number }>(us: T[], name: string, step: number) => us.find((u) => u.name.toLowerCase() === name && u.step === step)!;

describe('every use has exactly one analysis status', () => {
  it('scones (recorded cards): real plan contents from the engine; the brushing cream shares the dough plan', async () => {
    const { uses } = await importScone();
    const us = await uses();
    expect(us.length).toBe(6);
    expect(us.every((u) => u.analysis && u.analysis.status)).toBe(true);
    const dough = at(us, 'heavy cream', 3), brush = at(us, 'heavy cream', 6);
    expect(dough.analysis).toMatchObject({ status: 'available', reason: null, coveredByUseId: null, sharedWithUseIds: [brush.id] });
    const p = dough.analysis!.plans[0];
    expect(p).toMatchObject({ ruleId: 'cream_to_butter_milk@1', title: 'Butter and milk for cream in a dough', provenance: { kind: 'reviewedRule', label: 'Reviewed change' },
      contentStatus: { label: 'Engineering content · provisional quantities · not released cooking guidance', provisional: true },
      consequence: { text: 'These become butter scones: the texture will be a little less rich and tender than cream scones.' } });
    expect(p.replacements.map((x) => [x.ingredientName, x.amount.display, x.preparation])).toEqual(expect.arrayContaining([
      ['Butter', '85 g', 'cold'], ['Milk', '180 ML, plus up to 30 ML more if needed', null], ['Milk', 'a little', null]]));
    expect(p.replacements.find((x) => x.amount.kind === 'conditional')!.condition).toMatch(/^Add it 1 tablespoon at a time/);
    expect(p.removals.map((x) => x.useId).sort()).toEqual([dough.id, brush.id].sort());
    expect(p.stepEffects.map((x) => x.effect)).toEqual(['changes', 'changes']);
    expect(p.stepEffects[1].after!.filter((s) => s.kind === 'inserted').map((s) => s.text)).toEqual(['milk']);
    expect(p.provenance.basis).toContain('Amounts worked out from the listed 300 ML heavy cream (read from the source)');
    expect(p.runtimeConditions.filter((x) => x.kind === 'availability').map((x) => x.text)).toEqual(expect.arrayContaining(['85 g cold butter']));
    expect(brush.analysis).toMatchObject({ status: 'available', coveredByUseId: dough.id, sharedWithUseIds: [dough.id] });
    expect(brush.analysis!.plans[0].planId).toBe(p.planId);
    // the cards' own answers: a "no" is evaluated with no option (the card's reason, verbatim); an omit is an AI plan
    expect(at(us, 'plain flour', 2).analysis).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'aiSaysNo', text: SCONE_CARDS.cards[0].opinion } });
    // a reviewed refusal of one replacement (oat flour for all of it) sits beside that answer; it never becomes the answer (batch 1, G13)
    expect(at(us, 'plain flour', 2).analysis!.ruledOut.map((x) => x.ruleId)).toEqual(['oat_flour_for_all_flour_not_offered@1']);
    // batch 1: the reviewed caster → granulated plan supersedes the sugar card's omission; the salt's omission stays an AI plan
    expect(at(us, 'caster sugar', 2).analysis!.plans[0]).toMatchObject({ ruleId: 'caster_to_granulated@1', provenance: { kind: 'reviewedRule', label: 'Reviewed change' } });
    expect(at(us, 'salt', 2).analysis!.plans[0]).toMatchObject({ title: 'Leave out the salt', provenance: { kind: 'aiPrepared', label: 'Prepared at import (AI)' }, ruleId: null });
  });

  it('saving carries the analysis onto the saved version; cooking offers the same plan id (shared id space)', async () => {
    const { svc, auth, draftId, uses } = await importScone();
    const before = await uses();
    const saved = await auth.save(draftId, { expectedRevision: await auth.revision(draftId) });
    const page = (await auth.getRecipe(saved.recipeId)).version.content!;
    const after = page.ingredients.flatMap((i) => i.uses);
    expect(after.map((u) => [u.id, u.analysis!.status, u.analysis!.plans.map((p) => p.planId)])).toEqual(before.map((u) => [u.id, u.analysis!.status, u.analysis!.plans.map((p) => p.planId)]));
    // start the saved import, reach step 3, ask about the cream: the candidate is the plan the import showed
    const st = await svc.startRecipe({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: saved.recipeVersionId });
    if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
    expect(st.run.recipeVersionId).toBe(saved.recipeVersionId);
    expect(st.recipe.ingredients.flatMap((i) => i.uses.map((u) => u.id))).toEqual(after.map((u) => u.id));
    let run = st.run;
    for (const s of st.recipe.steps.slice(0, 2)) { const r = await svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' }); if (r.outcome !== 'recorded') throw new Error(r.code); run = r.run; }
    const cream = st.recipe.ingredients.find((i) => i.name === 'heavy cream')!;
    const ev = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: cream.id, proposedKindIds: [], utterance: { text: 'out of cream', channel: 'tapped' } });
    if (ev.outcome !== 'needsFacts') throw new Error(ev.outcome);
    expect(ev.previews[0].id).toBe(at(before, 'heavy cream', 3).analysis!.plans[0].planId);
    expect((await svc.getActiveRecipe()).recipe!.ingredients.flatMap((i) => i.uses).every((u) => u.analysis === null)).toBe(true);   // cooking never carries previews
  });
});

describe('a recipe edit invalidates the analysis it affects', () => {
  it('an edit to the reading (owner repair: merge steps 4 and 5): the AI cards no longer apply; machine-checked roles and the reviewed rule are recomputed', async () => {
    const { auth, draftId, uses } = await importScone();
    expect(at(await uses(), 'salt', 2).analysis!.status).toBe('available');   // its card's omission (AI only)
    const e = (await auth.effective(draftId))!;
    await auth.repair(draftId, { expectedRevision: await auth.revision(draftId), edits: [{ kind: 'MERGE_STEPS', stepIds: [e.steps[3].stepId, e.steps[4].stepId] }] });
    const after = await uses();
    expect(after.map((u) => u.step)).toEqual([2, 2, 2, 2, 3, 5]);                 // the brushing step is now step 5
    expect(at(after, 'salt', 2).analysis).toMatchObject({ status: 'unexamined', reason: { code: 'contentChanged', detail: 'import card: STALE_ANALYSIS' } });
    expect(at(after, 'caster sugar', 2).analysis).toMatchObject({ status: 'available', plans: [{ ruleId: 'caster_to_granulated@1' }] });   // reviewed: recomputed, not stale
    expect(at(after, 'heavy cream', 3).analysis).toMatchObject({ status: 'available', plans: [{ ruleId: 'cream_to_butter_milk@1' }] });
    expect(at(after, 'heavy cream', 5).analysis!.coveredByUseId).toBe(at(after, 'heavy cream', 3).id);
  });
});

describe('pending, not evaluated, failed and blocked stay distinct', () => {
  it('pending while the swap analysis runs; then the real result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const slow: SwapAnalyzer = { name: 'GATED', analyze: async (m, v, k, l) => { await gate; return recordedAnalyzer(rec.cards).analyze(m, v, k, l); } };
    const { auth, jobId, uses } = await importScone(slow, false);
    for (let i = 0; i < 50 && !(await auth.job(jobId)).stagesCompleted.includes('uses'); i++) await new Promise((ok) => setTimeout(ok, 10));
    // R-1: the cream's roles are machine-checked from the approved table, so its reviewed plan doesn't wait for the AI analysis
    // batch 1: the caster sugar and baking powder have reviewed plans too, so they don't wait either
    expect((await uses()).map((u) => `${u.name} ${u.step}: ${u.analysis!.status}`)).toEqual(['plain flour 2: pending', 'caster sugar 2: available', 'baking powder 2: available', 'salt 2: pending', 'heavy cream 3: available', 'heavy cream 6: available']);
    release();
    await auth.waitForJob(jobId);
    expect((await uses()).map((u) => u.analysis!.status)).not.toContain('pending');
  });

  it('no analysis ran → not evaluated; a failed call → failed; a card that fails validation → failed (never "no option")', async () => {
    const none = await importScone(recordedAnalyzer({}));
    expect(new Set((await none.uses()).map((u) => u.analysis!.status))).toEqual(new Set(['unexamined', 'available']));   // the cream: R-1 roles + reviewed rule, no AI needed
    expect(at((await none.uses()), 'plain flour', 2).analysis!.reason).toMatchObject({ code: 'notRun', detail: expect.stringContaining('LIVE_ANALYSIS_REQUIRED') });
    const down: SwapAnalyzer = { name: 'DOWN', analyze: async () => ({ ok: false, error: 'BUDGET_EXCEEDED', detail: 'cap', analyzer: 'DOWN', usage: null, costUsd: 0 }) };
    expect(at(await (await importScone(down)).uses(), 'plain flour', 2).analysis).toMatchObject({ status: 'failed', reason: { code: 'analysisError' } });
    const key = Object.keys(rec.cards).find((k) => (rec.cards[k] as typeof SCONE_CARDS).cards.length === 6 && JSON.stringify(rec.cards[k]).includes('U6'))!;
    const bad = structuredClone(rec.cards) as Record<string, { cards: Record<string, unknown>[] }>;
    bad[key].cards[3] = { ...bad[key].cards[3], tradeoff: null };   // salt omit without a tradeoff (the sugar now has a reviewed plan)
    expect(at(await (await importScone(recordedAnalyzer(bad))).uses(), 'salt', 2).analysis).toMatchObject({ status: 'failed', reason: { code: 'validationFailed', detail: 'import card: TRADEOFF_MISSING; correction round: NOT_RUN (FAILED_CALL:LIVE_ANALYSIS_REQUIRED)' } });   // offline: the one correction round has no recording
  });

  it('R-1 roles are MACHINE_CHECKED with their table row; an unconfirmed technique leaves the role unresolved and the rule blocked, named in plain words', async () => {
    const { uses } = await importScone(recordedAnalyzer({}));   // no AI cards at all
    const dough = at(await uses(), 'heavy cream', 3);
    expect(dough.reviewedFunction).toMatchObject({ labels: ['liquid', 'fat'], authority: 'MACHINE_CHECKED', reviewId: expect.stringMatching(/^roles\.json#heavy-cream×MIX_DOUGH \(content-decisions\.md#OD-4; R-1\)$/) });
    expect(dough.analysis!.plans[0].provenance.basis[0]).toBe('What the cream does in step 3 (liquid, fat): machine-checked against the approved role table (heavy-cream×MIX_DOUGH (content-decisions.md#OD-4; R-1))');
    // the reading gave step 3 no technique: nothing confirms the dough cream's role, so it stays unresolved (never inferred)
    const key = Object.keys(rec.readings).find((k) => rec.readings[k] === SCONE_PDF_READING)!;
    const noTech = { ...rec.readings, [key]: { ...SCONE_PDF_READING, steps: SCONE_PDF_READING.steps.map((x) => (x.key === 'step_3' ? { ...x, technique: null } : x)) } };
    const b = await importScone(recordedAnalyzer({}), true, noTech);
    const a = at((await b.uses()), 'heavy cream', 3);
    expect(a.reviewedFunction).toBeNull();
    expect(a.analysis).toMatchObject({ status: 'blocked', plans: [], reason: { code: 'missingFact' } });
    expect(a.analysis!.reason!.text).toBe("CourseCorrect couldn't confirm what the cream does in step 3 and how step 3 is done from this reading, so the reviewed alternative (butter and milk for cream in a dough) can't be offered.");
  });
});
