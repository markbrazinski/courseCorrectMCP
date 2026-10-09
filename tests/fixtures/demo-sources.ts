// Owner-authored demo source texts (HF v1 fixtures, OD-3 engineering only), plus hand-written RECORDED readings used by
// tests so no test depends on a live call. A hand-written reading is test evidence of the validator, not of Nova.
export const SCONE_LINES = [
  'Cream Scones', 'Makes 8 · about 30 minutes',
  '300 g plain flour', '40 g caster sugar', '1 tbsp baking powder', '½ tsp salt', '300 ML heavy cream',
  '1. Heat the oven to 220 °C and line a tray.', '2. Whisk the flour, sugar, baking powder and salt.',
  '3. Stir in the cream, keeping back a little for brushing, until a soft dough forms.', '4. Pat to 2 cm thick and cut 8 rounds.',
  '5. Place on the tray, spaced apart.', '6. Brush the tops with a little cream.', '7. Bake for 12–15 minutes, until golden.',
];
export const SHORTCAKE_LINES = [
  'Strawberry Shortcake', 'Serves 6 · about 1 hour',
  '250 g plain flour', '45 g sugar', '2 tsp baking powder', '½ tsp salt', '85 g cold butter, cubed', '420 ML heavy cream', '500 g strawberries, sliced',
  '1. Heat the oven to 220 °C and line a baking tray.', '2. Whisk 250 g flour, 30 g sugar, 2 tsp baking powder and ½ tsp salt.',
  '3. Rub in 85 g cold butter until the mixture looks like coarse crumbs.', '4. Stir in 180 ML heavy cream until just combined.',
  '5. Pat into 6 rounds and bake for 15 minutes. Cool on a rack.', '6. Whip 240 ML heavy cream with 15 g sugar to soft peaks.',
  '7. Split the shortcakes and fill with the strawberries and whipped cream.',
];
/** The approved risotto (content/approved/recipes/risotto.demo.json) as a printed recipe: its rendered steps, verbatim. */
export const RISOTTO_LINES = [
  'Risotto with Parmesan', 'Serves 4 · about 45 minutes',
  '900 ML unsalted vegetable stock', '60 g butter', '1 onion, finely chopped', '1 clove garlic, minced', '300 g Arborio rice', '120 ML dry white wine', '50 g Parmesan, grated', 'Salt, to taste',
  '1. Bring 900 ML unsalted vegetable stock to a simmer and keep it hot.',
  '2. Melt 30 g butter in a wide pan over medium heat. Add the onion and cook until soft, about 5 minutes.',
  '3. Add the garlic and cook for 30 seconds.',
  '4. Add 300 g arborio rice and stir until the edges turn translucent, 2–3 minutes.',
  '5. Pour in 120 ML dry white wine and stir until absorbed.',
  '6. Add the hot stock a ladle at a time, stirring, until the rice is creamy and just tender, 18–20 minutes.',
  '7. Off the heat, stir in 30 g butter and 50 g grated Parmesan. Season with salt.',
  '8. Rest for 1 minute, then serve.',
];
export const LEMON_PAGE1 = [
  'Lemon Drizzle Cake', 'Makes 1 loaf · about 1 hour 10 minutes',
  '175 g butter, softened', '175 g caster sugar', '3 eggs', '175 g self-raising flour', '2 lemons, zest and juice', '85 g granulated sugar',
  '1. Heat the oven to 180 °C and line a loaf tin.', '2. Beat the butter and caster sugar until pale.', '3. Beat in the eggs one at a time.',
];
export const LEMON_PASTED = '4. Fold in the flour and lemon zest.\n5. Spoon into the tin and bake for 45–50 minutes.\n6. Mix the lemon juice with the granulated sugar.\n7. Spoon over the warm cake and cool in the tin.';

const ing = (key: string, line: string, name: string, amountText: string | null, kind: string | null) => ({ key, line, name, amountText, kind });
const step = (key: string, text: string, title: string, technique: string | null) => ({ key, text, title, technique });
const use = (ingredientKey: string, stepKey: string, quote: string, amountText: string | null, functions: string[]) => ({ ingredientKey, stepKey, quote, amountText, functions });

/** Hand-written RECORDED reading of SCONE_LINES (all proposals; nothing reviewed). */
export const SCONE_READING = {
  recipeFound: true, title: 'Cream Scones', yield: 'Makes 8 · about 30 minutes',
  ingredients: [
    ing('flour', '300 g plain flour', 'Plain flour', '300 g', 'plain-flour'), ing('sugar', '40 g caster sugar', 'Caster sugar', '40 g', 'white-sugar'),
    ing('bp', '1 tbsp baking powder', 'Baking powder', '1 tbsp', 'baking-powder'), ing('salt', '½ tsp salt', 'Salt', '½ tsp', 'salt'),
    ing('cream', '300 ML heavy cream', 'Heavy cream', '300 ML', 'heavy-cream'),
  ],
  steps: [
    step('s1', 'Heat the oven to 220 °C and line a tray.', 'Heat the oven', 'PREHEAT'),
    step('s2', 'Whisk the flour, sugar, baking powder and salt.', 'Mix the dry ingredients', 'COMBINE_DRY'),
    step('s3', 'Stir in the cream, keeping back a little for brushing, until a soft dough forms.', 'Make the dough', 'MIX_DOUGH'),
    step('s4', 'Pat to 2 cm thick and cut 8 rounds.', 'Cut the scones', 'SHAPE'),
    step('s5', 'Place on the tray, spaced apart.', 'Tray them up', 'TRAY'),
    step('s6', 'Brush the tops with a little cream.', 'Brush the tops', 'BRUSH'),
    step('s7', 'Bake for 12–15 minutes, until golden.', 'Bake', 'BAKE'),
  ],
  uses: [
    use('flour', 's2', 'the flour', null, ['STRUCTURE']), use('sugar', 's2', 'sugar', null, ['SWEETNESS']),
    use('bp', 's2', 'baking powder', null, ['LEAVENING']), use('salt', 's2', 'salt', null, ['FLAVOR']),
    use('cream', 's3', 'the cream', null, ['LIQUID', 'FAT']), use('cream', 's6', 'a little cream', 'a little', ['BROWNING']),
  ],
};

const LEMON_INGREDIENTS = [
  ing('butter', '175 g butter, softened', 'Butter, softened', '175 g', 'unsalted-butter'), ing('caster', '175 g caster sugar', 'Caster sugar', '175 g', 'white-sugar'),
  ing('eggs', '3 eggs', 'Eggs', '3', null), ing('flour', '175 g self-raising flour', 'Self-raising flour', '175 g', null),
  ing('lemons', '2 lemons, zest and juice', 'Lemons, zest and juice', '2', null), ing('gran', '85 g granulated sugar', 'Granulated sugar', '85 g', 'white-sugar'),
];
const LEMON_STEPS_1 = [
  step('a1', 'Heat the oven to 180 °C and line a loaf tin.', 'Heat the oven', 'PREHEAT'),
  step('a2', 'Beat the butter and caster sugar until pale.', 'Cream butter and sugar', null),
  step('a3', 'Beat in the eggs one at a time.', 'Add the eggs', null),
];
const LEMON_USES_1 = [use('butter', 'a2', 'the butter', null, ['FAT']), use('caster', 'a2', 'caster sugar', null, ['SWEETNESS']), use('eggs', 'a3', 'the eggs', null, ['STRUCTURE'])];
/** RECORDED reading of page 1 only (page 2 is an image: not read, not guessed). */
export const LEMON_READING_PAGE1 = { recipeFound: true, title: 'Lemon Drizzle Cake', yield: 'Makes 1 loaf · about 1 hour 10 minutes', ingredients: LEMON_INGREDIENTS, steps: LEMON_STEPS_1, uses: LEMON_USES_1 };
/** RECORDED reading of page 1 + the cook's pasted steps. */
export const LEMON_READING_WITH_PASTE = {
  ...LEMON_READING_PAGE1,
  steps: [...LEMON_STEPS_1,
    step('a4', 'Fold in the flour and lemon zest.', 'Fold in the flour', null), step('a5', 'Spoon into the tin and bake for 45–50 minutes.', 'Bake', 'BAKE'),
    step('a6', 'Mix the lemon juice with the granulated sugar.', 'Make the drizzle', null), step('a7', 'Spoon over the warm cake and cool in the tin.', 'Drizzle and cool', null)],
  uses: [...LEMON_USES_1, use('flour', 'a4', 'the flour', null, ['STRUCTURE']), use('lemons', 'a4', 'lemon zest', null, ['FLAVOR']),
    use('lemons', 'a6', 'the lemon juice', null, ['ACIDITY']), use('gran', 'a6', 'the granulated sugar', null, ['SWEETNESS'])],
};

/** Hand-written RECORDED reading of RISOTTO_LINES (test fixture; not Nova output). */
export const RISOTTO_READING = {
  recipeFound: true, title: 'Risotto with Parmesan', yield: 'Serves 4 · about 45 minutes',
  ingredients: [
    ing('stock', '900 ML unsalted vegetable stock', 'Unsalted vegetable stock', '900 ML', 'unsalted-vegetable-stock'), ing('butter', '60 g butter', 'Butter', '60 g', 'unsalted-butter'),
    ing('onion', '1 onion, finely chopped', 'Onion', '1', 'onion'), ing('garlic', '1 clove garlic, minced', 'Garlic', '1 clove', 'garlic'),
    ing('rice', '300 g Arborio rice', 'Arborio rice', '300 g', 'arborio-rice'), ing('wine', '120 ML dry white wine', 'Dry white wine', '120 ML', 'dry-white-wine'),
    ing('parm', '50 g Parmesan, grated', 'Parmesan', '50 g', 'parmesan'), ing('salt', 'Salt, to taste', 'Salt', 'to taste', 'salt'),
  ],
  steps: [
    step('s1', 'Bring 900 ML unsalted vegetable stock to a simmer and keep it hot.', 'Heat the stock', 'HEAT_STOCK'),
    step('s2', 'Melt 30 g butter in a wide pan over medium heat. Add the onion and cook until soft, about 5 minutes.', 'Soften the onion', 'SOFTEN'),
    step('s3', 'Add the garlic and cook for 30 seconds.', 'Add the garlic', 'SAUTE'),
    step('s4', 'Add 300 g arborio rice and stir until the edges turn translucent, 2–3 minutes.', 'Toast the rice', 'TOAST_RICE'),
    step('s5', 'Pour in 120 ML dry white wine and stir until absorbed.', 'Add the wine', 'DEGLAZE'),
    step('s6', 'Add the hot stock a ladle at a time, stirring, until the rice is creamy and just tender, 18–20 minutes.', 'Cook with the stock', 'LADLE_STOCK'),
    step('s7', 'Off the heat, stir in 30 g butter and 50 g grated Parmesan. Season with salt.', 'Finish', 'OFF_HEAT_FINISH'),
    step('s8', 'Rest for 1 minute, then serve.', 'Rest and serve', 'REST'),
  ],
  uses: [
    use('stock', 's1', '900 ML unsalted vegetable stock', '900 ML', ['LIQUID']), use('butter', 's2', '30 g butter', '30 g', ['FAT']),
    use('onion', 's2', 'the onion', null, ['FLAVOR']), use('garlic', 's3', 'the garlic', null, ['FLAVOR']),
    use('rice', 's4', '300 g arborio rice', '300 g', ['STRUCTURE']), use('wine', 's5', '120 ML dry white wine', '120 ML', ['LIQUID', 'ACIDITY', 'FLAVOR']),
    use('stock', 's6', 'the hot stock', null, ['LIQUID']), use('butter', 's7', '30 g butter', '30 g', ['FAT']),
    use('parm', 's7', '50 g grated Parmesan', '50 g', ['FLAVOR']), use('salt', 's7', 'salt', null, ['FLAVOR']),
  ],
};

/** Verbatim copy of the retained live M2 reading of the scone PDF (.artifacts/probes/m2-replay.json). Its role guesses are
 *  wrong (dough cream "liquid · aeration", brushing cream "fat"): the role table must still produce the right roles. */
export const SCONE_PDF_READING = {"recipeFound":true,"title":"Cream Scones","yield":"Makes 8 · about 30 minutes","ingredients":[{"name":"plain flour","key":"plain_flour","line":"300 g plain flour","amountText":"300 g","kind":"plain-flour"},{"name":"caster sugar","key":"caster_sugar","line":"40 g caster sugar","amountText":"40 g","kind":null},{"name":"baking powder","key":"baking_powder","line":"1 tbsp baking powder","amountText":"1 tbsp","kind":"baking-powder"},{"name":"salt","key":"salt","line":"½ tsp salt","amountText":"½ tsp","kind":"salt"},{"name":"heavy cream","key":"heavy_cream","line":"300 ML heavy cream","amountText":"300 ML","kind":"heavy-cream"}],"steps":[{"technique":"PREHEAT","text":"Heat the oven to 220 °C and line a tray.","title":"Preheat oven","key":"step_1"},{"technique":"COMBINE_DRY","text":"Whisk the flour, sugar, baking powder and salt.","title":"Combine dry ingredients","key":"step_2"},{"technique":"MIX_DOUGH","text":"Stir in the cream, keeping back a little for brushing, until a soft dough forms.","title":"Mix dough","key":"step_3"},{"technique":"SHAPE","text":"Pat to 2 cm thick and cut 8 rounds.","title":"Shape scones","key":"step_4"},{"technique":"TRAY","text":"Place on the tray, spaced apart.","title":"Arrange on tray","key":"step_5"},{"technique":"BRUSH","text":"Brush the tops with a little cream.","title":"Brush tops","key":"step_6"},{"technique":"BAKE","text":"Bake for 12–15 minutes, until golden.","title":"Bake scones","key":"step_7"}],"uses":[{"ingredientKey":"plain_flour","stepKey":"step_2","quote":"the flour","amountText":null,"functions":["STRUCTURE"]},{"ingredientKey":"caster_sugar","stepKey":"step_2","quote":"the sugar","amountText":null,"functions":["SWEETNESS"]},{"ingredientKey":"baking_powder","stepKey":"step_2","quote":"the baking powder","amountText":null,"functions":["LEAVENING"]},{"ingredientKey":"salt","stepKey":"step_2","quote":"the salt","amountText":null,"functions":["FLAVOR"]},{"ingredientKey":"heavy_cream","stepKey":"step_3","quote":"the cream","amountText":null,"functions":["LIQUID","AERATION"]},{"ingredientKey":"heavy_cream","stepKey":"step_6","quote":"a little cream","amountText":"a little","functions":["FAT"]}]};
/** Verbatim copy of the retained live M2 reading of SHORTCAKE_LINES (pasted text). */
export const SHORTCAKE_READING = {"recipeFound":true,"title":"Strawberry Shortcake","yield":"Serves 6 · about 1 hour","ingredients":[{"name":"plain flour","key":"plain_flour_1","line":"250 g plain flour","amountText":"250 g","kind":"plain-flour"},{"name":"sugar","key":"sugar_2","line":"45 g sugar","amountText":"45 g","kind":"white-sugar"},{"name":"baking powder","key":"baking_powder_3","line":"2 tsp baking powder","amountText":"2 tsp","kind":"baking-powder"},{"name":"salt","key":"salt_4","line":"½ tsp salt","amountText":"½ tsp","kind":"salt"},{"name":"butter","key":"butter_5","line":"85 g cold butter, cubed","amountText":"85 g","kind":"unsalted-butter"},{"name":"heavy cream","key":"heavy_cream_6","line":"420 ML heavy cream","amountText":"420 ML","kind":"heavy-cream"},{"name":"strawberries","key":"strawberries_7","line":"500 g strawberries, sliced","amountText":"500 g","kind":"strawberry"}],"steps":[{"technique":"PREHEAT","text":"Heat the oven to 220 °C and line a baking tray.","title":"Preheat oven","key":"step_1"},{"technique":"COMBINE_DRY","text":"Whisk 250 g flour, 30 g sugar, 2 tsp baking powder and ½ tsp salt.","title":"Combine dry ingredients","key":"step_2"},{"technique":"RUB_IN","text":"Rub in 85 g cold butter until the mixture looks like coarse crumbs.","title":"Rub in butter","key":"step_3"},{"technique":"MIX_DOUGH","text":"Stir in 180 ML heavy cream until just combined.","title":"Add cream to dough","key":"step_4"},{"technique":"SHAPE","text":"Pat into 6 rounds and bake for 15 minutes. Cool on a rack.","title":"Shape and bake","key":"step_5"},{"technique":"WHIP","text":"Whip 240 ML heavy cream with 15 g sugar to soft peaks.","title":"Whip cream","key":"step_6"},{"technique":"ASSEMBLE","text":"Split the shortcakes and fill with the strawberries and whipped cream.","title":"Assemble shortcakes","key":"step_7"}],"uses":[{"ingredientKey":"plain_flour_1","stepKey":"step_2","quote":"250 g flour","amountText":"250 g","functions":["STRUCTURE"]},{"ingredientKey":"sugar_2","stepKey":"step_2","quote":"30 g sugar","amountText":"30 g","functions":["SWEETNESS"]},{"ingredientKey":"baking_powder_3","stepKey":"step_2","quote":"2 tsp baking powder","amountText":"2 tsp","functions":["LEAVENING"]},{"ingredientKey":"salt_4","stepKey":"step_2","quote":"½ tsp salt","amountText":"½ tsp","functions":["FLAVOR"]},{"ingredientKey":"butter_5","stepKey":"step_3","quote":"85 g cold butter","amountText":"85 g","functions":["FAT"]},{"ingredientKey":"heavy_cream_6","stepKey":"step_4","quote":"180 ML heavy cream","amountText":"180 ML","functions":["LIQUID"]},{"ingredientKey":"heavy_cream_6","stepKey":"step_6","quote":"240 ML heavy cream","amountText":"240 ML","functions":["AERATION"]},{"ingredientKey":"sugar_2","stepKey":"step_6","quote":"15 g sugar","amountText":"15 g","functions":["SWEETNESS"]},{"ingredientKey":"strawberries_7","stepKey":"step_7","quote":"the strawberries","amountText":null,"functions":["FLAVOR"]}]};

/** OD-6 (owner 2026-10-07, engineering demo): the adapted scone with both cream amounts stated, exactly as its PDF prints it
 *  (private/probes/cards2/scones-explicit.pdf). */
export const SCONE_EXPLICIT_LINES = [
  'Cream Scones', 'Makes 8 · about 30 minutes',
  '300 g plain flour', '40 g caster sugar', '1 tbsp baking powder', '½ tsp salt', '315 ML heavy cream (300 ML for the dough, 15 ML for brushing)',
  '1. Heat the oven to 220 °C and line a tray.', '2. Whisk the flour, sugar, baking powder and salt.',
  '3. Stir in 300 ML heavy cream until a soft dough forms.', '4. Pat to 2 cm thick and cut 8 rounds.',
  '5. Place on the tray, spaced apart.', '6. Brush the tops with 15 ML heavy cream.', '7. Bake for 12–15 minutes, until golden.',
  'Adapted from scones.pdf (051e7d3e): cream amounts stated; 15 ML brushing cream by owner decision 2026-10-07 (engineering demo).',
];
/** Hand-written RECORDED reading of SCONE_EXPLICIT_LINES (TEST FIXTURE: proposals only; not Nova output, not reviewed). */
export const SCONE_EXPLICIT_READING = {
  recipeFound: true, title: 'Cream Scones', yield: 'Makes 8 · about 30 minutes',
  ingredients: [
    ing('flour', '300 g plain flour', 'plain flour', '300 g', 'plain-flour'), ing('sugar', '40 g caster sugar', 'caster sugar', '40 g', 'white-sugar'),
    ing('bp', '1 tbsp baking powder', 'baking powder', '1 tbsp', 'baking-powder'), ing('salt', '½ tsp salt', 'salt', '½ tsp', 'salt'),
    ing('cream', '315 ML heavy cream (300 ML for the dough, 15 ML for brushing)', 'heavy cream', '315 ML', 'heavy-cream'),
  ],
  steps: [
    step('s1', 'Heat the oven to 220 °C and line a tray.', 'Preheat oven', 'PREHEAT'), step('s2', 'Whisk the flour, sugar, baking powder and salt.', 'Combine dry ingredients', 'COMBINE_DRY'),
    step('s3', 'Stir in 300 ML heavy cream until a soft dough forms.', 'Mix dough', 'MIX_DOUGH'), step('s4', 'Pat to 2 cm thick and cut 8 rounds.', 'Shape scones', 'SHAPE'),
    step('s5', 'Place on the tray, spaced apart.', 'Arrange on tray', 'TRAY'), step('s6', 'Brush the tops with 15 ML heavy cream.', 'Brush tops', 'BRUSH'),
    step('s7', 'Bake for 12–15 minutes, until golden.', 'Bake scones', 'BAKE'),
  ],
  uses: [
    use('flour', 's2', 'the flour', null, ['STRUCTURE']), use('sugar', 's2', 'sugar', null, ['SWEETNESS']), use('bp', 's2', 'baking powder', null, ['LEAVENING']), use('salt', 's2', 'salt', null, ['FLAVOR']),
    use('cream', 's3', '300 ML heavy cream', '300 ML', ['LIQUID', 'FAT']), use('cream', 's6', '15 ML heavy cream', '15 ML', ['BROWNING']),
  ],
};

/** Drop biscuits (batch 1 browser evidence, 2026-10-08): a development recipe with milk stirred into a dough and the oven
 *  heated first. TEST FIXTURE reading (not Nova output); kept out of DEMO so the demo card tables are unchanged. */
export const DROP_LINES = ['Drop Biscuits', 'Makes 10', '250 g plain flour', '20 g caster sugar', '2 tsp baking powder', '¼ tsp salt', '200 ML milk',
  '1. Heat the oven to 220 °C.', '2. Whisk the flour, sugar, baking powder and salt.', '3. Stir in the milk until a soft dough forms.', '4. Drop onto a tray and bake for 12 minutes.'];
export const DROP_READING = {
  recipeFound: true, title: 'Drop Biscuits', yield: 'Makes 10',
  ingredients: [ing('f', '250 g plain flour', 'plain flour', '250 g', null), ing('s', '20 g caster sugar', 'caster sugar', '20 g', null), ing('b', '2 tsp baking powder', 'baking powder', '2 tsp', null),
    ing('t', '¼ tsp salt', 'salt', '¼ tsp', null), ing('m', '200 ML milk', 'milk', '200 ML', null)],
  steps: [step('s0', 'Heat the oven to 220 °C.', 'Heat oven', 'PREHEAT'), step('s1', 'Whisk the flour, sugar, baking powder and salt.', 'Mix dry', 'COMBINE_DRY'),
    step('s2', 'Stir in the milk until a soft dough forms.', 'Mix dough', 'MIX_DOUGH'), step('s3', 'Drop onto a tray and bake for 12 minutes.', 'Bake', 'BAKE')],
  uses: [use('f', 's1', 'the flour', null, ['STRUCTURE']), use('s', 's1', 'sugar', null, ['SWEETNESS']), use('b', 's1', 'baking powder', null, ['LEAVENING']), use('t', 's1', 'salt', null, ['FLAVOR']), use('m', 's2', 'the milk', null, ['LIQUID'])],
};
