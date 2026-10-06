// Import-time swap cards (owner 2026-10-02): the model plans every ADD use once at import; code validates each card and
// fails closed (a failed card is "we couldn't work out a swap for this one", never half a plan); valid cards compile into
// ordinary bindings that go through the same dry run and runtime checks as reviewed patterns. Reviewed patterns stay a
// cross-check: where one binds a use, its plan is used and the card is only recorded (with any disagreement).
import { z } from 'zod';
import type { Amount, Binding, CardEntry, CardSource, CoverageEntry, FunctionMapEntry, Id, IngredientUse, Op, Provenance, Recipe, RecipePack, Vocabulary } from '../contract/types.ts';
import { cmp, hash, mul, rat } from '../domain/rational.ts';
import { amountDisplay, getIngredient, getStep, getUse, lowerFirst, parseAmount, proseLint, renderStep, stepOrder, upperFirst, useLabel } from '../domain/recipe.ts';
import { classesOfKind } from '../domain/vocabulary.ts';
import { factsHashOf } from '../engine/evaluate.ts';
import { dryRun } from './binder.ts';

/** Pattern id under which card bindings and coverage appear. Not a content id: no approved pattern carries it. */
export const CARD_PATTERN = 'import-card';
export const CARD_LABEL = 'Prepared at import (AI)';

export function cardSchema(v: Vocabulary) {
  const fns = v.functions.map((f) => f.functionId) as [string, ...string[]];
  const kinds = v.kinds.map((k) => k.kindId) as [string, ...string[]];
  const ingredient = { ingredient: z.string().min(1).max(60), kindId: z.enum(kinds).nullable(), amountText: z.string().min(1).max(40) };
  const card = z.strictObject({
    useRef: z.string().regex(/^U\d{1,3}$/), role: z.string().min(1).max(120), functions: z.array(z.enum(fns)).min(1).max(4),
    verdict: z.enum(['swap', 'omit', 'no']),
    swap: z.strictObject({ ...ingredient, otherIngredients: z.array(z.strictObject(ingredient)).max(3) }).nullable(),
    stepRewrites: z.array(z.strictObject({ stepRef: z.string().regex(/^S\d{1,3}$/), text: z.string().min(1).max(600) })).max(4),
    siblings: z.array(z.strictObject({ useRef: z.string().regex(/^U\d{1,3}$/), handling: z.enum(['coveredBy', 'unchanged', 'cantCover']), note: z.string().min(1).max(200) })).max(8),
    tradeoff: z.string().min(1).max(240).nullable(),
    opinion: z.string().min(1).max(240),
  });
  return { card, all: z.strictObject({ cards: z.array(card).max(80) }) };
}
export type RawCard = z.infer<ReturnType<typeof cardSchema>['card']>;

/** The prompt's short refs (U1…, S1…) → this recipe's opaque ids, fixed when the analysis ran. */
export interface Refs { uses: Record<string, Id>; steps: Record<string, Id> }
export const refsOf = (r: Recipe): Refs => ({
  uses: Object.fromEntries(r.uses.filter((u) => u.kind === 'ADD').map((u, i) => [`U${i + 1}`, u.useId])),
  steps: Object.fromEntries(r.steps.map((s, i) => [`S${i + 1}`, s.stepId])),
});

interface NewIngredient { name: string; kindId: Id | null; amount: Amount }
/** A validated card: everything the binding needs, with rewrites already tokenized against placeholders. */
export interface CardPlan {
  useId: Id; verdict: 'swap' | 'omit' | 'no'; role: string; functions: Id[]; opinion: string; tradeoff: string | null; hash: string;
  main: NewIngredient | null; others: NewIngredient[];
  covered: Id[]; uncovered: Id[]; notes: Record<Id, string>;
  texts: Record<Id, string>;                 // stepId → text with {use:@main} {use:@o<i>} {use:@c:<useId>} placeholders
  display: Record<string, string>;           // placeholder → the words that named it in the rewrite
}
export interface CheckedCards { plans: Map<Id, CardPlan>; entries: CardEntry[] }

// ---------- validation (deterministic; every failure names its reason) ----------
const NUM = /\d+(?:[.,/]\d+)?|[½¼¾⅓⅔]/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Suggesting something (beyond the card's own swap) is never the opinion's to do; saying there is no alternative is fine.
const SUGGEST = String.raw`\b(?:try|could use|you could|use some|could also|or use|a good alternative|alternatives? (?:is|are|would|could))\b`;
const ALT_NO = new RegExp(`${SUGGEST}|\\b(?:in place of|rather than)\\b|\\buse\\b[^.;]{0,40}\\binstead\\b|\\binstead,? use\\b`, 'i');
const ALT_SWAP = new RegExp(SUGGEST, 'i');   // a swap's own opinion may say "instead of" or "in place of"
const SAME = /(?<!not |n't )\b(identical|equivalent)\b|\b(exactly the same|no difference|just as good|won'?t notice|same result|works just as well)\b/i;
const ARTICLE = /^(?:the|a|an)\s+/i;

class Invalid extends Error {}
const fail = (reason: string): never => { throw new Invalid(reason); };

/** Amount words → amount. Qualitative words ("a little") stay as written; words with a number that don't parse fail. */
function amountOf(text: string, vol: Recipe['volumeSystem'], what: string): Amount {
  const a = parseAmount(text, vol);
  if (a.kind === 'UNSPECIFIED' || (a.kind === 'AS_WRITTEN' && (/\d|[½¼¾⅓⅔]/.test(a.text) || !a.text.trim()))) fail(`UNPARSEABLE_AMOUNT: ${what} "${text}"`);
  return a;
}
const comparable = (a: Amount) => (a.kind === 'EXACT' ? { value: a.value, dim: a.unit === 'COUNT' ? 'COUNT' : 'MASS_OR_VOLUME' } : null);   // g ≈ ML for a sanity bound only

/** [start, end) of "<amount> … <name>" (or the name alone) in a rewrite. */
function mention(text: string, amount: string | null, name: string): [number, number] | null {
  const head = esc(name.trim().split(/\s+/).pop()!.replace(/[^\p{L}\p{N}-]/gu, ''));
  const re = amount ? new RegExp(`${esc(amount)}(?![\\p{L}\\p{N}])[^.;:{}]{0,40}?\\b${head}\\w*`, 'iu') : new RegExp(`\\b${head}\\w*`, 'iu');
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

function guardText(field: string, text: string, corpus: string, v: Vocabulary, alt: RegExp | null, sameCheck: boolean) {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  for (const m of t.match(NUM) ?? []) if (!corpus.includes(m)) fail(`INVENTED_NUMBER: ${field} "${m}"`);
  const terms = new Set(v.kinds.flatMap((k) => [k.label, k.short, ...k.aliases]).map((x) => x.toLowerCase()));
  for (const term of terms) if (new RegExp(`\\b${esc(term)}\\b`).test(t) && !corpus.includes(term)) fail(`INVENTED_INGREDIENT: ${field} "${term}"`);
  const a = alt ? alt.exec(t) : null;
  if (a) fail(`SUGGESTS_ALTERNATIVE: ${field} "${a[0]}"`);
  if (sameCheck && SAME.test(t)) fail(`CLAIMS_EQUIVALENT: ${field}`);
}

function checkOne(c: RawCard, refs: Refs, r: Recipe, v: Vocabulary): CardPlan {
  const target = getUse(r, refs.uses[c.useRef])!;
  const ing = getIngredient(r, target.ingredientId)!;
  const vol = r.volumeSystem;
  const siblings = r.uses.filter((u) => u.kind === 'ADD' && u.ingredientId === target.ingredientId && u.useId !== target.useId);
  const plan: CardPlan = { useId: target.useId, verdict: c.verdict, role: c.role.trim(), functions: [...new Set(c.functions)], opinion: c.opinion.trim(), tradeoff: c.tradeoff?.trim() ?? null,
    hash: hash(c), main: null, others: [], covered: [], uncovered: [], notes: {}, texts: {}, display: {} };
  // the card's own words: what its opinion, tradeoff and notes may mention (plus the recipe and its step numbers)
  const corpus = [r.title, r.meta, ...r.ingredients.flatMap((i) => [i.name, amountDisplay(i.listed)]), ...r.steps.map((s) => renderStep(r, s)), ...r.steps.map((_s, i) => `step ${i + 1}`), c.role,
    ...(c.swap ? [c.swap.ingredient, c.swap.amountText, ...c.swap.otherIngredients.flatMap((o) => [o.ingredient, o.amountText])] : []), ...c.stepRewrites.map((x) => x.text)]
    .join(' \n ').toLowerCase().replace(/[’]/g, "'");

  if (c.verdict === 'no') {
    if (c.swap) fail('NO_WITH_SWAP');
    if (c.stepRewrites.length) fail('NO_WITH_REWRITE');
    if (!/^No\b/.test(plan.opinion)) fail('NO_MUST_START_WITH_NO');
    if (plan.opinion.split(/\s+/).length < 6) fail('NO_WITHOUT_REASON');
    guardText('opinion', plan.opinion, corpus, v, ALT_NO, false);
    return plan;
  }
  if (/^No\b/.test(plan.opinion)) fail('SWAP_OPINION_SAYS_NO');
  if (!plan.tradeoff) fail('TRADEOFF_MISSING');
  if (c.verdict === 'swap' && !c.swap) fail('SWAP_MISSING');
  if (c.verdict === 'omit' && c.swap) fail('OMIT_WITH_SWAP');
  const alt = c.verdict === 'swap' ? ALT_SWAP : ALT_NO;
  guardText('opinion', plan.opinion, corpus, v, alt, true);
  guardText('tradeoff', plan.tradeoff!, corpus, v, alt, true);

  // every other use of the same ingredient is addressed exactly once
  const seen = new Set<Id>();
  for (const s of c.siblings) {
    const id = refs.uses[s.useRef];
    if (!id || !siblings.some((u) => u.useId === id)) fail(`SIBLING_NOT_SAME_INGREDIENT: ${s.useRef}`);
    if (seen.has(id)) fail(`SIBLING_TWICE: ${s.useRef}`);
    seen.add(id);
    if (s.handling === 'coveredBy' && c.verdict === 'omit') fail(`OMIT_CANNOT_COVER: ${s.useRef}`);
    guardText(`sibling note ${s.useRef}`, s.note, corpus, v, ALT_NO, false);
    (s.handling === 'coveredBy' ? plan.covered : plan.uncovered).push(id);
    plan.notes[id] = s.note.trim();
  }
  for (const u of siblings) if (!seen.has(u.useId)) fail(`SIBLING_MISSED: step ${stepOrder(r, u.stepId)}`);

  // amounts: code parses the words; a like-for-like amount stays within 0.25–4× of the original
  const reference = target.amount.kind === 'EXACT' ? target.amount : ing.listed.kind === 'EXACT' ? ing.listed : null;
  const base = reference ? comparable(reference) : null;
  if (c.swap) {
    plan.main = { name: c.swap.ingredient.trim(), kindId: c.swap.kindId, amount: amountOf(c.swap.amountText, vol, c.swap.ingredient) };
    plan.others = c.swap.otherIngredients.map((o) => ({ name: o.ingredient.trim(), kindId: o.kindId, amount: amountOf(o.amountText, vol, o.ingredient) }));
    const m = comparable(plan.main.amount);
    if (base && m && m.dim === base.dim && (cmp(m.value, mul(base.value, rat(1, 4))) < 0 || cmp(m.value, mul(base.value, rat(4))) > 0)) fail(`AMOUNT_RATIO: ${plan.main.name} ${amountDisplay(plan.main.amount)} vs ${amountDisplay(reference!)}`);
    for (const o of plan.others) {
      const x = comparable(o.amount);
      if (base && x && x.dim === base.dim && cmp(x.value, mul(base.value, rat(4))) > 0) fail(`AMOUNT_RATIO: ${o.name} ${amountDisplay(o.amount)} vs ${amountDisplay(reference!)}`);
    }
  }

  // rewrites: only the steps the swap needs, every ingredient tokenized, no stale literal amounts
  const allowed = new Set([target.stepId, ...plan.covered.map((id) => getUse(r, id)!.stepId)]);
  for (const w of c.stepRewrites) {
    const stepId = refs.steps[w.stepRef];
    if (!stepId || !getStep(r, stepId)) fail(`REWRITE_UNKNOWN_STEP: ${w.stepRef}`);
    if (!allowed.has(stepId)) fail(`REWRITE_OUTSIDE_SWAP: step ${stepOrder(r, stepId)}`);
    if (plan.texts[stepId] !== undefined) fail(`REWRITE_TWICE: step ${stepOrder(r, stepId)}`);
    if (/[{}]/.test(w.text)) fail('REWRITE_HAS_BRACES');
    const text = w.text.trim();
    const spans: { at: [number, number]; key: string }[] = [];
    const want = (key: string, amount: string | null, name: string) => {
      const at = mention(text, amount, name);
      if (!at) fail(`REWRITE_MISSING_AMOUNT: step ${stepOrder(r, stepId)} doesn't say ${amount ? `${amount} ` : ''}${name}`);
      spans.push({ at: at!, key });
    };
    if (stepId === target.stepId && plan.main) want('@main', amountDisplay(plan.main.amount), plan.main.name);
    if (stepId === target.stepId) plan.others.forEach((o, i) => want(`@o${i}`, amountDisplay(o.amount), o.name));
    for (const id of plan.covered.filter((x) => getUse(r, x)!.stepId === stepId)) {
      const a = getUse(r, id)!.amount;
      want(`@c:${id}`, a.kind === 'EXACT' || a.kind === 'AS_WRITTEN' ? amountDisplay(a) : null, plan.main!.name);
    }
    const replaced = new Set([target.useId, ...plan.covered]);
    const original = getStep(r, stepId)!.text;   // a use the reading couldn't place in the text isn't named there now either
    for (const u of r.uses.filter((x) => x.stepId === stepId && !replaced.has(x.useId) && original.includes(`{use:${x.useId}}`))) {
      const words = [...new Set([u.displayText, u.displayText?.replace(ARTICLE, ''), useLabel(r, u)].filter((x): x is string => !!x))];
      const lower = text.toLowerCase();
      const hit = words.map((x) => [lower.indexOf(x.toLowerCase()), x.length] as const).find(([i]) => i >= 0);
      if (!hit) fail(`REWRITE_DROPS_INGREDIENT: step ${stepOrder(r, stepId)} no longer names ${useLabel(r, u)}`);
      spans.push({ at: [hit![0], hit![0] + hit![1]], key: u.useId });
    }
    spans.sort((a, b) => a.at[0] - b.at[0]);
    spans.forEach((s, i) => { if (i && s.at[0] < spans[i - 1].at[1]) fail(`REWRITE_AMBIGUOUS: step ${stepOrder(r, stepId)}`); });
    let out = text;
    for (const s of [...spans].reverse()) {
      if (s.key.startsWith('@')) plan.display[s.key] = text.slice(s.at[0], s.at[1]);
      out = `${out.slice(0, s.at[0])}{use:${s.key}}${out.slice(s.at[1])}`;
    }
    const lint = proseLint(out);
    if (lint) fail(`STALE_AMOUNT: step ${stepOrder(r, stepId)} ${lint}`);
    plan.texts[stepId] = out;
  }
  if ((c.verdict === 'omit' || plan.others.length) && plan.texts[target.stepId] === undefined) fail(`REWRITE_REQUIRED: step ${stepOrder(r, target.stepId)}`);
  for (const u of [target, ...plan.covered.map((id) => getUse(r, id)!)]) {   // a use changed without a rewrite must be a token in its step
    if (plan.texts[u.stepId] === undefined && !getStep(r, u.stepId)!.text.includes(`{use:${u.useId}}`)) fail(`USE_NOT_LOCATED_IN_TEXT: step ${stepOrder(r, u.stepId)}`);
  }
  return plan;
}

/** Validate the model's cards against this recipe. Every ADD use gets an entry; `failure` (no analysis) fails them all. */
export function checkCards(raw: unknown, refs: Refs | null, r: Recipe, v: Vocabulary, failure: string | null): CheckedCards {
  const adds = r.uses.filter((u) => u.kind === 'ADD');
  const plans = new Map<Id, CardPlan>();
  const reasons = new Map<Id, string>();
  const verdicts = new Map<Id, { verdict: CardEntry['verdict']; role: string | null; opinion: string | null }>();
  const list = !failure && refs && raw && typeof raw === 'object' && Array.isArray((raw as { cards?: unknown }).cards) ? (raw as { cards: unknown[] }).cards : null;
  if (!list) for (const u of adds) reasons.set(u.useId, failure ?? 'SCHEMA: no card list');
  const schema = cardSchema(v).card;
  const byUse = new Map<Id, unknown[]>();
  for (const c of list ?? []) {
    const ref = (c as { useRef?: unknown } | null)?.useRef;
    const id = typeof ref === 'string' ? refs!.uses[ref] : undefined;
    if (id) byUse.set(id, [...(byUse.get(id) ?? []), c]);
  }
  for (const u of list ? adds : []) {
    const cs = byUse.get(u.useId) ?? [];
    if (!cs.length) { reasons.set(u.useId, 'NO_CARD'); continue; }
    if (cs.length > 1) { reasons.set(u.useId, 'DUPLICATE_CARD'); continue; }
    const parsed = schema.safeParse(cs[0]);
    if (!parsed.success) { reasons.set(u.useId, `SCHEMA: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`); continue; }
    verdicts.set(u.useId, { verdict: parsed.data.verdict, role: parsed.data.role, opinion: parsed.data.opinion });
    try { plans.set(u.useId, checkOne(parsed.data, refs!, r, v)); }
    catch (e) { if (e instanceof Invalid) reasons.set(u.useId, e.message); else throw e; }
  }
  const entries: CardEntry[] = adds.map((u) => {
    const p = plans.get(u.useId), raw0 = verdicts.get(u.useId);
    return p ? { useId: u.useId, verdict: p.verdict, role: p.role, opinion: p.opinion, status: 'COMPILED', reason: null }
      : { useId: u.useId, verdict: raw0?.verdict ?? null, role: raw0?.role ?? null, opinion: raw0?.opinion ?? null, status: 'INVALID', reason: reasons.get(u.useId) ?? 'INVALID' };
  });
  return { plans, entries };
}

// ---------- compile: card → ordinary binding ----------
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
const label = (n: NewIngredient) => `${amountDisplay(n.amount)} ${lowerFirst(n.name)}`;

export function cardTitle(p: Pick<CardPlan, 'verdict' | 'main' | 'others'>, ingredientName: string) {
  const name = lowerFirst(ingredientName);
  if (p.verdict === 'no') return `No swap for the ${name}`;
  if (p.verdict === 'omit') return `Leave out the ${name}`;
  return `${upperFirst(and([p.main!.name, ...p.others.map((o) => o.name)].map(lowerFirst)))} for the ${name}`;
}

function bindCard(p: CardPlan, r: Recipe, v: Vocabulary): Binding {
  const target = getUse(r, p.useId)!, ing = getIngredient(r, target.ingredientId)!, n = stepOrder(r, target.stepId);
  const gid = (local: string) => `gen_${hash({ card: p.hash, local }).slice(0, 10)}`;   // opaque, deterministic
  const prov: Provenance = { status: 'PROPOSED', by: 'MODEL', ref: `card:${p.hash.slice(0, 12)}` };
  const slots: Record<Id, Id> = Object.fromEntries([...[...p.covered, ...p.uncovered].map((id, i) => [`sib${i}`, id]), ...Object.keys(p.texts).map((id, i) => [`step${i}`, id])]);
  const card: CardSource = { role: p.role, opinion: p.opinion, tradeoff: p.tradeoff, siblingNotes: p.notes };
  const common = {
    bindingId: `cand_${hash({ card: p.hash, u: p.useId }).slice(0, 12)}`, patternId: CARD_PATTERN, patternVersion: 1, patternHash: p.hash,
    patternTitle: cardTitle(p, ing.name), targetUseId: p.useId, slots, factsHash: factsHashOf(r, target, { slots }), card,
  };
  if (p.verdict === 'no') {
    return { ...common, kind: 'REFUSAL', ops: [], quantities: {}, functionMap: [], coveredSiblingUseIds: [], uncoveredSiblingUseIds: [], consequence: null, proposal: null,
      refusal: { classes: [], requiredFunctionLabel: p.role, text: p.opinion, scopeNote: `${CARD_LABEL}: an opinion, not a reviewed rule.` }, guards: [], quantityStatus: 'NONE' };
  }
  const ops: Op[] = [], functionMap: FunctionMapEntry[] = [];
  const added = new Map<string, Id>();
  const ingredientFor = (x: NewIngredient): Id => {
    const existing = r.ingredients.find((i) => (x.kindId && i.kind?.kindId === x.kindId) || i.name.toLowerCase() === x.name.toLowerCase());
    if (existing) return existing.ingredientId;
    const key = x.name.toLowerCase();
    if (!added.has(key)) {
      const id = gid(`ing:${key}`);
      added.set(key, id);
      ops.push({ op: 'ADD_INGREDIENT', ingredient: { ingredientId: id, name: upperFirst(x.name), kind: x.kindId ? { kindId: x.kindId, prov } : null, listed: { kind: 'UNSPECIFIED' }, listedProv: prov } });
    }
    return added.get(key)!;
  };
  const newUse = (key: string, x: NewIngredient, stepId: Id, amount: Amount, from: IngredientUse | null): IngredientUse => ({
    useId: gid(key), ingredientId: ingredientFor(x), stepId, kind: 'ADD', preparesUseId: null, amount, amountProv: prov,
    displayText: p.display[key] ?? null, prepNote: null, optional: false, allowance: null,
    functions: (from?.functions ?? []).map((f) => ({ functionId: f.functionId, label: f.label, prov })),
  });
  const ids: Record<string, Id> = {};
  if (p.verdict === 'swap') {
    const main = newUse('@main', p.main!, target.stepId, p.main!.amount, target);
    ids['@main'] = main.useId;
    ops.push({ op: 'REPLACE_USE', useId: target.useId, newUse: main });
    for (const f of target.functions) functionMap.push({ fromUseId: target.useId, functionId: f.functionId, disposition: 'RETAINED', toUseId: main.useId });
  } else {
    ops.push({ op: 'REMOVE_USE', useId: target.useId });
    for (const f of target.functions) functionMap.push({ fromUseId: target.useId, functionId: f.functionId, disposition: 'DROPPED_WITH_TRADEOFF', toUseId: null });
  }
  p.others.forEach((o, i) => { const u = newUse(`@o${i}`, o, target.stepId, o.amount, null); ids[`@o${i}`] = u.useId; ops.push({ op: 'ADD_USE', newUse: u }); });
  for (const id of p.covered) {
    const s = getUse(r, id)!, key = `@c:${id}`;
    const u = newUse(key, p.main!, s.stepId, s.amount, s);   // coveredBy: same replacement, the use's own amount words
    ids[key] = u.useId;
    ops.push({ op: 'REPLACE_USE', useId: id, newUse: u });
    for (const f of s.functions) functionMap.push({ fromUseId: id, functionId: f.functionId, disposition: 'RETAINED', toUseId: u.useId });
  }
  for (const [stepId, text] of Object.entries(p.texts)) ops.push({ op: 'REPLACE_STEP_TEXT', stepId, text: text.replace(/\{use:(@[^}]+)\}/g, (_m, k: string) => `{use:${ids[k]}}`) });
  ops.push({ op: 'SET_RESUME', stepId: target.stepId });
  const kinds = p.verdict === 'swap' ? [p.main!, ...p.others].map((x) => x.kindId) : [];
  const classes = kinds.length && kinds.every(Boolean) ? [...new Set(kinds.flatMap((k) => classesOfKind(v, k!)))].sort() : [];
  const name = lowerFirst(ing.name);
  const covers = p.covered.map((id) => `, and ${lowerFirst(p.main!.name)} in step ${stepOrder(r, getUse(r, id)!.stepId)}`).join('');
  return {
    ...common, kind: 'RECOVERY', ops, quantities: {}, functionMap,
    coveredSiblingUseIds: p.covered, uncoveredSiblingUseIds: p.uncovered,
    consequence: {
      outcomeClass: p.verdict === 'swap' ? 'SUBSTITUTED' : 'ALTERNATE_FINISH', equivalence: 'NOT_EQUIVALENT',
      headline: p.verdict === 'swap' ? `Use ${and([p.main!, ...p.others].map(label))} instead of the ${name} in step ${n}${covers}.` : `Leave the ${name} out of step ${n}.`,
      reason: p.opinion, tradeoff: p.tradeoff!,
    },
    proposal: classes.length ? { classes, relation: 'REALIZED_AS_PROPOSED', text: `Yes, with the change ${CARD_LABEL.toLowerCase()}.` } : null,
    refusal: null, guards: [{ kind: 'CURRENT_STEP_IS', stepId: target.stepId }], quantityStatus: 'PROVISIONAL',
  };
}

/** Add card bindings to a compiled pack. Reviewed bindings stay first and win on their use. */
export function addCards(pack: RecipePack, checked: CheckedCards, v: Vocabulary): RecipePack {
  const r = pack.recipe;
  const bindings = [...pack.bindings], coverage = [...pack.coverage], warnings = [...pack.warnings];
  const entries = checked.entries.map((e) => ({ ...e }));
  const cover = (e: CardEntry, title: string, status: CoverageEntry['status'], code: string | null): CoverageEntry => ({
    patternId: CARD_PATTERN, patternVersion: 1, patternTitle: title, kind: e.verdict === 'no' ? 'REFUSAL' : 'RECOVERY', targetUseId: e.useId, status, missing: [],
    failedCheck: code ? { code, detail: e.reason ?? '' } : null,
  });
  for (const e of entries) {
    const ingName = getIngredient(r, getUse(r, e.useId)!.ingredientId)!.name;
    const plan = checked.plans.get(e.useId);
    if (!plan) { coverage.push(cover(e, `Card for the ${lowerFirst(ingName)}`, 'NOT_APPLICABLE', 'CARD_INVALID')); warnings.push(`CARD_INVALID:${e.useId}: ${e.reason}`); continue; }
    const reviewed = pack.bindings.filter((b) => b.targetUseId === e.useId);
    const rec = reviewed.find((b) => b.kind === 'RECOVERY'), ref = reviewed.find((b) => b.kind === 'REFUSAL');
    if (rec || (ref && plan.verdict !== 'no')) {
      const agrees = rec ? plan.verdict === 'swap' : false;
      e.status = 'SUPERSEDED'; e.reason = `reviewed "${(rec ?? ref)!.patternTitle}" is used; the card said ${plan.verdict} (${agrees ? 'agrees' : 'disagrees'})`;
      coverage.push(cover(e, cardTitle(plan, ingName), 'NOT_APPLICABLE', 'CARD_SUPERSEDED'));
      warnings.push(`CARD_SUPERSEDED:${e.useId}: ${e.reason}`);
      continue;
    }
    if (ref) warnings.push(`CARD_AGREES:${e.useId}: reviewed "${ref.patternTitle}" and the card both say no`);
    // a plan may not replace a use whose own answer is "no" (a reviewed refusal, or that use's card): the refusal wins
    const refused = plan.covered.map((id) => ({ id, by: pack.bindings.find((b) => b.kind === 'REFUSAL' && b.targetUseId === id)?.patternTitle ?? (checked.plans.get(id)?.verdict === 'no' ? 'its own card says no' : null) })).find((x) => x.by);
    if (refused) {
      e.status = 'INVALID'; e.reason = `COVERS_A_REFUSED_USE: step ${stepOrder(r, getUse(r, refused.id)!.stepId)} (${refused.by})`;
      coverage.push(cover(e, cardTitle(plan, ingName), 'NOT_APPLICABLE', 'CARD_INVALID')); warnings.push(`CARD_INVALID:${e.useId}: ${e.reason}`);
      continue;
    }
    const b = bindCard(plan, r, v);
    const dry = b.kind === 'RECOVERY' ? dryRun(b, r, v) : null;
    if (dry) { e.status = 'INVALID'; e.reason = `DRY_RUN_FAILED: ${dry}`; coverage.push(cover(e, b.patternTitle, 'DRY_RUN_FAILED', 'CARD_INVALID')); warnings.push(`CARD_INVALID:${e.useId}: ${e.reason}`); continue; }
    bindings.push(b);
    coverage.push(cover(e, b.patternTitle, 'BOUND', null));
  }
  const cardSetHash = hash({ entries, bindings: bindings.filter((b) => b.card) });
  const packHash = hash({ recipeHash: pack.recipeHash, vocabularyHash: pack.vocabularyHash, patternSetHash: pack.patternSetHash, engineSemantics: pack.engineSemantics, cardSetHash });
  return { ...pack, packHash, bindings, coverage, warnings, cards: entries, cardSetHash };
}
