// One authenticated session for owner checks (each sign-in is a new workspace against the environment's daily cap). With
// CC_SESSION_FILE set, the first check signs in once (JSON sign-in: a bearer token and a cookie for the same workspace) and saves
// both there (keep it private: it is a credential for that workspace); every later check reuses them. Unset: a fresh sign-in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export async function session(url: string, code: string): Promise<{ token: string; cookie: string; reused: boolean }> {
  const file = process.env.CC_SESSION_FILE;
  if (file && existsSync(file)) return { ...(JSON.parse(readFileSync(file, 'utf8')) as { token: string; cookie: string }), reused: true };
  const r = await fetch(`${url.replace(/\/$/, '')}/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json() as { token?: string };
  if (!j.token) throw new Error(`sign-in refused (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  const s = { token: j.token, cookie: (r.headers.getSetCookie()[0] ?? '').split(';')[0] };
  if (file) writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  return { ...s, reused: false };
}
export const reusing = () => !!process.env.CC_SESSION_FILE;
