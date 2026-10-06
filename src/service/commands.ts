// Tool semantics, receipts, fencing and transactions (ESOD §7, §8.2). Thin over the pure engine.
import { randomUUID } from 'node:crypto';
import { MAX_CHANGES_PER_RUN } from '../contract/types.ts';
import type { EvaluationResult, Id, Recipe, RecipePack, RescueRequest, RunSnapshot, StepStatus, UseStatus } from '../contract/types.ts';
import { hash } from '../domain/rational.ts';
import { currentStepId, getStep, renderStep } from '../domain/recipe.ts';
import { evaluate } from '../engine/evaluate.ts';
import { applyProgress, type ProgressAction } from '../engine/progress.ts';
import {
  contentLabel, coverageSummary, progressOf, recipeContent, rescueEvaluation, type RecipeBookEntry, type RecipeContent, type RescueEvaluation, type WireAmendment, type WireRun,
} from '../contract/project.ts';
import type { Authoring } from '../authoring/drafts.ts';
import type { Content } from './content.ts';
import { refusalWhy } from '../contract/why.ts';
import { explain, noneExplainer, type Explainer } from './explain.ts';
import { noticesOf, type Interpreter } from './interpret.ts';
import { Store, type Row } from './store.ts';

/** Saved imported recipes (from authoring): latest version per recipe, with engine-computed eligibility. */
export interface CatalogEntry { recipeId: Id; pack: RecipePack | null; release: RecipeBookEntry['release']; title: string; meta: string; sourceLabel: string; versionId?: string }
export interface ServiceOptions {
  dbPath: string; content: Content; interpreter: Interpreter; explainer?: Explainer; catalog?: () => CatalogEntry[];
  /** List the hand-authored approved recipes in the Recipe Book (test fixtures since the demo recipes come through import). */
  fixtureRecipes?: boolean;
  kitchenId?: string; now?: () => string; newId?: (prefix: string) => string;
}
export type Rejected = { outcome: 'rejected'; code: string; message: string; run: WireRun | null; activeRun?: { runId: Id; recipeTitle: string } };
type Replayable<T> = (T | Rejected) & { replayed?: true };

interface RunRow {
  run_id: string; kitchen_id: string; recipe_id: string; pack_hash: string; epoch: number; mode: 'COOK' | 'ENGINEERING'; status: 'ACTIVE' | 'FINISHED' | 'ARCHIVED';
  revision: number; version: number; applied_rescue_count: number; latest_evaluation_id: string | null; step_status: string; use_status: string;
}
interface EvalRow { evaluation_id: string; run_id: string; base_revision: number; version: number; state: string; request_json: string; result_json: string | null; interpretation: string | null }
interface StoredRequest { request: RescueRequest; utterance: { text: string; channel: string } | null }

const MESSAGES: Record<string, string> = {
  INVALID_COMMAND: 'This request is missing a required field (commandId, epoch or expectedRevision).',
  COMMAND_ID_REUSE: 'That command ID was already used for a different request.',
  IN_PROGRESS: 'That request is still being processed.',
  INTERRUPTED: 'That request was interrupted before it finished. Check the recipe, then try again with a new request.',
  RUN_NOT_FOUND: 'No cooking session with that ID.',
  RUN_ENDED: 'That cooking session has ended.',
  RUN_EXPIRED: 'That cooking session was reset.',
  STALE_STATE: 'Your progress changed since this was sent. Check again.',
  RECIPE_NOT_FOUND: 'No saved recipe with that ID.',
  NOT_ELIGIBLE: "This recipe can't be started yet.",
  VERSION_MISMATCH: 'That recipe version is not the current one.',
  ACTIVE_RUN_EXISTS: 'Another recipe is being cooked. Resume it, or confirm ending it to start this one.',
  REPLACE_NOT_CONFIRMED: 'Ending the other cooking session needs explicit confirmation.',
  REGRESSION: "Progress can't move backwards.",
  UNKNOWN_STEP: 'That step is not in this recipe.',
  UNKNOWN_USE: 'That ingredient is not used in this step.',
  STEP_BLOCKED: 'An earlier step is not done yet.',
  PARTIAL_USE_REQUIRES_ADDED: 'Report the partly added ingredient as added before marking the step done.',
  ACCEPTANCE_REQUIRED: 'Applying a change needs explicit acceptance.',
  NOT_LATEST_EVALUATION: 'A newer check replaced this proposal. Check again.',
  NOT_ACTIONABLE: 'This proposal can no longer be applied. Check again.',
  PLAN_MISMATCH: "That isn't the change that was shown. Check again.",
  PLAN_CHANGED: 'The change no longer matches your recipe. Check again.',
  SUCCESSIVE_RESCUE_UNSUPPORTED: `This cooking session already used its ${MAX_CHANGES_PER_RUN} changes.`,
  RECIPE_IN_USE: 'This recipe is being cooked. Finish or end that cooking session before removing it from the Recipe Book.',
  IMPORT_UNAVAILABLE: 'Importing is not available on this server.',
  INTERNAL: 'Something went wrong; nothing was changed.',
};

export class Service {
  readonly store: Store;
  readonly content: Content;
  readonly interpreter: Interpreter;
  readonly explainer: Explainer;
  readonly kitchenId: string;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly packs = new Map<string, RecipePack>();
  private readonly fixtureRecipes: boolean;
  catalog: () => CatalogEntry[];

  constructor(o: ServiceOptions) {
    this.store = new Store(o.dbPath);
    this.content = o.content;
    this.interpreter = o.interpreter;
    this.explainer = o.explainer ?? noneExplainer;
    this.kitchenId = o.kitchenId ?? 'kitchen';
    this.now = o.now ?? (() => new Date().toISOString());
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.catalog = o.catalog ?? (() => []);
    this.fixtureRecipes = o.fixtureRecipes ?? true;
    this.store.tx(() => {
      this.store.run('INSERT OR IGNORE INTO kitchens(kitchen_id, epoch) VALUES (?, 1)', this.kitchenId);
      for (const p of o.content.packs.values()) this.store.run('INSERT OR IGNORE INTO packs(pack_hash, recipe_id, json) VALUES (?, ?, ?)', p.packHash, p.recipe.recipeId, JSON.stringify(p));
      // startup recovery: never auto-retry; PENDING becomes INTERRUPTED
      this.store.run(`UPDATE receipts SET state = 'INTERRUPTED' WHERE state = 'PENDING'`);
      this.store.run(`UPDATE evaluations SET state = 'INTERRUPTED' WHERE state = 'PENDING'`);
    });
  }

  // ---------- helpers ----------
  private epoch() { return this.store.get<{ epoch: number }>('SELECT epoch FROM kitchens WHERE kitchen_id = ?', this.kitchenId)!.epoch; }
  private pack(hashId: string): RecipePack {
    let p = this.packs.get(hashId);
    if (!p) { p = JSON.parse(this.store.get<{ json: string }>('SELECT json FROM packs WHERE pack_hash = ?', hashId)!.json) as RecipePack; this.packs.set(hashId, p); }
    return p;
  }
  private runRow(runId: string) { return this.store.get<RunRow>('SELECT * FROM runs WHERE run_id = ?', runId); }
  private activeRow() { return this.store.get<RunRow>(`SELECT * FROM runs WHERE kitchen_id = ? AND status = 'ACTIVE'`, this.kitchenId); }
  private recipeAt(runId: string, version: number): Recipe {
    return JSON.parse(this.store.get<{ recipe_json: string }>('SELECT recipe_json FROM run_versions WHERE run_id = ? AND version = ?', runId, version)!.recipe_json) as Recipe;
  }
  private snapshot(row: RunRow): RunSnapshot {
    return {
      runId: row.run_id, epoch: row.epoch, packHash: row.pack_hash, mode: row.mode, revision: row.revision, version: row.version,
      appliedRescueCount: row.applied_rescue_count, recipe: this.recipeAt(row.run_id, row.version),
      stepStatus: JSON.parse(row.step_status) as Record<Id, StepStatus>, useStatus: JSON.parse(row.use_status) as Record<Id, UseStatus>,
    };
  }
  private amendmentsOf(runId: string) { return this.store.all<Row>('SELECT * FROM amendments WHERE run_id = ? ORDER BY to_version', runId); }

  wireRun(row: RunRow): WireRun {
    const snap = this.snapshot(row), v1 = this.recipeAt(row.run_id, 1), ams = this.amendmentsOf(row.run_id);
    const changedBy = (stepId: Id) => [...ams].reverse().find((a) => (JSON.parse(a.changed_step_ids as string) as Id[]).includes(stepId));
    const pack = this.pack(row.pack_hash);
    return {
      id: row.run_id, recipeId: row.recipe_id, recipeVersionId: pack.recipeHash, epoch: row.epoch, revision: row.revision, version: row.version,
      state: row.status === 'ACTIVE' ? 'active' : 'ended', mode: row.mode,
      contentLabel: contentLabel(row.mode, pack.bindings.some((b) => b.quantityStatus === 'PROVISIONAL' && !b.card)),
      steps: snap.recipe.steps.map((s) => {
        const orig = getStep(v1, s.stepId);
        const eff = renderStep(snap.recipe, s), was = orig ? renderStep(v1, orig) : null;
        const progress = progressOf(snap.recipe, s.stepId, snap.stepStatus, snap.useStatus);
        return {
          stepId: s.stepId, progress, effectiveText: eff, originalText: was !== null && was !== eff ? was : null,
          partialUseIds: progress === 'partly' ? snap.recipe.uses.filter((u) => u.stepId === s.stepId && (snap.useStatus[u.useId] ?? 'UNADDED') !== 'UNADDED').map((u) => u.useId) : [],
          changedByAmendmentId: (changedBy(s.stepId)?.amendment_id as string | undefined) ?? null, onHold: null,
        };
      }),
      currentStepId: currentStepId(snap.recipe, snap.stepStatus),
      appliedAmendments: ams.map((a) => this.wireAmendment(a)), pendingCommand: null,
    };
  }
  private wireAmendment(am: Row): WireAmendment {
    return { id: am.amendment_id as string, commandId: am.command_id as string, candidateId: am.candidate_id as string, planId: am.plan_hash as string,
      changedStepIds: JSON.parse(am.changed_step_ids as string) as Id[], appliedAtRunRevision: am.revision_after as number, fromVersion: am.from_version as number, toVersion: am.to_version as number };
  }
  private reject(code: string, row?: RunRow | null, message?: string): Rejected {
    return { outcome: 'rejected', code, message: message ?? MESSAGES[code] ?? code, run: row ? this.wireRun(this.runRow(row.run_id)!) : null };
  }
  private digest(tool: string, input: object) { const { commandId: _c, ...rest } = input as Record<string, unknown>; return hash({ tool, input: rest }); }

  /** Receipt lookup. Returns a stored result to replay, a rejection, or null to proceed (inside the caller's transaction). */
  private receiptGate<T>(tool: string, input: object): Replayable<T> | null {
    const commandId = (input as { commandId?: unknown }).commandId;
    if (typeof commandId !== 'string' || !commandId) return this.reject('INVALID_COMMAND') as Replayable<T>;
    const rc = this.store.get<{ tool: string; payload_digest: string; state: string; result_json: string | null }>(
      'SELECT tool, payload_digest, state, result_json FROM receipts WHERE kitchen_id = ? AND command_id = ?', this.kitchenId, commandId);
    if (!rc) return null;
    if (rc.payload_digest !== this.digest(tool, input)) return this.reject('COMMAND_ID_REUSE') as Replayable<T>;
    if (rc.state === 'PENDING') return this.reject('IN_PROGRESS') as Replayable<T>;
    if (rc.state === 'INTERRUPTED') return this.reject('INTERRUPTED') as Replayable<T>;
    const stored = JSON.parse(rc.result_json!) as T & { outcome?: string };
    return { ...stored, ...(stored.outcome === 'applied' ? { outcome: 'alreadyApplied' } : {}), replayed: true } as Replayable<T>;
  }
  private writeReceipt(tool: string, input: object, runId: string | null, state: 'PENDING' | 'DONE', result: unknown) {
    this.store.run(`INSERT INTO receipts(kitchen_id, command_id, tool, run_id, payload_digest, state, result_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kitchen_id, command_id) DO UPDATE SET state = excluded.state, result_json = excluded.result_json`,
      this.kitchenId, (input as { commandId: string }).commandId, tool, runId, this.digest(tool, input), state, result === null ? null : JSON.stringify(result), this.now());
  }
  /** Run checks shared by run-scoped mutations. */
  private checkRun(input: { runId?: string; epoch?: number }): RunRow | Rejected {
    if (typeof input.runId !== 'string' || typeof input.epoch !== 'number') return this.reject('INVALID_COMMAND');
    const row = this.runRow(input.runId);
    if (!row) return this.reject('RUN_NOT_FOUND');
    if (row.status === 'ARCHIVED' || row.epoch !== input.epoch || row.epoch !== this.epoch()) return this.reject('RUN_EXPIRED', row);
    if (row.status === 'FINISHED') return this.reject('RUN_ENDED', row);
    return row;
  }

  // ---------- list_recipes ----------
  /** Approved engineering content (eligible) plus saved imports (eligibility computed at save). Never drafts. */
  private entries(): CatalogEntry[] {
    const archived = new Set(this.store.all<{ recipe_id: string }>('SELECT recipe_id FROM archived_recipes').map((r) => r.recipe_id));
    return [
      ...[...this.content.packs.values()].filter(() => this.fixtureRecipes).map((p) => ({ recipeId: p.recipe.recipeId, pack: p as RecipePack | null, release: { kind: 'eligible' as const, coverageSummary: '' }, title: p.recipe.title, meta: p.recipe.meta, sourceLabel: p.recipe.source?.label ?? '' })),
      ...this.catalog(),
    ].filter((e) => !archived.has(e.recipeId));
  }
  listRecipes(): { recipes: RecipeBookEntry[] } {
    const active = this.activeRow();
    return {
      recipes: this.entries().map((e) => {
        const p = e.pack;
        if (!p || e.release.kind === 'ineligible') {
          return { recipeId: e.recipeId, currentVersionId: p?.recipeHash ?? e.versionId ?? '', title: e.title, meta: e.meta, sourceLabel: e.sourceLabel, release: e.release, activeRunId: null };
        }
        return {
          recipeId: p.recipe.recipeId, currentVersionId: p.recipeHash, title: p.recipe.title, meta: p.recipe.meta, sourceLabel: e.sourceLabel,
          release: { kind: 'eligible' as const, coverageSummary: coverageSummary(p) },
          activeRunId: active && active.recipe_id === p.recipe.recipeId ? active.run_id : null,
        };
      }),
    };
  }

  /** Approved content as a recipe page (GET /recipes/:id for recipes that are not imports). */
  approvedRecipe(recipeId: string) {
    const p = this.fixtureRecipes ? this.content.packs.get(recipeId) : undefined;
    if (!p) return null;
    return { version: { id: p.recipeHash, recipeId, createdFromDraft: null, content: recipeContent(p.recipe, this.content.vocab, p, p.recipe, this.content.patterns), release: this.listRecipes().recipes.find((r) => r.recipeId === recipeId)!.release }, sources: [] };
  }

  // ---------- start_recipe (C-3: explicit, confirmed, atomic replacement) ----------
  startRecipe(input: { commandId?: string; recipeId: string; recipeVersionId?: string; replace?: { runId: string; epoch: number; expectedRevision: number; confirm: boolean } }) {
    type Started = { outcome: 'started'; run: WireRun; recipe: RecipeContent };
    return this.store.tx((): Replayable<Started> => {
      const gate = this.receiptGate<Started>('start_recipe', input);
      if (gate) return gate;
      const done = (res: Started | Rejected, runId: string | null) => { this.writeReceipt('start_recipe', input, runId, 'DONE', res); return res; };
      const entry = this.entries().find((e) => e.recipeId === input.recipeId);
      if (!entry) return done(this.reject('RECIPE_NOT_FOUND'), null);
      if (!entry.pack || entry.release.kind === 'ineligible') {
        return done(this.reject('NOT_ELIGIBLE', null, entry.release.kind === 'ineligible' ? entry.release.reasons.map((r) => r.message).join(' ') : undefined), null);
      }
      const pack = entry.pack;
      if (input.recipeVersionId && input.recipeVersionId !== pack.recipeHash) return done(this.reject('VERSION_MISMATCH'), null);
      const active = this.activeRow();
      if (active) {
        const rp = input.replace;
        if (!rp) return done({ ...this.reject('ACTIVE_RUN_EXISTS', active), activeRun: { runId: active.run_id, recipeTitle: this.pack(active.pack_hash).recipe.title } }, null);
        if (rp.confirm !== true) return done(this.reject('REPLACE_NOT_CONFIRMED', active), null);
        if (rp.runId !== active.run_id || rp.epoch !== active.epoch) return done(this.reject('RUN_EXPIRED', active), null);
        if (rp.expectedRevision !== active.revision) return done(this.reject('STALE_STATE', active), null);
        this.store.run(`UPDATE runs SET status = 'ARCHIVED' WHERE run_id = ?`, active.run_id);   // history preserved
      }
      const row = this.createRun(pack);
      return done({ outcome: 'started', run: this.wireRun(row), recipe: recipeContent(pack.recipe, this.content.vocab, pack, pack.recipe, this.content.patterns) }, row.run_id);
    });
  }
  private createRun(pack: RecipePack): RunRow {
    const runId = this.newId('run'), r = pack.recipe;
    const ss = Object.fromEntries(r.steps.map((s) => [s.stepId, 'NOT_STARTED'])), us = Object.fromEntries(r.uses.map((u) => [u.useId, 'UNADDED']));
    // ponytail: no release records in M1, so every run is ENGINEERING; COOK fails closed in the engine (B11).
    this.store.run(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, 'ENGINEERING', 'ACTIVE', 0, 1, 0, NULL, ?, ?, ?)`,
      runId, this.kitchenId, r.recipeId, pack.packHash, this.epoch(), JSON.stringify(ss), JSON.stringify(us), this.now());
    this.store.run('INSERT INTO run_versions VALUES (?, 1, ?, ?)', runId, JSON.stringify(r), hash(r));
    return this.runRow(runId)!;
  }

  // ---------- get_active_recipe (read-only; the reconciliation read) ----------
  getActiveRecipe(input: { runId?: string; commandId?: string; evaluationId?: string } = {}) {
    const row = this.activeRow();
    const out: {
      run: WireRun | null; recipe: RecipeContent | null; latestEvaluation: RescueEvaluation | null;
      command?: { commandId: Id; receipt: 'NONE' | 'PENDING' | 'DONE' | 'INTERRUPTED'; code: string | null; status: 'applied' | 'appliedOther' | 'notApplied' | 'unknown' | 'runReplaced'; amendmentId?: Id };
    } = { run: null, recipe: null, latestEvaluation: null };
    if (row) {
      const pack = this.pack(row.pack_hash);
      out.run = this.wireRun(row);
      out.recipe = recipeContent(this.recipeAt(row.run_id, row.version), this.content.vocab, pack, this.recipeAt(row.run_id, 1), this.content.patterns);
      out.latestEvaluation = row.latest_evaluation_id ? this.wireEvaluation(row.latest_evaluation_id) : null;
    }
    if (input.commandId) out.command = this.commandOutcome(input.commandId, input.runId, input.evaluationId);
    return out;
  }

  /**
   * ESOD §4.2h: RUN_REPLACED → APPLIED_THIS → APPLIED_OTHER → NOT_APPLIED (authoritative only) → UNKNOWN.
   * With several changes per run (ENGINE_SEMANTICS 2), APPLIED_OTHER means the same evaluation was applied by another command.
   */
  commandOutcome(commandId: string, runId?: string, evaluationId?: string) {
    const rc = this.store.get<{ run_id: string | null; state: string; result_json: string | null }>('SELECT run_id, state, result_json FROM receipts WHERE kitchen_id = ? AND command_id = ?', this.kitchenId, commandId);
    const receipt = (rc?.state ?? 'NONE') as 'NONE' | 'PENDING' | 'DONE' | 'INTERRUPTED';
    const code = rc?.result_json ? ((JSON.parse(rc.result_json) as { outcome?: string; code?: string }).code ?? (JSON.parse(rc.result_json) as { outcome?: string }).outcome?.toUpperCase() ?? null) : null;
    const base = { commandId, receipt, code };
    const cmdRun = rc?.run_id ?? runId;
    const run = cmdRun ? this.runRow(cmdRun) : undefined;
    if (run && (run.status === 'ARCHIVED' || run.epoch !== this.epoch())) return { ...base, status: 'runReplaced' as const };
    const mine = this.store.get<Row>('SELECT amendment_id FROM amendments WHERE command_id = ?', commandId);
    if (mine) return { ...base, status: 'applied' as const, amendmentId: mine.amendment_id as string };
    const other = evaluationId ? this.store.get<Row>('SELECT amendment_id FROM amendments WHERE evaluation_id = ? AND command_id <> ?', evaluationId, commandId) : undefined;
    if (other) return { ...base, status: 'appliedOther' as const, amendmentId: other.amendment_id as string };
    if (receipt === 'DONE' || receipt === 'INTERRUPTED') return { ...base, status: 'notApplied' as const };
    return { ...base, status: 'unknown' as const };
  }

  // ---------- record_progress ----------
  recordProgress(input: { commandId?: string; runId: string; epoch: number; expectedRevision?: number } & ProgressAction) {
    type Recorded = { outcome: 'recorded'; code: 'PROGRESS_RECORDED' | 'ALREADY_RECORDED'; run: WireRun };
    return this.store.tx((): Replayable<Recorded> => {
      const gate = this.receiptGate<Recorded>('record_progress', input);
      if (gate) return gate;
      const done = (res: Recorded | Rejected) => { this.writeReceipt('record_progress', input, input.runId ?? null, 'DONE', res); return res; };
      if (typeof input.expectedRevision !== 'number') return done(this.reject('INVALID_COMMAND'));
      const row = this.checkRun(input);
      if ('outcome' in row) return done(row);
      if (row.revision !== input.expectedRevision) return done(this.reject('STALE_STATE', row));
      const snap = this.snapshot(row);
      const res = applyProgress(snap.recipe, snap.stepStatus, snap.useStatus, input);
      if (!res.ok) return done(this.reject(res.code, row));
      if (!res.changed) return done({ outcome: 'recorded', code: 'ALREADY_RECORDED', run: this.wireRun(row) });
      this.commitProgress(row, res.stepStatus, res.useStatus, input);
      return done({ outcome: 'recorded', code: 'PROGRESS_RECORDED', run: this.wireRun(this.runRow(row.run_id)!) });
    });
  }
  private commitProgress(row: RunRow, ss: Record<Id, StepStatus>, us: Record<Id, UseStatus>, a: ProgressAction) {
    const recipe = this.recipeAt(row.run_id, row.version);
    const finished = recipe.steps.every((s) => ss[s.stepId] === 'COMPLETED');
    const seq = (this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM progress_events WHERE run_id = ?', row.run_id)!.n) + 1;
    this.store.run('UPDATE runs SET step_status = ?, use_status = ?, revision = revision + 1, status = ? WHERE run_id = ?',
      JSON.stringify(ss), JSON.stringify(us), finished ? 'FINISHED' : 'ACTIVE', row.run_id);
    this.store.run('INSERT INTO progress_events VALUES (?, ?, ?, ?, ?)', row.run_id, seq,
      JSON.stringify({ stepId: a.stepId, progress: a.progress, addedUseIds: a.addedUseIds ?? [], partialUseIds: a.partialUseIds ?? [] }), row.revision + 1, this.now());
  }

  // ---------- evaluate_rescue (reserve → compute → publish) ----------
  async evaluateRescue(input: {
    commandId?: string; runId: string; epoch: number; expectedRevision?: number;
    utterance?: { text: string; channel: 'voice' | 'typed' | 'tapped' }; missingIngredientId?: string; proposedKindIds?: string[];
    answers?: { questionId: string; value: 'yes' | 'no' }[]; previousEvaluationId?: string;
  }): Promise<Replayable<RescueEvaluation>> {
    const reserved = this.store.tx((): Replayable<RescueEvaluation> | { row: RunRow; evaluationId: string } => {
      const gate = this.receiptGate<RescueEvaluation>('evaluate_rescue', input);
      if (gate) return gate;
      const fail = (r: Rejected) => { this.writeReceipt('evaluate_rescue', input, input.runId ?? null, 'DONE', r); return r; };
      if (typeof input.expectedRevision !== 'number') return fail(this.reject('INVALID_COMMAND'));
      const row = this.checkRun(input);
      if ('outcome' in row) return fail(row);
      if (row.revision !== input.expectedRevision) return fail(this.reject('STALE_STATE', row));
      const evaluationId = this.newId('ev');
      this.writeReceipt('evaluate_rescue', input, row.run_id, 'PENDING', null);
      this.store.run(`UPDATE evaluations SET state = 'SUPERSEDED' WHERE run_id = ? AND state = 'PENDING'`, row.run_id);
      this.store.run(`INSERT INTO evaluations(evaluation_id, run_id, base_revision, version, state, request_json, at) VALUES (?, ?, ?, ?, 'PENDING', '{}', ?)`,
        evaluationId, row.run_id, row.revision, row.version, this.now());
      return { row, evaluationId };
    });
    if (!('evaluationId' in reserved)) return reserved;
    const { row, evaluationId } = reserved;
    const snap = this.snapshot(row);
    const pack = this.pack(row.pack_hash);

    // compute (outside any transaction; at most one interpreter call)
    let stored: StoredRequest | null = null;
    if (input.previousEvaluationId) {
      const prev = this.store.get<EvalRow>('SELECT * FROM evaluations WHERE evaluation_id = ? AND run_id = ?', input.previousEvaluationId, row.run_id);
      if (prev && prev.request_json !== '{}') stored = JSON.parse(prev.request_json) as StoredRequest;
    }
    let missing = input.missingIngredientId ?? null, proposed = input.proposedKindIds ?? null, interpretation: string | null = null;
    const notices: RescueRequest['notices'] = [];
    if (!missing && input.utterance?.text) {
      const ctx = {
        ingredients: snap.recipe.ingredients.map((i) => ({ id: i.ingredientId, name: i.name })),
        kinds: this.content.vocab.kinds.map((k) => ({ id: k.kindId, label: k.label, aliases: k.aliases })),
      };
      const out = await this.interpreter.interpret(input.utterance.text, ctx);
      interpretation = out.summary;
      if (out.ok) { missing = out.intent.missingIngredientId; proposed ??= out.intent.proposedKindIds; notices.push(...noticesOf(out.intent)); }
    } else if (!missing && stored) {
      missing = stored.request.missingIngredientId; proposed ??= stored.request.proposedKindIds; interpretation = 're-check of a previous request (no interpreter call)';
    } else if (missing) {
      if (stored) proposed ??= stored.request.proposedKindIds;   // "Not this ingredient": the corrected reference keeps what was asked about
      interpretation = `${input.utterance?.channel === 'tapped' ? 'tapped' : 'structured'}: missing = ${missing}`;
    }
    const request: RescueRequest = {
      missingIngredientId: missing, proposedKindIds: proposed ?? [], notices,
      answers: (input.answers ?? []).map((a) => ({ questionId: a.questionId, choiceId: a.value === 'yes' ? 'ENOUGH' : 'NOT_ENOUGH' })),
    };
    let res: EvaluationResult | null = null, error: string | null = null;
    try { res = evaluate(pack, this.content.vocab, snap, request, false); } catch (e) { error = (e as Error).message; }
    // a refusal says why: engine facts first, then (at most one call) words for them, checked; the decision never changes
    let explained: Parameters<typeof rescueEvaluation>[0]['explained'];
    if (res?.status === 'REFUSED' && res.refusal) {
      const why = refusalWhy({ pack, patterns: this.content.patterns, v: this.content.vocab }, res, request.proposedKindIds);
      const said = await explain(this.explainer, input.utterance?.channel === 'tapped' ? null : input.utterance?.text ?? null, why, this.content.vocab);
      explained = { why, answer: { text: said.text, source: said.source }, note: `${said.source}${said.rejected ? ` (${this.explainer.mode} answer not used: ${said.rejected})` : ''}` };
    }

    // publish
    return this.store.tx(() => {
      const now = this.runRow(row.run_id)!;
      const newer = this.store.get<Row>(`SELECT evaluation_id FROM evaluations WHERE run_id = ? AND rowid > (SELECT rowid FROM evaluations WHERE evaluation_id = ?)`, row.run_id, evaluationId);
      let state = 'PUBLISHED';
      if (error || !res) state = 'FAILED';
      else if (now.status !== 'ACTIVE' || now.epoch !== row.epoch) state = 'INTERRUPTED';
      else if (now.revision !== row.revision) state = 'STALE';
      else if (newer) state = 'SUPERSEDED';
      if (state === 'FAILED') {
        const r = this.reject('INTERNAL', now, `${MESSAGES.INTERNAL} (${error})`);
        this.store.run(`UPDATE evaluations SET state = 'FAILED', request_json = ? WHERE evaluation_id = ?`, JSON.stringify({ request, utterance: input.utterance ?? null }), evaluationId);
        this.writeReceipt('evaluate_rescue', input, row.run_id, 'DONE', r);
        return r as Replayable<RescueEvaluation>;
      }
      const actionable = state === 'PUBLISHED' && res!.status === 'CANDIDATES';
      const wire = rescueEvaluation({ evaluationId, runId: row.run_id, baseRevision: row.revision, actionable, res: res!, snapRecipe: snap.recipe, v: this.content.vocab, stepStatus: snap.stepStatus, mode: row.mode, interpretationSummary: interpretation, explained });
      this.store.run('UPDATE evaluations SET state = ?, request_json = ?, result_json = ?, interpretation = ? WHERE evaluation_id = ?',
        state, JSON.stringify({ request, utterance: input.utterance ?? null } satisfies StoredRequest), JSON.stringify({ engine: res, wire }), interpretation, evaluationId);
      if (state === 'PUBLISHED') this.store.run('UPDATE runs SET latest_evaluation_id = ? WHERE run_id = ?', evaluationId, row.run_id);
      this.writeReceipt('evaluate_rescue', input, row.run_id, 'DONE', wire);
      return wire;
    });
  }

  /** Stored evaluation with `actionable` recomputed against the current run (never trusts an old flag). */
  wireEvaluation(evaluationId: string): RescueEvaluation | null {
    const ev = this.store.get<EvalRow>('SELECT * FROM evaluations WHERE evaluation_id = ?', evaluationId);
    if (!ev?.result_json) return null;
    const run = this.runRow(ev.run_id)!;
    const { wire } = JSON.parse(ev.result_json) as { wire: RescueEvaluation };
    const actionable = ev.state === 'PUBLISHED' && run.status === 'ACTIVE' && run.latest_evaluation_id === evaluationId
      && run.revision === ev.base_revision && run.applied_rescue_count < MAX_CHANGES_PER_RUN && wire.outcome === 'proposal';
    if (wire.outcome === 'proposal') {
      wire.candidates = wire.candidates.map((c) => ({ ...c, applicable: actionable ? { kind: 'yes' } : { kind: 'no', reason: 'stale', message: 'Your progress changed since this was checked. Check again.' } }));
    }
    return { ...wire, actionable };
  }

  /**
   * Text the speech route may read aloud: only what this service rendered (an evaluation's authored speech, or a step).
   * "Change applied." is said only for an amendment this run actually holds, so it is never spoken before the server confirms.
   */
  speechText(ref: { evaluationId?: string; runId?: string; stepId?: string; amendmentId?: string; next?: boolean }): string | null {
    if (ref.evaluationId) return this.wireEvaluation(ref.evaluationId)?.speech.text ?? null;
    const row = ref.runId ? this.runRow(ref.runId) : undefined;
    if (!row || !ref.stepId) return null;
    if (ref.amendmentId && !this.store.get('SELECT 1 FROM amendments WHERE amendment_id = ? AND run_id = ?', ref.amendmentId, row.run_id)) return null;
    const steps = this.wireRun(row).steps, i = steps.findIndex((s) => s.stepId === ref.stepId);
    return i < 0 ? null : `${ref.amendmentId ? 'Change applied. ' : ref.next ? 'Next: ' : ''}Step ${i + 1}. ${steps[i].effectiveText}`;
  }

  // ---------- apply_amendment (one BEGIN IMMEDIATE transaction; receipt committed with the amendment) ----------
  applyAmendment(input: { commandId?: string; runId: string; epoch: number; expectedRevision?: number; evaluationId: string; candidateId: string; planId: string; accepted?: boolean }) {
    type Applied = { outcome: 'applied'; amendment: WireAmendment; run: WireRun; resume: { stepId: Id; text: string } };
    return this.store.tx((): Replayable<Applied> => {
      const gate = this.receiptGate<Applied>('apply_amendment', input);
      if (gate) return gate;
      const done = (res: Applied | Rejected) => { this.writeReceipt('apply_amendment', input, input.runId ?? null, 'DONE', res); return res; };
      if (typeof input.expectedRevision !== 'number') return done(this.reject('INVALID_COMMAND'));
      if (input.accepted !== true) return done(this.reject('ACCEPTANCE_REQUIRED'));
      const row = this.checkRun(input);
      if ('outcome' in row) return done(row);
      if (row.revision !== input.expectedRevision) return done(this.reject('STALE_STATE', row));
      const ev = this.store.get<EvalRow>('SELECT * FROM evaluations WHERE evaluation_id = ?', input.evaluationId);
      if (!ev || ev.run_id !== row.run_id || row.latest_evaluation_id !== ev.evaluation_id) return done(this.reject('NOT_LATEST_EVALUATION', row));
      const stored = JSON.parse(ev.result_json!) as { engine: EvaluationResult };
      if (ev.state !== 'PUBLISHED' || stored.engine.status !== 'CANDIDATES') return done(this.reject('NOT_ACTIONABLE', row));
      if (ev.base_revision !== row.revision) return done(this.reject('STALE_STATE', row));
      if (row.applied_rescue_count >= MAX_CHANGES_PER_RUN) return done(this.reject('SUCCESSIVE_RESCUE_UNSUPPORTED', row));
      const shown = stored.engine.candidates.find((c) => c.candidateId === input.candidateId);
      if (!shown || shown.planHash !== input.planId) return done(this.reject('PLAN_MISMATCH', row));
      // re-evaluate on the current snapshot with the stored request; never apply a stale plan
      const snap = this.snapshot(row);
      const { request } = JSON.parse(ev.request_json) as StoredRequest;
      const again = evaluate(this.pack(row.pack_hash), this.content.vocab, snap, request, false);
      const fresh = again.status === 'CANDIDATES' ? again.candidates.find((c) => c.candidateId === input.candidateId) : undefined;
      if (!fresh || fresh.planHash !== shown.planHash) return done(this.reject('PLAN_CHANGED', row));
      const amendmentId = this.newId('am');
      const changed = fresh.changes.filter((c) => c.kind !== 'UNCHANGED').map((c) => c.stepId);
      this.store.run('INSERT INTO run_versions VALUES (?, ?, ?, ?)', row.run_id, row.version + 1, JSON.stringify(fresh.resultRecipe), hash(fresh.resultRecipe));
      // statuses for new uses start UNADDED; nothing is completed by applying (B21)
      const us = { ...snap.useStatus };
      for (const u of fresh.resultRecipe.uses) us[u.useId] ??= 'UNADDED';
      this.store.run('UPDATE runs SET version = version + 1, revision = revision + 1, applied_rescue_count = applied_rescue_count + 1, use_status = ? WHERE run_id = ?', JSON.stringify(us), row.run_id);
      this.store.run('INSERT INTO amendments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', amendmentId, row.run_id, ev.evaluation_id, fresh.candidateId, fresh.planHash,
        input.commandId!, row.version, row.version + 1, row.revision + 1, JSON.stringify(changed), this.now());
      const after = this.runRow(row.run_id)!;
      return done({ outcome: 'applied', amendment: this.wireAmendment(this.store.get<Row>('SELECT * FROM amendments WHERE amendment_id = ?', amendmentId)!), run: this.wireRun(after), resume: { stepId: fresh.resume.stepId, text: fresh.resume.text } });
    });
  }

  // ---------- import_recipe (owner amendment 2026-10-05): a draft, exactly as the companion's import makes one ----------
  /**
   * Text, or the opaque sourceDocId an earlier upload returned (never a path or URL). The existing pipeline runs (one
   * extraction and one swap analysis, ledger-capped, never retried); the result is a draft that nobody has saved,
   * reviewed or released. Retrying the same commandId replays the stored result and never starts a second extraction.
   */
  async importRecipe(input: { commandId?: string; source: { kind: 'text'; text: string; title?: string } | { kind: 'upload'; sourceDocId: string } }, authoring: Authoring | undefined, waitMs = 25_000) {
    type Imported = { outcome: 'imported' | 'importing' | 'failed'; job: unknown; draft: unknown; next: string };
    const gate = this.store.tx(() => {
      const g = this.receiptGate<Imported>('import_recipe', input);
      if (!g) this.writeReceipt('import_recipe', input, null, 'PENDING', null);
      return g;
    });
    if (gate) return gate;
    const done = (res: Imported | Rejected) => { this.store.tx(() => this.writeReceipt('import_recipe', input, null, 'DONE', res)); return res; };
    if (!authoring) return done(this.reject('IMPORT_UNAVAILABLE'));
    const r = await authoring.createImport(input.source, `mcp:${input.commandId}`);
    if (r.status !== 202) return done(this.reject(r.error.code, null, r.error.message));
    // ponytail: bounded wait so an agent gets the reading in one call; a slower live reading finishes in the companion
    await Promise.race([authoring.waitForJob(r.job.id), new Promise((ok) => setTimeout(ok, waitMs))]);
    const { job, draft } = authoring.getImport(r.job.id);
    const content = draft?.content;
    return done({
      outcome: job.state === 'failed' ? 'failed' : job.state === 'queued' || job.state === 'running' ? 'importing' : 'imported',
      job, draft: draft && {
        draftId: draft.id, revision: draft.revision, title: content?.title ?? null, saved: false, blockers: draft.blockers.map((b) => b.message),
        steps: content?.steps.length ?? 0,
        uses: content?.ingredients.flatMap((i) => i.uses.map((u) => ({
          ingredient: i.name, step: content.steps.find((s) => s.id === u.stepId)?.ordinal ?? null, swap: u.swap.kind, text: u.swap.text, label: u.swap.label ?? null,
        }))) ?? [],
      },
      next: 'This is an unsaved draft. Review it and save it from the companion; importing never saves, reviews or releases a recipe.',
    });
  }

  // ---------- delete_recipe = archive from the Recipe Book (owner amendment 2026-10-05) ----------
  /** Hides one recipe from the book. Runs, receipts, saved versions, packs and sources stay; nothing is physically deleted. */
  archiveRecipe(input: { commandId?: string; recipeId: string; recipeVersionId: string; confirm: boolean }) {
    type Archived = { outcome: 'archived'; recipeId: Id; recipeVersionId: string; kept: string };
    return this.store.tx((): Replayable<Archived> => {
      const gate = this.receiptGate<Archived>('delete_recipe', input);
      if (gate) return gate;
      const done = (res: Archived | Rejected) => { this.writeReceipt('delete_recipe', input, null, 'DONE', res); return res; };
      if (input.confirm !== true) return done(this.reject('REPLACE_NOT_CONFIRMED', null, 'Removing a recipe from the Recipe Book needs explicit confirmation.'));
      const entry = this.listRecipes().recipes.find((r) => r.recipeId === input.recipeId);
      if (!entry) return done(this.reject('RECIPE_NOT_FOUND'));
      if (entry.currentVersionId !== input.recipeVersionId) return done(this.reject('VERSION_MISMATCH'));
      const active = this.activeRow();
      if (active?.recipe_id === input.recipeId) return done(this.reject('RECIPE_IN_USE', active));
      this.store.run('INSERT INTO archived_recipes VALUES (?, ?, ?, ?)', input.recipeId, input.recipeVersionId, input.commandId!, this.now());
      return done({ outcome: 'archived', recipeId: input.recipeId, recipeVersionId: input.recipeVersionId,
        kept: 'Removed from the Recipe Book only. Cooking history, receipts, saved versions and source files are kept.' });
    });
  }

  // ---------- admin reset (HTTP only; never an MCP tool) ----------
  adminReset(fixtureId: string): { ok: true; runId: Id; epoch: number; stateHash: string } | { ok: false; code: string } {
    const fx = this.content.fixtures.get(fixtureId);
    if (!fx) return { ok: false, code: 'FIXTURE_NOT_FOUND' };
    const pack = this.content.packs.get(fx.recipeId);
    if (!pack) return { ok: false, code: 'RECIPE_NOT_FOUND' };
    return this.store.tx(() => {
      this.store.run(`UPDATE runs SET status = 'ARCHIVED' WHERE kitchen_id = ? AND status = 'ACTIVE'`, this.kitchenId);
      this.store.run('UPDATE kitchens SET epoch = epoch + 1 WHERE kitchen_id = ?', this.kitchenId);
      let row = this.createRun(pack);
      for (const a of fx.actions) {   // fixtures reach only states the product can reach: the same progress path
        const snap = this.snapshot(row);
        const res = applyProgress(snap.recipe, snap.stepStatus, snap.useStatus, a);
        if (!res.ok) throw new Error(`fixture ${fixtureId}: ${a.stepId} ${res.code}`);
        this.commitProgress(row, res.stepStatus, res.useStatus, a);
        row = this.runRow(row.run_id)!;
      }
      const snap = this.snapshot(row);
      return { ok: true as const, runId: row.run_id, epoch: row.epoch, stateHash: hash({ packHash: row.pack_hash, revision: row.revision, stepStatus: snap.stepStatus, useStatus: snap.useStatus }) };
    });
  }

  /**
   * Demo/practice reset (owner key; HTTP only, never MCP). Archives the whole database first, then clears cooking
   * sessions, proposals, receipts and Activity (and, if asked, imported recipes, except the demo recipes listed in
   * demo_recipes, which stay in the Recipe Book). Kitchen epoch +1, so a stale tab's commands are refused. Approved
   * content is untouched.
   */
  demoReset(archivePath: string, removeImports: boolean) {
    this.store.db.exec(`VACUUM INTO '${archivePath.replace(/'/g, "''")}'`);   // evidence copy before anything is cleared
    this.store.tx(() => {
      for (const t of ['activity', 'receipts', 'amendments', 'evaluations', 'progress_events', 'run_versions', 'runs']) this.store.run(`DELETE FROM ${t}`);
      if (removeImports) {
        const demo = 'SELECT draft_id FROM saved_recipes WHERE recipe_id IN (SELECT recipe_id FROM demo_recipes)';
        for (const t of ['facts', 'extractions', 'swap_analyses', 'draft_bodies', 'draft_sources', 'import_jobs', 'drafts']) this.store.run(`DELETE FROM ${t} WHERE draft_id NOT IN (${demo})`);
        this.store.run('DELETE FROM saved_recipes WHERE recipe_id NOT IN (SELECT recipe_id FROM demo_recipes)');
        this.store.run('DELETE FROM sources WHERE source_id NOT IN (SELECT source_id FROM draft_sources)');
        const keep = [...this.content.packs.values()].map((p) => p.packHash);
        this.store.run(`DELETE FROM packs WHERE pack_hash NOT IN (${keep.map(() => '?').join(',')}) AND pack_hash NOT IN (SELECT pack_hash FROM saved_recipes)`, ...keep);
      }
      this.store.run(`DELETE FROM sqlite_sequence WHERE name = 'activity'`);   // Activity numbering restarts at #1
      this.store.run('UPDATE kitchens SET epoch = epoch + 1 WHERE kitchen_id = ?', this.kitchenId);
    });
    return { ok: true as const, archivedTo: archivePath, removedImports: removeImports };
  }

  // ---------- activity (real MCP calls, server-recorded) ----------
  logActivity(e: { runId: string | null; tool: string; correlationId: string | null; status: string; summary: string; input: unknown; trace: unknown; durationMs: number }) {
    this.store.run('INSERT INTO activity(run_id, tool, correlation_id, status, summary, input_json, trace_json, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.runId, e.tool, e.correlationId, e.status, e.summary, JSON.stringify(e.input ?? null), e.trace ? JSON.stringify(e.trace) : null, e.durationMs, this.now());
  }
  activity(runId?: string, after = 0) {
    const rows = runId
      ? this.store.all<Row>('SELECT * FROM activity WHERE run_id = ? AND seq > ? ORDER BY seq', runId, after)
      : this.store.all<Row>('SELECT * FROM activity WHERE seq > ? ORDER BY seq', after);
    return rows.map((r) => ({
      id: `act_${r.seq}`, seq: r.seq as number, channel: 'mcp' as const, name: r.tool as string, correlationId: r.correlation_id as string | null,
      status: r.status as string, summary: r.summary as string, input: JSON.parse((r.input_json as string) ?? 'null') as unknown,
      trace: r.trace_json ? (JSON.parse(r.trace_json as string) as unknown) : undefined, durationMs: r.duration_ms as number, at: r.at as string,
    }));
  }

  close() { this.store.close(); }
}
