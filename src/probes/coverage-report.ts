// Import coverage by ingredient USE and by unique PLAN, over the retained live readings and cards (no calls).
//   node src/probes/coverage-report.ts <label> [overlayDir]
// Card sets: v1 = the 2026-10-04 card probe (ccmcp-swaps-1; scones, risotto, shortcake); v2 = the 2026-10-07 cards2 probe
// (ccmcp-swaps-2; explicit scone, scones, risotto, shortcake). Every import runs on its own fresh database. An overlay
// (proposed, NOT approved content) adds patterns and role rows for a "what if approved" comparison only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Authoring } from '../authoring/drafts.ts';
import { recordedExtractor, userMessage } from '../authoring/extract.ts';
import { readPdf } from '../authoring/source.ts';
import { recordedAnalyzer } from '../authoring/swap-analysis.ts';
import { hash } from '../domain/rational.ts';
import { Service } from '../service/commands.ts';
import { SqliteKv } from '../service/kv-sqlite.ts';
import { modelRows } from './records.ts';
import { loadContent } from '../service/content.ts';
import { noneInterpreter } from '../service/interpret.ts';

const root = join(import.meta.dirname, '../..');
const label = process.argv[2] ?? 'report';
const overlay = process.argv[3] ? join(root, process.argv[3]) : null;
const content = overlay ? loadContent(undefined, [overlay]) : loadContent();
if (content.errors.length) throw new Error(content.errors.join('\n'));
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const PDF = { explicit: 'private/probes/cards2/scones-explicit.pdf', scones: 'private/probes/cards/scones.pdf', risotto: 'private/probes/cards/risotto.pdf', shortcake: 'private/probes/cards/shortcake.pdf' } as const;
const pages = async (f: string) => { const r = await readPdf(new Uint8Array(readFileSync(join(root, f)))); if (!r.ok) throw new Error(f); return r.source.pages.filter((p) => p.status === 'TEXT'); };

const v1 = json('.artifacts/probes/cards-replay.json') as { readings: Record<string, unknown>; cards: Record<string, unknown> };
const r2 = json('private/probes/cards2/results-v1.json') as { raw: Record<string, { extraction?: { raw: unknown }[]; swapAnalysis?: { raw: unknown; input_hash: string }[] }> };
const readings = { ...v1.readings, [hash(userMessage(await pages(PDF.explicit)))]: r2.raw.explicit.extraction![0].raw };
const v2cards = Object.fromEntries(Object.values(r2.raw).flatMap((x) => (x.swapAnalysis ?? []).filter((a) => a.raw).map((a) => [a.input_hash, a.raw])));
const SETS = { v1: { cards: v1.cards, recipes: ['scones', 'risotto', 'shortcake'] }, v2: { cards: v2cards, recipes: ['explicit', 'scones', 'risotto', 'shortcake'] } } as const;

const dir = join(root, '.artifacts/coverage');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
type Row = { set: string; recipe: string; ingredient: string; step: number; status: string; offer: string | null; code: string | null; detail: string | null; plans: { planId: string; ruleId: string | null; kind: string; title: string }[]; coveredBy: string | null; ruledOut: string[] };
const rows: Row[] = [];
const repairs: { set: string; recipe: string; requested: number; status: string }[] = [];
for (const [set, s] of Object.entries(SETS)) {
  for (const name of s.recipes) {
    const svc = new Service({ kv: new SqliteKv(join(dir, `${stamp}-${label}-${set}-${name}.kv`)), content, interpreter: noneInterpreter, fixtureRecipes: false });
    const auth = new Authoring({ kv: svc.kv, ws: svc.ws, content, extractor: recordedExtractor(readings, 'REPLAY'), analyzer: recordedAnalyzer(s.cards, `REPLAY_${set}`) });
    const f = PDF[name as keyof typeof PDF];
    const r = await auth.createImport({ kind: 'pdf', bytes: new Uint8Array(readFileSync(join(root, f))), filename: f.split('/').pop()! });
    if (r.status !== 202) throw new Error(`${name}: ${JSON.stringify(r)}`);
    await auth.waitForJob(r.job.id);
    const c = (await auth.getDraft(r.draftId)).draft.content!;
    for (const i of c.ingredients) for (const u of i.uses) {
      const a = u.analysis!;
      rows.push({ set, recipe: name, ingredient: i.name, step: c.steps.find((x) => x.id === u.stepId)!.ordinal, status: a.status, offer: a.offer, code: a.reason?.code ?? null, detail: a.reason?.detail ?? null,
        plans: a.plans.map((p) => ({ planId: p.planId, ruleId: p.ruleId, kind: p.kind, title: p.title })), coveredBy: a.coveredByUseId, ruledOut: (a.ruledOut ?? []).map((r) => r.ruleId) });
    }
    const rep = (await modelRows(svc.kv, svc.ws, r.draftId)).repairs;
    for (const x of rep) repairs.push({ set, recipe: name, requested: (JSON.parse(x.requested_json) as unknown[]).length, status: x.status });
    (svc.kv as SqliteKv).close();
  }
}

const count = (xs: Row[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status === 'available' ? `available:${x.offer}` : x.status]: (m[`${x.status === 'available' ? `available:${x.offer}` : x.status}`] ?? 0) + 1 }), {});
const summary = Object.fromEntries(Object.keys(SETS).map((set) => {
  const xs = rows.filter((x) => x.set === set);
  const plans = new Map(xs.flatMap((x) => x.plans.slice(0, 1).map((p) => [p.planId, p] as const)));   // the plan each use would be offered first
  return [set, {
    uses: xs.length, byUse: count(xs),
    uniquePlans: plans.size, plansBySource: [...plans.values()].reduce<Record<string, number>>((m, p) => { const k = `${p.ruleId ? 'reviewed' : 'ai'}:${p.kind}`; return { ...m, [k]: (m[k] ?? 0) + 1 }; }, {}),
    perRecipe: Object.fromEntries(SETS[set as keyof typeof SETS].recipes.map((n) => { const ys = xs.filter((x) => x.recipe === n); return [n, { uses: ys.length, byUse: count(ys), uniquePlans: new Set(ys.flatMap((y) => y.plans.slice(0, 1).map((p) => p.planId))).size }]; })),
  }];
}));
const out = { kind: 'cc-coverage-report/1', label, at: new Date().toISOString(), overlay: process.argv[3] ?? null, note: 'Replay of retained live readings and cards; no calls. Status per ingredient use; plans counted once per unique plan id (two uses changed by one plan are one plan).', summary, repairs, rows };
writeFileSync(join(dir, `${label}.json`), JSON.stringify(out, null, 2));
for (const [set, x] of Object.entries(summary)) {
  console.log(`\n== ${set}: ${x.uses} uses · ${x.uniquePlans} unique plans ${JSON.stringify(x.plansBySource)}\n   by use ${JSON.stringify(x.byUse)}`);
  for (const r of rows.filter((y) => y.set === set)) console.log(`   ${r.recipe.padEnd(9)} ${`${r.ingredient} s${r.step}`.padEnd(28)} ${(r.status === 'available' ? `available:${r.offer}` : r.status).padEnd(22)} ${(r.plans[0]?.ruleId ?? (r.plans[0] ? 'AI' : '')).padEnd(24)} ${r.code ?? ''} ${r.detail ? `· ${r.detail.slice(0, 150)}` : ''}`);
}
console.log(`\nwritten .artifacts/coverage/${label}.json`);
