// OCR fallback (commission 2026-10-13): Amazon Textract DetectDocumentText, text only (no Forms, Tables or Queries), for PDF
// pages whose recipe text isn't in the text layer (source.ts classifyPage). Native text first: OCR lines replace a page only
// when that page needs recognition; every other page keeps its text layer.
//   Where: inside the claimed import job (the worker function), asynchronously (StartDocumentTextDetection, then polling).
//   Input: the PDF, held in the private bucket under ocr-input/<ws>/<sha256>.pdf from upload until the job is done; deleted
//     explicitly when reading ends (success or failure), with a one-day lifecycle rule as the backstop (infra/data.yaml).
//   Pages: Textract's asynchronous API reads the whole document (it can't select pages), so a document that needs OCR is
//     read in full, at most LIMITS.pages pages, and billed per page; only the pages that need it are used.
//   Spending: reserved in the ledger as purpose "ocr" for the document's pages before the call, settled at the pages Textract
//     reports, never retried. ClientRequestToken is derived from the workspace and document, so a repeated start within
//     Textract's idempotency window reuses the same Textract job instead of paying again; a finished result is stored by
//     document hash (drafts.ts) and reused by every later import of the same PDF in that workspace.
//   Fidelity: lines are kept as Textract read them, with their position and confidence; numerals in words Textract was
//     unsure of (confidence < UNSURE) are listed on the line and never corrected.
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand, TextractClient, type Block } from '@aws-sdk/client-textract';
import { hash } from '../domain/rational.ts';
import { BudgetExceeded, type SpendLedger } from './nova.ts';
import { norm, type SourceLine, type SourcePage } from './source.ts';

/** us-east-1 DetectDocumentText, synchronous and asynchronous alike (AWS price list, published 2026-09-11). */
export const OCR_PRICE_PER_PAGE = 0.0015;
/** A word below this Textract confidence (0–100) whose text holds a numeral makes its line's amount uncertain. */
export const UNSURE = 90;
export const OCR_ENGINE = 'TEXTRACT_DETECT_DOCUMENT_TEXT';

export interface OcrPage { page: number; lines: SourceLine[] }
export type OcrRead = { ok: true; pages: OcrPage[]; billedPages: number; jobId: string } | { ok: false; error: 'BUDGET_EXCEEDED' | 'FAILED' | 'TIMEOUT'; detail: string };
export interface Ocr {
  readonly name: string;
  /** Hold the PDF for a later read (upload time). */
  stash(key: string, bytes: Uint8Array): Promise<void>;
  /** Read a stashed PDF of `pages` pages; paid, reserved and settled in the ledger under `ledgerKey`. */
  read(key: string, a: { pages: number; token: string; ledgerKey: string; label: string }): Promise<OcrRead>;
  /** Delete the stashed PDF (always, once reading ends). */
  discard(key: string): Promise<void>;
}
export const ocrInputKey = (ws: string, sha256: string) => `ocr-input/${ws}/${sha256}.pdf`;
/** Textract's ClientRequestToken: 1–64 of [a-zA-Z0-9-_]; the same document in the same workspace gives the same token. */
export const ocrToken = (ws: string, sha256: string) => `cc-${hash({ ws, sha256 }).slice(0, 40)}`;

const NUMERAL = /\d|[¼½¾⅓⅔⅛⅜⅝⅞]/;
/** Textract blocks (all result pages) → lines per page, in Textract's order, with box, confidence and unsure numerals. */
export function linesOf(blocks: Block[]): OcrPage[] {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));
  const pages = new Map<number, SourceLine[]>();
  for (const b of blocks) {
    if (b.BlockType !== 'LINE' || !b.Text) continue;
    const page = b.Page ?? 1, lines = pages.get(page) ?? [];
    const words = (b.Relationships ?? []).filter((r) => r.Type === 'CHILD').flatMap((r) => r.Ids ?? []).map((id) => byId.get(id)).filter((w): w is Block => !!w && w.BlockType === 'WORD');
    const uncertain = words.filter((w) => NUMERAL.test(w.Text ?? '') && (w.Confidence ?? 0) < UNSURE).map((w) => w.Text!);
    const g = b.Geometry?.BoundingBox;
    const r3 = (x: number | undefined) => Math.round((x ?? 0) * 1000) / 1000;
    const text = norm(b.Text);
    if (!text) continue;
    lines.push({ lineId: `p${page}.o${lines.length + 1}`, text, box: [r3(g?.Left), r3(g?.Top), r3(g?.Width), r3(g?.Height)], confidence: Math.round((b.Confidence ?? 0) * 10) / 10, ...(uncertain.length ? { uncertain } : {}) });
    pages.set(page, lines);
  }
  return [...pages].sort((a, b) => a[0] - b[0]).map(([page, lines]) => ({ page, lines }));
}

/** The page as read: the OCR page in place of a page that needs recognition, every other page as its text layer read it. */
export function mergeOcr(pages: SourcePage[], ocr: OcrPage[] | null): SourcePage[] {
  if (!ocr) return pages;
  return pages.map((p) => {
    if (p.status === 'TEXT') return p;
    const o = ocr.find((x) => x.page === p.page);
    if (!o || !o.lines.length) return p;
    return { ...p, status: 'TEXT', readingOrder: 'SIMPLE', lines: ocrReadingOrder(o.lines), method: 'OCR' };
  });
}

const AMOUNT_START = /^[\s•●▪*-]*(?:\d|[¼½¾⅓⅔⅛])/;
/**
 * Reading order for OCR lines (holdout h01, 2026-10-13: Textract reads a two-column ingredient list row by row, so a wrapped line
 * ends up after the other column's line). Lines are grouped into rows by their boxes (page fractions, top-left origin); a run of
 * rows whose lines all sit on one side of a common gutter, with lines on both sides in at least two rows, is two columns. When
 * those rows read as two ingredient lists (both sides start with an amount in at least two rows), the left column is read before
 * the right one. Otherwise (a table of amounts and names, an advert beside the list, prose) the page keeps Textract's order
 * exactly: nothing is reordered on a guess, and text that order garbles is then not found in the source (the reading fails its
 * fidelity check, a step reads as unlocated), never taken as read. Line ids and texts are kept as read.
 */
export function ocrReadingOrder(lines: SourceLine[]): SourceLine[] {
  if (lines.length < 4 || lines.some((l) => !l.box)) return lines;
  const h = [...lines].map((l) => l.box![3]).sort((a, b) => a - b)[lines.length >> 1] || 0.02;
  const rows: SourceLine[][] = [];
  for (const l of [...lines].sort((a, b) => a.box![1] - b.box![1])) {
    const row = rows.at(-1), mid = (x: SourceLine) => x.box![1] + x.box![3] / 2;
    if (row && Math.abs(mid(row[0]) - mid(l)) <= 0.5 * h) row.push(l); else rows.push([l]);
  }
  rows.forEach((r) => r.sort((a, b) => a.box![0] - b.box![0]));
  const right = (l: SourceLine) => l.box![0] + l.box![2];
  const out: SourceLine[] = [];
  let lists = false;
  for (let i = 0; i < rows.length;) {
    // a run starts at a row with two lines separated by a clear gap
    const r0 = rows[i];
    const gapAt = r0.length >= 2 ? r0.findIndex((l, k) => k > 0 && l.box![0] - right(r0[k - 1]) >= 0.03) : -1;
    if (gapAt < 0) { out.push(...r0); i++; continue; }
    let gL = Math.max(...r0.slice(0, gapAt).map(right)), gR = Math.min(...r0.slice(gapAt).map((l) => l.box![0]));
    const run: { left: SourceLine[]; right: SourceLine[] }[] = [];
    let j = i;
    for (; j < rows.length; j++) {
      const L = rows[j].filter((l) => right(l) <= gR && l.box![0] < gL + 0.01), R = rows[j].filter((l) => l.box![0] >= gL && right(l) > gR - 0.01);
      if (L.length + R.length !== rows[j].length || L.some((l) => R.includes(l))) break;   // a line across the gutter ends the run
      const nL = Math.max(gL, ...L.map(right)), nR = Math.min(gR, ...R.map((l) => l.box![0]));
      if (nR <= nL) break;
      gL = nL; gR = nR;
      run.push({ left: L, right: R });
    }
    const both = run.filter((x) => x.left.length && x.right.length);
    if (both.length < 2) { out.push(...r0); i++; continue; }
    if (both.filter((x) => AMOUNT_START.test(x.left[0].text) && AMOUNT_START.test(x.right[0].text)).length < 2) { out.push(...r0); i++; continue; }
    out.push(...run.flatMap((x) => x.left), ...run.flatMap((x) => x.right));
    lists = true;
    i = j;
  }
  return lists ? out : lines;
}

export function textractOcr(o: { bucket: string; ledger: SpendLedger; region?: string; pollMs?: number; deadlineMs?: number }): Ocr {
  const s3 = new S3Client({ region: o.region }), textract = new TextractClient({ region: o.region, maxAttempts: 1 });   // a paid call is made once
  const poll = o.pollMs ?? 1500, deadline = o.deadlineMs ?? 240_000;
  return {
    name: OCR_ENGINE,
    async stash(key, bytes) { await s3.send(new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: bytes, ContentType: 'application/pdf' })); },
    async discard(key) { await s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key })); },
    async read(key, a) {
      try { await o.ledger.reserve('ocr', a.ledgerKey, a.pages * OCR_PRICE_PER_PAGE, a.label); }
      catch (e) { if (e instanceof BudgetExceeded) return { ok: false, error: 'BUDGET_EXCEEDED', detail: e.message }; throw e; }
      let jobId = '';
      try {
        jobId = (await textract.send(new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: { Bucket: o.bucket, Name: key } }, ClientRequestToken: a.token, JobTag: 'coursecorrect-import' }))).JobId!;
        const end = Date.now() + deadline;
        for (;;) {
          await new Promise((ok) => setTimeout(ok, poll));
          const first = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1000 }));
          if (first.JobStatus === 'IN_PROGRESS') { if (Date.now() > end) { await o.ledger.failed('ocr', a.ledgerKey, a.label); return { ok: false, error: 'TIMEOUT', detail: `Textract job ${jobId} still running after ${deadline / 1000} s` }; } continue; }
          if (first.JobStatus !== 'SUCCEEDED' && first.JobStatus !== 'PARTIAL_SUCCESS') { await o.ledger.failed('ocr', a.ledgerKey, a.label); return { ok: false, error: 'FAILED', detail: `Textract ${first.JobStatus}: ${first.StatusMessage ?? ''}`.slice(0, 200) }; }
          const blocks = [...(first.Blocks ?? [])];
          for (let next = first.NextToken; next;) {
            const more = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId, MaxResults: 1000, NextToken: next }));
            blocks.push(...(more.Blocks ?? []));
            next = more.NextToken;
          }
          const billedPages = first.DocumentMetadata?.Pages ?? a.pages;
          await o.ledger.settleChars('ocr', a.ledgerKey, billedPages, billedPages * OCR_PRICE_PER_PAGE, a.label);   // "characters" here: pages
          return { ok: true, pages: linesOf(blocks), billedPages, jobId };
        }
      } catch (e) {
        const n = (e as Error).name;   // refused before any page was read (not billed): $0; anything else stays counted in full
        if (!jobId && (n === 'ThrottlingException' || n === 'ProvisionedThroughputExceededException')) await o.ledger.refused('ocr', a.ledgerKey, `${n}: refused before reading (${a.label})`);
        else await o.ledger.failed('ocr', a.ledgerKey, a.label);
        return { ok: false, error: 'FAILED', detail: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200) };
      }
    },
  };
}
