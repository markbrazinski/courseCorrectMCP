// CourseCorrect companion: HF v1 Index Card on the reconciled FE–BE contract. The UI computes no culinary facts; every
// outcome, amount and consequence is rendered from server responses.
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  activityFrom, activitySince, call, newId, onWebLog, prefs, startActivityScope, startOver, web, webEntries,
  type Active, type ActivityEntry, type ImportJob, type RecipeBookEntry, type RecipeContent, type Rejected, type SourceLine, type SpeechRef, type WireRun,
} from './api.ts';
import { Canvas } from './canvas.tsx';
import { Review, type SourceRef } from './review.tsx';
import { Cooking, type CookingHandle } from './cooking.tsx';
import { route, useVoice, type VoiceState } from './voice.ts';

type Screen = { kind: 'book' } | { kind: 'page'; recipeId: string; savedOpen?: string[] | null } | { kind: 'canvas'; draftId: string; jobId: string | null } | { kind: 'cooking' };
type Sheet = null | { step: 'pdf' | 'paste' } | { step: 'switch'; to: { recipeId: string; versionId: string; title: string } };

function useWide() {
  const q = '(min-width: 1280px)';
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => setWide(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return wide;
}

function App() {
  const wide = useWide();
  const [screen, setScreen] = useState<Screen>({ kind: 'book' });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [book, setBook] = useState<RecipeBookEntry[] | null>(null);
  const [actOpen, setActOpen] = useState(false);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [speechOn, setSpeechOn] = useState(() => prefs.get('speech') !== 'off');   // on unless this viewer turned it off
  const [signedIn, setSignedIn] = useState(false);   // the deployed service: each sign-in is its own kitchen
  const [agent, setAgent] = useState<{ endpoint: string; token: string; expiresAt: string } | null>(null);
  useEffect(() => { void fetch('/health').then((r) => r.json()).then((h: { speech?: string; signIn?: boolean }) => { setSpeechAvailable(h.speech === 'polly'); setSignedIn(h.signIn === true); }).catch(() => undefined); }, []);
  const [typed, setTyped] = useState('');
  const [heardText, setHeardText] = useState<string | null>(null);
  const cooking = useRef<CookingHandle | null>(null);

  const refresh = useCallback(async () => { const a = await call<Active>('get_active_recipe'); setActive(a); return a; }, []);
  const loadBook = useCallback(async () => { setBook((await call<{ recipes: RecipeBookEntry[] }>('list_recipes')).recipes); }, []);
  useEffect(() => {
    void Promise.all([refresh(), loadBook()]).then(([a]) => {
      if (a.run && sessionStorage.getItem('cc.pendingApply')) setScreen({ kind: 'cooking' });
    });
  }, [refresh, loadBook]);

  const routeText = (text: string, channel: 'voice' | 'typed') => {
    const r = route(text);
    if (screen.kind !== 'cooking' || !cooking.current) return voice.setState({ kind: 'clarify', message: active?.run ? 'Resume cooking first, then ask.' : 'Open a recipe and start cooking first.' });
    const msg = cooking.current.handle(r, channel);
    voice.setState(typeof msg === 'string' ? { kind: 'clarify', message: msg } : msg ? { kind: 'info', message: msg.info } : { kind: 'ready' });
  };
  const routeRef = useRef(routeText);
  routeRef.current = routeText;
  // Owner amendment 2026-10-02 to ESOD §8.5: a spoken request sends itself after a short pause; Cancel or editing stops it.
  const autoSend = useRef<number | null>(null);
  const cancelAuto = () => { if (autoSend.current) { window.clearTimeout(autoSend.current); autoSend.current = null; } };
  const voice = useVoice((text) => {
    const r = route(text);
    if (r.kind !== 'rescue' || cooking.current?.awaitingAnswer()) { routeText(text, 'voice'); return; }   // answers to an open question go straight in
    setTyped(text); setHeardText(text); voice.setState({ kind: 'heard', text });
    cancelAuto();
    autoSend.current = window.setTimeout(() => { autoSend.current = null; setTyped(''); setHeardText(null); routeRef.current(text, 'voice'); }, AUTO_SEND_MS);
  });
  const speak = useCallback((text: string, ref: SpeechRef | null) => { void voice.say(text, ref, speechOn && speechAvailable); }, [voice.say, speechOn, speechAvailable]);
  const send = () => {
    cancelAuto();
    const text = typed.trim();
    if (!text) return;
    setTyped(''); setHeardText(null);
    routeText(text, heardText === text ? 'voice' : 'typed');
  };

  useEffect(() => {   // Space toggles the mic when focus is not on a control
    const f = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || screen.kind !== 'cooking' || sheet) return;
      const t = e.target as HTMLElement;
      if (t.closest('button,input,textarea,select,a,[contenteditable]')) return;
      e.preventDefault();
      if (voice.state.kind === 'listening') voice.stop(); else if (voice.supported) voice.start();
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [screen.kind, sheet, voice]);

  const run = active?.run ?? null;
  const goBook = () => { setScreen({ kind: 'book' }); void loadBook(); };
  const startRecipe = async (to: { recipeId: string; versionId: string; title: string }, replace?: WireRun) => {
    await startActivityScope();
    const out = await call<{ outcome: 'started'; run: WireRun } | Rejected>('start_recipe', {
      commandId: newId(), recipeId: to.recipeId, recipeVersionId: to.versionId,
      ...(replace ? { replace: { runId: replace.id, epoch: replace.epoch, expectedRevision: replace.revision, confirm: true } } : {}),
    });
    if (out.outcome === 'rejected') {
      if (out.code === 'ACTIVE_RUN_EXISTS') { await refresh(); setSheet({ step: 'switch', to }); return out.message; }
      await refresh(); return out.message;
    }
    setSheet(null); await refresh(); setScreen({ kind: 'cooking' }); void loadBook();
    return null;
  };

  const activeTitle = run ? book?.find((b) => b.recipeId === run.recipeId)?.title ?? active?.recipe?.title ?? 'recipe' : null;
  const curOrd = run && active?.recipe ? (active.recipe.steps.find((s) => s.id === run.currentStepId)?.ordinal ?? null) : null;
  const strip = screen.kind === 'canvas' || screen.kind === 'page';   // the review screens carry the compact Activity strip (HF Import Review)
  const showAct = (wide || actOpen) && !strip;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{ height: 56, flex: 'none', background: 'var(--cc-chrome)', color: 'var(--cc-on-chrome)', display: 'flex', alignItems: 'center', gap: 22, padding: '0 22px' }}>
        <button onClick={goBook} style={{ background: 'none', border: 'none', padding: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-.01em', fontFamily: 'var(--cc-font-head)', color: 'var(--cc-on-chrome)' }}>CourseCorrect</button>
        <button onClick={goBook} style={{ background: 'none', border: 'none', padding: '4px 0', fontSize: 16, color: 'var(--cc-on-chrome)' }}>Recipe Book</button>
        <div style={{ flex: 1 }} />
        {run && screen.kind !== 'cooking' && <button onClick={async () => { await refresh(); setScreen({ kind: 'cooking' }); }} style={{ background: 'transparent', border: '1.5px solid var(--cc-on-chrome)', borderRadius: 20, padding: '7px 15px', fontSize: 15, fontWeight: 600, color: 'var(--cc-on-chrome)', whiteSpace: 'nowrap' }}>Resume cooking · {activeTitle}{curOrd ? ` · step ${curOrd}` : ''}</button>}
        {signedIn && <button onClick={async () => { const r = await fetch('/mcp-token'); if (r.ok) setAgent(await r.json() as { endpoint: string; token: string; expiresAt: string }); }}
          style={{ background: 'transparent', border: '1.5px solid var(--cc-on-chrome)', borderRadius: 6, padding: '7px 13px', fontSize: 15, color: 'var(--cc-on-chrome)', whiteSpace: 'nowrap' }}>MCP client</button>}
        {signedIn && <button onClick={async () => {
          if (!window.confirm('Start over with an empty kitchen? Recipes you saved and any cooking session stay with this kitchen, not the new one.')) return;
          if (await startOver()) location.assign('/'); else window.alert("Couldn't start over right now. Nothing was changed.");
        }} style={{ background: 'transparent', border: '1.5px solid var(--cc-on-chrome)', borderRadius: 6, padding: '7px 13px', fontSize: 15, color: 'var(--cc-on-chrome)', whiteSpace: 'nowrap' }}>Start over</button>}
        {!wide && !strip && <button onClick={() => setActOpen(!actOpen)} aria-expanded={actOpen} style={{ background: 'transparent', border: '1.5px solid var(--cc-on-chrome)', borderRadius: 6, padding: '7px 13px', fontSize: 15, color: 'var(--cc-on-chrome)' }}>Activity</button>}
      </header>
      {agent && <AgentAccess {...agent} onClose={() => setAgent(null)} />}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {screen.kind === 'book' && <Book book={book} onOpen={(id) => setScreen({ kind: 'page', recipeId: id })} onAdd={() => setSheet({ step: 'pdf' })} />}
          {screen.kind === 'page' && <RecipePage key={screen.recipeId} wide={wide} activity={<ActivityStrip />} recipeId={screen.recipeId} savedOpen={screen.savedOpen ?? null} active={active} activeTitle={activeTitle}
            onCanvas={(draftId) => setScreen({ kind: 'canvas', draftId, jobId: null })} onRemoved={goBook} onStart={startRecipe} onResume={async () => { await refresh(); setScreen({ kind: 'cooking' }); }} />}
          {screen.kind === 'canvas' && <Canvas key={screen.draftId} draftId={screen.draftId} jobId={screen.jobId} wide={wide}
            onSaved={(recipeId, open) => { void loadBook(); setScreen({ kind: 'page', recipeId, savedOpen: open }); }} onPage={(recipeId) => setScreen({ kind: 'page', recipeId })} activity={<ActivityStrip />} />}
          {screen.kind === 'cooking' && active && (
            <Cooking active={active} setActive={setActive} refresh={refresh} speak={speak} handleRef={cooking} wide={wide}
              onLeave={goBook} voiceBar={<VoiceBar state={voice.state} supported={voice.supported} lastSpoken={voice.lastSpoken?.text ?? null} audio={voice.audio}
                onMic={() => (voice.state.kind === 'listening' ? voice.stop() : voice.start())} onStopSpeaking={voice.stopSpeaking} onRepeat={voice.repeat}
                typed={typed} setTyped={(t) => { cancelAuto(); setTyped(t); if (voice.state.kind === 'heard' || voice.state.kind === 'clarify') voice.setState({ kind: 'ready' }); }} onSend={send}
                onCancelHeard={() => { cancelAuto(); setTyped(''); setHeardText(null); voice.setState({ kind: 'stopped' }); }}
                speechOn={speechOn} speechAvailable={speechAvailable} setSpeechOn={(v) => { setSpeechOn(v); prefs.set('speech', v ? 'on' : 'off'); if (!v) voice.stopSpeaking(); }} />} />
          )}
        </main>
        {showAct && <Activity wide={wide} onClose={() => setActOpen(false)} />}
      </div>
      {sheet && <SheetView sheet={sheet} setSheet={setSheet} run={run} activeTitle={activeTitle} curOrd={curOrd}
        onImported={(draftId, jobId) => { setSheet(null); setScreen({ kind: 'canvas', draftId, jobId }); }}
        onResume={async () => { setSheet(null); await refresh(); setScreen({ kind: 'cooking' }); }}
        onSwitch={(to) => { if (run) void startRecipe(to, run); }} />}
    </div>
  );
}

// ---------- Recipe Book ----------
function Book({ book, onOpen, onAdd }: { book: RecipeBookEntry[] | null; onOpen: (id: string) => void; onAdd: () => void }) {
  return (
    <div className="scroll" style={{ flex: 1, padding: '44px 56px' }}>
      <div style={{ maxWidth: 1020, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><h1 style={{ fontSize: 36 }}>Recipe Book</h1><span className="muted" style={{ fontSize: 17 }}>Open a recipe to read it or cook from it.</span></div>
          <button className="b primary" onClick={onAdd}>Add a recipe</button>
        </div>
        {book === null && <span className="muted">Loading…</span>}
        {book?.length === 0 && <div className="card" style={{ border: '2px dashed var(--cc-border-strong)', padding: '56px 40px', alignItems: 'center', textAlign: 'center' }}>
          <h2 style={{ fontSize: 28 }}>Your Recipe Book is empty</h2>
          <span className="muted" style={{ fontSize: 18 }}>Add a recipe from a PDF, or paste its text. CourseCorrect shows you how it was read before you save it.</span>
          <button className="b primary" onClick={onAdd}>Add a recipe</button></div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {book?.map((b) => (
            <button key={b.recipeId} onClick={() => onOpen(b.recipeId)} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1.3fr) auto', gap: 24, alignItems: 'center', padding: '20px 22px', border: '1px solid var(--cc-border)', borderRadius: 12, background: 'var(--cc-surface)', textAlign: 'left' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--cc-font-head)' }}>{b.title}</span><span className="muted" style={{ fontSize: 15 }}>{[b.meta, b.sourceLabel].filter(Boolean).join(' · ')}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                <span className={`tag${b.release.kind === 'eligible' ? '' : ' att'}`}>{b.release.kind === 'eligible' ? 'Saved · can start' : 'Saved · can’t start yet'}</span>
                <span className="muted" style={{ fontSize: 15 }}>{b.release.kind === 'eligible' ? b.release.coverageSummary : b.release.reasons[0]?.message}</span>
              </div>
              <span style={{ fontSize: 16, display: 'flex', gap: 12, alignItems: 'center', whiteSpace: 'nowrap' }}>{b.activeRunId && <span className="tag now" style={{ fontSize: 13 }}>Cooking now</span>}Open →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Saved recipe page: the same review as at import, plus cooking ----------
interface RecipeVersionView {
  version: { id: string; recipeId: string; createdFromDraft: string | null; content: RecipeContent | null; release: RecipeBookEntry['release'] };
  sources: { displayName: string; pageCount: number | null }[]; sourceLines?: SourceLine[]; sourceRefs?: Record<string, SourceRef | null>;
}
function RecipePage({ recipeId, savedOpen, active, activeTitle, onCanvas, onStart, onResume, onRemoved, wide, activity }: {
  recipeId: string; savedOpen: string[] | null; active: Active | null; activeTitle: string | null; wide: boolean; activity: ReactNode;
  onCanvas: (draftId: string) => void; onStart: (to: { recipeId: string; versionId: string; title: string }) => Promise<string | null>; onResume: () => void; onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [v, setV] = useState<RecipeVersionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void web<RecipeVersionView>('GET', `/recipes/${recipeId}`).then((r) => setV(r.data)); }, [recipeId]);
  if (!v) return <div style={{ padding: 48 }} className="muted">Loading…</div>;
  const c = v.version.content, rel = v.version.release;
  const thisCooking = active?.run?.recipeId === recipeId, other = active?.run && !thisCooking;
  const src = v.sources[0];
  const bar = (
    <div style={{ flex: 'none', padding: '12px 22px', borderBottom: '1px solid var(--cc-border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {savedOpen && <div role="status" className="card in" style={{ border: '2px solid var(--cc-text)', fontSize: 18, fontWeight: 700, display: 'block', padding: '10px 14px' }}>
        {rel.kind === 'eligible' ? 'Saved to your Recipe Book. You can start cooking.' : 'Saved to your Recipe Book. It can’t start yet.'}
        {savedOpen.length > 0 && <span style={{ fontWeight: 400 }}> Still open: {savedOpen.join(' ')}</span>}</div>}
      <div style={{ display: 'flex', gap: '10px 20px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`tag${rel.kind === 'eligible' ? '' : ' att'}`} style={{ alignSelf: 'center' }}>{rel.kind === 'eligible' ? 'Saved · can start' : 'Saved · can’t start yet'}</span>
        <span style={{ flex: 1, minWidth: 240, fontSize: 15 }}>{rel.kind === 'eligible' ? rel.coverageSummary : rel.reasons[0]?.message}
          {v.version.createdFromDraft && <> · <button className="link" onClick={() => onCanvas(v.version.createdFromDraft!)}>See how it was read</button></>}</span>
        {other && <span className="muted" style={{ fontSize: 14 }}>You’re cooking {activeTitle}. Starting asks first.</span>}
        {/* archive through the delete_recipe MCP tool: off the book, history kept; refused by the server while it is being cooked */}
        {!thisCooking && !removing && <button className="link" onClick={() => setRemoving(true)}>Remove from Recipe Book</button>}
        {thisCooking && <button className="b primary" onClick={onResume}>Resume cooking</button>}
        {!thisCooking && rel.kind === 'eligible' && <button className="b primary" disabled={busy} onClick={async () => { setBusy(true); setErr(await onStart({ recipeId, versionId: v.version.id, title: c?.title ?? 'this recipe' })); setBusy(false); }}>Start cooking</button>}
        {rel.kind === 'ineligible' && <><button className="b" disabled>Start cooking</button>
          {v.version.createdFromDraft && rel.reasons[0]?.nextAction && <button className="b strong" onClick={() => onCanvas(v.version.createdFromDraft!)}>{rel.reasons[0].nextAction}</button>}</>}
      </div>
      {rel.kind === 'ineligible' && <span style={{ fontSize: 15 }}>Can’t start yet: {rel.reasons.map((r) => r.message).join(' ')}</span>}
      {err && <span role="alert" className="attention" style={{ fontSize: 15 }}>{err}</span>}
      {!thisCooking && removing && <div role="group" aria-label="Remove from Recipe Book" className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15 }}>
        <span>Remove “{c?.title ?? 'this recipe'}” from your Recipe Book? It is archived, not erased: past cooking sessions are kept.</span>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="link" disabled={busy} onClick={() => setRemoving(false)}>Keep it</button>
          <button className="b" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try {
              const entry = (await call<{ recipes: RecipeBookEntry[] }>('list_recipes')).recipes.find((x) => x.recipeId === recipeId);
              if (!entry) { setErr('This recipe is no longer in your Recipe Book.'); return; }
              const out = await call<{ outcome: string; message?: string }>('delete_recipe', { commandId: newId(), recipeId, recipeVersionId: entry.currentVersionId, confirm: true });
              if (out.outcome === 'archived') onRemoved(); else { setErr(out.message ?? 'It wasn’t removed.'); setRemoving(false); }
            } catch { setErr('No response from CourseCorrect. Check the Recipe Book before trying again.'); }
            finally { setBusy(false); }
          }}>Remove</button>
        </div></div>}
    </div>
  );
  return <div data-testid="recipe-page" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    {bar}
    {c ? <Review content={c} sourceLines={v.sourceLines ?? []} sourceName={src?.displayName ?? null} sourceRefs={v.sourceRefs ?? {}} wide={wide} footer={activity} /> : <div className="muted" style={{ flex: 1, padding: 24 }}>This version has no readable content.</div>}
  </div>;
}

// ---------- Add sheet (modal) and switch-session confirmation ----------
function SheetView({ sheet, setSheet, run, activeTitle, curOrd, onImported, onResume, onSwitch }: {
  sheet: NonNullable<Sheet>; setSheet: (s: Sheet) => void; run: WireRun | null; activeTitle: string | null; curOrd: number | null;
  onImported: (draftId: string, jobId: string) => void; onResume: () => void; onSwitch: (to: { recipeId: string; versionId: string; title: string }) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [drag, setDrag] = useState(false);
  // the document holds several recipes (the job waits for a choice); a failed job that may be run again (same job, nothing re-read)
  const [choice, setChoice] = useState<{ jobId: string; choices: { index: number; title: string }[] } | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const key = useRef(newId());
  const uploaded = useRef<{ key: string; file: File; sourceDocId: string } | null>(null);   // a retry reuses the same upload and command
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('button,input,textarea')?.focus(); }, [sheet.step]);
  useEffect(() => () => opener.current?.focus(), []);
  const close = () => { if (!reading) setSheet(null); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Tab' || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea')];
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) { setErr('That file isn’t a PDF. Choose a PDF, or paste the recipe text.'); return; }
    setFile(f); key.current = newId();
  };
  /**
   * A PDF is uploaded (web request; nothing is read yet), then the import itself is the import_recipe MCP tool, so it shows
   * in Activity like any agent's call. Pasted text goes straight to the tool. The draft is never saved here.
   */
  const submit = async (body: Blob | { kind: 'text'; text: string }, headers: Record<string, string>) => {
    setReading(true); setErr(null);
    await startActivityScope();
    try {
      let source: { kind: 'upload'; sourceDocId: string } | { kind: 'text'; text: string };
      if (body instanceof Blob) {
        if (uploaded.current?.key !== key.current || uploaded.current.file !== body) {
          const u = await web<{ sourceDocId?: string; error?: { message: string } }>('POST', '/uploads', body, headers, 'Upload');
          if (u.status !== 201 || !u.data.sourceDocId) { setErr(u.data.error?.message ?? 'That couldn’t be read.'); return; }
          uploaded.current = { key: key.current, file: body as File, sourceDocId: u.data.sourceDocId };
        }
        source = { kind: 'upload', sourceDocId: uploaded.current.sourceDocId };
      } else source = body;
      type Imported = { outcome: 'imported' | 'importing' | 'needsChoice' | 'failed' | 'rejected'; message?: string; job?: ImportJob };
      let r: Imported;
      try { r = await call<Imported>('import_recipe', { commandId: key.current, source }); }
      catch { setErr('No response from CourseCorrect. Try again; the same request is reused, so nothing is read twice.'); return; }
      if (r.outcome === 'rejected') { setErr(r.message ?? 'That couldn’t be read.'); key.current = newId(); return; }
      await settle(r.job);   // the tool returns once the import is accepted; the reading finishes here
    } finally { setReading(false); }
  };
  /** Follow a job to its end: imported (open the review), a choice of recipe, or a failure (retryable or not). */
  const settle = async (j: ImportJob | undefined) => {
    let job = j;
    while (job && (job.state === 'queued' || job.state === 'running')) { await new Promise((ok) => setTimeout(ok, 400)); job = (await web<{ job: ImportJob }>('GET', `/imports/${job.id}`)).data.job; }
    if (job?.state === 'needsChoice') { setChoice({ jobId: job.id, choices: job.choices ?? [] }); return; }
    if (!job || job.state === 'failed') { setErr(job?.failure?.message ?? 'We couldn’t find a recipe in that document.'); setRetryId(job?.canRetry ? job.id : null); if (!job?.canRetry) key.current = newId(); return; }
    onImported(job.draftId, job.id);
  };
  const again = async (path: string, body: object, label: string) => {
    setReading(true); setErr(null); setRetryId(null); setChoice(null);
    try {
      const r = await web<{ job?: ImportJob; error?: { code: string } }>('POST', path, body, {}, label);
      if (!r.data.job) { setErr(r.data.error?.code === 'RETRY_LIMIT' ? 'This import has been tried as many times as it can be. Paste the recipe text instead.' : 'That didn’t start. Try again.'); return; }
      await settle(r.data.job);
    } finally { setReading(false); }
  };
  /** The bundled sample (owner-authored cream scones): read exactly like a PDF the cook chose, so no recipe of your own is needed. */
  const useSample = async () => {
    setErr(null);
    const r = await fetch('/sample/scones-explicit.pdf');
    if (!r.ok) { setErr('The sample recipe isn’t available on this server. Choose a PDF, or paste the recipe text.'); return; }
    const f = new File([await r.blob()], 'scones-explicit.pdf', { type: 'application/pdf' });
    setFile(f); key.current = newId();
    await submit(f, { 'x-filename': encodeURIComponent(f.name) });
  };
  const choiceBox = choice && <div role="group" aria-label="Choose a recipe" data-testid="recipe-choice" style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1.5px solid var(--cc-border-strong)', borderRadius: 12, padding: '14px 16px' }}>
            <strong style={{ fontSize: 18 }}>This document holds {choice.choices.length} recipes. Which one do you want?</strong>
            <span className="muted" style={{ fontSize: 15 }}>Only the one you choose is read. Nothing from the others is mixed in.</span>
            {choice.choices.map((c) => <button key={c.index} className="b" style={{ alignSelf: 'flex-start' }} disabled={reading} onClick={() => void again(`/imports/${choice.jobId}/choose`, { index: c.index }, `Read “${c.title}”`)}>{c.title}</button>)}
          </div>;
  const title = sheet.step === 'switch' ? 'Start a different recipe?' : sheet.step === 'paste' ? 'Paste recipe text' : 'Add a recipe';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(42,33,27,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 30 }} onKeyDown={onKey}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className="in" style={{ width: 580, maxWidth: '100%', maxHeight: '100%', overflow: 'auto', background: 'var(--cc-surface)', borderRadius: 16, padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 20px 50px rgba(42,33,27,.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h2 style={{ fontSize: 26 }}>{title}</h2><button className="link" onClick={close} disabled={reading}>Cancel</button></div>
        {sheet.step === 'pdf' && <>
          {!file ? <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '32px 20px', border: `2px dashed ${drag ? 'var(--cc-current)' : 'var(--cc-border-strong)'}`, borderRadius: 14, background: drag ? 'var(--cc-surface-2)' : 'var(--cc-surface)', cursor: 'pointer', textAlign: 'center' }}>
            <span style={{ fontSize: 20, fontWeight: 700 }}>Drag a recipe PDF here</span><span className="muted">or</span>
            <span className="b primary">Choose a file</span>
            <input type="file" accept="application/pdf,.pdf" aria-label="Choose a recipe PDF" onChange={(e) => pick(e.target.files?.[0])} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%' }} />
          </label> : <div style={{ display: 'flex', gap: 14, alignItems: 'center', border: '1.5px solid var(--cc-border-strong)', borderRadius: 12, padding: '14px 16px', background: 'var(--cc-surface-2)' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}><strong style={{ fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</strong><span className="muted">PDF · {Math.max(1, Math.round(file.size / 1024))} KB</span></div>
            <button className="link" disabled={reading} onClick={() => { setFile(null); setErr(null); }}>Change file</button></div>}
          {!file && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 15 }}>No recipe handy? Try ours:</span>
            <button data-testid="sample-chip" disabled={reading} onClick={() => void useSample()}
              style={{ border: '1.5px solid var(--cc-border-strong)', borderRadius: 999, background: 'var(--cc-surface-2)', padding: '7px 15px', fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>Cream Scones · sample PDF</button>
          </div>}
          {choiceBox}
          {err && <div role="alert" className="attention" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><strong style={{ fontSize: 17 }}>{err}</strong>{file && <span>Your file is still selected. Choose a different file, or paste the recipe text.</span>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{retryId && <button className="b sm primary" disabled={reading} onClick={() => void again(`/imports/${retryId}/retry`, {}, 'Try the import again')}>Try again</button>}<button className="b sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSheet({ step: 'paste' })}>Paste text instead</button></div></div>}
          {reading && <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 17, fontWeight: 700 }}><span className="dots"><i /><i /><i /></span>Uploading and reading {file?.name}…</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="b primary" disabled={!file || reading} onClick={() => file && void submit(file, { 'x-filename': encodeURIComponent(file.name) })}>Upload and read</button>
            <button className="link" disabled={reading} onClick={() => setSheet({ step: 'paste' })}>Or paste the recipe text</button></div>
        </>}
        {sheet.step === 'paste' && <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 15, fontWeight: 600 }}>Recipe text
            <textarea value={text} readOnly={reading} onChange={(e) => setText(e.target.value)} placeholder="Paste the whole recipe: title, ingredients and steps." style={{ width: '100%', height: 210, border: '1.5px solid var(--cc-border-strong)', borderRadius: 8, padding: 10, fontSize: 15, resize: 'vertical' }} /></label>
          {choiceBox}
          {err && <div role="alert" className="attention" style={{ fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{err}{retryId && <button className="b sm primary" disabled={reading} onClick={() => void again(`/imports/${retryId}/retry`, {}, 'Try the import again')}>Try again</button>}</div>}
          {reading && <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 17, fontWeight: 700 }}><span className="dots"><i /><i /><i /></span>Reading the text…</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><button className="b primary" disabled={!text.trim() || reading} onClick={() => void submit({ kind: 'text', text } as never, {})}>Read this recipe</button><button className="link" disabled={reading} onClick={() => setSheet({ step: 'pdf' })}>Back to PDF</button></div>
        </>}
        {sheet.step === 'switch' && run && <>
          <p style={{ margin: 0, fontSize: 19, lineHeight: 1.45 }}>You’re cooking <strong>{activeTitle}</strong>{curOrd ? `, now at step ${curOrd}` : ''}. Starting {sheet.to.title} ends that session, and your place in it won’t be kept.</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="b primary" onClick={onResume}>Resume {activeTitle}</button><button className="b" onClick={() => onSwitch(sheet.to)}>End it and start {sheet.to.title}</button></div>
        </>}
      </div>
    </div>
  );
}

// ---------- Activity (server-recorded MCP calls + this browser's web requests) ----------
const PILL: Record<string, string> = { ok: 'OK', needsFact: 'Needs a fact', proposed: 'Proposed', refused: 'Refused', failed: 'Rejected', unknown: 'Unknown', applied: 'Applied' };
/** Server-recorded MCP calls (any client) since this view's scope began, newest first, plus this tab's web requests. */
function useActivity() {
  const [mcp, setMcp] = useState<ActivityEntry[]>([]);
  const [webLog, setWebLog] = useState(webEntries().slice());
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => onWebLog(() => setWebLog(webEntries().slice())), []);
  useEffect(() => {
    let last = 0, alive = true, input = Date.now();
    const seen = () => { input = Date.now(); };
    for (const e of ['pointerdown', 'keydown', 'focus'] as const) window.addEventListener(e, seen);
    const tick = async () => {
      // ponytail: each poll is a paid request when deployed, so a hidden tab or one left alone for 10 minutes stops asking until it's used again
      if (document.hidden || Date.now() - input > 10 * 60_000) return;
      const add = await activitySince(last).catch(() => []);
      if (!alive) return;
      if (add.length) { last = add[add.length - 1].seq; setMcp((m) => [...add.reverse(), ...m].slice(0, 200)); setFlash(last); window.setTimeout(() => setFlash(null), 2400); }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 1200);
    return () => { alive = false; window.clearInterval(t); for (const e of ['pointerdown', 'keydown', 'focus'] as const) window.removeEventListener(e, seen); };
  }, []);
  return { mcp: mcp.filter((e) => e.seq > activityFrom()), webLog, flash };
}

/** Import screens (HF Import Review): one line, expandable; real requests only (web from this tab, MCP from the server). */
function ActivityStrip() {
  const { mcp, webLog } = useActivity();
  const [open, setOpen] = useState(false);
  const rows = [...mcp.map((e) => ({ key: `m${e.seq}`, at: e.at, mcp: true, n: e.seq, name: e.name, detail: e.summary, status: PILL[e.status] ?? e.status })),
    ...webLog.map((e) => ({ key: `w${e.seq}`, at: e.at, mcp: false, n: e.seq, name: e.name, detail: e.input, status: e.result }))].sort((a, b) => b.at.localeCompare(a.at));
  const latest = rows[0];
  return <section aria-label="Activity" style={{ flex: 'none', borderTop: '1px solid var(--cc-border)', background: 'var(--cc-surface-2)' }}>
    {open && <div className="scroll" style={{ maxHeight: 170, padding: '8px 22px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No requests yet.</span>}
      {rows.map((e) => <div key={e.key} data-testid={e.mcp ? 'activity-entry' : 'activity-web'} style={{ display: 'grid', gridTemplateColumns: '40px 50px minmax(160px,auto) minmax(0,1fr) auto', gap: 10, fontSize: 13, alignItems: 'baseline' }}>
        <span className="muted">#{e.n}</span>
        <span style={{ border: `1px ${e.mcp ? 'solid var(--cc-text)' : 'dashed var(--cc-border-strong)'}`, borderRadius: 3, padding: '0 4px', textAlign: 'center', fontWeight: e.mcp ? 700 : 400 }}>{e.mcp ? 'MCP' : 'web'}</span>
        <strong>{e.name}</strong><span style={{ overflowWrap: 'anywhere' }}>{e.detail}</span><span className="muted">{e.status}</span>
      </div>)}
    </div>}
    <button onClick={() => setOpen(!open)} aria-expanded={open} style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center', padding: '6px 22px', border: 'none', borderTop: open ? '1px solid var(--cc-border)' : 'none', background: 'var(--cc-surface-2)', textAlign: 'left' }}>
      <strong style={{ fontSize: 13 }}>Activity</strong>
      <span className="muted" style={{ fontSize: 13 }}>{webLog.length} web request{webLog.length === 1 ? '' : 's'} · {mcp.length} MCP call{mcp.length === 1 ? '' : 's'}</span>
      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Latest: {latest ? `${latest.name} · ${latest.status}` : 'none yet'}</span>
      <span style={{ fontSize: 13, textDecoration: 'underline' }}>{open ? 'Hide' : 'Show history'}</span>
    </button>
  </section>;
}

function Activity({ wide, onClose }: { wide: boolean; onClose: () => void }) {
  const { mcp: shown, webLog, flash } = useActivity();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <aside aria-label="Activity" style={{ flex: '0 0 300px', borderLeft: '1px solid var(--cc-border)', background: 'var(--cc-surface-2)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--cc-border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><strong style={{ fontSize: 16 }}>Activity</strong>{!wide && <button className="link" onClick={onClose}>Close</button>}</div>
        <span className="muted" style={{ fontSize: 13, lineHeight: 1.4 }}>MCP tool calls recorded by the server, from any client (this companion or an agent). Newest first.</span>
      </div>
      <div className="scroll" style={{ flex: 1, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        {shown.length === 0 && <span className="muted" style={{ fontSize: 14 }}>No MCP calls yet.</span>}
        {shown.map((e) => (
          <div key={e.seq} style={{ display: 'flex', flexDirection: 'column' }}>
            <button onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq} data-testid="activity-entry"
              style={{ background: 'var(--cc-surface)', border: flash === e.seq ? '2px solid var(--cc-proposed)' : '1px solid var(--cc-border)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', animation: flash === e.seq ? 'ccFlash 2.4s ease-out' : undefined }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}><span className="muted" style={{ fontWeight: 400 }}>#{e.seq}</span> {e.name}</span>
                <span style={{ fontSize: 12, fontWeight: 700, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', border: `1.5px ${e.status === 'refused' || e.status === 'failed' || e.status === 'unknown' ? 'dashed' : 'solid'} ${e.status === 'proposed' ? 'var(--cc-proposed)' : 'var(--cc-border-strong)'}`, background: e.status === 'proposed' ? 'var(--cc-proposed-bg)' : undefined }}>{PILL[e.status] ?? e.status}</span>
              </span>
              <span className="muted" style={{ fontSize: 14, lineHeight: 1.35 }}>{e.summary}</span>
            </button>
            {open === e.seq && <div style={{ background: 'var(--cc-surface)', border: '1px solid var(--cc-border)', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <span className="eyebrow" style={{ fontSize: 12 }}>Input</span><span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(e.input, null, 1)}</span>
              {e.trace?.interpretation && <><span className="eyebrow" style={{ fontSize: 12 }}>Interpretation</span><span>{e.trace.interpretation}</span></>}
              {e.trace?.deterministic && <><span className="eyebrow" style={{ fontSize: 12 }}>Deterministic evaluation</span><span>{e.trace.deterministic}</span></>}
              <span className="muted">{e.durationMs} ms · {new Date(e.at).toLocaleTimeString()}</span>
            </div>}
          </div>
        ))}
        {webLog.length > 0 && <>
          <span className="eyebrow" style={{ marginTop: 10 }}>Import · web requests, not MCP</span>
          {webLog.map((e) => <div key={e.seq} style={{ border: '1.5px dashed var(--cc-border-strong)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}><strong>#{e.seq} {e.name}</strong><span className="muted">{e.input}</span><span>→ {e.result}</span></div>)}
        </>}
      </div>
    </aside>
  );
}

// ---------- Voice bar ----------
/** The reply being spoken, two lines tall: it scrolls with the audio, so the bar never grows with the reply. */
function SpokenText({ text, audio }: { text: string; audio: { current: HTMLAudioElement | null } }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const follow = () => {
      const el = box.current, a = audio.current;
      if (el && a && a.duration > 0) el.scrollTop = (a.currentTime / a.duration) * (el.scrollHeight - el.clientHeight);
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [text, audio]);
  return <div ref={box} data-testid="spoken-text" style={{ fontSize: 17, lineHeight: 1.35, maxHeight: '2.7em', overflow: 'hidden' }}>{text}</div>;
}
const AUTO_SEND_MS = 2000;
function VoiceBar({ state, supported, lastSpoken, audio, onMic, onStopSpeaking, onRepeat, typed, setTyped, onSend, onCancelHeard, speechOn, speechAvailable, setSpeechOn }: {
  state: VoiceState; supported: boolean; lastSpoken: string | null; audio: { current: HTMLAudioElement | null }; onMic: () => void; onStopSpeaking: () => void; onRepeat: () => void;
  typed: string; setTyped: (t: string) => void; onSend: () => void; onCancelHeard: () => void; speechOn: boolean; speechAvailable: boolean; setSpeechOn: (v: boolean) => void;
}) {
  const listening = state.kind === 'listening';
  const unavailable = !supported || state.kind === 'unavailable';
  const reason = state.kind === 'unavailable' ? state.reason : 'unsupported';
  return (
    <div style={{ flex: 'none', borderTop: '1px solid var(--cc-border-strong)', background: 'var(--cc-surface-2)', padding: '10px 20px', display: 'flex', gap: 16, alignItems: 'center', minHeight: 84, flexWrap: 'wrap' }}>
      <button onClick={onMic} disabled={unavailable} aria-label={listening ? 'Stop listening' : 'Start listening'} aria-pressed={listening}
        style={{ width: 62, height: 62, flex: 'none', borderRadius: 31, display: 'flex', alignItems: 'center', justifyContent: 'center', background: listening ? 'var(--cc-listening)' : 'var(--cc-surface)', color: listening ? '#fff' : unavailable ? 'var(--cc-text-2)' : 'var(--cc-text)', border: unavailable ? '2px dashed var(--cc-border-strong)' : `4px solid ${listening ? 'var(--cc-listening)' : 'var(--cc-text)'}` }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d={`M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21${unavailable ? 'M4 4l16 16' : ''}`} /></svg>
      </button>
      <div aria-live="polite" data-testid="voice-state" style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {state.kind === 'ready' && !unavailable && <><span style={{ fontSize: 18, fontWeight: 700 }}>Tap the mic or press Space to talk</span>
          {lastSpoken ? <span className="muted" style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Last said: {lastSpoken} {speechOn && <button className="link" onClick={onRepeat}>Repeat</button>}</span>
            : <span className="muted" style={{ fontSize: 15 }}>Say “next step”, “read it again”, or what’s missing.</span>}</>}
        {listening && <><span style={{ fontSize: 18, fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center' }}><span aria-hidden="true" style={{ display: 'flex', gap: 3, height: 20 }}>{[0, 0.15, 0.3].map((d) => <span key={d} style={{ width: 4, height: 20, background: 'var(--cc-listening)', borderRadius: 2, animation: `ccBar .9s ${d}s ease-in-out infinite` }} />)}</span>Listening…</span>
          <span style={{ fontSize: 19, fontWeight: 600 }}>{state.interim ? `“${state.interim}”` : <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>Speak now. Tap the mic again to stop.</span>}</span></>}
        {state.kind === 'heard' && <><span className="muted" style={{ fontSize: 15 }}>Heard · sending in a moment · edit the text or Cancel to stop</span>
          <span style={{ fontSize: 19, fontWeight: 600, display: 'flex', gap: 10, alignItems: 'baseline' }}>“{state.text}” <button className="b sm" onClick={onCancelHeard}>Cancel</button></span></>}
        {state.kind === 'speaking' && <><span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cc-speaking)', letterSpacing: '.04em', textTransform: 'uppercase' }}>CourseCorrect is saying</span><SpokenText text={state.text} audio={audio} /></>}
        {state.kind === 'clarify' && <><span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cc-attention)', letterSpacing: '.04em', textTransform: 'uppercase' }}>Needs clarification</span><span style={{ fontSize: 18, fontWeight: 700 }}>{state.message}</span></>}
        {state.kind === 'info' && <><span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cc-speaking)', letterSpacing: '.04em', textTransform: 'uppercase' }}>One more</span><span style={{ fontSize: 18, fontWeight: 700 }}>{state.message}</span></>}
        {state.kind === 'stopped' && <><span style={{ fontSize: 18, fontWeight: 700 }}>Stopped listening</span><span className="muted" style={{ fontSize: 15 }}>Nothing was sent.</span></>}
        {unavailable && <><span style={{ fontSize: 18, fontWeight: 700 }}>Microphone unavailable</span><span className="muted" style={{ fontSize: 15 }}>
          {reason === 'permissionDenied' ? 'Microphone permission was blocked. Allow it in the browser, or type your request.' : reason === 'network' ? 'Speech recognition couldn’t reach its service. Type your request instead.' : 'This browser has no speech recognition. Type your request, or use the buttons.'}</span></>}
      </div>
      {state.kind === 'speaking' && <div style={{ display: 'flex', gap: 6 }}><button className="b sm" onClick={onStopSpeaking}>Stop</button><button className="b sm" onClick={onRepeat}>Repeat</button></div>}
      {speechAvailable ? <button className="b sm" aria-pressed={speechOn} onClick={() => setSpeechOn(!speechOn)} style={{ flex: 'none', borderColor: speechOn ? 'var(--cc-speaking)' : undefined, color: speechOn ? 'var(--cc-speaking)' : undefined }}>
        {speechOn ? '🔊 Spoken replies: on' : '🔇 Spoken replies: off'}</button> : <span className="muted" style={{ fontSize: 13, flex: 'none' }}>Spoken replies are off on this server</span>}
      <div style={{ flex: '0 1 400px', minWidth: 260, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }} aria-label="Type a request" placeholder="Type instead, e.g. I don’t have…" style={{ flex: 1, minWidth: 0, border: '1.5px solid var(--cc-border-strong)', borderRadius: 8, padding: '11px 12px', fontSize: 16 }} />
          <button className={`b sm${typed.trim() ? ' primary' : ''}`} disabled={!typed.trim()} onClick={onSend}>Send</button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Speech-to-text runs in your browser (Chrome sends the audio to Google to recognize it). Spoken replies are Amazon Polly, via this server.
        </span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

/** Connect an MCP client to this kitchen: the endpoint and a bearer token for this workspace (deployed service only). */
function AgentAccess({ endpoint, token, expiresAt, onClose }: { endpoint: string; token: string; expiresAt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); };
  const row = (label: string, value: string) => <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    <div style={{ display: 'flex', gap: 8 }}><code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13, padding: '6px 8px', border: '1px solid var(--cc-border)', borderRadius: 6, fontFamily: 'var(--cc-font-mono)' }}>{value}</code>
      <button className="b sm" onClick={() => copy(value)} aria-label={`Copy ${label}`}>Copy</button></div></div>;
  return <div role="dialog" aria-modal="true" aria-labelledby="agent-title" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 50 }}>
    <div className="card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: '100%', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--cc-surface)', color: 'var(--cc-text)' }}>
      <h2 id="agent-title" style={{ fontSize: 22, margin: 0 }}>Connect an MCP client to this kitchen</h2>
      <span className="muted" style={{ fontSize: 14 }}>Streamable HTTP. The client sees and changes this kitchen only, with the same eight tools the companion uses. Keep the token private; it works until {new Date(expiresAt).toLocaleDateString()}.</span>
      {row('Endpoint', endpoint)}
      {row('Header', `Authorization: Bearer ${token}`)}
      {row('Example (MCP Inspector)', `npx @modelcontextprotocol/inspector --cli ${endpoint} --transport http --header "Authorization: Bearer ${token}" --method tools/list`)}
      <button ref={close} className="b" onClick={onClose} style={{ alignSelf: 'flex-end' }}>Close</button>
    </div></div>;
}
