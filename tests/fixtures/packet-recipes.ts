// Shared TEST FIXTURES for the knowledge-packet tests (software evidence only, never culinary validation).
import { coreHashes } from '../../src/authoring/drafts.ts';
import type { kitchen } from './successive.ts';

export type Fact = { name: RegExp; kind: 'INGREDIENT' | 'STEP'; predicate: 'KIND' | 'TECHNIQUE'; value: string };

/** Import a scripted recipe, confirm the named facts as the owner (as the requirements form does), save it. */
export async function importConfirmed(k: ReturnType<typeof kitchen>, src: { lines: string[]; reading: unknown }, facts: Fact[]) {
  const saved = await (async () => {
    const r0 = await k.importAndSave(src).catch((e) => { throw e; });
    return r0;
  })();
  if (!facts.length) return saved;
  const r = (await k.auth.effective(saved.draftId))!, cores = coreHashes(r);
  const assertions = facts.map((f) => {
    const id = f.kind === 'STEP' ? r.steps.find((s) => f.name.test(s.text))!.stepId : r.ingredients.find((i) => f.name.test(i.name))!.ingredientId;
    return { subject: { kind: f.kind, id }, predicate: f.predicate, value: f.value, coreHash: cores.get(`${f.kind}|${id}`)! };
  });
  await k.auth.assert(saved.draftId, { expectedRevision: await k.auth.revision(saved.draftId), reviewer: 'owner (test)', assertions });
  return k.auth.save(saved.draftId, { expectedRevision: await k.auth.revision(saved.draftId) });
}

// ---------- Sour Milk Griddle-cakes (Fannie Farmer, public domain; corpus d10) ----------
export function griddle() {
  const ing = (key: string, line: string, name: string, amountText: string) => ({ key, line, name, amountText, kind: null });
  const ingredients = [ing('f', '2½ cups flour', 'flour', '2½ cups'), ing('t', '½ teaspoon salt', 'salt', '½ teaspoon'), ing('m', '2 cups sour milk', 'sour milk', '2 cups'),
    ing('d', '1¼ teaspoons soda', 'soda', '1¼ teaspoons'), ing('e', '1 egg', 'egg', '1')];
  const steps = [{ key: 's1', text: 'Mix and sift flour, salt, and soda; add sour milk, and egg well beaten.', title: 'Mix batter', technique: 'MIX_DOUGH' },
    { key: 's2', text: 'Drop by spoonfuls on a greased hot griddle; cook on one side.', title: 'Griddle', technique: null },
    { key: 's3', text: 'When puffed, full of bubbles, and cooked on edges, turn, and cook other side.', title: 'Turn', technique: null }];
  const use = (k: string, quote: string, functions: string[]) => ({ ingredientKey: k, stepKey: 's1', quote, amountText: null, functions });
  const uses = [use('f', 'flour', ['STRUCTURE']), use('t', 'salt', ['FLAVOR']), use('d', 'soda', ['LEAVENING']), use('m', 'sour milk', ['LIQUID', 'ACIDITY']), use('e', 'egg', ['STRUCTURE'])];
  return { lines: ['Sour Milk Griddle-cakes', ...ingredients.map((i) => i.line), ...steps.map((s) => s.text)], reading: { recipeFound: true, title: 'Sour Milk Griddle-cakes', yield: null, ingredients, steps, uses } };
}
// Fannie Farmer's method gives no "dough" or "batter" word for the mixing step: the technique is an owner confirmation, and
// "soda" (soda water? baking soda?) is never baking soda by name alone
export const GRIDDLE_FACTS: Fact[] = [{ name: /^Mix and sift/, kind: 'STEP', predicate: 'TECHNIQUE', value: 'MIX_DOUGH' }, { name: /^soda$/, kind: 'INGREDIENT', predicate: 'KIND', value: 'baking-soda' }];

