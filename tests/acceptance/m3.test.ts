// M3 server additions: speech may read only service-rendered text; the ledger refuses a purpose the authorization does
// not name; a corrected ingredient reference keeps what the cook asked about.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetExceeded, Ledger, type Authorization } from '../../src/authoring/nova.ts';
import { onlyNamed, recordedInterpreter } from '../../src/service/interpret.ts';
import { cmd, newService, startAt } from '../helpers.ts';
import { ING, RECIPE } from '../fixtures/ids.ts';

const auth = (maxCalls: Authorization['maxCalls']): Authorization => ({ id: `t-${Math.random()}`, grantedBy: 'test', at: '2026-10-02', maxCalls, maxUsd: 0.1, projectCeilingUsd: 5, priorProjectUsd: 0, profile: 'none' });

describe('ledger caps (money path)', () => {
  it('a purpose the authorization does not name is not authorized; named caps hold', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cc-ledger-')), 'l.jsonl');
    expect(() => new Ledger(file, auth({ extraction: 1, interpretation: 1 })).reserve('speech', 'k0', 0.001, 'x')).toThrow(BudgetExceeded);
    const l = new Ledger(file, auth({ speech: 1 }));
    l.reserve('speech', 'k1', 0.001, 'x');
    l.settleChars('speech', 'k1', 60, 0.00096, 'x');
    expect(() => l.reserve('speech', 'k2', 0.001, 'x')).toThrow(/call cap 1/);
    expect(l.totals()).toMatchObject({ calls: { speech: 1 } });
    expect(l.totals().authorizationUsd).toBeCloseTo(0.00096, 8);
  });
});

describe('speech text is only what the service rendered', () => {
  it('evaluation speech and step text by reference; nothing else', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const ev = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I don't have any white wine. Can I use lemon juice?", channel: 'typed' } });
    if (ev.outcome === 'rejected') throw new Error(ev.code);
    expect(svc.speechText({ evaluationId: ev.id })).toBe(ev.speech.text);
    expect(svc.speechText({ runId: run.id, stepId: run.steps[4].stepId })).toBe('Step 5. Pour in 120 ML dry white wine and stir until absorbed.');
    expect(svc.speechText({ runId: run.id, stepId: 'nope' })).toBeNull();
    expect(svc.speechText({ evaluationId: 'nope' })).toBeNull();
    expect(svc.speechText({ text: 'say anything' } as never)).toBeNull();
    // "Change applied." only for an amendment this run holds: never before the server confirms
    expect(svc.speechText({ runId: run.id, stepId: run.steps[4].stepId, amendmentId: 'am_not_applied' })).toBeNull();
    const yes = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, previousEvaluationId: ev.id, answers: ev.outcome === 'needsFacts' ? ev.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) : [] });
    if (yes.outcome !== 'proposal') throw new Error(yes.outcome);
    const ap = svc.applyAmendment({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, evaluationId: yes.id, candidateId: yes.candidates[0].id, planId: yes.candidates[0].planId, accepted: true });
    if (ap.outcome !== 'applied') throw new Error(ap.outcome);
    expect(svc.speechText({ runId: run.id, stepId: ap.resume.stepId, amendmentId: ap.amendment.id })).toBe(`Change applied. Step 5. ${ap.resume.text}`);
  });
});

describe('RECORDED interpreter resolves a recorded kind against the active recipe (no model call)', () => {
  it('one name match → that ingredient; none or several → asked, not guessed', async () => {
    const rec = recordedInterpreter({ 'out of cream': { missingKindId: 'heavy-cream', proposedKindIds: ['whole-milk'] } });
    const kinds = [{ id: 'heavy-cream', label: 'heavy cream', aliases: ['cream'] }, { id: 'whole-milk', label: 'whole milk', aliases: [] }];
    const one = await rec.interpret('Out of cream', { ingredients: [{ id: 'ing_x', name: 'Heavy cream' }, { id: 'ing_y', name: 'plain flour' }], kinds });
    expect(one).toMatchObject({ ok: true, intent: { missingIngredientId: 'ing_x', proposedKindIds: ['whole-milk'] } });
    expect(one.summary).toMatch(/^RECORDED interpreter: missing = ing_x \(recorded kind heavy-cream/);
    for (const ingredients of [[{ id: 'a', name: 'butter' }], [{ id: 'a', name: 'cream' }, { id: 'b', name: 'heavy cream' }]]) {
      expect(await rec.interpret('out of cream', { ingredients, kinds })).toMatchObject({ ok: true, intent: { missingIngredientId: null } });
    }
  });
});

describe('“Not this ingredient” keeps the proposal', () => {
  it('a corrected reference re-evaluates with the stored proposed kinds (no interpreter call)', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['scones.demo'], 'scones.step3');
    const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
    const e1 = await svc.evaluateRescue({ commandId: cmd(), ...base, proposedKindIds: ['whole-milk', 'unsalted-butter'] });
    expect(e1).toMatchObject({ outcome: 'needsInterpretation' });
    if (e1.outcome === 'rejected') throw new Error(e1.code);
    const e2 = await svc.evaluateRescue({ commandId: cmd(), ...base, missingIngredientId: ING['cream'], previousEvaluationId: e1.id, utterance: { text: 'Heavy cream', channel: 'tapped' } });
    expect(e2).toMatchObject({ outcome: 'needsFacts', proposalResponse: { response: 'REALIZED_AS_PROPOSED' } });
  });
});

describe('voice/typed navigation router', () => {
  it('natural progress phrasings advance; negations, questions and missing-ingredient requests never do', async () => {
    const { route } = await import('../../src/web/route.ts');
    for (const t of ['next step', 'Next one please.', "I'm done with this stuff next one please", 'Hey CourseCorrect, I’m done', 'finished', 'moving on', 'all done, on to the next']) expect(route(t).kind, t).toBe('done');
    for (const t of ["I'm not finished yet", "I'm not done", "I haven't finished", 'almost done', "what's the next step", 'how do I finish', 'can you read the next step',
      "I'm done with the wine, I don't have any more", 'I ran out of stock, next step needs it', "I don't have any white wine. Can I use lemon juice?", 'use lemon juice instead and move on']) expect(route(t).kind, t).not.toBe('done');
    expect(route("I don't have any white wine. Can I use lemon juice?").kind).toBe('rescue');
    for (const t of ['yes', 'ok', 'sure', 'Yes.']) expect(route(t).kind, t).toBe('yes');   // never 'accept'
    expect(route('use this change').kind).toBe('accept');
  });
});

describe('answers to an open yes/no question', () => {
  it('natural replies are answers; negations win; anything else is not an answer', async () => {
    const { answerOf } = await import('../../src/web/route.ts');
    for (const t of ['yes', 'yes I have that', 'Yeah, I’ve got both.', 'I do', 'I have them', 'sure', 'ok']) expect(answerOf(t), t).toBe('yes');
    for (const t of ['no', "no I don't have that", 'not enough', "I don't have the lemon", "nope, I haven't got it", 'I ran out']) expect(answerOf(t), t).toBe('no');
    for (const t of ['maybe', 'what was the question', "I'm out of butter"]) expect(answerOf(t), t).not.toBe('yes');
  });
});

describe('timer voice commands', () => {
  it('start/stop the client timer; never a rescue request', async () => {
    const { route } = await import('../../src/web/route.ts');
    for (const t of ["great let's turn on the timer", 'please start the timer', 'please start my timer', 'create the timer for me', 'timer please', 'set a timer', 'start timer']) expect(route(t).kind, t).toBe('startTimer');
    for (const t of ['stop the timer', 'cancel the timer', 'turn off the timer']) expect(route(t).kind, t).toBe('stopTimer');
    expect(route("I don't have a timer, can I use my phone").kind).toBe('rescue');
  });
});

describe('explicit acceptance and multi-question answers', () => {
  it('natural acceptance phrasings accept; negations and bare yes never do; "both/all" covers every open question', async () => {
    const { route, answersAll } = await import('../../src/web/route.ts');
    for (const t of ["let's use this change", 'Use this change.', 'apply the change', 'ok use the change please', 'accept this change',
      'used this change', 'use this chain', 'use the changes', 'use change']) expect(route(t).kind, t).toBe('accept');   // how recognition hears the short command
    for (const t of ["don't use this change", 'do not apply the change', 'no, not this change', "don't use the changes", 'yes', 'yes I have it', 'sure', 'what changed', 'change of plan']) expect(route(t).kind, t).not.toBe('accept');
    for (const t of ['yes to both', 'I have everything', 'yes, all of them']) expect(answersAll(t), t).toBe(true);
    for (const t of ['yes', 'yes I have it', 'yeah']) expect(answersAll(t), t).toBe(false);
  });
});

describe('an open question proposes nothing the cook didn’t name (live finding 2026-10-08)', () => {
  const ctx = { ingredients: [{ id: 'ing_c', name: 'heavy cream' }], kinds: [
    { id: 'whole-milk', label: 'whole milk', aliases: ['milk'] }, { id: 'half-and-half-cream', label: 'half-and-half', aliases: [] }, { id: 'unsalted-butter', label: 'unsalted butter', aliases: ['butter'] }] };
  const intent = { missingIngredientId: 'ing_c', proposedKindIds: ['whole-milk', 'half-and-half-cream', 'unsalted-butter'], statesAmount: false, progressClaim: null, unmappedProposalText: null };
  it('drops the model’s own ideas; keeps what was named; leaves a proposal alone', () => {
    expect(onlyNamed(intent, 'I am out of cream, what do I use in place?', ctx).proposedKindIds).toEqual([]);
    expect(onlyNamed(intent, 'What can I use instead, milk?', ctx).proposedKindIds).toEqual(['whole-milk']);
    expect(onlyNamed(intent, 'I’m out of cream. Can I use milk and butter?', ctx).proposedKindIds).toEqual(intent.proposedKindIds);   // not an open question
  });
});
