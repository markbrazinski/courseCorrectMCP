// Deterministic runtime evaluator (ESOD §6). Pure: no I/O, no clock, no model, no recipe-specific branches.
import {
  ENGINE_SEMANTICS, MAX_CHANGES_PER_RUN,
  type Binding, type Candidate, type ChangeOrigin, type DecisionTrace, type EvaluationResult, type Id, type IngredientUse, type LedgerRow,
  type ProposalResponse, type ProtectedFact, type Question, type Recipe, type RecipePack, type Refusal, type RefusalCode,
  type RebindKnowledge, type Requirement, type RescueRequest, type RoleRow, type RunSnapshot, type StepChange, type Target, type TraceCheck,
  type Vocabulary,
} from '../contract/types.ts';
import { rebind } from '../compile/binder.ts';
import { add, canonicalJson, formatRational, hash, type Rational } from '../domain/rational.ts';
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
/** A requirement's purpose at a step, from the step's technique label (never its title): "mix dough" → "for the dough",
 *  "brush" → "for brushing", "rub in" → "for rubbing in". Anything else names the step. */
function purposeOf(v: Vocabulary, r: Recipe, stepId: Id): { purpose: string; noun: string | null } {
  const t = getStep(r, stepId)?.technique, label = t ? v.techniques.find((x) => x.techniqueId === t.techniqueId)?.label : undefined;
  const w = label?.toLowerCase().split(/\s+/) ?? [];
  const ing = (x: string) => (/^[^aeiou]*[aeiou][bdgmnprt]$/.test(x) ? `${x}${x.slice(-1)}ing` : x.endsWith('e') && !x.endsWith('ee') ? `${x.slice(0, -1)}ing` : `${x}ing`);
  if (w.length === 1) return { purpose: `for ${ing(w[0])}`, noun: null };
  if (w.length === 2 && ['in', 'up', 'out', 'off'].includes(w[1])) return { purpose: `for ${ing(w[0])} ${w[1]}`, noun: null };
  if (w.length === 2) return { purpose: `for the ${w[1]}`, noun: `the ${w[1]}` };
  return { purpose: `for step ${stepOrder(r, stepId)}`, noun: null };   // ponytail: longer labels name the step
}

function requirementsFor(before: Recipe, after: Recipe, snap: RunSnapshot, v: Vocabulary): Requirement[] {
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
      // one question per ingredient. When its stated amounts serve several steps: the total including any conditional extra,
      // then each use by purpose and the extra apart ("225 ML milk: 180 ML for the dough (step 3) + 15 ML for brushing (step 6)
      // + up to 30 ML extra for the dough, only if needed")
      const parts = exact.length > 1 ? exact.map((u) => ({ qty: (u.amount as { value: Rational }).value, ...purposeOf(v, after, u.stepId), order: stepOrder(after, u.stepId), upTo: u.allowance?.max ?? null })) : undefined;
      const extra = parts?.find((x) => x.upTo);
      const display = parts
        ? `${qtyText(add(base, upTo), unit)}${reservedUses.length ? ' more' : ''} ${[prep, name].filter(Boolean).join(' ')}: ${parts.map((x) => `${qtyText(x.qty, unit)} ${x.purpose} (step ${x.order})`).join(' + ')}${extra ? ` + up to ${qtyText(upTo, unit)} extra ${extra.purpose}, only if needed` : ''}`
        : `${exact.length === 1 && !reservedUses.length ? amountDisplay(exact[0].amount) : qtyText(base, unit)}${reservedUses.length ? ' more' : ''} ${[prep, name].filter(Boolean).join(' ')}` + (upTo.n ? `, plus up to ${qtyText(upTo, unit)} more only if needed` : '');
      out.push({
        ...(parts ? { parts } : {}),
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
    resume: resumeStepId, requirementHash: hash(reqs), knowledgeReleaseId: snap.knowledgeReleaseId ?? null,
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
  /** REINTRODUCES_UNAVAILABLE: the ingredient the plan would bring back */
  subjectName?: string;
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
  stampOrigins(r, after, b, snap);
  // a cycle: a plan may not bring back an ingredient the cook is out of (this one, or one an accepted change replaced)
  const out = new Set([...(snap.unavailableKinds ?? []), getIngredient(r, target.ingredientId)?.kind?.kindId].filter((k): k is Id => !!k));
  const back = after.uses.filter((u) => !getUse(r, u.useId)).map((u) => getIngredient(after, u.ingredientId)!).find((i) => i.kind && out.has(i.kind.kindId));
  if (back) return { ...refuse('APPLY', 'brings back nothing the cook is out of', 'REINTRODUCES_UNAVAILABLE', `${back.ingredientId} (${back.kind!.kindId})`, [], null), subjectName: back.name };
  ok('APPLY', 'brings back nothing the cook is out of');
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

  const reqs = requirementsFor(r, after, snap, v);
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

/** Every use and ingredient this plan adds records the change it came from (deterministic: the plan hash covers it). */
function stampOrigins(before: Recipe, after: Recipe, b: Binding, snap: RunSnapshot) {
  const replaces = new Map(b.ops.flatMap((o) => (o.op === 'REPLACE_USE' ? [[o.newUse.useId, o.useId] as const] : [])));
  const origin = (replacesUseId: Id | null): ChangeOrigin => ({ fromVersion: snap.version, patternId: b.patternId, patternVersion: b.patternVersion, knowledgeReleaseId: snap.knowledgeReleaseId ?? null, replacesUseId });
  for (const u of after.uses) if (!getUse(before, u.useId)) u.origin = origin(replaces.get(u.useId) ?? null);
  for (const i of after.ingredients) if (!getIngredient(before, i.ingredientId)) i.origin = origin(null);
}

// ---------- refusal copy (deterministic, closed table) ----------
const PRIORITY: RefusalCode[] = ['PROTECTED_WORK', 'AFFECTED_USE_IN_PROGRESS', 'CONFLICTS_WITH_EARLIER_CHANGE', 'REINTRODUCES_UNAVAILABLE', 'AFFECTED_USE_UNACCOUNTED', 'INSUFFICIENT_AVAILABILITY', 'NOT_APPLICABLE_NOW'];

function makeRefusal(code: RefusalCode, snap: RunSnapshot, v: Vocabulary, ctx: {
  ingredientId?: Id; target?: IngredientUse; refusalBinding?: Binding; protectedFacts?: ProtectedFact[]; subjectUseId?: Id | null; reason?: Refusal['reason'];
  origin?: Refusal['origin']; subjectName?: string;
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
  const introduced = ing?.origin ? ' as it is used now (it came in with a change you accepted earlier)' : '';

  const messages: Record<RefusalCode, string> = {
    NOT_FUNCTIONALLY_EQUIVALENT: ctx.refusalBinding?.refusal?.text ?? '',
    PROTECTED_WORK: firstPf ? (firstPf.kind.startsWith('STEP')
      ? `Step ${firstPf.order} is marked ${firstPf.kind === 'STEP_STARTED' ? 'started' : 'done'}, so this change can't be used.`
      : `Some ${name} is already in for step ${firstPf.order}, so this change can't be used.`) : `Work this change would rewrite is already reported, so it can't be used.`,
    AFFECTED_USE_IN_PROGRESS: `Some ${name} for step ${subj ? stepOrder(r, subj.stepId) : '?'} is already in, so this change can't be used.`,
    AFFECTED_USE_UNACCOUNTED: `The ${plan} change doesn't cover the ${name} in step ${subj ? stepOrder(r, subj.stepId) : '?'}, so it can't be used.`,
    NO_SUPPORTED_RECOVERY: `There's no reviewed change for ${name}${introduced || ' in this recipe'}. That isn't a judgement that nothing else could work.`,
    NOT_APPLICABLE_NOW: `The ${plan} change for ${name} doesn't apply at this point in the recipe.`,
    INSUFFICIENT_AVAILABILITY: `Without those, there's no ${plan} change for ${name} here.`,
    REFERENCE_NOT_IN_RECIPE: `That ingredient isn't in this recipe.`,
    NOTHING_TO_CHANGE: ctx.reason === 'REPLACED_BY_AMENDMENT' ? `${upperFirst(name)} is no longer in your recipe after the change you accepted.` : `All the ${name} in this recipe is already in.`,
    SUCCESSIVE_RESCUE_UNSUPPORTED: `This cooking session already used its ${MAX_CHANGES_PER_RUN} changes.`,
    CONFLICTS_WITH_EARLIER_CHANGE: `That change would undo part of a change you accepted earlier in this session, so it can't be offered here.`,
    NOT_RELEASED: `This recipe isn't released for cooking guidance.`,
    REINTRODUCES_UNAVAILABLE: `That change would need ${ctx.subjectName ? lowerFirst(ctx.subjectName) : 'an ingredient'}, which you said you're out of, so it can't be used.`,
    KNOWLEDGE_UNAVAILABLE: `The reviewed knowledge this recipe was prepared with isn't available, so no further change for ${name} can be checked.`,
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
/** `knowledge`: the run's pinned release, for plans that must be re-bound against the current recipe (null: unavailable). */
export function evaluate(pack: RecipePack, v: Vocabulary, snap: RunSnapshot, req: RescueRequest, released = false, knowledge: RebindKnowledge | null = null): EvaluationResult {
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
  let rebound: EvaluationResult['rebound'];
  const refused = (refusal: Refusal, target: Target | null = null, proposal: ProposalResponse | null = null) =>
    done({ status: 'REFUSED', target, proposal, candidates: [], previews: [], questions: [], refusal, ...(rebound ? { rebound } : {}) });

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

  // Successive changes (ENGINE_SEMANTICS 4): a frozen reviewed plan describes the recipe as saved. When the target came in with
  // an accepted change, or an accepted change altered what a frozen reviewed plan read or would rewrite, the pinned release's
  // reviewed patterns are bound again against the current recipe. Import cards (AI) are never re-bound: one applies only to the
  // recipe state it was checked against (an original use whose facts no change altered), and no model is called here.
  const frozen = pack.bindings.filter((b) => b.targetUseId === tUse.useId);   // COOK would further filter to released bindings
  const introducedTarget = !getUse(pack.recipe, tUse.useId);
  const stale = frozen.filter((b) => !b.card && (factsHashOf(r, tUse, { slots: b.slots }) !== b.factsHash || earlierChangeConflict(pack.recipe, r, b) !== null));
  let B = frozen;
  if (introducedTarget || stale.length) {
    if (!knowledge) {
      g('SELECT', 're-bind against the current recipe', 'FAIL', 'KNOWLEDGE_UNAVAILABLE', introducedTarget ? 'target introduced by an accepted change' : stale.map((b) => b.bindingId).join(', '));
      return refused(makeRefusal('KNOWLEDGE_UNAVAILABLE', snap, v, { ingredientId: ing.ingredientId, target: tUse }), target);
    }
    const rb = rebind(r, knowledge.vocab, knowledge.patterns, tUse.useId, { baseline: pack.recipe, seed: `v${snap.version}` });
    if (rb.errors.length) throw new Error(`current recipe invalid: ${rb.errors.join('; ')}`);
    rebound = { releaseId: knowledge.releaseId, coverage: rb.coverage.filter((c) => c.targetUseId === tUse.useId), bindings: rb.bindings };
    B = [...frozen.filter((b) => b.card), ...rb.bindings];
    g('SELECT', `re-bound ${tUse.useId} against version ${snap.version} (release ${knowledge.releaseId})`, 'PASS', null,
      rebound.coverage.map((c) => `${c.patternId}@${c.patternVersion}:${c.status}${c.failedCheck ? `:${c.failedCheck.code}` : ''}`).join(', ') || null);
  }
  g('SELECT', `bindings for ${tUse.useId}`, B.length ? 'PASS' : 'FAIL', B.length ? null : 'NO_SUPPORTED_RECOVERY', B.map((b) => b.bindingId).join(', ') || null);

  // PROPOSAL (§6.3)
  const pc = proposalClasses(v, req.proposedKindIds);
  pc.unknown.forEach((k) => notices.push({ kind: 'UNMAPPED_PROPOSAL', text: k }));
  const P = pc.classes;
  // an exact proposal match first; a refusal with no classes (an import card's "no") refuses any replacement (ENGINE_SEMANTICS 3)
  const refuser = (P.length ? B.find((b) => b.kind === 'REFUSAL' && b.refusal!.classes.length > 0 && sameSet(b.refusal!.classes, P)) : undefined)
    ?? B.find((b) => b.kind === 'REFUSAL' && b.refusal!.classes.length === 0 && !b.refusal!.omission);   // "can't be left out" refuses no replacement

  const outcomes = B.filter((b) => b.kind === 'RECOVERY').map((b) => {
    const answers = new Map(req.answers.map((a) => [a.questionId, a.choiceId] as const));
    const conflict = rebound?.bindings.includes(b) ? null : earlierChangeConflict(pack.recipe, snap.recipe, b);   // a re-bound plan was composed with the current recipe
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
    // a reviewed plan that would undo part of an earlier change (rewrite its step, drop its allowance) is a conflict, not "no rule"
    const clash = rebound?.coverage.find((c) => c.failedCheck && ['REWRITES_EARLIER_CHANGE', 'DROPS_EARLIER_ALLOWANCE'].includes(c.failedCheck.code));
    if (!best && clash) return refused(makeRefusal('CONFLICTS_WITH_EARLIER_CHANGE', snap, v, { ingredientId: ing.ingredientId, target: tUse, origin: 'REVIEWED' }), target, proposal);
    if (!best) return refused(makeRefusal('NO_SUPPORTED_RECOVERY', snap, v, { ingredientId: ing.ingredientId, target: tUse }), target, proposal);
    return refused(makeRefusal(best.o.refusalCode!, snap, v, { ingredientId: ing.ingredientId, target: tUse, protectedFacts: best.o.protectedFacts, subjectUseId: best.o.subjectUseId, subjectName: best.o.subjectName, origin: best.b.card ? 'IMPORT_CARD' : 'REVIEWED' }), target, proposal);
  }
  if (pending.length) {
    return done({ status: 'CLARIFY', target, proposal, candidates: [], refusal: null,
      previews: live.map((x) => x.o.candidate!), questions: pending.flatMap((x) => x.o.questions), ...(rebound ? { rebound } : {}) });
  }
  return done({ status: 'CANDIDATES', target, proposal, candidates: eligible.map((x) => x.o.candidate!), previews: [], questions: [], refusal: null, ...(rebound ? { rebound } : {}) });
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
    const reqs = res.questions.flatMap((x) => (x.kind === 'AVAILABILITY' ? x.requirements : []));
    // an amount that serves several steps is spoken as one total, then what it includes (detail stays on screen)
    if (reqs.some((x) => x.parts)) {
      const word = (x: Requirement) => (x.unit === 'G' ? 'grams of ' : x.unit === 'ML' ? 'millilitres of ' : '');
      const exact = reqs.filter((x) => x.qty), qual = reqs.filter((x) => !x.qty);
      const ordered = [...exact.filter((x) => !x.parts), ...exact.filter((x) => x.parts)];
      const spoken = ordered.map((x) => `${formatRational(x.qty!)} ${word(x)}${x.name}`);
      const includes = ordered.filter((x) => x.parts).flatMap((x) => {
        const main = x.parts!.reduce((a, b) => (b.qty.n / b.qty.d > a.qty.n / a.qty.d ? b : a));
        const unitWord = x.unit === 'G' ? 'grams' : x.unit === 'ML' ? 'millilitres' : '';
        const extra = x.parts!.find((p) => p.upTo);
        return [...x.parts!.filter((p) => p !== main).map((p) => `${x.name} ${p.purpose}`),
          ...(extra ? [`up to ${formatRational(extra.upTo!)} ${unitWord} extra, only if ${extra.noun ?? 'it'} needs it`] : [])];
      });
      return [`Do you have ${spoken.length > 1 ? `${spoken.slice(0, -1).join(', ')} and ${spoken[spoken.length - 1]}` : spoken[0]}?`,
        includes.length ? `That includes ${includes.length > 1 ? `${includes.slice(0, -1).join(', ')} and ${includes[includes.length - 1]}` : includes[0]}.` : '',
        ...qual.map((x) => `And do you also have ${lowerFirst(x.display)}?`)].filter(Boolean).join(' ');
    }
    const items = reqs.map((r) => lowerFirst(r.display));
    const list = items.length > 2 ? `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}` : items.join(' and ');
    return `To check this, I need to know: do you have ${list}?`;
  }
  if (res.status === 'CANDIDATES') {
    if (res.candidates.length > 1) return `There are ${res.candidates.length} possible changes. Choose one to see what it changes.`;
    const c = res.candidates[0];
    const pre = res.proposal?.response === 'REFUSED' ? `${res.proposal.text} ` : '';
    // "Yes" answers a proposal ("can I use …?"); asked only what to use, the cook hears the change itself
    return `${pre}${res.proposal ? 'Yes, with changes.' : "Here's a change that works."} ${c.consequence.headline} ${c.consequence.tradeoff} Say "use this change", or tap.`;
  }
  const rf = res.refusal!;
  return `${rf.message} ${rf.unchanged}`.trim();
}

/** The answer when the run's knowledge release can't be read or established: nothing is evaluated (frozen plans need the
 *  vocabulary they were compiled with), and the recipe is unchanged. Never falls back to other knowledge. */
export function knowledgeUnavailable(pack: RecipePack, snap: RunSnapshot, req: RescueRequest, why: string): EvaluationResult {
  const none: Vocabulary = { schema: 'cc-vocabulary/1', version: 0, functions: [], techniques: [], classes: [], kinds: [] };
  const stateHash = hash({ recipe: hash(snap.recipe), stepStatus: snap.stepStatus, useStatus: snap.useStatus, version: snap.version });
  const ing = req.missingIngredientId ? getIngredient(snap.recipe, req.missingIngredientId) : undefined;
  const refusal = makeRefusal('KNOWLEDGE_UNAVAILABLE', snap, none, { ingredientId: ing?.ingredientId });
  const trace: DecisionTrace = { kind: 'cc-decision-trace/2', engineSemantics: ENGINE_SEMANTICS, packHash: pack.packHash, stateHash,
    global: [{ stage: 'SELECT', check: 'knowledge release readable', result: 'FAIL', code: 'KNOWLEDGE_UNAVAILABLE', detail: why }], bindings: [] };
  return { status: 'REFUSED', target: null, proposal: null, candidates: [], previews: [], questions: [], refusal, notices: [...req.notices], trace, speech: `${refusal.message} ${refusal.unchanged}` };
}
