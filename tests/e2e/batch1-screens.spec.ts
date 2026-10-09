// Batch 1 browser evidence (OD-7, 2026-10-08): positive reviewed plans and scoped refusals in the existing import-review
// matrix and detail, on the real companion (CC_ANALYZER=recorded test fixtures; no paid calls). Screenshots go to
// .artifacts/e2e/shots/batch1-*.png (git-ignored). The drop-biscuit reading and cards are TEST FIXTURES, not Nova output.
import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../fixtures/pdf.ts';
import { DROP_LINES } from '../fixtures/demo-sources.ts';

const shot = async (page: Page, name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: `.artifacts/e2e/shots/batch1-${name}.png` }); };
const cell = (page: Page, re: RegExp) => page.getByRole('button', { name: re });

test('batch 1: drop biscuits (import) → B6 / B7 / B8 plans; shortcake (approved) → B3 / B4 / B5 / D-5 listed as one swap each', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const r = await page.request.post('/admin/reset', { headers: { authorization: 'Bearer e2e-admin-key' }, data: { fixtureId: 'risotto.step5' } });
  expect(r.ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles({ name: 'drop-biscuits.pdf', mimeType: 'application/pdf', buffer: Buffer.from(makePdf([{ lines: [...DROP_LINES] }])) });
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await page.getByRole('button', { name: 'Skip to results' }).click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByText('How drop-biscuits.pdf was read')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('analysis-summary')).toHaveText('● 3 Alternative available◐ 1 Omission available⊘ 1 Drafted swap not offered');
  await shot(page, '01-drop-matrix');

  // B7: both ingredients, both amounts and the mixing, written into the step by the server
  await cell(page, /^milk, step 3:/i).click();
  await expect(page.getByTestId('swap')).toHaveText('Evaporated milk and water for milk in a dough');
  await expect(page.getByTestId('swap-label')).toHaveText('Reviewed change');
  await expect(page.getByTestId('replacement').filter({ hasText: 'Evaporated milk' })).toContainText('100 ML');
  await expect(page.getByTestId('replacement').filter({ hasText: 'Water' })).toContainText('100 ML');
  await expect(page.getByTestId('would-read-3')).toContainText('Stir in 100 ML evaporated milk mixed with 100 ML water until a soft dough forms.');
  await shot(page, '02-b7-evaporated-milk');

  // B8: the ATK selection in spoons, the timing note in the dry-mix step, and two scoped refusals listed beside it
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^baking powder, step 2:/i).click();
  await expect(page.getByTestId('swap')).toHaveText('Baking soda and cream of tartar for baking powder');
  await expect(page.getByTestId('replacement').filter({ hasText: 'Baking soda' })).toContainText('½ tsp');
  await expect(page.getByTestId('replacement').filter({ hasText: 'Cream of tartar' })).toContainText('1 tsp');
  await expect(page.getByTestId('would-read-2')).toContainText('shape it and bake it straight away, without resting or chilling it');
  await expect(page.getByTestId('ruled-out-item')).toHaveCount(2);
  await expect(page.getByTestId('ruled-out')).toContainText('Baking soda on its own can’t stand in'.replace('’', "'"));
  await shot(page, '03-b8-soda-cream-of-tartar');

  // B6: same weight, the grain-size consequence kept
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^caster sugar, step 2:/i).click();
  await expect(page.getByTestId('swap')).toHaveText('Granulated sugar for caster sugar in a dry mix');
  await expect(page.getByTestId('replacement').filter({ hasText: 'Granulated sugar' })).toContainText('20 g');
  await expect(page.getByTestId('import-consequence')).toContainText('UK granulated sugar is coarser still');
  await shot(page, '04-b6-caster-to-granulated');

  // the flour: the AI drafted oat flour for all of it; D-5 answers that one draft (kept, with its reasons), not the flour itself
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^plain flour, step 2:/i).click();
  await expect(page.getByTestId('answer-card')).toContainText('⊘ Drafted swap not offered');
  await expect(page.getByTestId('swap')).toContainText('The alternative drafted at import (oat flour for the plain flour) isn’t offered.');
  await expect(page.getByTestId('answer-card')).toContainText('It isn’t a finding that nothing else could work.');
  await expect(page.getByTestId('swap')).toContainText("CourseCorrect doesn't offer oat flour in place of all the flour");
  await expect(page.getByTestId('swap')).toContainText("It isn't a verdict on oat-flour recipes or on using some oat flour.");
  await expect(page.getByTestId('ruled-out')).toHaveCount(0);   // its rule is quoted once, in the answer
  await shot(page, '05-d5-drafted-oat-flour-not-offered');

  // the approved shortcake: B4, B3 and B5 answer one swap each beside the use's own status
  await page.getByRole('button', { name: 'Recipe Book', exact: true }).click();
  await page.getByRole('button', { name: /^Strawberry Shortcake/ }).click();
  await cell(page, /^Cold butter, cubed, step 3:/i).click();
  await expect(page.getByTestId('ruled-out')).toContainText("Oil can't stand in for the cold butter rubbed into this dough");
  await shot(page, '06-b4-oil-ruled-out');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^Heavy cream, step 6:/i).click();
  await expect(page.getByTestId('ruled-out-item')).toHaveCount(2);
  await expect(page.getByTestId('ruled-out')).toContainText("This catalog doesn't accept half-and-half or light cream");
  await shot(page, '07-b3-whip-ruled-out');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^Sugar, step 2:/i).click();
  await expect(page.getByTestId('ruled-out')).toContainText("Powdered (icing) sugar can't simply replace the sugar in this dough's dry mix");
  await shot(page, '08-b5-powdered-sugar-ruled-out');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await cell(page, /^Sugar, step 6:/i).click();
  await expect(page.getByTestId('ruled-out')).toHaveCount(0);   // the whipped-cream sugar: B5 doesn't reach it
  await shot(page, '09-whip-sugar-not-ruled-out');
});
