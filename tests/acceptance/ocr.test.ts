// OCR fallback (commission 2026-10-13): native text first, OCR only for pages that need it, the PDF held only until the
// job reads it, one paid reading per document per workspace, uncertain numerals flagged and never corrected. The OCR engine
// here is SCRIPTED (no Textract call); the Textract adapter's block parsing is checked on a recorded-shape fixture.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authoring } from '../../src/authoring/drafts.ts';
import type { Extractor } from '../../src/authoring/extract.ts';
import { linesOf, mergeOcr, ocrInputKey, type Ocr, type OcrPage, type OcrRead } from '../../src/authoring/ocr.ts';
import type { SourcePage } from '../../src/authoring/source.ts';
import { content, newKv, newWs } from '../helpers.ts';
import { makePdf, scanImage } from '../fixtures/pdf.ts';

const PAGE1 = ['Lemon Rice', 'Ingredients', '1 cup long-grain rice', '2 cups water', '1 lemon, zested'];
const OCR2: OcrPage = { page: 2, lines: [
  { lineId: 'p2.o1', text: 'Method', box: [0.1, 0.1, 0.2, 0.02], confidence: 99.1 },
  { lineId: 'p2.o2', text: '1. Simmer the rice in 2 cups water for 15 minutes.', box: [0.1, 0.14, 0.7, 0.02], confidence: 97.4, uncertain: ['2'] },
  { lineId: 'p2.o3', text: '2. Stir in the lemon zest.', box: [0.1, 0.18, 0.4, 0.02], confidence: 98.8 },
] };
const pdf = makePdf([{ lines: PAGE1 }, { image: scanImage() }]);
const reading = { recipeFound: true, title: 'Lemon Rice', yield: null,
  ingredients: [{ key: 'r', line: '1 cup long-grain rice', name: 'long-grain rice', amountText: '1 cup', kind: null }, { key: 'w', line: '2 cups water', name: 'water', amountText: '2 cups', kind: null },
    { key: 'l', line: '1 lemon, zested', name: 'lemon', amountText: '1', kind: null }],
  steps: [{ key: 's1', text: 'Simmer the rice in 2 cups water for 15 minutes.', title: 'Simmer', technique: null }, { key: 's2', text: 'Stir in the lemon zest.', title: 'Finish', technique: null }],
  uses: [{ ingredientKey: 'r', stepKey: 's1', quote: 'the rice', amountText: null, functions: [] }, { ingredientKey: 'w', stepKey: 's1', quote: 'water', amountText: '2 cups', functions: [] },
    { ingredientKey: 'l', stepKey: 's2', quote: 'the lemon zest', amountText: null, functions: [] }] };

function scriptedOcr(answer: (key: string) => OcrRead) {
  const calls = { stash: [] as string[], read: [] as string[], discard: [] as string[] };
  const ocr: Ocr = { name: 'SCRIPTED_OCR', stash: async (k) => { calls.stash.push(k); }, read: async (k) => { calls.read.push(k); return answer(k); }, discard: async (k) => { calls.discard.push(k); } };
  return { ocr, calls };
}
function authoring(ocr?: Ocr, raw: unknown = reading, ws = newWs()) {
  const seen: SourcePage[][] = [];
  const extractor: Extractor = { name: 'SCRIPTED', extract: async (pages) => { seen.push(pages); return { ok: true, raw, extractor: 'SCRIPTED', usage: null, costUsd: 0 }; } };
  return { a: new Authoring({ kv: newKv(join(mkdtempSync(join(tmpdir(), 'ccmcp-ocr-')), 'db')), ws, content, extractor, ...(ocr ? { ocr } : {}) }), seen, ws };
}
async function run(a: Authoring, input: Parameters<Authoring['createImport']>[0] = { kind: 'pdf', bytes: pdf, filename: 'lemon.pdf' }) {
  const r = await a.createImport(input);
  if (r.status !== 202) throw new Error(JSON.stringify(r));
  return { job: await a.waitForJob(r.job.id), draftId: r.draftId };
}

describe('OCR fallback', () => {
  it('reads only the page that needs it, deletes the held PDF, and flags the amount OCR was unsure of without changing it', async () => {
    const { ocr, calls } = scriptedOcr(() => ({ ok: true, pages: [{ page: 1, lines: [{ lineId: 'p1.o1', text: 'IGNORED: page 1 has a text layer' }] }, OCR2], billedPages: 2, jobId: 'tx1' }));
    const { a, seen, ws } = authoring(ocr);
    const { job, draftId } = await run(a);
    expect(job.state).not.toBe('failed');
    const key = calls.stash[0];
    expect(key).toMatch(new RegExp(`^ocr-input/${ws}/[0-9a-f]{64}\\.pdf$`));
    expect(calls).toEqual({ stash: [key], read: [key], discard: [key] });
    expect(seen[0].map((p) => [p.page, p.method, p.lines.map((l) => l.text)])).toEqual([[1, 'TEXT_LAYER', PAGE1], [2, 'OCR', OCR2.lines.map((l) => l.text)]]);   // native text first
    const d = (await a.getDraft(draftId)).draft;
    expect(d.blockers).toEqual([]);
    expect(d.issues).toContainEqual(expect.objectContaining({ code: 'OCR_UNCERTAIN_AMOUNT' }));
    const r = (await a.effective(draftId))!, water = r.ingredients.find((i) => i.name === 'water')!;
    expect(water.listedProv.status).toBe('SOURCE_VERIFIED');                                                  // "2 cups water" on page 1: native text
    expect(r.uses.find((u) => u.ingredientId === water.ingredientId)!.amountProv.status).toBe('PROPOSED');   // the step's "2": OCR was unsure
    expect(r.uses.find((u) => u.ingredientId === water.ingredientId)!.amount).toMatchObject({ kind: 'EXACT' });   // flagged, never changed
  });

  it('a second import of the same PDF in the workspace reuses the stored reading: no second paid call', async () => {
    const { ocr, calls } = scriptedOcr(() => ({ ok: true, pages: [OCR2], billedPages: 2, jobId: 'tx1' }));
    const { a } = authoring(ocr);
    await run(a); await run(a);
    expect(calls.read).toHaveLength(1);
    expect(calls.discard).toHaveLength(2);   // still never kept: the second upload's copy is deleted too
  });

  it('when OCR is refused (allowance used up), the text pages are read and the cook is asked to paste the rest', async () => {
    const { ocr, calls } = scriptedOcr(() => ({ ok: false, error: 'BUDGET_EXCEEDED', detail: 'reservation would exceed the $0.3 ocr allowance' }));
    const page1 = [...PAGE1, 'Method', '1. Rinse the rice.'];
    const { a } = authoring(ocr, { ...reading, steps: [{ key: 's1', text: 'Rinse the rice.', title: 'Rinse', technique: null }], uses: [{ ingredientKey: 'r', stepKey: 's1', quote: 'the rice', amountText: null, functions: [] }] });
    const { job, draftId } = await run(a, { kind: 'pdf', bytes: makePdf([{ lines: page1 }, { image: scanImage() }]), filename: 'lemon.pdf' });
    expect(job.state).toBe('partial');
    expect(calls.discard).toHaveLength(1);
    expect((await a.getDraft(draftId)).draft.blockers).toEqual([expect.objectContaining({ kind: 'missingSteps', resolution: { action: 'appendText', label: 'Paste the missing steps' } })]);
  });

  it('a PDF with no readable page: without OCR it fails at once (paste instead); with OCR failing, the job says reading it as an image failed', async () => {
    const scan = makePdf([{ image: scanImage() }]);
    const r = await authoring().a.createImport({ kind: 'pdf', bytes: scan, filename: 'scan.pdf' });
    expect(r.status === 202 && r.job.failure).toMatchObject({ code: 'UNREADABLE', message: expect.stringContaining('Paste the recipe text instead') });
    const { ocr } = scriptedOcr(() => ({ ok: false, error: 'FAILED', detail: 'Textract FAILED' }));
    const { job } = await run(authoring(ocr).a, { kind: 'pdf', bytes: scan, filename: 'scan.pdf' });
    expect(job.failure).toEqual({ code: 'UNREADABLE', message: "The recipe in that PDF isn't readable text, and reading it as an image didn't work. Paste the recipe text instead." });
  });

  it('a held PDF is keyed by workspace and document; merge never replaces a page that has a text layer', () => {
    expect(ocrInputKey('ws_a', 'ab'.repeat(32))).toBe(`ocr-input/ws_a/${'ab'.repeat(32)}.pdf`);
    const pages: SourcePage[] = [{ page: 1, status: 'TEXT', readingOrder: 'SIMPLE', lines: [{ lineId: 'p1.l1', text: 'native' }] }, { page: 2, status: 'HEADINGS_ONLY', readingOrder: 'SIMPLE', lines: [{ lineId: 'p2.l1', text: 'What you need' }] }];
    expect(mergeOcr(pages, [{ page: 1, lines: [{ lineId: 'p1.o1', text: 'ocr' }] }, OCR2]).map((p) => p.lines[0].text)).toEqual(['native', 'Method']);
  });

  it('Textract blocks → lines in Textract order, with box, confidence, and the numerals of unsure words', () => {
    const blocks = [
      { BlockType: 'PAGE', Id: 'pg', Page: 1 },
      { BlockType: 'LINE', Id: 'l1', Page: 1, Text: '1 ½ cups flour', Confidence: 96.04, Geometry: { BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.02 } }, Relationships: [{ Type: 'CHILD', Ids: ['w1', 'w2', 'w3', 'w4'] }] },
      { BlockType: 'WORD', Id: 'w1', Text: '1', Confidence: 99 }, { BlockType: 'WORD', Id: 'w2', Text: '½', Confidence: 61.5 }, { BlockType: 'WORD', Id: 'w3', Text: 'cups', Confidence: 50 }, { BlockType: 'WORD', Id: 'w4', Text: 'flour', Confidence: 99 },
      { BlockType: 'LINE', Id: 'l2', Page: 2, Text: 'Bake.', Confidence: 99.9, Geometry: { BoundingBox: { Left: 0.1, Top: 0.1, Width: 0.1, Height: 0.02 } }, Relationships: [] },
    ];
    expect(linesOf(blocks as never)).toEqual([
      { page: 1, lines: [{ lineId: 'p1.o1', text: '1 ½ cups flour', box: [0.1, 0.2, 0.3, 0.02], confidence: 96, uncertain: ['½'] }] },   // "cups" is unsure but no numeral
      { page: 2, lines: [{ lineId: 'p2.o1', text: 'Bake.', box: [0.1, 0.1, 0.1, 0.02], confidence: 99.9 }] },
    ]);
  });
});
