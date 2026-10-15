// Engine → wire projection. Wire shapes = FE–BE Contract v1 (private/design) with the ESOD §8.6 deltas.
import type {
  Amount, Candidate, EvaluationResult, Id, IngredientUse, Pattern, Recipe, RecipePack, Refusal, StepStatus, UseStatus, Vocabulary,
} from './types.ts';
import { swapOf, type WireSwap, type Why } from './why.ts';
import { analysisOf, type ImportPlan, type UseAnalysis } from './analysis.ts';
import { CARD_LABEL } from '../compile/cards.ts';
import { formatRational } from '../domain/rational.ts';
import { allowanceText, amountDisplay, getIngredient, getStep, lowerFirst, qtyText, renderStep, stepOrder, upperFirst, useLabel } from '../domain/recipe.ts';
import { functionLabel, kindOf } from '../domain/vocabulary.ts';

// ---------- wire types ----------
export type WireAmount =
  | { kind: 'exact'; value: number; unit: string; display: string }
  | { kind: 'range'; min: number; max: number; unit: string; display: string }
  | { kind: 'approximate'; display: string }
  | { kind: 'conditional'; display: string; condition: string }
  | { kind: 'toTaste'; display: string }
  | { kind: 'count'; value: number; display: string }
  | { kind: 'unresolved'; display: string | null; reason: string };
export type { WireSwap, Why, UseAnalysis, ImportPlan };
export interface WireUse {
  id: Id; ingredientId: Id; stepId: Id; amount: WireAmount; prepares: Id | null;
  proposedFunction: { labels: string[]; origin: 'import-inference' } | null;   // display only ("import guessed …")
  reviewedFunction: { labels: string[]; reviewId: string; authority: 'MACHINE_CHECKED' | 'OWNER_REVIEWED' } | null;   // R-1: the role table's roles are MACHINE_CHECKED
  swap: WireSwap; sourceRef: null;
  analysis: UseAnalysis | null;   // import review only (drafts and recipe pages); null on cooking responses
  /** Cooking only: the accepted change this use came in with (2026-10-11), so a cook can name it as missing and see why it's there. */
  introducedBy?: { amendmentId: Id; title: string | null; replaces: string | null } | null;
}
export interface WireIngredient { id: Id; name: string; totalAmount: WireAmount; uses: WireUse[]; sourceRef: null; removedByAmendment: boolean;
  /** the source's sub-list heading for this line ("For the Makhani Sauce:"); the same ingredient may be listed in two groups */
  group?: string | null }
export interface WireStep { id: Id; ordinal: number; title: string; text: string; useIds: Id[]; duration: { seconds: number; display: string; sourceText: string | null } | null; dependsOn: Id[]; sourceRef: null }
export interface RecipeContent { title: string; meta: string; ingredients: WireIngredient[]; steps: WireStep[]; notes: [] }
export type StepProgress = 'notStarted' | 'started' | 'partly' | 'done';
export interface WireRunStep {
  stepId: Id; progress: StepProgress; partialUseIds: Id[]; effectiveText: string; originalText: string | null;
  changedByAmendmentId: Id | null; onHold: null;
}
export interface WireAmendment { id: Id; commandId: Id; candidateId: Id; planId: string; changedStepIds: Id[]; appliedAtRunRevision: number; fromVersion: number; toVersion: number;
  /** 2026-10-11: the plan's title, the knowledge release that authorized it, and the earlier changes it builds on */
  title?: string | null; knowledgeReleaseId?: string | null; dependsOn?: { amendmentId: Id; relation: 'REPLACES_INTRODUCED' | 'SHARES_STEP' }[] }
export interface WireRun {
  id: Id; recipeId: Id; recipeVersionId: string; epoch: number; revision: number; version: number;
  state: 'active' | 'ended'; mode: 'COOK' | 'ENGINEERING'; contentLabel: string;
  steps: WireRunStep[]; currentStepId: Id | null; appliedAmendments: WireAmendment[]; pendingCommand: null;
  /** The knowledge release every check in this session uses: PINNED when the recipe was prepared; HASH_MATCH for a recipe saved
   *  before releases whose content equals a published release; UNPINNED when neither can be established (2026-10-11). */
  knowledge?: { releaseId: string | null; basis: 'PINNED' | 'HASH_MATCH' | 'UNPINNED' };
}
export interface RecipeBookEntry {
  recipeId: Id; currentVersionId: string; title: string; meta: string; sourceLabel: string;
  release: { kind: 'eligible'; coverageSummary: string } | { kind: 'ineligible'; reasons: { code: string; message: string; nextAction: string | null }[] };
  activeRunId: Id | null;
}
export interface WireStepChange { stepId: Id; relation: 'context' | 'changesNow' | 'changesLater' | 'unchanged' | 'refused'; stateLabel: string; segments: { text: string; kind: 'same' | 'inserted' }[] | null; note: string | null; titleAfter: string | null }
export interface WireCandidate {
  id: Id; planId: string; ruleId: string; headline: string;
  roleMap: { role: string; replacement: string; kind: 'replaced' | 'lost' | 'alreadyDone' }[];
  stepChanges: WireStepChange[];
  ledger: { ingredient: string; step: string; before: string; after: string; kind: string }[];
  consequence: { text: string; contentSlot: false };
  contentLabel: string; resumeStepId: Id;
  applicable: { kind: 'yes' } | { kind: 'no'; reason: 'stale'; message: string };
}
export type WireRefusal =
  | { kind: 'noReviewedRecovery'; ingredientId: Id; stillNeededInStepIds: Id[]; unchanged: string; message: string }
  | { kind: 'functionallyUnsupported'; useId: Id; reason: { text: string; contentSlot: false }; roleMap: WireCandidate['roleMap']; stepChanges: WireStepChange[]; unchanged: string; message: string; scopeNote: string | null; origin: 'reviewed' | 'importCard' }
  | { kind: 'protectedWork'; stepId: Id; progress: 'started' | 'partly'; unchanged: string; guidance: null; message: string }
  | { kind: 'missingFacts'; unchanged: string; message: string }
  | { kind: 'nothingToChange'; ingredientId: Id; reason: 'allUsesDone' | 'replacedByAmendment'; message: string }
  | { kind: 'rescueLimitReached'; unchanged: string; message: string }
  | { kind: 'earlierChangeConflict'; unchanged: string; message: string }
  | { kind: 'knowledgeUnavailable'; unchanged: string; message: string }
  | { kind: 'notReleased'; message: string };
export interface WireInterpretation { missingIngredientId: Id; missingUseIds: Id[]; atStepId: Id; askedAbout: string | null; display: { label: string; value: string }[] }
export type RescueEvaluation = {
  id: Id; runId: Id; evaluatedAtRunRevision: number; actionable: boolean;
  /** What this answer was evaluated against (2026-10-11): the run revision and recipe version, and the knowledge release. */
  basis?: { revision: number; version: number; knowledgeReleaseId: string | null; knowledgeBasis: 'PINNED' | 'HASH_MATCH' | 'UNPINNED' };
  interpretation: WireInterpretation | null;
  speech: { text: string; source: 'engineAuthored'; correspondsTo: Id };
  trace: { interpretation: string | null; deterministic: string | null; explanation: string | null };
  notices: EvaluationResult['notices'];
  proposalResponse: EvaluationResult['proposal'];
} & (
  | { outcome: 'needsInterpretation'; prompt: string; options: { ingredientId: Id; label: string }[] }
  | { outcome: 'needsFacts'; questions: { id: Id; title: string; items: { text: string; contentSlot: false }[] }[]; note: string | null; previews: WireCandidate[] }
  | { outcome: 'proposal'; candidates: WireCandidate[] }
  | { outcome: 'refused'; refusal: WireRefusal; why: Why; answer: { text: string; source: 'model' | 'template' } }
);

// ---------- helpers ----------
export function wireAmount(a: Amount, u?: IngredientUse): WireAmount {
  if (u?.allowance) return { kind: 'conditional', display: `${amountDisplay(a)}, plus up to ${qtyText(u.allowance.max, u.allowance.unit)} more if needed`, condition: u.allowance.stopCondition };
  switch (a.kind) {
    case 'EXACT':
      return a.unit === 'COUNT' ? { kind: 'count', value: a.value.n / a.value.d, display: amountDisplay(a) }
        : { kind: 'exact', value: a.value.n / a.value.d, unit: a.unit === 'G' ? 'g' : 'ML', display: amountDisplay(a) };
    case 'RANGE': return { kind: 'range', min: a.min.n / a.min.d, max: a.max.n / a.max.d, unit: a.unit === 'G' ? 'g' : 'ML', display: amountDisplay(a) };
    case 'AS_WRITTEN': return { kind: 'approximate', display: a.text };
    case 'NOT_QUANTITY_BEARING': return { kind: 'toTaste', display: a.text };
    case 'UNSPECIFIED': return { kind: 'unresolved', display: null, reason: 'The recipe does not say' };
  }
}
const labelsOf = (v: Vocabulary, u: IngredientUse) => u.functions.map((f) => f.label ?? functionLabel(v, f.functionId));

/** `analysis`: add each use's import analysis (Amendment 1); `pending` while the import's swap analysis is still running. */
/** `changeOf`: cooking views, the accepted change that made the version after `fromVersion` (labels uses it introduced). */
export function recipeContent(r: Recipe, v: Vocabulary, pack: RecipePack, v1: Recipe, patterns: Pattern[], analysis?: { pending: boolean },
  changeOf?: (fromVersion: number) => { amendmentId: Id; title: string | null } | null): RecipeContent {
  const memo = new Map<Id, ImportPlan | null>();
  const steps: WireStep[] = r.steps.map((s, i) => ({
    id: s.stepId, ordinal: i + 1, title: s.title ?? `Step ${i + 1}`, text: renderStep(r, s),
    useIds: r.uses.filter((u) => u.stepId === s.stepId).map((u) => u.useId), duration: s.duration, dependsOn: s.dependsOn, sourceRef: null,
  }));
  const ingredients: WireIngredient[] = r.ingredients.map((ing) => {
    const uses = r.uses.filter((u) => u.ingredientId === ing.ingredientId);
    return {
      id: ing.ingredientId, name: ing.name, sourceRef: null, group: ing.group ?? null,
      totalAmount: ing.listed.kind === 'UNSPECIFIED' ? derivedTotal(r, uses) : wireAmount(ing.listed),
      removedByAmendment: uses.length === 0 && v1.uses.some((u) => u.ingredientId === ing.ingredientId),
      uses: uses.map((u) => ({
        id: u.useId, ingredientId: u.ingredientId, stepId: u.stepId, amount: wireAmount(u.amount, u), prepares: u.preparesUseId,
        proposedFunction: u.functions.some((f) => f.prov.status !== 'REVIEWED') ? { labels: labelsOf(v, u), origin: 'import-inference' } : null,
        reviewedFunction: u.functions.length && u.functions.every((f) => f.prov.status === 'REVIEWED') ? { labels: labelsOf(v, u), reviewId: u.functions[0].prov.ref ?? 'reviewed', authority: u.functions.every((f) => f.prov.by === 'OWNER') ? 'OWNER_REVIEWED' : 'MACHINE_CHECKED' } : null,
        swap: swapOf({ pack, patterns, v }, u.useId), sourceRef: null,
        analysis: analysis ? analysisOf({ pack, patterns, v }, u.useId, analysis.pending, memo) : null,
        ...(changeOf ? { introducedBy: introducedBy(r, v1, u, changeOf) } : {}),
      })),
    };
  });
  return { title: r.title, meta: r.meta, ingredients, steps, notes: [] };
}

function introducedBy(r: Recipe, v1: Recipe, u: IngredientUse, changeOf: (fromVersion: number) => { amendmentId: Id; title: string | null } | null) {
  const c = u.origin ? changeOf(u.origin.fromVersion) : null;
  if (!c) return null;
  const was = u.origin!.replacesUseId ? [r, v1].map((x) => x.uses.find((y) => y.useId === u.origin!.replacesUseId)).find(Boolean) : undefined;
  return { amendmentId: c.amendmentId, title: c.title, replaces: was ? (getIngredient(r, was.ingredientId) ?? getIngredient(v1, was.ingredientId))?.name ?? null : null };
}

/** Total for an introduced ingredient: exact ADD uses summed; ceilings and qualitative amounts kept separate (never summed). */
function derivedTotal(r: Recipe, uses: IngredientUse[]): WireAmount {
  const adds = uses.filter((u) => u.kind === 'ADD');
  const exact = adds.filter((u) => u.amount.kind === 'EXACT');
  const parts: string[] = [];
  if (exact.length) {
    const unit = (exact[0].amount as { unit: 'G' | 'ML' | 'COUNT' }).unit;
    let n = 0, up = 0;
    for (const u of exact) { const a = u.amount as { value: { n: number; d: number } }; n += a.value.n / a.value.d; if (u.allowance) up += u.allowance.max.n / u.allowance.max.d; }
    parts.push(qtyText({ n: Math.round(n * 1000), d: 1000 }, unit));
    if (up) parts.push(`plus up to ${formatRational({ n: Math.round(up * 1000), d: 1000 })} ${unit === 'G' ? 'g' : 'ML'} if needed`);
  }
  for (const u of adds.filter((x) => x.amount.kind !== 'EXACT')) parts.push(`plus ${amountDisplay(u.amount)} for step ${stepOrder(r, u.stepId)}`);
  return { kind: 'approximate', display: parts.join(', ') || 'amount not stated' };
}

export const progressOf = (r: Recipe, stepId: Id, ss: Record<Id, StepStatus>, us: Record<Id, UseStatus>): StepProgress => {
  const s = ss[stepId] ?? 'NOT_STARTED';
  if (s === 'COMPLETED') return 'done';
  if (s === 'NOT_STARTED') return 'notStarted';
  return r.uses.some((u) => u.stepId === stepId && (us[u.useId] ?? 'UNADDED') !== 'UNADDED') ? 'partly' : 'started';
};

export function contentLabel(mode: 'COOK' | 'ENGINEERING', provisional: boolean, origin: 'REVIEWED' | 'IMPORT_CARD' = 'REVIEWED') {
  if (origin === 'IMPORT_CARD') return `${CARD_LABEL} · checked by code`;
  return mode === 'COOK' ? 'Released' : 'Reviewed change';
}

/** Recipe Book line: reviewed changes on file, and how many uses have a valid import card (never counted as reviewed). */
export function coverageSummary(p: RecipePack): string {
  const bound = p.bindings.filter((b) => b.kind === 'RECOVERY' && !b.card).map((b) => {
    const u = p.recipe.uses.find((x) => x.useId === b.targetUseId)!;
    return `${p.recipe.ingredients.find((i) => i.ingredientId === u.ingredientId)!.name.toLowerCase()}, step ${stepOrder(p.recipe, u.stepId)}`;
  });
  const reviewed = bound.length ? `Reviewed change on file: ${bound.join('; ')}` : 'No reviewed changes on file';
  if (!p.cards) return reviewed;
  return `${reviewed} · ${CARD_LABEL}: a card for ${p.cards.filter((c) => c.status !== 'INVALID').length} of ${p.cards.length} uses`;
}

// ---------- candidates ----------
export function wireCandidate(c: Candidate, after: Recipe, mode: 'COOK' | 'ENGINEERING', actionable: boolean): WireCandidate {
  const changedIdx = c.changes.map((x, i) => (x.kind !== 'UNCHANGED' ? i : -1)).filter((i) => i >= 0);
  const lo = Math.max(0, changedIdx[0] - 1), hi = Math.min(c.changes.length - 1, changedIdx[changedIdx.length - 1] + 1);
  const stepChanges: WireStepChange[] = c.changes.slice(lo, hi + 1).map((x, k) => {
    if (x.kind !== 'UNCHANGED') return { stepId: x.stepId, relation: x.when === 'NOW' ? 'changesNow' : 'changesLater', stateLabel: x.when === 'NOW' ? 'Changes now' : 'Changes later', segments: x.segments, note: null, titleAfter: x.titleAfter };
    if (x.note) return { stepId: x.stepId, relation: 'unchanged', stateLabel: 'Unchanged', segments: null, note: x.note, titleAfter: null };
    const done = x.when === 'DONE';
    const lastRow = lo + k === hi && !done;
    return { stepId: x.stepId, relation: 'context', stateLabel: done ? 'Done' : 'Later', segments: null, note: done ? 'Already done. Not affected.' : lastRow ? 'Unchanged.' : 'Not affected.', titleAfter: null };
  });
  return {
    id: c.candidateId, planId: c.planHash, ruleId: c.candidateId, headline: c.consequence.headline, roleMap: c.roleMap, stepChanges,
    ledger: c.ledger.map((l) => ({ ingredient: l.ingredient, step: `Step ${l.order}`, before: l.before, after: l.after, kind: l.kind })),
    consequence: { text: c.consequence.tradeoff, contentSlot: false },
    contentLabel: contentLabel(mode, c.quantityStatus === 'PROVISIONAL', c.origin), resumeStepId: c.resume.stepId,
    applicable: actionable ? { kind: 'yes' } : { kind: 'no', reason: 'stale', message: 'Your progress changed since this was checked. Check again.' },
  };
}

export function wireRefusal(rf: Refusal, res: EvaluationResult, r: Recipe): WireRefusal {
  const t = res.target;
  switch (rf.code) {
    case 'NOT_FUNCTIONALLY_EQUIVALENT':
      return {
        kind: 'functionallyUnsupported', useId: t!.useId, reason: { text: rf.message, contentSlot: false }, message: rf.message, scopeNote: rf.scopeNote, unchanged: rf.unchanged,
        origin: rf.origin === 'IMPORT_CARD' ? 'importCard' : 'reviewed',
        roleMap: rf.ingredientUses.map((u) => ({ role: `Step ${u.order} · ${u.functionLabels.join(' · ')}`, replacement: u.status === 'ADDED' ? 'Already done' : rf.origin === 'IMPORT_CARD' && u.useId === t!.useId ? `No swap · ${CARD_LABEL}` : 'No reviewed replacement', kind: u.status === 'ADDED' ? 'alreadyDone' as const : 'lost' as const })),
        stepChanges: rf.ingredientUses.map((u) => ({
          stepId: u.stepId, relation: u.useId === t!.useId ? 'refused' as const : 'context' as const,
          stateLabel: u.useId === t!.useId ? 'Now · no change available' : u.status === 'ADDED' ? 'Done' : 'Later',
          segments: null, note: u.status === 'ADDED' ? `Used ${u.label}. Already done.` : null, titleAfter: null,
        })),
      };
    case 'PROTECTED_WORK': case 'AFFECTED_USE_IN_PROGRESS': {
      const f = rf.protectedFacts[0];
      const stepId = f ? ('stepId' in f ? f.stepId : getStep(r, r.uses.find((u) => u.useId === f.useId)!.stepId)!.stepId) : t!.stepId;
      return { kind: 'protectedWork', stepId, progress: f && f.kind.startsWith('USE') ? 'partly' : 'started', unchanged: rf.unchanged, guidance: null, message: rf.message };
    }
    case 'INSUFFICIENT_AVAILABILITY': return { kind: 'missingFacts', unchanged: rf.unchanged, message: rf.message };
    case 'NOTHING_TO_CHANGE': return { kind: 'nothingToChange', ingredientId: rf.ingredientUses[0]?.useId ? r.uses.find((u) => u.useId === rf.ingredientUses[0].useId)!.ingredientId : t?.ingredientId ?? '', reason: rf.reason === 'REPLACED_BY_AMENDMENT' ? 'replacedByAmendment' : 'allUsesDone', message: rf.message };
    case 'SUCCESSIVE_RESCUE_UNSUPPORTED': return { kind: 'rescueLimitReached', unchanged: rf.unchanged, message: rf.message };
    case 'CONFLICTS_WITH_EARLIER_CHANGE': case 'REINTRODUCES_UNAVAILABLE': return { kind: 'earlierChangeConflict', unchanged: rf.unchanged, message: rf.message };
    case 'KNOWLEDGE_UNAVAILABLE': return { kind: 'knowledgeUnavailable', unchanged: rf.unchanged, message: rf.message };
    case 'NOT_RELEASED': return { kind: 'notReleased', message: rf.message };
    default:
      return { kind: 'noReviewedRecovery', ingredientId: t?.ingredientId ?? '', stillNeededInStepIds: t ? t.allRemainingUses.map((u) => u.stepId) : [], unchanged: rf.unchanged, message: rf.message };
  }
}

function interpretationOf(res: EvaluationResult, r: Recipe, v: Vocabulary, ss: Record<Id, StepStatus>): WireInterpretation | null {
  const t = res.target;
  if (!t) return null;
  const u = r.uses.find((x) => x.useId === t.useId)!;
  const doneCount = r.steps.findIndex((s) => ss[s.stepId] !== 'COMPLETED');
  const cur = doneCount < 0 ? r.steps.length : doneCount;
  const place = cur === 0 ? `No steps done · step 1 ${progressWord(ss[r.steps[0].stepId])}`
    : cur >= r.steps.length ? 'All steps done'
      : `Steps 1–${cur} done · step ${cur + 1} ${progressWord(ss[r.steps[cur].stepId])}`;
  const display = [
    { label: 'Missing', value: `${getIngredient(r, t.ingredientId)!.name} · step ${t.order}, ${amountDisplay(u.amount)}` },
    { label: 'Its role there', value: upperFirst(labelsOf(v, u).join(' · ')) },
    ...(u.origin ? [{ label: 'Came in with', value: 'a change you accepted earlier in this session' }] : []),
    ...(res.proposal ? [{ label: 'You asked about', value: upperFirst(res.proposal.proposed.map((p) => p.label).join(' and ')) }] : []),
    { label: 'Your place', value: place },
  ];
  return { missingIngredientId: t.ingredientId, missingUseIds: t.allRemainingUses.map((x) => x.useId), atStepId: t.stepId, askedAbout: res.proposal ? res.proposal.proposed.map((p) => p.label).join(' and ') : null, display };
}
const progressWord = (s: StepStatus | undefined) => (s === 'STARTED' ? 'started' : 'not started');

export function rescueEvaluation(args: {
  evaluationId: Id; runId: Id; baseRevision: number; actionable: boolean; res: EvaluationResult; snapRecipe: Recipe; v: Vocabulary;
  stepStatus: Record<Id, StepStatus>; mode: 'COOK' | 'ENGINEERING'; interpretationSummary: string | null;
  explained?: { why: Why; answer: { text: string; source: 'model' | 'template' }; note: string };
  basis?: RescueEvaluation['basis'];
}): RescueEvaluation {
  const { res } = args;
  const base = {
    id: args.evaluationId, runId: args.runId, evaluatedAtRunRevision: args.baseRevision, actionable: args.actionable, ...(args.basis ? { basis: args.basis } : {}),
    interpretation: interpretationOf(res, args.snapRecipe, args.v, args.stepStatus),
    speech: { text: res.speech, source: 'engineAuthored' as const, correspondsTo: args.evaluationId },
    trace: { interpretation: args.interpretationSummary, deterministic: deterministicSummary(res), explanation: args.explained?.note ?? null },
    notices: res.notices, proposalResponse: res.proposal,
  };
  if (res.status === 'CLARIFY' && res.questions[0]?.kind === 'REFERENCE') {
    const q = res.questions[0];
    return { ...base, outcome: 'needsInterpretation', prompt: q.prompt, options: q.choices.map((c) => ({ ingredientId: c.choiceId, label: c.label })) };
  }
  if (res.status === 'CLARIFY') {
    const notes = res.questions.map((q) => (q.kind === 'AVAILABILITY' ? q.note : null)).filter(Boolean);
    return {
      ...base, outcome: 'needsFacts', note: notes.join(' ') || null,
      questions: res.questions.map((q) => ({ id: q.questionId, title: q.prompt, items: q.kind === 'AVAILABILITY' ? q.requirements.map((x) => ({ text: x.display, contentSlot: false as const })) : [] })),
      previews: res.previews.map((c) => wireCandidate(c, c.resultRecipe, args.mode, false)),
    };
  }
  if (res.status === 'CANDIDATES') return { ...base, outcome: 'proposal', candidates: res.candidates.map((c) => wireCandidate(c, c.resultRecipe, args.mode, args.actionable)) };
  if (res.refusal?.code === 'REFERENCE_NOT_IN_RECIPE') {
    return { ...base, outcome: 'needsInterpretation', prompt: `${res.refusal.message} Which ingredient are you out of?`, options: [] };
  }
  const ex = args.explained ?? { why: { verdict: 'noRule' as const, facts: [res.refusal!.message], proposalAnswer: null }, answer: { text: res.refusal!.message, source: 'template' as const } };
  // the answer is the headline and the spoken reply; the engine's "unchanged" line always follows it
  return { ...base, speech: { ...base.speech, text: `${ex.answer.text} ${res.refusal!.unchanged}`.trim() }, outcome: 'refused', refusal: wireRefusal(res.refusal!, res, args.snapRecipe), why: ex.why, answer: ex.answer };
}

function deterministicSummary(res: EvaluationResult): string {
  if (res.status === 'CANDIDATES') return `${res.candidates.map((c) => `${c.origin === 'IMPORT_CARD' ? CARD_LABEL : 'Reviewed change found'}: ${c.patternTitle}`).join('; ')}. Not applied.`;
  if (res.status === 'CLARIFY') {
    const items = res.questions.flatMap((q) => (q.kind === 'AVAILABILITY' ? q.requirements.map((r) => r.display) : []));
    return items.length ? `Reviewed change found for this use. Required facts: ${items.join('; ')}.` : 'Ingredient reference needed.';
  }
  return `${res.refusal?.code ?? res.status}: ${res.refusal?.message ?? ''}`.trim();
}

