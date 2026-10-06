// Demo editing package: turns one captured take (.artifacts/demo/takes/<take>) into an iMovie-ready folder
// (.artifacts/demo/packages/<take>): originals plus clearly named derivatives (48 kHz WAV, MP4), the script in the beat
// format with actual responses and measured timing, timeline.json/csv, and index.html, a RECORDED PLAYBACK of the take
// that loads only local files (no service, model or speech calls). Run alone: npm run demo:export -- <takeDir> [--polly-speed 1.1]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { Recipe } from '../contract/types.ts';
import { renderStep } from '../domain/recipe.ts';

export const ROOT = join(import.meta.dirname, '../..');

// ---------- timeline (private/demo/timeline.json) ----------
export interface Check { text?: string; testId?: string; button?: string; dialog?: string; nth?: number; count?: number }
export type Target = string | { name: string; hasNotText?: string; first?: boolean };
export interface Action {
  do: 'setup' | 'say' | 'click' | 'upload' | 'review' | 'hold'; fixtureId?: string; text?: string; name?: string; names?: Target[]; inQuestion?: number; file?: string;
  patternId?: string; decisionRef?: string; facts?: { ingredient: string; step: number; functions: string[] }[];
}
export interface Planned { inputS: number; processingS: number; speechS: number; holdS: number }
export interface Cue {
  id: string; title: string; startingState?: string; sourceAssets?: string[]; onScreen?: string; vo?: string[]; alice?: string; coursecorrectPlanned?: string;
  action: Action; sceneStart?: boolean; expect?: { ui?: Check[]; mcp?: { tool: string; status: string }; web?: { path: string; status: number }; rule?: { patternId: string; status: string }; allowRejected?: string[] }; capture?: string[]; planned: Planned; notes?: string[];
  beat: { number: number; title: string; plannedWindow: string };
}
export interface Timeline { schema: string; title: string; status: string; narrationSource: string; conventions: Record<string, string>; beats: { number: number; title: string; plannedWindow: string; cues: Omit<Cue, 'beat'>[] }[] }
export const TIMELINE = join(ROOT, 'private/demo/timeline.json');
export const loadTimeline = (path = TIMELINE) => JSON.parse(readFileSync(path, 'utf8')) as Timeline;
export const cuesOf = (t: Timeline): Cue[] => t.beats.flatMap((b) => b.cues.map((c) => ({ ...c, beat: { number: b.number, title: b.title, plannedWindow: b.plannedWindow } })));

// ---------- what a take records ----------
export interface Clip { n: number; cueId: string; offsetS: number; id: string; text: string; settings: Record<string, unknown>; cached: boolean; durationS: number | null; file: string; status: number }
export interface Attempt {
  cueId: string; attempt: number; status: 'passed' | 'mismatch' | 'interrupted'; error?: string;
  t: { cue: number; actionStart?: number; actionEnd?: number; outcome?: number };
  input?: { mode: string; transcript: string; sent?: { text: string; channel: string } | null; aliceFile?: string | null };
  mcp: { seq: number; tool: string; status: string; summary: string; interpretation?: string | null; durationMs: number }[];
  captured?: Record<string, string>; screenshot?: string; review?: Record<string, unknown>;
}
export interface Manifest {
  kind: 'cc-demo-take/1'; takeId: string; label: string; startedAt: string; endedAt?: string; result?: 'PASSED' | 'FAILED' | 'INCOMPLETE'; golden?: boolean;
  modes: Record<string, string>; labels: string[]; identity: Record<string, unknown>; videoT0: string; restarts: { at: number; fromCue: string }[];
  ledger?: Record<string, unknown>; aliceMic?: { file: string; offsetS: number } | null;
}

const fmt = (s: number | null | undefined) => (s == null ? '' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);
const r1 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const have = (cmd: string) => { try { execFileSync(cmd, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const AUDIO = ['.wav', '.m4a', '.mp3', '.aif', '.aiff'];
export const sourceFor = (dir: string, cueId: string) => AUDIO.map((e) => join(ROOT, dir, `${cueId}${e}`)).find(existsSync) ?? null;

/** Measured timing per cue: the last attempt's marks, the next cue's start for the hold, speech from the clips. */
export function measure(cues: Cue[], attempts: Attempt[], clips: Clip[], endS: number) {
  const last = new Map(attempts.map((a) => [a.cueId, a]));
  const ran = cues.filter((c) => last.has(c.id));
  return new Map(ran.map((c, i) => {
    const a = last.get(c.id)!, next = ran[i + 1] ? last.get(ran[i + 1].id)!.t.cue : endS;
    const cc = clips.filter((x) => x.cueId === c.id && x.status === 200);
    const speechEnd = Math.max(0, ...cc.map((x) => x.offsetS + (x.durationS ?? 0)));
    const ready = Math.max(a.t.outcome ?? a.t.cue, speechEnd);
    return [c.id, {
      status: a.status, startS: a.t.cue, inputS: r1((a.t.actionEnd ?? a.t.cue) - (a.t.actionStart ?? a.t.cue)), processingS: a.t.outcome != null ? r1(a.t.outcome - (a.t.actionEnd ?? a.t.cue)) : null,
      speechS: r1(cc.reduce((s, x) => s + (x.durationS ?? 0), 0)), holdS: r1(next - ready), endS: next,
    }];
  }));
}

export function exportTake(takeDir: string, opts: { pollySpeed?: number } = {}) {
  const m = JSON.parse(readFileSync(join(takeDir, 'manifest.json'), 'utf8')) as Manifest;
  const attempts = JSON.parse(readFileSync(join(takeDir, 'cues.json'), 'utf8')) as Attempt[];
  const clips = JSON.parse(readFileSync(join(takeDir, 'clips.json'), 'utf8')) as Clip[];
  const timeline = loadTimeline(join(takeDir, 'timeline.json'));
  const cues = cuesOf(timeline);
  const out = join(ROOT, '.artifacts/demo/packages', m.takeId);
  for (const d of ['video', 'audio', 'shots', 'evidence']) mkdirSync(join(out, d), { recursive: true });
  const ff = have('ffmpeg'), notes: string[] = [];
  const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  const wav48 = (src: string, dst: string, speed?: number) => ffmpeg(['-i', src, ...(speed ? ['-filter:a', `atempo=${speed}`] : []), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', dst]);

  // video: original webm + MP4 derivative (constant 30 fps, H.264, for iMovie)
  const webm = readdirSync(join(takeDir, 'video')).find((f) => f.endsWith('.webm'));
  let videoS = 0;
  if (webm) {
    copyFileSync(join(takeDir, 'video', webm), join(out, 'video/take.original.webm'));
    if (ff) {
      try { ffmpeg(['-i', join(takeDir, 'video', webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', join(out, 'video/take.mp4')]); }
      catch (e) { notes.push(`MP4 conversion failed: ${(e as Error).message.slice(0, 200)}`); }
    }
    try { videoS = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(out, existsSync(join(out, 'video/take.mp4')) ? 'video/take.mp4' : 'video/take.original.webm')]).toString().trim()) || 0; } catch { /* unknown */ }
  } else notes.push('No screen video in this take.');
  const endS = Math.max(videoS, ...attempts.map((a) => a.t.outcome ?? a.t.cue));
  const timing = measure(cues, attempts, clips, endS);

  // audio, numbered in cue order: VO slot → ALICE → COURSECORRECT
  const assets: { n: number; cueId: string; track: 'VO' | 'ALICE' | 'COURSECORRECT'; file: string; wav: string | null; startS: number | null; durationS: number | null; label: string; text: string }[] = [];
  let n = 0;
  const num = () => String(++n).padStart(2, '0');
  const last = new Map(attempts.map((a) => [a.cueId, a]));
  for (const c of cues) {
    const tm = timing.get(c.id);
    if (c.vo?.length) {
      const src = sourceFor('private/demo/vo', c.id), base = `${num()}-${c.id}-vo`;
      if (src) {
        copyFileSync(src, join(out, 'audio', `${base}${extname(src)}`));
        let wav: string | null = null;
        if (ff) { wav = `${base}.48k.wav`; wav48(src, join(out, 'audio', wav)); }
        assets.push({ n, cueId: c.id, track: 'VO', file: `${base}${extname(src)}`, wav, startS: tm?.startS ?? null, durationS: null, label: 'Mark’s narration recording (original)', text: c.vo.join(' ') });
      } else {
        writeFileSync(join(out, 'audio', `${base}-SLOT.txt`), `VO SLOT ${c.id} — not recorded yet (record it yourself; no narration is generated)\nPlace at ${fmt(tm?.startS)} in take ${m.takeId}.\nTarget: about ${c.planned.holdS + c.planned.speechS} s (planned).\n\n${c.vo.join('\n\n')}\n`);
        assets.push({ n, cueId: c.id, track: 'VO', file: `${base}-SLOT.txt`, wav: null, startS: tm?.startS ?? null, durationS: null, label: 'empty slot', text: c.vo.join(' ') });
      }
    }
    const a = last.get(c.id);
    if (c.alice) {
      const src = sourceFor('private/demo/alice', c.id), base = `${num()}-${c.id}-alice`;
      const mode = a?.input?.mode ?? 'not run';
      if (src) {
        copyFileSync(src, join(out, 'audio', `${base}${extname(src)}`));
        let wav: string | null = null;
        if (ff) { wav = `${base}.48k.wav`; wav48(src, join(out, 'audio', wav)); }
        assets.push({ n, cueId: c.id, track: 'ALICE', file: `${base}${extname(src)}`, wav, startS: a?.t.actionStart ?? null, durationS: null, label: `owner-supplied file ${basename(src)}; input mode in this take: ${mode}`, text: c.alice });
      } else {
        writeFileSync(join(out, 'audio', `${base}-SLOT.txt`), `ALICE SLOT ${c.id} — no prerecorded file supplied (private/demo/alice/${c.id}.wav|m4a)\nInput mode in this take: ${mode}\nTranscript: ${c.alice}\n`);
        assets.push({ n, cueId: c.id, track: 'ALICE', file: `${base}-SLOT.txt`, wav: null, startS: a?.t.actionStart ?? null, durationS: null, label: `empty slot; input mode in this take: ${mode}`, text: c.alice });
      }
    }
    for (const clip of clips.filter((x) => x.cueId === c.id && x.status === 200)) {
      const base = `${num()}-${c.id}-coursecorrect`;
      copyFileSync(join(takeDir, clip.file), join(out, 'audio', `${base}.mp3`));
      writeFileSync(join(out, 'audio', `${base}.json`), JSON.stringify({ text: clip.text, settings: clip.settings, pollyCacheId: clip.id, cachedAtCapture: clip.cached, offsetS: clip.offsetS, durationS: clip.durationS }, null, 1));
      let wav: string | null = null;
      if (ff) { wav = `${base}.48k.wav`; wav48(join(takeDir, clip.file), join(out, 'audio', wav)); }
      if (ff && opts.pollySpeed) { mkdirSync(join(out, 'audio/derived'), { recursive: true }); wav48(join(takeDir, clip.file), join(out, 'audio/derived', `${base}.x${opts.pollySpeed.toFixed(2)}.48k.wav`), opts.pollySpeed); }
      assets.push({ n, cueId: c.id, track: 'COURSECORRECT', file: `${base}.mp3`, wav, startS: clip.offsetS, durationS: clip.durationS, label: `Amazon Polly ${clip.settings.voiceId}/${clip.settings.engine} original${clip.cached ? ' (served from the speech cache)' : ''}`, text: clip.text });
    }
  }
  if (m.aliceMic && existsSync(join(takeDir, m.aliceMic.file))) {
    copyFileSync(join(takeDir, m.aliceMic.file), join(out, 'audio', 'alice-mic-whole-take.wav'));
    notes.push(`ALICE microphone track for the whole take: audio/alice-mic-whole-take.wav, starts at ${fmt(m.aliceMic.offsetS)} of the video.`);
  }
  if (opts.pollySpeed) notes.push(`audio/derived/ holds Polly clips at ${opts.pollySpeed}× (editing derivatives; the originals are unchanged).`);
  if (!ff) notes.push('ffmpeg was not found: no WAV or MP4 derivatives; originals only.');

  // every clip: its cache id recomputes from the exact text and settings, and the text is one the server rendered in this take
  const rendered = new Set<string>();
  if (existsSync(join(takeDir, 'service.db'))) {   // the take's own database, read-only: what the server actually rendered
    const db = new DatabaseSync(join(takeDir, 'service.db'), { readOnly: true });
    for (const e of db.prepare('SELECT result_json FROM evaluations WHERE result_json IS NOT NULL').all() as { result_json: string }[]) rendered.add((JSON.parse(e.result_json) as { wire: { speech: { text: string } } }).wire.speech.text);
    for (const v of db.prepare('SELECT version, recipe_json FROM run_versions').all() as { version: number; recipe_json: string }[]) {
      const r = JSON.parse(v.recipe_json) as Recipe;   // "Change applied." exists only for an amended version
      r.steps.forEach((st, k) => { const t = `Step ${k + 1}. ${renderStep(r, st)}`; rendered.add(t); rendered.add(`Next: ${t}`); if (v.version > 1) rendered.add(`Change applied. ${t}`); });
    }
    db.close();
  }
  const clipCheck = clips.filter((x) => x.status === 200).map((x) => {
    const idOk = createHash('sha256').update(`${x.settings.voiceId}|${x.settings.engine}|${x.text}`).digest('hex') === x.id;
    const bytesOk = existsSync(join(takeDir, x.file)) && existsSync(join(ROOT, '.artifacts/speech-cache', `${x.id}.mp3`))
      && createHash('sha256').update(readFileSync(join(takeDir, x.file))).digest('hex') === createHash('sha256').update(readFileSync(join(ROOT, '.artifacts/speech-cache', `${x.id}.mp3`))).digest('hex');
    return { n: x.n, cueId: x.cueId, idMatchesTextAndSettings: idOk, sameBytesAsCache: bytesOk, textRenderedByServerInThisTake: rendered.has(x.text), text: x.text };
  });
  const clipsOk = clipCheck.every((c) => c.idMatchesTextAndSettings && c.sameBytesAsCache && c.textRenderedByServerInThisTake);
  writeFileSync(join(out, 'evidence/clip-check.json'), JSON.stringify({ allMatch: clipsOk, clips: clipCheck }, null, 1));
  notes.push(`Polly clip check: ${clipsOk ? 'every clip matches its exact response text' : 'MISMATCH — see evidence/clip-check.json'} (${clipCheck.length} clips).`);

  // screenshots + evidence
  if (existsSync(join(takeDir, 'shots'))) for (const f of readdirSync(join(takeDir, 'shots'))) copyFileSync(join(takeDir, 'shots', f), join(out, 'shots', f));
  for (const f of ['manifest.json', 'cues.json', 'clips.json', 'events.jsonl', 'mcp-activity.json', 'server-records.json', 'timeline.json', 'server.log']) if (existsSync(join(takeDir, f))) copyFileSync(join(takeDir, f), join(out, 'evidence', f));

  // timeline.json / timeline.csv: planned beside measured
  const rows = cues.map((c) => {
    const a = last.get(c.id), tm = timing.get(c.id);
    return {
      beat: c.beat.number, cueId: c.id, title: c.title, action: c.action.do, status: tm?.status ?? 'not run',
      aliceText: c.alice ?? '', aliceMode: a?.input?.mode ?? '', sentText: a?.input?.sent?.text ?? '', sentChannel: a?.input?.sent?.channel ?? '',
      coursecorrect: clips.filter((x) => x.cueId === c.id && x.status === 200).map((x) => x.text).join(' ⟂ '),
      interpretation: a?.mcp.map((x) => x.interpretation).filter(Boolean).join(' | ') ?? '',
      planned: c.planned, measured: tm ? { startS: r1(tm.startS), inputS: tm.inputS, processingS: tm.processingS, speechS: tm.speechS, holdS: tm.holdS } : null,
      screenshot: a?.screenshot ?? '', audio: assets.filter((x) => x.cueId === c.id).map((x) => x.file), captured: a?.captured ?? {},
    };
  });
  writeFileSync(join(out, 'timeline.json'), JSON.stringify({ take: m.takeId, result: m.result, golden: m.golden, modes: m.modes, labels: m.labels, cues: rows }, null, 1));
  const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['beat', 'cueId', 'title', 'status', 'aliceText', 'aliceMode', 'sentChannel', 'coursecorrect', 'plannedInputS', 'plannedProcessingS', 'plannedSpeechS', 'plannedHoldS', 'startAt', 'inputS', 'processingS', 'speechS', 'holdS', 'screenshot', 'audio'];
  writeFileSync(join(out, 'timeline.csv'), [head.join(','), ...rows.map((r) => [r.beat, r.cueId, r.title, r.status, r.aliceText, r.aliceMode, r.sentChannel, r.coursecorrect, r.planned.inputS, r.planned.processingS, r.planned.speechS, r.planned.holdS,
    fmt(r.measured?.startS), r.measured?.inputS, r.measured?.processingS, r.measured?.speechS, r.measured?.holdS, r.screenshot, r.audio.join(' ')].map(csv).join(','))].join('\n'));

  // script in the beat format, actual responses, planned and measured timing kept apart
  const md: string[] = [`# CourseCorrect demo — take ${m.takeId}`, '', `Result: **${m.result}**${m.golden ? ' (golden: the specified journey passed)' : ''} · modes: ${Object.entries(m.modes).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '', ...m.labels.map((l) => `- ${l}`), ''];
  for (const b of timeline.beats) {
    const bc = cues.filter((c) => c.beat.number === b.number), tms = bc.map((c) => timing.get(c.id)).filter(Boolean);
    md.push(`## Beat — ${b.number} — ${b.title} — ${b.plannedWindow} (planned)${tms.length ? ` · ${fmt(tms[0]!.startS)}–${fmt(tms[tms.length - 1]!.endS)} (measured in this take)` : ' · not run in this take'}`, '');
    for (const c of bc) {
      const a = last.get(c.id), tm = timing.get(c.id);
      if (c.startingState) md.push(`*Setup record:* ${c.startingState}`, '');
      if (c.onScreen) md.push('**What’s on screen:**', c.onScreen, '');
      if (c.vo?.length && !c.alice) md.push('**VO:**', ...c.vo, '');
      if (c.alice) {
        md.push('**ALICE:**', c.alice, a?.input ? `*(this take: ${a.input.mode}${a.input.sent ? `; the server received “${a.input.sent.text}” via ${a.input.sent.channel}` : ''})*` : '', '');
      }
      const said = clips.filter((x) => x.cueId === c.id && x.status === 200);
      if (said.length || c.coursecorrectPlanned) {
        md.push('**COURSECORRECT:**', ...(said.length ? said.map((x) => `${x.text}  \n*[${assets.find((y) => y.track === 'COURSECORRECT' && y.startS === x.offsetS)?.file ?? x.file} · ${x.durationS ?? '?'} s · at ${fmt(x.offsetS)}]*`) : ['*(no spoken response captured in this take)*']));
        if (c.coursecorrectPlanned) md.push(`*(planned: ${c.coursecorrectPlanned})*`);
        md.push('');
      }
      if (c.vo?.length && c.alice) md.push('**VO:**', ...c.vo, '');
      md.push(`*${c.id} · ${c.title} · planned ${c.planned.inputS}/${c.planned.processingS}/${c.planned.speechS}/${c.planned.holdS} s (input/processing/speech/hold) · measured ${tm ? `${tm.inputS ?? '–'}/${tm.processingS ?? '–'}/${tm.speechS ?? '–'}/${tm.holdS ?? '–'} s, ${tm.status}` : 'not run'}*`, '');
      for (const note of c.notes ?? []) md.push(`> ${note}`, '');
      if (a?.captured) for (const [k, v] of Object.entries(a.captured)) md.push(`> Captured on screen (${k}): “${v}”`, '');
    }
  }
  writeFileSync(join(out, 'script.md'), md.join('\n'));

  // iMovie assembly guide
  const g = [`# iMovie assembly — take ${m.takeId}`, '', 'There is no iMovie project file. Build it by hand:', '',
    `1. New Movie → import \`video/take.mp4\` (${fmt(videoS)}; screen only, no audio). The original capture is \`video/take.original.webm\`.`,
    '2. Add each audio file below at its **start** time (drag to that point on the video, then fine-tune against the screen). Use the `.48k.wav` derivative; the `.mp3`/original next to it is the source.',
    '3. Record your VO into each slot (or put recordings in `private/demo/vo/<cueId>.m4a` and re-run `npm run demo:export`). Narration stays on its own track; it is never generated.',
    '4. Keep the real order of events. You may trim holds, but do not move a CourseCorrect reply before the screen shows the request it answers, and never before “Change applied” for an acceptance reply.', '',
    '| # | Cue | Track | File | Start | Duration | Label |', '|---|---|---|---|---|---|---|',
    ...assets.map((x) => `| ${x.n} | ${x.cueId} | ${x.track} | \`${x.wav ?? x.file}\` | ${fmt(x.startS)} | ${x.durationS != null ? `${x.durationS.toFixed(1)} s` : ''} | ${x.label} |`), '',
    '## Measured cue timing', '', '| Cue | Start | Input | Processing | Speech | Hold | Status |', '|---|---|---|---|---|---|---|',
    ...cues.map((c) => { const t = timing.get(c.id); return `| ${c.id} ${c.title} | ${fmt(t?.startS)} | ${t?.inputS ?? ''} | ${t?.processingS ?? ''} | ${t?.speechS ?? ''} | ${t?.holdS ?? ''} | ${t?.status ?? 'not run'} |`; }),
    '', ...notes.map((x) => `- ${x}`)];
  writeFileSync(join(out, 'IMOVIE.md'), g.join('\n'));

  // recorded playback page: local files only
  const data = { take: m.takeId, startedAt: m.startedAt, result: m.result, golden: m.golden, modes: m.modes, labels: m.labels, rows,
    clips: assets.filter((x) => x.track !== 'VO' && x.startS != null && x.wav).map((x) => ({ file: `audio/${x.wav}`, startS: x.startS, track: x.track, text: x.text, cueId: x.cueId })) };
  writeFileSync(join(out, 'index.html'), playbackHtml(data, existsSync(join(out, 'video/take.mp4')) ? 'video/take.mp4' : 'video/take.original.webm'));
  return { out, assets: assets.length, notes, clipsOk };
}

function playbackHtml(data: unknown, video: string) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recorded take playback</title>
<style>
:root{--bg:#faf9f6;--fg:#1d1c1a;--mut:#6b675f;--line:#ddd8cf;--warn:#8a3b00;--ok:#1d6b3a;--bad:#9b1c1c;--hl:#fff3cd}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#171614;--fg:#eceae4;--mut:#a29d93;--line:#3a3732;--warn:#f0a35c;--ok:#6fcf97;--bad:#ff8a8a;--hl:#3b3420}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif}
.banner{position:sticky;top:0;z-index:2;background:var(--warn);color:#fff;padding:10px 16px;font-weight:700}
main{max-width:1200px;margin:0 auto;padding:16px}
video{width:100%;background:#000;border-radius:8px}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
tr.now{background:var(--hl)}.mut{color:var(--mut)}.passed{color:var(--ok)}.mismatch,.interrupted{color:var(--bad)}
button{font:inherit;cursor:pointer}
</style></head><body>
<div class="banner" role="status">RECORDED PLAYBACK — not a live run. This page replays saved files of take <span id="take"></span>; it makes no service, model or speech calls and changes nothing.</div>
<main><p id="meta" class="mut"></p><video id="v" controls src="${video}"></video>
<p class="mut">CourseCorrect (Polly) and ALICE clips play at their captured offsets. VO slots are not included.</p>
<table><thead><tr><th>Cue</th><th>Status</th><th>ALICE / input</th><th>COURSECORRECT (exact text)</th><th>Planned s</th><th>Measured s</th></tr></thead><tbody id="rows"></tbody></table></main>
<script id="data" type="application/json">${json}</script>
<script>
const d = JSON.parse(document.getElementById('data').textContent);
const fmt = s => s == null ? '' : Math.floor(s/60) + ':' + (s%60).toFixed(1).padStart(4,'0');
document.getElementById('take').textContent = d.take;
document.getElementById('meta').textContent = 'Captured ' + d.startedAt + ' · result ' + d.result + (d.golden ? ' (golden)' : '') + ' · ' + Object.entries(d.modes).map(([k,v]) => k + ' ' + v).join(' · ') + ' · ' + d.labels.join(' · ');
const v = document.getElementById('v'), tb = document.getElementById('rows');
for (const r of d.rows) {
  const tr = document.createElement('tr'); tr.dataset.start = r.measured ? r.measured.startS : '';
  const p = r.planned, m = r.measured;
  const cells = [r.cueId + ' ' + r.title, r.status, (r.aliceText ? r.aliceText + ' — ' + (r.aliceMode || '') : ''), r.coursecorrect, [p.inputS,p.processingS,p.speechS,p.holdS].join('/'), m ? fmt(m.startS) + ' · ' + [m.inputS,m.processingS,m.speechS,m.holdS].map(x => x ?? '–').join('/') : 'not run'];
  cells.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c; if (i === 1) td.className = r.status; tr.appendChild(td); });
  if (m) { const b = document.createElement('button'); b.textContent = '▶ ' + fmt(m.startS); b.onclick = () => { v.currentTime = m.startS; v.play(); }; tr.cells[0].appendChild(document.createElement('br')); tr.cells[0].appendChild(b); }
  tb.appendChild(tr);
}
const clips = d.clips.map(c => Object.assign(c, { el: new Audio(c.file), done: false }));
const stopAll = () => clips.forEach(c => { c.el.pause(); c.done = false; });
v.addEventListener('timeupdate', () => {
  const t = v.currentTime;
  for (const tr of tb.rows) tr.classList.toggle('now', tr.dataset.start !== '' && +tr.dataset.start <= t && (!tr.nextElementSibling || tr.nextElementSibling.dataset.start === '' || +tr.nextElementSibling.dataset.start > t));
  if (v.paused) return;
  for (const c of clips) if (!c.done && t >= c.startS && t < c.startS + 30) { c.done = true; c.el.currentTime = Math.max(0, t - c.startS); c.el.play().catch(() => {}); }
});
v.addEventListener('seeking', stopAll); v.addEventListener('pause', () => clips.forEach(c => c.el.pause()));
</script></body></html>`;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'polly-speed': { type: 'string' } } });
  const takes = join(ROOT, '.artifacts/demo/takes');
  const dir = positionals[0] ?? join(takes, readdirSync(takes).sort().at(-1)!);
  const r = exportTake(dir, { pollySpeed: values['polly-speed'] ? Number(values['polly-speed']) : undefined });
  console.log(`package: ${r.out}\n${r.assets} audio assets/slots${r.notes.length ? `\n${r.notes.join('\n')}` : ''}\nrecorded playback: open "${join(r.out, 'index.html')}"`);
}
