// B32: wire payloads match FE–BE Contract v1 §7.3–§7.7 structurally (private/design/…/CourseCorrectMCP-FE-BE-Contract-v1.md).
import { describe, expect, it } from 'vitest';
import { cmd, newService, startAt } from '../helpers.ts';
import { ING, RECIPE, STEP, USE } from '../fixtures/ids.ts';

describe('FE–BE v1 wire fixtures (B32)', () => {
  it('§7.3 needsFacts, §7.4 proposal, §7.5 applied', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['risotto.demo'], 'risotto.step5');
    const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
    const e1 = await svc.evaluateRescue({ commandId: cmd(), ...base, utterance: { text: "I don't have any white wine. Can I use lemon juice?", channel: 'voice' } });
    // §7.3
    expect(e1).toMatchObject({ outcome: 'needsFacts', evaluatedAtRunRevision: run.revision, speech: { source: 'engineAuthored' } });
    if (e1.outcome !== 'needsFacts') return;
    expect(e1.interpretation).toMatchObject({ missingIngredientId: ING['wine'], missingUseIds: [USE['r.wine']], atStepId: STEP['r.deglaze'], askedAbout: 'lemon juice' });
    expect(e1.interpretation!.display).toEqual([
      { label: 'Missing', value: 'Dry white wine · step 5, 120 ML' },
      { label: 'Its role there', value: 'Liquid · acidity · aroma' },
      { label: 'You asked about', value: 'Lemon juice' },
      { label: 'Your place', value: 'Steps 1–4 done · step 5 not started' },
    ]);
    expect(e1.questions).toHaveLength(1);
    expect(e1.questions[0]).toMatchObject({ title: 'Do you have both of these?', items: [{ text: '120 ML more hot unsalted vegetable stock', contentSlot: false }, { text: '10 ML lemon juice', contentSlot: false }] });
    expect(e1.speech.text).toBe('To check this, I need to know: do you have 120 ML more hot unsalted vegetable stock and 10 ML lemon juice?');
    expect(e1.trace.deterministic).toContain('Required facts');

    // §7.4
    const e2 = await svc.evaluateRescue({ commandId: cmd(), ...base, previousEvaluationId: e1.id, answers: [{ questionId: e1.questions[0].id, value: 'yes' }] });
    expect(e2.outcome).toBe('proposal');
    if (e2.outcome !== 'proposal') return;
    const c = e2.candidates[0];
    expect(c.stepChanges.map((s) => [s.stepId, s.relation, s.stateLabel])).toEqual([
      [STEP['r.toast'], 'context', 'Done'], [STEP['r.deglaze'], 'changesNow', 'Changes now'], [STEP['r.ladle'], 'unchanged', 'Unchanged'],
      [STEP['r.finish'], 'changesLater', 'Changes later'], [STEP['r.rest'], 'context', 'Later'],
    ]);
    expect(c.stepChanges[2].note).toBe('900 ML stock still reserved here');
    const ins = (i: number) => c.stepChanges[i].segments!.filter((s) => s.kind === 'inserted').map((s) => s.text.trim());
    expect(ins(1)).toEqual(['hot unsalted vegetable stock']);
    expect(ins(3)).toContain('and 10 ML lemon juice');
    expect(c.roleMap).toEqual(expect.arrayContaining([
      { role: 'Liquid', replacement: 'Hot stock, step 5', kind: 'replaced' },
      { role: 'Acidity', replacement: 'Lemon juice, step 7', kind: 'replaced' },
      { role: 'Aroma', replacement: 'Not replaced · see What to expect', kind: 'lost' },
    ]));
    expect(c.ledger.map((l) => [l.ingredient, l.step, l.before, l.after, l.kind])).toEqual([
      ['Dry white wine', 'Step 5', '120 ML', 'Not needed', 'removed'],
      ['Hot unsalted vegetable stock', 'Step 5', '—', '120 ML more', 'added'],
      ['Unsalted vegetable stock', 'Step 6', '900 ML', '900 ML, still reserved', 'unchanged'],
      ['Lemon juice', 'Step 7', '—', '10 ML', 'added'],
    ]);
    expect(c.consequence).toEqual({ text: 'The risotto will taste different, and it won’t have the aroma of white wine.'.replace('’', "'"), contentSlot: false });
    expect(c.contentLabel).toBe('Engineering content · provisional quantities · not released cooking guidance');
    expect(c).toMatchObject({ resumeStepId: STEP['r.deglaze'], applicable: { kind: 'yes' } });

    // §7.5
    const applied = await svc.applyAmendment({ commandId: cmd(), ...base, evaluationId: e2.id, candidateId: c.id, planId: c.planId, accepted: true });
    expect(applied.outcome).toBe('applied');
    if (applied.outcome !== 'applied') return;
    expect(applied.amendment).toMatchObject({ changedStepIds: [STEP['r.deglaze'], STEP['r.finish']], appliedAtRunRevision: run.revision + 1 });
    const step = (id: string) => applied.run.steps.find((s) => s.stepId === id)!;
    expect(step(STEP['r.toast'])).toMatchObject({ progress: 'done', originalText: null, changedByAmendmentId: null });
    expect(step(STEP['r.deglaze'])).toMatchObject({ progress: 'notStarted', effectiveText: 'Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.', originalText: 'Pour in 120 ML dry white wine and stir until absorbed.', changedByAmendmentId: applied.amendment.id });
    expect(step(STEP['r.ladle'])).toMatchObject({ effectiveText: 'Add the hot stock a ladle at a time, stirring, until the rice is creamy and just tender, 18–20 minutes.', originalText: null });
    expect(step(STEP['r.finish'])).toMatchObject({ effectiveText: 'Off the heat, stir in 30 g butter, 50 g grated Parmesan and 10 ML lemon juice. Season with salt.', originalText: 'Off the heat, stir in 30 g butter and 50 g grated Parmesan. Season with salt.' });
    expect(applied.run).toMatchObject({ currentStepId: STEP['r.deglaze'], state: 'active' });
  });

  it('§7.6 shortcake refusal and §7.7 protected work', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['shortcake.demo'], 'shortcake.step6');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I'm out of heavy cream. Can I use milk and butter to whip instead?", channel: 'voice' } });
    expect(res.outcome).toBe('refused');
    if (res.outcome !== 'refused' || res.refusal.kind !== 'functionallyUnsupported') throw new Error('kind');
    expect(res.interpretation!.display.map((d) => d.label)).toEqual(['Missing', 'Its role there', 'You asked about', 'Your place']);
    expect(res.interpretation!.display[0].value).toBe('Heavy cream · step 6, 240 ML');
    expect(res.interpretation!.display[1].value).toBe('Whipped topping');
    expect(res.interpretation!.display[3].value).toBe('Steps 1–5 done · step 6 not started');
    expect(res.refusal.roleMap).toEqual([
      { role: 'Step 4 · liquid · fat', replacement: 'Already done', kind: 'alreadyDone' },
      { role: 'Step 6 · whipped topping', replacement: 'No reviewed replacement', kind: 'lost' },
    ]);
    expect(res.refusal.stepChanges.map((s) => [s.stepId, s.relation])).toEqual([[STEP['k.dough'], 'context'], [STEP['k.whip'], 'refused']]);
    expect(res.refusal.unchanged).toBe('Your recipe is unchanged. Step 6 still needs 240 ML heavy cream.');
    expect(res.refusal.reason.contentSlot).toBe(false);

    const { svc: s2 } = newService();
    const r2 = await startAt(s2, RECIPE['risotto.demo'], 'risotto.step5');
    const st = await s2.recordProgress({ commandId: cmd(), runId: r2.id, epoch: r2.epoch, expectedRevision: r2.revision, stepId: STEP['r.deglaze'], progress: 'started' });
    if (st.outcome !== 'recorded') throw new Error('progress');
    const pw = await s2.evaluateRescue({ commandId: cmd(), runId: r2.id, epoch: r2.epoch, expectedRevision: st.run.revision, missingIngredientId: ING['wine'] });
    expect(pw).toMatchObject({ outcome: 'refused', refusal: { kind: 'protectedWork', stepId: STEP['r.deglaze'], progress: 'started', guidance: null } });
    expect('speech' in pw && pw.speech.text).toContain('Step 5 is marked started, so this change can’t be used.'.replace('’', "'"));
  });

  it('scone (HF slots filled per OD-3): two questions, brushing stays qualitative and separate', async () => {
    const { svc } = newService();
    const run = await startAt(svc, RECIPE['scones.demo'], 'scones.step3');
    const res = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, utterance: { text: "I'm out of heavy cream. Can I use milk and butter?", channel: 'voice' } });
    expect(res.outcome).toBe('needsFacts');
    if (res.outcome !== 'needsFacts') return;
    expect(res.questions.map((q) => q.items.map((i) => i.text))).toEqual([
      ['180 ML milk, plus up to 30 ML more only if needed', '85 g cold butter'],
      ['A little more milk for step 6 (Brush the tops) — amount not stated, on top of any milk above'],
    ]);
    const e2 = await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, previousEvaluationId: res.id, answers: res.questions.map((q) => ({ questionId: q.id, value: 'yes' as const })) });
    expect(e2.outcome).toBe('proposal');
    if (e2.outcome !== 'proposal') return;
    expect(e2.candidates[0].stepChanges.map((s) => [s.stepId, s.relation])).toEqual([
      [STEP['sc.dry'], 'context'], [STEP['sc.dough'], 'changesNow'], [STEP['sc.cut'], 'context'], [STEP['sc.tray'], 'context'], [STEP['sc.brush'], 'changesLater'], [STEP['sc.bake'], 'context'],
    ]);
    const milk = (await svc.getActiveRecipe()).recipe!.ingredients.find((i) => i.id === ING['cream'])!;
    expect(milk.uses.map((u) => u.amount)).toEqual([{ kind: 'approximate', display: 'all but a little' }, { kind: 'approximate', display: 'a little' }]);
  });
});
