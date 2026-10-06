// Minimal deterministic PDF writer for tests and probe inputs: Helvetica text lines, or one image with NO text layer.
// ponytail: just enough PDF 1.4 for pdf.js; not a PDF library.
export interface PageSpec { lines?: string[]; image?: { w: number; h: number; data: Uint8Array } }

const WIN_ANSI: Record<string, number> = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 };
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function pdfString(s: string): string {
  let out = '(';
  for (const ch of s) {
    const c = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    if (c > 255) throw new Error(`fixture text outside WinAnsi: ${ch}`);
    out += ch === '(' || ch === ')' || ch === '\\' ? `\\${ch}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : ch;
  }
  return `${out})`;
}

export function makePdf(pages: PageSpec[]): Uint8Array {
  const objs: (Uint8Array | string)[] = [];
  const add = (o: Uint8Array | string) => objs.push(o);
  const stream = (dict: string, body: Uint8Array) => new Uint8Array([...latin1(`<< ${dict} /Length ${body.length} >>\nstream\n`), ...body, ...latin1('\nendstream')]);
  const catalog = add(''), pagesObj = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    let content = '', res = `/Font << /F1 ${font} 0 R >>`;
    (p.lines ?? []).forEach((t, i) => { content += `BT /F1 11 Tf 72 ${720 - i * 16} Td ${pdfString(t)} Tj ET\n`; });
    if (p.image) {
      const img = add(stream(`/Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceGray /BitsPerComponent 8`, p.image.data));
      res += ` /XObject << /Im1 ${img} 0 R >>`;
      content += 'q 612 0 0 792 0 0 cm /Im1 Do Q\n';
    }
    const c = add(stream('', latin1(content)));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << ${res} >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts: Uint8Array[] = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  const offsets: number[] = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const chunk = new Uint8Array([...latin1(`${i + 1} 0 obj\n`), ...(typeof o === 'string' ? latin1(o) : o), ...latin1('\nendobj\n')]);
    parts.push(chunk); len += chunk.length;
  });
  parts.push(latin1(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A deterministic gray "scan" (stripes), so the page has an image and no text layer. */
export const scanImage = (w = 64, h = 64) => ({ w, h, data: Uint8Array.from({ length: w * h }, (_, i) => ((Math.floor(i / w) % 8) < 4 ? 200 : 40)) });
