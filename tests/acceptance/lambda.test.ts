// The deployed entry (src/service/lambda.ts) driven with Function URL events (payload 2.0) against DynamoDB Local: sign-in,
// session on every route, Origin/CSRF, MCP over the adapter, a cook-and-apply, isolation, Start over, a binary upload, and
// the import worker's claim (a duplicate delivery does nothing). Runs only with CC_TEST_DYNAMO_ENDPOINT (npm run
// test:dynamodb-local). Local emulation: no Lambda runtime, IAM, Function URL limits or real DynamoDB here.
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import { offExtractor } from '../../src/authoring/extract.ts';
import { LEDGER } from '../../src/authoring/nova.ts';
import { DynamoKv } from '../../src/service/kv-dynamo.ts';
import type { UrlEvent, UrlResult } from '../../src/service/lambda.ts';
import { demoPdf } from '../fixtures/demo-cards.ts';
import { SCONE_LINES } from '../fixtures/demo-sources.ts';
import { RECIPE } from '../fixtures/ids.ts';
import { content, fixtureActions, ROOT } from '../helpers.ts';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { publishRelease, readKnowledgeDir } from '../../src/knowledge/release.ts';

const endpoint = process.env.CC_TEST_DYNAMO_ENDPOINT;
const CODE = 'judge-code-for-tests', HOST = 'abc123.lambda-url.us-east-1.on.aws', ORIGIN = `https://${HOST}`;
type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads are asserted here

describe.skipIf(!endpoint)('the deployed entry (Function URL events, DynamoDB Local)', () => {
  const table = process.env.CC_TEST_DYNAMO_TABLE ?? 'cc-test';
  let kv: DynamoKv, handler: typeof import('../../src/service/lambda.ts')['handler'];
  beforeAll(async () => {   // only when the suite runs: the entry initializes against DynamoDB Local on import
    Object.assign(process.env, { CC_TABLE: table, CC_KNOWLEDGE_TABLE: `${table}-knowledge`, CC_DYNAMO_ENDPOINT: endpoint, CC_SESSION_KEY: randomBytes(32).toString('base64'),
      CC_ACCESS_CODE_SHA256: createHash('sha256').update(CODE).digest('hex'), CC_BUCKET: 'unused' });
    kv = new DynamoKv(table, { endpoint, region: 'us-east-1' });
    // the release the owner publishes (npm run cc -- knowledge publish): the deployed entry reads knowledge only from this table
    await publishRelease(new DynamoKv(`${table}-knowledge`, { endpoint, region: 'us-east-1' }), readKnowledgeDir(join(ROOT, 'content/approved')), { activate: true, note: 'test' });
    // the authorization the owner records: no paid calls, enough sign-ins for this test
    const auth = await kv.get({ pk: LEDGER, sk: 'AUTH' });
    await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', id: 'test-deploy', grantedBy: 'test', at: '', maxCalls: {}, maxUsd: 0, projectCeilingUsd: 0, priorProjectUsd: 0, maxNewWorkspacesPerDay: 100_000, v: (auth?.v ?? 0) + 1 }, ...(auth ? { if: auth.v! } : { if: 'absent' as const }) }]);
    ({ handler } = await import('../../src/service/lambda.ts'));
  });

  const ev = (method: string, path: string, o: { headers?: Record<string, string>; cookies?: string[]; body?: string | Buffer } = {}): UrlEvent => {
    const [rawPath, rawQueryString] = path.split('?');
    const binary = Buffer.isBuffer(o.body);
    return { rawPath, rawQueryString: rawQueryString ?? '', headers: o.headers ?? {}, cookies: o.cookies, body: binary ? (o.body as Buffer).toString('base64') : o.body as string | undefined,
      isBase64Encoded: binary, requestContext: { domainName: HOST, http: { method, sourceIp: '203.0.113.7' } } };
  };
  const send = async (e: UrlEvent) => (await handler(e)) as UrlResult;
  const signIn = async () => {
    const r = await send(ev('POST', '/signin', { headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` }));
    expect(r.statusCode).toBe(303);
    return r.cookies![0].split(';')[0];
  };
  let n = 0;
  const mcp = async (cookie: string, method: string, params: J = {}) => {
    const r = await send(ev('POST', '/mcp', { cookies: [cookie], headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) }));
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) as J : null };
  };
  const tool = async (cookie: string, name: string, args: J = {}) => (await mcp(cookie, 'tools/call', { name, arguments: args })).body!.result.structuredContent as J;

  it('everything but /health and sign-in needs a session; a wrong code is refused; MCP answers JSON over the adapter', async () => {
    expect(JSON.parse((await send(ev('GET', '/health'))).body)).toMatchObject({ ok: true, signIn: true, speech: 'off', knowledge: content.releaseId });
    // knowledge comes only from the knowledge table on this path: the entry never loads the bundled files
    expect(readFileSync(join(ROOT, 'src/service/lambda.ts'), 'utf8')).not.toMatch(/loadContent|readKnowledgeDir|content\/approved/);
    const page = await send(ev('GET', '/', { headers: { accept: 'text/html' } }));
    expect([page.statusCode, page.body]).toEqual([200, expect.stringContaining('Access code')]);
    expect((await send(ev('POST', '/mcp', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' }))).statusCode).toBe(401);
    for (const p of ['/activity', '/recipes/x', '/imports/x']) expect((await send(ev('GET', p))).statusCode, p).toBe(401);
    const wrong = await send(ev('POST', '/signin', { headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=nope' }));
    expect([wrong.statusCode, wrong.cookies]).toEqual([401, undefined]);
    const cookie = await signIn();
    expect(cookie).toMatch(/^cc_ws=ws_/);
    const init = await mcp(cookie, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.body!.result.protocolVersion).toBe('2025-11-25');
    expect(((await mcp(cookie, 'tools/list')).body!.result.tools as J[]).map((t) => t.name).sort()).toEqual(['apply_amendment', 'delete_recipe', 'evaluate_rescue', 'get_active_recipe', 'import_recipe', 'list_recipes', 'record_progress', 'start_recipe']);
    expect((await send(ev('GET', '/mcp', { cookies: [cookie], headers: { accept: 'text/event-stream' } }))).statusCode).toBe(405);   // no stream held open
    // CSRF: a cookie alone is not enough for a write
    expect((await send(ev('POST', '/mcp', { cookies: [cookie], headers: { 'content-type': 'application/json' }, body: '{}' }))).statusCode).toBe(403);
    expect((await send(ev('POST', '/mcp', { cookies: [cookie], headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }))).statusCode).toBe(403);
    // a forged or altered cookie is no session
    expect((await send(ev('GET', '/activity', { cookies: [cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))] }))).statusCode).toBe(401);
  });

  it('cook → evaluate → accept → apply in one sign-in; another sign-in is another kitchen; Start over leaves only that kitchen', async () => {
    const a = await signIn(), b = await signIn();
    expect((await tool(a, 'list_recipes')).recipes).toHaveLength(2);   // risotto and shortcake; the scones are Add recipe's sample import
    const started = await tool(a, 'start_recipe', { commandId: 'c1', recipeId: RECIPE['risotto.demo'] });
    let run = started.run as J;
    for (const [i, x] of fixtureActions('risotto.step5').entries()) run = (await tool(a, 'record_progress', { commandId: `p${i}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, ...x })).run;
    const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
    const wine = content.packs.get(RECIPE['risotto.demo'])!.recipe.ingredients.find((i) => /wine/i.test(i.name))!.ingredientId;
    const e1 = await tool(a, 'evaluate_rescue', { commandId: 'e1', ...base, missingIngredientId: wine, proposedKindIds: ['lemon-juice'], utterance: { text: 'wine', channel: 'tapped' } });
    expect(e1.outcome).toBe('needsFacts');
    const e2 = await tool(a, 'evaluate_rescue', { commandId: 'e2', ...base, previousEvaluationId: e1.id, answers: (e1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
    expect(e2.outcome).toBe('proposal');
    const accept = { commandId: 'a1', ...base, evaluationId: e2.id, candidateId: e2.candidates[0].id, planId: e2.candidates[0].planId, accepted: true };
    expect(await tool(a, 'apply_amendment', accept)).toMatchObject({ outcome: 'applied' });
    expect(await tool(a, 'apply_amendment', accept)).toMatchObject({ outcome: 'alreadyApplied' });
    expect((await tool(a, 'get_active_recipe', { commandId: 'a1' })).command).toMatchObject({ status: 'applied' });
    expect((await tool(b, 'get_active_recipe')).run).toBeNull();                                   // b is its own kitchen
    expect((await tool(b, 'get_active_recipe', { commandId: 'a1' })).command).toMatchObject({ receipt: 'NONE' });
    const reset = await send(ev('POST', '/workspace/reset', { cookies: [a], headers: { origin: ORIGIN } }));
    expect(reset.statusCode).toBe(200);
    const a2 = reset.cookies![0].split(';')[0];
    expect((await tool(a2, 'get_active_recipe')).run).toBeNull();
    expect((await tool(a, 'get_active_recipe')).run).not.toBeNull();                               // the old kitchen is kept, not erased
  });

  it('a PDF arrives base64 through the adapter; the import worker claims a queued job once (a duplicate delivery does nothing)', async () => {
    const cookie = await signIn();
    const up = await send(ev('POST', '/uploads', { cookies: [cookie], headers: { origin: ORIGIN, 'content-type': 'application/pdf', 'x-filename': 'scones.pdf' }, body: Buffer.from(demoPdf(SCONE_LINES)) }));
    expect([up.statusCode, JSON.parse(up.body).sourceDocId]).toEqual([201, expect.stringMatching(/^src_/)]);
    // a queued job (as the web function leaves it before its asynchronous hand-off), then two deliveries
    const ws = 'ws_worker_check_' + randomBytes(6).toString('hex');
    const author = new Authoring({ kv, ws, content, extractor: offExtractor, dispatch: async () => undefined });
    const r = await author.createImport({ kind: 'text', text: SCONE_LINES.join('\n') });
    if (r.status !== 202) throw new Error('import');
    expect(r.job.state).toBe('queued');
    expect(await handler({ job: { ws, jobId: r.job.id } })).toEqual({ ran: 'ran' });
    expect(await handler({ job: { ws, jobId: r.job.id } })).toEqual({ ran: 'notQueued' });
    expect(await author.job(r.job.id)).toMatchObject({ state: 'failed', failure: { code: 'LIVE_EXTRACTION_REQUIRED' } });   // reading is off: no paid call
  });
});
