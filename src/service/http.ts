// The HTTP surface, as one web-standard handler (Request → Response) so the same code serves a local Node listener and a
// Lambda Function URL (lambda.ts): /mcp (Streamable HTTP, stateless, JSON responses), /activity, /health, /speech,
// import/draft routes, owner routes (/authoring/*, /admin/start-over; bearer CC_OWNER_TOKEN), and the built companion.
// Deployed, a judge sign-in (gate.ts) guards every route but /health and the sign-in itself, and each session is its own
// workspace; locally there is one kitchen. Live calls are attributed to the request's workspace (spender).
import { createServer, type RequestListener, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Conflict, NotFound, type Authoring } from '../authoring/drafts.ts';
import { spender } from '../authoring/nova.ts';
import type { Service } from './commands.ts';
import type { Kv } from './kv.ts';
import { signInPage, type Gate } from './gate.ts';
import { buildMcp } from './mcp.ts';
import type { Speaker } from './speech.ts';

/** The upload's display name. Headers carry Latin-1 only, so the companion percent-encodes it ("Sloppy Joseph — …"); a name
 *  that isn't valid percent-encoding is an older client's raw name, kept as sent. */
const fileName = (req: Request) => {
  const h = req.headers.get('x-filename');
  if (!h) return 'upload.pdf';
  try { return decodeURIComponent(h).slice(0, 200); } catch { return h.slice(0, 200); }
};
export interface Workspace { svc: Service; authoring?: Authoring }
export interface AppOptions {
  /** The services for one workspace (made per request; cheap). */
  workspace: (ws: string) => Workspace;
  /** Deployed: judge sign-in, one workspace per session. Absent: one local kitchen (`local`, else 'kitchen'). */
  gate?: Gate | null;
  local?: { current(): Promise<string>; startOver(): Promise<string> };
  /** Browser origins allowed to call (the MCP transport spec requires the check; it is also the CSRF defence). */
  origins: (url: URL) => string[];
  ownerToken?: string | null; speaker?: Speaker | null; webRoot?: string;
  /** `knowledge`: the ACTIVE knowledge release id (null: none can be read; imports and examples are unavailable). */
  health: { interpreter: string; knowledge?: () => Promise<string | null> };
  /** The owner's maintenance switch (deployed): while frozen, no new request starts. */
  maintenance?: () => Promise<{ frozen?: boolean } | null | undefined>;
  /** Largest PDF accepted (a Lambda Function URL takes at most 6 MB per request, before base64). */
  maxPdfBytes?: number;
}
export type Handler = (req: Request, sourceIp?: string) => Promise<Response>;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
const json = (status: number, v: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function raw(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length') ?? 0) > limit) throw new Error('TOO_LARGE');
  const chunks: Uint8Array[] = []; let n = 0;
  for await (const c of (req.body ?? []) as AsyncIterable<Uint8Array>) { n += c.length; if (n > limit) throw new Error('TOO_LARGE'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const body = async (req: Request) => { const b = await raw(req, 1_000_000); return b.length ? JSON.parse(Buffer.from(b).toString('utf8')) as unknown : undefined; };
const MAINTENANCE = 'CourseCorrect is paused for a few minutes of maintenance. Nothing was changed; try again shortly.';
const maintenancePage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CourseCorrect · Maintenance</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:380px}</style></head>
<body><main><h1>CourseCorrect</h1><p>${MAINTENANCE}</p></main></body></html>`;
const wantsPage = (req: Request) => req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html');

export function app(o: AppOptions): Handler {
  const owner = (req: Request) => !!o.ownerToken && sameSecret(req.headers.get('authorization') ?? '', `Bearer ${o.ownerToken}`);
  return async (req, sourceIp = 'local') => {
    try {
      const url = new URL(req.url);
      const origin = req.headers.get('origin');
      if (origin && !o.origins(url).includes(origin)) return json(403, { error: `Invalid Origin: ${origin}` });   // DNS-rebinding and cross-site defence
      const mode = o.maintenance ? await o.maintenance() : null;
      if (url.pathname === '/health') return json(200, { ok: true, interpreter: o.health.interpreter, speech: o.speaker ? 'polly' : 'off', ...(o.gate ? { signIn: true } : {}), ...(mode?.frozen ? { maintenance: true } : {}),
        ...(o.health.knowledge ? { knowledge: await o.health.knowledge().catch(() => null) } : {}) });
      // Maintenance (owner: npm run cc -- backup / maintenance): no new request starts; requests already running finish.
      if (mode?.frozen) return wantsPage(req) ? html(503, maintenancePage(), { 'retry-after': '300' }) : json(503, { error: { code: 'MAINTENANCE', message: MAINTENANCE } }, { 'retry-after': '300' });
      // Start over (local owner key): the kitchen moves to a new, empty workspace; the previous one is kept in the database.
      if (url.pathname === '/admin/start-over' && req.method === 'POST') {
        if (!owner(req)) return json(401, { error: 'owner capability required' });
        if (!o.local) return json(404, { error: { code: 'START_OVER_OFF', message: 'Start over is not available on this server.' } });
        return json(200, { ok: true, kept: 'The previous kitchen is kept in the database.', workspace: await o.local.startOver() });
      }
      let ws: string;
      if (o.gate) {
        if (url.pathname === '/signin') return await signIn(o.gate, req, sourceIp, url);
        // a browser session (cookie), or an MCP client's bearer token for one workspace (no cookie, so no CSRF; a foreign Origin is still refused above)
        const bearer = o.gate.bearer(req.headers.get('authorization'));
        const s = bearer ?? o.gate.session(req.headers.get('cookie'));
        if (!s) return wantsPage(req) ? html(200, signInPage('', url.searchParams.get('code') ?? '')) : json(401, { error: { code: 'SIGN_IN_REQUIRED', message: 'Your session ended. Reload the page and sign in.' } });
        if (!bearer && req.method !== 'GET' && req.method !== 'HEAD' && !origin) return json(403, { error: 'Origin required' });   // a browser always sends it on POST
        if (url.pathname === '/mcp-token' && req.method === 'GET') {
          if (bearer) return json(403, { error: { code: 'BROWSER_ONLY', message: 'Ask for a token from a signed-in browser.' } });
          return json(200, { endpoint: `${url.origin}/mcp`, ...o.gate.token(s) }, { 'cache-control': 'no-store' });
        }
        if (url.pathname === '/workspace/reset' && req.method === 'POST') {
          if (bearer) return json(403, { error: { code: 'BROWSER_ONLY', message: 'Start over is in the companion.' } });
          const next = await o.gate.newWorkspace('reset', s);
          if (!next) return json(503, { error: { code: 'WORKSPACE_LIMIT', message: "Today's new-workspace limit is reached; this kitchen is unchanged." } });
          return json(200, { ok: true }, { 'set-cookie': o.gate.cookie(next) });
        }
        ws = s;
      } else ws = o.local ? await o.local.current() : 'kitchen';
      const w = o.workspace(ws);
      return await spender.run(ws, () => route(o, w, req, url, owner(req)));
    } catch (e) {
      if ((e as Error).message === 'TOO_LARGE') return json(413, { error: { code: 'TOO_LARGE', message: 'That file is too large.' } });
      console.error(`http: ${(e as Error).name}: ${(e as Error).message}`.slice(0, 400));
      return json(500, { error: (e as Error).message });
    }
  };
}

async function signIn(gate: Gate, req: Request, sourceIp: string, url: URL) {
  if (req.method !== 'POST') return html(200, signInPage('', url.searchParams.get('code') ?? ''));
  const form = (req.headers.get('content-type') ?? '').includes('application/json');
  const text = Buffer.from(await raw(req, 10_000)).toString('utf8');
  const code = form ? String((JSON.parse(text || '{}') as { code?: unknown }).code ?? '') : new URLSearchParams(text).get('code') ?? '';
  const r = await gate.signIn(code, sourceIp);
  if (!r.ok) return form ? json(r.status, { error: { code: 'SIGN_IN_FAILED', message: r.message } }) : html(r.status, signInPage(r.message));
  const cookie = { 'set-cookie': gate.cookie(r.ws) };
  // JSON sign-in (scripts and MCP clients) also returns a bearer token for the new workspace's /mcp
  return form ? json(200, { ok: true, endpoint: `${url.origin}/mcp`, ...gate.token(r.ws) }, cookie) : new Response(null, { status: 303, headers: { location: '/', ...cookie } });
}

async function route(o: AppOptions, w: Workspace, req: Request, url: URL, isOwner: boolean): Promise<Response> {
  const { svc, authoring } = w;
  if (url.pathname === '/speech' && req.method === 'POST') {
    if (!o.speaker) return json(503, { error: { code: 'SPEECH_OFF', message: 'Spoken replies are off on this server.' } });
    const text = await svc.speechText(((await body(req)) ?? {}) as Parameters<Service['speechText']>[0]);
    if (!text) return json(404, { error: { code: 'NOT_SPEAKABLE', message: 'Only text this service rendered can be spoken.' } });
    const r = await o.speaker.synthesize(text);
    if (!r.ok) return json(r.error === 'BUDGET_EXCEEDED' ? 402 : 502, { error: { code: r.error, message: r.detail } });
    return new Response(r.audio, { status: 200, headers: { 'content-type': 'audio/mpeg', 'x-speech-cached': String(r.cached), 'x-speech-text-chars': String(text.length), 'x-speech-id': r.id } });
  }
  if (url.pathname === '/activity' && req.method === 'GET') {
    return json(200, { entries: await svc.activity(url.searchParams.get('runId') ?? undefined, Number(url.searchParams.get('after') ?? 0)) });
  }
  if (authoring && (url.pathname.startsWith('/imports') || url.pathname === '/uploads' || url.pathname.startsWith('/drafts') || url.pathname.startsWith('/recipes') || url.pathname.startsWith('/authoring/'))) {
    if (url.pathname.startsWith('/authoring/') && !isOwner) return json(401, { error: 'owner capability required' });   // owner review and repair
    const approved = req.method === 'GET' && url.pathname.startsWith('/recipes/') ? await svc.approvedRecipe(url.pathname.split('/')[2] ?? '') : null;
    if (approved) return json(200, approved);
    return await authoringRoute(authoring, req, url, o.maxPdfBytes ?? 11 * 1024 * 1024);
  }
  if (url.pathname === '/mcp') {
    // Stateless, JSON responses only: no server-sent event stream to hold open (405 is the spec's answer to GET).
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const mcp = buildMcp(svc, authoring);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try { return await transport.handleRequest(req); } finally { await mcp.close(); }
  }
  if (o.webRoot && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(o.webRoot, url.pathname);
  return json(404, { error: 'Not found' });
}

/** The built companion. Unknown paths fall back to index.html (single page; no client routes collide with the API). */
function serveStatic(root: string, path: string) {
  const file = normalize(join(root, decodeURIComponent(path)));
  const target = file.startsWith(root) && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
  if (!existsSync(target)) return json(404, { error: 'The companion is not built. Run npm run build:web.' });
  return new Response(readFileSync(target), { status: 200, headers: { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
}

/** Import / draft routes (FE–BE Contract v1 §4.2) and owner authoring routes (ESOD §8.5). Web requests, never MCP. */
async function authoringRoute(a: Authoring, req: Request, url: URL, maxPdf: number): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/imports') {
      const type = req.headers.get('content-type') ?? '';
      const key = req.headers.get('idempotency-key') ?? undefined;
      let input: Parameters<Authoring['createImport']>[0];
      if (type.startsWith('application/pdf')) input = { kind: 'pdf', bytes: await raw(req, maxPdf), filename: fileName(req) };
      else {
        const b = JSON.parse(Buffer.from(await raw(req, 300_000)).toString('utf8')) as { kind?: string; text?: string; title?: string };
        if (b.kind !== 'text' || typeof b.text !== 'string') return json(400, { error: { code: 'NOT_A_PDF', message: 'Send a PDF (application/pdf) or {"kind":"text","text":"…"}.' } });
        input = { kind: 'text', text: b.text, title: b.title };
      }
      const r = await a.createImport(input, key);
      return r.status === 202 ? json(202, { job: r.job, draftId: r.draftId }) : json(r.status, { error: r.error });
    }
    if (req.method === 'POST' && url.pathname === '/uploads') {   // upload only; the import itself is the import_recipe MCP tool
      if (!(req.headers.get('content-type') ?? '').startsWith('application/pdf')) return json(400, { error: { code: 'NOT_A_PDF', message: "That file isn't a PDF." } });
      const r = await a.upload(await raw(req, maxPdf), fileName(req));
      return r.status === 201 ? json(201, { sourceDocId: r.sourceDocId }) : json(r.status, { error: r.error });
    }
    if (req.method === 'GET' && parts[0] === 'imports' && parts[1] && !parts[2]) return json(200, await a.getImport(parts[1]));
    // the same job again (never a second one): what didn't finish, within its run limit (commission 2026-10-13)
    if (req.method === 'POST' && parts[0] === 'imports' && parts[1] && parts[2] === 'retry') return json(202, { job: await a.retryImport(parts[1]) });
    if (req.method === 'POST' && parts[0] === 'imports' && parts[1] && parts[2] === 'choose') return json(202, { job: await a.chooseRecipe(parts[1], Number(((await body(req)) as { index?: unknown } | null)?.index)) });
    if (parts[0] === 'drafts' && parts[1]) {
      const id = parts[1];
      if (req.method === 'GET' && !parts[2]) return json(200, await a.getDraft(id));
      const b = (await body(req)) as Record<string, unknown>;
      if (req.method === 'POST' && parts[2] === 'append-text') return json(202, await a.appendText(id, b as never));
      if (req.method === 'POST' && parts[2] === 'confirmations') return json(200, await a.confirm(id, b as never));
      if (req.method === 'POST' && parts[2] === 'choices') return json(200, await a.chooseOption(id, b as never));
      if (req.method === 'POST' && parts[2] === 'save') return json(200, await a.save(id, { ...(b as object), idempotencyKey: req.headers.get('idempotency-key') ?? (b.idempotencyKey as string | undefined) } as never));
    }
    if (req.method === 'GET' && parts[0] === 'recipes' && parts[1]) return json(200, await a.getRecipe(parts[1]));
    if (req.method === 'GET' && url.pathname === '/authoring/vocabulary') return json(200, await a.vocabulary());
    if (parts[0] === 'authoring' && parts[1] === 'drafts' && parts[2]) {
      const id = parts[2];
      if (req.method === 'GET' && parts[3] === 'requirements') return json(200, await a.requirements(id));
      const b = (await body(req)) as Record<string, unknown>;
      if (req.method === 'POST' && parts[3] === 'assertions') return json(200, await a.assert(id, b as never));
      if (req.method === 'POST' && parts[3] === 'revisions') return json(200, await a.repair(id, b as never));
    }
    return json(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof Conflict) return json(409, { error: { code: e.message } });
    if (e instanceof NotFound) return json(404, { error: { code: 'NOT_FOUND', detail: e.message } });
    if ((e as Error).message === 'TOO_LARGE') return json(413, { error: { code: 'TOO_LARGE', message: 'That file is too large.' } });
    throw e;
  }
}

// ---------- one local kitchen on a Node listener (the product's local run, tests, walkthroughs) ----------
/** The local kitchen's current workspace; Start over moves it to a new, empty one (the previous one stays in the store). */
export function localKitchen(kv: Kv): NonNullable<AppOptions['local']> {
  const KITCHEN = { pk: 'LOCAL', sk: 'KITCHEN' };
  return {
    async current() { return ((await kv.get(KITCHEN))?.ws as string | undefined) ?? 'kitchen'; },
    async startOver() { const ws = `kitchen_${randomUUID()}`; await kv.write([{ put: { ...KITCHEN, ws } }]); return ws; },
  };
}
export interface HttpOptions { port: number; ownerToken?: string | null; host?: string; authoring?: Authoring; speaker?: Speaker | null; webRoot?: string; local?: AppOptions['local']; workspace?: AppOptions['workspace'] }
export const localOrigins = (port: number) => () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
/** As a Node request listener, so a test server can serve its own routes beside it (tests/support/server.ts). */
export function handler(svc: Service, o: HttpOptions): RequestListener {
  const fetchApp = app({
    workspace: o.workspace ?? (() => ({ svc, authoring: o.authoring })), local: o.local, origins: localOrigins(o.port),
    ownerToken: o.ownerToken, speaker: o.speaker, webRoot: o.webRoot,
    health: { interpreter: svc.interpreter.mode, knowledge: () => svc.knowledge.active().then((c) => c.releaseId) },
  });
  return getRequestListener((req) => fetchApp(req), { overrideGlobalObjects: false }) as unknown as RequestListener;
}
export function startHttp(svc: Service, o: HttpOptions): Promise<Server> {
  const server = createServer(handler(svc, o));
  return new Promise((resolve) => server.listen(o.port, o.host ?? '127.0.0.1', () => resolve(server)));
}
