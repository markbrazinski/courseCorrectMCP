// Loads owner-approved content (project rule 6: content/approved only) and compiles packs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, Pattern, RecipePack, RoleTable, Vocabulary } from '../contract/types.ts';
import { compile } from '../compile/binder.ts';
import { expandRecipe, type RecipeSource } from '../domain/recipe.ts';

export interface Fixture { fixtureId: Id; recipeId: Id; actions: { stepId: Id; progress: 'started' | 'partly' | 'done'; addedUseIds?: Id[] }[] }
export interface Content { vocab: Vocabulary; roles: RoleTable; patterns: Pattern[]; packs: Map<Id, RecipePack>; fixtures: Map<Id, Fixture>; errors: string[] }

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const jsonFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));

export function loadContent(dir = join(import.meta.dirname, '../../content/approved')): Content {
  const vocab = readJson<Vocabulary>(join(dir, 'vocabulary.json'));
  const roles = readJson<RoleTable>(join(dir, 'roles.json'));
  const patterns = jsonFiles(join(dir, 'patterns')).map((f) => readJson<Pattern>(f));
  const packs = new Map<Id, RecipePack>(), errors: string[] = [];
  for (const x of roles.roles) {
    if (!vocab.kinds.some((k) => k.kindId === x.kindId) || !vocab.techniques.some((t) => t.techniqueId === x.techniqueId) || !x.functions.every((f) => vocab.functions.some((g) => g.functionId === f))) errors.push(`roles.json: unknown id in ${x.kindId} × ${x.techniqueId}`);
  }
  for (const t of Object.keys(roles.cues)) if (!vocab.techniques.some((x) => x.techniqueId === t)) errors.push(`roles.json: unknown technique ${t}`);
  for (const f of jsonFiles(join(dir, 'recipes'))) {
    const recipe = expandRecipe(readJson<RecipeSource>(f));
    const res = compile(recipe, vocab, patterns);
    if (res.pack) packs.set(recipe.recipeId, res.pack); else errors.push(...res.errors.map((e) => `${recipe.recipeId}: ${e}`));
  }
  const fixtures = new Map(jsonFiles(join(dir, 'fixtures')).map((f) => { const x = readJson<Fixture>(f); return [x.fixtureId, x] as const; }));
  return { vocab, roles, patterns, packs, fixtures, errors };
}
