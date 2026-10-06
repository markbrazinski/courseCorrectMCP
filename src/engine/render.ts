// Deterministic text helpers for proposals: word-level change segments (FE TextSegment).
export interface Segment { text: string; kind: 'same' | 'inserted' }

const tokenize = (s: string) => s.split(/(\s+|[,.;:])/).filter((t) => t !== '');

/** Segments of `after`, marking what is not in the LCS with `before` as inserted. */
export function diffSegments(before: string, after: string): Segment[] {
  const a = tokenize(before), b = tokenize(after);
  const L: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const raw: Segment[] = [];
  let i = 0, j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { raw.push({ text: b[j], kind: 'same' }); i++; j++; }
    else if (i < a.length && L[i + 1][j] >= L[i][j + 1]) i++;
    else { raw.push({ text: b[j], kind: 'inserted' }); j++; }
  }
  // whitespace that only separates inserted words belongs to the insertion
  for (let k = 1; k < raw.length - 1; k++) {
    if (raw[k].kind === 'same' && /^\s+$/.test(raw[k].text) && raw[k - 1].kind === 'inserted' && raw[k + 1].kind === 'inserted') raw[k].kind = 'inserted';
  }
  // punctuation or spacing alone is not a change worth marking ("butter and" → "butter," in a joined list)
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].kind === 'inserted' && /^[\s,.;:]+$/.test(raw[k].text) && !(raw[k - 1]?.kind === 'inserted' && raw[k + 1]?.kind === 'inserted')) raw[k].kind = 'same';
  }
  const out: Segment[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text; else out.push({ ...s });
  }
  return out;
}
