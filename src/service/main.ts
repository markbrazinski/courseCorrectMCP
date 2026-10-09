// Entry point (the product). Env:
//   CC_PORT (8791), CC_DB (.artifacts/runtime/coursecorrect.db), CC_OWNER_TOKEN (owner routes: /authoring/*, /admin/start-over).
//   Model and speech services are each off unless set; a live one needs CC_LIVE=1, the CourseCorrect IAM user and the owner
//   authorization named by CC_AUTHORIZATION (default live-authorization-m3.json):
//     CC_EXTRACTOR   none|live   reading a recipe at import (none: the import says live reading is required)
//     CC_ANALYZER    none|live   AI swap cards at import (none: no AI alternatives; reviewed policies still bind)
//     CC_INTERPRETER none|nova   free-text requests (none: the cook taps the missing ingredient)
//     CC_EXPLAINER   none|nova   refusal wording (none: the template built from the engine's facts)
//     CC_SPEECH      off|polly   spoken replies
//   Test doubles (recorded readings, cards, intents) exist only in tests/support/server.ts.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, offExtractor } from '../authoring/extract.ts';
import { novaAnalyzer, offAnalyzer } from '../authoring/swap-analysis.ts';
import { Ledger, NovaClient, type Authorization } from '../authoring/nova.ts';
import { Service } from './commands.ts';
import { noneExplainer, novaExplainer } from './explain.ts';
import { loadContent } from './content.ts';
import { startHttp } from './http.ts';
import { Speaker } from './speech.ts';
import { noneInterpreter, novaInterpreter } from './interpret.ts';

/** One setting, one of its allowed values; anything else stops startup (never a silent fallback). */
function mode<T extends string>(name: string, allowed: readonly T[]): T {
  const v = process.env[name] ?? allowed[0];
  if (!allowed.includes(v as T)) { console.error(`${name}=${v}: expected ${allowed.join(' or ')}`); process.exit(1); }
  return v as T;
}
const extractorMode = mode('CC_EXTRACTOR', ['none', 'live']);
const analyzerMode = mode('CC_ANALYZER', ['none', 'live']);
const interpreterMode = mode('CC_INTERPRETER', ['none', 'nova']);
const explainerMode = mode('CC_EXPLAINER', ['none', 'nova']);
const speechMode = mode('CC_SPEECH', ['off', 'polly']);

const root = join(import.meta.dirname, '../..');
const dbPath = process.env.CC_DB ?? join(root, '.artifacts/runtime/coursecorrect.db');
mkdirSync(dirname(dbPath), { recursive: true });
const content = loadContent();
if (content.errors.length) { console.error(content.errors.join('\n')); process.exit(1); }
const authPath = join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'live-authorization-m3.json');
const ledger = () => new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), JSON.parse(readFileSync(authPath, 'utf8')) as Authorization);
const nova = () => new NovaClient(ledger());
const interpreter = interpreterMode === 'nova' ? novaInterpreter(nova()) : noneInterpreter;
const extractor = extractorMode === 'live' ? novaExtractor(nova()) : offExtractor;
const analyzer = analyzerMode === 'live' ? novaAnalyzer(nova()) : offAnalyzer;
const explainer = explainerMode === 'nova' ? novaExplainer(nova()) : noneExplainer;   // the explanation purpose needs its own authorization; without it the template is used
const svc = new Service({ dbPath, content, interpreter, explainer });   // every owner-authored example recipe is listed
const authoring = new Authoring({ store: svc.store, content, extractor, analyzer });
svc.catalog = () => authoring.catalog();
const port = Number(process.env.CC_PORT ?? 8791);
const speaker = speechMode === 'polly' ? new Speaker(ledger(), join(root, '.artifacts/speech-cache')) : null;
if (interpreterMode === 'nova' || explainerMode === 'nova' || speaker || extractorMode === 'live' || analyzerMode === 'live') {   // live AWS only as the non-root CourseCorrect user
  const id = await nova().verifyIdentity();
  if (!id.ok) { console.error(`refusing live calls: AWS identity is ${id.principal}, not the CourseCorrect IAM user`); process.exit(1); }
  console.log(`live AWS identity ${id.principal} · authorization ${ledger().auth.id}`);
}
await startHttp(svc, { port, ownerToken: process.env.CC_OWNER_TOKEN ?? null, authoring, speaker, webRoot: join(root, 'dist/web'), archiveDir: join(dirname(dbPath), 'archive') });
console.log(`CourseCorrectMCP on http://127.0.0.1:${port}/ (MCP at /mcp) · interpreter ${interpreter.mode} · explainer ${explainer.mode} · extractor ${extractor.name} · swaps ${analyzer.name} · speech ${speaker ? 'polly' : 'off'} · ENGINEERING · packs ${[...content.packs.keys()].join(', ')}`);
