// PAID: one risotto journey with live Nova interpretation (1 call) and Polly speech for the engine-authored replies.
// Typed input: this is not microphone evidence (the owner's real-audio walkthrough is).
import { expect, test } from '@playwright/test';

test('LIVE Nova + Polly: typed risotto rescue with spoken replies', async ({ page }) => {
  const speech: { status: number; type: string | null; bytes: number; cached: string | null }[] = [];
  // the page consumes the audio body, so the server's content-length is the byte measure
  page.on('response', async (r) => {
    if (r.url().endsWith('/speech')) speech.push({ status: r.status(), type: r.headers()['content-type'] ?? null, bytes: Number(r.headers()['content-length'] ?? 0), cached: r.headers()['x-speech-cached'] ?? null });
  });
  await page.request.post('/admin/reset', { headers: { authorization: 'Bearer live-admin-key' }, data: { fixtureId: 'risotto.step5' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Resume cooking' }).first().click();
  await expect(page.getByText(/^Step 5 of 8/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Spoken replies: on/ })).toBeVisible();   // on by default when the server can speak
  await page.getByLabel('Type a request').fill('I don’t have any white wine. Can I use lemon juice?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('question')).toContainText('120 ML more hot unsalted vegetable stock', { timeout: 30_000 });
  await expect(page.getByTestId('voice-state')).toContainText(/CourseCorrect is saying|Last said/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByTestId('consequence')).toBeVisible();
  await expect.poll(() => speech.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Use this change', exact: true }).click();
  await expect(page.getByText(/Change applied\. Step 5 is ready/)).toBeVisible();
  await expect.poll(() => speech.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const act = (await (await page.request.get('/activity')).json()).entries as { name: string; trace?: { interpretation: string | null } }[];
  const interp = act.find((e) => e.name === 'evaluate_rescue' && e.trace?.interpretation?.startsWith('NOVA'))?.trace?.interpretation;
  console.log(JSON.stringify({ interpretation: interp, speech }, null, 1));
  expect(interp).toMatch(/NOVA interpreter \(\d+ ms\): RESOLVED; missing = wine/);
  for (const s of speech) { expect(s.status).toBe(200); expect(s.type).toBe('audio/mpeg'); expect(s.bytes).toBeGreaterThan(1000); }
});
