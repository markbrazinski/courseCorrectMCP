// Import canvas: how the recipe was read, each use's role and its swap plan (a reviewed rule's, or the use's import card,
// labelled "Prepared at import (AI)"), all rendered by the server at reading time. Nothing here asks the cook to confirm
// anything (owner decision 2026-10-02).
import { useEffect, useMemo, useState } from 'react';
import { newId, web, type ImportJob, type RecipeContent, type SourceLine, type WireDraft, type WireSourceDoc } from './api.ts';

type Ing = NonNullable<WireDraft['content']>['ingredients'][number];
type Use = Ing['uses'][number];
interface DraftView { draft: WireDraft; sources: WireSourceDoc[]; sourceLines: SourceLine[] }
const STAGES = [['reading', 'Reading the source'], ['recipeFound', 'Finding the recipe'], ['ingredientsAndSteps', 'Ingredients and steps'], ['uses', 'Where each is used'], ['proposedFunctions', 'What each one does'], ['coverage', 'Swaps worked out']] as const;
const roleOf = (u: Use) => u.reviewedFunction ? u.reviewedFunction.labels.join(' · ') : u.swap.role ? `${u.swap.role} (AI)` : 'Not worked out yet';
const mark = (w: Use['swap']) => (w.kind === 'recovery' ? (w.origin === 'reviewed' ? '◆ swap ready' : '◇ swap (AI)') : w.kind === 'covered' ? '↳ covered' : w.kind === 'refusal' ? '✕ no swap' : '');


async function poll(jobId: string): Promise<ImportJob> {
  for (;;) {
    const j = (await web<{ job: ImportJob }>('GET', `/imports/${jobId}`)).data.job;
    if (j.state !== 'running' && j.state !== 'queued') return j;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function Canvas({ draftId, jobId, wide, onSaved, onPage }: {
  draftId: string; jobId: string | null; wide: boolean; onSaved: (recipeId: string, stillOpen: string[]) => void; onPage: (recipeId: string) => void;
}) {
  const [d, setD] = useState<DraftView | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [revealed, setRevealed] = useState(jobId ? 1 : 6);
  const [sel, setSel] = useState<string | null>(null);
  const [paste, setPaste] = useState<{ text: string; reading: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => setD((await web<DraftView>('GET', `/drafts/${draftId}`)).data);

  useEffect(() => {
    void (async () => { if (jobId) setJob(await poll(jobId)); await load(); })();
  }, [draftId, jobId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const target = job ? job.stagesCompleted.length : 6;
  useEffect(() => {   // pace the reveal of stages the backend already returned; never ahead of them
    if (revealed >= target) return;
    const t = window.setTimeout(() => setRevealed((r) => r + 1), 900);
    return () => window.clearTimeout(t);
  }, [revealed, target]);

  const c = d?.draft.content ?? null;
  const multi = useMemo(() => c?.ingredients.find((i) => new Set(i.uses.map((u) => u.stepId)).size > 1) ?? null, [c]);
  if (!d) return <div style={{ padding: 40 }} className="muted">Reading…</div>;
  const draft = d.draft;
  const src = d.sources[0];
  const show = (stage: (typeof STAGES)[number][0]) => STAGES.findIndex(([s]) => s === stage) < revealed && (job?.stagesCompleted.includes(stage) ?? true);
  const revealing = revealed < target;
  const ord = (stepId: string) => c?.steps.find((s) => s.id === stepId)?.ordinal ?? 0;
  const allUses = c?.ingredients.flatMap((i) => i.uses.map((u) => ({ u, ing: i }))) ?? [];
  const selected = allUses.find((x) => x.u.id === sel) ?? null;
  const selRef = sel ? draft.sourceRefs[sel] ?? null : null;
  const saved = draft.savedAs && draft.savedAs.draftRevision === draft.revision;
  const stillOpen = draft.blockers.map((b) => b.message);
  const steps = c?.steps ?? [];
  const cols = `minmax(150px,1.3fr) repeat(${steps.length}, minmax(76px,1fr))`;

  const appendText = async () => {
    if (!paste?.text.trim()) return;
    setPaste({ ...paste, reading: true }); setErr(null);
    const r = await web<{ job?: ImportJob; error?: { code: string } }>('POST', `/drafts/${draftId}/append-text`, { expectedRevision: draft.revision, text: paste.text }, {}, 'Add pasted steps');
    if (!r.data.job) { setErr('Those steps couldn’t be added.'); setPaste({ ...paste, reading: false }); return; }
    const j = await poll(r.data.job.id);
    setJob(j); setRevealed(j.stagesCompleted.length);
    if (j.state === 'failed') setErr(j.failure?.message ?? 'Those steps couldn’t be read.');
    await load(); setPaste(null);
  };
  const save = async () => {
    setBusy(true); setErr(null);
    const r = await web<{ recipeId?: string; error?: { code: string } }>('POST', `/drafts/${draftId}/save`, { expectedRevision: draft.revision }, { 'idempotency-key': newId() }, 'Save to Recipe Book');
    setBusy(false);
    if (r.data.recipeId) onSaved(r.data.recipeId, stillOpen); else { setErr('It wasn’t saved. Try again.'); await load(); }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 'none', padding: '14px 24px', borderBottom: '1px solid var(--cc-border)', background: 'var(--cc-surface)', display: 'flex', gap: 24, alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '0 1 300px' }}>
          <span className="eyebrow">How {src?.displayName ?? 'it'} was read</span>
          {c && show('recipeFound') ? <span className="in" style={{ fontFamily: 'var(--cc-font-head)', fontSize: 24, fontWeight: 700 }}>{c.title}</span> : <span className="muted" style={{ fontSize: 18 }}>Finding the recipe…</span>}
        </div>
        <ol aria-label="Reading progress" style={{ flex: 1, display: 'flex', gap: 6, listStyle: 'none', margin: 0, padding: 0, minWidth: 0 }}>
          {STAGES.map(([k, label], i) => {
            const done = show(k), active = !done && i === revealed;
            return <li key={k} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span style={{ height: 6, borderRadius: 3, background: done ? 'var(--cc-text)' : active ? 'var(--cc-processing)' : 'var(--cc-border)', transformOrigin: 'left', animation: done ? 'ccGrow .5s ease-out' : active ? 'ccDot 1.2s infinite' : undefined }} />
              <span style={{ fontSize: 13, fontWeight: done || active ? 700 : 400, color: active ? 'var(--cc-processing)' : done ? undefined : 'var(--cc-text-2)' }}>{done ? `✓ ${label}` : active ? `${label}…` : label}</span></li>;
          })}
        </ol>
        {revealing && <button className="link" onClick={() => setRevealed(target)}>Skip the animation</button>}
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 16, padding: '16px 20px', minHeight: 0 }}>
        {wide && <section aria-label="Source" style={{ flex: '0 0 190px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <span className="eyebrow">Source · {src?.displayName}</span>
          <div className="scroll card" style={{ flex: 1, padding: 12, gap: 3 }}>
            {d.sourceLines.map((l) => {
              const hl = selRef && selRef.lineId === l.lineId && selRef.sourceId === l.sourceDocId;
              return l.image ? <span key={l.sourceDocId + l.lineId} style={{ marginTop: 6, fontSize: 14, padding: '16px 8px', borderRadius: 6, border: '1.5px dashed var(--cc-attention)', background: 'repeating-linear-gradient(135deg,var(--cc-surface) 0 8px,var(--cc-surface-2) 8px 16px)', textAlign: 'center', fontWeight: 600 }}>{l.text}</span>
                : <span key={l.sourceDocId + l.lineId} style={{ fontSize: 14, lineHeight: 1.4, padding: '3px 6px', borderRadius: 4, color: hl ? undefined : 'var(--cc-text-2)', background: hl ? 'var(--cc-surface-2)' : undefined, boxShadow: hl ? 'inset 0 0 0 2px var(--cc-current)' : undefined, fontWeight: hl ? 600 : 400 }}>{l.origin === 'COOK_PASTED' ? '+ ' : ''}{l.text}</span>;
            })}
          </div>
        </section>}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {multi && show('uses') && <div aria-live="polite" className="card in" style={{ border: '2px solid var(--cc-current)', fontSize: 18, fontWeight: 600, display: 'block', padding: '10px 16px' }}>
            {multi.name} is used in more than one step: {multi.uses.map((u) => `step ${ord(u.stepId)}${show('proposedFunctions') && u.reviewedFunction ? ` (${u.reviewedFunction.labels.join(' · ')})` : ''}`).join(', ')}.{show('proposedFunctions') && ' Same ingredient, different job.'}</div>}
          <section aria-label="Where each ingredient is used" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="eyebrow">Where each ingredient is used, and what it does there</span>
            <div className="scroll card" style={{ flex: 1, padding: 0, gap: 0, display: 'block' }}>
              {!c || !show('ingredientsAndSteps') ? <div className="muted" style={{ padding: 24, fontSize: 16 }}>The grid fills in as ingredients and steps are read.</div> : <div style={{ minWidth: 150 + steps.length * 76 }}>
                <div style={{ display: 'grid', gridTemplateColumns: cols, borderBottom: '1px solid var(--cc-border-strong)', position: 'sticky', top: 0, background: 'var(--cc-surface)', zIndex: 1 }}>
                  <span style={{ padding: '9px 12px', fontSize: 13, fontWeight: 700 }}>Ingredient</span>
                  {steps.map((s) => <div key={s.id} style={{ padding: '7px 4px', borderLeft: '1px solid var(--cc-border)', display: 'flex', flexDirection: 'column', textAlign: 'center' }}><span style={{ fontSize: 13, fontWeight: 700 }}>Step {s.ordinal}</span><span className="muted" style={{ fontSize: 12, lineHeight: 1.2 }}>{s.title}</span></div>)}
                </div>
                {c.ingredients.map((g) => {
                  const spot = g === multi && show('uses');
                  return <div key={g.id} style={{ display: 'grid', gridTemplateColumns: cols, borderBottom: '1px solid var(--cc-border)', background: spot ? 'var(--cc-surface-2)' : undefined, boxShadow: spot ? 'inset 0 0 0 2px var(--cc-current)' : undefined }}>
                    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2, justifyContent: 'center' }}>
                      <span style={{ fontSize: 15, fontWeight: spot ? 700 : 600 }}>{g.name}</span><span className="muted" style={{ fontSize: 13 }}>{g.totalAmount.display}</span>
                      {show('uses') && new Set(g.uses.map((u) => u.stepId)).size > 1 && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cc-current)', textTransform: 'uppercase', letterSpacing: '.03em' }}>More than one step</span>}
                      {show('uses') && g.uses.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No use found yet</span>}
                    </div>
                    {steps.map((s) => {
                      const u = g.uses.find((x) => x.stepId === s.id);
                      const on = u && sel === u.id;
                      return <div key={s.id} style={{ borderLeft: '1px solid var(--cc-border)', padding: 4, minHeight: 52, display: 'flex' }}>
                        {u && show('uses') && <button onClick={() => setSel(on ? null : u.id)} aria-pressed={!!on} aria-label={`${g.name}, step ${s.ordinal}, ${u.amount.display ?? 'amount not stated'}`}
                          style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', justifyContent: 'center', textAlign: 'center', overflowWrap: 'anywhere', minWidth: 0, background: on ? 'var(--cc-current)' : 'var(--cc-surface-2)', color: on ? 'var(--cc-on-current)' : undefined, border: `1.5px solid ${on ? 'var(--cc-current)' : 'var(--cc-border-strong)'}`, borderRadius: 6, padding: '5px 4px' }}>
                          <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>{u.amount.display ?? 'not stated'}</span>
                          {show('proposedFunctions') && u.reviewedFunction && <span style={{ fontSize: 12, fontStyle: 'italic', lineHeight: 1.2 }}>{u.reviewedFunction.labels.join(' · ')}</span>}
                          {show('coverage') && mark(u.swap) && <span style={{ fontSize: 12, fontWeight: 700 }}>{mark(u.swap)}</span>}
                        </button>}
                      </div>;
                    })}
                  </div>;
                })}
                <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--cc-border-strong)' }}>
                  <span className="eyebrow">Steps as read</span>
                  {steps.map((q) => <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 8, padding: '6px 8px', borderRadius: 8, background: selected?.u.stepId === q.id ? 'var(--cc-surface-2)' : undefined, boxShadow: selected?.u.stepId === q.id ? 'inset 0 0 0 2px var(--cc-current)' : undefined }}>
                    <strong style={{ fontSize: 16 }}>{q.ordinal}</strong><span style={{ fontSize: 16, lineHeight: 1.4 }}><strong>{q.title}.</strong> {q.text}</span></div>)}
                  {draft.blockers.map((b) => <div key={b.id} className="attention" style={{ fontSize: 16, fontWeight: 700 }}>{b.message}</div>)}
                </div>
              </div>}
            </div>
          </section>
        </div>
        <aside aria-label="Review" style={{ flex: '0 0 290px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          <div className="scroll" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, padding: 2 }}>
            {selected && <div className="card in" style={{ border: '2px solid var(--cc-current)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span className="eyebrow" style={{ color: 'var(--cc-current)' }}>Selected use · step {ord(selected.u.stepId)}</span><button className="link" onClick={() => setSel(null)}>Close</button></div>
              <span style={{ fontSize: 19, fontWeight: 700 }}>{selected.ing.name} · {selected.u.amount.display ?? 'amount not stated'}</span>
              <span style={{ fontSize: 16 }}><strong>{c?.steps.find((s) => s.id === selected.u.stepId)?.title}.</strong> {c?.steps.find((s) => s.id === selected.u.stepId)?.text}</span>
              {selRef && !wide && <span style={{ fontSize: 15, background: 'var(--cc-surface-2)', borderRadius: 6, padding: '6px 8px' }}><strong>Source:</strong> “{selRef.text}”</span>}
              <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '4px 10px', fontSize: 15 }}>
                <span className="muted">Amount</span><span>{selected.u.amount.display ?? 'not stated'}</span>
                <span className="muted">Role</span><span style={{ fontStyle: 'italic' }}>{show('proposedFunctions') ? roleOf(selected.u) : '…'}</span>
                {show('proposedFunctions') && selected.u.proposedFunction && <><span className="muted">Import guessed</span><span className="muted">{selected.u.proposedFunction.labels.join(' · ')} · not used</span></>}
                <span className="muted">Swap</span><span data-testid="swap" style={{ fontWeight: selected.u.swap.kind === 'recovery' ? 700 : 400 }}>{show('coverage') ? selected.u.swap.text : '…'}</span>
                {show('coverage') && selected.u.swap.label && <><span className="muted">Plan</span><span data-testid="swap-label" style={{ fontWeight: 700, color: selected.u.swap.origin === 'importCard' ? 'var(--cc-proposed)' : undefined }}>{selected.u.swap.label}</span></>}
                {show('coverage') && selected.u.swap.opinion && selected.u.swap.opinion !== selected.u.swap.text && <><span className="muted">Opinion</span><span data-testid="swap-opinion">“{selected.u.swap.opinion}”</span></>}
              </div>
              {show('coverage') && selected.u.swap.details.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 15 }}>{selected.u.swap.details.map((x) => <li key={x}>{x}</li>)}</ul>}
              {selected.ing.uses.length > 1 && <span className="muted" style={{ fontSize: 14 }}>Also used: {selected.ing.uses.filter((u) => u.id !== selected.u.id).map((u) => `step ${ord(u.stepId)} (${u.amount.display ?? 'not stated'})`).join(', ')}</span>}
            </div>}
            <div className="card">
              <span className="eyebrow">What was read</span>
              {revealing || !c ? <><span aria-live="polite" style={{ fontSize: 18, fontWeight: 700 }}>{STAGES[Math.min(revealed, 5)][1]}…</span><span className="muted">Nothing is saved yet.</span></>
                : <><span style={{ fontSize: 18, fontWeight: 700 }}>{c.ingredients.length} ingredients · {c.steps.length} steps{draft.blockers.length ? ` (steps 1–${c.steps.length} only)` : ''}</span>
                  <span className="muted" style={{ fontSize: 15, lineHeight: 1.4 }}>Amounts and steps are read from the source. Each use’s role and swap were prepared at import (AI) and checked by code before saving; a reviewed rule is used where one applies. ◆ marks a reviewed swap, ◇ a swap prepared at import (AI).</span></>}
            </div>
            {err && <div role="alert" className="attention" style={{ fontWeight: 700 }}>{err}</div>}
            {!revealing && draft.blockers.map((b) => <div key={b.id} className="attention" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span className="eyebrow">Next · incomplete reading</span>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{b.message}</span>
              {paste ? <><textarea value={paste.text} readOnly={paste.reading} onChange={(e) => setPaste({ ...paste, text: e.target.value })} aria-label="Pasted steps" placeholder="Paste the missing steps exactly as they appear in your recipe." style={{ width: '100%', height: 130, fontSize: 14, border: '1.5px solid var(--cc-border-strong)', borderRadius: 6, padding: 8 }} />
                {paste.reading && <span role="status" style={{ fontWeight: 700 }}><span className="dots"><i /><i /><i /></span> Reading the pasted steps…</span>}
                <div style={{ display: 'flex', gap: 8 }}><button className="b primary" disabled={paste.reading || !paste.text.trim()} onClick={() => void appendText()}>Add these steps</button><button className="b" disabled={paste.reading} onClick={() => setPaste(null)}>Cancel</button></div>
                <span className="muted" style={{ fontSize: 13 }}>Your original file is kept as it was. The pasted text is kept as a separate source.</span></>
                : b.resolution && <button className="b primary" style={{ alignSelf: 'flex-start' }} onClick={() => setPaste({ text: '', reading: false })}>{b.resolution.label}</button>}
            </div>)}
            {!revealing && !draft.blockers.length && !selected && <div className="card" style={{ fontSize: 16 }}>Select a cell to see what each use does and what you could swap if you run out.</div>}
          </div>
          <div className="card" style={{ flex: 'none', border: '1px solid var(--cc-border-strong)' }}>
            {saved ? <><span style={{ fontSize: 16, fontWeight: 700 }}>In your Recipe Book</span><button className="b" onClick={() => onPage(draft.savedAs!.recipeId)}>Open the recipe</button></>
              : <><span style={{ fontSize: 15 }}>Saving keeps this recipe as read, with its swap plan, so you can cook from it.</span>
                {stillOpen.length > 0 && <span className="muted" style={{ fontSize: 14 }}>Still open after saving: {stillOpen.join(' ')}</span>}
                {revealing || job?.state === 'running' ? <button className="b" disabled>Save when reading finishes</button>
                  : <button className="b primary" disabled={busy || !c} onClick={() => void save()}>{draft.savedAs ? 'Save changes as a new version' : 'Save to Recipe Book'}</button>}</>}
          </div>
        </aside>
      </div>
    </div>
  );
}
