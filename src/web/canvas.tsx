// Import canvas (HF Import Review v1): the reading's stages as the server returns them, then the review (matrix → step →
// use) of every ingredient use's analysis, and Save. Every status, plan, reason and question is the server's. Since 2026-10-13 the
// cook may answer the server's questions about this recipe (what an ingredient is, what a step does) when an answer would let a
// reviewed change apply, and may re-run a check for alternatives that didn't finish (the same import; nothing read twice).
import { useEffect, useState, type ReactNode } from 'react';
import { newId, web, type ImportJob, type SourceLine, type WireDraft, type WireSourceDoc } from './api.ts';
import { Review, statusCounts } from './review.tsx';

interface DraftView { draft: WireDraft; sources: WireSourceDoc[]; sourceLines: SourceLine[] }
const STAGES = [['reading', 'Reading the source'], ['recipeFound', 'Recipe found'], ['ingredientsAndSteps', 'Ingredients and steps'], ['uses', 'Uses linked to steps'], ['coverage', 'Checking each use for alternatives']] as const;
const live = (j: ImportJob | null) => !!j && (j.state === 'running' || j.state === 'queued');

export function Canvas({ draftId, jobId, wide, onSaved, onPage, activity }: {
  draftId: string; jobId: string | null; wide: boolean; onSaved: (recipeId: string, stillOpen: string[]) => void; onPage: (recipeId: string) => void; activity: ReactNode;
}) {
  const [d, setD] = useState<DraftView | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const END = STAGES.length + 2;   // rows = Uploading + STAGES; one more beat shows the last row before the results open
  const [revealed, setRevealed] = useState(jobId ? 1 : END);   // rows shown so far: never ahead of the server
  const [paste, setPaste] = useState<{ text: string; reading: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => setD((await web<DraftView>('GET', `/drafts/${draftId}`)).data);

  /** Follow a job until it ends, reloading the draft as stages arrive (pending uses resolve in place). */
  const follow = async (id: string) => {
    for (;;) {
      const j = (await web<{ job: ImportJob }>('GET', `/imports/${id}`)).data.job;
      setJob(j);
      if (j.stagesCompleted.length > 1) await load();
      if (!live(j)) return j;
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  useEffect(() => { void (async () => { if (jobId) await follow(jobId); await load(); })(); }, [draftId, jobId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const done = (k: string) => !job || job.stagesCompleted.includes(k as ImportJob['stagesCompleted'][number]);
  const returned = 1 + STAGES.filter(([k]) => done(k)).length + (live(job) ? 0 : 1);
  useEffect(() => {   // pace the rows the backend already returned, one at a time
    if (revealed >= returned) return;
    const t = window.setTimeout(() => setRevealed((r) => r + 1), 1250);
    return () => window.clearTimeout(t);
  }, [revealed, returned]);

  const draft = d?.draft ?? null, c = draft?.content ?? null, src = d?.sources[0];
  const reading = !d || !c || revealed < END;
  if (reading) {
    const pages = src?.pageCount ? `${src.pageCount} page${src.pageCount > 1 ? 's' : ''}` : 'pasted text';
    const uses = c?.ingredients.reduce((n, i) => n + i.uses.length, 0) ?? 0;
    const detail: Record<string, string> = {
      reading: `${src?.displayName ?? ''} · ${pages}`, recipeFound: c ? [c.title, c.meta].filter(Boolean).join(' · ') : '',
      ingredientsAndSteps: c ? `${c.ingredients.length} ingredients · ${c.steps.length} steps` : '', uses: `${uses} ingredient uses linked to steps`,
      coverage: c ? statusCounts(c).map((x) => `${x.n} ${x.label.toLowerCase()}`).join(' · ') : '',
    };
    const rows = [{ label: 'Uploading', detail: `${src?.displayName ?? 'Your recipe'} · received`, ok: true }, ...STAGES.map(([k, label]) => ({ label, detail: detail[k], ok: done(k) }))];
    return <div className="scroll" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '44px 24px' }}><div style={{ width: '100%', maxWidth: 800, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 style={{ fontSize: 30 }}>Reading {src?.displayName ?? 'your recipe'}</h2>
        <ol aria-label="Reading progress" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((g, i) => { const shown = g.ok && i < revealed, active = !shown && i === revealed; return <li key={g.label} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0,1fr)', gap: 10, alignItems: 'baseline', padding: '12px 16px', borderRadius: 12, background: 'var(--cc-surface)', border: '1px solid var(--cc-border)' }}>
            {shown ? <><strong style={{ fontSize: 18 }}>✓</strong><span className="in" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><strong style={{ fontSize: 18 }}>{g.label}</strong><span style={{ fontSize: 17 }}>{g.detail}</span></span></>
              : active ? <><span style={{ width: 12, height: 12, borderRadius: 6, background: 'var(--cc-processing)', animation: 'ccDot 1s infinite', display: 'inline-block' }} /><strong style={{ fontSize: 18, color: 'var(--cc-processing)' }}>{g.label}…</strong></>
                : <><span className="muted" style={{ fontSize: 18 }}>○</span><span className="muted" style={{ fontSize: 18 }}>{g.label}</span></>}
          </li>; })}
        </ol>
      </div></div>
      {activity}
    </div>;
  }

  const counts = statusCounts(c);
  const pendingN = counts.find((x) => x.s === 'pending')?.n ?? 0;
  const saved = !!draft!.savedAs && draft!.savedAs.draftRevision === draft!.revision;
  const stillOpen = draft!.blockers.map((b) => b.message);
  const retryChecks = async (jobId: string) => {
    setBusy(true); setErr(null);
    const r = await web<{ job?: ImportJob; error?: { code: string } }>('POST', `/imports/${jobId}/retry`, {}, {}, 'Check the remaining uses again');
    if (!r.data.job) setErr(r.data.error?.code === 'RETRY_LIMIT' ? 'These uses have been checked as many times as they can be.' : 'Checking didn’t start. Try again.');
    else await follow(r.data.job.id);
    await load(); setBusy(false);
  };
  const choose = async (ingredientId: string, option: number) => {
    setBusy(true); setErr(null);
    const r = await web<{ draft?: WireDraft; error?: { code: string } }>('POST', `/drafts/${draftId}/choices`, { expectedRevision: draft!.revision, ingredientId, option }, {}, 'Choose from the recipe');
    if (r.data.draft) setD({ ...d!, draft: r.data.draft }); else { setErr('That choice wasn’t recorded. The recipe may have changed; it has been reloaded.'); await load(); }
    setBusy(false);
  };
  const answer = async (questionId: string, value: 'yes' | 'no') => {
    setBusy(true); setErr(null);
    const r = await web<{ draft?: WireDraft; error?: { code: string } }>('POST', `/drafts/${draftId}/confirmations`, { expectedRevision: draft!.revision, answers: [{ questionId, answer: value }] }, {}, 'Confirm a recipe detail');
    if (r.data.draft) setD({ ...d!, draft: r.data.draft }); else { setErr('That answer wasn’t recorded. The recipe may have changed; it has been reloaded.'); await load(); }
    setBusy(false);
  };
  const appendText = async () => {
    if (!paste?.text.trim()) return;
    setPaste({ ...paste, reading: true }); setErr(null);
    const r = await web<{ job?: ImportJob; error?: { code: string } }>('POST', `/drafts/${draftId}/append-text`, { expectedRevision: draft!.revision, text: paste.text }, {}, 'Add pasted steps');
    if (!r.data.job) { setErr('Those steps couldn’t be added.'); setPaste({ ...paste, reading: false }); return; }
    const j = await follow(r.data.job.id);
    if (j.state === 'failed') setErr(j.failure?.message ?? 'Those steps couldn’t be read.');
    await load(); setPaste(null);
  };
  const save = async () => {
    setBusy(true); setErr(null);
    const r = await web<{ recipeId?: string; error?: { code: string } }>('POST', `/drafts/${draftId}/save`, { expectedRevision: draft!.revision }, { 'idempotency-key': newId() }, 'Save to Recipe Book');
    setBusy(false);
    if (r.data.recipeId) onSaved(r.data.recipeId, stillOpen); else { setErr('It wasn’t saved. Try again.'); await load(); }
  };
  const banner = <>
    {draft!.blockers.map((b) => <div key={b.id} className="attention" style={{ flex: '1 1 100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 4 }}><span className="eyebrow">{b.kind === 'chooseOption' ? 'Next · your recipe gives a choice' : 'Next · incomplete reading'}</span><span style={{ fontSize: 17 }}><strong>{b.message}</strong> {b.kind === 'chooseOption' ? 'The recipe can be saved, and started once you choose.' : b.kind === 'unclearLine' ? 'It can’t be started until that line is clear.' : 'Uses in those steps can’t be checked until the steps are added.'}</span></div>
      {b.resolution?.action === 'choose' && <div role="group" aria-label={b.message} data-testid="option-choice" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {b.resolution.options.map((o) => <button key={o.index} className="b" disabled={busy} onClick={() => void choose(b.resolution!.action === 'choose' ? (b.resolution as { ingredientId: string }).ingredientId : '', o.index)}>{o.text}</button>)}</div>}
      {!paste && b.resolution?.action === 'appendText' && <button className="b primary" onClick={() => setPaste({ text: '', reading: false })}>{b.resolution.label}</button>}
      {paste && <div style={{ flex: '1 1 100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea value={paste.text} readOnly={paste.reading} onChange={(e) => setPaste({ ...paste, text: e.target.value })} aria-label="Pasted steps" placeholder="Paste the missing steps exactly as they appear in your recipe." style={{ width: '100%', height: 110, fontSize: 15, border: '1.5px solid var(--cc-border-strong)', borderRadius: 8, padding: 8 }} />
        {paste.reading && <span role="status" style={{ fontWeight: 700 }}><span className="dots"><i /><i /><i /></span> Reading the pasted steps…</span>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><button className="b primary" disabled={paste.reading || !paste.text.trim()} onClick={() => void appendText()}>Add these steps</button><button className="b" disabled={paste.reading} onClick={() => setPaste(null)}>Cancel</button>
          <span className="muted" style={{ fontSize: 14 }}>Your original file is kept as it was. The pasted text is kept as a separate source.</span></div>
      </div>}
    </div>)}
    {draft!.unchecked && <div role="status" data-testid="unchecked" className="attention" style={{ flex: '1 1 100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 4 }}><span className="eyebrow">Not checked yet</span>
        <span style={{ fontSize: 17 }}><strong>{draft!.unchecked.reason}</strong> {draft!.unchecked.uses} {draft!.unchecked.uses === 1 ? 'use wasn’t' : 'uses weren’t'} checked for alternatives. The recipe as read is kept; nothing is guessed for them.</span></div>
      {draft!.unchecked.canRetry && <button className="b primary" disabled={busy || live(job)} onClick={() => void retryChecks(draft!.unchecked!.jobId)}>Check them again</button>}
    </div>}
    {draft!.questions.length > 0 && !saved && <section aria-label="Confirm details from your recipe" data-testid="questions" style={{ flex: '1 1 100%', display: 'flex', flexDirection: 'column', gap: 10, border: '1.5px solid var(--cc-border-strong)', borderRadius: 12, padding: '12px 16px', background: 'var(--cc-surface)' }}>
      <span className="eyebrow">Confirm from your recipe · {draft!.questions.length} {draft!.questions.length === 1 ? 'question' : 'questions'}</span>
      <span className="muted" style={{ fontSize: 15 }}>A reviewed change can apply to this recipe once you confirm these. Only you can tell from your recipe; CourseCorrect doesn’t guess. Skip any you aren’t sure of.</span>
      {draft!.questions.map((q) => <div key={q.id} data-testid="review-question" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--cc-border)', paddingTop: 8 }}>
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <strong style={{ fontSize: 17 }}>{q.prompt}</strong>
          {q.quote && <span className="muted" style={{ fontSize: 14 }}>Your recipe: “{q.quote.length > 180 ? `${q.quote.slice(0, 180)}…` : q.quote}”</span>}
          <span style={{ fontSize: 14 }}>Lets {q.unlocks.map((u) => `“${u.title}”`).join(' and ')} apply.</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}><button className="b sm primary" disabled={busy} onClick={() => void answer(q.id, 'yes')}>Yes</button><button className="b sm" disabled={busy} onClick={() => void answer(q.id, 'no')}>No</button></div>
      </div>)}
    </section>}
    {err && <div role="alert" className="attention" style={{ flex: '1 1 100%', fontWeight: 700 }}>{err}</div>}
  </>;
  const note = saved ? 'In your Recipe Book. Nothing in the recipe was changed.'
    : pendingN ? `${pendingN} ${pendingN === 1 ? 'use is' : 'uses are'} still being checked. You can save when checking finishes.`
      : stillOpen.length ? `You can save now. It can’t be started until ${draft!.blockers.some((b) => b.kind === 'chooseOption') ? 'you choose from your recipe’s options' : 'the missing steps are added'}.`
        : 'Saving keeps the recipe and every alternative found. Nothing in the recipe is changed.';
  return <Review content={c} sourceLines={d!.sourceLines} sourceName={src?.displayName ?? null} sourceRefs={draft!.sourceRefs} wide={wide} banner={banner}
    footer={<div style={{ flex: 'none', borderTop: '1px solid var(--cc-border-strong)', background: 'var(--cc-surface)' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '10px 22px' }}>
        <span data-testid="save-note" style={{ flex: 1, fontSize: 16, color: 'var(--cc-text-2)' }}>{note}</span>
        {saved ? <button className="b" onClick={() => onPage(draft!.savedAs!.recipeId)}>Open the recipe</button>
          : <button className="b primary" disabled={busy || pendingN > 0 || live(job)} onClick={() => void save()}>{draft!.savedAs ? 'Save changes as a new version' : 'Save to Recipe Book'}</button>}
      </div>
      {activity}
    </div>} />;
}
