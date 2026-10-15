// The storage contract (src/service/kv.ts) both stores must keep: conditional writes, all-or-nothing transactions, ordered
// ranges, counters, the 400 KB item limit, and the workspace transaction's validation of everything it read. Runs on
// SQLite; with CC_TEST_DYNAMO_ENDPOINT (DynamoDB Local) the same assertions run against the DynamoDB adapter. Local
// emulation is not proof of the deployed service's behaviour (see LAMBDA-FIRST-SLICE-REPORT.md).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decode, encode, META, Retry, tx, WriteConflict, wsPk, type Item, type Key, type Kv, type Op } from '../../src/service/kv.ts';
import { newKv, newWs } from '../helpers.ts';

const k = (pk: string, sk: string): Key => ({ pk, sk });

describe('kv contract', () => {
  it('conditional put: absent, then only at the version read; a failed transaction writes nothing', async () => {
    const kv = newKv(), pk = wsPk(newWs());
    await kv.write([{ put: { ...k(pk, 'A'), v: 1, x: 1 }, if: 'absent' }]);
    await expect(kv.write([{ put: { ...k(pk, 'A'), v: 1, x: 2 }, if: 'absent' }])).rejects.toBeInstanceOf(WriteConflict);
    await kv.write([{ put: { ...k(pk, 'A'), v: 2, x: 2 }, if: 1 }]);
    await expect(kv.write([{ put: { ...k(pk, 'A'), v: 3, x: 3 }, if: 1 }])).rejects.toBeInstanceOf(WriteConflict);
    const ops: Op[] = [{ put: { ...k(pk, 'B'), v: 1, y: 1 }, if: 'absent' }, { check: k(pk, 'A'), if: 1 }];   // A is at 2: the whole write fails
    await expect(kv.write(ops)).rejects.toBeInstanceOf(WriteConflict);
    expect(await kv.get(k(pk, 'B'))).toBeUndefined();
    expect(await kv.get(k(pk, 'A'))).toMatchObject({ x: 2, v: 2 });
    await kv.write([{ del: k(pk, 'A'), if: 2 }]);
    expect(await kv.get(k(pk, 'A'))).toBeUndefined();
  });

  it('ranges are ordered, prefix-bounded, resumable after a key, and reversible; counters are atomic', async () => {
    const kv = newKv(), pk = wsPk(newWs());
    for (const sk of ['ACT#00000002', 'ACT#00000001', 'ACT#00000003', 'ACTSEQ', 'B#1']) await kv.write([{ put: { ...k(pk, sk), sk2: sk } }]);
    expect((await kv.query(pk, { prefix: 'ACT#' })).map((r) => r.sk)).toEqual(['ACT#00000001', 'ACT#00000002', 'ACT#00000003']);
    expect((await kv.query(pk, { prefix: 'ACT#', after: 'ACT#00000001' })).map((r) => r.sk)).toEqual(['ACT#00000002', 'ACT#00000003']);
    expect((await kv.query(pk, { prefix: 'ACT#', desc: true, limit: 1 })).map((r) => r.sk)).toEqual(['ACT#00000003']);
    expect(await Promise.all([1, 2, 3, 4, 5].map(() => kv.incr(k(pk, 'N'))))).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
    expect((await kv.query(pk)).find((r) => r.sk === 'N')).toMatchObject({ n: 5 });   // a counter (no body) reads back in a range
  });

  it('items over 64 KB are stored compressed; over 400 KB encoded they are refused before anything is written', async () => {
    const kv = newKv(), pk = wsPk(newWs());
    const big = { ...k(pk, 'BIG'), text: 'step text '.repeat(20_000) };   // ~200 KB of JSON, compresses well
    expect(typeof encode(big).d).not.toBe('string');
    await kv.write([{ put: big }]);
    expect((await kv.get(k(pk, 'BIG')))!.text).toBe(big.text);
    expect(decode(encode(big))).toMatchObject({ text: big.text });
    const random = { ...k(pk, 'HUGE'), blob: randomBytes(450_000).toString('base64') };
    await expect(kv.write([{ put: random }])).rejects.toThrow(/ITEM_TOO_LARGE/);
    expect(await kv.get(k(pk, 'HUGE'))).toBeUndefined();
  });
});

describe('workspace transactions', () => {
  it('two concurrent read-modify-writes of the same item: both land, serialized (no lost update)', async () => {
    const kv = newKv(), ws = newWs();
    await tx(kv, ws, async (t) => { t.put('C', { n: 0 }); });
    await Promise.all(Array.from({ length: 8 }, () => tx(kv, ws, async (t) => { const c = (await t.get<{ n: number }>('C'))!; t.put('C', { ...c, n: c.n + 1 }); })));
    expect((await kv.get({ pk: wsPk(ws), sk: 'C' }))!.n).toBe(8);
  });

  it('a decision made on a half-visible read is retried, never committed (DynamoDB: GetItems beside a transaction are read-committed)', async () => {
    const kv = newKv(), ws = newWs(), pk = wsPk(ws);
    await tx(kv, ws, async (t) => { t.put('RUN', { revision: 1 }); t.put('OTHER', { x: 1 }); });
    const stale = (await kv.get({ pk, sk: 'RUN' }))!;
    await tx(kv, ws, async (t) => { const r = (await t.get<{ revision: number }>('RUN'))!; t.put('RUN', { ...r, revision: 2 }); });
    // a store that serves the old RUN once (the head and everything else fresh): what a lagging replica read looks like
    let served = false;
    const laggy: Kv = { ...kv, name: kv.name, owner: kv.owner, alive: (o) => kv.alive(o), getMany: (ks) => kv.getMany(ks), query: (p, o) => kv.query(p, o), write: (ops) => kv.write(ops), incr: (x) => kv.incr(x),
      get: async (key) => (!served && key.sk === 'RUN' ? ((served = true), stale as Item) : kv.get(key)) };
    const seen: number[] = [];
    await tx(laggy, ws, async (t) => {   // "apply only at revision 1"
      const r = (await t.get<{ revision: number }>('RUN'))!;
      seen.push(r.revision);
      if (r.revision === 1) t.put('APPLIED', { at: 1 });
    });
    expect(seen).toEqual([1, 2]);                                  // first attempt saw the stale item; its commit failed validation
    expect(await kv.get({ pk, sk: 'APPLIED' })).toBeUndefined();   // nothing was applied on the stale read
  });

  it('a read-only transaction validates its reads; must() retries an item its parent names but that is not visible yet', async () => {
    const kv = newKv(), ws = newWs();
    await tx(kv, ws, async (t) => { t.put('P', { child: 'C1' }); });
    let tries = 0;
    await expect(tx(kv, ws, async (t) => { tries++; await t.get('P'); await t.must('C1'); })).rejects.toThrow(/busy/);   // never becomes visible: bounded
    expect(tries).toBeGreaterThan(1);
    await expect(tx(kv, ws, async () => { throw new Retry('x'); })).rejects.toThrow(/busy/);
    expect(await tx(kv, ws, async (t, meta) => ({ head: await t.get(META), epoch: meta.epoch }))).toMatchObject({ epoch: 1 });
  });
});
