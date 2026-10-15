// Successive substitutions through the real companion (commission 2026-10-11): two changes to the same dry-mix step compose on
// screen, the cumulative recipe shows both, and an ingredient a change brought in can itself be reported missing. Tapped
// requests only (no interpreter). Admin reset is used only to make another session active at the start.
import { expect, test, type Page } from '@playwright/test';

const SHOTS = '.artifacts/evidence/successive-2026-10-11';
const scr = (page: Page) => page.locator('[data-testid=screen], main:not(:has([data-testid=screen]))');
/** An ingredient's card in the Ingredients tab (the innermost element with its name and its own button). */
const ingCard = (page: Page, name: string) => page.locator('nav div').filter({ has: page.getByText(name, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'I don’t have this' }) }).last();
async function startScones(page: Page) {
  expect((await page.request.post('/admin/reset', { headers: { authorization: 'Bearer e2e-admin-key' }, data: { fixtureId: 'risotto.step5' } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: /Cream Scones/ }).filter({ hasText: 'CourseCorrect recipe' }).first().click();
  await page.getByRole('button', { name: 'Start cooking' }).click();
  await page.getByRole('button', { name: /^End it and start/ }).click();
  await expect(scr(page).getByText(/^Step 1 of \d+/)).toBeVisible();
}
/** Ingredients tab → "I don't have this" on `name` → every availability question Yes → Use this change. */
async function outOf(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Ingredients' }).click();
  await ingCard(page, name).getByRole('button', { name: 'I don’t have this' }).click();
  const yes = page.getByTestId('question').getByRole('button', { name: 'Yes', exact: true }).first(), done = page.getByTestId('consequence');
  for (let i = 0; i < 4; i++) {
    await expect(done.or(yes)).toBeVisible();
    if (await done.isVisible()) return;
    await yes.click();
  }
  await expect(done).toBeVisible();
}

test('two changes in the dry-mix step compose; the cumulative recipe shows both; an introduced ingredient can be reported missing', async ({ page }) => {
  await startScones(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(scr(page).getByText(/^Step 2 of \d+/)).toBeVisible();

  await outOf(page, 'Caster sugar');
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText(/Change applied\. Step 2 is ready, not started/)).toBeVisible();

  await outOf(page, 'Baking powder');
  // the proposal is computed on the step as the first change left it, and says it keeps that change
  await expect(page.getByTestId('change-2')).toContainText('40 g granulated sugar');
  await expect(page.getByText('Keeps your earlier change: granulated sugar for caster sugar in a dry mix.')).toBeVisible();
  await page.waitForTimeout(600);   // let the proposal finish its entrance before the evidence screenshot
  await page.screenshot({ path: `${SHOTS}/1-second-change-keeps-the-first.png` });
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText(/Change applied\. Step 2 is ready, not started/)).toBeVisible();
  await expect(page.getByTestId('current-step')).toHaveText('Whisk the flour, 40 g granulated sugar, ¾ tsp baking soda, salt and 1½ tsp cream of tartar. Have the oven hot before the liquid goes in: once the dough is wet, the baking soda and cream of tartar start working, so shape it and bake it straight away, without resting or chilling it.');

  // the ingredients the changes brought in are listed as such, and can themselves be reported missing
  await page.getByRole('tab', { name: 'Ingredients' }).click();
  await expect(page.getByTestId('introduced')).toHaveCount(3);   // granulated sugar, baking soda, cream of tartar
  const soda = ingCard(page, 'Baking soda');
  await expect(soda.getByTestId('introduced')).toHaveText(' · from your change (instead of the baking powder)');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/2-cumulative-recipe-introduced-ingredients.png` });
  await soda.getByRole('button', { name: 'I don’t have this' }).click();
  // no reviewed change for baking soda as it's used now: said plainly, and both earlier changes stay
  await expect(page.getByTestId('refusal-answer')).toBeVisible();
  await expect(scr(page).getByText(/Your recipe is unchanged/).first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/3-introduced-ingredient-missing-refused.png` });
  const run = await page.request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_active_recipe', arguments: {} } } });
  const active = ((await run.json()) as { result: { structuredContent: { run: { appliedAmendments: unknown[]; version: number } } } }).result.structuredContent.run;
  expect([active.appliedAmendments.length, active.version]).toEqual([2, 3]);
});
