// Worker thread: reads an untrusted PDF's text layer with pdf.js. Isolated (resource limits + timeout set by the caller).
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface RawItem { str: string; x: number; y: number; w: number; h: number }
export interface RawPage { width: number; height: number; items: RawItem[] }
export type WorkerReply = { ok: true; pages: RawPage[] } | { ok: false; code: 'ENCRYPTED' | 'NOT_A_PDF' | 'TOO_MANY_PAGES'; detail: string };

const { data, maxPages } = workerData as { data: Uint8Array; maxPages: number };
async function run(): Promise<WorkerReply> {
  try {
    const task = getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    if (doc.numPages > maxPages) return { ok: false, code: 'TOO_MANY_PAGES', detail: `${doc.numPages} pages (limit ${maxPages})` };
    const pages: RawPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [, , width, height] = page.view as [number, number, number, number];
      const items: RawItem[] = [];
      for (const it of (await page.getTextContent()).items) {
        if (!('str' in it) || !it.str) continue;
        items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width, h: it.height || Math.abs(it.transform[3] as number) || 10 });
      }
      pages.push({ width, height, items });
    }
    await task.destroy();
    return { ok: true, pages };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, code: name === 'PasswordException' ? 'ENCRYPTED' : 'NOT_A_PDF', detail: `${name}: ${(e as Error).message}`.slice(0, 200) };
  }
}
parentPort!.postMessage(await run());
