// Cooking and Changing course. Progress, evaluation and application are the MCP tools; this file only renders their
// results and keeps client-local state (preview, timer, the pending-apply hold). Applying never marks a step done.
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { call, newId, pending, type Active, type Applied, type PendingCommand, type Rejected, type RescueEvaluation, type SpeechRef, type WireCandidate, type WireRefusal, type WireRun } from './api.ts';
import { answerOf, answersAll, type Routed } from './route.ts';

export type HandleResult = string | { info: string } | null;   // string: needs clarification; info: a neutral next prompt
export interface CookingHandle { handle(r: Routed, channel: 'voice' | 'typed'): HandleResult; awaitingAnswer(): boolean }
type Heard = { text: string; channel: 'voice' | 'typed' | 'tapped' };
type Answers = { questionId: string; value: 'yes' | 'no' }[];
type Rx =
  | { phase: 'evaluating'; heard: Heard }
  | { phase: 'result'; heard: Heard; ev: RescueEvaluation; pick: boolean; chosen: string | null; answers: Answers; given: Record<string, 'yes' | 'no'> }
  | { phase: 'applying'; heard: Heard; ev: RescueEvaluation; candidate: WireCandidate }
  | { phase: 'unknown'; checking: boolean; checkedAgain: boolean }
  | { phase: 'notApplied'; code: string | null; evaluationId: string; answers: Answers }
  | { phase: 'message'; heard: Heard | null; title: string; text: string };
type Banner = { kind: 'applied' | 'resumed' | 'plain'; text: string } | null;
const MARK = { notStarted: 'Not started', started: 'Started', partly: 'Partly done', done: 'Done' } as const;
const REASON: Record<string, string> = {
  STALE_STATE: 'Your progress changed after the change was checked.', PLAN_CHANGED: 'The change no longer matched your recipe.', PLAN_MISMATCH: 'The change sent wasn’t the one shown.',
  NOT_LATEST_EVALUATION: 'A newer check replaced it.', NOT_ACTIONABLE: 'It could no longer be applied.', INTERRUPTED: 'The request was interrupted before it finished.',
  RUN_ENDED: 'The cooking session had ended.', RUN_EXPIRED: 'The cooking session was reset.', SUCCESSIVE_RESCUE_UNSUPPORTED: 'This session had already used its one change.',
};

export function Cooking({ active, setActive, refresh, speak, handleRef, wide, onLeave, voiceBar }: {
  active: Active; setActive: (a: Active) => void; refresh: () => Promise<Active>; speak: (text: string, ref: SpeechRef | null) => void;
  handleRef: MutableRefObject<CookingHandle | null>; wide: boolean; onLeave: () => void; voiceBar: ReactNode;
}) {
  const [finished, setFinished] = useState<WireRun | null>(null);
  const run = active.run ?? finished, recipe = active.recipe;
  const [pend, setPend] = useState<PendingCommand | null>(() => pending.get());
  const [rx, setRx] = useState<Rx | null>(() => (pending.get() ? { phase: 'unknown', checking: false, checkedAgain: false } : null));
  const [waiting, setWaiting] = useState<Rx | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [tab, setTab] = useState<'steps' | 'ings'>('steps');
  const [banner, setBanner] = useState<Banner>(() => (active.run && active.run.steps.some((s) => s.progress !== 'notStarted') && !pending.get() ? { kind: 'resumed', text: '' } : null));
  const [flash, setFlash] = useState(false);
  const [origOpen, setOrigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timer, setTimer] = useState<{ stepId: string; ends: number; label: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const appliedCands = useRef<Record<string, WireCandidate>>({});
  useEffect(() => { if (!timer) return; const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, [timer]);

  if (!run || !recipe) return <div style={{ padding: 40 }}>No active cooking session.</div>;
  const steps = recipe.steps;
  const st = (id: string) => run.steps.find((s) => s.stepId === id)!;
  const cur = steps.find((s) => s.id === run.currentStepId) ?? null;
  const next = cur ? steps[cur.ordinal] ?? null : null;
  const ingOfUse = (useId: string) => recipe.ingredients.find((i) => i.uses.some((u) => u.id === useId));
  const usesIn = (stepId: string) => recipe.ingredients.flatMap((i) => i.uses.filter((u) => u.stepId === stepId).map((u) => ({ u, ing: i })));
  const held = pend ? new Set(pend.changedStepIds) : new Set<string>();
  const markOf = (id: string) => { const s = st(id); return s.progress === 'partly' ? `Partly done · ${s.partialUseIds.map((u) => ingOfUse(u)?.name.toLowerCase()).join(', ')} added` : MARK[s.progress]; };
  // the prefix is shown here and spoken by the server only when the ref proves it (an applied amendment; a preview)
  // `from`: the run as just refreshed (after an apply the closure's run still holds the old step text)
  const say = (stepId: string, prefix = '', ref: { amendmentId?: string; next?: true } = {}, from: WireRun = run) => { const s = steps.find((x) => x.id === stepId), t = from.steps.find((x) => x.stepId === stepId); if (s && t) speak(`${prefix}Step ${s.ordinal}. ${t.effectiveText}`, { runId: from.id, stepId, ...ref }); };
  // each changed step shows the words its latest change inserted (several changes per session are possible)
  const candOf = (candidateId: string) => appliedCands.current[candidateId]
    ?? (active.latestEvaluation?.outcome === 'proposal' ? active.latestEvaluation.candidates.find((c) => c.id === candidateId) : undefined);
  const segsFor = (stepId: string) => {
    const am = [...run.appliedAmendments].reverse().find((a) => a.changedStepIds.includes(stepId));
    return am ? candOf(am.candidateId)?.stepChanges.find((x) => x.stepId === stepId && x.segments)?.segments ?? null : null;
  };

  // ---------- progress ----------
  const progress = async (stepId: string, kind: 'started' | 'partly' | 'done', addedUseIds?: string[]) => {
    if (busy || held.has(stepId)) return;
    setBusy(true);
    try {
      const out = await call<{ outcome: 'recorded'; run: WireRun } | Rejected>('record_progress', { commandId: newId(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, stepId, progress: kind, ...(addedUseIds ? { addedUseIds } : {}) });
      if (out.outcome === 'rejected') { setBanner({ kind: 'plain', text: out.message }); await refresh(); return; }
      setBanner(null); setPreview(null);
      if (out.run.state === 'ended') { setFinished(out.run); setActive({ ...active, run: null }); speak('Every step is marked done.', null); return; }
      const a = await refresh();
      if (kind === 'done' && a.run?.currentStepId) say(a.run.currentStepId);
    } catch { setBanner({ kind: 'plain', text: 'No response from CourseCorrect. Check your place before trying again.' }); await refresh(); }
    finally { setBusy(false); }
  };

  // ---------- rescue ----------
  const evaluate = async (args: Record<string, unknown>, heard: Heard) => {
    setWaiting(null);
    setRx({ phase: 'evaluating', heard });
    let out: RescueEvaluation | Rejected;
    try { out = await call<RescueEvaluation | Rejected>('evaluate_rescue', { commandId: newId(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, ...args }); }
    catch { setRx({ phase: 'message', heard, title: 'No response', text: 'CourseCorrect didn’t answer. Nothing was changed; ask again.' }); return; }
    if (out.outcome === 'rejected') { await refresh(); setRx({ phase: 'message', heard, title: 'Ask again', text: out.message }); return; }
    setRx({ phase: 'result', heard, ev: out, pick: false, chosen: null, answers: (args.answers as Answers) ?? [], given: {} });
    speak(out.speech.text, { evaluationId: out.id });
  };
  const ask = (text: string, channel: 'voice' | 'typed') => evaluate({ utterance: { text, channel } }, { text, channel });
  const tapMissing = (ingredientId: string, name: string, prev?: string) => evaluate({ missingIngredientId: ingredientId, utterance: { text: `I don’t have the ${name.toLowerCase()}`, channel: 'tapped' }, ...(prev ? { previousEvaluationId: prev } : {}) }, { text: name, channel: 'tapped' });
  const recheck = (evaluationId: string, answers: Answers, heard: Heard) => evaluate({ previousEvaluationId: evaluationId, ...(answers.length ? { answers } : {}) }, heard);

  const accept = async (ev: RescueEvaluation, c: WireCandidate, heard: Heard) => {
    const p: PendingCommand = {
      args: { commandId: newId(), runId: run.id, epoch: run.epoch, expectedRevision: run.revision, evaluationId: ev.id, candidateId: c.id, planId: c.planId, accepted: true },
      status: 'sending', checks: 0, changedStepIds: c.stepChanges.filter((x) => x.relation === 'changesNow' || x.relation === 'changesLater').map((x) => x.stepId), heldStepId: c.resumeStepId, headline: c.headline,
    };
    pending.set(p); setPend(p);
    appliedCands.current[c.id] = c;
    setRx({ phase: 'applying', heard, ev, candidate: c });
    await sendApply(p);
  };
  /** Send (or resend, with the identical envelope and commandId) one apply. No response → unknown; never a fresh apply. */
  const sendApply = async (p: PendingCommand) => {
    let out: Applied | Rejected;
    try { out = await call<Applied | Rejected>('apply_amendment', p.args); }
    catch { const u = { ...p, status: 'unknown' as const }; pending.set(u); setPend(u); setRx({ phase: 'unknown', checking: false, checkedAgain: false }); return; }
    pending.set(null); setPend(null);
    if (out.outcome === 'rejected') { await refresh(); setRx({ phase: 'notApplied', code: out.code, evaluationId: p.args.evaluationId, answers: [] }); return; }
    await applied(out.resume?.stepId ?? p.heldStepId, out.amendment.id);
  };
  const applied = async (resumeStepId: string, amendmentId?: string) => {
    setRx(null); setTab('steps'); setPreview(null);
    const a = await refresh();
    const s = a.recipe?.steps.find((x) => x.id === resumeStepId);
    setBanner({ kind: 'applied', text: `Change applied. Step ${s?.ordinal ?? ''} is ready, not started until you report it.` });
    setFlash(true); window.setTimeout(() => setFlash(false), 2400);
    if (a.run) say(resumeStepId, amendmentId ? 'Change applied. ' : '', amendmentId ? { amendmentId } : {}, a.run);
  };
  const checkStatus = async () => {
    const p = pending.get();
    if (!p) { setRx(null); return; }
    setRx({ phase: 'unknown', checking: true, checkedAgain: false });
    let a: Active;
    try { a = await call<Active>('get_active_recipe', { runId: p.args.runId, commandId: p.args.commandId, evaluationId: p.args.evaluationId }); }
    catch { const u = { ...p, checks: p.checks + 1 }; pending.set(u); setPend(u); setRx({ phase: 'unknown', checking: false, checkedAgain: true }); return; }
    setActive(a);
    const s = a.command?.status;
    if (s === 'applied') { pending.set(null); setPend(null); await applied(p.heldStepId, a.command?.amendmentId); return; }
    if (s === 'unknown') { const u = { ...p, checks: p.checks + 1 }; pending.set(u); setPend(u); setRx({ phase: 'unknown', checking: false, checkedAgain: true }); return; }
    pending.set(null); setPend(null);
    if (s === 'notApplied') { setRx({ phase: 'notApplied', code: a.command?.code ?? null, evaluationId: p.args.evaluationId, answers: [] }); return; }
    setRx({ phase: 'message', heard: null, title: s === 'appliedOther' ? 'A different change was applied' : 'That cooking session was replaced',
      text: s === 'appliedOther' ? 'This session already has a change applied, so this one can’t apply. Your steps show what is saved.' : 'Nothing from the old session will be applied here.' });
  };
  const close = (unchanged = true) => { setRx(null); if (unchanged) setBanner({ kind: 'plain', text: 'Your recipe is unchanged.' }); };

  // ---------- voice / typed routing ----------
  handleRef.current = {
    awaitingAnswer: () => rx?.phase === 'result' && rx.ev.outcome === 'needsFacts' && !rx.pick,
    handle(r, channel) {
      const res = rx?.phase === 'result' ? rx : null;
      const ev = res?.ev;
      switch (r.kind) {
        case 'rescue': {
          if (pend) return 'First check whether the last change was saved.';
          const a = answerOf(r.text);
          if (ev?.outcome === 'needsFacts') {   // an open question: free text answers it, never replaces it
            if (a) return answerSpoken(res!, a, answersAll(r.text));
            return 'Please answer yes or no for the items listed. To ask about something else, tap Back first.';
          }
          if (ev?.outcome === 'proposal' && a === 'yes') return 'A plain “yes” doesn’t apply anything. Say “use this change”, or tap it.';
          void ask(r.text, channel); return null;
        }
        case 'done': case 'started':
          if (!cur) return 'Every step is already done.';
          if (held.has(cur.id)) return `Step ${cur.ordinal} is on hold until we confirm the change. Say “check status”.`;
          if (r.kind === 'started' && st(cur.id).progress !== 'notStarted') return `Step ${cur.ordinal} is already marked ${MARK[st(cur.id).progress].toLowerCase()}.`;
          void progress(cur.id, r.kind); return null;
        case 'whatsNext': if (!next) return 'This is the last step.'; setPreview(next.id); say(next.id, 'Next: ', { next: true }); return null;
        case 'read': if (cur) say(cur.id); return null;
        case 'ingredients': setTab('ings'); return null;
        case 'startTimer':
          if (!cur?.duration) return cur ? `Step ${cur.ordinal} has no time in the recipe, so there’s no timer.` : 'There’s no current step.';
          setTimer({ stepId: cur.id, ends: Date.now() + cur.duration.seconds * 1000, label: cur.duration.display }); return null;
        case 'stopTimer': if (!timer) return 'No timer is running.'; setTimer(null); return null;
        case 'stepPreview': { const s = steps[r.n - 1]; if (!s) return `There’s no step ${r.n}.`; setPreview(s.id === cur?.id ? null : s.id); say(s.id); return null; }
        case 'checkStatus': if (!pend) return 'There’s nothing to check.'; void checkStatus(); return null;
        case 'accept': {
          if (ev?.outcome !== 'proposal') return 'There’s no proposed change to use right now.';
          const c = ev.candidates.length === 1 ? ev.candidates[0] : ev.candidates.find((x) => x.id === res!.chosen);
          if (!c) return 'Choose one of the changes first.';
          if (c.applicable.kind !== 'yes' || ev.evaluatedAtRunRevision !== run.revision) return 'This change has to be checked again first.';
          void accept(ev, c, res!.heard); return null;
        }
        case 'yes': case 'no':
          if (ev?.outcome === 'needsFacts') return answerSpoken(res!, r.kind, false);
          if (ev?.outcome === 'proposal' && r.kind === 'yes') return 'A plain “yes” doesn’t apply anything. Say “use this change”, or tap it.';
          return 'I didn’t catch what that answers.';
      }
    },
  };
  /** A spoken reply: all open questions when it says so ("yes to both"), else the first; then prompt the next one. */
  const answerSpoken = (res: Extract<Rx, { phase: 'result' }>, value: 'yes' | 'no', all: boolean): HandleResult => {
    if (res.ev.outcome !== 'needsFacts') return null;
    const open = res.ev.questions.filter((x) => !res.given[x.id]);
    if (!open.length) return null;
    if (all || open.length === 1) { void answerMany(res, open.map((q) => q.id), value); return null; }
    void answerOne(res, open[0].id, value);
    const next = open[1];
    return { info: `Next: ${next.title} ${next.items.map((x) => x.text).join('; ')}. Say yes or no.` };
  };
  const answerMany = async (res: Extract<Rx, { phase: 'result' }>, ids: string[], value: 'yes' | 'no') => {
    if (res.ev.outcome !== 'needsFacts') return;
    const given = { ...res.given, ...Object.fromEntries(ids.map((id) => [id, value])) };
    await evaluate({ previousEvaluationId: res.ev.id, answers: res.ev.questions.map((q) => ({ questionId: q.id, value: given[q.id] })) }, res.heard);
  };
  /** Each availability question is answered on its own (a qualitative "a little milk" is never folded into another answer). */
  const answerOne = async (res: Extract<Rx, { phase: 'result' }>, questionId: string, value: 'yes' | 'no') => {
    if (res.ev.outcome !== 'needsFacts') return;
    const given = { ...res.given, [questionId]: value };
    if (res.ev.questions.some((q) => !given[q.id])) { setRx({ ...res, given }); return; }
    await evaluate({ previousEvaluationId: res.ev.id, answers: res.ev.questions.map((q) => ({ questionId: q.id, value: given[q.id] })) }, res.heard);
  };

  // ---------- render ----------
  const cs = cur ? st(cur.id) : null;
  const prevStep = preview ? steps.find((s) => s.id === preview) ?? null : null;
  const timerLeft = timer ? Math.max(0, Math.ceil((timer.ends - now) / 1000)) : 0;
  const curUses = cur ? usesIn(cur.id) : [];
  const openIngs = recipe.ingredients.filter((i) => i.uses.some((u) => st(u.stepId).progress !== 'done' && !st(u.stepId).partialUseIds.includes(u.id)));
  const resumedLine = cur ? `You’re on step ${cur.ordinal}${cur.ordinal > 1 ? `. Steps 1–${cur.ordinal - 1} are done` : ''}.` : '';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div data-testid="screen" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!rx && <nav aria-label="Recipe steps and ingredients" style={{ flex: '0 0 250px', borderRight: '1px solid var(--cc-border)', background: 'var(--cc-surface-2)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 19, fontWeight: 700 }}>{recipe.title}</span>
            <span className="muted" style={{ fontSize: 12 }} title={run.knowledge?.releaseId ? `Knowledge release ${run.knowledge.releaseId}${run.knowledge.basis === 'HASH_MATCH' ? ' (matched by content: saved before releases were recorded)' : ''}` : 'Knowledge release unknown: saved before releases were recorded'}>{run.contentLabel}</span>
            <div role="tablist" style={{ display: 'flex', gap: 4 }}>
              {(['steps', 'ings'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ flex: 1, border: tab === t ? '2px solid var(--cc-text)' : '1.5px solid var(--cc-border-strong)', borderRadius: 8, padding: '8px 6px', fontSize: 15, fontWeight: tab === t ? 700 : 400, background: tab === t ? 'var(--cc-surface)' : 'transparent' }}>{t === 'steps' ? 'Steps' : 'Ingredients'}</button>)}
            </div>
          </div>
          <div className="scroll" style={{ flex: 1, padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {tab === 'steps' && <><span className="muted" style={{ fontSize: 13 }}>Tap a step to preview it. Your place stays put.</span>
              {steps.map((q) => {
                const isNow = q.id === cur?.id, s = st(q.id), segs = s.originalText ? segsFor(q.id) : null;
                return <button key={q.id} onClick={() => setPreview(isNow ? null : q.id)} aria-current={isNow ? 'step' : undefined} aria-pressed={preview === q.id}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', border: isNow ? '2px solid var(--cc-current)' : '1px solid var(--cc-border)', borderRadius: 8, background: 'var(--cc-surface)', textAlign: 'left' }}>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><strong style={{ fontSize: 16 }}>{q.ordinal}</strong><span style={{ fontSize: 15, flex: 1, fontWeight: isNow ? 700 : 400 }}>{q.title}</span>
                    {isNow && <span className="tag now" style={{ fontSize: 11, padding: '2px 7px' }}>Now</span>}{preview === q.id && <span className="tag" style={{ fontSize: 11, padding: '1px 6px' }}>VIEWING</span>}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{s.progress === 'done' ? '✓ ' : ''}{markOf(q.id)}{s.originalText ? ' · ✓ Changed' : ''}{held.has(q.id) ? ' · on hold' : ''}</span>
                  {segs && <span style={{ marginTop: 4, fontSize: 13, lineHeight: 1.35, borderRadius: 5, padding: '5px 7px', background: 'var(--cc-applied-bg)', border: '1px solid var(--cc-applied)', animation: flash ? 'ccApplied 2.4s ease-out' : undefined }}>
                    {segs.map((g, i) => (g.kind === 'inserted' ? <strong key={i} className="ins-applied">{g.text}</strong> : <span key={i}>{g.text}</span>))}</span>}
                </button>;
              })}</>}
            {tab === 'ings' && <><span className="muted" style={{ fontSize: 13 }}>Missing something? Tap “I don’t have this”.</span>
              {recipe.ingredients.map((g) => {
                const open = openIngs.includes(g);
                return <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 10px', borderRadius: 8, background: 'var(--cc-surface)', border: '1px solid var(--cc-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 15 }}><strong>{g.name}{g.group && <span style={{ fontWeight: 400 }}> · {g.group.replace(/:\s*$/, '')}</span>}</strong><span style={{ textAlign: 'right' }}>{g.totalAmount.display}</span></div>
                  {g.uses.map((u) => { const d = st(u.stepId).progress === 'done' || st(u.stepId).partialUseIds.includes(u.id);
                    return <span key={u.id} style={{ fontSize: 13 }} className={d ? 'muted' : undefined}>{d ? '✓ ' : ''}Step {steps.find((s) => s.id === u.stepId)?.ordinal} · {u.amount.display ?? 'not stated'}{d ? ' · used' : (u.reviewedFunction ?? u.proposedFunction) ? ` · ${(u.reviewedFunction ?? u.proposedFunction)!.labels.join(' · ')}` : ''}
                      {u.introducedBy && <em data-testid="introduced" title={u.introducedBy.title ?? undefined}> · from your change{u.introducedBy.replaces ? ` (instead of the ${u.introducedBy.replaces.toLowerCase()})` : ''}</em>}</span>; })}
                  {g.removedByAmendment && <span style={{ fontSize: 13, fontWeight: 700 }}>Not needed after your change</span>}
                  {open && !g.removedByAmendment && !pend && <button className="b sm" style={{ alignSelf: 'flex-start', fontSize: 14 }} onClick={() => void tapMissing(g.id, g.name)}>I don’t have this</button>}
                </div>;
              })}</>}
          </div>
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--cc-border)' }}><button className="b sm" style={{ width: '100%' }} onClick={onLeave}>Leave for now · place saved</button></div>
        </nav>}

        {!rx && <div className="scroll" style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', padding: '26px 36px 20px' }}>
          <div style={{ width: '100%', maxWidth: 840, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {banner?.kind === 'resumed' && cur && <div role="status" className="card in" style={{ border: '2px solid var(--cc-current)', fontSize: 18, display: 'block' }}><strong>Welcome back.</strong> {resumedLine}</div>}
            {banner?.kind === 'applied' && <div role="status" className="in" style={{ border: '2px solid var(--cc-applied)', background: 'var(--cc-applied-bg)', borderRadius: 10, padding: '12px 16px', fontSize: 19, fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center' }}><span style={{ color: 'var(--cc-applied)' }}>✓</span><span style={{ flex: 1 }}>{banner.text}</span><button className="link" onClick={() => setBanner(null)}>Dismiss</button></div>}
            {banner?.kind === 'plain' && <div role="status" style={{ border: '1.5px solid var(--cc-border-strong)', background: 'var(--cc-surface-2)', borderRadius: 10, padding: '12px 16px', fontSize: 18, fontWeight: 600, display: 'flex', gap: 10 }}><span style={{ flex: 1 }}>{banner.text}</span><button className="link" onClick={() => setBanner(null)}>Dismiss</button></div>}
            {waiting && waiting.phase === 'result' && <div className="card" style={{ border: '2px solid var(--cc-proposed)', flexDirection: 'row', alignItems: 'center' }}><span style={{ flex: 1, fontSize: 18 }}><strong>A proposed change is waiting.</strong> It isn’t applied.</span><button className="b strong" onClick={() => { setRx(waiting); setWaiting(null); }}>Review it</button></div>}
            {pend && <div role="alert" className="attention" style={{ display: 'flex', gap: 12, alignItems: 'center' }}><span style={{ flex: 1, fontSize: 18 }}><strong>Steps {[...held].map((id) => steps.find((s) => s.id === id)?.ordinal).join(' and ')} are on hold.</strong> We don’t know yet whether the change was saved.</span><button className="b primary" onClick={() => void checkStatus()}>Check status</button></div>}
            {timer && timerLeft > 0 && <div style={{ background: 'var(--cc-chrome)', color: 'var(--cc-on-chrome)', borderRadius: 10, padding: '10px 16px', display: 'flex', gap: 14, alignItems: 'center' }}><span>Step {steps.find((s) => s.id === timer.stepId)?.ordinal} timer</span><span style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.floor(timerLeft / 60)}:{String(timerLeft % 60).padStart(2, '0')}</span><span style={{ fontSize: 14, flex: 1 }}>{timer.label} · this tab only</span><button className="b sm" onClick={() => setTimer(null)}>Stop</button></div>}
            {timer && timerLeft === 0 && <div role="alert" className="attention" style={{ display: 'flex', gap: 14, alignItems: 'center' }}><span style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>Time’s up for step {steps.find((s) => s.id === timer.stepId)?.ordinal}. Check it, then mark it done when it’s ready.</span><button className="b sm" onClick={() => setTimer(null)}>Dismiss</button></div>}

            {finished && !active.run && <><h2 style={{ fontSize: 32 }}>Every step is marked done.</h2><button className="b primary big" style={{ alignSelf: 'flex-start' }} onClick={onLeave}>Back to Recipe Book</button></>}

            {prevStep && <div className="card in" style={{ border: '2px solid var(--cc-text)', borderRadius: 14, padding: '24px 26px', gap: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>Viewing step {prevStep.ordinal} · {markOf(prevStep.id)} · not your place</span>
              <span style={{ fontSize: 28, lineHeight: 1.35 }}>{st(prevStep.id).effectiveText}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{usesIn(prevStep.id).map(({ u, ing }) => <span key={u.id} className="chip" style={{ fontSize: 17 }}>{ing.name} · <strong>{u.amount.display ?? 'not stated'}</strong></span>)}</div>
              {cur && <button className="b primary" style={{ alignSelf: 'flex-start' }} onClick={() => setPreview(null)}>Back to step {cur.ordinal} · your place</button>}
            </div>}

            {!prevStep && cur && cs && held.has(cur.id) && <div className="card" style={{ border: '2px dashed var(--cc-attention)', borderRadius: 14, padding: '24px 26px', gap: 14 }}>
              <span style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 17, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}><span className="tag now">Now</span>Step {cur.ordinal} · on hold</span>
              <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 30, fontWeight: 700 }}>Hold step {cur.ordinal} until we confirm which version is saved.</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
                <div style={{ border: '1.5px solid var(--cc-border-strong)', borderRadius: 10, padding: 12 }}><span className="eyebrow">Last confirmed · as written</span><p className="muted" style={{ fontSize: 18, margin: '4px 0 0' }}>{cs.effectiveText}</p></div>
                <div style={{ border: '1.5px dashed var(--cc-border-strong)', borderRadius: 10, padding: 12 }}><span className="eyebrow">Pending change · not confirmed</span><p className="muted" style={{ fontSize: 18, margin: '4px 0 0' }}>{pend!.headline}</p></div>
              </div>
              <span style={{ fontSize: 17 }}>Don’t start either version yet. Checking status reads your recipe and changes nothing.</span>
              <button className="b primary big" style={{ alignSelf: 'flex-start' }} onClick={() => void checkStatus()}>Check status</button>
            </div>}

            {!prevStep && cur && cs && !held.has(cur.id) && <div className="in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><span className="tag now" style={{ fontSize: 17 }}>Now</span><span style={{ fontSize: 19, fontWeight: 700 }}>Step {cur.ordinal} of {steps.length} · {cur.title}</span></div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><span className="muted" style={{ fontSize: 17 }}>You marked: {markOf(cur.id)}</span>
                {cs.originalText && <><span className="tag applied" style={{ fontSize: 15 }}>✓ Changed</span><button className="link" style={{ fontSize: 16 }} aria-expanded={origOpen} onClick={() => setOrigOpen(!origOpen)}>Show as written</button></>}</div>
              <p data-testid="current-step" style={{ margin: 0, fontSize: wide ? 38 : 32, lineHeight: 1.26, borderRadius: 10, animation: flash ? 'ccApplied 2.4s ease-out' : undefined }}>{cs.effectiveText}</p>
              {origOpen && cs.originalText && <span className="muted" style={{ fontSize: 18 }}><strong>As written:</strong> <s>{cs.originalText}</s></span>}
              {curUses.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{curUses.map(({ u, ing }) => <span key={u.id} className="chip">{ing.name} · <strong>{u.amount.display ?? 'not stated'}</strong></span>)}</div>}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                <button className="b primary big" disabled={busy} onClick={() => void progress(cur.id, 'done')}>Done</button>
                {cs.progress === 'notStarted' && <button className="b big" style={{ fontSize: 18, padding: '17px 20px' }} disabled={busy} onClick={() => void progress(cur.id, 'started')}>I’ve started</button>}
                {recipe.steps.find((s) => s.id === cur.id)?.duration && (!timer || timer.stepId !== cur.id) && <button className="b big" style={{ fontSize: 17, padding: '17px 18px' }} onClick={() => { const d = cur.duration!; setTimer({ stepId: cur.id, ends: Date.now() + d.seconds * 1000, label: d.display }); }}>Timer · {cur.duration!.display}</button>}
              </div>
              {next && <div style={{ borderTop: '1px solid var(--cc-border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}><span className="eyebrow" style={{ fontSize: 15 }}>Next · step {next.ordinal} · {next.title}</span><span className="muted" style={{ fontSize: 20, lineHeight: 1.4 }}>{st(next.id).effectiveText}</span></div>}
            </div>}
          </div>
        </div>}

        {rx && <Rescue rx={rx} setRx={setRx} run={run} active={active} steps={steps} st={st} openIngs={openIngs.map((g) => ({ id: g.id, name: g.name, group: g.group ?? null }))} wide={wide} pend={pend}
          close={close} notNow={() => { setWaiting(rx); setRx(null); }} accept={accept} sendApply={() => { const p = pending.get(); if (p) { setRx({ phase: 'unknown', checking: true, checkedAgain: false }); void sendApply(p); } }}
          checkStatus={checkStatus} tapMissing={tapMissing} recheck={recheck} answer={(res, q, v) => void answerOne(res, q, v)} holdView={() => setRx(null)} />}
      </div>
      {voiceBar}
    </div>
  );
}

// ---------- Changing course ----------
function Rescue({ rx, setRx, run, active, steps, st, openIngs, wide, pend, close, notNow, accept, sendApply, checkStatus, tapMissing, recheck, answer, holdView }: {
  rx: Rx; setRx: (r: Rx) => void; run: WireRun; active: Active; steps: NonNullable<Active['recipe']>['steps']; st: (id: string) => WireRun['steps'][number];
  openIngs: { id: string; name: string; group?: string | null }[]; wide: boolean; pend: PendingCommand | null; close: (unchanged?: boolean) => void; notNow: () => void;
  accept: (ev: RescueEvaluation, c: WireCandidate, heard: Heard) => Promise<void>; sendApply: () => void; checkStatus: () => Promise<void>;
  tapMissing: (id: string, name: string, prev?: string) => Promise<void>; recheck: (evaluationId: string, answers: Answers, heard: Heard) => Promise<void>;
  answer: (res: Extract<Rx, { phase: 'result' }>, questionId: string, v: 'yes' | 'no') => void; holdView: () => void;
}) {
  const cur = steps.find((s) => s.id === run.currentStepId);
  const ordOf = (id: string) => steps.find((s) => s.id === id)?.ordinal ?? 0;
  const heard = 'heard' in rx ? rx.heard : null;
  const ev = rx.phase === 'result' || rx.phase === 'applying' ? rx.ev : null;
  const interp = ev?.interpretation ?? null;
  const missingName = interp ? active.recipe!.ingredients.find((i) => i.id === interp.missingIngredientId)?.name ?? '' : '';
  const canBack = rx.phase !== 'evaluating' && rx.phase !== 'applying' && rx.phase !== 'unknown';
  const res = rx.phase === 'result' ? rx : null;
  const picker = (prev?: string) => <div role="group" aria-label="Which ingredient is missing" className="in" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 30, fontWeight: 700 }}>Which ingredient are you missing?</span>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
      {(ev?.outcome === 'needsInterpretation' && ev.options.length ? ev.options.map((o) => ({ id: o.ingredientId, name: o.label, group: active.recipe!.ingredients.find((i) => i.id === o.ingredientId)?.group ?? null })) : openIngs).map((g) =>
        <button key={g.id} className="b" style={{ textAlign: 'left', whiteSpace: 'normal', fontSize: 18 }} onClick={() => void tapMissing(g.id, g.name, prev)}>{g.name}{g.group ? ` · ${g.group.replace(/:\s*$/, '')}` : ''}</button>)}</div>
    {res?.pick && <button className="link" style={{ alignSelf: 'flex-start', fontSize: 16 }} onClick={() => setRx({ ...res, pick: false })}>Cancel · keep {missingName.toLowerCase()}</button>}
  </div>;
  const backBtns = <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="b primary" onClick={() => close(false)}>Ask about something else</button><button className="b" onClick={() => close()}>Back to step {cur?.ordinal} as written</button></div>;

  // ---- proposal / functional refusal use the canvas layout; everything else is a centered card ----
  const proposal = res && ev?.outcome === 'proposal' && !res.pick ? ev : null;
  const fRefusal = res && ev?.outcome === 'refused' && ev.refusal.kind === 'functionallyUnsupported' && !res.pick ? ev.refusal : null;
  const cands = proposal?.candidates ?? [];
  const chosen = proposal ? (cands.length === 1 ? cands[0] : cands.find((c) => c.id === res!.chosen) ?? null) : null;
  const applying = rx.phase === 'applying' ? rx.candidate : null;
  const shown = applying ?? chosen;
  const stale = !!shown && !applying && (shown.applicable.kind !== 'yes' || ev!.evaluatedAtRunRevision !== run.revision);

  return (
    <section aria-label="Changing course" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', background: 'var(--cc-surface)', borderBottom: '1px solid var(--cc-border)', padding: '10px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span data-testid="heard" style={{ flex: 1, minWidth: 0, fontSize: 19, fontWeight: 600 }}>{heard ? (heard.channel === 'tapped' ? `You tapped: ${heard.text}` : `You ${heard.channel === 'voice' ? 'said' : 'typed'}: “${heard.text}”`) : 'Checking a change'}</span>
          {canBack && <button className="b sm" onClick={() => close()}>Back to step {cur?.ordinal} · recipe unchanged</button>}
        </div>
        {interp && <div style={{ display: 'flex', gap: '4px 18px', flexWrap: 'wrap', alignItems: 'baseline', fontSize: 14 }}>
          <span className="eyebrow">Changing course · {active.recipe!.title}</span>
          <dl style={{ display: 'contents' }}>{interp.display.map((x) => <div key={x.label} style={{ display: 'flex', gap: 5, alignItems: 'baseline' }}><dt className="muted">{x.label}:</dt><dd style={{ fontWeight: 700 }} data-testid={x.label === 'Missing' ? 'understood' : undefined}>{x.value}</dd></div>)}</dl>
          {res && !res.pick && <button className="b sm" style={{ marginLeft: 'auto' }} onClick={() => setRx({ ...res, pick: true })}>Not this ingredient</button>}
        </div>}
        {ev?.notices.map((n, i) => <span key={i} className="muted" style={{ fontSize: 14 }}>{n.kind === 'CLAIMED_PROGRESS_NOT_RECORDED' ? 'Progress you mentioned isn’t recorded; use Done.' : n.kind === 'UNMAPPED_PROPOSAL' ? `Not recognized as an ingredient: ${n.text}` : n.text}</span>)}
      </div>

      {(proposal || fRefusal || applying) ? (
        <div style={{ flex: 1, display: 'flex', gap: 16, padding: '14px 18px', minHeight: 0 }}>
          <div className="scroll" style={{ flex: 1.55, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 2 }}>
            {proposal && cands.length > 1 && !applying && <div className="card" role="radiogroup" aria-label="Choose a change" style={{ border: '2px solid var(--cc-proposed)' }}>
              <strong style={{ fontSize: 18 }}>There is more than one reviewed change. Choose one to see it.</strong>
              {cands.map((c) => <button key={c.id} role="radio" aria-checked={res!.chosen === c.id} className="b" style={{ textAlign: 'left', whiteSpace: 'normal', display: 'flex', flexDirection: 'column', gap: 4, borderColor: res!.chosen === c.id ? 'var(--cc-current)' : undefined, borderWidth: res!.chosen === c.id ? 3 : 2 }} onClick={() => setRx({ ...res!, chosen: c.id })}>
                <strong>{res!.chosen === c.id ? '● ' : '○ '}{c.headline}</strong><span className="muted" style={{ fontSize: 15 }}>{c.consequence.text}</span></button>)}
            </div>}
            {(shown?.stepChanges ?? fRefusal?.stepChanges ?? []).map((z) => {
              const s = steps.find((x) => x.id === z.stepId)!;
              if (z.relation === 'context') return <div key={z.stepId} className="muted" style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '6px 14px', fontSize: 16 }}><strong style={{ whiteSpace: 'nowrap' }}>Step {s.ordinal} · {z.stateLabel}</strong><span>{s.title}{z.note ? ` · ${z.note}` : ''}</span></div>;
              if (z.relation === 'unchanged') return <article key={z.stepId} className="card"><span className="eyebrow" style={{ color: 'var(--cc-text)', fontSize: 15 }}>Step {s.ordinal} · {z.stateLabel} · {s.title}</span><span className="muted" style={{ fontSize: 19 }}>{st(s.id).effectiveText}</span>{z.note && <strong style={{ fontSize: 20 }}>{z.note}</strong>}</article>;
              if (z.relation === 'refused') return <article key={z.stepId} className="refusal" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}><span className="eyebrow" style={{ color: 'var(--cc-text)', fontSize: 15 }}>Step {s.ordinal} · {z.stateLabel} · {s.title}</span><p style={{ margin: 0, fontSize: 28, lineHeight: 1.32 }}>{st(s.id).effectiveText}</p><strong style={{ fontSize: 19 }}>{fRefusal?.origin === 'importCard' ? '✕ No swap for this use · Prepared at import (AI)' : '✕ No reviewed change for this use'}</strong></article>;
              return <article key={z.stepId} className="card proposed in" style={{ padding: '14px 18px' }}>
                <span className="eyebrow" style={{ color: 'var(--cc-proposed)', fontSize: 15 }}>Step {s.ordinal} · {z.stateLabel} · {z.titleAfter ?? s.title}</span>
                <p data-testid={`change-${s.ordinal}`} style={{ margin: 0, fontSize: wide ? 29 : 25, lineHeight: 1.32 }}>{(z.segments ?? []).map((g, i) => (g.kind === 'inserted' ? <mark key={i} className="ins">{g.text}</mark> : <span key={i}>{g.text}</span>))}</p>
                <span className="muted" style={{ fontSize: 16 }}><strong>As written:</strong> {st(s.id).effectiveText}</span>
                {run.appliedAmendments.filter((a) => a.changedStepIds.includes(s.id)).map((a) => <span key={a.id} style={{ fontSize: 15 }}>Keeps your earlier change{a.title ? `: ${a.title.toLowerCase()}` : ''}.</span>)}
              </article>;
            })}
          </div>
          {shown && <aside aria-label="Decision" style={{ flex: 1, minWidth: 330, maxWidth: 460, background: 'var(--cc-surface)', border: '2px solid var(--cc-proposed)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            <div className="scroll" style={{ flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span className="tag prop">Proposed change · not applied</span>
              {stale && <div role="alert" className="attention" style={{ fontSize: 16 }}><strong>You’ve reported progress since this was checked.</strong> It has to be checked again before it can be used.</div>}
              {ev?.proposalResponse?.text && <span style={{ fontSize: 16 }}>{ev.proposalResponse.text}</span>}
              <h2 style={{ fontSize: wide ? 26 : 22 }}>{shown.headline}</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="muted" style={{ fontSize: 15 }}>What each job of the {missingName.toLowerCase()} becomes</span>
                {shown.roleMap.map((o) => <div key={o.role} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr)', gap: 10, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--cc-border)' }}>
                  <span className="eyebrow" style={{ fontSize: 14 }}>{o.role}</span><span style={{ fontSize: o.kind === 'alreadyDone' ? 16 : 18, fontWeight: o.kind === 'alreadyDone' ? 400 : 700 }}>{o.kind === 'replaced' ? '→ ' : o.kind === 'lost' ? '✕ ' : ''}{o.replacement}</span></div>)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span className="eyebrow">Ingredients with this change</span>
                {shown.ledger.map((l, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 15, borderBottom: '1px solid var(--cc-border)' }}><span>{l.ingredient} · {l.step}</span><strong style={{ textAlign: 'right' }}>{l.after}</strong></div>)}</div>
              <span className="muted" style={{ fontSize: 14 }}>Checked against your recipe · {interp?.display.find((x) => x.label === 'Your place')?.value}{ev?.basis ? ` · version ${ev.basis.version}${run.appliedAmendments.length ? `, with your ${run.appliedAmendments.length} earlier change${run.appliedAmendments.length > 1 ? 's' : ''}` : ''}` : ''}</span>
            </div>
            <div style={{ flex: 'none', borderTop: '2px solid var(--cc-proposed)', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="eyebrow" style={{ color: 'var(--cc-text)', fontSize: 14 }}>What to expect</span>
              <p data-testid="consequence" style={{ margin: 0, fontSize: wide ? 22 : 20, lineHeight: 1.3, fontWeight: 600 }}>{shown.consequence.text}</p>
              <span className="muted" style={{ fontSize: 13 }}>{shown.contentLabel}</span>
              <span style={{ fontSize: 15 }}>After you accept: step {ordOf(shown.resumeStepId)}, not started until you report it.</span>
              {applying ? <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', border: '2px dashed var(--cc-processing)', borderRadius: 10, padding: '12px 14px' }}><span className="dots"><i /><i /><i /></span><span style={{ display: 'flex', flexDirection: 'column' }}><strong style={{ fontSize: 18 }}>Applying the change…</strong><span className="muted">Steps update only once it’s confirmed.</span></span></div>
                : stale ? <div style={{ display: 'flex', gap: 8 }}><button className="b primary" onClick={() => void recheck(ev!.id, res!.answers, res!.heard)}>Check again</button><button className="b" onClick={notNow}>Not now</button></div>
                  : <><div style={{ display: 'flex', gap: 8 }}><button className="b primary" style={{ fontSize: 20, padding: '15px 24px' }} onClick={() => void accept(ev!, shown, res!.heard)}>Use this change</button><button className="b" onClick={notNow}>Not now</button></div><span className="muted" style={{ fontSize: 14 }}>Or say “use this change”.</span></>}
            </div>
          </aside>}
          {proposal && !shown && <aside className="card" style={{ flex: 1, minWidth: 330, maxWidth: 460, justifyContent: 'center' }}><strong>Choose a change to see what it does.</strong><span className="muted">Nothing is chosen for you.</span></aside>}
          {fRefusal && <aside aria-label="Not supported" className="refusal" style={{ flex: 1, minWidth: 330, maxWidth: 460, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', borderRadius: 14 }}>
            <div className="scroll" style={{ flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span className="tag ref">✕ Not supported for this use</span>
              {ev?.outcome === 'refused' && <h2 data-testid="refusal-answer" style={{ fontSize: 20, lineHeight: 1.35 }}>{ev.answer.text}</h2>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="muted" style={{ fontSize: 15 }}>Where the {missingName.toLowerCase()} is used, and what it does</span>
                {fRefusal.roleMap.map((o) => <div key={o.role} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 0', borderBottom: '1px solid var(--cc-border)' }}><span style={{ fontSize: 15, fontWeight: 700 }}>{o.role}</span><span style={{ fontSize: o.kind === 'lost' ? 17 : 16, fontWeight: o.kind === 'lost' ? 700 : 400 }} className={o.kind === 'lost' ? undefined : 'muted'}>{o.kind === 'lost' ? '✕ ' : ''}{o.replacement}</span></div>)}</div>
              {ev?.outcome === 'refused' && <WhyList ev={ev} />}{fRefusal.scopeNote && <span className="muted" style={{ fontSize: 14 }}>{fRefusal.scopeNote}</span>}
            </div>
            <div style={{ flex: 'none', borderTop: '3px dashed var(--cc-refusal)', padding: '14px 20px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}><p style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>{fRefusal.unchanged}</p>{backBtns}</div>
          </aside>}
        </div>
      ) : (
        <div className="scroll" style={{ flex: 1, display: 'flex', gap: 18, padding: '18px 22px', alignItems: 'stretch' }}>
          <div className="card in" style={{ flex: 1.7, minWidth: 0, minHeight: 0, border: '2px solid var(--cc-text)', borderRadius: 16, padding: 0, gap: 0, overflow: 'hidden' }}>
          <div className="scroll" style={{ flex: 1, padding: '30px 36px', display: 'flex', flexDirection: 'column', gap: 18, justifyContent: 'safe center' }}>
            {rx.phase === 'evaluating' && <div role="status" style={{ display: 'flex', gap: 14, alignItems: 'center' }}><span className="dots"><i /><i /><i /></span><span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 30, fontWeight: 700 }}>Checking your recipe and the steps you’ve marked…</span></div>}
            {res && (res.pick || ev?.outcome === 'needsInterpretation') && <>{ev?.outcome === 'needsInterpretation' && ev.prompt !== 'Which ingredient are you out of?' && <span style={{ fontSize: 19 }}>{ev.prompt}</span>}{picker(ev?.id)}</>}
            {res && !res.pick && ev?.outcome === 'needsFacts' && <>
              <span className="eyebrow" style={{ fontSize: 14 }}>Needed before checking a change</span>
              {ev.questions.map((q) => <div key={q.id} data-testid="question" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: ev.questions.length > 1 ? 26 : 32, fontWeight: 700, lineHeight: 1.2 }}>{q.title}</span>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>{q.items.map((x) => <li key={x.text} className="in" style={{ fontSize: 26, border: '1.5px solid var(--cc-border)', borderRadius: 12, padding: '12px 18px', background: 'var(--cc-surface-2)' }}>{x.text}</li>)}</ul>
                {res.given[q.id] ? <span style={{ fontSize: 18, fontWeight: 700 }}>You answered: {res.given[q.id] === 'yes' ? 'Yes' : 'No'} <button className="link" onClick={() => { const g = { ...res.given }; delete g[q.id]; setRx({ ...res, given: g }); }}>Change</button></span>
                  : <div style={{ display: 'flex', gap: 10 }}><button className="b primary big" onClick={() => answer(res, q.id, 'yes')}>Yes</button><button className="b big" onClick={() => answer(res, q.id, 'no')}>No</button></div>}
              </div>)}
              {ev.note && <span style={{ fontSize: 19 }}>{ev.note}</span>}
              <span className="muted" style={{ fontSize: 16 }}>Answering doesn’t change your recipe.{ev.questions.length > 1 ? ' Each question is answered separately.' : ''}</span>
            </>}
            {res && !res.pick && ev?.outcome === 'refused' && <><RefusalCard r={ev.refusal} name={missingName} ordOf={ordOf} answer={ev.answer.text} noRule={ev.why.verdict === 'noRule'} /><WhyList ev={ev} /></>}
            {rx.phase === 'unknown' && rx.checking && <div role="status" style={{ display: 'flex', gap: 14, alignItems: 'center' }}><span className="dots"><i /><i /><i /></span><span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 30, fontWeight: 700 }}>Checking whether the change was saved…</span><span className="muted" style={{ fontSize: 17 }}>This reads your recipe. It doesn’t send a new change.</span></span></div>}
            {rx.phase === 'unknown' && !rx.checking && pend && <>
              <span className="eyebrow" style={{ color: 'var(--cc-attention)', fontSize: 14 }}>Result unknown</span>
              <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 34, fontWeight: 700 }}>We can’t confirm whether the change was saved</span>
              <span style={{ fontSize: 21 }}>Hold step {ordOf(pend.heldStepId)}. Don’t start either version until we know which one is saved.</span>
              <div style={{ border: '1.5px solid var(--cc-border-strong)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="eyebrow">Last confirmed · step {ordOf(pend.heldStepId)}</span><span className="muted" style={{ fontSize: 18 }}>{st(pend.heldStepId).effectiveText}</span>
                <span className="eyebrow" style={{ marginTop: 4 }}>Pending · not confirmed</span><span className="muted" style={{ fontSize: 16 }}>{pend.headline} · request {pend.args.commandId.slice(0, 8)}</span></div>
              {rx.checkedAgain && <span className="muted" style={{ fontSize: 16 }}>Checked again · still unknown. You can keep checking; nothing is applied twice.</span>}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="b primary" onClick={() => void checkStatus()}>Check status</button>
                <button className="b" onClick={sendApply}>Retry confirmation</button>
                <button className="b" onClick={holdView}>See my steps · step {ordOf(pend.heldStepId)} on hold</button></div>
              <span className="muted" style={{ fontSize: 15 }}>Retry confirmation resends the same request ({pend.args.commandId.slice(0, 8)}). It can apply at most once.</span>
            </>}
            {rx.phase === 'notApplied' && <>
              <span className="eyebrow" style={{ fontSize: 14 }}>Confirmed · not applied</span>
              <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 34, fontWeight: 700 }}>The change wasn’t applied</span>
              <span style={{ fontSize: 21 }}>{REASON[rx.code ?? ''] ?? 'It was refused.'} Your recipe is as written.</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="b primary" onClick={() => void recheck(rx.evaluationId, rx.answers, { text: 'Re-check the change', channel: 'tapped' })}>Re-check the change</button><button className="b" onClick={() => close()}>Back to recipe</button></div>
              <span className="muted" style={{ fontSize: 15 }}>Re-checking evaluates your recipe as it is now. If a change is still possible, you’ll see it before anything is applied.</span>
            </>}
            {rx.phase === 'message' && <><span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 30, fontWeight: 700 }}>{rx.title}</span><span style={{ fontSize: 20 }}>{rx.text}</span><button className="b primary" style={{ alignSelf: 'flex-start' }} onClick={() => close()}>Back to step {cur?.ordinal}</button></>}
          </div>
          {res && !res.pick && ev?.outcome === 'refused' && <div style={{ flex: 'none', padding: '14px 36px 18px', borderTop: '1px solid var(--cc-border)' }}>{backBtns}</div>}
          </div>
          <aside aria-label="Your recipe right now" style={{ flex: 1, minWidth: 250, maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="eyebrow">Your recipe right now</span>
            <div className="card" style={{ padding: 8, gap: 3 }}>{steps.map((q) => { const rel = interp?.missingUseIds.some((u) => active.recipe!.ingredients.some((i) => i.uses.some((x) => x.id === u && x.stepId === q.id))) || q.id === cur?.id;
              return <div key={q.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 10px', borderRadius: 8, border: rel ? '2px solid var(--cc-text)' : undefined }}><strong style={{ fontSize: 15 }}>{q.ordinal}</strong><span style={{ fontSize: 15, flex: 1, fontWeight: rel ? 700 : 400 }}>{q.title}</span><span className="muted" style={{ fontSize: 13 }}>{st(q.id).progress === 'done' ? '✓ Done' : MARK[st(q.id).progress]}</span></div>; })}</div>
          </aside>
        </div>
      )}
    </section>
  );
}

/** The engine's reasons, stated by the server; the answer above them is only those reasons in words. */
function WhyList({ ev }: { ev: Extract<RescueEvaluation, { outcome: 'refused' }> }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span className="eyebrow">Why</span>
    <ul data-testid="refusal-reason" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 16, lineHeight: 1.45 }}>{ev.why.facts.map((f) => <li key={f}>{f.charAt(0).toUpperCase() + f.slice(1)}.</li>)}</ul>
    {ev.why.proposalAnswer && <span className="muted" style={{ fontSize: 15 }}>{ev.why.proposalAnswer}</span>}</div>;
}

function RefusalCard({ r, name, ordOf, answer, noRule }: { r: WireRefusal; name: string; ordOf: (id: string) => number; answer: string; noRule: boolean }) {
  const n = name.toLowerCase();
  const head = <span data-testid="refusal-answer" style={{ fontFamily: 'var(--cc-font-head)', fontSize: answer.length > 140 ? 23 : 30, fontWeight: 700, lineHeight: 1.3 }}>{answer}</span>;
  switch (r.kind) {
    case 'noReviewedRecovery': return <><span className="eyebrow" style={{ fontSize: 14 }}>No safe swap for the {n || 'ingredient'}</span>{head}
      <span style={{ fontSize: 21 }}>{r.unchanged}{r.stillNeededInStepIds.length ? ` ${name} is still needed in step ${r.stillNeededInStepIds.map(ordOf).join(' and ')}.` : ''}</span>
      {noRule && <span className="muted" style={{ fontSize: 17 }}>This means no change has been reviewed for this use. It isn’t a judgement that nothing else could work. CourseCorrect doesn’t guess a substitute.</span>}</>;
    case 'protectedWork': return <><span className="eyebrow" style={{ fontSize: 14 }}>Protected · work already reported</span>{head}
      <span style={{ fontSize: 21 }}>You marked step {ordOf(r.stepId)} <strong>{r.progress === 'partly' ? 'partly done' : 'started'}</strong>. The change rewrites step {ordOf(r.stepId)}, and CourseCorrect doesn’t change a step you’ve reported starting.</span>
      <span style={{ fontSize: 19 }}>Your recipe is unchanged. {r.unchanged}</span></>;
    case 'missingFacts': return <><span className="eyebrow" style={{ fontSize: 14 }}>Missing availability</span>{head}<span style={{ fontSize: 21 }}>{r.unchanged}</span></>;
    case 'nothingToChange': return <><span className="eyebrow" style={{ fontSize: 14 }}>Nothing to change</span>
      <span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 34, fontWeight: 700 }}>{r.reason === 'replacedByAmendment' ? `${name || 'That ingredient'} isn’t needed anymore` : `You’ve already used the ${n}`}</span>
      <span style={{ fontSize: 21 }}>{r.reason === 'replacedByAmendment' ? 'The change you accepted replaced it.' : r.message}</span></>;
    case 'rescueLimitReached': return <><span className="eyebrow" style={{ fontSize: 14 }}>Change limit reached</span>{head}<span style={{ fontSize: 21 }}>{r.unchanged}</span></>;
    case 'earlierChangeConflict': return <><span className="eyebrow" style={{ fontSize: 14 }}>No change can be offered here</span><span style={{ fontFamily: 'var(--cc-font-head)', fontSize: 34, fontWeight: 700 }}>This would undo part of an earlier change</span>{head}<span style={{ fontSize: 19 }}>{r.unchanged}</span></>;
    case 'knowledgeUnavailable': return <><span className="eyebrow" style={{ fontSize: 14 }}>Can’t check changes right now</span>{head}<span style={{ fontSize: 19 }}>{r.unchanged}</span></>;
    case 'notReleased': return head;
    default: return <>{head}<span style={{ fontSize: 21 }}>{r.unchanged}</span></>;
  }
}
