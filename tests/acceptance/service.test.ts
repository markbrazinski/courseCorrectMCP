// Service/transaction acceptance (ESOD §7, §10; FE–BE v1 A-4…A-12). Real SQLite file per test.
import { describe, expect, it } from 'vitest';
import { hash } from '../../src/domain/rational.ts';
import { ENGINE_SEMANTICS } from '../../src/contract/types.ts';
import { Service } from '../../src/service/commands.ts';
import { cmd, content, newService, pack, startAt } from '../helpers.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { ING, RECIPE, STEP, USE } from '../fixtures/ids.ts';

const WINE = "I don't have any white wine. Can I use lemon juice?";

async function risottoProposal(svc: Service) {
  const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
  const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
  const e1 = await svc.evaluateRescue({ commandId: cmd(), ...base, utterance: { text: WINE, channel: 'voice' } });
  if (e1.outcome !== 'needsFacts') throw new Error(JSON.stringify(e1));
  const e2 = await svc.evaluateRescue({ commandId: cmd(), ...base, previousEvaluationId: e1.id, answers: e1.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) });
  if (e2.outcome !== 'proposal') throw new Error(JSON.stringify(e2));
  return { run, base, e1, e2, cand: e2.candidates[0] };
}
const count = (svc: Service, table: string) => svc.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

describe('A-4 start / resume, C-3 explicit replacement (B34)', () => {
  it('start, read back, refuse a second start, then replace only with exact identity and confirmation', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], null);
    expect(svc.getActiveRecipe().run?.id).toBe(run.id);
    const sc = pack(RECIPE['scones.demo']);
    const blocked = svc.startRecipe({ commandId: cmd(), recipeId: RECIPE['scones.demo'] });
    expect(blocked).toMatchObject({ outcome: 'rejected', code: 'ACTIVE_RUN_EXISTS', activeRun: { runId: run.id, recipeTitle: 'Risotto with Parmesan' } });
    expect(svc.startRecipe({ commandId: cmd(), recipeId: RECIPE['scones.demo'], replace: { runId: run.id, epoch: run.epoch, expectedRevision: run.revision + 1, confirm: true } })).toMatchObject({ code: 'STALE_STATE' });
    expect(svc.startRecipe({ commandId: cmd(), recipeId: RECIPE['scones.demo'], replace: { runId: run.id, epoch: run.epoch, expectedRevision: run.revision, confirm: false } })).toMatchObject({ code: 'REPLACE_NOT_CONFIRMED' });
    const replaced = svc.startRecipe({ commandId: cmd(), recipeId: RECIPE['scones.demo'], recipeVersionId: sc.recipeHash, replace: { runId: run.id, epoch: run.epoch, expectedRevision: run.revision, confirm: true } });
    expect(replaced.outcome).toBe('started');
    expect(svc.store.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', run.id)!.status).toBe('ARCHIVED');   // history preserved
    const late = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: STEP['r.heat'], progress: 'done' });
    expect(late).toMatchObject({ outcome: 'rejected', code: 'RUN_EXPIRED' });
  });
});

describe('A-5 progress (forward-only, idempotent)', () => {
  it('double submit with the same commandId records once; regression rejected; stale revision rejected', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['shortcake.demo'], null);
    const input = { commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: STEP['k.heat'], progress: 'done' as const };
    const a = svc.recordProgress(input), b = svc.recordProgress(input);
    expect(a).toMatchObject({ outcome: 'recorded', code: 'PROGRESS_RECORDED' });
    expect(b).toMatchObject({ outcome: 'recorded', replayed: true });
    expect(count(svc, 'progress_events')).toBe(1);
    const rev = a.outcome === 'recorded' ? a.run.revision : -1;
    expect(svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: rev, stepId: STEP['k.heat'], progress: 'started' })).toMatchObject({ code: 'REGRESSION' });
    expect(svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: rev - 1, stepId: STEP['k.dry'], progress: 'done' })).toMatchObject({ code: 'STALE_STATE' });
    const partly = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: rev, stepId: STEP['k.dry'], progress: 'partly', addedUseIds: [USE['k.flour']] });
    expect(partly.outcome === 'recorded' && partly.run.steps.find((s) => s.stepId === STEP['k.dry'])).toMatchObject({ progress: 'partly', partialUseIds: [USE['k.flour']] });
  });

  it('B23: missing commandId or expectedRevision → INVALID_COMMAND; reused id with different payload → COMMAND_ID_REUSE', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['shortcake.demo'], null);
    expect(svc.recordProgress({ runId: run.id, epoch: run.epoch, expectedRevision: 0, stepId: STEP['k.heat'], progress: 'done' })).toMatchObject({ code: 'INVALID_COMMAND' });
    expect(svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, stepId: STEP['k.heat'], progress: 'done' })).toMatchObject({ code: 'INVALID_COMMAND' });
    expect(await svc.evaluateRescue({ runId: run.id, epoch: run.epoch, expectedRevision: 0, missingIngredientId: ING['cream'] })).toMatchObject({ code: 'INVALID_COMMAND' });
    expect(svc.startRecipe({ recipeId: RECIPE['risotto.demo'] })).toMatchObject({ code: 'INVALID_COMMAND' });
    const id = cmd();
    svc.recordProgress({ commandId: id, runId: run.id, epoch: run.epoch, expectedRevision: 0, stepId: STEP['k.heat'], progress: 'done' });
    expect(svc.recordProgress({ commandId: id, runId: run.id, epoch: run.epoch, expectedRevision: 0, stepId: STEP['k.dry'], progress: 'done' })).toMatchObject({ code: 'COMMAND_ID_REUSE' });
  });
});

describe('A-7 risotto rescue to resumed cooking (B20, B21)', () => {
  it('needsFacts → proposal → apply → step 5 current and not started → done advances to 6', async () => {
    const { svc } = newService();
    const { base, e1, e2, cand } = await risottoProposal(svc);
    expect(e1.speech.text).toBe('To check this, I need to know: do you have 120 ML more hot unsalted vegetable stock and 10 ML lemon juice?');
    expect(count(svc, 'amendments')).toBe(0);                             // B20: answering never applies
    const statusBefore = svc.store.get<{ step_status: string; use_status: string }>('SELECT step_status, use_status FROM runs WHERE run_id = ?', base.runId)!;
    const applied = svc.applyAmendment({ commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true });
    expect(applied.outcome).toBe('applied');
    if (applied.outcome !== 'applied') return;
    expect(applied.resume.text).toBe('Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.');
    expect(applied.run.currentStepId).toBe(STEP['r.deglaze']);
    expect(applied.run.steps.find((s) => s.stepId === STEP['r.deglaze'])).toMatchObject({ progress: 'notStarted', originalText: 'Pour in 120 ML dry white wine and stir until absorbed.' });
    const statusAfter = svc.store.get<{ step_status: string }>('SELECT step_status FROM runs WHERE run_id = ?', base.runId)!;
    expect(statusAfter.step_status).toBe(statusBefore.step_status);       // B21: apply completes nothing
    const read = svc.getActiveRecipe();
    expect(read.recipe!.steps.find((s) => s.id === STEP['r.deglaze'])!.title).toBe('Add the stock');
    expect(read.recipe!.ingredients.find((i) => i.id === ING['wine'])!.removedByAmendment).toBe(true);
    const next = svc.recordProgress({ commandId: cmd(), runId: base.runId, epoch: base.epoch, expectedRevision: applied.run.revision, stepId: STEP['r.deglaze'], progress: 'done' });
    expect(next.outcome === 'recorded' && next.run.currentStepId).toBe(STEP['r.ladle']);
  });

  it('A-6: correcting the ingredient re-evaluates with the chosen id and changes nothing', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: ING['parm'], utterance: { text: 'parmesan', channel: 'tapped' } });
    expect(res).toMatchObject({ outcome: 'refused', refusal: { kind: 'noReviewedRecovery' } });
    expect(count(svc, 'amendments')).toBe(0);
  });

  it('B16: with no interpreter, free text fails closed to a reference menu; no state change', async () => {
    const { svc } = newService({ recorded: false });
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: WINE, channel: 'voice' } });
    expect(res).toMatchObject({ outcome: 'needsInterpretation', prompt: 'Which ingredient are you out of?' });
    expect(svc.getActiveRecipe().run!.revision).toBe(run.revision);
  });
});

describe('A-8 / A-11 stale and protected (B10)', () => {
  it('progress between proposal and apply → apply rejected STALE_STATE, no amendment; check again → protectedWork', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    const started = svc.recordProgress({ commandId: cmd(), ...base, stepId: STEP['r.deglaze'], progress: 'started' });
    if (started.outcome !== 'recorded') throw new Error('progress');
    expect(svc.getActiveRecipe().latestEvaluation!.actionable).toBe(false);
    const stale = svc.applyAmendment({ commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true });
    expect(stale).toMatchObject({ outcome: 'rejected', code: 'STALE_STATE' });
    const fresh = svc.applyAmendment({ commandId: cmd(), ...base, expectedRevision: started.run.revision, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true });
    expect(fresh).toMatchObject({ outcome: 'rejected', code: 'STALE_STATE' });     // evaluation base revision is old
    expect(count(svc, 'amendments')).toBe(0);
    const again = await svc.evaluateRescue({ commandId: cmd(), ...base, expectedRevision: started.run.revision, previousEvaluationId: e2.id });
    expect(again).toMatchObject({ outcome: 'refused', refusal: { kind: 'protectedWork', stepId: STEP['r.deglaze'], progress: 'started' } });
  });

  it('acceptance is explicit and plan identity is checked', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    expect(svc.applyAmendment({ commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId })).toMatchObject({ code: 'ACCEPTANCE_REQUIRED' });
    expect(svc.applyAmendment({ commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: 'not-the-plan', accepted: true })).toMatchObject({ code: 'PLAN_MISMATCH' });
  });
});

describe('A-9 / A-10 refusals', () => {
  it('A-9 shortcake: functionallyUnsupported, no Apply', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['shortcake.demo'], 'shortcake.step6');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I'm out of heavy cream. Can I use milk and butter to whip instead?", channel: 'voice' } });
    expect(res).toMatchObject({ outcome: 'refused', actionable: false, refusal: { kind: 'functionallyUnsupported', unchanged: 'Your recipe is unchanged. Step 6 still needs 240 ML heavy cream.' } });
  });
  it('A-10 "I don\'t have this" on an ingredient with no rule → noReviewedRecovery that does not claim nothing works', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: ING['stock'], utterance: { text: ING['stock'], channel: 'tapped' } });
    expect(res.outcome === 'refused' && res.refusal).toMatchObject({ kind: 'noReviewedRecovery' });
    expect(res.outcome === 'refused' && res.refusal.kind === 'noReviewedRecovery' && res.refusal.message).toContain("isn't a judgement that nothing else could work");
  });
});

describe('A-12 lost response, reconciliation (§4.2h), one rescue per run (B12, B22)', () => {
  it('applied once; identical retry replays alreadyApplied; status read reports applied', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    const input = { commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true as const };
    svc.applyAmendment(input);                                        // response "lost"
    expect(svc.getActiveRecipe({ commandId: input.commandId }).command).toMatchObject({ receipt: 'DONE', status: 'applied' });
    expect(svc.applyAmendment(input)).toMatchObject({ outcome: 'alreadyApplied', replayed: true });
    expect(count(svc, 'amendments')).toBe(1);
  });

  it('receipt NONE or PENDING → unknown (never notApplied); an identical resend then executes once', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    const input = { commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true as const };
    expect(svc.getActiveRecipe({ commandId: input.commandId, runId: base.runId }).command).toMatchObject({ receipt: 'NONE', status: 'unknown' });
    svc.store.run(`INSERT INTO receipts VALUES (?, 'pending-1', 'apply_amendment', ?, 'x', 'PENDING', NULL, 'now')`, svc.kitchenId, base.runId);
    expect(svc.getActiveRecipe({ commandId: 'pending-1' }).command).toMatchObject({ receipt: 'PENDING', status: 'unknown' });
    expect(svc.applyAmendment(input).outcome).toBe('applied');        // "Retry confirmation": identical command
    expect(svc.getActiveRecipe({ commandId: input.commandId }).command?.status).toBe('applied');
  });

  it('the same proposal applied by another command is appliedOther (checked before notApplied); one change per version (B22, ENGINE_SEMANTICS 2)', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    const a = { commandId: cmd(), ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true as const };
    const b = { ...a, commandId: cmd() };
    expect(svc.applyAmendment(a).outcome).toBe('applied');
    const second = svc.applyAmendment(b);
    expect(second.outcome).toBe('rejected');                          // stored DONE refusal (authoritative)
    expect(svc.getActiveRecipe({ commandId: b.commandId, evaluationId: e2.id }).command).toMatchObject({ receipt: 'DONE', status: 'appliedOther' });
    expect(svc.getActiveRecipe({ commandId: b.commandId }).command).toMatchObject({ receipt: 'DONE', status: 'notApplied' });   // without the evaluation: its own refusal
    expect(svc.getActiveRecipe().run!.appliedAmendments).toHaveLength(1);
    expect(() => svc.store.run(`INSERT INTO amendments VALUES ('dup', ?, 'e', 'c', 'p', 'k', 1, 2, 9, '[]', 'now')`, base.runId)).toThrow();
  });

  it('confirmed notApplied comes only from an authoritative refusal receipt; resending it replays the refusal', async () => {
    const { svc } = newService();
    const { base, e2, cand } = await risottoProposal(svc);
    const bad = { commandId: cmd(), ...base, expectedRevision: base.expectedRevision + 7, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true as const };
    expect(svc.applyAmendment(bad)).toMatchObject({ code: 'STALE_STATE' });
    expect(svc.getActiveRecipe({ commandId: bad.commandId }).command).toMatchObject({ receipt: 'DONE', status: 'notApplied' });
    expect(svc.applyAmendment(bad)).toMatchObject({ code: 'STALE_STATE', replayed: true });   // C-1: never applies under the same id
  });

  it('run replaced → runReplaced', async () => {
    const { svc } = newService();
    const { base } = await risottoProposal(svc);
    const id = cmd();
    svc.store.run(`INSERT INTO receipts VALUES (?, ?, 'apply_amendment', ?, 'x', 'DONE', '{"outcome":"rejected","code":"STALE_STATE"}', 'now')`, svc.kitchenId, id, base.runId);
    svc.adminReset('scones.step3');
    expect(svc.getActiveRecipe({ commandId: id }).command?.status).toBe('runReplaced');
  });
});

describe('B24 interrupted interpretation, B25 reset, B27 identity', () => {
  it('B24: crash between reserve and publish → INTERRUPTED, never actionable; retry with the same id says INTERRUPTED', async () => {
    const { svc, dbPath } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const id = cmd();
    svc.store.run(`INSERT INTO receipts VALUES (?, ?, 'evaluate_rescue', ?, ?, 'PENDING', NULL, 'now')`, svc.kitchenId, id, run.id,
      hash({ tool: 'evaluate_rescue', input: { runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: ING['wine'] } }));
    svc.store.run(`INSERT INTO evaluations(evaluation_id, run_id, base_revision, version, state, request_json, at) VALUES ('ev-crash', ?, ?, 1, 'PENDING', '{}', 'now')`, run.id, run.revision);
    svc.close();
    const svc2 = new Service({ dbPath, content, interpreter: noneInterpreter });
    expect(svc2.store.get<{ state: string }>(`SELECT state FROM evaluations WHERE evaluation_id = 'ev-crash'`)!.state).toBe('INTERRUPTED');
    expect(await svc2.evaluateRescue({ commandId: id, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: ING['wine'] })).toMatchObject({ code: 'INTERRUPTED' });
    expect(svc2.getActiveRecipe().latestEvaluation).toBeNull();
  });

  it('B25: reset → new runId, epoch+1, old commands RUN_EXPIRED, state hash stable across 3 resets', async () => {
    const { svc } = newService();
    const old = await startAt(svc, RECIPE['risotto.demo'], null);
    const hashes = [1, 2, 3].map(() => { const r = svc.adminReset('risotto.step5'); if (!r.ok) throw new Error(r.code); return r; });
    expect(new Set(hashes.map((h) => h.stateHash)).size).toBe(1);
    expect(new Set(hashes.map((h) => h.runId)).size).toBe(3);
    expect(hashes[2].epoch).toBe(old.epoch + 3);
    expect(svc.recordProgress({ commandId: cmd(), runId: old.id, epoch: old.epoch, expectedRevision: 0, stepId: STEP['r.heat'], progress: 'done' })).toMatchObject({ code: 'RUN_EXPIRED' });
    expect(svc.getActiveRecipe().run!.currentStepId).toBe(STEP['r.deglaze']);
  });

  it('B27: pack identity is content + ENGINE_SEMANTICS only (no code hash)', () => {
    const p = pack(RECIPE['risotto.demo']);
    expect(p.packHash).toBe(hash({ recipeHash: p.recipeHash, vocabularyHash: p.vocabularyHash, patternSetHash: p.patternSetHash, engineSemantics: ENGINE_SEMANTICS }));
  });
});
