// Import-time swap cards (owner 2026-10-02): the model plans every ADD use once at import; code validates each card and
// fails closed (a failed card is "we couldn't work out a swap for this one", never half a plan); valid cards compile into
// ordinary bindings that go through the same dry run and runtime checks as reviewed patterns. Reviewed patterns stay a
// cross-check: where one binds a use, its plan is used and the card is only recorded (with any disagreement).
import { z } from 'zod';
import type { Amount, Binding, CardEntry, CardSource, CoverageEntry, FunctionMapEntry, Id, IngredientUse, Op, Pattern, Provenance, Recipe, RecipePack, Vocabulary } from '../contract/types.ts';
import { cmp, hash, mul, rat } from '../domain/rational.ts';
import { amountDisplay, getIngredient, getStep, getUse, lowerFirst, parseAmount, proseLint, renderStep, stepOrder, upperFirst, useLabel } from '../domain/recipe.ts';
import { bareName, classesOfKind, kindByName, kindNames, kindOf, normName, sameSet } from '../domain/vocabulary.ts';
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
/** `plans`: a use's validated plans, best first (ccmcp-swaps-3 ranks up to three; a later one is only a fallback). */
export interface CheckedCards { plans: Map<Id, CardPlan[]>; entries: CardEntry[] }
export const MAX_CARDS_PER_USE = 3;

// ---------- validation (deterministic; every failure names its reason) ----------
const NUM = /\d+(?:[.,/]\d+)?|[½¼¾⅓⅔]/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Suggesting something (beyond the card's own swap) is never the opinion's to do; saying there is no alternative is fine.
const SUGGEST = String.raw`\b(?:try|could use|you could|use some|could also|or use|a good alternative|alternatives? (?:is|are|would|could))\b`;
const ALT_NO = new RegExp(`${SUGGEST}|\\b(?:in place of|rather than)\\b|\\buse\\b[^.;]{0,40}\\binstead\\b|\\binstead,? use\\b`, 'i');
const ALT_SWAP = new RegExp(SUGGEST, 'i');   // a swap's own opinion may say "instead of" or "in place of"
const SAME = /(?<!not |n't )\b(identical|equivalent)\b|\b(exactly the same|no difference|just as good|won'?t notice|same result|works just as well)\b/i;
const ARTICLE = /^(?:the|a|an)\s+/i;
const norm = normName, bare = bareName, namesOf = kindNames;   // identity lives in domain/vocabulary.ts (one rule for cards and readings)

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
  // identity first, the most basic defect: a kind the card asserts must be the kind it names ("chicken stock" tagged as the
  // vegetable stock, "baking soda" tagged as baking powder); a replacement that resolves to the replaced ingredient isn't a swap
  if (c.swap) {
    for (const x of [c.swap, ...c.swap.otherIngredients]) {
      const k = x.kindId ? kindOf(v, x.kindId) : undefined;
      if (k && !namesOf(k).includes(bare(x.ingredient))) fail(`KIND_MISMATCH: "${x.ingredient.trim()}" isn't ${k.label}`);
    }
    if (existingIngredient(r, { name: c.swap.ingredient.trim(), kindId: c.swap.kindId }, v)?.ingredientId === ing.ingredientId) fail(`SWAP_IS_SAME_INGREDIENT: ${c.swap.ingredient.trim()} resolves to ${ing.name}`);
  }
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
    // no stray ingredient: plain (untokenized) text names no recipe ingredient more often than the original step did
    // (live probe: "… 2 tsp baking powder and sugar." for an omitted salt; "Skip adding garlic." for an omitted garlic)
    const plainText = (t: string) => t.replace(/\{use:[^}]+\}/g, ' ').toLowerCase().replace(/[’]/g, "'");
    for (const i of r.ingredients) {
      const terms = [...new Set([bare(i.name), ...(i.kind ? [kindOf(v, i.kind.kindId)].flatMap((k) => (k ? [k.label, ...k.aliases].map(norm) : [])) : [])])].filter(Boolean).sort((x, y) => y.length - x.length);
      const re = new RegExp(`\\b(?:${terms.map(esc).join('|')})\\b`, 'g');
      if ((plainText(out).match(re)?.length ?? 0) > (plainText(getStep(r, stepId)!.text).match(re)?.length ?? 0)) fail(`REWRITE_EXTRA_INGREDIENT: step ${stepOrder(r, stepId)} names ${lowerFirst(i.name)} again`);
    }
    plan.texts[stepId] = out;
  }
  if ((c.verdict === 'omit' || plan.others.length) && plan.texts[target.stepId] === undefined) fail(`REWRITE_REQUIRED: step ${stepOrder(r, target.stepId)}`);
  for (const u of [target, ...plan.covered.map((id) => getUse(r, id)!)]) {   // a use changed without a rewrite must be a token in its step
    if (plan.texts[u.stepId] === undefined && !getStep(r, u.stepId)!.text.includes(`{use:${u.useId}}`)) fail(`USE_NOT_LOCATED_IN_TEXT: step ${stepOrder(r, u.stepId)}`);
  }
  return plan;
}

/**
 * Deterministic repairs whose meaning is unambiguous; everything else still fails validation. The raw card is never changed
 * (it stays in swap_analyses); each repair is named on the card's entry.
 * - `swap` absent on a "no" or "omit" card: the prompt says null there, and the verdict already says there is no swap.
 * - the card's own use listed as a sibling it covers: siblings are the ingredient's OTHER uses; covering itself adds nothing.
 * - a use of a different ingredient listed as "unchanged": the plan touches only this ingredient, so it stays as written anyway.
 * A self-sibling marked unchanged/cantCover, or another ingredient marked coveredBy/cantCover, contradicts the card: not repaired.
 */
function normalize(raw: unknown, refs: Refs, r: Recipe): { card: unknown; notes: string[] } {
  if (!raw || typeof raw !== 'object') return { card: raw, notes: [] };
  const c = structuredClone(raw) as Record<string, unknown> & { siblings?: { useRef?: unknown; handling?: unknown }[] };
  const notes: string[] = [];
  if (!('swap' in c) && (c.verdict === 'no' || c.verdict === 'omit')) { c.swap = null; notes.push(`absent swap read as null ("${c.verdict}" card)`); }
  const self = typeof c.useRef === 'string' ? getUse(r, refs.uses[c.useRef]) : undefined;
  if (self && Array.isArray(c.siblings)) {
    c.siblings = c.siblings.filter((x) => {
      const u = typeof x?.useRef === 'string' ? getUse(r, refs.uses[x.useRef]) : undefined;
      if (u === self && x.handling === 'coveredBy') { notes.push(`own use ${String(x.useRef)} dropped from its siblings`); return false; }
      if (u && u.ingredientId !== self.ingredientId && x.handling === 'unchanged') { notes.push(`${String(x.useRef)} (another ingredient, "unchanged") dropped from the siblings`); return false; }
      return true;
    });
  }
  return { card: c, notes };
}

/** The one correction round's record (swap_repairs): which uses were sent, why, and what came back. */
export interface RepairRound { status: string; requested: { useRef: string; reason: string }[]; raw: unknown }
const cardList = (raw: unknown): unknown[] | null => (raw && typeof raw === 'object' && Array.isArray((raw as { cards?: unknown }).cards) ? (raw as { cards: unknown[] }).cards : null);

/** Validate the model's cards against this recipe. Every ADD use gets an entry; `failure` (no analysis) fails them all.
 *  A use sent to the correction round is judged by its corrected card, through the same checks, when exactly one came back. */
export function checkCards(raw: unknown, refs: Refs | null, r: Recipe, v: Vocabulary, failure: string | null, repair: RepairRound | null = null): CheckedCards {
  const adds = r.uses.filter((u) => u.kind === 'ADD');
  const plans = new Map<Id, CardPlan[]>();
  const tried = new Map<Id, { name: string; reason: string | null }[]>();
  const reasons = new Map<Id, string>();
  const verdicts = new Map<Id, { verdict: CardEntry['verdict']; role: string | null; opinion: string | null }>();
  const list = !failure && refs ? cardList(raw) : null;
  if (!list) for (const u of adds) reasons.set(u.useId, failure ?? 'SCHEMA: no card list');
  const schema = cardSchema(v).card;
  const byUse = new Map<Id, unknown[]>();
  const normalized = new Map<Id, string[]>();
  const rounds = new Map<Id, NonNullable<CardEntry['repair']>>();
  const byRef = (cs: unknown[] | null) => {
    const m = new Map<Id, unknown[]>();
    for (const c of cs ?? []) {
      const ref = (c as { useRef?: unknown } | null)?.useRef;
      const id = typeof ref === 'string' ? refs!.uses[ref] : undefined;
      if (id) m.set(id, [...(m.get(id) ?? []), c]);
    }
    return m;
  };
  for (const [k, x] of byRef(list)) byUse.set(k, x);
  const again = repair?.status === 'SUCCEEDED' ? byRef(cardList(repair.raw)) : new Map<Id, unknown[]>();
  type Verdict = { verdict: CardEntry['verdict']; role: string | null; opinion: string | null };
  type One = { plan?: CardPlan; reason?: string; notes: string[]; verdict?: Verdict };
  const single = (card: unknown): One => {
    const { card: c0, notes } = normalize(card, refs!, r);
    const parsed = schema.safeParse(c0);
    if (!parsed.success) return { reason: `SCHEMA: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, notes };
    const verdict = { verdict: parsed.data.verdict, role: parsed.data.role, opinion: parsed.data.opinion };
    try { return { plan: checkOne(parsed.data, refs!, r, v), notes, verdict }; }
    catch (e) { if (e instanceof Invalid) return { reason: e.message, notes, verdict }; throw e; }
  };
  const nameOf = (c: unknown) => { const x = c as { verdict?: unknown; swap?: { ingredient?: unknown } | null } | null;
    return typeof x?.swap?.ingredient === 'string' ? x.swap.ingredient.trim() : x?.verdict === 'omit' ? 'leaving it out' : x?.verdict === 'no' ? 'no swap' : 'a draft'; };
  // up to three ranked cards for a use, each checked on its own: the use's result is the first that passes, with every
  // suggestion and its reason kept (more than three is a malformed answer, as two cards for one use were before v3)
  const one = (cs: unknown[]): One & { plans: CardPlan[]; tries: { name: string; reason: string | null }[] } => {
    if (!cs.length) return { reason: 'NO_CARD', notes: [], plans: [], tries: [] };
    if (cs.length > MAX_CARDS_PER_USE) return { reason: 'DUPLICATE_CARD', notes: [], plans: [], tries: [] };
    const xs = cs.map(single), ok = xs.filter((x) => x.plan);
    const head = ok[0] ?? xs[0];
    return { ...head, notes: [...new Set(xs.flatMap((x) => x.notes))], verdict: head.verdict ?? xs.find((x) => x.verdict)?.verdict,
      plans: ok.map((x) => x.plan!), tries: cs.length > 1 ? cs.map((c, i) => ({ name: nameOf(c), reason: xs[i].reason ?? null })) : [] };
  };
  for (const u of list ? adds : []) {
    let x = one(byUse.get(u.useId) ?? []);
    const q = repair?.requested.find((y) => refs!.uses[y.useRef] === u.useId);
    if (q) {
      const back = again.get(u.useId) ?? [];
      if (back.length >= 1 && back.length <= MAX_CARDS_PER_USE) { x = one(back); rounds.set(u.useId, { originalReason: q.reason, outcome: x.plan ? 'REPAIRED' : 'STILL_INVALID' }); }
      else rounds.set(u.useId, { originalReason: q.reason, outcome: repair!.status === 'RUNNING' ? 'RUNNING' : repair!.status !== 'SUCCEEDED' ? 'NOT_RUN' : back.length ? 'DUPLICATE' : 'NOT_RETURNED', ...(repair!.status !== 'SUCCEEDED' && repair!.status !== 'RUNNING' ? { detail: repair!.status } : {}) });
    }
    if (x.notes.length) normalized.set(u.useId, x.notes);
    if (x.verdict) verdicts.set(u.useId, x.verdict);
    if (x.plans.length) plans.set(u.useId, x.plans); else reasons.set(u.useId, x.reason!);
    if (x.tries.length) tried.set(u.useId, x.tries);
  }
  const entries: CardEntry[] = adds.map((u) => {
    const p = plans.get(u.useId)?.[0], raw0 = verdicts.get(u.useId);
    const n = { ...(normalized.has(u.useId) ? { normalized: normalized.get(u.useId)! } : {}), ...(rounds.has(u.useId) ? { repair: rounds.get(u.useId)! } : {}),
      ...(tried.has(u.useId) ? { alternates: tried.get(u.useId)! } : {}) };
    return p ? { useId: u.useId, verdict: p.verdict, role: p.role, opinion: p.opinion, status: 'COMPILED', reason: null, ...n }
      : { useId: u.useId, verdict: raw0?.verdict ?? null, role: raw0?.role ?? null, opinion: raw0?.opinion ?? null, status: 'INVALID', reason: reasons.get(u.useId) ?? 'INVALID', ...n };
  });
  return { plans, entries };
}

// ---------- compile: card → ordinary binding ----------
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
/** The recipe ingredient a replacement is (the binding uses the same resolution): same kind, or the same name once
 *  preparation words are set aside ("cold butter" is the butter; "fresh strawberries" are the strawberries). */
const existingIngredient = (r: Recipe, x: Pick<NewIngredient, 'name' | 'kindId'>, v: Vocabulary) => {
  const k = x.kindId ?? kindByName(v, x.name)?.kindId;   // a true alias names the same ingredient ("all-purpose flour" is the plain flour)
  // the recipe ingredient's identity: a reviewed kind, else its own name, else (unconfirmed) the reading's tag
  const own = (i: Recipe['ingredients'][number]) => (i.kind?.prov.status === 'REVIEWED' ? i.kind.kindId : kindByName(v, i.name)?.kindId ?? i.kind?.kindId);
  return r.ingredients.find((i) => (k && own(i) === k) || bare(i.name) === bare(x.name));
};
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
    const existing = existingIngredient(r, x, v);
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

/** The replacement's kind: the card's kindId, else a vocabulary label or alias equal to its name (so leaving kindId out
 *  can't hide a replacement from the reviewed claims below). */
const kindFor = (v: Vocabulary, x: NewIngredient) => x.kindId ?? kindByName(v, x.name)?.kindId ?? null;

/** The pattern's target selector and $target amount range, satisfied by the facts as read (any status; for the technique,
 *  the reading's or an approved wording cue in the step text: evidence that may restrict a card, never enable a plan). */
function targetsAsRead(p: Pattern, r: Recipe, u: IngredientUse, v: Vocabulary, cues: Record<Id, string[]>): boolean {
  const kind = getIngredient(r, u.ingredientId)?.kind?.kindId;
  if (!kind || !classesOfKind(v, kind).includes(p.target.ingredientClass)) return false;
  if (!p.target.performsAll.every((f) => u.functions.some((x) => x.functionId === f))) return false;
  const step = getStep(r, u.stepId)!;
  if (step.technique?.techniqueId !== p.target.stepTechnique && !(cues[p.target.stepTechnique] ?? []).some((c) => new RegExp(c, 'i').test(renderStep(r, step)))) return false;
  return p.applicability.every((q) => q.kind !== 'AMOUNT_IN_RANGE' || q.slot !== '$target'
    || (u.amount.kind === 'EXACT' && u.amount.unit === q.unit && cmp(u.amount.value, q.min) >= 0 && cmp(u.amount.value, q.max) <= 0));
}

/**
 * A card may not realize a proposal that a reviewed pattern for a use it replaces answers otherwise (engine §6.3 matching):
 * a reviewed refusal of exactly that replacement, or a reviewed recovery whose claim ADAPTS it ("There's no one-for-one
 * lemon swap for the wine here"). The pattern counts when compile matched it to the use (BOUND, or NEEDS_FACTS: its facts
 * not yet reviewed) and its target fits the use as read, the card's own roles included: unreviewed facts may restrict a
 * card, never enable one. Live probe finding 2026-10-07 (risotto: 120 ML lemon juice for 120 ML wine, applied at the stove
 * while the reviewed wine rule waited on review).
 */
function contradiction(plan: CardPlan, pack: RecipePack, v: Vocabulary, patterns: Pattern[], cues: Record<Id, string[]>): string | null {
  const reviewedFor = (useId: Id) => pack.coverage.filter((x) => x.targetUseId === useId && (x.status === 'BOUND' || x.status === 'NEEDS_FACTS'))
    .map((e) => patterns.find((x) => x.patternId === e.patternId && x.version === e.patternVersion)).filter((p): p is Pattern => !!p && targetsAsRead(p, pack.recipe, getUse(pack.recipe, useId)!, v, cues));
  // an omission may not leave out what a reviewed rule says can't be left out (the shortcake's baking powder, live probe 2026-10-07)
  if (plan.verdict === 'omit') {
    const p = reviewedFor(plan.useId).find((x) => x.kind === 'REFUSAL' && x.proposal.match === 'OMISSION');
    return p?.kind === 'REFUSAL' ? `"${p.title}" refuses leaving it out: ${p.text}` : null;
  }
  if (plan.verdict !== 'swap') return null;
  const kinds = [plan.main!, ...plan.others].map((x) => kindFor(v, x));
  const P = [...new Set(kinds.flatMap((k) => (k ? classesOfKind(v, k) : [])))].sort();
  if (!P.length) return null;
  for (const useId of [plan.useId, ...plan.covered]) {
    for (const p of reviewedFor(useId)) {
      // on the card's own use, a weaker form of the refused replacement is refused too (milk alone for cream that must
      // whip, where milk and butter are refused); on a covered use, only the exact one here (COVERS_A_REFUSED_USE below)
      const refused = p.kind === 'REFUSAL' && p.proposal.match === 'EQUALS' && (useId === plan.useId ? within(P, p.proposal.classes) : sameSet(p.proposal.classes, P));
      if (p.kind === 'REFUSAL' && refused) return `"${p.title}" refuses this replacement: ${p.text}`;
      if (p.kind === 'RECOVERY' && p.proposal?.relation === 'ADAPTED' && P.every((c) => p.proposal!.classes.includes(c))) return `"${p.title}" answers this replacement differently: ${p.proposal.text}`;
    }
  }
  return null;
}

/** P is the refused replacement or a part of it (non-empty). */
const within = (P: Id[], refused: Id[]) => P.length > 0 && P.every((c) => refused.includes(c));
/** The classes a card's replacement realizes ([] when any of its kinds is unknown). */
const classesOf = (plan: CardPlan, v: Vocabulary) => {
  const kinds = plan.verdict === 'swap' ? [plan.main!, ...plan.others].map((x) => kindFor(v, x)) : [];
  return kinds.length && kinds.every(Boolean) ? [...new Set(kinds.flatMap((k) => classesOfKind(v, k!)))].sort() : [];
};

/** Add card bindings to a compiled pack. A reviewed recovery wins its use; a reviewed refusal answers only the replacement
 *  it names (G13, commission 2026-10-08): its presence never hides an unrelated card plan, and no card contradicts it. */
export function addCards(pack: RecipePack, checked: CheckedCards, v: Vocabulary, patterns: Pattern[] = [], cues: Record<Id, string[]> = {}): RecipePack {
  const r = pack.recipe;
  const bindings = [...pack.bindings], coverage = [...pack.coverage], warnings = [...pack.warnings];
  const entries = checked.entries.map((e) => ({ ...e, ...(e.repair ? { repair: { ...e.repair } } : {}), ...(e.alternates ? { alternates: e.alternates.map((a) => ({ ...a })) } : {}) }));
  const reject = (e: CardEntry, reason: string) => { e.status = 'INVALID'; e.reason = reason; if (e.repair?.outcome === 'REPAIRED') e.repair.outcome = 'STILL_INVALID'; };
  const cover = (e: CardEntry, title: string, status: CoverageEntry['status'], code: string | null): CoverageEntry => ({
    patternId: CARD_PATTERN, patternVersion: 1, patternTitle: title, kind: e.verdict === 'no' ? 'REFUSAL' : 'RECOVERY', targetUseId: e.useId, status, missing: [],
    failedCheck: code ? { code, detail: e.reason ?? '' } : null,
  });
  for (const e of entries) {
    const ingName = getIngredient(r, getUse(r, e.useId)!.ingredientId)!.name;
    const ranked = checked.plans.get(e.useId) ?? [];
    if (!ranked.length) { coverage.push(cover(e, `Card for the ${lowerFirst(ingName)}`, 'NOT_APPLICABLE', 'CARD_INVALID')); warnings.push(`CARD_INVALID:${e.useId}: ${e.reason}`); continue; }
    const reviewed = pack.bindings.filter((b) => b.targetUseId === e.useId);
    // only a reviewed recovery supersedes a card; a refusal of one replacement leaves other replacements (and omission) to
    // the card. An omission refusal refuses only leaving it out (checked above).
    const rec = reviewed.find((b) => b.kind === 'RECOVERY'), ref = reviewed.find((b) => b.kind === 'REFUSAL' && !b.refusal?.omission);
    // ranked plans (ccmcp-swaps-3): the first that passes is bound; each earlier one keeps the reason it didn't
    const open = e.alternates?.filter((a) => a.reason === null) ?? [];
    const failed: { reason: string; title: string; status: CoverageEntry['status'] }[] = [];
    let settled = false;
    for (const [k, plan] of ranked.entries()) {
      const no = (reason: string, title = cardTitle(plan, ingName), status: CoverageEntry['status'] = 'NOT_APPLICABLE') => { failed.push({ reason, title, status }); if (open[k]) open[k].reason = reason; };
      const against = contradiction(plan, pack, v, patterns, cues);
      if (against) { no(`CONTRADICTS_REVIEWED_RULE: ${against}`); continue; }
      if (rec) {
        e.status = 'SUPERSEDED'; e.reason = `reviewed "${rec.patternTitle}" is used; the card said ${plan.verdict} (${plan.verdict === 'swap' ? 'agrees' : 'disagrees'})`;
        coverage.push(cover(e, cardTitle(plan, ingName), 'NOT_APPLICABLE', 'CARD_SUPERSEDED'));
        warnings.push(`CARD_SUPERSEDED:${e.useId}: ${e.reason}`);
        settled = true; break;
      }
      if (ref && plan.verdict === 'no') warnings.push(`CARD_AGREES:${e.useId}: reviewed "${ref.patternTitle}" and the card both say no`);
      // a plan may not replace another use whose own answer is "no" to it: a reviewed refusal of that replacement (or a part
      // of it), or that use's own card
      const P = classesOf(plan, v);
      const refused = plan.covered.map((id) => ({ id, by: pack.bindings.find((b) => b.kind === 'REFUSAL' && !b.refusal?.omission && b.targetUseId === id && within(P, b.refusal!.classes))?.patternTitle ?? (checked.plans.get(id)?.[0]?.verdict === 'no' ? 'its own card says no' : null) })).find((x) => x.by);
      if (refused) { no(`COVERS_A_REFUSED_USE: step ${stepOrder(r, getUse(r, refused.id)!.stepId)} (${refused.by})`); continue; }
      const b = bindCard(plan, r, v);
      const dry = b.kind === 'RECOVERY' ? dryRun(b, r, v) : null;
      if (dry) { no(`DRY_RUN_FAILED: ${dry}`, b.patternTitle, 'DRY_RUN_FAILED'); continue; }
      bindings.push(b);
      coverage.push(cover(e, b.patternTitle, 'BOUND', null));
      if (open[k]) open[k].used = true;
      if (k > 0) { e.verdict = plan.verdict; e.role = plan.role; e.opinion = plan.opinion; }
      settled = true; break;
    }
    if (!settled) {
      reject(e, failed[0].reason);
      coverage.push(cover(e, failed[0].title, failed[0].status, 'CARD_INVALID')); warnings.push(`CARD_INVALID:${e.useId}: ${e.reason}`);
    }
  }
  const cardSetHash = hash({ entries, bindings: bindings.filter((b) => b.card) });
  const packHash = hash({ recipeHash: pack.recipeHash, vocabularyHash: pack.vocabularyHash, patternSetHash: pack.patternSetHash, engineSemantics: pack.engineSemantics, cardSetHash });
  return { ...pack, packHash, bindings, coverage, warnings, cards: entries, cardSetHash };
}

// ---------- the bounded correction round: what to send ----------
/** Rejections that are authority decisions (a reviewed rule said otherwise) or whole-analysis failures: never sent. */
const NOT_REPAIRABLE = /^(?:CONTRADICTS_REVIEWED_RULE|COVERS_A_REFUSED_USE|NO_ANALYSIS|STALE_ANALYSIS|FAILED_CALL|SCHEMA: no card list|LIVE_ANALYSIS_REQUIRED)/;
/** Every card the checks rejected for a reason the model can fix, unless reviewed content already decides its use. */
export function repairRequests(pack: RecipePack, refs: Refs, raw: unknown) {
  const r = pack.recipe;
  const refOf = Object.fromEntries(Object.entries(refs.uses).map(([k, id]) => [id, k])), stepRef = Object.fromEntries(Object.entries(refs.steps).map(([k, id]) => [id, k]));
  // a reviewed refusal of one replacement doesn't decide the use (G13): other drafts for it may still be corrected
  const decided = (id: Id) => pack.bindings.some((b) => !b.card && b.kind === 'RECOVERY' && (b.targetUseId === id || b.coveredSiblingUseIds.includes(id)));
  return (pack.cards ?? []).filter((e) => e.status === 'INVALID' && !NOT_REPAIRABLE.test(e.reason ?? '') && !decided(e.useId) && refOf[e.useId]).map((e) => {
    const u = getUse(r, e.useId)!;
    const sibs = r.uses.filter((x) => x.kind === 'ADD' && x.ingredientId === u.ingredientId && x.useId !== u.useId);
    return {
      useRef: refOf[e.useId], reason: e.reason!, card: cardList(raw)?.find((c) => (c as { useRef?: unknown } | null)?.useRef === refOf[e.useId]) ?? null,
      siblings: sibs.map((x) => refOf[x.useId]).filter(Boolean), steps: [...new Set([u, ...sibs].map((x) => stepRef[x.stepId]))],
    };
  });
}
