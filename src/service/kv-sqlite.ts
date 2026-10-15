// The kv.ts contract on one local SQLite file (node:sqlite, WAL): local runs and the test suites. One product process per
// file, as before; every write() is one BEGIN IMMEDIATE transaction.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bounds, decode, encode, WriteConflict, type Item, type Key, type Kv, type Op, type Stored } from './kv.ts';

export class SqliteKv implements Kv {
  readonly name = 'sqlite';
  readonly owner = `sqlite-${randomUUID()}`;
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv(pk TEXT NOT NULL, sk TEXT NOT NULL, v INTEGER, n INTEGER, d BLOB, PRIMARY KEY(pk, sk)) WITHOUT ROWID;`);
  }
  alive(owner: string) { return owner === this.owner; }
  private row(k: Key) { return this.db.prepare('SELECT pk, sk, v, n, d FROM kv WHERE pk = ? AND sk = ?').get(k.pk, k.sk) as Stored | undefined; }
  async get(k: Key) { const r = this.row(k); return r && decode(r); }
  async getMany(ks: Key[]) { return ks.map((k) => { const r = this.row(k); return r && decode(r); }); }
  async query(pk: string, o: { prefix?: string; after?: string; limit?: number; desc?: boolean } = {}) {
    const [lo, hi] = bounds(o);
    return (this.db.prepare(`SELECT pk, sk, v, n, d FROM kv WHERE pk = ? AND sk >= ? AND sk <= ? ORDER BY sk ${o.desc ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(pk, lo, hi, o.limit ?? -1) as unknown as Stored[]).map(decode);
  }
  async write(ops: Op[]) {
    const stored = ops.map((op) => ('put' in op ? encode(op.put) : null));   // size errors before anything is written
    this.db.exec('BEGIN IMMEDIATE');
    try {
      ops.forEach((op, i) => {
        const k = 'put' in op ? op.put : 'del' in op ? op.del : op.check;
        const cur = op.if === undefined ? undefined : this.db.prepare('SELECT v FROM kv WHERE pk = ? AND sk = ?').get(k.pk, k.sk) as { v: number | null } | undefined;
        if (op.if === 'absent' ? cur !== undefined : op.if !== undefined && cur?.v !== op.if) throw new WriteConflict(`${k.pk} ${k.sk}`);
        if ('put' in op) { const s = stored[i]!; this.db.prepare('INSERT OR REPLACE INTO kv(pk, sk, v, n, d) VALUES (?, ?, ?, ?, ?)').run(s.pk, s.sk, s.v ?? null, s.n ?? null, s.d ?? null); }
        else if ('del' in op) this.db.prepare('DELETE FROM kv WHERE pk = ? AND sk = ?').run(k.pk, k.sk);
      });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async incr(k: Key) {
    return (this.db.prepare('INSERT INTO kv(pk, sk, n) VALUES (?, ?, 1) ON CONFLICT(pk, sk) DO UPDATE SET n = coalesce(n, 0) + 1 RETURNING n').get(k.pk, k.sk) as { n: number }).n;
  }
  async *scan(): AsyncIterable<Item[]> { yield (this.db.prepare('SELECT pk, sk, v, n, d FROM kv ORDER BY pk, sk').all() as unknown as Stored[]).map(decode); }
  close() { this.db.close(); }
}
