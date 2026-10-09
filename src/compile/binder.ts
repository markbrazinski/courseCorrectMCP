// Build-time binder (ESOD §5): patterns × recipe → immutable pack with per-binding status.
// No failure here except a structural recipe error affects anything beyond its own binding.
import type {
  Binding, CoverageEntry, FactStatus, FunctionMapEntry, Id, Ingredient, IngredientUse, MissingFact, NewUseSpec, Op,
  Pattern, Predicate, Provenance, Recipe, RecipePack, RecoveryPattern, RunSnapshot, Step, Unit, Vocabulary,
} from '../contract/types.ts';
import { cmp, hash, type Rational } from '../domain/rational.ts';
/** Opaque, deterministic binding (candidate) id: never readable as a rule or recipe name. */
const bindingIdOf = (p: { patternId: Id; version: number }, useId: Id): Id => `cand_${hash({ p: p.patternId, v: p.version, u: useId }).slice(0, 12)}`;

export { ENGINE_SEMANTICS };
import { getIngredient, getStep, getUse, renderStep, spoonText, stepOrder, upperFirst, validateStructure } from '../domain/recipe.ts';
import { classLabel, classesOfKind, ingredientInClass, sameSet } from '../domain/vocabulary.ts';
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
function technique(f: Facts, s: Step, t: Id): Tri {
  const miss = (have: string | null) => f.missing.push({ subject: { kind: 'STEP', id: s.stepId }, predicate: 'TECHNIQUE', expected: t, have, minStatus: 'REVIEWED', who: 'OWNER' });
  if (!s.technique) { miss(null); return 'ABSENT'; }
  if (s.technique.techniqueId !== t) return 'FAIL';
  if (atLeast(s.technique.prov, 'REVIEWED')) return 'PASS';
  miss(s.technique.prov.status);
  return 'UNKNOWN';
}
function inClass(f: Facts, ing: Ingredient, c: Id): Tri {
  const miss = (have: string | null) => f.missing.push({ subject: { kind: 'INGREDIENT', id: ing.ingredientId }, predicate: 'KIND_CLASS', expected: c, have, minStatus: 'REVIEWED', who: 'OWNER' });
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
/** `anchor`: the ingredient kind must be proposed or reviewed (targets), so silence alone never makes a use a target. */
function matchUse(f: Facts, u: IngredientUse, cls: Id, fns: Id[], tech: Id | null, anchor = false): Tri {
  if (u.kind !== 'ADD') return 'FAIL';
  const ing = getIngredient(f.recipe, u.ingredientId)!, step = getStep(f.recipe, u.stepId)!;
  const sub: Facts = { ...f, missing: [] };
  const k = inClass(sub, ing, cls);
  if (anchor && k === 'ABSENT') return 'FAIL';
  const t = all([k, ...fns.map((fn) => performs(sub, u, fn)), ...(tech ? [technique(sub, step, tech)] : [])]);
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
  return technique(f, getStep(f.recipe, stepRef(p.slot, ctx, f.recipe))!, p.techniqueId);
}

/** G1: does any ingredient other than the target's belong to the class? Every listed ingredient counts, used or not (a use
 *  the reading never placed is still in the recipe). null: some ingredient's kind isn't REVIEWED, so absence is unknown. */
function hasClass(f: Facts, classId: Id, ctx: Ctx): boolean | null {
  let unknown = false;
  for (const ing of f.recipe.ingredients.filter((i) => i.ingredientId !== ctx.target.ingredientId)) {
    if (ing.kind?.prov.status === 'REVIEWED') { if (classesOfKind(f.vocab, ing.kind.kindId).includes(classId)) return true; continue; }
    unknown = true;   // a proposed or missing kind is never evidence of absence
    f.missing.push({ subject: { kind: 'INGREDIENT', id: ing.ingredientId }, predicate: 'KIND_CLASS', expected: classId, have: ing.kind ? ing.kind.prov.status : null, minStatus: 'REVIEWED', who: 'OWNER' });
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
  if (steps.some((s) => s.technique?.prov.status === 'REVIEWED' && p.techniques.includes(s.technique.techniqueId))) return 'FAIL';
  const miss = (s: Step, predicate: 'SOURCE_COVERAGE' | 'TIMING' | 'TECHNIQUE', expected: string, have: string | null = null) =>
    f.missing.push({ subject: { kind: 'STEP', id: s.stepId }, predicate, expected, have, minStatus: 'REVIEWED', who: 'OWNER' });
  let unknown = false;
  if (f.recipe.source?.rights !== 'OWNER_AUTHORED') {
    for (const s of span) {
      if (!s.source) { miss(s, 'SOURCE_COVERAGE', 'NOT_ASSESSED'); unknown = true; }
      else if (!s.source.located) { miss(s, 'SOURCE_COVERAGE', s.source.gapBefore || 'NOT_FOUND'); unknown = true; }
      else if (s !== span[0] && s.source.gapBefore) { miss(s, 'SOURCE_COVERAGE', s.source.gapBefore); unknown = true; }
    }
  }
  for (const s of steps.slice(0, -1)) { const m = DURATION.exec(renderStep(f.recipe, s)); if (m) { miss(s, 'TIMING', m[0]); unknown = true; } }
  const unrecognized = steps.filter((s) => s.technique?.prov.status !== 'REVIEWED');
  for (const s of unrecognized) miss(s, 'TECHNIQUE', s.technique?.techniqueId ?? 'UNRECOGNIZED', s.technique ? s.technique.prov.status : null);
  return unknown || unrecognized.length ? 'UNKNOWN' : 'PASS';
}

type BindResult = { binding: Binding | null; entry: CoverageEntry };

function bindTarget(p: Pattern, patternHash: string, r: Recipe, v: Vocabulary, target: IngredientUse, targetTri: Tri, inherited: MissingFact[]): BindResult {
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
  return bindRecovery(p, patternHash, r, v, target, ctx, f, factsHash, entry);
}

function bindRecovery(p: RecoveryPattern, patternHash: string, r: Recipe, v: Vocabulary, target: IngredientUse, ctx: Ctx, f: Facts, factsHash: string,
  entry: (s: CoverageEntry['status'], fc?: CoverageEntry['failedCheck']) => BindResult): BindResult {
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
  for (const u of [target, ...covered.map((c) => c.use)]) {
    if (!getStep(r, u.stepId)!.text.includes(`{use:${u.useId}}`)) return entry('NOT_APPLICABLE', { code: 'USE_NOT_LOCATED_IN_TEXT', detail: u.useId });
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
        const ing = getIngredient(r, useRef(e.from.listedTotalOf, ctx, r).ingredientId)!;
        base = exactAmount(f, { kind: 'INGREDIENT', id: ing.ingredientId }, ing.listed, ing.listedProv, e.sourceUnit);
      }
    }
    const q = resolveQuantity(id, e, base);
    if (!q.ok) return q.status === 'NEEDS_BASE' ? entry('NEEDS_FACTS') : entry(q.status, { code: q.code, detail: q.detail });
    quantities[id] = { value: q.value, unit: q.unit };
  }
  // ops
  const gid = (local: Id) => `gen_${hash({ p: p.patternId, local }).slice(0, 10)}`;   // opaque, deterministic
  const ops: Op[] = [];
  const introduced: Record<Id, Id> = {};
  for (const intro of p.introduces) {
    const existing = r.ingredients.find((i) => i.kind?.kindId === intro.kindId);
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
      const spoons = e?.kind === 'SCALE' && e.display === 'SPOONS' && q.unit === 'ML' ? spoonText(q.value, r.volumeSystem) : null;
      if (e?.kind === 'SCALE' && e.display === 'SPOONS' && !spoons) return 'SPOON_AMOUNT_NOT_EXPRESSIBLE';
      amount = { kind: 'EXACT', value: q.value, unit: q.unit, asWritten: spoons };
    }
    let allowance: IngredientUse['allowance'] = null;
    if (spec.allowance) {
      const q = quantities[spec.allowance.maxQty];
      allowance = { max: q.value, unit: q.unit, stopCondition: spec.allowance.stopCondition, ifExhausted: spec.allowance.ifExhausted };
    }
    const u: IngredientUse = {
      useId: gid(spec.local) + idSuffix, ingredientId, stepId, kind: 'ADD', preparesUseId: null, amount, amountProv: prov,
      displayText: null, prepNote: spec.prepNote, functions: spec.functions.map((functionId) => ({ functionId, label: null, prov })),
      optional: false, allowance,
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
      if (typeof u === 'string') return entry('NOT_APPLICABLE', { code: u, detail: spec.local });
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
      ops.push({ op: 'SET_STEP_TITLE', stepId: stepRef(op.step, ctx, r), title: upperFirst(title) });
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
      else { const ing = getIngredient(r, useRef(e.from.listedTotalOf, ctx, r).ingredientId)!; exactAmount(f, { kind: 'INGREDIENT', id: ing.ingredientId }, ing.listed, ing.listedProv, e.sourceUnit); }
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

export function compile(recipe: Recipe, vocab: Vocabulary, patterns: Pattern[]): CompileResult {
  const errors = validateStructure(recipe, vocab);
  if (errors.length) return { pack: null, errors };
  const bindings: Binding[] = [], coverage: CoverageEntry[] = [], warnings: string[] = [];
  const sorted = [...patterns].sort((a, b) => (a.patternId + a.version).localeCompare(b.patternId + b.version));
  for (const p of sorted) {
    const patternHash = hash(p);
    const probe: Facts = { recipe, vocab, missing: [] };
    const targets = recipe.uses.map((u) => {
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
      try { res = bindTarget(p, patternHash, recipe, vocab, t.u, t.tri, t.missing); }
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
  const recipeHash = hash(recipe), vocabularyHash = hash(vocab);
  const patternSetHash = hash(sorted.map((p) => hash(p)));
  const packHash = hash({ recipeHash, vocabularyHash, patternSetHash, engineSemantics: ENGINE_SEMANTICS });
  return { pack: { schema: 'cc-pack/1', packHash, engineSemantics: ENGINE_SEMANTICS, recipe, recipeHash, vocabularyHash, patternSetHash, bindings: kept, coverage, warnings }, errors: [] };
}

