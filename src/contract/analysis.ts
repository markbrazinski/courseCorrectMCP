// Per-use import analysis (FE–BE Contract v1 Amendment 1 §A3–A4, reconciled 2026-10-06). Every ingredient use gets exactly
// one status, read from the compiled pack (reviewed bindings, validated import cards, compile coverage) the way the cooking
// engine reads it. A plan is a preview from the engine's own dry run (previewBinding): replacement amounts, rewritten steps
// and availability come from the binding, never from the client and never from recipe-specific code. Previews never apply.
import type { Binding, CoverageEntry, Id, IngredientUse, MissingFact } from './types.ts';
import { previewBinding } from '../compile/binder.ts';
import { CARD_LABEL, CARD_PATTERN } from '../compile/cards.ts';
import { touched } from '../engine/apply.ts';
import { amountDisplay, getIngredient, getStep, getUse, lowerFirst, renderStep, stepOrder, upperFirst } from '../domain/recipe.ts';
import { classLabel, functionLabel, kindOf } from '../domain/vocabulary.ts';
import { contentLabel, wireAmount, type WireAmount } from './project.ts';
import { checkText, missingText, type WhyCtx } from './why.ts';

/** The six statuses this build produces. `needsRecipeDetail` and `stale` (Amendment A3) need cook corrections, which the
 *  owner removed from import on 2026-10-02; they are not produced. */
export type AnalysisStatus = 'available' | 'evaluatedNoOption' | 'blocked' | 'pending' | 'failed' | 'unexamined';
export interface AnalysisReason { code: string; text: string; detail: string | null }   // text: for the cook; detail: diagnostics
export interface ImportPlan {
  planId: Id;                          // the binding id; cooking offers the same plan as WireCandidate.id
  ruleId: string | null;               // reviewed pattern id@version; null for an import card
  title: string;
  kind: 'replacement' | 'omission';   // an omission replaces nothing: the ingredient is left out, with its instruction change and consequence
  provenance: { kind: 'reviewedRule' | 'aiPrepared'; label: string; basis: string[] };
  contentStatus: { label: string; provisional: boolean };
  summary: string;
  replacements: { useId: Id; ingredientName: string; amount: WireAmount; stepId: Id; preparation: string | null; condition: string | null }[];
  removals: { useId: Id; before: WireAmount; after: 'notNeeded' }[];
  reservations: { useId: Id; amount: WireAmount; note: string }[];
  affectedUseIds: Id[];
  stepEffects: { stepId: Id; effect: 'changes' | 'staysReserved'; before: string; after: { text: string; kind: 'same' | 'inserted' }[] | null; titleAfter: string | null; note: string | null }[];
  consequence: { text: string };
  opinion: string | null;              // an import card's own words (AI), shown as such
  runtimeConditions: { text: string; kind: 'availability' | 'progress' }[];
}
export interface UseAnalysis {
  status: AnalysisStatus; reason: AnalysisReason | null; plans: ImportPlan[];
  sharedWithUseIds: Id[];              // other uses the same plan(s) change
  coveredByUseId: Id | null;           // this use is changed by the plan prepared for that use
  offer: 'replacement' | 'omission' | null;   // what the first plan offers (status available only)
  /** Reviewed rules that answer one replacement (or leaving it out) "no" for this use (commission 2026-10-08). Each is
   *  about that replacement only: it never decides the status, and it sits beside whatever else was found. */
  ruledOut: { ruleId: string; title: string; text: string; scopeNote: string; omission: boolean }[];
}

const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function helpers(c: WhyCtx) {
  const r = c.pack.recipe;
  const n = (u: IngredientUse) => stepOrder(r, u.stepId);
  const short = (u: IngredientUse) => { const i = getIngredient(r, u.ingredientId)!; return (i.kind && kindOf(c.v, i.kind.kindId)?.short) || lowerFirst(i.name); };
  const by = (p: { status: string; by: string; ref?: string | null }) => (p.status === 'REVIEWED' ? (p.by === 'OWNER' ? 'reviewed by the owner' : p.ref?.startsWith('roles.json#') ? `machine-checked against the approved role table (${p.ref.slice('roles.json#'.length)})` : 'machine-checked against owner-approved content') : p.status === 'SOURCE_VERIFIED' ? 'read from the source' : p.status === 'CONFIRMED' ? (p.by === 'COOK' ? 'confirmed by you for this recipe' : 'confirmed') : 'not reviewed');
  return { r, n, short, by };
}

/** One binding as an import preview: the candidate the engine builds when the cook reaches the target step. */
function planOf(c: WhyCtx, b: Binding): ImportPlan | null {
  const { r, n, short, by } = helpers(c);
  const { snap, out } = previewBinding(b, r, c.v);
  const k = out.candidate;
  if (!k) return null;
  const after = k.resultRecipe, beforeIds = new Set(r.uses.map((u) => u.useId)), afterIds = new Set(after.uses.map((u) => u.useId));
  const reserved = new Set(k.requirements.filter((q) => q.alreadyReserved).map((q) => q.ingredientId));
  const replacements = after.uses.filter((u) => u.kind === 'ADD' && !beforeIds.has(u.useId)).map((u) => {
    const a = wireAmount(u.amount, u), more = u.amount.kind === 'EXACT' && reserved.has(u.ingredientId);
    return {
      useId: u.useId, ingredientName: upperFirst(lowerFirst(getIngredient(after, u.ingredientId)!.name)), stepId: u.stepId, preparation: u.prepNote,
      amount: more ? { ...a, display: (a.display ?? '').replace(amountDisplay(u.amount), `${amountDisplay(u.amount)} more`) } : a,
      condition: u.allowance ? `${u.allowance.stopCondition} ${u.allowance.ifExhausted}` : null,
    };
  });
  const removals = r.uses.filter((u) => u.kind === 'ADD' && !afterIds.has(u.useId)).map((u) => ({ useId: u.useId, before: wireAmount(u.amount, u), after: 'notNeeded' as const }));
  const reservations = r.uses.filter((u) => u.kind === 'ADD' && afterIds.has(u.useId) && reserved.has(u.ingredientId) && snap.useStatus[u.useId] !== 'ADDED')
    .map((u) => ({ useId: u.useId, amount: wireAmount(u.amount, u), note: `${amountDisplay(u.amount)} ${short(u)} stays reserved for step ${n(u)}` }));
  const stepEffects = k.changes.filter((x) => x.kind !== 'UNCHANGED' || x.note).map((x) => ({
    stepId: x.stepId, effect: x.kind === 'UNCHANGED' ? 'staysReserved' as const : 'changes' as const,
    before: x.before ?? renderStep(r, getStep(r, x.stepId)!), after: x.kind === 'UNCHANGED' ? null : x.segments, titleAfter: x.titleAfter, note: x.note,
  }));
  const steps = [...touched(r, b.ops).steps].map((id) => stepOrder(r, id)).sort((x, y) => x - y);
  const target = getUse(r, b.targetUseId)!;
  const basis: string[] = [];
  // mechanical validity and culinary support said apart (2026-10-13)
  if (b.card) basis.push('Written for this recipe by the import analysis (an AI model), then checked by code: amounts parsed, every use of the ingredient addressed, rewritten steps checked against the recipe.',
    'Culinary support: none on file. Whether this replacement can do the job here is the AI\'s claim; no source or reviewed rule backs it.', 'Not reviewed and not kitchen-tested.');

  const entry = b.card ? c.pack.cards?.find((e) => e.useId === b.targetUseId) : undefined, repaired = entry?.normalized;
  // ccmcp-swaps-3: which of the ranked suggestions this is, and why each earlier one wasn't used
  const rank = entry?.alternates?.findIndex((a) => a.used) ?? -1;
  if (entry?.alternates && rank >= 0) basis.push(`Suggestion ${rank + 1} of ${entry.alternates.length} from the import analysis${rank ? `; earlier ones didn't pass these checks: ${entry.alternates.slice(0, rank).map((a) => `${a.name} (${a.reason})`).join('; ')}` : ''}.`);
  if (entry?.repair?.outcome === 'REPAIRED') basis.push('Corrected once at import: the first draft was rejected by these checks, and this corrected draft passed the same checks. The correction is not a culinary review.');
  if (repaired?.length) basis.push(`Read with deterministic repairs before checking: ${repaired.join('; ')}.`);
  else {
    for (const u of [target, ...b.coveredSiblingUseIds.map((id) => getUse(r, id)!)]) {
      if (u.functions.length) basis.push(`What the ${short(u)} does in step ${n(u)} (${u.functions.map((f) => f.label ?? functionLabel(c.v, f.functionId)).join(', ')}): ${by(u.functions[0].prov)}`);
      // the facts the cook confirmed for this recipe (2026-10-13), named as such
      const k = getIngredient(r, u.ingredientId)?.kind;
      if (k?.prov.by === 'COOK') basis.push(`That the ${lowerFirst(getIngredient(r, u.ingredientId)!.name)} is ${kindOf(c.v, k.kindId)?.label ?? k.kindId}: ${by(k.prov)}`);
      if (u.technique?.prov.by === 'COOK') basis.push(`What is done with the ${short(u)} in step ${n(u)} (${c.v.techniques.find((t) => t.techniqueId === u.technique!.techniqueId)?.label ?? u.technique.techniqueId}): ${by(u.technique.prov)}`);
    }
    const p = c.patterns.find((x) => x.patternId === b.patternId && x.version === b.patternVersion);
    const scale = p?.kind === 'RECOVERY' ? Object.values(p.quantities).find((q) => q.kind === 'SCALE') : undefined;
    if (scale?.kind === 'SCALE') {
      const ing = getIngredient(r, target.ingredientId)!, listed = typeof scale.from !== 'string';
      basis.push(listed ? `Amounts worked out from the listed ${amountDisplay(ing.listed)} ${lowerFirst(ing.name)} (${by(ing.listedProv)})` : `Amounts worked out from step ${n(target)}'s ${amountDisplay(target.amount)} (${by(target.amountProv)})`);
    }
    for (const u of [target, ...b.coveredSiblingUseIds.map((id) => getUse(r, id)!)]) {
      const note = c.pack.cards?.find((e) => e.useId === u.useId)?.roleNote;
      if (note) basis.push(`Step ${n(u)}: ${note}.`);
    }
    if (b.quantityStatus === 'PROVISIONAL') basis.push('Quantities are provisional engineering content, not kitchen-tested.');
  }
  if (!b.card) basis.push('Culinary support: a reviewed rule (sourced content the owner approved). Not kitchen-tested.');
  return {
    planId: b.bindingId, ruleId: b.card ? null : `${b.patternId}@${b.patternVersion}`, title: b.patternTitle, kind: replacements.length ? 'replacement' : 'omission',
    provenance: b.card ? { kind: 'aiPrepared', label: CARD_LABEL, basis } : { kind: 'reviewedRule', label: 'Reviewed change', basis },
    contentStatus: { label: contentLabel('ENGINEERING', b.quantityStatus === 'PROVISIONAL', b.card ? 'IMPORT_CARD' : 'REVIEWED'), provisional: b.quantityStatus === 'PROVISIONAL' },
    summary: k.consequence.headline, replacements, removals, reservations,
    affectedUseIds: uniq([b.targetUseId, ...b.coveredSiblingUseIds, ...removals.map((x) => x.useId), ...reservations.map((x) => x.useId)]),
    stepEffects, consequence: { text: k.consequence.tradeoff }, opinion: b.card?.opinion ?? null,
    runtimeConditions: [
      ...k.requirements.map((q) => ({ kind: 'availability' as const, text: q.display })),
      ...b.guards.map((g) => ({ kind: 'progress' as const, text: `Offered when step ${stepOrder(r, g.stepId)} is your next step` })),
      { kind: 'progress' as const, text: `Only while ${steps.length > 1 ? `steps ${and(steps.map(String))} haven't` : `step ${steps[0]} hasn't`} been started` },
    ],
  };
}

/** What blocks a reviewed alternative, in the cook's words: facts the reading didn't let CourseCorrect confirm (never a question for the cook). */
function blockedText(c: WhyCtx, needs: CoverageEntry[]): string {
  const { r, n, short } = helpers(c);
  const ms = [...new Map(needs.flatMap((e) => e.missing).map((m) => [`${m.subject.id}|${m.predicate}`, m])).values()];
  const recipe = ms.filter((m) => m.predicate === 'AMOUNT_EXACT');
  const unread = ms.filter((m) => m.predicate === 'SOURCE_COVERAGE' || m.predicate === 'TIMING');   // closure 2026-10-08
  const review = ms.filter((m) => m.predicate !== 'AMOUNT_EXACT' && !unread.includes(m)).map((m: MissingFact) => {
    if (m.predicate === 'FUNCTION') { const u = getUse(r, m.subject.id); return u ? `what the ${short(u)} does in step ${n(u)}` : 'what the ingredient does'; }
    if (m.predicate === 'TECHNIQUE') { const u = m.subject.kind === 'USE' ? getUse(r, m.subject.id) : undefined; return u ? `what is done with the ${short(u)} in step ${n(u)}` : `how step ${stepOrder(r, m.subject.id)} is done`; }
    return `that “${getIngredient(r, m.subject.id)?.name ?? 'the ingredient'}” is ${classLabel(c.v, m.expected)}`;
  });
  const titles = and(uniq(needs.map((e) => e.patternTitle.toLowerCase())));
  return [
    recipe.length ? `The recipe doesn't state ${and(recipe.map((m) => missingText(c, m)))}, which the alternative (${titles}) needs.` : '',
    review.length ? `CourseCorrect couldn't confirm ${and(uniq(review))} from this reading, so the reviewed alternative (${titles}) can't be offered.` : '',
    unread.length ? `The reading doesn't account for all of the original method (${and(uniq(unread.map((m) => missingText(c, m))))}), so the reviewed alternative (${titles}) can't be offered: it needs the method from mixing to baking read in full.` : '',
  ].filter(Boolean).join(' ');
}

const ruledOut = (e: CoverageEntry) => e.status !== 'BOUND' && e.status !== 'NEEDS_FACTS' && !e.failedCheck?.code.startsWith('CARD_');

/** Exactly one analysis per use. `pending`: the import's swap analysis is still running for this reading. */
export function analysisOf(c: WhyCtx, useId: Id, pending: boolean, memo = new Map<Id, ImportPlan | null>()): UseAnalysis {
  const { r, n, short } = helpers(c);
  const u = getUse(r, useId);
  const refusals = c.pack.bindings.filter((b) => b.kind === 'REFUSAL' && !b.card && b.targetUseId === useId && b.refusal)
    .map((b) => ({ ruleId: `${b.patternId}@${b.patternVersion}`, title: b.patternTitle, text: b.refusal!.text, scopeNote: b.refusal!.scopeNote, omission: !!b.refusal!.omission }));
  const bare = { plans: [], sharedWithUseIds: [], coveredByUseId: null, offer: null, ruledOut: refusals };
  const R = (status: AnalysisStatus, code: string, text: string, detail: string | null = null): UseAnalysis => ({ status, reason: { code, text, detail }, ...bare });
  if (!u) return R('unexamined', 'notInPack', 'This use wasn’t part of the recipe that was checked.');
  if (u.kind === 'PREPARE') {
    const t = u.preparesUseId ? getUse(r, u.preparesUseId) : undefined;
    return R('unexamined', 'preparesUse', t ? `This step only prepares the ${short(u)} for step ${n(t)}; alternatives are checked on that use.` : 'This step only prepares an ingredient; alternatives are checked where it is added.');
  }
  const plan = (b: Binding) => { if (!memo.has(b.bindingId)) memo.set(b.bindingId, planOf(c, b)); return memo.get(b.bindingId)!; };
  const available = (bs: Binding[], coveredBy: Id | null = null): UseAnalysis => {
    const plans = bs.map(plan).filter((p): p is ImportPlan => !!p);
    if (!plans.length) return R('failed', 'previewFailed', 'The alternative couldn’t be previewed against this recipe.', bs.map((b) => b.bindingId).join(', '));
    return { status: 'available', reason: null, plans, coveredByUseId: coveredBy, offer: plans[0].kind, ruledOut: refusals, sharedWithUseIds: uniq(bs.flatMap((b) => [b.targetUseId, ...b.coveredSiblingUseIds])).filter((x) => x !== useId) };
  };
  const binds = c.pack.bindings;
  const recs = binds.filter((b) => b.kind === 'RECOVERY' && b.targetUseId === useId);
  const coverOf = (card: boolean) => binds.find((b) => b.kind === 'RECOVERY' && !!b.card === card && b.coveredSiblingUseIds.includes(useId));
  const card = c.pack.cards?.find((e) => e.useId === useId) ?? null;

  // a plan always shows first; a reviewed refusal of one replacement never hides it (G13, commission 2026-10-08)
  if (recs.some((b) => !b.card)) return available(recs.filter((b) => !b.card));
  const rc = coverOf(false);
  if (rc) return available([rc], rc.targetUseId);
  if (pending && (!card || card.reason === 'NO_ANALYSIS' || card.repair?.outcome === 'RUNNING')) return { status: 'pending', reason: null, ...bare };
  const own = recs.find((b) => b.card);
  if (own) {
    const later = own.uncoveredSiblingUseIds.map((id) => getUse(r, id)).filter((s): s is IngredientUse => !!s && n(s) > n(u));
    if (later.length) return R('evaluatedNoOption', 'otherUseCantBeCovered', later.map((s) => own.card!.siblingNotes[s.useId]).join(' '), `${CARD_LABEL}: "${own.patternTitle}" covers step ${n(u)} only`);
    return available([own]);
  }
  const cc = coverOf(true);
  if (cc) return available([cc], cc.targetUseId);
  const entries = c.pack.coverage.filter((e) => e.targetUseId === useId);
  // blocked: a reviewed rule for this use waits on a named fact, or one for another use of the same ingredient does and
  // names this use (a rule must account for every use of its ingredient, as the scone's brushing cream)
  const sameIngredient = (e: CoverageEntry) => !!e.targetUseId && getUse(r, e.targetUseId)?.ingredientId === u.ingredientId;
  const waiting = c.pack.coverage.filter((e) => e.status === 'NEEDS_FACTS' && e.kind === 'RECOVERY' && (e.targetUseId === useId || (sameIngredient(e) && e.missing.some((m) => m.subject.id === useId))));
  // one rule, several versions (v1 for "a little", v2 for stated amounts): name the version closest to applying
  const needs = waiting.filter((e) => !waiting.some((o) => o.patternId === e.patternId && (o.missing.length < e.missing.length || (o.missing.length === e.missing.length && o.patternVersion < e.patternVersion))));
  // reviewed refusals answer one replacement each: they are listed in `ruledOut` beside whatever this use's status is, and
  // never become the status ("no alternative") themselves (commission 2026-10-08)
  const no = binds.find((b) => b.kind === 'REFUSAL' && b.targetUseId === useId && b.card);
  if (no?.card) return R('evaluatedNoOption', 'aiSaysNo', no.card.opinion, `${CARD_LABEL}: an opinion, not a reviewed rule`);
  const round = card?.repair ? `; correction round: ${card.repair.outcome}${card.repair.outcome === 'REPAIRED' || card.repair.outcome === 'STILL_INVALID' ? `, first draft rejected as ${card.repair.originalReason}` : card.repair.detail ? ` (${card.repair.detail})` : ''}` : '';
  const cardWhy = card?.status === 'INVALID' ? `${card.alternates ? `import cards (${card.alternates.length} ranked): ${card.alternates.map((a) => `${a.name}: ${a.reason}`).join('; ')}` : `import card: ${card.reason}`}${card.normalized?.length ? ` (after repairs: ${card.normalized.join('; ')})` : ''}${round}` : null;
  // waiting on a fact: a drafted alternative already answered by a sourced limit or a reviewed rule says so beside the question
  const limit = card?.status === 'INVALID' && card.reason?.startsWith('EXCEEDS_SOURCED_LIMIT') ? card.reason.replace(/^EXCEEDS_SOURCED_LIMIT: [^:]+: /, '') : null;
  const draftTitle = entries.find((e) => e.patternId === CARD_PATTERN)?.patternTitle;
  const limitNote = limit ? ` The alternative drafted at import${draftTitle ? ` (${lowerFirst(draftTitle)})` : ''} isn’t offered: ${limit}` : '';
  if (needs.length) return R('blocked', 'missingFact', blockedText(c, needs) + limitNote, [...needs.flatMap((e) => e.missing.map((m) => missingText(c, m))), cardWhy].filter(Boolean).join('; '));
  // a reviewed alternative this recipe ruled out keeps its reason visible beside a failed or missing AI check (closure 2026-10-08)
  const considered = entries.filter((e) => e.kind === 'RECOVERY' && ruledOut(e)).map((e) => ` The reviewed alternative (${e.patternTitle.toLowerCase()}) isn’t offered here: ${checkText(c, e)}.`).join('');
  if (cardWhy) {
    const code = card!.reason ?? '';
    if (code === 'NO_ANALYSIS' || code.includes('LIVE_ANALYSIS_REQUIRED')) return R('unexamined', 'notRun', `This use hasn’t been checked for alternatives: no analysis ran for this reading.${considered}`, cardWhy);
    if (code === 'DRAFTED_BEFORE_CHOICE') return R('unexamined', 'contentChanged', `The alternatives drafted at import were written before you chose which option to use, so they aren’t offered for your choice. That isn’t a finding that the ${short(u)} can’t be replaced.${considered}`, cardWhy);
    if (code === 'STALE_ANALYSIS') return R('unexamined', 'contentChanged', 'The recipe changed after this use was checked, so that check no longer applies.', cardWhy);
    // technical failures stay "failed" (recoverable: checking again can change them), never worded as a finding about the food
    const notFinding = `That isn’t a finding that the ${short(u)} can’t be replaced.`;   // the page states the available action
    if (code.startsWith('FAILED_CALL')) return R('failed', 'analysisError', `The check for alternatives didn’t finish (a technical problem). ${notFinding}${considered}`, cardWhy);
    // a drafted alternative that reviewed content answers otherwise: that one replacement is answered (the draft and its
    // reasons are kept for the record); nothing else was drafted, which is not a finding that nothing else could work
    // a drafted alternative beyond what sources support (an approved sourced limit): an explicit limitation, never a usable plan
    if (limit) return R('evaluatedNoOption', 'unsupportedByEvidence', `${limitNote.trim()} No other alternative was drafted for this use.`, cardWhy);
    if (code.startsWith('CONTRADICTS_REVIEWED_RULE')) {
      const rule = /^CONTRADICTS_REVIEWED_RULE: "([^"]+)" [^:]+: (.*)$/.exec(code);
      const draft = entries.find((e) => e.patternId === CARD_PATTERN)?.patternTitle;
      const scope = rule ? refusals.find((x) => x.text === rule[2])?.scopeNote : undefined;   // the rule's own limits travel with its answer
      return R('evaluatedNoOption', 'contradictsReviewedRule', `The alternative drafted at import${draft ? ` (${lowerFirst(draft)})` : ''} isn’t offered.${rule ? ` ${rule[2]}` : ''}${scope ? ` ${scope}` : ''} No other alternative was drafted for this use.`,
        [`${cardWhy}`, card!.opinion ? `${CARD_LABEL} said: “${card!.opinion}”` : ''].filter(Boolean).join('; '));
    }
    // the only suggestions were the same ingredient under another name (live, 2026-10-08: "all-purpose flour" for plain flour,
    // again after the correction round): no alternative was drafted at all, which is "no alternative found", not a failed check
    if ((card!.alternates?.map((x) => x.reason ?? '') ?? [code]).every((x) => x.startsWith('SWAP_IS_SAME_INGREDIENT'))) {
      const named = /^SWAP_IS_SAME_INGREDIENT: (.+?) resolves to /.exec(code)?.[1];
      return R('evaluatedNoOption', 'sameIngredient', `The import analysis suggested ${named ?? 'the same ingredient'}, which is the ${short(u)} under another name, so there’s no alternative to offer here. ${notFinding}${considered}`, cardWhy);
    }
    const tried = card!.repair && card!.repair.outcome !== 'NOT_RUN' ? ', even after one automatic correction' : '';
    const drafted = card!.alternates ? `None of the ${card!.alternates.length} alternatives drafted for this use passed CourseCorrect’s checks${tried}, so none is offered.` : `An alternative was drafted for this use, but it didn’t pass CourseCorrect’s checks${tried}, so it isn’t offered.`;
    return R('failed', 'validationFailed', `${drafted} ${notFinding}${considered}`, cardWhy);
  }
  const out = entries.filter(ruledOut);
  if (out.length) return R('evaluatedNoOption', 'noSupportedPlan', `${upperFirst(out.map((e) => checkText(c, e)).join('; '))}.`, out.map((e) => `Considered: ${e.patternTitle}`).join('; '));
  return R('unexamined', 'noCheck', 'No reviewed alternative applies to this use, and it wasn’t checked at import.');
}
