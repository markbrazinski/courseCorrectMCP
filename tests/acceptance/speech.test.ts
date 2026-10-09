// Product speech: Polly audio is reused only for the exact text and settings, and an uncached request is reserved in the
// ledger before any call. No paid call: the authorization below allows no speech, so the ledger refuses before Polly.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/authoring/nova.ts';
import { sha256 } from '../../src/domain/rational.ts';
import { POLLY, Speaker } from '../../src/service/speech.ts';

const saved = { live: process.env.CC_LIVE, profile: process.env.AWS_PROFILE };
afterAll(() => { process.env.CC_LIVE = saved.live; process.env.AWS_PROFILE = saved.profile; if (saved.live === undefined) delete process.env.CC_LIVE; if (saved.profile === undefined) delete process.env.AWS_PROFILE; });

describe('Polly cache', () => {
  it('serves cached audio for the exact text only; anything else goes through the ledger, which refuses here', async () => {
    process.env.CC_LIVE = '1';
    const dir = mkdtempSync(join(tmpdir(), 'cc-speech-')), ledgerPath = join(dir, 'ledger.jsonl');
    const speaker = new Speaker(new Ledger(ledgerPath, { id: 'test-no-speech', grantedBy: 'test', at: '', maxCalls: { speech: 0 }, maxUsd: 0, projectCeilingUsd: 0, priorProjectUsd: 0, profile: 'none' }), join(dir, 'cache'));
    const text = 'Change applied. Step 3. Rub 85 g cold butter into the flour.';
    writeFileSync(join(dir, 'cache', `${sha256(`${POLLY.voiceId}|${POLLY.engine}|${text}`)}.mp3`), Buffer.from('mp3-bytes'));
    const hit = await speaker.synthesize(text);
    expect(hit).toMatchObject({ ok: true, cached: true });
    expect(Buffer.from((hit as { audio: Uint8Array }).audio).toString()).toBe('mp3-bytes');
    expect(await speaker.synthesize(`${text} `)).toMatchObject({ ok: false, error: 'BUDGET_EXCEEDED' });   // one character different: not reused
    expect(existsSync(ledgerPath)).toBe(false);                                                             // refused before anything was reserved or called
  });
});
