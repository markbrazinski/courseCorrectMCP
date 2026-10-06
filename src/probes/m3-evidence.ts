// Collects the evidence of an owner-run real-audio walkthrough from the service's own records: the MCP call log, each
// rescue request with its input channel (voice/typed/tapped), Nova interpretations, applied amendments, and the M3
// ledger lines (Nova + Polly). It reads; it never calls anything. The screen recording with microphone audio is the
// audio evidence; "voice" here only means the text came through the browser's speech recognition path.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const dbPath = process.argv[2] ?? join(root, '.artifacts/walkthrough/m3-live.db');
const authId = (JSON.parse(readFileSync(join(root, 'private/architecture/live-authorization-m3.json'), 'utf8')) as { id: string }).id;
const db = new DatabaseSync(dbPath, { readOnly: true });
type R = Record<string, string | number | null>;

const activity = (db.prepare('SELECT seq, run_id, tool, correlation_id, status, summary, input_json, trace_json, duration_ms, at FROM activity ORDER BY seq').all() as R[])
  .map((r) => ({ seq: r.seq, at: r.at, tool: r.tool, status: r.status, summary: r.summary, input: JSON.parse(String(r.input_json ?? 'null')), trace: r.trace_json ? JSON.parse(String(r.trace_json)) : null, durationMs: r.duration_ms, runId: r.run_id }));
const rescues = activity.filter((a) => a.tool === 'evaluate_rescue' && a.input?.utterance).map((a) => ({
  seq: a.seq, at: a.at, channel: a.input.utterance.channel as string, text: a.input.utterance.text as string, status: a.status,
  interpretation: a.trace?.interpretation ?? null, durationMs: a.durationMs,
}));
const amendments = db.prepare('SELECT amendment_id, run_id, command_id, changed_step_ids, at FROM amendments ORDER BY at').all() as R[];
const ledger = readFileSync(join(root, '.artifacts/ledger/nova-ledger.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as { at: string; key: string; kind: string; purpose: string; usd: number; authorization: string; label: string; characters?: number })
  .filter((e) => e.authorization === authId);
const settled = (p: string) => ledger.filter((e) => e.purpose === p && e.kind === 'settle');
const usd = [...new Map(ledger.map((e) => [e.key, e])).keys()].reduce((s, k) => {
  const es = ledger.filter((e) => e.key === k), st = es.find((e) => e.kind === 'settle');
  return s + (st ? st.usd : es.filter((e) => e.kind === 'reserve').reduce((a, e) => a + e.usd, 0));
}, 0);

const summary = {
  db: dbPath, authorization: authId,
  mcpCalls: Object.fromEntries([...new Set(activity.map((a) => a.tool))].map((t) => [t, activity.filter((a) => a.tool === t).length])),
  rescueRequests: rescues.length, viaVoice: rescues.filter((r) => r.channel === 'voice').length, viaTyped: rescues.filter((r) => r.channel === 'typed').length,
  novaInterpretations: rescues.filter((r) => String(r.interpretation ?? '').startsWith('NOVA')).length,
  amendmentsApplied: amendments.length,
  ledger: { novaCalls: settled('interpretation').length, pollyCalls: settled('speech').length, pollyCharacters: settled('speech').reduce((s, e) => s + (e.characters ?? 0), 0), failed: ledger.filter((e) => e.kind === 'failed').length, authorizationUsd: Number(usd.toFixed(5)) },
};
const out = join(root, '.artifacts/walkthrough', `m3-real-audio-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(join(root, '.artifacts/walkthrough'), { recursive: true });
writeFileSync(out, JSON.stringify({ kind: 'cc-m3-walkthrough-evidence/1', summary, rescues, amendments, activity, ledger }, null, 1));
console.log(JSON.stringify(summary, null, 1));
for (const r of rescues) console.log(`  #${r.seq} ${r.channel.padEnd(6)} “${r.text}” → ${r.status} · ${r.interpretation ?? ''}`);
console.log(`\nwrote ${out}`);
