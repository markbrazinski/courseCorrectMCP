// Keyboard-cued demo runner: drives the real companion through private/demo/timeline.json against its OWN server and
// database (one fresh SQLite file per take under .artifacts/demo/takes/), never the ordinary session. Every cue goes
// through the product's own controls; scenes start mid-cook only through the admin fixture path, recorded in the take.
// The operator console is this terminal (outside the recorded viewport), so no shortcut touches the product's keyboard.
//
//   npm run demo -- [--label golden] [--interpreter recorded|nova] [--speech polly|off] [--alice typed|mic|file]
//                   [--upload manual|auto] [--auto] [--from B3.1] [--record-mic] [--headless] [--port 18793]
//
// Keys: space/enter/→ advance (after a mismatch: check again; repeats the action only if the server recorded nothing),
//       p auto pacing on/off · r repeat the last CourseCorrect audio (local file; no request) · s restart scene · q end take
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { chromium, type Locator, type Page } from '@playwright/test';
import { renderStep } from '../domain/recipe.ts';
import type { Recipe } from '../contract/types.ts';
import { loadContent } from '../service/content.ts';
import { ROOT, cuesOf, exportTake, loadTimeline, sourceFor, TIMELINE, type Attempt, type Check, type Clip, type Cue, type Manifest } from './export.ts';

const { values: o } = parseArgs({ options: {
  label: { type: 'string', default: 'rehearsal' }, interpreter: { type: 'string', default: 'recorded' }, speech: { type: 'string', default: 'polly' },
  alice: { type: 'string', default: 'typed' }, upload: { type: 'string', default: 'manual' }, auto: { type: 'boolean', default: false },
  from: { type: 'string' }, 'record-mic': { type: 'boolean', default: false }, headless: { type: 'boolean', default: false }, port: { type: 'string', default: '18793' },
  'polly-speed': { type: 'string' }, timeout: { type: 'string', default: '45' }, reviewer: { type: 'string' },
} });
const bad = (x: string | undefined, ok: string[]) => !ok.includes(String(x));
if (bad(o.interpreter, ['recorded', 'nova']) || bad(o.speech, ['polly', 'off']) || bad(o.alice, ['typed', 'mic', 'file']) || bad(o.upload, ['manual', 'auto'])) {
  console.error('usage: npm run demo -- [--interpreter recorded|nova] [--speech polly|off] [--alice typed|mic|file] [--upload manual|auto] [--auto] [--from <cueId>] [--label <name>]');
  process.exit(2);
}
if (!existsSync(TIMELINE)) { console.error(`missing ${relative(ROOT, TIMELINE)} (the canonical timeline is private and ignored)`); process.exit(2); }

// ---------- take folder ----------
const timeline = loadTimeline(), cues = cuesOf(timeline);
const startedAt = new Date().toISOString(), takeId = `${startedAt.replace(/[:.]/g, '-')}-${o.label!.replace(/[^\w-]/g, '_')}`;
const take = join(ROOT, '.artifacts/demo/takes', takeId);
for (const d of ['video', 'polly', 'shots', 'alice']) mkdirSync(join(take, d), { recursive: true });
copyFileSync(TIMELINE, join(take, 'timeline.json'));
const say = (s: string) => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (type: string, data: Record<string, unknown> = {}) => appendFileSync(join(take, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), s: sec(), type, ...data })}\n`);
let t0 = Date.now();
const sec = () => Math.round((Date.now() - t0) / 10) / 100;
const live = o.interpreter === 'nova' || o.speech === 'polly';
const INPUT_LABEL: Record<string, string> = {
  typed: 'TYPED_TRANSCRIPT: ALICE lines submitted as typed text (the screen says “You typed”); not speech evidence',
  mic: 'LIVE_MICROPHONE: spoken into the microphone, recognized by Chrome Web Speech',
  file: 'PRERECORDED_FILE_TO_MICROPHONE: an owner-supplied recording played aloud into the microphone and recognized by Chrome; the recognition is real, the voice is a recording',
};

// ---------- ledger (for the manifest; this runner never calls AWS itself) ----------
const LEDGER = join(ROOT, '.artifacts/ledger/nova-ledger.jsonl');
const AUTH = JSON.parse(readFileSync(join(ROOT, 'private/architecture/live-authorization-m3.json'), 'utf8')) as { id: string; maxUsd: number; maxCalls: Record<string, number> };
function ledgerTotals() {
  const lines = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; kind: string; purpose: string; usd: number; authorization: string }) : [];
  const keys = [...new Set(lines.map((l) => l.key))];
  const usdOf = (k: string) => { const es = lines.filter((e) => e.key === k), st = es.find((e) => e.kind === 'settle'); return st ? st.usd : es.filter((e) => e.kind === 'reserve').reduce((s, e) => s + e.usd, 0); };
  const m3 = keys.filter((k) => lines.find((e) => e.key === k)!.authorization === AUTH.id);
  const calls: Record<string, number> = {};
  for (const k of m3) { const p = lines.find((e) => e.key === k)!.purpose; calls[p] = (calls[p] ?? 0) + 1; }
  return { lines: lines.length, m3Usd: Math.round(m3.reduce((s, k) => s + usdOf(k), 0) * 1e5) / 1e5, m3Calls: calls, allUsd: Math.round(keys.reduce((s, k) => s + usdOf(k), 0) * 1e5) / 1e5 };
}
const ledgerBefore = ledgerTotals();

// ---------- identity ----------
const sha = (files: string[]) => { const h = createHash('sha256'); for (const f of files.sort()) h.update(`${relative(ROOT, f)}\0`).update(readFileSync(f)); return h.digest('hex'); };
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const content = loadContent();
const git = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'no commit (uncommitted working tree)'; } })();
const identity = {
  git, node: process.version, srcSha256: sha(walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx|html)$/.test(f))), contentSha256: sha(walk(join(ROOT, 'content/approved'))),
  webBundle: existsSync(join(ROOT, 'dist/web/assets')) ? readdirSync(join(ROOT, 'dist/web/assets')) : [], timelineSha256: sha([TIMELINE]),
  packs: [...content.packs.values()].map((p) => ({ recipeId: p.recipe.recipeId, title: p.recipe.title, packHash: p.packHash })),
};

// ---------- the take's own server ----------
const port = Number(o.port), base = `http://127.0.0.1:${port}`, admin = randomUUID(), owner = randomUUID();
if (await fetch(`${base}/health`).then(() => true, () => false)) { console.error(`port ${port} is already in use; this runner starts its own server (use --port)`); process.exit(2); }
const env: NodeJS.ProcessEnv = { ...process.env, CC_PORT: String(port), CC_DB: join(take, 'service.db'), CC_ADMIN_TOKEN: admin, CC_OWNER_TOKEN: owner,
  CC_INTERPRETER: o.interpreter, CC_SPEECH: o.speech, CC_EXPLAINER: 'none', CC_EXTRACTOR: 'replay', CC_ANALYZER: 'replay', CC_LIVE: live ? '1' : '' };
delete env.CC_DEMO; delete env.CC_FIXTURE_RECIPES;   // the Recipe Book lists imports only (the product default)
const log = openSync(join(take, 'server.log'), 'a');
const server: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/service/main.ts'], { cwd: ROOT, env, stdio: ['ignore', log, log] });
let health: Record<string, unknown> | null = null;
for (let i = 0; i < 120 && !health; i++) { await new Promise((r) => setTimeout(r, 250)); health = await fetch(`${base}/health`).then((r) => r.json() as Promise<Record<string, unknown>>, () => null); if (server.exitCode !== null) break; }
if (!health) { console.error(`the take's server did not start; see ${relative(ROOT, join(take, 'server.log'))}`); process.exit(1); }

const manifest: Manifest = {
  kind: 'cc-demo-take/1', takeId, label: o.label!, startedAt, modes: {
    interpreter: String(health.interpreter), speech: String(health.speech), aliceInput: o.alice!, upload: o.upload!, explainer: 'NONE (template from engine facts)',
    extractor: 'REPLAY_OF_LIVE_PROBES', swapCards: 'REPLAY_OF_LIVE_CARD_PROBE', recipes: 'Recipe Book lists imports only; fixture scenes start through the admin setup path', reviewer: o.reviewer ?? 'none', database: relative(ROOT, join(take, 'service.db')),
  },
  labels: ['ENGINEERING content: provisional quantities; not culinary validation; not released cooking guidance', 'Held-out transfer: not shown', 'No claim of native Alexa+ compatibility',
    INPUT_LABEL[o.alice!], o.interpreter === 'nova' ? 'Interpretation: live Amazon Nova' : 'Interpretation: RECORDED test fixtures (labelled in each trace), not Nova',
    'Scenes that start mid-cook use the admin fixture path; nothing was cooked'],
  identity, videoT0: '', restarts: [], aliceMic: null,
};
const save = () => { writeFileSync(join(take, 'manifest.json'), JSON.stringify(manifest, null, 1)); writeFileSync(join(take, 'cues.json'), JSON.stringify(attempts, null, 1)); writeFileSync(join(take, 'clips.json'), JSON.stringify(clips, null, 1)); };

// ---------- browser (video records the product viewport only) ----------
const chrome = o.alice !== 'typed';
const browser = await chromium.launch({ headless: o.headless, channel: chrome ? 'chrome' : undefined, args: ['--autoplay-policy=no-user-gesture-required', ...(chrome ? ['--use-fake-ui-for-media-stream'] : [])] });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(take, 'video'), size: { width: 1440, height: 900 } }, permissions: chrome ? ['microphone'] : [] });
const page = await context.newPage();
t0 = Date.now(); manifest.videoT0 = new Date(t0).toISOString();
let mic: ChildProcess | null = null;
if (o['record-mic']) {   // the ALICE track for a microphone take: the whole take from the default input
  mic = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'avfoundation', '-i', `:${process.env.CC_DEMO_MIC_DEVICE ?? '0'}`, '-ac', '1', '-ar', '48000', join(take, 'alice/mic-take.wav')], { stdio: ['pipe', 'ignore', 'ignore'] });
  manifest.aliceMic = { file: 'alice/mic-take.wav', offsetS: sec() };
}

const attempts: Attempt[] = [], clips: Clip[] = [];
const web: { s: number; path: string; status: number }[] = [];
let current: Cue = cues[0];
// a reply belongs to the cue during which the page asked for it (a slow synthesis may finish after the next cue starts)
const asked = new Map<object, string>();
page.on('request', (q) => { if (new URL(q.url()).pathname === '/speech') asked.set(q, current.id); });
page.on('requestfailed', (q) => asked.delete(q));
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname === '/imports' && r.request().method() === 'POST') {
    web.push({ s: sec(), path: '/imports', status: r.status() }); ev('web', { path: '/imports', status: r.status() });
  }
  if (u.pathname !== '/speech') return;
  const id = r.headers()['x-speech-id'], at = sec(), cueId = asked.get(r.request()) ?? current.id, n = clips.length + 1;
  asked.delete(r.request());
  if (r.status() !== 200 || !id) { clips.push({ n, cueId, offsetS: at, id: id ?? '', text: '', settings: {}, cached: false, durationS: null, file: '', status: r.status() }); ev('speech-failed', { cueId, status: r.status() }); return; }
  const cache = join(ROOT, '.artifacts/speech-cache');
  if (!existsSync(join(cache, `${id}.json`))) { clips.push({ n, cueId, offsetS: at, id, text: '', settings: {}, cached: false, durationS: null, file: '', status: 0 }); ev('speech-unrecorded', { cueId, id }); return; }
  const meta = JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8')) as { text: string } & Record<string, unknown>;
  const file = `polly/${String(n).padStart(2, '0')}-${cueId}-coursecorrect.mp3`;
  copyFileSync(join(cache, `${id}.mp3`), join(take, file));
  copyFileSync(join(cache, `${id}.json`), join(take, file.replace(/\.mp3$/, '.json')));
  let durationS: number | null = null;
  try { durationS = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(take, file)]).toString()) * 100) / 100; } catch { /* no ffprobe */ }
  const { text, id: _i, recordedAt: _r, requestCharacters: _c, ...settings } = meta;
  clips.push({ n, cueId, offsetS: at, id, text, settings, cached: r.headers()['x-speech-cached'] === 'true', durationS, file, status: 200 });
  ev('speech', { cueId, id, cached: r.headers()['x-speech-cached'], durationS, text });
  say(`  ♪ CourseCorrect (${durationS ?? '?'} s${r.headers()['x-speech-cached'] === 'true' ? ', cached' : ', new Polly call'}): ${text}`);
});
await page.goto('/');

// ---------- server activity ----------
type Act = { seq: number; name: string; status: string; summary: string; input: { utterance?: { text: string; channel: string } } | null; trace?: { interpretation: string | null }; durationMs: number };
let seen = 0;
const activity: Act[] = [];
async function pollActivity() {
  const fresh = ((await (await fetch(`${base}/activity?after=${seen}`)).json()) as { entries: Act[] }).entries;
  for (const e of fresh) { activity.push(e); seen = e.seq; ev('mcp', { seq: e.seq, tool: e.name, status: e.status, summary: e.summary }); }
  return fresh;
}

// ---------- console ----------
const keys: string[] = [];
let auto = o.auto!, interrupt: string | null = null, lastPassed: Attempt | null = null;
const push = (k: string) => {
  ev('key', { key: k });
  if (k === 'p') { auto = !auto; say(`  auto pacing ${auto ? 'ON' : 'OFF'}`); return; }
  if (k === 'r') return repeat();
  keys.push(k);
  if (k === 'q' || k === 's') interrupt = k;
};
if (process.stdin.isTTY) {
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_s, k: { name?: string; ctrl?: boolean }) => {
    if (k.ctrl && k.name === 'c') return push('q');
    const m: Record<string, string> = { space: 'n', return: 'n', right: 'n', n: 'n', p: 'p', r: 'r', s: 's', q: 'q', h: 'h' };
    if (k.name && m[k.name]) push(m[k.name]);
  });
} else {   // scripted operator (one key per line), used to check the runner itself
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d: string) => { for (const l of d.split('\n').map((x) => x.trim()).filter(Boolean)) push(l); });
}
function repeat() {
  const c = [...clips].reverse().find((x) => x.status === 200);
  if (!c) return say('  (nothing has been said yet)');
  say(`  ↻ repeating ${c.file} from the take folder — no request is made, nothing is re-sent`);
  ev('repeat-audio', { file: c.file });
  spawn('afplay', [join(take, c.file)], { stdio: 'ignore' }).on('error', () => say('  (afplay unavailable)'));
}
/** Auto pacing advances only after the last cue's outcome was verified, its reply finished, and its planned hold passed. */
function autoDue(): number | null {
  if (!lastPassed || lastPassed.t.outcome == null || asked.size) return null;   // never advance over a reply still being fetched
  if (cues[i]?.action.do === 'review') return null;                               // an owner review is always a deliberate key press
  const said = clips.filter((x) => x.cueId === lastPassed!.cueId).map((x) => x.offsetS + (x.durationS ?? 0));
  return Math.max(lastPassed.t.outcome, ...said) + (cues.find((c) => c.id === lastPassed!.cueId)?.planned.holdS ?? 0);
}
async function next(): Promise<string> {
  for (;;) {
    if (keys.length) return keys.shift()!;
    const due = auto ? autoDue() : null;
    if (due !== null && sec() >= due) { ev('auto-advance'); return 'n'; }
    await sleep(100);
  }
}
const describe = (c: Cue) => {
  const a = c.action;
  if (a.do === 'setup') return `admin setup ${a.fixtureId} (fresh run) → Resume cooking`;
  if (a.do === 'say') return `ALICE (${o.alice}): “${a.text}”`;
  if (a.do === 'click') return `tap ${(a.names ?? [a.name!]).map((t) => (typeof t === 'string' ? t : `${t.name} (not “${t.hasNotText}”)`)).join(' → ')}${a.inQuestion !== undefined ? ` (question ${a.inQuestion + 1})` : ''}`;
  if (a.do === 'review') return `OWNER REVIEW as “${o.reviewer ?? '(no --reviewer given)'}”: ${(a.facts ?? []).map((f) => `${f.ingredient} step ${f.step} = ${f.functions.join(' + ')}`).join('; ')}`;
  if (a.do === 'upload') return o.upload === 'manual' ? `YOU upload ${a.file} (choose it, then “Upload and read”)` : `upload ${a.file} (auto)`;
  return 'hold (narration only)';
};
const status = (i: number) => { const c = cues[i]; say(c ? `\n▶ Beat ${c.beat.number} · ${c.id} ${c.title}\n  next: ${describe(c)}   [space advance · p auto ${auto ? 'ON' : 'off'} · r repeat audio · s restart scene · q end]` : '\n■ end of timeline — press space or q to finish the take'); };

// ---------- checks ----------
const rx = (s: string) => { const m = /^\/(.*)\/([a-z]*)$/.exec(s); return m ? new RegExp(m[1], m[2]) : null; };
const matches = (s: string, t: string) => { const r = rx(s); return r ? r.test(t.trim()) : t.includes(s); };
function locate(c: Check): Locator {
  if (c.dialog) return page.getByRole('dialog', { name: c.dialog });
  if (c.button) return page.getByRole('button', { name: c.button, exact: true });
  if (c.testId) return page.getByTestId(c.testId);
  return page.getByText(rx(c.text!) ?? c.text!);
}
async function holds(c: Check) {
  const l = locate(c);
  if (c.count !== undefined) return (await l.count()) === c.count;
  const one = c.nth !== undefined ? l.nth(c.nth) : l.first();
  if (!(await one.isVisible().catch(() => false))) return false;
  return !(c.testId && c.text) || matches(c.text, await one.innerText().catch(() => ''));
}
const WATCH: Record<string, () => Locator> = {
  question: () => page.getByTestId('question'), consequence: () => page.getByTestId('consequence'), 'refusal-answer': () => page.getByTestId('refusal-answer'),
  'ingredient picker': () => page.getByRole('group', { name: 'Which ingredient is missing' }), 'unconfirmed apply': () => page.getByText('We can’t confirm whether the change was saved'),
  'not applied': () => page.getByText('The change wasn’t applied'), alert: () => page.getByRole('alert'),
};
const visibleWatchers = async () => new Set((await Promise.all(Object.entries(WATCH).map(async ([k, l]) => ((await l().first().isVisible().catch(() => false)) ? k : null)))).filter(Boolean) as string[]);

/** Wait for the cue's expected UI + server outcome. Anything new and unexpected stops here. */
async function verify(c: Cue, before: Set<string>, fromSeq: number, fromWeb: number, unbounded: boolean): Promise<string | null> {
  const allowed = new Set((c.expect?.ui ?? []).map((x) => x.testId).filter(Boolean) as string[]);
  const deadline = Date.now() + Number(o.timeout) * 1000;
  const seenSince = new Map<string, number>();
  for (;;) {
    if (interrupt) return `interrupted (${interrupt === 'q' ? 'end take' : 'restart scene'})`;
    await pollActivity();
    const mine = activity.filter((a) => a.seq > fromSeq), hits = web.slice(fromWeb);
    // a rejection is a mismatch unless the cue names it as part of the product's own flow (C-3: ACTIVE_RUN_EXISTS → "End it and start")
    const failed = mine.find((a) => a.status === 'failed' && !(c.expect?.allowRejected ?? []).some((code) => a.summary.endsWith(code)));
    if (failed) return `server rejected ${failed.name}: ${failed.summary}`;
    const badWeb = hits.find((w) => w.status >= 400);
    if (badWeb) return `${badWeb.path} returned ${badWeb.status}`;
    const ui = await Promise.all((c.expect?.ui ?? []).map(holds));
    const mcpOk = !c.expect?.mcp || mine.some((a) => a.name === c.expect!.mcp!.tool && a.status === c.expect!.mcp!.status);
    const webOk = !c.expect?.web || hits.some((w) => w.path === c.expect!.web!.path && w.status === c.expect!.web!.status);
    const draftId = c.expect?.rule ? latestDraft() : null;
    const ruleOk = !c.expect?.rule || (!!draftId && ((await (await fetch(`${base}/authoring/drafts/${draftId}/requirements`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { coverage: { patternId: string; status: string }[] })
      .coverage.some((x) => x.patternId === c.expect!.rule!.patternId && x.status === c.expect!.rule!.status));
    if (ui.every(Boolean) && mcpOk && webOk && ruleOk) return null;
    const now = await visibleWatchers();
    // a new, unexpected state counts once it has stayed on screen for a second (a closing sheet is not a new state)
    for (const k of now) if (!before.has(k) && !allowed.has(k)) seenSince.set(k, seenSince.get(k) ?? Date.now());
    for (const k of [...seenSince.keys()]) if (!now.has(k)) seenSince.delete(k);
    const surprise = [...seenSince.entries()].find(([, t]) => Date.now() - t >= 1000)?.[0];
    if (surprise) {
      const detail = surprise === 'refusal-answer' ? await page.getByTestId('refusal-answer').first().innerText().catch(() => '') : '';
      return `unexpected ${surprise} on screen${detail ? `: “${detail}”` : ''} (expected ${JSON.stringify(c.expect)})`;
    }
    if (unbounded && keys[0] === 'n') { keys.shift(); return 'you stopped waiting (nothing was skipped)'; }
    const lastAnswer = mine.at(-1);
    if (!unbounded && Date.now() > deadline) return `timed out after ${o.timeout} s waiting for ${JSON.stringify(c.expect)}; UI checks ${JSON.stringify(ui)}, rule ${ruleOk}, server ${mcpOk}${lastAnswer ? ` (last: ${lastAnswer.name} → ${lastAnswer.status}, “${lastAnswer.summary.slice(0, 140)}”)` : ''}, web ${webOk}`;
    await sleep(250);
  }
}

/** The draft this take's own upload created (the take's database, read-only). */
function latestDraft(): string | null {
  const db = new DatabaseSync(join(take, 'service.db'), { readOnly: true });
  try { return (db.prepare('SELECT draft_id FROM import_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { draft_id: string } | undefined)?.draft_id ?? null; }
  finally { db.close(); }
}

// ---------- actions (the product's own controls) ----------
const button = (name: string, scope: Page | Locator = page) => scope.getByRole('button', { name: rx(name) ?? name, exact: rx(name) ? undefined : true });
async function perform(c: Cue, a: Attempt): Promise<{ unbounded: boolean }> {
  const x = c.action;
  if (x.do === 'setup') {
    const r = await fetch(`${base}/admin/reset`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ fixtureId: x.fixtureId }) });
    const j = await r.json() as Record<string, unknown>;
    ev('setup', { cueId: c.id, fixtureId: x.fixtureId, result: j });
    if (!r.ok) throw new Error(`admin setup ${x.fixtureId} failed: ${JSON.stringify(j)}`);
    await page.goto('/');
    await button('/^Resume cooking/').first().click();
  } else if (x.do === 'click') {
    for (const t of x.names ?? [x.name!]) {
      const { name, hasNotText, first } = typeof t === 'string' ? { name: t, hasNotText: undefined, first: false } : t;
      let b = button(name, x.inQuestion !== undefined ? page.getByTestId('question').nth(x.inQuestion) : page);
      if (hasNotText) b = b.filter({ hasNotText });
      if (first) b = b.first();   // only where the timeline says several equal controls are expected
      await b.click({ timeout: 10_000 });
    }
  } else if (x.do === 'say') {
    a.input = { mode: o.alice!, transcript: x.text!, sent: null, aliceFile: null };
    if (o.alice === 'typed') {
      await page.getByLabel('Type a request').fill(x.text!);
      await button('Send').click();
    } else {
      const file = o.alice === 'file' ? sourceFor('private/demo/alice', c.id) : null;
      if (o.alice === 'file' && !file) throw new Error(`missing ALICE recording private/demo/alice/${c.id}.(wav|m4a|mp3)`);
      await button('Start listening').click();
      if (file) {
        a.input.aliceFile = relative(ROOT, file);
        copyFileSync(file, join(take, 'alice', `${c.id}${file.slice(file.lastIndexOf('.'))}`));
        execFileSync('afplay', [file]);   // played aloud into the microphone; Chrome recognizes it for real
      } else say('  🎙  speak now (the product is listening)');
      return { unbounded: true };
    }
  } else if (x.do === 'review') {
    // the owner's review, through the existing owner route; only facts the rule itself reports as missing
    if (!o.reviewer) throw new Error('owner review needs --reviewer "<owner name>"; nothing was asserted');
    const draftId = latestDraft();
    if (!draftId) throw new Error('no draft from this take’s upload to review');
    const auth = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' };
    const reqs = await (await fetch(`${base}/authoring/drafts/${draftId}/requirements`, { headers: auth })).json() as { revision: number; coverage: { patternId: string; missing: { subject: { kind: string; id: string }; predicate: string; coreHash: string }[] }[] };
    const d = await (await fetch(`${base}/drafts/${draftId}`)).json() as { draft: { content: { steps: { id: string; ordinal: number }[]; ingredients: { name: string; uses: { id: string; stepId: string }[] }[] } } };
    const assertions = (x.facts ?? []).map((f) => {
      const step = d.draft.content.steps.find((st) => st.ordinal === f.step);
      const use = d.draft.content.ingredients.filter((g) => g.name.toLowerCase() === f.ingredient.toLowerCase()).flatMap((g) => g.uses).find((u) => u.stepId === step?.id);
      const m = reqs.coverage.filter((c) => c.patternId === x.patternId).flatMap((c) => c.missing).find((mm) => mm.subject.kind === 'USE' && mm.subject.id === use?.id && mm.predicate === 'FUNCTION');
      if (!use || !m) throw new Error(`${f.ingredient} at step ${f.step} is not a missing fact of ${x.patternId}; nothing was asserted`);
      return { subject: { kind: 'USE', id: use.id }, predicate: 'FUNCTIONS', value: f.functions, coreHash: m.coreHash };
    });
    const r = await fetch(`${base}/authoring/drafts/${draftId}/assertions`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedRevision: reqs.revision, reviewer: o.reviewer, assertions }) });
    a.review = { reviewer: o.reviewer, decisionRef: x.decisionRef ?? null, draftId, assertions, status: r.status };
    ev('owner-review', a.review);
    if (!r.ok) throw new Error(`owner review refused: ${r.status} ${await r.text()}`);
  } else if (x.do === 'upload') {
    if (o.upload === 'auto') {
      await page.getByLabel('Choose a recipe PDF').setInputFiles(join(ROOT, x.file!));
      await button('Upload and read').click();
    } else {
      say(`  ⇢ your turn: choose ${x.file} in the Add a recipe sheet, then press “Upload and read”. The runner continues when the reading has actually arrived.`);
      return { unbounded: true };
    }
  }
  return { unbounded: false };
}

interface Prev { a: Attempt; fromSeq: number; fromWeb: number }
const isSceneStart = (c: Cue) => c.action.do === 'setup' || c.sceneStart === true;
/** One attempt at cue i. After a mismatch (prev), the action is repeated only if the server recorded nothing for it. */
async function run(i: number, prev: Prev | null): Promise<Prev> {
  const c = cues[i];
  current = c;
  const fromSeq = prev?.fromSeq ?? seen, fromWeb = prev?.fromWeb ?? web.length;
  const redo = !prev || (c.action.do !== 'setup' && !activity.some((x) => x.seq > fromSeq) && web.length === fromWeb);
  const a: Attempt = { cueId: c.id, attempt: attempts.filter((x) => x.cueId === c.id).length + 1, status: 'passed', t: prev && !redo ? { ...prev.a.t, outcome: undefined } : { cue: prev?.a.t.cue ?? sec() }, mcp: [] };
  const before = await visibleWatchers();
  ev('cue', { cueId: c.id, attempt: a.attempt, redo });
  try {
    let unbounded = false;
    if (redo) { a.t.actionStart = sec(); ({ unbounded } = await perform(c, a)); a.t.actionEnd = sec(); }
    else { say('  checking again (the action is not repeated: the server already recorded it)'); if (prev?.a.input) a.input = prev.a.input; }
    const err = await verify(c, before, fromSeq, fromWeb, unbounded);
    if (err) throw new Error(err);
    a.t.outcome = sec();
  } catch (e) {
    a.status = interrupt ? 'interrupted' : 'mismatch';
    a.error = (e as Error).message.split('\n')[0].slice(0, 600);
  }
  await pollActivity();
  a.mcp = activity.filter((x) => x.seq > fromSeq).map((x) => ({ seq: x.seq, tool: x.name, status: x.status, summary: x.summary, interpretation: x.trace?.interpretation ?? null, durationMs: x.durationMs }));
  const sent = activity.filter((x) => x.seq > fromSeq && x.input?.utterance).at(-1)?.input?.utterance;
  if (a.input && sent) a.input.sent = sent;
  if (a.status === 'passed') for (const k of c.capture ?? []) {
    const l = k.startsWith('text:') ? page.getByText(rx(k.slice(5))!).first() : page.getByTestId(k).first();
    (a.captured ??= {})[k] = (await l.innerText().catch(() => '')).trim();
  }
  a.screenshot = `shots/${c.id}${a.status === 'passed' ? '' : `-${a.status}-${a.attempt}`}.png`;
  await sleep(600);   // let entrance animations settle (as the e2e screenshots do)
  await page.screenshot({ path: join(take, a.screenshot) }).catch(() => undefined);
  attempts.push(a);   // every attempt stays on record, failed ones included
  ev('cue-result', { cueId: c.id, attempt: a.attempt, status: a.status, error: a.error });
  save();
  if (a.status === 'passed') { lastPassed = a; say(`  ✓ ${c.id}${a.captured ? ` ${JSON.stringify(a.captured)}` : ''}${a.input?.sent ? ` · server received “${a.input.sent.text}” (${a.input.sent.channel})` : ''}`); }
  else say(`  ✕ ${c.id} ${a.status.toUpperCase()}: ${a.error}\n    paused. You may fix it in the product, then press space to check again — or s to restart the scene, q to end.`);
  return { a, fromSeq, fromWeb };
}

// ---------- main loop ----------
let i = o.from ? cues.findIndex((c) => c.id === o.from) : 0;
if (i < 0) { console.error(`no cue ${o.from}`); process.exit(2); }
if (o.from && !isSceneStart(cues[i])) say(`  note: ${o.from} is not a scene start; the product shows whatever this fresh database holds`);
say(`CourseCorrect demo runner · take ${takeId}\n  server ${base} (its own database; your ordinary session is untouched) · interpreter ${health.interpreter} · speech ${health.speech}\n  ALICE: ${INPUT_LABEL[o.alice!]}`);
if (live) say(`  live calls are charged to ${AUTH.id}: $${ledgerBefore.m3Usd} of $${AUTH.maxUsd} used before this take`);
let pending: Prev | null = null;
status(i);
for (;;) {
  const k = await next();
  interrupt = null;
  if (k === 'q') break;
  if (k === 'h') { status(i); continue; }
  if (k === 's') {
    let j = Math.max(0, Math.min(pending ? i : i - 1, cues.length - 1));
    while (j > 0 && !isSceneStart(cues[j])) j--;
    manifest.restarts.push({ at: sec(), fromCue: cues[j].id });
    ev('restart-scene', { fromCue: cues[j].id });
    say(`  ⟲ restarting the scene from ${cues[j].id}${cues[j].action.do === 'setup' ? ' (a fresh run through the admin setup path)' : ''}`);
    pending = null; lastPassed = null; i = j; status(i); continue;
  }
  if (i >= cues.length) break;
  const r = await run(i, pending);
  if (interrupt === 'q') break;
  if (interrupt === 's') continue;   // the queued 's' restarts on the next turn
  pending = r.a.status === 'passed' ? null : r;
  if (!pending) i++;
  status(i);
}

// ---------- finish: evidence, video, package ----------
say('\nfinishing the take…');
await pollActivity().catch(() => undefined);
const all = ((await (await fetch(`${base}/activity`)).json()) as { entries: unknown[] }).entries;
writeFileSync(join(take, 'mcp-activity.json'), JSON.stringify(all, null, 1));
const db = new DatabaseSync(join(take, 'service.db'), { readOnly: true });
const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
const runs = rows<{ run_id: string; recipe_id: string; status: string; revision: number; version: number; step_status: string; created_at: string }>('SELECT run_id, recipe_id, status, revision, version, step_status, created_at FROM runs ORDER BY created_at');
writeFileSync(join(take, 'server-records.json'), JSON.stringify({
  runs: runs.map((r) => ({ ...r, stepStatus: JSON.parse(r.step_status), step_status: undefined,
    versions: rows<{ run_id: string; version: number; recipe_json: string; hash: string }>(`SELECT * FROM run_versions WHERE run_id = '${r.run_id}' ORDER BY version`)
      .map((v) => { const rec = JSON.parse(v.recipe_json) as Recipe; return { version: v.version, hash: v.hash, steps: rec.steps.map((s, k) => `${k + 1}. ${renderStep(rec, s)}`) }; }) })),
  amendments: rows('SELECT * FROM amendments ORDER BY at'),
  progressEvents: rows('SELECT * FROM progress_events ORDER BY at'),
  evaluations: rows<{ evaluation_id: string; run_id: string; state: string; interpretation: string | null; at: string; result_json: string | null }>('SELECT evaluation_id, run_id, state, interpretation, at, result_json FROM evaluations ORDER BY at')
    .map(({ result_json, ...e }) => ({ ...e, speech: result_json ? (JSON.parse(result_json) as { wire: { speech: { text: string } } }).wire.speech.text : null })),
  imports: { jobs: rows('SELECT job_id, draft_id, state, stages_json, failure_json, created_at FROM import_jobs'), extractions: rows('SELECT extraction_id, draft_id, extractor, status, cost_usd FROM extractions'),
    swapAnalyses: rows('SELECT analysis_id, draft_id, analyzer, status, cost_usd FROM swap_analyses'), saved: rows('SELECT recipe_id, version_id, release_json, at FROM saved_recipes') },
}, null, 1));
db.close();
const ran = new Set(attempts.filter((a) => a.status === 'passed').map((a) => a.cueId));
// golden = the whole specified journey passed in this take (earlier failed attempts stay on record); a stop on an unresolved mismatch is FAILED
manifest.result = cues.every((c) => ran.has(c.id)) ? 'PASSED' : attempts.at(-1)?.status === 'mismatch' ? 'FAILED' : 'INCOMPLETE';
manifest.golden = manifest.result === 'PASSED' && health.interpreter === 'NOVA' && health.speech === 'polly';   // a rehearsal with fixtures or no speech is never golden
manifest.endedAt = new Date().toISOString();
const ledgerAfter = ledgerTotals();
manifest.ledger = { authorization: AUTH.id, before: ledgerBefore, after: ledgerAfter, thisTakeUsd: Math.round((ledgerAfter.m3Usd - ledgerBefore.m3Usd) * 1e5) / 1e5,
  newLedgerLines: readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).slice(ledgerBefore.lines).map((l) => JSON.parse(l)) };
save();
if (mic) { mic.stdin?.write('q'); await new Promise((r) => mic!.once('exit', r)); }
await context.close();   // writes the video
await browser.close();
server.kill('SIGTERM');
process.stdin.pause();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
const pkg = exportTake(take, { pollySpeed: o['polly-speed'] ? Number(o['polly-speed']) : undefined });
say(`take ${manifest.result}${manifest.golden ? ' (golden)' : ''} · ${attempts.length} cue attempts · ${clips.filter((c) => c.status === 200).length} CourseCorrect clips · this take $${manifest.ledger.thisTakeUsd}`);
say(`take:    ${relative(ROOT, take)}\npackage: ${relative(ROOT, pkg.out)}\nrecorded playback: open "${join(pkg.out, 'index.html')}"`);
process.exit(0);
