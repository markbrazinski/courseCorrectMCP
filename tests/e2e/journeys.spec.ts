// Connected journeys through the real companion, real MCP tools and the real engine (RECORDED interpretation; replayed
// M2 extraction readings). Admin reset is used only to make "another session is active" true at the start of a test;
// everything a cook does goes through the product's own controls.
import { expect, test, type Page } from '@playwright/test';
import { LEMON_PAGE1, LEMON_PASTED, RISOTTO_LINES, SCONE_LINES, SHORTCAKE_LINES } from '../fixtures/demo-sources.ts';
import { makePdf, scanImage } from '../fixtures/pdf.ts';

// The same bytes the M2 probe froze; extraction replays the retained M2 readings (.artifacts/probes/m2-replay.json).
const pdf = (name: string, pages: Parameters<typeof makePdf>[0]) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(makePdf(pages)) });

/** The visible screen, excluding the voice bar's "Last said" line and the Activity column. */
const scr = (page: Page) => page.locator('[data-testid=screen], main:not(:has([data-testid=screen]))');
async function reset(page: Page, fixtureId: string) {
  const r = await page.request.post('/admin/reset', { headers: { authorization: 'Bearer e2e-admin-key' }, data: { fixtureId } });
  expect(r.ok()).toBeTruthy();
}
async function mcp(page: Page, name: string, args: Record<string, unknown> = {}) {
  const r = await page.request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return ((await r.json()) as { result: { structuredContent: Record<string, any> } }).result.structuredContent;   // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** Book → recipe page → Start cooking; confirms ending the other session when the product asks (C-3). */
async function start(page: Page, row: RegExp, hasText?: string) {
  await page.goto('/');
  let r = page.getByRole('button', { name: row });
  if (hasText) r = r.filter({ hasText });
  await r.first().click();
  await page.getByRole('button', { name: 'Start cooking' }).click();
  const end = page.getByRole('button', { name: /^End it and start/ });
  await expect(end).toBeVisible();
  await end.click();
  await expect(scr(page).getByText(/^Step 1 of \d+/)).toBeVisible();
}
async function doneThrough(page: Page, n: number) {
  for (let i = 1; i <= n; i++) {
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(scr(page).getByText(new RegExp(`^Step ${i + 1} of \\d+`))).toBeVisible();
  }
}
async function say(page: Page, text: string) {
  await page.getByLabel('Type a request').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}
async function risottoProposal(page: Page) {
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await doneThrough(page, 4);
  await say(page, 'I don’t have any white wine. Can I use lemon juice?');
  await expect(page.getByTestId('question')).toContainText('120 ML more hot unsalted vegetable stock');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('consequence')).toBeVisible();
}

test('Risotto rescue: question → yes → proposal (consequence beside acceptance) → apply → resumed cooking', async ({ page }) => {
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await doneThrough(page, 4);
  await expect(page.getByTestId('current-step')).toHaveText('Pour in 120 ML dry white wine and stir until absorbed.');
  await say(page, 'I don’t have any white wine. Can I use lemon juice?');
  await expect(page.getByTestId('heard')).toHaveText('You typed: “I don’t have any white wine. Can I use lemon juice?”');
  await expect(page.getByTestId('understood')).toHaveText('Dry white wine · step 5, 120 ML');
  await expect(page.getByRole('button', { name: 'Not this ingredient' })).toBeVisible();
  const q = page.getByTestId('question');
  await expect(q).toContainText('120 ML more hot unsalted vegetable stock');
  await expect(q).toContainText('10 ML lemon juice');
  await expect(scr(page).getByText('The 900 ML unsalted vegetable stock already in the recipe stays reserved for step 6.')).toBeVisible();
  await expect(scr(page).getByText('Answering doesn’t change your recipe.')).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.getByTestId('change-5')).toHaveText('Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.');
  await expect(page.getByTestId('change-5').locator('mark')).toHaveText('hot unsalted vegetable stock');
  await expect(scr(page).getByText('900 ML stock still reserved here')).toBeVisible();
  await expect(page.getByTestId('change-7')).toHaveText('Off the heat, stir in 30 g butter, 50 g grated Parmesan and 10 ML lemon juice. Season with salt.');
  await expect(page.getByTestId('change-7').locator('mark')).toHaveText(['and 10 ML lemon juice']);   // the comma is not marked
  const consequence = page.getByTestId('consequence'), use = page.getByRole('button', { name: 'Use this change', exact: true });
  await expect(consequence).toHaveText("The risotto will taste different, and it won't have the aroma of white wine.");
  await expect(consequence).toBeInViewport();
  await expect(use).toBeInViewport();
  await expect(scr(page).getByText('Proposed change · not applied')).toBeVisible();
  await expect(scr(page).getByText(/Engineering content · provisional quantities · not released cooking guidance/)).toBeVisible();
  await expect(scr(page).getByText('After you accept: step 5, not started until you report it.')).toBeVisible();
  await page.screenshot({ path: '.artifacts/e2e/shots/risotto-proposal-1440.png' });

  await use.click();
  await expect(scr(page).getByText(/Change applied\. Step 5 is ready, not started/)).toBeVisible();
  await expect(scr(page).getByText('Step 5 of 8 · Add the stock')).toBeVisible();
  await expect(page.getByTestId('current-step')).toHaveText('Pour in 120 ML hot unsalted vegetable stock and stir until absorbed.');
  await expect(scr(page).getByText('You marked: Not started')).toBeVisible();
  await expect(scr(page).getByText('✓ Changed', { exact: true })).toBeVisible();
  // what the voice bar says is the changed instruction, never the old one (the server speaks the same text)
  await expect(page.getByTestId('voice-state')).toContainText('Change applied. Step 5. Pour in 120 ML hot unsalted vegetable stock');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(scr(page).getByText(/^Step 6 of 8/)).toBeVisible();
  // the second rescue in one session is refused by the engine, not the client
  await say(page, 'I don’t have any white wine. Can I use lemon juice?');
  await expect(scr(page).getByText(/isn’t needed anymore|already used its change/)).toBeVisible();
  // real MCP activity, recorded by the server
  const act = page.getByRole('complementary', { name: 'Activity' });
  await expect(act.getByTestId('activity-entry').filter({ hasText: 'apply_amendment' }).filter({ hasText: 'Applied' })).toHaveCount(1);
  await expect(act.getByTestId('activity-entry').filter({ hasText: 'record_progress' }).first()).toBeVisible();
});

test('Interpreted ingredient has an obvious correction route (Not this ingredient)', async ({ page }) => {
  await risottoProposal(page);
  await page.getByRole('button', { name: 'Not this ingredient' }).click();
  await expect(page.getByRole('group', { name: 'Which ingredient is missing' })).toBeVisible();
  await page.getByRole('group', { name: 'Which ingredient is missing' }).getByRole('button', { name: 'Unsalted vegetable stock' }).first().click();
  await expect(page.getByTestId('understood')).toContainText(/stock/i);
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^No\. There's no reviewed swap for the stock/);
  await expect(scr(page).getByText(/It isn’t a judgement that nothing else could work/)).toBeVisible();
});

test('Shortcake refusal: not supported for whipping, recipe unchanged, no Apply', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await start(page, /Strawberry Shortcake/);
  await doneThrough(page, 5);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter to whip instead?');
  await expect(scr(page).getByText('✕ Not supported for this use')).toBeVisible();
  await expect(scr(page).getByText('✕ No reviewed change for this use')).toBeVisible();
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^No\. /);                          // the decision, in words
  await expect(page.getByTestId('refusal-reason')).toContainText('milk and butter can\'t whip');   // the engine's reasons
  await expect(page.getByTestId('refusal-reason')).toContainText('This catalog doesn\'t accept milk and butter in place of cream that has to be whipped');
  await expect(scr(page).getByText(/Step 6 still needs 240 ML heavy cream/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toHaveCount(0);
  await expect(scr(page).getByText(/Already done/).first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/shortcake-step6-refusal.png' });
  await page.getByRole('button', { name: 'Back to step 6 as written' }).click();
  await expect(scr(page).getByText('Your recipe is unchanged.')).toBeVisible();
});

test('Shortcake step 4: "No", because the same cream must whip in step 6 (reasons from the engine)', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await start(page, /Strawberry Shortcake/);
  await doneThrough(page, 3);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter?');
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^No\. /);
  const why = page.getByTestId('refusal-reason');
  await expect(why).toContainText(/step 6 \(whipped topping\)/);
  await expect(why).toContainText('milk and butter can\'t whip');
  await expect(why).toContainText(/In step 4 .*milk and butter can do that job/);
  await expect(scr(page).getByText('Milk and butter: step 4: would work on its own, step 6: no')).toBeVisible();
  await expect(scr(page).getByText(/no change has been reviewed for this use/)).toHaveCount(0);   // a rule was reviewed; it can't cover step 6
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toHaveCount(0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/shortcake-step4-refusal.png' });
});

test('Scone recovery (approved demo): brushing milk confirmed separately → apply → step 3 not started', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await start(page, /Cream Scones/, 'Owner-authored');
  await doneThrough(page, 2);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter?');
  const qs = page.getByTestId('question');
  await expect(qs).toHaveCount(2);
  await expect(qs.nth(0)).toContainText('85 g cold butter');
  await expect(qs.nth(1)).toContainText('A little more milk for step 6 (Brush the tops) — amount not stated');
  await qs.nth(0).getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(qs.nth(0)).toContainText('You answered: Yes');
  await expect(page.getByTestId('consequence')).toHaveCount(0);       // the other question still needs its own answer
  await qs.nth(1).getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('change-3')).toContainText('Rub 85 g cold butter');
  await expect(page.getByTestId('change-6')).toHaveText('Brush the tops with a little milk.');
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText(/Change applied\. Step 3 is ready, not started/)).toBeVisible();
  await expect(page.getByTestId('current-step')).toContainText('180 ML milk');
  await expect(scr(page).getByText('You marked: Not started')).toBeVisible();
});

test('A-8 protected work: Not now → I’ve started → stale → Check again → refused, recipe unchanged', async ({ page }) => {
  await risottoProposal(page);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(scr(page).getByText('A proposed change is waiting.')).toBeVisible();
  await page.getByRole('button', { name: 'I’ve started' }).click();
  await expect(scr(page).getByText('You marked: Started')).toBeVisible();
  await page.getByRole('button', { name: 'Review it' }).click();
  await expect(scr(page).getByText('You’ve reported progress since this was checked.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^Not right now\. Step \d+ is marked started/);
  await expect(scr(page).getByText(/You marked step 5/)).toContainText('started');
});

test('A-12/A-13 lost apply response: unknown → hold survives reload → Check status (read-only) → applied', async ({ page }) => {
  await risottoProposal(page);
  let dropped = false;
  await page.route('**/mcp', async (route) => {
    if (!dropped && (route.request().postData() ?? '').includes('"apply_amendment"')) { dropped = true; await route.fetch(); await route.abort('failed'); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText('We can’t confirm whether the change was saved')).toBeVisible();
  await page.reload();
  await expect(scr(page).getByText('We can’t confirm whether the change was saved')).toBeVisible();   // reconciliation offered before any cooking control
  await page.getByRole('button', { name: /See my steps/ }).click();
  await expect(scr(page).getByText('Hold step 5 until we confirm which version is saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check status' }).first().click();
  await expect(scr(page).getByText(/Change applied\. Step 5 is ready/)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Activity' }).getByText('Status check · applied').first()).toBeVisible();
  const run = (await mcp(page, 'get_active_recipe')).run;
  const calls = (await (await page.request.get(`/activity?runId=${run.id}`)).json()).entries as { name: string; status: string }[];
  expect(calls.filter((c) => c.name === 'apply_amendment')).toHaveLength(1);   // sent once, applied once
  expect(run.appliedAmendments).toHaveLength(1);
});

test('C-1 unknown → Retry confirmation resends the same commandId and applies at most once', async ({ page }) => {
  await risottoProposal(page);
  let dropped = false;
  const sent: string[] = [];
  await page.route('**/mcp', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"apply_amendment"')) sent.push(JSON.parse(body).params.arguments.commandId);
    if (!dropped && body.includes('"apply_amendment"')) { dropped = true; await route.fetch(); await route.abort('failed'); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText('We can’t confirm whether the change was saved')).toBeVisible();
  await page.getByRole('button', { name: 'Retry confirmation' }).click();
  await expect(scr(page).getByText(/Change applied\. Step 5 is ready/)).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0]).toBe(sent[1]);
  const run = (await mcp(page, 'get_active_recipe')).run;
  expect(run.appliedAmendments).toHaveLength(1);
});

test('C-1 confirmed not applied → shows the reason → Re-check the change (new evaluation)', async ({ page }) => {
  await risottoProposal(page);
  const a = (await mcp(page, 'get_active_recipe')).run;
  const step5 = a.steps[4].stepId;
  // another client reports step 5 started after the proposal was shown
  await mcp(page, 'record_progress', { commandId: crypto.randomUUID(), runId: a.id, epoch: a.epoch, expectedRevision: a.revision, stepId: step5, progress: 'started' });
  await page.route('**/mcp', async (route) => {
    if ((route.request().postData() ?? '').includes('"apply_amendment"')) { await route.fetch(); await route.abort('failed'); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText('We can’t confirm whether the change was saved')).toBeVisible();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(scr(page).getByText('The change wasn’t applied')).toBeVisible();
  await expect(scr(page).getByText(/Your progress changed after the change was checked/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply the same change/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Re-check the change' }).click();
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^Not right now\. Step \d+ is marked started/);
});

test('C-2 several candidates are never chosen silently (UI check, stubbed evaluation; engine evidence is SYN-D)', async ({ page }) => {
  await page.route('**/mcp', async (route) => {
    if (!(route.request().postData() ?? '').includes('"evaluate_rescue"')) return route.continue();
    const res = await route.fetch();
    const j = await res.json();
    const sc = j.result.structuredContent;
    if (sc.outcome === 'proposal') sc.candidates = [sc.candidates[0], { ...sc.candidates[0], id: 'stub-second', planId: 'stub', headline: 'A second reviewed change (stub)' }];
    await route.fulfill({ response: res, json: j });
  });
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await doneThrough(page, 4);
  await say(page, 'I don’t have any white wine. Can I use lemon juice?');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Choose a change' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toHaveCount(0);
  await expect(scr(page).getByText('Choose a change to see what it does.')).toBeVisible();
  await page.getByRole('radio', { name: /A second reviewed change/ }).click();
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toBeVisible();
});

test('A-1 PDF import → swap plan shown at reading (no confirmations, no owner screen) → save → start → rescue on the imported scone', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles(pdf('scones.pdf', [{ lines: SCONE_LINES }]));
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await expect(scr(page).getByText('How scones.pdf was read')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Activity' }).getByText('Import · web requests, not MCP')).toBeVisible();
  await page.getByRole('button', { name: 'Skip the animation' }).click({ timeout: 3000 }).catch(() => undefined);
  await expect(scr(page).getByText('✓ Swaps worked out')).toBeVisible();
  await expect(page.getByRole('region', { name: 'If you run out' })).toHaveCount(0);   // owner: no summary panel
  await expect(scr(page).getByText(/Heavy cream is used in more than one step: step 3 \(liquid · fat\), step 6 \(browning\)/i)).toBeVisible();
  await expect(scr(page).getByText('◆ swap ready')).toHaveCount(1);
  await page.getByRole('button', { name: /heavy cream, step 3/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('If you run out: Butter and milk for cream in a dough');
  await expect(scr(page).getByText('Step 3: 85 g cold butter')).toBeVisible();                      // calculated amounts on the selected use
  await expect(scr(page).getByText('liquid · aeration · not used')).toBeVisible();   // the import's wrong guess, shown, never used
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/import-canvas.png' });
  await expect(page.getByRole('button', { name: /owner review/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Save to Recipe Book|Save changes as a new version/ }).click();
  await expect(scr(page).getByText('Saved to your Recipe Book. You can start cooking.')).toBeVisible();
  await expect(scr(page).getByText('Reviewed change on file: heavy cream, step 3')).toBeVisible();
  await page.screenshot({ path: '.artifacts/e2e/shots/import-recipe-page.png', fullPage: true });
  await page.getByRole('button', { name: 'Start cooking' }).click();
  await page.getByRole('button', { name: /^End it and start/ }).click();
  await expect(scr(page).getByText(/^Step 1 of 7/)).toBeVisible();
  await doneThrough(page, 2);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter?');
  // the recorded interpreter knows only the demo recipe's ids, so the reference is asked, not guessed
  await page.getByRole('group', { name: 'Which ingredient is missing' }).getByRole('button', { name: /heavy cream/i }).click();
  const qs = page.getByTestId('question');
  await expect(qs).toHaveCount(2);
  await qs.nth(0).getByRole('button', { name: 'Yes', exact: true }).click();
  await qs.nth(1).getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('change-6')).toHaveText('Brush the tops with a little milk.');
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText(/Change applied\. Step 3 is ready, not started/)).toBeVisible();
});

/** Import a demo PDF through the product (recorded reading + RECORDED card fixtures), then save it. */
async function importDemo(page: Page, name: string, lines: string[]) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles(pdf(`${name}.pdf`, [{ lines }]));
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await page.getByRole('button', { name: 'Skip the animation' }).click({ timeout: 3000 }).catch(() => undefined);
  await expect(scr(page).getByText('✓ Swaps worked out')).toBeVisible();
}
async function saveAndStart(page: Page) {
  await page.getByRole('button', { name: /Save to Recipe Book|Save changes as a new version/ }).click();
  await expect(scr(page).getByText('Saved to your Recipe Book. You can start cooking.')).toBeVisible();
  await expect(scr(page).getByText(/Prepared at import \(AI\): a card for (\d+) of \1 uses/)).toBeVisible();   // every use has a valid card
  await page.getByRole('button', { name: 'Start cooking' }).click();
  await page.getByRole('button', { name: /^End it and start/ }).click();   // each test starts from a reset, so a session is active
  await expect(scr(page).getByText(/^Step 1 of \d+/)).toBeVisible();
}

test('Import cards: every use of the shortcake has an answer, labelled AI; a "no" says why (canvas and cooking)', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await importDemo(page, 'shortcake', SHORTCAKE_LINES);
  await expect(scr(page).getByText('◇ swap (AI)')).toHaveCount(3);                                // salt, sugar (step 6), strawberries
  await page.getByRole('button', { name: /strawberries, step 7/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('If you run out: Raspberries for the strawberries');
  await expect(page.getByTestId('swap-label')).toHaveText('Prepared at import (AI)');
  await expect(page.getByTestId('swap-opinion')).toHaveText('“Fill the shortcakes with 500 g raspberries instead of the strawberries.”');
  await expect(scr(page).getByText('Step 7: 500 g raspberries')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/import-card-selected.png' });
  await page.getByRole('button', { name: /heavy cream, step 4/i }).click();
  await expect(page.getByTestId('swap')).toHaveText("No for now: The cream is also whipped in step 6, and milk and butter can't be whipped.");
  await page.getByRole('button', { name: /baking powder, step 2/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('No, because the baking powder makes the shortcakes rise; without it they bake flat and dense.');
  await expect(page.getByTestId('swap-label')).toHaveText('Prepared at import (AI)');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/import-card-no.png' });
  await saveAndStart(page);
  await doneThrough(page, 5);
  await say(page, 'I’m out of heavy cream. What can I use?');
  // the recorded interpreter knows only the fixture recipe's ids, so the reference is asked, not guessed
  await page.getByRole('group', { name: 'Which ingredient is missing' }).getByRole('button', { name: /heavy cream/i }).click();
  await expect(page.getByTestId('refusal-answer')).toHaveText(/^No, because this cream has to whip and hold air for the topping/);
  await expect(scr(page).getByText('✕ No swap for this use · Prepared at import (AI)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toHaveCount(0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/cook-card-no.png' });
});

test('Import cards: the imported risotto\'s Parmesan card is a labelled plan → availability → explicit acceptance → applied', async ({ page }) => {
  await reset(page, 'shortcake.step6');
  await importDemo(page, 'risotto', RISOTTO_LINES);
  await page.getByRole('button', { name: /dry white wine, step 5/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('If you run out: Split the wine\'s jobs');
  await expect(page.getByTestId('swap-label')).toHaveText('Reviewed change');                 // the reviewed rule is the cross-check
  await saveAndStart(page);
  await doneThrough(page, 6);
  await say(page, 'I’m out of Parmesan.');
  await page.getByRole('group', { name: 'Which ingredient is missing' }).getByRole('button', { name: /parmesan/i }).click();
  await expect(page.getByTestId('question')).toContainText('50 g grated pecorino');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('change-7')).toHaveText('Off the heat, stir in 30 g butter and 50 g grated pecorino. Season with salt.');
  await expect(scr(page).getByText(/^Prepared at import \(AI\) · not reviewed · provisional quantities · not released cooking guidance$/)).toBeVisible();
  await expect(page.getByTestId('consequence')).toHaveText('Pecorino is saltier and sharper, so taste before adding salt.');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.artifacts/e2e/shots/cook-card-proposal.png' });
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(scr(page).getByText(/Change applied\. Step 7 is ready, not started/)).toBeVisible();
});

test('A-2 lemon partial read → saved, can’t start → paste the missing steps → can start', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles(pdf('lemon-cake.pdf', [{ lines: LEMON_PAGE1 }, { image: scanImage() }]));
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await page.getByRole('button', { name: 'Skip the animation' }).click({ timeout: 3000 }).catch(() => undefined);
  await expect(scr(page).getByText('Next · incomplete reading')).toBeVisible();
  await expect(scr(page).getByText(/Page 2 · scanned image · not read/)).toBeVisible();
  await page.getByRole('button', { name: 'Save to Recipe Book' }).click();
  await expect(scr(page).getByText('Saved to your Recipe Book. It can’t start yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start cooking' })).toBeDisabled();
  await page.getByRole('button', { name: 'Paste the missing steps' }).click();
  await page.getByRole('button', { name: 'Paste the missing steps' }).click();
  await page.getByLabel('Pasted steps').fill(LEMON_PASTED);
  await page.getByRole('button', { name: 'Add these steps' }).click();
  await expect(scr(page).getByText('Next · incomplete reading')).toHaveCount(0);       // cleared by the backend
  await page.getByRole('button', { name: 'Save changes as a new version' }).click();
  await expect(scr(page).getByText('Saved to your Recipe Book. You can start cooking.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start cooking' })).toBeEnabled();
});

test('A-3 a failed reading keeps the selected file and offers pasting', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles({ name: 'pantry-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really a pdf') });
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await expect(page.getByRole('alert')).toContainText(/That file isn.t a PDF/);
  await expect(page.getByRole('dialog').getByText('pantry-notes.pdf')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Paste text instead' })).toBeVisible();
});

test('SIMULATED speech recognition (software check of the voice bar; not microphone evidence)', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRec {
      lang = ''; interimResults = false; continuous = false;
      onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null;
      start() { const t = (window as unknown as { __said: string }).__said; setTimeout(() => { const r = Object.assign([{ transcript: t }], { isFinal: true }); this.onresult?.({ results: [r] }); this.onend?.(); }, 200); }
      stop() { this.onend?.(); } abort() { this.onerror?.({ error: 'aborted' }); this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: FakeRec, webkitSpeechRecognition: FakeRec });
  });
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await page.evaluate(() => { (window as unknown as { __said: string }).__said = 'next step'; });
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(scr(page).getByText(/^Step 2 of 8/)).toBeVisible();                 // navigation command executes directly
  await page.evaluate(() => { (window as unknown as { __said: string }).__said = 'I don’t have any onion'; });
  await page.getByRole('button', { name: 'Start listening' }).click();
  await expect(page.getByTestId('voice-state')).toContainText('Heard · sending in a moment');
  await expect(page.getByTestId('heard')).toHaveText('You said: “I don’t have any onion”');   // sent automatically, no tap
  await page.getByRole('button', { name: /^Back to step 2/ }).first().click();
  // Cancel stops an automatic send
  await page.evaluate(() => { (window as unknown as { __said: string }).__said = 'I don’t have any garlic'; });
  await page.getByRole('button', { name: 'Start listening' }).click();
  await page.getByTestId('voice-state').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('heard')).toHaveCount(0);
  await expect(page.getByTestId('voice-state')).toContainText('Nothing was sent.');
});

test('No speech recognition → microphone unavailable, typed fallback still works', async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined }); });
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await expect(page.getByTestId('voice-state')).toContainText('Microphone unavailable');
  await expect(page.getByRole('button', { name: 'Start listening' })).toBeDisabled();
  await say(page, 'next step');
  await expect(scr(page).getByText(/^Step 2 of 8/)).toBeVisible();
});

test('1024×768: no horizontal page overflow; Activity opens from the header', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await risottoProposal(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Use this change', exact: true })).toBeInViewport();
  await page.screenshot({ path: '.artifacts/e2e/shots/risotto-proposal-1024.png' });
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Activity' })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.goto('/');
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test('Add sheet keyboard: focus moves in, Tab is trapped, Esc closes, focus returns to the opener', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Add a recipe' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Add a recipe' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true); }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('A bare “yes” never applies a plan; only explicit acceptance does', async ({ page }) => {
  await risottoProposal(page);
  const applies: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/mcp') && (r.postData() ?? '').includes('"apply_amendment"')) applies.push(r.postData()!); });
  for (const said of ['yes', 'Yes.', 'yeah', 'ok']) {
    await say(page, said);
    await expect(page.getByTestId('voice-state')).toContainText(/plain “yes” doesn’t apply anything|didn’t catch/);
  }
  await expect(page.getByTestId('consequence')).toBeVisible();          // still a proposal, not applied
  expect(applies).toHaveLength(0);
  expect((await mcp(page, 'get_active_recipe')).run.appliedAmendments).toHaveLength(0);
});

test('A natural reply answers the open question instead of starting a new request', async ({ page }) => {
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  await doneThrough(page, 4);
  await say(page, 'I don’t have any white wine. Can I use lemon juice?');
  await expect(page.getByTestId('question')).toBeVisible();
  await say(page, 'maybe later');                                         // not an answer: asked again, question kept
  await expect(page.getByTestId('voice-state')).toContainText('Please answer yes or no');
  await expect(page.getByTestId('question')).toBeVisible();
  await say(page, 'yes I have that');
  await expect(page.getByTestId('consequence')).toBeVisible();
  await say(page, 'yes I have that');                                     // during a proposal: never an acceptance
  await expect(page.getByTestId('voice-state')).toContainText('doesn’t apply anything');
  expect((await mcp(page, 'get_active_recipe')).run.appliedAmendments).toHaveLength(0);
});

test('Activity starts blank for each recipe; ⌥⇧R resets the demo (sessions, imports and Activity cleared, data archived)', async ({ page }) => {
  await reset(page, 'shortcake.step6');
  await start(page, /Risotto with Parmesan/);
  const act = page.getByRole('complementary', { name: 'Activity' });
  await expect(act.getByTestId('activity-entry').last()).toContainText('start_recipe');               // nothing from before this recipe
  await expect(act.getByTestId('activity-entry').filter({ hasText: 'record_progress' })).toHaveCount(0);   // the previous session's progress is hidden
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.keyboard.press('Alt+Shift+KeyR');
  const dialog = page.getByRole('dialog', { name: 'Reset demo' });
  await dialog.getByRole('button', { name: 'Reset' }).click();                                       // no key needed on a practice server
  await expect(page.getByRole('heading', { name: 'Recipe Book' })).toBeVisible();
  await expect(act.getByText('No MCP calls yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume cooking/ })).toHaveCount(0);                 // no active session
  expect((await mcp(page, 'get_active_recipe')).run).toBeNull();
  expect((await mcp(page, 'list_recipes')).recipes).toHaveLength(3);                                  // imports removed; demo recipes stay
});

test('Scone by spoken-style replies: a plain yes answers one question and prompts the next; "yes to both" answers all; "let’s use this change" applies', async ({ page }) => {
  await reset(page, 'risotto.step5');
  await start(page, /Cream Scones/, 'Owner-authored');
  await doneThrough(page, 2);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter?');
  await expect(page.getByTestId('question')).toHaveCount(2);
  await say(page, 'yes I have it');
  await expect(page.getByTestId('voice-state')).toContainText(/One more.*Next:.*A little more milk for step 6/s);
  await expect(page.getByTestId('question').nth(0)).toContainText('You answered: Yes');
  await say(page, 'yes');
  await expect(page.getByTestId('consequence')).toBeVisible();
  await say(page, 'let’s use this change');
  await expect(scr(page).getByText(/Change applied\. Step 3 is ready, not started/)).toBeVisible();
  // the same request answered in one go
  await reset(page, 'risotto.step5');
  await start(page, /Cream Scones/, 'Owner-authored');
  await doneThrough(page, 2);
  await say(page, 'I’m out of heavy cream. Can I use milk and butter?');
  await expect(page.getByTestId('question')).toHaveCount(2);   // answer the open questions, not a new request
  await say(page, 'yes to both');
  await expect(page.getByTestId('consequence')).toBeVisible();
});
