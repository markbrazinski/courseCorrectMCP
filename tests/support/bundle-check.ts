// TEST-ONLY: load a staged Lambda bundle (npm run cc -- stage) the way the Lambda Node.js runtime does — index.mjs's
// `handler`, with the bundle's own pruned node_modules — and drive it with Function URL events against DynamoDB Local:
// health, sign-in, MCP tools/list, a PDF upload (pdf.js from the pruned legacy build). Usage:
//   CC_TEST_DYNAMO_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
//     node tests/support/bundle-check.ts .artifacts/deploy/<env>/stage
// Not the Lambda runtime itself (no AWS Lambda Runtime Interface Client, IAM or Function URL limits).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stage = resolve(process.argv[2] ?? '.artifacts/deploy/review/stage');
const CODE = 'bundle-check-code', HOST = 'bundle.lambda-url.us-east-1.on.aws', ORIGIN = `https://${HOST}`;
Object.assign(process.env, { CC_TABLE: process.env.CC_TEST_DYNAMO_TABLE ?? 'cc-test', CC_KNOWLEDGE_TABLE: `${process.env.CC_TEST_DYNAMO_TABLE ?? 'cc-test'}-knowledge`, CC_DYNAMO_ENDPOINT: process.env.CC_TEST_DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000',
  CC_SESSION_KEY: randomBytes(32).toString('base64'), CC_ACCESS_CODE_SHA256: createHash('sha256').update(CODE).digest('hex'), CC_BUCKET: 'unused', AWS_REGION: 'us-east-1' });
const { handler } = await import(pathToFileURL(join(stage, 'index.mjs')).href) as { handler: (e: unknown) => Promise<{ statusCode: number; body: string; cookies?: string[]; headers: Record<string, string> }> };
const ev = (method: string, path: string, o: { headers?: Record<string, string>; cookies?: string[]; body?: string | Buffer } = {}) => ({
  rawPath: path, rawQueryString: '', headers: o.headers ?? {}, cookies: o.cookies, isBase64Encoded: Buffer.isBuffer(o.body),
  body: Buffer.isBuffer(o.body) ? o.body.toString('base64') : o.body, requestContext: { domainName: HOST, http: { method, sourceIp: '203.0.113.9' } } });
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };

check(`node ${process.version} loads the bundled handler through index.mjs`, typeof handler === 'function');
const health = await handler(ev('GET', '/health'));
check('health', health.statusCode === 200, health.body);
const page = await handler(ev('GET', '/', { headers: { accept: 'text/html' } }));
check('sign-in page', page.statusCode === 200 && page.body.includes('Access code'));
const signed = await handler(ev('POST', '/signin', { headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` }));
check('sign-in', signed.statusCode === 303, signed.statusCode === 303 ? '' : signed.body.slice(0, 200));
const cookie = (signed.cookies?.[0] ?? '').split(';')[0];
const tools = await handler(ev('POST', '/mcp', { cookies: [cookie], headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
check('MCP tools/list', JSON.parse(tools.body).result?.tools?.length === 8);
// knowledge comes from the knowledge table: the bundle carries the example recipes but no vocabulary, roles or patterns
const book = await handler(ev('POST', '/mcp', { cookies: [cookie], headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_recipes', arguments: {} } }) }));
check('two prepared examples compiled from the knowledge table (no knowledge files in the bundle)', JSON.parse(book.body).result?.structuredContent?.recipes?.length === 2
  && !existsSync(join(stage, 'content/approved/patterns')) && !existsSync(join(stage, 'content/approved/vocabulary.json')));
const js = await handler(ev('GET', '/', { cookies: [cookie], headers: { accept: 'text/html' } }));
check('the companion is served after sign-in', js.statusCode === 200 && js.body.includes('<script'));
const sample = await handler(ev('GET', '/sample/scones-explicit.pdf', { cookies: [cookie] }));
check('the sample PDF is served after sign-in', sample.statusCode === 200 && sample.headers['content-type'] === 'application/pdf');
const pdf = readFileSync(join(stage, 'dist/web/sample/scones-explicit.pdf'));
const up = await handler(ev('POST', '/uploads', { cookies: [cookie], headers: { origin: ORIGIN, 'content-type': 'application/pdf', 'x-filename': 'scones-explicit.pdf' }, body: pdf }));
check('PDF upload read by the pruned pdf.js', up.statusCode === 201, up.body.slice(0, 120));
const bad = results.filter((r) => !r[1]).length;
console.log(bad ? `✗ ${bad} failed` : `✓ all ${results.length} passed`);
process.exit(bad ? 1 : 0);
