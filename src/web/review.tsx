// Import review (HF "Import Review" v1, on FE–BE Contract v1 Amendment 1): the ingredient × step matrix, a step's detail and
// one use's detail. Every status, amount, plan, instruction and reason is rendered from the server's per-use `analysis`;
// the client only lays it out (no culinary arithmetic, no composed instructions, no inferred statuses).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { RecipeContent, SourceLine } from './api.ts';

type Ing = RecipeContent['ingredients'][number];
type Use = Ing['uses'][number];
type Analysis = NonNullable<Use['analysis']>;
type Plan = Analysis['plans'][number];
// display statuses derived from the server's: 'omission' (available, and what's offered is leaving the ingredient out);
// 'draftRefused' (the swap drafted at import was answered "no" by a reviewed rule: one swap, not "no alternative")
type Status = Analysis['status'] | 'omission' | 'draftRefused';
export interface SourceRef { sourceId: string; lineId: string }
type Sel = { kind: 'use'; useId: string } | { kind: 'step'; stepId: string } | null;

export const STATUS: Record<Status, { g: string; label: string }> = {
  available: { g: '●', label: 'Alternative available' }, omission: { g: '◐', label: 'Omission available' }, evaluatedNoOption: { g: '○', label: 'No alternative found' },
  draftRefused: { g: '⊘', label: 'Drafted swap not offered' },
  pending: { g: '…', label: 'Checking' }, failed: { g: '!', label: 'Check failed' },
  blocked: { g: '×', label: 'Can’t check yet' }, unexamined: { g: '·', label: 'Not checked yet' },
};
const ORDER: Status[] = ['available', 'omission', 'evaluatedNoOption', 'draftRefused', 'pending', 'failed', 'blocked', 'unexamined'];
const statusOf = (u: Use): Status => (u.analysis?.status === 'available' && u.analysis.offer === 'omission' ? 'omission'
  : u.analysis?.status === 'evaluatedNoOption' && u.analysis.reason?.code === 'contradictsReviewedRule' ? 'draftRefused' : u.analysis?.status ?? 'unexamined');
const AI_REASONS = new Set(['aiSaysNo', 'otherUseCantBeCovered']);

/** Per-status counts, in the legend's order (the results header and the reading's last stage). */
export function statusCounts(c: RecipeContent) {
  const all = c.ingredients.flatMap((i) => i.uses.map(statusOf));
  return ORDER.map((s) => ({ s, n: all.filter((x) => x === s).length, ...STATUS[s] })).filter((x) => x.n > 0);
}

const eyebrow = { fontSize: 12, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--cc-text-2)', fontWeight: 700 } as const;
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');

export function Review({ content: c, sourceLines, sourceName, sourceRefs, wide, banner, footer }: {
  content: RecipeContent; sourceLines: SourceLine[]; sourceName: string | null; sourceRefs: Record<string, SourceRef | null>;
  wide: boolean; banner?: ReactNode; footer?: ReactNode;
}) {
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState<'matrix' | 'detail'>('matrix');
  const [alt, setAlt] = useState(0);
  const [provOpen, setProvOpen] = useState(false);
  const [src, setSrc] = useState<HTMLElement | null>(null);   // the opener, while the source popover is open
  const full = useRef<HTMLDivElement>(null), compact = useRef<HTMLDivElement>(null), back = useRef<HTMLButtonElement>(null), detail = useRef<HTMLElement>(null);
  const scroll = useRef({ full: [0, 0], compact: [0, 0] });
  const focusAfter = useRef<string | null>(null);   // data-key to focus once the next view has rendered

  const steps = c.steps, ord = (stepId: string) => steps.find((s) => s.id === stepId)?.ordinal ?? 0;
  const uses = c.ingredients.flatMap((g) => g.uses.map((u) => ({ g, u })));
  const selUse = sel?.kind === 'use' ? uses.find((x) => x.u.id === sel.useId) ?? null : null;
  const selStep = sel?.kind === 'step' ? steps.find((s) => s.id === sel.stepId) ?? null : sel?.kind === 'use' && selUse ? steps.find((s) => s.id === selUse.u.stepId) ?? null : null;
  const plans = selUse?.u.analysis?.plans ?? [];
  const plan: Plan | null = plans[Math.min(alt, plans.length - 1)] ?? null;
  const changes = new Set(plan?.stepEffects.filter((e) => e.effect === 'changes').map((e) => e.stepId) ?? []);
  const keeps = new Set(plan?.stepEffects.filter((e) => e.effect === 'staysReserved').map((e) => e.stepId) ?? []);
  const affected = new Set((plan?.affectedUseIds ?? []).filter((id) => id !== selUse?.u.id));
  const compactOn = view === 'detail' && wide && !!sel;

  // matrix scroll positions survive the trip to a detail and back; focus follows the activated control (no jump)
  useLayoutEffect(() => {
    const el = view === 'matrix' ? full.current : compact.current, at = view === 'matrix' ? scroll.current.full : scroll.current.compact;
    if (el) { el.scrollTop = at[0]; el.scrollLeft = at[1]; }
    if (view === 'detail' && detail.current) detail.current.scrollTop = 0;   // another use or step opens at its top
    const k = focusAfter.current;
    focusAfter.current = null;
    if (k === 'back') back.current?.focus();
    else if (k) (view === 'matrix' ? full.current : compact.current)?.querySelector<HTMLElement>(`[data-key="${k}"]`)?.focus();
  }, [view, sel]);
  const keep = (which: 'full' | 'compact') => (e: UIEvent<HTMLDivElement>) => { scroll.current[which] = [e.currentTarget.scrollTop, e.currentTarget.scrollLeft]; };
  const open = (s: NonNullable<Sel>) => {
    const key = s.kind === 'use' ? `u:${s.useId}` : `s:${s.stepId}`;
    focusAfter.current = wide ? key : 'back';
    setSel(s); setView('detail'); setAlt(0); setProvOpen(false); setSrc(null);
  };
  const toMatrix = () => { focusAfter.current = sel ? (sel.kind === 'use' ? `u:${sel.useId}` : `s:${sel.stepId}`) : null; setView('matrix'); setSrc(null); };
  useEffect(() => { if (!src) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSrc(); }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); });
  const closeSrc = () => { const o = src; setSrc(null); o?.focus(); };
  const counts = statusCounts(c);

  const matrix = (small: boolean) => {
    const cols = `${small ? 'minmax(150px,1.6fr)' : wide ? 'minmax(220px,1.4fr)' : 'minmax(150px,1.3fr)'} repeat(${steps.length}, minmax(${small ? 40 : 84}px,1fr))`;
    return <div role="region" aria-label={small ? 'Recipe matrix (compact)' : 'Recipe matrix'} style={{ minWidth: small ? 150 + steps.length * 40 : (wide ? 220 : 150) + steps.length * 84 }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, position: 'sticky', top: 0, background: 'var(--cc-surface)', borderBottom: '1px solid var(--cc-border-strong)', zIndex: 1 }}>
        <span style={{ ...eyebrow, padding: '9px 14px' }}>Ingredient · listed total</span>
        {steps.map((s) => {
          const on = selStep?.id === s.id, ch = !on && changes.has(s.id), kp = !on && keeps.has(s.id);
          return <button key={s.id} data-key={`s:${s.id}`} aria-pressed={sel?.kind === 'step' && sel.stepId === s.id} aria-label={`Step ${s.ordinal}, ${s.title}${ch ? ', would change' : kp ? ', stays reserved' : ''}`} onClick={() => open({ kind: 'step', stepId: s.id })}
            style={{ border: 'none', borderLeft: '1px solid var(--cc-border)', background: 'var(--cc-surface)', padding: '7px 4px', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', textAlign: 'center', lineHeight: 1.2,
              boxShadow: on ? 'inset 0 -4px 0 var(--cc-current)' : ch ? 'inset 0 -4px 0 var(--cc-proposed)' : kp ? 'inset 0 -4px 0 var(--cc-border-strong)' : undefined }}>
            <strong style={{ fontSize: 14, color: on ? 'var(--cc-current)' : undefined }}>{small ? s.ordinal : `Step ${s.ordinal}`}</strong>
            {!small && <span style={{ fontSize: 13 }}>{s.title}</span>}
            {!small && ch && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--cc-proposed)' }}>WOULD CHANGE</span>}
            {!small && kp && <span style={{ fontSize: 11, fontWeight: 700 }}>STAYS RESERVED</span>}
          </button>;
        })}
      </div>
      {c.ingredients.map((g) => <div key={g.id} style={{ display: 'grid', gridTemplateColumns: cols, borderBottom: '1px solid var(--cc-border)' }}>
        <span style={{ padding: '7px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, lineHeight: 1.25 }}>
          <span style={{ fontSize: wide && !small ? 16 : 14, fontWeight: 600 }}>{g.name}{g.group && <span style={{ fontWeight: 400, color: 'var(--cc-text-2)' }}> · {g.group.replace(/:\s*$/, '')}</span>}</span><span style={{ fontSize: 14, color: 'var(--cc-text-2)' }}>{g.totalAmount.display ?? ''}</span>
        </span>
        {steps.map((s) => {
          const u = g.uses.find((x) => x.stepId === s.id);
          if (!u) return <span key={s.id} style={{ borderLeft: '1px solid var(--cc-border)', minHeight: wide ? 58 : 50 }} />;
          const st = statusOf(u), on = selUse?.u.id === u.id, aff = !on && affected.has(u.id);
          return <span key={s.id} style={{ borderLeft: '1px solid var(--cc-border)', padding: 4, display: 'flex', minHeight: wide ? 58 : 50 }}>
            <button data-key={`u:${u.id}`} data-testid="matrix-cell" aria-pressed={on} aria-label={`${g.name}, step ${s.ordinal}: ${STATUS[st].label}${small ? '' : `, ${u.amount.display ?? 'amount not stated'}`}`} onClick={() => open({ kind: 'use', useId: u.id })}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 7, padding: 4, lineHeight: 1.2,
                border: on ? '2px solid var(--cc-current)' : aff ? '2px dashed var(--cc-proposed)' : '1px solid var(--cc-border-strong)',
                background: on ? 'var(--cc-current)' : aff ? 'var(--cc-surface)' : 'var(--cc-surface-2)', color: on ? 'var(--cc-on-current)' : 'var(--cc-text)' }}>
              {!small && <span style={{ fontSize: 15, fontWeight: on || aff ? 700 : 400, overflowWrap: 'anywhere', textAlign: 'center' }}>{u.amount.display ?? 'not stated'}</span>}
              <span aria-hidden style={{ fontSize: 15, fontWeight: 700, color: on ? undefined : aff ? 'var(--cc-proposed)' : st === 'available' || st === 'omission' ? 'var(--cc-current)' : 'var(--cc-text-2)' }}>{STATUS[st].g}</span>
            </button>
          </span>;
        })}
      </div>)}
      <div style={{ padding: '10px 14px', display: 'flex', gap: '6px 18px', flexWrap: 'wrap', fontSize: 14, color: 'var(--cc-text-2)' }}>
        {ORDER.map((s) => <span key={s} style={{ whiteSpace: 'nowrap' }}>{STATUS[s].g} {STATUS[s].label}</span>)}
        <span style={{ whiteSpace: 'nowrap' }}><span style={{ display: 'inline-block', width: 16, height: 11, border: '2px dashed var(--cc-proposed)', borderRadius: 3, verticalAlign: -1 }} /> affected by the selected alternative</span>
      </div>
    </div>;
  };

  const hl = new Set([sel?.kind === 'use' ? sourceRefs[sel.useId] : null, selStep ? sourceRefs[selStep.id] : null, selUse ? sourceRefs[selUse.g.id] : null]
    .filter((x): x is SourceRef => !!x).map((x) => `${x.sourceId}|${x.lineId}`));
  const viewSource = sourceLines.length > 0 ? (label = 'View source') => <button className="link" style={{ alignSelf: 'flex-start' }} aria-expanded={!!src} onClick={(e) => setSrc(src ? null : e.currentTarget)}>{label}</button> : () => null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', padding: '12px 22px', borderBottom: '1px solid var(--cc-border)', background: 'var(--cc-surface)', display: 'flex', gap: '10px 28px', alignItems: 'center', flexWrap: 'wrap', position: 'relative' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 360px', minWidth: 0 }}>
          {sourceName && <span className="eyebrow" style={{ fontSize: 12 }}>How {sourceName} was read</span>}
          <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 28, fontWeight: 700, lineHeight: 1.15 }}>{c.title}</span>
          <span style={{ fontSize: 15, color: 'var(--cc-text-2)' }}>{[c.meta, `${c.ingredients.length} ingredients · ${steps.length} steps · ${uses.length} uses`, sourceName ? `from ${sourceName}` : null].filter(Boolean).join(' · ')}{sourceLines.length > 0 && <> · {viewSource()}</>}</span>
        </div>
        <div aria-label="Alternatives, per use" data-testid="analysis-summary" style={{ display: 'flex', gap: '6px 18px', flexWrap: 'wrap', alignItems: 'baseline' }}>
          {counts.map((x) => <span key={x.s} style={{ fontSize: 16, whiteSpace: 'nowrap' }}><strong>{x.g} {x.n}</strong> {x.label}</span>)}
        </div>
        {banner}
        {src && <div role="dialog" aria-label="Source" style={{ position: 'absolute', right: 22, top: 'calc(100% + 6px)', width: 460, maxWidth: 'calc(100% - 44px)', maxHeight: 400, overflow: 'auto', zIndex: 5, background: 'var(--cc-surface)', border: '2px solid var(--cc-text)', borderRadius: 12, boxShadow: '0 12px 30px rgba(42,33,27,.2)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}><span style={eyebrow}>Source · {sourceName}</span><button className="link" onClick={closeSrc}>Close</button></div>
          {sourceLines.map((l) => { const on = hl.has(`${l.sourceDocId}|${l.lineId}`); return <span key={l.sourceDocId + l.lineId} data-highlighted={on || undefined} style={{ fontSize: 15, lineHeight: 1.4, padding: '3px 6px', borderRadius: 4, color: on ? undefined : 'var(--cc-text-2)', boxShadow: on ? 'inset 0 0 0 2px var(--cc-current)' : undefined, fontWeight: on ? 600 : 400 }}>{l.origin === 'COOK_PASTED' ? '+ ' : ''}{l.text}</span>; })}
        </div>}
      </div>

      {view === 'matrix' || !sel ? <>
        <div ref={full} onScroll={keep('full')} className="scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--cc-surface)' }}>{matrix(false)}</div>
        {sel && <div style={{ flex: 'none', display: 'flex', gap: 12, alignItems: 'center', padding: '8px 22px', borderTop: '1px solid var(--cc-border)', background: 'var(--cc-surface-2)' }}>
          <span style={{ fontSize: 16 }}>Selected: <strong>{selUse ? `${selUse.g.name} · step ${ord(selUse.u.stepId)}` : selStep ? `Step ${selStep.ordinal} · ${selStep.title}` : ''}</strong></span>
          <button className="b sm" onClick={() => open(sel)}>Open detail</button>
          <button className="link" style={{ fontSize: 14 }} onClick={() => setSel(null)}>Clear</button>
        </div>}
      </> : <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {compactOn && <div ref={compact} onScroll={keep('compact')} style={{ flex: '0 0 36%', minWidth: 0, overflow: 'auto', borderRight: '1px solid var(--cc-border-strong)', background: 'var(--cc-surface)' }}>{matrix(true)}</div>}
        <section ref={detail} aria-label="Detail" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '14px 26px 22px', background: 'var(--cc-page)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button ref={back} className="b sm" style={{ alignSelf: 'flex-start' }} onClick={toMatrix}>← Recipe matrix</button>
          {selUse ? <UseDetail c={c} g={selUse.g} u={selUse.u} plan={plan} plans={plans} alt={alt} setAlt={(i) => { setAlt(i); setProvOpen(false); }} provOpen={provOpen} setProvOpen={setProvOpen}
            affected={affected} ord={ord} onUse={(id) => open({ kind: 'use', useId: id })} viewSource={viewSource} />
            : selStep && <StepDetail c={c} step={selStep} ord={ord} onUse={(id) => open({ kind: 'use', useId: id })} viewSource={viewSource} />}
        </section>
      </div>}
      {footer}
    </div>
  );
}

function Amount({ a }: { a: { display: string | null } }) { return <>{a.display ?? 'amount not stated'}</>; }

function UseDetail({ c, g, u, plan, plans, alt, setAlt, provOpen, setProvOpen, affected, ord, onUse, viewSource }: {
  c: RecipeContent; g: Ing; u: Use; plan: Plan | null; plans: Plan[]; alt: number; setAlt: (i: number) => void; provOpen: boolean; setProvOpen: (v: boolean) => void;
  affected: Set<string>; ord: (stepId: string) => number; onUse: (useId: string) => void; viewSource: (label?: string) => ReactNode;
}) {
  const a = u.analysis, st = statusOf(u), step = c.steps.find((s) => s.id === u.stepId)!;
  const ingOf = (useId: string) => c.ingredients.find((i) => i.uses.some((x) => x.id === useId));
  const useOf = (useId: string) => c.ingredients.flatMap((i) => i.uses).find((x) => x.id === useId);
  const roles = u.reviewedFunction?.labels ?? [];
  const guess = !roles.length && u.proposedFunction ? u.proposedFunction.labels : [];
  const others = g.uses.filter((x) => x.id !== u.id);
  const changed = plan ? plan.stepEffects.filter((e) => e.effect === 'changes').map((e) => `step ${ord(e.stepId)}`) : [];
  const kept = plan ? plan.stepEffects.filter((e) => e.effect === 'staysReserved').map((e) => `step ${ord(e.stepId)}`) : [];
  const reason = a?.reason;
  const details = reason?.detail ? <details style={{ fontSize: 14 }}><summary style={{ cursor: 'pointer' }}>Technical details</summary><span style={{ display: 'block', marginTop: 6, color: 'var(--cc-text-2)', overflowWrap: 'anywhere' }}>{reason.code} · {reason.detail}</span></details> : null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={eyebrow}>Step {step.ordinal} · {step.title}</span>
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 32, lineHeight: 1.1 }}>{g.name}</h2>
        <span style={{ fontSize: 18 }}>Used here: <strong data-testid="used-here"><Amount a={u.amount} /></strong><span style={{ color: 'var(--cc-text-2)' }}> · listed total {g.totalAmount.display ?? 'not stated'}</span></span>
      </div>
      {(roles.length > 0 || guess.length > 0) && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 15, color: 'var(--cc-text-2)' }}>What it does here</span>
        {(roles.length ? roles : guess).map((t) => <span key={t} style={{ fontSize: 16, fontWeight: 700, border: '1.5px solid var(--cc-border-strong)', borderRadius: 14, padding: '2px 11px', background: 'var(--cc-surface)' }}>{t}</span>)}
        <span className="muted" style={{ fontSize: 14 }}>{!roles.length ? 'as read at import · not reviewed' : u.reviewedFunction!.authority === 'OWNER_REVIEWED' ? 'reviewed' : 'machine-checked against the approved role table'}</span>
      </div>}
      {others.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 15, color: 'var(--cc-text-2)' }}>Also used in</span>
        {others.map((x) => { const aff = affected.has(x.id); return <button key={x.id} className="b sm" onClick={() => onUse(x.id)} style={{ padding: '4px 10px', fontSize: 14, border: aff ? '2px dashed var(--cc-proposed)' : undefined }}>
          {STATUS[statusOf(x)].g} Step {ord(x.stepId)} · <Amount a={x.amount} />{aff ? ' · also changes' : ''}</button>; })}
      </div>}
    </div>

    {(st === 'available' || st === 'omission') && plan && <>
      <div data-testid="answer-card" style={{ background: 'var(--cc-surface)', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, border: '2px solid var(--cc-current)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15, color: 'var(--cc-current)' }}>{plan.kind === 'omission' ? '◐ Omission available: leave it out' : '● Alternative available'}</strong>
          <span style={{ fontSize: 13, fontWeight: 700, border: '1.5px solid var(--cc-border-strong)', borderRadius: 4, padding: '2px 8px' }}>Preview · your recipe hasn’t changed</span>
          <span data-testid="swap-label" style={{ fontSize: 13, fontWeight: 700, color: plan.provenance.kind === 'aiPrepared' ? 'var(--cc-proposed)' : undefined }}>{plan.provenance.label}</span>
        </div>
        {plans.length > 1 && <div role="tablist" aria-label="Alternatives" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {plans.map((p, i) => <button key={p.planId} role="tab" aria-selected={i === alt} className={`b sm${i === alt ? ' strong' : ''}`} onClick={() => setAlt(i)}>Option {i + 1}</button>)}
          <span className="muted" style={{ fontSize: 14, alignSelf: 'center' }}>Choose which one to preview</span>
        </div>}
        <span data-testid="swap" style={{ fontSize: 18, fontWeight: 700 }}>{plan.title}</span>
        {a?.coveredByUseId && <span style={{ fontSize: 15 }}>This use is changed by the plan for step {ord(useOf(a.coveredByUseId)?.stepId ?? '')}.</span>}
        {plan.replacements.length > 0 && <span style={eyebrow}>Instead, use</span>}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {[...plan.replacements].sort((x, y) => ord(x.stepId) - ord(y.stepId)).map((r) => <div key={r.useId} data-testid="replacement" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.7fr) auto', gap: '4px 14px', alignItems: 'baseline', padding: '8px 0', borderBottom: '1px solid var(--cc-border)' }}>
            <strong style={{ fontSize: 22, lineHeight: 1.2 }}>{r.ingredientName}</strong>
            <strong style={{ fontSize: 22 }}><Amount a={r.amount} /></strong>
            <span style={{ fontSize: 15, color: 'var(--cc-text-2)', whiteSpace: 'nowrap' }}>Step {ord(r.stepId)}</span>
            {r.preparation && <span style={{ gridColumn: '1 / -1', fontSize: 15 }}>Prep: {r.preparation}</span>}
            {r.condition && <span style={{ gridColumn: '1 / -1', fontSize: 15 }}>Only if needed: {r.condition}</span>}
          </div>)}
          {plan.removals.map((m) => <span key={m.useId} style={{ fontSize: 16, padding: '7px 0 0', color: 'var(--cc-text-2)' }}>Not needed: {ingOf(m.useId)?.name ?? ''} · step {ord(useOf(m.useId)?.stepId ?? '')} · <Amount a={m.before} /></span>)}
          {plan.reservations.map((k) => <span key={k.useId} style={{ fontSize: 16, padding: '7px 0 0' }}><strong>Stays reserved:</strong> {k.note}</span>)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '2px solid var(--cc-text)', paddingTop: 10 }}>
          <span style={eyebrow}>What’s different</span>
          <span data-testid="import-consequence" style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.3 }}>{plan.consequence.text}</span>
          {plan.opinion && <span style={{ fontSize: 16 }}><span className="muted">The import analysis (AI) says:</span> <span data-testid="swap-opinion">“{plan.opinion}”</span></span>}
        </div>
        <span style={{ fontSize: 15 }}>{changed.length ? `Changes ${and(changed)}` : 'Changes no other step'}{kept.length ? ` · ${and(kept)} ${kept.length > 1 ? 'stay' : 'stays'} reserved` : ''}. Details below.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ ...eyebrow, color: 'var(--cc-text)' }}>Instruction changes</span>
        {plan.stepEffects.map((e) => { const s = c.steps.find((x) => x.id === e.stepId); return <div key={e.stepId} data-testid={`would-read-${s?.ordinal}`} style={{ background: 'var(--cc-surface)', border: '1.5px solid var(--cc-border-strong)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>Step {s?.ordinal} · {e.titleAfter ?? s?.title} · {e.effect === 'changes' ? 'Would change' : 'Stays reserved'}</span>
          {e.effect === 'changes' ? <>
            <span style={{ fontSize: 15, color: 'var(--cc-text-2)', lineHeight: 1.4 }}><strong>Now:</strong> {e.before}</span>
            <span style={{ fontSize: 20, lineHeight: 1.35 }}><strong style={{ fontSize: 15 }}>Would read: </strong><span data-testid="after">{(e.after ?? []).map((x, i) => x.kind === 'inserted' ? <mark key={i} className="ins">{x.text}</mark> : <span key={i}>{x.text}</span>)}</span></span>
          </> : <><span style={{ fontSize: 16, color: 'var(--cc-text-2)', lineHeight: 1.4 }}>{e.before}</span><strong style={{ fontSize: 18 }}>{e.note}</strong></>}
        </div>; })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ ...eyebrow, color: 'var(--cc-text)' }}>When you use it while cooking</span>
        <span style={{ fontSize: 16, lineHeight: 1.4 }}>Nothing is applied now. If you ask for this while cooking, CourseCorrect first checks the steps you’ve marked and asks whether you have:</span>
        {plan.runtimeConditions.filter((x) => x.kind === 'availability').map((x) => <span key={x.text} style={{ fontSize: 17 }}>• {x.text}</span>)}
        {plan.runtimeConditions.filter((x) => x.kind === 'progress').map((x) => <span key={x.text} className="muted" style={{ fontSize: 15 }}>{x.text}.</span>)}
        <span className="muted" style={{ fontSize: 15 }}>The change is applied only when you choose “Use this change”.</span>
      </div>
      <button className="link" aria-expanded={provOpen} onClick={() => setProvOpen(!provOpen)} style={{ alignSelf: 'flex-start' }}>Plan details</button>
      {provOpen && <dl data-testid="plan-details" style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: '6px 12px', fontSize: 14, border: '1px solid var(--cc-border)', borderRadius: 10, padding: '10px 12px', background: 'var(--cc-surface)' }}>
        <dt className="muted">Plan</dt><dd style={{ overflowWrap: 'anywhere' }}>{plan.planId}{plan.ruleId ? ` · rule ${plan.ruleId}` : ''}</dd>
        <dt className="muted">Source of this plan</dt><dd>{plan.provenance.kind === 'reviewedRule' ? 'Reviewed rule' : 'Prepared at import by AI, checked by code'}<ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{plan.provenance.basis.map((b) => <li key={b}>{b}</li>)}</ul></dd>
        <dt className="muted">Content status</dt><dd>{plan.contentStatus.label}</dd>
        <dt className="muted">Checked against</dt><dd>The recipe as read. Your ingredients and progress are checked when you ask while cooking.</dd>
      </dl>}
    </>}

    {st === 'evaluatedNoOption' && <div data-testid="answer-card" style={{ borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, border: '2px solid var(--cc-border-strong)', background: 'var(--cc-refusal-bg)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><strong style={{ fontSize: 15 }}>○ No alternative found</strong>
        {reason && AI_REASONS.has(reason.code) && <span data-testid="swap-label" style={{ fontSize: 13, fontWeight: 700, color: 'var(--cc-proposed)' }}>Prepared at import (AI) · not reviewed</span>}</div>
      <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>This use was checked. No alternative could be supported.</span>
      <span data-testid="swap" style={{ fontSize: 18, lineHeight: 1.4 }}>{reason?.text}</span>
      <span style={{ fontSize: 16, lineHeight: 1.45, color: 'var(--cc-text-2)' }}>That isn’t a claim that nothing could work. CourseCorrect only offers changes it can back with amounts and instructions. If you run out while cooking, it will say so and keep step {step.ordinal} as written.</span>
      {details}
    </div>}
    {st === 'draftRefused' && <div data-testid="answer-card" style={{ borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, border: '2px solid var(--cc-border-strong)', background: 'var(--cc-refusal-bg)' }}>
      <strong style={{ fontSize: 15 }}>⊘ Drafted swap not offered</strong>
      <span data-testid="swap" style={{ fontSize: 18, lineHeight: 1.4 }}>{reason?.text}</span>
      <span style={{ fontSize: 16, lineHeight: 1.45, color: 'var(--cc-text-2)' }}>That’s an answer about that one swap. It isn’t a finding that nothing else could work. If you run out while cooking, CourseCorrect will say so and keep step {step.ordinal} as written.</span>
      {details}
    </div>}
    {st === 'blocked' && <div data-testid="answer-card" className="attention" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 14, padding: '18px 20px' }}>
      <strong style={{ fontSize: 21 }}>× Can’t check yet</strong><span data-testid="swap" style={{ fontSize: 17, lineHeight: 1.4 }}>{reason?.text}</span>{details}</div>}
    {st === 'pending' && <div role="status" data-testid="answer-card" style={{ background: 'var(--cc-surface)', borderRadius: 14, padding: '18px 20px', display: 'flex', gap: 12, alignItems: 'center', border: '1.5px dashed var(--cc-processing)' }}>
      <span className="dots"><i /><i /><i /></span><strong data-testid="swap" style={{ fontSize: 20 }}>Checking this use for alternatives…</strong></div>}
    {st === 'failed' && <div role="alert" data-testid="answer-card" className="attention" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 14, padding: '18px 20px' }}>
      <strong style={{ fontSize: 21 }}>! Check failed</strong><span data-testid="swap" style={{ fontSize: 17, lineHeight: 1.4 }}>{reason?.text}</span>
      <span className="muted" style={{ fontSize: 15 }}>CourseCorrect doesn’t guess an alternative instead. When the check didn’t finish, “Check them again” at the top runs it again for these uses.</span>{details}</div>}
    {st === 'unexamined' && <div data-testid="answer-card" style={{ background: 'var(--cc-surface)', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10, border: '1.5px dashed var(--cc-border-strong)' }}>
      <strong style={{ fontSize: 21 }}>Not checked yet</strong><span data-testid="swap" style={{ fontSize: 17, lineHeight: 1.4 }}>{reason?.text ?? 'This use hasn’t been checked for alternatives.'}</span>{details}</div>}

    {/* a refused draft already quotes its rule above: list only the others */}
    {a && a.ruledOut.filter((r) => !(st === 'draftRefused' && reason?.text.includes(r.text))).length > 0 && <div data-testid="ruled-out" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--cc-border)', paddingTop: 12 }}>
      <span style={eyebrow}>{st === 'draftRefused' ? 'Also not offered here' : 'Not offered here'} · reviewed rules, one swap each</span>
      {a.ruledOut.filter((r) => !(st === 'draftRefused' && reason?.text.includes(r.text))).map((r) => <div key={r.ruleId} data-testid="ruled-out-item" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <strong style={{ fontSize: 16 }}>⊘ {r.omission ? 'Leaving it out' : r.title}</strong>
        <span style={{ fontSize: 15, lineHeight: 1.4 }}>{r.text}</span>
        <span className="muted" style={{ fontSize: 14, lineHeight: 1.4 }}>{r.scopeNote}</span>
      </div>)}
    </div>}

    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--cc-border)', paddingTop: 12 }}>
      <span style={eyebrow}>How it’s used here · step {step.ordinal}</span>
      <span style={{ fontSize: 18, lineHeight: 1.4 }}>{step.text}</span>
      {viewSource()}
    </div>
  </div>;
}

function StepDetail({ c, step, ord, onUse, viewSource }: { c: RecipeContent; step: RecipeContent['steps'][number]; ord: (stepId: string) => number; onUse: (useId: string) => void; viewSource: (label?: string) => ReactNode }) {
  const here = c.ingredients.flatMap((g) => g.uses.filter((u) => u.stepId === step.id).map((u) => ({ g, u })));
  const elsewhere = c.ingredients.flatMap((g) => g.uses.filter((u) => u.stepId !== step.id && !u.analysis?.coveredByUseId).flatMap((u) =>
    (u.analysis?.plans ?? []).filter((p) => p.stepEffects.some((e) => e.stepId === step.id)).map((p) => ({ g, u, p }))));
  const line = (u: Use) => {
    const a = u.analysis;
    if (!a) return '';
    if (a.status === 'available') return a.plans.map((p) => p.title).join(' · ');
    if (a.status === 'pending') return 'Still being checked.';
    return a.reason?.text ?? '';
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <span style={eyebrow}>Step {step.ordinal}</span>
    <h2 style={{ fontSize: 32, lineHeight: 1.1 }}>{step.title}</h2>
    <p data-testid="step-text" style={{ margin: 0, fontSize: 26, lineHeight: 1.35 }}>{step.text}</p>
    {viewSource()}
    {here.length ? <><span style={{ ...eyebrow, color: 'var(--cc-text)' }}>Ingredients in this step</span>
      {here.map(({ g, u }) => <button key={u.id} onClick={() => onUse(u.id)} aria-label={`${g.name} in step ${step.ordinal}: ${STATUS[statusOf(u)].label}. Open`}
        style={{ textAlign: 'left', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '4px 12px', padding: '13px 15px', border: '1.5px solid var(--cc-border-strong)', borderRadius: 12, background: 'var(--cc-surface)' }}>
        <strong style={{ fontSize: 19 }}>{g.name} · <Amount a={u.amount} /></strong><span style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap' }}>{STATUS[statusOf(u)].g} {STATUS[statusOf(u)].label}</span>
        <span style={{ fontSize: 15, color: 'var(--cc-text-2)' }}>{(u.reviewedFunction ?? u.proposedFunction)?.labels.join(' · ') ?? ''}</span><span style={{ fontSize: 14, textDecoration: 'underline' }}>Open</span>
        <span style={{ gridColumn: '1 / -1', fontSize: 16, lineHeight: 1.35 }}>{line(u)}</span>
      </button>)}</> : <span style={{ fontSize: 17, color: 'var(--cc-text-2)' }}>This step uses no listed ingredients.</span>}
    {elsewhere.length > 0 && <><span style={{ ...eyebrow, color: 'var(--cc-text)' }}>Also changed by alternatives elsewhere</span>
      {elsewhere.map(({ g, u, p }) => <button key={u.id + p.planId} onClick={() => onUse(u.id)} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, padding: '12px 15px', border: '2px dashed var(--cc-proposed)', borderRadius: 12, background: 'var(--cc-surface)' }}>
        <strong style={{ fontSize: 17 }}>If you replace {g.name.toLowerCase()} (step {ord(u.stepId)})</strong><span style={{ fontSize: 16 }}>{p.title}</span></button>)}</>}
  </div>;
}
