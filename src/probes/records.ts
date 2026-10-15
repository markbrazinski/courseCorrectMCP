// A draft's stored model outputs in the SQLite build's row shapes, read from the workspace store (probe reports only, so
// their evidence files keep the same fields). Newest first, as the probes read them.
import { wsPk, type Item, type Kv } from '../service/kv.ts';

const json = (x: unknown) => (x === null || x === undefined ? null : JSON.stringify(x));
const newest = (a: Item, b: Item) => String(b.createdAt).localeCompare(String(a.createdAt));
export async function modelRows(kv: Kv, ws: string, draftId: string) {
  const items = await kv.query(wsPk(ws), { prefix: `DR#${draftId}#` });
  const extractions = items.filter((x) => x.sk.includes('#EX#')).sort(newest).map((x) => ({
    extractor: x.extractor as string, job_id: x.jobId as string, status: x.status as string, raw_json: json(x.raw), issues_json: json(x.issues) ?? '[]',
    input_tokens: x.inputTokens as number | null, output_tokens: x.outputTokens as number | null, cost_usd: x.costUsd as number,
  }));
  const analyses = items.filter((x) => x.sk.includes('#SA#')).sort(newest).map((x) => ({
    analysis_id: x.analysisId as string, analyzer: x.analyzer as string, status: x.status as string, raw_json: json(x.raw), refs_json: json(x.refs) ?? '{}', issues_json: json(x.issues),
    input_tokens: x.inputTokens as number | null, output_tokens: x.outputTokens as number | null, cost_usd: x.costUsd as number, input_hash: x.inputHash as string,
  }));
  const repairs = (await Promise.all(analyses.map((a) => kv.get({ pk: wsPk(ws), sk: `SR#${a.analysis_id}` })))).filter((x): x is Item => !!x)
    .map((x) => ({ status: x.status as string, requested_json: json(x.requested) ?? '[]', raw_json: json(x.raw) }));
  return { extractions, analyses, repairs };
}
