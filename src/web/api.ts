// Transport. Cooking goes through the six cooking MCP tools with the real MCP SDK client (the companion is an MCP client, so the
// Activity column shows real calls the server recorded). Import, drafts and saving are plain web requests, logged locally
// as channel 'web' and never shown as MCP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RecipeBookEntry, RecipeContent, RescueEvaluation, WireAmendment, WireRun } from '../contract/project.ts';
import type { ImportJob, WireDraft, WireSourceDoc } from '../authoring/drafts.ts';

export type { RecipeBookEntry, RecipeContent, RescueEvaluation, WireAmendment, WireRun, ImportJob, WireDraft, WireSourceDoc };
export type WireCandidate = Extract<RescueEvaluation, { outcome: 'proposal' }>['candidates'][number];
export type WireRefusal = Extract<RescueEvaluation, { outcome: 'refused' }>['refusal'];
export interface Rejected { outcome: 'rejected'; code: string; message: string; run: WireRun | null; activeRun?: { runId: string; recipeTitle: string } }
export interface Active { run: WireRun | null; recipe: RecipeContent | null; latestEvaluation: RescueEvaluation | null; command?: { commandId: string; receipt: string; code: string | null; status: 'applied' | 'appliedOther' | 'notApplied' | 'unknown' | 'runReplaced'; amendmentId?: string } }
export type Applied = { outcome: 'applied' | 'alreadyApplied'; amendment: WireAmendment; run: WireRun; resume: { stepId: string; text: string }; replayed?: true };
export interface SourceLine { sourceDocId: string; page: number | null; lineId: string; text: string; origin: string; image: boolean }

export const newId = () => crypto.randomUUID();

let client: Promise<Client> | null = null;
function mcp(): Promise<Client> {
  client ??= (async () => {
    const c = new Client({ name: 'coursecorrect-companion', version: '0.1.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.origin)));
    return c;
  })().catch((e) => { client = null; throw e; });
  return client;
}
/** One MCP tool call. Throws only when no response arrived (the caller decides what "unknown" means). */
export async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await (await mcp()).callTool({ name, arguments: args });
  return r.structuredContent as T;
}

// ---------- web requests (logged as 'web') ----------
export interface WebEntry { seq: number; name: string; input: string; result: string; at: string }
const webLog: WebEntry[] = [];
const listeners = new Set<() => void>();
export const onWebLog = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const webEntries = () => webLog;
function logWeb(name: string, input: string, result: string) { webLog.unshift({ seq: webLog.length + 1, name, input, result, at: new Date().toISOString() }); listeners.forEach((f) => f()); }

export async function web<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, label?: string): Promise<{ status: number; data: T }> {
  const isFile = body instanceof Blob;
  const r = await fetch(path, {
    method, headers: { ...(isFile ? { 'content-type': 'application/pdf' } : body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: isFile ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() as T : (undefined as T);
  if (label) logWeb(label, `${method} ${path.split('?')[0]}`, `${r.status}${(data as { error?: { code?: string } })?.error?.code ? ` · ${(data as { error: { code: string } }).error.code}` : ''}`);
  return { status: r.status, data };
}

// ---------- Activity scope: blank at the start of each recipe or import ----------
const FROM = 'cc.activityFrom';
export const activityFrom = () => { try { return Number(sessionStorage.getItem(FROM) ?? 0); } catch { return 0; } };
/** Hide everything recorded so far (the server keeps it); the column then shows only what happens next. */
export async function startActivityScope() {
  const all = await activitySince(0).catch(() => []);
  try { sessionStorage.setItem(FROM, String(all.length ? all[all.length - 1].seq : 0)); } catch { /* this tab only */ }
  webLog.length = 0;
  listeners.forEach((f) => f());
}

// ---------- server-recorded MCP activity ----------
export interface ActivityEntry { id: string; seq: number; name: string; correlationId: string | null; status: string; summary: string; input: unknown; trace?: { interpretation: string | null; deterministic: string | null }; durationMs: number; at: string }
export async function activitySince(after: number): Promise<ActivityEntry[]> {
  const r = await fetch(`/activity?after=${after}`);
  return r.ok ? ((await r.json()) as { entries: ActivityEntry[] }).entries : [];
}

// ---------- spoken replies (server-mediated Polly; only server-rendered text) ----------
export type SpeechRef = { evaluationId: string } | { runId: string; stepId: string; amendmentId?: string; next?: true };
export async function speechAudio(ref: SpeechRef): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const r = await fetch('/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ref) });
  if (!r.ok) return { ok: false, message: ((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `Speech failed (${r.status})` };
  return { ok: true, url: URL.createObjectURL(await r.blob()) };
}

// ---------- client-held state that must survive reload ----------
/** An apply whose response may have been lost (FE contract §2.8). Session storage, so a reload keeps the hold (A-13). */
export interface PendingCommand {
  args: { commandId: string; runId: string; epoch: number; expectedRevision: number; evaluationId: string; candidateId: string; planId: string; accepted: true };
  status: 'sending' | 'unknown'; checks: number; changedStepIds: string[]; heldStepId: string; headline: string;
}
const KEY = 'cc.pendingApply';
export const pending = {
  get(): PendingCommand | null { try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as PendingCommand | null; } catch { return null; } },
  set(p: PendingCommand | null) { try { if (p) sessionStorage.setItem(KEY, JSON.stringify(p)); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable: hold lasts this page only */ } },
};
export const prefs = {
  get(k: string) { try { return localStorage.getItem(`cc.${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`cc.${k}`, v); } catch { /* per-viewer convenience only */ } },
};
