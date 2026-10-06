// Held-out transfer (ESOD §9.6). Two commands, each runnable once:
//   node src/probes/transfer.ts register <file>   identity + frozen hashes + expectations, BEFORE anyone reads the recipe.
//                                                 Prints only hashes and size; never the content.
//   node src/probes/transfer.ts record [db] [port] after the owner imports/reviews/saves it in the live companion:
//                                                 refuses on drift, buckets every use, runs the frozen evaluation states
//                                                 over real MCP (structured input, no model calls), writes result.json once.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ENGINE_SEMANTICS, type RecipePack } from '../contract/types.ts';
import { hash, sha256 } from '../domain/rational.ts';
import { promptIdentity } from '../authoring/extract.ts';
import { interpretPromptIdentity } from '../service/interpret.ts';
import { loadContent } from '../service/content.ts';

const root = join(import.meta.dirname, '../..');
const dir = join(root, 'private/transfer/heldout-1');
const regPath = join(dir, 'registration.json'), resPath = join(dir, 'result.json');
const content = loadContent();
const srcFiles = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? srcFiles(p) : /\.tsx?$/.test(f) ? [p] : []; });
const frozen = () => ({
  engineSemantics: ENGINE_SEMANTICS,
  vocabularyHash: hash(content.vocab),
  patternSetHash: hash(content.patterns),
  extractorPromptId: promptIdentity(content.vocab),
  interpreterPromptId: interpretPromptIdentity(),
  sourceTreeHash: hash(srcFiles(join(root, 'src')).filter((f) => !f.includes('/probes/')).sort().map((f) => [relative(root, f), sha256(readFileSync(f, 'utf8'))])),
});

/** Written before the recipe is read. Recipe-agnostic: what each reviewed rule must do with ANY recipe. */
const EXPECTATIONS = {
  prior: 'Most likely NO_PATTERN for most uses and NOT_APPLICABLE or NEEDS_FACTS for any rule family present; BOUND only if the recipe falls inside a reviewed rule\'s explicit applicability. A failure to transfer is a valid, recorded result.',
  perRule: {
    'split': 'Targets a wine-class use performing ACIDITY+LIQUID at a DEGLAZE step. BOUND only if: wine EXACT 100–150 ML (cook-confirmed); exactly one later LADLE_STOCK cooking-stock LIQUID use; exactly one later OFF_HEAT_FINISH step; one risotto-rice use with mass 280–320 g confirmed. Household volumes without a weighed rice mass → NEEDS_FACTS (rice mass). Outside a range → NOT_APPLICABLE.',
    'cream_to_butter_milk': 'Targets a heavy-cream use performing FAT+LIQUID at MIX_DOUGH with a COMBINE_DRY step before it. BOUND only if listed cream total is EXACT 250–350 ML and every other cream use has a sibling handler (BROWNING at BRUSH). Otherwise NOT_APPLICABLE.',
    'whip_needs_cream': 'Refusal on a heavy-cream use performing AERATION at WHIP for proposal {milk, butter}. Binds only with those reviewed facts.',
  },
  vocabulary: 'Any ingredient whose kind is not in the frozen vocabulary is recorded as a vocabulary gap; no kind or class is added during the attempt.',
  engine: 'No ENGINE_ERROR. A structural extraction error is recorded as-is.',
};
const ALLOWED = ['cook amount confirmations in the review canvas (truthful to the source)', 'owner culinary review in the owner screen (truthful; nothing pre-selected)', 'pasting text the source itself contains when a page has no text layer', 'saving'];
const FORBIDDEN = ['changing patterns, vocabulary, engine or prompts', 're-running extraction', 'editing the source', 'answering review questions to make a rule bind'];
const STATES = [
  'Each BOUND recovery binding: steps before the target step done, every availability question answered yes → expect a proposal (planHash present, consequence authored).',
  'Each BOUND recovery binding: the target step reported started → expect refused protectedWork.',
  'Each BOUND refusal binding: proposal of one kind per refused class → expect refused functionallyUnsupported.',
  'One ingredient with no binding, at its first open use → expect refused noReviewedRecovery.',
];

if (process.argv[2] === 'register') {
  const file = process.argv[3];
  if (!file) throw new Error('usage: transfer.ts register <file>');
  if (existsSync(regPath)) throw new Error(`already registered: ${regPath} (registration is once; nothing changed)`);
  const bytes = readFileSync(file);
  const reg = {
    kind: 'cc-transfer-registration/1', id: 'heldout-1', registeredAt: new Date().toISOString(), selectedBy: 'owner', inspectedBeforeRegistration: false,
    source: { file: relative(root, file), sha256: createHash('sha256').update(bytes).digest('hex'), serviceSourceKey: sha256(bytes.toString('latin1')), bytes: bytes.length, mediaType: bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : 'text/plain' },
    frozen: frozen(), budget: { authorization: 'm3-2026-10-02', extractionCalls: 1, interpretationCalls: 0, maxUsd: 0.05, retries: 0 },
    allowedActions: ALLOWED, forbidden: FORBIDDEN, evaluationStates: STATES, expectations: EXPECTATIONS,
    buckets: ['BOUND_AND_PLANNED', 'NEEDS_FACTS(list)', 'NOT_APPLICABLE(check)', 'NO_PATTERN', 'ENGINE_ERROR'],
    rule: 'If any pattern, class or kind must change, the attempt closes as recorded; that change is development and needs a new held-out recipe.',
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(regPath, JSON.stringify(reg, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ registered: regPath, sha256: reg.source.sha256, bytes: reg.source.bytes, mediaType: reg.source.mediaType, frozen: reg.frozen }, null, 2));
} else if (process.argv[2] === 'record') {
  const reg = JSON.parse(readFileSync(regPath, 'utf8')) as { source: { serviceSourceKey: string; sha256: string }; frozen: ReturnType<typeof frozen> };
  if (existsSync(resPath)) throw new Error('a result is already recorded; the first outcome is kept');
  const now = frozen();
  const drift = Object.keys(reg.frozen).filter((k) => reg.frozen[k as keyof typeof now] !== now[k as keyof typeof now]);
  const write = (r: object) => { writeFileSync(resPath, JSON.stringify({ kind: 'cc-transfer-result/1', recordedAt: new Date().toISOString(), sourceSha256: reg.source.sha256, ...r }, null, 2), { flag: 'wx' }); console.log(JSON.stringify(r, null, 2)); };
  if (drift.length) { write({ status: 'REFUSED_DRIFT', drift }); process.exit(1); }
  const db = new DatabaseSync(process.argv[3] ?? join(root, '.artifacts/walkthrough/m3-live.db'), { readOnly: true });
  const row = db.prepare(`SELECT s.recipe_id, s.version_id, s.pack_hash, s.draft_id, s.release_json FROM saved_recipes s JOIN draft_sources ds ON ds.draft_id = s.draft_id JOIN sources src ON src.source_id = ds.source_id
    WHERE src.sha256 = ? AND ds.origin = 'UPLOAD' ORDER BY s.seq DESC LIMIT 1`).get(reg.source.serviceSourceKey) as Record<string, string> | undefined;
  if (!row) {   // a failed reading is the first outcome too: record it, never retry
    const job = db.prepare(`SELECT j.job_id, j.state, j.stages_json, j.failure_json FROM import_jobs j JOIN draft_sources ds ON ds.draft_id = j.draft_id JOIN sources src ON src.source_id = ds.source_id
      WHERE src.sha256 = ? AND ds.origin = 'UPLOAD' ORDER BY j.created_at LIMIT 1`).get(reg.source.serviceSourceKey) as Record<string, string> | undefined;
    if (job?.state === 'failed') { write({ status: 'IMPORT_FAILED', job: { id: job.job_id, stages: JSON.parse(job.stages_json), failure: JSON.parse(job.failure_json) } }); process.exit(0); }
    throw new Error('no saved version of the registered source in that database yet (import, review and save it in the companion first)');
  }
  const pack = JSON.parse((db.prepare('SELECT json FROM packs WHERE pack_hash = ?').get(row.pack_hash) as { json: string }).json) as RecipePack;
  const extractions = db.prepare('SELECT extractor, status, input_tokens, output_tokens, cost_usd FROM extractions WHERE draft_id = ?').all(row.draft_id);
  const facts = db.prepare('SELECT by, predicate, COUNT(*) AS n FROM facts WHERE draft_id = ? AND retired_at IS NULL GROUP BY by, predicate').all(row.draft_id);
  const r = pack.recipe, ord = (stepId: string) => r.steps.findIndex((s) => s.stepId === stepId) + 1;
  const ingName = (useId: string) => r.ingredients.find((i) => i.ingredientId === r.uses.find((u) => u.useId === useId)!.ingredientId)!.name;
  const bound = pack.bindings;
  const uses = r.uses.filter((u) => u.kind === 'ADD').map((u) => {
    const cov = pack.coverage.filter((c) => c.targetUseId === u.useId);
    const b = bound.find((x) => x.targetUseId === u.useId);
    const sib = bound.find((x) => x.coveredSiblingUseIds.includes(u.useId));
    const bucket = b ? (b.kind === 'RECOVERY' ? 'BOUND_AND_PLANNED' : 'BOUND_REFUSAL') : sib ? `COVERED_AS_SIBLING(${sib.patternId})`
      : cov.some((c) => c.status === 'NEEDS_FACTS') ? `NEEDS_FACTS(${cov.flatMap((c) => c.missing.map((m) => `${m.predicate}:${m.expected}`)).join('; ')})`
        : cov.length ? `NOT_APPLICABLE(${cov.map((c) => `${c.patternId}:${c.status}:${c.failedCheck?.code ?? ''}`).join('; ')})` : 'NO_PATTERN';
    return { use: u.useId, ingredient: ingName(u.useId), step: ord(u.stepId), bucket };
  });
  // frozen evaluation states over real MCP against the running live service (structured: no interpreter call)
  const client = new Client({ name: 'transfer-record', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.argv[4] ?? 8791}/mcp`)));
  const mcp = async (name: string, args: object) => (await client.callTool({ name, arguments: args as Record<string, unknown> })).structuredContent as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = () => crypto.randomUUID();
  const fresh = async (doneThrough: number) => {
    const act = (await mcp('get_active_recipe', {})).run;
    let run = (await mcp('start_recipe', { commandId: id(), recipeId: row.recipe_id, recipeVersionId: row.version_id, ...(act ? { replace: { runId: act.id, epoch: act.epoch, expectedRevision: act.revision, confirm: true } } : {}) })).run;
    for (const s of run.steps.slice(0, doneThrough)) run = (await mcp('record_progress', { commandId: id(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: s.stepId, progress: 'done' })).run;
    return run;
  };
  const evals: object[] = [];
  const scope = (run: { id: string; epoch: number; revision: number }) => ({ runId: run.id, epoch: run.epoch, expectedRevision: run.revision });
  if (row.release_json.includes('"eligible"')) {
    for (const b of bound) {
      const u = r.uses.find((x) => x.useId === b.targetUseId)!, n = ord(u.stepId);
      const proposed = b.kind === 'REFUSAL' ? (b.proposal as { classes: string[] }).classes.map((c) => content.vocab.kinds.find((k) => k.classes.includes(c))!.kindId) : [];
      let run = await fresh(n - 1);
      let e = await mcp('evaluate_rescue', { commandId: id(), ...scope(run), missingIngredientId: u.ingredientId, proposedKindIds: proposed });
      if (e.outcome === 'needsFacts') e = await mcp('evaluate_rescue', { commandId: id(), ...scope(run), previousEvaluationId: e.id, answers: e.questions.map((q: { id: string }) => ({ questionId: q.id, value: 'yes' })) });
      evals.push({ state: `${b.patternId} at step ${n}, steps 1–${n - 1} done`, outcome: e.outcome, refusal: e.refusal?.kind ?? null, headline: e.candidates?.[0]?.headline ?? null, consequence: e.candidates?.[0]?.consequence?.text ?? null, speech: e.speech?.text ?? null });
      if (b.kind === 'RECOVERY') {
        run = (await mcp('record_progress', { commandId: id(), ...scope(run), stepId: u.stepId, progress: 'started' })).run;
        const p = await mcp('evaluate_rescue', { commandId: id(), ...scope(run), missingIngredientId: u.ingredientId });
        evals.push({ state: `${b.patternId}, step ${n} started`, outcome: p.outcome, refusal: p.refusal?.kind ?? null });
      }
    }
    const none = uses.find((x) => x.bucket === 'NO_PATTERN' && x.step > 1);
    if (none) {
      const run = await fresh(none.step - 1);
      const u = r.uses.find((x) => x.useId === none.use)!;
      const e = await mcp('evaluate_rescue', { commandId: id(), ...scope(run), missingIngredientId: u.ingredientId });
      evals.push({ state: `${none.ingredient} (no rule) at step ${none.step}`, outcome: e.outcome, refusal: e.refusal?.kind ?? null });
    }
  }
  const noKind = r.ingredients.filter((i) => !i.kind).map((i) => i.name);   // no kind recorded (not proposed, or not in the frozen vocabulary)
  write({
    status: 'RECORDED', recipeId: row.recipe_id, versionId: row.version_id, release: JSON.parse(row.release_json), title: r.title,
    counts: { ingredients: r.ingredients.length, steps: r.steps.length, uses: uses.length, boundRecoveries: bound.filter((b) => b.kind === 'RECOVERY').length, boundRefusals: bound.filter((b) => b.kind === 'REFUSAL').length },
    uses, coverage: pack.coverage.map((c) => ({ patternId: c.patternId, target: c.targetUseId, status: c.status, failedCheck: c.failedCheck, missing: c.missing.length })),
    facts, extractions, ingredientsWithoutKind: noKind, evaluations: evals,
  });
  await client.close();
} else {
  console.log('usage: transfer.ts register <file> | record [db] [port]');
}
