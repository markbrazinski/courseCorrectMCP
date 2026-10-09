// Owner amendment 2026-10-05: import_recipe and delete_recipe (archive) over a real MCP client and HTTP. Readings and cards
// are the hand-written RECORDED demo fixtures (validator/software evidence only, no paid calls).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { recordedExtractor } from '../../src/authoring/extract.ts';
import { recordedAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { Service } from '../../src/service/commands.ts';
import { startHttp } from '../../src/service/http.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import { DEMO, demoPdf, recordedDemo } from '../fixtures/demo-cards.ts';
import { cmd, content } from '../helpers.ts';

type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads are asserted here

async function setup() {
  const svc = new Service({ dbPath: join(mkdtempSync(join(tmpdir(), 'cc-tools-')), 't.db'), content, interpreter: noneInterpreter, fixtureRecipes: false });
  const rec = await recordedDemo(content.vocab);
  const authoring = new Authoring({ store: svc.store, content, extractor: recordedExtractor(rec.readings, 'RECORDED_FIXTURES'), analyzer: recordedAnalyzer(rec.cards, 'RECORDED_FIXTURES') });
  svc.catalog = () => authoring.catalog();
  const port = 19000 + Math.floor(Math.random() * 900);
  const server = await startHttp(svc, { port, authoring });
  const client = new Client({ name: 'tools-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = async (name: string, args: J = {}): Promise<J> => {
    const r = await client.callTool({ name, arguments: args });
    return { ...(r.structuredContent as J), isError: r.isError === true, text: (r.content as { text: string }[])[0]?.text };
  };
  const scone = DEMO.find((d) => d.name === 'scones')!;
  /** The companion's upload path (POST /imports); its sourceDocId is the opaque handle import_recipe takes. */
  const upload = async () => (await (await fetch(`http://127.0.0.1:${port}/imports`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-filename': 'scones.pdf' }, body: Buffer.from(demoPdf(scone.lines)) })).json()) as J;
  const count = (t: string) => (svc.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!).n;
  return { svc, authoring, client, call, upload, count, base: `http://127.0.0.1:${port}`, close: async () => { await client.close(); server.close(); } };
}

describe('recipe-management MCP tools', () => {
  it('discovery lists exactly the eight tools, the new two with their contract in the description', async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['apply_amendment', 'delete_recipe', 'evaluate_rescue', 'get_active_recipe', 'import_recipe', 'list_recipes', 'record_progress', 'start_recipe']);
    expect(tools.find((x) => x.name === 'delete_recipe')!.description).toMatch(/Archive .*kept/);
    expect(tools.find((x) => x.name === 'import_recipe')!.description).toMatch(/Never saves, reviews or releases/);
    await t.close();
  });

  it('POST /uploads stores the file and starts nothing; import_recipe then reads it (the companion path)', async () => {
    const t = await setup();
    const post = (body: Uint8Array | string, type = 'application/pdf') => fetch(`${t.base}/uploads`, { method: 'POST', headers: { 'content-type': type, 'x-filename': 'scones.pdf' }, body: Buffer.from(body) });
    const r = await post(demoPdf(DEMO.find((d) => d.name === 'scones')!.lines));
    expect(r.status).toBe(201);
    const { sourceDocId } = await r.json() as { sourceDocId: string };
    expect([t.count('sources'), t.count('import_jobs'), t.count('drafts'), t.count('extractions')]).toEqual([1, 0, 0, 0]);
    expect(await t.call('import_recipe', { commandId: cmd(), source: { kind: 'upload', sourceDocId } })).toMatchObject({ outcome: 'imported', draft: { saved: false, title: 'Cream Scones' } });
    expect((await post('not really a pdf')).status).toBe(400);
    expect(t.count('sources')).toBe(1);
    await t.close();
  });

  it('import_recipe: a draft from an upload handle, never saved or reviewed; retry is safe; no paths, unknown handles refused', async () => {
    const t = await setup();
    const up = await t.upload();
    const handle = up.job.sourceDocId as string;
    const args = { commandId: cmd(), source: { kind: 'upload', sourceDocId: handle } };
    const r = await t.call('import_recipe', args);
    expect(r).toMatchObject({ outcome: 'imported', draft: { saved: false, title: 'Cream Scones' } });
    expect(r.draft.uses.some((u: J) => u.ingredient.toLowerCase().includes('cream') && u.step === 3)).toBe(true);
    expect(r.draft.draftId).not.toBe(up.draftId);                                     // a new draft over the same stored source
    expect(t.svc.store.get<{ source_id: string }>('SELECT source_id FROM draft_sources WHERE draft_id = ?', r.draft.draftId)!.source_id).toBe(handle);
    expect((await t.call('list_recipes')).recipes).toEqual([]);                        // drafts never appear in the book
    expect(t.count(`facts`)).toBe(0);                                                  // nothing reviewed or confirmed
    expect(t.count('saved_recipes')).toBe(0);

    const jobs = t.count('import_jobs'), extractions = t.count('extractions');
    expect(await t.call('import_recipe', args)).toMatchObject({ outcome: 'imported', replayed: true });   // same commandId: replay
    expect([t.count('import_jobs'), t.count('extractions')]).toEqual([jobs, extractions]);                  // no second reading
    expect(await t.call('import_recipe', { ...args, source: { kind: 'text', text: 'Toast\n1. Toast the bread.' } })).toMatchObject({ outcome: 'rejected', code: 'COMMAND_ID_REUSE' });

    expect(await t.call('import_recipe', { commandId: cmd(), source: { kind: 'upload', sourceDocId: '/etc/passwd' } })).toMatchObject({ outcome: 'rejected', code: 'UNKNOWN_UPLOAD' });
    expect((await t.call('import_recipe', { commandId: cmd(), source: { kind: 'path', path: '/etc/passwd' } })).isError).toBe(true);
    expect((await t.call('import_recipe', { commandId: cmd(), source: { kind: 'url', url: 'https://example.com/r.pdf' } })).isError).toBe(true);
    // an unrecorded document offline: the existing cost protection holds (no live call; the job fails, nothing saved)
    expect(await t.call('import_recipe', { commandId: cmd(), source: { kind: 'text', text: 'Toast\n1. Toast the bread.' } })).toMatchObject({ outcome: 'failed', job: { failure: { code: 'LIVE_EXTRACTION_REQUIRED' } } });
    await t.close();
  });

  it('delete_recipe archives from the book: exact version, explicit confirmation, refused while cooking, history kept', async () => {
    const t = await setup();
    const up = await t.upload();
    await t.authoring.waitForJob(up.job.id);
    const saved = t.authoring.save(up.draftId, { expectedRevision: t.authoring.revision(up.draftId) });
    const other = await t.upload();
    await t.authoring.waitForJob(other.job.id);
    const saved2 = t.authoring.save(other.draftId, { expectedRevision: t.authoring.revision(other.draftId) });
    const entry = (await t.call('list_recipes')).recipes.find((r: J) => r.recipeId === saved.recipeId);
    const started = await t.call('start_recipe', { commandId: cmd(), recipeId: saved.recipeId });
    expect(started.outcome).toBe('started');
    await t.call('record_progress', { commandId: cmd(), runId: started.run.id, epoch: started.run.epoch, expectedRevision: started.run.revision, stepId: started.run.steps[0].stepId, progress: 'done' });

    const del = (extra: J = {}) => ({ commandId: cmd(), recipeId: saved.recipeId, recipeVersionId: entry.currentVersionId, confirm: true, ...extra });
    expect(await t.call('delete_recipe', del())).toMatchObject({ outcome: 'rejected', code: 'RECIPE_IN_USE' });
    expect((await t.call('delete_recipe', del({ confirm: false }))).isError).toBe(true);
    const { confirm: _c, ...noConfirm } = del();
    expect((await t.call('delete_recipe', noConfirm)).isError).toBe(true);
    expect(await t.call('delete_recipe', del({ recipeVersionId: 'stale-version' }))).toMatchObject({ outcome: 'rejected', code: 'VERSION_MISMATCH' });

    // end the session the product's way (C-3 replace), then archive
    const cur = (await t.call('get_active_recipe')).run;
    expect((await t.call('start_recipe', { commandId: cmd(), recipeId: saved2.recipeId, replace: { runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, confirm: true } })).outcome).toBe('started');
    const before = { runs: t.count('runs'), receipts: t.count('receipts'), saved: t.count('saved_recipes'), sources: t.count('sources'), versions: t.count('run_versions'), progress: t.count('progress_events') };
    const args = del();
    expect(await t.call('delete_recipe', args)).toMatchObject({ outcome: 'archived', recipeId: saved.recipeId });
    expect(await t.call('delete_recipe', args)).toMatchObject({ outcome: 'archived', replayed: true });
    expect((await t.call('list_recipes')).recipes.map((r: J) => r.recipeId)).toEqual([saved2.recipeId]);
    expect(await t.call('start_recipe', { commandId: cmd(), recipeId: saved.recipeId })).toMatchObject({ outcome: 'rejected', code: 'RECIPE_NOT_FOUND' });
    expect(await t.call('delete_recipe', del())).toMatchObject({ outcome: 'rejected', code: 'RECIPE_NOT_FOUND' });
    const after = { runs: t.count('runs'), receipts: t.count('receipts'), saved: t.count('saved_recipes'), sources: t.count('sources'), versions: t.count('run_versions'), progress: t.count('progress_events') };
    expect({ ...after, receipts: before.receipts }).toEqual(before);                   // only receipts grow; no history is removed
    expect(t.svc.store.get<{ status: string }>('SELECT status FROM runs WHERE run_id = ?', started.run.id)!.status).toBe('ARCHIVED');
    await t.close();
  });
});
