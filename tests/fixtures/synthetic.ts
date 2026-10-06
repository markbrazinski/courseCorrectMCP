// SYNTHETIC SOFTWARE EVIDENCE (ESOD §9.5). Renamed/rearranged recipes and synthetic patterns that
// prove the engine has no hero-specific branch. None of these values are culinary content.
import type { Pattern, RecoveryPattern, RefusalPattern } from '../../src/contract/types.ts';
import type { RecipeSource } from '../../src/domain/recipe.ts';
import { patterns, source } from '../helpers.ts';
import { ING, RECIPE, STEP, USE } from './ids.ts';

/** Rename every step/use/ingredient id (including text tokens) through `map`. */
export function renameIds(src: RecipeSource, map: (id: string) => string): RecipeSource {
  const s = structuredClone(src);
  s.ingredients.forEach((i) => { i.id = map(i.id); });
  s.steps.forEach((st) => {
    st.id = map(st.id);
    st.dependsOn = st.dependsOn?.map(map);
    st.text = st.text.replace(/\{(use|allowance):([^}]+)\}/g, (_m, k: string, id: string) => `{${k}:${map(id)}}`);
  });
  s.uses.forEach((u) => { u.id = map(u.id); u.ingredient = map(u.ingredient); u.step = map(u.step); if (u.prepares) u.prepares = map(u.prepares); });
  return s;
}

/** SYN-A: risotto with every id renamed, names changed, steps rearranged, extra trailing step, wine 140 ML. */
export function synA(): RecipeSource {
  const s = renameIds(source(RECIPE['risotto.demo']), (id) => `z.q_${id.replace(/\W/g, '_')}`);
  s.recipeId = 'syn.a'; s.title = 'SYNTHETIC leek risotto';
  const ing = (id: string) => s.ingredients.find((i) => i.id === `z.q_${id}`)!;
  ing(ING['stock']).kind = 'mushroom-stock'; ing(ING['stock']).name = 'Mushroom stock';
  ing(ING['rice']).kind = 'carnaroli-rice'; ing(ING['rice']).name = 'Carnaroli rice';
  ing(ING['onion']).name = 'Leek, sliced';
  ing(ING['wine']).listed = '140 ML';
  s.uses.find((u) => u.id === `z.q_${USE['r.wine']}`)!.amount = '140 ML';
  // rearrange: garlic before onion; add a garnish step after the finish
  const [heat, soften, garlic, ...rest] = s.steps;
  s.steps = [heat, garlic, soften, ...rest, { id: 'z.q_garnish', title: 'Garnish', text: 'Scatter with herbs and serve.', technique: 'REST' }];
  return s;
}

/** SYN-B: SYN-A with pearl barley (not a risotto rice). */
export function synB(): RecipeSource {
  const s = synA(); s.recipeId = 'syn.b';
  const rice = s.ingredients.find((i) => i.id === `z.q_${ING['rice']}`)!;
  rice.kind = 'pearl-barley'; rice.name = 'Pearl barley';
  return s;
}

/** SYN-C: risotto plus a second (uncovered) wine use at the finish. */
export function synC(): RecipeSource {
  const s = source(RECIPE['risotto.demo']); s.recipeId = 'syn.c';
  s.ingredients.find((i) => i.id === ING['wine'])!.listed = '150 ML';
  s.uses.push({ id: 'r.wine2', ingredient: ING['wine'], step: STEP['r.finish'], amount: '30 ML', functions: [{ id: 'FLAVOR', label: 'aroma' }] });
  const fin = s.steps.find((x) => x.id === STEP['r.finish'])!;
  fin.text = `Off the heat, stir in {use:${USE['r.butter2']}} and {use:${USE['r.parm']}}. Add {use:r.wine2}. Season with {use:${USE['r.salt']}}.`;
  return s;
}

const split = () => structuredClone(patterns.find((p) => p.patternId === 'split')) as RecoveryPattern;

/** SYN-D: a second, synthetic recovery on the same target (stock only; acidity dropped). */
export function synStockOnly(): RecoveryPattern {
  const p = split();
  return {
    ...p, patternId: 'syn_stock_only', version: 1, title: 'SYNTHETIC stock only',
    introduces: [], quantities: { stock_now: p.quantities.stock_now },
    ops: [p.ops[0], { op: 'SET_RESUME', step: '$target.step' }],
    functionAccounting: [
      { from: '$target', functionId: 'ACIDITY', disposition: 'DROPPED_WITH_TRADEOFF', to: null },
      { from: '$target', functionId: 'FLAVOR', disposition: 'DROPPED_WITH_TRADEOFF', to: null },
      { from: '$target', functionId: 'LIQUID', disposition: 'RETAINED', to: 'stock_now' },
    ],
    consequence: { ...p.consequence, headline: 'SYNTHETIC: stock only.', tradeoff: 'SYNTHETIC tradeoff.' },
    proposal: null,
  };
}

/** SYN-E: split plus a narrowing exception (target 140–150 ML). */
export function splitWithException(): RecoveryPattern {
  const p = split();
  p.exceptions = [{ exceptionId: 'syn_narrow', when: { kind: 'AMOUNT_IN_RANGE', slot: '$target', unit: 'ML', min: { n: 140, d: 1 }, max: { n: 150, d: 1 } }, reason: 'SYNTHETIC narrowing' }];
  return p;
}

/** SYN-F: a synthetic refusal that contradicts split's lemon-juice claim on the same target. */
export function contradictingRefusal(): RefusalPattern {
  return {
    schema: 'cc-pattern/1', kind: 'REFUSAL', patternId: 'syn_no_lemon', version: 1, title: 'SYNTHETIC refusal',
    target: { ingredientClass: 'wine', performsAll: ['ACIDITY', 'LIQUID'], stepTechnique: 'DEGLAZE' },
    slots: [], applicability: [], exceptions: [], evidence: { quantityStatus: 'NONE', basis: 'SYNTHETIC' },
    proposal: { classes: ['citrus-juice'], match: 'EQUALS' }, response: 'NOT_FUNCTIONALLY_EQUIVALENT',
    requiredFunctionLabel: 'SYNTHETIC', text: 'SYNTHETIC refusal text.', scopeNote: 'SYNTHETIC',
  };
}

export const withPatterns = (...extra: Pattern[]) => [...patterns, ...extra];

/** SYNTHETIC: swap the finishing cheese for lemon juice (touches the finish step). Used only to prove a later change can't
 *  rewrite a step an earlier change already altered. Not culinary content. */
export function synSwapCheese(): RecoveryPattern {
  return {
    kind: 'RECOVERY', patternId: 'syn_swap_cheese', version: 1, title: 'SYNTHETIC cheese swap',
    target: { ingredientClass: 'hard-cheese', performsAll: ['FLAVOR'], stepTechnique: 'OFF_HEAT_FINISH' }, slots: [], applicability: [], exceptions: [],
    evidence: { quantityStatus: 'NONE', basis: 'SYNTHETIC' },
    introduces: [{ local: 'sub', kindId: 'lemon-juice', name: 'lemon juice' }],
    quantities: { q: { kind: 'LITERAL', value: { n: 5, d: 1 }, unit: 'ML' } },
    ops: [{ op: 'REPLACE_USE', use: '$target', with: { local: 'sub_use', ingredient: { introduce: 'sub' }, at: '$target.step', qty: 'q', prepNote: null, functions: ['FLAVOR'], allowance: null } }, { op: 'SET_RESUME', step: '$target.step' }],
    siblingHandlers: [], functionAccounting: [{ from: '$target', functionId: 'FLAVOR', disposition: 'RETAINED', to: 'sub_use' }], introducedFunctions: [],
    consequence: { outcomeClass: 'SUBSTITUTED', equivalence: 'NOT_EQUIVALENT', headline: 'SYNTHETIC', reason: 'SYNTHETIC', tradeoff: 'SYNTHETIC' },
    proposal: null, guards: [],
  } as unknown as RecoveryPattern;
}
