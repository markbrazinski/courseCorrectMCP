// The product's normal startup (src/service/main.ts): no replay or recorded path is reachable from it. No paid calls:
// every model and speech service is off in these runs.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoPdf } from '../fixtures/demo-cards.ts';
import { SCONE_LINES } from '../fixtures/demo-sources.ts';
import { content, ROOT } from '../helpers.ts';

const MAIN = join(ROOT, 'src/service/main.ts');

/** Every source file main.ts loads (relative static and dynamic imports, followed recursively). */
function closure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
    const next = resolve(dirname(file), m[1]);
    if (existsSync(next)) closure(next, seen);
  }
  return seen;
}

function start(env: Record<string, string>) {
  const port = 20000 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
    cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CC_PORT: String(port), CC_DB: join(mkdtempSync(join(tmpdir(), 'cc-start-')), 'p.db'), ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const ready = new Promise<void>((ok, fail) => {
    const t = setInterval(() => { if (out.includes('CourseCorrectMCP on')) { clearInterval(t); ok(); } }, 50);
    child.on('exit', (code) => { clearInterval(t); fail(new Error(`exited ${code}: ${err}`)); });
  });
  ready.catch(() => undefined);   // awaited only by the tests that expect a start; an expected exit isn't an unhandled error
  const exited = new Promise<{ code: number | null; err: string }>((ok) => child.on('exit', (code) => ok({ code, err })));
  return { base: `http://127.0.0.1:${port}`, ready, exited, stop: () => child.kill() };
}
const mcp = async (base: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await r.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
};

describe('product startup', () => {
  it('start over (owner key) moves the kitchen to a new, empty workspace; the examples stay', async () => {
    const s = start({ CC_OWNER_TOKEN: 'k' });
    try {
      await s.ready;
      const book = (await mcp(s.base, 'list_recipes')).recipes as { recipeId: string }[];
      expect((await mcp(s.base, 'start_recipe', { commandId: 'c1', recipeId: book[0].recipeId })).outcome).toBe('started');
      expect((await mcp(s.base, 'get_active_recipe')).run).not.toBeNull();
      expect((await fetch(`${s.base}/admin/start-over`, { method: 'POST', headers: { authorization: 'Bearer k' } })).status).toBe(200);
      expect((await mcp(s.base, 'get_active_recipe')).run).toBeNull();
      expect(((await mcp(s.base, 'list_recipes')).recipes as unknown[])).toHaveLength(2);
    } finally { s.stop(); }
  }, 30_000);

  it('loads no test or probe code, and reads no replay data', () => {
    const files = [...closure(MAIN)].map((f) => relative(ROOT, f));
    expect(files.filter((f) => /^(tests|src\/probes)\//.test(f))).toEqual([]);
    const src = files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    for (const banned of ['.artifacts/probes', 'private/probes']) {
      expect(src.includes(banned), banned).toBe(false);
    }
    expect(readFileSync(MAIN, 'utf8')).not.toMatch(/recorded(Extractor|Analyzer|Interpreter|Explainer)|RECORDED_INTENTS|recordedDemo|'replay'|'recorded'/);   // the doubles exist; main.ts can't pick one
  });

  it('with nothing configured: every service off, examples listed, a document with a retained reading is NOT replayed', async () => {
    const s = start({});
    try {
      await s.ready;
      expect(await (await fetch(`${s.base}/health`)).json()).toEqual({ ok: true, interpreter: 'NONE', speech: 'off', knowledge: content.releaseId });   // the bundled content, published locally as a release
      const book = (await mcp(s.base, 'list_recipes')).recipes as { title: string }[];
      expect(book.map((r) => r.title).sort()).toEqual(['Risotto with Parmesan', 'Strawberry Shortcake']);   // the scones are Add recipe's sample import
      // the M2 probe's retained reading covers exactly these bytes; the product must still say live reading is required
      const up = await fetch(`${s.base}/imports`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-filename': 'scones.pdf' }, body: Buffer.from(demoPdf(SCONE_LINES)) });
      const { job } = (await up.json()) as { job: { id: string } };
      let j: { state: string; failure: { code: string; message: string } | null } = { state: 'running', failure: null };
      for (let i = 0; i < 100 && (j.state === 'running' || j.state === 'queued'); i++) { await new Promise((r) => setTimeout(r, 50)); j = ((await (await fetch(`${s.base}/imports/${job.id}`)).json()) as { job: typeof j }).job; }
      expect(j).toMatchObject({ state: 'failed', failure: { code: 'LIVE_EXTRACTION_REQUIRED', message: expect.stringContaining('off on this server') } });
      // no fixture-scene route (test server only); owner routes need the owner key
      expect((await fetch(`${s.base}/admin/reset`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await fetch(`${s.base}/admin/start-over`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${s.base}/admin/start-over`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
      expect((await fetch(`${s.base}/authoring/vocabulary`)).status).toBe(401);
    } finally { s.stop(); }
  }, 30_000);

  it('a replay or recorded mode is refused at startup, never silently substituted', async () => {
    for (const [k, v] of [['CC_EXTRACTOR', 'replay'], ['CC_ANALYZER', 'recorded'], ['CC_INTERPRETER', 'recorded'], ['CC_ANALYZER', 'replay']]) {
      const r = await start({ [k]: v }).exited;
      expect(r.code, `${k}=${v}`).toBe(1);
      expect(r.err).toContain(`${k}=${v}: expected`);
    }
  }, 30_000);
});
