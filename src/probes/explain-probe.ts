// Explanation probe (owner, 2026-10-02): 8 frozen refusal cases, each with the engine's `why` facts computed here and
// written down with expectations BEFORE any live call. Two modes:
//   node src/probes/explain-probe.ts freeze   → private/probes/explain/probe-v1.json (refuses to overwrite)
//   CC_LIVE=1 CC_AUTHORIZATION=<file naming `explanation`> node src/probes/explain-probe.ts run
//     → one Nova call per case, results next to the probe (refuses to run twice). Not run without owner approval.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecipePack, RescueRequest, RunSnapshot } from '../contract/types.ts';
import { refusalWhy, type Why } from '../contract/why.ts';
import { applyAuthority } from '../authoring/drafts.ts';
import { buildDraft } from '../authoring/extract.ts';
import { readPastedText } from '../authoring/source.ts';
import { Ledger, NovaClient, type Authorization } from '../authoring/nova.ts';
import { compile } from '../compile/binder.ts';
import { sha256 } from '../domain/rational.ts';
import { evaluate } from '../engine/evaluate.ts';
import { EXPLAIN_SYSTEM, EXPLAIN_VERSION, explainPromptIdentity, explainUserMessage, novaExplainer, rejectAnswer } from '../service/explain.ts';
import { compileSource, content, doneUpTo, pack, req, snapshotAfter, source } from '../../tests/helpers.ts';
import { ING, RECIPE } from '../../tests/fixtures/ids.ts';

const root = join(import.meta.dirname, '../..');
const dir = join(root, 'private/probes/explain'), probePath = join(dir, 'probe-v1.json'), resultsPath = join(dir, 'results-v1.json');
const v = content.vocab;
interface Case { id: string; question: string; why: Why; expect: { startsWith: 'No'; verdict: Why['verdict']; mention: string[]; mustNotMention: string[] } }

function caseOf(id: string, question: string, p: RecipePack, snap: RunSnapshot, r: RescueRequest, mention: string[], mustNotMention: string[]): Case {
  const res = evaluate(p, v, snap, r);
  if (res.status !== 'REFUSED') throw new Error(`${id}: expected a refusal, got ${res.status}`);
  const why = refusalWhy({ pack: p, patterns: content.patterns, v }, res, r.proposedKindIds);
  return { id, question, why, expect: { startsWith: 'No', verdict: why.verdict, mention, mustNotMention: [...mustNotMention, 'yes'] } };
}

function freeze(): Case[] {
  const shortcake = pack(RECIPE['shortcake.demo']), risotto = pack(RECIPE['risotto.demo']), scones = pack(RECIPE['scones.demo']);
  const sc420 = structuredClone(source(RECIPE['scones.demo']));
  sc420.ingredients.find((i) => i.id === ING['cream'])!.listed = '420 ML';
  const scones420 = compileSource(sc420);
  const started5 = snapshotAfter(risotto, [...doneUpTo(risotto, 4), { stepId: risotto.recipe.steps[4].stepId, progress: 'started' }]);
  const limit = { ...snapshotAfter(scones, doneUpTo(scones, 2)), appliedRescueCount: 4 };
  // NEEDS_FACTS: the synthetic household risotto as imported (role table + corroboration applied), rice in cups only
  const lines = ['SYNTHETIC household risotto', 'Serves 4 to 6', '6 cups broth', '1 ½ cups arborio rice', '½ cup dry white wine', '1. Warm the broth.', '2. Toast the rice.', '3. Pour in the wine and stir until it is absorbed.', '4. Add the broth one ladle at a time.', '5. Off the heat, rest.'];
  const read = readPastedText(new TextEncoder().encode(lines.join('\n')));
  if (!read.ok) throw new Error('b14 text');
  const b14 = buildDraft({
    recipeFound: true, title: 'SYNTHETIC household risotto', yield: 'Serves 4 to 6',
    ingredients: [{ key: 'b', line: '6 cups broth', name: 'Broth', amountText: '6 cups', kind: 'unsalted-vegetable-stock' }, { key: 'r', line: '1 ½ cups arborio rice', name: 'Arborio rice', amountText: '1 ½ cups', kind: 'arborio-rice' }, { key: 'w', line: '½ cup dry white wine', name: 'Dry white wine', amountText: '½ cup', kind: 'dry-white-wine' }],
    steps: [{ key: 'a', text: 'Warm the broth.', title: 'Warm the broth', technique: 'HEAT_STOCK' }, { key: 't', text: 'Toast the rice.', title: 'Toast', technique: 'TOAST_RICE' }, { key: 'c', text: 'Pour in the wine and stir until it is absorbed.', title: 'Add the wine', technique: 'DEGLAZE' }, { key: 'd', text: 'Add the broth one ladle at a time.', title: 'Ladle', technique: 'LADLE_STOCK' }, { key: 'e', text: 'Off the heat, rest.', title: 'Rest', technique: 'OFF_HEAT_FINISH' }],
    uses: [{ ingredientKey: 'b', stepKey: 'a', quote: 'the broth', amountText: null, functions: ['LIQUID'] }, { ingredientKey: 'r', stepKey: 't', quote: 'the rice', amountText: null, functions: ['STRUCTURE'] }, { ingredientKey: 'w', stepKey: 'c', quote: 'the wine', amountText: null, functions: ['ACIDITY'] }, { ingredientKey: 'b', stepKey: 'd', quote: 'the broth', amountText: null, functions: ['LIQUID'] }],
  }, v, [{ sourceId: 's', origin: 'UPLOAD', pages: read.source.pages }], 'rcp_probe_b14', 'ex_probe', 'PROBE');
  if (!b14.ok) throw new Error('b14 draft');
  applyAuthority(b14.body.recipe, v, content.roles);
  const b14pack = compile(b14.body.recipe, v, content.patterns).pack!;
  const wine = b14pack.recipe.ingredients.find((i) => i.name === 'Dry white wine')!.ingredientId;
  const cream = ING['cream'];
  return [
    caseOf('shortcake-step4', "I don't have heavy cream, can I use milk and butter?", shortcake, snapshotAfter(shortcake, doneUpTo(shortcake, 3)), req(cream, ['whole-milk', 'unsalted-butter']), ['step 6', 'whip'], ['lemon']),
    caseOf('shortcake-step6', "I'm out of heavy cream. Can I use milk and butter to whip instead?", shortcake, snapshotAfter(shortcake, doneUpTo(shortcake, 5)), req(cream, ['whole-milk', 'unsalted-butter']), ['whip'], ['lemon']),
    caseOf('scones-out-of-range', "I'm out of heavy cream. Can I use milk and butter?", scones420, snapshotAfter(scones420, doneUpTo(scones420, 2)), req(cream, ['whole-milk', 'unsalted-butter']), ['420'], ['lemon']),
    caseOf('risotto-stock', "I'm out of stock. What can I use?", risotto, snapshotAfter(risotto, doneUpTo(risotto, 5)), req(ING['stock']), ['stock'], ['water', 'wine']),
    caseOf('risotto-protected-work', "I don't have any white wine. Can I use lemon juice?", risotto, started5, req(ING['wine'], ['lemon-juice']), ['step 5'], ['vinegar']),
    caseOf('needs-facts', 'No wine. What now?', b14pack, snapshotAfter(b14pack, doneUpTo(b14pack, 2)), req(wine), ['grams'], ['lemon']),
    caseOf('off-list-proposal', "I don't have heavy cream. Can I use lemon juice?", shortcake, snapshotAfter(shortcake, doneUpTo(shortcake, 3)), req(cream, ['lemon-juice']), ['step 6'], ['milk', 'butter']),
    caseOf('fifth-change', "I'm out of heavy cream. Can I use milk and butter?", scones, limit, req(cream, ['whole-milk', 'unsalted-butter']), ['4 changes'], ['lemon']),
  ];
}

const mode = process.argv[2];
if (mode === 'freeze') {
  if (existsSync(probePath)) throw new Error(`${probePath} exists: the probe is frozen (owner approval needed to change it)`);
  const cases = freeze();
  const probe = {
    kind: 'cc-explain-probe/1', frozenAt: new Date().toISOString(), status: 'FROZEN · NOT RUN · needs owner authorization for purpose "explanation"',
    model: 'us.amazon.nova-2-lite-v1:0', promptVersion: EXPLAIN_VERSION, promptIdentity: explainPromptIdentity(), system: EXPLAIN_SYSTEM,
    budget: { calls: cases.length, estimatedUsd: 0.01 },
    pass: 'An answer passes when rejectAnswer() accepts it (starts with "No", ≤ 280 chars, no new kind, technique or number) and it mentions every expect.mention term. A rejected answer still yields the template, so a failure never reaches a cook.',
    cases: cases.map((c) => ({ ...c, user: explainUserMessage(c.question, c.why) })),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(probePath, JSON.stringify({ ...probe, sha256: sha256(JSON.stringify(probe)) }, null, 2));
  for (const c of cases) console.log(`${c.id.padEnd(22)} ${c.why.verdict.padEnd(7)} ${c.why.facts.join(' | ')}`);
  console.log(`frozen: ${probePath}`);
} else if (mode === 'run') {
  if (existsSync(resultsPath)) throw new Error('results exist: the frozen probe runs once');
  const probe = JSON.parse(readFileSync(probePath, 'utf8')) as { promptIdentity: string; cases: Case[] };
  if (probe.promptIdentity !== explainPromptIdentity()) throw new Error('prompt identity changed since freezing');
  const auth = JSON.parse(readFileSync(join(root, 'private/architecture', process.env.CC_AUTHORIZATION ?? 'missing'), 'utf8')) as Authorization;
  if (!auth.maxCalls.explanation) throw new Error('the authorization does not name the "explanation" purpose');
  const ex = novaExplainer(new NovaClient(new Ledger(join(root, '.artifacts/ledger/nova-ledger.jsonl'), auth)));
  const results = [];
  for (const c of probe.cases) {
    const r = await ex.explain(c.question, c.why);
    const text = r.ok ? (r.raw as { answer?: unknown }).answer : null;
    const rejected = r.ok ? rejectAnswer(text, c.why, c.question, v) : r.reason;
    const missing = typeof text === 'string' ? c.expect.mention.filter((m) => !text.toLowerCase().includes(m.toLowerCase())) : c.expect.mention;
    results.push({ id: c.id, text, rejected, missing, pass: !rejected && !missing.length });
    console.log(`${c.id.padEnd(22)} ${!rejected && !missing.length ? 'PASS' : 'FAIL'} ${rejected ?? ''} ${missing.join(',')} ${String(text)}`);
  }
  writeFileSync(resultsPath, JSON.stringify({ at: new Date().toISOString(), authorization: auth.id, results }, null, 2));
} else console.log('usage: explain-probe.ts freeze | run');
