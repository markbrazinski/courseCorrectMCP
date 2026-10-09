// One HTTP listener: /mcp (Streamable HTTP, stateless), /activity, /health, /speech, import/draft routes, owner routes
// (/authoring/*, /admin/start-over; bearer CC_OWNER_TOKEN), and the built companion (static files) at /.
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Conflict, NotFound, type Authoring } from '../authoring/drafts.ts';
import type { Service } from './commands.ts';
import { buildMcp } from './mcp.ts';
import type { Speaker } from './speech.ts';

export interface HttpOptions { port: number; ownerToken?: string | null; host?: string; authoring?: Authoring; speaker?: Speaker | null; webRoot?: string; archiveDir?: string }
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const raw = (req: IncomingMessage, limit = 11 * 1024 * 1024) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = []; let n = 0;
  req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { reject(new Error('TOO_LARGE')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const body = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 1_000_000) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const json = (res: ServerResponse, status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startHttp(svc: Service, o: HttpOptions): Promise<Server> {
  const server = createServer(handler(svc, o));
  return new Promise((resolve) => server.listen(o.port, o.host ?? '127.0.0.1', () => resolve(server)));
}

/** The request handler on its own, so a test server can serve its own routes beside it (tests/support/server.ts). */
export function handler(svc: Service, o: HttpOptions): RequestListener {
  const host = o.host ?? '127.0.0.1';
  const owner = (req: IncomingMessage) => !!o.ownerToken && sameSecret(req.headers.authorization ?? '', `Bearer ${o.ownerToken}`);
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const origin = req.headers.origin;
      const allowed = [`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`];
      if (origin && !allowed.includes(origin)) return json(res, 403, { error: `Invalid Origin: ${origin}` });   // DNS-rebinding defence
      if (url.pathname === '/health') return json(res, 200, { ok: true, interpreter: svc.interpreter.mode, speech: o.speaker ? 'polly' : 'off' });
      if (url.pathname === '/speech' && req.method === 'POST') {
        if (!o.speaker) return json(res, 503, { error: { code: 'SPEECH_OFF', message: 'Spoken replies are off on this server.' } });
        const text = svc.speechText(((await body(req)) ?? {}) as Parameters<Service['speechText']>[0]);
        if (!text) return json(res, 404, { error: { code: 'NOT_SPEAKABLE', message: 'Only text this service rendered can be spoken.' } });
        const r = await o.speaker.synthesize(text);
        if (!r.ok) return json(res, r.error === 'BUDGET_EXCEEDED' ? 402 : 502, { error: { code: r.error, message: r.detail } });
        return res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(r.audio.length), 'x-speech-cached': String(r.cached), 'x-speech-text-chars': String(text.length), 'x-speech-id': r.id }).end(r.audio);
      }
      if (url.pathname === '/activity' && req.method === 'GET') {
        return json(res, 200, { entries: svc.activity(url.searchParams.get('runId') ?? undefined, Number(url.searchParams.get('after') ?? 0)) });
      }
      // Start over (owner key): archives the database, then clears cooking sessions, imports and Activity. The owner-authored
      // example recipes stay listed; nothing is replayed or restored.
      if (url.pathname === '/admin/start-over' && req.method === 'POST') {
        if (!owner(req)) return json(res, 401, { error: 'owner capability required' });
        if (!o.archiveDir) return json(res, 404, { error: { code: 'START_OVER_OFF', message: 'Start over is not available on this server.' } });
        mkdirSync(o.archiveDir, { recursive: true });
        return json(res, 200, svc.startOver(join(o.archiveDir, `before-start-over-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)));
      }
      if (o.authoring && (url.pathname.startsWith('/imports') || url.pathname === '/uploads' || url.pathname.startsWith('/drafts') || url.pathname.startsWith('/recipes') || url.pathname.startsWith('/authoring/'))) {
        if (url.pathname.startsWith('/authoring/') && !owner(req)) return json(res, 401, { error: 'owner capability required' });   // owner review and repair
        const approved = req.method === 'GET' && url.pathname.startsWith('/recipes/') ? svc.approvedRecipe(url.pathname.split('/')[2] ?? '') : null;
        if (approved) return json(res, 200, approved);
        return await authoringRoute(o.authoring, req, res, url);
      }
      if (url.pathname !== '/mcp') {
        if (o.webRoot && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(o.webRoot, url.pathname, res);
        return json(res, 404, { error: 'Not found' });
      }
      const mcp = buildMcp(svc, o.authoring);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? await body(req) : undefined);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    }
  };
}

/** The built companion. Unknown paths fall back to index.html (single page; no client routes collide with the API). */
function serveStatic(root: string, path: string, res: ServerResponse) {
  const file = normalize(join(root, decodeURIComponent(path)));
  const target = file.startsWith(root) && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html');
  if (!existsSync(target)) return json(res, 404, { error: 'The companion is not built. Run npm run build:web.' });
  return res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(target));
}

/** Import / draft routes (FE–BE Contract v1 §4.2) and owner authoring routes (ESOD §8.5). Web requests, never MCP. */
async function authoringRoute(a: Authoring, req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/imports') {
      const type = req.headers['content-type'] ?? '';
      const key = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
      let input: Parameters<Authoring['createImport']>[0];
      if (type.startsWith('application/pdf')) input = { kind: 'pdf', bytes: new Uint8Array(await raw(req)), filename: String(req.headers['x-filename'] ?? 'upload.pdf') };
      else {
        const b = JSON.parse((await raw(req, 300_000)).toString('utf8')) as { kind?: string; text?: string; title?: string };
        if (b.kind !== 'text' || typeof b.text !== 'string') return json(res, 400, { error: { code: 'NOT_A_PDF', message: 'Send a PDF (application/pdf) or {"kind":"text","text":"…"}.' } });
        input = { kind: 'text', text: b.text, title: b.title };
      }
      const r = await a.createImport(input, key);
      return r.status === 202 ? json(res, 202, { job: r.job, draftId: r.draftId }) : json(res, r.status, { error: r.error });
    }
    if (req.method === 'POST' && url.pathname === '/uploads') {   // upload only; the import itself is the import_recipe MCP tool
      if (!(req.headers['content-type'] ?? '').startsWith('application/pdf')) return json(res, 400, { error: { code: 'NOT_A_PDF', message: "That file isn't a PDF." } });
      const r = await a.upload(new Uint8Array(await raw(req)), String(req.headers['x-filename'] ?? 'upload.pdf'));
      return r.status === 201 ? json(res, 201, { sourceDocId: r.sourceDocId }) : json(res, r.status, { error: r.error });
    }
    if (req.method === 'GET' && parts[0] === 'imports' && parts[1]) return json(res, 200, a.getImport(parts[1]));
    if (parts[0] === 'drafts' && parts[1]) {
      const id = parts[1];
      if (req.method === 'GET' && !parts[2]) return json(res, 200, a.getDraft(id));
      const b = (await body(req)) as Record<string, unknown>;
      if (req.method === 'POST' && parts[2] === 'append-text') return json(res, 202, a.appendText(id, b as never));
      if (req.method === 'POST' && parts[2] === 'save') return json(res, 200, a.save(id, { ...(b as object), idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? (b.idempotencyKey as string | undefined) } as never));
    }
    if (req.method === 'GET' && parts[0] === 'recipes' && parts[1]) return json(res, 200, a.getRecipe(parts[1]));
    if (req.method === 'GET' && url.pathname === '/authoring/vocabulary') return json(res, 200, a.vocabulary());
    if (parts[0] === 'authoring' && parts[1] === 'drafts' && parts[2]) {
      const id = parts[2];
      if (req.method === 'GET' && parts[3] === 'requirements') return json(res, 200, a.requirements(id));
      const b = (await body(req)) as Record<string, unknown>;
      if (req.method === 'POST' && parts[3] === 'assertions') return json(res, 200, a.assert(id, b as never));
      if (req.method === 'POST' && parts[3] === 'revisions') return json(res, 200, a.repair(id, b as never));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof Conflict) return json(res, 409, { error: { code: e.message } });
    if (e instanceof NotFound) return json(res, 404, { error: { code: 'NOT_FOUND', detail: e.message } });
    if ((e as Error).message === 'TOO_LARGE') return json(res, 413, { error: { code: 'TOO_LARGE', message: 'That file is too large.' } });
    throw e;
  }
}
