// Source adapters (ESOD §3.4): PDF text layer or pasted text → one page/line-addressed SourceText.
// No OCR: a page without a text layer is reported (NO_TEXT_LAYER), never guessed. Bytes are never edited.
import { Worker } from 'node:worker_threads';
import { sha256 } from '../domain/rational.ts';
import type { RawItem, RawPage, WorkerReply } from './pdf-worker.ts';

export const LIMITS = { pdfBytes: 10 * 1024 * 1024, textBytes: 200 * 1024, pages: 20, minPageChars: 20, workerMs: 20_000 } as const;

export interface SourceLine { lineId: string; text: string }
export interface SourcePage { page: number | null; status: 'TEXT' | 'NO_TEXT_LAYER'; readingOrder: 'SIMPLE' | 'READING_ORDER_UNCERTAIN'; lines: SourceLine[] }
export interface SourceText {
  kind: 'cc-source-text/1'; sha256: string; mediaType: 'application/pdf' | 'text/plain'; byteLength: number;
  status: 'TEXT_READY' | 'NEEDS_TEXT_RECOGNITION'; pages: SourcePage[];
}
export type ReadFailure = 'EMPTY' | 'TOO_LARGE' | 'NOT_A_PDF' | 'ENCRYPTED' | 'TOO_MANY_PAGES' | 'UNREADABLE' | 'NOT_UTF8';
export type ReadResult = { ok: true; source: SourceText } | { ok: false; code: ReadFailure; detail: string };

/** NFC, explicit ligatures, collapsed whitespace. No NFKC (keeps ½), no dehyphenation. */
export const norm = (t: string) => t.normalize('NFC').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/\s+/g, ' ').trim();

export function readPastedText(bytes: Uint8Array, linePrefix = 'l'): ReadResult {
  if (bytes.length > LIMITS.textBytes) return { ok: false, code: 'TOO_LARGE', detail: `${bytes.length} bytes (limit ${LIMITS.textBytes})` };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, code: 'NOT_UTF8', detail: 'pasted text is not valid UTF-8' }; }
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((t) => norm(t)).filter(Boolean).map((t, i) => ({ lineId: `${linePrefix}${i + 1}`, text: t }));
  if (!lines.length) return { ok: false, code: 'EMPTY', detail: 'no text' };
  return { ok: true, source: { kind: 'cc-source-text/1', sha256: sha256(Buffer.from(bytes).toString('latin1')), mediaType: 'text/plain', byteLength: bytes.length, status: 'TEXT_READY', pages: [{ page: null, status: 'TEXT', readingOrder: 'SIMPLE', lines }] } };
}

function runWorker(bytes: Uint8Array): Promise<WorkerReply | { ok: false; code: 'UNREADABLE'; detail: string }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./pdf-worker.ts', import.meta.url), { workerData: { data: bytes, maxPages: LIMITS.pages }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { void w.terminate(); resolve({ ok: false, code: 'UNREADABLE', detail: `reading took longer than ${LIMITS.workerMs / 1000} s` }); }, LIMITS.workerMs);
    w.once('message', (m: WorkerReply) => { clearTimeout(timer); void w.terminate(); resolve(m); });
    w.once('error', (e: Error) => { clearTimeout(timer); resolve({ ok: false, code: 'UNREADABLE', detail: e.message.slice(0, 200) }); });
  });
}

export async function readPdf(bytes: Uint8Array): Promise<ReadResult> {
  if (!bytes.length) return { ok: false, code: 'EMPTY', detail: 'empty file' };
  if (bytes.length > LIMITS.pdfBytes) return { ok: false, code: 'TOO_LARGE', detail: `${bytes.length} bytes (limit ${LIMITS.pdfBytes})` };
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') return { ok: false, code: 'NOT_A_PDF', detail: 'the file does not start with a PDF header' };
  const r = await runWorker(bytes);
  if (!r.ok) return r;
  const pages = buildPages(r.pages);
  return { ok: true, source: {
    kind: 'cc-source-text/1', sha256: sha256(Buffer.from(bytes).toString('latin1')), mediaType: 'application/pdf', byteLength: bytes.length,
    status: pages.every((p) => p.status === 'NO_TEXT_LAYER') ? 'NEEDS_TEXT_RECOGNITION' : 'TEXT_READY', pages,
  } };
}

/** Baseline grouping into lines; a page with two text segments on ≥2 baselines is flagged READING_ORDER_UNCERTAIN. */
export function buildPages(raw: RawPage[]): SourcePage[] {
  return raw.map((p, n) => {
    const items = [...p.items].sort((a, b) => b.y - a.y || a.x - b.x);
    const bands: RawItem[][] = [];
    for (const it of items) {
      const band = bands.at(-1);
      if (band && Math.abs(band[0].y - it.y) <= 0.5 * Math.max(band[0].h, it.h)) band.push(it); else bands.push([it]);
    }
    let split = 0;
    const lines = bands.map((band, i) => {
      band.sort((a, b) => a.x - b.x);
      let out = '';
      band.forEach((it, k) => {
        const prev = band[k - 1];
        if (prev && it.x - (prev.x + prev.w) > 3 * Math.max(prev.h, it.h)) split++;
        if (prev && it.x - (prev.x + prev.w) > 0.15 * it.h && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
        out += it.str;
      });
      return { lineId: `p${n + 1}.l${i + 1}`, text: norm(out) };
    }).filter((l) => l.text);
    const chars = lines.reduce((c, l) => c + l.text.replace(/\s/g, '').length, 0);
    return { page: n + 1, status: chars < LIMITS.minPageChars ? 'NO_TEXT_LAYER' : 'TEXT', readingOrder: split >= 2 ? 'READING_ORDER_UNCERTAIN' : 'SIMPLE', lines };
  });
}

export const allLines = (pages: SourcePage[]) => pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));
