// Authoring (ESOD §3.2, §8.5): import jobs, append-only draft bodies, per-use requirements, save → compile → recipe version.
// Owner decision 2026-10-02: no cook confirmation. Kinds and techniques count only when code corroborates the reading, and
// source-verified amounts suffice. Every use's role and swap plan come from its validated import-time swap card; the role
// table is a cross-check (a card's roles that match it count as reviewed). Saving never reviews or releases.
import { randomUUID } from 'node:crypto';
import type { CoverageEntry, Id, MissingFact, Provenance, Recipe, RecipePack, RoleTable, Vocabulary } from '../contract/types.ts';
import { compile } from '../compile/binder.ts';
import { addCards, checkCards, refsOf, repairRequests, type CheckedCards, type Refs, type RepairRound } from '../compile/cards.ts';
import { coverageSummary, recipeContent, type RecipeBookEntry, type RecipeContent } from '../contract/project.ts';
import { hash } from '../domain/rational.ts';
import { amountDisplay, getIngredient, getStep, parseAmount, renderStep } from '../domain/recipe.ts';
import { functionLabel, kindByName, sameSet } from '../domain/vocabulary.ts';
import type { Content } from '../service/content.ts';
import type { Store } from '../service/store.ts';
import { buildDraft, methodCoverage, promptIdentity, type DraftBody, type Extractor, type Issue, type SourceRef } from './extract.ts';
import { readPastedText, readPdf, type SourcePage, type SourceText } from './source.ts';
import { offAnalyzer, repairMessage, repairPromptIdentity, swapMessageV3, swapPromptIdentity, swapUserMessage, type SwapAnalyzer } from './swap-analysis.ts';

export type Release = RecipeBookEntry['release'];
type Subject = { kind: 'INGREDIENT' | 'STEP' | 'USE'; id: Id };
type Predicate = 'KIND' | 'FUNCTIONS' | 'TECHNIQUE' | 'AMOUNT';
interface FactRow { fact_id: string; subject_kind: Subject['kind']; subject_id: string; core_hash: string; predicate: Predicate; value_json: string; status: 'CONFIRMED' | 'REVIEWED'; by: 'COOK' | 'OWNER'; reviewer: string | null; at: string }
export interface FailureJson { code: 'NO_RECIPE_FOUND' | 'NOT_A_PDF' | 'UNREADABLE' | 'TOO_LARGE' | 'INTERNAL' | 'LIVE_EXTRACTION_REQUIRED' | 'BUDGET_EXCEEDED'; message: string }
export type ImportStage = 'reading' | 'recipeFound' | 'ingredientsAndSteps' | 'uses' | 'proposedFunctions' | 'coverage';
export interface ImportJob { id: Id; draftId: Id; sourceDocId: Id; state: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed'; stagesCompleted: ImportStage[]; failure: FailureJson | null }
export interface WireSourceDoc { id: Id; kind: 'pdf' | 'pastedText'; origin: 'upload' | 'cookPasted'; displayName: string; pageCount: number | null; pages: { index: number; readable: 'text' | 'image' }[]; byteSize: number }
export interface Blocker { id: string; kind: 'missingSteps'; message: string; resolution: { action: 'appendText'; label: string } | null }
export interface WireDraft { id: Id; revision: number; sourceDocIds: Id[]; content: RecipeContent | null; blockers: Blocker[]; issues: Issue[]; savedAs: { recipeId: Id; recipeVersionId: string; draftRevision: number } | null; sourceRefs: Record<Id, SourceRef | null> }
export class Conflict extends Error {}
export class NotFound extends Error {}

const FAILURE_MESSAGES: Record<string, string> = {
  NOT_A_PDF: "That file isn't a PDF.", TOO_LARGE: 'That file is too large.', EMPTY: "That file is empty.", ENCRYPTED: "That PDF is password-protected.",
  TOO_MANY_PAGES: 'That PDF has too many pages.', UNREADABLE: "We couldn't read that file.", NOT_UTF8: "That text couldn't be read.",
  NEEDS_TEXT_RECOGNITION: "That PDF has no readable text (it may be a scan). Paste the recipe text instead.",
  NO_RECIPE_FOUND: "We couldn't find a recipe in that document.",
};

export interface AuthoringOptions { store: Store; content: Content; extractor: Extractor; analyzer?: SwapAnalyzer; now?: () => string; newId?: (p: string) => string }

export class Authoring {
  readonly store: Store; readonly content: Content; extractor: Extractor; analyzer: SwapAnalyzer;
  private readonly now: () => string; private readonly newId: (p: string) => string;
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(o: AuthoringOptions) {
    this.store = o.store; this.content = o.content; this.extractor = o.extractor;
    this.analyzer = o.analyzer ?? offAnalyzer;   // no analyzer: every use fails closed ("not checked yet")
    this.now = o.now ?? (() => new Date().toISOString());
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.store.run(`UPDATE import_jobs SET state = 'failed', failure_json = ? WHERE state IN ('queued', 'running')`, JSON.stringify({ code: 'INTERNAL', message: 'Reading was interrupted. Try again.' }));
    this.store.run(`UPDATE swap_repairs SET status = 'FAILED_CALL:INTERRUPTED' WHERE status = 'RUNNING'`);
  }
  private get v(): Vocabulary { return this.content.vocab; }

  // ---------- import ----------
  /** `upload` re-reads nothing: it starts a new draft from a source an earlier upload stored (its opaque sourceDocId). */
  async createImport(input: { kind: 'pdf'; bytes: Uint8Array; filename: string } | { kind: 'text'; text: string; title?: string } | { kind: 'upload'; sourceDocId: Id }, idempotencyKey?: string)
    : Promise<{ status: 202; job: ImportJob; draftId: Id } | { status: 400 | 404 | 413; error: { code: string; message: string } }> {
    if (idempotencyKey) {
      const prior = this.store.get<{ job_id: string }>('SELECT job_id FROM import_jobs WHERE idempotency_key = ?', idempotencyKey);
      if (prior) { const j = this.job(prior.job_id); return { status: 202, job: j, draftId: j.draftId }; }
    }
    let uploaded: { source_id: string; text_json: string; kind: string } | undefined;
    if (input.kind === 'upload') {
      uploaded = this.store.get(`SELECT source_id, text_json, kind FROM sources WHERE source_id = ? AND origin = 'UPLOAD'`, input.sourceDocId);
      if (!uploaded) return { status: 404, error: { code: 'UNKNOWN_UPLOAD', message: 'No uploaded file with that handle.' } };
    }
    const read: Awaited<ReturnType<typeof readPdf>> = uploaded ? { ok: true, source: JSON.parse(uploaded.text_json) as SourceText }
      : input.kind === 'pdf' ? await readPdf(input.bytes) : readPastedText(new TextEncoder().encode((input as { text: string }).text));
    if (!read.ok && (read.code === 'NOT_A_PDF' || read.code === 'TOO_LARGE' || read.code === 'EMPTY')) {
      return { status: read.code === 'TOO_LARGE' ? 413 : 400, error: { code: read.code, message: FAILURE_MESSAGES[read.code] } };
    }
    const draftId = this.newId('dr'), jobId = this.newId('job');
    const recipeId = `rcp_${hash(draftId).slice(0, 10)}`;
    this.store.tx(() => {
      this.store.run('INSERT INTO drafts VALUES (?, ?, 0, 0, ?)', draftId, recipeId, this.now());
      if (read.ok) {
        const sourceId = uploaded?.source_id ?? this.addSource(read.source, input.kind === 'pdf' ? 'PDF' : 'TEXT', 'UPLOAD', input.kind === 'pdf' ? input.filename : 'pasted text');
        this.store.run('INSERT INTO draft_sources VALUES (?, 1, ?, ?)', draftId, sourceId, 'UPLOAD');
      }
      const failure: FailureJson | null = read.ok
        ? (read.source.status === 'NEEDS_TEXT_RECOGNITION' ? { code: 'UNREADABLE', message: FAILURE_MESSAGES.NEEDS_TEXT_RECOGNITION } : null)
        : { code: 'UNREADABLE', message: FAILURE_MESSAGES[read.code] ?? read.detail };
      this.store.run('INSERT INTO import_jobs VALUES (?, ?, ?, ?, ?, ?, ?)', jobId, draftId, idempotencyKey ?? null, failure ? 'failed' : 'running',
        JSON.stringify(failure ? [] : ['reading']), failure ? JSON.stringify(failure) : null, this.now());
    });
    if (this.job(jobId).state === 'running') this.running.set(jobId, this.runExtraction(jobId, draftId));
    return { status: 202, job: this.job(jobId), draftId };
  }

  /** Store an uploaded PDF without reading a recipe from it; its id is the opaque handle `import_recipe` takes. */
  async upload(bytes: Uint8Array, filename: string): Promise<{ status: 201; sourceDocId: Id } | { status: 400 | 413; error: { code: string; message: string } }> {
    const read = await readPdf(bytes);
    if (!read.ok) return { status: read.code === 'TOO_LARGE' ? 413 : 400, error: { code: read.code, message: FAILURE_MESSAGES[read.code] ?? read.detail } };
    return { status: 201, sourceDocId: this.store.tx(() => this.addSource(read.source, 'PDF', 'UPLOAD', filename)) };   // a scan still stores; its import then fails as unreadable
  }

  private addSource(src: SourceText, kind: 'PDF' | 'TEXT', origin: 'UPLOAD' | 'COOK_PASTED', displayName: string): Id {
    const id = this.newId('src');
    this.store.run('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, src.sha256, kind, origin, displayName, src.byteLength, JSON.stringify(src), this.now());
    return id;
  }
  private draftSources(draftId: Id) {
    return this.store.all<{ source_id: string; origin: 'UPLOAD' | 'COOK_PASTED'; text_json: string; kind: string; display_name: string; byte_length: number }>(
      'SELECT ds.source_id, ds.origin, s.text_json, s.kind, s.display_name, s.byte_length FROM draft_sources ds JOIN sources s USING(source_id) WHERE ds.draft_id = ? ORDER BY ds.seq', draftId)
      .map((r) => ({ sourceId: r.source_id, origin: r.origin, text: JSON.parse(r.text_json) as SourceText, kind: r.kind, displayName: r.display_name, byteLength: r.byte_length }));
  }

  /** One extraction over the draft's readable pages (upload text pages + cook-pasted text). Never retried automatically. */
  private async runExtraction(jobId: Id, draftId: Id) {
    const stages: ImportStage[] = ['reading'];
    const fail = (f: FailureJson) => this.store.run(`UPDATE import_jobs SET state = 'failed', failure_json = ?, stages_json = ? WHERE job_id = ?`, JSON.stringify(f), JSON.stringify(stages), jobId);
    try {
      const srcs = this.draftSources(draftId).map((s) => ({ sourceId: s.sourceId, origin: s.origin, pages: s.text.pages.filter((p) => p.status === 'TEXT') as SourcePage[] }));
      const extractionId = this.newId('ex');
      const r = await this.extractor.extract(srcs.flatMap((s) => s.pages), this.v, extractionId, `import ${draftId}`);
      const recipeId = this.store.get<{ recipe_id: string }>('SELECT recipe_id FROM drafts WHERE draft_id = ?', draftId)!.recipe_id;
      const built = r.ok ? buildDraft(r.raw, this.v, srcs, recipeId, extractionId, r.extractor) : null;
      this.store.run('INSERT INTO extractions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', extractionId, draftId, jobId, r.extractor, (r.ok && r.promptHash) || promptIdentity(this.v),
        !r.ok ? `FAILED_CALL:${r.error}` : built!.ok ? 'SUCCEEDED' : `FAILED_VALIDATION:${built!.code}`, r.ok ? JSON.stringify(r.raw) : null,
        JSON.stringify(!r.ok ? [{ code: r.error, detail: r.detail }] : built!.ok ? built!.body.issues : built!.issues),
        r.usage?.inputTokens ?? null, r.usage?.outputTokens ?? null, r.costUsd, this.now());
      if (!r.ok) return fail({ code: r.error === 'LIVE_EXTRACTION_REQUIRED' || r.error === 'BUDGET_EXCEEDED' ? r.error : 'INTERNAL', message: r.detail });
      if (!built!.ok) return fail(built!.code === 'NO_RECIPE_FOUND' ? { code: 'NO_RECIPE_FOUND', message: FAILURE_MESSAGES.NO_RECIPE_FOUND } : { code: 'INTERNAL', message: `The reading failed validation (${built!.code}).` });
      this.store.tx(() => this.addBody(draftId, built!.body, 'EXTRACTOR'));
      stages.push('recipeFound', 'ingredientsAndSteps', 'uses');
      this.store.run('UPDATE import_jobs SET stages_json = ? WHERE job_id = ?', JSON.stringify(stages), jobId);
      await this.runAnalysis(draftId, built!.body);                // one swap-analysis call per import; never retried
      stages.push('proposedFunctions');
      this.store.run('UPDATE import_jobs SET stages_json = ? WHERE job_id = ?', JSON.stringify(stages), jobId);
      this.coverageOf(draftId);                                   // the coverage stage actually ran
      stages.push('coverage');
      const blocked = this.blockers(draftId).length > 0;
      this.store.run('UPDATE import_jobs SET state = ?, stages_json = ? WHERE job_id = ?', blocked ? 'partial' : 'succeeded', JSON.stringify(stages), jobId);
    } catch (e) {
      fail({ code: 'INTERNAL', message: (e as Error).message.slice(0, 200) });
    }
  }
  async waitForJob(jobId: Id) { await this.running.get(jobId); return this.job(jobId); }

  /** Swap analysis over the reading as read. The raw cards are kept as evidence; validation runs on every compile. A
   *  recording may answer the same reading's message under an earlier approved vocabulary; it is stored as what it is. */
  private async runAnalysis(draftId: Id, body: DraftBody) {
    const [message, ...alternates] = swapMessageVariants(body, this.v, this.content.history);
    const id = this.newId('sa');
    const r = await this.analyzer.analyze(message, this.v, id, `swaps ${draftId}`, alternates)
      .catch((e: Error) => ({ ok: false as const, error: 'CALL_FAILED', detail: e.message.slice(0, 200), analyzer: this.analyzer.name, usage: null, costUsd: 0 }));
    const refs = refsOf(body.recipe);
    const issues = r.ok ? checkCards(r.raw, refs, body.recipe, this.v, null).entries.filter((e) => e.status === 'INVALID') : [{ code: r.error, detail: r.detail }];
    this.store.run('INSERT INTO swap_analyses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, draftId, body.extractionId, r.analyzer, (r.ok && r.promptHash) || swapPromptIdentity(this.v),
      hash((r.ok && r.answered) || message), r.ok ? 'SUCCEEDED' : `FAILED_CALL:${r.error}`, r.ok ? JSON.stringify(r.raw) : null, JSON.stringify(refs), JSON.stringify(issues),
      r.usage?.inputTokens ?? null, r.usage?.outputTokens ?? null, r.costUsd, this.now());
    if (r.ok && this.analyzer.repair) await this.runRepair(draftId, id, body);
  }

  /** The ONE correction round per analysis: every card the checks rejected for a reason the model can fix, batched, unless
   *  reviewed content already decides that use. The round's output is kept apart from the first round's (swap_repairs). */
  private async runRepair(draftId: Id, analysisId: Id, body: DraftBody) {
    const { pack } = this.coverageOf(draftId);
    const a = this.store.get<{ raw_json: string; refs_json: string }>('SELECT raw_json, refs_json FROM swap_analyses WHERE analysis_id = ?', analysisId)!;
    const requests = pack ? repairRequests(pack, JSON.parse(a.refs_json) as Refs, JSON.parse(a.raw_json) as unknown) : [];
    if (!requests.length) return;
    const message = repairMessage(body.recipe, this.v, requests);
    const id = this.newId('sr');
    this.store.run('INSERT INTO swap_repairs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)', id, analysisId, this.analyzer.name, repairPromptIdentity(this.v), hash(message), 'RUNNING',
      JSON.stringify(requests.map(({ useRef, reason }) => ({ useRef, reason }))), this.now());
    const r = await this.analyzer.repair!(message, this.v, id, `repair ${draftId}`)
      .catch((e: Error) => ({ ok: false as const, error: 'CALL_FAILED', detail: e.message.slice(0, 200), analyzer: this.analyzer.name, usage: null, costUsd: 0 }));
    this.store.run('UPDATE swap_repairs SET analyzer = ?, status = ?, raw_json = ?, input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE repair_id = ?', r.analyzer,
      r.ok ? 'SUCCEEDED' : `FAILED_CALL:${r.error}`, r.ok ? JSON.stringify(r.raw) : null, r.usage?.inputTokens ?? null, r.usage?.outputTokens ?? null, r.costUsd, id);
  }

  /** New body revision; facts whose subject no longer exists (by content hash) are retired, never silently re-pointed. */
  private addBody(draftId: Id, body: DraftBody, author: string) {
    const d = this.store.get<{ body_revision: number }>('SELECT body_revision FROM drafts WHERE draft_id = ?', draftId)!;
    this.store.run('INSERT INTO draft_bodies VALUES (?, ?, ?, ?, ?)', draftId, d.body_revision + 1, author, JSON.stringify(body), this.now());
    this.store.run('UPDATE drafts SET body_revision = body_revision + 1, revision = revision + 1 WHERE draft_id = ?', draftId);
    const cores = new Set(coreHashes(body.recipe).values());
    for (const f of this.liveFacts(draftId)) if (!cores.has(f.core_hash)) this.store.run('UPDATE facts SET retired_at = ? WHERE fact_id = ?', this.now(), f.fact_id);
  }

  job(jobId: Id): ImportJob {
    const j = this.store.get<{ job_id: string; draft_id: string; state: ImportJob['state']; stages_json: string; failure_json: string | null }>('SELECT * FROM import_jobs WHERE job_id = ?', jobId);
    if (!j) throw new NotFound(jobId);
    const src = this.store.get<{ source_id: string }>('SELECT source_id FROM draft_sources WHERE draft_id = ? ORDER BY seq LIMIT 1', j.draft_id);
    return { id: j.job_id, draftId: j.draft_id, sourceDocId: src?.source_id ?? '', state: j.state, stagesCompleted: JSON.parse(j.stages_json) as ImportStage[], failure: j.failure_json ? JSON.parse(j.failure_json) as FailureJson : null };
  }
  getImport(jobId: Id) { const job = this.job(jobId); return { job, draft: job.state === 'failed' || job.stagesCompleted.length < 2 ? null : this.wireDraft(job.draftId) }; }

  // ---------- effective recipe = latest body + live facts (by content hash) ----------
  private body(draftId: Id): DraftBody | null {
    const r = this.store.get<{ body_json: string }>('SELECT b.body_json FROM drafts d JOIN draft_bodies b ON b.draft_id = d.draft_id AND b.body_revision = d.body_revision WHERE d.draft_id = ?', draftId);
    return r ? JSON.parse(r.body_json) as DraftBody : null;
  }
  private liveFacts(draftId: Id) { return this.store.all<FactRow>('SELECT * FROM facts WHERE draft_id = ? AND retired_at IS NULL ORDER BY at, fact_id', draftId); }
  revision(draftId: Id) { const d = this.store.get<{ revision: number }>('SELECT revision FROM drafts WHERE draft_id = ?', draftId); if (!d) throw new NotFound(draftId); return d.revision; }

  effective(draftId: Id): Recipe | null { return this.prepared(draftId)?.recipe ?? null; }

  /** The reading + corroboration + roles (R-1 table, else validated cards) + live facts, and the checked cards themselves. */
  private prepared(draftId: Id): { recipe: Recipe; cards: CheckedCards; disagreements: { useId: Id; card: Id[]; table: Id[] }[]; identity: ReturnType<typeof resolveIdentity> } | null {
    const b = this.body(draftId);
    if (!b) return null;
    const r: Recipe = structuredClone(b.recipe);
    r.revision = this.revision(draftId);
    methodCoverage(r, this.draftSources(draftId).flatMap((s) => s.text.pages));   // what of the source the steps account for (closure 2026-10-08)
    const a = this.store.get<{ analysis_id: string; status: string; raw_json: string | null; refs_json: string; input_hash: string }>(
      'SELECT analysis_id, status, raw_json, refs_json, input_hash FROM swap_analyses WHERE draft_id = ? AND extraction_id = ? ORDER BY rowid DESC LIMIT 1', draftId, b.extractionId);
    // a model analysis describes the reading it was given: once the reading changes (an owner repair), it no longer applies.
    // A vocabulary change alone is not a reading change: the same reading's message under an earlier vocabulary still matches.
    const stale = !!a && !swapMessageVariants(b, this.v, this.content.history).some((m) => a.input_hash === hash(m));
    const rep = a && !stale ? this.store.get<{ status: string; requested_json: string; raw_json: string | null }>('SELECT status, requested_json, raw_json FROM swap_repairs WHERE analysis_id = ?', a.analysis_id) : undefined;
    const identity = resolveIdentity(r, this.v, this.content.roles);   // before the cards are checked: they are judged against what the recipe's ingredients ARE
    const cards = checkCards(a?.raw_json && !stale ? JSON.parse(a.raw_json) as unknown : null, a ? JSON.parse(a.refs_json) as Refs : null, r, this.v,
      !a ? 'NO_ANALYSIS' : stale ? 'STALE_ANALYSIS' : a.status !== 'SUCCEEDED' ? a.status : null,
      rep ? { status: rep.status, requested: JSON.parse(rep.requested_json) as RepairRound['requested'], raw: rep.raw_json ? JSON.parse(rep.raw_json) as unknown : null } : null);
    const disagreements = applyAuthority(r, this.v, this.content.roles, new Map([...cards.plans].map(([id, ps]) => [id, ps[0].functions])), a ? `card:${a.analysis_id}` : 'card');
    const cores = coreHashes(b.recipe);
    const byCore = new Map([...cores].map(([k, v]) => [v, k]));
    for (const f of this.liveFacts(draftId)) {
      const key = byCore.get(f.core_hash);
      if (!key) continue;
      const [kind, id] = key.split('|') as [Subject['kind'], Id];
      const value = JSON.parse(f.value_json) as unknown;
      const prov = { status: f.status, by: f.by, ref: `fact:${f.fact_id}` } as const;
      if (kind === 'INGREDIENT') {
        const ing = r.ingredients.find((i) => i.ingredientId === id)!;
        if (f.predicate === 'KIND') ing.kind = { kindId: value as string, prov };
        if (f.predicate === 'AMOUNT') applyAmount(ing, 'listed', 'listedProv', value as AmountValue, prov, r.volumeSystem);
      } else if (kind === 'STEP') {
        const s = getStep(r, id)!;
        if (f.predicate === 'TECHNIQUE') s.technique = { techniqueId: value as string, prov };
      } else {
        const u = r.uses.find((x) => x.useId === id)!;
        if (f.predicate === 'FUNCTIONS') u.functions = (value as string[]).map((fid) => ({ functionId: fid, label: u.functions.find((x) => x.functionId === fid)?.label ?? null, prov }));
        if (f.predicate === 'AMOUNT') applyAmount(u, 'amount', 'amountProv', value as AmountValue, prov, r.volumeSystem);
      }
    }
    return { recipe: r, cards, disagreements, identity };
  }

  /** Reviewed patterns first, then the validated cards (src/compile/cards.ts). The same engine for both. */
  coverageOf(draftId: Id): { pack: RecipePack | null; errors: string[] } {
    const p = this.prepared(draftId);
    if (!p) return { pack: null, errors: ['no reading yet'] };
    const res = compile(p.recipe, this.v, this.content.patterns);
    if (!res.pack) return { pack: null, errors: res.errors };
    const pack = addCards(res.pack, p.cards, this.v, this.content.patterns, this.content.roles.cues);
    for (const d of p.disagreements) {   // R-1: the table's roles were used; the card's reading is kept as a note
      const e = pack.cards?.find((x) => x.useId === d.useId);
      if (e) e.roleNote = `the import analysis read ${d.card.join(' + ')}; the approved role table's ${d.table.join(' + ')} was used`;
      pack.warnings.push(`ROLE_DISAGREES:${d.useId}: card ${d.card.join('+')} vs table ${d.table.join('+')}`);
    }
    for (const x of p.identity) pack.warnings.push(`KIND_FROM_NAME:${x.ingredientId}: "${x.name}" is ${x.kindId} by approved name; the reading proposed ${x.proposed ?? 'no kind'}`);
    return { pack, errors: res.errors };
  }

  // ---------- blockers (computed, never stored) ----------
  blockers(draftId: Id): Blocker[] {
    const body = this.body(draftId);
    const out: Blocker[] = [];
    const pasted = Object.values(body?.sourceRefs ?? {}).some((ref) => ref?.origin === 'COOK_PASTED');
    for (const s of this.draftSources(draftId).filter((x) => x.origin === 'UPLOAD')) {
      for (const p of s.text.pages.filter((pg) => pg.status === 'NO_TEXT_LAYER')) {
        if (pasted) continue;   // resolved only when pasted text actually contributed steps to the current reading
        const n = body ? body.recipe.steps.length : 0;
        out.push({ id: `blk.${s.sourceId}.p${p.page}`, kind: 'missingSteps', message: `Steps after step ${n} are on page ${p.page}, a scanned image that couldn't be read.`, resolution: { action: 'appendText', label: 'Paste the missing steps' } });
      }
    }
    return out;
  }

  private addFact(draftId: Id, subject: Subject, predicate: Predicate, value: unknown, status: FactRow['status'], by: FactRow['by'], reviewer: string | null) {
    const core = coreHashes(this.body(draftId)!.recipe).get(`${subject.kind}|${subject.id}`);
    if (!core) throw new NotFound(`${subject.kind} ${subject.id}`);
    this.store.run('INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)', this.newId('fact'), draftId, subject.kind, subject.id, core, predicate, JSON.stringify(value), status, by, reviewer, this.now());
    this.store.run('UPDATE drafts SET revision = revision + 1 WHERE draft_id = ?', draftId);
  }

  // ---------- append pasted text (C-4): original source preserved; addition kept as a separate COOK_PASTED source ----------
  appendText(draftId: Id, a: { expectedRevision: number; text: string }) {
    const read = readPastedText(new TextEncoder().encode(a.text), 'x');
    if (!read.ok) throw new Conflict(read.code);
    const jobId = this.newId('job');
    this.store.tx(() => {
      if (this.revision(draftId) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const seq = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM draft_sources WHERE draft_id = ?', draftId)!.n + 1;
      const sid = this.addSource(read.source, 'TEXT', 'COOK_PASTED', 'pasted text');
      this.store.run('INSERT INTO draft_sources VALUES (?, ?, ?, ?)', draftId, seq, sid, 'COOK_PASTED');
      this.store.run('INSERT INTO import_jobs VALUES (?, ?, NULL, ?, ?, NULL, ?)', jobId, draftId, 'running', JSON.stringify(['reading']), this.now());
      this.store.run('UPDATE drafts SET revision = revision + 1 WHERE draft_id = ?', draftId);
    });
    this.running.set(jobId, this.runExtraction(jobId, draftId));
    return { job: this.job(jobId) };
  }

  // ---------- owner: requirements, assertions, repair ----------
  requirements(draftId: Id) {
    const { pack, errors } = this.coverageOf(draftId);
    const body = this.body(draftId);
    const r = this.effective(draftId);
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
    return { draftId, revision: body ? this.revision(draftId) : 0, structuralErrors: errors, coverage, bindings: pack?.bindings.map((b) => ({ bindingId: b.bindingId, patternId: b.patternId, targetUseId: b.targetUseId, quantities: b.quantities })) ?? [] };
  }

  /** One REVIEWED fact per item, each with reviewer and content hash. Pre-filled proposals still need an explicit submission. */
  assert(draftId: Id, a: { expectedRevision: number; reviewer: string; assertions: { subject: Subject; predicate: Predicate; value: unknown; coreHash: string }[] }) {
    return this.store.tx(() => {
      if (this.revision(draftId) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      if (!a.reviewer) throw new Conflict('REVIEWER_REQUIRED');
      const cores = coreHashes(this.body(draftId)!.recipe);
      for (const x of a.assertions) {
        if (cores.get(`${x.subject.kind}|${x.subject.id}`) !== x.coreHash) throw new Conflict(`STALE_SUBJECT:${x.subject.id}`);
        const ok = x.predicate === 'KIND' ? x.subject.kind === 'INGREDIENT' && this.v.kinds.some((k) => k.kindId === x.value)
          : x.predicate === 'TECHNIQUE' ? x.subject.kind === 'STEP' && this.v.techniques.some((t) => t.techniqueId === x.value)
            : x.predicate === 'FUNCTIONS' ? x.subject.kind === 'USE' && Array.isArray(x.value) && x.value.every((f) => this.v.functions.some((g) => g.functionId === f))
              : x.subject.kind !== 'STEP' && typeof (x.value as AmountValue).amount === 'string';
        if (!ok) throw new Conflict(`INVALID_ASSERTION:${x.subject.id}:${x.predicate}`);
        this.addFact(draftId, x.subject, x.predicate, x.value, 'REVIEWED', 'OWNER', a.reviewer);
      }
      return { draft: this.wireDraft(draftId) };
    });
  }

  /** Owner repair of an extraction error. A new body revision; facts follow their subjects by content hash. */
  repair(draftId: Id, a: { expectedRevision: number; edits: RepairEdit[] }) {
    return this.store.tx(() => {
      if (this.revision(draftId) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const body: DraftBody = structuredClone(this.body(draftId)!);
      for (const e of a.edits) applyRepair(body, e);
      this.addBody(draftId, body, 'OWNER_REPAIR');
      return { draft: this.wireDraft(draftId) };
    });
  }

  // ---------- save: compile → immutable recipe version (never releases, never reviews) ----------
  save(draftId: Id, a: { expectedRevision: number; idempotencyKey?: string }) {
    return this.store.tx(() => {
      if (a.idempotencyKey) {
        const prior = this.store.get<{ recipe_id: string; version_id: string; release_json: string }>('SELECT * FROM saved_recipes WHERE idempotency_key = ?', a.idempotencyKey);
        if (prior) return { recipeId: prior.recipe_id, recipeVersionId: prior.version_id, release: JSON.parse(prior.release_json) as Release };
      }
      if (this.revision(draftId) !== a.expectedRevision) throw new Conflict('STALE_REVISION');
      const r = this.effective(draftId);
      if (!r) throw new Conflict('NOTHING_TO_SAVE');
      const res = this.coverageOf(draftId);
      const blockers = this.blockers(draftId);
      const reasons = [
        ...blockers.map((b) => ({ code: 'MISSING_STEPS', message: b.message, nextAction: b.resolution?.label ?? null })),
        ...res.errors.map((e) => ({ code: 'STRUCTURAL_ERROR', message: e, nextAction: null })),
      ];
      const release: Release = reasons.length ? { kind: 'ineligible', reasons } : { kind: 'eligible', coverageSummary: coverageSummary(res.pack!) };
      const versionId = hash(r);
      if (res.pack) this.store.run('INSERT OR IGNORE INTO packs(pack_hash, recipe_id, json) VALUES (?, ?, ?)', res.pack.packHash, r.recipeId, JSON.stringify(res.pack));
      const seq = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_recipes')!.n + 1;
      this.store.run('INSERT OR REPLACE INTO saved_recipes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.recipeId, versionId, res.pack?.packHash ?? '', draftId, r.revision, a.idempotencyKey ?? null, JSON.stringify(release), seq, this.now());
      return { recipeId: r.recipeId, recipeVersionId: versionId, release };
    });
  }

  /** Latest saved version per imported recipe, for list_recipes / start_recipe. */
  catalog(): { pack: RecipePack | null; recipeId: Id; versionId: string; release: Release; title: string; meta: string; sourceLabel: string }[] {
    const rows = this.store.all<{ recipe_id: string; version_id: string; pack_hash: string; draft_id: string; release_json: string }>(
      'SELECT * FROM saved_recipes s WHERE seq = (SELECT MAX(seq) FROM saved_recipes WHERE recipe_id = s.recipe_id) ORDER BY seq');
    return rows.map((x) => {
      const packRow = x.pack_hash ? this.store.get<{ json: string }>('SELECT json FROM packs WHERE pack_hash = ?', x.pack_hash) : undefined;
      const pack = packRow ? JSON.parse(packRow.json) as RecipePack : null;
      const src = this.draftSources(x.draft_id)[0];
      const pages = src?.text.pages.filter((p) => p.page !== null).length ?? 0;
      return { pack, recipeId: x.recipe_id, versionId: x.version_id, release: JSON.parse(x.release_json) as Release,
        title: pack?.recipe.title ?? this.effective(x.draft_id)?.title ?? 'Imported recipe', meta: pack?.recipe.meta ?? '',
        sourceLabel: src ? `${src.displayName}${pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''}` : '' };
    });
  }

  getRecipe(recipeId: Id) {
    const e = this.catalog().find((x) => x.recipeId === recipeId);
    if (!e) throw new NotFound(recipeId);
    const draftId = this.store.get<{ draft_id: string }>('SELECT draft_id FROM saved_recipes WHERE recipe_id = ? AND version_id = ?', recipeId, e.versionId)!.draft_id;
    return { version: { id: e.versionId, recipeId, createdFromDraft: draftId, content: e.pack ? recipeContent(e.pack.recipe, this.v, e.pack, e.pack.recipe, this.content.patterns, { pending: false }) : null, release: e.release }, sources: this.wireSources(draftId),
      sourceLines: this.sourceLines(draftId), sourceRefs: this.body(draftId)?.sourceRefs ?? {} };   // "View source" on a reopened recipe
  }

  // ---------- wire ----------
  wireSources(draftId: Id): WireSourceDoc[] {
    return this.draftSources(draftId).map((s) => ({
      id: s.sourceId, kind: s.kind === 'PDF' ? 'pdf' as const : 'pastedText' as const, origin: s.origin === 'UPLOAD' ? 'upload' as const : 'cookPasted' as const,
      displayName: s.displayName, pageCount: s.kind === 'PDF' ? s.text.pages.length : null,
      pages: s.text.pages.map((p, i) => ({ index: p.page ?? i + 1, readable: p.status === 'TEXT' ? 'text' as const : 'image' as const })), byteSize: s.byteLength,
    }));
  }
  wireDraft(draftId: Id): WireDraft {
    const body = this.body(draftId), r = this.effective(draftId);
    const { pack } = this.coverageOf(draftId);
    const saved = this.store.get<{ recipe_id: string; version_id: string; draft_revision: number }>('SELECT recipe_id, version_id, draft_revision FROM saved_recipes WHERE draft_id = ? ORDER BY seq DESC LIMIT 1', draftId);
    // the swap analysis of this reading may still be running (a job past the reading stages): those uses are pending
    const pending = !!this.store.get(`SELECT 1 FROM import_jobs WHERE draft_id = ? AND state IN ('queued', 'running')`, draftId);
    const content = r ? recipeContent(r, this.v, pack ?? emptyPack(r), r, this.content.patterns, { pending }) : null;
    // the model's role guesses stay on the wire for display only ("import guessed …"); they never bind
    for (const u of content?.ingredients.flatMap((i) => i.uses) ?? []) {
      const g = body!.recipe.uses.find((x) => x.useId === u.id)?.functions ?? [];
      u.proposedFunction = g.length ? { labels: g.map((f) => functionLabel(this.v, f.functionId)), origin: 'import-inference' } : null;
    }
    return {
      id: draftId, revision: this.revision(draftId), sourceDocIds: this.draftSources(draftId).map((s) => s.sourceId),
      content, blockers: this.blockers(draftId), issues: body?.issues ?? [],
      savedAs: saved ? { recipeId: saved.recipe_id, recipeVersionId: saved.version_id, draftRevision: saved.draft_revision } : null, sourceRefs: body?.sourceRefs ?? {},
    };
  }
  getDraft(draftId: Id) { this.revision(draftId); return { draft: this.wireDraft(draftId), sources: this.wireSources(draftId), sourceLines: this.sourceLines(draftId) }; }
  /** Every source line as read (the review canvas's source pane). Pages without a text layer appear as one marker line. */
  sourceLines(draftId: Id) {
    return this.draftSources(draftId).flatMap((s) => s.text.pages.flatMap((p) => p.status === 'TEXT'
      ? p.lines.map((l) => ({ sourceDocId: s.sourceId, page: p.page, lineId: l.lineId, text: l.text, origin: s.origin, image: false }))
      : [{ sourceDocId: s.sourceId, page: p.page, lineId: `image.p${p.page}`, text: `Page ${p.page} · scanned image · not read`, origin: s.origin, image: true }]));
  }
  /** Vocabulary choices for owner review forms (labels only; ids are what an assertion records). */
  vocabulary() {
    return {
      functions: this.v.functions.map((f) => ({ id: f.functionId, label: f.label })),
      techniques: this.v.techniques.map((t) => ({ id: t.techniqueId, label: t.label })),
      kinds: this.v.kinds.map((k) => ({ id: k.kindId, label: k.label })),
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
/**
 * Identity (commission 2026-10-07): an ingredient whose name, preparation words set aside, is a kind's label or TRUE alias
 * is that kind, REVIEWED by CONTENT, whatever kind (or none) the reading proposed; a disagreeing tag is returned. A name no
 * kind owns keeps the reading's tag as PROPOSED (never promoted). Sharing a class never makes two kinds one ingredient.
 * A proposed technique counts when the step text has one of its approved cues.
 */
export function resolveIdentity(r: Recipe, v: Vocabulary, roles: RoleTable): { ingredientId: Id; name: string; proposed: Id | null; kindId: Id }[] {
  const corrected: { ingredientId: Id; name: string; proposed: Id | null; kindId: Id }[] = [];
  for (const i of r.ingredients) {
    if (i.kind?.prov.status === 'REVIEWED') continue;
    const k = kindByName(v, i.name);
    if (!k) continue;
    if (i.kind?.kindId !== k.kindId) corrected.push({ ingredientId: i.ingredientId, name: i.name, proposed: i.kind?.kindId ?? null, kindId: k.kindId });
    i.kind = { kindId: k.kindId, prov: content('vocabulary.json#aliases') };
  }
  for (const s of r.steps) {
    const t = s.technique, text = renderStep(r, s);
    if (t?.prov.status === 'PROPOSED' && (roles.cues[t.techniqueId] ?? []).some((c) => new RegExp(c, 'i').test(text))) s.technique = { techniqueId: t.techniqueId, prov: content('roles.json#cues') };
  }
  return corrected;
}

export function applyAuthority(r: Recipe, v: Vocabulary, roles: RoleTable, cardFunctions: Map<Id, Id[]> = new Map(), cardRef = 'card'): { useId: Id; card: Id[]; table: Id[] }[] {
  resolveIdentity(r, v, roles);
  const disagreements: { useId: Id; card: Id[]; table: Id[] }[] = [];
  for (const u of r.uses) {
    const fns = cardFunctions.get(u.useId);
    const k = getIngredient(r, u.ingredientId)?.kind, t = getStep(r, u.stepId)?.technique;
    const row = u.kind === 'ADD' && k?.prov.status === 'REVIEWED' && t?.prov.status === 'REVIEWED' ? roles.roles.find((x) => x.kindId === k.kindId && x.techniqueId === t.techniqueId) : undefined;
    if (row) {
      u.functions = row.functions.map((f) => ({ functionId: f, label: null, prov: content(`roles.json#${row.kindId}×${row.techniqueId} (${roles.decisionRef}; R-1)`) }));
      if (fns && !sameSet(row.functions, fns)) disagreements.push({ useId: u.useId, card: fns, table: row.functions });
      continue;
    }
    if (fns) u.functions = fns.map((f) => ({ functionId: f, label: null, prov: { status: 'PROPOSED', by: 'MODEL', ref: cardRef } }));
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
