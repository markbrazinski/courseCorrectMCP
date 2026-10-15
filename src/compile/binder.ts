// Build-time binder (ESOD §5): patterns × recipe → immutable pack with per-binding status.
// No failure here except a structural recipe error affects anything beyond its own binding.
import type {
  Binding, CoverageEntry, FactStatus, FunctionMapEntry, Id, Ingredient, IngredientUse, MissingFact, NewUseSpec, Op,
  Pattern, Predicate, Provenance, Recipe, RecipePack, RecoveryPattern, RunSnapshot, Step, Unit, Vocabulary,
} from '../contract/types.ts';
import { add, cmp, hash, mul, type Rational } from '../domain/rational.ts';
/** Opaque, deterministic binding (candidate) id: never readable as a rule or recipe name. */
const bindingIdOf = (p: { patternId: Id; version: number }, useId: Id): Id => `cand_${hash({ p: p.patternId, v: p.version, u: useId }).slice(0, 12)}`;

export { ENGINE_SEMANTICS };
import { cupText, getIngredient, getStep, getUse, renderStep, spoonText, stepOrder, upperFirst, validateStructure } from '../domain/recipe.ts';
import { classLabel, classesOfKind, ingredientInClass, sameSet, settled } from '../domain/vocabulary.ts';
import { ENGINE_SEMANTICS } from '../contract/types.ts';
import { evaluateBinding, factsHashOf } from '../engine/evaluate.ts';
import { resolveQuantity } from './quantity.ts';

const MAX_PER_TARGET = 3;

// Unreviewed facts are never PASS (ESOD §3.1). A proposal that contradicts the requirement FAILs; silence (no proposal)
// is ABSENT — a weaker UNKNOWN that still lists the fact for review, so a model omission cannot hide a rule (M2 probe E5).
type Tri = 'PASS' | 'FAIL' | 'UNKNOWN' | 'ABSENT';
const RANK: Record<FactStatus, number> = { PROPOSED: 0, SOURCE_VERIFIED: 1, CONFIRMED: 1, REVIEWED: 2 };
const atLeast = (p: Provenance, s: FactStatus) => RANK[p.status] >= RANK[s];
const all = (xs: Tri[]): Tri => (xs.includes('FAIL') ? 'FAIL' : xs.includes('ABSENT') ? 'ABSENT' : xs.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS');

interface Facts { recipe: Recipe; vocab: Vocabulary; missing: MissingFact[] }

function performs(f: Facts, u: IngredientUse, fn: Id): Tri {
  const a = u.functions.find((x) => x.functionId === fn);
  const miss = (have: string | null) => f.missing.push({ subject: { kind: 'USE', id: u.useId }, predicate: 'FUNCTION', expected: fn, have, minStatus: 'REVIEWED', who: 'OWNER' });
  if (a) { if (atLeast(a.prov, 'REVIEWED')) return 'PASS'; miss(a.prov.status); return 'UNKNOWN'; }
  if (u.functions.some((x) => atLeast(x.prov, 'REVIEWED'))) return 'FAIL';   // a reviewed set without it
  miss(null);
  return 'ABSENT';
}
/** What a step does (approved cue, or the cook said so; 2026-10-13: either settles it). Missing: the cook can answer it. */
function technique(f: Facts, s: Step, t: Id): Tri {
  const miss = (have: string | null) => f.missing.push({ subject: { kind: 'STEP', id: s.stepId }, predicate: 'TECHNIQUE', expected: t, have, minStatus: 'CONFIRMED', who: 'COOK' });
  if (!s.technique) { miss(null); return 'ABSENT'; }
  if (s.technique.techniqueId !== t) return 'FAIL';
  if (settled(s.technique.prov)) return 'PASS';
  miss(s.technique.prov.status);
  return 'UNKNOWN';
}
/**
 * What is done with a use: the cook's answer for that use when there is one, else its step's technique. A step technique the
 * reading only proposed can't rule out what is done with THIS ingredient there (one step can combine the dry ingredients and mix
 * a batter: corpus d03): the use's own technique is then a missing fact the cook can confirm, never a FAIL. A settled step
 * technique still decides for its uses.
 */
function useTechnique(f: Facts, u: IngredientUse, s: Step, t: Id): Tri {
  if (u.technique) return u.technique.techniqueId !== t ? 'FAIL' : settled(u.technique.prov) ? 'PASS' : 'UNKNOWN';
  if (s.technique && !settled(s.technique.prov) && s.technique.techniqueId !== t) {
    f.missing.push({ subject: { kind: 'USE', id: u.useId }, predicate: 'TECHNIQUE', expected: t, have: `${s.technique.techniqueId} for the step (${s.technique.prov.status})`, minStatus: 'CONFIRMED', who: 'COOK' });
    return 'ABSENT';
  }
  return technique(f, s, t);
}
function inClass(f: Facts, ing: Ingredient, c: Id): Tri {
  const miss = (have: string | null) => f.missing.push({ subject: { kind: 'INGREDIENT', id: ing.ingredientId }, predicate: 'KIND_CLASS', expected: c, have, minStatus: 'CONFIRMED', who: 'COOK' });
  if (!ing.kind) { miss(null); return 'ABSENT'; }
  if (!classesOfKind(f.vocab, ing.kind.kindId).includes(c)) return 'FAIL';
  if (ingredientInClass(f.vocab, ing, c) === 'PASS') return 'PASS';
  miss(ing.kind.prov.status);
  return 'UNKNOWN';
}
function exactAmount(f: Facts, subject: { kind: 'USE' | 'INGREDIENT'; id: Id }, a: IngredientUse['amount'], prov: Provenance, unit: Unit): Rational | null {
  if (a.kind === 'EXACT' && a.unit === unit && atLeast(prov, 'CONFIRMED')) return a.value;
  f.missing.push({ subject, predicate: 'AMOUNT_EXACT', expected: `exact amount in ${unit}`, have: a.kind === 'EXACT' ? `${a.unit}, ${prov.status}` : a.kind, minStatus: 'CONFIRMED', who: 'COOK' });
  return null;
}
/** An ingredient's listed total. One that an accepted change put in a cooking session's recipe (2026-10-11) has no ingredient-list
 *  line: its total is the exact amounts that change stated for it (every one exact in `unit`; an "only if needed" extra is never
 *  part of a total). Original ingredients: their listed amount, as before. */
function listedTotal(f: Facts, ing: Ingredient, unit: Unit): Rational | null {
  if (!ing.origin || ing.listed.kind !== 'UNSPECIFIED') return exactAmount(f, { kind: 'INGREDIENT', id: ing.ingredientId }, ing.listed, ing.listedProv, unit);
  const adds = f.recipe.uses.filter((u) => u.ingredientId === ing.ingredientId && u.kind === 'ADD');
  let total: Rational | null = adds.length ? { n: 0, d: 1 } : null;
  for (const u of adds) { const x = exactAmount(f, { kind: 'USE', id: u.useId }, u.amount, u.amountProv, unit); total = x && total ? add(total, x) : null; }
  return total;
}
/** `anchor`: the ingredient kind must be proposed or reviewed (targets), so silence alone never makes a use a target. */
function matchUse(f: Facts, u: IngredientUse, cls: Id, fns: Id[], tech: Id | null, anchor = false): Tri {
  if (u.kind !== 'ADD') return 'FAIL';
  const ing = getIngredient(f.recipe, u.ingredientId)!, step = getStep(f.recipe, u.stepId)!;
  const sub: Facts = { ...f, missing: [] };
  const k = inClass(sub, ing, cls);
  if (anchor && k === 'ABSENT') return 'FAIL';
  const t = all([k, ...fns.map((fn) => performs(sub, u, fn)), ...(tech ? [useTechnique(sub, u, step, tech)] : [])]);
  if (t !== 'FAIL') f.missing.push(...sub.missing);
  return t;
}

interface Ctx { target: IngredientUse; slots: Record<Id, Id> }        // slot name → step or use id
function resolveRef(ref: string, ctx: Ctx, r: Recipe): { kind: 'USE' | 'STEP'; id: Id } {
  const [name, sub] = ref.replace(/^\$/, '').split('.');
  const id = name === 'target' ? ctx.target.useId : ctx.slots[name];
  if (!id) throw new Error(`unbound slot ${ref}`);
  if (getUse(r, id)) return sub === 'step' ? { kind: 'STEP', id: getUse(r, id)!.stepId } : { kind: 'USE', id };
  return { kind: 'STEP', id };
}
const stepRef = (ref: string, ctx: Ctx, r: Recipe) => { const x = resolveRef(ref, ctx, r); if (x.kind !== 'STEP') throw new Error(`${ref} is not a step`); return x.id; };
const useRef = (ref: string, ctx: Ctx, r: Recipe) => { const x = resolveRef(ref, ctx, r); if (x.kind !== 'USE') throw new Error(`${ref} is not a use`); return getUse(r, x.id)!; };

const capture = (f: Facts, fn: (g: Facts) => Tri) => { const g: Facts = { ...f, missing: [] }; const tri = fn(g); return { tri, missing: g.missing }; };

function predicate(f: Facts, p: Predicate, ctx: Ctx): Tri {
  if (p.kind === 'AMOUNT_IN_RANGE') {
    const u = useRef(p.slot, ctx, f.recipe);
    const v = exactAmount(f, { kind: 'USE', id: u.useId }, u.amount, u.amountProv, p.unit);
    return v === null ? 'UNKNOWN' : cmp(v, p.min) >= 0 && cmp(v, p.max) <= 0 ? 'PASS' : 'FAIL';
  }
  if (p.kind === 'USE_PERFORMS') return performs(f, useRef(p.slot, ctx, f.recipe), p.functionId);
  if (p.kind === 'RECIPE_HAS_USE_OF_CLASS') { const has = hasClass(f, p.classId, ctx); return has === null ? 'UNKNOWN' : has === p.expect ? 'PASS' : 'FAIL'; }
  if (p.kind === 'NO_HOLD_BETWEEN') return noHold(f, p, ctx);
  if (p.kind === 'STEP_TEXT_MATCHES') {
    const from = stepOrder(f.recipe, stepRef(p.slot, ctx, f.recipe));
    const texts = p.wholeRecipe ? [...f.recipe.steps.map((s) => renderStep(f.recipe, s)), ...f.recipe.ingredients.filter((i) => i.ingredientId !== ctx.target.ingredientId).map((i) => i.sourceLine ?? i.name)]
      : f.recipe.steps.slice(from - 1, p.andLater ? undefined : from).map((s) => renderStep(f.recipe, s));
    return texts.some((t) => p.cues.some((c) => new RegExp(c, 'i').test(t))) ? 'PASS' : 'FAIL';
  }
  return technique(f, getStep(f.recipe, stepRef(p.slot, ctx, f.recipe))!, p.techniqueId);
}

/** G1: does any ingredient other than the target's belong to the class? Every listed ingredient counts, used or not (a use
 *  the reading never placed is still in the recipe). null: some ingredient's kind isn't REVIEWED, so absence is unknown. */
function hasClass(f: Facts, classId: Id, ctx: Ctx): boolean | null {
  let unknown = false;
  for (const ing of f.recipe.ingredients.filter((i) => i.ingredientId !== ctx.target.ingredientId)) {
    if (ing.kind && settled(ing.kind.prov)) { if (classesOfKind(f.vocab, ing.kind.kindId).includes(classId)) return true; continue; }
    unknown = true;   // a proposed or missing kind is never evidence of absence
    f.missing.push({ subject: { kind: 'INGREDIENT', id: ing.ingredientId }, predicate: 'KIND_CLASS', expected: classId, have: ing.kind ? ing.kind.prov.status : null, minStatus: 'CONFIRMED', who: 'COOK' });
  }
  return unknown ? null : false;
}

/** A stated time ("for 30 minutes", "1–2 hours", "overnight"): before the baking step it may be a rest or a chill. */
const DURATION = /\b\d+(?:\s*[–-]\s*\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b|\bovernight\b/i;
/** G1: no rest/chill/hold from just after `from` through `to`, judged against the whole method, not only the extracted steps
 *  (closure 2026-10-08). FAIL: a hold cue in a step or in source text the reading didn't take in, or a reviewed hold
 *  technique. UNKNOWN: an imported method not shown to be fully read from `from` through `to` (a step not found in the
 *  source, or unaccounted source text between steps), a stated time before the baking step, or a step whose technique
 *  isn't REVIEWED. An owner-authored recipe's steps are its source. Never PASS on what wasn't read. */
function noHold(f: Facts, p: Extract<Predicate, { kind: 'NO_HOLD_BETWEEN' }>, ctx: Ctx): Tri {
  const a = stepOrder(f.recipe, stepRef(p.from, ctx, f.recipe)), b = stepOrder(f.recipe, stepRef(p.to, ctx, f.recipe));
  if (b <= a) return 'FAIL';
  const steps = f.recipe.steps.slice(a, b);            // orders a+1 … b
  const span = f.recipe.steps.slice(a - 1, b);         // orders a … b: every step whose wording must be found in the source
  const hold = (text: string) => p.cues.some((c) => new RegExp(c, 'i').test(text));
  if (steps.some((s) => hold(renderStep(f.recipe, s)) || hold(s.source?.gapBefore ?? ''))) return 'FAIL';   // a hold the source states blocks it
  if (steps.some((s) => s.technique && settled(s.technique.prov) && p.techniques.includes(s.technique.techniqueId))) return 'FAIL';
  const miss = (s: Step, predicate: 'SOURCE_COVERAGE' | 'TIMING' | 'TECHNIQUE', expected: string, have: string | null = null) =>
    f.missing.push({ subject: { kind: 'STEP', id: s.stepId }, predicate, expected, have, minStatus: predicate === 'TECHNIQUE' ? 'CONFIRMED' : 'REVIEWED', who: predicate === 'TECHNIQUE' ? 'COOK' : 'OWNER' });
  let unknown = false;
  if (f.recipe.source?.rights !== 'OWNER_AUTHORED') {
    for (const s of span) {
      if (!s.source) { miss(s, 'SOURCE_COVERAGE', 'NOT_ASSESSED'); unknown = true; }
      else if (!s.source.located) { miss(s, 'SOURCE_COVERAGE', s.source.gapBefore || 'NOT_FOUND'); unknown = true; }
      else if (s !== span[0] && s.source.gapBefore) { miss(s, 'SOURCE_COVERAGE', s.source.gapBefore); unknown = true; }
    }
  }
  for (const s of steps.slice(0, -1)) { const m = DURATION.exec(renderStep(f.recipe, s)); if (m) { miss(s, 'TIMING', m[0]); unknown = true; } }
  const unrecognized = steps.filter((s) => !s.technique || !settled(s.technique.prov));
  for (const s of unrecognized) miss(s, 'TECHNIQUE', s.technique?.techniqueId ?? 'UNRECOGNIZED', s.technique ? s.technique.prov.status : null);
  return unknown || unrecognized.length ? 'UNKNOWN' : 'PASS';
}

type BindResult = { binding: Binding | null; entry: CoverageEntry };

/** Re-binding against a cooking session's current recipe (2026-10-11): `baseline` is the recipe as saved (a step whose text or
 *  title differs from it was changed by an accepted change), `seed` makes the ids of uses this plan creates unique to the
 *  recipe version it is computed on (the same pattern may apply twice in one session). Absent: compile at import/save. */
export interface BindOpts { baseline?: Recipe; seed?: string }

function bindTarget(p: Pattern, patternHash: string, r: Recipe, v: Vocabulary, target: IngredientUse, targetTri: Tri, inherited: MissingFact[], o: BindOpts = {}): BindResult {
  const f: Facts = { recipe: r, vocab: v, missing: [...inherited] };
  const entry = (status: CoverageEntry['status'], failedCheck: CoverageEntry['failedCheck'] = null): BindResult =>
    ({ binding: null, entry: { patternId: p.patternId, patternVersion: p.version, patternTitle: p.title, kind: p.kind, targetUseId: target.useId, status, missing: status === 'NEEDS_FACTS' ? dedupe(f.missing) : [], failedCheck } });
  const ctx: Ctx = { target, slots: {} };
  const tOrder = stepOrder(r, target.stepId);
  let unknown = targetTri === 'UNKNOWN' || targetTri === 'ABSENT';

  for (const s of p.slots) {
    const before = f.missing.length;
    let cands: { id: Id; tri: Tri; missing?: MissingFact[] }[];
    if (s.kind === 'STEP_AFTER_TARGET' || s.kind === 'STEP_BEFORE_TARGET') {
      const tech = s.technique;
      cands = r.steps.filter((st, i) => (s.kind === 'STEP_AFTER_TARGET' ? i + 1 > tOrder : i + 1 < tOrder)).map((st) => ({ id: st.stepId, ...capture(f, (g) => technique(g, st, tech)) }));
    } else if (s.kind === 'USE_AFTER_TARGET') {
      const sel = s;
      cands = r.uses.filter((u) => stepOrder(r, u.stepId) > tOrder).map((u) => ({ id: u.useId, ...capture(f, (g) => matchUse(g, u, sel.ingredientClass, sel.performsAll, sel.stepTechnique)) }));
    } else if (s.kind === 'USE_OF_CLASS') {
      const cls = s.ingredientClass;
      cands = r.uses.filter((u) => u.useId !== target.useId && u.kind === 'ADD').map((u) => ({ id: u.useId, ...capture(f, (g) => inClass(g, getIngredient(r, u.ingredientId)!, cls)) }));
    } else throw new Error(`unknown slot kind ${(s as { kind: string }).kind}`);
    // facts were collected per candidate; keep only those of candidates we still consider
    f.missing.length = before;
    const strong = cands.filter((c) => c.tri === 'PASS' || c.tri === 'UNKNOWN');
    if (strong.length) cands = cands.filter((c) => c.tri !== 'ABSENT');           // weak (silent) candidates only when nothing agrees
    else {                                                                        // among silent ones, keep those missing the fewest facts
      const silent = (c: (typeof cands)[number]) => (c.missing ?? []).filter((m) => m.have === null).length;
      const least = Math.min(...cands.filter((c) => c.tri === 'ABSENT').map(silent));
      cands = cands.filter((c) => c.tri !== 'ABSENT' || silent(c) === least);
    }
    for (const c of cands) if (c.tri === 'UNKNOWN' || c.tri === 'ABSENT') f.missing.push(...(c.missing ?? []));
    const pass = cands.filter((c) => c.tri === 'PASS'), unk = cands.filter((c) => c.tri === 'UNKNOWN' || c.tri === 'ABSENT');
    if (pass.length > 1) return entry('AMBIGUOUS', { code: `SLOT_AMBIGUOUS:${s.slot}`, detail: pass.map((c) => c.id).join(', ') });
    if (pass.length === 1 && unk.length === 0) { ctx.slots[s.slot] = pass[0].id; f.missing.length = before; continue; }
    if (pass.length + unk.length === 0) return entry('NOT_APPLICABLE', { code: `SLOT_NONE:${s.slot}`, detail: `no ${s.kind} match` });
    unknown = true;                                         // cannot know uniqueness until facts are reviewed
    if (pass.length === 1) ctx.slots[s.slot] = pass[0].id; else if (unk.length) ctx.slots[s.slot] = unk[0].id;
  }
  const app = p.applicability.map((q) => predicate(f, q, ctx));
  if (app.includes('FAIL')) return entry('NOT_APPLICABLE', { code: 'APPLICABILITY', detail: canonicalPredicate(p.applicability[app.indexOf('FAIL')]) });
  if (unknown || app.includes('UNKNOWN') || app.includes('ABSENT')) {
    // an exception already proven on settled facts rules the pattern out whatever the waiting facts turn out to be (exceptions
    // only narrow): a leavened batter's oat-flour card answered by the leavened-dough rule, not the steam-batter one
    const before = f.missing.length;
    const out = p.exceptions.find((e) => predicate(f, e.when, ctx) === 'PASS');
    f.missing.length = before;
    if (out) return entry('NOT_APPLICABLE', { code: `EXCEPTION:${out.exceptionId}`, detail: out.reason });
    if (p.kind === 'RECOVERY') sweepRecoveryFacts(p, r, v, target, ctx, f);   // one complete requirement list, not one layer at a time
    return entry('NEEDS_FACTS');
  }
  for (const e of p.exceptions) {                          // narrow only: PASS or UNKNOWN ⇒ not bound
    const t = predicate(f, e.when, ctx);
    if (t === 'PASS') return entry('NOT_APPLICABLE', { code: `EXCEPTION:${e.exceptionId}`, detail: e.reason });
    if (t === 'UNKNOWN' || t === 'ABSENT') return entry('NEEDS_FACTS');
  }
  const factsHash = factsHashOf(r, target, ctx);
  if (p.kind === 'REFUSAL') {
    return {
      binding: {
        bindingId: bindingIdOf(p, target.useId), patternId: p.patternId, patternVersion: p.version, patternHash, patternTitle: p.title,
        kind: 'REFUSAL', targetUseId: target.useId, slots: ctx.slots, ops: [], quantities: {}, functionMap: [],
        coveredSiblingUseIds: [], uncoveredSiblingUseIds: [], consequence: null, proposal: null,
        refusal: { classes: [...p.proposal.classes].sort(), requiredFunctionLabel: p.requiredFunctionLabel, text: p.text, scopeNote: p.scopeNote, ...(p.proposal.match === 'OMISSION' ? { omission: true as const } : {}), ...(p.answer ? { answer: p.answer } : {}) },
        guards: [], quantityStatus: p.evidence.quantityStatus, factsHash,
      },
      entry: { patternId: p.patternId, patternVersion: p.version, patternTitle: p.title, kind: p.kind, targetUseId: target.useId, status: 'BOUND', missing: [], failedCheck: null },
    };
  }
  return bindRecovery(p, patternHash, r, v, target, ctx, f, factsHash, entry, o);
}

function bindRecovery(p: RecoveryPattern, patternHash: string, r: Recipe, v: Vocabulary, target: IngredientUse, ctx: Ctx, f: Facts, factsHash: string,
  entry: (s: CoverageEntry['status'], fc?: CoverageEntry['failedCheck']) => BindResult, o: BindOpts = {}): BindResult {
  // sibling uses of the same ingredient
  const siblings = r.uses.filter((u) => u.kind === 'ADD' && u.ingredientId === target.ingredientId && u.useId !== target.useId);
  const covered: { use: IngredientUse; handler: number }[] = [], uncovered: Id[] = [];
  for (const s of siblings) {
    const tris = p.siblingHandlers.map((h) => matchUse(f, s, firstClass(v, r, s), h.match.performsAll, h.match.stepTechnique));
    const hit = tris.indexOf('PASS');
    if (hit >= 0) covered.push({ use: s, handler: hit });
    else if (tris.includes('UNKNOWN') || tris.includes('ABSENT')) return entry('NEEDS_FACTS');
    else uncovered.push(s.useId);
  }
  // every use the plan rewrites must be located in its step text, or the rewrite could leave stale wording: fail closed
  // (a use named only by its group's words, "the Rub ingredients", is located: replacing it leaves those words true)
  for (const u of [target, ...covered.map((c) => c.use)]) {
    const t = getStep(r, u.stepId)!.text;
    if (!t.includes(`{use:${u.useId}}`) && !(u.groupText && t.toLowerCase().includes(u.groupText.toLowerCase()))) return entry('NOT_APPLICABLE', { code: 'USE_NOT_LOCATED_IN_TEXT', detail: u.useId });
  }
  // quantities
  const quantities: Binding['quantities'] = {};
  for (const [id, e] of Object.entries(p.quantities)) {
    let base: Rational | null = null;
    if (e.kind === 'SCALE') {
      if (typeof e.from === 'string') {
        const u = useRef(e.from, ctx, r);
        base = exactAmount(f, { kind: 'USE', id: u.useId }, u.amount, u.amountProv, e.sourceUnit);
      } else {
        if (uncovered.length) return entry('NOT_APPLICABLE', { code: 'TOTAL_BASE_REQUIRES_ALL_USES_COVERED', detail: uncovered.join(', ') });
        base = listedTotal(f, getIngredient(r, useRef(e.from.listedTotalOf, ctx, r).ingredientId)!, e.sourceUnit);
      }
    }
    const q = resolveQuantity(id, e, base);
    if (!q.ok) return q.status === 'NEEDS_BASE' ? entry('NEEDS_FACTS') : entry(q.status, { code: q.code, detail: q.detail });
    quantities[id] = { value: q.value, unit: q.unit };
  }
  // ops
  const gid = (local: Id) => `gen_${hash(o.seed ? { p: p.patternId, local, seed: o.seed } : { p: p.patternId, local }).slice(0, 10)}`;   // opaque, deterministic
  // composition (2026-10-11): a whole-step rewrite or retitle of a step an accepted change already altered would erase that change
  const changedEarlier = (stepId: Id, what: 'text' | 'title') => { const b = o.baseline && getStep(o.baseline, stepId), now = getStep(r, stepId); return !!o.baseline && (!b || !now || b[what] !== now[what]); };
  const ops: Op[] = [];
  const introduced: Record<Id, Id> = {};
  for (const intro of p.introduces) {
    const same = r.ingredients.filter((i) => i.kind?.kindId === intro.kindId);   // listed twice (two groups): no line is guessed
    const existing = same.length === 1 ? same[0] : undefined;
    introduced[intro.local] = existing ? existing.ingredientId : gid(intro.local);
  }
  const addedIngredients = new Set<Id>();
  const localUse: Record<Id, IngredientUse> = {};
  const prov: Provenance = { status: 'REVIEWED', by: 'OWNER', ref: `pattern:${p.patternId}@${p.version}` };
  const texts: Record<Id, string> = Object.fromEntries(r.steps.map((s) => [s.stepId, s.text]));
  const mkUse = (spec: Omit<NewUseSpec, 'at'>, stepId: Id, replaced: IngredientUse | null, idSuffix = ''): IngredientUse | string => {
    let ingredientId: Id;
    if ('slot' in spec.ingredient) ingredientId = useRef(spec.ingredient.slot, ctx, r).ingredientId;
    else {
      const intro = p.introduces.find((i) => i.local === (spec.ingredient as { introduce: Id }).introduce)!;
      ingredientId = introduced[intro.local];
      if (!getIngredient(r, ingredientId) && !addedIngredients.has(ingredientId)) {
        addedIngredients.add(ingredientId);
        ops.push({ op: 'ADD_INGREDIENT', ingredient: { ingredientId, name: intro.name, kind: { kindId: intro.kindId, prov }, listed: { kind: 'UNSPECIFIED' }, listedProv: prov } });
      }
    }
    let amount: IngredientUse['amount'];
    if (spec.qty === 'CARRY_AS_WRITTEN') {
      if (!replaced || replaced.amount.kind !== 'AS_WRITTEN') return 'CARRY_REQUIRES_AS_WRITTEN';
      amount = replaced.amount;
    } else {
      const q = quantities[spec.qty], e = p.quantities[spec.qty];
      const shown = e?.kind === 'SCALE' && e.display && q.unit === 'ML' ? (e.display === 'SPOONS' ? spoonText : cupText)(q.value, r.volumeSystem) : null;
      if (e?.kind === 'SCALE' && e.display && !shown) return e.display === 'SPOONS' ? 'SPOON_AMOUNT_NOT_EXPRESSIBLE' : 'CUP_AMOUNT_NOT_EXPRESSIBLE';
      const spoons = shown;
      amount = { kind: 'EXACT', value: q.value, unit: q.unit, asWritten: spoons };
    }
    let allowance: IngredientUse['allowance'] = null;
    if (spec.allowance && 'carryFrom' in spec.allowance) {   // the earlier change's "only if needed" extra, in this plan's proportion
      const from = useRef(spec.allowance.carryFrom, ctx, r).allowance;
      if (from) {
        if (amount.kind !== 'EXACT' || amount.unit !== from.unit) return 'ALLOWANCE_UNIT_MISMATCH';
        allowance = { max: mul(from.max, spec.allowance.factor), unit: from.unit, stopCondition: spec.allowance.stopCondition, ifExhausted: spec.allowance.ifExhausted };
      }
    } else if (spec.allowance) {
      const q = quantities[spec.allowance.maxQty];
      allowance = { max: q.value, unit: q.unit, stopCondition: spec.allowance.stopCondition, ifExhausted: spec.allowance.ifExhausted };
    }
    // a plan that replaces a use carrying an allowance must say what becomes of it; dropping it would undo part of the change that added it
    if (replaced?.allowance && !(spec.allowance && 'carryFrom' in spec.allowance)) return 'DROPS_EARLIER_ALLOWANCE';
    const u: IngredientUse = {
      useId: gid(spec.local) + idSuffix, ingredientId, stepId, kind: 'ADD', preparesUseId: null, amount, amountProv: prov,
      displayText: null, prepNote: spec.prepNote, functions: spec.functions.map((functionId) => ({ functionId, label: null, prov })),
      optional: false, allowance, ...(replaced?.groupText ? { groupText: replaced.groupText } : {}),
      // what the cook confirmed is done with the replaced use in this step is done with its replacement there too
      ...(replaced?.technique && replaced.stepId === stepId ? { technique: replaced.technique } : {}),
    };
    localUse[spec.local + idSuffix] = u;
    return u;
  };
  const localToken = (text: string) => text.replace(/\{(use|allowance):([^}]+)\}/g, (_m, k: string, l: string) => `{${k}:${localUse[l]?.useId ?? gid(l)}}`);
  let resume: Id | null = null;
  for (const op of p.ops) {
    if (op.op === 'REPLACE_USE' || op.op === 'ADD_USE') {
      const spec = op.op === 'REPLACE_USE' ? op.with : op.use;
      const replaced = op.op === 'REPLACE_USE' ? useRef(op.use, ctx, r) : null;
      const u = mkUse(spec, stepRef(spec.at, ctx, r), replaced);
      if (typeof u === 'string') return entry('NOT_APPLICABLE', { code: u, detail: u === 'DROPS_EARLIER_ALLOWANCE' ? replaced!.useId : spec.local });
      if (op.op === 'REPLACE_USE') {
        ops.push({ op: 'REPLACE_USE', useId: replaced!.useId, newUse: u });
        texts[u.stepId] = texts[u.stepId].replaceAll(`{use:${replaced!.useId}}`, `{use:${u.useId}}`).replaceAll(`{allowance:${replaced!.useId}}`, `{allowance:${u.useId}}`);
      } else if (typeof op.placement === 'object') {   // G6: beside another plan use, in that use's step
        const anchor = localUse[op.placement.beside], token = anchor ? `{use:${anchor.useId}}` : '';
        if (!anchor || anchor.stepId !== u.stepId || !texts[u.stepId].includes(token)) return entry('NOT_APPLICABLE', { code: 'USE_NOT_LOCATED_IN_TEXT', detail: `beside ${op.placement.beside}` });
        ops.push({ op: 'ADD_USE', newUse: u });
        texts[u.stepId] = texts[u.stepId].replace(token, `${token} ${op.placement.joiner} {use:${u.useId}}`);
        ops.push({ op: 'REPLACE_STEP_TEXT', stepId: u.stepId, text: texts[u.stepId] });
      } else {
        ops.push({ op: 'ADD_USE', newUse: u });
        if (op.placement !== 'NONE') {
          const t = texts[u.stepId];
          const joined = joinUseList(t, u.useId);
          const next = op.placement === 'JOIN_USE_LIST' && joined ? joined : `${t} Add {use:${u.useId}}.`;
          ops.push({ op: 'REPLACE_STEP_TEXT', stepId: u.stepId, text: next });
          texts[u.stepId] = next;
        }
      }
    } else if (op.op === 'REMOVE_USE') {
      const u = useRef(op.use, ctx, r);
      ops.push({ op: 'REMOVE_USE', useId: u.useId });
      if (op.placement === 'FROM_USE_LIST') {
        const next = dropFromUseList(texts[u.stepId], u.useId);
        if (next === null) return entry('NOT_APPLICABLE', { code: 'USE_NOT_IN_USE_LIST', detail: u.useId });
        texts[u.stepId] = next;
        ops.push({ op: 'REPLACE_STEP_TEXT', stepId: u.stepId, text: next });
      }
    } else if (op.op === 'SET_STEP_TEXT') {
      const id = stepRef(op.step, ctx, r);
      if (changedEarlier(id, 'text')) return entry('NOT_APPLICABLE', { code: 'REWRITES_EARLIER_CHANGE', detail: id });
      texts[id] = localToken(op.text);
      ops.push({ op: 'REPLACE_STEP_TEXT', stepId: id, text: texts[id] });
    } else if (op.op === 'APPEND_STEP_NOTE') {
      const id = stepRef(op.step, ctx, r);
      texts[id] = `${texts[id].trimEnd()} ${op.text}`;
      ops.push({ op: 'REPLACE_STEP_TEXT', stepId: id, text: texts[id] });
    } else if (op.op === 'SET_STEP_TITLE') {
      const title = op.title.replace(/\{classLabel:([^}]+)\}/g, (_m, l: string) => {
        const u = localUse[l]; const ing = u ? getIngredient(r, u.ingredientId) : undefined;
        return ing?.kind ? classLabel(v, classesOfKind(v, ing.kind.kindId)[0]) : l;
      });
      const id = stepRef(op.step, ctx, r);
      if (changedEarlier(id, 'title')) return entry('NOT_APPLICABLE', { code: 'REWRITES_EARLIER_CHANGE', detail: id });
      ops.push({ op: 'SET_STEP_TITLE', stepId: id, title: upperFirst(title) });
    } else if (op.op === 'SET_RESUME') {
      resume = stepRef(op.step, ctx, r);
    } else {
      // Specified but deferred ops (ESOD §4.1): fail closed for this binding only, never throw or approximate.
      return entry('NOT_APPLICABLE', { code: `UNSUPPORTED_OP:${op.op}`, detail: 'operation specified but not implemented' });
    }
  }
  covered.forEach(({ use, handler }, i) => {
    const h = p.siblingHandlers[handler];
    const u = mkUse(h.replaceWith, use.stepId, use, covered.length > 1 ? `.${i + 1}` : '');
    if (typeof u === 'string') throw new SiblingError(u);
    ops.push({ op: 'REPLACE_USE', useId: use.useId, newUse: u });
  });
  if (resume) ops.push({ op: 'SET_RESUME', stepId: resume });
  // function map
  const functionMap: FunctionMapEntry[] = [];
  for (const d of p.functionAccounting) {
    const froms = typeof d.from === 'string' ? [useRef(d.from, ctx, r)] : covered.filter((c) => c.handler === (d.from as { sibling: number }).sibling).map((c) => c.use);
    froms.forEach((from) => {
      const idx = covered.findIndex((c) => c.use.useId === from.useId);
      const toLocal = d.to === null ? null : d.to + (typeof d.from !== 'string' && covered.length > 1 ? `.${idx + 1}` : '');
      functionMap.push({ fromUseId: from.useId, functionId: d.functionId, disposition: d.disposition, toUseId: toLocal === null ? null : localUse[toLocal]?.useId ?? gid(toLocal) });
    });
  }
  for (const i of p.introducedFunctions) functionMap.push({ fromUseId: null, functionId: i.functionId, disposition: 'INTRODUCED', toUseId: localUse[i.local]?.useId ?? gid(i.local) });

  const binding: Binding = {
    bindingId: bindingIdOf(p, target.useId), patternId: p.patternId, patternVersion: p.version, patternHash, patternTitle: p.title,
    kind: 'RECOVERY', targetUseId: target.useId, slots: ctx.slots, ops, quantities, functionMap,
    coveredSiblingUseIds: covered.map((c) => c.use.useId), uncoveredSiblingUseIds: uncovered,
    consequence: p.consequence, proposal: p.proposal, refusal: null,
    guards: p.guards.map((g) => ({ kind: 'CURRENT_STEP_IS' as const, stepId: stepRef(g.step, ctx, r) })),
    quantityStatus: p.evidence.quantityStatus, factsHash,
  };
  const dry = dryRun(binding, r, v);
  if (dry) return entry('DRY_RUN_FAILED', { code: 'DRY_RUN_FAILED', detail: dry });
  return { binding, entry: { patternId: p.patternId, patternVersion: p.version, patternTitle: p.title, kind: p.kind, targetUseId: target.useId, status: 'BOUND', missing: [], failedCheck: null } };
}
class SiblingError extends Error {}

/** Collect (without deciding) the sibling-use and quantity-base facts a recovery binding would read. */
function sweepRecoveryFacts(p: RecoveryPattern, r: Recipe, v: Vocabulary, target: IngredientUse, ctx: Ctx, f: Facts) {
  const siblings = r.uses.filter((u) => u.kind === 'ADD' && u.ingredientId === target.ingredientId && u.useId !== target.useId);
  for (const s of siblings) for (const h of p.siblingHandlers) matchUse(f, s, firstClass(v, r, s), h.match.performsAll, h.match.stepTechnique);
  for (const e of Object.values(p.quantities)) {
    if (e.kind !== 'SCALE') continue;
    try {
      if (typeof e.from === 'string') { const u = useRef(e.from, ctx, r); exactAmount(f, { kind: 'USE', id: u.useId }, u.amount, u.amountProv, e.sourceUnit); }
      else listedTotal(f, getIngredient(r, useRef(e.from.listedTotalOf, ctx, r).ingredientId)!, e.sourceUnit);
    } catch { /* slot not bound yet: its own fact is already listed */ }
  }
}
const dedupe = (ms: MissingFact[]) => [...new Map(ms.map((m) => [`${m.subject.kind}:${m.subject.id}:${m.predicate}:${m.expected}`, m])).values()];

const firstClass = (v: Vocabulary, r: Recipe, u: IngredientUse) => {
  const k = getIngredient(r, u.ingredientId)?.kind?.kindId;
  return k ? classesOfKind(v, k)[0] ?? '' : '';
};
const canonicalPredicate = (p: Predicate) => JSON.stringify(p);

/** Insert {use:id} into the first sentence that lists ≥2 use tokens ("A and B" → "A, B and C"). */
export function joinUseList(text: string, useId: Id): string | null {
  const re = /(\{use:[^}]+\}(?:, \{use:[^}]+\})*) and (\{use:[^}]+\})/;
  return re.test(text) ? text.replace(re, `$1, $2 and {use:${useId}}`) : null;
}

/** Take {use:id} out of the use list it sits in ("A, B and C" → "A and B"; "A and B" → "A"); null when it isn't in one. */
export function dropFromUseList(text: string, useId: Id): string | null {
  const t = `\\{use:${useId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, U = '\\{use:[^}]+\\}';
  const tries: [RegExp, string][] = [
    [new RegExp(`(${U}(?:, ${U})*), (${U}) and ${t}`), '$1 and $2'],   // last of three or more
    [new RegExp(`(${U}) and ${t}`), '$1'],                              // last of two
    [new RegExp(`${t} and (${U})`), '$1'],                              // first of two
    [new RegExp(`${t}, `), ''],                                         // first or middle of three or more
  ];
  for (const [re, to] of tries) if (re.test(text)) return text.replace(re, to);
  return null;
}

/** Evaluate the binding at its minimal eligible state with every availability answered ENOUGH. */
/** The binding evaluated at its guard step with nothing else progressed: the build-time dry run, and the import preview. */
export function previewBinding(b: Binding, r: Recipe, v: Vocabulary) {
  const guardStep = b.guards[0]?.stepId ?? getUse(r, b.targetUseId)!.stepId;
  const g = stepOrder(r, guardStep);
  const snap: RunSnapshot = {
    runId: 'dry-run', epoch: 0, packHash: 'dry-run', mode: 'ENGINEERING', revision: 0, version: 1, appliedRescueCount: 0, recipe: r,
    stepStatus: Object.fromEntries(r.steps.map((s, i) => [s.stepId, i + 1 < g ? 'COMPLETED' : 'NOT_STARTED'])),
    // uncovered siblings are a per-request matter (AFFECTED_USE_UNACCOUNTED at runtime), so the dry run treats them as history
    useStatus: Object.fromEntries(r.uses.map((u) => [u.useId, stepOrder(r, u.stepId) < g || b.uncoveredSiblingUseIds.includes(u.useId) ? 'ADDED' : 'UNADDED'])),
  };
  return { snap, out: evaluateBinding(b, snap, v, 'ASSUME_ENOUGH', 'dry-run') };
}

export function dryRun(b: Binding, r: Recipe, v: Vocabulary): string | null {
  const { out } = previewBinding(b, r, v);
  return out.status === 'ELIGIBLE' ? null : `${out.status}:${out.refusalCode ?? ''} ${out.checks.filter((c) => c.result !== 'PASS').map((c) => c.detail).join('; ')}`;
}

export interface CompileResult { pack: RecipePack | null; errors: string[] }

const sortPatterns = (ps: Pattern[]) => [...ps].sort((a, b) => (a.patternId + a.version).localeCompare(b.patternId + b.version));
export const patternSetHashOf = (ps: Pattern[]) => hash(sortPatterns(ps).map((p) => hash(p)));

/** `releaseId`: the knowledge release vocab and patterns came from; recorded on the pack and part of its hash. */
export function compile(recipe: Recipe, vocab: Vocabulary, patterns: Pattern[], o: { releaseId?: string } = {}): CompileResult {
  const errors = validateStructure(recipe, vocab);
  if (errors.length) return { pack: null, errors };
  const sorted = sortPatterns(patterns);
  const { bindings: kept, coverage, warnings } = bindPatterns(recipe, vocab, sorted, null, {});
  const recipeHash = hash(recipe), vocabularyHash = hash(vocab);
  const patternSetHash = hash(sorted.map((p) => hash(p)));
  const packHash = hash({ recipeHash, vocabularyHash, patternSetHash, engineSemantics: ENGINE_SEMANTICS, ...(o.releaseId ? { knowledgeReleaseId: o.releaseId } : {}) });
  return { pack: { schema: 'cc-pack/1', packHash, engineSemantics: ENGINE_SEMANTICS, recipe, recipeHash, vocabularyHash, patternSetHash, bindings: kept, coverage, warnings, ...(o.releaseId ? { knowledgeReleaseId: o.releaseId } : {}) }, errors: [] };
}

/**
 * Successive changes (2026-10-11): the reviewed patterns of a pinned release bound against a cooking session's CURRENT recipe,
 * for one target use only. Bounded: each pattern once, one target, no recursion, no model. Quantities are computed from the
 * current amounts (never reused from the recipe as saved); a whole-step rewrite of a step an accepted change altered, or
 * dropping an earlier change's allowance, is NOT_APPLICABLE (REWRITES_EARLIER_CHANGE / DROPS_EARLIER_ALLOWANCE).
 */
export function rebind(recipe: Recipe, vocab: Vocabulary, patterns: Pattern[], targetUseId: Id, o: Required<BindOpts>): { bindings: Binding[]; coverage: CoverageEntry[]; errors: string[] } {
  const errors = validateStructure(recipe, vocab);
  if (errors.length) return { bindings: [], coverage: [], errors };
  const { bindings, coverage } = bindPatterns(recipe, vocab, sortPatterns(patterns), targetUseId, o);
  return { bindings, coverage, errors: [] };
}

function bindPatterns(recipe: Recipe, vocab: Vocabulary, sorted: Pattern[], only: Id | null, o: BindOpts): { bindings: Binding[]; coverage: CoverageEntry[]; warnings: string[] } {
  const bindings: Binding[] = [], coverage: CoverageEntry[] = [], warnings: string[] = [];
  for (const p of sorted) {
    const patternHash = hash(p);
    const probe: Facts = { recipe, vocab, missing: [] };
    const targets = recipe.uses.filter((u) => only === null || u.useId === only).map((u) => {
      const before = probe.missing.length;
      const tri = matchUse(probe, u, p.target.ingredientClass, p.target.performsAll, p.target.stepTechnique, true);
      return { u, tri, missing: probe.missing.slice(before) };
    }).filter((t) => t.tri !== 'FAIL');
    if (!targets.length) {
      coverage.push({ patternId: p.patternId, patternVersion: p.version, patternTitle: p.title, kind: p.kind, targetUseId: null, status: 'NOT_APPLICABLE', missing: [], failedCheck: { code: 'NO_TARGET', detail: 'no use matches the target selector' } });
      continue;
    }
    for (const t of targets) {
      let res: BindResult;
      try { res = bindTarget(p, patternHash, recipe, vocab, t.u, t.tri, t.missing, o); }
      catch (e) {
        if (!(e instanceof SiblingError)) throw e;
        res = { binding: null, entry: { patternId: p.patternId, patternVersion: p.version, patternTitle: p.title, kind: p.kind, targetUseId: t.u.useId, status: 'NOT_APPLICABLE', missing: [], failedCheck: { code: e.message, detail: 'sibling handler' } } };
      }
      coverage.push(res.entry);
      if (res.binding) bindings.push(res.binding);
    }
  }
  // realize/refuse conflicts are binding-scoped (SYN-F)
  for (const ref of bindings.filter((b) => b.kind === 'REFUSAL')) {
    for (const rec of bindings.filter((b) => b.kind === 'RECOVERY' && !ref.refusal!.omission && b.targetUseId === ref.targetUseId && b.proposal && sameSet(b.proposal.classes, ref.refusal!.classes))) {
      for (const b of [ref, rec]) {
        const e = coverage.find((c) => c.targetUseId === b.targetUseId && c.patternId === b.patternId)!;
        e.status = 'CONFLICT'; e.failedCheck = { code: 'CONTRADICTORY_PROPOSAL_CLAIMS', detail: `${ref.bindingId} vs ${rec.bindingId}` };
      }
    }
  }
  const conflicted = new Set(coverage.filter((c) => c.status === 'CONFLICT').map((c) => `${c.patternId}|${c.targetUseId}`));
  const kept = bindings.filter((b) => !conflicted.has(`${b.patternId}|${b.targetUseId}`));
  for (const use of new Set(kept.map((b) => b.targetUseId))) {
    for (const kind of ['RECOVERY', 'REFUSAL'] as const) {
      const n = kept.filter((b) => b.targetUseId === use && b.kind === kind).length;
      if (n > MAX_PER_TARGET) throw new Error(`more than ${MAX_PER_TARGET} ${kind} bindings on ${use}`);
      if (kind === 'RECOVERY' && n > 1) warnings.push(`MULTIPLE_RECOVERIES:${use} (${n}) — the client must render an explicit picker`);
    }
  }
  return { bindings: kept, coverage, warnings };
}

