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

export const sameSet = (a: Id[], b: Id[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
