// Deterministic "why" (owner, 2026-10-02): compile coverage and bindings → plain-language facts. Shared by the import swap
// plan and refusal explanations. Code templates, content-driven wording; never a model, never recipe-specific branches.
import type { Binding, CoverageEntry, EvaluationResult, Id, IngredientUse, MissingFact, Pattern, Predicate, RecipePack, Vocabulary } from './types.ts';
import { formatRational } from '../domain/rational.ts';
import { amountDisplay, getIngredient, getStep, getUse, lowerFirst, qtyText, stepOrder, upperFirst } from '../domain/recipe.ts';
import { classLabel, classesOfKind, functionLabel, kindOf, proposalClasses, sameSet } from '../domain/vocabulary.ts';
import { CARD_LABEL } from '../compile/cards.ts';

export interface WhyCtx { pack: RecipePack; patterns: Pattern[]; v: Vocabulary }
/** One use's answer. `origin`/`label` say whose plan it is (reviewed rule or import card, AI); `role`/`opinion` are the card's words. */
export interface WireSwap {
  kind: 'recovery' | 'covered' | 'refusal' | 'needsFacts' | 'none'; text: string; details: string[];
  origin: 'reviewed' | 'importCard' | null; label: string | null; role: string | null; opinion: string | null;
}
export interface Why { verdict: 'no' | 'notNow' | 'noRule'; facts: string[]; proposalAnswer: string | null }

const techLabel = (v: Vocabulary, id: Id) => v.techniques.find((t) => t.techniqueId === id)?.label ?? id;
const unitText = (u: string) => (u === 'G' ? 'g' : u === 'ML' ? 'ML' : '');
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');

function lex(c: WhyCtx) {
  const r = c.pack.recipe;
  const use = (id: Id) => getUse(r, id);
  const n = (u: IngredientUse) => stepOrder(r, u.stepId);
  const short = (u: IngredientUse) => { const i = getIngredient(r, u.ingredientId)!; return (i.kind && kindOf(c.v, i.kind.kindId)?.short) || lowerFirst(i.name); };
  const roles = (u: IngredientUse) => and(u.functions.map((f) => f.label ?? functionLabel(c.v, f.functionId)));
  // a use can carry several refusals (whipping cream: milk and butter; thin creams): the one naming the proposal first, then
  // a replacement-specific one, then anything else (an omission refusal or a card's "no")
  const refusalOn = (id: Id, P: Id[] = []) => {
    const rs = c.pack.bindings.filter((b) => b.kind === 'REFUSAL' && b.targetUseId === id);
    return rs.find((b) => P.length > 0 && b.refusal!.classes.length > 0 && sameSet(b.refusal!.classes, P)) ?? rs.find((b) => !b.refusal!.omission) ?? rs[0];
  };
  const pattern = (e: { patternId: Id; patternVersion: number }) => c.patterns.find((p) => p.patternId === e.patternId && p.version === e.patternVersion);
  return { r, use, n, short, roles, refusalOn, pattern };
}

/** What a binding's new use reads as: "85 g cold butter", "180 ML milk, plus up to 30 ML more only if needed". */
function newUseText(c: WhyCtx, b: Binding, u: IngredientUse) {
  const added = b.ops.find((o) => o.op === 'ADD_INGREDIENT' && o.ingredient.ingredientId === u.ingredientId);
  const name = lowerFirst(added?.op === 'ADD_INGREDIENT' ? added.ingredient.name : getIngredient(c.pack.recipe, u.ingredientId)?.name ?? '');
  return `${amountDisplay(u.amount)} ${[u.prepNote, name].filter(Boolean).join(' ')}${u.allowance ? `, plus up to ${qtyText(u.allowance.max, u.allowance.unit)} more only if needed` : ''}`;
}

export function missingText(c: WhyCtx, m: MissingFact): string {
  const { r, use, n, short } = lex(c);
  if (m.predicate === 'AMOUNT_EXACT') {
    const u = m.subject.kind === 'USE' ? use(m.subject.id) : r.uses.find((x) => x.ingredientId === m.subject.id);
    const what = u ? short(u) : 'ingredient', unit = m.expected.endsWith('G') ? 'weight in grams' : `amount in ${m.expected.split(' ').pop()}`;
    return `the ${what} ${unit} ${m.subject.kind === 'USE' && u ? `in step ${n(u)}` : 'in the ingredient list'}`;
  }
  if (m.predicate === 'KIND_CLASS') return `confirmation that “${getIngredient(r, m.subject.id)?.name ?? m.subject.id}” is ${classLabel(c.v, m.expected)}`;
  // source completeness (closure 2026-10-08): what of the original method the steps as read don't account for
  if (m.predicate === 'SOURCE_COVERAGE') {
    const n = stepOrder(r, m.subject.id), ex = m.expected.length > 70 ? `${m.expected.slice(0, 67)}…` : m.expected;
    return m.expected === 'NOT_ASSESSED' ? `the method around step ${n} wasn't checked against the original` : m.expected === 'NOT_FOUND' ? `step ${n}'s wording wasn't found in the original` : `“${ex}” before step ${n} isn't in the steps as read`;
  }
  if (m.predicate === 'TIMING') return `the time “${m.expected}” in step ${stepOrder(r, m.subject.id)} isn't accounted for`;
  if (m.predicate === 'TECHNIQUE') return c.v.techniques.some((x) => x.techniqueId === m.expected) ? `step ${stepOrder(r, m.subject.id)} recognized as “${techLabel(c.v, m.expected)}”` : `step ${stepOrder(r, m.subject.id)} recognized (what it does wasn't confirmed)`;
  const u = use(m.subject.id);
  return u ? `the ${short(u)}'s role in step ${n(u)} (${functionLabel(c.v, m.expected)}) on the role table` : `a role on the role table`;
}

/** One plain-language reason for a compile check that ruled a reviewed swap out for this recipe. */
export function checkText(c: WhyCtx, e: CoverageEntry): string {
  const { r, use, n, short, roles, refusalOn, pattern } = lex(c);
  const target = e.targetUseId ? use(e.targetUseId) : undefined, p = pattern(e);
  const code = e.failedCheck?.code ?? e.status, detail = e.failedCheck?.detail ?? '';
  if (code === 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED') {
    return detail.split(', ').map(use).filter((u): u is IngredientUse => !!u).map((u) =>
      `the ${short(u)} is also used in step ${n(u)} (${refusalOn(u.useId)?.refusal?.requiredFunctionLabel ?? roles(u)}), and this swap can't cover that use`).join('; ');
  }
  if (code === 'QUANTITY_INPUT_OUT_OF_DOMAIN' && p?.kind === 'RECOVERY' && target) {
    const q = p.quantities[detail.split(':')[0]];
    if (q?.kind === 'SCALE') {
      const listed = typeof q.from !== 'string', a = listed ? getIngredient(r, target.ingredientId)!.listed : target.amount;
      return `the swap is reviewed only for ${formatRational(q.inputDomain[0])}–${formatRational(q.inputDomain[1])} ${unitText(q.sourceUnit)}; this recipe ${listed ? 'lists' : 'uses'} ${amountDisplay(a)}`;
    }
  }
  if (code === 'APPLICABILITY') {
    const pr = JSON.parse(detail) as Predicate;
    if (pr.kind === 'AMOUNT_IN_RANGE') return `the swap is reviewed only for ${formatRational(pr.min)}–${formatRational(pr.max)} ${unitText(pr.unit)}${pr.slot === '$target' && target ? `; this recipe uses ${amountDisplay(target.amount)}` : ''}`;
    if (pr.kind === 'RECIPE_HAS_USE_OF_CLASS') return pr.expect ? `the swap needs ${classLabel(c.v, pr.classId)} in the recipe` : `the recipe also has ${classLabel(c.v, pr.classId)}, which the swap doesn't account for`;
    if (pr.kind === 'NO_HOLD_BETWEEN') return `the recipe rests or chills before baking, and the swap has to be baked straight away`;
    return `this recipe doesn't meet the swap's conditions`;
  }
  if (code.startsWith('SLOT_')) {
    const s = p?.slots.find((x) => x.slot === code.split(':')[1]);
    const what = !s ? 'step' : 'technique' in s ? `“${techLabel(c.v, s.technique)}” step ${s.kind === 'STEP_BEFORE_TARGET' ? 'before' : 'after'} step ${target ? n(target) : '?'}` : `${classLabel(c.v, s.ingredientClass)} use`;
    // a slot found nowhere in an import is about this reading (a step's technique may not have been recognized), never proof
    // about the recipe; an owner-authored recipe is as written
    if (code.startsWith('SLOT_NONE')) return r.source?.rights === 'OWNER_AUTHORED' ? `this recipe has no ${what}, which the swap needs` : `this reading has no recognized ${what}, which the swap needs`;
    return `more than one ${what} could be the one the swap needs`;
  }
  if (code.startsWith('EXCEPTION:')) return lowerFirst(detail);
  if (code === 'CONTRADICTORY_PROPOSAL_CLAIMS') return 'two reviewed rules disagree about this use';
  if (code === 'CARD_INVALID') return 'no swap could be worked out for this use at import';
  if (code === 'QUANTITY_OUTPUT_OUT_OF_DOMAIN' || code === 'QUANTITY_ROUNDING_ERROR') return 'the worked-out amounts would fall outside the reviewed range';
  if (code.startsWith('QUANTITY_UNRESOLVED') || e.status === 'QUANTITY_UNRESOLVED') return "the swap's amounts aren't worked out yet";
  return "the swap couldn't be checked against this recipe's wording";   // ponytail: rare structural codes share one honest line
}

const ruledOut = (e: CoverageEntry) => e.status !== 'BOUND' && e.status !== 'NEEDS_FACTS' && e.failedCheck?.code !== 'CARD_SUPERSEDED';

/** The swap plan for one use (owner decisions 2026-10-02): a reviewed plan where one binds, else the use's import card. */
export function swapOf(c: WhyCtx, useId: Id): WireSwap {
  const { use, n } = lex(c);
  const u = use(useId);
  const card = c.pack.cards?.find((e) => e.useId === useId) ?? null;
  const words = { role: card?.role ?? null, opinion: card && card.status !== 'INVALID' ? card.opinion : null };
  const R = (x: Pick<WireSwap, 'kind' | 'text' | 'details'>): WireSwap => ({ ...x, origin: 'reviewed', label: 'Reviewed change', ...words });
  const C = (x: Pick<WireSwap, 'kind' | 'text' | 'details'>): WireSwap => ({ ...x, origin: 'importCard', label: CARD_LABEL, ...words });
  if (!u) return { kind: 'none', text: 'No swap prepared', details: [], origin: null, label: null, role: null, opinion: null };
  const steps = (b: Binding) => b.ops.flatMap((o) => (o.op === 'ADD_USE' || o.op === 'REPLACE_USE' ? [`Step ${stepOrder(c.pack.recipe, o.newUse.stepId)}: ${newUseText(c, b, o.newUse)}`] : []));
  const recs = c.pack.bindings.filter((b) => b.kind === 'RECOVERY' && b.targetUseId === useId);
  const reviewed = recs.filter((b) => !b.card);
  if (reviewed.length) {
    return R({ kind: 'recovery', text: `If you run out: ${reviewed.map((b) => b.patternTitle).join(' · or · ')}`, details: reviewed.flatMap((b) => [b.consequence!.headline, ...steps(b), b.consequence!.tradeoff]) });
  }
  const coverOf = (fromCard: boolean) => {
    const b = c.pack.bindings.find((x) => x.kind === 'RECOVERY' && !!x.card === fromCard && x.coveredSiblingUseIds.includes(useId));
    const op = b?.ops.find((o) => o.op === 'REPLACE_USE' && o.useId === useId);
    return b && op?.op === 'REPLACE_USE' ? { kind: 'covered' as const, text: `Covered by step ${n(use(b.targetUseId)!)}'s swap: ${newUseText(c, b, op.newUse)}`, details: [b.patternTitle] } : null;
  };
  const rc = coverOf(false);
  if (rc) return R(rc);
  const own = recs.find((b) => b.card);
  if (own) {
    const later = own.uncoveredSiblingUseIds.map(use).filter((s): s is IngredientUse => !!s && n(s) > n(u));
    if (later.length) return C({ kind: 'refusal', text: `No for now: ${later.map((s) => own.card!.siblingNotes[s.useId]).join(' ')}`, details: [`The plan for step ${n(u)} alone: ${steps(own).map((x) => x.replace(/^Step \d+: /, '')).join(', ')}`, own.consequence!.tradeoff] });
    return C({ kind: 'recovery', text: `If you run out: ${own.patternTitle}`, details: [own.consequence!.headline, ...steps(own), own.consequence!.tradeoff] });
  }
  const cc = coverOf(true);
  if (cc) return C(cc);
  const no = c.pack.bindings.find((b) => b.kind === 'REFUSAL' && b.targetUseId === useId && b.card);
  if (no?.card) return C({ kind: 'refusal', text: no.card.opinion, details: [] });
  const entries = c.pack.coverage.filter((e) => e.targetUseId === useId);
  const needs = [...new Set(entries.filter((e) => e.status === 'NEEDS_FACTS').flatMap((e) => e.missing.map((m) => missingText(c, m))))];
  const failed = card?.status === 'INVALID', couldnt = "We couldn't work out a swap for this one";
  if (needs.length) {
    const x = { kind: 'needsFacts' as const, details: entries.filter((e) => !e.failedCheck?.code.startsWith('CARD_')).map((e) => `Considered: ${e.patternTitle}`) };
    return failed ? C({ ...x, text: `${couldnt}. A reviewed swap needs ${and(needs)}` }) : R({ ...x, text: `No swap prepared: needs ${and(needs)}` });
  }
  if (failed) return C({ kind: 'none', text: couldnt, details: [] });
  // a reviewed refusal answers one replacement only (G13): said as such, never as "no swap", and only where nothing else
  // answered this use; leaving-it-out refusals refuse no replacement
  const ref = c.pack.bindings.find((b) => b.kind === 'REFUSAL' && b.targetUseId === useId && !b.card && !b.refusal?.omission);
  if (ref?.refusal) return R({ kind: 'refusal', text: `One swap ruled out: ${ref.patternTitle.toLowerCase()}`, details: [ref.refusal.text, ref.refusal.scopeNote] });
  const out = entries.filter(ruledOut);
  if (out.length) return R({ kind: 'none', text: `No swap prepared: ${out.map((e) => checkText(c, e)).join('; ')}`, details: out.map((e) => `Considered: ${e.patternTitle}`) });
  return { kind: 'none', text: 'No swap prepared', details: [], origin: null, label: null, ...words };
}

/** Structured reasons for a refused rescue. The engine decided; this only states why, from the pack and the result. */
export function refusalWhy(c: WhyCtx, res: EvaluationResult, proposedKindIds: Id[]): Why {
  const { r, use, n, short, roles, refusalOn, pattern } = lex(c);
  const rf = res.refusal!, t = res.target, tu = t ? use(t.useId) : undefined;
  const P = proposalClasses(c.v, proposedKindIds).classes;
  const said = and(proposedKindIds.map((k) => kindOf(c.v, k)?.short ?? k));
  const facts: string[] = [], answers: string[] = [];
  // an import card's "no" refused this use: its opinion is the reason, said first ("No, because …")
  const cardNo = rf.code === 'NOT_FUNCTIONALLY_EQUIVALENT' && tu ? c.pack.bindings.find((b) => b.kind === 'REFUSAL' && b.card && b.targetUseId === tu.useId && b.refusal!.text === rf.message) : undefined;
  // every remaining use of the ingredient: its role, what the reviewed rules say there, and whether the proposal fits
  const uses = t ? t.allRemainingUses.map((x) => use(x.useId)).filter((u): u is IngredientUse => !!u) : [];
  // a use whose own refusal answers the proposal is explained there; other reasons about that use would only repeat it
  const answered = new Set(uses.filter((u) => { const x = refusalOn(u.useId, P)?.refusal; return !!x && P.length > 0 && (x.classes.length === 0 || sameSet(x.classes, P)); }).map((u) => u.useId));
  for (const u of uses) {
    const title = getStep(r, u.stepId)?.title, where = `In step ${n(u)}${title ? ` (${title})` : ''}`;
    const refusal = refusalOn(u.useId, P), techId = getStep(r, u.stepId)?.technique?.techniqueId;
    const entries = c.pack.coverage.filter((e) => e.targetUseId === u.useId && e.kind === 'RECOVERY');
    const fits = entries.find((e) => { const p = pattern(e); return P.length > 0 && p?.kind === 'RECOVERY' && p.proposal?.relation === 'REALIZED_AS_PROPOSED' && sameSet(p.proposal.classes, P); });
    if (u === tu && cardNo) {
      if (P.length) answers.push(`step ${n(u)}: no`);
    } else if (refusal?.refusal) {
      const job = techId ? techLabel(c.v, techId) : refusal.refusal.requiredFunctionLabel;
      const matched = P.length > 0 && (refusal.refusal.classes.length === 0 || sameSet(refusal.refusal.classes, P));
      const head = refusal.refusal.answer ? `${where} the ${short(u)} is the ${refusal.refusal.requiredFunctionLabel}` : `${where} the ${short(u)} is used to ${job} (${refusal.refusal.requiredFunctionLabel})`;
      const authored = u === tu && rf.code === 'NOT_FUNCTIONALLY_EQUIVALENT';
      // the authored reason already names the job and why the proposal can't do it, so it's said once. A proposal no rule
      // answers is never called unsuitable: CourseCorrect can't confirm it (chilled coconut cream does whip, for one)
      if (!(authored && matched)) facts.push(`${head}; ${matched ? `${said} ${refusal.refusal.answer ?? `can't ${job}`}` : refusal.card ? `the import analysis found nothing that can replace it` : said ? `CourseCorrect can't confirm that ${said} will do that, and it has no other option to suggest` : `CourseCorrect has no option it can confirm for that`}`);
      if (authored) facts.push(rf.message);   // authored reason, verbatim
      if (P.length) answers.push(`step ${n(u)}: ${matched ? 'no' : 'not reviewed'}`);
    } else if (fits) {
      facts.push(`${where} the ${short(u)} is the ${roles(u)}; ${said} can do that job`);
      if (P.length) answers.push(`step ${n(u)}: ${fits.status === 'BOUND' ? 'yes' : 'would work on its own'}`);
    } else if (P.length) answers.push(`step ${n(u)}: not reviewed`);
    if (u === tu || rf.code === 'NO_SUPPORTED_RECOVERY') {
      const all = entries.filter(ruledOut);
      for (const e of all) {
        const code = e.failedCheck?.code ?? '';
        if (code === 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED' && e.failedCheck!.detail.split(', ').every((id) => answered.has(id))) continue;
        // two versions of one rule: the specific reason, not that this version's shape doesn't fit
        if (code.startsWith('SLOT_NONE') && all.some((o) => o.patternId === e.patternId && !(o.failedCheck?.code ?? '').startsWith('SLOT_NONE'))) continue;
        facts.push(checkText(c, e));
      }
      const waiting = entries.filter((e) => e.status === 'NEEDS_FACTS').flatMap((e) => e.missing);
      const read = (m: MissingFact) => m.predicate === 'SOURCE_COVERAGE' || m.predicate === 'TIMING';
      const needs = waiting.filter((m) => !read(m)).map((m) => missingText(c, m)), unread = waiting.filter(read).map((m) => missingText(c, m));
      if (needs.length) facts.push(`the swap for step ${n(u)} needs ${and([...new Set(needs)])}, which this recipe doesn't state`);
      if (unread.length) facts.push(`the swap for step ${n(u)} needs the original method read in full, and it wasn't: ${and([...new Set(unread)])}`);
    }
  }
  const NOT_NOW = ['PROTECTED_WORK', 'AFFECTED_USE_IN_PROGRESS', 'NOT_APPLICABLE_NOW', 'CONFLICTS_WITH_EARLIER_CHANGE', 'SUCCESSIVE_RESCUE_UNSUPPORTED', 'INSUFFICIENT_AVAILABILITY', 'NOTHING_TO_CHANGE'];
  let verdict: Why['verdict'];
  if (NOT_NOW.includes(rf.code)) { verdict = 'notNow'; facts.unshift(rf.message); }
  else if (rf.code === 'NO_SUPPORTED_RECOVERY' && !facts.length) { verdict = 'noRule'; facts.push(`there's no reviewed swap for the ${tu ? short(tu) : 'ingredient'}${tu ? ` in step ${n(tu)}` : ''}, and CourseCorrect doesn't guess one`); }
  else if (rf.code === 'REFERENCE_NOT_IN_RECIPE' || rf.code === 'NOT_RELEASED') { verdict = 'noRule'; facts.push(rf.message); }
  else {
    verdict = 'no';
    if (rf.code === 'AFFECTED_USE_UNACCOUNTED') {
      // a card plan that can't cover a still-needed use: the card's own note says why ("the cream is also whipped in step 6 …")
      const plan = tu ? c.pack.bindings.find((b) => b.kind === 'RECOVERY' && b.card && b.targetUseId === tu.useId) : undefined;
      const remaining = new Set(t?.allRemainingUses.map((x) => x.useId) ?? []);
      facts.unshift(rf.message, ...(plan?.uncoveredSiblingUseIds.filter((id) => remaining.has(id)).map((id) => plan.card!.siblingNotes[id]) ?? []));
    }
    if (cardNo) facts.unshift(`because ${lowerFirst(cardNo.card!.opinion.replace(/^No[,.:;]?\s*(?:because\s+)?/i, ''))}`);
  }
  return { verdict, facts: [...new Set(facts.map((f) => f.replace(/\.$/, '')))], proposalAnswer: answers.length ? `${upperFirst(said)}: ${answers.join(', ')}` : null };
}

const PREFIX: Record<Why['verdict'], string> = { no: 'No.', notNow: 'Not right now.', noRule: 'No.' };
/** Fallback answer: always available, built only from the facts. */
export const templateAnswer = (w: Why) => (w.verdict === 'no' && /^because /.test(w.facts[0] ?? '')
  ? [`No, ${w.facts[0]}.`, ...w.facts.slice(1).map((f) => `${upperFirst(f)}.`)]
  : [PREFIX[w.verdict], ...w.facts.map((f) => `${upperFirst(f)}.`)]).join(' ');
