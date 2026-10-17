// The judge link (deployed): a second access code whose workspaces spend from their own allowance (Authorization.tiers.judge),
// so judges never compete with the regular code's caps; the project ceiling still binds everything. The invitation link
// only fills the code in: nothing signs in on a GET.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KvLedger, LEDGER, spender, tierOf, type Authorization } from '../../src/authoring/nova.ts';
import { Gate, signInPage } from '../../src/service/gate.ts';
import { SqliteKv } from '../../src/service/kv-sqlite.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const store = () => new SqliteKv(join(mkdtempSync(join(tmpdir(), 'cc-judge-')), 't.kv'));   // the LEDGER and GATE partitions are table-wide
const AUTH: Authorization = {
  id: 'review', grantedBy: 'test', at: 'now', maxCalls: { extraction: 1 }, maxUsd: 0.05, projectCeilingUsd: 0.14, priorProjectUsd: 0,
  perWorkspace: { maxCalls: { extraction: 1 }, maxUsd: 0.05 }, maxNewWorkspacesPerDay: 1,
  tiers: { judge: { maxCalls: { extraction: 5 }, maxUsd: 0.1, perWorkspace: { maxCalls: { extraction: 2 }, maxUsd: 0.06 }, maxNewWorkspacesPerDay: 2 } },
};
async function setUp(auth = AUTH) {
  const kv = store();
  await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...auth, v: 1 } }]);
  for (const [ws, tier] of [['ws_regular_0001', null], ['ws_judge_one_01', 'judge'], ['ws_judge_two_01', 'judge'], ['ws_ghost_00001', 'ghost']] as const)
    await kv.write([{ put: { pk: 'GATE', sk: `WS#${ws}`, ws, ...(tier ? { tier } : {}) } }]);
  return { kv, l: new KvLedger(kv) };
}
const spend = (l: KvLedger, ws: string, key: string, usd = 0.03) => spender.run(ws, () => l.reserve('extraction', key, usd, 'test'));

describe('the judge tier: its own allowance, the shared project ceiling', () => {
  it('judge workspaces spend from the judge pool: the regular caps neither block them nor count them', async () => {
    const { l } = await setUp();
    await spend(l, 'ws_regular_0001', 'r1');
    await expect(spend(l, 'ws_regular_0001', 'r2')).rejects.toThrow(/call cap 1 reached/);           // the regular code is used up
    await spend(l, 'ws_judge_one_01', 'j1');                                                          // …and a judge still spends
    await spend(l, 'ws_judge_one_01', 'j2');
    await expect(spend(l, 'ws_judge_one_01', 'j3')).rejects.toThrow(/workspace's extraction allowance \(2\)/);   // the judge per-workspace cap
    await expect(spend(l, 'ws_judge_two_01', 'j4', 0.05)).rejects.toThrow(/exceed \$0.1 authorization/);         // the judge total: 0.06 + 0.05
    await spend(l, 'ws_judge_two_01', 'j5');
    const u = await l.usage();
    expect(u.totals).toMatchObject({ usd: 0.03, calls: { extraction: 1 } });
    expect(u.tiers.judge).toMatchObject({ usd: 0.09, calls: { extraction: 3 } });
    expect(u.projectUsd).toBe(0.12);
  });

  it('the project ceiling binds judges too; a settlement corrects the pool it was reserved in, never another', async () => {
    const { l } = await setUp({ ...AUTH, projectCeilingUsd: 0.07 });
    await spend(l, 'ws_regular_0001', 'r1');
    await spend(l, 'ws_judge_one_01', 'j1');
    await expect(spend(l, 'ws_judge_two_01', 'j2')).rejects.toThrow(/project ceiling/);              // 0.03 + 0.03 + 0.03 > 0.07
    await l.refused('extraction', 'j1', 'ThrottlingException');                                      // settles at $0 in the judge pool
    const u = await l.usage();
    expect(u.tiers.judge).toMatchObject({ usd: 0 });
    expect(u.totals).toMatchObject({ usd: 0.03 });
    await spend(l, 'ws_judge_two_01', 'j3');                                                          // room under the ceiling again
  });

  it('a workspace whose tier has no allowance on record is refused rather than charged to the regular caps', async () => {
    const { l } = await setUp();
    await expect(spend(l, 'ws_ghost_00001', 'g1')).rejects.toThrow(/tier \(ghost\)/);
  });
});

describe('the judge code at the gate', () => {
  it('opens a judge workspace; Start over keeps the tier; judges and the regular code have separate daily limits', async () => {
    const kv = store();
    await kv.write([{ put: { pk: LEDGER, sk: 'AUTH', ...AUTH, v: 1 } }]);
    const gate = new Gate({ kv, ledger: new KvLedger(kv), codeHashes: [hash('cook-regular')], tierCodes: { judge: [hash('judge-link')] }, sessionKey: randomBytes(32), secure: false });
    const j = await gate.signIn(' judge-link ', '10.0.0.1');
    expect(j.ok).toBe(true);
    const ws = (j as { ws: string }).ws;
    expect(await tierOf(kv, ws)).toBe('judge');
    const next = await gate.newWorkspace('reset', ws);
    expect(await tierOf(kv, next)).toBe('judge');                                                      // Start over: still a judge
    expect(await gate.signIn('judge-link', '10.0.0.1')).toMatchObject({ ok: false, status: 503 });   // the judge limit (2 a day) is reached…
    const r = await gate.signIn('cook-regular', '10.0.0.2');                                          // …and the regular code's own limit isn't
    expect(r.ok).toBe(true);
    expect(await tierOf(kv, (r as { ws: string }).ws)).toBeNull();
    expect(await gate.signIn('judge-link-typo', '10.0.0.3')).toMatchObject({ ok: false, status: 401 });
  });

  it('the invitation page fills the code in (escaped) and waits for a press; the plain page asks for the code', () => {
    const invited = signInPage('', 'judge-a"b<c');
    expect(invited).toContain('value="judge-a&quot;b&lt;c"');
    expect(invited).toContain('>Start cooking</button>');
    expect(invited).toContain('<meta name="referrer" content="no-referrer">');
    expect(invited).not.toMatch(/<script/);                                                            // no auto-submit: a GET never signs in
    const plain = signInPage();
    expect(plain).toContain('>Sign in</button>');
    expect(plain).not.toContain('value=');
  });
});
