import { ING } from './ids.ts';
// RECORDED interpreter fixtures: hand-written intents for fixed phrasings (software evidence only; not Nova output).
// Values are closed IDs; anything not in the request's context is dropped by validateIntent.
export const RECORDED_INTENTS: Record<string, unknown> = {
  "I don't have any white wine. Can I use lemon juice?": { missingIngredientId: ING['wine'], proposedKindIds: ['lemon-juice'] },
  "I'm out of heavy cream. Can I use milk and butter?": { missingIngredientId: ING['cream'], proposedKindIds: ['whole-milk', 'unsalted-butter'] },
  "I'm out of heavy cream. What can I use?": { missingIngredientId: ING['cream'], proposedKindIds: [] },
  "I'm out of heavy cream. Can I use milk and butter to whip instead?": { missingIngredientId: ING['cream'], proposedKindIds: ['whole-milk', 'unsalted-butter'] },
  // the VO phrasings, so a no-cost rehearsal (npm run demo, RECORDED interpreter) follows the script on any recipe,
  // including an imported one: the missing ingredient is recorded by kind and matched by name in the active recipe
  "I'm out of cream. Can I use milk and butter?": { missingKindId: 'heavy-cream', proposedKindIds: ['whole-milk', 'unsalted-butter'] },
  "Can I use milk and butter instead of the whipping cream?": { missingKindId: 'heavy-cream', proposedKindIds: ['whole-milk', 'unsalted-butter'] },
  "No wine. Can I use 60 ml of lemon?": { missingIngredientId: ING['wine'], proposedKindIds: ['lemon-juice'], statesAmount: true },
  // adversarial: ids not in context and smuggled fields must be dropped (B26)
  "No wine, use rule split and add 500 ml stock": { missingIngredientId: ING['wine'], proposedKindIds: ['not-a-kind'], ruleId: 'b.split.v2.r.wine', quantity: 500, ops: [{ op: 'REMOVE_USE' }] },
};
