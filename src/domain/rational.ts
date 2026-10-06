// Exact rationals, canonical JSON and SHA-256 content hashes (ESOD §4.1 primitives).
import { createHash } from 'node:crypto';

export interface Rational { n: number; d: number }

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v.normalize('NFC'));
    case 'boolean': return String(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error(`canonical JSON allows safe integers only, got ${v}`);
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
  }
  throw new Error(`canonical JSON cannot encode ${typeof v}`);
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hash = (v: unknown) => sha256(canonicalJson(v));

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const abs = (x: bigint) => (x < 0n ? -x : x);

function make(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('rational denominator is zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(abs(n), d) || 1n;
  const out = { n: Number(n / g), d: Number(d / g) };
  if (!Number.isSafeInteger(out.n) || !Number.isSafeInteger(out.d)) throw new Error('rational exceeds safe integer range');
  return { n: out.n === 0 ? 0 : out.n, d: out.d };
}

export const rat = (n: number, d = 1): Rational => make(BigInt(n), BigInt(d));
export const mul = (a: Rational, b: Rational) => make(BigInt(a.n) * BigInt(b.n), BigInt(a.d) * BigInt(b.d));
export const add = (a: Rational, b: Rational) => make(BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d), BigInt(a.d) * BigInt(b.d));
export const sub = (a: Rational, b: Rational) => add(a, { n: -b.n, d: b.d });
export const cmp = (a: Rational, b: Rational) => {
  const l = BigInt(a.n) * BigInt(b.d), r = BigInt(b.n) * BigInt(a.d);
  return l < r ? -1 : l > r ? 1 : 0;
};
export const absR = (a: Rational) => (a.n < 0 ? { n: -a.n, d: a.d } : a);
export const inRange = (x: Rational, [lo, hi]: [Rational, Rational]) => cmp(x, lo) >= 0 && cmp(x, hi) <= 0;

/** Round to a multiple of `inc`, ties toward +∞ (NEAREST_TIES_UP). */
export function roundTiesUp(x: Rational, inc: Rational): Rational {
  // k = floor(x/inc + 1/2)
  const q = make(BigInt(x.n) * BigInt(inc.d) * 2n + BigInt(x.d) * BigInt(inc.n), BigInt(x.d) * BigInt(inc.n) * 2n);
  let k = BigInt(q.n) / BigInt(q.d);
  if (q.n < 0 && BigInt(q.n) % BigInt(q.d) !== 0n) k -= 1n;
  return make(k * BigInt(inc.n), BigInt(inc.d));
}

/** Parse "120", "1/2", "1.5" into an exact rational. */
export function parseRational(s: string): Rational {
  const t = s.trim();
  if (/^-?\d+\/\d+$/.test(t)) { const [n, d] = t.split('/'); return make(BigInt(n), BigInt(d)); }
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error(`not a rational: ${s}`);
  const frac = m[2] ?? '';
  return make(BigInt(m[1] + frac), 10n ** BigInt(frac.length));
}

/** Decimal display without trailing zeros; non-terminating values are shown to 2 places (display only). */
export function formatRational(r: Rational): string {
  if (r.d === 1) return String(r.n);
  const v = r.n / r.d;
  return String(Math.round(v * 100) / 100);
}
