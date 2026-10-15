// Environment lifecycle over the store (owner tooling; tested without AWS in tests/acceptance/lifecycle.test.ts):
//  - maintenance: a switch the web function reads before every request. While frozen, no new request starts; requests
//    already running finish within the function timeout, and accepted import jobs finish in the worker. A backup waits
//    for that, so what it exports can't change underneath it.
//  - spending lifetimes: a table's ledger totals are one lifetime. Destroying the table closes it into the local history;
//    a new table starts a new lifetime that carries every closed one (LEDGER CARRIED, keyed by lifetime id, so merging the
//    same lifetime twice is a no-op). Caps and the project ceiling count carried + current: never reset, never doubled.
import { randomUUID } from 'node:crypto';
import { LEDGER, type Purpose } from '../authoring/nova.ts';
import { JOB_LIMITS } from '../authoring/drafts.ts';
import { CONTROL, maintenanceMode, WriteConflict, type Item, type Kv } from '../service/kv.ts';
import { listReleases, loadRelease } from '../knowledge/release.ts';

export { CONTROL };
export const LIFETIME = { pk: LEDGER, sk: 'LIFETIME' }, CARRIED = { pk: LEDGER, sk: 'CARRIED' };
/** A closed spending lifetime: one table's ledger totals when it was destroyed (or found in a restored backup). */
export interface Closed { lifetime: string; closedAt: string; source: 'destroy' | 'restore'; usd: number; byAuth: Record<string, { calls: Partial<Record<Purpose, number>>; usd: number; usdBy?: Partial<Record<Purpose, number>> }> }
/** Longest any request runs (web function timeout 60 s), plus margin. */
export const REQUEST_DRAIN_MS = 70_000;

async function update(kv: Kv, key: { pk: string; sk: string }, f: (cur: Item | undefined) => Record<string, unknown> | null) {
  for (let i = 0; i < 10; i++) {
    const cur = await kv.get(key), next = f(cur);
    if (!next) return cur;
    try { await kv.write([{ put: { ...key, ...next, v: (cur?.v ?? 0) + 1 }, if: cur?.v ?? 'absent' }]); return next; }
    catch (e) { if (!(e instanceof WriteConflict)) throw e; await new Promise((r) => setTimeout(r, 50 * (i + 1))); }
  }
  throw new Error(`could not update ${key.pk} ${key.sk}`);
}

// ---------- maintenance ----------
export const mode = maintenanceMode;
export async function freeze(kv: Kv, reason: string, now = () => new Date().toISOString()) {
  return update(kv, CONTROL, (cur) => (cur?.frozen ? null : { frozen: true, at: now(), reason }));   // already frozen: keep the original time
}
export function unfreeze(kv: Kv) { return update(kv, CONTROL, (cur) => (cur?.frozen ? { frozen: false, at: new Date().toISOString(), reason: '' } : null)); }

/** Work that may still write: accepted import jobs whose runner can still be alive, and paid calls reserved but not settled. */
export async function inflight(items: AsyncIterable<Item[]>, nowMs = Date.now()) {
  const jobs: string[] = [], reservations: string[] = [];
  for await (const page of items) for (const x of page) {
    if (x.sk.startsWith('JOB#') && (x.state === 'queued' || x.state === 'running')) {
      const since = Date.parse(String(x.state === 'running' ? x.claimedAt : x.createdAt));
      if (nowMs - since <= (x.state === 'running' ? JOB_LIMITS.runningMs : JOB_LIMITS.queuedMs)) jobs.push(`${x.pk} ${x.jobId as string} ${x.state as string}`);
    }
    if (x.pk === LEDGER && x.sk.startsWith('R#') && x.state === 'reserved' && nowMs - Date.parse(String(x.at)) <= JOB_LIMITS.runningMs) reservations.push(x.key as string);
  }
  return { jobs, reservations };
}

// ---------- spending lifetimes ----------
/** The current table's lifetime, created (with every closed lifetime carried) the first time a deploy finds none. */
export async function openLifetime(kv: Kv, history: Closed[]): Promise<{ lifetime: string; created: boolean }> {
  const cur = await kv.get(LIFETIME);
  if (cur) return { lifetime: cur.id as string, created: false };
  const id = `lt_${randomUUID()}`;
  try {
    await kv.write([{ put: { ...LIFETIME, id, createdAt: new Date().toISOString(), v: 1 }, if: 'absent' }, { put: { ...CARRIED, closed: dedupe(history), v: 1 }, if: 'absent' }]);
    return { lifetime: id, created: true };
  } catch (e) { if (e instanceof WriteConflict) return { lifetime: (await kv.get(LIFETIME))!.id as string, created: false }; throw e; }
}
/** This table's own spending (its lifetime), from its ledger totals: what destroying it must carry forward. */
export async function closeLifetime(kv: Kv, source: Closed['source'] = 'destroy'): Promise<Closed> {
  const lt = await kv.get(LIFETIME), totals = await kv.query(LEDGER, { prefix: 'TOTAL#' });
  return fromTotals((lt?.id as string | undefined) ?? 'lt_unrecorded', totals, source);
}
function fromTotals(lifetime: string, totals: Item[], source: Closed['source']): Closed {
  const all = totals.find((t) => t.sk === 'TOTAL#ALL');
  return { lifetime, closedAt: new Date().toISOString(), source, usd: (all?.usd as number | undefined) ?? 0,
    byAuth: Object.fromEntries(totals.filter((t) => t.sk !== 'TOTAL#ALL').map((t) => [t.sk.slice('TOTAL#'.length), { calls: (t.calls ?? {}) as Partial<Record<Purpose, number>>, usd: (t.usd as number | undefined) ?? 0, usdBy: (t.usdBy ?? {}) as Partial<Record<Purpose, number>> }])) };
}
export const dedupe = (xs: Closed[]) => [...new Map(xs.map((x) => [x.lifetime, x])).values()];
/** Merge closed lifetimes into the current table's carried spending. Idempotent: a lifetime already carried is skipped. */
export async function carry(kv: Kv, closed: Closed[]) {
  const lt = (await kv.get(LIFETIME))?.id;
  return update(kv, CARRIED, (cur) => {
    const have = (cur?.closed ?? []) as Closed[], ids = new Set(have.map((c) => c.lifetime));
    const add = closed.filter((c) => !ids.has(c.lifetime) && c.lifetime !== lt);   // never the current lifetime: its totals are live
    return add.length ? { closed: dedupe([...have, ...add]) } : null;
  });
}

/**
 * Restore plan for a backup's items into a fresh table. Never written: the target's own authorization and ledger totals
 * (counters of THIS lifetime), its lifetime and carried record, transient counters, the maintenance switch. The backup's
 * spending comes back as carried lifetimes instead: its own lifetime (from its totals) and whatever it already carried.
 */
export function planRestore(items: Item[]): { write: Item[]; carry: Closed[]; lifetime: string | null } {
  const skip = (x: Item) => x.pk === CONTROL.pk || (x.pk === 'GATE' && x.sk.startsWith('FAIL#'))
    || (x.pk === LEDGER && (x.sk === 'AUTH' || x.sk.startsWith('TOTAL#') || x.sk === 'LIFETIME' || x.sk === 'CARRIED' || x.sk.startsWith('WSDAY#')));
  const lt = items.find((x) => x.pk === LEDGER && x.sk === 'LIFETIME')?.id as string | undefined;
  const carried = (items.find((x) => x.pk === LEDGER && x.sk === 'CARRIED')?.closed ?? []) as Closed[];
  const totals = items.filter((x) => x.pk === LEDGER && x.sk.startsWith('TOTAL#'));
  const own = totals.length ? [fromTotals(lt ?? 'lt_unrecorded', totals, 'restore')] : [];
  return { write: items.filter((x) => !skip(x)), carry: dedupe([...carried, ...own]), lifetime: lt ?? null };
}

// ---------- knowledge releases (2026-10-11): backed up, restored and checked with the recipes that are pinned to them ----------
/** The releases a workspace table's recipes depend on: pinned ones by id (packs, saved recipes, drafts, runs), and packs saved
 *  before releases by the vocabulary and pattern-set hashes a release must match. */
export function referencedReleases(items: Iterable<Item>): { pinned: string[]; legacy: { vocabularyHash: string; patternSetHash: string; where: string }[] } {
  const pinned = new Set<string>(), legacy = new Map<string, { vocabularyHash: string; patternSetHash: string; where: string }>();
  for (const x of items) {
    if (!x.pk.startsWith('W#')) continue;
    const pack = x.sk.startsWith('PACK#') ? x.pack as { knowledgeReleaseId?: string; vocabularyHash: string; patternSetHash: string } : null;
    const id = pack?.knowledgeReleaseId ?? (x.sk.startsWith('SAVED#') || x.sk.startsWith('DR#') ? x.knowledgeReleaseId as string | undefined
      : x.sk.startsWith('RUN#') && !x.sk.includes('#', 4) ? (x.knowledge as { releaseId?: string | null } | undefined)?.releaseId ?? undefined : undefined);
    if (id) pinned.add(id);
    else if (pack) legacy.set(`${pack.vocabularyHash}|${pack.patternSetHash}`, { vocabularyHash: pack.vocabularyHash, patternSetHash: pack.patternSetHash, where: `${x.pk} ${x.sk}` });
  }
  return { pinned: [...pinned].sort(), legacy: [...legacy.values()] };
}

/** Write a backup's knowledge items into a knowledge table. Never overwrites: a release already there is the same release (its
 *  id is its content); an ACTIVE pointer already there is kept. Returns what it wrote and kept. */
export async function restoreKnowledge(kv: Kv, items: Item[]): Promise<{ written: number; kept: number; active: string | null }> {
  let written = 0, kept = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      try { await kv.write([{ put: x, if: 'absent' }]); written++; }
      catch (e) { if (!(e instanceof WriteConflict)) throw e; kept++; }
    }
  }));
  return { written, kept, active: ((await kv.get({ pk: 'KNOWLEDGE', sk: 'ACTIVE' }))?.releaseId as string | undefined) ?? null };
}

/** Every release the recipes depend on is present, PUBLISHED and verifies (hashes); every legacy pack matches one. */
export async function knowledgeGaps(kv: Kv, refs: ReturnType<typeof referencedReleases>): Promise<string[]> {
  const gaps: string[] = [];
  for (const id of refs.pinned) { try { await loadRelease(kv, id); } catch (e) { gaps.push(`${id}: ${(e as Error).message}`); } }
  const published = await listReleases(kv);
  for (const l of refs.legacy) if (!published.some((m) => m.vocabularyHash === l.vocabularyHash && m.patternSetHash === l.patternSetHash)) gaps.push(`${l.where}: saved before releases; no published release matches it (its plans still work; nothing can be re-bound)`);
  return gaps;
}
