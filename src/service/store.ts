// One SQLite file (node:sqlite), WAL, BEGIN IMMEDIATE writes (ESOD §7.1). Only the tables M1 uses.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kitchens(kitchen_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS packs(pack_hash TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  run_id TEXT PRIMARY KEY, kitchen_id TEXT NOT NULL, recipe_id TEXT NOT NULL, pack_hash TEXT NOT NULL, epoch INTEGER NOT NULL,
  mode TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL, applied_rescue_count INTEGER NOT NULL,
  latest_evaluation_id TEXT, step_status TEXT NOT NULL, use_status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(kitchen_id) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS run_versions(run_id TEXT NOT NULL, version INTEGER NOT NULL, recipe_json TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run_id, version));
CREATE TABLE IF NOT EXISTS progress_events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, action_json TEXT NOT NULL, revision_after INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(run_id, seq));
CREATE TABLE IF NOT EXISTS evaluations(
  evaluation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, base_revision INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
  request_json TEXT NOT NULL, result_json TEXT, interpretation TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS amendments(
  amendment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, candidate_id TEXT NOT NULL, plan_hash TEXT NOT NULL,
  command_id TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, revision_after INTEGER NOT NULL,
  changed_step_ids TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(evaluation_id, candidate_id), UNIQUE(run_id, to_version));
CREATE TABLE IF NOT EXISTS receipts(
  kitchen_id TEXT NOT NULL, command_id TEXT NOT NULL, tool TEXT NOT NULL, run_id TEXT, payload_digest TEXT NOT NULL,
  state TEXT NOT NULL, result_json TEXT, at TEXT NOT NULL, PRIMARY KEY(kitchen_id, command_id));
CREATE TABLE IF NOT EXISTS sources(
  source_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, display_name TEXT NOT NULL,
  byte_length INTEGER NOT NULL, text_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_jobs(
  job_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, idempotency_key TEXT UNIQUE, state TEXT NOT NULL, stages_json TEXT NOT NULL,
  failure_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts(draft_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, revision INTEGER NOT NULL, body_revision INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS draft_sources(draft_id TEXT NOT NULL, seq INTEGER NOT NULL, source_id TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY(draft_id, seq));
CREATE TABLE IF NOT EXISTS draft_bodies(draft_id TEXT NOT NULL, body_revision INTEGER NOT NULL, author TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(draft_id, body_revision));
CREATE TABLE IF NOT EXISTS extractions(
  extraction_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, job_id TEXT NOT NULL, extractor TEXT NOT NULL, prompt_hash TEXT NOT NULL, status TEXT NOT NULL,
  raw_json TEXT, issues_json TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts(
  fact_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, core_hash TEXT NOT NULL, predicate TEXT NOT NULL,
  value_json TEXT NOT NULL, status TEXT NOT NULL, by TEXT NOT NULL, reviewer TEXT, at TEXT NOT NULL, retired_at TEXT);
CREATE TABLE IF NOT EXISTS saved_recipes(
  recipe_id TEXT NOT NULL, version_id TEXT NOT NULL, pack_hash TEXT NOT NULL, draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
  idempotency_key TEXT, release_json TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(recipe_id, version_id));
CREATE TABLE IF NOT EXISTS swap_analyses(
  analysis_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, extraction_id TEXT NOT NULL, analyzer TEXT NOT NULL, prompt_hash TEXT NOT NULL, input_hash TEXT NOT NULL,
  status TEXT NOT NULL, raw_json TEXT, refs_json TEXT NOT NULL, issues_json TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS demo_recipes(recipe_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS archived_recipes(recipe_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, command_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tool TEXT NOT NULL, correlation_id TEXT, status TEXT NOT NULL, summary TEXT NOT NULL,
  input_json TEXT, trace_json TEXT, duration_ms INTEGER, at TEXT NOT NULL);
`;

export type Row = Record<string, string | number | null>;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // ENGINE_SEMANTICS 2: a run may hold several amendments (one per version). Rebuild an older table that allowed one per run.
    const old = this.db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'amendments'`).get() as { sql: string } | undefined;
    if (old?.sql.includes('run_id TEXT NOT NULL UNIQUE')) {
      this.db.exec(`BEGIN IMMEDIATE; ALTER TABLE amendments RENAME TO amendments_v1; ${SCHEMA.match(/CREATE TABLE IF NOT EXISTS amendments\([\s\S]*?\);/)![0]}
        INSERT INTO amendments SELECT * FROM amendments_v1; DROP TABLE amendments_v1; COMMIT;`);
    }
  }
  get<T = Row>(sql: string, ...p: (string | number | null)[]): T | undefined { return this.db.prepare(sql).get(...p) as T | undefined; }
  all<T = Row>(sql: string, ...p: (string | number | null)[]): T[] { return this.db.prepare(sql).all(...p) as T[]; }
  run(sql: string, ...p: (string | number | null)[]) { return this.db.prepare(sql).run(...p); }
  /** One short BEGIN IMMEDIATE transaction; any throw rolls back and nothing is committed. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
