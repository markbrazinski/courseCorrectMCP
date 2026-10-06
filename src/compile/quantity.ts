// Policy quantities resolved to literals at bind time (ESOD §5.3). The runtime never computes culinary amounts.
import type { QuantityExpr, Unit } from '../contract/types.ts';
import { absR, cmp, inRange, mul, roundTiesUp, sub, type Rational } from '../domain/rational.ts';

export type QtyResult =
  | { ok: true; value: Rational; unit: Unit }
  | { ok: false; status: 'QUANTITY_UNRESOLVED' | 'NOT_APPLICABLE' | 'NEEDS_BASE'; code: string; detail: string };

/** `base` is the exact base amount (in expr.sourceUnit) or null when the base fact is missing/unconfirmed. */
export function resolveQuantity(id: string, e: QuantityExpr, base: Rational | null): QtyResult {
  if (e.kind === 'LITERAL') return { ok: true, value: e.value, unit: e.unit };
  if (e.kind === 'UNRESOLVED') return { ok: false, status: 'QUANTITY_UNRESOLVED', code: `QUANTITY_UNRESOLVED:${e.unresolvedId}`, detail: e.question };
  if (base === null) return { ok: false, status: 'NEEDS_BASE', code: 'QUANTITY_BASE_UNKNOWN', detail: `${id}: base amount must be EXACT in ${e.sourceUnit} and confirmed` };
  if (!inRange(base, e.inputDomain)) return { ok: false, status: 'NOT_APPLICABLE', code: 'QUANTITY_INPUT_OUT_OF_DOMAIN', detail: `${id}: base outside the reviewed input domain` };
  const raw = mul(base, e.factor);
  const value = roundTiesUp(raw, e.increment);
  if (cmp(absR(sub(value, raw)), e.maxAbsError) > 0) return { ok: false, status: 'NOT_APPLICABLE', code: 'QUANTITY_ROUNDING_ERROR', detail: `${id}: rounding error exceeds the reviewed maximum` };
  if (!inRange(value, e.outputDomain)) return { ok: false, status: 'NOT_APPLICABLE', code: 'QUANTITY_OUTPUT_OUT_OF_DOMAIN', detail: `${id}: result outside the reviewed output domain` };
  return { ok: true, value, unit: e.resultUnit };
}
