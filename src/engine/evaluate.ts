// Deterministic runtime evaluator (ESOD §6). Pure: no I/O, no clock, no model, no recipe-specific branches.
import {
  ENGINE_SEMANTICS, MAX_CHANGES_PER_RUN,
  type Binding, type Candidate, type DecisionTrace, type EvaluationResult, type Id, type IngredientUse, type LedgerRow,
  type ProposalResponse, type ProtectedFact, type Question, type Recipe, type RecipePack, type Refusal, type RefusalCode,
  type Requirement, type RescueRequest, type RoleRow, type RunSnapshot, type StepChange, type Target, type TraceCheck,
  type Vocabulary,
} from '../contract/types.ts';
import { add, canonicalJson, hash, type Rational } from '../domain/rational.ts';
import {
  amountDisplay, currentStepId, getIngredient, getStep, getUse, lowerFirst, qtyText, renderStep, stepOrder, upperFirst,
  useLabel, validateStructure,
} from '../domain/recipe.ts';
import { functionLabel, kindOf, proposalClasses, sameSet } from '../domain/vocabulary.ts';
import { applyOps, checkFunctionAccounting, historyProof, touched } from './apply.ts';
import { diffSegments } from './render.ts';

export type Answers = Map<Id, 'ENOUGH' | 'NOT_ENOUGH' | 'UNKNOWN'> | 'ASSUME_ENOUGH';

/** The facts a binding read; a different hash at runtime means the binding no longer describes this recipe. */
export function factsHashOf(r: Recipe, target: IngredientUse, ctx: { slots: Record<Id, Id> }): string {
  const entities = [target.useId, ...Object.values(ctx.slots)].map((id) => getUse(r, id) ?? getStep(r, id) ?? null);
  return hash({ target, entities, ingredient: getIngredient(r, target.ingredientId), targetStep: getStep(r, target.stepId) });
}

const short = (v: Vocabulary, r: Recipe, u: IngredientUse) => {
  const ing = getIngredient(r, u.ingredientId)!;
  return (ing.kind && kindOf(v, ing.kind.kindId)?.short) || lowerFirst(ing.name);
};
const fnLabel = (v: Vocabulary, u: IngredientUse, fid: Id) => u.functions.find((f) => f.functionId === fid)?.label ?? functionLabel(v, fid);
const fnLabels = (v: Vocabulary, u: IngredientUse) => u.functions.map((f) => f.label ?? functionLabel(v, f.functionId));

// ---------- requirements and availability ----------
function requirementsFor(before: Recipe, after: Recipe, snap: RunSnapshot): Requirement[] {
  const beforeIds = new Set(before.uses.map((u) => u.useId)), afterIds = new Set(after.uses.map((u) => u.useId));
  const fresh = after.uses.filter((u) => u.kind === 'ADD' && !beforeIds.has(u.useId));
  const out: Requirement[] = [];
  for (const ingId of [...new Set(fresh.map((u) => u.ingredientId))]) {
    const uses = fresh.filter((u) => u.ingredientId === ingId);
    const name = lowerFirst(getIngredient(after, ingId)!.name);
    const exact = uses.filter((u) => u.amount.kind === 'EXACT');
    if (exact.length) {
      const unit = (exact[0].amount as { unit: 'G' | 'ML' | 'COUNT' }).unit;
      let base: Rational = { n: 0, d: 1 }, upTo: Rational = { n: 0, d: 1 };
      for (const u of exact) {
        if (u.amount.kind !== 'EXACT' || u.amount.unit !== unit) throw new Error(`mixed units for ${ingId}`);
        base = add(base, u.amount.value);
        if (u.allowance) upTo = add(upTo, u.allowance.max);
      }
      const reservedUses = before.uses.filter((u) => u.ingredientId === ingId && u.kind === 'ADD' && afterIds.has(u.useId)
        && (snap.useStatus[u.useId] ?? 'UNADDED') !== 'ADDED' && u.amount.kind === 'EXACT' && u.amount.unit === unit);
      const reserved = reservedUses.reduce<Rational>((a, u) => add(a, (u.amount as { value: Rational }).value), { n: 0, d: 1 });
      const prep = exact[0].prepNote;
      const display = `${qtyText(base, unit)}${reservedUses.length ? ' more' : ''} ${[prep, name].filter(Boolean).join(' ')}`
        + (upTo.n ? `, plus up to ${qtyText(upTo, unit)} more only if needed` : '');
      out.push({
        ingredientId: ingId, name, qty: add(base, upTo), unit, display,
        forSteps: [...new Set(exact.map((u) => u.stepId))].map((stepId) => ({ stepId, order: stepOrder(after, stepId) })),
        includesUpTo: upTo.n ? upTo : null,
        alreadyReserved: reservedUses.length ? {
          qty: reserved, display: qtyText(reserved, unit),
          forSteps: reservedUses.map((u) => ({ stepId: u.stepId, order: stepOrder(after, u.stepId) })),
        } : null,
      });
    }
    // Qualitative amounts stay unresolved: never zero, never summed, always confirmed separately (OD-3 boundary).
    for (const u of uses.filter((x) => x.amount.kind !== 'EXACT')) {
      const step = getStep(after, u.stepId)!, n = stepOrder(after, u.stepId);
      out.push({
        ingredientId: ingId, name, qty: null, unit: null,
        display: `${upperFirst(amountDisplay(u.amount))} more ${name} for step ${n}${step.title ? ` (${step.title})` : ''} — amount not stated, on top of any ${name} above`,
        forSteps: [{ stepId: u.stepId, order: n }], includesUpTo: null, alreadyReserved: null,
      });
    }
  }
  return out;
}

function questionsFor(bindingId: Id, reqs: Requirement[], after: Recipe): Question[] {
  const qs: Question[] = [];
  const mk = (group: Requirement[], prompt: string, note: string | null): Question => {
    const requirementHash = hash(group);
    return { questionId: `q.${hash({ bindingId, requirementHash }).slice(0, 16)}`, kind: 'AVAILABILITY', candidateId: bindingId, requirementHash, prompt, requirements: group, note };
  };
  const exact = reqs.filter((r) => r.qty !== null);
  if (exact.length) {
    const notes = exact.filter((r) => r.alreadyReserved).map((r) =>
      `The ${r.alreadyReserved!.display} ${lowerFirst(getIngredient(after, r.ingredientId)!.name)} already in the recipe stays reserved for step ${r.alreadyReserved!.forSteps.map((s) => s.order).join(', ')}.`);
    qs.push(mk(exact, `Do you have ${exact.length === 1 ? 'this' : exact.length === 2 ? 'both of these' : 'all of these'}?`, notes.join(' ') || null));
  }
  for (const r of reqs.filter((x) => x.qty === null)) qs.push(mk([r], 'Do you also have this?', 'Confirming the amounts above does not cover this.'));
  return qs;
}

// ---------- candidate projection ----------
function buildCandidate(b: Binding, snap: RunSnapshot, after: Recipe, resumeStepId: Id, reqs: Requirement[], v: Vocabulary, packHash: string): Candidate {
  const before = snap.recipe;
  const beforeIds = new Set(before.uses.map((u) => u.useId)), afterIds = new Set(after.uses.map((u) => u.useId));
  const requiredIng = new Set(reqs.map((r) => r.ingredientId));
  const reservedUse = (u: IngredientUse) => requiredIng.has(u.ingredientId) && u.kind === 'ADD' && beforeIds.has(u.useId) && afterIds.has(u.useId)
    && (snap.useStatus[u.useId] ?? 'UNADDED') !== 'ADDED';
  const changes: StepChange[] = after.steps.map((s, i) => {
    const prev = getStep(before, s.stepId);
    const beforeText = prev ? renderStep(before, prev) : null, afterText = renderStep(after, s);
    const changed = !prev || prev.text !== s.text || prev.title !== s.title || beforeText !== afterText;
    const reserved = after.uses.filter((u) => u.stepId === s.stepId && reservedUse(u));
    return {
      stepId: s.stepId, kind: prev ? (changed ? 'CHANGED' : 'UNCHANGED') : 'INSERTED',
      when: snap.stepStatus[s.stepId] === 'COMPLETED' ? 'DONE' : s.stepId === resumeStepId ? 'NOW' : 'LATER',
      prevOrder: prev ? stepOrder(before, s.stepId) : null, newOrder: i + 1,
      before: changed ? beforeText : null, after: changed ? afterText : null,
      titleAfter: prev && prev.title !== s.title ? s.title : null,
      segments: changed ? diffSegments(beforeText ?? '', afterText) : null,
      note: !changed && reserved.length ? reserved.map((u) => `${amountDisplay(u.amount)} ${short(v, after, u)} still reserved here`).join('; ') : null,
    };
  });
  const ledger: LedgerRow[] = [];
  const ingName = (r: Recipe, u: IngredientUse) => getIngredient(r, u.ingredientId)!.name;
  for (const u of before.uses.filter((x) => x.kind === 'ADD' && !afterIds.has(x.useId))) {
    ledger.push({ ingredient: ingName(before, u), stepId: u.stepId, order: stepOrder(before, u.stepId), before: amountDisplay(u.amount), after: 'Not needed', kind: 'removed', roles: fnLabels(v, u).join(' · ') });
  }
  for (const u of after.uses.filter((x) => !beforeIds.has(x.useId))) {
    const more = reqs.find((r) => r.ingredientId === u.ingredientId)?.alreadyReserved ? ' more' : '';
    const upTo = u.allowance ? `, plus up to ${qtyText(u.allowance.max, u.allowance.unit)} more if needed` : '';
    ledger.push({ ingredient: upperFirst([u.prepNote, lowerFirst(ingName(after, u))].filter(Boolean).join(' ')), stepId: u.stepId, order: stepOrder(after, u.stepId),
      before: '—', after: `${amountDisplay(u.amount)}${more}${upTo}`, kind: 'added', roles: fnLabels(v, u).join(' · ') });
  }
  for (const u of after.uses.filter(reservedUse)) {
    ledger.push({ ingredient: ingName(after, u), stepId: u.stepId, order: stepOrder(after, u.stepId), before: amountDisplay(u.amount), after: `${amountDisplay(u.amount)}, still reserved`, kind: 'unchanged', roles: fnLabels(v, u).join(' · ') });
  }
  const target = getUse(before, b.targetUseId)!;
  for (const u of before.uses.filter((x) => x.ingredientId === target.ingredientId && x.kind === 'ADD' && snap.useStatus[x.useId] === 'ADDED')) {
    ledger.push({ ingredient: ingName(before, u), stepId: u.stepId, order: stepOrder(before, u.stepId), before: amountDisplay(u.amount), after: 'Used · done', kind: 'done', roles: fnLabels(v, u).join(' · ') });
  }
  ledger.sort((a, b2) => a.order - b2.order);
  const roleMap: RoleRow[] = b.functionMap.filter((e) => e.fromUseId !== null).map((e) => {
    const from = getUse(before, e.fromUseId!)!;
    const role = upperFirst(fnLabel(v, from, e.functionId)) + (from.useId !== b.targetUseId ? ` · step ${stepOrder(before, from.stepId)}` : '');
    if (e.disposition === 'DROPPED_WITH_TRADEOFF' || !e.toUseId) return { role, replacement: 'Not replaced · see What to expect', kind: 'lost' };
    const to = getUse(after, e.toUseId)!;
    return { role, replacement: `${upperFirst([to.prepNote, short(v, after, to)].filter(Boolean).join(' '))}, step ${stepOrder(after, to.stepId)}`, kind: 'replaced' };
  });
  const noLongerUsed = before.ingredients
    .filter((i) => before.uses.some((u) => u.ingredientId === i.ingredientId && u.kind === 'ADD') && !after.uses.some((u) => u.ingredientId === i.ingredientId))
    .map((i) => ({ ingredientId: i.ingredientId, name: i.name }));
  const rs = getStep(after, resumeStepId)!;
  const resume = { stepId: resumeStepId, order: stepOrder(after, resumeStepId), title: rs.title, text: renderStep(after, rs) };
  const planHash = hash({
    packHash, engineSemantics: ENGINE_SEMANTICS, bindingId: b.bindingId, runId: snap.runId, epoch: snap.epoch,
    baseRevision: snap.revision, version: snap.version, ops: b.ops, resultRecipeHash: hash(after), functionMap: b.functionMap,
    resume: resumeStepId, requirementHash: hash(reqs),
  });
  return {
    candidateId: b.bindingId, planHash, patternTitle: b.patternTitle, consequence: b.consequence!, changes, ledger, roleMap, noLongerUsed,
    requirements: reqs, resume, quantityStatus: b.quantityStatus, origin: b.card ? 'IMPORT_CARD' : 'REVIEWED', ops: b.ops, resultRecipe: after,
  };
}

// ---------- per-binding ordered checks (ESOD §6.4) ----------
export interface BindingOutcome {
  status: 'ELIGIBLE' | 'NEEDS_AVAILABILITY' | 'REFUSED';
  candidate: Candidate | null; questions: Question[];
  refusalCode: RefusalCode | null; protectedFacts: ProtectedFact[]; subjectUseId: Id | null;
  checks: TraceCheck[];
}

export function evaluateBinding(b: Binding, snap: RunSnapshot, v: Vocabulary, answers: Answers, packHash: string): BindingOutcome {
  const r = snap.recipe, checks: TraceCheck[] = [];
  const ok = (stage: TraceCheck['stage'], check: string) => checks.push({ stage, check, result: 'PASS', code: null, detail: null });
  const refuse = (stage: TraceCheck['stage'], check: string, code: RefusalCode, detail: string, protectedFacts: ProtectedFact[] = [], subjectUseId: Id | null = null): BindingOutcome => {
    checks.push({ stage, check, result: 'FAIL', code, detail });
    return { status: 'REFUSED', candidate: null, questions: [], refusalCode: code, protectedFacts, subjectUseId, checks };
  };
  const target = getUse(r, b.targetUseId);
  if (!target || factsHashOf(r, target, { slots: b.slots }) !== b.factsHash) return refuse('FUNCTION', 'reviewed facts unchanged', 'NOT_APPLICABLE_NOW', 'binding facts differ from this recipe version');
  ok('FUNCTION', 'reviewed facts unchanged');

  const t = touched(r, b.ops);
  const pf: ProtectedFact[] = [];
  for (const id of t.steps) {
    const st = snap.stepStatus[id] ?? 'NOT_STARTED';
    if (st !== 'NOT_STARTED') pf.push({ kind: st === 'STARTED' ? 'STEP_STARTED' : 'STEP_COMPLETED', stepId: id, order: stepOrder(r, id) });
  }
  for (const id of t.uses) {
    const us = snap.useStatus[id] ?? 'UNADDED', u = getUse(r, id)!;
    if (us !== 'UNADDED') pf.push({ kind: us === 'PARTIAL' ? 'USE_PARTIAL' : 'USE_ADDED', useId: id, label: useLabel(r, u), order: stepOrder(r, u.stepId) });
  }
  if (pf.length) return refuse('HISTORY', 'touched work not started', 'PROTECTED_WORK', pf.map((p) => p.kind).join(', '), pf);
  ok('HISTORY', 'touched work not started');

  const siblings = r.uses.filter((u) => u.kind === 'ADD' && u.ingredientId === target.ingredientId && u.useId !== target.useId && snap.useStatus[u.useId] !== 'ADDED');
  for (const s of siblings) {
    if (snap.useStatus[s.useId] === 'PARTIAL') return refuse('AFFECTED_USES', `affected use ${s.useId}`, 'AFFECTED_USE_IN_PROGRESS', s.useId,
      [{ kind: 'USE_PARTIAL', useId: s.useId, label: useLabel(r, s), order: stepOrder(r, s.stepId) }], s.useId);
    if (!b.coveredSiblingUseIds.includes(s.useId)) return refuse('AFFECTED_USES', `affected use ${s.useId}`, 'AFFECTED_USE_UNACCOUNTED', s.useId, [], s.useId);
  }
  ok('AFFECTED_USES', `every remaining use accounted (${siblings.length})`);

  const cur = currentStepId(r, snap.stepStatus);
  for (const g of b.guards) {
    if (cur !== g.stepId) return refuse('GUARD', `current step is ${g.stepId}`, 'NOT_APPLICABLE_NOW', `current step is ${cur}`, [], null);
  }
  ok('GUARD', 'current step');

  let after: Recipe, resumeStepId: Id | null;
  try { ({ recipe: after, resumeStepId } = applyOps(r, b.ops)); }
  catch (e) { return refuse('APPLY', 'ops apply', 'NOT_APPLICABLE_NOW', (e as Error).message); }
  if (!resumeStepId || (snap.stepStatus[resumeStepId] ?? 'NOT_STARTED') !== 'NOT_STARTED' || currentStepId(after, snap.stepStatus) !== resumeStepId) {
    return refuse('APPLY', 'resume is the first unfinished, not-started step', 'NOT_APPLICABLE_NOW', `resume ${resumeStepId}`);
  }
  const proof = historyProof(r, after, snap.stepStatus, snap.useStatus);
  if (proof) return refuse('APPLY', 'progressed history byte-identical', 'PROTECTED_WORK', proof);
  ok('APPLY', 'progressed history byte-identical');

  const fa = checkFunctionAccounting(r, after, b.functionMap);
  if (fa) return refuse('FUNCTION_ACCOUNTING', 'every removed function accounted', 'NOT_APPLICABLE_NOW', fa);
  ok('FUNCTION_ACCOUNTING', 'every removed function accounted');

  const errs = validateStructure(after, v, t.steps);
  if (errs.length) return refuse('RESULT_VALIDATION', 'resulting recipe valid', 'NOT_APPLICABLE_NOW', errs.join('; '));
  ok('RESULT_VALIDATION', 'resulting recipe valid');

  const reqs = requirementsFor(r, after, snap);
  const candidate = buildCandidate(b, snap, after, resumeStepId, reqs, v, packHash);
  const qs = questionsFor(b.bindingId, reqs, after);
  const answerOf = (q: Question) => (answers === 'ASSUME_ENOUGH' ? 'ENOUGH' : answers.get(q.questionId) ?? 'UNKNOWN');
  if (qs.some((q) => answerOf(q) === 'NOT_ENOUGH')) return refuse('AVAILABILITY', 'additional amounts available', 'INSUFFICIENT_AVAILABILITY', 'cook answered not enough');
  const open = qs.filter((q) => answerOf(q) !== 'ENOUGH');
  if (open.length) {
    checks.push({ stage: 'AVAILABILITY', check: 'additional amounts available', result: 'UNKNOWN', code: null, detail: `${open.length} question(s) open` });
    return { status: 'NEEDS_AVAILABILITY', candidate, questions: open, refusalCode: null, protectedFacts: [], subjectUseId: null, checks };
  }
  ok('AVAILABILITY', 'additional amounts available');
  return { status: 'ELIGIBLE', candidate, questions: [], refusalCode: null, protectedFacts: [], subjectUseId: null, checks };
}

// ---------- refusal copy (deterministic, closed table) ----------
const PRIORITY: RefusalCode[] = ['PROTECTED_WORK', 'AFFECTED_USE_IN_PROGRESS', 'CONFLICTS_WITH_EARLIER_CHANGE', 'AFFECTED_USE_UNACCOUNTED', 'INSUFFICIENT_AVAILABILITY', 'NOT_APPLICABLE_NOW'];

function makeRefusal(code: RefusalCode, snap: RunSnapshot, v: Vocabulary, ctx: {
  ingredientId?: Id; target?: IngredientUse; refusalBinding?: Binding; protectedFacts?: ProtectedFact[]; subjectUseId?: Id | null; reason?: Refusal['reason'];
  origin?: Refusal['origin'];
}): Refusal {
  const r = snap.recipe;
  const ing = ctx.ingredientId ? getIngredient(r, ctx.ingredientId) : undefined;
  const name = ing ? lowerFirst(ing.name) : 'that ingredient';
  const cur = currentStepId(r, snap.stepStatus);
  const curStep = cur ? getStep(r, cur) : undefined;
  const t = ctx.target;
  const tOrder = t ? stepOrder(r, t.stepId) : null;
  const subj = ctx.subjectUseId ? getUse(r, ctx.subjectUseId) : undefined;
  const firstPf = ctx.protectedFacts?.[0];
  const origin = ctx.origin ?? (ctx.refusalBinding ? (ctx.refusalBinding.card ? 'IMPORT_CARD' : 'REVIEWED') : null);
  const plan = origin === 'IMPORT_CARD' ? 'prepared' : 'reviewed';   // honest labelling: an import card is not a reviewed rule
  const messages: Record<RefusalCode, string> = {
    NOT_FUNCTIONALLY_EQUIVALENT: ctx.refusalBinding?.refusal?.text ?? '',
    PROTECTED_WORK: firstPf ? (firstPf.kind.startsWith('STEP')
      ? `Step ${firstPf.order} is marked ${firstPf.kind === 'STEP_STARTED' ? 'started' : 'done'}, so this change can't be used.`
      : `Some ${name} is already in for step ${firstPf.order}, so this change can't be used.`) : `Work this change would rewrite is already reported, so it can't be used.`,
    AFFECTED_USE_IN_PROGRESS: `Some ${name} for step ${subj ? stepOrder(r, subj.stepId) : '?'} is already in, so this change can't be used.`,
    AFFECTED_USE_UNACCOUNTED: `The ${plan} change doesn't cover the ${name} in step ${subj ? stepOrder(r, subj.stepId) : '?'}, so it can't be used.`,
    NO_SUPPORTED_RECOVERY: `There's no reviewed change for ${name} in this recipe. That isn't a judgement that nothing else could work.`,
    NOT_APPLICABLE_NOW: `The ${plan} change for ${name} doesn't apply at this point in the recipe.`,
    INSUFFICIENT_AVAILABILITY: `Without those, there's no ${plan} change for ${name} here.`,
    REFERENCE_NOT_IN_RECIPE: `That ingredient isn't in this recipe.`,
    NOTHING_TO_CHANGE: ctx.reason === 'REPLACED_BY_AMENDMENT' ? `${upperFirst(name)} is no longer in your recipe after the change you accepted.` : `All the ${name} in this recipe is already in.`,
    SUCCESSIVE_RESCUE_UNSUPPORTED: `This cooking session already used its ${MAX_CHANGES_PER_RUN} changes.`,
    CONFLICTS_WITH_EARLIER_CHANGE: `That change would rewrite a step an earlier change in this session already altered, so no change can be offered here.`,
    NOT_RELEASED: `This recipe isn't released for cooking guidance.`,
  };
  return {
    code, message: messages[code], reason: ctx.reason ?? null, origin,
    ingredientUses: ing ? r.uses.filter((u) => u.ingredientId === ing.ingredientId && u.kind === 'ADD').map((u) => ({
      useId: u.useId, stepId: u.stepId, order: stepOrder(r, u.stepId), label: useLabel(r, u), functionLabels: fnLabels(v, u), status: snap.useStatus[u.useId] ?? 'UNADDED',
    })) : [],
    requiredFunction: code === 'NOT_FUNCTIONALLY_EQUIVALENT' && t && ctx.refusalBinding?.refusal
      ? { label: ctx.refusalBinding.refusal.requiredFunctionLabel, stepId: t.stepId, order: tOrder!, stepText: renderStep(r, getStep(r, t.stepId)!) } : null,
    protectedFacts: ctx.protectedFacts ?? [],
    scopeNote: ctx.refusalBinding?.refusal?.scopeNote ?? (code === 'NO_SUPPORTED_RECOVERY' ? 'This means no change has been reviewed for this use.' : null),
    unchanged: t ? `Your recipe is unchanged. Step ${tOrder} still needs ${useLabel(r, t)}.` : 'Your recipe is unchanged.',
    nextAction: cur && curStep ? { kind: 'CONTINUE_STEP', stepId: cur, order: stepOrder(r, cur), text: renderStep(r, curStep) } : { kind: 'NONE' },
  };
}

// ---------- entry ----------
export function evaluate(pack: RecipePack, v: Vocabulary, snap: RunSnapshot, req: RescueRequest, released = false): EvaluationResult {
  const r = snap.recipe;
  const stateHash = hash({ recipe: hash(r), stepStatus: snap.stepStatus, useStatus: snap.useStatus, version: snap.version });
  const trace: DecisionTrace = { kind: 'cc-decision-trace/2', engineSemantics: ENGINE_SEMANTICS, packHash: pack.packHash, stateHash, global: [], bindings: [] };
  const g = (stage: TraceCheck['stage'], check: string, result: TraceCheck['result'], code: string | null = null, detail: string | null = null) =>
    trace.global.push({ stage, check, result, code, detail });
  const notices = [...req.notices];
  const done = (x: Omit<EvaluationResult, 'trace' | 'notices' | 'speech'>): EvaluationResult => {
    const res = { ...x, notices, trace, speech: '' };
    res.speech = speechFor(res);
    return res;
  };
  const refused = (refusal: Refusal, target: Target | null = null, proposal: ProposalResponse | null = null) =>
    done({ status: 'REFUSED', target, proposal, candidates: [], previews: [], questions: [], refusal });

  if (snap.mode === 'COOK' && !released) {
    g('MODE', 'content released for COOK', 'FAIL', 'NOT_RELEASED');
    return done({ status: 'NOT_RELEASED', target: null, proposal: null, candidates: [], previews: [], questions: [], refusal: makeRefusal('NOT_RELEASED', snap, v, {}) });
  }
  g('MODE', `mode ${snap.mode}`, 'PASS');

  // TARGET (§6.2)
  const remainingIngredients = r.ingredients.filter((i) => r.uses.some((u) => u.ingredientId === i.ingredientId && u.kind === 'ADD' && snap.useStatus[u.useId] !== 'ADDED'));
  const referenceQuestion = (choices: { choiceId: Id; label: string }[]): EvaluationResult => {
    g('TARGET', 'missing ingredient identified', 'UNKNOWN', 'REFERENCE_REQUIRED');
    return done({ status: 'CLARIFY', target: null, proposal: null, candidates: [], previews: [], refusal: null,
      questions: [{ questionId: `q.ref.${hash(choices).slice(0, 12)}`, kind: 'REFERENCE', prompt: 'Which ingredient are you out of?', choices }] });
  };
  if (!req.missingIngredientId) return referenceQuestion(remainingIngredients.map((i) => ({ choiceId: i.ingredientId, label: i.name })));
  const ing = getIngredient(r, req.missingIngredientId);
  if (!ing) { g('TARGET', 'ingredient in recipe', 'FAIL', 'REFERENCE_NOT_IN_RECIPE'); return refused(makeRefusal('REFERENCE_NOT_IN_RECIPE', snap, v, {})); }
  const adds = r.uses.filter((u) => u.ingredientId === ing.ingredientId && u.kind === 'ADD').sort((a, b) => stepOrder(r, a.stepId) - stepOrder(r, b.stepId));
  if (!adds.length) {
    const reason = snap.version > 1 ? 'REPLACED_BY_AMENDMENT' : null;
    g('TARGET', 'ingredient has uses', 'FAIL', reason ? 'NOTHING_TO_CHANGE' : 'REFERENCE_NOT_IN_RECIPE');
    return refused(makeRefusal(reason ? 'NOTHING_TO_CHANGE' : 'REFERENCE_NOT_IN_RECIPE', snap, v, { ingredientId: ing.ingredientId, reason }));
  }
  const remaining = adds.filter((u) => snap.useStatus[u.useId] !== 'ADDED');
  if (!remaining.length) {
    g('TARGET', 'ingredient has remaining uses', 'FAIL', 'NOTHING_TO_CHANGE');
    return refused(makeRefusal('NOTHING_TO_CHANGE', snap, v, { ingredientId: ing.ingredientId, reason: 'ALL_USES_DONE',
      protectedFacts: adds.map((u) => ({ kind: 'USE_ADDED' as const, useId: u.useId, label: useLabel(r, u), order: stepOrder(r, u.stepId) })) }));
  }
  const cur = currentStepId(r, snap.stepStatus);
  const curOrder = cur ? stepOrder(r, cur) : Infinity;
  const tUse = remaining.find((u) => stepOrder(r, u.stepId) >= curOrder) ?? remaining[0];
  const sameStep = remaining.filter((u) => u.stepId === tUse.stepId);
  if (sameStep.length > 1) return referenceQuestion(sameStep.map((u) => ({ choiceId: u.useId, label: useLabel(r, u) })));
  const target: Target = {
    ingredientId: ing.ingredientId, name: ing.name, useId: tUse.useId, stepId: tUse.stepId, order: stepOrder(r, tUse.stepId),
    allRemainingUses: remaining.map((u) => ({ useId: u.useId, stepId: u.stepId, order: stepOrder(r, u.stepId), label: useLabel(r, u), status: snap.useStatus[u.useId] ?? 'UNADDED' })),
  };
  g('TARGET', `target ${tUse.useId}`, 'PASS');

  if (snap.appliedRescueCount >= MAX_CHANGES_PER_RUN) {
    g('RESCUE_LIMIT', `at most ${MAX_CHANGES_PER_RUN} changes per run`, 'FAIL', 'SUCCESSIVE_RESCUE_UNSUPPORTED');
    return refused(makeRefusal('SUCCESSIVE_RESCUE_UNSUPPORTED', snap, v, { ingredientId: ing.ingredientId, target: tUse }), target);
  }
  g('RESCUE_LIMIT', `at most ${MAX_CHANGES_PER_RUN} changes per run`, 'PASS');

  const B = pack.bindings.filter((b) => b.targetUseId === tUse.useId);   // COOK would further filter to released bindings
  g('SELECT', `bindings for ${tUse.useId}`, B.length ? 'PASS' : 'FAIL', B.length ? null : 'NO_SUPPORTED_RECOVERY', B.map((b) => b.bindingId).join(', ') || null);

  // PROPOSAL (§6.3)
  const pc = proposalClasses(v, req.proposedKindIds);
  pc.unknown.forEach((k) => notices.push({ kind: 'UNMAPPED_PROPOSAL', text: k }));
  const P = pc.classes;
  // an exact proposal match first; a refusal with no classes (an import card's "no") refuses any replacement (ENGINE_SEMANTICS 3)
  const refuser = (P.length ? B.find((b) => b.kind === 'REFUSAL' && b.refusal!.classes.length > 0 && sameSet(b.refusal!.classes, P)) : undefined)
    ?? B.find((b) => b.kind === 'REFUSAL' && b.refusal!.classes.length === 0);

  const outcomes = B.filter((b) => b.kind === 'RECOVERY').map((b) => {
    const answers = new Map(req.answers.map((a) => [a.questionId, a.choiceId] as const));
    const conflict = earlierChangeConflict(pack.recipe, snap.recipe, b);
    const o: BindingOutcome = conflict
      ? { status: 'REFUSED', candidate: null, questions: [], refusalCode: 'CONFLICTS_WITH_EARLIER_CHANGE', protectedFacts: [], subjectUseId: null,
          checks: [{ stage: 'HISTORY', check: 'touches nothing an earlier change altered', result: 'FAIL', code: 'CONFLICTS_WITH_EARLIER_CHANGE', detail: conflict }] }
      : evaluateBinding(b, snap, v, answers, pack.packHash);
    trace.bindings.push({ bindingId: b.bindingId, checks: o.checks, outcome: o.status + (o.refusalCode ? `:${o.refusalCode}` : '') });
    return { b, o };
  });
  for (const b of B.filter((x) => x.kind === 'REFUSAL')) trace.bindings.push({ bindingId: b.bindingId, checks: [], outcome: refuser === b ? 'PROPOSAL_REFUSED' : 'NOT_MATCHED' });
  const live = outcomes.filter((x) => x.o.status !== 'REFUSED');
  const eligible = live.filter((x) => x.o.status === 'ELIGIBLE'), pending = live.filter((x) => x.o.status === 'NEEDS_AVAILABILITY');

  let proposal: ProposalResponse | null = null;
  if (req.proposedKindIds.length) {
    const proposed = req.proposedKindIds.map((k) => ({ kindId: k, label: kindOf(v, k)?.label ?? k }));
    const realizer = live.find((x) => x.b.proposal?.relation === 'REALIZED_AS_PROPOSED' && sameSet(x.b.proposal.classes, P));
    const adapter = live.find((x) => x.b.proposal?.relation === 'ADAPTED' && P.length > 0 && P.every((c) => x.b.proposal!.classes.includes(c)));
    if (refuser) proposal = { proposed, response: 'REFUSED', text: refuser.refusal!.text, alternativeOffered: live.length > 0 };
    else if (realizer) proposal = { proposed, response: 'REALIZED_AS_PROPOSED', text: realizer.b.proposal!.text, alternativeOffered: live.some((x) => x !== realizer) };
    else if (adapter) proposal = { proposed, response: 'ADAPTED', text: adapter.b.proposal!.text, alternativeOffered: true };
    else proposal = { proposed, response: 'NOT_COVERED', text: null, alternativeOffered: live.length > 0 };
    g('PROPOSAL', `proposal ${P.join('+') || '(unknown kinds)'}`, 'PASS', proposal.response);
  }

  if (!live.length) {
    if (refuser) return refused(makeRefusal('NOT_FUNCTIONALLY_EQUIVALENT', snap, v, { ingredientId: ing.ingredientId, target: tUse, refusalBinding: refuser }), target, proposal);
    const failed = outcomes.filter((x) => x.o.refusalCode);
    const best = PRIORITY.map((c) => failed.find((x) => x.o.refusalCode === c)).find(Boolean);
    if (!best) return refused(makeRefusal('NO_SUPPORTED_RECOVERY', snap, v, { ingredientId: ing.ingredientId, target: tUse }), target, proposal);
    return refused(makeRefusal(best.o.refusalCode!, snap, v, { ingredientId: ing.ingredientId, target: tUse, protectedFacts: best.o.protectedFacts, subjectUseId: best.o.subjectUseId, origin: best.b.card ? 'IMPORT_CARD' : 'REVIEWED' }), target, proposal);
  }
  if (pending.length) {
    return done({ status: 'CLARIFY', target, proposal, candidates: [], refusal: null,
      previews: live.map((x) => x.o.candidate!), questions: pending.flatMap((x) => x.o.questions) });
  }
  return done({ status: 'CANDIDATES', target, proposal, candidates: eligible.map((x) => x.o.candidate!), previews: [], questions: [], refusal: null });
}

/** A later change may not rewrite a step or use that an earlier change in this run altered (bindings are compiled
 *  against the pack recipe, so its ops would otherwise overwrite the earlier change). Returns the conflicting id. */
function earlierChangeConflict(v1: Recipe, now: Recipe, b: Binding): string | null {
  if (v1 === now || canonicalJson(v1) === canonicalJson(now)) return null;
  const t = touched(v1, b.ops);
  for (const id of t.steps) { const a = getStep(v1, id), c = getStep(now, id); if (!c || canonicalJson(a) !== canonicalJson(c)) return id; }
  for (const id of t.uses) { const a = getUse(v1, id), c = getUse(now, id); if (!c || canonicalJson(a) !== canonicalJson(c)) return id; }
  return null;
}

// ---------- speech (engine-authored, deterministic templates over authored text) ----------
function speechFor(res: Omit<EvaluationResult, 'speech'>): string {
  if (res.status === 'CLARIFY') {
    const q = res.questions[0];
    if (q.kind === 'REFERENCE') return q.prompt;
    const items = res.questions.flatMap((x) => (x.kind === 'AVAILABILITY' ? x.requirements.map((r) => lowerFirst(r.display)) : []));
    const list = items.length > 2 ? `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}` : items.join(' and ');
    return `To check this, I need to know: do you have ${list}?`;
  }
  if (res.status === 'CANDIDATES') {
    if (res.candidates.length > 1) return `There are ${res.candidates.length} possible changes. Choose one to see what it changes.`;
    const c = res.candidates[0];
    const pre = res.proposal?.response === 'REFUSED' ? `${res.proposal.text} ` : '';
    return `${pre}Yes, with changes. ${c.consequence.headline} ${c.consequence.tradeoff} Say "use this change", or tap.`;
  }
  const rf = res.refusal!;
  return `${rf.message} ${rf.unchanged}`.trim();
}
