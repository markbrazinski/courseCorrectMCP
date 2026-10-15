// Cook confirmations at import review (commission 2026-10-13; supersedes the 2026-10-02 "no consumer confirmations" ruling for
// these two facts only). A reviewed change can wait on a fact about THIS recipe that the reading can't establish: what an
// ingredient is (a bare word for a flour isn't plain flour by approved name; a bare "soda" may be soda water) or what is done with
// it in a step (Fannie Farmer's "Mix and sift …; add sour milk" names no technique). The cook holds the recipe and can say. A question is offered
// only when "yes" would let a reviewed change apply: the facts are tried in a dry compile first, so nothing is asked that unlocks
// nothing. The reading's own guess is what is asked about (never a kind or technique no one proposed); an answer is recorded as
// CONFIRMED by COOK on the draft, and only an answer counts: a guess is never promoted. Functions still come only from the
// approved role table, quantities only from the source, and the content itself only from an owner-approved release.
import type { Id, IngredientUse, Pattern, Provenance, Recipe, RecipePack, Step, Vocabulary } from '../contract/types.ts';
import { compile } from '../compile/binder.ts';
import { hash } from '../domain/rational.ts';
import { getIngredient, getStep, getUse, lowerFirst, renderStep, stepOrder } from '../domain/recipe.ts';
import { classesOfKind, kindOf, settled } from '../domain/vocabulary.ts';

export interface CookQuestion {
  id: string;
  /** what the cook is asked, in the recipe's words; `quote` is the source wording it is about */
  prompt: string; quote: string | null;
  kind: 'identity' | 'technique';
  subject: { kind: 'INGREDIENT' | 'STEP' | 'USE'; id: Id }; predicate: 'KIND' | 'TECHNIQUE'; value: Id;
  /** the reviewed changes "yes" would let apply (with the other questions listed beside it answered yes) */
  unlocks: { patternId: Id; title: string; useId: Id }[];
}
/** A fact the cook answered: "no" is kept as { not: value } so the same question isn't asked again. */
export interface Answered { subject: { kind: string; id: Id }; predicate: string; value: unknown }

/** At most this many questions for one reviewed change (more is a review task, not a question at the stove's door). */
export const MAX_QUESTIONS_PER_CHANGE = 4;
const COOK: Provenance = { status: 'CONFIRMED', by: 'COOK', ref: 'question' };

type Hypothesis = Omit<CookQuestion, 'id' | 'prompt' | 'quote' | 'unlocks'>;
const keyOf = (h: Hypothesis) => `${h.subject.kind}|${h.subject.id}|${h.predicate}|${h.value}`;

/** Put hypothesized answers into a copy of the recipe (as the draft's fact fold would), for the dry compile. */
export function withAnswers(r: Recipe, hs: Hypothesis[]): Recipe {
  const x = structuredClone(r);
  for (const h of hs) {
    if (h.predicate === 'KIND') x.ingredients.find((i) => i.ingredientId === h.subject.id)!.kind = { kindId: h.value, prov: COOK };
    else if (h.subject.kind === 'USE') x.uses.find((u) => u.useId === h.subject.id)!.technique = { techniqueId: h.value, prov: COOK };
    else getStep(x, h.subject.id)!.technique = { techniqueId: h.value, prov: COOK };
  }
  return x;
}

/**
 * The questions for a prepared draft. For each reviewed recovery waiting on facts (NEEDS_FACTS): every missing fact must be one
 * the cook can answer, about the reading's own proposal (an ingredient's proposed kind in the class the rule needs; the
 * technique the rule needs for the target's use, or a step's proposed technique); then those answers are tried in a dry compile
 * (`reapply` = the draft's identity + role-table authority), and only if the change then binds are they asked.
 */
export function cookQuestions(a: { recipe: Recipe; pack: RecipePack; v: Vocabulary; patterns: Pattern[]; cues: Record<Id, string[]>; answered: Answered[]; reapply: (r: Recipe) => void }): CookQuestion[] {
  const { recipe: r, v } = a;
  // a step the reading gave no technique, whose own words carry an approved cue for it ("…until a soft dough forms"): asked about
  // as a step ("Does step 3 mix dough?"), so one answer serves every change that needs that step (live 2026-10-13, the scones)
  const cueFits = (t: Id, s: Step) => (a.cues[t] ?? []).some((c) => new RegExp(c, 'i').test(renderStep(r, s)));
  const no = new Set(a.answered.filter((f) => f.value && typeof f.value === 'object' && 'not' in (f.value as object)).map((f) => `${f.subject.kind}|${f.subject.id}|${f.predicate}|${(f.value as { not: Id }).not}`));
  const out = new Map<string, Hypothesis & { unlocks: CookQuestion['unlocks'] }>();
  for (const e of a.pack.coverage.filter((c) => c.status === 'NEEDS_FACTS' && c.kind === 'RECOVERY' && c.targetUseId)) {
    const p = a.patterns.find((x) => x.patternId === e.patternId && x.version === e.patternVersion);
    const target = getUse(r, e.targetUseId!);
    if (!p || !target) continue;
    const hs: Hypothesis[] = [], unnamed: Step[] = [];
    let askable = true;
    for (const m of e.missing) {
      if (m.predicate === 'FUNCTION') continue;   // from the role table once what it is and what is done are settled
      if (m.predicate === 'KIND_CLASS') {
        const ing = getIngredient(r, m.subject.id), k = ing?.kind;
        if (!k || settled(k.prov) || !classesOfKind(v, k.kindId).includes(m.expected)) { askable = false; break; }
        hs.push({ kind: 'identity', subject: { kind: 'INGREDIENT', id: ing!.ingredientId }, predicate: 'KIND', value: k.kindId });
      } else if (m.predicate === 'TECHNIQUE' && m.subject.kind === 'STEP') {
        const s = getStep(r, m.subject.id)!;
        if (m.expected === 'UNRECOGNIZED') { unnamed.push(s); continue; }   // any technique would do: settled below
        const known = v.techniques.some((t) => t.techniqueId === m.expected);
        if (known && (s.technique?.techniqueId === m.expected || (!s.technique && cueFits(m.expected, s)))) hs.push({ kind: 'technique', subject: { kind: 'STEP', id: s.stepId }, predicate: 'TECHNIQUE', value: m.expected });
        else if (m.subject.id === target.stepId && known) hs.push({ kind: 'technique', subject: { kind: 'USE', id: target.useId }, predicate: 'TECHNIQUE', value: m.expected });
        else { askable = false; break; }
      } else if (m.predicate === 'TECHNIQUE' && m.subject.kind === 'USE') {
        if (!v.techniques.some((t) => t.techniqueId === m.expected)) { askable = false; break; }
        hs.push({ kind: 'technique', subject: { kind: 'USE', id: m.subject.id }, predicate: 'TECHNIQUE', value: m.expected });
      } else { askable = false; break; }   // amounts, unread method text: the reading must change, not the cook's answer
    }
    for (const s of askable ? unnamed : []) {   // a step that must be recognized as something: its proposal, else its one fitting cue
      if (hs.some((h) => h.subject.kind === 'STEP' && h.subject.id === s.stepId)) continue;
      const fits = v.techniques.filter((t) => cueFits(t.techniqueId, s));
      const value = s.technique ? s.technique.techniqueId : fits.length === 1 ? fits[0].techniqueId : null;
      if (!value) { askable = false; break; }
      hs.push({ kind: 'technique', subject: { kind: 'STEP', id: s.stepId }, predicate: 'TECHNIQUE', value });
    }
    const unique = [...new Map(hs.map((h) => [keyOf(h), h])).values()];
    if (!askable || !unique.length || unique.length > MAX_QUESTIONS_PER_CHANGE || unique.some((h) => no.has(keyOf(h)))) continue;
    const tried = withAnswers(r, unique);
    a.reapply(tried);
    const res = compile(tried, v, [p]);
    if (!res.pack?.coverage.some((c) => c.targetUseId === target.useId && c.status === 'BOUND')) continue;
    for (const h of unique) {
      const q = out.get(keyOf(h)) ?? { ...h, unlocks: [] };
      if (!q.unlocks.some((u) => u.patternId === p.patternId && u.useId === target.useId)) q.unlocks.push({ patternId: p.patternId, title: p.title, useId: target.useId });
      out.set(keyOf(h), q);
    }
  }
  return [...out.values()].map((h) => ({ ...h, id: `q_${hash(keyOf(h)).slice(0, 12)}`, ...wording(r, v, h) }));
}

const named = (v: Vocabulary, kindId: Id) => { const k = kindOf(v, kindId)!; const other = k.aliases.find((x) => x.toLowerCase() !== k.label.toLowerCase()); return other ? `${k.label} (${other})` : k.label; };
const techLabel = (v: Vocabulary, id: Id) => v.techniques.find((t) => t.techniqueId === id)?.label ?? id;
/** The ingredient as the cook would say it: its settled kind's name, else the name as read. */
const ingName = (r: Recipe, v: Vocabulary, u: IngredientUse) => { const i = getIngredient(r, u.ingredientId); return i?.kind && settled(i.kind.prov) ? kindOf(v, i.kind.kindId)?.label ?? lowerFirst(i.name) : lowerFirst(i?.name ?? 'ingredient'); };
/** The question in the recipe's own words: never an id, an enum or a class name. */
function wording(r: Recipe, v: Vocabulary, h: Hypothesis): { prompt: string; quote: string | null } {
  if (h.predicate === 'KIND') {
    const i = getIngredient(r, h.subject.id)!;
    return { prompt: `Is the “${i.name}” in this recipe ${named(v, h.value)}?`, quote: i.sourceLine ?? null };
  }
  const s = h.subject.kind === 'USE' ? getStep(r, getUse(r, h.subject.id)!.stepId)! : getStep(r, h.subject.id)!, n = stepOrder(r, s.stepId);
  return h.subject.kind === 'USE'
    ? { prompt: `In step ${n}, is the ${ingName(r, v, getUse(r, h.subject.id)!)} used to ${techLabel(v, h.value)}?`, quote: renderStep(r, s) }
    : { prompt: `Does step ${n} ${techLabel(v, h.value)}?`, quote: renderStep(r, s) };
}
