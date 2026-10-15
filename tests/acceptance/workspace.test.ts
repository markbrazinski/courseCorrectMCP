// First Lambda slice (LAMBDA-FIRST-SLICE-REPORT.md): the cooking path on the workspace store — two independent workspaces,
// start from a stored pack, progress, evaluate with the unchanged engine, accept and apply, read back, reconcile — and the
// failure cases the transaction model must survive. SQLite by default; DynamoDB Local with CC_TEST_DYNAMO_ENDPOINT.
import { describe, expect, it } from 'vitest';
import { K, LEASE_MS, Service, type RunItem } from '../../src/service/commands.ts';
import { wsPk, type Item, type Kv } from '../../src/service/kv.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { cmd, content, newKv, newService, newWs, startAt } from '../helpers.ts';
import { RECIPE, STEP } from '../fixtures/ids.ts';

const WINE = "I don't have any white wine. Can I use lemon juice?";
async function proposal(svc: Service) {
  const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
  const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
  const e1 = await svc.evaluateRescue({ commandId: cmd(), ...base, utterance: { text: WINE, channel: 'voice' } });
  if (e1.outcome !== 'needsFacts') throw new Error(JSON.stringify(e1));
  const e2 = await svc.evaluateRescue({ commandId: cmd(), ...base, previousEvaluationId: e1.id, answers: e1.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) });
  if (e2.outcome !== 'proposal') throw new Error(JSON.stringify(e2));
  const cand = e2.candidates[0];
  return { run, base, e2, cand, accept: (commandId = cmd()) => ({ commandId, ...base, evaluationId: e2.id, candidateId: cand.id, planId: cand.planId, accepted: true as const }) };
}
const item = async (svc: Service, sk: string) => svc.kv.get({ pk: wsPk(svc.ws), sk });
const amendments = async (svc: Service, runId: string) => (await svc.kv.query(wsPk(svc.ws), { prefix: K.amendments(runId) })).length;

describe('first slice: two workspaces on one store', () => {
  it('each workspace is its own kitchen: its own active run, book state, receipts and ids', async () => {
    const kv = newKv();
    const a = newService({ kv }).svc, b = newService({ kv }).svc;
    const { run, accept } = await proposal(a);
    expect((await b.getActiveRecipe()).run).toBeNull();
    expect((await b.listRecipes()).recipes.every((r) => r.activeRunId === null)).toBe(true);
    const bRun = await startAt(b, RECIPE['shortcake.demo'], null);   // a shared store never means a shared active session
    expect((await a.getActiveRecipe()).run!.id).toBe(run.id);
    expect((await b.getActiveRecipe()).run!.id).toBe(bRun.id);
    // A's ids mean nothing in B
    expect(await b.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: STEP['r.deglaze'], progress: 'started' })).toMatchObject({ code: 'RUN_NOT_FOUND' });
    expect(await b.applyAmendment(accept())).toMatchObject({ code: 'RUN_NOT_FOUND' });
    const applied = await a.applyAmendment(accept());
    expect(applied.outcome).toBe('applied');
    const id = applied.outcome === 'applied' ? applied.amendment.commandId : '';
    expect((await b.getActiveRecipe({ commandId: id })).command).toMatchObject({ receipt: 'NONE', status: 'unknown' });
    expect(await b.speechText({ runId: run.id, stepId: STEP['r.deglaze'] })).toBeNull();
    expect(await amendments(b, run.id)).toBe(0);
  });

  it('start → progress → evaluate → accept → apply → read → reconcile a repeated command', async () => {
    const { svc } = newService();
    const { run, base, accept } = await proposal(svc);
    const before = (await item(svc, K.run(run.id))) as RunItem & Item;
    const input = accept();
    const applied = await svc.applyAmendment(input);
    expect(applied).toMatchObject({ outcome: 'applied', resume: { text: 'Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.' } });
    const after = (await item(svc, K.run(run.id))) as RunItem & Item;
    expect(after.stepStatus).toEqual(before.stepStatus);                       // applying completes nothing
    expect([after.version, after.revision]).toEqual([before.version + 1, before.revision + 1]);
    const read = await svc.getActiveRecipe({ commandId: input.commandId });
    expect(read.command).toMatchObject({ receipt: 'DONE', status: 'applied' });
    expect(read.run!.steps.find((s) => s.stepId === STEP['r.deglaze'])).toMatchObject({ progress: 'notStarted', originalText: 'Pour in 120 ML dry white wine and stir until absorbed.' });
    expect(await svc.applyAmendment(input)).toMatchObject({ outcome: 'alreadyApplied', replayed: true });   // the lost-response retry
    expect(await amendments(svc, run.id)).toBe(1);
    const next = await svc.recordProgress({ commandId: cmd(), ...base, expectedRevision: after.revision, stepId: STEP['r.deglaze'], progress: 'done' });
    expect(next.outcome === 'recorded' && next.run.currentStepId).toBe(STEP['r.ladle']);
  });
});

describe('first slice: failure cases', () => {
  it('two simultaneous applies against the same revision (different commands): exactly one amendment', async () => {
    const { svc } = newService();
    const { run, accept } = await proposal(svc);
    const [x, y] = await Promise.all([svc.applyAmendment(accept()), svc.applyAmendment(accept())]);
    expect([x.outcome, y.outcome].sort()).toEqual(['applied', 'rejected']);
    expect((x.outcome === 'rejected' ? x : y)).toMatchObject({ code: expect.stringMatching(/^(STALE_STATE|NOT_ACTIONABLE)$/) });
    expect(await amendments(svc, run.id)).toBe(1);
    expect(((await item(svc, K.run(run.id))) as RunItem & Item).appliedRescueCount).toBe(1);
  });

  it('the same command sent twice at once (a retry racing its original): one amendment, the other replays it', async () => {
    const { svc } = newService();
    const { run, accept } = await proposal(svc);
    const input = accept();
    const out = await Promise.all([svc.applyAmendment(input), svc.applyAmendment(input)]);
    expect(out.map((o) => o.outcome).sort()).toEqual(['alreadyApplied', 'applied']);
    expect(await amendments(svc, run.id)).toBe(1);
  });

  it('progress racing an apply on the same revision: never both', async () => {
    const { svc } = newService();
    const { run, base, accept } = await proposal(svc);
    const [p, a] = await Promise.all([svc.recordProgress({ commandId: cmd(), ...base, stepId: STEP['r.deglaze'], progress: 'started' }), svc.applyAmendment(accept())]);
    expect([p.outcome === 'recorded', a.outcome === 'applied'].filter(Boolean)).toHaveLength(1);
    expect(await amendments(svc, run.id)).toBe(a.outcome === 'applied' ? 1 : 0);
  });

  it('a stale evaluation or candidate is never applied', async () => {
    const { svc } = newService();
    const { run, base, e2, accept } = await proposal(svc);
    const newer = await svc.evaluateRescue({ commandId: cmd(), ...base, previousEvaluationId: e2.id, answers: [] });
    expect((newer as { id?: string }).id).not.toBe(e2.id);
    expect(await svc.applyAmendment(accept())).toMatchObject({ code: 'NOT_LATEST_EVALUATION' });
    expect(await svc.applyAmendment({ ...accept(), planId: 'not-the-plan' })).toMatchObject({ outcome: 'rejected' });
    expect(await amendments(svc, run.id)).toBe(0);
  });

  it('a refusal leaves the recipe unchanged', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['shortcake.demo'], 'shortcake.step6');
    const before = (await item(svc, K.run(run.id))) as RunItem & Item;
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I'm out of heavy cream. Can I use milk and butter to whip instead?", channel: 'voice' } });
    expect(res).toMatchObject({ outcome: 'refused', actionable: false });
    const after = (await item(svc, K.run(run.id))) as RunItem & Item;
    expect([after.version, after.revision, after.stepStatus, after.useStatus]).toEqual([before.version, before.revision, before.stepStatus, before.useStatus]);
    expect((await svc.getActiveRecipe()).run!.steps.every((s) => s.originalText === null)).toBe(true);
    expect(await amendments(svc, run.id)).toBe(0);
  });

  it('an evaluation whose invocation died is INTERRUPTED once its lease passes (no restart needed), never actionable', async () => {
    const kv: Kv = newKv();
    const ws = newWs();
    let t = Date.parse('2026-10-21T12:00:00Z');
    const svc = new Service({ kv, ws, content, interpreter: noneInterpreter, now: () => new Date(t).toISOString() });
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const id = cmd();
    // what a crash between reserve and publish leaves: a PENDING receipt stamped by an owner the store can't declare dead
    await kv.write([{ put: { pk: wsPk(ws), sk: K.receipt(id), commandId: id, tool: 'evaluate_rescue', runId: run.id, digest: 'x', state: 'PENDING', result: null, at: new Date(t).toISOString(), owner: 'lambda', v: 1 } }]);
    const dynamoLike = new Service({ kv: { ...kvMethods(kv), alive: () => true }, ws, content, interpreter: noneInterpreter, now: () => new Date(t).toISOString() });
    expect((await dynamoLike.getActiveRecipe({ commandId: id })).command).toMatchObject({ receipt: 'PENDING', status: 'unknown' });
    t += LEASE_MS + 1;
    expect((await dynamoLike.getActiveRecipe({ commandId: id })).command).toMatchObject({ receipt: 'INTERRUPTED', status: 'notApplied' });
  });
});

/** The same store with its methods bound (to override one). */
function kvMethods(kv: Kv): Kv {
  return { name: kv.name, owner: kv.owner, alive: (o) => kv.alive(o), get: (x) => kv.get(x), getMany: (x) => kv.getMany(x), query: (p, o) => kv.query(p, o), write: (o) => kv.write(o), incr: (x) => kv.incr(x) };
}
