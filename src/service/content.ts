// Knowledge for the service: one knowledge release (vocabulary, role table, reviewed patterns, vocabulary history) plus the
// owner-authored example recipes compiled against it. Project rule 6: content counts only once it is in content/approved; the
// deployed service reads releases from the knowledge table (src/knowledge/release.ts), never the bundled JSON.
//   loadContent(dir)      the bundled files as a release (tests, probes, the coverage report; its id is the id publishing it gives)
//   storeKnowledge(kv)    the runtime authority: ACTIVE and pinned releases from the knowledge table, verified, cached per release
//   staticKnowledge(c)    one release only (tests, owner tooling)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Id, Pattern, RebindKnowledge, RecipePack, RoleTable, SourcedLimit, Vocabulary } from '../contract/types.ts';
import { compile } from '../compile/binder.ts';
import { expandRecipe, type RecipeSource } from '../domain/recipe.ts';
import { activeReleaseId, knowledgeErrors, KnowledgeUnavailable, listReleases, loadRelease, mergePacket, readKnowledgeDir, releaseIdOfFiles, type KnowledgeFiles } from '../knowledge/release.ts';
import type { Kv } from './kv.ts';

export { KnowledgeUnavailable };
export interface Fixture { fixtureId: Id; recipeId: Id; actions: { stepId: Id; progress: 'started' | 'partly' | 'done'; addedUseIds?: Id[] }[] }
export interface Content {
  /** the knowledge release this content is (content-addressed: the same id whether read from the bundle or the table) */
  releaseId: string;
  vocab: Vocabulary; roles: RoleTable; patterns: Pattern[]; packs: Map<Id, RecipePack>; fixtures: Map<Id, Fixture>; errors: string[]; /** file stem (risotto.json → risotto) → recipeId */ names: Map<string, Id>;
  /** earlier approved vocabularies (history/vocabulary.v<n>.json): a retained analysis of the same reading under one still applies */ history: Vocabulary[];
  /** NOT approved content merged in for comparison only (coverage report, tests); empty for the product */ overlays: string[];
  /** sourced amount limits on import cards (2026-10-13); none in R1 */ limits: SourcedLimit[] }

export const APPROVED = join(import.meta.dirname, '../../content/approved');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : []);

/** `overlays`: proposed-content directories for what-if comparison only: a knowledge packet (vocabulary.additions.json,
 *  roles.additions.json, patterns/; mergePacket), or the older form (patterns/, roles.json with extra rows and cues). */
export function loadContent(dir = APPROVED, overlays: string[] = []): Content {
  let files = readKnowledgeDir(dir);
  for (const o of overlays) {
    if (existsSync(join(o, 'vocabulary.additions.json')) || existsSync(join(o, 'roles.additions.json'))) { files = mergePacket(files, o); continue; }
    files.patterns.push(...jsonFiles(join(o, 'patterns')).map((f) => readJson<Pattern>(f)));
    if (existsSync(join(o, 'roles.json'))) {
      const extra = readJson<Pick<RoleTable, 'roles' | 'cues'>>(join(o, 'roles.json'));
      files.roles.roles = [...files.roles.roles, ...extra.roles];
      for (const [t, cs] of Object.entries(extra.cues ?? {})) files.roles.cues[t] = [...(files.roles.cues[t] ?? []), ...cs];
    }
  }
  return { ...contentOf(files, releaseIdOfFiles(files), dir), overlays };
}

/** A release's knowledge with the example recipes (from `examplesDir`, owner-authored recipe sources) compiled against it. */
export function contentOf(files: KnowledgeFiles, releaseId: string, examplesDir = APPROVED): Content {
  const { vocabulary: vocab, roles, patterns, history } = files;
  const packs = new Map<Id, RecipePack>(), names = new Map<string, Id>(), errors: string[] = knowledgeErrors(files);
  for (const f of jsonFiles(join(examplesDir, 'recipes'))) {
    const recipe = expandRecipe(readJson<RecipeSource>(f));
    const res = compile(recipe, vocab, patterns, { releaseId });
    names.set(f.split('/').pop()!.split('.')[0], recipe.recipeId);
    if (res.pack) packs.set(recipe.recipeId, res.pack); else errors.push(...res.errors.map((e) => `${recipe.recipeId}: ${e}`));
  }
  const fixtures = new Map(jsonFiles(join(examplesDir, 'fixtures')).map((f) => { const x = readJson<Fixture>(f); return [x.fixtureId, x] as const; }));
  return { releaseId, vocab, roles, patterns, packs, fixtures, errors, names, history, overlays: [], limits: files.limits ?? [] };
}

/** Recipe ids of the bundled example recipes with these file stems (risotto.json → "risotto"). */
export function exampleIds(stems: string[], dir = APPROVED): Set<Id> {
  return new Set(jsonFiles(join(dir, 'recipes')).filter((f) => stems.includes(f.split('/').pop()!.split('.')[0])).map((f) => readJson<RecipeSource>(f).recipeId));
}
/** The prepared examples the product lists (owner 2026-10-13): the scones come in through Add recipe's sample PDF, a real import. */
export const PRODUCT_EXAMPLES = ['risotto', 'shortcake'];

/** How a saved pack relates to a knowledge release. */
export type Pin = { releaseId: string; basis: 'PINNED' | 'HASH_MATCH' } | { releaseId: null; basis: 'UNPINNED' };
export interface Knowledge {
  /** The release new work is pinned to. Throws KnowledgeUnavailable when none is active or it can't be read. */
  active(): Promise<Content>;
  /** A pinned release. Throws KnowledgeUnavailable. */
  get(releaseId: string): Promise<Content>;
  /** A pack saved before releases existed: the earliest published release whose vocabulary and pattern-set hashes equal the
   *  pack's (the content its plans were compiled from); null when none does. Never written back to the pack. */
  legacy(vocabularyHash: string, patternSetHash: string): Promise<string | null>;
}
export const rebindOf = (c: Content): RebindKnowledge => ({ releaseId: c.releaseId, vocab: c.vocab, patterns: c.patterns });

export function staticKnowledge(c: Content): Knowledge {
  return {
    active: async () => c,
    get: async (id) => { if (id === c.releaseId) return c; throw new KnowledgeUnavailable(id, 'not a release this server has'); },
    legacy: async (vh, ph) => {
      const p = [...c.packs.values()][0];
      return p && p.vocabularyHash === vh && p.patternSetHash === ph ? c.releaseId : null;
    },
  };
}

/**
 * The runtime authority. ACTIVE is read on every call that pins new work (so a published release reaches every instance on its
 * next request); releases are immutable, so each is loaded, verified and compiled once per process and cached by id. A release
 * that can't be read is never cached as missing (the next request tries again) and never replaced by bundled content.
 */
export function storeKnowledge(kv: Kv, examplesDir = APPROVED): Knowledge {
  const cache = new Map<string, Promise<Content>>();
  const get = (id: string) => {
    let p = cache.get(id);
    if (!p) {
      p = loadRelease(kv, id).then(({ files }) => contentOf(files, id, examplesDir));
      p.catch(() => cache.delete(id));
      cache.set(id, p);
    }
    return p;
  };
  const legacyHits = new Map<string, string>();
  return {
    async active() {
      const id = await activeReleaseId(kv);
      if (!id) throw new KnowledgeUnavailable(null, 'no knowledge release is published and active on this server');
      return get(id);
    },
    get,
    async legacy(vh, ph) {
      const k = `${vh}|${ph}`;
      if (!legacyHits.has(k)) {
        const hit = (await listReleases(kv)).find((m) => m.vocabularyHash === vh && m.patternSetHash === ph);
        if (!hit) return null;
        legacyHits.set(k, hit.releaseId);
      }
      return legacyHits.get(k)!;
    },
  };
}

/** The release a pack's plans came from: its own pin, else (saved before releases) a hash match, else unknown. */
export async function pinOf(k: Knowledge, pack: RecipePack): Promise<Pin> {
  if (pack.knowledgeReleaseId) return { releaseId: pack.knowledgeReleaseId, basis: 'PINNED' };
  const id = await k.legacy(pack.vocabularyHash, pack.patternSetHash);
  return id ? { releaseId: id, basis: 'HASH_MATCH' } : { releaseId: null, basis: 'UNPINNED' };
}
