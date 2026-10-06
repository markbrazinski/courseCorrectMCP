// Server-mediated speech output (ESOD §8.5): Polly synthesizes only text the service itself rendered; the browser plays
// the bytes. AWS credentials stay server-side. Every uncached call is reserved and settled in the authorization ledger.
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../domain/rational.ts';
import { BudgetExceeded, NOVA, type Ledger } from '../authoring/nova.ts';

/** Polly neural list price, us-east-1 (USD per character; $16 per 1M). Estimate used for reservation and settlement. */
// ponytail: format and sample rate are fixed (mp3, Polly's neural default 24 kHz) and not in the cache key; change the key if they change
export const POLLY = { voiceId: 'Joanna', engine: 'neural', outputFormat: 'mp3', sampleRate: 'default (24000)', usdPerChar: 16 / 1_000_000 } as const;

export type SpeechResult = { ok: true; audio: Uint8Array; cached: boolean; id: string } | { ok: false; error: 'BUDGET_EXCEEDED' | 'CALL_FAILED' | 'TOO_LONG'; detail: string };

export class Speaker {
  private client: PollyClient;
  readonly ledger: Ledger; private readonly cacheDir: string;
  constructor(ledger: Ledger, cacheDir: string) {
    this.ledger = ledger; this.cacheDir = cacheDir;
    if (process.env.CC_LIVE !== '1') throw new Error('live speech is disabled (set CC_LIVE=1 under a recorded authorization)');
    process.env.AWS_PROFILE = ledger.auth.profile;          // only the non-root CourseCorrect profile
    this.client = new PollyClient({ region: NOVA.region });
    mkdirSync(cacheDir, { recursive: true });
  }

  private denied: string | null = null;   // ponytail: after an access denial, stop calling (and reserving) until restart
  async synthesize(text: string): Promise<SpeechResult> {
    if (text.length > 1500) return { ok: false, error: 'TOO_LONG', detail: `${text.length} characters` };
    if (this.denied) return { ok: false, error: 'CALL_FAILED', detail: this.denied };
    // the cache key is the text with its synthesis settings, so a cached clip is reused only for exactly that text
    const id = sha256(`${POLLY.voiceId}|${POLLY.engine}|${text}`), file = join(this.cacheDir, `${id}.mp3`), meta = join(this.cacheDir, `${id}.json`);
    const record = (requestCharacters: number | null) => { if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({ id, text, voiceId: POLLY.voiceId, engine: POLLY.engine, outputFormat: POLLY.outputFormat, sampleRate: POLLY.sampleRate, requestCharacters, recordedAt: new Date().toISOString() }, null, 1)); };
    if (existsSync(file)) { record(null); return { ok: true, audio: readFileSync(file), cached: true, id }; }   // no call, no ledger entry
    const key = `tts-${Date.now()}-${sha256(text).slice(0, 8)}`, usd = text.length * POLLY.usdPerChar;
    try { this.ledger.reserve('speech', key, usd, `polly ${text.length} chars`); }
    catch (e) { return { ok: false, error: 'BUDGET_EXCEEDED', detail: (e as BudgetExceeded).message }; }
    try {
      const out = await this.client.send(new SynthesizeSpeechCommand({ Text: text, OutputFormat: POLLY.outputFormat, VoiceId: POLLY.voiceId, Engine: POLLY.engine }), { abortSignal: AbortSignal.timeout(10_000) });
      const audio = await out.AudioStream!.transformToByteArray();
      const chars = Number(out.RequestCharacters ?? text.length);
      this.ledger.settleChars('speech', key, chars, chars * POLLY.usdPerChar, `polly ${chars} chars`);
      writeFileSync(file, audio);
      record(chars);
      return { ok: true, audio, cached: false, id };
    } catch (e) {
      this.ledger.failed('speech', key, 'polly');            // the reservation stays counted in full
      console.error(`polly: ${(e as Error).name}: ${(e as Error).message}`.slice(0, 400));   // full detail stays server-side
      if ((e as Error).name === 'AccessDeniedException') this.denied = 'AccessDeniedException (the CourseCorrect AWS user may not use Polly)';
      return { ok: false, error: 'CALL_FAILED', detail: (e as Error).name };
    }
  }
}
