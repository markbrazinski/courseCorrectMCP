// Judge access (deployed service): one shared access code opens a NEW workspace per sign-in, held in a signed cookie.
// A shared code never means a shared kitchen: each sign-in (and each "Start over") gets its own partition. Codes are
// stored only as SHA-256 hashes; the cookie is HMAC-SHA256 signed, HttpOnly, Secure and SameSite=Strict. Failed sign-ins
// are throttled per source address; new workspaces are capped per day by the live authorization.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tierOf, type KvLedger } from '../authoring/nova.ts';
import type { Kv } from './kv.ts';

export const COOKIE = 'cc_ws';
const MAX_AGE_S = 30 * 24 * 3600;
const FAILS_PER_WINDOW = 10, WINDOW_MS = 15 * 60_000;
export const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** tierCodes: codes that open a workspace under a tier's own allowance (Authorization.tiers), e.g. { judge: [hash] } for the judge link. */
export interface GateOptions { kv: Kv; ledger: KvLedger; codeHashes: string[]; tierCodes?: Record<string, string[]>; sessionKey: Buffer; secure?: boolean; now?: () => number }
export class Gate {
  private readonly o: GateOptions;
  constructor(o: GateOptions) {
    this.o = o;
    if (o.sessionKey.length < 32) throw new Error('CC_SESSION_KEY must be at least 32 bytes (base64)');
    if (!o.codeHashes.length || o.codeHashes.some((h) => !/^[0-9a-f]{64}$/.test(h))) throw new Error('CC_ACCESS_CODE_SHA256 must list SHA-256 hex hashes');
    if (Object.values(o.tierCodes ?? {}).flat().some((h) => !/^[0-9a-f]{64}$/.test(h))) throw new Error('tier access codes must be SHA-256 hex hashes');
  }
  private now() { return this.o.now?.() ?? Date.now(); }
  private sign(payload: string) { return createHmac('sha256', this.o.sessionKey).update(payload).digest('base64url'); }

  /** An MCP client's bearer token for one workspace (signed for a different purpose than the cookie: neither works as the other). */
  token(ws: string): { token: string; expiresAt: string } {
    const exp = Math.floor(this.now() / 1000) + MAX_AGE_S;
    return { token: `cc1.${ws}.${exp}.${this.sign(`mcp|${ws}.${exp}`)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }
  /** The workspace an `Authorization: Bearer cc1.…` header names, or null. */
  bearer(authorization: string | null): string | null {
    const m = /^Bearer cc1\.(ws_[\w-]{10,64})\.(\d+)\.([\w-]+)$/.exec(authorization ?? '');
    if (!m || Number(m[2]) * 1000 < this.now()) return null;
    return same(Buffer.from(m[3]), Buffer.from(this.sign(`mcp|${m[1]}.${m[2]}`))) ? m[1] : null;
  }
  /** The signed-in workspace, or null. */
  session(cookieHeader: string | null): string | null {
    const raw = (cookieHeader ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const [ws, exp, sig] = (raw ?? '').split('.');
    if (!ws || !exp || !sig || !/^ws_[\w-]{10,64}$/.test(ws)) return null;
    if (!same(Buffer.from(sig), Buffer.from(this.sign(`${ws}.${exp}`))) || Number(exp) * 1000 < this.now()) return null;
    return ws;
  }
  cookie(ws: string) {
    const exp = Math.floor(this.now() / 1000) + MAX_AGE_S;
    return `${COOKIE}=${ws}.${exp}.${this.sign(`${ws}.${exp}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${this.o.secure === false ? '' : '; Secure'}`;
  }

  /** A new, empty workspace (sign-in or Start over), within today's cap. The GATE row indexes it for the owner's tooling and
   *  holds its tier (the ledger reads it); Start over keeps the tier of the workspace it replaces. */
  async newWorkspace(via: 'signin' | 'reset', from?: string, tier?: string | null): Promise<string | null> {
    const t = tier ?? (via === 'reset' ? await tierOf(this.o.kv, from ?? null) : null);
    if (!(await this.o.ledger.newWorkspace(t))) return null;
    const ws = `ws_${randomBytes(16).toString('base64url')}`;
    await this.o.kv.write([{ put: { pk: 'GATE', sk: `WS#${ws}`, ws, via, from: from ?? null, ...(t ? { tier: t } : {}), at: new Date(this.now()).toISOString() }, if: 'absent' }]);
    return ws;
  }

  async signIn(code: string, source: string): Promise<{ ok: true; ws: string } | { ok: false; status: 401 | 429 | 503; message: string }> {
    const window = Math.floor(this.now() / WINDOW_MS);
    const failKey = { pk: 'GATE', sk: `FAIL#${sha256hex(source).slice(0, 16)}#${window}` };
    if (((await this.o.kv.get(failKey))?.n ?? 0) >= FAILS_PER_WINDOW) return { ok: false, status: 429, message: 'Too many attempts. Wait 15 minutes, then try again.' };
    const h = Buffer.from(sha256hex(code.trim()));
    const matches = (hashes: string[]) => hashes.some((x) => same(Buffer.from(x), h));
    const tier = Object.entries(this.o.tierCodes ?? {}).find(([, hashes]) => matches(hashes))?.[0] ?? null;
    if (!tier && !matches(this.o.codeHashes)) { await this.o.kv.incr(failKey); return { ok: false, status: 401, message: "That access code isn't right." }; }
    const ws = await this.newWorkspace('signin', undefined, tier);
    return ws ? { ok: true, ws } : { ok: false, status: 503, message: "Today's new-workspace limit is reached. Try again tomorrow, or contact the entrant." };
  }
}

/** The sign-in page (served instead of the companion until there is a session). Plain HTML, no script. */
/** With `code` (from an invitation link's ?code=), the code is filled in and one button starts: nothing signs in on a GET, so
 *  link previews and crawlers open no workspace. no-referrer keeps the code out of any outgoing request. */
export function signInPage(message = '', code = '') {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  // the companion's Index Card palette and type (src/web/index.html), so signing in looks like the app it opens
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>CourseCorrect · Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap">
<style>
:root{--cc-page:#EEE8DD;--cc-surface:#FFFDF9;--cc-chrome:#2A211B;--cc-on-chrome:#FFFCF6;--cc-text:#241C17;--cc-text-2:#54473D;--cc-border-strong:#8A7766;
--cc-action:#A9321F;--cc-on-action:#FFFFFF;--cc-focus:#1D5C58;--cc-attention:#A9321F;--cc-attention-bg:#FBE6E0;--cc-font-head:'Zilla Slab',Georgia,serif;--cc-font-body:'Source Sans 3','Segoe UI',Helvetica,Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--cc-page);color:var(--cc-text);font:17px/1.5 var(--cc-font-body)}
header{height:56px;flex:none;background:var(--cc-chrome);color:var(--cc-on-chrome);display:flex;align-items:center;padding:0 22px;font:700 20px var(--cc-font-head);letter-spacing:-.01em}
.wrap{flex:1;display:grid;place-items:center;padding:24px 16px}
main{width:100%;max-width:440px;background:var(--cc-surface);border-radius:16px;padding:28px 30px;box-shadow:0 20px 50px rgba(42,33,27,.18)}
h1{font:700 30px/1.2 var(--cc-font-head);margin:0 0 6px}p{color:var(--cc-text-2);margin:0 0 22px}
label{display:block;font-weight:700;margin-bottom:6px}
input{width:100%;font:inherit;font-size:18px;padding:12px 14px;border:1.5px solid var(--cc-border-strong);border-radius:10px;background:var(--cc-surface);color:var(--cc-text)}
:focus-visible{outline:3px solid var(--cc-focus);outline-offset:2px}
button{margin-top:16px;width:100%;font:inherit;font-size:18px;font-weight:700;padding:13px 20px;border:2px solid var(--cc-action);border-radius:10px;background:var(--cc-action);color:var(--cc-on-action);cursor:pointer}
.err{color:var(--cc-attention);background:var(--cc-attention-bg);border-radius:8px;padding:10px 12px;margin:14px 0 0;font-weight:600}</style></head><body>
<header>CourseCorrect</header><div class="wrap"><main>
${code ? '<h1>Welcome</h1><p>Your invitation has the access code filled in. Each start opens your own private kitchen.</p>' : '<h1>Sign in</h1><p>Enter the access code from the testing instructions. Each sign-in opens its own private kitchen.</p>'}
<form method="post" action="/signin"><label for="code">Access code</label><input id="code" name="code" autocomplete="off" required${code ? ` value="${esc(code)}"` : ' autofocus'}>
<button type="submit"${code ? ' autofocus' : ''}>${code ? 'Start cooking' : 'Sign in'}</button>${message ? `<p class="err" role="alert">${esc(message)}</p>` : ''}</form></main></div></body></html>`;
}
