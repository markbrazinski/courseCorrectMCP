// Source adapters (ESOD §3.4): PDF text layer or pasted text → one page/line-addressed SourceText.
// Native text first: every page is classified from its own text layer and drawing operators (classifyPage). A page whose
// recipe text isn't in the text layer is reported (NO_TEXT_LAYER, HEADINGS_ONLY, UNUSABLE_TEXT), never guessed; the import
// job may read it with OCR (ocr.ts), else the cook is asked to paste it. Bytes are never edited.
import { Worker } from 'node:worker_threads';
import { sha256 } from '../domain/rational.ts';
import type { RawItem, RawPage, WorkerReply } from './pdf-worker.ts';

export const LIMITS = { pdfBytes: 10 * 1024 * 1024, textBytes: 200 * 1024, pages: 20, minPageChars: 20, workerMs: 20_000 } as const;

export interface SourceLine {
  lineId: string; text: string;
  /** where the line is on its page: [x, y, w, h] in PDF points from the bottom left (text layer), or page fractions from the top left (OCR) */
  box?: [number, number, number, number];
  /** OCR only: the engine's confidence in the line (0–100), and the numerals in it it was unsure of (never corrected) */
  confidence?: number; uncertain?: string[];
}
/**
 * TEXT: the text layer holds the page's text. NO_TEXT_LAYER: (almost) no text. HEADINGS_ONLY: a few lines, no recipe body, and
 * drawing content that can hold text (text drawn as shapes, or pictures of it). UNUSABLE_TEXT: the text layer's characters
 * are mostly undecodable (private-use glyphs, replacement characters). Only TEXT pages are read from the text layer.
 */
export type PageStatus = 'TEXT' | 'NO_TEXT_LAYER' | 'HEADINGS_ONLY' | 'UNUSABLE_TEXT';
export interface SourcePage {
  page: number | null; status: PageStatus;
  /** COLUMNS: side-by-side blocks were found from the item geometry and are read block by block (columnsOf) */
  readingOrder: 'SIMPLE' | 'COLUMNS' | 'READING_ORDER_UNCERTAIN'; lines: SourceLine[];
  /** how the lines were read; absent = the PDF text layer (or pasted text) */ method?: 'TEXT_LAYER' | 'OCR';
  /** PDF pages: pictures and vector shapes drawn on the page (a TEXT page with pictures is read from its text only) */ graphics?: { images: number; paths: number };
}
export const needsRecognition = (p: SourcePage) => p.status !== 'TEXT';
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
    status: pages.every(needsRecognition) ? 'NEEDS_TEXT_RECOGNITION' : 'TEXT_READY', pages,
  } };
}

const blank = (it: RawItem) => !it.str.trim();
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Baselines: items whose vertical positions agree within half a line height. */
function bandsOf(items: RawItem[]): RawItem[][] {
  const bands: RawItem[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const band = bands.at(-1);
    if (band && Math.abs(band[0].y - it.y) <= 0.5 * Math.max(band[0].h, it.h)) band.push(it); else bands.push([it]);
  }
  return bands;
}

/** Widest empty interval in a projection of [start, end] spans, at least `min` wide: its midpoint, else null. */
function widestGap(spans: [number, number][], min: number): { at: number; width: number } | null {
  const xs = [...spans].sort((a, b) => a[0] - b[0]);
  let best: { at: number; width: number } | null = null, end = xs[0]?.[1] ?? 0;
  for (const [a, b] of xs.slice(1)) {
    if (a - end >= min && (!best || a - end > best.width)) best = { at: (a + end) / 2, width: a - end };
    end = Math.max(end, b);
  }
  return best;
}

/**
 * Reading order from geometry (recursive XY cut). A block is split left|right at its widest vertical gutter (at least
 * 1.5 line heights and 12 pt wide, crossed by no text), else top|bottom at a gap wider than a line height; otherwise it is
 * one block, read line by line. A left|right split is refused when the two sides' lines sit on the same baselines (within
 * 0.2 line heights) for 80% of either side's lines: that is a table read across (amounts | names), not two columns.
 * `uncertain`: such a refused split had prose on both sides (3+ lines each, 4+ words a line): columns whose lines happen to
 * align that closely stay glued, and the page is flagged READING_ORDER_UNCERTAIN. Text rotated or set in curves isn't handled.
 */
type Cut = { blocks: RawItem[][]; columns: boolean; uncertain: boolean };
const words = (band: RawItem[]) => band.map((it) => it.str).join(' ').trim().split(/\s+/).length;
export function columnsOf(items: RawItem[]): Cut {
  const solid = items.filter((it) => !blank(it));
  if (solid.length < 2) return { blocks: [items], columns: false, uncertain: false };
  const h = median(solid.map((it) => it.h)) || 10;
  const side = (at: number, axis: 'x' | 'y') => {
    const a: RawItem[] = [], b: RawItem[] = [];
    for (const it of items) (axis === 'x' ? it.x + it.w / 2 < at : it.y + it.h / 2 > at) ? a.push(it) : b.push(it);
    return [a, b] as const;
  };
  const v = widestGap(solid.map((it) => [it.x, it.x + it.w]), Math.max(12, 1.5 * h));
  if (v) {
    const [l, r] = side(v.at, 'x');
    const BL = bandsOf(l.filter((it) => !blank(it))), BR = bandsOf(r.filter((it) => !blank(it)));
    const bl = BL.map((b) => b[0].y), br = BR.map((b) => b[0].y);
    const tol = 0.2 * h, aligned = (ys: number[], other: number[]) => ys.filter((y) => other.some((o) => Math.abs(o - y) <= tol)).length / ys.length;
    if (Math.max(aligned(bl, br), aligned(br, bl)) < 0.8) {
      const a = columnsOf(l), b = columnsOf(r);
      return { blocks: [...a.blocks, ...b.blocks], columns: true, uncertain: a.uncertain || b.uncertain };
    }
    const prose = (bs: RawItem[][]) => bs.length >= 3 && median(bs.map(words)) >= 4;
    if (prose(BL) && prose(BR)) return { blocks: [items], columns: false, uncertain: true };
  }
  const hz = widestGap(solid.map((it) => [it.y, it.y + it.h]), h);
  if (hz) {
    const [top, bottom] = side(hz.at, 'y');
    if (top.length && bottom.length) {
      const a = columnsOf(top), b = columnsOf(bottom);
      return { blocks: [...a.blocks, ...b.blocks], columns: a.columns || b.columns, uncertain: a.uncertain || b.uncertain };
    }
  }
  return { blocks: [items], columns: false, uncertain: false };
}

/**
 * The page's class from its own content (documented page selection, the OCR commission 2026-10-13). Thresholds:
 * NO_TEXT_LAYER under 20 visible characters; UNUSABLE_TEXT when over 20% of them are private-use, replacement or control
 * characters; HEADINGS_ONLY when the page draws a picture or 200+ vector shapes, has at most 12 lines, and none of them
 * reads like a recipe body (an amount-led line, or a sentence of 8+ words ending in punctuation).
 */
export function classifyPage(lines: SourceLine[], g: { images: number; paths: number } | undefined): PageStatus {
  const chars = lines.reduce((c, l) => c + l.text.replace(/\s/g, '').length, 0);
  if (chars < LIMITS.minPageChars) return 'NO_TEXT_LAYER';
  const bad = lines.reduce((c, l) => c + (l.text.match(/[\uE000-\uF8FF\uFFFD\u0000-\u001F]/g)?.length ?? 0), 0);
  if (bad > 0.2 * chars) return 'UNUSABLE_TEXT';
  const body = (t: string) => /^[\s•●▪◦*-]*(?:\d|[¼½¾⅓⅔⅛⅜⅝⅞])/.test(t) || (t.split(/\s+/).length >= 8 && /[.!?:]$/.test(t));
  if (g && (g.images > 0 || g.paths >= 200) && lines.length <= 12 && !lines.some((l) => body(l.text))) return 'HEADINGS_ONLY';
  return 'TEXT';
}

/** Lines in reading order (columnsOf), each with its box. A line still holding two prose runs (3+ words each) more than three
 *  line heights apart is glued text; two such lines, or an uncertain cut, flag the page READING_ORDER_UNCERTAIN. */
export function buildPages(raw: RawPage[]): SourcePage[] {
  return raw.map((p, n) => {
    const { blocks, columns, uncertain } = columnsOf(p.items);
    let split = 0, k = 0;
    const lines: SourceLine[] = [];
    for (const band of blocks.flatMap(bandsOf)) {
      band.sort((a, b) => a.x - b.x);
      const runs: RawItem[][] = [];
      for (const it of band.filter((x) => !blank(x))) {
        const run = runs.at(-1), last = run?.at(-1);
        if (last && it.x - (last.x + last.w) <= 3 * Math.max(last.h, it.h)) run!.push(it); else runs.push([it]);
      }
      if (runs.filter((x) => words(x) >= 3).length >= 2) split++;
      let out = '';
      band.forEach((it, i) => {
        const prev = band[i - 1];
        if (prev && it.x - (prev.x + prev.w) > 0.15 * it.h && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
        out += it.str;
      });
      const text = norm(out);
      if (!text) continue;
      const x0 = Math.min(...band.map((it) => it.x)), x1 = Math.max(...band.map((it) => it.x + it.w)), y0 = Math.min(...band.map((it) => it.y));
      lines.push({ lineId: `p${n + 1}.l${++k}`, text, box: [round1(x0), round1(y0), round1(x1 - x0), round1(Math.max(...band.map((it) => it.y + it.h)) - y0)] });
    }
    const graphics = { images: p.images ?? 0, paths: p.paths ?? 0 };
    return { page: n + 1, status: classifyPage(lines, graphics), readingOrder: split >= 2 || uncertain ? 'READING_ORDER_UNCERTAIN' : columns ? 'COLUMNS' : 'SIMPLE', lines, method: 'TEXT_LAYER', graphics };
  });
}

export const allLines = (pages: SourcePage[]) => pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));

/**
 * Lines joined into one text three ways, for finding a quote that runs across a line break (holdout h01, 2026-10-13): as printed
 * (a space at each break), with a line-end hyphen kept and the space dropped ("3/4-" + "inch" → "3/4-inch", a genuine hyphen), and
 * with a hyphen between two lower-case letters dropped as well ("min-" + "utes" → "minutes", a word broken at the margin). Which a
 * break is can't be known, so a quote is found when any of the three has it. Digits are never joined ("1-" + "2 cups" stays two
 * numbers). The source text itself is never changed.
 */
export function joinings(texts: string[]): [string, string, string] {
  let asPrinted = '', hard = '', soft = '';
  texts.forEach((t, i) => {
    if (!i) { asPrinted = hard = soft = t; return; }
    asPrinted += ` ${t}`;
    const brk = /-$/.test(hard) && /^\S/.test(t);
    hard += brk ? t : ` ${t}`;
    soft = /\p{Ll}-$/u.test(soft) && /^\p{Ll}/u.test(t) ? soft.slice(0, -1) + t : /-$/.test(soft) && /^\S/.test(t) ? soft + t : `${soft} ${t}`;
  });
  return [asPrinted, hard, soft];
}
