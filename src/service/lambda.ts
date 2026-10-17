// Entry point (the deployed service on AWS Lambda; infra/app.yaml). One bundle, two functions:
//   web:    Lambda Function URL requests (payload 2.0, buffered) → the same web handler the local server uses (http.ts);
//   worker: { job: { ws, jobId } }, an asynchronous invocation the web function makes when an import is queued → claim and
//           run that job (drafts.ts runJob: a duplicate or late delivery does nothing). Never reachable over HTTP.
// Env (set by the template; secrets as NoEcho parameters):
//   CC_TABLE, CC_KNOWLEDGE_TABLE (read only: knowledge releases the owner publishes), CC_BUCKET, CC_WORKER_FUNCTION (web only), CC_SESSION_KEY (base64, ≥32 bytes), CC_JUDGE_CODE_SHA256 (optional: the judge link's code, tier "judge"), CC_ACCESS_CODE_SHA256 (comma list),
//   CC_AWS_IDENTITY=role/<execution role>, CC_LIVE, CC_EXTRACTOR none|live, CC_ANALYZER none|live, CC_INTERPRETER none|nova,
//   CC_EXPLAINER none|nova, CC_SPEECH off|polly, CC_OCR off|textract (PDF pages without readable text; needs CC_LIVE=1), CC_PUBLIC_ORIGIN (optional extra origin), CC_MAX_PDF_BYTES (default 4 MB).
// Paid calls are reserved in the deployed ledger (KvLedger) under the authorization item the owner records with
// `npm run cc -- allowances`; without one, every paid call is refused.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, offExtractor } from '../authoring/extract.ts';
import { KvLedger, NovaClient, spender, verifyIdentity, identityPolicy } from '../authoring/nova.ts';
import { textractOcr } from '../authoring/ocr.ts';
import { novaAnalyzer, offAnalyzer } from '../authoring/swap-analysis.ts';
import { Service } from './commands.ts';
import { exampleIds, PRODUCT_EXAMPLES, storeKnowledge } from './content.ts';
import { activeReleaseId } from '../knowledge/release.ts';
import { noneExplainer, novaExplainer } from './explain.ts';
import { Gate } from './gate.ts';
import { app } from './http.ts';
import { noneInterpreter, novaInterpreter } from './interpret.ts';
import { DynamoKv } from './kv-dynamo.ts';
import { maintenanceMode } from './kv.ts';
import { s3Cache, Speaker } from './speech.ts';
import { meter, serverTiming, timed } from './timing.ts';

const loadedMs = performance.now();   // since the process started: runtime start plus loading every module

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
/** One setting, one of its allowed values; anything else fails the cold start (never a silent fallback). */
function mode<T extends string>(name: string, allowed: readonly T[]): T {
  const v = process.env[name] ?? allowed[0];
  if (!allowed.includes(v as T)) throw new Error(`${name}=${v}: expected ${allowed.join(' or ')}`);
  return v as T;
}
const onLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const modes = {
  extractor: mode('CC_EXTRACTOR', ['none', 'live']), analyzer: mode('CC_ANALYZER', ['none', 'live']),
  interpreter: mode('CC_INTERPRETER', ['none', 'nova']), explainer: mode('CC_EXPLAINER', ['none', 'nova']), speech: mode('CC_SPEECH', ['off', 'polly']),
  ocr: mode('CC_OCR', ['off', 'textract']),
};
const kv = meter(new DynamoKv(env('CC_TABLE'), { endpoint: process.env.CC_DYNAMO_ENDPOINT }), 'db');   // the endpoint override is for DynamoDB Local only
// Culinary knowledge comes only from the knowledge table (2026-10-11): never the bundled JSON, which isn't even in the bundle. No
// active release: the service still starts; imports and example recipes say knowledge is unavailable, and sessions pinned to a
// readable release keep working. A release is read and compiled on first use (counted in that request's db time), then cached.
const knowledgeKv = meter(new DynamoKv(env('CC_KNOWLEDGE_TABLE'), { endpoint: process.env.CC_DYNAMO_ENDPOINT }), 'db');
const knowledge = storeKnowledge(knowledgeKv);
const examples = exampleIds(PRODUCT_EXAMPLES);   // risotto and shortcake; the scones are the sample import
let mark = performance.now();
const ledger = new KvLedger(kv);
const live = modes.extractor === 'live' || modes.analyzer === 'live' || modes.interpreter === 'nova' || modes.explainer === 'nova' || modes.speech === 'polly' || modes.ocr === 'textract';
mark = performance.now();
if (live) {   // live AWS only as the identity the policy names (the function's own execution role)
  const id = await verifyIdentity(identityPolicy());
  if (!id.ok) throw new Error(`refusing live calls: AWS identity is ${id.principal}, not the identity CC_AWS_IDENTITY names`);
}
const identityMs = performance.now() - mark;
const nova = () => new NovaClient(ledger);
const interpreter = meter(modes.interpreter === 'nova' ? novaInterpreter(nova()) : noneInterpreter, 'model');
const extractor = modes.extractor === 'live' ? novaExtractor(nova()) : offExtractor;
const analyzer = modes.analyzer === 'live' ? novaAnalyzer(nova()) : offAnalyzer;
const explainer = meter(modes.explainer === 'nova' ? novaExplainer(nova()) : noneExplainer, 'model');
const speaker = modes.speech === 'polly' ? new Speaker(ledger, s3Cache(env('CC_BUCKET'))) : null;
const ocr = modes.ocr === 'textract' ? textractOcr({ bucket: env('CC_BUCKET'), ledger, deadlineMs: 180_000 }) : undefined;

const worker = process.env.CC_WORKER_FUNCTION;
if (onLambda && !worker && !process.env.CC_IS_WORKER) throw new Error('CC_WORKER_FUNCTION is required: an import must not depend on the request that started it');
const lambda = new LambdaClient({});
const dispatch = worker
  ? async (ws: string, jobId: string) => { await lambda.send(new InvokeCommand({ FunctionName: worker, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ job: { ws, jobId } })) })); }
  : undefined;   // off Lambda (a local check of this entry): the job runs in this process
const workspace = (ws: string) => {
  const svc = new Service({ kv, ws, knowledge, interpreter, explainer, fixtureRecipes: examples });
  const authoring = new Authoring({ kv, ws, knowledge, extractor, analyzer, dispatch, ocr });
  svc.catalog = (t) => authoring.catalogIn(t);
  return { svc, authoring };
};
const hashes = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const judge = hashes(process.env.CC_JUDGE_CODE_SHA256);   // optional: the judge link's code, under Authorization.tiers.judge
const gate = new Gate({ kv, ledger, codeHashes: hashes(env('CC_ACCESS_CODE_SHA256')), tierCodes: judge.length ? { judge } : {}, sessionKey: Buffer.from(env('CC_SESSION_KEY'), 'base64'), secure: process.env.CC_INSECURE_COOKIE !== '1' });
const web = app({
  workspace, gate, speaker, webRoot: join(import.meta.dirname, '../../dist/web'), health: { interpreter: interpreter.mode, knowledge: () => activeReleaseId(knowledgeKv) }, maintenance: () => maintenanceMode(kv),
  origins: (url) => [url.origin, ...(process.env.CC_PUBLIC_ORIGIN ? [process.env.CC_PUBLIC_ORIGIN] : [])],
  maxPdfBytes: Number(process.env.CC_MAX_PDF_BYTES ?? 4 * 1024 * 1024),
});
console.log(JSON.stringify({ init: { loadedMs: Math.round(loadedMs), identityMs: Math.round(identityMs), totalMs: Math.round(performance.now()) } }));

// ---------- Function URL (payload format 2.0) ⇄ web-standard Request/Response ----------
export interface UrlEvent {
  rawPath: string; rawQueryString?: string; headers?: Record<string, string>; cookies?: string[]; body?: string; isBase64Encoded?: boolean;
  requestContext: { domainName: string; http: { method: string; sourceIp: string } };
}
export interface UrlResult { statusCode: number; headers: Record<string, string>; cookies?: string[]; body: string; isBase64Encoded: boolean }
export function toRequest(e: UrlEvent): Request {
  const method = e.requestContext.http.method;
  const headers = new Headers(e.headers ?? {});
  if (e.cookies?.length) headers.set('cookie', e.cookies.join('; '));
  const body = method === 'GET' || method === 'HEAD' || e.body === undefined ? undefined : e.isBase64Encoded ? Buffer.from(e.body, 'base64') : e.body;
  return new Request(`https://${e.requestContext.domainName}${e.rawPath}${e.rawQueryString ? `?${e.rawQueryString}` : ''}`, { method, headers, body });
}
export async function toResult(res: Response): Promise<UrlResult> {
  const bytes = Buffer.from(await res.arrayBuffer()), type = res.headers.get('content-type') ?? '';
  const text = /^(text\/|application\/json)/.test(type) || !bytes.length;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = res.headers.getSetCookie();
  return { statusCode: res.status, headers, ...(cookies.length ? { cookies } : {}), body: text ? bytes.toString('utf8') : bytes.toString('base64'), isBase64Encoded: !text };
}

export async function handler(event: UrlEvent | { job: { ws: string; jobId: string } }): Promise<UrlResult | { ran: string }> {
  if ('job' in event) {   // the worker: only an asynchronous invocation reaches this (the worker function has no URL)
    const { ws, jobId } = event.job;
    const ran = await spender.run(ws, () => workspace(ws).authoring.runJob(jobId));
    console.log(JSON.stringify({ worker: jobId, ran }));
    return { ran };
  }
  const t0 = performance.now(), { out: res, spent } = await timed(async () => toResult(await web(toRequest(event), event.requestContext.http.sourceIp)));
  const ms = performance.now() - t0;
  res.headers['server-timing'] = serverTiming(spent, ms);
  if (event.requestContext.http.method !== 'GET' || res.statusCode >= 400) {
    let rpc: { method?: string; params?: { name?: string } } | null = null;   // which MCP call (never its arguments)
    if (event.rawPath === '/mcp' && event.body && !event.isBase64Encoded) try { rpc = JSON.parse(event.body); } catch { /* not JSON: the transport answers it */ }
    console.log(JSON.stringify({ m: event.requestContext.http.method, p: event.rawPath, ...(rpc ? { rpc: rpc.params?.name ?? rpc.method } : {}), s: res.statusCode, ms: Math.round(ms), db: Math.round(spent.db), dbN: spent.dbN, ...(spent.modelN ? { model: Math.round(spent.model) } : {}) }));
  }
  return res;
}
