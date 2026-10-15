// OD-6 explicit-quantity scone, the SAME freshly imported recipe end to end (playwright.review.config.ts; no paid calls):
// upload the frozen probe PDF → automatic analysis → both cream uses → save → reload/reopen → cook → rescue → explicit
// acceptance → resume. Reading and cards replay the cards2 live probe (2026-10-07) for these exact bytes; interpretation is
// RECORDED. No owner route, no asserted fact, no fixture recipe: the Recipe Book's scone is this import.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ROOT = join(import.meta.dirname, '../..');
const PDF = join(ROOT, 'samples/scones-explicit.pdf');   // the tracked owner-authored sample (OD-6); same bytes as the cards2 probe's frozen input
const OUT = join(ROOT, '.artifacts/review', `${new Date().toISOString().replace(/[:.]/g, '-')}-explicit-scone`);
mkdirSync(join(OUT, 'shots'), { recursive: true });
const shot = async (page: Page, name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: join(OUT, 'shots', `${name}.png`) }); };
async function mcp(page: Page, name: string, args: Record<string, unknown> = {}) {
  const r = await page.request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return ((await r.json()) as { result: { structuredContent: Record<string, any> } }).result.structuredContent;   // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('explicit scone · sample chip → automatic analysis → both cream uses → save → reload → reopen → cook → rescue → accept → resume', async ({ page }) => {
  const evidence: Record<string, unknown> = { kind: 'cc-explicit-scone-journey/1', at: new Date().toISOString(),
    pdf: { path: 'samples/scones-explicit.pdf', sha256: createHash('sha256').update(readFileSync(PDF)).digest('hex') },
    modes: { extraction: 'REPLAY_OF_LIVE_PROBES (cards2 live reading of these bytes)', swapAnalysis: 'REPLAY_OF_LIVE_CARD_PROBE (cards2, prompt ccmcp-swaps-2)', interpreter: 'RECORDED', paidCalls: 0 } };
  const authoring: string[] = [];
  let draftId = '';
  page.on('request', (q) => { const p = new URL(q.url()).pathname; const m = /\/drafts\/([^/?]+)$/.exec(p); if (m) draftId = m[1]; if (p.startsWith('/authoring')) authoring.push(p); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a recipe' }).first().click();
  // the sample chip (owner 2026-10-13): the same bytes as choosing samples/scones-explicit.pdf, read the same way, no file of your own
  await page.getByTestId('sample-chip').click();
  await expect(page.getByText('How scones-explicit.pdf was read')).toBeVisible({ timeout: 20_000 });
  evidence.summary = await page.getByTestId('analysis-summary').textContent();
  await shot(page, '01-matrix');
  const draft = (await (await page.request.get(`/drafts/${draftId}`)).json()).draft;
  const cream = draft.content.ingredients.find((g: { name: string }) => g.name === 'heavy cream');
  expect(cream.totalAmount.display).toBe('315 ML');
  expect(cream.uses.map((u: { amount: { display: string } }) => u.amount.display)).toEqual(['300 ML', '15 ML']);
  for (const u of cream.uses) expect(u.reviewedFunction.authority).toBe('MACHINE_CHECKED');
  evidence.uses = draft.content.ingredients.flatMap((g: { name: string; uses: { stepId: string; amount: { display: string }; analysis: { status: string; offer: string | null; reason: { code: string } | null; plans: { title: string; provenance: { kind: string } }[] } }[] }) =>
    g.uses.map((u) => ({ use: `${g.name} · step ${draft.content.steps.find((s: { id: string }) => s.id === u.stepId).ordinal}`, amount: u.amount.display, status: u.analysis.status, offer: u.analysis.offer,
      reason: u.analysis.reason?.code ?? null, plan: u.analysis.plans[0] ? `${u.analysis.plans[0].provenance.kind}: ${u.analysis.plans[0].title}` : null })));

  await page.getByRole('button', { name: /^heavy cream, step 3:/i }).click();   // the dough cream's alternative
  await expect(page.getByTestId('swap')).toHaveText('Butter and milk for cream in a dough');
  await expect(page.getByTestId('used-here')).toHaveText('300 ML');
  await expect(page.getByTestId('replacement')).toHaveText([/Milk\s*180 ML, plus up to 30 ML more if needed\s*Step 3/, /Butter\s*85 g\s*Step 3\s*Prep: cold/, /Milk\s*15 ML\s*Step 6/]);
  await shot(page, '02-dough-cream');
  await page.getByTestId('would-read-6').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('would-read-6').getByTestId('after')).toHaveText('Brush the tops with 15 ML milk.');
  await shot(page, '03-instruction-changes');
  await page.getByRole('button', { name: /^heavy cream, step 6:/i }).click();   // the brushing cream is covered by the same plan
  await expect(page.getByTestId('used-here')).toHaveText('15 ML');
  await expect(page.getByText('This use is changed by the plan for step 3.')).toBeVisible();
  await shot(page, '04-brushing-cream');
  await page.getByRole('button', { name: '← Recipe matrix' }).click();
  await page.getByRole('button', { name: 'Save to Recipe Book' }).click();
  await expect(page.getByText('Saved to your Recipe Book. You can start cooking.')).toBeVisible();
  const saved = (await mcp(page, 'list_recipes')).recipes.find((r: { sourceLabel: string }) => /scones-explicit/.test(r.sourceLabel));
  await shot(page, '05-saved');

  await page.reload();
  await page.getByRole('button', { name: /^Cream Scones.*scones-explicit/s }).click();
  await expect(page.getByTestId('analysis-summary')).toHaveText(evidence.summary as string);
  await page.getByRole('button', { name: /^heavy cream, step 3:/i }).click();
  await expect(page.getByTestId('swap')).toHaveText('Butter and milk for cream in a dough');
  await shot(page, '06-reopened');
  await page.getByRole('button', { name: 'Start cooking' }).click();
  const end = page.getByRole('button', { name: /^End it and start/ });
  if (await end.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await end.click();
  await expect(page.getByText(/^Step 1 of 7/)).toBeVisible();
  const started = await mcp(page, 'get_active_recipe');
  expect(started.run.recipeVersionId).toBe(saved.currentVersionId);
  for (const n of [1, 2]) { await page.getByRole('button', { name: 'Done', exact: true }).click(); await expect(page.getByText(new RegExp(`^Step ${n + 1} of 7`))).toBeVisible(); }
  await page.getByLabel('Type a request').fill('I\'m out of cream. Can I use milk and butter?');
  await page.getByRole('button', { name: 'Send' }).click();
  const picker = page.getByRole('group', { name: 'Which ingredient is missing' });
  if (await picker.isVisible({ timeout: 1500 }).catch(() => false)) await picker.getByRole('button', { name: /heavy cream/i }).click();
  const q = page.getByTestId('question');
  await expect(q).toHaveCount(1);
  await expect(q).toContainText('225 ML milk: 180 ML for the dough (step 3) + 15 ML for brushing (step 6) + up to 30 ML extra for the dough, only if needed');
  await expect(q).not.toContainText('Brush cream');
  await expect(q).toContainText('85 g cold butter');
  const asked = await mcp(page, 'get_active_recipe');
  await shot(page, '07-availability');
  await q.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('consequence')).toBeVisible();
  const proposal = await mcp(page, 'get_active_recipe');
  expect(proposal.run.appliedAmendments).toHaveLength(0);
  await shot(page, '08-proposal');
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(page.getByText(/Change applied\. Step 3 is ready, not started/)).toBeVisible();
  const applied = await mcp(page, 'get_active_recipe');
  await shot(page, '09-applied');
  await page.getByRole('button', { name: 'Done', exact: true }).click();   // resume: Ben makes the dough and moves on
  await expect(page.getByText(/^Step 4 of 7/)).toBeVisible();
  const resumed = await mcp(page, 'get_active_recipe');
  const s = (r: Record<string, any>, n: number) => (r.recipe.steps as { ordinal: number; text: string }[]).find((x) => x.ordinal === n)!.text;   // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(s(applied, 6)).toBe('Brush the tops with 15 ML milk.');
  expect(authoring).toEqual([]);
  evidence.dialogue = {   // the server's own replies (speech text), for the VO
    availability: asked.latestEvaluation.speech.text, proposal: proposal.latestEvaluation.speech.text,
    candidate: { id: proposal.latestEvaluation.candidates[0].id, importPlanId: draft.content.ingredients.find((g: { name: string }) => g.name === 'heavy cream').uses[0].analysis.plans[0].planId, contentLabel: proposal.latestEvaluation.candidates[0].contentLabel },
    interpretation: asked.latestEvaluation.trace.interpretation,
  };
  evidence.readBack = { step3: s(applied, 3), step6: s(applied, 6), afterResume: { current: resumed.recipe.steps.find((x: { id: string }) => x.id === resumed.run.currentStepId)?.ordinal, step3: resumed.run.steps[2].progress } };
  evidence.ownerActions = authoring;
  evidence.saved = { recipeId: saved.recipeId, recipeVersionId: saved.currentVersionId, coverageSummary: saved.release.coverageSummary };
  writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 1));
  expect((evidence.dialogue as { candidate: { id: string; importPlanId: string } }).candidate.id).toBe((evidence.dialogue as { candidate: { importPlanId: string } }).candidate.importPlanId);
});
