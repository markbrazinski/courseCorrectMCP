// The automatic import (R-1, 2026-10-07): upload → analysis → present → save → reload → reopen → cook → rescue on ONE imported
// recipe (playwright.review.config.ts; no paid calls). The PDF is the real probe input (private/probes/cards/scones.pdf);
// its reading and swap cards replay the retained live probe for those bytes; interpretation is RECORDED. No owner route is
// called and no fact is asserted: the cream's roles are MACHINE_CHECKED from the approved role table.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ROOT = join(import.meta.dirname, '../..');
const PDF = join(ROOT, 'private/probes/cards/scones.pdf');
const OUT = join(ROOT, '.artifacts/review', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(join(OUT, 'shots'), { recursive: true });
const evidence: Record<string, unknown> = { kind: 'cc-import-review-proof/1', at: new Date().toISOString(), pdf: { path: 'private/probes/cards/scones.pdf', sha256: createHash('sha256').update(readFileSync(PDF)).digest('hex') },
  modes: { extraction: 'REPLAY_OF_LIVE_PROBES', swapAnalysis: 'REPLAY_OF_LIVE_CARD_PROBE', interpreter: 'RECORDED', paidCalls: 0 } };
const save = () => writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
const shot = async (page: Page, name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: join(OUT, 'shots', `${name}.png`) }); };

async function mcp(page: Page, name: string, args: Record<string, unknown> = {}) {
  const r = await page.request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return ((await r.json()) as { result: { structuredContent: Record<string, any> } }).result.structuredContent;   // eslint-disable-line @typescript-eslint/no-explicit-any
}
type Use = { id: string; stepId: string; amount: { display: string | null }; reviewedFunction: { authority: string; reviewId: string } | null; analysis: { status: string; reason: { code: string; text: string } | null; plans: { planId: string; title: string; provenance: { kind: string } }[]; coveredByUseId: string | null } };
type Content = { title: string; steps: { id: string; ordinal: number }[]; ingredients: { name: string; uses: Use[] }[] };
const table = (c: Content) => c.ingredients.flatMap((g) => g.uses.map((u) => ({ use: `${g.name} · step ${c.steps.find((s) => s.id === u.stepId)!.ordinal}`, useId: u.id, amount: u.amount.display, status: u.analysis.status,
  reason: u.analysis.reason?.code ?? null, plans: u.analysis.plans.map((p) => `${p.provenance.kind}: ${p.title} (${p.planId})`) })));

/** Every server response the browser saw, for the payload privacy check. */
const bodies: { url: string; text: string }[] = [];

test.describe.configure({ mode: 'serial' });
let draftId = '', recipeId = '';

test('1440×900 · upload the real PDF → automatic analysis (no owner step) → matrix → both cream uses → save → reload → reopen → cook → rescue', async ({ page }) => {
  const authoring: string[] = [];
  page.on('response', async (r) => { const t = r.headers()['content-type'] ?? ''; if (/json|html|javascript|text/.test(t)) bodies.push({ url: r.url(), text: await r.text().catch(() => '') }); });
  page.on('request', (q) => { const p = new URL(q.url()).pathname; const m = /\/drafts\/([^/?]+)$/.exec(p); if (m) draftId = m[1]; if (p.startsWith('/authoring')) authoring.push(p); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).first().click();
  await page.getByLabel('Choose a recipe PDF').setInputFiles(PDF);
  await page.getByRole('button', { name: 'Upload and read' }).click();
  await expect(page.getByRole('heading', { name: 'Reading scones.pdf' })).toBeVisible();
  await page.waitForTimeout(1600);
  await shot(page, '1440-01-reading');
  await expect(page.getByText('How scones.pdf was read')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('analysis-summary')).toHaveText('● 4 Alternative available◐ 1 Omission available○ 1 No alternative found');   // 2026-10-08: the flour's only suggestion was the same flour; batch 1: reviewed caster sugar and baking powder plans
  const draft0 = (await (await page.request.get(`/drafts/${draftId}`)).json()).draft as { content: Content };
  evidence.afterImport = { draftId, summary: await page.getByTestId('analysis-summary').innerText(), uses: table(draft0.content),
    creamRoles: draft0.content.ingredients.find((g) => g.name === 'heavy cream')!.uses.map((u) => u.reviewedFunction) };
  for (const u of draft0.content.ingredients.find((g) => g.name === 'heavy cream')!.uses) expect(u.reviewedFunction).toMatchObject({ authority: 'MACHINE_CHECKED', reviewId: expect.stringMatching(/^roles\.json#heavy-cream×(MIX_DOUGH|BRUSH) \(content-decisions\.md#OD-4; R-1\)$/) });
  await shot(page, '1440-02-matrix');

  await page.getByRole('button', { name: /^heavy cream, step 3:/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('Butter and milk for cream in a dough');
  await expect(page.getByTestId('swap-label')).toHaveText('Reviewed change');
  await expect(page.getByText('machine-checked against the approved role table').first()).toBeVisible();
  await expect(page.getByTestId('replacement')).toHaveText([/Milk\s*180 ML, plus up to 30 ML more if needed\s*Step 3/, /Butter\s*85 g\s*Step 3\s*Prep: cold/, /Milk\s*a little\s*Step 6/]);
  await expect(page.getByTestId('import-consequence')).toHaveText('These become butter scones: the texture will be a little less rich and tender than cream scones.');
  await expect(page.getByRole('button', { name: /^Step 6, [^,]+, would change/ })).toBeVisible();
  await shot(page, '1440-03-cream-step3');
  await page.getByTestId('would-read-3').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('would-read-3').getByTestId('after')).toHaveText(/^Rub 85 g cold butter into the dry mixture until it looks like coarse crumbs, then stir in 180 ML milk until a soft dough forms\./);
  await expect(page.getByTestId('would-read-6').getByTestId('after')).toHaveText('Brush the tops with a little milk.');
  await page.getByRole('button', { name: 'Plan details' }).click();
  await expect(page.getByTestId('plan-details')).toContainText('What the cream does in step 3 (liquid, fat): machine-checked against the approved role table (heavy-cream×MIX_DOUGH');
  await expect(page.getByTestId('plan-details')).toContainText('What the cream does in step 6 (browning): machine-checked against the approved role table (heavy-cream×BRUSH');
  await page.getByTestId('plan-details').scrollIntoViewIfNeeded();
  await shot(page, '1440-04-plan-details');
  await page.getByRole('button', { name: /^heavy cream, step 6:/i }).click();
  await expect(page.getByTestId('used-here')).toHaveText('a little');
  await expect(page.getByText('This use is changed by the plan for step 3.')).toBeVisible();
  await shot(page, '1440-05-cream-step6');
  await page.getByRole('button', { name: /^salt, step 2:/i }).click();
  await expect(page.getByTestId('answer-card')).toContainText('◐ Omission available: leave it out');
  await expect(page.getByTestId('swap-label')).toHaveText('Prepared at import (AI)');
  await expect(page.getByTestId('would-read-2').getByTestId('after')).toHaveText('Whisk the flour, sugar, baking powder.');
  await shot(page, '1440-06-salt-omission');
  await page.getByRole('button', { name: /^plain flour, step 2:/i }).click();
  await expect(page.getByTestId('answer-card')).toContainText('○ No alternative found');
  await expect(page.getByTestId('answer-card')).toContainText('The import analysis suggested all-purpose flour, which is the flour under another name, so there’s no alternative to offer here.');
  await page.getByText('Technical details').click();
  await expect(page.getByTestId('answer-card')).toContainText('SWAP_IS_SAME_INGREDIENT: all-purpose flour resolves to plain flour');   // vocabulary v2: all-purpose flour is plain flour
  await shot(page, '1440-07-flour-check-failed');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await expect(page.getByRole('button', { name: /^plain flour, step 2:/i })).toBeFocused();
  const doughUse = draft0.content.ingredients.find((g) => g.name === 'heavy cream')!.uses.find((u) => draft0.content.steps.find((s) => s.id === u.stepId)!.ordinal === 3)!;
  evidence.A8_1 = { note: 'Real server-produced UseAnalysis (available) for the freshly imported dough cream, with no owner action', useId: doughUse.id, analysis: doughUse.analysis };

  await page.getByRole('button', { name: 'Save to Recipe Book' }).click();
  await expect(page.getByText('Saved to your Recipe Book. You can start cooking.')).toBeVisible();
  const v1 = (await mcp(page, 'list_recipes')).recipes.find((r: { sourceLabel: string }) => /^scones\.pdf/.test(r.sourceLabel));
  recipeId = v1.recipeId;
  evidence.saved = { recipeId, recipeVersionId: v1.currentVersionId, coverageSummary: v1.release.coverageSummary };

  await page.reload();
  await page.getByRole('button', { name: /^Cream Scones.*· scones\.pdf/s }).click();
  await expect(page.getByTestId('analysis-summary')).toHaveText('● 4 Alternative available◐ 1 Omission available○ 1 No alternative found');   // 2026-10-08: the flour's only suggestion was the same flour; batch 1: reviewed caster sugar and baking powder plans
  const reopened = (await (await page.request.get(`/recipes/${recipeId}`)).json()).version.content as Content;
  expect(table(reopened)).toEqual(table(draft0.content));   // the saved analysis, unchanged
  await page.getByRole('button', { name: /^heavy cream, step 3:/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('Butter and milk for cream in a dough');
  await shot(page, '1440-08-reopened-after-reload');

  await page.getByRole('button', { name: 'Start cooking' }).click();
  const end = page.getByRole('button', { name: /^End it and start/ });   // another journey on this server may have a session open
  if (await end.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await end.click();
  await expect(page.getByText(/^Step 1 of 7/)).toBeVisible();
  const started = await mcp(page, 'get_active_recipe');
  expect(started.run.recipeVersionId).toBe(v1.currentVersionId);
  for (const n of [1, 2]) { await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.getByText(new RegExp(`^Step ${n + 1} of 7`))).toBeVisible(); }
  await page.getByLabel('Type a request').fill('I\'m out of cream. Can I use milk and butter?');
  await page.getByRole('button', { name: 'Send' }).click();
  const picker = page.getByRole('group', { name: 'Which ingredient is missing' });
  if (await picker.isVisible({ timeout: 1500 }).catch(() => false)) await picker.getByRole('button', { name: /heavy cream/i }).click();
  const qs = page.getByTestId('question');
  await expect(qs).toHaveCount(2);
  await shot(page, '1440-09-availability');
  await qs.nth(0).getByRole('button', { name: 'Yes', exact: true }).click();
  await qs.nth(1).getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('consequence')).toBeVisible();
  const proposal = await mcp(page, 'get_active_recipe');
  const cand = proposal.latestEvaluation.candidates[0];
  expect(cand.id).toBe(doughUse.analysis.plans[0].planId);
  expect(proposal.run.appliedAmendments).toHaveLength(0);
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(page.getByText(/Change applied\. Step 3 is ready, not started/)).toBeVisible();
  await shot(page, '1440-10-applied');
  const after = await mcp(page, 'get_active_recipe');
  const s3 = after.recipe.steps.find((s: { ordinal: number }) => s.ordinal === 3), s6 = after.recipe.steps.find((s: { ordinal: number }) => s.ordinal === 6);
  expect(after.run.steps.find((s: { stepId: string }) => s.stepId === s3.id).progress).toBe('notStarted');
  expect(authoring).toEqual([]);   // no owner route, no assertion: the automatic path
  evidence.rescue = { runId: after.run.id, recipeVersionId: after.run.recipeVersionId, importPlanId: doughUse.analysis.plans[0].planId, candidateId: cand.id, amendment: after.run.appliedAmendments[0],
    readBack: { step3: s3.text, step6: s6.text, currentStepId: after.run.currentStepId, step3Progress: 'notStarted' } };
  evidence.ownerActions = authoring;
  save();
});

test('1024×768 · reopen, drill down, keyboard and focus, scroll kept; distinct states on the fixture recipes', async ({ page }) => {
  page.on('response', async (r) => { const t = r.headers()['content-type'] ?? ''; if (/json|html|javascript|text/.test(t)) bodies.push({ url: r.url(), text: await r.text().catch(() => '') }); });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Cream Scones.*· scones\.pdf/s }).click();
  await expect(page.getByTestId('analysis-summary')).toBeVisible();
  await shot(page, '1024-01-reopened-matrix');
  const cell = page.getByRole('button', { name: /^heavy cream, step 3:/i });
  await cell.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '← Recipe matrix' })).toBeFocused();   // detail is full width at 1024: focus starts at Back
  await expect(page.getByRole('region', { name: 'Recipe matrix (compact)' })).toHaveCount(0);
  await expect(page.getByTestId('swap')).toHaveText('Butter and milk for cream in a dough');
  await shot(page, '1024-02-cream-detail');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^heavy cream, step 3:/i })).toBeFocused();
  await expect(page.getByText('Selected: heavy cream · step 3')).toBeVisible();

  // the risotto fixture is taller than the frame: the matrix keeps its scroll position across a detail
  await page.getByRole('button', { name: 'Recipe Book', exact: true }).click();
  await page.getByRole('button', { name: /^Risotto with Parmesan/ }).click();
  const grid = page.locator('.scroll:has([aria-label="Recipe matrix"])');
  await grid.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const top = await grid.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.getByRole('button', { name: /^Salt, step 7:/i }).click();
  await shot(page, '1024-03-risotto-salt-detail');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  expect(Math.abs(await grid.evaluate((el) => el.scrollTop) - top)).toBeLessThan(58);   // restored; focusing the selected cell may nudge it into view (< one row)
  await expect(page.getByRole('button', { name: /^Salt, step 7:/i })).toBeFocused();
  await page.getByRole('button', { name: /^Dry white wine, step 5:/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('Split the wine\'s jobs');
  await shot(page, '1024-04-risotto-wine');
  await page.getByRole('button', { name: 'Recipe Book', exact: true }).click();
  await page.getByRole('button', { name: /^Strawberry Shortcake/ }).click();
  await page.getByRole('button', { name: /^Heavy cream, step 6:/i }).click();
  // batch 1 (G13): a reviewed refusal answers one swap; it is listed, and never shown as "no alternative" for the use
  await expect(page.getByTestId('answer-card')).toContainText('Not checked yet');
  await expect(page.getByTestId('ruled-out-item')).toHaveCount(2);
  await expect(page.getByTestId('ruled-out')).toContainText("This catalog doesn't accept milk and butter in place of cream that has to be whipped");
  await expect(page.getByTestId('ruled-out')).toContainText('This catalog doesn\'t accept half-and-half or light cream');
  await shot(page, '1024-05-shortcake-whip-no');
});

test.afterAll(() => {
  // no credentials, local paths or private evidence in anything the browser received
  const bad = [/\/Users\//, /private\//, /\.artifacts/, /AKIA[0-9A-Z]{8}/, /review-owner-key|review-admin-key/, /aws_secret|secretAccessKey/i, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|net|org|us|io|dev)\b/];   // no e-mail address of anyone
  const hits = bodies.flatMap((b) => bad.filter((re) => re.test(b.text)).map((re) => `${new URL(b.url).pathname}: ${re}`));
  evidence.payloadScan = { responses: bodies.length, hits };
  save();
  expect(hits).toEqual([]);
});
