// Recipe structure: expansion from authored content, rendering, structural invariants (ESOD §2.2).
import type { Amount, Id, IngredientUse, Provenance, Recipe, Step, StepStatus, Unit, Vocabulary } from '../contract/types.ts';
import { add, formatRational, mul, parseRational, rat, type Rational } from './rational.ts';

// ---------- amounts ----------
const TSP = { US: rat(473176473, 96000000), METRIC: rat(5) }, TBSP = { US: rat(473176473, 32000000), METRIC: rat(15) }, CUP = { US: rat(473176473, 2000000), METRIC: rat(250) };
const VOLUME_ML: Record<string, Record<'US' | 'METRIC', Rational>> = {
  tsp: TSP, teaspoon: TSP, tbsp: TBSP, tablespoon: TBSP, cup: CUP,
};
const MASS_G: Record<string, Rational> = { g: rat(1), gram: rat(1), kg: rat(1000), oz: rat(28349523125, 1000000000), ounce: rat(28349523125, 1000000000), lb: rat(45359237, 100000), pound: rat(45359237, 100000) };
const FRACTIONS: Record<string, string> = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8' };
/** "1", "1/2", "½", "1 ½", "1 1/2", "1.5", ".5" → exact rational. */
function parseQuantity(q: string): Rational {
  const parts = q.trim().split(/\s+/).map((p) => FRACTIONS[p] ?? p.replace(/^(\d+)([½¼¾⅓⅔⅛])$/, (_m, a: string, f: string) => `${a} ${FRACTIONS[f]}`).replace(/^\./, '0.'));
  return parts.join(' ').split(/\s+/).reduce((acc, p) => add(acc, parseRational(p)), rat(0));
}
/** Volume words whose size depends on the country (US or imperial pint, quart, gallon, gill) or that are one letter ("1 c", "1 T"):
 *  never converted, never read as a count. */
const UNSURE_UNITS = /^(?:pints?|pts?|quarts?|qts?|gallons?|gals?|gills?|[a-fh-km-z])$/i;
const Q = String.raw`(?:\d+(?:[./]\d+)?|\.\d+|[½¼¾⅓⅔⅛])(?:\s*(?:\d+\/\d+|[½¼¾⅓⅔⅛]))?`;

/** One measure: "120 ML", "30 g", "1 tbsp", "½ tsp", "1 cupful", "1 clove", "1". Null: not one measure. */
function oneMeasure(t: string, volumeSystem: 'US' | 'METRIC'): Amount | null {
  const m = new RegExp(`^(${Q})\\s*([A-Za-z]+\\.?)?$`).exec(t);
  if (!m) return null;
  const value = parseQuantity(m[1]);
  const u = (m[2] ?? '').toLowerCase().replace(/\.$/, '').replace(/ful(?:s)?$|fuls$/, '');   // "cupful", "tablespoonfuls": the measure itself
  if (u && UNSURE_UNITS.test(u)) return { kind: 'AS_WRITTEN', text: t };
  const one = u.replace(/(es|s)$/, '') || u;
  if (u === 'ml' || one === 'milliliter' || one === 'millilitre') return { kind: 'EXACT', value, unit: 'ML', asWritten: t };
  if (u === 'l' || one === 'liter' || one === 'litre') return { kind: 'EXACT', value: mul(value, rat(1000)), unit: 'ML', asWritten: t };
  const mass = MASS_G[u] ?? MASS_G[one];
  if (mass) return { kind: 'EXACT', value: mul(value, mass), unit: 'G', asWritten: t };
  const vol = VOLUME_ML[u] ?? VOLUME_ML[one];
  if (vol) return { kind: 'EXACT', value: mul(value, vol[volumeSystem]), unit: 'ML', asWritten: t };
  return { kind: 'EXACT', value, unit: 'COUNT', asWritten: t };   // "1", "1 clove", "1 medium"
}
/** Two measures of one amount ("1 lb / 0.5 kg", "1/4 cup (60 ml)") may differ by rounding; past this they aren't one amount. */
export const EQUIVALENT_TOLERANCE = 0.15;

/**
 * Parse an amount as written. One measure, or (2026-10-13 hardening):
 * - an equivalent written two ways, "A (B)", "A / B", "A or B": A's value, the whole wording kept (never summed). Two measures of the
 *   same kind that differ by more than EQUIVALENT_TOLERANCE aren't one amount: as written.
 * - an addition, "A plus B" or "A + B" in one dimension ("1 tablespoon plus 2 teaspoons"): the sum, the wording kept.
 * - a range, "2-3 tsp", "2 1/2-3tsp", "1 to 2 cups": RANGE (never exact).
 * - a mixed number written with a hyphen, "1-1/2": 1½ (a range never ends below its start).
 * Anything else, and a unit whose size isn't certain (pint, quart, a one-letter "c" or "T"), stays as written: never guessed.
 */
export function parseAmount(raw: string | { asWritten: string } | null, volumeSystem: 'US' | 'METRIC'): Amount {
  if (raw === null) return { kind: 'UNSPECIFIED' };
  if (typeof raw === 'object') return { kind: 'AS_WRITTEN', text: raw.asWritten };
  const t = raw.trim();
  if (/^to taste$/i.test(t)) return { kind: 'NOT_QUANTITY_BEARING', reason: 'TO_TASTE', text: t };
  const asWritten: Amount = { kind: 'AS_WRITTEN', text: t };
  const s = t.replace(/(\d)-(\d+\/\d+)(?!\d)/g, '$1 $2');   // "1-1/2" → "1 1/2"
  const single = oneMeasure(s, volumeSystem);
  if (single) return single.kind === 'EXACT' ? { ...single, asWritten: t } : asWritten;
  const keep = (a: Amount): Amount => (a.kind === 'EXACT' ? { ...a, asWritten: t } : a);
  // addition: both parts exact, one dimension
  const plus = /^(.+?)\s*(?:\bplus\b|\+)\s*(.+)$/i.exec(s);
  if (plus) {
    const [a, b] = [oneMeasure(plus[1].trim(), volumeSystem), oneMeasure(plus[2].trim(), volumeSystem)];
    return a?.kind === 'EXACT' && b?.kind === 'EXACT' && a.unit === b.unit && a.unit !== 'COUNT' ? { kind: 'EXACT', value: add(a.value, b.value), unit: a.unit, asWritten: t } : asWritten;
  }
  // equivalents: the first measure; a second one of the same kind must agree within the tolerance. A "/" between digits is a fraction.
  const eq = /^(.+?)\s*\((.+)\)$/.exec(s) ?? /^(.+?)\s*(?:(?<!\d)\/|\/(?!\d)|\bor\b)\s*(.+)$/i.exec(s);
  if (eq) {
    const a = parseAmount(eq[1].trim(), volumeSystem), b = parseAmount(eq[2].trim(), volumeSystem);
    if (a.kind !== 'EXACT' && a.kind !== 'RANGE') return asWritten;
    if (b.kind === 'EXACT' && a.kind === 'EXACT' && a.unit === b.unit) {
      const x = a.value.n / a.value.d, y = b.value.n / b.value.d;
      if (Math.abs(x - y) > EQUIVALENT_TOLERANCE * Math.max(x, y)) return asWritten;
    } else if (b.kind !== 'EXACT' && b.kind !== 'RANGE') return asWritten;
    return a.kind === 'EXACT' ? keep(a) : { ...a, asWritten: t };
  }
  // range: "2-3 tsp", "2 1/2-3tsp", "1 to 2 cups"
  const rg = new RegExp(`^(${Q})\\s*(?:-|–|to)\\s*(${Q})\\s*([A-Za-z]+\\.?)?$`, 'i').exec(s);
  if (rg) {
    const [lo, hi] = [oneMeasure(`${rg[1]} ${rg[3] ?? ''}`.trim(), volumeSystem), oneMeasure(`${rg[2]} ${rg[3] ?? ''}`.trim(), volumeSystem)];
    if (lo?.kind === 'EXACT' && hi?.kind === 'EXACT' && lo.unit === hi.unit && lo.value.n * hi.value.d < hi.value.n * lo.value.d) return { kind: 'RANGE', min: lo.value, max: hi.value, unit: lo.unit, asWritten: t };
  }
  return asWritten;
}

/** A small volume in the recipe's teaspoons or tablespoons, to the nearest quarter ("¾ tsp", "1½ tsp", "1 tbsp"); null
 *  when it isn't within 2% of a quarter spoon (the caller then fails closed rather than print an odd millilitre figure). */
export function spoonText(ml: Rational, vol: 'US' | 'METRIC'): string | null {
  const glyph = (q: number) => { const w = Math.floor(q / 4), f = ['', '¼', '½', '¾'][q % 4]; return w ? `${w}${f}` : f; };
  const x = ml.n / ml.d;
  for (const [unit, size] of [['tbsp', TBSP[vol]], ['tsp', TSP[vol]]] as const) {
    const q = Math.round((x / (size.n / size.d)) * 4);
    if (q > 0 && Math.abs(q / 4 - x / (size.n / size.d)) <= 0.02 * (q / 4) && (unit === 'tsp' || q % 4 === 0)) return `${glyph(q)} ${unit}`;
  }
  return null;
}

/** A volume as the recipe's cups, to the nearest quarter or third ("1½ cups", "⅔ cup"), within 2%; null otherwise. */
export function cupText(ml: Rational, vol: 'US' | 'METRIC'): string | null {
  const c = (ml.n / ml.d) / (CUP[vol].n / CUP[vol].d);
  for (const [d, glyphs] of [[4, ['', '¼', '½', '¾']], [3, ['', '⅓', '⅔']]] as const) {
    const q = Math.round(c * d), w = Math.floor(q / d), f = glyphs[q % d];
    if (q > 0 && Math.abs(q / d - c) <= 0.02 * (q / d)) return `${w || ''}${f || (w ? '' : '0')} ${q / d > 1 ? 'cups' : 'cup'}`;
  }
  return null;
}

const UNIT_TEXT: Record<Unit, string> = { G: 'g', ML: 'ML', COUNT: '' };
export const qtyText = (value: Rational, unit: Unit) => `${formatRational(value)}${UNIT_TEXT[unit] ? ' ' + UNIT_TEXT[unit] : ''}`;

export function amountDisplay(a: Amount): string {
  switch (a.kind) {
    case 'EXACT': return a.asWritten ?? qtyText(a.value, a.unit);
    case 'RANGE': return a.asWritten ?? `${formatRational(a.min)}–${qtyText(a.max, a.unit)}`;
    case 'AS_WRITTEN': return a.text;
    case 'NOT_QUANTITY_BEARING': return a.text;
    case 'UNSPECIFIED': return 'amount not stated';
  }
}

// ---------- lookups ----------
export const stepOrder = (r: Recipe, stepId: Id) => r.steps.findIndex((s) => s.stepId === stepId) + 1;
export const getStep = (r: Recipe, stepId: Id) => r.steps.find((s) => s.stepId === stepId);
export const getUse = (r: Recipe, useId: Id) => r.uses.find((u) => u.useId === useId);
export const getIngredient = (r: Recipe, id: Id) => r.ingredients.find((i) => i.ingredientId === id);
/** "Heavy cream" → "heavy cream" in a sentence; a name with a second capitalized word is a proper name ("Better Than Bouillon …",
 *  "Diamond Crystal kosher salt") and stays as written. */
export const lowerFirst = (s: string) => (/^\p{Lu}\p{Ll}*\s+\p{Lu}/u.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
export const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** First step (in order) that is not COMPLETED; null when all are done. */
export function currentStepId(r: Recipe, stepStatus: Record<Id, StepStatus>): Id | null {
  return r.steps.find((s) => stepStatus[s.stepId] !== 'COMPLETED')?.stepId ?? null;
}

// ---------- rendering ----------
export function useLabel(r: Recipe, u: IngredientUse): string {
  if (u.displayText !== null) return u.displayText;
  const name = lowerFirst(getIngredient(r, u.ingredientId)?.name ?? u.ingredientId);
  return [amountDisplay(u.amount), u.prepNote, name].filter((x) => x && x !== 'amount not stated').join(' ');
}

export function allowanceText(r: Recipe, u: IngredientUse): string {
  const a = u.allowance;
  if (!a) return '';
  const name = lowerFirst(getIngredient(r, u.ingredientId)?.name ?? u.ingredientId);
  return `Only if needed: up to ${qtyText(a.max, a.unit)} more ${name}. ${a.stopCondition} ${a.ifExhausted}`;
}

const TOKEN = /\{(use|allowance):([^}]+)\}/g;
export function renderText(r: Recipe, text: string): string {
  return text.replace(TOKEN, (_m, kind: string, id: string) => {
    const u = getUse(r, id);
    if (!u) throw new Error(`unresolved token ${kind}:${id}`);
    return kind === 'use' ? useLabel(r, u) : allowanceText(r, u);
  }).replace(/\s+$/, '');
}
export const renderStep = (r: Recipe, s: Step) => renderText(r, s.text);
export const tokensIn = (text: string) => [...text.matchAll(TOKEN)].map((m) => ({ kind: m[1], id: m[2] }));

// ---------- prose lint: literal ingredient amounts outside tokens go stale on amendment ----------
const LITERAL_AMOUNT = /\b\d+(?:[.,/]\d+)?\s*(?:ml|g|kg|tsp|tbsp|cups?|oz|lb)\b|[½¼¾]\s*(?:tsp|tbsp|cups?)\b/i;
export function proseLint(text: string): string | null {
  const bare = text.replace(TOKEN, '');
  const m = LITERAL_AMOUNT.exec(bare);
  return m ? `untokenized amount "${m[0]}"` : null;
}

// ---------- structural invariants ----------
/** Structural invariants. Prose lint is pattern-local: only `lintStepIds` (the steps an amendment touched) are linted. */
export function validateStructure(r: Recipe, v: Vocabulary, lintStepIds: Iterable<Id> = []): string[] {
  const lintSet = new Set(lintStepIds);
  const errs: string[] = [];
  const dup = (ids: Id[], what: string) => ids.forEach((id, i) => ids.indexOf(id) !== i && errs.push(`duplicate ${what} ${id}`));
  dup(r.steps.map((s) => s.stepId), 'step'); dup(r.uses.map((u) => u.useId), 'use'); dup(r.ingredients.map((i) => i.ingredientId), 'ingredient');
  const fn = new Set(v.functions.map((f) => f.functionId)), tech = new Set(v.techniques.map((t) => t.techniqueId)), kinds = new Set(v.kinds.map((k) => k.kindId));
  r.steps.forEach((s, i) => {
    for (const d of s.dependsOn) if (!r.steps.slice(0, i).some((p) => p.stepId === d)) errs.push(`step ${s.stepId} depends on ${d}, which is not earlier`);
    if (s.technique && !tech.has(s.technique.techniqueId)) errs.push(`step ${s.stepId}: unknown technique ${s.technique.techniqueId}`);
    for (const t of tokensIn(s.text)) {
      const u = getUse(r, t.id);
      if (!u) errs.push(`step ${s.stepId}: token ${t.kind}:${t.id} does not resolve`);
      else if (t.kind === 'allowance' && !u.allowance) errs.push(`step ${s.stepId}: allowance token on use ${t.id} without allowance`);
    }
    const lint = lintSet.has(s.stepId) ? proseLint(s.text) : null;
    if (lint) errs.push(`step ${s.stepId}: ${lint}`);
  });
  for (const u of r.uses) {
    if (!getIngredient(r, u.ingredientId)) errs.push(`use ${u.useId}: unknown ingredient ${u.ingredientId}`);
    if (!getStep(r, u.stepId)) errs.push(`use ${u.useId}: unknown step ${u.stepId}`);
    for (const f of u.functions) if (!fn.has(f.functionId)) errs.push(`use ${u.useId}: unknown function ${f.functionId}`);
    if (u.kind === 'PREPARE') {
      const p = u.preparesUseId ? getUse(r, u.preparesUseId) : undefined;
      if (!p || p.kind !== 'ADD' || p.ingredientId !== u.ingredientId) errs.push(`use ${u.useId}: PREPARE must point at an ADD use of the same ingredient`);
    } else if (u.preparesUseId !== null) errs.push(`use ${u.useId}: preparesUseId only on PREPARE uses`);
    if (u.allowance && (u.amount.kind !== 'EXACT' || u.amount.unit !== u.allowance.unit)) errs.push(`use ${u.useId}: allowance unit must equal an EXACT amount unit`);
  }
  for (const i of r.ingredients) if (i.kind && !kinds.has(i.kind.kindId)) errs.push(`ingredient ${i.ingredientId}: unknown kind ${i.kind.kindId}`);
  return errs;
}

// ---------- authored content → Recipe ----------
export interface RecipeSource {
  schema: 'cc-recipe-src/1'; recipeId: Id; title: string; meta: string; volumeSystem: 'US' | 'METRIC';
  source: Recipe['source']; decisionRef: string;
  ingredients: { id: Id; name: string; kind: Id | null; listed: string | { asWritten: string } | null }[];
  steps: { id: Id; title: string; text: string; technique: Id | null; dependsOn?: Id[]; duration?: [number, string] }[];
  uses: {
    id: Id; ingredient: Id; step: Id; amount: string | { asWritten: string } | null; prepares?: Id;
    display?: string; functions: (Id | { id: Id; label: string })[]; optional?: boolean;
  }[];
}

/** Expand owner-approved authored content. Every fact carries REVIEWED provenance pointing at the recorded decision. */
export function expandRecipe(src: RecipeSource): Recipe {
  const prov: Provenance = { status: 'REVIEWED', by: 'OWNER', ref: src.decisionRef };
  return {
    schema: 'cc-recipe/2', recipeId: src.recipeId, revision: 1, title: src.title, meta: src.meta,
    volumeSystem: src.volumeSystem, source: src.source,
    ingredients: src.ingredients.map((i) => ({
      ingredientId: i.id, name: i.name, kind: i.kind ? { kindId: i.kind, prov } : null,
      listed: parseAmount(i.listed, src.volumeSystem), listedProv: prov,
    })),
    steps: src.steps.map((s, idx) => ({
      stepId: s.id, title: s.title, text: s.text,
      technique: s.technique ? { techniqueId: s.technique, prov } : null,
      dependsOn: s.dependsOn ?? (idx > 0 ? [src.steps[idx - 1].id] : []),   // default: linear chain
      duration: s.duration ? { seconds: s.duration[0], display: s.duration[1], sourceText: null } : null,
      prov,
    })),
    uses: src.uses.map((u) => ({
      useId: u.id, ingredientId: u.ingredient, stepId: u.step,
      kind: u.prepares ? 'PREPARE' : 'ADD', preparesUseId: u.prepares ?? null,
      amount: parseAmount(u.amount, src.volumeSystem), amountProv: prov,
      displayText: u.display ?? null, prepNote: null,
      functions: u.functions.map((f) => (typeof f === 'string' ? { functionId: f, label: null, prov } : { functionId: f.id, label: f.label, prov })),
      optional: u.optional ?? false, allowance: null,
    })),
  };
}

/** Σ of EXACT ADD uses per unit. Used for display totals and reservations. */
export function sumExact(uses: IngredientUse[], unit: Unit): Rational {
  return uses.reduce((acc, u) => (u.kind === 'ADD' && u.amount.kind === 'EXACT' && u.amount.unit === unit ? add(acc, u.amount.value) : acc), rat(0));
}
