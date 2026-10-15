// Per-request server timing (latency audit 2026-10-11): time spent awaiting the store and model calls, summed per request;
// the rest of a request is this process (auth, engine, serialization). Reported as a Server-Timing header and in the log.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Spent { db: number; dbN: number; model: number; modelN: number }
const als = new AsyncLocalStorage<Spent>();

export async function timed<T>(fn: () => Promise<T>): Promise<{ out: T; spent: Spent }> {
  const spent: Spent = { db: 0, dbN: 0, model: 0, modelN: 0 };
  return { out: await als.run(spent, fn), spent };
}

/** Every async method of `o` counts toward `kind` for the request it runs in. ponytail: overlapping calls are summed, not merged. */
export function meter<T extends object>(o: T, kind: 'db' | 'model'): T {
  return new Proxy(o, {
    get(target, k) {
      const v = Reflect.get(target, k);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const s = als.getStore(), t = performance.now(), r = v.apply(target, a);
        if (!s || !(r instanceof Promise)) return r;
        return r.finally(() => { s[kind] += performance.now() - t; s[`${kind}N`]++; });
      };
    },
  });
}

export function serverTiming(s: Spent, totalMs: number) {
  const ms = (n: number) => n.toFixed(1);
  return [`db;dur=${ms(s.db)};desc="${s.dbN} store calls"`, ...(s.modelN ? [`model;dur=${ms(s.model)};desc="${s.modelN} model calls"`] : []),
    `app;dur=${ms(totalMs - s.db - s.model)};desc="auth, engine, serialization"`, `total;dur=${ms(totalMs)}`].join(', ');
}
