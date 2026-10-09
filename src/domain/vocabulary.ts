// Open vocabulary lookups. Vocabulary is content (content/approved/vocabulary.json), never code.
import type { Id, Ingredient, Vocabulary } from '../contract/types.ts';

export const kindOf = (v: Vocabulary, kindId: Id) => v.kinds.find((k) => k.kindId === kindId);
export const classesOfKind = (v: Vocabulary, kindId: Id): Id[] => kindOf(v, kindId)?.classes ?? [];
export const classLabel = (v: Vocabulary, classId: Id) => v.classes.find((c) => c.classId === classId)?.label ?? classId;
export const functionLabel = (v: Vocabulary, functionId: Id) => v.functions.find((f) => f.functionId === functionId)?.label ?? functionId;

/** Class membership of an ingredient: PASS / FAIL, or UNKNOWN when its kind is missing or not REVIEWED. */
export function ingredientInClass(v: Vocabulary, ing: Ingredient, classId: Id): 'PASS' | 'FAIL' | 'UNKNOWN' {
  if (!ing.kind || ing.kind.prov.status !== 'REVIEWED') return 'UNKNOWN';
  return classesOfKind(v, ing.kind.kindId).includes(classId) ? 'PASS' : 'FAIL';
}

/** Classes of proposed kinds, sorted and deduplicated; unknown kinds are returned separately. */
export function proposalClasses(v: Vocabulary, kindIds: Id[]): { classes: Id[]; unknown: Id[] } {
  const classes = new Set<Id>(), unknown: Id[] = [];
  for (const k of kindIds) { const kind = kindOf(v, k); if (kind) kind.classes.forEach((c) => classes.add(c)); else unknown.push(k); }
  return { classes: [...classes].sort(), unknown };
}

// ---------- identity (approved names only; a shared class never makes two kinds the same ingredient) ----------
export const normName = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
// ponytail: a closed list of preparation words; a variety or form word ("chicken", "granulated", "caster", "self-raising") is never stripped
const PREP = /^(?:cold|chilled|melted|softened|fresh|hot|warm|room[- ]temperature|cubed|diced|chopped|grated|sliced|minced)\s+/;
/** A name with leading preparation words set aside, and a trailing ", sliced"-style preparation note dropped. */
export function bareName(s: string): string {
  let x = normName(s).replace(/,\s*(?:finely |roughly |thinly )?(?:chopped|diced|minced|grated|sliced|cubed|softened|melted)$/, '');
  while (PREP.test(x)) x = x.replace(PREP, '');
  return x;
}
/** A kind's names: its label, its true aliases and its id spelled out (whole-milk → "whole milk"). */
export const kindNames = (k: Vocabulary['kinds'][number]) => [...new Set([k.label, ...k.aliases, k.kindId.replace(/-/g, ' ')].map(normName))];
/** The one kind an ingredient name IS by approved identity, preparation words set aside; undefined when no kind has that name. */
export const kindByName = (v: Vocabulary, name: string) => { const n = bareName(name); return v.kinds.find((k) => kindNames(k).includes(n)); };
/** Content check: every name belongs to exactly one kind (an ambiguous alias would make identity depend on list order). */
export function identityErrors(v: Vocabulary): string[] {
  const owner = new Map<string, Id>(), out: string[] = [];
  for (const k of v.kinds) for (const n of kindNames(k)) {
    if (owner.has(n) && owner.get(n) !== k.kindId) out.push(`vocabulary: "${n}" names both ${owner.get(n)} and ${k.kindId}`);
    owner.set(n, k.kindId);
  }
  return out;
}

export const sameSet =(a: Id[], b: Id[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
