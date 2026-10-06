// Amendment application on a private copy, protected-history proof, function accounting (ESOD §6.4 steps 5–6).
import type { FunctionMapEntry, Id, Op, Recipe, StepStatus, UseStatus } from '../contract/types.ts';
import { canonicalJson } from '../domain/rational.ts';
import { getStep, renderStep } from '../domain/recipe.ts';

export interface Applied { recipe: Recipe; resumeStepId: Id | null }

export function applyOps(before: Recipe, ops: Op[]): Applied {
  const r: Recipe = structuredClone(before);
  let resumeStepId: Id | null = null;
  const retoken = (from: Id, to: Id) => {
    const re = new RegExp(`\\{(use|allowance):${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
    for (const s of r.steps) s.text = s.text.replace(re, (_m, k: string) => `{${k}:${to}}`);
  };
  for (const op of ops) {
    if (resumeStepId !== null) throw new Error('SET_RESUME must be the final op');
    switch (op.op) {
      case 'ADD_INGREDIENT':
        if (r.ingredients.some((i) => i.ingredientId === op.ingredient.ingredientId)) throw new Error(`ingredient ${op.ingredient.ingredientId} exists`);
        r.ingredients.push(structuredClone(op.ingredient)); break;
      case 'REPLACE_USE': {
        const i = r.uses.findIndex((u) => u.useId === op.useId);
        if (i < 0) throw new Error(`REPLACE_USE: no use ${op.useId}`);
        r.uses[i] = structuredClone(op.newUse);
        retoken(op.useId, op.newUse.useId); break;
      }
      case 'ADD_USE':
        if (r.uses.some((u) => u.useId === op.newUse.useId)) throw new Error(`use ${op.newUse.useId} exists`);
        r.uses.push(structuredClone(op.newUse)); break;
      case 'REMOVE_USE': {
        const i = r.uses.findIndex((u) => u.useId === op.useId);
        if (i < 0) throw new Error(`REMOVE_USE: no use ${op.useId}`);
        r.uses.splice(i, 1); break;
      }
      case 'REPLACE_STEP_TEXT': { const s = getStep(r, op.stepId); if (!s) throw new Error(`no step ${op.stepId}`); s.text = op.text; break; }
      case 'SET_STEP_TITLE': { const s = getStep(r, op.stepId); if (!s) throw new Error(`no step ${op.stepId}`); s.title = op.title; break; }
      case 'SET_RESUME': resumeStepId = op.stepId; break;
    }
  }
  return { recipe: r, resumeStepId };
}

/** Steps and uses an op writes or removes. Central history protection reads only this. */
export function touched(before: Recipe, ops: Op[]): { steps: Set<Id>; uses: Set<Id> } {
  const steps = new Set<Id>(), uses = new Set<Id>();
  const stepOfUse = (id: Id) => before.uses.find((u) => u.useId === id)?.stepId;
  for (const op of ops) {
    if (op.op === 'REPLACE_USE' || op.op === 'REMOVE_USE') { uses.add(op.useId); const s = stepOfUse(op.useId); if (s) steps.add(s); }
    if (op.op === 'REPLACE_USE' || op.op === 'ADD_USE') steps.add(op.newUse.stepId);
    if (op.op === 'REPLACE_STEP_TEXT' || op.op === 'SET_STEP_TITLE') steps.add(op.stepId);
  }
  return { steps, uses };
}

/** Every progressed step/use must be byte-identical (and render identically) after the amendment. */
export function historyProof(before: Recipe, after: Recipe, stepStatus: Record<Id, StepStatus>, useStatus: Record<Id, UseStatus>): string | null {
  const progressedSteps = before.steps.filter((s) => (stepStatus[s.stepId] ?? 'NOT_STARTED') !== 'NOT_STARTED');
  for (const s of progressedSteps) {
    const a = getStep(after, s.stepId);
    if (!a || canonicalJson(a) !== canonicalJson(s)) return `progressed step ${s.stepId} changed`;
    if (renderStep(after, a) !== renderStep(before, s)) return `progressed step ${s.stepId} renders differently`;
  }
  const order = (r: Recipe) => r.steps.map((s) => s.stepId).filter((id) => progressedSteps.some((p) => p.stepId === id)).join('|');
  if (order(before) !== order(after)) return 'progressed steps reordered';
  for (const u of before.uses) {
    if ((useStatus[u.useId] ?? 'UNADDED') === 'UNADDED') continue;
    const a = after.uses.find((x) => x.useId === u.useId);
    if (!a || canonicalJson(a) !== canonicalJson(u)) return `progressed use ${u.useId} changed`;
  }
  return null;
}

/** Recompute function accounting from the actual before/after and require it to equal the binding's map. */
export function checkFunctionAccounting(before: Recipe, after: Recipe, map: FunctionMapEntry[]): string | null {
  const afterIds = new Set(after.uses.map((u) => u.useId)), beforeIds = new Set(before.uses.map((u) => u.useId));
  const removed = before.uses.filter((u) => u.kind === 'ADD' && !afterIds.has(u.useId));
  const added = after.uses.filter((u) => !beforeIds.has(u.useId));
  for (const u of removed) for (const f of u.functions) {
    const entries = map.filter((e) => e.fromUseId === u.useId && e.functionId === f.functionId);
    if (entries.length !== 1) return `removed function ${f.functionId} of ${u.useId} has ${entries.length} dispositions`;
    const e = entries[0];
    if (e.disposition !== 'DROPPED_WITH_TRADEOFF') {
      const to = added.find((n) => n.useId === e.toUseId);
      if (!to || !to.functions.some((x) => x.functionId === f.functionId)) return `${f.functionId} of ${u.useId} is not performed by ${e.toUseId}`;
    }
  }
  for (const n of added) for (const f of n.functions) {
    if (!map.some((e) => e.toUseId === n.useId && e.functionId === f.functionId)) return `new function ${f.functionId} of ${n.useId} has no source`;
  }
  for (const e of map) {
    if (e.fromUseId !== null && !removed.some((u) => u.useId === e.fromUseId)) return `disposition names ${e.fromUseId}, which is not removed`;
  }
  return null;
}
