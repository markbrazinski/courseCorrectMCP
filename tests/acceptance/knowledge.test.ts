// Knowledge releases in their own table (commission 2026-10-11): publication, verification, pinning, legacy packs, missing
// releases, caching. Runs on SQLite, and on DynamoDB Local (npm run test:dynamodb-local) with a table per test.
import { describe, expect, it } from 'vitest';
import type { Item, Kv } from '../../src/service/kv.ts';
import { compile } from '../../src/compile/binder.ts';
import { hash } from '../../src/domain/rational.ts';
import { expandRecipe } from '../../src/domain/recipe.ts';
import { activateRelease, activeReleaseId, listReleases, loadRelease, publishRelease, recordsOf, releaseIdOfFiles } from '../../src/knowledge/release.ts';
import { loadContent, staticKnowledge, storeKnowledge, KnowledgeUnavailable, type Content } from '../../src/service/content.ts';
import { K, type CatalogEntry } from '../../src/service/commands.ts';
import { wsPk } from '../../src/service/kv.ts';
import { biscuits, kitchen, newKnowledgeKv, r1Files, r2Files, APPROVED_DIR } from '../fixtures/successive.ts';
import { RECIPE } from '../fixtures/ids.ts';
import { cmd, content, fixtureActions, source } from '../helpers.ts';

/** The plan content a pack carries, without ids that only name the pack itself. */
const plans = (c: Content) => Object.fromEntries([...c.packs].map(([id, p]) => [id, {
  bindings: p.bindings.map((b) => ({ id: b.bindingId, pattern: `${b.patternId}@${b.patternVersion}`, ops: b.ops, quantities: b.quantities, functionMap: b.functionMap, factsHash: b.factsHash, guards: b.guards, covered: b.coveredSiblingUseIds })),
  coverage: p.coverage, warnings: p.warnings, recipeHash: p.recipeHash, vocabularyHash: p.vocabularyHash, patternSetHash: p.patternSetHash,
}]));
/** A store whose writes fail after `after` of them succeed: a publisher interrupted part-way (its process died). */
const interruptAfter = (kv: Kv, after: number): Kv => {
  let n = 0;
  return new Proxy(kv, { get(t, p) {
    if (p === 'write') return async (ops: Parameters<Kv['write']>[0]) => { if (++n > after) throw new Error('simulated interruption'); return t.write(ops); };
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
};

describe('migration parity: the same knowledge from the bundle and from the table gives the same plans', () => {
  it('every record is copied exactly; the release id is content-addressed; the example packs and their plans are identical', async () => {
    const kv = await newKnowledgeKv();
    const pub = await publishRelease(kv, r2Files(), { activate: true, note: 'parity', source: { commit: null, dir: 'content/approved' } });
    expect(pub).toMatchObject({ releaseId: content.releaseId, created: true, activated: true, previous: null });
    const { files, manifest } = await loadRelease(kv, pub.releaseId);
    // exact copies: each record's body hashes to the bundled file's hash (canonical JSON), and nothing is added or dropped
    expect(manifest.records.map((r) => [r.sk, r.sha256])).toEqual(recordsOf(r2Files()).map((r) => [r.entry.sk, r.entry.sha256]));
    expect(files).toEqual({ ...r2Files(), patterns: [...r2Files().patterns].sort((a, b) => `${a.patternId}@${a.version}`.localeCompare(`${b.patternId}@${b.version}`)) });
    expect(manifest.records.filter((r) => r.kind === 'pattern')).toHaveLength(13);
    // authority: owner-approved engineering content except the one commissioned addition; nothing claims physical validation
    expect(manifest.records.every((r) => r.authority.physicalValidation === 'NONE')).toBe(true);
    expect(manifest.records.filter((r) => r.authority.approval !== 'OWNER_APPROVED_ENGINEERING').map((r) => r.sk)).toEqual(['REC#pattern#evaporated_milk_for_milk@2']);
    expect(manifest.records.find((r) => r.sk === 'REC#pattern#caster_to_granulated@1')!.authority).toMatchObject({ decisionRef: 'OD-7', evidence: 'SOURCED' });
    // the plans: compiled from the table's copy vs from the bundled files, through the same code
    const fromTable = await storeKnowledge(kv).get(pub.releaseId);
    expect(plans(fromTable)).toEqual(plans(loadContent(APPROVED_DIR)));
    expect([...fromTable.packs.values()].map((p) => p.packHash)).toEqual([...content.packs.values()].map((p) => p.packHash));
  });

  it('R1 (the deployed knowledge) migrates with the same plans; R1 and R2 differ only by B7 v1 → v2, so only milk plans can differ', async () => {
    const kv = await newKnowledgeKv();
    const r1 = await publishRelease(kv, r1Files(), { activate: true });
    const a = await storeKnowledge(kv).get(r1.releaseId), bundledR1 = plans(a);
    // R1 compiled straight from files (no table) equals R1 from the table
    const direct = Object.fromEntries([...a.packs.keys()].map((id) => [id, compile(expandRecipe(source(id)), r1Files().vocabulary, r1Files().patterns, { releaseId: r1.releaseId }).pack!]));
    for (const [id, p] of Object.entries(direct)) expect(bundledR1[id].bindings).toEqual(p.bindings.map((x) => ({ id: x.bindingId, pattern: `${x.patternId}@${x.patternVersion}`, ops: x.ops, quantities: x.quantities, functionMap: x.functionMap, factsHash: x.factsHash, guards: x.guards, covered: x.coveredSiblingUseIds })));
    // the example recipes have no milk: their plans are the same under R1 and R2 (only the release, hence the pack hash, differs)
    const r2 = loadContent(APPROVED_DIR);
    for (const id of a.packs.keys()) {
      expect(plans(a)[id].bindings, id).toEqual(plans(r2)[id].bindings);
      expect(a.packs.get(id)!.packHash).not.toBe(r2.packs.get(id)!.packHash);
    }
    expect(r1.releaseId).not.toBe(r2.releaseId);
  });
});

describe('publication is all or nothing', () => {
  it('a publication interrupted at any point is never selectable; the active release stays; a rerun completes it', async () => {
    const kv = await newKnowledgeKv();
    const r1 = await publishRelease(kv, r1Files(), { activate: true });
    const records = recordsOf(r2Files()).length, r2 = releaseIdOfFiles(r2Files());
    for (const after of [0, 1, Math.floor(records / 2), records, records + 1]) {   // nothing / some records / all records / + STAGED manifest
      await expect(publishRelease(interruptAfter(kv, after), r2Files(), { activate: true })).rejects.toThrow('simulated interruption');
      expect(await activeReleaseId(kv), `after ${after} writes`).toBe(r1.releaseId);
      await expect(loadRelease(kv, r2)).rejects.toBeInstanceOf(KnowledgeUnavailable);
      await expect(activateRelease(kv, r2)).rejects.toThrow(/not published/);
      expect((await listReleases(kv)).map((x) => x.releaseId)).toEqual([r1.releaseId]);
      // the service keeps pinning new work to R1 and lists R1's example recipes
      const k = kitchen(storeKnowledge(kv));
      expect((await k.svc.listRecipes()).recipes).toHaveLength(3);
      expect((await storeKnowledge(kv).active()).releaseId).toBe(r1.releaseId);
    }
    const done = await publishRelease(kv, r2Files(), { activate: true });   // resumes the interrupted one (records already there are verified)
    expect(done).toMatchObject({ releaseId: r2, created: true, activated: true, previous: r1.releaseId });
    expect((await storeKnowledge(kv).active()).releaseId).toBe(r2);
    expect(await publishRelease(kv, r2Files(), { activate: true })).toMatchObject({ created: false, activated: false });   // idempotent
  });

  it('a damaged or extra record makes a release unreadable, never partly used; invalid content is refused before any write', async () => {
    const kv = await newKnowledgeKv();
    const { releaseId } = await publishRelease(kv, r2Files(), { activate: true });
    const rec = (await kv.get({ pk: `REL#${releaseId}`, sk: 'REC#pattern#split@2' }))!;
    await kv.write([{ put: { ...rec, body: { ...(rec.body as object), title: 'tampered' }, v: rec.v! + 1 }, if: rec.v! }]);
    await expect(loadRelease(kv, releaseId)).rejects.toThrow(/does not match its hash/);
    await expect(storeKnowledge(kv).active()).rejects.toBeInstanceOf(KnowledgeUnavailable);
    const bad = r2Files();
    bad.patterns[0] = { ...bad.patterns[0], target: { ...bad.patterns[0].target, ingredientClass: 'no-such-class' } };
    const empty = await newKnowledgeKv();
    await expect(publishRelease(empty, bad)).rejects.toThrow(/unknown class no-such-class/);
    expect(await empty.query(`REL#${releaseIdOfFiles(bad)}`)).toEqual([]);
  });
});

describe('version pinning', () => {
  it('a newer release changes newly prepared recipes; saved recipes and active sessions keep theirs', async () => {
    const kv = await newKnowledgeKv(), knowledge = storeKnowledge(kv);
    const r1 = (await publishRelease(kv, r1Files(), { activate: true })).releaseId;
    const k = kitchen(knowledge);
    const old = await k.importAndSave(biscuits());
    // an example recipe started under R1
    const ex = (await k.svc.listRecipes()).recipes.find((r) => /Scones/.test(r.title))!;
    const st = await k.start(ex.recipeId);
    expect(st.run.knowledge).toEqual({ releaseId: r1, basis: 'PINNED' });
    const runKey = { pk: wsPk(k.ws), sk: K.run(st.run.id) }, pinnedPack = (await k.kv.get(runKey))!.packHash;
    const r2 = (await publishRelease(kv, r2Files(), { activate: true })).releaseId;
    // newly prepared: R2
    const fresh = await k.importAndSave(biscuits());
    const packOf = async (recipeId: string) => (await k.auth.catalog()).find((e) => e.recipeId === recipeId)!.pack!;
    expect((await packOf(fresh.recipeId)).knowledgeReleaseId).toBe(r2);
    // already saved: still R1, byte for byte
    expect((await packOf(old.recipeId)).knowledgeReleaseId).toBe(r1);
    // the session started under R1 stays on R1 (and on the same pack) after R2 is published
    const run = await k.run();
    expect(run.knowledge).toEqual({ releaseId: r1, basis: 'PINNED' });
    expect((await k.kv.get(runKey))!.packHash).toBe(pinnedPack);
    // an evaluation says which release it was checked against
    const e = await k.ask(/heavy cream/i);
    expect(e.basis).toEqual({ revision: run.revision, version: 1, knowledgeReleaseId: r1, knowledgeBasis: 'PINNED' });
    // the example listed now is R2's; the R1 one keeps cooking
    expect((await k.svc.listRecipes()).recipes.find((r) => r.recipeId === ex.recipeId)!.currentVersionId).toBe(ex.currentVersionId);   // same recipe
    expect((await knowledge.active()).releaseId).toBe(r2);
  });
});

describe('recipes saved before releases existed (legacy packs)', () => {
  const legacyKitchen = async (kv: Kv) => {
    const k = kitchen(storeKnowledge(kv));
    // a pack exactly as the deployed build saved it: no release id, ENGINE_SEMANTICS of its day (hash recomputed as then)
    const r1 = r1Files(), recipe = expandRecipe(source(RECIPE['risotto.demo']));
    const pack = compile(recipe, r1.vocabulary, r1.patterns).pack!;
    delete pack.knowledgeReleaseId;
    const entry: CatalogEntry = { recipeId: 'rcp_legacy', pack: { ...pack, packHash: hash({ legacy: pack.packHash }) }, release: { kind: 'eligible', coverageSummary: '' }, title: 'Legacy risotto', meta: '', sourceLabel: '' };
    k.svc.catalog = async () => [entry];
    return { k, entry };
  };

  it('matched by its vocabulary and pattern hashes to a published release (HASH_MATCH), never written back', async () => {
    const kv = await newKnowledgeKv();
    const r1 = (await publishRelease(kv, r1Files(), { activate: true })).releaseId;
    await publishRelease(kv, r2Files(), { activate: true });
    const { k, entry } = await legacyKitchen(kv);
    const st = await k.start(entry.recipeId);
    expect(st.run.knowledge).toEqual({ releaseId: r1, basis: 'HASH_MATCH' });   // the release whose content it was compiled from, not the active one
    const stored = (await k.kv.get({ pk: wsPk(k.ws), sk: K.pack(entry.pack!.packHash) }))! as Item & { pack: { knowledgeReleaseId?: string } };
    expect(stored.pack.knowledgeReleaseId).toBeUndefined();
    for (const a of fixtureActions('risotto.step5')) await k.svc.recordProgress({ commandId: cmd(), runId: st.run.id, epoch: st.run.epoch, expectedRevision: (await k.run()).revision, ...a });
    const { second } = await k.propose(/wine/i);
    expect(second.outcome).toBe('proposal');   // its frozen plan still works
  });

  it('with no matching release it is UNPINNED: nothing is evaluated or applied, the recipe still reads, and the reason is said', async () => {
    const kv = await newKnowledgeKv();
    await publishRelease(kv, r2Files(), { activate: true });   // R1 was never published here
    const { k, entry } = await legacyKitchen(kv);
    const st = await k.start(entry.recipeId);
    expect(st.run.knowledge).toEqual({ releaseId: null, basis: 'UNPINNED' });
    for (const a of fixtureActions('risotto.step5')) await k.svc.recordProgress({ commandId: cmd(), runId: st.run.id, epoch: st.run.epoch, expectedRevision: (await k.run()).revision, ...a });
    const e = await k.ask(/wine/i);
    expect(e).toMatchObject({ outcome: 'refused', refusal: { kind: 'knowledgeUnavailable' } });
    expect(e.trace.deterministic).toMatch(/KNOWLEDGE_UNAVAILABLE/);
    expect((await k.recipe()).steps.length).toBe(8);   // still readable
  });
});

describe('a missing or unreadable release fails clearly', () => {
  it('no active release: no examples, imports refuse (503), the health check says so; a pinned session whose release is gone refuses changes', async () => {
    const kv = await newKnowledgeKv();
    const k = kitchen(storeKnowledge(kv));
    expect((await k.svc.listRecipes()).recipes).toEqual([]);
    expect(await k.auth.createImport({ kind: 'text', text: biscuits().lines.join('\n') })).toMatchObject({ status: 503, error: { code: 'KNOWLEDGE_UNAVAILABLE' } });
    // a session pinned to a release this store doesn't have (a restore that left the knowledge table behind)
    const other = kitchen(staticKnowledge(content), { kv: k.kv, ws: k.ws });
    const st = await other.start(RECIPE['scones.demo']);
    await k.doneUpTo(2);
    const e = await k.ask(/heavy cream/i);
    expect(e).toMatchObject({ outcome: 'refused', refusal: { kind: 'knowledgeUnavailable', unchanged: expect.stringContaining('unchanged') } });
    expect((await k.run()).revision).toBe(st.run.revision + 2);   // only the progress; the refusal changed nothing
  });

  it('a release is read and verified once per process (immutable cache); ACTIVE is read every time new work is pinned', async () => {
    const kv = await newKnowledgeKv();
    const { releaseId } = await publishRelease(kv, r2Files(), { activate: true });
    const reads = { rel: 0, active: 0 };
    const counting = new Proxy(kv, { get(t, p) {
      if (p === 'query') return (pk: string, o?: unknown) => { if (pk.startsWith('REL#')) reads.rel++; return t.query(pk, o as never); };
      if (p === 'get') return (key: { pk: string; sk: string }) => { if (key.sk === 'ACTIVE') reads.active++; return t.get(key); };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    const knowledge = storeKnowledge(counting);
    const [a, b] = await Promise.all([knowledge.active(), knowledge.active()]);
    expect(a).toBe(b);
    await knowledge.get(releaseId);
    expect(reads).toEqual({ rel: 1, active: 2 });
  });
});
