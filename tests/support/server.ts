// TEST-ONLY server for the browser suites (playwright*.config.ts). The product entry point is src/service/main.ts; it has no
// replay, recorded or fixture-scene modes. This file is where the labelled test doubles are wired, and it adds the one
// test route, POST /admin/reset {fixtureId} (bearer TEST_ADMIN_TOKEN): start a run at a named fixture scene through the
// normal progress path. Env (besides the product's CC_PORT, CC_DB, CC_OWNER_TOKEN, CC_LIVE, CC_AUTHORIZATION):
//   TEST_MODELS       fixtures | probes   reading + swap cards: hand-written RECORDED fixtures (tests/fixtures/demo-cards.ts) plus
//                                         the retained M2 probe readings, or the retained live card probes (.artifacts/probes)
//   TEST_INTERPRETER  recorded | nova     labelled recorded intents (tests/fixtures/recorded-intents.ts), or live Nova (paid)
//   TEST_SPEECH       off | polly         live Polly (paid)
//   TEST_EXAMPLES     all | risotto,shortcake   which owner-authored recipes the Recipe Book lists
//   TEST_ADMIN_TOKEN  bearer for /admin/reset
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { Authoring } from '../../src/authoring/drafts.ts';
import { recordedExtractor, type Extractor } from '../../src/authoring/extract.ts';
import { Ledger, NovaClient, type Authorization } from '../../src/authoring/nova.ts';
import { recordedAnalyzer, type SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import { Service } from '../../src/service/commands.ts';
import { SqliteKv } from '../../src/service/kv-sqlite.ts';
import { loadContent } from '../../src/service/content.ts';
import { handler, localKitchen } from '../../src/service/http.ts';
import { novaInterpreter, recordedInterpreter } from '../../src/service/interpret.ts';
import { Speaker } from '../../src/service/speech.ts';
import { recordedDemo } from '../fixtures/demo-cards.ts';
import { RECORDED_INTENTS } from '../fixtures/recorded-intents.ts';
import { reviewReadings } from '../fixtures/review-questions.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) { console.error(`test server: ${k} is required`); process.exit(1); } return v; };
const models = env('TEST_MODELS'), port = Number(env('CC_PORT')), dbPath = env('CC_DB'), adminToken = env('TEST_ADMIN_TOKEN');
const root = join(import.meta.dirname, '../..');
mkdirSync(dirname(dbPath), { recursive: true });
const content = loadContent();
const readJson = (p: string) => (existsSync(join(root, p)) ? JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, Record<string, unknown>> : null);
const ledger = () => new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), JSON.parse(readFileSync(join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'live-authorization-m3.json'), 'utf8')) as Authorization);

// ---------- recorded readings and cards (labelled with what produced them; unknown input is refused) ----------
const m2 = readJson('.artifacts/probes/m2-replay.json') ?? {};
let extractor: Extractor, analyzer: SwapAnalyzer;
if (models === 'fixtures') {
  const fx = await recordedDemo(content.vocab);
  extractor = recordedExtractor({ ...m2, ...fx.readings, ...reviewReadings() }, 'REPLAY_OF_LIVE_M2_PROBE+RECORDED_FIXTURES');
  analyzer = recordedAnalyzer(fx.cards, 'RECORDED_TEST_FIXTURES');
} else if (models === 'probes') {
  if (!existsSync(join(root, '.artifacts/probes/cards2-replay.json'))) { console.error('EVIDENCE-DEPENDENT: TEST_MODELS=probes needs the retained live card probes in .artifacts/probes/ (see SETUP.md)'); process.exit(1); }
  // the retained live card probes: cards (2026-10-04), cards2 (2026-10-07), cards3 (2026-10-08, with its correction round)
  const c1 = readJson('.artifacts/probes/cards-replay.json'), c2 = readJson('.artifacts/probes/cards2-replay.json'), c3 = readJson('.artifacts/probes/cards3-replay.json');
  const v3 = (c3?.meta as { swapAnalysis?: { version: string; identity: string } } | undefined)?.swapAnalysis;
  const probeId = (f: string) => readJson(f) as { extraction?: { identity: string }; swapAnalysis?: { version: string; identity: string } } | null;
  const p1 = probeId('private/probes/cards/probe-v1.json'), p2 = probeId('private/probes/cards2/probe-v1.json'), m2probe = readJson('private/probes/m2/manifest.json') as { extractionPrompt?: string } | null;
  const cardOrigin = (key: string) => (c3?.cards && key in c3.cards ? { analyzer: `LIVE_NOVA cards3 run 2026-10-08 (${v3?.version ?? '?'})`, promptHash: v3?.identity ?? 'UNRECORDED' }
    : c2?.cards && key in c2.cards ? { analyzer: `LIVE_NOVA cards2 probe 2026-10-07 (${p2?.swapAnalysis?.version ?? '?'})`, promptHash: p2?.swapAnalysis?.identity ?? 'UNRECORDED' }
    : c1?.cards && key in c1.cards ? { analyzer: `LIVE_NOVA cards probe 2026-10-04 (${p1?.swapAnalysis?.version ?? '?'})`, promptHash: p1?.swapAnalysis?.identity ?? 'UNRECORDED' } : null);
  const readingOrigin = (key: string) => (c2?.readings && key in c2.readings ? { extractor: 'LIVE_NOVA cards2 probe 2026-10-07', promptHash: p2?.extraction?.identity ?? 'UNRECORDED' }
    : c1?.readings && key in c1.readings ? { extractor: 'LIVE_NOVA cards probe 2026-10-04', promptHash: p1?.extraction?.identity ?? 'UNRECORDED' }
      : { extractor: 'LIVE_NOVA M2 probe 2026-10-02', promptHash: m2probe?.extractionPrompt ?? 'UNRECORDED' });
  extractor = recordedExtractor({ ...m2, ...c1?.readings, ...c2?.readings }, 'REPLAY_OF_LIVE_PROBES', readingOrigin);
  analyzer = recordedAnalyzer({ ...c1?.cards, ...c2?.cards, ...c3?.cards }, 'REPLAY_OF_LIVE_CARD_PROBE', { origin: cardOrigin, repairs: { ...c3?.repairs } });
} else { console.error(`TEST_MODELS=${models}: expected fixtures or probes`); process.exit(1); }

// ---------- interpretation and speech: recorded, or the product's live adapters (paid; same guard and ledger) ----------
const live = process.env.TEST_INTERPRETER === 'nova' || process.env.TEST_SPEECH === 'polly';
const interpreter = process.env.TEST_INTERPRETER === 'nova' ? novaInterpreter(new NovaClient(ledger())) : recordedInterpreter(RECORDED_INTENTS);
const speaker = process.env.TEST_SPEECH === 'polly' ? new Speaker(ledger(), join(root, '.artifacts/speech-cache')) : null;
if (live) {
  const id = await new NovaClient(ledger()).verifyIdentity();
  if (!id.ok) { console.error(`refusing live calls: AWS identity is ${id.principal}, not the CourseCorrect IAM user`); process.exit(1); }
}

const ex = process.env.TEST_EXAMPLES ?? 'all';
const fixtureRecipes = ex === 'all' ? true : new Set(ex.split(',').map((n) => content.names.get(n.trim())).filter((x): x is string => !!x));
const kv = new SqliteKv(dbPath), local = localKitchen(kv);
const workspace = (ws: string) => {
  const svc = new Service({ kv, ws, content, interpreter, fixtureRecipes });
  const authoring = new Authoring({ kv, ws, content, extractor, analyzer });
  svc.catalog = (t) => authoring.catalogIn(t);
  return { svc, authoring };
};
const product = handler(workspace('kitchen').svc, { port, ownerToken: process.env.CC_OWNER_TOKEN ?? null, workspace, local, speaker, webRoot: join(root, 'dist/web') });
createServer((req, res) => {
  if (req.url !== '/admin/reset' || req.method !== 'POST') return void product(req, res);
  if (req.headers.authorization !== `Bearer ${adminToken}`) return void res.writeHead(401).end();
  let b = ''; req.on('data', (c) => { b += c; }).on('end', async () => {
    const r = await workspace(await local.current()).svc.adminReset((JSON.parse(b || '{}') as { fixtureId?: string }).fixtureId ?? '');
    res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(r));
  });
}).listen(port, '127.0.0.1', () => console.log(`TEST server on http://127.0.0.1:${port}/ · models ${extractor.name} / ${analyzer.name} · interpreter ${interpreter.mode} · speech ${speaker ? 'polly' : 'off'}`));
