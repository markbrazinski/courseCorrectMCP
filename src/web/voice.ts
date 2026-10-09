// Voice: browser speech-to-text in, server-mediated Polly out. Half duplex: listening stops playback.
// "Listening" is shown only while recognition is actually running. Nothing here mutates state; recognized text goes
// through the same router and tools as typed text.
import { useCallback, useEffect, useRef, useState } from 'react';
import { speechAudio } from './api.ts';

export type VoiceState =
  | { kind: 'ready' } | { kind: 'listening'; interim: string } | { kind: 'heard'; text: string }
  | { kind: 'speaking'; text: string } | { kind: 'clarify'; message: string } | { kind: 'info'; message: string } | { kind: 'stopped' }
  | { kind: 'unavailable'; reason: 'unsupported' | 'permissionDenied' | 'network' };

interface Rec { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; onstart: (() => void) | null }
const SR = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

const PAUSE_MS = 1500;   // this much silence after speech ends the request

export function useVoice(onFinal: (text: string) => void) {
  const [state, setState] = useState<VoiceState>(SR ? { kind: 'ready' } : { kind: 'unavailable', reason: 'unsupported' });
  const [lastSpoken, setLastSpoken] = useState<{ text: string; url: string | null } | null>(null);
  const rec = useRef<Rec | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const final = useRef('');
  const finalCb = useRef(onFinal);
  finalCb.current = onFinal;

  const stopSpeaking = useCallback(() => { audio.current?.pause(); setState((s) => (s.kind === 'speaking' ? { kind: 'ready' } : s)); }, []);

  const start = useCallback(() => {
    if (!SR) return;
    audio.current?.pause();
    const r = new SR();
    // continuous, ended by our own pause: Chrome's single-phrase mode stops at the first breath ("I don't have white wine.
    // [pause] Will lemon juice work?" arrived as its first sentence only)
    r.lang = 'en-US'; r.interimResults = true; r.continuous = true;
    final.current = '';
    let failed = false, quiet = 0;
    r.onresult = (e) => {
      const fin: string[] = [], interim: string[] = [];
      for (let i = 0; i < e.results.length; i++) { const res = e.results[i]; (res.isFinal ? fin : interim).push(res[0].transcript.trim()); }
      final.current = fin.join(' ');
      setState({ kind: 'listening', interim: [...fin, ...interim].join(' ').trim() });
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => r.stop(), PAUSE_MS);
    };
    r.onerror = (e) => {
      failed = true;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setState({ kind: 'unavailable', reason: 'permissionDenied' });
      else if (e.error === 'no-speech') setState({ kind: 'clarify', message: "I didn't hear anything." });
      else if (e.error === 'aborted') setState({ kind: 'stopped' });
      else if (e.error === 'network') setState({ kind: 'unavailable', reason: 'network' });
      else setState({ kind: 'clarify', message: `Speech recognition stopped (${e.error}).` });
    };
    r.onend = () => {
      window.clearTimeout(quiet);
      rec.current = null;
      const text = final.current.trim();
      if (text) finalCb.current(text);
      else if (!failed) setState({ kind: 'stopped' });
    };
    rec.current = r;
    setState({ kind: 'listening', interim: '' });
    r.start();
  }, []);
  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const cancel = useCallback(() => { final.current = ''; rec.current?.abort(); }, []);

  /** Speak server-rendered text (by reference); shows the text whether or not audio plays. */
  const say = useCallback(async (text: string, ref: Parameters<typeof speechAudio>[0] | null, enabled: boolean) => {
    if (!enabled || !ref) { setLastSpoken({ text, url: null }); return; }
    const a = await speechAudio(ref);
    if (!a.ok) { setLastSpoken({ text, url: null }); setState({ kind: 'clarify', message: `Spoken reply unavailable: ${a.message}` }); return; }
    setLastSpoken({ text, url: a.url });
    if (rec.current) return;                                   // never talk over the cook
    play(a.url, text);
  }, []);
  const play = (url: string, text: string) => {
    audio.current?.pause();
    const el = new Audio(url);
    audio.current = el;
    el.onended = () => setState((s) => (s.kind === 'speaking' ? { kind: 'ready' } : s));
    setState({ kind: 'speaking', text });
    el.play().catch(() => setState({ kind: 'clarify', message: 'The browser blocked audio playback. Tap Repeat.' }));
  };
  const repeat = useCallback(() => { if (lastSpoken?.url) play(lastSpoken.url, lastSpoken.text); }, [lastSpoken]);

  useEffect(() => () => { rec.current?.abort(); audio.current?.pause(); }, []);
  return { state, setState, start, stop, cancel, say, repeat, stopSpeaking, lastSpoken, audio, supported: !!SR };
}

export { route, type Routed } from './route.ts';
