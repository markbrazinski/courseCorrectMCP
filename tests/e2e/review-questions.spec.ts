// Import review (2026-10-13): the cook answers a question about their recipe and a reviewed change applies; a page with two
// recipes asks which one to read. Scripted readings (tests/fixtures/review-questions.ts); every plan from content/approved.
import { expect, test, type Page } from '@playwright/test';
import { CHOWDER_LINES, FISH_CHOWDER_LINES, POPOVER_LINES } from '../fixtures/review-questions.ts';

async function paste(page: Page, lines: readonly string[]) {
  await page.goto('/');
  await page.getByRole('button', { name: /Add a recipe/i }).first().click();
  await page.getByRole('button', { name: /paste the recipe text/i }).click();
  await page.getByRole('textbox', { name: 'Recipe text' }).fill(lines.join('\n'));
  await page.getByRole('button', { name: 'Read this recipe' }).click();
}

test('one question in the recipe’s words; “Yes” lets the reviewed change apply to that use', async ({ page }) => {
  await paste(page, POPOVER_LINES);
  const q = page.getByTestId('review-question');
  await expect(q).toHaveCount(1, { timeout: 30_000 });
  await expect(q).toContainText('In step 1, is the milk used to mix dough?');
  await expect(q).toContainText('Your recipe: “Mix salt and flour; add milk gradually, in order to obtain a smooth batter.”');
  await q.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByTestId('questions')).toHaveCount(0);
  await page.getByRole('button', { name: /^milk, step 1: Alternative available/ }).click();
  await expect(page.getByTestId('swap-label')).toHaveText('Reviewed change');
  await page.getByRole('button', { name: 'Plan details' }).click();
  await expect(page.getByTestId('plan-details')).toContainText('confirmed by you for this recipe');
});

test('a page with two recipes: none is read until the cook chooses; the chosen one opens', async ({ page }) => {
  await paste(page, CHOWDER_LINES);
  const choice = page.getByTestId('recipe-choice');
  await expect(choice).toContainText('This document holds 2 recipes. Which one do you want?');
  await choice.getByRole('button', { name: 'Connecticut Chowder' }).click();
  await expect(page.getByText('Connecticut Chowder', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

test('a printed either/or line is one ingredient; the cook picks one before saving and the recipe uses it', async ({ page }) => {
  await paste(page, FISH_CHOWDER_LINES);
  const choice = page.getByTestId('option-choice');
  await expect(choice).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText('Your recipe gives a choice: “6 cups potatoes cut in 1/4-inch slices, or 4 cups potatoes cut in 3/4-inch cubes”. Which will you use?')).toBeVisible();
  await choice.getByRole('button', { name: '4 cups potatoes cut in 3/4-inch cubes' }).click();
  await expect(page.getByTestId('option-choice')).toHaveCount(0);
  await expect(page.getByText('potatoes cut in 3/4-inch cubes').first()).toBeVisible();
});
