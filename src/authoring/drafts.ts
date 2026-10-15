// Authoring (ESOD §3.2, §8.5): import jobs, append-only draft bodies, per-use requirements, save → compile → recipe version.
// Owner decision 2026-10-02: no cook confirmation. Kinds and techniques count only when code corroborates the reading, and
// source-verified amounts suffice. Every use's role and swap plan come from its validated import-time swap card; the role
// table is a cross-check (a card's roles that match it count as reviewed). Saving never reviews or releases.
// Lambda deployment (2026-10-09): a workspace's drafts live in its partition (kv.ts). An import job is a durable record:
// created queued, then claimed (queued → running, once) by whoever runs it — this process locally, the worker function on
// Lambda — so the reading survives the HTTP request that started it. A job whose runner is gone past its deadline reads as
// failed ("Reading was interrupted"), and a late claim of it is refused; nothing is retried automatically.
import { randomUUID } from 'node:crypto';
import type { CoverageEntry, Id, MissingFact, Provenance, Recipe, RecipePack, RoleTable, Vocabulary } from '../contract/types.ts';
import { compile } from '../compile/binder.ts';
import { addCards, checkCards, refsOf, repairRequests, type CheckedCards, type Refs, type RepairRound } from '../compile/cards.ts';
import { coverageSummary, recipeContent, type RecipeBookEntry, type RecipeContent } from '../contract/project.ts';
import { hash } from '../domain/rational.ts';
import { amountDisplay, getIngredient, getStep, getUse, parseAmount, renderStep } from '../domain/recipe.ts';
import { bareName, functionLabel, kindByName, kindNames, normName, sameSet, settled } from '../domain/vocabulary.ts';
import { pinOf, staticKnowledge, KnowledgeUnavailable, type Content, type Knowledge } from '../service/content.ts';
import { K } from '../service/commands.ts';
import { pad, tx, type Kv, type Meta, type Tx } from '../service/kv.ts';
import { buildDraft, methodCoverage, promptIdentity, type DraftBody, type Extractor, type Issue, type RecipeChoice, type SourceRef } from './extract.ts';
import { cookQuestions, type CookQuestion } from './confirmations.ts';
import { mergeOcr, ocrInputKey, ocrToken, OCR_ENGINE, type Ocr, type OcrPage } from './ocr.ts';
import { needsRecognition, readPastedText, readPdf, type SourcePage, type SourceText } from './source.ts';
import { batchMessage, offAnalyzer, repairMessage, repairPromptIdentity, swapMessageV3, swapPromptIdentity, swapUserMessage, type RepairRequest, type SwapAnalyzer } from './swap-analysis.ts';

export type Release = RecipeBookEntry['release'];
type Subject = { kind: 'INGREDIENT' | 'STEP' | 'USE'; id: Id };
type Predicate = 'KIND' | 'FUNCTIONS' | 'TECHNIQUE' | 'AMOUNT' | 'CHOICE';
interface FactItem { factId: string; draftId: string; subjectKind: Subject['kind']; subjectId: string; coreHash: string; predicate: Predicate; value: unknown; status: 'CONFIRMED' | 'REVIEWED'; by: 'COOK' | 'OWNER'; reviewer: string | null; at: string; retiredAt: string | null; v?: number }
/** `retryable`: the same job may be run again (retryImport): a busy service, an interruption or a failed call, never a finding. */
export interface FailureJson { code: 'NO_RECIPE_FOUND' | 'NOT_A_PDF' | 'UNREADABLE' | 'TOO_LARGE' | 'INTERNAL' | 'BUSY' | 'MULTIPLE_RECIPES' | 'LIVE_EXTRACTION_REQUIRED' | 'BUDGET_EXCEEDED'; message: string; retryable?: boolean }
export type ImportStage = 'reading' | 'recipeFound' | 'ingredientsAndSteps' | 'uses' | 'proposedFunctions' | 'coverage';
/** `needsChoice`: the document holds several recipes (`choices`); nothing is read until the cook chooses one (chooseRecipe). */
export interface ImportJob { id: Id; draftId: Id; sourceDocId: Id; state: 'queued' | 'running' | 'needsChoice' | 'succeeded' | 'partial' | 'failed'; stagesCompleted: ImportStage[]; failure: FailureJson | null;
  choices?: { index: number; title: string }[];
  /** runs of this job so far, and whether another may be started (a retryable failure, or alternatives left unchecked) */
  attempt?: number; canRetry?: boolean }
export interface WireSourceDoc { id: Id; kind: 'pdf' | 'pastedText'; origin: 'upload' | 'cookPasted'; displayName: string; pageCount: number | null; pages: { index: number; readable: 'text' | 'ocr' | 'image' }[]; byteSize: number }
/** `chooseOption`: the line offers a choice whose amounts differ (2026-10-13): the cook chooses before the recipe can be started.
 *  `unclearLine`: a printed "or" CourseCorrect couldn't place: never guessed; paste the ingredient list as text to read it again. */
export interface Blocker { id: string; kind: 'missingSteps' | 'chooseOption' | 'unclearLine'; message: string;
  resolution: { action: 'appendText'; label: string } | { action: 'choose'; label: string; ingredientId: Id; options: { index: number; text: string }[] } | null }
export interface WireDraft { id: Id; revision: number; sourceDocIds: Id[]; content: RecipeContent | null; blockers: Blocker[]; issues: Issue[]; savedAs: { recipeId: Id; recipeVersionId: string; draftRevision: number } | null; sourceRefs: Record<Id, SourceRef | null>;
  /** Uses whose alternatives weren't checked (the analysis call failed, was busy, or ran out of time): never shown as checked.
   *  `jobId` + canRetry: POST /imports/:jobId/retry checks just those again (the reading is kept). */
  unchecked: { uses: number; reason: string; jobId: Id; canRetry: boolean } | null;
  /** Facts about this recipe the cook can confirm to let a reviewed change apply (confirmations.ts); empty when none would. */
  questions: CookQuestion[] }
export class Conflict extends Error {}
export class NotFound extends Error {}

const FAILURE_MESSAGES: Record<string, string> = {
  NOT_A_PDF: "That file isn't a PDF.", TOO_LARGE: 'That file is too large.', EMPTY: "That file is empty.", ENCRYPTED: "That PDF is password-protected.",
  TOO_MANY_PAGES: 'That PDF has too many pages.', UNREADABLE: "We couldn't read that file.", NOT_UTF8: "That text couldn't be read.",
  NEEDS_TEXT_RECOGNITION: "The recipe in that PDF isn't readable text (it may be a scan or a picture). Paste the recipe text instead.",
  OCR_FAILED: "The recipe in that PDF isn't readable text, and reading it as an image didn't work. Paste the recipe text instead.",
  NO_RECIPE_FOUND: "We couldn't find a recipe in that document.",
};
const INTERRUPTED: FailureJson = { code: 'INTERNAL', message: 'Reading was interrupted. Try again.', retryable: true };
const BUSY: FailureJson = { code: 'BUSY', message: 'The recipe reader is busy right now. Try again in a minute; nothing is read twice.', retryable: true };

// ---------- items in the workspace partition ----------
interface SourceItem { sourceId: string; sha256: string; kind: 'PDF' | 'TEXT'; origin: 'UPLOAD' | 'COOK_PASTED'; displayName: string; byteLength: number; text: SourceText; createdAt: string;
  /** Pages need recognition and the PDF is held for OCR under this key until the import reads it (ocr.ts). */
  ocr?: { key: string } }
/** One OCR reading of a document (by its hash): reused by every import of the same PDF in this workspace. Immutable. */
interface OcrItem { sha256: string; engine: string; jobId: string; billedPages: number; pages: OcrPage[]; at: string }
interface DraftItem { draftId: string; recipeId: string; revision: number; bodyRevision: number; createdAt: string; sources: { sourceId: string; origin: 'UPLOAD' | 'COOK_PASTED' }[]; jobIds: string[]; savedAs: WireDraft['savedAs']; v?: number;
  /** The knowledge release this import is read, checked, compiled and saved with (the ACTIVE one when it was created; 2026-10-11).
   *  Absent on drafts created before releases: they use the ACTIVE release, and the pack records the one its plans came from. */
  knowledgeReleaseId?: string }
interface JobItem { jobId: string; draftId: string; idempotencyKey: string | null; state: ImportJob['state']; stages: ImportStage[]; failure: FailureJson | null; createdAt: string; claim: string | null; owner: string | null; claimedAt: string | null; v?: number;
  /** runs claimed (absent: 1); the extraction this job read (a retry never reads it again); the recipes found and the cook's choice */
  attempt?: number; extractionId?: string; choices?: RecipeChoice[]; choice?: number; /** when it was last queued (a retry, a choice) */ queuedAt?: string }
/** One swap analysis of a reading. A recipe with more than BATCH_USES uses is analysed in batches (each with the whole recipe as
 *  context, asked for its own uses only); `raw` holds the cards of every batch that answered; status SUCCEEDED when all did,
 *  PARTIAL when some did (the others are named in `batches` and can be run again), FAILED_CALL:<error> when none did. */
interface AnalysisItem { analysisId: string; extractionId: string; analyzer: string; promptHash: string; inputHash: string; status: string; raw: unknown; refs: Refs; issues: unknown; inputTokens: number | null; outputTokens: number | null; costUsd: number; createdAt: string;
  batches?: AnalysisBatch[] }
interface AnalysisBatch { refs: string[]; status: string; raw: unknown; inputTokens: number | null; outputTokens: number | null; costUsd: number; attempts: number }
interface RepairItem { repairId: string; analysisId: string; analyzer: string; promptHash: string; inputHash: string; status: string; requested: RepairRound['requested']; raw: unknown; inputTokens: number | null; outputTokens: number | null; costUsd: number; createdAt: string; owner: string; v?: number }
interface SavedItem { recipeId: string; versionId: string; packHash: string; draftId: string; draftRevision: number; idempotencyKey: string | null; release: Release; seq: number; at: string; v?: number; knowledgeReleaseId?: string }
const D = {
  source: (s: string) => `SRC#${s}`, draft: (d: string) => `DR#${d}`, body: (d: string, r: number) => `DR#${d}#B#${pad(r)}`, facts: (d: string) => `DR#${d}#F#`,
  fact: (d: string, at: string, f: string) => `DR#${d}#F#${at}#${f}`, extraction: (d: string, e: string) => `DR#${d}#EX#${e}`, analysis: (d: string, e: string) => `DR#${d}#SA#${e}`,
  repair: (a: string) => `SR#${a}`, job: (j: string) => `JOB#${j}`, importKey: (k: string) => `IDEM#IMPORT#${k}`, saveKey: (k: string) => `IDEM#SAVE#${k}`,
  saved: (r: string, v: string) => `SAVED#${r}#${v}`, ocr: (sha: string) => `OCR#${sha}`, ocrAttempt: (d: string, s: string) => `DR#${d}#OCR#${s}`,
};

/** How long a queued job may wait for its runner, and how long a claimed one may run (the worker function's timeout is 600 s). */
export const JOB_LIMITS = { queuedMs: 11 * 60_000, runningMs: 11 * 60_000 } as const;
/**
 * Import reliability (commission 2026-10-13). A paid call refused as busy is tried again after a pause, at most `attempts` times in
 * one run, each attempt reserved on its own; a run starts no paid call it can't finish inside `workMs` (the worker's 600 s, less
 * margin), leaving it for a retry. A job may be run at most `runs` times (the first run and two retries); a retry repeats only the
 * stages that didn't finish (the reading, the analysis batches without an answer), never a finished one.
 */
export const RELIABILITY = { attempts: 3, pauseMs: [4_000, 12_000], workMs: 540_000, runs: 3 };   // ponytail: mutable so tests can shorten the pauses
/** Uses per swap-analysis call: a larger recipe is analysed in batches (Butter Chicken's 33 uses ended in malformed_tool_use once). */
export const BATCH_USES = 12;

export interface AuthoringOptions {
  kv: Kv; ws?: string; extractor: Extractor; analyzer?: SwapAnalyzer; now?: () => string; newId?: (p: string) => string;
  /** Text recognition for pages without readable text (deployed: Textract). Absent: such pages ask the cook to paste. */
  ocr?: Ocr;
  /** The knowledge releases (storeKnowledge on the deployed service), or one release as `content` (tests). */
  knowledge?: Knowledge; content?: Content;
  /** Start a queued job. Default: run it in this process. On Lambda: an asynchronous invocation of the worker function. */
  dispatch?: (ws: string, jobId: Id) => Promise<void>;
}

export class Authoring {
  readonly kv: Kv; readonly ws: string; readonly knowledge: Knowledge; extractor: Extractor; analyzer: SwapAnalyzer; readonly ocr: Ocr | null;
  private readonly now: () => string; private readonly newId: (p: string) => string;
  private readonly dispatch: (ws: string, jobId: Id) => Promise<void>;
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(o: AuthoringOptions) {
    if (!o.knowledge && !o.content) throw new Error('Authoring needs knowledge (or one release as content)');
    this.kv = o.kv; this.ws = o.ws ?? 'kitchen'; this.knowledge = o.knowledge ?? staticKnowledge(o.content!); this.extractor = o.extractor;
    this.analyzer = o.analyzer ?? offAnalyzer;   // no analyzer: every use fails closed ("not checked yet")
    this.ocr = o.ocr ?? null;
    this.now = o.now ?? (() => new Date().toISOString());
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.dispatch = o.dispatch ?? (async (_ws, jobId) => { this.running.set(jobId, this.runJob(jobId)); });
  }
  /** The release a draft is pinned to (legacy drafts: the active one). Throws KnowledgeUnavailable: never other knowledge. */
  private async k(t: Tx, draftId: Id): Promise<Content> {
    const id = (await this.draftItem(t, draftId)).knowledgeReleaseId;
    return id ? this.knowledge.get(id) : this.knowledge.active();
  }
  private async kOf(draftId: Id) { return this.tx((t) => this.k(t, draftId)); }
  /** A saved pack's release for display (labels and plan summaries); ids only if it can't be read. */
  private async packContent(pack: RecipePack): Promise<{ v: Vocabulary; patterns: Content['patterns'] }> {
    const pin = await pinOf(this.knowledge, pack);
    try { if (pin.releaseId) { const c = await this.knowledge.get(pin.releaseId); return { v: c.vocab, patterns: c.patterns }; } }
    catch (e) { if (!(e instanceof KnowledgeUnavailable)) throw e; }
    return { v: { schema: 'cc-vocabulary/1', version: 0, functions: [], techniques: [], classes: [], kinds: [] }, patterns: [] };
  }
  private tx<T>(fn: (t: Tx, meta: Meta) => Promise<T>) { return tx(this.kv, this.ws, fn); }
  private since(at: string) { return Date.parse(this.now()) - Date.parse(at); }

  // ---------- import ----------
  /** `upload` re-reads nothing: it starts a new draft from a source an earlier upload stored (its opaque sourceDocId). */
  async createImport(input: { kind: 'pdf'; bytes: Uint8Array; filename: string } | { kind: 'text'; text: string; title?: string } | { kind: 'upload'; sourceDocId: Id }, idempotencyKey?: string)
    : Promise<{ status: 202; job: ImportJob; draftId: Id } | { status: 400 | 404 | 413 | 503; error: { code: string; message: string } }> {
    if (idempotencyKey) {
      const prior = await this.tx(async (t) => (await t.get<{ jobId: string }>(D.importKey(idempotencyKey)))?.jobId);
      if (prior) { const j = await this.job(prior); return { status: 202, job: j, draftId: j.draftId }; }
    }
    let uploaded: SourceItem | undefined;
    if (input.kind === 'upload') {
      uploaded = await this.tx(async (t) => t.fixed<SourceItem>(D.source(input.sourceDocId)));
      if (!uploaded || uploaded.origin !== 'UPLOAD') return { status: 404, error: { code: 'UNKNOWN_UPLOAD', message: 'No uploaded file with that handle.' } };
    }
    const read: Awaited<ReturnType<typeof readPdf>> = uploaded ? { ok: true, source: uploaded.text }
      : input.kind === 'pdf' ? await readPdf(input.bytes) : readPastedText(new TextEncoder().encode((input as { text: string }).text));
    if (!read.ok && (read.code === 'NOT_A_PDF' || read.code === 'TOO_LARGE' || read.code === 'EMPTY')) {
      return { status: read.code === 'TOO_LARGE' ? 413 : 400, error: { code: read.code, message: FAILURE_MESSAGES[read.code] } };
    }
    const ocrKey = uploaded ? uploaded.ocr?.key ?? null : read.ok && input.kind === 'pdf' ? await this.stashForOcr(read.source, input.bytes) : null;
    let knowledgeReleaseId: string;   // pinned now: a release published while this import is read or reviewed never changes it
    try { knowledgeReleaseId = (await this.knowledge.active()).releaseId; }
    catch (e) { if (e instanceof KnowledgeUnavailable) return { status: 503, error: { code: 'KNOWLEDGE_UNAVAILABLE', message: "Importing isn't available: no published knowledge release can be read on this server." } }; throw e; }
    const draftId = this.newId('dr'), jobId = this.newId('job');
    const recipeId = `rcp_${hash(draftId).slice(0, 10)}`;
    const created = await this.tx(async (t) => {
      if (idempotencyKey) {   // the same key raced: the first commit wins, the other returns its job
        const prior = await t.get<{ jobId: string }>(D.importKey(idempotencyKey));
        if (prior) return prior.jobId;
        t.put(D.importKey(idempotencyKey), { jobId });
      }
      const sources: DraftItem['sources'] = [];
      if (read.ok) sources.push({ sourceId: uploaded?.sourceId ?? this.addSource(t, read.source, input.kind === 'pdf' ? 'PDF' : 'TEXT', 'UPLOAD', input.kind === 'pdf' ? input.filename : 'pasted text', ocrKey), origin: 'UPLOAD' });
      t.put(D.draft(draftId), { draftId, recipeId, revision: 0, bodyRevision: 0, createdAt: this.now(), sources, jobIds: [jobId], savedAs: null, knowledgeReleaseId } satisfies DraftItem);
      const failure: FailureJson | null = read.ok
        ? (read.source.status === 'NEEDS_TEXT_RECOGNITION' && !ocrKey ? { code: 'UNREADABLE', message: FAILURE_MESSAGES.NEEDS_TEXT_RECOGNITION } : null)
        : { code: 'UNREADABLE', message: FAILURE_MESSAGES[read.code] ?? read.detail };
      t.put(D.job(jobId), { jobId, draftId, idempotencyKey: idempotencyKey ?? null, state: failure ? 'failed' : 'queued', stages: failure ? [] : ['reading'], failure, createdAt: this.now(), claim: null, owner: null, claimedAt: null } satisfies JobItem);
      return jobId;
    });
    if (created !== jobId) { const j = await this.job(created); return { status: 202, job: j, draftId: j.draftId }; }
    const accepted = await this.job(jobId);   // the job as accepted; its runner reports progress on GET /imports/:id
    await this.start(jobId);
    return { status: 202, job: accepted, draftId };
  }
  /** Hand a queued job to its runner. If it can't be handed over, it fails now (never left queued, never retried). */
  private async start(jobId: Id) {
    if ((await this.job(jobId)).state !== 'queued') return;
    try { await this.dispatch(this.ws, jobId); }
    catch (e) {
      console.error(`import dispatch failed: ${(e as Error).name}: ${(e as Error).message}`.slice(0, 300));
      await this.tx(async (t) => { const j = (await t.get<JobItem>(D.job(jobId)))!; if (j.state === 'queued') t.put(D.job(jobId), { ...j, state: 'failed', failure: { code: 'INTERNAL', message: "Reading couldn't start. Try again." } }); });
    }
  }

  /**
   * Run one queued job (this process, or the worker function). The claim is one transaction: only a queued job inside its
   * deadline becomes running, so a duplicate delivery or a late one does nothing. Model calls happen only after the claim.
   */
  async runJob(jobId: Id): Promise<'ran' | 'notQueued'> {
    const claim = this.newId('claim'), started = Date.now();
    const job = await this.tx(async (t) => {
      const j = await t.get<JobItem>(D.job(jobId));
      if (!j || j.state !== 'queued' || this.since(j.queuedAt ?? j.createdAt) > JOB_LIMITS.queuedMs) return null;
      t.put(D.job(jobId), { ...j, state: 'running', stages: j.extractionId ? j.stages : ['reading'], claim, owner: this.kv.owner, claimedAt: this.now() });
      return j;
    });
    if (!job) return 'notQueued';
    await this.runExtraction(jobId, job, claim, started + RELIABILITY.workMs);
    return 'ran';
  }

  /** The cook's choice of one recipe on a document that holds several: the same job reads that recipe's lines only. */
  async chooseRecipe(jobId: Id, index: number): Promise<ImportJob> {
    await this.tx(async (t) => {
      const j = await t.get<JobItem>(D.job(jobId));
      if (!j) throw new NotFound(jobId);
      if (j.state !== 'needsChoice' || !Number.isInteger(index) || !j.choices?.[index]) throw new Conflict('NO_CHOICE_PENDING');
      t.put(D.job(jobId), { ...j, state: 'queued', choice: index, queuedAt: this.now(), claim: null, owner: null, claimedAt: null });
    });
    await this.start(jobId);
    return this.job(jobId);
  }
  /** Run the same job again (never a second job): only what didn't finish (the reading, or the analysis batches without an
   *  answer). Refused while it runs, when nothing can be retried, and after RELIABILITY.runs runs. Each paid call is reserved anew. */
  async retryImport(jobId: Id): Promise<ImportJob> {
    await this.tx(async (t) => {
      const j = await t.get<JobItem>(D.job(jobId));
      if (!j) throw new NotFound(jobId);
      const view = await this.jobIn(t, jobId);
      if (!view.canRetry) throw new Conflict(view.state === 'queued' || view.state === 'running' ? 'JOB_RUNNING' : (j.attempt ?? 1) >= RELIABILITY.runs ? 'RETRY_LIMIT' : 'NOTHING_TO_RETRY');
      t.put(D.job(jobId), { ...j, state: 'queued', failure: null, attempt: (j.attempt ?? 1) + 1, queuedAt: this.now(), claim: null, owner: null, claimedAt: null });
    });
    await this.start(jobId);
    return this.job(jobId);
  }

  /**
   * One paid call, tried again when the service answers busy (THROTTLED), at most RELIABILITY.attempts times with a growing
   * pause; every attempt is reserved under its own ledger key. Null: this run has no time left to start (or wait for) it.
   */
  private async paid<R extends { ok: boolean }>(deadline: number, needMs: number, call: (key: string) => Promise<R>): Promise<{ r: R; attempts: number } | null> {
    for (let a = 1; ; a++) {
      if (Date.now() + needMs > deadline) return null;
      const r = await call(this.newId('call'));
      if (r.ok || (r as { error?: string }).error !== 'THROTTLED' || a >= RELIABILITY.attempts) return { r, attempts: a };
      const pause = RELIABILITY.pauseMs[a - 1] * (1 + Math.random() / 2);   // jitter: two workers busy at once don't retry together
      if (Date.now() + pause + needMs > deadline) return { r, attempts: a };
      await new Promise((ok) => setTimeout(ok, pause));
    }
  }

  /** Store an uploaded PDF without reading a recipe from it; its id is the opaque handle `import_recipe` takes. */
  async upload(bytes: Uint8Array, filename: string): Promise<{ status: 201; sourceDocId: Id } | { status: 400 | 413; error: { code: string; message: string } }> {
    const read = await readPdf(bytes);
    if (!read.ok) return { status: read.code === 'TOO_LARGE' ? 413 : 400, error: { code: read.code, message: FAILURE_MESSAGES[read.code] ?? read.detail } };
    const ocrKey = await this.stashForOcr(read.source, bytes);
    return { status: 201, sourceDocId: await this.tx(async (t) => this.addSource(t, read.source, 'PDF', 'UPLOAD', filename, ocrKey)) };   // a scan still stores; without OCR its import then fails as unreadable
  }
  /** A PDF with pages that need recognition is held for OCR (when this server has it). The same PDF has the same key. */
  private async stashForOcr(src: SourceText, bytes: Uint8Array): Promise<string | null> {
    if (!this.ocr || !src.pages.some(needsRecognition)) return null;
    const key = ocrInputKey(this.ws, src.sha256);
    await this.ocr.stash(key, bytes);
    return key;
  }

  private addSource(t: Tx, src: SourceText, kind: 'PDF' | 'TEXT', origin: 'UPLOAD' | 'COOK_PASTED', displayName: string, ocrKey: string | null = null): Id {
    const id = this.newId('src');
    t.put(D.source(id), { sourceId: id, sha256: src.sha256, kind, origin, displayName, byteLength: src.byteLength, text: src, createdAt: this.now(), ...(ocrKey ? { ocr: { key: ocrKey } } : {}) } satisfies SourceItem);
    return id;
  }

  /**
   * OCR for the draft's held PDFs (in the claimed job, before the reading): once per document per workspace (a stored
   * result is reused), the PDF deleted when reading ends, every attempt recorded on the draft. A failure leaves those pages
   * unreadable: the reading goes ahead on the rest, and the cook is asked to paste what's missing.
   */
  private async recognize(draftId: Id, jobId: Id) {
    if (!this.ocr) return;
    const items = await this.tx(async (t) => {
      const d = await this.draftItem(t, draftId);
      const xs = await Promise.all(d.sources.map((s) => t.must<SourceItem>(D.source(s.sourceId))));
      return Promise.all(xs.filter((x) => x.ocr).map(async (x) => ({ x, have: !!(await t.get<OcrItem>(D.ocr(x.sha256))) })));
    });
    for (const { x, have } of items) {
      if (have) { await this.ocr.discard(x.ocr!.key).catch(() => undefined); continue; }   // read before: this upload's copy isn't kept either
      const r = await this.ocr.read(x.ocr!.key, { pages: x.text.pages.length, token: ocrToken(this.ws, x.sha256), ledgerKey: `ocr:${jobId}:${x.sha256.slice(0, 12)}`, label: `ocr ${draftId}` })
        .catch((e: Error) => ({ ok: false as const, error: 'FAILED' as const, detail: e.message.slice(0, 200) }));
      await this.ocr.discard(x.ocr!.key).catch((e: Error) => console.error(`ocr: could not delete ${x.ocr!.key}: ${e.name}`));   // the lifecycle rule is the backstop
      await this.tx(async (t) => {
        if (r.ok && !(await t.get(D.ocr(x.sha256)))) t.put(D.ocr(x.sha256), { sha256: x.sha256, engine: OCR_ENGINE, jobId: r.jobId, billedPages: r.billedPages, pages: r.pages, at: this.now() } satisfies OcrItem);
        t.put(D.ocrAttempt(draftId, x.sourceId), { jobId, engine: this.ocr!.name, status: r.ok ? 'SUCCEEDED' : r.error, detail: r.ok ? null : r.detail, billedPages: r.ok ? r.billedPages : null, at: this.now() });
      });
    }
  }
  private async draftItem(t: Tx, draftId: Id) { const d = await t.get<DraftItem>(D.draft(draftId)); if (!d) throw new NotFound(draftId); return d; }
  private async draftSources(t: Tx, draftId: Id) {
    const d = await this.draftItem(t, draftId);
    return Promise.all(d.sources.map(async (s) => {
      const r = await t.must<SourceItem>(D.source(s.sourceId));
      const o = r.ocr ? await t.get<OcrItem>(D.ocr(r.sha256)) : undefined;   // native text first: OCR only where a page needs it
      return { sourceId: s.sourceId, origin: s.origin, text: o ? { ...r.text, pages: mergeOcr(r.text.pages, o.pages) } : r.text, kind: r.kind, displayName: r.displayName, byteLength: r.byteLength };
    }));
  }
  /** Update the job this runner claimed (nothing, if it is no longer that claim's running job). */
  private updateJob(jobId: Id, claim: string, patch: Partial<JobItem>) {
    return this.tx(async (t) => { const j = (await t.get<JobItem>(D.job(jobId)))!; if (j.state === 'running' && j.claim === claim) t.put(D.job(jobId), { ...j, ...patch }); });
  }

  /** The reading (once per job: a retry reuses a finished one), then the swap analysis and coverage. */
  private async runExtraction(jobId: Id, job: JobItem, claim: string, deadline: number) {
    const draftId = job.draftId, stages: ImportStage[] = ['reading'];
    const fail = (f: FailureJson) => this.updateJob(jobId, claim, { state: 'failed', failure: f, stages: [...stages] });
    try {
      const k = await this.kOf(draftId), v = k.vocab;   // before any model call: an unreadable release fails the job, nothing is spent
      let body = job.extractionId ? await this.tx(async (t) => { const b = await this.body(t, draftId); return b?.extractionId === job.extractionId ? b : null; }) : null;
      if (!body) {
        await this.recognize(draftId, jobId);
        let srcs = (await this.tx((t) => this.draftSources(t, draftId))).map((s) => ({ sourceId: s.sourceId, origin: s.origin, pages: s.text.pages.filter((p) => p.status === 'TEXT') as SourcePage[] }));
        const span = job.choices && job.choice !== undefined ? spanOf(srcs, job.choices, job.choice) : null;
        if (span) srcs = srcs.map((s) => ({ ...s, pages: s.pages.map((p) => ({ ...p, lines: p.lines.filter((l) => span.has(l.lineId)) })).filter((p) => p.lines.length) }));
        if (!srcs.some((s) => s.pages.length)) return await fail({ code: 'UNREADABLE', message: FAILURE_MESSAGES.OCR_FAILED });
        const extractionId = this.newId('ex');
        const p = await this.paid(deadline, 100_000, (key) => this.extractor.extract(srcs.flatMap((s) => s.pages), v, key, `import ${draftId}`));
        if (!p) return await fail(BUSY);
        const r = p.r;
        const recipeId = (await this.tx((t) => this.draftItem(t, draftId))).recipeId;
        const built = r.ok ? buildDraft(r.raw, v, srcs, recipeId, extractionId, r.extractor) : null;
        // a reading that fails its schema or references was cut off at the output limit (TRUNCATED) or is malformed (MALFORMED)
        const diagnosis = r.ok && !built!.ok && (built!.code === 'SCHEMA' || built!.code === 'REFERENCE') ? (r.stopReason === 'max_tokens' ? 'TRUNCATED' : 'MALFORMED') : null;
        await this.tx(async (t) => t.put(D.extraction(draftId, extractionId), {
          extractionId, jobId, extractor: r.extractor, promptHash: (r.ok && r.promptHash) || promptIdentity(v),
          status: !r.ok ? `FAILED_CALL:${r.error}` : built!.ok ? 'SUCCEEDED' : `FAILED_VALIDATION:${built!.code}`, raw: r.ok ? r.raw : null,
          issues: !r.ok ? [{ code: r.error, detail: r.detail }] : built!.ok ? built!.body.issues : built!.issues,
          inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null, costUsd: r.costUsd, createdAt: this.now(), attempts: p.attempts,
          ...(r.ok && r.stopReason ? { stopReason: r.stopReason } : {}), ...(diagnosis ? { diagnosis } : {}), ...(span ? { recipeChoice: job.choice } : {}),
        }));
        if (!r.ok) {
          if (r.error === 'THROTTLED') return await fail(BUSY);
          const known = r.error === 'LIVE_EXTRACTION_REQUIRED' || r.error === 'BUDGET_EXCEEDED';
          return await fail({ code: known ? r.error as FailureJson['code'] : 'INTERNAL', message: r.detail, ...(known ? {} : { retryable: true }) });
        }
        if (!built!.ok && built!.code === 'MULTIPLE_RECIPES') {
          if (built!.choices && !span) { stages.push('recipeFound'); return await this.updateJob(jobId, claim, { state: 'needsChoice', choices: built!.choices, stages: [...stages] }); }
          return await fail({ code: 'MULTIPLE_RECIPES', message: 'This document seems to hold more than one recipe, and they couldn’t be told apart. Paste the one recipe you want as text.' });
        }
        if (!built!.ok) return await fail(built!.code === 'NO_RECIPE_FOUND' ? { code: 'NO_RECIPE_FOUND', message: FAILURE_MESSAGES.NO_RECIPE_FOUND }
          : diagnosis === 'TRUNCATED' ? { code: 'INTERNAL', message: 'This recipe is too long to read in one pass (the reading was cut off). Paste the part you need as text.' }
            : { code: 'INTERNAL', message: `The reading failed validation (${built!.code}${diagnosis ? `, ${diagnosis.toLowerCase()}` : ''}).` });
        const b = { ...built!.body, ...(span ? { span: [...span] } : {}) };
        await this.tx((t) => this.addBody(t, draftId, b, 'EXTRACTOR'));
        await this.updateJob(jobId, claim, { extractionId });
        body = b;
      }
      stages.push('recipeFound', 'ingredientsAndSteps', 'uses');
      await this.updateJob(jobId, claim, { stages: [...stages] });
      await this.runAnalysis(draftId, body, k, deadline);
      stages.push('proposedFunctions');
      await this.updateJob(jobId, claim, { stages: [...stages] });
      const blocked = await this.tx(async (t) => { await this.coverageIn(t, draftId); return (await this.blockers(t, draftId)).length > 0; });   // the coverage stage actually ran
      stages.push('coverage');
      await this.updateJob(jobId, claim, { state: blocked ? 'partial' : 'succeeded', stages: [...stages] });
    } catch (e) {
      await fail({ code: 'INTERNAL', message: (e as Error).message.slice(0, 200), retryable: true }).catch(() => undefined);
    }
  }
  /** Until the job is done (or `ms` passes): its promise in this process, else its record. */
  async waitForJob(jobId: Id, ms = Infinity) {
    const end = Date.now() + ms, p = this.running.get(jobId);
    if (p) {   // no timer without a limit, and none left behind (a pending one would keep the process alive)
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([p, new Promise((ok) => { if (Number.isFinite(ms)) timer = setTimeout(ok, ms); })]);
      clearTimeout(timer);
    }
    else for (let j = await this.job(jobId); (j.state === 'queued' || j.state === 'running') && Date.now() < end; j = await this.job(jobId)) await new Promise((ok) => setTimeout(ok, 500));
    return this.job(jobId);
  }

  /** Swap analysis over the reading as read, in batches of BATCH_USES uses (one call for a smaller recipe, its message unchanged).
   *  Batches that already answered are kept; the others are run (again). The raw cards are kept as evidence; validation runs on
   *  every compile. A recording may answer the same reading's message under an earlier approved vocabulary; it is stored as what it is. */
  private async runAnalysis(draftId: Id, body: DraftBody, k: Content, deadline: number) {
    const v = k.vocab;
    const [message, ...alternates] = swapMessageVariants(body, v, k.history);
    const refs = refsOf(body.recipe), groups = batchesOf(body.recipe, refs);
    const prior = await this.tx((t) => t.get<AnalysisItem>(D.analysis(draftId, body.extractionId)));
    if (prior?.status !== 'SUCCEEDED') {
      const batches: AnalysisBatch[] = groups.map((g) => prior?.batches?.find((b) => b.refs.join() === g.join() && b.status === 'SUCCEEDED')
        ?? { refs: g, status: 'NOT_RUN', raw: null, inputTokens: null, outputTokens: null, costUsd: 0, attempts: prior?.batches?.find((b) => b.refs.join() === g.join())?.attempts ?? 0 });
      let analyzer = prior?.analyzer ?? this.analyzer.name, promptHash: string | undefined, answered: string | undefined;
      for (const b of batches.filter((x) => x.status !== 'SUCCEEDED')) {
        const m = groups.length === 1 ? message : batchMessage(message, b.refs);
        const p = await this.paid(deadline, 130_000, (key) => this.analyzer.analyze(m, v, key, `swaps ${draftId}`, groups.length === 1 ? alternates : [])
          .catch((e: Error) => ({ ok: false as const, error: 'CALL_FAILED', detail: e.message.slice(0, 200), analyzer: this.analyzer.name, usage: null, costUsd: 0 })));
        if (!p) { b.status = 'NOT_RUN:NO_TIME_LEFT'; break; }
        const r = p.r;
        analyzer = r.analyzer;
        Object.assign(b, { status: r.ok ? 'SUCCEEDED' : `FAILED_CALL:${r.error}`, raw: r.ok ? r.raw : null, inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null, costUsd: b.costUsd + r.costUsd, attempts: b.attempts + p.attempts });
        if (r.ok) { promptHash = r.promptHash; answered = r.answered; }
      }
      const ok = batches.filter((b) => b.status === 'SUCCEEDED');
      const status = ok.length === batches.length ? 'SUCCEEDED' : ok.length ? 'PARTIAL' : batches.find((b) => b.status.startsWith('FAILED_CALL'))?.status ?? 'FAILED_CALL:NOT_RUN';
      const raw = batches.length === 1 ? batches[0].raw : ok.length ? { cards: ok.flatMap((b) => (b.raw as { cards?: unknown[] } | null)?.cards ?? []) } : null;
      const sum = (f: (b: AnalysisBatch) => number | null) => batches.some((b) => f(b) !== null) ? batches.reduce((x, b) => x + (f(b) ?? 0), 0) : null;
      const issues = status === 'SUCCEEDED' ? checkCards(raw, refs, body.recipe, v, null).entries.filter((e) => e.status === 'INVALID') : batches.filter((b) => b.status !== 'SUCCEEDED').map((b) => ({ code: b.status, detail: b.refs.join(', ') }));
      await this.tx(async (t) => t.put(D.analysis(draftId, body.extractionId), {
        v: (await t.get<AnalysisItem & { v?: number }>(D.analysis(draftId, body.extractionId)))?.v,   // a retry rewrites it: read in this write
        analysisId: prior?.analysisId ?? this.newId('sa'), extractionId: body.extractionId, analyzer, promptHash: promptHash || prior?.promptHash || swapPromptIdentity(v),
        inputHash: hash(answered || message), status, raw, refs, issues, inputTokens: sum((b) => b.inputTokens), outputTokens: sum((b) => b.outputTokens),
        costUsd: batches.reduce((x, b) => x + b.costUsd, 0), createdAt: prior?.createdAt ?? this.now(), ...(groups.length > 1 || prior?.batches ? { batches } : {}),
      } satisfies AnalysisItem & { v?: number }));
      if (status !== 'SUCCEEDED') return;
    }
    if (this.analyzer.repair) await this.runRepair(draftId, body, v, deadline);
  }

  /** The ONE correction round per analysis: every card the checks rejected for a reason the model can fix, unless reviewed content
   *  already decides that use; sent REPAIR_CHUNK at a time (a long list cut off the round's output). Its output is kept apart from
   *  the first round's. A use whose part of the round got no answer keeps its first card's reason. */
  private async runRepair(draftId: Id, body: DraftBody, v: Vocabulary, deadline: number) {
    const prep = await this.tx(async (t) => {
      const { pack } = await this.coverageIn(t, draftId);
      const a = (await t.must<AnalysisItem>(D.analysis(draftId, body.extractionId)));
      return { a, done: !!(await t.get<RepairItem>(D.repair(a.analysisId))), requests: pack ? repairRequests(pack, a.refs, a.raw) : [] };
    });
    if (prep.done || !prep.requests.length) return;
    const chunks = Array.from({ length: Math.ceil(prep.requests.length / REPAIR_CHUNK) }, (_x, i) => prep.requests.slice(i * REPAIR_CHUNK, (i + 1) * REPAIR_CHUNK));
    const messages = chunks.map((c) => repairMessage(body.recipe, v, c));
    const id = this.newId('sr'), sk = D.repair(prep.a.analysisId);
    await this.tx(async (t) => t.put(sk, {
      repairId: id, analysisId: prep.a.analysisId, analyzer: this.analyzer.name, promptHash: repairPromptIdentity(v), inputHash: hash(messages.join('\n')), status: 'RUNNING',
      requested: prep.requests.map(({ useRef, reason }) => ({ useRef, reason })), raw: null, inputTokens: null, outputTokens: null, costUsd: 0, createdAt: this.now(), owner: this.kv.owner,
    } satisfies RepairItem));
    const answered: RepairRequest[] = [], cards: unknown[] = [];
    let analyzer = this.analyzer.name, failure: string | null = null, inTok = 0, outTok = 0, cost = 0;
    for (const [i, m] of messages.entries()) {
      const p = await this.paid(deadline, 130_000, (key) => this.analyzer.repair!(m, v, key, `repair ${draftId}`)
        .catch((e: Error) => ({ ok: false as const, error: 'CALL_FAILED', detail: e.message.slice(0, 200), analyzer: this.analyzer.name, usage: null, costUsd: 0 })));
      if (!p) { failure ??= 'NOT_RUN:NO_TIME_LEFT'; break; }
      analyzer = p.r.analyzer; inTok += p.r.usage?.inputTokens ?? 0; outTok += p.r.usage?.outputTokens ?? 0; cost += p.r.costUsd;
      if (p.r.ok) { answered.push(...chunks[i]); cards.push(...((p.r.raw as { cards?: unknown[] } | null)?.cards ?? [])); } else failure ??= p.r.error;
    }
    await this.tx(async (t) => {
      const cur = (await t.get<RepairItem>(sk))!;
      t.put(sk, { ...cur, analyzer, status: answered.length ? 'SUCCEEDED' : `FAILED_CALL:${failure}`, requested: answered.length ? answered.map(({ useRef, reason }) => ({ useRef, reason })) : cur.requested,
        raw: answered.length ? { cards } : null, inputTokens: inTok || null, outputTokens: outTok || null, costUsd: cost });
    });
  }

  /** New body revision; facts whose subject no longer exists (by content hash) are retired, never silently re-pointed. */
  private async addBody(t: Tx, draftId: Id, body: DraftBody, author: string) {
    const d = await this.draftItem(t, draftId);
    t.put(D.body(draftId, d.bodyRevision + 1), { author, body, createdAt: this.now() });
    const cores = new Set(coreHashes(body.recipe).values());
    for (const f of await this.liveFacts(t, draftId)) if (!cores.has(f.coreHash)) t.put(f.sk, { ...f, retiredAt: this.now() });
    t.put(D.draft(draftId), { ...d, bodyRevision: d.bodyRevision + 1, revision: d.revision + 1 });
  }

  async job(jobId: Id): Promise<ImportJob> { return this.tx((t) => this.jobIn(t, jobId)); }
  /** A job whose runner is gone (another local process, or past its deadline) reads as failed: interrupted. `canRetry`: a
   *  retryable failure, or alternatives this job left unchecked, with runs to spare. */
  private async jobIn(t: Tx, jobId: Id): Promise<ImportJob> {
    const j = await t.get<JobItem>(D.job(jobId));
    if (!j) throw new NotFound(jobId);
    const d = await this.draftItem(t, j.draftId);
    const dead = (j.state === 'queued' && this.since(j.queuedAt ?? j.createdAt) > JOB_LIMITS.queuedMs)
      || (j.state === 'running' && (!this.kv.alive(j.owner!) || this.since(j.claimedAt!) > JOB_LIMITS.runningMs));
    const state = dead ? 'failed' : j.state, failure = dead ? INTERRUPTED : j.failure, attempt = j.attempt ?? 1;
    const unchecked = (state === 'succeeded' || state === 'partial') && !!j.extractionId && retryableAnalysis(await this.analysisOfBody(t, j.draftId, j.extractionId));
    return { id: j.jobId, draftId: j.draftId, sourceDocId: d.sources[0]?.sourceId ?? '', state, stagesCompleted: j.stages, failure,
      ...(j.choices && state === 'needsChoice' ? { choices: j.choices.map(({ index, title }) => ({ index, title })) } : {}),
      attempt, canRetry: attempt < RELIABILITY.runs && ((state === 'failed' && !!failure?.retryable) || unchecked) };
  }
  /** The analysis of the draft's current reading, when that reading is `extractionId`'s. */
  private async analysisOfBody(t: Tx, draftId: Id, extractionId: Id) {
    const b = await this.body(t, draftId);
    return b?.extractionId === extractionId ? t.get<AnalysisItem>(D.analysis(draftId, extractionId)) : undefined;
  }
  async getImport(jobId: Id) {
    return this.tx(async (t) => { const job = await this.jobIn(t, jobId); return { job, draft: job.state === 'failed' || job.state === 'needsChoice' || job.stagesCompleted.length < 2 ? null : await this.wireDraftIn(t, job.draftId, false) }; });   // status polls: no questions (the review reads the draft)
  }

  // ---------- effective recipe = latest body + live facts (by content hash) ----------
  private async body(t: Tx, draftId: Id): Promise<DraftBody | null> {
    const d = await t.get<DraftItem>(D.draft(draftId));
    return d && d.bodyRevision > 0 ? (await t.must<{ body: DraftBody }>(D.body(draftId, d.bodyRevision))).body : null;
  }
  private async liveFacts(t: Tx, draftId: Id) { return (await t.query<FactItem>(D.facts(draftId))).filter((f) => !f.retiredAt); }
  async revision(draftId: Id) { return this.tx((t) => this.revisionIn(t, draftId)); }
  private async revisionIn(t: Tx, draftId: Id) { return (await this.draftItem(t, draftId)).revision; }

  async effective(draftId: Id): Promise<Recipe | null> { return this.tx(async (t) => (await this.prepared(t, draftId))?.recipe ?? null); }

  /** The reading + corroboration + roles (R-1 table, else validated cards) + live facts, and the checked cards themselves. */
  private async prepared(t: Tx, draftId: Id): Promise<{ recipe: Recipe; cards: CheckedCards; disagreements: { useId: Id; card: Id[]; table: Id[]; basis: 'table' | 'reading' }[]; identity: ReturnType<typeof resolveIdentity>; k: Content } | null> {
    const b = await this.body(t, draftId);
    if (!b) return null;
    const k = await this.k(t, draftId), v = k.vocab;
    const r: Recipe = structuredClone(b.recipe);
    r.revision = await this.revisionIn(t, draftId);
    // what of the source the steps account for (closure 2026-10-08); a recipe chosen from several is judged against its own lines
    const span = b.span ? new Set(b.span) : null;
    methodCoverage(r, (await this.draftSources(t, draftId)).flatMap((s) => s.text.pages).map((p) => (span ? { ...p, lines: p.lines.filter((l) => span.has(l.lineId)) } : p)));
    const a = await t.get<AnalysisItem>(D.analysis(draftId, b.extractionId));   // a retry may complete it: read, not cached
    // a model analysis describes the reading it was given: once the reading changes (an owner repair), it no longer applies.
    // A vocabulary change alone is not a reading change: the same reading's message under an earlier vocabulary still matches.
    const stale = !!a && !swapMessageVariants(b, v, k.history).some((m) => a.inputHash === hash(m));
    const rep = a && !stale ? await t.get<RepairItem>(D.repair(a.analysisId)) : undefined;
    const repStatus = rep?.status === 'RUNNING' && (!this.kv.alive(rep.owner) || this.since(rep.createdAt) > JOB_LIMITS.runningMs) ? 'FAILED_CALL:INTERRUPTED' : rep?.status;
    const cores = coreHashes(b.recipe);
    const byCore = new Map([...cores].map(([k, v]) => [v, k]));
    const facts = await this.liveFacts(t, draftId);
    // owner facts in two passes (2026-10-13): what an ingredient IS and what a step DOES first, so identity, the cards and the
    // role table all see the owner's confirmation; then functions and amounts, which override what those derived
    const fold = (which: Predicate[]) => { for (const f of facts.filter((x) => which.includes(x.predicate))) {
      const key = byCore.get(f.coreHash);
      if (!key) continue;
      const [kind, id] = key.split('|') as [Subject['kind'], Id];
      const value = f.value;
      if (value && typeof value === 'object' && 'not' in value) continue;   // the cook said no: nothing changes, the question isn't asked again
      const prov = { status: f.status, by: f.by, ref: `fact:${f.factId}` } as const;
      if (kind === 'INGREDIENT') {
        const ing = r.ingredients.find((i) => i.ingredientId === id)!;
        if (f.predicate === 'KIND') ing.kind = { kindId: value as string, prov };
        if (f.predicate === 'CHOICE' && ing.options?.[value as number]) applyChoice(r, ing, value as number);
        if (f.predicate === 'AMOUNT') applyAmount(ing, 'listed', 'listedProv', value as AmountValue, prov, r.volumeSystem);
      } else if (kind === 'STEP') {
        const s = getStep(r, id)!;
        if (f.predicate === 'TECHNIQUE') s.technique = { techniqueId: value as string, prov };
      } else {
        const u = r.uses.find((x) => x.useId === id)!;
        if (f.predicate === 'TECHNIQUE') u.technique = { techniqueId: value as string, prov };
        if (f.predicate === 'FUNCTIONS') u.functions = (value as string[]).map((fid) => ({ functionId: fid, label: u.functions.find((x) => x.functionId === fid)?.label ?? null, prov }));
        if (f.predicate === 'AMOUNT') applyAmount(u, 'amount', 'amountProv', value as AmountValue, prov, r.volumeSystem);
      }
    } };
    fold(['CHOICE', 'KIND', 'TECHNIQUE']);
    const identity = resolveIdentity(r, v, k.roles);   // before the cards are checked: they are judged against what the recipe's ingredients ARE
    // a PARTIAL analysis: the uses of batches that didn't answer fail as a technical failure (never "no card"), the rest are judged
    const unanswered = a?.status === 'PARTIAL' ? new Map((a.batches ?? []).filter((x) => x.status !== 'SUCCEEDED').flatMap((x) => x.refs.map((ref) => [a.refs.uses[ref], `FAILED_CALL:${x.status.replace(/^FAILED_CALL:/, '')}`] as const))) : undefined;
    const cards = checkCards(a?.raw && !stale ? a.raw : null, a ? a.refs : null, r, v,
      !a ? 'NO_ANALYSIS' : stale ? 'STALE_ANALYSIS' : a.status !== 'SUCCEEDED' && a.status !== 'PARTIAL' ? a.status : null,
      rep ? { status: repStatus!, requested: rep.requested, raw: rep.raw ?? null } : null, unanswered);
    // a printed choice the cook settled after import: the alternatives drafted for its uses were written for the line as printed
    // (h01 live: "6 cups yams" after the cook chose 4 cups), so they are withdrawn, never offered against the choice
    const chosen = new Set(r.ingredients.filter((i) => i.options && i.choice !== undefined && choiceMatters(i.options)).map((i) => i.ingredientId));
    for (const e of cards.entries) if (chosen.has(getUse(r, e.useId)?.ingredientId ?? '') && e.verdict !== null && e.status !== 'SUPERSEDED') { cards.plans.delete(e.useId); Object.assign(e, { status: 'INVALID', reason: 'DRAFTED_BEFORE_CHOICE' }); }
    const disagreements = applyAuthority(r, v, k.roles, new Map([...cards.plans].map(([id, ps]) => [id, ps[0].functions])), a ? `card:${a.analysisId}` : 'card');
    fold(['FUNCTIONS', 'AMOUNT']);
    return { recipe: r, cards, disagreements, identity, k };
  }

  /** Reviewed patterns first, then the validated cards (src/compile/cards.ts). The same engine for both. */
  coverageOf(draftId: Id) { return this.tx((t) => this.coverageIn(t, draftId)); }
  async coverageIn(t: Tx, draftId: Id): Promise<{ pack: RecipePack | null; errors: string[] }> {
    const p = await this.prepared(t, draftId);
    if (!p) return { pack: null, errors: ['no reading yet'] };
    const res = compile(p.recipe, p.k.vocab, p.k.patterns, { releaseId: p.k.releaseId });   // the draft's pinned release
    if (!res.pack) return { pack: null, errors: res.errors };
    const pack = addCards(res.pack, p.cards, p.k.vocab, p.k.patterns, p.k.roles.cues, p.k.limits);
    for (const d of p.disagreements) {   // R-1: the table's roles were used; the card's reading is kept as a note
      const e = pack.cards?.find((x) => x.useId === d.useId);
      if (e) e.roleNote = d.basis === 'table' ? `the import analysis read ${d.card.join(' + ')}; the approved role table's ${d.table.join(' + ')} was used`
        : `the swap suggestion described it as ${d.card.join(' + ')}; the recipe reading's ${d.table.join(' + ')} is what it does here`;
      pack.warnings.push(`ROLE_DISAGREES:${d.useId}: card ${d.card.join('+')} vs ${d.basis} ${d.table.join('+')}`);
    }
    for (const x of p.identity) pack.warnings.push(`KIND_FROM_NAME:${x.ingredientId}: "${x.name}" is ${x.kindId} by approved name; the reading proposed ${x.proposed ?? 'no kind'}`);
    return { pack, errors: res.errors };
  }

  // ---------- blockers (computed, never stored) ----------
  async blockers(t: Tx, draftId: Id): Promise<Blocker[]> {
    const body = await this.body(t, draftId);
    const out: Blocker[] = [];
    const pasted = Object.values(body?.sourceRefs ?? {}).some((ref) => ref?.origin === 'COOK_PASTED');
    for (const s of (await this.draftSources(t, draftId)).filter((x) => x.origin === 'UPLOAD')) {
      for (const p of s.text.pages.filter(needsRecognition)) {
        if (pasted) continue;   // resolved only when pasted text actually contributed steps to the current reading
        const n = body ? body.recipe.steps.length : 0;
        out.push({ id: `blk.${s.sourceId}.p${p.page}`, kind: 'missingSteps', message: `Steps after step ${n} may be on page ${p.page}, which isn't readable text (a scan or a picture) and couldn't be read.`, resolution: { action: 'appendText', label: 'Paste the missing steps' } });
      }
    }
    // a printed choice whose amounts differ: the cook chooses before the recipe can be started (never summed, never guessed)
    const r = body ? (await this.prepared(t, draftId))?.recipe : null;
    for (const i of r?.ingredients ?? []) {
      if (!i.options || i.choice !== undefined || !choiceMatters(i.options)) continue;
      out.push({ id: `blk.choice.${i.ingredientId}`, kind: 'chooseOption', message: `Your recipe gives a choice: “${i.sourceLine ?? i.options.map((o) => o.text).join(' or ')}”. Which will you use?`,
        resolution: { action: 'choose', label: 'Choose one', ingredientId: i.ingredientId, options: i.options.map((o, index) => ({ index, text: `${amountDisplay(o.amount) === 'amount not stated' ? '' : `${amountDisplay(o.amount)} `}${o.text}`.trim() })) } });
    }
    for (const x of (body?.issues ?? []).filter((y) => y.code === 'UNRESOLVED_CHOICE')) {
      out.push({ id: `blk.unclear.${x.about}`, kind: 'unclearLine', message: `CourseCorrect couldn't tell what the ingredient list means here: ${x.detail.replace(/ offers a choice CourseCorrect couldn't place$/, '')}. Paste the ingredient list as text to have it read again.`, resolution: { action: 'appendText', label: 'Paste the ingredient list' } });
    }
    return out;
  }

  /** The cook's choice on a line that prints one (a draft fact, CONFIRMED by COOK, kept by content hash). */
  async chooseOption(draftId: Id, a: { expectedRevision: number; ingredientId: Id; option: number }) {
    return this.tx(async (t) => {
      if ((await this.revisionIn(t, draftId)) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const ing = (await this.body(t, draftId))?.recipe.ingredients.find((i) => i.ingredientId === a.ingredientId);
      if (!ing?.options || !Number.isInteger(a.option) || !ing.options[a.option]) throw new Conflict('NO_SUCH_CHOICE');
      await this.addFact(t, draftId, { kind: 'INGREDIENT', id: a.ingredientId }, 'CHOICE', a.option, 'CONFIRMED', 'COOK', null);
      return { draft: await this.wireDraftIn(t, draftId) };
    });
  }

  private async addFact(t: Tx, draftId: Id, subject: Subject, predicate: Predicate, value: unknown, status: FactItem['status'], by: FactItem['by'], reviewer: string | null) {
    const core = coreHashes((await this.body(t, draftId))!.recipe).get(`${subject.kind}|${subject.id}`);
    if (!core) throw new NotFound(`${subject.kind} ${subject.id}`);
    const factId = this.newId('fact'), at = this.now();
    t.put(D.fact(draftId, at, factId), { factId, draftId, subjectKind: subject.kind, subjectId: subject.id, coreHash: core, predicate, value, status, by, reviewer, at, retiredAt: null } satisfies FactItem);
    const d = await this.draftItem(t, draftId);
    t.put(D.draft(draftId), { ...d, revision: d.revision + 1 });
  }

  // ---------- append pasted text (C-4): original source preserved; addition kept as a separate COOK_PASTED source ----------
  async appendText(draftId: Id, a: { expectedRevision: number; text: string }) {
    const read = readPastedText(new TextEncoder().encode(a.text), 'x');
    if (!read.ok) throw new Conflict(read.code);
    const jobId = this.newId('job');
    await this.tx(async (t) => {
      const d = await this.draftItem(t, draftId);
      if (d.revision !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const sid = this.addSource(t, read.source, 'TEXT', 'COOK_PASTED', 'pasted text');
      t.put(D.job(jobId), { jobId, draftId, idempotencyKey: null, state: 'queued', stages: ['reading'], failure: null, createdAt: this.now(), claim: null, owner: null, claimedAt: null } satisfies JobItem);
      t.put(D.draft(draftId), { ...d, sources: [...d.sources, { sourceId: sid, origin: 'COOK_PASTED' }], jobIds: [...d.jobIds, jobId], revision: d.revision + 1 });
    });
    const accepted = await this.job(jobId);
    await this.start(jobId);
    return { job: accepted };
  }

  // ---------- owner: requirements, assertions, repair ----------
  async requirements(draftId: Id) {
    return this.tx(async (t) => {
      const { pack, errors } = await this.coverageIn(t, draftId);
      const body = await this.body(t, draftId);
      const r = (await this.prepared(t, draftId))?.recipe ?? null;
      const cores = body ? coreHashes(body.recipe) : new Map<string, string>();
      const describe = (m: MissingFact): string | null => {
        if (!r) return null;
        if (m.subject.kind === 'USE') { const u = r.uses.find((x) => x.useId === m.subject.id)!; return m.predicate === 'FUNCTION' ? u.functions.map((f) => `${f.functionId}(${f.prov.status})`).join(', ') : `${amountDisplay(u.amount)} (${u.amountProv.status})`; }
        if (m.subject.kind === 'STEP') { const s = getStep(r, m.subject.id)!; return s.technique ? `${s.technique.techniqueId}(${s.technique.prov.status})` : null; }
        const i = r.ingredients.find((x) => x.ingredientId === m.subject.id)!;
        return m.predicate === 'KIND_CLASS' ? (i.kind ? `${i.kind.kindId}(${i.kind.prov.status})` : null) : `${amountDisplay(i.listed)} (${i.listedProv.status})`;
      };
      const coverage = (pack?.coverage ?? []).filter((c) => c.targetUseId !== null).map((c: CoverageEntry) => ({
        ...c, missing: c.missing.map((m) => ({ ...m, coreHash: cores.get(`${m.subject.kind}|${m.subject.id}`) ?? null, current: describe(m) })),
      }));
      return { draftId, revision: body ? await this.revisionIn(t, draftId) : 0, structuralErrors: errors, coverage, bindings: pack?.bindings.map((b) => ({ bindingId: b.bindingId, patternId: b.patternId, targetUseId: b.targetUseId, quantities: b.quantities })) ?? [] };
    });
  }

  /** One REVIEWED fact per item, each with reviewer and content hash. Pre-filled proposals still need an explicit submission. */
  async assert(draftId: Id, a: { expectedRevision: number; reviewer: string; assertions: { subject: Subject; predicate: Predicate; value: unknown; coreHash: string }[] }) {
    return this.tx(async (t) => {
      if ((await this.revisionIn(t, draftId)) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      if (!a.reviewer) throw new Conflict('REVIEWER_REQUIRED');
      const cores = coreHashes((await this.body(t, draftId))!.recipe), v = (await this.k(t, draftId)).vocab;
      for (const x of a.assertions) {
        if (cores.get(`${x.subject.kind}|${x.subject.id}`) !== x.coreHash) throw new Conflict(`STALE_SUBJECT:${x.subject.id}`);
        const ok = x.predicate === 'KIND' ? x.subject.kind === 'INGREDIENT' && v.kinds.some((k) => k.kindId === x.value)
          : x.predicate === 'TECHNIQUE' ? (x.subject.kind === 'STEP' || x.subject.kind === 'USE') && v.techniques.some((tq) => tq.techniqueId === x.value)
            : x.predicate === 'FUNCTIONS' ? x.subject.kind === 'USE' && Array.isArray(x.value) && x.value.every((f) => v.functions.some((g) => g.functionId === f))
              : x.subject.kind !== 'STEP' && typeof (x.value as AmountValue).amount === 'string';
        if (!ok) throw new Conflict(`INVALID_ASSERTION:${x.subject.id}:${x.predicate}`);
        await this.addFact(t, draftId, x.subject, x.predicate, x.value, 'REVIEWED', 'OWNER', a.reviewer);
      }
      return { draft: await this.wireDraftIn(t, draftId) };
    });
  }

  /** Owner repair of an extraction error. A new body revision; facts follow their subjects by content hash. */
  async repair(draftId: Id, a: { expectedRevision: number; edits: RepairEdit[] }) {
    return this.tx(async (t) => {
      if ((await this.revisionIn(t, draftId)) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const body: DraftBody = structuredClone((await this.body(t, draftId))!);
      for (const e of a.edits) applyRepair(body, e);
      await this.addBody(t, draftId, body, 'OWNER_REPAIR');
      return { draft: await this.wireDraftIn(t, draftId) };
    });
  }

  // ---------- save: compile → immutable recipe version (never releases, never reviews) ----------
  async save(draftId: Id, a: { expectedRevision: number; idempotencyKey?: string }) {
    return this.tx(async (t, meta) => {
      if (a.idempotencyKey) {
        const prior = await t.get<{ recipeId: string; versionId: string; release: Release }>(D.saveKey(a.idempotencyKey));
        if (prior) return { recipeId: prior.recipeId, recipeVersionId: prior.versionId, release: prior.release };
      }
      const d = await this.draftItem(t, draftId);
      if (d.revision !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const r = (await this.prepared(t, draftId))?.recipe ?? null;
      if (!r) throw new Conflict('NOTHING_TO_SAVE');
      const res = await this.coverageIn(t, draftId);
      const blockers = await this.blockers(t, draftId);
      const reasons = [
        ...blockers.map((b) => ({ code: b.kind === 'chooseOption' ? 'CHOICE_NEEDED' : b.kind === 'unclearLine' ? 'UNCLEAR_INGREDIENT' : 'MISSING_STEPS', message: b.message, nextAction: b.resolution?.label ?? null })),
        ...res.errors.map((e) => ({ code: 'STRUCTURAL_ERROR', message: e, nextAction: null })),
      ];
      const release: Release = reasons.length ? { kind: 'ineligible', reasons } : { kind: 'eligible', coverageSummary: coverageSummary(res.pack!) };
      const versionId = hash(r);
      if (res.pack && !(await t.fixed(K.pack(res.pack.packHash)))) t.put(K.pack(res.pack.packHash), { recipeId: r.recipeId, pack: res.pack });
      meta.savedSeq += 1;
      const prev = await t.get<SavedItem>(D.saved(r.recipeId, versionId));
      t.put(D.saved(r.recipeId, versionId), { recipeId: r.recipeId, versionId, packHash: res.pack?.packHash ?? '', draftId, draftRevision: r.revision, idempotencyKey: a.idempotencyKey ?? null, release, seq: meta.savedSeq, at: this.now(), v: prev?.v,
        ...(res.pack?.knowledgeReleaseId ? { knowledgeReleaseId: res.pack.knowledgeReleaseId } : {}) } satisfies SavedItem);
      if (a.idempotencyKey) t.put(D.saveKey(a.idempotencyKey), { recipeId: r.recipeId, versionId, release });
      t.put(D.draft(draftId), { ...d, savedAs: { recipeId: r.recipeId, recipeVersionId: versionId, draftRevision: r.revision } });
      return { recipeId: r.recipeId, recipeVersionId: versionId, release };
    });
  }

  /** Latest saved version per imported recipe, for list_recipes / start_recipe (the saved range's parent is the head). */
  catalog() { return this.tx((t) => this.catalogIn(t)); }
  async catalogIn(t: Tx): Promise<{ pack: RecipePack | null; recipeId: Id; versionId: string; release: Release; title: string; meta: string; sourceLabel: string; draftId: Id }[]> {
    const latest = new Map<string, SavedItem>();
    for (const s of await t.query<SavedItem>('SAVED#')) if ((latest.get(s.recipeId)?.seq ?? -1) < s.seq) latest.set(s.recipeId, s);
    return Promise.all([...latest.values()].sort((a, b) => a.seq - b.seq).map(async (x) => {
      const pack = x.packHash ? (await t.must<{ pack: RecipePack }>(K.pack(x.packHash))).pack : null;
      const src = (await this.draftSources(t, x.draftId))[0];
      const pages = src?.text.pages.filter((p) => p.page !== null).length ?? 0;
      return { pack, recipeId: x.recipeId, versionId: x.versionId, release: x.release, draftId: x.draftId,
        title: pack?.recipe.title ?? (await this.prepared(t, x.draftId))?.recipe.title ?? 'Imported recipe', meta: pack?.recipe.meta ?? '',
        sourceLabel: src ? `${src.displayName}${pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''}` : '' };
    }));
  }

  async getRecipe(recipeId: Id) {
    return this.tx(async (t) => {
      const e = (await this.catalogIn(t)).find((x) => x.recipeId === recipeId);
      if (!e) throw new NotFound(recipeId);
      const k = e.pack ? await this.packContent(e.pack) : null;
      return { version: { id: e.versionId, recipeId, createdFromDraft: e.draftId, content: e.pack ? recipeContent(e.pack.recipe, k!.v, e.pack, e.pack.recipe, k!.patterns, { pending: false }) : null, release: e.release }, sources: await this.wireSources(t, e.draftId),
        sourceLines: await this.sourceLines(t, e.draftId), sourceRefs: (await this.body(t, e.draftId))?.sourceRefs ?? {} };   // "View source" on a reopened recipe
    });
  }

  // ---------- wire ----------
  async wireSources(t: Tx, draftId: Id): Promise<WireSourceDoc[]> {
    return (await this.draftSources(t, draftId)).map((s) => ({
      id: s.sourceId, kind: s.kind === 'PDF' ? 'pdf' as const : 'pastedText' as const, origin: s.origin === 'UPLOAD' ? 'upload' as const : 'cookPasted' as const,
      displayName: s.displayName, pageCount: s.kind === 'PDF' ? s.text.pages.length : null,
      pages: s.text.pages.map((p, i) => ({ index: p.page ?? i + 1, readable: p.status !== 'TEXT' ? 'image' as const : p.method === 'OCR' ? 'ocr' as const : 'text' as const })), byteSize: s.byteLength,
    }));
  }
  wireDraft(draftId: Id) { return this.tx((t) => this.wireDraftIn(t, draftId)); }
  /** `questions`: compute the cook's questions (a dry compile per waiting change): the review's draft read, not status polls. */
  private async wireDraftIn(t: Tx, draftId: Id, questions = true): Promise<WireDraft> {
    const d = await this.draftItem(t, draftId);
    const body = await this.body(t, draftId), p = await this.prepared(t, draftId), r = p?.recipe ?? null;
    const { pack } = await this.coverageIn(t, draftId);
    // the swap analysis of this reading may still be running (a job past the reading stages): those uses are pending
    let pending = false;
    for (const j of d.jobIds) { const s = (await this.jobIn(t, j)).state; if (s === 'queued' || s === 'running') pending = true; }
    const content = r ? recipeContent(r, p!.k.vocab, pack ?? emptyPack(r), r, p!.k.patterns, { pending }) : null;
    // the model's role guesses stay on the wire for display only ("import guessed …"); they never bind
    for (const u of content?.ingredients.flatMap((i) => i.uses) ?? []) {
      const g = body!.recipe.uses.find((x) => x.useId === u.id)?.functions ?? [];
      u.proposedFunction = g.length ? { labels: g.map((f) => functionLabel(p!.k.vocab, f.functionId)), origin: 'import-inference' } : null;
    }
    // alternatives left unchecked (a busy, failed or unfinished analysis): counted, never shown as checked; retryable when the job is
    const a = body ? await t.get<AnalysisItem>(D.analysis(draftId, body.extractionId)) : undefined;
    const last = d.jobIds.at(-1)!, lastJob = await this.jobIn(t, last);
    const unchecked = a && retryableAnalysis(a) && !pending ? {
      uses: (pack?.cards ?? []).filter((e) => e.status === 'INVALID' && /^FAILED_CALL|^NOT_RUN/.test(e.reason ?? '')).length,
      reason: a.status === 'PARTIAL' ? 'Part of the check for alternatives didn’t finish.' : /THROTTLED/.test(a.status) ? 'The check for alternatives was refused: the service was busy.' : 'The check for alternatives didn’t finish.',
      jobId: last, canRetry: !!lastJob.canRetry } : null;
    return {
      id: draftId, revision: d.revision, sourceDocIds: d.sources.map((s) => s.sourceId),
      content, blockers: await this.blockers(t, draftId), issues: body?.issues ?? [], savedAs: d.savedAs, sourceRefs: body?.sourceRefs ?? {},
      unchecked, questions: questions && p && pack ? await this.questionsOf(t, draftId, p, pack) : [],
    };
  }
  private async questionsOf(t: Tx, draftId: Id, p: NonNullable<Awaited<ReturnType<Authoring['prepared']>>>, pack: RecipePack) {
    const answered = (await this.liveFacts(t, draftId)).filter((f) => f.by === 'COOK').map((f) => ({ subject: { kind: f.subjectKind, id: f.subjectId }, predicate: f.predicate, value: f.value }));
    return cookQuestions({ recipe: p.recipe, pack, v: p.k.vocab, patterns: p.k.patterns, cues: p.k.roles.cues, answered, reapply: (r) => { applyAuthority(r, p.k.vocab, p.k.roles); } });
  }

  /**
   * The cook's answers to import-review questions (cookQuestions): each a fact about this recipe, CONFIRMED by COOK, kept by
   * content hash like every draft fact. "no" is kept too (the question isn't asked again) and changes nothing. Only questions
   * the draft asks now can be answered: a stale revision or an unknown question is refused.
   */
  async confirm(draftId: Id, a: { expectedRevision: number; answers: { questionId: string; answer: 'yes' | 'no' }[] }) {
    return this.tx(async (t) => {
      if ((await this.revisionIn(t, draftId)) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const p = await this.prepared(t, draftId), { pack } = await this.coverageIn(t, draftId);
      if (!p || !pack) throw new Conflict('NOTHING_TO_CONFIRM');
      const qs = await this.questionsOf(t, draftId, p, pack);
      for (const x of a.answers ?? []) {
        const q = qs.find((y) => y.id === x.questionId);
        if (!q || (x.answer !== 'yes' && x.answer !== 'no')) throw new Conflict(`UNKNOWN_QUESTION:${x.questionId}`);
        await this.addFact(t, draftId, q.subject, q.predicate, x.answer === 'yes' ? q.value : { not: q.value }, 'CONFIRMED', 'COOK', null);
      }
      return { draft: await this.wireDraftIn(t, draftId) };
    });
  }
  async getDraft(draftId: Id) { return this.tx(async (t) => ({ draft: await this.wireDraftIn(t, draftId), sources: await this.wireSources(t, draftId), sourceLines: await this.sourceLines(t, draftId) })); }
  /** Every source line as read (the review canvas's source pane). A page read by OCR is introduced by a marker line; a page
   *  not read appears as one marker line saying why. */
  async sourceLines(t: Tx, draftId: Id) {
    const why = { NO_TEXT_LAYER: 'scanned image', HEADINGS_ONLY: 'headings only, the rest is a picture', UNUSABLE_TEXT: "text that can't be decoded" } as const;
    const line = (s: { sourceId: Id; origin: string }, page: number | null, lineId: string, text: string, image: boolean) => ({ sourceDocId: s.sourceId, page, lineId, text, origin: s.origin, image });
    return (await this.draftSources(t, draftId)).flatMap((s) => s.text.pages.flatMap((p) => p.status !== 'TEXT'
      ? [line(s, p.page, `image.p${p.page}`, `Page ${p.page} · ${why[p.status]} · not read`, true)]
      : [...(p.method === 'OCR' ? [line(s, p.page, `ocr.p${p.page}`, `Page ${p.page} · read from an image by OCR · check amounts against the page`, true)] : []),
        ...p.lines.map((l) => line(s, p.page, l.lineId, l.text, false))]));
  }
  /** Vocabulary choices for owner review forms (labels only; ids are what an assertion records). */
  async vocabulary() {
    const v = (await this.knowledge.active()).vocab;
    return {
      functions: v.functions.map((f) => ({ id: f.functionId, label: f.label })),
      techniques: v.techniques.map((tq) => ({ id: tq.techniqueId, label: tq.label })),
      kinds: v.kinds.map((k) => ({ id: k.kindId, label: k.label })),
    };
  }
}

// ---------- helpers ----------
/**
 * Import authority (owner decisions 2026-10-02, OD-4, OD-5; R-1 2026-10-07). A proposed kind counts when the ingredient's
 * name is that kind's label or an alias; a proposed technique counts when the step text has one of its content cues.
 * R-1: where an ADD use's kind and technique are both confirmed and the approved role table has that kind × technique, the
 * row's functions are the use's roles, MACHINE_CHECKED (REVIEWED by CONTENT, ref = the row and its decision), whatever an
 * import card says and whether or not the card's plan validated; a disagreeing card is returned for diagnostics. No row, or
 * a kind/technique not confirmed: the validated card's roles stay PROPOSED (serving only its own plan), else the reading's.
 */
/** The reading's swap message now, then the same reading as earlier approved vocabularies and the earlier tokenizer (uses
 *  it couldn't place) showed it: a retained analysis of any of them describes this reading. Never a different reading. */
function swapMessageVariants(b: DraftBody, v: Vocabulary, history: Vocabulary[]): string[] {
  const placements = b.barePlaced?.length ? [new Set<Id>(), new Set(b.barePlaced)] : [new Set<Id>()];
  // the current (ccmcp-swaps-3) message first; the earlier prompt's messages still identify retained analyses of this reading
  return [...new Set([swapMessageV3(b.recipe, v), ...[v, ...history].flatMap((x) => placements.map((p) => swapUserMessage(b.recipe, x, p)))])];
}
const content = (ref: string): Provenance => ({ status: 'REVIEWED', by: 'CONTENT', ref });
/** Analysis statuses a retry can change: a busy, failed or unfinished call (never "live analysis is off" or a spent allowance). */
const retryableAnalysis = (a: AnalysisItem | undefined) => !!a && a.status !== 'SUCCEEDED' && !/LIVE_ANALYSIS_REQUIRED|BUDGET_EXCEEDED/.test(a.status);
/** Uses (by their U refs) in batches of at most BATCH_USES, an ingredient's uses together so its cards see each other's batch. */
export function batchesOf(r: Recipe, refs: Refs): string[][] {
  const order = Object.keys(refs.uses);
  if (order.length <= BATCH_USES) return [order];
  const byIngredient = new Map<Id, string[]>();
  for (const ref of order) { const i = r.uses.find((u) => u.useId === refs.uses[ref])!.ingredientId; byIngredient.set(i, [...(byIngredient.get(i) ?? []), ref]); }
  const out: string[][] = [];
  for (const g of byIngredient.values()) { const last = out.at(-1); if (last && last.length + g.length <= BATCH_USES) last.push(...g); else out.push([...g]); }
  return out;
}
/** The source lines of the chosen recipe: from its title line up to the next listed recipe's title line, in reading order. */
function spanOf(srcs: { pages: SourcePage[] }[], choices: RecipeChoice[], choice: number): Set<string> {
  const order = srcs.flatMap((s) => s.pages.flatMap((p) => p.lines.map((l) => l.lineId)));
  const from = order.indexOf(choices[choice].lineId), to = choices.map((c) => order.indexOf(c.lineId)).filter((i) => i > from).sort((x, y) => x - y)[0] ?? order.length;
  return new Set(from < 0 ? [] : order.slice(from, to));
}
/** Repair requests per correction call (Sloppy Joseph sent 17 at once, 2026-10-13). */
const REPAIR_CHUNK = 8;
/**
 * Identity (commission 2026-10-07): an ingredient whose name, preparation words set aside, is a kind's label or TRUE alias
 * is that kind, REVIEWED by CONTENT, whatever kind (or none) the reading proposed; a disagreeing tag is returned. A name no
 * kind owns keeps the reading's tag as PROPOSED (never promoted). Sharing a class never makes two kinds one ingredient.
 * A proposed technique counts when the step text has one of its approved cues.
 */
export function resolveIdentity(r: Recipe, v: Vocabulary, roles: RoleTable): { ingredientId: Id; name: string; proposed: Id | null; kindId: Id }[] {
  const corrected: { ingredientId: Id; name: string; proposed: Id | null; kindId: Id }[] = [];
  for (const i of r.ingredients) {
    if (i.kind && settled(i.kind.prov)) continue;
    // the name as read, else the printed line itself with its amount words set aside (2026-10-13: Tarragon's reading gave its
    // cream line a kind id as its name): the same approved-name rule either way, so a line offering "… or milk" names nothing
    const fromLine = !kindByName(v, i.name) && i.sourceLine ? kindByName(v, lineName(i.sourceLine, i.listed)) : undefined;
    const k = kindByName(v, i.name) ?? fromLine;
    if (!k || (!fromLine && i.sourceLine && narrowerOnLine(v, k, i.name, i.sourceLine))) continue;
    if (i.kind?.kindId !== k.kindId) corrected.push({ ingredientId: i.ingredientId, name: i.name, proposed: i.kind?.kindId ?? null, kindId: k.kindId });
    i.kind = { kindId: k.kindId, prov: content(fromLine ? 'vocabulary.json#aliases (the printed ingredient line)' : 'vocabulary.json#aliases') };
  }
  for (const s of r.steps) {
    const t = s.technique, text = renderStep(r, s);
    if (t?.prov.status === 'PROPOSED' && (roles.cues[t.techniqueId] ?? []).some((c) => new RegExp(c, 'i').test(text))) s.technique = { techniqueId: t.techniqueId, prov: content('roles.json#cues') };
  }
  return corrected;
}

/**
 * Roles (2026-10-13, the popovers card): a card never defines what the ingredient does there. It used to: with no settled table
 * row, the card's own claim became the use's role, so a card could claim "the milk adds acidity" and then satisfy that claim
 * with lemon juice. The role is the approved table's row when kind and technique are settled, else the reading's own
 * description; a card that describes it differently is recorded as a disagreement (shown as the AI's words, never as the role).
 */
export function applyAuthority(r: Recipe, v: Vocabulary, roles: RoleTable, cardFunctions: Map<Id, Id[]> = new Map(), _cardRef = 'card'): { useId: Id; card: Id[]; table: Id[]; basis: 'table' | 'reading' }[] {
  resolveIdentity(r, v, roles);
  const disagreements: { useId: Id; card: Id[]; table: Id[]; basis: 'table' | 'reading' }[] = [];
  for (const u of r.uses) {
    const fns = cardFunctions.get(u.useId);
    const k = getIngredient(r, u.ingredientId)?.kind, t = u.technique ?? getStep(r, u.stepId)?.technique;   // the cook's answer for this use first
    const row = u.kind === 'ADD' && k && settled(k.prov) && t && settled(t.prov) ? roles.roles.find((x) => x.kindId === k.kindId && x.techniqueId === t.techniqueId) : undefined;
    if (row) {
      u.functions = row.functions.map((f) => ({ functionId: f, label: null, prov: content(`roles.json#${row.kindId}×${row.techniqueId} (${roles.decisionRef}; R-1)`) }));
      if (fns && !sameSet(row.functions, fns)) disagreements.push({ useId: u.useId, card: fns, table: row.functions, basis: 'table' });
      continue;
    }
    const read = u.functions.map((f) => f.functionId);
    if (fns && read.length && !sameSet(read, fns)) disagreements.push({ useId: u.useId, card: fns, table: read, basis: 'reading' });
  }
  return disagreements;
}

type AmountValue = { confirm?: true; notStated?: true; amount?: string };
function applyAmount<T extends object>(o: T, field: keyof T, provField: keyof T, v: AmountValue, prov: { status: 'CONFIRMED' | 'REVIEWED'; by: 'COOK' | 'OWNER'; ref: string }, vol: Recipe['volumeSystem']) {
  if (v.notStated) (o as Record<string, unknown>)[field as string] = { kind: 'UNSPECIFIED' };
  if (v.amount) (o as Record<string, unknown>)[field as string] = parseAmount(v.amount, vol);
  (o as Record<string, unknown>)[provField as string] = prov;
}

/** Content hash of each subject's id-free core, so facts follow content across re-extraction and repair. */
export function coreHashes(r: Recipe): Map<string, string> {
  const m = new Map<string, string>();
  const stepText = (id: Id) => renderStep(r, getStep(r, id)!);
  for (const i of r.ingredients) m.set(`INGREDIENT|${i.ingredientId}`, hash({ k: 'I', name: i.name.toLowerCase(), listed: amountDisplay(i.listed) }));
  for (const s of r.steps) m.set(`STEP|${s.stepId}`, hash({ k: 'S', text: stepText(s.stepId) }));
  for (const u of r.uses) {
    const ing = r.ingredients.find((i) => i.ingredientId === u.ingredientId)!;
    m.set(`USE|${u.useId}`, hash({ k: 'U', ing: ing.name.toLowerCase(), step: stepText(u.stepId), display: u.displayText }));
  }
  return m;
}

/** Whether a printed choice needs the cook before cooking: its choices differ in amount (one amount for all needs no choice). */
const choiceMatters = (os: NonNullable<Recipe['ingredients'][number]['options']>) => new Set(os.map((o) => amountDisplay(o.amount).toLowerCase())).size > 1;
/** The cook's choice applied: that option's name and amount become the line's; a single use without its own amount takes it. */
function applyChoice(r: Recipe, ing: Recipe['ingredients'][number], n: number) {
  const o = ing.options![n];
  ing.choice = n; ing.name = o.name; ing.listed = o.amount; ing.listedProv = o.amountProv;
  const uses = r.uses.filter((u) => u.ingredientId === ing.ingredientId && u.kind === 'ADD');
  if (uses.length === 1 && (uses[0].amount.kind === 'UNSPECIFIED' || uses[0].amount.kind === 'AS_WRITTEN')) uses[0].amount = o.amount;
}

/** The printed line has the word that sets a narrower kind apart from the name as read (corpus d05: the line "Yolks 2 eggs" read
 *  by its last word): the name is not that kind's identity; the cook confirms it (2026-10-13). */
function narrowerOnLine(v: Vocabulary, k: Vocabulary['kinds'][number], name: string, line: string): boolean {
  const words = (x: string) => new Set(normName(x).match(/\p{L}+/gu)?.map((w) => w.replace(/s$/, '')) ?? []);
  const said = words(bareName(name)), printed = words(line);
  return v.kinds.some((o) => o.kindId !== k.kindId && kindNames(o).some((n) => {
    const w = words(n);
    return [...said].every((x) => w.has(x)) && [...w].some((x) => !said.has(x) && printed.has(x));
  }));
}

/** An ingredient line with its amount words (and a list marker) set aside: "1 cup heavy cream" → "heavy cream". */
function lineName(line: string, listed: Recipe['ingredients'][number]['listed']): string {
  let x = line.replace(/^[\s•●▪◦*-]+/, '');
  const amt = listed.kind === 'EXACT' || listed.kind === 'RANGE' ? listed.asWritten : listed.kind === 'AS_WRITTEN' || listed.kind === 'NOT_QUANTITY_BEARING' ? listed.text : null;
  if (amt && x.toLowerCase().startsWith(amt.toLowerCase())) x = x.slice(amt.length);
  return x.replace(/^\s*of\s+/i, '').trim();
}

const emptyPack = (r: Recipe): RecipePack => ({ schema: 'cc-pack/1', packHash: '', engineSemantics: 0, recipe: r, recipeHash: '', vocabularyHash: '', patternSetHash: '', bindings: [], coverage: [], warnings: [] });

// ---------- repair edits (owner) ----------
export type RepairEdit =
  | { kind: 'ADD_USE'; ingredientId: Id; stepId: Id; quote: string }
  | { kind: 'REMOVE_USE'; useId: Id }
  | { kind: 'MERGE_STEPS'; stepIds: [Id, Id] }
  | { kind: 'SPLIT_STEP'; stepId: Id; before: string };
function applyRepair(b: DraftBody, e: RepairEdit) {
  const r = b.recipe;
  if (e.kind === 'ADD_USE') {
    const s = getStep(r, e.stepId);
    if (!s || !r.ingredients.some((i) => i.ingredientId === e.ingredientId)) throw new Conflict('UNKNOWN_SUBJECT');
    const id = `use_${hash({ existing: r.uses.map((u) => u.useId), add: [e.ingredientId, e.stepId, e.quote] }).slice(0, 10)}`;
    const at = s.text.indexOf(e.quote);
    if (at < 0) throw new Conflict('QUOTE_NOT_IN_STEP');
    s.text = s.text.slice(0, at) + `{use:${id}}` + s.text.slice(at + e.quote.length);
    r.uses.push({ useId: id, ingredientId: e.ingredientId, stepId: e.stepId, kind: 'ADD', preparesUseId: null, amount: { kind: 'UNSPECIFIED' }, amountProv: { status: 'CONFIRMED', by: 'OWNER', ref: 'repair' },
      displayText: e.quote, prepNote: null, functions: [], optional: false, allowance: null });
    b.sourceRefs[id] = b.sourceRefs[e.stepId] ?? null;
  } else if (e.kind === 'REMOVE_USE') {
    const u = r.uses.find((x) => x.useId === e.useId);
    if (!u) throw new Conflict('UNKNOWN_SUBJECT');
    const s = getStep(r, u.stepId)!;
    s.text = s.text.replace(`{use:${u.useId}}`, u.displayText ?? '');
    r.uses = r.uses.filter((x) => x.useId !== e.useId);
  } else if (e.kind === 'MERGE_STEPS') {
    const [a, c] = e.stepIds.map((id) => r.steps.findIndex((s) => s.stepId === id));
    if (a < 0 || c !== a + 1) throw new Conflict('STEPS_NOT_ADJACENT');
    r.steps[a].text = `${r.steps[a].text} ${r.steps[c].text}`;
    for (const u of r.uses) if (u.stepId === r.steps[c].stepId) u.stepId = r.steps[a].stepId;
    const gone = r.steps[c].stepId;
    r.steps.splice(c, 1);
    for (const s of r.steps) s.dependsOn = s.dependsOn.map((d) => (d === gone ? r.steps[a].stepId : d)).filter((d, i, xs) => xs.indexOf(d) === i && d !== s.stepId);
  } else {
    const i = r.steps.findIndex((s) => s.stepId === e.stepId);
    if (i < 0) throw new Conflict('UNKNOWN_SUBJECT');
    const s = r.steps[i], at = s.text.indexOf(e.before);
    if (at <= 0) throw new Conflict('SPLIT_POINT_NOT_IN_STEP');
    const id = `stp_${hash({ existing: r.steps.map((x) => x.stepId), split: [e.stepId, e.before] }).slice(0, 10)}`;
    const tail = { ...structuredClone(s), stepId: id, text: s.text.slice(at).trim(), dependsOn: [s.stepId] };
    s.text = s.text.slice(0, at).trim();
    for (const u of r.uses) if (u.stepId === s.stepId && tail.text.includes(`{use:${u.useId}}`)) u.stepId = id;
    r.steps.splice(i + 1, 0, tail);
    if (r.steps[i + 2]) r.steps[i + 2].dependsOn = r.steps[i + 2].dependsOn.map((d) => (d === s.stepId ? id : d));
    b.sourceRefs[id] = b.sourceRefs[s.stepId] ?? null;
  }
}
