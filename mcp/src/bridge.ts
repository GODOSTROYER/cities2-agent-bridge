// Mailbox protocol client for the CitiesIIAgentBridge mod (same contract as bridge.ps1):
// session.json heartbeat (< 10 s, status ready), one compact JSON request file per call,
// response file with the same id, 16 KB request limit, culture-safe UTC parsing.
// Runs under Node >= 22.18 with native TypeScript type stripping (no build step).
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

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

// ---- events: paging over events.jsonl (+ rotated events.1.jsonl) ----
// An event is { s: <8-char mod session id>, seq, type, frame, utc, data }; lines without "s" (older
// mods) are session ''. seq restarts at 1 in each new mod session. A cursor is "<s>:<seq>", the last
// event a caller has consumed. File order (oldest first) is the order of the log.
export interface EventPage { events: Json[]; next?: string; cursor: string; hasMore: boolean; gap?: Json }

const eventKey = (e: Json): string => `${e.s ?? ''}:${e.seq}`;
const sessionOf = (e: Json): string => String(e.s ?? '');
const seqOf = (e: Json): number => Number(e.seq);
const wanted = (e: Json, types?: string[]): boolean => !types?.length || types.includes(e.type);

function parseCursor(text: string): { s: string; seq: number } | null {
  const m = /^([^:]*):(\d+)$/.exec(text);
  return m ? { s: m[1], seq: Number(m[2]) } : null;
}

// Walks list[start..] in file order and stops after `limit` matching events. Filtered-out events
// are scanned too, so `last` (the last scanned index, start-1 when none) moves past them.
// `prev` is the caller's own cursor event when it sits right before `start`; it anchors the
// sequence check across the seam.
function scanFrom(list: Json[], start: number, limit: number, types: string[] | undefined, prev: Json | null) {
  const events: Json[] = [];
  let last = start - 1, jump: Json | undefined, p = prev;
  for (let j = start; j < list.length && events.length < limit; j++) {
    const e = list[j];
    last = j;
    if (p && !jump && sessionOf(p) === sessionOf(e) && seqOf(e) !== seqOf(p) + 1) {
      jump = { reason: 'sequence_jump', expected: seqOf(p) + 1, got: seqOf(e) };
    }
    p = e;
    if (wanted(e, types)) events.push(e);
  }
  return { events, last, hasMore: last + 1 < list.length, jump };
}

// Legacy filters (ISO time, seq within the newest session): the filtered view is paged oldest first.
function viewPage(view: Json[], list: Json[], text: string, limit: number, types?: string[]): EventPage {
  const page = scanFrom(view, 0, limit, types, null);
  return {
    events: page.events,
    next: page.events.length ? page.events[page.events.length - 1].utc : text,
    cursor: page.last >= 0 ? eventKey(view[page.last]) : (list.length ? eventKey(list[list.length - 1]) : ''),
    hasMore: page.hasMore,
    ...(page.jump ? { gap: page.jump } : {}),
  };
}

// Pure paging over the parsed, file-ordered event list. readEvents is a thin file-reading wrapper.
export function pageEvents(all: Json[], since: string | number | undefined, limit = 20, types?: string[]): EventPage {
  const L = Math.max(1, Math.min(200, Number(limit) || 20));
  const list = all;
  if (since === undefined || since === null || since === '') {
    // First look: the newest L matching events; the cursor is the newest event in the list.
    let start = 0, matched = 0;
    for (let j = list.length - 1; j >= 0; j--) {
      if (!wanted(list[j], types)) continue;
      if (++matched === L) { start = j; break; }
    }
    const page = scanFrom(list, start, Infinity, types, null);
    return {
      events: page.events,
      next: page.events.length ? page.events[page.events.length - 1].utc : undefined,
      cursor: list.length ? eventKey(list[list.length - 1]) : '',
      hasMore: false,
      ...(page.jump ? { gap: page.jump } : {}),
    };
  }
  const text = String(since);
  if (typeof since === 'number' || /^\d+$/.test(text)) {
    // Legacy seq filter: seq > N within the newest session (the session of the last line).
    const newest = sessionOf(list.length ? list[list.length - 1] : {});
    const N = Number(since);
    return viewPage(list.filter(e => sessionOf(e) === newest && seqOf(e) > N), list, text, L, types);
  }
  const cur = Number.isNaN(parseUtc(text)) ? parseCursor(text) : null;
  if (!cur) {
    // Legacy ISO since: events strictly after that time.
    const t = parseUtc(text);
    return viewPage(list.filter(e => parseUtc(e.utc) > t), list, text, L, types);
  }
  const idx = list.findIndex(e => sessionOf(e) === cur.s && seqOf(e) === cur.seq);
  let start = 0, prev: Json | null = null, restarted = false;
  if (idx >= 0) {
    // The cursor's event is still in the files: continue right after it. Events of another session
    // after it mean the mod restarted and seq began again at 1.
    start = idx + 1; prev = list[idx];
    restarted = list.slice(start).some(e => sessionOf(e) !== cur.s);
  } else {
    // Cursor event rotated away: resume at the caller's session's next event if one remains, else
    // after that session's last event, else at the oldest available event.
    const own: number[] = [];
    list.forEach((e, j) => { if (sessionOf(e) === cur.s) own.push(j); });
    const ahead = own.find(j => seqOf(list[j]) > cur.seq);
    start = ahead ?? (own.length ? own[own.length - 1] + 1 : 0);
  }
  const page = scanFrom(list, start, L, types, prev);
  const firstAvailable = start < list.length ? eventKey(list[start]) : '';
  // One gap per page: a rotated-away cursor or a restart is reported in preference to a sequence jump.
  const gap = idx < 0 ? { reason: 'cursor_not_found', from: text, firstAvailable }
    : restarted ? { reason: 'session_restarted', from: text, firstAvailable }
    : page.jump;
  return {
    events: page.events,
    next: page.events.length ? page.events[page.events.length - 1].utc : text,
    cursor: page.last >= start ? eventKey(list[page.last]) : text,
    hasMore: page.hasMore,
    ...(gap ? { gap } : {}),
  };
}

export async function readEvents(since?: string | number, limit = 20, types?: string[]): Promise<EventPage> {
  const all: Json[] = [];
  for (const name of ['events.1.jsonl', 'events.jsonl']) {
    let text: string;
    try { text = (await fs.readFile(join(MAILBOX, name), 'utf8')).replace(/^﻿/, ''); } catch { continue; } // absent
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && typeof e === 'object') all.push(e); } catch { /* partial last line */ }
    }
  }
  return pageEvents(all, since, limit, types);
}

// ---- goal lock: one goal (mutation, script, background step) holds the game at a time ----
// FIFO mutex. A queued waiter can be abandoned through its AbortSignal: it leaves the queue at
// once and its promise rejects, so the queue behind it still advances when the holder releases.
// A grant that is never awaited cannot be observed by the lock; callers must await acquire()
// (run() does) or pass a signal.
type Waiter = { owner: string; resolve: (release: () => void) => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort: () => void };
export class GoalLock {
  #holder: { owner: string; token: object } | null = null;
  #queue: Waiter[] = [];

  get held(): string | null { return this.#holder?.owner ?? null; }
  get waiting(): number { return this.#queue.length; }

  // Resolves with an idempotent release function once this caller holds the lock.
  acquire(owner: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
      const waiter: Waiter = {
        owner, resolve, reject, signal,
        onAbort: () => {
          const i = this.#queue.indexOf(waiter);
          if (i >= 0) { this.#queue.splice(i, 1); reject(signal?.reason ?? new Error('aborted')); }
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.#queue.push(waiter);
      this.#dispatch();
    });
  }

  // Acquire, run fn, always release (also when fn throws or rejects).
  async run<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(owner);
    try { return await fn(); } finally { release(); }
  }

  #dispatch(): void {
    if (this.#holder) return;
    const next = this.#queue.shift();
    if (!next) return;
    next.signal?.removeEventListener('abort', next.onAbort);
    const token = {};
    this.#holder = { owner: next.owner, token };
    next.resolve(() => {
      // Only the grant that created this release can free the lock; a second call is a no-op.
      if (this.#holder?.token === token) { this.#holder = null; this.#dispatch(); }
    });
  }
}
export const goalLock = new GoalLock();

// Set while an async chain runs inside a goal that holds goalLock. Nested mutate()/runPwsh()
// calls in that chain run directly instead of queueing behind their own outer goal.
// `active` clears when the goal's fn ends, so a detached continuation queues normally.
const lockCtx = new AsyncLocalStorage<{ active: boolean }>();
const holdsLock = (): boolean => lockCtx.getStore()?.active === true;
function inLockContext<T>(fn: () => Promise<T>): Promise<T> {
  const token = { active: true };
  return lockCtx.run(token, async () => { try { return await fn(); } finally { token.active = false; } });
}

// Queued or held goals count in state.mutating (other code reads it). The release is idempotent.
async function acquireGoal(owner: string): Promise<() => void> {
  state.mutating++;
  const release = await goalLock.acquire(owner);
  let counted = true;
  return () => { release(); if (counted) { counted = false; state.mutating--; } };
}

// Runs a harness PowerShell script (pwsh 7) from the repo root; returns its output lines.
// The script holds the goal lock until the process exits, even when the caller stops waiting at
// its time limit: a running script is never killed, and nothing may interleave with it.
export async function runPwsh(script: string, args: string[], timeoutMs = 600000): Promise<{ code: number | null; lines: string[] }> {
  const release = holdsLock() ? () => {} : await acquireGoal(`script:${script}`);
  return new Promise((done0) => {
    let settled = false;
    const done = (v: { code: number | null; lines: string[] }) => { if (!settled) { settled = true; done0(v); } };
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(REPO, script), ...args], { cwd: REPO, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += '\n[mcp] script time limit reached; the script was left running (never kill a running mutation)'; done({ code: null, lines: lines(out) }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); done({ code, lines: lines(out) }); release(); });
    // A spawn failure never starts a process (no pid), so the lock is released here; otherwise 'close' releases it.
    child.on('error', e => { clearTimeout(timer); done({ code: -1, lines: [String(e)] }); if (child.pid === undefined) release(); });
  });
}
const lines = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length);

// ---- shared state: one bounded run at a time; mutations refuse while it is active ----
export const state = { running: false, mutating: 0 };
export function assertIdle(): void { if (state.running) throw new Error('run_in_progress: wait for run() to finish (snapshot/events/ui are safe meanwhile)'); }

// Mutations pause the game (the mod requires it). While a background run is active they are
// allowed: the running step ends with analysis_requested and the loop resumes afterwards, so
// the simulation only stops for the build itself, never for planning reads.
// Mutations are serialized by goalLock; a nested mutate() in the same async chain runs directly.
export async function mutate<T>(fn: () => Promise<T>): Promise<T> {
  if (holdsLock()) return fn();
  state.mutating++;
  try { return await goalLock.run('mutation', () => inLockContext(fn)); }
  finally { state.mutating--; }
}

export const background = { until: 0, speed: 4, active: false, lastStop: '', steps: 0, cashFloor: 0, stopOnNewShortage: true };
export function startBackground(seconds: number, speed = 4, cashFloor = 0, stopOnNewShortage = true): void {
  background.until = Date.now() + seconds * 1000; background.speed = speed;
  background.cashFloor = cashFloor; background.stopOnNewShortage = stopOnNewShortage;
  if (!background.active) {
    background.active = true;
    // The loop takes goalLock per step itself, so it must not inherit the caller's lock context.
    void lockCtx.exit(() => backgroundLoop())
      .catch((e: unknown) => { background.lastStop = `loop_error: ${String((e as any)?.message ?? e)}`; })
      .finally(() => { background.active = false; });
  }
}
export function stopBackground(): void { background.until = 0; }

// simulate_step arguments shared by run() and the background loop (cashFloor only when > 0).
function simArgs(wall: number, speed: number, stopOnNewShortage: boolean, cashFloor: number): Json {
  const args: Json = { frames: 262144, wallSeconds: wall, stallSeconds: Math.min(5, wall), speed, stopOnNewShortage };
  if (cashFloor > 0) args.cashFloor = cashFloor;
  return args;
}

type StepOutcome =
  | { kind: 'refused'; error: string }            // domain refusal (e.g. an operation still in flight)
  | { kind: 'transport'; error: unknown }         // call() threw: timeout or bridge not responding
  | { kind: 'deadline' }                          // the mod did not finish the step in time
  | { kind: 'ended'; cause: 'finished' | 'preempted' | 'stopped'; res: Json | null };

// Background simulation: one simulate_step at a time, each under goalLock. A waiting goal
// preempts the running step, and a stop request ends it; both cancel by the step's id. Transport
// errors back off and stop the loop after three in a row (never a blind retry loop).
async function backgroundLoop(): Promise<void> {
  let shortSteps = 0, shortageStreak = 0, transportErrors = 0;
  // Any successful call() resets the consecutive transport-error count.
  const tcall = async (command: string, args: Json, timeoutSeconds: number): Promise<Response> => {
    const r = await call(command, args, timeoutSeconds); transportErrors = 0; return r;
  };
  // Cancel by id, then wait (bounded) until the mod reports the step ended, so the next goal starts on an idle game.
  const cancelAndWait = async (id: string): Promise<Json | null> => {
    await tcall('cancel_simulation_step', { id }, 5);
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const r = await tcall('get_simulation_step', { id }, 5);
      if (r.ok && r.result?.status !== 'running') return r.result;
      await sleep(100);
    }
    return null;
  };
  const step = async (wall: number): Promise<StepOutcome> => {
    try {
      const started = await tcall('simulate_step', { ...simArgs(wall, background.speed, background.stopOnNewShortage, background.cashFloor), acknowledgeNoProgress: true }, 10);
      if (!started.ok) return { kind: 'refused', error: String(started.error) };
      const id = started.result?.id;
      if (!id) return { kind: 'refused', error: 'simulate_step returned no operation id' };
      const end = Date.now() + (wall + 8) * 1000;
      while (Date.now() < end) {
        await sleep(400);
        if (Date.now() >= background.until) return { kind: 'ended', cause: 'stopped', res: await cancelAndWait(id) };
        if (goalLock.waiting > 0) return { kind: 'ended', cause: 'preempted', res: await cancelAndWait(id) };
        const r = await tcall('get_simulation_step', { id }, 5);
        if (!r.ok) return { kind: 'deadline' };
        if (r.result?.status !== 'running') return { kind: 'ended', cause: 'finished', res: r.result };
      }
      await tcall('cancel_simulation_step', { id }, 5).catch(() => {});
      return { kind: 'deadline' };
    } catch (error) { return { kind: 'transport', error }; }
  };

  while (Date.now() < background.until) {
    if (state.mutating > 0 || state.running) { await sleep(150); continue; }
    const wall = Math.min(50, Math.max(5, Math.ceil((background.until - Date.now()) / 1000)));
    const o = await goalLock.run('background', async () => (Date.now() < background.until ? step(wall) : null));
    if (!o) continue;
    if (o.kind === 'transport') {
      transportErrors++;
      background.lastStop = `transport_error: ${String((o.error as any)?.message ?? o.error)}`;
      if (transportErrors >= 3) { background.until = 0; break; }
      await sleep(2000); // back off; call() re-reads the heartbeat before anything is sent again
      continue;
    }
    if (o.kind === 'refused') { background.lastStop = o.error; await sleep(400); continue; }
    if (o.kind === 'deadline') { background.lastStop = 'client_deadline'; continue; }
    if (o.res) { background.steps++; stats.simSteps++; stats.simSeconds += Number(o.res.elapsedSeconds ?? 0); }
    if (o.cause !== 'finished' || !o.res) { background.lastStop = o.cause; continue; }

    const res = o.res;
    const reason = String(res.reason);
    background.lastStop = reason;
    shortSteps = Number(res.elapsedSeconds ?? 0) < 1 ? shortSteps + 1 : 0;
    shortageStreak = reason === 'new_utility_shortage' ? shortageStreak + 1 : 0;
    if (reason === 'cash_floor') { background.until = 0; background.lastStop = 'cash_floor'; break; }
    if (shortageStreak >= 3) { background.until = 0; background.lastStop = 'new_shortages_3_steps'; break; }
    if (reason === 'game_paused') {
      try { await goalLock.run('background:popups', () => fixPopups(3)); } catch { /* the mod also auto-resolves */ }
      await sleep(600);
    }
    if (shortSteps >= 8 && state.mutating === 0) { background.lastStop = `stalled:${reason}`; await sleep(3000); shortSteps = 0; }
  }
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

// The goal lock for one foreground step (not across the popup/snapshot reads between steps).
// A no-op when this async chain already holds the lock.
async function acquireStep(owner: string): Promise<() => void> {
  if (holdsLock()) return () => {};
  return goalLock.acquire(owner);
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
      const release = await acquireStep('run');
      let res: Json = null;
      try {
        const started = await call('simulate_step', simArgs(wall, speed, true, cashFloor), 10);
        if (!started.ok) { stop = `step_refused: ${started.error}`; break; }
        const id = started.result?.id;
        const clientEnd = Date.now() + (wall + 8) * 1000;
        while (Date.now() < clientEnd) {
          await sleep(1000);
          res = await callOk('get_simulation_step', { id }, 5);
          if (res.status !== 'running') break;
        }
        if (!res || res.status === 'running') {
          if (id) { try { await callOk('cancel_simulation_step', { id }, 5); } catch { notes.push('cancel not confirmed'); } }
          stop = 'client_deadline'; break;
        }
      } finally { release(); }
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
