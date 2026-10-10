// Mailbox protocol client for the CitiesIIAgentBridge mod (same contract as bridge.ps1):
// session.json heartbeat (< 10 s, status ready), one compact JSON request file per call,
// response file with the same id, 16 KB request limit, culture-safe UTC parsing.
// Runs under Node >= 22.18 with native TypeScript type stripping (no build step).
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAILBOX = process.env.CS2_MAILBOX ?? join(process.env.LOCALAPPDATA ?? '', 'CitiesIIAgentBridge');
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_REQUEST_BYTES = 15000; // mod rejects > 16384; keep envelope room like lib/BridgeClient.psm1
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type Json = any;
export interface Response { ok: boolean; result?: Json; error?: string }

// Culture-safe: parse the ISO 'O' timestamp by hand (7 fraction digits, Z or offset).
export function parseUtc(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(String(text).trim());
  if (!m) return NaN;
  const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  if (m[8] && m[8] !== 'Z') { const sign = m[8][0] === '-' ? -1 : 1; t -= sign * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6))) * 60000; }
  return t;
}

export async function readSession(): Promise<Json> {
  // The heartbeat file is replaced atomically; retry the read only (never a command).
  for (let i = 0; ; i++) {
    try { return JSON.parse((await fs.readFile(join(MAILBOX, 'session.json'), 'utf8')).replace(/^﻿/, '')); }
    catch (e) { if (i >= 9) throw e; await sleep(50); }
  }
}

// The heartbeat file is cached for 1 s: a tool that makes 20 calls reads it once, not 20 times.
let sessionCache: { at: number; session: Json } | null = null;
export function dropSessionCache(): void { sessionCache = null; }
export async function sessionReady(): Promise<{ ready: boolean; session: Json; ageSec: number }> {
  if (!sessionCache || Date.now() - sessionCache.at > 1000) sessionCache = { at: Date.now(), session: await readSession() };
  const session = sessionCache.session;
  const ageSec = (Date.now() - parseUtc(session.heartbeatUtc)) / 1000;
  return { ready: session.status === 'ready' && ageSec <= 10, session, ageSec };
}
const POLL_MS = 12; // the mod ticks every ~15 ms while busy; 50-100 ms polling used to dominate latency
export const stats = { calls: 0, callMs: 0, startedAt: Date.now(), simSeconds: 0, simSteps: 0 };

// One request. Transport problems throw; a mod-side failure returns {ok:false,error}.
// Never resends: on timeout the request expires by itself and the caller must inspect state.
export async function call(command: string, args: Json = {}, timeoutSeconds = 15): Promise<Response> {
  let { ready, session, ageSec } = await sessionReady();
  if (!ready) { dropSessionCache(); ({ ready, session, ageSec } = await sessionReady()); }
  if (!ready) throw new Error(`bridge_not_responding: status=${session.status} heartbeatAge=${ageSec.toFixed(1)}s`);
  const t0 = Date.now(); stats.calls++;
  const id = randomUUID().replace(/-/g, '');
  const timeout = Math.max(1, Math.min(45, timeoutSeconds));
  const packet = { protocol: 1, id, session: session.session, citySession: session.citySession, command, args: args ?? {}, expiresUtc: new Date(Date.now() + timeout * 1000).toISOString() };
  const text = JSON.stringify(packet);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_REQUEST_BYTES) throw new Error(`request_too_large_client: ${bytes} bytes (limit ${MAX_REQUEST_BYTES}); nothing was sent`);
  const requestPath = join(MAILBOX, 'requests', id + '.json');
  const responsePath = join(MAILBOX, 'responses', id + '.json');
  await fs.writeFile(requestPath + '.tmp', text, 'utf8');
  await fs.rename(requestPath + '.tmp', requestPath);
  const deadline = Date.now() + (timeout + 2) * 1000;
  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      let raw: string;
      try { raw = await fs.readFile(responsePath, 'utf8'); }
      catch (e: any) { if (e.code === 'EBUSY' || e.code === 'EPERM') { await sleep(POLL_MS); continue; } throw e; }
      let response: Response;
      try { response = JSON.parse(raw.replace(/^﻿/, '')); } catch { await sleep(50); continue; } // partially visible; same id only
      fs.unlink(responsePath).catch(() => {}); // ids are unique; the mod never re-executes a completed id
      stats.callMs += Date.now() - t0;
      // A rejected stale session/city id means nothing ran: refresh the cache for the next call.
      if (!response.ok && /stale_(city_)?session/.test(String(response.error))) dropSessionCache();
      return response;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timeout: ${command} request ${id}; outcome unknown, inspect state before retrying`);
}

export async function callOk(command: string, args: Json = {}, timeoutSeconds = 15): Promise<Json> {
  const r = await call(command, args, timeoutSeconds);
  if (!r.ok) throw new Error(`${command}: ${r.error}`);
  return r.result;
}

const PENDING = ['queued', 'validating', 'applying', 'running'];
export async function waitOperation(id: string, timeoutSeconds = 120): Promise<Json> {
  const end = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < end) {
    const op = await callOk('get_operation', { id }, 5);
    if (!PENDING.includes(op.status)) return op;
    await sleep(40);
  }
  throw new Error(`operation ${id} still pending after ${timeoutSeconds}s; inspect before retrying`);
}

export async function waitBatch(id: string, timeoutSeconds = 600): Promise<Json> {
  const end = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < end) {
    const b = await callOk('get_batch', { id }, 5);
    if (!PENDING.includes(b.status)) return b;
    await sleep(40);
  }
  throw new Error(`batch ${id} still running after ${timeoutSeconds}s; inspect before retrying`);
}

// Several non-pausing reads in one mailbox round trip. Returns each command's result; throws
// on the first failed one (reads only, so nothing can be half-applied).
export async function multi(commands: { command: string; args?: Json }[]): Promise<Json[]> {
  const r = await callOk('multi', { commands: commands.map(c => ({ command: c.command, args: c.args ?? {} })) }, 30);
  return r.results.map((x: Json) => { if (!x.ok) throw new Error(`${x.command}: ${x.error}`); return x.result; });
}

// events.jsonl (+ rotated events.1.jsonl): entries strictly after `since` (ISO utc or seq).
export async function readEvents(since?: string | number, limit = 20, types?: string[]): Promise<{ events: Json[]; next?: string }> {
  const lines: string[] = [];
  for (const name of ['events.1.jsonl', 'events.jsonl']) {
    try { lines.push(...(await fs.readFile(join(MAILBOX, name), 'utf8')).split('\n')); } catch { /* absent */ }
  }
  let events = lines.filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (since !== undefined && since !== null && since !== '') {
    if (typeof since === 'number' || /^\d+$/.test(String(since))) events = events.filter(e => e.seq > Number(since));
    else { const t = parseUtc(String(since)); events = events.filter(e => parseUtc(e.utc) > t); }
  }
  if (types?.length) events = events.filter(e => types.includes(e.type));
  events = events.slice(-Math.max(1, Math.min(200, limit)));
  return { events, next: events.length ? events[events.length - 1].utc : (since === undefined ? undefined : String(since)) };
}

// Runs a harness PowerShell script (pwsh 7) from the repo root; returns its output lines.
export function runPwsh(script: string, args: string[], timeoutMs = 600000): Promise<{ code: number | null; lines: string[] }> {
  // Scripts mutate (and pause) the game: hold the background run while one is active.
  state.mutating++; let released = false; const release = () => { if (!released) { released = true; state.mutating--; } };
  return new Promise((done0) => {
    const done = (v: { code: number | null; lines: string[] }) => { release(); done0(v); };
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(REPO, script), ...args], { cwd: REPO, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += '\n[mcp] script time limit reached; the script was left running (never kill a running mutation)'; done({ code: null, lines: lines(out) }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); done({ code, lines: lines(out) }); });
    child.on('error', e => { clearTimeout(timer); done({ code: -1, lines: [String(e)] }); });
  });
}
const lines = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length);

// ---- shared state: one bounded run at a time; mutations refuse while it is active ----
export const state = { running: false, mutating: 0 };
export function assertIdle(): void { if (state.running) throw new Error('run_in_progress: wait for run() to finish (snapshot/events/ui are safe meanwhile)'); }

// Mutations pause the game (the mod requires it). While a background run is active they are
// allowed: the running step ends with analysis_requested and the loop resumes afterwards, so
// the simulation only stops for the build itself, never for planning reads.
export async function mutate<T>(fn: () => Promise<T>): Promise<T> {
  state.mutating++;
  try { return await fn(); } finally { state.mutating--; }
}

export const background = { until: 0, speed: 4, active: false, lastStop: '', steps: 0 };
export function startBackground(seconds: number, speed = 4): void {
  background.until = Date.now() + seconds * 1000; background.speed = speed;
  if (!background.active) { background.active = true; void backgroundLoop().finally(() => { background.active = false; }); }
}
export function stopBackground(): void { background.until = 0; }
async function backgroundLoop(): Promise<void> {
  let shortSteps = 0;
  while (Date.now() < background.until) {
    if (state.mutating > 0 || state.running) { await sleep(150); continue; }
    const wall = Math.min(50, Math.max(5, Math.ceil((background.until - Date.now()) / 1000)));
    let started: Response;
    try { started = await call('simulate_step', { frames: 262144, wallSeconds: wall, stallSeconds: 5, speed: background.speed, stopOnNewShortage: false, acknowledgeNoProgress: true }, 10); }
    catch (e: any) { background.lastStop = String(e.message ?? e); await sleep(2000); continue; }
    if (!started.ok) { background.lastStop = String(started.error); await sleep(400); continue; } // e.g. an operation is still in flight
    let res: Json = null; const clientEnd = Date.now() + (wall + 8) * 1000;
    while (Date.now() < clientEnd) {
      await sleep(400);
      try { res = await callOk('get_simulation_step', { id: started.result.id }, 5); } catch { res = null; break; }
      if (res.status !== 'running') break;
    }
    if (!res || res.status === 'running') { background.lastStop = 'client_deadline'; continue; }
    background.steps++; stats.simSteps++; stats.simSeconds += Number(res.elapsedSeconds ?? 0);
    background.lastStop = String(res.reason);
    shortSteps = Number(res.elapsedSeconds ?? 0) < 1 ? shortSteps + 1 : 0;
    if (res.reason === 'game_paused') { try { await fixPopups(3); } catch { /* the mod also auto-resolves */ } await sleep(600); }
    if (shortSteps >= 8 && state.mutating === 0) { background.lastStop = `stalled:${res.reason}`; await sleep(3000); shortSteps = 0; }
  }
  try { if (state.mutating === 0 && !state.running) await call('cancel_simulation_step', {}, 5); } catch { /* already paused */ }
}

export async function fixPopups(max = 10): Promise<string[]> {
  const done: string[] = [];
  for (let n = 0; n < max; n++) {
    const ui = await callOk('get_ui_state', { chirps: 0 }, 10);
    if (ui.milestone?.blockedBy === 'tutorial_intro' && !ui.resolvableByBridge) {
      const ri = await call('resolve_pause_blocker', { action: 'complete_tutorial_intro' }, 10);
      done.push(ri.ok ? `complete_tutorial_intro (released=${!ri.result.introUnfinishedAfter})` : `retry:${String(ri.error).slice(0, 60)}`); await sleep(1200); continue;
    }
    if (!ui.resolvableByBridge) { done.push(`blocker=${ui.likelyBlocker}`); break; }
    const req = ui.likelyBlocker === 'milestone_popup' ? { action: 'dismiss_milestone', expectedMilestone: String(ui.milestone.pending) }
      : ui.likelyBlocker === 'signature_popup' ? { action: 'dismiss_signature', expectedSignature: String(ui.signatures?.pending?.[0]?.name ?? '') }
      : { action: 'complete_tutorial_phase', expectedPhase: String(ui.tutorial.activeTutorialPhase) };
    // The phase/popup can change between the read and the resolve (*_changed): re-read and retry.
    const res = await call('resolve_pause_blocker', req, 10);
    if (!res.ok) { done.push(`retry:${String(res.error).slice(0, 60)}`); await sleep(500); continue; }
    const r = res.result;
    done.push(`${req.action}:${r.completedPhase ?? r.dismissed}`);
    await sleep(1500); // the UI releases its pause barrier on later frames
  }
  return done;
}

// Bounded simulation like run-session.ps1: chained simulate_step (<= 50 s each), status
// polls only (non-pausing), popups passed through, stops paused with a reason otherwise.
export async function run(totalSeconds: number, speed = 4, cashFloor = 0): Promise<string> {
  assertIdle(); state.running = true;
  try {
    const before = await callOk('get_snapshot', {}, 10);
    let used = 0, steps = 0, frames = 0, shortageStreak = 0, resolutions = 0; let stop = 'done'; const notes: string[] = [];
    while (used < totalSeconds && totalSeconds - used >= 1) {
      const wall = Math.min(50, Math.ceil(totalSeconds - used));
      const stepArgs: Json = { frames: 262144, wallSeconds: wall, stallSeconds: Math.min(5, wall), speed, stopOnNewShortage: true };
      if (cashFloor > 0) stepArgs.cashFloor = cashFloor;
      const started = await call('simulate_step', stepArgs, 10);
      if (!started.ok) { stop = `step_refused: ${started.error}`; break; }
      let res: Json = null; const clientEnd = Date.now() + (wall + 8) * 1000;
      while (Date.now() < clientEnd) {
        await sleep(1000);
        res = await callOk('get_simulation_step', { id: started.result.id }, 5);
        if (res.status !== 'running') break;
      }
      if (!res || res.status === 'running') {
        try { await callOk('cancel_simulation_step', {}, 5); } catch { notes.push('cancel not confirmed'); }
        stop = 'client_deadline'; break;
      }
      steps++; used += Number(res.elapsedSeconds ?? 0); frames += Number(res.advancedFrames ?? 0);
      stats.simSteps++; stats.simSeconds += Number(res.elapsedSeconds ?? 0);
      const reason = String(res.reason);
      if (!res.paused) { stop = 'pause_not_confirmed'; break; }
      // Milestones are withheld while the tutorial intro is unfinished (FAILURES #24) without
      // any pause, so check the non-pausing snapshot after every step and release them.
      try { const snap = await callOk('get_snapshot', {}, 5); if (snap.milestone?.blockedBy === 'tutorial_intro') notes.push(...(await fixPopups(3)).filter(f => !f.startsWith('blocker='))); } catch { /* best effort */ }
      if (reason === 'frame_limit' || reason === 'wall_deadline') { shortageStreak = 0; continue; }
      if (reason === 'new_utility_shortage') { if (++shortageStreak >= 3) { stop = 'new_shortages_3_steps'; break; } continue; }
      if (reason === 'game_paused' && resolutions < 10) {
        const fixed = await fixPopups(3);
        const acted = fixed.filter(f => !f.startsWith('blocker='));
        if (acted.length) { resolutions += acted.length; notes.push(...acted); continue; }
        stop = `game_paused:${fixed.at(-1)?.replace('blocker=', '') ?? 'unknown'}`; break;
      }
      stop = reason; break;
    }
    const after = await callOk('get_snapshot', {}, 10);
    const c0 = before.city ?? {}, c1 = after.city ?? {};
    return `run ${Math.round(used)}s ${steps} steps | frame ${before.liveFrame ?? before.frame}->${after.liveFrame ?? after.frame} (+${frames}) | pop ${c0.pop}->${c1.pop} | money ${c0.money}->${c1.money} | net ${c1.net} | unemp ${after.jobs?.unemp}% | power ${after.util?.power?.pct}% | stop: ${stop}` + (notes.length ? ` | ${notes.join('; ')}` : '');
  } finally { state.running = false; }
}

// Prefab lookup by exact name (any kind) with construction cost and monthly upkeep.
export async function prefabInfo(name: string, kind = 'all'): Promise<Json> {
  const page = await callOk('get_build_prefabs', { kind, filter: name, limit: 200 }, 20);
  const hit = (page.prefabs ?? []).find((p: Json) => p.name === name);
  if (!hit) return { name, found: false, similar: (page.prefabs ?? []).slice(0, 8).map((p: Json) => p.name) };
  const details = await callOk('get_prefab_details', { index: hit.index, version: hit.version }, 10);
  return { name, found: true, index: hit.index, version: hit.version, kind: hit.kind, locked: hit.locked, ...(details.costs ?? {}) };
}

export const money = async (): Promise<number> => Number((await callOk('get_city_state', {}, 10)).money);

// Called at the start of every tool (FAILURES #37): if the non-pausing snapshot shows a
// resolvable popup or an intro-held milestone, clear it (race-tolerant) before acting.
export async function ensureClear(): Promise<string[]> {
  if (state.running) return []; // run() resolves popups itself; never race its step loop
  try {
    const s = await callOk('get_snapshot', {}, 5);
    if (s.ui?.fixable || s.milestone?.blockedBy === 'tutorial_intro') return (await fixPopups(10)).filter(f => !f.startsWith('blocker='));
  } catch { /* the tool itself will report a dead bridge */ }
  return [];
}
