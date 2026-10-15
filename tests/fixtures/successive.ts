// TEST FIXTURES for knowledge releases and successive substitutions (commission 2026-10-11). Readings are hand-written test
// inputs (software evidence, not Nova output, not culinary content); every plan in them comes from content/approved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Authoring } from '../../src/authoring/drafts.ts';
import type { Extractor } from '../../src/authoring/extract.ts';
import type { SwapAnalyzer } from '../../src/authoring/swap-analysis.ts';
import type { Pattern } from '../../src/contract/types.ts';
import { readKnowledgeDir, type KnowledgeFiles } from '../../src/knowledge/release.ts';
import { Service } from '../../src/service/commands.ts';
import type { Knowledge } from '../../src/service/content.ts';
import { noneInterpreter } from '../../src/service/interpret.ts';
import type { Kv } from '../../src/service/kv.ts';
import { DynamoKv } from '../../src/service/kv-dynamo.ts';
import { cmd, newKv, newWs, ROOT } from '../helpers.ts';

export const APPROVED_DIR = join(ROOT, 'content/approved');
/** R1: the knowledge as deployed before this commission (ee617ab): today's content with B7 v1 instead of v2 (OD-8). */
export function r1Files(): KnowledgeFiles {
  const f = readKnowledgeDir(APPROVED_DIR);
  f.patterns = [...f.patterns.filter((p) => p.patternId !== 'evaporated_milk_for_milk'),
    JSON.parse(readFileSync(join(APPROVED_DIR, 'history/patterns/evaporated_milk_for_milk.v1.json'), 'utf8')) as Pattern];
  return f;
}
export const r2Files = () => readKnowledgeDir(APPROVED_DIR);

let tables = 0;
/** A knowledge table of its own: a fresh SQLite file, or (DynamoDB Local) a table created for this test. */
export async function newKnowledgeKv(): Promise<Kv> {
  const endpoint = process.env.CC_TEST_DYNAMO_ENDPOINT;
  if (!endpoint) return newKv();
  const TableName = `cc-test-k-${process.pid}-${Date.now().toString(36)}-${++tables}`;
  await new DynamoDBClient({ endpoint, region: 'us-east-1' }).send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }));
  return new DynamoKv(TableName, { endpoint, region: 'us-east-1' });
}

// ---------- cream biscuits: cream only in the dough (no brushing), an imported recipe ----------
type Step = { key: string; text: string; title: string; technique: string | null };
type Use = { ingredientKey: string; stepKey: string; quote: string; amountText: string | null; functions: string[] };
/** `waterBrush`: the tops are brushed with 1 tbsp water (an existing use of an ingredient a later plan introduces). */
export function biscuits(o: { waterBrush?: boolean } = {}) {
  const ing = (key: string, line: string, name: string, amountText: string) => ({ name, key, line, amountText, kind: null });
  const ingredients = [ing('f', '250 g plain flour', 'plain flour', '250 g'), ing('s', '20 g granulated sugar', 'granulated sugar', '20 g'),
    ing('b', '2 tsp baking powder', 'baking powder', '2 tsp'), ing('t', '¼ tsp salt', 'salt', '¼ tsp'), ing('c', '300 ML heavy cream', 'heavy cream', '300 ML'),
    ...(o.waterBrush ? [ing('w', '1 tbsp water', 'water', '1 tbsp')] : [])];
  const steps: Step[] = [
    { key: 's0', text: 'Heat the oven to 220 °C.', title: 'Heat oven', technique: 'PREHEAT' },
    { key: 's1', text: 'Whisk the flour, sugar, baking powder and salt.', title: 'Mix dry', technique: 'COMBINE_DRY' },
    { key: 's2', text: 'Stir in the cream until a soft dough forms.', title: 'Mix dough', technique: 'MIX_DOUGH' },
    { key: 's3', text: 'Pat out 2 cm thick and cut into rounds.', title: 'Shape', technique: 'SHAPE' },
    ...(o.waterBrush ? [{ key: 'sb', text: 'Brush the tops with the water.', title: 'Brush', technique: 'BRUSH' }] : []),
    { key: 's4', text: 'Bake for 15 minutes, until golden.', title: 'Bake', technique: 'BAKE' }];
  const use = (k: string, s: string, quote: string, functions: string[]): Use => ({ ingredientKey: k, stepKey: s, quote, amountText: null, functions });
  const uses = [use('f', 's1', 'the flour', ['STRUCTURE']), use('s', 's1', 'sugar', ['SWEETNESS']), use('b', 's1', 'baking powder', ['LEAVENING']),
    use('t', 's1', 'salt', ['FLAVOR']), use('c', 's2', 'the cream', ['LIQUID', 'FAT']), ...(o.waterBrush ? [use('w', 'sb', 'the water', ['BROWNING'])] : [])];
  const lines = ['Cream Biscuits', 'Makes 8', ...ingredients.map((i) => i.line), ...steps.map((s, i) => `${i + 1}. ${s.text}`)];
  return { lines, reading: { recipeFound: true, title: 'Cream Biscuits', yield: 'Makes 8', ingredients, steps, uses } };
}

type Ev = { id: string; outcome: string; questions?: { id: string; items: { text: string }[] }[]; candidates?: { id: string; planId: string }[] };
/** One cook's kitchen on the product service path (Service + Authoring over a store), with a scripted reading and no AI cards. */
export function kitchen(knowledge: Knowledge, o: { kv?: Kv; ws?: string } = {}) {
  const kv = o.kv ?? newKv(), ws = o.ws ?? newWs();
  const svc = new Service({ kv, ws, knowledge, interpreter: noneInterpreter });
  let reading: unknown = null;
  const extractor: Extractor = { name: 'SCRIPTED', extract: async () => ({ ok: true, raw: reading, extractor: 'SCRIPTED', usage: null, costUsd: 0 }) };
  const analyzer: SwapAnalyzer = { name: 'SCRIPTED', analyze: async () => ({ ok: true, raw: { cards: [] }, analyzer: 'SCRIPTED', usage: null, costUsd: 0 }) };
  const auth = new Authoring({ kv, ws, knowledge, extractor, analyzer });
  svc.catalog = (t) => auth.catalogIn(t);
  const k = {
    svc, auth, kv, ws,
    /** import and save a scripted recipe; returns the saved recipe id */
    async importAndSave(src: { lines: string[]; reading: unknown }) {
      reading = src.reading;
      const r = await auth.createImport({ kind: 'text', text: src.lines.join('\n') });
      if (r.status !== 202) throw new Error(JSON.stringify(r));
      const job = await auth.waitForJob(r.job.id);
      if (job.state === 'failed') throw new Error(JSON.stringify(job.failure));
      const saved = await auth.save(r.draftId, { expectedRevision: await auth.revision(r.draftId) });
      return { ...saved, draftId: r.draftId };
    },
    async start(recipeId: string) {
      const st = await svc.startRecipe({ commandId: cmd(), recipeId });
      if (st.outcome !== 'started') throw new Error(JSON.stringify(st));
      return st;
    },
    run: async () => (await svc.getActiveRecipe()).run!,
    recipe: async () => (await svc.getActiveRecipe()).recipe!,
    /** report progress on the step at 0-based `i` of the CURRENT recipe */
    async progress(i: number, progress: 'started' | 'partly' | 'done', addedUseIds?: string[]) {
      const run = await k.run();
      const x = await svc.recordProgress({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId: run.steps[i].stepId, progress, ...(addedUseIds ? { addedUseIds } : {}) });
      if (x.outcome !== 'recorded') throw new Error(JSON.stringify(x));
      return x.run;
    },
    async doneUpTo(n: number) { for (let i = 0; i < n; i++) await k.progress(i, 'done'); },
    /** the ingredient id by its name in the CURRENT recipe */
    id: async (name: RegExp) => (await k.recipe()).ingredients.find((i) => name.test(i.name))!.id,
    async ask(name: RegExp, kinds: string[] = [], prev?: Ev) {
      const run = await k.run();
      return await svc.evaluateRescue({ commandId: cmd(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, missingIngredientId: await k.id(name), proposedKindIds: kinds,
        utterance: { text: 'tapped', channel: 'tapped' }, ...(prev ? { previousEvaluationId: prev.id, answers: (prev.questions ?? []).map((q) => ({ questionId: q.id, value: 'yes' as const })) } : {}) }) as unknown as Ev & Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- wire payloads are asserted
    },
    /** ask, answer every availability question yes, and return the proposal (or the refusal) */
    async propose(name: RegExp, kinds: string[] = []) {
      const first = await k.ask(name, kinds);
      return first.outcome === 'needsFacts' ? { first, second: await k.ask(name, kinds, first) } : { first, second: first };
    },
    async applyArgs(e: Ev, commandId = cmd()) {
      const run = await k.run();
      return { commandId, runId: run.id, epoch: run.epoch, expectedRevision: run.revision, evaluationId: e.id, candidateId: e.candidates![0].id, planId: e.candidates![0].planId, accepted: true as const };
    },
    async apply(e: Ev) { return svc.applyAmendment(await k.applyArgs(e)) as unknown as Promise<Record<string, any>>; },   // eslint-disable-line @typescript-eslint/no-explicit-any
    /** propose and apply in one go; throws unless it applied */
    async change(name: RegExp, kinds: string[] = []) {
      const { second } = await k.propose(name, kinds);
      if (second.outcome !== 'proposal') throw new Error(`${name}: ${JSON.stringify(second).slice(0, 600)}`);
      const a = await k.apply(second);
      if (a.outcome !== 'applied') throw new Error(`${name}: ${JSON.stringify(a)}`);
      return { proposal: second, applied: a };
    },
    text: async (i: number) => (await k.run()).steps[i].effectiveText,
  };
  return k;
}
