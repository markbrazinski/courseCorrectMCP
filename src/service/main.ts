// Entry point (the product, run locally). Env:
//   CC_PORT (8791), CC_DB (.artifacts/runtime/coursecorrect-kv.db), CC_OWNER_TOKEN (owner routes: /authoring/*, /admin/start-over),
//   CC_KNOWLEDGE_DB (coursecorrect-knowledge.db beside CC_DB): the local knowledge table. At startup the bundled, reviewed
//   content/approved is published to it as a release (content-addressed: unchanged content is a no-op) and made ACTIVE, so new
//   recipes use it; recipes and sessions already pinned keep their release. The deployed service never does this (lambda.ts).
//   Model and speech services are each off unless set; a live one needs CC_LIVE=1, the identity CC_AWS_IDENTITY names
//   (default user/coursecorrect-nova, through that CLI profile) and the owner authorization named by CC_AUTHORIZATION
//   (default live-authorization-m3.json):
//     CC_EXTRACTOR   none|live   reading a recipe at import (none: the import says live reading is required)
//     CC_ANALYZER    none|live   AI swap cards at import (none: no AI alternatives; reviewed policies still bind)
//     CC_INTERPRETER none|nova   free-text requests (none: the cook taps the missing ingredient)
//     CC_EXPLAINER   none|nova   refusal wording (none: the template built from the engine's facts)
//     CC_SPEECH      off|polly   spoken replies
//   Test doubles (recorded readings, cards, intents) exist only in tests/support/server.ts. The deployed service is lambda.ts.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { novaExtractor, offExtractor } from '../authoring/extract.ts';
import { novaAnalyzer, offAnalyzer } from '../authoring/swap-analysis.ts';
import { Ledger, NovaClient, type Authorization } from '../authoring/nova.ts';
import { Service } from './commands.ts';
import { noneExplainer, novaExplainer } from './explain.ts';
import { APPROVED, exampleIds, PRODUCT_EXAMPLES, storeKnowledge } from './content.ts';
import { publishRelease, readKnowledgeDir } from '../knowledge/release.ts';
import { localKitchen, startHttp } from './http.ts';
import { SqliteKv } from './kv-sqlite.ts';
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
const dbPath = process.env.CC_DB ?? join(root, '.artifacts/runtime/coursecorrect-kv.db');
mkdirSync(dirname(dbPath), { recursive: true });
const knowledgeKv = new SqliteKv(process.env.CC_KNOWLEDGE_DB ?? join(dirname(dbPath), 'coursecorrect-knowledge.db'));
const published = await publishRelease(knowledgeKv, readKnowledgeDir(APPROVED), { activate: true, note: 'local product: content/approved at startup', source: { commit: null, dir: 'content/approved' } })
  .catch((e: Error) => { console.error(e.message); process.exit(1); });
const knowledge = storeKnowledge(knowledgeKv);
const content = await knowledge.active();
if (content.errors.length) { console.error(content.errors.join('\n')); process.exit(1); }
const authPath = join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'live-authorization-m3.json');
const ledger = () => new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), JSON.parse(readFileSync(authPath, 'utf8')) as Authorization);
const nova = () => new NovaClient(ledger());
const interpreter = interpreterMode === 'nova' ? novaInterpreter(nova()) : noneInterpreter;
const extractor = extractorMode === 'live' ? novaExtractor(nova()) : offExtractor;
const analyzer = analyzerMode === 'live' ? novaAnalyzer(nova()) : offAnalyzer;
const explainer = explainerMode === 'nova' ? novaExplainer(nova()) : noneExplainer;   // the explanation purpose needs its own authorization; without it the template is used
const kv = new SqliteKv(dbPath);
const workspace = (ws: string) => {
  const svc = new Service({ kv, ws, knowledge, interpreter, explainer, fixtureRecipes: exampleIds(PRODUCT_EXAMPLES) });   // the scones come in through Add recipe's sample PDF
  const authoring = new Authoring({ kv, ws, knowledge, extractor, analyzer });
  svc.catalog = (t) => authoring.catalogIn(t);
  return { svc, authoring };
};
const local = localKitchen(kv);   // Start over moves the kitchen to a new, empty workspace (the previous one stays)
const port = Number(process.env.CC_PORT ?? 8791);
const speaker = speechMode === 'polly' ? new Speaker(ledger(), join(root, '.artifacts/speech-cache')) : null;
if (interpreterMode === 'nova' || explainerMode === 'nova' || speaker || extractorMode === 'live' || analyzerMode === 'live') {   // live AWS only as the identity the policy names
  const id = await nova().verifyIdentity();
  if (!id.ok) { console.error(`refusing live calls: AWS identity is ${id.principal}, not the identity CC_AWS_IDENTITY names`); process.exit(1); }
  console.log(`live AWS identity ${id.principal} · authorization ${ledger().auth.id}`);
}
const kitchen = workspace(await local.current());
await startHttp(kitchen.svc, { port, ownerToken: process.env.CC_OWNER_TOKEN ?? null, workspace, local, speaker, webRoot: join(root, 'dist/web') });
console.log(`CourseCorrectMCP on http://127.0.0.1:${port}/ (MCP at /mcp) · interpreter ${interpreter.mode} · explainer ${explainer.mode} · extractor ${extractor.name} · swaps ${analyzer.name} · speech ${speaker ? 'polly' : 'off'} · knowledge ${content.releaseId}${published.created ? ' (published now)' : ''}${published.activated ? ' (activated now)' : ''} · packs ${[...content.packs.keys()].join(', ')}`);
