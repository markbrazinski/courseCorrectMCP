// Durable storage (Lambda deployment, 2026-10-09): one DynamoDB-shaped key-value table with the same contract on SQLite
// (local runs and tests, kv-sqlite.ts) and DynamoDB (Lambda, kv-dynamo.ts). Replaces the SQLite tables of ESOD §7.1.
//
// A workspace is one partition (pk W#<id>). A workspace transaction (tx) is optimistic and serializable:
//  - every mutable item it reads is validated at commit (its version `v`, or its absence), and every write is conditional
//    on the version it was based on. DynamoDB documents that several GetItems running beside a transaction "can be run in
//    any order … the results are read-committed", so a reader can see half of another transaction; validating each item
//    read turns that into a retry, never a decision on mixed state.
//  - the workspace head (META) is read first and rewritten by every write transaction, so writes in one workspace are
//    serialized (the BEGIN IMMEDIATE of the SQLite build) and a range whose parent is META can't change unseen.
//  - ranges (query) are read only under a parent item that every insert into the range also rewrites (a run's versions and
//    amendments under RUN#, a draft's bodies and facts under DR#, saved recipes under META).
//  - immutable items (packs, run versions, sources, bodies) are read with fixed()/must() and not validated; must() retries
//    when an item a parent already names hasn't become visible yet.
//  - a transaction function never calls a model or another service: it may run more than once.
import { gunzipSync, gzipSync } from 'node:zlib';

export interface Key { pk: string; sk: string }
export type Item = Key & { v?: number; n?: number } & Record<string, unknown>;
/** 'absent': the item must not exist; a number: the item's v must equal it. */
export type Cond = 'absent' | number;
export type Op = { put: Item; if?: Cond } | { del: Key; if?: Cond } | { check: Key; if: Cond };
export class WriteConflict extends Error {}
/** A read saw another transaction half-applied (or a condition failed): run the transaction function again. */
export class Retry extends Error {}

export interface Kv {
  readonly name: string;
  /** Who stamps PENDING work (receipts, evaluations, import jobs) in this process. */
  readonly owner: string;
  /** Whether a writer that stamped `owner` may still be running. SQLite (one product process per file) knows that a
   *  different owner is a process that has ended; DynamoDB can't know, so PENDING work there expires by its lease. */
  alive(owner: string): boolean;
  /** Strongly consistent. */
  get(k: Key): Promise<Item | undefined>;
  /** Serializable with write(): never observes a transaction half-applied (DynamoDB TransactGetItems, ≤100 per call). */
  getMany(ks: Key[]): Promise<(Item | undefined)[]>;
  /** Strongly consistent, in sk order. `after`: exclusive start. */
  query(pk: string, o?: { prefix?: string; after?: string; limit?: number; desc?: boolean }): Promise<Item[]>;
  /** All or nothing; WriteConflict when a condition fails or another transaction holds an item. */
  write(ops: Op[]): Promise<void>;
  /** Atomic counter (attribute n); outside workspace transactions. */
  incr(k: Key): Promise<number>;
  /** Owner tooling only (backup): every item of the table, in pages. Never on a request path. */
  scan?(): AsyncIterable<Item[]>;
}

// ---------- encoding (shared, so the 400 KB item limit fails the same way locally and on DynamoDB) ----------
export const MAX_ITEM_BYTES = 400 * 1024;
const GZIP_OVER = 64 * 1024;
export interface Stored { pk: string; sk: string; v?: number; n?: number; d?: string | Uint8Array }
export function encode(item: Item): Stored {
  const { pk, sk, v, n, ...rest } = item;
  const json = JSON.stringify(rest);
  const d = Buffer.byteLength(json) > GZIP_OVER ? new Uint8Array(gzipSync(json)) : json;
  const size = 2 + Buffer.byteLength(pk) + 2 + Buffer.byteLength(sk) + 1 + (typeof d === 'string' ? Buffer.byteLength(d) : d.length) + (v === undefined ? 0 : 22) + (n === undefined ? 0 : 22);
  if (size > MAX_ITEM_BYTES) throw new Error(`ITEM_TOO_LARGE: ${pk} ${sk} is ${size} bytes (limit ${MAX_ITEM_BYTES})`);
  return { pk, sk, ...(v === undefined ? {} : { v }), ...(n === undefined ? {} : { n }), d };
}
export function decode(s: Stored): Item {
  const body = s.d === undefined || s.d === null ? {} : JSON.parse(typeof s.d === 'string' ? s.d : gunzipSync(s.d).toString('utf8')) as Record<string, unknown>;
  return { ...body, pk: s.pk, sk: s.sk, ...(s.v === undefined || s.v === null ? {} : { v: Number(s.v) }), ...(s.n === undefined || s.n === null ? {} : { n: Number(s.n) }) };
}
/** Range bounds for a prefix and an exclusive start (keys here are ASCII). */
export function bounds(o: { prefix?: string; after?: string } = {}): [string, string] {
  const p = o.prefix ?? '';
  const lo = o.after !== undefined && o.after >= p ? `${o.after}\u0000` : p;
  return [lo, `${p}￿`];
}

// ---------- the owner's maintenance switch (src/ops/lifecycle.ts sets it; the web function reads it per request) ----------
export const CONTROL = { pk: 'CONTROL', sk: 'MODE' };
export async function maintenanceMode(kv: Kv) { return (await kv.get(CONTROL)) as (Item & { frozen?: boolean; at?: string; reason?: string }) | undefined; }

// ---------- keys ----------
export const wsPk = (ws: string) => `W#${ws}`;
export const pad = (n: number) => String(n).padStart(8, '0');
export const META = 'META';

// ---------- the workspace transaction ----------
type Pending = { put: Item; create: boolean } | { del: true; base: number | undefined };
export class Tx {
  readonly pk: string;
  private readonly reads = new Map<string, Item | undefined>();     // validated at commit
  private readonly fixedReads = new Map<string, Item | undefined>();
  private readonly writes = new Map<string, Pending>();
  readonly kv: Kv; readonly ws: string;
  constructor(kv: Kv, ws: string) { this.kv = kv; this.ws = ws; this.pk = wsPk(ws); }

  /** A mutable item (validated at commit). Reads this transaction's own writes. */
  async get<T extends object = Record<string, unknown>>(sk: string): Promise<(T & Item) | undefined> {
    const w = this.writes.get(sk);
    if (w) return ('put' in w ? w.put : undefined) as (T & Item) | undefined;
    if (!this.reads.has(sk)) this.reads.set(sk, await this.kv.get({ pk: this.pk, sk }));
    return this.reads.get(sk) as (T & Item) | undefined;
  }
  /** An immutable item (written once, never changed): not validated. */
  async fixed<T extends object = Record<string, unknown>>(sk: string): Promise<(T & Item) | undefined> {
    const w = this.writes.get(sk);
    if (w) return ('put' in w ? w.put : undefined) as (T & Item) | undefined;
    if (this.reads.has(sk)) return this.reads.get(sk) as (T & Item) | undefined;
    if (!this.fixedReads.has(sk)) this.fixedReads.set(sk, await this.kv.get({ pk: this.pk, sk }));
    return this.fixedReads.get(sk) as (T & Item) | undefined;
  }
  /** An immutable item that a validated parent names: absent means not visible yet, so the transaction runs again. */
  async must<T extends object = Record<string, unknown>>(sk: string): Promise<T & Item> {
    const x = await this.fixed<T>(sk);
    if (!x) { this.fixedReads.delete(sk); throw new Retry(`not visible yet: ${sk}`); }
    return x;
  }
  /** A range under a parent item the caller reads with get(). Includes this transaction's own writes. */
  async query<T extends object = Record<string, unknown>>(prefix: string, o: { desc?: boolean; limit?: number } = {}): Promise<(T & Item)[]> {
    const m = new Map((await this.kv.query(this.pk, { prefix })).map((r) => [r.sk, r]));   // ponytail: whole range; every range here is small (one run, one draft, one workspace's book)
    for (const [sk, w] of this.writes) if (sk.startsWith(prefix)) { if ('put' in w) m.set(sk, w.put); else m.delete(sk); }
    const out = [...m.values()].sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (o.desc) out.reverse();
    return (o.limit ? out.slice(0, o.limit) : out) as (T & Item)[];
  }
  /** Write an item; its `v` (from the read it is based on) is the version the write requires. No `v`: it must not exist. */
  put(sk: string, data: object) { this.writes.set(sk, { put: { ...data, pk: this.pk, sk } as Item, create: (data as { v?: number }).v === undefined }); }
  del(sk: string, base: Item) { this.writes.set(sk, { del: true, base: base.v }); }
  get dirty() { return this.writes.size > 0; }

  /** Every mutable item read is still the version read (serializable read; nothing is written). */
  async validate() {
    const keys = [...this.reads.keys()];
    const now = await this.kv.getMany(keys.map((sk) => ({ pk: this.pk, sk })));
    if (keys.some((sk, i) => this.reads.get(sk)?.v !== now[i]?.v)) throw new Retry('read set changed');
  }

  /** Read-only: validate. With writes (or a changed head): commit them atomically with the new head, conditional on every read. */
  async commit(head: Item | undefined, meta: object, metaChanged: boolean) {
    if (!this.writes.size && !metaChanged) return this.validate();
    this.put(META, { ...meta, ...(head?.v === undefined ? {} : { v: head.v }) });
    const ops: Op[] = [];
    for (const [sk, w] of this.writes) {
      if ('put' in w) {
        const base = w.put.v;
        ops.push({ put: { ...w.put, v: (base ?? 0) + 1 }, if: base === undefined ? 'absent' : base });
      } else ops.push({ del: { pk: this.pk, sk }, if: w.base === undefined ? 'absent' : w.base });
    }
    for (const [sk, it] of this.reads) if (!this.writes.has(sk)) ops.push({ check: { pk: this.pk, sk }, if: it?.v === undefined ? 'absent' : it.v });
    if (ops.length > 100) throw new Error(`transaction too large (${ops.length} items)`);
    await this.kv.write(ops);
  }
}
const stripKeys = ({ pk: _p, sk: _s, v: _v, ...rest }: Record<string, unknown>) => rest;

export class Busy extends Error {}
const TRIES = 12;
const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(200, 5 * 2 ** attempt)));

/** The workspace's head: its epoch (kitchen reset counter), active run, archived recipes and saved-recipe sequence. */
export interface Meta { epoch: number; activeRunId: string | null; archived: Record<string, { versionId: string; commandId: string; at: string }>; savedSeq: number; createdAt?: string }
const freshMeta = (): Meta => ({ epoch: 1, activeRunId: null, archived: {}, savedSeq: 0 });

/**
 * Run fn as one serializable workspace transaction (see the header). fn gets the transaction and the head (mutable; any
 * change is committed). Conflicts and half-visible reads run fn again with fresh reads (bounded; then Busy).
 */
export async function tx<T>(kv: Kv, ws: string, fn: (t: Tx, meta: Meta) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t = new Tx(kv, ws);
    const head = await t.get<Meta>(META);
    const meta: Meta = { ...freshMeta(), ...(head ? stripKeys(head) as unknown as Meta : {}) };
    meta.archived = { ...meta.archived };
    const before = JSON.stringify(meta);
    try {
      const out = await fn(t, meta);
      await t.commit(head, meta, JSON.stringify(meta) !== before);
      return out;
    } catch (e) {
      let again = e instanceof Retry || e instanceof WriteConflict;
      if (!again) {   // a decision made on a stale read is retried, never returned
        try { await t.validate(); } catch (v) { again = v instanceof Retry || v instanceof WriteConflict; }
        if (!again) throw e;
      }
      if (attempt + 1 >= TRIES) throw new Busy(`workspace busy: ${(e as Error).message}`);
      await backoff(attempt);
    }
  }
}
