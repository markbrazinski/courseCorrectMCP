// Server-mediated speech output (ESOD §8.5): Polly synthesizes only text the service itself rendered; the browser plays
// the bytes. AWS credentials stay server-side. Every uncached call is reserved and settled in the authorization ledger.
// The cache is a folder locally and an S3 prefix when deployed (clips are shared by exact text and settings).
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../domain/rational.ts';
import { BudgetExceeded, NOVA, type SpendLedger } from '../authoring/nova.ts';

/** Polly neural list price, us-east-1 (USD per character; $16 per 1M). Estimate used for reservation and settlement. */
// ponytail: format and sample rate are fixed (mp3, Polly's neural default 24 kHz) and not in the cache key; change the key if they change
export const POLLY = { voiceId: 'Joanna', engine: 'neural', outputFormat: 'mp3', sampleRate: 'default (24000)', usdPerChar: 16 / 1_000_000 } as const;

export type SpeechResult = { ok: true; audio: Uint8Array; cached: boolean; id: string } | { ok: false; error: 'BUDGET_EXCEEDED' | 'CALL_FAILED' | 'TOO_LONG'; detail: string };
/** A clip by id (mp3), with its exact text and settings beside it. */
export interface SpeechCache { get(id: string): Promise<Uint8Array | null>; put(id: string, audio: Uint8Array, record: object): Promise<void> }

export const folderCache = (dir: string): SpeechCache => {
  mkdirSync(dir, { recursive: true });
  return {
    async get(id) { const f = join(dir, `${id}.mp3`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; },
    async put(id, audio, record) { writeFileSync(join(dir, `${id}.mp3`), audio); if (!existsSync(join(dir, `${id}.json`))) writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 1)); },
  };
};
export const s3Cache = (bucket: string, prefix = 'speech/'): SpeechCache => {
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? NOVA.region });
  return {
    async get(id) {
      try { return await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${id}.mp3` }))).Body!.transformToByteArray(); }
      catch (e) { if ((e as Error).name === 'NoSuchKey') return null; throw e; }
    },
    async put(id, audio, record) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${id}.mp3`, Body: audio, ContentType: 'audio/mpeg' }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}${id}.json`, Body: JSON.stringify(record), ContentType: 'application/json' }));
    },
  };
};

export class Speaker {
  private client: PollyClient;
  readonly ledger: SpendLedger; private readonly cache: SpeechCache;
  constructor(ledger: SpendLedger, cache: SpeechCache | string) {
    this.ledger = ledger; this.cache = typeof cache === 'string' ? folderCache(cache) : cache;
    if (process.env.CC_LIVE !== '1') throw new Error('live speech is disabled (set CC_LIVE=1 under a recorded authorization)');
    if (ledger.auth.profile) process.env.AWS_PROFILE = ledger.auth.profile;          // local: only the non-root CourseCorrect profile
    this.client = new PollyClient({ region: NOVA.region, maxAttempts: 1 });   // never retried (the SDK default is 3 attempts)
  }

  private denied: string | null = null;   // ponytail: after an access denial, stop calling (and reserving) until restart
  async synthesize(text: string): Promise<SpeechResult> {
    if (text.length > 1500) return { ok: false, error: 'TOO_LONG', detail: `${text.length} characters` };
    if (this.denied) return { ok: false, error: 'CALL_FAILED', detail: this.denied };
    // the cache key is the text with its synthesis settings, so a cached clip is reused only for exactly that text
    const id = sha256(`${POLLY.voiceId}|${POLLY.engine}|${text}`);
    const record = (requestCharacters: number | null) => ({ id, text, voiceId: POLLY.voiceId, engine: POLLY.engine, outputFormat: POLLY.outputFormat, sampleRate: POLLY.sampleRate, requestCharacters, recordedAt: new Date().toISOString() });
    const hit = await this.cache.get(id);
    if (hit) return { ok: true, audio: hit, cached: true, id };   // no call, no ledger entry
    const key = `tts-${Date.now()}-${sha256(text).slice(0, 8)}`, usd = text.length * POLLY.usdPerChar;
    try { await this.ledger.reserve('speech', key, usd, `polly ${text.length} chars`); }
    catch (e) { return { ok: false, error: 'BUDGET_EXCEEDED', detail: (e as BudgetExceeded).message }; }
    try {
      const out = await this.client.send(new SynthesizeSpeechCommand({ Text: text, OutputFormat: POLLY.outputFormat, VoiceId: POLLY.voiceId, Engine: POLLY.engine }), { abortSignal: AbortSignal.timeout(10_000) });
      const audio = await out.AudioStream!.transformToByteArray();
      const chars = Number(out.RequestCharacters ?? text.length);
      await this.ledger.settleChars('speech', key, chars, chars * POLLY.usdPerChar, `polly ${chars} chars`);
      await this.cache.put(id, audio, record(chars)).catch((e: Error) => console.error(`speech cache: ${e.name}: ${e.message}`.slice(0, 300)));   // the clip still plays
      return { ok: true, audio, cached: false, id };
    } catch (e) {
      await this.ledger.failed('speech', key, 'polly');            // the reservation stays counted in full
      console.error(`polly: ${(e as Error).name}: ${(e as Error).message}`.slice(0, 400));   // full detail stays server-side
      if ((e as Error).name === 'AccessDeniedException') this.denied = 'AccessDeniedException (the CourseCorrect AWS user may not use Polly)';
      return { ok: false, error: 'CALL_FAILED', detail: (e as Error).name };
    }
  }
}
