// Import-time swap cards (owner 2026-10-02; handoff-import-swap-cards.md). RECORDED readings and hand-written card
// fixtures only (validator/compiler evidence, not Nova evidence). Cooking uses structured input and no explainer, so no
// model call happens at cook time.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { buildDraft, recordedExtractor } from '../../src/authoring/extract.ts';
import { readPastedText } from '../../src/authoring/source.ts';
import { recordedAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { checkCards, refsOf } from '../../src/compile/cards.ts';
import { Service } from '../../src/service/commands.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { DEMO, demoPdf, recordedDemo, RISOTTO_CARDS, SHORTCAKE_CARDS } from '../fixtures/demo-cards.ts';
import { RISOTTO_LINES, RISOTTO_READING, SHORTCAKE_LINES, SHORTCAKE_READING } from '../fixtures/demo-sources.ts';
import { cmd, content, ROOT, vocab } from '../helpers.ts';
import { hash } from '../../src/domain/rational.ts';

const rec = await recordedDemo(vocab);
type Name = (typeof DEMO)[number]['name'];

async function imported(names: Name[] = ['risotto', 'scones', 'shortcake'], cards = rec.cards, readings = rec.readings) {
  const svc = new Service({ dbPath: join(mkdtempSync(join(tmpdir(), 'ccmcp-cards-')), 'db'), content, interpreter: noneInterpreter, fixtureRecipes: false });
  const auth = new Authoring({ store: svc.store, content, extractor: recordedExtractor(readings), analyzer: recordedAnalyzer(cards) });
  svc.catalog = () => auth.catalog();
  const saved: Record<string, { recipeId: string; recipeVersionId: string; draftId: string }> = {};
  for (const name of names) {
    const d = DEMO.find((x) => x.name === name)!;
    const r = await auth.createImport({ kind: 'pdf', bytes: demoPdf(d.lines), filename: `${name}.pdf` });
    if (r.status !== 202) throw new Error('import');
    expect((await auth.waitForJob(r.job.id)).state).toBe('succeeded');
    saved[name] = { ...auth.save(r.draftId, { expectedRevision: auth.revision(r.draftId) }), draftId: r.draftId };
  }
  return { svc, auth, saved };
}

/** Start an imported recipe, mark steps done, and ask (structured: no interpreter, no explainer). */
async function cookTo(svc: Service, recipeId: string, done: number) {
  const st = svc.startRecipe({ commandId: cmd(), recipeId, ...(svc.getActiveRecipe().run ? { replace: { runId: svc.getActiveRecipe().run!.id, epoch: svc.getActiveRecipe().run!.epoch, expectedRevision: svc.getActiveRecipe().run!.revision, confirm: true } } : {}) });
  if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
  let run = st.run;
  for (const s of st.recipe.steps.slice(0, done)) {
    const r = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.id, progress: 'done' });
    if (r.outcome !== 'recorded') throw new Error(JSON.stringify(r));
    run = r.run;
  }
  const ing = (name: RegExp) => st.recipe.ingredients.find((i) => name.test(i.name))!.id;
  const ask = async (name: RegExp, proposedKindIds: string[] = [], previous?: { id: string; answers: { questionId: string; value: 'yes' | 'no' }[] }) => {
    const cur = svc.getActiveRecipe().run!;
    const ev = await svc.evaluateRescue({ commandId: cmd(), runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, missingIngredientId: ing(name), proposedKindIds,
      utterance: { text: name.source, channel: 'tapped' }, ...(previous ? { previousEvaluationId: previous.id, answers: previous.answers } : {}) });
    if (ev.outcome === 'rejected') throw new Error(ev.code);
    return ev;
  };
  /** Ask, then answer every availability question with `value`. */
  const askAll = async (name: RegExp, value: 'yes' | 'no' = 'yes', proposed: string[] = []) => {
    const e1 = await ask(name, proposed);
    if (e1.outcome !== 'needsFacts') return e1;
    return ask(name, proposed, { id: e1.id, answers: e1.questions.map((q) => ({ questionId: q.id, value })) });
  };
  return { run, ask, askAll };
}
const apply = (svc: Service, ev: { id: string; outcome: string; candidates?: { id: string; planId: string }[] }, accepted = true) => {
  const run = svc.getActiveRecipe().run!;
  return svc.applyAmendment({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, evaluationId: ev.id, candidateId: ev.candidates![0].id, planId: ev.candidates![0].planId, accepted });
};

describe('every ADD use of the three demo recipes has a validated card (coverage table)', () => {
  it('imports, validates and writes the coverage table; fails on any use without a swap, omit or no-with-opinion', async () => {
    const { auth, saved } = await imported();
    const rows: string[] = ['| Recipe | Step | Use | Verdict | Plan | Opinion |', '|---|---|---|---|---|---|'];
    const missing: string[] = [];
    for (const [name, s] of Object.entries(saved)) {
      const { pack } = auth.coverageOf(s.draftId);
      const c = auth.getDraft(s.draftId).draft.content!;
      for (const e of pack!.cards!) {
        const u = c.ingredients.flatMap((i) => i.uses.map((x) => ({ ...x, name: i.name }))).find((x) => x.id === e.useId)!;
        const step = c.steps.find((x) => x.id === u.stepId)!.ordinal;
        if (e.status === 'INVALID' || !e.verdict || !e.opinion) missing.push(`${name} step ${step} ${u.name}: ${e.reason}`);
        rows.push(`| ${name} | ${step} | ${u.name} | ${e.verdict} | ${e.status === 'SUPERSEDED' ? `reviewed rule (card agrees: ${/agrees/.test(e.reason ?? '')})` : u.swap.label ?? ''} | ${e.opinion} |`);
      }
    }
    mkdirSync(join(ROOT, '.artifacts/cards'), { recursive: true });
    writeFileSync(join(ROOT, '.artifacts/cards/coverage-recorded.md'), `# Card coverage (RECORDED test fixtures, not Nova)\n\n${rows.join('\n')}\n`);
    expect(missing).toEqual([]);
    expect(rows.length - 2).toBe(10 + 6 + 9);
  });

  it('reviewed rules stay a cross-check: where one binds, its plan is used and the card is recorded with agreement', async () => {
    const { auth, saved } = await imported(['risotto', 'scones']);
    const risotto = auth.coverageOf(saved.risotto.draftId).pack!, scones = auth.coverageOf(saved.scones.draftId).pack!;
    expect(risotto.warnings).toContainEqual(expect.stringMatching(/^CARD_SUPERSEDED:.*reviewed "Split the wine's jobs" is used; the card said swap \(agrees\)/));
    expect(scones.warnings).toContainEqual(expect.stringMatching(/^CARD_SUPERSEDED:.*"Butter and milk for cream in a dough".*\(agrees\)/));
    // card bindings are ordinary bindings in the same pack (no forked engine), and change the pack's identity
    expect(risotto.bindings.filter((b) => b.card).every((b) => b.patternId === 'import-card' && b.factsHash && (b.kind === 'REFUSAL' || b.ops.at(-1)?.op === 'SET_RESUME'))).toBe(true);
    expect(risotto.cardSetHash).toBeTruthy();
  });
});

describe('cooking answers come from cards, with no model call beyond interpretation', () => {
  it('risotto: wine → stock + lemon (reviewed); Parmesan → its card (labelled, applied once)', async () => {
    const { svc, saved } = await imported(['risotto']);
    const k = await cookTo(svc, saved.risotto.recipeId, 4);
    const wine = await k.askAll(/wine/i, 'yes', ['lemon-juice']);
    expect(wine.outcome).toBe('proposal');
    if (wine.outcome !== 'proposal') return;
    expect(wine.candidates[0]).toMatchObject({ headline: 'Use hot stock now and lemon juice at the finish instead of the wine.', contentLabel: 'Engineering content · provisional quantities · not released cooking guidance' });

    const p = await cookTo(svc, saved.risotto.recipeId, 6);
    const e1 = await p.ask(/parmesan/i);
    expect(e1.outcome).toBe('needsFacts');
    if (e1.outcome !== 'needsFacts') return;
    expect(e1.questions.map((q) => q.items.map((i) => i.text))).toEqual([['50 g grated pecorino']]);
    const e2 = await p.ask(/parmesan/i, [], { id: e1.id, answers: [{ questionId: e1.questions[0].id, value: 'yes' }] });
    if (e2.outcome !== 'proposal') throw new Error(e2.outcome);
    expect(e2.candidates[0]).toMatchObject({ headline: 'Use 50 g grated pecorino instead of the parmesan in step 7.', contentLabel: 'Prepared at import (AI) · not reviewed · provisional quantities · not released cooking guidance',
      consequence: { text: 'Pecorino is saltier and sharper, so taste before adding salt.' } });
    expect(e2.trace.deterministic).toMatch(/^Prepared at import \(AI\): Grated pecorino for the parmesan/);
    const a = apply(svc, e2);
    expect(a.outcome).toBe('applied');
    if (a.outcome !== 'applied') return;
    expect(a.run.steps[6].effectiveText).toBe('Off the heat, stir in 30 g butter and 50 g grated pecorino. Season with salt.');
    expect(a.run.steps[6].progress).toBe('notStarted');
  });

  it('scones: cream at step 3 → butter + milk (reviewed); brushing cream at step 6 → a little milk (card)', async () => {
    const { svc, saved } = await imported(['scones']);
    const k = await cookTo(svc, saved.scones.recipeId, 2);
    const dough = await k.askAll(/cream/i);
    if (dough.outcome !== 'proposal') throw new Error(dough.outcome);
    expect(dough.candidates[0].headline).toBe('Rub in cold butter and use milk in the dough, and brush with milk instead of cream.');
    const b = await cookTo(svc, saved.scones.recipeId, 5);
    const e1 = await b.ask(/cream/i);
    if (e1.outcome !== 'needsFacts') throw new Error(e1.outcome);
    expect(e1.questions.map((q) => q.items.map((i) => i.text))).toEqual([['A little more milk for step 6 (Brush tops) — amount not stated, on top of any milk above']]);
    const e2 = await b.ask(/cream/i, [], { id: e1.id, answers: [{ questionId: e1.questions[0].id, value: 'yes' }] });
    if (e2.outcome !== 'proposal') throw new Error(e2.outcome);
    expect(e2.candidates[0].contentLabel).toMatch(/^Prepared at import \(AI\)/);
    const a = apply(svc, e2);
    expect(a.outcome === 'applied' && a.run.steps[5].effectiveText).toBe('Brush the tops with a little milk.');
  });

  it('shortcake: step 4 → "No" for now, with the card\'s step-6 reason; step 6 → "No, because it has to whip …"', async () => {
    const { svc, saved } = await imported(['shortcake']);
    const k = await cookTo(svc, saved.shortcake.recipeId, 3);
    const e4 = await k.ask(/cream/i, ['whole-milk', 'unsalted-butter']);
    if (e4.outcome !== 'refused') throw new Error(e4.outcome);
    expect(e4.why.verdict).toBe('no');
    expect(e4.why.facts).toContain("The cream is also whipped in step 6, and milk and butter can't be whipped");
    expect(e4.why.facts[0]).toBe("The prepared change doesn't cover the heavy cream in step 6, so it can't be used");
    expect(e4.answer).toMatchObject({ source: 'template', text: expect.stringMatching(/^No\. /) });

    const k6 = await cookTo(svc, saved.shortcake.recipeId, 5);
    const open = await k6.ask(/cream/i);
    if (open.outcome !== 'refused' || open.refusal.kind !== 'functionallyUnsupported') throw new Error(open.outcome);
    expect(open.refusal.origin).toBe('importCard');
    expect(open.answer.text).toMatch(/^No, because this cream has to whip and hold air for the topping/);
    expect(open.speech.text.startsWith(open.answer.text)).toBe(true);
    // the exact reviewed refusal still answers its own proposal
    const mb = await k6.ask(/cream/i, ['whole-milk', 'unsalted-butter']);
    if (mb.outcome !== 'refused' || mb.refusal.kind !== 'functionallyUnsupported') throw new Error(mb.outcome);
    expect(mb.refusal.origin).toBe('reviewed');
    expect(mb.why.facts.some((f) => f.startsWith("This catalog doesn't accept milk and butter"))).toBe(true);
  });
});

describe('a card never contradicts a reviewed rule (live probe finding 2026-10-07: 120 ML lemon juice for 120 ML wine)', () => {
  // the retained live card for the risotto wine, verbatim except for `functions` in the first case
  const LEMON = { useRef: 'U6', verdict: 'swap', role: 'adds acidity and helps to deglaze the pan', functions: ['ACIDITY', 'LIQUID'],
    swap: { ingredient: 'lemon juice', kindId: 'lemon-juice', amountText: '120 ML', otherIngredients: [] },
    stepRewrites: [{ stepRef: 'S5', text: 'Pour in 120 ML lemon juice and stir until absorbed.' }], siblings: [],
    tradeoff: "The flavor will be brighter and more acidic, but the dish will lose the wine's characteristic flavor.",
    opinion: 'Swap dry white wine for lemon juice if you want a brighter, more acidic risotto without the wine flavor.' };
  const withWineCard = (card: Record<string, unknown>) => {
    const key = Object.keys(rec.cards).find((k) => JSON.stringify(rec.cards[k]) === JSON.stringify(RISOTTO_CARDS))!;
    return { ...rec.cards, [key]: { cards: RISOTTO_CARDS.cards.map((c) => (c.useRef === 'U6' ? card : c)) } };
  };
  const wineAt = async (cards: Record<string, unknown>, readings = rec.readings) => {
    const { svc, auth, saved } = await imported(['risotto'], cards, readings);
    const page = auth.getRecipe(saved.risotto.recipeId).version.content!;
    const wine = page.ingredients.find((i) => /wine/i.test(i.name))!.uses[0];
    return { svc, saved, wine, card: auth.catalog()[0].pack!.cards!.find((c) => c.useId === wine.id)! };
  };

  it('split binds (roles match the table): the lemon card is invalid; the stock-now, lemon-at-finish plan stays available and applies', async () => {
    const { svc, saved, wine, card } = await wineAt(withWineCard({ ...LEMON, functions: ['LIQUID', 'ACIDITY', 'FLAVOR'] }));
    expect(card).toMatchObject({ status: 'INVALID', reason: expect.stringMatching(/^CONTRADICTS_REVIEWED_RULE: "Split the wine's jobs" answers this replacement differently: There's no one-for-one lemon swap/) });
    expect(wine.analysis!.status).toBe('available');
    expect(wine.analysis!.plans.map((p) => [p.provenance.kind, p.title])).toEqual([['reviewedRule', "Split the wine's jobs"]]);
    expect(wine.analysis!.plans[0].replacements.map((x) => `${x.amount.display} ${x.ingredientName}`)).toEqual(['120 ML Unsalted vegetable stock', '10 ML Lemon juice']);
    const k = await cookTo(svc, saved.risotto.recipeId, 4);
    const ev = await k.askAll(/wine/i, 'yes', ['lemon-juice']);
    if (ev.outcome !== 'proposal') throw new Error(ev.outcome);
    expect(ev.proposalResponse).toMatchObject({ response: 'ADAPTED', text: expect.stringMatching(/^There's no one-for-one lemon swap/) });
    expect(ev.candidates.map((c) => c.headline)).toEqual(['Use hot stock now and lemon juice at the finish instead of the wine.']);
    const a = apply(svc, ev);
    if (a.outcome !== 'applied') throw new Error(a.outcome);
    expect(a.run.steps[4].effectiveText).toBe('Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.');
    expect(a.run.steps[6].effectiveText).toBe('Off the heat, stir in 30 g butter, 50 g grated Parmesan and 10 ML lemon juice. Season with salt.');
  });

  it('split waits on a fact (the reading gave step 5 no technique, so the wine role is unconfirmed): the lemon card is still invalid, never shown as usable, never offered or applied', async () => {
    // R-1 confirms the retained case's roles (split binds there); here nothing confirms step 5, but its wording cue ("pour in … wine")
    // still shows the reviewed claim's target, and evidence like that may restrict a card
    const variant = { ...RISOTTO_READING, steps: RISOTTO_READING.steps.map((x) => (x.key === 's5' ? { ...x, technique: null } : x)) };
    const noTech: Record<string, unknown> = Object.fromEntries(Object.entries(rec.readings).map(([k, x]) => [k, x === RISOTTO_READING ? variant : x]));   // text and PDF keys
    const key = Object.keys(rec.readings).find((k) => rec.readings[k] === RISOTTO_READING)!;
    const recCards = (await recordedDemo(vocab)).cards;   // keyed by the original reading; this reading's own key differs
    const { analysisKey } = await import('../fixtures/demo-cards.ts');
    const k2 = await analysisKey(noTech[key], RISOTTO_LINES, vocab);
    const cards = { ...recCards, [k2]: { cards: RISOTTO_CARDS.cards.map((c) => (c.useRef === 'U6' ? LEMON : c)) } };
    const { svc, saved, wine, card } = await wineAt(cards, noTech);
    expect(card.status).toBe('INVALID');
    expect(wine.analysis!.status).toBe('blocked');                      // the reviewed plan, waiting on its facts; no plan offered
    expect(wine.analysis!.plans).toEqual([]);
    expect(wine.analysis!.reason!.detail).toMatch(/CONTRADICTS_REVIEWED_RULE/);
    const k = await cookTo(svc, saved.risotto.recipeId, 4);
    const ev = await k.askAll(/wine/i, 'yes', ['lemon-juice']);
    expect(ev.outcome).toBe('refused');
    expect(ev.proposalResponse?.response).not.toBe('REALIZED_AS_PROPOSED');
    expect(svc.getActiveRecipe().run!.appliedAmendments).toEqual([]);
  });

  it('leaving kindId out does not hide the replacement; stock with lemon (not what the claim answers) is not affected', async () => {
    expect((await wineAt(withWineCard({ ...LEMON, swap: { ...LEMON.swap, kindId: null } }))).card.reason).toMatch(/^CONTRADICTS_REVIEWED_RULE/);
    expect((await wineAt(rec.cards)).card).toMatchObject({ status: 'SUPERSEDED' });   // the fixture card: 120 ML stock + 1 tbsp lemon, superseded by split
  });
});

describe('invalid cards fail closed (never a half-plan)', () => {
  const lines = SHORTCAKE_LINES;
  const r0 = (() => {
    const t = readPastedText(new TextEncoder().encode(lines.join('\n')));
    if (!t.ok) throw new Error('x');
    const b = buildDraft(SHORTCAKE_READING, vocab, [{ sourceId: 's', origin: 'UPLOAD', pages: t.source.pages }], 'r', 'e', 'T');
    if (!b.ok) throw new Error('x');
    return b.body.recipe;
  })();
  const dough = SHORTCAKE_CARDS.cards[5] as Record<string, unknown> & { swap: Record<string, unknown> };
  const reasonFor = (card: Record<string, unknown>) => {
    const raw = { cards: SHORTCAKE_CARDS.cards.map((c) => (c.useRef === card.useRef ? card : c)) };
    return checkCards(raw, refsOf(r0), r0, vocab, null).entries.find((e) => e.useId === refsOf(r0).uses[card.useRef as string])!;
  };
  it('the fixture card itself is valid', () => expect(reasonFor(dough)).toMatchObject({ status: 'COMPILED', reason: null }));
  it('unparseable amount', () => expect(reasonFor({ ...dough, swap: { ...dough.swap, amountText: '130 ml of milk' } }).reason).toMatch(/^UNPARSEABLE_AMOUNT/));
  it('a missed sibling use', () => expect(reasonFor({ ...dough, siblings: [] }).reason).toBe('SIBLING_MISSED: step 6'));
  it('ingredient identity: a mislabelled kind fails as such; a true alias is the same ingredient; varieties are not collapsed; omit and no are not swaps', () => {
    const swapTo = (ingredient: string, kindId: string | null) => reasonFor({ ...dough, swap: { ...dough.swap, ingredient, kindId }, opinion: 'Use it in the dough instead.', tradeoff: 'The shortcakes will be less rich.', siblings: (dough.siblings as { note: string }[]).map((x) => ({ ...x, note: 'The cream in step 6 is whipped, so it stays as written.' })),
      stepRewrites: [{ stepRef: 'S4', text: `Stir in 130 ML ${ingredient} and 50 g melted butter until just combined.` }] }).reason;
    expect(swapTo('milk', 'heavy-cream')).toBe('KIND_MISMATCH: "milk" isn\'t heavy cream');              // live probe: chicken stock / baking soda pattern
    expect(swapTo('heavy cream', null)).toBe('SWAP_IS_SAME_INGREDIENT: heavy cream resolves to heavy cream');                // its own name
    expect(swapTo('double cream', 'heavy-cream')).toBe('KIND_MISMATCH: "double cream" isn\'t heavy cream');                 // vocabulary v2: a distinct form (fat content), not an alias
    expect(swapTo('fresh heavy cream', null)).toBe('SWAP_IS_SAME_INGREDIENT: fresh heavy cream resolves to heavy cream');  // preparation word only
    expect(swapTo('half-and-half', null)).toBeNull();
    expect(swapTo('whole milk', 'whole-milk')).toBeNull();                                         // a kind's id is one of its names (live probe 2026-10-07)                                                  // a different ingredient compiles
    const omitSalt = SHORTCAKE_CARDS.cards[3] as Record<string, unknown>;
    expect(reasonFor(omitSalt)).toMatchObject({ status: 'COMPILED' });
    expect(reasonFor(SHORTCAKE_CARDS.cards[2] as Record<string, unknown>)).toMatchObject({ status: 'COMPILED', verdict: 'no' });
  });
  it('ranked suggestions (ccmcp-swaps-3, owner 2026-10-08): the first that passes is used; each earlier one keeps its reason', async () => {
    const swapCard = (ingredient: string, kindId: string | null) => ({ ...dough, swap: { ...dough.swap, ingredient, kindId }, opinion: 'Use it in the dough instead.', tradeoff: 'The shortcakes will be less rich.', siblings: (dough.siblings as { note: string }[]).map((x) => ({ ...x, note: 'The cream in step 6 is whipped, so it stays as written.' })),
      stepRewrites: [{ stepRef: 'S4', text: `Stir in 130 ML ${ingredient} and 50 g melted butter until just combined.` }] });
    const same = swapCard('heavy cream', null), SAME = 'SWAP_IS_SAME_INGREDIENT: heavy cream resolves to heavy cream';
    const ranked = (cs: unknown[]) => ({ cards: SHORTCAKE_CARDS.cards.flatMap((c) => (c.useRef === dough.useRef ? cs : [c])) });
    const at = (cs: unknown[]) => checkCards(ranked(cs), refsOf(r0), r0, vocab, null).entries.find((e) => e.useId === refsOf(r0).uses[dough.useRef as unknown as string])!;
    expect(at([same, swapCard('whole milk', 'whole-milk')])).toMatchObject({ status: 'COMPILED', alternates: [{ name: 'heavy cream', reason: SAME }, { name: 'whole milk', reason: null }] });
    expect(at([same, { ...swapCard('whole milk', 'whole-milk'), siblings: [] }])).toMatchObject({ status: 'INVALID', reason: SAME, alternates: [{ reason: SAME }, { reason: 'SIBLING_MISSED: step 6' }] });
    expect(at([dough, dough, dough, dough]).reason).toBe('DUPLICATE_CARD');   // more than three for one use is malformed
    // through the import: the second suggestion is bound, and the first keeps its reason
    const { auth, saved } = await imported(['shortcake'], Object.fromEntries(Object.entries(rec.cards).map(([k, raw]) => [k, raw === SHORTCAKE_CARDS ? ranked([same, dough]) : raw])));
    const pack = auth.coverageOf(saved.shortcake.draftId).pack!;
    const useId = refsOf(pack.recipe).uses[dough.useRef as unknown as string];
    expect(pack.cards!.find((e) => e.useId === useId)!.alternates).toEqual([{ name: 'heavy cream', reason: SAME }, { name: dough.swap.ingredient, reason: null, used: true }]);
    expect(pack.bindings.some((b) => b.card && b.targetUseId === useId)).toBe(true);
    // only the same ingredient under another name was suggested: no alternative was drafted, so "no alternative found"
    const only = await imported(['shortcake'], Object.fromEntries(Object.entries(rec.cards).map(([k, raw]) => [k, raw === SHORTCAKE_CARDS ? ranked([same]) : raw])));
    const p2 = only.auth.coverageOf(only.saved.shortcake.draftId).pack!, u2 = refsOf(p2.recipe).uses[dough.useRef as unknown as string];
    const a2 = only.auth.wireDraft(only.saved.shortcake.draftId).content!.ingredients.flatMap((g) => g.uses).find((x) => x.id === u2)!.analysis!;
    expect(a2).toMatchObject({ status: 'evaluatedNoOption', reason: { code: 'sameIngredient', text: expect.stringMatching(/^The import analysis suggested heavy cream, which is the cream under another name, so there’s no alternative to offer here\./) } });
  });
  it('normalization: only meaning-preserving repairs, each named; contradictory forms still fail', () => {
    const omitSalt = SHORTCAKE_CARDS.cards[3] as Record<string, unknown>;
    const { swap: _drop, ...noSwapField } = omitSalt;
    expect(reasonFor(noSwapField)).toMatchObject({ status: 'COMPILED', normalized: ['absent swap read as null ("omit" card)'] });
    expect(reasonFor({ ...omitSalt, siblings: [{ useRef: 'U4', handling: 'coveredBy', note: 'The salt in step 2.' }] })).toMatchObject({ status: 'COMPILED', normalized: ['own use U4 dropped from its siblings'] });
    expect(reasonFor({ ...omitSalt, siblings: [{ useRef: 'U1', handling: 'unchanged', note: 'The flour stays.' }] })).toMatchObject({ status: 'COMPILED', normalized: ['U1 (another ingredient, "unchanged") dropped from the siblings'] });
    expect(reasonFor({ ...omitSalt, siblings: [{ useRef: 'U4', handling: 'cantCover', note: 'The salt in step 2.' }] }).reason).toBe('SIBLING_NOT_SAME_INGREDIENT: U4');
    expect(reasonFor({ ...omitSalt, siblings: [{ useRef: 'U1', handling: 'coveredBy', note: 'The flour too.' }] }).reason).toBe('SIBLING_NOT_SAME_INGREDIENT: U1');
    // the retained live salt card's garbled rewrite ("… and sugar"): a rewrite may not name an ingredient again
    expect(reasonFor({ ...omitSalt, stepRewrites: [{ stepRef: 'S2', text: 'Whisk 250 g flour, 30 g sugar, 2 tsp baking powder and sugar.' }] }).reason).toBe('REWRITE_EXTRA_INGREDIENT: step 2 names sugar again');
    const { swap: _s, ...swapWithoutField } = dough;
    expect(reasonFor(swapWithoutField).reason).toMatch(/^SCHEMA: swap/);                              // a "swap" card without one is not repaired
  });
  it('a stale-amount rewrite', () => expect(reasonFor({ ...dough, stepRewrites: [{ stepRef: 'S4', text: 'Stir in 130 ML milk and 50 g melted butter, or 180 ML heavy cream, until just combined.' }] }).reason).toMatch(/^STALE_AMOUNT: step 4 untokenized amount "180 ML"/));
  it('an invented alternative in an opinion', () => {
    const whip = SHORTCAKE_CARDS.cards[6];
    expect(reasonFor({ ...whip, opinion: 'No, because it has to whip and hold air; try margarine instead.' }).reason).toMatch(/^SUGGESTS_ALTERNATIVE/);
    expect(reasonFor({ ...whip, opinion: 'No, because it has to whip; use 300 ML coconut milk.' }).reason).toMatch(/^INVENTED_NUMBER|^INVENTED_INGREDIENT/);
    expect(reasonFor({ ...whip, opinion: 'No, because lemon juice would curdle.' }).reason).toBe('INVENTED_INGREDIENT: opinion "lemon juice"');
  });
  it('also: out-of-ratio amounts, equivalence claims, rewrites outside the swap, a "no" that is not a no', () => {
    expect(reasonFor({ ...dough, swap: { ...dough.swap, amountText: '900 ML' } }).reason).toMatch(/^AMOUNT_RATIO/);
    expect(reasonFor({ ...dough, tradeoff: 'The shortcakes will be identical.' }).reason).toBe('CLAIMS_EQUIVALENT: tradeoff');
    expect(reasonFor({ ...dough, stepRewrites: [...(dough.stepRewrites as object[]), { stepRef: 'S5', text: 'Pat into 6 rounds and bake.' }] }).reason).toBe('REWRITE_OUTSIDE_SWAP: step 5');
    expect(reasonFor({ ...SHORTCAKE_CARDS.cards[6], opinion: 'Yes, it is fine without it here.' }).reason).toBe('NO_MUST_START_WITH_NO');
  });
  it('a plan may not replace a use whose answer is "no" (reviewed refusal or its own card): live probe finding, 2026-10-04', async () => {
    // the live shortcake card swapped the dough cream for milk and marked the whipping cream "coveredBy": whipping milk
    const bad = structuredClone(rec.cards);
    for (const v of Object.values(bad) as { cards: Record<string, unknown>[] }[]) for (const c of v.cards) {
      if (c.useRef === 'U6' && (c.siblings as { useRef: string }[])?.[0]?.useRef === 'U7') Object.assign(c, { swap: { ingredient: 'milk', kindId: 'whole-milk', amountText: '180 ML', otherIngredients: [] }, stepRewrites: [{ stepRef: 'S4', text: 'Stir in 180 ML milk until just combined.' }], siblings: [{ useRef: 'U7', handling: 'coveredBy', note: 'The same swap applies to the heavy cream in step 6.' }],
        opinion: 'Use milk if you run out of heavy cream; the shortcake will still come together but may be less moist.' });
    }
    const { svc, auth, saved } = await imported(['shortcake'], bad);
    expect(auth.coverageOf(saved.shortcake.draftId).pack!.warnings).toContainEqual(expect.stringMatching(/^CARD_INVALID:.*COVERS_A_REFUSED_USE: step 6 \(Milk and butter for cream that must whip\)/));
    const k = await cookTo(svc, saved.shortcake.recipeId, 3);
    const e4 = await k.ask(/cream/i, ['whole-milk']);
    expect(e4.outcome === 'refused' && e4.why.verdict).toBe('no');   // never a plan that whips milk
  });

  it('a failed card shows "We couldn\'t work out a swap for this one"; the reason stays in diagnostics', async () => {
    const bad = structuredClone(rec.cards);
    for (const v of Object.values(bad) as { cards: { useRef: string; siblings: unknown[] }[] }[]) for (const c of v.cards) if (c.useRef === 'U6' && c.siblings.length === 1) c.siblings = [];
    const { auth, saved } = await imported(['shortcake'], bad);
    const c = auth.getDraft(saved.shortcake.draftId).draft.content!;
    const doughUse = c.ingredients.find((i) => /cream/i.test(i.name))!.uses[0];
    expect(doughUse.swap).toMatchObject({ text: expect.stringMatching(/^We couldn't work out a swap for this one/), origin: 'importCard' });
    expect(auth.coverageOf(saved.shortcake.draftId).pack!.warnings).toContainEqual(expect.stringMatching(/^CARD_INVALID:.*SIBLING_MISSED: step 6/));
  });
});

describe('protections hold on card plans (same engine)', () => {
  it('started step → protected; availability no → refused; apply once; earlier-change conflict; at most 4 changes', async () => {
    const { svc, saved } = await imported(['risotto']);
    // started step
    let k = await cookTo(svc, saved.risotto.recipeId, 6);
    const run = svc.getActiveRecipe().run!;
    const st = svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: run.steps[6].stepId, progress: 'started' });
    expect(st.outcome).toBe('recorded');
    const pw = await k.ask(/parmesan/i);
    expect(pw.outcome === 'refused' && pw.refusal.kind).toBe('protectedWork');
    // availability no
    k = await cookTo(svc, saved.risotto.recipeId, 6);
    const no = await k.askAll(/parmesan/i, 'no');
    expect(no.outcome === 'refused' && no.why.facts[0]).toBe("Without those, there's no prepared change for parmesan here");
    // explicit acceptance, apply once
    k = await cookTo(svc, saved.risotto.recipeId, 6);
    const ev = await k.askAll(/^salt/i);
    if (ev.outcome !== 'proposal') throw new Error(ev.outcome);
    expect(apply(svc, ev, false)).toMatchObject({ outcome: 'rejected', code: 'ACCEPTANCE_REQUIRED' });
    const first = apply(svc, ev);
    expect(first.outcome).toBe('applied');
    expect(apply(svc, ev)).toMatchObject({ outcome: 'rejected', code: 'STALE_STATE' });   // the run moved on: never applied twice
    expect(svc.getActiveRecipe().run!.appliedAmendments).toHaveLength(1);
    // a later change may not rewrite a step an earlier change altered (salt omit rewrote step 7; the Parmesan card touches step 7)
    const conflict = await k.askAll(/parmesan/i);
    expect(conflict.outcome === 'refused' && conflict.refusal.kind).toBe('earlierChangeConflict');
    // at most 4 changes per run
    svc.store.run('UPDATE runs SET applied_rescue_count = 4 WHERE run_id = ?', svc.getActiveRecipe().run!.id);
    const limit = await k.askAll(/butter/i);
    expect(limit.outcome === 'refused' && limit.refusal.kind).toBe('rescueLimitReached');
  });

  it('cards are pinned with the saved version: different cards make a different pack', async () => {
    const a = await imported(['shortcake']);
    const other = structuredClone(rec.cards);
    for (const v of Object.values(other) as { cards: { useRef: string; opinion: string }[] }[]) for (const c of v.cards) if (c.useRef === 'U9') c.opinion = 'Fill the shortcakes with 500 g raspberries.';
    const b = await imported(['shortcake'], other);
    const pa = a.auth.catalog()[0].pack!, pb = b.auth.catalog()[0].pack!;
    expect(pa.cardSetHash).not.toBe(pb.cardSetHash);
    expect(pa.packHash).toBe(hash({ recipeHash: pa.recipeHash, vocabularyHash: pa.vocabularyHash, patternSetHash: pa.patternSetHash, engineSemantics: pa.engineSemantics, cardSetHash: pa.cardSetHash }));
    // a run is pinned to the pack it started on
    const st = a.svc.startRecipe({ commandId: cmd(), recipeId: a.saved.shortcake.recipeId });
    expect(st.outcome === 'started' && a.svc.store.get<{ pack_hash: string }>('SELECT pack_hash FROM runs WHERE run_id = ?', st.run.id)!.pack_hash).toBe(pa.packHash);
  });
});

describe('start over', () => {
  it('archives first, then clears sessions and every import; nothing is restored', async () => {
    const { svc, saved } = await imported(['risotto', 'shortcake']);
    await cookTo(svc, saved.shortcake.recipeId, 1);
    const archive = join(mkdtempSync(join(tmpdir(), 'ccmcp-arch-')), 'a.db');
    svc.startOver(archive);
    expect(svc.listRecipes().recipes).toEqual([]);                                   // this service lists no examples (fixtureRecipes: false)
    expect(svc.getActiveRecipe().run).toBeNull();
    expect(new DatabaseSync(archive, { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM saved_recipes').get()).toEqual({ n: 2 });   // the copy kept both
  });
});
