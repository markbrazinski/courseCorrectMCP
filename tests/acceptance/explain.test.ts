// Refusals say "No, because …" (owner, 2026-10-02): the engine's reasons as structured facts; a model may only word them,
// and its answer is replaced by the template when it could change the decision or add anything. RECORDED explainer only.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Service } from '../../src/service/commands.ts';
import { recordedInterpreter } from '../../src/service/interpret.ts';
import { RECORDED_INTENTS } from '../fixtures/recorded-intents.ts';
import { recordedExplainer, rejectAnswer } from '../../src/service/explain.ts';
import { cmd, content, newService, ROOT, startAt, vocab } from '../helpers.ts';
import { RECIPE } from '../fixtures/ids.ts';

const MILK_BUTTER = "I'm out of heavy cream. Can I use milk and butter?";
const WHIP = "I'm out of heavy cream. Can I use milk and butter to whip instead?";
const withAnswer = (answer: string) => new Service({ dbPath: join(mkdtempSync(join(tmpdir(), 'ccmcp-exp-')), 'db'), content, interpreter: recordedInterpreter(RECORDED_INTENTS), explainer: recordedExplainer({ [MILK_BUTTER]: answer }) });
const authored = (JSON.parse(readFileSync(join(ROOT, 'content/approved/patterns/whip_needs_cream.v1.json'), 'utf8')) as { text: string }).text;

async function ask(svc: Service, doneSteps: number, text: string) {
  let run = await startAt(svc, RECIPE['shortcake.demo'], null);
  const steps = svc.getActiveRecipe().recipe!.steps;
  for (const s of steps.slice(0, doneSteps)) {
    const r = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' });
    if (r.outcome !== 'recorded') throw new Error(JSON.stringify(r));
    run = r.run;
  }
  const ev = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text, channel: 'typed' } });
  if (!('outcome' in ev) || ev.outcome !== 'refused') throw new Error(`expected a refusal: ${JSON.stringify(ev).slice(0, 300)}`);
  return ev;
}

describe('refusal why (deterministic) and its answer', () => {
  it('shortcake step 4, milk and butter: "No", because step 6 is whipped topping and milk and butter can\'t whip', async () => {
    const { svc } = newService();
    const ev = await ask(svc, 3, MILK_BUTTER);
    expect(ev.refusal.kind).toBe('noReviewedRecovery');                         // engine decision unchanged
    expect(ev.why.verdict).toBe('no');
    expect(ev.why.facts.some((f) => /step 6/.test(f) && /whipped topping/.test(f))).toBe(true);
    expect(ev.why.facts.some((f) => /can't whip/.test(f))).toBe(true);
    expect(ev.why.facts.some((f) => /step 4/.test(f) && /can do that job/.test(f))).toBe(true);
    expect(ev.why.proposalAnswer).toBe('Milk and butter: step 4: would work on its own, step 6: no');
    expect(ev.answer).toMatchObject({ source: 'template' });
    expect(ev.answer.text).toMatch(/^No\. /);
    expect(ev.speech.text).toBe(`${ev.answer.text} ${'Your recipe is unchanged. Step 4 still needs 180 ML heavy cream.'}`);
    expect(svc.speechText({ evaluationId: ev.id })).toBe(ev.speech.text);       // Polly reads exactly this
  });

  it('shortcake step 6: the authored whip reason is kept verbatim in the facts', async () => {
    const { svc } = newService();
    const ev = await ask(svc, 5, WHIP);
    expect(ev.refusal.kind).toBe('functionallyUnsupported');
    expect(ev.why.verdict).toBe('no');
    expect(ev.why.facts).toContain(authored.replace(/\.$/, ''));
    expect(ev.answer.text).toMatch(/^No\. /);
  });

  it('a state refusal is "not right now" and keeps the engine message', async () => {
    const { svc } = newService();
    let run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const step5 = svc.getActiveRecipe().recipe!.steps[4];
    const r = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: step5.id, progress: 'started' });
    if (r.outcome !== 'recorded') throw new Error('progress');
    run = r.run;
    const ev = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I don't have any white wine. Can I use lemon juice?", channel: 'typed' } });
    if (!('outcome' in ev) || ev.outcome !== 'refused') throw new Error('refusal');
    expect(ev.refusal.kind).toBe('protectedWork');
    expect(ev.why).toMatchObject({ verdict: 'notNow', facts: [expect.stringMatching(/^Step 5 is marked started/)] });
    expect(ev.answer.text).toMatch(/^Not right now\. Step 5 is marked started/);
  });
});

describe('the model can never turn a refusal into a yes', () => {
  it('a recorded "Yes, you can…" answer is rejected and the template is used', async () => {
    const ev = await ask(withAnswer('Yes, you can use milk and butter in step 4.'), 3, MILK_BUTTER);
    expect(ev.answer.source).toBe('template');
    expect(ev.answer.text).toMatch(/^No\. /);
    expect(ev.trace.explanation).toContain('NOT_A_NO');
  });

  it('a faithful recorded answer is used; one that adds an ingredient or amount is not', async () => {
    const good = 'No. Milk and butter could do the dough’s job in step 4, but the cream in step 6 is whipped topping, and milk and butter can’t whip.';
    const ev = await ask(withAnswer(good), 3, MILK_BUTTER);
    expect(ev.answer).toEqual({ text: good, source: 'model' });
    expect(rejectAnswer('No. It would need 100 ML milk.', ev.why, MILK_BUTTER, vocab)).toBe('NEW_QUANTITY:100');
    expect(rejectAnswer('No. Use 100 ML milk instead.', ev.why, MILK_BUTTER, vocab)).toMatch(/^SUGGESTS_ALTERNATIVE:|^NEW_QUANTITY:/);
    expect(rejectAnswer('No, but lemon juice would work.', ev.why, MILK_BUTTER, vocab)).toMatch(/^NEW_TERM:|SOUNDS_LIKE_YES/);
    expect(rejectAnswer('No. It needs stock.', ev.why, MILK_BUTTER, vocab)).toBe('NEW_TERM:stock');
    expect(rejectAnswer('No. Try it with stock.', ev.why, MILK_BUTTER, vocab)).toMatch(/^SUGGESTS_ALTERNATIVE:|^NEW_TERM:/);
    expect(rejectAnswer('x'.repeat(300), ev.why, MILK_BUTTER, vocab)).toBe('TOO_LONG');
    // an alternative outside the vocabulary is still an invented swap
    expect(rejectAnswer('No, but you could try margarine instead.', ev.why, MILK_BUTTER, vocab)).toMatch(/^SUGGESTS_ALTERNATIVE:/);
    expect(rejectAnswer('No. Coconut cream is a good alternative.', ev.why, MILK_BUTTER, vocab)).toMatch(/^SUGGESTS_ALTERNATIVE:/);
  });
});
