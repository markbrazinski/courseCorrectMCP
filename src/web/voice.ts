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
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
const SR = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

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
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false;
    final.current = '';
    let failed = false;
    r.onresult = (e) => {
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final.current = res[0].transcript; else interim += res[0].transcript;
      }
      setState({ kind: 'listening', interim: (final.current || interim).trim() });
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
  return { state, setState, start, stop, cancel, say, repeat, stopSpeaking, lastSpoken, supported: !!SR };
}

export { route, type Routed } from './route.ts';
