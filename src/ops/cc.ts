// Owner commands for one deployed environment (never part of the deployed service). Stacks: cc-<env>-data (table + bucket,
// infra/data.yaml) and cc-<env>-app (functions, URL, role, logs; infra/app.yaml). Runs on the owner's machine with the
// owner's AWS CLI profile (named in the environment's config.json); refuses the root identity.
//   npm run cc -- init       --env <name> --profile <aws-profile>   local config, secrets and a paid-off authorization
//   npm run cc -- stage      --env <name>                           build and zip the bundle (no AWS)
//   npm run cc -- deploy     --env <name>                           stage, deploy both stacks, record the authorization
//   npm run cc -- status     --env <name>                           stacks, version, URL, data, logs, spending
//   npm run cc -- verify     --env <name> [--paid] [--restored]     smoke checks on the live URL
//   npm run cc -- backup     --env <name> [--out <dir>] [--keep-frozen]  maintenance on, running work settles, then every item + clip → a local folder
//   npm run cc -- restore    --env <name> --from <dir> --confirm <name>
//   npm run cc -- destroy    --env <name> --mode compute|full --confirm <name> [--backup <dir> | --no-backup]
//   npm run cc -- allowances --env <name> [--apply | --pause | --resume]
//   npm run cc -- usage | jobs | logs [--since 1h]  --env <name>
//   npm run cc -- maintenance --env <name> --on|--off       503 for new requests (consistent data; running work finishes)
//   npm run cc -- stop | start --env <name>                  emergency stop: reserved concurrency 0 on both functions
//   npm run cc -- knowledge publish  --env <name> [--activate] [--note <text>] [--dir <approved tree> --commit <sha>]   content/approved → an immutable release (validated, verified)
//   npm run cc -- knowledge list | refs | verify --env <name>                  releases; which ones saved recipes and sessions use; re-check every hash
//   npm run cc -- knowledge activate --env <name> --release <id>               the release new recipes are pinned to (or roll back)
// The knowledge table (cc-<env>-knowledge, in the data stack) is the deployed service's only source of culinary knowledge; the
// functions may only read it. Publishing never changes a recipe or session already pinned to a release, and nothing deletes one.
// Local files: private/deploy/<env>/ (config.json, secrets.json mode 600, authorization.json, deployments.jsonl,
// last-verify.json; override with CC_DEPLOY_DIR). Backups: ~/CourseCorrect-backups/<env>/<UTC stamp>/ (CC_BACKUP_DIR).
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Authoring } from '../authoring/drafts.ts';
import { offExtractor } from '../authoring/extract.ts';
import { KvLedger, LEDGER, PURPOSES, type Authorization } from '../authoring/nova.ts';
import { K, Service } from '../service/commands.ts';
import type { RecipePack } from '../contract/types.ts';
import { loadContent } from '../service/content.ts';
import { Gate } from '../service/gate.ts';
import { noneInterpreter } from '../service/interpret.ts';
import { wsPk, type Item } from '../service/kv.ts';
import { DynamoKv } from '../service/kv-dynamo.ts';
import { carry, closeLifetime, freeze, inflight, knowledgeGaps, mode, openLifetime, planRestore, referencedReleases, REQUEST_DRAIN_MS, restoreKnowledge, unfreeze, type Closed } from './lifecycle.ts';
import { reusing, session } from './session.ts';
import { activateRelease, activeReleaseId, knowledgeErrors, listReleases, loadRelease, mergePacket, pendingIn, publishRelease, readKnowledgeDir, releaseIdOfFiles, writeKnowledgeDir } from '../knowledge/release.ts';
import { exampleIds, PRODUCT_EXAMPLES, storeKnowledge } from '../service/content.ts';

// ---------- arguments, files, output ----------
const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
const fail = (msg: string): never => { console.error(`✗ ${msg}`); process.exit(1); };
const say = (msg: string) => console.log(msg);
const env = typeof flags.env === 'string' ? flags.env : fail('--env <name> is required (for example --env review)');
if (!/^[a-z][a-z0-9-]{1,20}$/.test(env)) fail(`--env ${env}: lower-case letters, digits and dashes, 2–21 characters`);
const ROOT = join(import.meta.dirname, '../..');
const DIR = join(process.env.CC_DEPLOY_DIR ?? join(ROOT, 'private/deploy'), env);
const BUILD = join(ROOT, '.artifacts/deploy', env);
const STACK = { data: `cc-${env}-data`, app: `cc-${env}-app` };
interface Config { profile: string; region: string; modes: { extractor: 'none' | 'live'; analyzer: 'none' | 'live'; interpreter: 'none' | 'nova'; explainer: 'none' | 'nova'; speech: 'off' | 'polly'; ocr?: 'off' | 'textract' }; logRetentionDays: number; publicOrigin: string }
interface Secrets { sessionKey: string; accessCode: string; /** the judge link's code (tier "judge"); created by the next deploy if missing */ judgeCode?: string }
const readJson = <T>(f: string): T | null => (existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T : null);
const t0 = Date.now(), elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

if (cmd === 'init') { init(); process.exit(0); }
if (cmd === 'stage') { stage(); say(`  (no AWS calls) → ${BUILD}`); process.exit(0); }
const cfg = readJson<Config>('config.json') ?? fail(`no ${join(DIR, 'config.json')}: run  npm run cc -- init --env ${env} --profile <aws-profile>`);
if (cfg.region !== 'us-east-1') fail('region must be us-east-1 (the Nova 2 Lite US inference profile and the measured prices)');
process.env.AWS_PROFILE = cfg.profile; process.env.AWS_REGION = cfg.region;
const secrets = () => readJson<Secrets>('secrets.json') ?? fail(`no secrets.json in ${DIR}: run init`);

function init() {
  const profile = typeof flags.profile === 'string' ? flags.profile : fail('--profile <aws-profile> is required: the owner profile that may deploy (not root, not coursecorrect-nova)');
  mkdirSync(DIR, { recursive: true });
  const write = (f: string, v: unknown, mode?: number) => {
    if (existsSync(join(DIR, f))) return say(`  kept     ${join(DIR, f)}`);
    writeFileSync(join(DIR, f), JSON.stringify(v, null, 2) + '\n'); if (mode) chmodSync(join(DIR, f), mode); say(`  created  ${join(DIR, f)}`);
  };
  write('config.json', { profile, region: 'us-east-1', modes: { extractor: 'none', analyzer: 'none', interpreter: 'none', explainer: 'none', speech: 'off', ocr: 'off' }, logRetentionDays: 14, publicOrigin: '' } satisfies Config);
  const word = () => randomBytes(3).toString('hex');
  write('secrets.json', { sessionKey: randomBytes(32).toString('base64'), accessCode: `cook-${word()}-${word()}`, judgeCode: `judge-${word()}-${word()}` } satisfies Secrets, 0o600);
  write('authorization.json', { id: `${env}-paid-off`, grantedBy: 'owner', at: new Date().toISOString().slice(0, 10), maxCalls: {}, maxUsd: 0, projectCeilingUsd: 0, priorProjectUsd: 0,
    perWorkspace: { maxCalls: {}, maxUsd: 0 }, maxNewWorkspacesPerDay: 30, paused: false } satisfies Authorization);
  say(`\nPaid model work is OFF until authorization.json names caps and config.json turns a service on. Next:  npm run cc -- deploy --env ${env}`);
}

// ---------- AWS access (the owner's profile) ----------
function aws(args: string[], o: { json?: boolean; quiet?: boolean; stream?: boolean } = {}): unknown {
  const opts: SpawnSyncOptions = { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, stdio: o.stream ? 'inherit' : 'pipe', maxBuffer: 256 * 1024 * 1024 };
  const r = spawnSync('aws', [...args, '--profile', cfg.profile, '--region', cfg.region, ...(o.json === false ? [] : ['--output', 'json'])], opts);
  if (r.error) fail(`the AWS CLI could not run (${r.error.message}). Install AWS CLI v2.`);
  if (r.status !== 0) { if (o.quiet) return null; fail(`aws ${args.slice(0, 2).join(' ')}: ${String(r.stderr ?? '').trim().slice(0, 600) || `exit ${r.status}`}`); }
  return o.stream || o.json === false ? r.stdout : JSON.parse(String(r.stdout).trim() || 'true');   // an empty success (head-bucket) is true
}
function identity() {
  const id = aws(['sts', 'get-caller-identity']) as { Account: string; Arn: string };
  if (/:root$/.test(id.Arn)) fail('the AWS profile is the root user: use an IAM user or role for deployments');
  return { account: id.Account, masked: `****${id.Account.slice(-4)}`, principal: id.Arn.split(':').slice(5).join(':') };
}
const stack = (name: string) => {
  const s = aws(['cloudformation', 'describe-stacks', '--stack-name', name], { quiet: true }) as { Stacks: { StackStatus: string; Outputs?: { OutputKey: string; OutputValue: string }[]; LastUpdatedTime?: string; CreationTime: string }[] } | null;
  const x = s?.Stacks[0];
  return x ? { status: x.StackStatus, out: Object.fromEntries((x.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])), updated: x.LastUpdatedTime ?? x.CreationTime } : null;
};
const deployStack = (name: string, template: string, params: Record<string, string>) => aws(['cloudformation', 'deploy', '--stack-name', name, '--template-file', join(ROOT, 'infra', template),
  '--no-fail-on-empty-changeset', '--capabilities', 'CAPABILITY_NAMED_IAM', '--tags', 'app=coursecorrect', `env=${env}`,
  '--parameter-overrides', ...Object.entries(params).map(([k, v]) => `${k}=${v}`)], { stream: true, json: false });
const kvOf = (table: string) => new DynamoKv(table, { region: cfg.region });
const s3 = () => new S3Client({ region: cfg.region });
const data = () => { const d = stack(STACK.data); if (!d || !d.out.TableName) fail(`stack ${STACK.data} is not deployed (status: ${d?.status ?? 'none'})`); return { table: d!.out.TableName, bucket: d!.out.BucketName, knowledge: d!.out.KnowledgeTableName ?? fail(`${STACK.data} has no knowledge table: deploy first`) }; };

// ---------- stage: the Lambda bundle (no AWS) ----------
function stage(): { zip: string; version: string; bytes: number } {
  if (!flags['skip-build'] && spawnSync('npm', ['run', 'build:web'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) fail('npm run build:web failed');
  const dir = join(BUILD, 'stage');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true, filter: (s) => !/\/src\/(web|probes|ops)(\/|$)|\/src\/walkthrough/.test(s) });
  // only the example recipes and their progress fixtures: culinary knowledge reaches the deployed service from the knowledge table,
  // so the bundle carries none to fall back on (vocabulary, roles and patterns stay out)
  for (const d of ['recipes', 'fixtures']) cpSync(join(ROOT, 'content/approved', d), join(dir, 'content/approved', d), { recursive: true });
  cpSync(join(ROOT, 'dist/web'), join(dir, 'dist/web'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(ROOT, f), join(dir, f));
  if (spawnSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' }).status !== 0) fail('npm ci in the stage folder failed');
  // ponytail: prune what the server never loads (the companion is prebuilt; pdf.js runs from its legacy build only)
  for (const p of ['react', 'react-dom', 'scheduler', 'pdfjs-dist/build', 'pdfjs-dist/web', 'pdfjs-dist/image_decoders', 'pdfjs-dist/types', 'pdfjs-dist/legacy/web', 'pdfjs-dist/legacy/image_decoders']) rmSync(join(dir, 'node_modules', p), { recursive: true, force: true });
  // one module for the handler: otherwise every cold start loads ~1,500 files and strips their types (latency audit 2026-10-11).
  // It sits in src/authoring/ so its relative paths still hold: ../../content, ../../dist/web, and ./pdf-worker.ts, the PDF
  // reader's worker thread, which alone still loads from source (with pdf.js, the one package kept).
  const handler = join(dir, 'src/authoring/handler.mjs');
  if (spawnSync('npx', ['rolldown', join(dir, 'src/service/lambda.ts'), '-p', 'node', '-f', 'esm', '-o', handler, '--no-codeSplitting', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) fail('bundling the handler failed');
  for (const e of readdirSync(join(dir, 'node_modules'))) if (e !== 'pdfjs-dist') rmSync(join(dir, 'node_modules', e), { recursive: true, force: true });
  const worker = readFileSync(join(dir, 'src/authoring/pdf-worker.ts')), bundled = readFileSync(handler);
  rmSync(join(dir, 'src'), { recursive: true, force: true }); mkdirSync(join(dir, 'src/authoring'), { recursive: true });
  writeFileSync(join(dir, 'src/authoring/pdf-worker.ts'), worker); writeFileSync(handler, bundled);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.map')) rmSync(f); else files.push(f); } };
  walk(dir);
  writeFileSync(join(dir, 'index.mjs'), "// Lambda handler module (src/service/lambda.ts, bundled).\nexport { handler } from './src/authoring/handler.mjs';\n");
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(relative(dir, f)).update(readFileSync(f));
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'nogit';
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() ? '-dirty' : '';
  const version = `${git}${dirty}-${h.digest('hex').slice(0, 10)}`;
  const zip = join(BUILD, `cc-${version}.zip`);
  rmSync(zip, { force: true });
  if (spawnSync('zip', ['-qrX', zip, '.'], { cwd: dir, stdio: 'inherit' }).status !== 0) fail('zip failed (install zip)');
  const bytes = statSync(zip).size;
  say(`  bundle ${version}: ${(bytes / 1e6).toFixed(1)} MB zipped, ${files.length} files`);
  return { zip, version, bytes };
}

// ---------- deploy ----------
async function deploy() {
  const id = identity();
  const sec = secrets(), auth = readJson<Authorization>('authorization.json') ?? fail('no authorization.json: run init');
  if (!sec.judgeCode) {   // environments created before the judge link: add its code, keeping the file private
    sec.judgeCode = `judge-${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`;
    writeFileSync(join(DIR, 'secrets.json'), JSON.stringify(sec, null, 2) + '\n'); chmodSync(join(DIR, 'secrets.json'), 0o600);
    say(`  judge link code created in ${join(DIR, 'secrets.json')}`);
  }
  if (!auth.tiers?.judge) say('  note: authorization.json has no tiers.judge, so the judge link signs in but its paid calls are refused');
  const live = Object.values(cfg.modes).some((m) => m !== 'none' && m !== 'off');
  say(`Deploying ${env} to account ${id.masked} (${id.principal}), ${cfg.region}. Paid services: ${live ? JSON.stringify(cfg.modes) : 'all off'}; authorization ${auth.id} ($${auth.maxUsd} cap).`);
  const times: Record<string, string> = {};
  const lap = (k: string, s: number) => { times[k] = `${((Date.now() - s) / 1000).toFixed(0)} s`; };
  let s = Date.now(); const b = stage(); lap('stage', s);
  s = Date.now(); deployStack(STACK.data, 'data.yaml', { Env: env, DeletionProtection: 'true' }); lap('data stack', s);
  const { table, bucket, knowledge } = data();
  // the app code reads knowledge only from the table: traffic never switches to it before a verified release is active
  const ready = await activeReleaseId(kvOf(knowledge));
  if (!ready) fail(`the data stack is up to date, but ${knowledge} has no active knowledge release, so the app stack was NOT updated (traffic stays on the previous code).\n  Publish one, then run deploy again: npm run cc -- knowledge publish --env ${env} --activate   (or restore a backup)`);
  await loadRelease(kvOf(knowledge), ready!).catch((e: Error) => fail(`active release ${ready} does not verify (${e.message}); the app stack was NOT updated`));
  say(`  knowledge: active release ${ready} verified`);
  s = Date.now();
  const key = `artifacts/cc-${b.version}.zip`;
  if (!aws(['s3api', 'head-object', '--bucket', bucket, '--key', key], { quiet: true })) await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(b.zip) }));
  lap('upload', s);
  s = Date.now();
  deployStack(STACK.app, 'app.yaml', {
    Env: env, TableName: table, KnowledgeTableName: knowledge, BucketName: bucket, CodeKey: key, Version: b.version, SessionKey: sec.sessionKey,
    AccessCodeSha256: createHash('sha256').update(sec.accessCode).digest('hex'), JudgeCodeSha256: createHash('sha256').update(sec.judgeCode).digest('hex'), Live: live ? '1' : '0',
    Extractor: cfg.modes.extractor, Analyzer: cfg.modes.analyzer, Interpreter: cfg.modes.interpreter, Explainer: cfg.modes.explainer, Speech: cfg.modes.speech, Ocr: cfg.modes.ocr ?? 'off',
    LogRetentionDays: String(cfg.logRetentionDays), PublicOrigin: cfg.publicOrigin,
  });
  lap('app stack', s);
  await recordAuthorization(table, auth);
  const lt = await openLifetime(kvOf(table), history());   // a new table carries every earlier table's spending of this environment
  say(`  spending lifetime ${lt.lifetime} (${lt.created ? `new; carrying ${history().length} earlier table(s)` : 'continuing'})`);
  const url = stack(STACK.app)!.out.Url;
  appendFileSync(join(DIR, 'deployments.jsonl'), JSON.stringify({ at: new Date().toISOString(), version: b.version, url, account: id.masked, times }) + '\n');
  say(`\n✓ ${env} deployed in ${elapsed()} (${Object.entries(times).map(([k, v]) => `${k} ${v}`).join(', ')})\n  URL: ${url}\n  Access code: in ${join(DIR, 'secrets.json')}\n  Judge link: ${url}?code=<judgeCode in secrets.json>\n  Next: npm run cc -- verify --env ${env}`);
}
/** The deployed spending authorization: written only when it changed; conditional on the version read. */
async function recordAuthorization(table: string, auth: Authorization) {
  const kv = kvOf(table), cur = await kv.get({ pk: LEDGER, sk: 'AUTH' });
  const { pk: _p, sk: _s, v: _v, ...was } = cur ?? {};
  if (cur && JSON.stringify(was) === JSON.stringify(auth)) return say(`  authorization ${auth.id}: unchanged`);
  await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...auth, v: (cur?.v ?? 0) + 1 }, if: cur?.v ?? 'absent' }]);
  say(`  authorization ${auth.id} recorded: ${PURPOSES.map((p) => `${p} ${auth.maxCalls[p] ?? 0}`).join(', ')}; $${auth.maxUsd}; per workspace $${auth.perWorkspace?.maxUsd ?? 0}; ${auth.maxNewWorkspacesPerDay ?? 0} new workspaces/day${auth.paused ? '; PAUSED' : ''}${Object.entries(auth.tiers ?? {}).map(([n, t]) => `; tier ${n}: $${t.maxUsd}, $${t.perWorkspace.maxUsd} per workspace, ${t.maxNewWorkspacesPerDay}/day`).join('')}`);
}

// ---------- status ----------
async function status() {
  const id = identity();
  say(`${env} · account ${id.masked} · ${cfg.region}`);
  const d = stack(STACK.data), a = stack(STACK.app);
  say(`  ${STACK.data}: ${d?.status ?? 'not deployed'}${d ? ` (updated ${d.updated})` : ''}`);
  say(`  ${STACK.app}: ${a?.status ?? 'not deployed'}${a ? ` (updated ${a.updated})\n    version ${a.out.Version}\n    URL ${a.out.Url}` : ''}`);
  if (d?.out.TableName) {
    const t = aws(['dynamodb', 'describe-table', '--table-name', d.out.TableName]) as { Table: { TableStatus: string; ItemCount: number; TableSizeBytes: number; DeletionProtectionEnabled: boolean } };
    say(`  table ${d.out.TableName}: ${t.Table.TableStatus}, ≈${t.Table.ItemCount} items, ≈${(t.Table.TableSizeBytes / 1e6).toFixed(2)} MB (DynamoDB refreshes these about every 6 hours), deletion protection ${t.Table.DeletionProtectionEnabled ? 'on' : 'off'}`);
    const objs = await listAll(d.out.BucketName);
    // ocr-input/: recipe PDFs held for OCR, deleted once each import has read them (a lifecycle rule removes any left after a day)
    for (const p of ['artifacts/', 'speech/', 'ocr-input/']) { const xs = objs.filter((o) => o.Key.startsWith(p)); say(`  bucket ${p}: ${xs.length} objects, ${(xs.reduce((n, o) => n + o.Size, 0) / 1e6).toFixed(1)} MB`); }
    const u = await new KvLedger(kvOf(d.out.TableName)).usage(), m = await mode(kvOf(d.out.TableName));
    say(`  authorization: ${u.authorization ? `${u.authorization.id}${u.authorization.paused ? ' (PAUSED)' : ''}, $${(((u.totals?.usd as number | undefined) ?? 0) + u.carriedForAuthorization.usd).toFixed(4)} of $${u.authorization.maxUsd} used (this table + earlier tables)` : 'none recorded (every paid call is refused)'}; project total $${u.projectUsd.toFixed(4)} of $${u.authorization?.projectCeilingUsd ?? 0}`);
    say(`  maintenance: ${m?.frozen ? `ON since ${m.at} (${m.reason})` : 'off'}`);
  }
  if (d?.out.KnowledgeTableName) {
    const k = kvOf(d.out.KnowledgeTableName), rels = await listReleases(k);
    say(`  knowledge ${d.out.KnowledgeTableName}: ${rels.length} release(s), active ${(await activeReleaseId(k)) ?? 'NONE (imports and examples unavailable)'}`);
  }
  if (a) for (const f of ['web', 'worker']) { const c = aws(['lambda', 'get-function-concurrency', '--function-name', `cc-${env}-${f}`], { quiet: true }) as { ReservedConcurrentExecutions?: number } | null; if (c?.ReservedConcurrentExecutions === 0) say(`  ✗ cc-${env}-${f} is STOPPED (reserved concurrency 0): npm run cc -- start --env ${env}`); }
  const logs = aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/cc-${env}-`]) as { logGroups: { logGroupName: string; retentionInDays?: number; storedBytes: number }[] };
  for (const g of logs.logGroups) say(`  log group ${g.logGroupName}: retention ${g.retentionInDays ?? 'NEVER EXPIRES'} days, ${(g.storedBytes / 1e6).toFixed(2)} MB stored`);
}
async function listAll(bucket: string) {
  const out: { Key: string; Size: number }[] = [];
  let token: string | undefined;
  do { const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })); out.push(...(r.Contents ?? []).map((o) => ({ Key: o.Key!, Size: o.Size ?? 0 }))); token = r.NextContinuationToken; } while (token);
  return out;
}

// ---------- verify (smoke checks on the live URL; free unless --paid) ----------
type J = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads
async function verify() {
  const a = stack(STACK.app) ?? fail(`${STACK.app} is not deployed`);
  const url = a.out.Url.replace(/\/$/, ''), origin = new URL(url).origin, sec = secrets();
  const results: { check: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => { results.push({ check: name, ok, detail }); say(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); return ok; };
  // CC_SESSION_FILE (src/ops/session.ts): one session for every check; the two checks that need a new workspace are skipped
  const reuse = reusing();
  const signIn = async () => {
    if (reuse) return (await session(url, sec.accessCode)).cookie;
    const r = await fetch(`${url}/signin`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${encodeURIComponent(sec.accessCode)}` });
    return r.status === 303 ? (r.headers.getSetCookie()[0] ?? '').split(';')[0] : null;
  };
  const skip = (name: string) => say(`  SKIP ${name} · one reused session (CC_SESSION_FILE); it needs a new workspace`);
  let n = 0;
  const mcp = async (cookie: string, name: string, args: J = {}) => {
    const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
    return ((await r.json()) as J).result?.structuredContent as J;
  };
  say(`Verifying ${url}`);
  if (flags.restored) return verifyRestored(url, origin);
  const h = await (await fetch(`${url}/health`)).json() as J;
  check('health', h.ok === true && h.signIn === true, JSON.stringify(h));
  check('a knowledge release is active', typeof h.knowledge === 'string' && h.knowledge.startsWith('kr-'), String(h.knowledge));
  check('the companion asks for sign-in', (await (await fetch(url, { headers: { accept: 'text/html' } })).text()).includes('Access code'));
  check('MCP needs a session', (await fetch(`${url}/mcp`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status === 401);
  check('a wrong code is refused', (await fetch(`${url}/signin`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=wrong' })).status === 401);
  const cookie = await signIn();
  if (!check('sign-in opens a workspace', !!cookie)) return finish(results);
  check('cross-site writes are refused', (await fetch(`${url}/mcp`, { method: 'POST', headers: { cookie: cookie!, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status === 403);
  check('no event stream is held open', (await fetch(`${url}/mcp`, { headers: { cookie: cookie!, accept: 'text/event-stream' } })).status === 405);
  const tools = await fetch(`${url}/mcp`, { method: 'POST', headers: { cookie: cookie!, origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) });
  check('eight MCP tools', ((await tools.json()) as J).result?.tools?.length === 8);
  // an external MCP client: JSON sign-in gives a bearer token for a new workspace; no cookie, no Origin
  const agent = reuse ? { endpoint: `${url}/mcp`, token: (await session(url, sec.accessCode)).token } as J : await (await fetch(`${url}/signin`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: sec.accessCode }) })).json() as J;
  const viaToken = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) });
  check('external MCP client with a bearer token', agent.endpoint === `${url}/mcp` && ((await viaToken.json()) as J).result?.tools?.length === 8);
  // a reused kitchen may also hold recipes it imported (a file or pasted text): only the prepared examples are counted
  const book = ((await mcp(cookie!, 'list_recipes')).recipes as J[]).filter((r) => !reuse || !/\.pdf\b|pasted text/i.test(r.sourceLabel ?? ''));
  check('two prepared examples (the scones are the Add recipe sample)', book?.length === 2 && !book.some((r) => /Scones/.test(r.title)), book?.map((r) => r.title).join(', '));
  // cook the risotto to its step 5 (the product's progress path), ask by tapping (no model), accept, apply, reconcile
  const content = loadContent(), risotto = book.find((r) => /risotto/i.test(r.title))!;
  const prior = reuse ? (await mcp(cookie!, 'get_active_recipe')).run as J | null : null;   // a reused kitchen may have a session open
  const st = await mcp(cookie!, 'start_recipe', { commandId: `v-${Date.now()}-s`, recipeId: risotto.recipeId, ...(prior ? { replace: { runId: prior.id, epoch: prior.epoch, expectedRevision: prior.revision, confirm: true } } : {}) });
  let run = st.run as J;
  for (const [i, x] of content.fixtures.get('risotto.step5')!.actions.entries()) run = (await mcp(cookie!, 'record_progress', { commandId: `v-${Date.now()}-p${i}`, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, ...x })).run;
  const base = { runId: run.id, epoch: run.epoch, expectedRevision: run.revision };
  const wine = (st.recipe.ingredients as J[]).find((i) => /wine/i.test(i.name))!.id;
  const e1 = await mcp(cookie!, 'evaluate_rescue', { commandId: `v-${Date.now()}-e1`, ...base, missingIngredientId: wine, proposedKindIds: ['lemon-juice'], utterance: { text: 'wine', channel: 'tapped' } });
  check('availability question (no model call)', e1.outcome === 'needsFacts', e1.speech?.text);
  const e2 = await mcp(cookie!, 'evaluate_rescue', { commandId: `v-${Date.now()}-e2`, ...base, previousEvaluationId: e1.id, answers: (e1.questions as J[]).map((q) => ({ questionId: q.id, value: 'yes' })) });
  check('proposal after "yes" (nothing applied)', e2.outcome === 'proposal' && (await mcp(cookie!, 'get_active_recipe')).run.appliedAmendments.length === 0);
  const accept = { commandId: `v-${Date.now()}-a`, ...base, evaluationId: e2.id, candidateId: e2.candidates[0].id, planId: e2.candidates[0].planId, accepted: true };
  const ap = await mcp(cookie!, 'apply_amendment', accept);
  check('explicit acceptance applies once', ap.outcome === 'applied' && (await mcp(cookie!, 'apply_amendment', accept)).outcome === 'alreadyApplied');
  const read = await mcp(cookie!, 'get_active_recipe', { commandId: accept.commandId });
  check('lost-response reconciliation', read.command?.status === 'applied' && read.run.steps.find((x: J) => x.stepId === read.run.currentStepId)?.progress === 'notStarted');
  // refusal: the shortcake's whipped cream
  const other = await signIn();
  const sk = book.find((r) => /shortcake/i.test(r.title))!;
  const cur = reuse ? (await mcp(other!, 'get_active_recipe')).run as J | null : null;   // one kitchen: the shortcake replaces the risotto session
  const st2 = await mcp(other!, 'start_recipe', { commandId: `v-${Date.now()}-s2`, recipeId: sk.recipeId, ...(cur ? { replace: { runId: cur.id, epoch: cur.epoch, expectedRevision: cur.revision, confirm: true } } : {}) });
  let run2 = st2.run as J;
  for (const [i, x] of content.fixtures.get('shortcake.step6')!.actions.entries()) run2 = (await mcp(other!, 'record_progress', { commandId: `v-${Date.now()}-q${i}`, runId: run2.id, epoch: run2.epoch, expectedRevision: run2.revision, ...x })).run;
  const cream = (st2.recipe.ingredients as J[]).find((i) => /cream/i.test(i.name))!.id;
  const no = await mcp(other!, 'evaluate_rescue', { commandId: `v-${Date.now()}-r`, runId: run2.id, epoch: run2.epoch, expectedRevision: run2.revision, missingIngredientId: cream, proposedKindIds: ['whole-milk', 'unsalted-butter'], utterance: { text: 'cream', channel: 'tapped' } });
  check('refusal leaves the recipe unchanged', no.outcome === 'refused' && (await mcp(other!, 'get_active_recipe')).run.revision === run2.revision, no.speech?.text);
  if (reuse) skip('another sign-in is another kitchen'); else check('another sign-in is another kitchen', (await mcp(other!, 'get_active_recipe')).run.id !== run.id);
  const up = await fetch(`${url}/uploads`, { method: 'POST', headers: { cookie: cookie!, origin, 'content-type': 'application/pdf', 'x-filename': 'scones-explicit.pdf' }, body: readFileSync(join(ROOT, 'samples/scones-explicit.pdf')) });
  const handle = ((await up.json()) as J).sourceDocId as string;
  check('PDF upload through the Function URL', up.status === 201, handle);
  let ws = '';
  if (flags.paid) ws = await paidChecks(url, origin, cookie!, other!, { runId: run2.id, epoch: run2.epoch, expectedRevision: run2.revision }, handle, check, mcp);
  // the state a restore must bring back: this kitchen's run, its amendment and its progress
  const kitchen = await mcp(cookie!, 'get_active_recipe');
  const gate = new Gate({ kv: kvOf(data().table), ledger: new KvLedger(kvOf(data().table)), codeHashes: [createHash('sha256').update(sec.accessCode).digest('hex')], sessionKey: Buffer.from(sec.sessionKey, 'base64') });
  writeFileSync(join(DIR, 'last-verify.json'), JSON.stringify({ at: new Date().toISOString(), url, workspace: gate.session(cookie!), runId: kitchen.run.id, revision: kitchen.run.revision,
    amendments: kitchen.run.appliedAmendments.length, steps: kitchen.run.steps.map((x: J) => [x.stepId, x.progress]), savedRecipes: ws ? 1 : 0 }, null, 2));
  if (reuse) { skip('Start over (this workspace only)'); return finish(results); }
  const reset = await fetch(`${url}/workspace/reset`, { method: 'POST', headers: { cookie: cookie!, origin } });
  check('Start over (this workspace only)', reset.status === 200 && (await mcp(reset.headers.getSetCookie()[0].split(';')[0], 'get_active_recipe')).run === null && (await mcp(cookie!, 'get_active_recipe')).run !== null);
  finish(results);
}
async function paidChecks(url: string, origin: string, cookie: string, other: string, base: J, handle: string, check: (n: string, ok: boolean, d?: string) => boolean, mcp: (c: string, n: string, a?: J) => Promise<J>) {
  const ledger = new KvLedger(kvOf(data().table)), before = (await ledger.usage()).totals?.usd as number | undefined ?? 0;
  // the README's shortcake example: live Nova reads the request, the engine refuses (whipping needs cream)
  const said = await mcp(other, 'evaluate_rescue', { commandId: `v-${Date.now()}-i`, ...base, utterance: { text: "I'm out of heavy cream. Can I use milk and butter to whip instead?", channel: 'typed' } });
  check('PAID: live interpretation → the reviewed refusal', said.outcome === 'refused', `${said.outcome} · ${said.speech?.text ?? said.message ?? ''}`);
  const sp = await fetch(`${url}/speech`, { method: 'POST', headers: { cookie: other, origin, 'content-type': 'application/json' }, body: JSON.stringify({ evaluationId: said.id }) });
  check('PAID: Polly reply', sp.status === 200 && (sp.headers.get('content-type') ?? '').startsWith('audio/mpeg'), `${sp.status} cached=${sp.headers.get('x-speech-cached')}`);
  const imp = await mcp(cookie, 'import_recipe', { commandId: `v-${Date.now()}-imp`, source: { kind: 'upload', sourceDocId: handle } });
  let job = imp.job as J;
  for (let i = 0; i < 120 && (job.state === 'queued' || job.state === 'running'); i++) { await new Promise((r) => setTimeout(r, 2000)); job = ((await (await fetch(`${url}/imports/${job.id}`, { headers: { cookie } })).json()) as J).job; }
  check('PAID: import read by the worker (survives the request)', job.state === 'succeeded' || job.state === 'partial', `${job.state} ${job.failure?.message ?? ''}`);
  if (job.state === 'succeeded' || job.state === 'partial') {
    const d = ((await (await fetch(`${url}/drafts/${job.draftId}`, { headers: { cookie } })).json()) as J).draft;
    const saved = await (await fetch(`${url}/drafts/${job.draftId}/save`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: d.revision }) })).json() as J;
    check('PAID: saved to the Recipe Book', !!saved.recipeId && ((await mcp(cookie, 'list_recipes')).recipes as J[]).some((r) => r.recipeId === saved.recipeId));
  }
  const after = (await ledger.usage()).totals?.usd as number | undefined ?? 0;
  say(`  ledger: $${(after - before).toFixed(4)} reserved or settled by these checks`);
  return 'ok';
}
/** After a restore: the kitchen the last verify left is back, readable directly and through the new URL. */
async function verifyRestored(url: string, origin: string) {
  const last = readJson<{ workspace: string; runId: string; revision: number; amendments: number; steps: [string, string][]; savedRecipes: number }>('last-verify.json') ?? fail('no last-verify.json: run verify before the backup');
  const results: { check: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => { results.push({ check: name, ok, detail }); say(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
  const kv = kvOf(data().table), knowledge = storeKnowledge(kvOf(data().knowledge));   // the restored releases, never the local files
  const svc = new Service({ kv, ws: last.workspace, knowledge, interpreter: noneInterpreter, fixtureRecipes: exampleIds(PRODUCT_EXAMPLES) });
  const author = new Authoring({ kv, ws: last.workspace, knowledge, extractor: offExtractor });
  svc.catalog = (t) => author.catalogIn(t);
  const read = await svc.getActiveRecipe();
  check('restored cooking session', read.run?.id === last.runId && read.run.revision === last.revision);
  check('restored progress', JSON.stringify(read.run?.steps.map((x) => [x.stepId, x.progress])) === JSON.stringify(last.steps));
  check('restored amendment history', read.run?.appliedAmendments.length === last.amendments);
  check('restored saved recipes', (await svc.listRecipes()).recipes.length === 2 + last.savedRecipes);
  const runRow = await kv.get({ pk: wsPk(last.workspace), sk: K.run(last.runId) });
  const packRow = runRow && await kv.get({ pk: wsPk(last.workspace), sk: K.pack(runRow.packHash as string) });
  check('the restored session\'s pinned release is readable', !!packRow && !!(await svc.known(packRow.pack as RecipePack)).content, JSON.stringify(read.run?.knowledge));
  const all: Item[] = [];
  for await (const page of kv.scan!()) all.push(...page);
  const gaps = await knowledgeGaps(kvOf(data().knowledge), referencedReleases(all));
  check('every release a saved recipe or session uses is restored and verifies', gaps.length === 0, gaps.join('; ') || `${referencedReleases(all).pinned.length} release(s)`);
  const sec = secrets();
  const gate = new Gate({ kv, ledger: new KvLedger(kv), codeHashes: [createHash('sha256').update(sec.accessCode).digest('hex')], sessionKey: Buffer.from(sec.sessionKey, 'base64') });
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { cookie: gate.cookie(last.workspace).split(';')[0], origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_active_recipe', arguments: {} } }) });
  check('the restored kitchen opens through the new URL (same session key)', ((await r.json()) as J).result?.structuredContent?.run?.id === last.runId);
  const fresh = await fetch(`${url}/signin`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${encodeURIComponent(sec.accessCode)}` });
  check('judge sign-in still opens a new workspace', fresh.status === 303);
  finish(results);
}
function finish(results: { ok: boolean }[]) {
  const bad = results.filter((r) => !r.ok).length;
  say(bad ? `\n✗ ${bad} of ${results.length} checks failed (${elapsed()})` : `\n✓ all ${results.length} checks passed (${elapsed()})`);
  if (bad) process.exit(1);
}

// ---------- backup and restore (consistent: freeze, let running work settle, then export) ----------
const history = (): Closed[] => (existsSync(join(DIR, 'spend-history.jsonl')) ? readFileSync(join(DIR, 'spend-history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Closed) : []);
function remember(c: Closed) { if (!history().some((h) => h.lifetime === c.lifetime)) appendFileSync(join(DIR, 'spend-history.jsonl'), JSON.stringify(c) + '\n'); }
/** Freeze (or keep a freeze), then wait until no request can still be running and no accepted job or paid call is unsettled. */
async function settle(kv: DynamoKv) {
  const m = (await freeze(kv, `maintenance by npm run cc (${cmd})`)) as { at: string };
  say(`  maintenance ON since ${m.at}: new requests get 503; running work may finish`);
  for (let i = 0; ; i++) {
    const wait = Date.parse(m.at) + REQUEST_DRAIN_MS - Date.now();
    const open = await inflight(kv.scan!());
    if (wait <= 0 && !open.jobs.length && !open.reservations.length) return m.at;
    if (i % 3 === 0) say(`  settling: ${Math.max(0, Math.ceil(wait / 1000))} s of request drain left, ${open.jobs.length} import job(s), ${open.reservations.length} unsettled paid call(s)`);
    if (i > 80) fail('running work did not settle in 13 minutes: the environment stays in maintenance; check npm run cc -- jobs, then retry');
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
async function backup(): Promise<string> {
  const id = identity(), { table, bucket } = data(), a = stack(STACK.app), kv = kvOf(table);
  const wasFrozen = !!(await mode(kv))?.frozen, frozenAt = await settle(kv);
  const out = typeof flags.out === 'string' ? flags.out : join(process.env.CC_BACKUP_DIR ?? join(homedir(), 'CourseCorrect-backups'), env, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(join(out, 'speech'), { recursive: true });
  const lines: string[] = [];
  for await (const page of kv.scan!()) for (const it of page) lines.push(JSON.stringify(it));   // owner tooling: the one place a scan is used
  writeFileSync(join(out, 'items.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  const klines: string[] = [];   // the knowledge releases saved recipes and sessions are pinned to (the whole table: it is small)
  for await (const page of kvOf(data().knowledge).scan!()) for (const it of page) klines.push(JSON.stringify(it));
  writeFileSync(join(out, 'knowledge.jsonl'), klines.join('\n') + (klines.length ? '\n' : ''));
  const clips = (await listAll(bucket)).filter((o) => o.Key.startsWith('speech/'));
  for (const o of clips) writeFileSync(join(out, o.Key), await (await s3().send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }))).Body!.transformToByteArray());
  const sha = (f: string) => createHash('sha256').update(readFileSync(join(out, f))).digest('hex');
  const files = ['items.jsonl', 'knowledge.jsonl', ...clips.map((o) => o.Key)];
  const spend = await closeLifetime(kv, 'destroy');
  const manifest = { kind: 'cc-backup/2', env, account: id.masked, region: cfg.region, table, bucket, version: a?.out.Version ?? null, url: a?.out.Url ?? null, createdAt: new Date().toISOString(),
    consistent: true, frozenAt, lifetime: spend.lifetime, lifetimeUsd: spend.usd, items: lines.length, knowledgeItems: klines.length, knowledgeReleases: referencedReleases(lines.map((l) => JSON.parse(l) as Item)),
    speechObjects: clips.length, files: Object.fromEntries(files.map((f) => [f, sha(f)])) };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!flags['keep-frozen'] && !wasFrozen) { await unfreeze(kv); say('  maintenance OFF'); }
  say(`✓ consistent backup of ${env}: ${lines.length} items, ${klines.length} knowledge items, ${clips.length} clips → ${out} (${elapsed()}). Local disk only: no AWS charge.${flags['keep-frozen'] || wasFrozen ? ' The environment stays in maintenance (for destroy).' : ''}`);
  return out;
}
function readBackup(dir: string) {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { kind: string; env: string; createdAt: string; items: number; files: Record<string, string>; consistent?: boolean; frozenAt?: string; lifetime?: string };
  if (m.kind !== 'cc-backup/2' || !m.consistent) fail(`${dir} is not a consistent CourseCorrect backup (take one with npm run cc -- backup)`);
  for (const [f, h] of Object.entries(m.files)) if (createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') !== h) fail(`backup file ${f} does not match its manifest hash`);
  return m;
}
async function restore() {
  const from = typeof flags.from === 'string' ? flags.from : fail('--from <backup folder> is required');
  if (flags.confirm !== env) fail(`restore writes into ${env}: add --confirm ${env}`);
  const m = readBackup(from), { table, bucket } = data(), kv = kvOf(table);
  await settle(kv);   // nothing else writes while the restore runs
  const existing: Item[] = [];
  for await (const page of kv.scan!()) existing.push(...page.filter((x) => x.pk.startsWith('W#')));
  if (existing.length) fail(`${table} already holds ${existing.length} workspace items: restore only into a fresh deployment (destroy --mode full, deploy, then restore). It stays in maintenance: npm run cc -- maintenance --off`);
  const backupItems = readFileSync(join(from, 'items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Item);
  // knowledge first: every release the restored recipes are pinned to must be back, and verify, before any recipe is
  if (!m.files['knowledge.jsonl']) fail(`${from} predates knowledge releases: restore it with a build from before 2026-10-11, or publish the release its recipes match first (npm run cc -- knowledge publish)`);
  const kItems = readFileSync(join(from, 'knowledge.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Item);
  const k = await restoreKnowledge(kvOf(data().knowledge), kItems);
  const gaps = await knowledgeGaps(kvOf(data().knowledge), referencedReleases(backupItems));
  if (gaps.length) fail(`knowledge the backup's recipes need is missing or damaged (nothing of the workspace table was written; it stays in maintenance):\n  ${gaps.join('\n  ')}`);
  say(`  knowledge: ${k.written} item(s) restored, ${k.kept} already there; active ${k.active ?? 'none'}; every pinned release verifies`);
  const plan = planRestore(backupItems);
  const queue = [...plan.write];
  await Promise.all(Array.from({ length: 8 }, async () => { for (let x = queue.shift(); x; x = queue.shift()) await kv.write([{ put: x }]); }));
  const clips = Object.keys(m.files).filter((f) => f.startsWith('speech/'));
  for (const f of clips) await s3().send(new PutObjectCommand({ Bucket: bucket, Key: f, Body: readFileSync(join(from, f)), ContentType: f.endsWith('.mp3') ? 'audio/mpeg' : 'application/json' }));
  await carry(kv, plan.carry);   // the backup's spending comes back as carried lifetimes (deduplicated): never reset, never doubled
  for (const c of plan.carry) remember(c);
  const u = await new KvLedger(kv).usage();
  if (!flags['keep-frozen']) await unfreeze(kv);
  say(`✓ restored ${plan.write.length} items and ${clips.length} clips from ${m.createdAt} into ${env} (${elapsed()}); carried spending now $${u.carriedUsd.toFixed(4)}, project total $${u.projectUsd.toFixed(4)}. Next: npm run cc -- verify --env ${env} --restored`);
}

// ---------- destroy ----------
async function destroy() {
  const modeName = flags.mode === 'compute' || flags.mode === 'full' ? flags.mode : fail('--mode compute (remove functions, URL, role and logs; keep data) or --mode full (remove everything) is required');
  if (flags.confirm !== env) fail(`this removes resources of ${env}: add --confirm ${env}`);
  const id = identity(), d = stack(STACK.data), a = stack(STACK.app);
  say(`Destroying (${modeName}) ${env} in account ${id.masked}, ${cfg.region}:`);
  say(`  ${STACK.app}: ${a?.status ?? 'not deployed'} → functions cc-${env}-web and cc-${env}-worker, their URL, role cc-${env}-fn, log groups /aws/lambda/cc-${env}-*`);
  if (modeName === 'full') {
    say(`  ${STACK.data}: ${d?.status ?? 'not deployed'} → table ${d?.out.TableName ?? '-'} (every workspace, recipe, session, receipt and the ledger), table ${d?.out.KnowledgeTableName ?? '-'} (every knowledge release) and bucket ${d?.out.BucketName ?? '-'} (artifacts, clips)`);
    if (flags['no-backup'] !== true) {
      const b = typeof flags.backup === 'string' ? readBackup(flags.backup) : fail('--mode full needs --backup <folder from npm run cc -- backup --keep-frozen> (or --no-backup to lose the data on purpose)');
      const now = d ? await mode(kvOf(d.out.TableName)) : undefined;
      if (b.env !== env) fail('that backup is not of this environment');
      if (d && (!now?.frozen || now.at !== b.frozenAt)) fail('the environment changed or reopened since that backup: run  npm run cc -- backup --env ' + env + ' --keep-frozen  and destroy with that one');
    }
  }
  if (a) { aws(['cloudformation', 'delete-stack', '--stack-name', STACK.app]); aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK.app], { json: false }); say(`  ✓ ${STACK.app} deleted`); }
  if (modeName === 'full' && d) {
    const closed = await closeLifetime(kvOf(d.out.TableName), 'destroy');   // this table's spending, carried by every later table of this environment
    remember(closed);
    say(`  spending of this table ($${closed.usd.toFixed(4)}, ${closed.lifetime}) recorded in ${join(DIR, 'spend-history.jsonl')}`);
    deployStack(STACK.data, 'data.yaml', { Env: env, DeletionProtection: 'false' });
    await emptyBucket(d.out.BucketName);
    aws(['cloudformation', 'delete-stack', '--stack-name', STACK.data]); aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK.data], { json: false });
    say(`  ✓ ${STACK.data} deleted`);
  }
  residuals(modeName);
  say(`  done in ${elapsed()}`);
}
async function emptyBucket(bucket: string) {   // every version and delete marker, in case versioning was ever turned on
  let key: string | undefined, ver: string | undefined, n = 0;
  do {
    const r = await s3().send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: key, VersionIdMarker: ver }));
    const objs = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key!, VersionId: o.VersionId }));
    if (objs.length) { await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } })); n += objs.length; }
    key = r.IsTruncated ? r.NextKeyMarker : undefined; ver = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (key);
  say(`  ✓ emptied ${bucket} (${n} objects and versions)`);
}
/** What is left of this environment, checked rather than assumed. */
function residuals(mode: 'compute' | 'full') {
  const left: string[] = [];
  for (const s of [STACK.app, ...(mode === 'full' ? [STACK.data] : [])]) if (stack(s)) left.push(`stack ${s}`);
  for (const f of ['web', 'worker']) if (aws(['lambda', 'get-function', '--function-name', `cc-${env}-${f}`], { quiet: true })) left.push(`function cc-${env}-${f}`);
  if (aws(['iam', 'get-role', '--role-name', `cc-${env}-fn`], { quiet: true })) left.push(`role cc-${env}-fn`);
  const lg = aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/cc-${env}-`]) as { logGroups: { logGroupName: string }[] };
  left.push(...lg.logGroups.map((g) => `log group ${g.logGroupName}`));
  if (mode === 'full') {
    for (const t of [`cc-${env}`, `cc-${env}-knowledge`]) if (aws(['dynamodb', 'describe-table', '--table-name', t], { quiet: true })) left.push(`table ${t}`);
    const id = identity();
    if (aws(['s3api', 'head-bucket', '--bucket', `cc-${env}-${id.account}`], { quiet: true })) left.push(`bucket cc-${env}-${id.account}`);
  }
  say(left.length ? `  ✗ still present: ${left.join('; ')}` : `  ✓ residual check: nothing of ${env} is left${mode === 'compute' ? ' except the data stack (table + bucket), kept on purpose' : ''}`);
  if (left.length) process.exitCode = 1;
}

// ---------- the owner's controls ----------
async function allowances() {
  const kv = kvOf(data().table), cur = await kv.get({ pk: LEDGER, sk: 'AUTH' });
  if (flags.apply) return recordAuthorization(data().table, readJson<Authorization>('authorization.json') ?? fail('no authorization.json'));
  if (flags.pause || flags.resume) {
    if (!cur) fail('no authorization is recorded (deploy first)');
    await kv.write([{ put: { ...cur!, paused: !!flags.pause, v: cur!.v! + 1 }, if: cur!.v! }]);
    return say(`✓ paid model work ${flags.pause ? 'PAUSED: every Nova and Polly call is refused now (cached clips still play)' : 'resumed under the recorded caps'}`);
  }
  say(JSON.stringify(cur ?? 'none recorded', null, 2));
}
async function usage() {
  const kv = kvOf(data().table), ledger = new KvLedger(kv), u = await ledger.usage();
  say(`authorization ${u.authorization?.id ?? 'none'}${u.authorization?.paused ? ' (PAUSED)' : ''}: this table ${JSON.stringify(u.totals?.calls ?? {})} $${((u.totals?.usd as number | undefined) ?? 0).toFixed(4)} + earlier tables ${JSON.stringify(u.carriedForAuthorization.calls)} $${u.carriedForAuthorization.usd.toFixed(4)} of $${u.authorization?.maxUsd ?? 0}`);
  say(`project: before Lambda $${(u.authorization?.priorProjectUsd ?? 0).toFixed(4)} + this table $${u.thisTableUsd.toFixed(4)} + earlier tables $${u.carriedUsd.toFixed(4)} = $${u.projectUsd.toFixed(4)} of $${u.authorization?.projectCeilingUsd ?? 0}`);
  const wss = await kv.query('GATE', { prefix: 'WS#' });
  say(`${wss.length} workspaces (${wss.filter((w) => w.via === 'reset').length} from Start over)`);
  for (const w of wss) { const x = await ledger.usage(w.ws as string); if (x.workspace) say(`  ${w.ws} (${w.at}): ${JSON.stringify(x.workspace.calls)}, $${(x.workspace.usd as number).toFixed(4)}`); }
}
async function jobs() {   // owner tooling: a scan for import jobs (failed ones are retried by importing again; nothing is re-run automatically)
  for await (const page of kvOf(data().table).scan!()) for (const j of page.filter((x) => x.sk.startsWith('JOB#'))) say(`${j.createdAt} ${j.pk} ${j.jobId} ${j.state}${j.failure ? ` · ${(j.failure as { message: string }).message}` : ''}`);
}

/** Maintenance switch: while on, every new request gets 503 (data consistent; running work finishes). */
async function maintenance() {
  const kv = kvOf(data().table);
  if (flags.on) { await freeze(kv, typeof flags.reason === 'string' ? flags.reason : 'owner'); return say('✓ maintenance ON: new requests get 503 with a message; running requests and accepted imports finish'); }
  if (flags.off) { await unfreeze(kv); return say('✓ maintenance OFF'); }
  say(JSON.stringify((await mode(kv)) ?? { frozen: false }));
}
/** The worker's reserved concurrency in infra/app.yaml (WorkerConcurrency's default): imports read at once. */
const WORKER_CONCURRENCY = 2;
/** Emergency stop: no function runs at all (Function URL requests get 429; queued imports are not started and read as failed after 11 minutes). */
function stopStart() {
  for (const f of ['web', 'worker']) {
    if (cmd === 'stop') aws(['lambda', 'put-function-concurrency', '--function-name', `cc-${env}-${f}`, '--reserved-concurrent-executions', '0']);
    else if (f === 'worker') aws(['lambda', 'put-function-concurrency', '--function-name', `cc-${env}-worker`, '--reserved-concurrent-executions', String(WORKER_CONCURRENCY)]);   // back to the template's limit
    else aws(['lambda', 'delete-function-concurrency', '--function-name', `cc-${env}-${f}`], { json: false });
  }
  say(cmd === 'stop' ? `✓ STOPPED cc-${env}-web and cc-${env}-worker (reserved concurrency 0). Requests already running finish. Undo: npm run cc -- start --env ${env}` : `✓ started cc-${env}-web and cc-${env}-worker`);
}

/** Knowledge releases: the owner's publication path (the functions can only read the table). */
async function knowledge() {
  const sub = rest[0], kv = kvOf(data().knowledge);
  if (sub === 'publish') {
    const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null;
    const dirty = spawnSync('git', ['status', '--porcelain', 'content/approved'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() ? '-dirty' : '';
    // --dir: an earlier approved tree (git archive <commit> content/approved), e.g. the release recipes saved before releases match
    const dir = typeof flags.dir === 'string' ? flags.dir : join(ROOT, 'content/approved');
    const files = readKnowledgeDir(dir);
    // content still awaiting the owner's confirmation is published only inactive, unless the owner says otherwise explicitly
    const pending = pendingIn(files);
    if (flags.activate && pending.length && !flags['allow-pending']) fail(`this release contains content pending owner confirmation (${pending.join(', ')}): publish it without --activate, or add --allow-pending once the owner has decided`);
    const r = await publishRelease(kv, files, { activate: !!flags.activate, note: typeof flags.note === 'string' ? flags.note : '',
      source: { commit: typeof flags.dir === 'string' ? (typeof flags.commit === 'string' ? flags.commit : null) : git ? `${git}${dirty}` : null, dir: typeof flags.dir === 'string' ? dir : 'content/approved' } });
    return say(`✓ release ${r.releaseId}: ${r.created ? 'published (validated, every record verified)' : 'already published'}${r.activated ? `; now ACTIVE (was ${r.previous ?? 'none'}): new recipes use it; saved recipes and running sessions keep theirs` : flags.activate ? '; already active' : `; not active (npm run cc -- knowledge activate --env ${env} --release ${r.releaseId})`}`);
  }
  if (sub === 'candidate') {   // local only: a release directory built from a base tree and a proposed packet; publishes nothing
    const base = typeof flags.base === 'string' ? flags.base : fail('--base <knowledge dir> is required (e.g. git archive ee617ab content/approved)');
    const packet = typeof flags.packet === 'string' ? flags.packet : fail('--packet <dir> is required');
    const out = typeof flags.out === 'string' ? flags.out : fail('--out <dir> is required');
    const files = mergePacket(readKnowledgeDir(base), packet), errors = knowledgeErrors(files);
    if (errors.length) fail(`the candidate doesn't validate:\n  ${errors.join('\n  ')}`);
    writeKnowledgeDir(out, files);
    const pend = pendingIn(files);
    return say(`candidate ${releaseIdOfFiles(files)} written to ${out}: ${files.vocabulary.kinds.length} kinds, ${files.roles.roles.length} role rows, ${files.patterns.length} patterns${pend.length ? `; pending owner confirmation: ${pend.join(', ')}` : ''}. Not published.`);
  }
  if (sub === 'activate') {
    const id = typeof flags.release === 'string' ? flags.release : fail('--release <id> is required (npm run cc -- knowledge list)');
    const pend = (await loadRelease(kv, id)).manifest.records.filter((x) => x.authority.approval !== 'OWNER_APPROVED_ENGINEERING').map((x) => x.sk);
    if (pend.length && !flags['allow-pending']) fail(`${id} contains content pending owner confirmation (${pend.join(', ')}): add --allow-pending once the owner has decided`);
    const r = await activateRelease(kv, id);
    return say(r.activated ? `✓ ${id} is ACTIVE (was ${r.previous ?? 'none'}): new recipes use it; saved recipes and running sessions keep theirs` : `${id} was already active`);
  }
  const active = await activeReleaseId(kv), rels = await listReleases(kv);
  if (sub === 'list') {
    for (const r of rels) {
      const { manifest } = await loadRelease(kv, r.releaseId);
      const pending = manifest.records.filter((x) => x.authority.approval !== 'OWNER_APPROVED_ENGINEERING').map((x) => x.sk.replace('REC#pattern#', ''));
      say(`${r.releaseId === active ? '* ' : '  '}${r.releaseId}  published ${r.publishedAt}  ${r.records} records  source ${manifest.source.commit ?? '-'}  ${r.note}${pending.length ? `  · pending owner confirmation: ${pending.join(', ')}` : ''}`);
    }
    return say(rels.length ? '(* = active; physical culinary validation recorded for none)' : 'no releases published');
  }
  if (sub === 'verify') {
    for (const r of rels) { try { await loadRelease(kv, r.releaseId); say(`  ✓ ${r.releaseId}`); } catch (e) { say(`  ✗ ${r.releaseId}: ${(e as Error).message}`); process.exitCode = 1; } }
    return;
  }
  if (sub === 'refs') {   // owner tooling: a scan of the workspace table
    const items: Item[] = [];
    for await (const page of kvOf(data().table).scan!()) items.push(...page);
    const refs = referencedReleases(items), gaps = await knowledgeGaps(kv, refs);
    say(`pinned: ${refs.pinned.join(', ') || 'none'}; saved before releases: ${refs.legacy.length}`);
    for (const g of gaps) say(`  ✗ ${g}`);
    return say(gaps.length ? `✗ ${gaps.length} gap(s)` : '✓ every release in use is published and verifies');
  }
  fail('knowledge publish [--activate] | activate --release <id> | list | refs | verify | candidate --base <dir> --packet <dir> --out <dir>');
}

const run: Record<string, () => unknown> = {
  stage, deploy, status, verify, backup, restore, destroy, allowances, usage, jobs, maintenance, stop: stopStart, start: stopStart, knowledge,
  logs: () => aws(['logs', 'tail', `/aws/lambda/cc-${env}-${flags.worker ? 'worker' : 'web'}`, '--since', typeof flags.since === 'string' ? flags.since : '1h', '--format', 'short'], { stream: true, json: false }),
};
if (!run[cmd]) fail(`unknown command ${cmd ?? '(none)'}: init, stage, deploy, status, verify, backup, restore, destroy, allowances, usage, jobs, logs, maintenance, stop, start, knowledge`);
await run[cmd]();
