// M1 deferrals, reconciled at M2 start: unsupported ops and an already-added covered sibling fail closed.
import { describe, expect, it } from 'vitest';
import type { RecoveryPattern } from '../../src/contract/types.ts';
import { evaluate } from '../../src/engine/evaluate.ts';
import { compileSource, fixtureActions, pack, patterns, req, snapshotAfter, source, vocab } from '../helpers.ts';
import { ING, RECIPE, USE } from '../fixtures/ids.ts';

const withOp = (op: RecoveryPattern['ops'][number]): RecoveryPattern => {
  const p = structuredClone(patterns.find((x) => x.patternId === 'split')) as RecoveryPattern;
  p.ops.splice(p.ops.length - 1, 0, op);
  return p;
};

describe('deferred ops fail closed (ESOD §4.1)', () => {
  for (const op of [
    { op: 'INSERT_STEP_BEFORE', before: '$target.step', local: 'x', title: 'X', text: 'X.', techniqueId: 'REST' },
    { op: 'REMOVE_STEP', step: '$finish' },
  ] as RecoveryPattern['ops']) {
    it(`${op.op} → binding NOT_APPLICABLE (UNSUPPORTED_OP); the recipe still compiles; other patterns unaffected`, () => {
      const ps = patterns.map((p) => (p.patternId === 'split' ? withOp(op) : p));
      const p = compileSource(source(RECIPE['risotto.demo']), vocab, ps);
      expect(p.bindings).toEqual([]);
      expect(p.coverage.find((c) => c.patternId === 'split')).toMatchObject({ status: 'NOT_APPLICABLE', failedCheck: { code: `UNSUPPORTED_OP:${op.op}` } });
      // other patterns unaffected: the shortcake binds exactly what it binds without the deferred op (batch 1 added more than the whip rule)
      const ids = (xs: typeof patterns) => compileSource(source(RECIPE['shortcake.demo']), vocab, xs).bindings.map((b) => b.patternId);
      expect(ids(ps)).toEqual(ids(patterns));
      expect(ids(ps)).toContain('whip_needs_cream');
    });
  }
});

describe('already-added covered sibling (deferred variant) fails closed', () => {
  it('scone with the brushing cream reported added → PROTECTED_WORK naming that use; no candidate, no quantities', () => {
    const p = pack(RECIPE['scones.demo']);
    const snap = snapshotAfter(p, fixtureActions('scones.step3'));
    snap.useStatus[USE['sc.cream_brush']] = 'ADDED';   // not reachable through the product path (step order); constructed directly
    const res = evaluate(p, vocab, snap, req(ING['cream'], ['whole-milk', 'unsalted-butter']));
    expect(res.status).toBe('REFUSED');
    expect(res.refusal?.code).toBe('PROTECTED_WORK');
    expect(res.refusal?.protectedFacts).toContainEqual(expect.objectContaining({ kind: 'USE_ADDED', useId: USE['sc.cream_brush'] }));
    expect(res.candidates).toEqual([]);
    expect(res.questions).toEqual([]);
  });
});
