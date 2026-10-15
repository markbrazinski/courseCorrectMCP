// Shared test helpers. Synthetic content here is SYNTHETIC SOFTWARE EVIDENCE, never culinary content.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Id, Pattern, RecipePack, RescueRequest, RunSnapshot, StepStatus, UseStatus, Vocabulary } from '../src/contract/types.ts';
import { compile } from '../src/compile/binder.ts';
import { expandRecipe, type RecipeSource } from '../src/domain/recipe.ts';
import { evaluate } from '../src/engine/evaluate.ts';
import { applyProgress } from '../src/engine/progress.ts';
import { Service } from '../src/service/commands.ts';
import type { Kv } from '../src/service/kv.ts';
import { DynamoKv } from '../src/service/kv-dynamo.ts';
import { SqliteKv } from '../src/service/kv-sqlite.ts';
import { loadContent } from '../src/service/content.ts';
import { recordedInterpreter, noneInterpreter } from '../src/service/interpret.ts';
import { RECORDED_INTENTS } from './fixtures/recorded-intents.ts';
import { ING } from './fixtures/ids.ts';

export const ROOT = join(import.meta.dirname, '..');
export const content = loadContent(join(ROOT, 'content/approved'));
export const vocab = content.vocab;
export const patterns = content.patterns;
export const source = (id: string) => readdirSync(join(ROOT, 'content/approved/recipes')).map((f) => JSON.parse(readFileSync(join(ROOT, 'content/approved/recipes', f), 'utf8')) as RecipeSource).find((r) => r.recipeId === id)!;
export const pack = (id: string) => content.packs.get(id)!;

/** Synthetic vocabulary additions (test-only content). */
export const synVocab: Vocabulary = structuredClone(vocab);
synVocab.classes.push({ classId: 'pearled-grain', label: 'pearled grain' });
synVocab.kinds.push(
  { kindId: 'mushroom-stock', label: 'mushroom stock', short: ING['stock'], aliases: [], classes: ['cooking-stock'] },
  { kindId: 'carnaroli-rice', label: 'carnaroli rice', short: ING['rice'], aliases: [], classes: ['risotto-rice'] },
  { kindId: 'pearl-barley', label: 'pearl barley', short: 'barley', aliases: [], classes: ['pearled-grain'] },
);

export function compileSource(src: RecipeSource, v: Vocabulary = vocab, ps: Pattern[] = patterns): RecipePack {
  const res = compile(expandRecipe(src), v, ps);
  if (!res.pack) throw new Error(res.errors.join('; '));
  return res.pack;
}

/** Snapshot after replaying progress through the same path the product uses. */
export function snapshotAfter(p: RecipePack, actions: { stepId: Id; progress: 'started' | 'partly' | 'done'; addedUseIds?: Id[]; partialUseIds?: Id[] }[], mode: 'COOK' | 'ENGINEERING' = 'ENGINEERING'): RunSnapshot {
  const r = p.recipe;
  let ss: Record<Id, StepStatus> = Object.fromEntries(r.steps.map((s) => [s.stepId, 'NOT_STARTED' as StepStatus]));
  let us: Record<Id, UseStatus> = Object.fromEntries(r.uses.map((u) => [u.useId, 'UNADDED' as UseStatus]));
  for (const a of actions) {
    const x = applyProgress(r, ss, us, a);
    if (!x.ok) throw new Error(`${a.stepId}: ${x.code}`);
    ss = x.stepStatus; us = x.useStatus;
  }
  return { runId: 'run-test', epoch: 1, packHash: p.packHash, mode, revision: actions.length, version: 1, appliedRescueCount: 0, recipe: r, stepStatus: ss, useStatus: us };
}
export const doneUpTo = (p: RecipePack, n: number) => p.recipe.steps.slice(0, n).map((s) => ({ stepId: s.stepId, progress: 'done' as const }));
export const fixtureActions = (id: string) => content.fixtures.get(id)!.actions;

export const req = (missing: Id | null, proposed: Id[] = [], answers: RescueRequest['answers'] = [], notices: RescueRequest['notices'] = []): RescueRequest =>
  ({ missingIngredientId: missing, proposedKindIds: proposed, answers, notices });

/** Evaluate, then answer every availability question "ENOUGH" and evaluate again. */
export function evaluateWithEnough(p: RecipePack, snap: RunSnapshot, missing: Id, proposed: Id[] = [], v: Vocabulary = vocab) {
  const first = evaluate(p, v, snap, req(missing, proposed));
  const answers = first.questions.map((q) => ({ questionId: q.questionId, choiceId: 'ENOUGH' as const }));
  return { first, second: evaluate(p, v, snap, req(missing, proposed, answers)) };
}

let n = 0, wsN = 0;
/** The store under test: a fresh SQLite file, or (CC_TEST_DYNAMO_ENDPOINT set, e.g. DynamoDB Local) one shared table where
 *  every test gets its own workspace partition, the isolation the deployed service relies on. */
export function newKv(dbPath?: string): Kv {
  const endpoint = process.env.CC_TEST_DYNAMO_ENDPOINT;
  return endpoint ? new DynamoKv(process.env.CC_TEST_DYNAMO_TABLE ?? 'cc-test', { endpoint, region: 'us-east-1' }) : new SqliteKv(dbPath ?? join(mkdtempSync(join(tmpdir(), 'ccmcp-')), 'test.kv'));
}
export const newWs = () => `t${process.pid}_${Date.now().toString(36)}_${++wsN}`;
export function newService(opts: { recorded?: boolean; dbPath?: string; kv?: Kv; ws?: string; now?: () => string } = {}) {
  const dbPath = opts.dbPath ?? join(mkdtempSync(join(tmpdir(), 'ccmcp-')), 'test.kv');
  const kv = opts.kv ?? newKv(dbPath), ws = opts.ws ?? newWs();
  let i = 0;
  const svc = new Service({
    kv, ws, content, interpreter: opts.recorded === false ? noneInterpreter : recordedInterpreter(RECORDED_INTENTS),
    now: opts.now ?? (() => `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z`), newId: (p) => `${p}_${++n}_${++i}`,
  });
  return { svc, dbPath, kv, ws };
}
let c = 0;
export const cmd = () => `cmd-${++c}`;

/** Start the named recipe and replay a fixture through record_progress (the product path). */
export async function startAt(svc: Service, recipeId: string, fixtureId: string | null) {
  const p = pack(recipeId);
  const started = await svc.startRecipe({ commandId: cmd(), recipeId, recipeVersionId: p.recipeHash });
  if (started.outcome !== 'started') throw new Error(`start: ${JSON.stringify(started)}`);
  let run = started.run;
  for (const a of fixtureId ? fixtureActions(fixtureId) : []) {
    const r = await svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, ...a });
    if (r.outcome !== 'recorded') throw new Error(`progress: ${JSON.stringify(r)}`);
    run = r.run;
  }
  return run;
}
