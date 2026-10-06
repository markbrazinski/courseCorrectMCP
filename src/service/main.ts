// Entry point. Env: CC_PORT (8791), CC_DB, CC_ADMIN_TOKEN, CC_OWNER_TOKEN (defaults to admin),
//   CC_INTERPRETER none|recorded|nova, CC_EXTRACTOR none|replay|live, CC_SPEECH off|polly, CC_EXPLAINER none|nova (none = template),
//   CC_ANALYZER replay|recorded|live (swap analysis at import: replay = the retained live card probe; recorded = test fixtures),
//   CC_FIXTURE_RECIPES 1 (list the hand-authored approved recipes, now test fixtures, in the Recipe Book),
//   CC_DEMO 1 (local practice: keyless reset and owner review)
//   (live Nova/Polly need CC_LIVE=1 and the recorded authorization named by CC_AUTHORIZATION, default M3).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, recordedExtractor, type Extractor } from '../authoring/extract.ts';
import { novaAnalyzer, recordedAnalyzer, type SwapAnalyzer } from '../authoring/swap-analysis.ts';
import { Ledger, NovaClient, type Authorization } from '../authoring/nova.ts';
import { Service } from './commands.ts';
import { noneExplainer, novaExplainer } from './explain.ts';
import { loadContent } from './content.ts';
import { startHttp } from './http.ts';
import { Speaker } from './speech.ts';
import { noneInterpreter, novaInterpreter, recordedInterpreter, type Interpreter } from './interpret.ts';

const root = join(import.meta.dirname, '../..');
const dbPath = process.env.CC_DB ?? join(root, '.artifacts/runtime/coursecorrect.db');
mkdirSync(dirname(dbPath), { recursive: true });
const content = loadContent();
if (content.errors.length) { console.error(content.errors.join('\n')); process.exit(1); }
const authPath = join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'live-authorization-m3.json');
const ledger = () => new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), JSON.parse(readFileSync(authPath, 'utf8')) as Authorization);
const nova = () => new NovaClient(ledger());
const interpreter: Interpreter = process.env.CC_INTERPRETER === 'recorded'
  ? recordedInterpreter((await import('../../tests/fixtures/recorded-intents.ts')).RECORDED_INTENTS)
  : process.env.CC_INTERPRETER === 'nova' ? novaInterpreter(nova()) : noneInterpreter;
const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, unknown>> : null);
// swap analysis: "replay" = the retained live card probe (.artifacts/probes/cards-replay.json: its readings and cards travel
// together, so a replayed reading meets the cards made for it); "recorded" = hand-written test fixtures; "live" = Nova.
const analyzerMode = process.env.CC_ANALYZER ?? 'replay';
const cardsReplay = analyzerMode === 'replay' ? readJson(join(root, '.artifacts/probes/cards-replay.json')) : null;
const fixtures = analyzerMode === 'recorded' ? await (await import('../../tests/fixtures/demo-cards.ts')).recordedDemo(content.vocab) : null;
/** "replay": the retained live probe readings (labeled; no new calls). Unknown documents → LIVE_EXTRACTION_REQUIRED. */
function replayExtractor(): Extractor {
  const m2 = readJson(join(root, '.artifacts/probes/m2-replay.json')) ?? {};
  return recordedExtractor({ ...m2, ...(cardsReplay?.readings ?? {}), ...(fixtures?.readings ?? {}) }, fixtures ? 'REPLAY_OF_LIVE_M2_PROBE+RECORDED_FIXTURES' : 'REPLAY_OF_LIVE_PROBES');
}
const extractor: Extractor = process.env.CC_EXTRACTOR === 'live' ? novaExtractor(nova()) : process.env.CC_EXTRACTOR === 'none' ? recordedExtractor({}) : replayExtractor();
const analyzer: SwapAnalyzer = analyzerMode === 'live' ? novaAnalyzer(nova())
  : fixtures ? recordedAnalyzer(fixtures.cards, 'RECORDED_TEST_FIXTURES') : recordedAnalyzer(cardsReplay?.cards ?? {}, 'REPLAY_OF_LIVE_CARD_PROBE');
// the explanation purpose needs its own owner authorization; without it the ledger refuses and the template is used
const explainer = process.env.CC_EXPLAINER === 'nova' ? novaExplainer(nova()) : noneExplainer;
const svc = new Service({ dbPath, content, interpreter, explainer, fixtureRecipes: process.env.CC_FIXTURE_RECIPES === '1' });
const authoring = new Authoring({ store: svc.store, content, extractor, analyzer });
svc.catalog = () => authoring.catalog();
const port = Number(process.env.CC_PORT ?? 8791);
const speaker = process.env.CC_SPEECH === 'polly' ? new Speaker(ledger(), join(root, '.artifacts/speech-cache')) : null;
if (interpreter.mode === 'NOVA' || explainer.mode === 'NOVA' || speaker || process.env.CC_EXTRACTOR === 'live' || analyzerMode === 'live') {   // live AWS only as the non-root CourseCorrect user
  const id = await nova().verifyIdentity();
  if (!id.ok) { console.error(`refusing live calls: AWS identity is ${id.principal}, not the CourseCorrect IAM user`); process.exit(1); }
  console.log(`live AWS identity ${id.principal} · authorization ${ledger().auth.id}`);
}
const webRoot = join(root, 'dist/web');
await startHttp(svc, { port, adminToken: process.env.CC_ADMIN_TOKEN ?? null, ownerToken: process.env.CC_OWNER_TOKEN ?? null, authoring, speaker, webRoot, archiveDir: join(dirname(dbPath), 'archive'), demo: process.env.CC_DEMO === '1' });
console.log(`CourseCorrectMCP on http://127.0.0.1:${port}/ (MCP at /mcp) · interpreter ${interpreter.mode} · explainer ${explainer.mode} · extractor ${extractor.name} · swaps ${analyzer.name} · speech ${speaker ? 'polly' : 'off'} · ENGINEERING · packs ${[...content.packs.keys()].join(', ')}`);
