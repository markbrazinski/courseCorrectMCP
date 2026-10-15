// Knowledge releases (commission 2026-10-11): the runtime authority for culinary knowledge is a dedicated table (DynamoDB when
// deployed, a separate SQLite file locally), not the bundled JSON. content/approved stays the reviewed authoring input and the
// reproducible seed; publishing copies it, record for record, into an immutable release.
//
// Layout (one table, the kv.ts contract):
//   REL#<releaseId>  REC#vocabulary | REC#roles | REC#history#vocabulary.v<n> | REC#pattern#<patternId>@<version>
//                    → { body: the authored JSON exactly as parsed, sha256: hash(body) }
//   REL#<releaseId>  MANIFEST → { schema, releaseId, state STAGED|PUBLISHED, records [{ sk, sha256, authority… }], hashes, source }
//   KNOWLEDGE        REL#<releaseId> → index entry, written only when the release is published
//   KNOWLEDGE        ACTIVE → { releaseId, previous } the release new work is pinned to
// A release id is content-addressed (kr-<sha256 of every record key and hash>), so the bundled JSON and its published copy have
// the same id, and publishing the same content twice is a no-op.
//
// Publication: validate → write records (absent only) → manifest STAGED → read everything back and verify each hash → ONE
// transaction: manifest STAGED→PUBLISHED, index entry, and (optionally) ACTIVE, conditional on the pointer read. A release
// interrupted anywhere before that transaction is never selectable: the loader accepts only a PUBLISHED manifest whose every
// record is present and verifies, and ACTIVE only ever names such a release. Nothing here deletes a release.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pattern, RoleTable, SourcedLimit, Vocabulary } from '../contract/types.ts';
import { patternSetHashOf } from '../compile/binder.ts';
import { hash } from '../domain/rational.ts';
import { identityErrors } from '../domain/vocabulary.ts';
import { WriteConflict, type Item, type Kv } from '../service/kv.ts';

export const KNOWLEDGE_SCHEMA = 'cc-knowledge/1';
export const ACTIVE = { pk: 'KNOWLEDGE', sk: 'ACTIVE' };
const relPk = (id: string) => `REL#${id}`;

/** `limits`: sourced amount limits (2026-10-13); absent or empty in a release that has none (its records and id are unchanged). */
export interface KnowledgeFiles { vocabulary: Vocabulary; roles: RoleTable; patterns: Pattern[]; history: Vocabulary[]; limits?: SourcedLimit[] }
/** What each record is and on whose authority: owner-approved engineering content, never culinary validation (physical
 *  trials: none recorded). Model output (import swap cards) is never knowledge; it lives with the import that produced it. */
export interface RecordEntry {
  sk: string; kind: 'vocabulary' | 'roles' | 'history' | 'pattern' | 'limit'; id: string; version: number | null; sha256: string;
  authority: { approval: 'OWNER_APPROVED_ENGINEERING' | 'COMMISSIONED_PENDING_OWNER_CONFIRMATION'; decisionRef: string | null; evidence: string | null; physicalValidation: 'NONE' };
}
export interface Manifest {
  schema: typeof KNOWLEDGE_SCHEMA; releaseId: string; state: 'STAGED' | 'PUBLISHED'; records: RecordEntry[];
  vocabularyHash: string; patternSetHash: string; rolesHash: string;
  note: string; source: { commit: string | null; dir: string | null }; createdAt: string; publishedAt: string | null;
}
export class KnowledgeUnavailable extends Error {
  readonly releaseId: string | null;
  constructor(releaseId: string | null, why: string) { super(`knowledge ${releaseId ?? '(active)'}: ${why}`); this.releaseId = releaseId; }
}

// ---------- the authored files ----------
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : []);
export function readKnowledgeDir(dir: string): KnowledgeFiles {
  return {
    vocabulary: readJson<Vocabulary>(join(dir, 'vocabulary.json')), roles: readJson<RoleTable>(join(dir, 'roles.json')),
    patterns: jsonFiles(join(dir, 'patterns')).map((f) => readJson<Pattern>(f)),
    history: jsonFiles(join(dir, 'history')).filter((f) => /vocabulary\.v\d+\.json$/.test(f)).map((f) => readJson<Vocabulary>(f)),
    ...(jsonFiles(join(dir, 'limits')).length ? { limits: jsonFiles(join(dir, 'limits')).map((f) => readJson<SourcedLimit>(f)) } : {}),
  };
}

/** The files as a knowledge directory (the layout readKnowledgeDir reads), e.g. a candidate release for review. */
export function writeKnowledgeDir(dir: string, f: KnowledgeFiles) {
  const put = (p: string, x: unknown) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), JSON.stringify(x, null, 2) + '\n'); };
  put('vocabulary.json', f.vocabulary); put('roles.json', f.roles);
  for (const p of f.patterns) put(`patterns/${p.patternId}.v${p.version}.json`, p);
  for (const h of f.history) put(`history/vocabulary.v${h.version}.json`, h);
  for (const l of f.limits ?? []) put(`limits/${l.limitId}.v${l.version}.json`, l);
}

/** Records still awaiting the owner's confirmation (patterns, and a candidate's vocabulary or roles). */
export const pendingIn = (f: KnowledgeFiles) => [
  ...(f.vocabulary.approval === 'COMMISSIONED_PENDING_OWNER_CONFIRMATION' ? [`vocabulary v${f.vocabulary.version}`] : []),
  ...(f.roles.approval === 'COMMISSIONED_PENDING_OWNER_CONFIRMATION' ? ['roles'] : []),
  ...f.patterns.filter((p) => p.evidence.approval === 'COMMISSIONED_PENDING_OWNER_CONFIRMATION').map((p) => `${p.patternId}@${p.version}`),
  ...(f.limits ?? []).filter((l) => l.evidence.approval === 'COMMISSIONED_PENDING_OWNER_CONFIRMATION').map((l) => `limit ${l.limitId}@${l.version}`),
];

/**
 * A proposed knowledge packet over a release's files (2026-10-13): `vocabulary.additions.json` (new kinds, classes, techniques
 * and functions, and the vocabulary version they make), `roles.additions.json` (role rows and technique cues), `patterns/`.
 * Additions only (plus aliasRemovals and relabel, named one by one): an id the base already has is an error, never an override. The base vocabulary joins the history (a
 * reading analysed under it still applies). Everything merged is marked pending unless the packet says otherwise.
 */
export function mergePacket(base: KnowledgeFiles, dir: string): KnowledgeFiles {
  const read = <T>(f: string): T | null => (existsSync(join(dir, f)) ? readJson<T>(join(dir, f)) : null);
  const va = read<Partial<Vocabulary> & { version: number }>('vocabulary.additions.json'), ra = read<Pick<RoleTable, 'roles' | 'cues'> & { approval?: RoleTable['approval'] }>('roles.additions.json');
  const pending = 'COMMISSIONED_PENDING_OWNER_CONFIRMATION' as const;
  const add = <T>(xs: T[], ys: T[] | undefined, id: (x: T) => string, what: string) => {
    for (const y of ys ?? []) if (xs.some((x) => id(x) === id(y))) throw new Error(`packet ${dir}: ${what} ${id(y)} is already in the base`);
    return [...xs, ...(ys ?? [])];
  };
  const v = base.vocabulary;
  // kindClassAdditions: a class added to a kind the base already has (an addition to its memberships, never a removal)
  const more = (va as { kindClassAdditions?: Record<string, string[]> } | null)?.kindClassAdditions ?? {};
  for (const k of Object.keys(more)) if (!v.kinds.some((x) => x.kindId === k)) throw new Error(`packet ${dir}: kindClassAdditions names unknown kind ${k}`);
  // aliasRemovals (2026-10-13, A2): an alias the base gave a kind that names something else; named one by one, never a pattern
  // relabel: the same kind under a label that names only it ("butter" → "unsalted butter"); its id and classes are unchanged
  const less = (va as { aliasRemovals?: Record<string, string[]> } | null)?.aliasRemovals ?? {}, relabel = (va as { relabel?: Record<string, string> } | null)?.relabel ?? {};
  for (const k of Object.keys(relabel)) if (!v.kinds.some((x) => x.kindId === k)) throw new Error(`packet ${dir}: relabel names unknown kind ${k}`);
  for (const [k, as] of Object.entries(less)) { const kind = v.kinds.find((x) => x.kindId === k); for (const a of as) if (!kind?.aliases.includes(a)) throw new Error(`packet ${dir}: aliasRemovals: ${k} has no alias "${a}"`); }
  const vocabulary: Vocabulary = va ? {
    schema: v.schema, version: va.version, approval: va.approval ?? pending,
    functions: add(v.functions, va.functions, (x) => x.functionId, 'function'), techniques: add(v.techniques, va.techniques, (x) => x.techniqueId, 'technique'),
    classes: add(v.classes, va.classes, (x) => x.classId, 'class'),
    kinds: add(v.kinds.map((k) => (more[k.kindId] ? { ...k, classes: [...k.classes, ...more[k.kindId].filter((c) => !k.classes.includes(c))] } : k))
      .map((k) => (less[k.kindId] ? { ...k, aliases: k.aliases.filter((a) => !less[k.kindId].includes(a)) } : k))
      .map((k) => (relabel[k.kindId] ? { ...k, label: relabel[k.kindId] } : k)), va.kinds, (x) => x.kindId, 'kind'),
  } : v;
  const cues = { ...base.roles.cues };
  for (const [t, cs] of Object.entries(ra?.cues ?? {})) cues[t] = [...(cues[t] ?? []), ...cs];
  const roles: RoleTable = ra ? { ...base.roles, roles: add(base.roles.roles, ra.roles, (x) => `${x.kindId} × ${x.techniqueId}`, 'role row'), cues, approval: ra.approval ?? pending } : base.roles;
  const patterns = add(base.patterns, jsonFiles(join(dir, 'patterns')).map((f) => readJson<Pattern>(f)), (p) => `${p.patternId}@${p.version}`, 'pattern');
  const limits = add(base.limits ?? [], jsonFiles(join(dir, 'limits')).map((f) => readJson<SourcedLimit>(f)), (l) => `${l.limitId}@${l.version}`, 'limit');
  return { vocabulary, roles, patterns, history: va ? [...base.history, v] : base.history, ...(limits.length ? { limits } : {}) };
}

const decisionOf = (text: string) => /\bOD-\d+\b/.exec(text)?.[0] ?? null;
export function recordsOf(f: KnowledgeFiles): { entry: RecordEntry; body: unknown }[] {
  const owner = (decisionRef: string | null, evidence: string | null = null): RecordEntry['authority'] => ({ approval: 'OWNER_APPROVED_ENGINEERING', decisionRef, evidence, physicalValidation: 'NONE' });
  const rec = (sk: string, kind: RecordEntry['kind'], id: string, version: number | null, body: unknown, authority: RecordEntry['authority']) => ({ entry: { sk, kind, id, version, sha256: hash(body), authority }, body });
  return [
    rec('REC#vocabulary', 'vocabulary', 'vocabulary', f.vocabulary.version, f.vocabulary, { ...owner('content/approved (rule 6)'), approval: f.vocabulary.approval ?? 'OWNER_APPROVED_ENGINEERING' }),
    rec('REC#roles', 'roles', 'roles', null, f.roles, { ...owner(f.roles.decisionRef), approval: f.roles.approval ?? 'OWNER_APPROVED_ENGINEERING' }),
    ...[...f.history].sort((a, b) => a.version - b.version).map((h) => rec(`REC#history#vocabulary.v${h.version}`, 'history', 'vocabulary', h.version, h, owner('content/approved/history'))),
    ...f.patterns.map((p) => rec(`REC#pattern#${p.patternId}@${p.version}`, 'pattern', p.patternId, p.version, p, {
      ...owner(decisionOf(p.evidence.basis), p.evidence.quantityStatus), approval: p.evidence.approval ?? 'OWNER_APPROVED_ENGINEERING',
    })),
    ...(f.limits ?? []).map((l) => rec(`REC#limit#${l.limitId}@${l.version}`, 'limit', l.limitId, l.version, l, {
      ...owner(decisionOf(l.evidence.basis), 'SOURCED'), approval: l.evidence.approval ?? 'OWNER_APPROVED_ENGINEERING',
    })),
  ].sort((a, b) => (a.entry.sk < b.entry.sk ? -1 : a.entry.sk > b.entry.sk ? 1 : 0));
}
export const releaseIdOf = (entries: Pick<RecordEntry, 'sk' | 'sha256'>[]) =>
  `kr-${hash({ schema: KNOWLEDGE_SCHEMA, records: entries.map((e) => [e.sk, e.sha256]).sort((a, b) => (a[0] < b[0] ? -1 : 1)) }).slice(0, 16)}`;
export const releaseIdOfFiles = (f: KnowledgeFiles) => releaseIdOf(recordsOf(f).map((r) => r.entry));

/** Every reference a release makes resolves inside it: vocabulary identity, role rows, and every id a pattern names. */
export function knowledgeErrors(f: KnowledgeFiles): string[] {
  const v = f.vocabulary, out = [...identityErrors(v)];
  const fn = new Set(v.functions.map((x) => x.functionId)), tq = new Set(v.techniques.map((x) => x.techniqueId));
  const cls = new Set(v.classes.map((x) => x.classId)), kinds = new Set(v.kinds.map((x) => x.kindId));
  for (const k of v.kinds) for (const c of k.classes) if (!cls.has(c)) out.push(`vocabulary: ${k.kindId} names unknown class ${c}`);
  for (const x of f.roles.roles) if (!kinds.has(x.kindId) || !tq.has(x.techniqueId) || !x.functions.every((y) => fn.has(y))) out.push(`roles.json: unknown id in ${x.kindId} × ${x.techniqueId}`);
  for (const t of Object.keys(f.roles.cues)) if (!tq.has(t)) out.push(`roles.json: unknown technique ${t}`);
  const seen = new Set<string>();
  for (const p of f.patterns) {
    const at = `pattern ${p.patternId}@${p.version}`, bad = (what: string) => out.push(`${at}: ${what}`);
    if (p.schema !== 'cc-pattern/1') bad(`schema ${String(p.schema)}`);
    if (seen.has(`${p.patternId}@${p.version}`)) bad('duplicate id and version');
    seen.add(`${p.patternId}@${p.version}`);
    const C = (c: string) => cls.has(c) || bad(`unknown class ${c}`), F = (x: string) => fn.has(x) || bad(`unknown function ${x}`), T = (x: string | null) => x === null || tq.has(x) || bad(`unknown technique ${x}`);
    C(p.target.ingredientClass); p.target.performsAll.forEach(F); T(p.target.stepTechnique);
    for (const s of p.slots) { if ('technique' in s) T(s.technique); if ('ingredientClass' in s) C(s.ingredientClass); if ('performsAll' in s) s.performsAll.forEach(F); if ('stepTechnique' in s) T(s.stepTechnique); }
    for (const q of [...p.applicability, ...p.exceptions.map((e) => e.when)]) {
      if (q.kind === 'USE_PERFORMS') F(q.functionId); if (q.kind === 'STEP_TECHNIQUE') T(q.techniqueId);
      if (q.kind === 'RECIPE_HAS_USE_OF_CLASS') C(q.classId); if (q.kind === 'NO_HOLD_BETWEEN') q.techniques.forEach(T);
      for (const c of q.kind === 'NO_HOLD_BETWEEN' || q.kind === 'STEP_TEXT_MATCHES' ? q.cues : []) { try { new RegExp(c, 'i'); } catch { bad(`cue is not a pattern: ${c}`); } }
    }
    if (p.kind === 'REFUSAL') { p.proposal.classes.forEach(C); continue; }
    p.introduces.forEach((i) => kinds.has(i.kindId) || bad(`introduces unknown kind ${i.kindId}`));
    p.proposal?.classes.forEach(C);
    const specs = [...p.ops.flatMap((o) => (o.op === 'REPLACE_USE' ? [o.with] : o.op === 'ADD_USE' ? [o.use] : [])), ...p.siblingHandlers.map((h) => h.replaceWith)];
    for (const s of specs) {
      s.functions.forEach(F);
      if (s.qty !== 'CARRY_AS_WRITTEN' && !p.quantities[s.qty]) bad(`unknown quantity ${s.qty}`);
      if (s.allowance && 'maxQty' in s.allowance && !p.quantities[s.allowance.maxQty]) bad(`unknown quantity ${s.allowance.maxQty}`);
      if ('introduce' in s.ingredient && !p.introduces.some((i) => i.local === (s.ingredient as { introduce: string }).introduce)) bad(`introduces nothing named ${s.ingredient.introduce}`);
    }
    p.functionAccounting.forEach((d) => F(d.functionId)); p.introducedFunctions.forEach((d) => F(d.functionId));
  }
  for (const l of f.limits ?? []) {
    const at = `limit ${l.limitId}@${l.version}`;
    if (l.schema !== 'cc-limit/1') out.push(`${at}: schema ${String(l.schema)}`);
    for (const c of l.classes) if (!cls.has(c)) out.push(`${at}: unknown class ${c}`);
    for (const x of l.replacing) if (!fn.has(x)) out.push(`${at}: unknown function ${x}`);
    if (!(l.maxFraction.n > 0 && l.maxFraction.d > 0 && l.maxFraction.n < l.maxFraction.d)) out.push(`${at}: maxFraction must be between 0 and 1`);
  }
  return out;
}

// ---------- publication ----------
export interface PublishResult { releaseId: string; created: boolean; activated: boolean; previous: string | null }
/**
 * Publish a release (idempotent; resumes an interrupted publication of the same content). `activate`: make it the release new
 * work is pinned to, in the same transaction that publishes it. Already-pinned recipes and sessions never change.
 */
export async function publishRelease(kv: Kv, f: KnowledgeFiles, o: { activate?: boolean; note?: string; source?: Manifest['source']; now?: () => string } = {}): Promise<PublishResult> {
  const now = o.now ?? (() => new Date().toISOString());
  const errs = knowledgeErrors(f);
  if (errs.length) throw new Error(`knowledge release invalid:\n${errs.join('\n')}`);
  const recs = recordsOf(f), releaseId = releaseIdOf(recs.map((r) => r.entry)), pk = relPk(releaseId);
  const MANIFEST = { pk, sk: 'MANIFEST' };
  let m = await kv.get(MANIFEST) as (Item & Manifest) | undefined;
  const created = m?.state !== 'PUBLISHED';
  if (created) {
    for (const r of recs) await putOnce(kv, { pk, sk: r.entry.sk, body: r.body, sha256: r.entry.sha256, v: 1 });
    if (!m) {
      const manifest: Manifest = { schema: KNOWLEDGE_SCHEMA, releaseId, state: 'STAGED', records: recs.map((r) => r.entry), vocabularyHash: hash(f.vocabulary),
        patternSetHash: patternSetHashOf(f.patterns), rolesHash: hash(f.roles), note: o.note ?? '', source: o.source ?? { commit: null, dir: null }, createdAt: now(), publishedAt: null };
      await putOnce(kv, { ...MANIFEST, ...manifest, v: 1 });
      m = await kv.get(MANIFEST) as Item & Manifest;
    }
    await verifyRelease(kv, releaseId, true);   // every record back, byte-for-byte by hash, before anything can select it
    const active = await kv.get(ACTIVE);
    const at = now();
    try {
      await kv.write([
        { put: { ...m, state: 'PUBLISHED', publishedAt: at, v: m.v! + 1 }, if: m.v! },
        { put: { pk: 'KNOWLEDGE', sk: `REL#${releaseId}`, releaseId, publishedAt: at, note: m.note, vocabularyHash: m.vocabularyHash, patternSetHash: m.patternSetHash, records: m.records.length, v: 1 }, if: 'absent' },
        ...(o.activate ? [{ put: { ...ACTIVE, releaseId, previous: (active?.releaseId as string | undefined) ?? null, at, v: (active?.v ?? 0) + 1 }, if: active?.v ?? ('absent' as const) }] : []),
      ]);
    } catch (e) {
      if (!(e instanceof WriteConflict)) throw e;
      const again = await kv.get(MANIFEST);   // another publisher finished the same release first: fine; anything else, retry
      if (again?.state !== 'PUBLISHED') throw new Error(`publication of ${releaseId} raced: run it again`);
      if (o.activate) return { releaseId, created: false, ...(await activateRelease(kv, releaseId, now)) };
      return { releaseId, created: false, activated: false, previous: null };
    }
    return { releaseId, created: true, activated: !!o.activate, previous: (active?.releaseId as string | undefined) ?? null };
  }
  if (o.activate) return { releaseId, created: false, ...(await activateRelease(kv, releaseId, now)) };
  return { releaseId, created: false, activated: false, previous: null };
}
async function putOnce(kv: Kv, item: Item) {
  try { await kv.write([{ put: item, if: 'absent' }]); }
  catch (e) { if (!(e instanceof WriteConflict)) throw e; }   // written by an earlier, interrupted attempt: verified below
}

/** Make a PUBLISHED release the one new work is pinned to (or roll back to an earlier one). Conditional on both items read. */
export async function activateRelease(kv: Kv, releaseId: string, now = () => new Date().toISOString()): Promise<{ activated: boolean; previous: string | null }> {
  const m = await kv.get({ pk: relPk(releaseId), sk: 'MANIFEST' });
  if (m?.state !== 'PUBLISHED') throw new KnowledgeUnavailable(releaseId, 'not published, so it cannot be activated');
  const cur = await kv.get(ACTIVE);
  if (cur?.releaseId === releaseId) return { activated: false, previous: (cur.previous as string | null) ?? null };
  await kv.write([{ check: { pk: m.pk, sk: m.sk }, if: m.v! }, { put: { ...ACTIVE, releaseId, previous: (cur?.releaseId as string | undefined) ?? null, at: now(), v: (cur?.v ?? 0) + 1 }, if: cur?.v ?? 'absent' }]);
  return { activated: true, previous: (cur?.releaseId as string | undefined) ?? null };
}

export async function activeReleaseId(kv: Kv): Promise<string | null> { return ((await kv.get(ACTIVE))?.releaseId as string | undefined) ?? null; }
/** Published releases, oldest first (the index entries). */
export async function listReleases(kv: Kv) {
  return (await kv.query('KNOWLEDGE', { prefix: 'REL#' })).map((x) => x as Item & { releaseId: string; publishedAt: string; note: string; vocabularyHash: string; patternSetHash: string; records: number })
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/** Read a release and prove it: the manifest, then every record present with the hash the manifest names, nothing extra, and
 *  the release id recomputed from them. `staged`: also accept a STAGED manifest (the publisher's own check). */
async function verifyRelease(kv: Kv, releaseId: string, staged = false): Promise<{ manifest: Manifest; bodies: Map<string, unknown> }> {
  const items = await kv.query(relPk(releaseId));
  const manifest = items.find((x) => x.sk === 'MANIFEST') as (Item & Manifest) | undefined;
  if (!manifest) throw new KnowledgeUnavailable(releaseId, 'no such release');
  if (manifest.state !== 'PUBLISHED' && !(staged && manifest.state === 'STAGED')) throw new KnowledgeUnavailable(releaseId, 'publication did not complete, so it is not selectable');
  const bodies = new Map<string, unknown>(), recs = new Map(items.filter((x) => x.sk.startsWith('REC#')).map((x) => [x.sk, x]));
  for (const e of manifest.records) {
    const it = recs.get(e.sk);
    if (!it) throw new KnowledgeUnavailable(releaseId, `record ${e.sk} missing`);
    if (it.sha256 !== e.sha256 || hash(it.body) !== e.sha256) throw new KnowledgeUnavailable(releaseId, `record ${e.sk} does not match its hash`);
    bodies.set(e.sk, it.body);
  }
  if (recs.size !== manifest.records.length) throw new KnowledgeUnavailable(releaseId, 'records the manifest does not name');
  if (releaseIdOf(manifest.records) !== releaseId) throw new KnowledgeUnavailable(releaseId, 'manifest does not match the release id');
  return { manifest, bodies };
}

/** A published release, verified, as the files it was published from. */
export async function loadRelease(kv: Kv, releaseId: string): Promise<{ files: KnowledgeFiles; manifest: Manifest }> {
  const { manifest, bodies } = await verifyRelease(kv, releaseId);
  const of = (kind: RecordEntry['kind']) => manifest.records.filter((e) => e.kind === kind).map((e) => bodies.get(e.sk));
  const files: KnowledgeFiles = {
    vocabulary: of('vocabulary')[0] as Vocabulary, roles: of('roles')[0] as RoleTable,
    patterns: of('pattern') as Pattern[], history: (of('history') as Vocabulary[]).sort((a, b) => a.version - b.version),
    ...(of('limit').length ? { limits: of('limit') as SourcedLimit[] } : {}),
  };
  if (!files.vocabulary || !files.roles) throw new KnowledgeUnavailable(releaseId, 'vocabulary or roles missing');
  return { files, manifest };
}
