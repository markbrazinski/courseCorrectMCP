// Tool semantics, receipts, fencing and transactions (ESOD §7, §8.2). Thin over the pure engine. One Service per workspace
// (a judge's sign-in, or the local kitchen): every item lives in that workspace's partition, and every mutation is one
// serializable workspace transaction (kv.ts), the equivalent of the SQLite build's BEGIN IMMEDIATE.
import { randomUUID } from 'node:crypto';
import { MAX_CHANGES_PER_RUN } from '../contract/types.ts';
import type { EvaluationResult, Id, Recipe, RecipePack, RescueRequest, RunSnapshot, StepStatus, UseStatus, Vocabulary } from '../contract/types.ts';
import { hash } from '../domain/rational.ts';
import { currentStepId, getStep, renderStep } from '../domain/recipe.ts';
import { evaluate, knowledgeUnavailable } from '../engine/evaluate.ts';
import { applyProgress, type ProgressAction } from '../engine/progress.ts';
import {
  coverageSummary, progressOf, recipeContent, rescueEvaluation, type RecipeBookEntry, type RecipeContent, type RescueEvaluation, type WireAmendment, type WireRun,
} from '../contract/project.ts';
import type { Authoring, ImportJob, WireDraft } from '../authoring/drafts.ts';
import { pinOf, rebindOf, staticKnowledge, KnowledgeUnavailable, type Content, type Knowledge, type Pin } from './content.ts';
import { refusalWhy } from '../contract/why.ts';
import { explain, noneExplainer, type Explainer } from './explain.ts';
import { noticesOf, type Interpreter } from './interpret.ts';
import { pad, tx, wsPk, type Kv, type Meta, type Tx } from './kv.ts';

/** Saved imported recipes (from authoring): latest version per recipe, with engine-computed eligibility. */
export interface CatalogEntry { recipeId: Id; pack: RecipePack | null; release: RecipeBookEntry['release']; title: string; meta: string; sourceLabel: string; versionId?: string }
export interface ServiceOptions {
  kv: Kv; interpreter: Interpreter;
  /** The knowledge releases (the runtime authority; storeKnowledge on the deployed service). Or one release, `content` (tests). */
  knowledge?: Knowledge; content?: Content; explainer?: Explainer; catalog?: (t: Tx) => Promise<CatalogEntry[]>;
  /** The workspace (partition) this service acts in. Default: the local kitchen. */
  ws?: string;
  /** List the hand-authored approved recipes in the Recipe Book (test fixtures since the demo recipes come through import). */
  fixtureRecipes?: boolean | Set<Id>;   // true = all; a set = only those (the rest come in through import)
  now?: () => string; newId?: (prefix: string) => string;
  /** PENDING work older than this was interrupted (a Lambda invocation can't outlive its timeout). */
  leaseMs?: number;
}
export type Rejected = { outcome: 'rejected'; code: string; message: string; run: WireRun | null; activeRun?: { runId: Id; recipeTitle: string } };
type Replayable<T> = (T | Rejected) & { replayed?: true };

export interface RunItem {
  runId: string; recipeId: string; packHash: string; epoch: number; mode: 'COOK' | 'ENGINEERING'; status: 'ACTIVE' | 'FINISHED' | 'ARCHIVED';
  revision: number; version: number; appliedRescueCount: number; latestEvaluationId: string | null; reservedEvaluationId: string | null;
  stepStatus: Record<Id, StepStatus>; useStatus: Record<Id, UseStatus>; progressCount: number; createdAt: string; v?: number;
  /** The knowledge release the run is pinned to for its whole life (2026-10-11); absent on runs started before releases. */
  knowledge?: Pin;
  /** Kinds the cook said they are out of, one per accepted change: no later plan may bring one back. */
  unavailableKinds?: Id[];
}
interface StoredRequest { request: RescueRequest; utterance: { text: string; channel: string } | null }
export interface EvalItem { evaluationId: string; runId: string; baseRevision: number; version: number; state: string; request: StoredRequest | null; result: { engine: EvaluationResult; wire: RescueEvaluation } | null; interpretation: string | null; at: string; owner: string; v?: number }
export interface ReceiptItem { commandId: string; tool: string; runId: string | null; digest: string; state: 'PENDING' | 'DONE' | 'INTERRUPTED'; result: unknown; at: string; owner: string; v?: number }
export interface AmendmentItem { amendmentId: string; runId: string; evaluationId: string; candidateId: string; planHash: string; commandId: string; fromVersion: number; toVersion: number; revisionAfter: number; changedStepIds: Id[]; at: string;
  /** 2026-10-11: what authorized it and what it builds on (absent on amendments applied before) */
  title?: string; origin?: 'REVIEWED' | 'IMPORT_CARD'; knowledgeReleaseId?: string | null; missingIngredientId?: Id | null;
  dependsOn?: { amendmentId: string; relation: 'REPLACES_INTRODUCED' | 'SHARES_STEP' }[] }

/** Item keys in a workspace partition. */
export const K = {
  run: (r: string) => `RUN#${r}`, version: (r: string, v: number) => `RUN#${r}#V#${pad(v)}`, progress: (r: string, n: number) => `RUN#${r}#P#${pad(n)}`,
  amendments: (r: string) => `RUN#${r}#A#`, amendment: (r: string, toVersion: number) => `RUN#${r}#A#${pad(toVersion)}`,
  byCommand: (c: string) => `AMCMD#${c}`, byEvaluation: (e: string) => `AMEV#${e}`,
  evaluation: (e: string) => `EV#${e}`, receipt: (c: string) => `RC#${c}`, pack: (h: string) => `PACK#${h}`, activity: (n: number) => `ACT#${pad(n)}`,
};

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
  KNOWLEDGE_UNAVAILABLE: "The reviewed knowledge this recipe was prepared with isn't available, so nothing can be checked or applied. Your recipe is unchanged.",
  PLAN_MISMATCH: "That isn't the change that was shown. Check again.",
  PLAN_CHANGED: 'The change no longer matches your recipe. Check again.',
  SUCCESSIVE_RESCUE_UNSUPPORTED: `This cooking session already used its ${MAX_CHANGES_PER_RUN} changes.`,
  RECIPE_IN_USE: 'This recipe is being cooked. Finish or end that cooking session before removing it from the Recipe Book.',
  IMPORT_UNAVAILABLE: 'Importing is not available on this server.',
  INTERNAL: 'Something went wrong; nothing was changed.',
};

/** Immutable packs by hash, shared by every workspace in the process (content-addressed, so sharing can't leak or change one). */
const packCache = new Map<string, RecipePack>();
export const LEASE_MS = 120_000;
/** Labels only, when a run's release can't be read: ids show as themselves; nothing is decided with it. */
const NO_VOCAB: Vocabulary = { schema: 'cc-vocabulary/1', version: 0, functions: [], techniques: [], classes: [], kinds: [] };
/** A pack's release: its content (null when it can't be read or established) and how the pack relates to it. */
type Known = { content: Content | null; pin: Pin; why: string | null };

export class Service {
  readonly kv: Kv;
  readonly ws: string;
  readonly knowledge: Knowledge;
  readonly interpreter: Interpreter;
  readonly explainer: Explainer;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly leaseMs: number;
  private readonly fixtureRecipes: boolean | Set<Id>;
  private listed(recipeId: Id) { return this.fixtureRecipes === true || (this.fixtureRecipes instanceof Set && this.fixtureRecipes.has(recipeId)); }
  catalog: (t: Tx) => Promise<CatalogEntry[]>;

  constructor(o: ServiceOptions) {
    this.kv = o.kv;
    this.ws = o.ws ?? 'kitchen';
    if (!o.knowledge && !o.content) throw new Error('Service needs knowledge (or one release as content)');
    this.knowledge = o.knowledge ?? staticKnowledge(o.content!);
    this.interpreter = o.interpreter;
    this.explainer = o.explainer ?? noneExplainer;
    this.now = o.now ?? (() => new Date().toISOString());
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.leaseMs = o.leaseMs ?? LEASE_MS;
    this.catalog = o.catalog ?? (async () => []);
    this.fixtureRecipes = o.fixtureRecipes ?? true;
  }
  private tx<T>(fn: (t: Tx, meta: Meta) => Promise<T>) { return tx(this.kv, this.ws, fn); }
  /** PENDING work whose process has ended, or whose lease has passed, was interrupted (never resumed or re-applied). */
  interrupted(x: { owner: string; at: string }) { return !this.kv.alive(x.owner) || Date.parse(this.now()) - Date.parse(x.at) > this.leaseMs; }

  // ---------- helpers ----------
  /** The example recipes of the ACTIVE release (none while no release can be read: never the bundled files). */
  private async examples(): Promise<Content | null> { try { return await this.knowledge.active(); } catch (e) { if (e instanceof KnowledgeUnavailable) return null; throw e; } }
  /** The knowledge a pack's plans came from (2026-10-11): its pinned release, or for a pack saved before releases a release with
   *  the same vocabulary and patterns. Unreadable or unknown: content null, and nothing can be evaluated or applied. */
  async known(pack: RecipePack): Promise<Known> {
    const pin = await pinOf(this.knowledge, pack);
    if (!pin.releaseId) return { content: null, pin, why: 'saved before knowledge versions were recorded, and no published release matches it' };
    try { return { content: await this.knowledge.get(pin.releaseId), pin, why: null }; }
    catch (e) { if (e instanceof KnowledgeUnavailable) return { content: null, pin, why: e.message }; throw e; }
  }
  private async pack(t: Tx, hashId: string): Promise<RecipePack> {
    let p = packCache.get(hashId);
    if (!p) {
      p = (await t.must<{ pack: RecipePack }>(K.pack(hashId))).pack;
      if (packCache.size > 200) packCache.clear();   // ponytail: a bounded process cache; an LRU if many recipes are ever cooked at once
      packCache.set(hashId, p);
    }
    return p;
  }
  private runRow(t: Tx, runId: string) { return t.get<RunItem>(K.run(runId)); }
  private async activeRow(t: Tx, meta: Meta) { return meta.activeRunId ? (await this.runRow(t, meta.activeRunId)) ?? null : null; }
  private async recipeAt(t: Tx, runId: string, version: number): Promise<Recipe> { return (await t.must<{ recipe: Recipe }>(K.version(runId, version))).recipe; }
  private async snapshot(t: Tx, row: RunItem): Promise<RunSnapshot> {
    return {
      runId: row.runId, epoch: row.epoch, packHash: row.packHash, mode: row.mode, revision: row.revision, version: row.version,
      appliedRescueCount: row.appliedRescueCount, recipe: await this.recipeAt(t, row.runId, row.version), stepStatus: row.stepStatus, useStatus: row.useStatus,
      knowledgeReleaseId: row.knowledge?.releaseId ?? null, unavailableKinds: row.unavailableKinds ?? [],
    };
  }
  private amendmentsOf(t: Tx, runId: string) { return t.query<AmendmentItem>(K.amendments(runId)); }

  async wireRun(t: Tx, row: RunItem, amendments?: AmendmentItem[]): Promise<WireRun> {
    const snap = await this.snapshot(t, row), v1 = await this.recipeAt(t, row.runId, 1), ams = amendments ?? await this.amendmentsOf(t, row.runId);
    const changedBy = (stepId: Id) => [...ams].reverse().find((a) => a.changedStepIds.includes(stepId));
    const pack = await this.pack(t, row.packHash);
    return {
      id: row.runId, recipeId: row.recipeId, recipeVersionId: pack.recipeHash, epoch: row.epoch, revision: row.revision, version: row.version,
      state: row.status === 'ACTIVE' ? 'active' : 'ended', mode: row.mode,
      contentLabel: row.mode === 'COOK' ? 'Released' : 'Reviewed knowledge',
      steps: snap.recipe.steps.map((s) => {
        const orig = getStep(v1, s.stepId);
        const eff = renderStep(snap.recipe, s), was = orig ? renderStep(v1, orig) : null;
        const progress = progressOf(snap.recipe, s.stepId, snap.stepStatus, snap.useStatus);
        return {
          stepId: s.stepId, progress, effectiveText: eff, originalText: was !== null && was !== eff ? was : null,
          partialUseIds: progress === 'partly' ? snap.recipe.uses.filter((u) => u.stepId === s.stepId && (snap.useStatus[u.useId] ?? 'UNADDED') !== 'UNADDED').map((u) => u.useId) : [],
          changedByAmendmentId: changedBy(s.stepId)?.amendmentId ?? null, onHold: null,
        };
      }),
      currentStepId: currentStepId(snap.recipe, snap.stepStatus),
      appliedAmendments: ams.map((a) => this.wireAmendment(a)), pendingCommand: null,
      knowledge: row.knowledge ?? (await pinOf(this.knowledge, pack)),
    };
  }
  private wireAmendment(am: AmendmentItem): WireAmendment {
    return { id: am.amendmentId, commandId: am.commandId, candidateId: am.candidateId, planId: am.planHash,
      changedStepIds: am.changedStepIds, appliedAtRunRevision: am.revisionAfter, fromVersion: am.fromVersion, toVersion: am.toVersion,
      title: am.title ?? null, knowledgeReleaseId: am.knowledgeReleaseId ?? null, dependsOn: am.dependsOn ?? [] };
  }
  /** Display for a run's recipe: labels and plan summaries from its release (ids only if that can't be read). */
  private async contentFor(t: Tx, row: RunItem, pack: RecipePack, r: Recipe, ams?: AmendmentItem[]) {
    const k = (await this.known(pack)).content;
    ams ??= await this.amendmentsOf(t, row.runId);
    return recipeContent(r, k?.vocab ?? NO_VOCAB, pack, await this.recipeAt(t, row.runId, 1), k?.patterns ?? [], undefined,
      (version) => { const a = ams.find((x) => x.fromVersion === version); return a ? { amendmentId: a.amendmentId, title: a.title ?? null } : null; });
  }
  private async reject(t: Tx, code: string, row?: RunItem | null, message?: string): Promise<Rejected> {
    return { outcome: 'rejected', code, message: message ?? MESSAGES[code] ?? code, run: row ? await this.wireRun(t, (await this.runRow(t, row.runId))!) : null };
  }
  private digest(tool: string, input: object) { const { commandId: _c, ...rest } = input as Record<string, unknown>; return hash({ tool, input: rest }); }

  /** Receipt lookup. Returns a stored result to replay, a rejection, or null to proceed (inside the caller's transaction). */
  private async receiptGate<T>(t: Tx, tool: string, input: object): Promise<Replayable<T> | null> {
    const commandId = (input as { commandId?: unknown }).commandId;
    if (typeof commandId !== 'string' || !commandId) return await this.reject(t, 'INVALID_COMMAND') as Replayable<T>;
    const rc = await t.get<ReceiptItem>(K.receipt(commandId));
    if (!rc) return null;
    if (rc.digest !== this.digest(tool, input)) return await this.reject(t, 'COMMAND_ID_REUSE') as Replayable<T>;
    const state = this.receiptState(rc);
    if (state === 'PENDING') return await this.reject(t, 'IN_PROGRESS') as Replayable<T>;
    if (state === 'INTERRUPTED') return await this.reject(t, 'INTERRUPTED') as Replayable<T>;
    const stored = rc.result as T & { outcome?: string };
    return { ...stored, ...(stored.outcome === 'applied' ? { outcome: 'alreadyApplied' } : {}), replayed: true } as Replayable<T>;
  }
  private receiptState(rc: ReceiptItem) { return rc.state === 'PENDING' && this.interrupted(rc) ? 'INTERRUPTED' : rc.state; }
  private async writeReceipt(t: Tx, tool: string, input: object, runId: string | null, state: 'PENDING' | 'DONE', result: unknown) {
    const commandId = (input as { commandId: string }).commandId, cur = await t.get<ReceiptItem>(K.receipt(commandId));
    t.put(K.receipt(commandId), { commandId, tool, runId: cur?.runId ?? runId, digest: this.digest(tool, input), state, result, at: cur?.at ?? this.now(), owner: this.kv.owner, v: cur?.v } satisfies ReceiptItem);
  }
  /** Run checks shared by run-scoped mutations. */
  private async checkRun(t: Tx, meta: Meta, input: { runId?: string; epoch?: number }): Promise<RunItem | Rejected> {
    if (typeof input.runId !== 'string' || typeof input.epoch !== 'number') return this.reject(t, 'INVALID_COMMAND');
    const row = await this.runRow(t, input.runId);
    if (!row) return this.reject(t, 'RUN_NOT_FOUND');
    if (row.status === 'ARCHIVED' || row.epoch !== input.epoch || row.epoch !== meta.epoch) return this.reject(t, 'RUN_EXPIRED', row);
    if (row.status === 'FINISHED') return this.reject(t, 'RUN_ENDED', row);
    return row;
  }

  // ---------- list_recipes ----------
  /** Approved engineering content (eligible) plus saved imports (eligibility computed at save). Never drafts. */
  private async entries(t: Tx, meta: Meta): Promise<CatalogEntry[]> {
    const ex = await this.examples();
    return [
      ...[...(ex?.packs.values() ?? [])].filter((p) => this.listed(p.recipe.recipeId)).map((p) => ({ recipeId: p.recipe.recipeId, pack: p as RecipePack | null, release: { kind: 'eligible' as const, coverageSummary: '' }, title: p.recipe.title, meta: p.recipe.meta, sourceLabel: p.recipe.source?.label ?? '' })),
      ...await this.catalog(t),
    ].filter((e) => !meta.archived[e.recipeId]);
  }
  private async book(t: Tx, meta: Meta): Promise<{ recipes: RecipeBookEntry[] }> {
    const active = await this.activeRow(t, meta);
    return {
      recipes: (await this.entries(t, meta)).map((e) => {
        const p = e.pack;
        if (!p || e.release.kind === 'ineligible') {
          return { recipeId: e.recipeId, currentVersionId: p?.recipeHash ?? e.versionId ?? '', title: e.title, meta: e.meta, sourceLabel: e.sourceLabel, release: e.release, activeRunId: null };
        }
        return {
          recipeId: p.recipe.recipeId, currentVersionId: p.recipeHash, title: p.recipe.title, meta: p.recipe.meta, sourceLabel: e.sourceLabel,
          release: { kind: 'eligible' as const, coverageSummary: coverageSummary(p) },
          activeRunId: active && active.recipeId === p.recipe.recipeId ? active.runId : null,
        };
      }),
    };
  }
  listRecipes() { return this.tx((t, meta) => this.book(t, meta)); }

  /** Approved content as a recipe page (GET /recipes/:id for recipes that are not imports). */
  async approvedRecipe(recipeId: string) {
    const ex = await this.examples();
    const p = this.listed(recipeId) ? ex?.packs.get(recipeId) : undefined;
    if (!p || !ex) return null;
    const release = (await this.listRecipes()).recipes.find((r) => r.recipeId === recipeId)?.release;
    if (!release) return null;   // archived from this workspace's book
    return { version: { id: p.recipeHash, recipeId, createdFromDraft: null, content: recipeContent(p.recipe, ex.vocab, p, p.recipe, ex.patterns, { pending: false }), release }, sources: [] };
  }

  // ---------- start_recipe (C-3: explicit, confirmed, atomic replacement) ----------
  startRecipe(input: { commandId?: string; recipeId: string; recipeVersionId?: string; replace?: { runId: string; epoch: number; expectedRevision: number; confirm: boolean } }) {
    type Started = { outcome: 'started'; run: WireRun; recipe: RecipeContent };
    return this.tx(async (t, meta): Promise<Replayable<Started>> => {
      const gate = await this.receiptGate<Started>(t, 'start_recipe', input);
      if (gate) return gate;
      const done = async (res: Started | Rejected, runId: string | null) => { await this.writeReceipt(t, 'start_recipe', input, runId, 'DONE', res); return res; };
      const entry = (await this.entries(t, meta)).find((e) => e.recipeId === input.recipeId);
      if (!entry) return done(await this.reject(t, 'RECIPE_NOT_FOUND'), null);
      if (!entry.pack || entry.release.kind === 'ineligible') {
        return done(await this.reject(t, 'NOT_ELIGIBLE', null, entry.release.kind === 'ineligible' ? entry.release.reasons.map((r) => r.message).join(' ') : undefined), null);
      }
      const pack = entry.pack;
      if (input.recipeVersionId && input.recipeVersionId !== pack.recipeHash) return done(await this.reject(t, 'VERSION_MISMATCH'), null);
      const active = await this.activeRow(t, meta);
      if (active) {
        const rp = input.replace;
        if (!rp) return done({ ...await this.reject(t, 'ACTIVE_RUN_EXISTS', active), activeRun: { runId: active.runId, recipeTitle: (await this.pack(t, active.packHash)).recipe.title } }, null);
        if (rp.confirm !== true) return done(await this.reject(t, 'REPLACE_NOT_CONFIRMED', active), null);
        if (rp.runId !== active.runId || rp.epoch !== active.epoch) return done(await this.reject(t, 'RUN_EXPIRED', active), null);
        if (rp.expectedRevision !== active.revision) return done(await this.reject(t, 'STALE_STATE', active), null);
        t.put(K.run(active.runId), { ...active, status: 'ARCHIVED' });   // history preserved
        meta.activeRunId = null;
      }
      const row = await this.createRun(t, meta, pack, await pinOf(this.knowledge, pack));
      return done({ outcome: 'started', run: await this.wireRun(t, row, []), recipe: await this.contentFor(t, row, pack, pack.recipe, []) }, row.runId);   // a new run has no amendments
    });
  }
  /** `pin`: the run keeps this release for its whole life; a newer release never changes it. */
  private async createRun(t: Tx, meta: Meta, pack: RecipePack, pin: Pin): Promise<RunItem> {
    const runId = this.newId('run'), r = pack.recipe;
    if (!(await t.fixed(K.pack(pack.packHash)))) t.put(K.pack(pack.packHash), { recipeId: r.recipeId, pack });   // the run stays pinned to its pack across deploys
    // ponytail: no release records in M1, so every run is ENGINEERING; COOK fails closed in the engine (B11).
    const row: RunItem = {
      runId, recipeId: r.recipeId, packHash: pack.packHash, epoch: meta.epoch, mode: 'ENGINEERING', status: 'ACTIVE', revision: 0, version: 1, appliedRescueCount: 0,
      latestEvaluationId: null, reservedEvaluationId: null, stepStatus: Object.fromEntries(r.steps.map((s) => [s.stepId, 'NOT_STARTED'])),
      useStatus: Object.fromEntries(r.uses.map((u) => [u.useId, 'UNADDED'])), progressCount: 0, createdAt: this.now(),
      knowledge: pin, unavailableKinds: [],
    };
    t.put(K.run(runId), row);
    t.put(K.version(runId, 1), { recipe: r, hash: hash(r) });
    meta.activeRunId = runId;
    return (await this.runRow(t, runId))!;
  }

  // ---------- get_active_recipe (read-only; the reconciliation read) ----------
  getActiveRecipe(input: { runId?: string; commandId?: string; evaluationId?: string } = {}) {
    return this.tx(async (t, meta) => {
      const row = await this.activeRow(t, meta);
      const out: {
        run: WireRun | null; recipe: RecipeContent | null; latestEvaluation: RescueEvaluation | null;
        command?: { commandId: Id; receipt: 'NONE' | 'PENDING' | 'DONE' | 'INTERRUPTED'; code: string | null; status: 'applied' | 'appliedOther' | 'notApplied' | 'unknown' | 'runReplaced'; amendmentId?: Id };
      } = { run: null, recipe: null, latestEvaluation: null };
      if (row) {
        const pack = await this.pack(t, row.packHash), ams = await this.amendmentsOf(t, row.runId);
        out.run = await this.wireRun(t, row, ams);
        out.recipe = await this.contentFor(t, row, pack, await this.recipeAt(t, row.runId, row.version), ams);
        out.latestEvaluation = row.latestEvaluationId ? await this.wireEvaluationIn(t, row.latestEvaluationId) : null;
      }
      if (input.commandId) out.command = await this.commandOutcomeIn(t, meta, input.commandId, input.runId, input.evaluationId);
      return out;
    });
  }

  /**
   * ESOD §4.2h: RUN_REPLACED → APPLIED_THIS → APPLIED_OTHER → NOT_APPLIED (authoritative only) → UNKNOWN.
   * With several changes per run (ENGINE_SEMANTICS 2), APPLIED_OTHER means the same evaluation was applied by another command.
   */
  commandOutcome(commandId: string, runId?: string, evaluationId?: string) { return this.tx((t, meta) => this.commandOutcomeIn(t, meta, commandId, runId, evaluationId)); }
  private async commandOutcomeIn(t: Tx, meta: Meta, commandId: string, runId?: string, evaluationId?: string) {
    const rc = await t.get<ReceiptItem>(K.receipt(commandId));
    const receipt = (rc ? this.receiptState(rc) : 'NONE') as 'NONE' | 'PENDING' | 'DONE' | 'INTERRUPTED';
    const result = rc?.result as { outcome?: string; code?: string } | null | undefined;
    const code = result ? (result.code ?? result.outcome?.toUpperCase() ?? null) : null;
    const base = { commandId, receipt, code };
    const cmdRun = rc?.runId ?? runId;
    const run = cmdRun ? await this.runRow(t, cmdRun) : undefined;
    if (run && (run.status === 'ARCHIVED' || run.epoch !== meta.epoch)) return { ...base, status: 'runReplaced' as const };
    const mine = await t.get<{ amendmentId: string }>(K.byCommand(commandId));
    if (mine) return { ...base, status: 'applied' as const, amendmentId: mine.amendmentId };
    const other = evaluationId ? await t.get<{ amendmentId: string; commandId: string }>(K.byEvaluation(evaluationId)) : undefined;
    if (other && other.commandId !== commandId) return { ...base, status: 'appliedOther' as const, amendmentId: other.amendmentId };
    if (receipt === 'DONE' || receipt === 'INTERRUPTED') return { ...base, status: 'notApplied' as const };
    return { ...base, status: 'unknown' as const };
  }

  // ---------- record_progress ----------
  recordProgress(input: { commandId?: string; runId: string; epoch: number; expectedRevision?: number } & ProgressAction) {
    type Recorded = { outcome: 'recorded'; code: 'PROGRESS_RECORDED' | 'ALREADY_RECORDED'; run: WireRun };
    return this.tx(async (t, meta): Promise<Replayable<Recorded>> => {
      const gate = await this.receiptGate<Recorded>(t, 'record_progress', input);
      if (gate) return gate;
      const done = async (res: Recorded | Rejected) => { await this.writeReceipt(t, 'record_progress', input, input.runId ?? null, 'DONE', res); return res; };
      if (typeof input.expectedRevision !== 'number') return done(await this.reject(t, 'INVALID_COMMAND'));
      const row = await this.checkRun(t, meta, input);
      if ('outcome' in row) return done(row);
      if (row.revision !== input.expectedRevision) return done(await this.reject(t, 'STALE_STATE', row));
      const snap = await this.snapshot(t, row);
      const res = applyProgress(snap.recipe, snap.stepStatus, snap.useStatus, input);
      if (!res.ok) return done(await this.reject(t, res.code, row));
      if (!res.changed) return done({ outcome: 'recorded', code: 'ALREADY_RECORDED', run: await this.wireRun(t, row) });
      await this.commitProgress(t, meta, row, res.stepStatus, res.useStatus, input);
      return done({ outcome: 'recorded', code: 'PROGRESS_RECORDED', run: await this.wireRun(t, (await this.runRow(t, row.runId))!) });
    });
  }
  private async commitProgress(t: Tx, meta: Meta, row: RunItem, ss: Record<Id, StepStatus>, us: Record<Id, UseStatus>, a: ProgressAction) {
    const recipe = await this.recipeAt(t, row.runId, row.version);
    const finished = recipe.steps.every((s) => ss[s.stepId] === 'COMPLETED');
    const seq = row.progressCount + 1;
    t.put(K.run(row.runId), { ...row, stepStatus: ss, useStatus: us, revision: row.revision + 1, status: finished ? 'FINISHED' : 'ACTIVE', progressCount: seq });
    if (finished && meta.activeRunId === row.runId) meta.activeRunId = null;
    t.put(K.progress(row.runId, seq), { action: { stepId: a.stepId, progress: a.progress, addedUseIds: a.addedUseIds ?? [], partialUseIds: a.partialUseIds ?? [] }, revisionAfter: row.revision + 1, at: this.now() });
  }

  // ---------- evaluate_rescue (reserve → compute → publish) ----------
  async evaluateRescue(input: {
    commandId?: string; runId: string; epoch: number; expectedRevision?: number;
    utterance?: { text: string; channel: 'voice' | 'typed' | 'tapped' }; missingIngredientId?: string; proposedKindIds?: string[];
    answers?: { questionId: string; value: 'yes' | 'no' }[]; previousEvaluationId?: string;
  }): Promise<Replayable<RescueEvaluation>> {
    const reserved = await this.tx(async (t, meta): Promise<Replayable<RescueEvaluation> | { row: RunItem; evaluationId: string; snap: RunSnapshot; pack: RecipePack; stored: StoredRequest | null }> => {
      const gate = await this.receiptGate<RescueEvaluation>(t, 'evaluate_rescue', input);
      if (gate) return gate;
      const fail = async (r: Rejected) => { await this.writeReceipt(t, 'evaluate_rescue', input, input.runId ?? null, 'DONE', r); return r; };
      if (typeof input.expectedRevision !== 'number') return fail(await this.reject(t, 'INVALID_COMMAND'));
      const row = await this.checkRun(t, meta, input);
      if ('outcome' in row) return fail(row);
      if (row.revision !== input.expectedRevision) return fail(await this.reject(t, 'STALE_STATE', row));
      const evaluationId = this.newId('ev');
      await this.writeReceipt(t, 'evaluate_rescue', input, row.runId, 'PENDING', null);
      if (row.reservedEvaluationId) {   // at most one PENDING per run: a newer check supersedes it
        const prev = await t.get<EvalItem>(K.evaluation(row.reservedEvaluationId));
        if (prev?.state === 'PENDING') t.put(K.evaluation(prev.evaluationId), { ...prev, state: 'SUPERSEDED' });
      }
      t.put(K.evaluation(evaluationId), { evaluationId, runId: row.runId, baseRevision: row.revision, version: row.version, state: 'PENDING', request: null, result: null, interpretation: null, at: this.now(), owner: this.kv.owner } satisfies EvalItem);
      t.put(K.run(row.runId), { ...row, reservedEvaluationId: evaluationId });
      let stored: StoredRequest | null = null;
      if (input.previousEvaluationId) {
        const prev = await t.get<EvalItem>(K.evaluation(input.previousEvaluationId));
        if (prev && prev.runId === row.runId && prev.request) stored = prev.request;
      }
      return { row, evaluationId, snap: await this.snapshot(t, row), pack: await this.pack(t, row.packHash), stored };
    });
    if (!('evaluationId' in reserved)) return reserved;
    const { row, evaluationId, snap, pack, stored } = reserved;
    const known = await this.known(pack);   // the run's pinned release (cached per process); never the ACTIVE one
    const v = known.content?.vocab ?? NO_VOCAB;

    // compute (outside any transaction; at most one interpreter call)
    let missing = input.missingIngredientId ?? null, proposed = input.proposedKindIds ?? null, interpretation: string | null = null;
    const notices: RescueRequest['notices'] = [];
    if (!missing && input.utterance?.text) {
      const ctx = {
        ingredients: snap.recipe.ingredients.map((i) => ({ id: i.ingredientId, name: i.name })),
        kinds: v.kinds.map((k) => ({ id: k.kindId, label: k.label, aliases: [...new Set([...k.aliases, k.short])] })),   // the short word is how a cook refers to it ("the cream"), not an identity
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
    try {
      res = known.content ? evaluate(pack, v, snap, request, false, rebindOf(known.content)) : knowledgeUnavailable(pack, snap, request, known.why ?? 'unavailable');
    } catch (e) { error = (e as Error).message; }
    // a refusal says why: engine facts first, then (at most one call) words for them, checked; the decision never changes
    let explained: Parameters<typeof rescueEvaluation>[0]['explained'];
    if (res?.status === 'REFUSED' && res.refusal) {
      const why = refusalWhy({ pack: whyPack(pack, snap.recipe, res), patterns: known.content?.patterns ?? [], v }, res, request.proposedKindIds);
      const said = await explain(this.explainer, input.utterance?.channel === 'tapped' ? null : input.utterance?.text ?? null, why, v);
      explained = { why, answer: { text: said.text, source: said.source }, note: `${said.source}${said.rejected ? ` (${this.explainer.mode} answer not used: ${said.rejected})` : ''}` };
    }

    // publish
    return this.tx(async (t, meta) => {
      const now = (await this.runRow(t, row.runId))!;
      const ev = (await t.get<EvalItem>(K.evaluation(evaluationId)))!;
      const newer = now.reservedEvaluationId !== evaluationId;
      let state = 'PUBLISHED';
      if (error || !res) state = 'FAILED';
      else if (now.status !== 'ACTIVE' || now.epoch !== row.epoch || now.epoch !== meta.epoch) state = 'INTERRUPTED';
      else if (now.revision !== row.revision) state = 'STALE';
      else if (newer) state = 'SUPERSEDED';
      const storedRequest: StoredRequest = { request, utterance: input.utterance ?? null };
      if (state === 'FAILED') {
        const r = await this.reject(t, 'INTERNAL', now, `${MESSAGES.INTERNAL} (${error})`);
        t.put(K.evaluation(evaluationId), { ...ev, state: 'FAILED', request: storedRequest });
        await this.writeReceipt(t, 'evaluate_rescue', input, row.runId, 'DONE', r);
        return r as Replayable<RescueEvaluation>;
      }
      const actionable = state === 'PUBLISHED' && res!.status === 'CANDIDATES';
      const wire = rescueEvaluation({ evaluationId, runId: row.runId, baseRevision: row.revision, actionable, res: res!, snapRecipe: snap.recipe, v, stepStatus: snap.stepStatus, mode: row.mode, interpretationSummary: interpretation, explained,
        basis: { revision: row.revision, version: row.version, knowledgeReleaseId: known.pin.releaseId, knowledgeBasis: known.pin.basis } });
      t.put(K.evaluation(evaluationId), { ...ev, state, request: storedRequest, result: { engine: res!, wire }, interpretation });
      if (state === 'PUBLISHED') t.put(K.run(row.runId), { ...now, latestEvaluationId: evaluationId });
      await this.writeReceipt(t, 'evaluate_rescue', input, row.runId, 'DONE', wire);
      return wire;
    });
  }

  /** Stored evaluation with `actionable` recomputed against the current run (never trusts an old flag). */
  wireEvaluation(evaluationId: string) { return this.tx((t) => this.wireEvaluationIn(t, evaluationId)); }
  private async wireEvaluationIn(t: Tx, evaluationId: string): Promise<RescueEvaluation | null> {
    const ev = await t.get<EvalItem>(K.evaluation(evaluationId));
    if (!ev?.result) return null;
    const run = (await this.runRow(t, ev.runId))!;
    const wire = structuredClone(ev.result.wire);
    const actionable = ev.state === 'PUBLISHED' && run.status === 'ACTIVE' && run.latestEvaluationId === evaluationId
      && run.revision === ev.baseRevision && run.appliedRescueCount < MAX_CHANGES_PER_RUN && wire.outcome === 'proposal';
    if (wire.outcome === 'proposal') {
      wire.candidates = wire.candidates.map((c) => ({ ...c, applicable: actionable ? { kind: 'yes' } : { kind: 'no', reason: 'stale', message: 'Your progress changed since this was checked. Check again.' } }));
    }
    return { ...wire, actionable };
  }

  /**
   * Text the speech route may read aloud: only what this service rendered (an evaluation's authored speech, or a step).
   * "Change applied." is said only for an amendment this run actually holds, so it is never spoken before the server confirms.
   */
  speechText(ref: { evaluationId?: string; runId?: string; stepId?: string; amendmentId?: string; next?: boolean }): Promise<string | null> {
    return this.tx(async (t) => {
      if (ref.evaluationId) return (await this.wireEvaluationIn(t, ref.evaluationId))?.speech.text ?? null;
      const row = ref.runId ? await this.runRow(t, ref.runId) : undefined;
      if (!row || !ref.stepId) return null;
      if (ref.amendmentId && !(await this.amendmentsOf(t, row.runId)).some((a) => a.amendmentId === ref.amendmentId)) return null;
      const steps = (await this.wireRun(t, row)).steps, i = steps.findIndex((s) => s.stepId === ref.stepId);
      return i < 0 ? null : `${ref.amendmentId ? 'Change applied. ' : ref.next ? 'Next: ' : ''}Step ${i + 1}. ${steps[i].effectiveText}`;
    });
  }

  // ---------- apply_amendment (one workspace transaction; receipt committed with the amendment) ----------
  applyAmendment(input: { commandId?: string; runId: string; epoch: number; expectedRevision?: number; evaluationId: string; candidateId: string; planId: string; accepted?: boolean }) {
    type Applied = { outcome: 'applied'; amendment: WireAmendment; run: WireRun; resume: { stepId: Id; text: string } };
    return this.tx(async (t, meta): Promise<Replayable<Applied>> => {
      const gate = await this.receiptGate<Applied>(t, 'apply_amendment', input);
      if (gate) return gate;
      const done = async (res: Applied | Rejected) => { await this.writeReceipt(t, 'apply_amendment', input, input.runId ?? null, 'DONE', res); return res; };
      if (typeof input.expectedRevision !== 'number') return done(await this.reject(t, 'INVALID_COMMAND'));
      if (input.accepted !== true) return done(await this.reject(t, 'ACCEPTANCE_REQUIRED'));
      const row = await this.checkRun(t, meta, input);
      if ('outcome' in row) return done(row);
      if (row.revision !== input.expectedRevision) return done(await this.reject(t, 'STALE_STATE', row));
      const ev = await t.get<EvalItem>(K.evaluation(input.evaluationId));
      if (!ev || ev.runId !== row.runId || row.latestEvaluationId !== ev.evaluationId) return done(await this.reject(t, 'NOT_LATEST_EVALUATION', row));
      if (ev.state !== 'PUBLISHED' || ev.result?.engine.status !== 'CANDIDATES') return done(await this.reject(t, 'NOT_ACTIONABLE', row));
      if (ev.baseRevision !== row.revision) return done(await this.reject(t, 'STALE_STATE', row));
      if (row.appliedRescueCount >= MAX_CHANGES_PER_RUN) return done(await this.reject(t, 'SUCCESSIVE_RESCUE_UNSUPPORTED', row));
      const shown = ev.result.engine.candidates.find((c) => c.candidateId === input.candidateId);
      if (!shown || shown.planHash !== input.planId) return done(await this.reject(t, 'PLAN_MISMATCH', row));
      // re-evaluate on the current snapshot with the stored request; never apply a stale plan
      const snap = await this.snapshot(t, row), pack = await this.pack(t, row.packHash), known = await this.known(pack);
      if (!known.content) return done(await this.reject(t, 'KNOWLEDGE_UNAVAILABLE', row));
      // re-evaluate on the current snapshot with the stored request and the run's pinned release; never apply a stale plan
      const again = evaluate(pack, known.content.vocab, snap, ev.request!.request, false, rebindOf(known.content));
      const fresh = again.status === 'CANDIDATES' ? again.candidates.find((c) => c.candidateId === input.candidateId) : undefined;
      if (!fresh || fresh.planHash !== shown.planHash) return done(await this.reject(t, 'PLAN_CHANGED', row));
      const amendmentId = this.newId('am');
      const changed = fresh.changes.filter((c) => c.kind !== 'UNCHANGED').map((c) => c.stepId);
      t.put(K.version(row.runId, row.version + 1), { recipe: fresh.resultRecipe, hash: hash(fresh.resultRecipe) });
      // statuses for new uses start UNADDED; nothing is completed by applying (B21)
      const us = { ...snap.useStatus };
      for (const u of fresh.resultRecipe.uses) us[u.useId] ??= 'UNADDED';
      const missing = ev.request!.request.missingIngredientId, kind = missing ? snap.recipe.ingredients.find((i) => i.ingredientId === missing)?.kind?.kindId : undefined;
      t.put(K.run(row.runId), { ...row, version: row.version + 1, revision: row.revision + 1, appliedRescueCount: row.appliedRescueCount + 1, useStatus: us,
        unavailableKinds: [...new Set([...(row.unavailableKinds ?? []), ...(kind ? [kind] : [])])] });
      const earlier = await this.amendmentsOf(t, row.runId);
      const am: AmendmentItem = { amendmentId, runId: row.runId, evaluationId: ev.evaluationId, candidateId: fresh.candidateId, planHash: fresh.planHash,
        commandId: input.commandId!, fromVersion: row.version, toVersion: row.version + 1, revisionAfter: row.revision + 1, changedStepIds: changed, at: this.now(),
        title: fresh.patternTitle, origin: fresh.origin, knowledgeReleaseId: known.pin.releaseId, missingIngredientId: missing ?? null,
        dependsOn: dependsOn(snap.recipe, fresh.ops, changed, earlier) };
      t.put(K.amendment(row.runId, row.version + 1), am);
      t.put(K.byCommand(input.commandId!), { amendmentId });
      t.put(K.byEvaluation(ev.evaluationId), { amendmentId, commandId: input.commandId! });   // one amendment per evaluation (it must not exist yet)
      const after = (await this.runRow(t, row.runId))!;
      return done({ outcome: 'applied', amendment: this.wireAmendment(am), run: await this.wireRun(t, after), resume: { stepId: fresh.resume.stepId, text: fresh.resume.text } });
    });
  }

  // ---------- import_recipe (owner amendment 2026-10-05): a draft, exactly as the companion's import makes one ----------
  /**
   * Text, or the opaque sourceDocId an earlier upload returned (never a path or URL). Returns once the import job is durable
   * (`importing`, or `failed` if the source can't be read at all); the existing pipeline then runs in the background (one
   * extraction and one swap analysis, ledger-capped, never retried). The same commandId and source again report the job as
   * it is now (`importing`, `imported` with the draft, or `failed`), never a second reading. The draft is never saved,
   * reviewed or released here. (Latency audit 2026-10-11: waiting for the reading held this call open for up to 25 s.)
   */
  async importRecipe(input: { commandId?: string; source: { kind: 'text'; text: string; title?: string } | { kind: 'upload'; sourceDocId: string } }, authoring: Authoring | undefined) {
    type Imported = { outcome: 'imported' | 'importing' | 'needsChoice' | 'failed'; job: ImportJob; draft: unknown; next: string };
    const gate = await this.tx(async (t) => {
      const g = await this.receiptGate<Imported>(t, 'import_recipe', input);
      if (!g) await this.writeReceipt(t, 'import_recipe', input, null, 'PENDING', null);
      return g;
    });
    // the receipt holds the acceptance; a retry reads the job's current state (still read-only: nothing starts again)
    if (gate) return gate.outcome === 'importing' && authoring ? { ...await this.importState(authoring, gate.job.id), replayed: true } : gate;
    const done = async (res: Imported | Rejected) => { await this.tx((t) => this.writeReceipt(t, 'import_recipe', input, null, 'DONE', res)); return res; };
    if (!authoring) return done(await this.tx((t) => this.reject(t, 'IMPORT_UNAVAILABLE')));
    const r = await authoring.createImport(input.source, `mcp:${input.commandId}`);
    if (r.status !== 202) return done(await this.tx((t) => this.reject(t, r.error.code, null, r.error.message)));
    return done(importResult(r.job, null));
  }
  private async importState(authoring: Authoring, jobId: Id) { const { job, draft } = await authoring.getImport(jobId); return importResult(job, draft); }

  // ---------- delete_recipe = archive from the Recipe Book (owner amendment 2026-10-05) ----------
  /** Hides one recipe from the book. Runs, receipts, saved versions, packs and sources stay; nothing is physically deleted. */
  archiveRecipe(input: { commandId?: string; recipeId: string; recipeVersionId: string; confirm: boolean }) {
    type Archived = { outcome: 'archived'; recipeId: Id; recipeVersionId: string; kept: string };
    return this.tx(async (t, meta): Promise<Replayable<Archived>> => {
      const gate = await this.receiptGate<Archived>(t, 'delete_recipe', input);
      if (gate) return gate;
      const done = async (res: Archived | Rejected) => { await this.writeReceipt(t, 'delete_recipe', input, null, 'DONE', res); return res; };
      if (input.confirm !== true) return done(await this.reject(t, 'REPLACE_NOT_CONFIRMED', null, 'Removing a recipe from the Recipe Book needs explicit confirmation.'));
      const entry = (await this.book(t, meta)).recipes.find((r) => r.recipeId === input.recipeId);
      if (!entry) return done(await this.reject(t, 'RECIPE_NOT_FOUND'));
      if (entry.currentVersionId !== input.recipeVersionId) return done(await this.reject(t, 'VERSION_MISMATCH'));
      const active = await this.activeRow(t, meta);
      if (active?.recipeId === input.recipeId) return done(await this.reject(t, 'RECIPE_IN_USE', active));
      meta.archived[input.recipeId] = { versionId: input.recipeVersionId, commandId: input.commandId!, at: this.now() };
      return done({ outcome: 'archived', recipeId: input.recipeId, recipeVersionId: input.recipeVersionId,
        kept: 'Removed from the Recipe Book only. Cooking history, receipts, saved versions and source files are kept.' });
    });
  }

  // ---------- test support: start a run at a named fixture scene (tests/support/server.ts and acceptance tests only; no
  // product route reaches it, and it is never an MCP tool) ----------
  async adminReset(fixtureId: string): Promise<{ ok: true; runId: Id; epoch: number; stateHash: string } | { ok: false; code: string }> {
    const ex = await this.examples();
    const fx = ex?.fixtures.get(fixtureId);
    if (!fx) return { ok: false as const, code: 'FIXTURE_NOT_FOUND' };
    const pack = ex!.packs.get(fx.recipeId);
    if (!pack) return { ok: false as const, code: 'RECIPE_NOT_FOUND' };
    return this.tx(async (t, meta) => {
      const active = await this.activeRow(t, meta);
      if (active) t.put(K.run(active.runId), { ...active, status: 'ARCHIVED' });
      meta.activeRunId = null;
      meta.epoch += 1;
      let row = await this.createRun(t, meta, pack, { releaseId: ex!.releaseId, basis: 'PINNED' });
      for (const a of fx.actions) {   // fixtures reach only states the product can reach: the same progress path
        const snap = await this.snapshot(t, row);
        const res = applyProgress(snap.recipe, snap.stepStatus, snap.useStatus, a);
        if (!res.ok) throw new Error(`fixture ${fixtureId}: ${a.stepId} ${res.code}`);
        await this.commitProgress(t, meta, row, res.stepStatus, res.useStatus, a);
        row = (await this.runRow(t, row.runId))!;
      }
      const snap = await this.snapshot(t, row);
      return { ok: true as const, runId: row.runId, epoch: row.epoch, stateHash: hash({ packHash: row.packHash, revision: row.revision, stepStatus: snap.stepStatus, useStatus: snap.useStatus }) };
    });
  }

  // ---------- activity (real MCP calls, server-recorded; outside workspace transactions) ----------
  async logActivity(e: { runId: string | null; tool: string; correlationId: string | null; status: string; summary: string; input: unknown; trace: unknown; durationMs: number }) {
    const pk = wsPk(this.ws), seq = await this.kv.incr({ pk, sk: 'ACTSEQ' });
    await this.kv.write([{ put: { pk, sk: K.activity(seq), seq, ...e, input: e.input ?? null, trace: e.trace ?? null, at: this.now() } }]);
  }
  async activity(runId?: string, after = 0) {
    const rows = await this.kv.query(wsPk(this.ws), { prefix: 'ACT#', after: after > 0 ? K.activity(after) : undefined });
    return rows.filter((r) => !runId || r.runId === runId).map((r) => ({
      id: `act_${r.seq}`, seq: r.seq as number, channel: 'mcp' as const, name: r.tool as string, correlationId: r.correlationId as string | null,
      status: r.status as string, summary: r.summary as string, input: r.input as unknown,
      trace: r.trace ? (r.trace as unknown) : undefined, durationMs: r.durationMs as number, at: r.at as string,
    }));
  }
}

/** A refusal's "why" reads the plans for the recipe as it is now: re-bound plans and their coverage replace the frozen ones
 *  for the target, and uses an accepted change introduced resolve against the current recipe. */
function whyPack(pack: RecipePack, now: Recipe, res: EvaluationResult): RecipePack {
  if (!res.rebound) return now === pack.recipe ? pack : { ...pack, recipe: now };
  const t = res.target?.useId;
  return { ...pack, recipe: now, coverage: [...pack.coverage.filter((c) => c.targetUseId !== t), ...res.rebound.coverage],
    bindings: [...pack.bindings.filter((b) => b.targetUseId !== t || b.card), ...res.rebound.bindings] };
}

/** Which earlier changes this one builds on: it replaces or removes a use one of them introduced, or edits a step one of them
 *  changed. Read from the recipe's own records (use origins, the amendments' changed steps); bounded by MAX_CHANGES_PER_RUN. */
export function dependsOn(before: Recipe, ops: import('../contract/types.ts').Op[], changedSteps: Id[], earlier: AmendmentItem[]): NonNullable<AmendmentItem['dependsOn']> {
  const out: NonNullable<AmendmentItem['dependsOn']> = [];
  const add = (amendmentId: string, relation: 'REPLACES_INTRODUCED' | 'SHARES_STEP') => { if (!out.some((d) => d.amendmentId === amendmentId && d.relation === relation)) out.push({ amendmentId, relation }); };
  for (const op of ops) {
    if (op.op !== 'REPLACE_USE' && op.op !== 'REMOVE_USE') continue;
    const o = before.uses.find((u) => u.useId === op.useId)?.origin;
    const a = o && earlier.find((x) => x.fromVersion === o.fromVersion);
    if (a) add(a.amendmentId, 'REPLACES_INTRODUCED');
  }
  for (const a of earlier) if (a.changedStepIds.some((s) => changedSteps.includes(s))) add(a.amendmentId, 'SHARES_STEP');
  return out;
}

/** What import_recipe reports for a job: never `imported` before the reading has finished and its draft exists. */
function importResult(job: ImportJob, draft: WireDraft | null) {
  const outcome = job.state === 'failed' ? 'failed' as const : job.state === 'needsChoice' ? 'needsChoice' as const : job.state === 'queued' || job.state === 'running' || !draft ? 'importing' as const : 'imported' as const;
  const content = draft?.content;
  return {
    outcome, job, draft: outcome === 'imported' && draft ? {
      draftId: draft.id, revision: draft.revision, title: content?.title ?? null, saved: false, blockers: draft.blockers.map((b) => b.message),
      steps: content?.steps.length ?? 0,
      uses: content?.ingredients.flatMap((i) => i.uses.map((u) => ({
        ingredient: i.name, step: content.steps.find((s) => s.id === u.stepId)?.ordinal ?? null, swap: u.swap.kind, text: u.swap.text, label: u.swap.label ?? null, analysis: u.analysis?.status ?? null,
      }))) ?? [],
    } : null,
    next: outcome === 'importing'
      ? 'Reading in the background; nothing is finished yet. Call import_recipe again with the same commandId and source for its current state (that never starts a second reading). The draft will be unsaved: the cook reviews and saves it in the companion.'
      : outcome === 'needsChoice' ? `The document holds ${job.choices?.length ?? 'several'} recipes (${(job.choices ?? []).map((c) => c.title).join('; ')}); none was read. The cook chooses one in the companion, and only that one is read.`
      : outcome === 'failed' ? (job.canRetry ? 'Nothing was imported yet. The cook can retry this same import in the companion; nothing that finished is read again.' : 'Nothing was imported. Try a different file or paste the recipe text, with a new commandId.')
        : 'This is an unsaved draft. Review it and save it from the companion; importing never saves, reviews or releases a recipe.',
  };
}
