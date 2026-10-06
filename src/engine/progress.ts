// Reported progress (ESOD §7.3): forward-only, cook-reported, never sensed.
import type { Id, Recipe, StepStatus, UseStatus } from '../contract/types.ts';

export interface ProgressAction {
  stepId: Id; progress: 'started' | 'partly' | 'done';
  addedUseIds?: Id[];     // 'partly': these uses are in
  partialUseIds?: Id[];   // 'partly' (agent-level detail): some of this use is in
}
export type ProgressResult =
  | { ok: true; changed: boolean; stepStatus: Record<Id, StepStatus>; useStatus: Record<Id, UseStatus> }
  | { ok: false; code: 'UNKNOWN_STEP' | 'UNKNOWN_USE' | 'STEP_BLOCKED' | 'REGRESSION' | 'PARTIAL_USE_REQUIRES_ADDED' };

const RANK = { NOT_STARTED: 0, STARTED: 1, COMPLETED: 2, UNADDED: 0, PARTIAL: 1, ADDED: 2 } as const;

export function applyProgress(r: Recipe, stepStatus: Record<Id, StepStatus>, useStatus: Record<Id, UseStatus>, a: ProgressAction): ProgressResult {
  const step = r.steps.find((s) => s.stepId === a.stepId);
  if (!step) return { ok: false, code: 'UNKNOWN_STEP' };
  const ss = { ...stepStatus }, us = { ...useStatus };
  const cur = ss[a.stepId] ?? 'NOT_STARTED';
  if (step.dependsOn.some((d) => ss[d] !== 'COMPLETED')) return { ok: false, code: 'STEP_BLOCKED' };
  const owned = r.uses.filter((u) => u.stepId === a.stepId);
  const setUse = (id: Id, to: UseStatus): boolean | 'REGRESSION' | 'UNKNOWN_USE' => {
    if (!owned.some((u) => u.useId === id)) return 'UNKNOWN_USE';
    const from = us[id] ?? 'UNADDED';
    if (RANK[to] < RANK[from]) return 'REGRESSION';
    us[id] = to;
    return from !== to;
  };
  let changed = false;
  if (a.progress === 'started') {
    if (cur === 'COMPLETED') return { ok: false, code: 'REGRESSION' };
    changed = cur === 'NOT_STARTED';
    ss[a.stepId] = 'STARTED';
  } else if (a.progress === 'partly') {
    if (cur === 'COMPLETED') return { ok: false, code: 'REGRESSION' };
    for (const [ids, to] of [[a.addedUseIds ?? [], 'ADDED'], [a.partialUseIds ?? [], 'PARTIAL']] as const) {
      for (const id of ids) {
        const r2 = setUse(id, to);
        if (r2 === 'REGRESSION' || r2 === 'UNKNOWN_USE') return { ok: false, code: r2 };
        changed ||= r2;
      }
    }
    if (cur === 'NOT_STARTED') { ss[a.stepId] = 'STARTED'; changed = true; }
  } else {
    if (cur === 'COMPLETED') return { ok: true, changed: false, stepStatus: ss, useStatus: us };
    if (owned.some((u) => us[u.useId] === 'PARTIAL')) return { ok: false, code: 'PARTIAL_USE_REQUIRES_ADDED' };
    for (const u of owned) us[u.useId] = 'ADDED';
    ss[a.stepId] = 'COMPLETED';
    changed = true;
  }
  return { ok: true, changed, stepStatus: ss, useStatus: us };
}
