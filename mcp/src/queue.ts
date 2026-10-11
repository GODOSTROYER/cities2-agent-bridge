// The shared work queue (journals/queue.json): every owner-approved or coordinator-requested item.
// The rule loop and the agent both read it. The loop shows it on the status line, raises ATTENTION
// when unblocked items exist and nobody works on them, raises STALLED after 20 minutes without a
// build action or a queue change, and does the items that code can do by itself (item.code).
// File: { "items": [ { id, title, priority (1 = first), status, blocker?, owner, created, updated,
//                      waitUntil?, waitFor?, code?: { tool, args, times?, done? } } ] }
import { promises as fs, statSync } from 'node:fs';
import { join } from 'node:path';

export type QueueStatus = 'queued' | 'in_progress' | 'blocked' | 'done' | 'dropped';
export interface QueueItem {
  id: string; title: string; priority: number; status: QueueStatus; blocker?: string;
  owner: 'code' | 'haiku' | 'opus'; created: string; updated: string;
  waitUntil?: string; waitFor?: string;            // a measurement window or money: not "unblocked" until then
  code?: { tool: string; args: Record<string, any>; times?: number; done?: number };
}
export const CODE_TOOLS = ['place_service', 'fix_services'];
export const STALL_MINUTES = 20;

const waiting = (i: QueueItem, now: number) => !!i.waitUntil && Date.parse(i.waitUntil) > now;
const byPriority = (a: QueueItem, b: QueueItem) => a.priority - b.priority || a.created.localeCompare(b.created);

/** Items somebody can work on right now: queued or in progress, and not waiting for a window or for money. */
export function unblocked(items: QueueItem[], now: number): QueueItem[] {
  return items.filter(i => (i.status === 'queued' || i.status === 'in_progress') && !waiting(i, now)).sort(byPriority);
}

/** "queue: 3 in progress, 9 queued, 1 waiting, 1 blocked (reason)"; empty when the queue has no open item. */
export function queueLine(items: QueueItem[], now: number): string {
  const open = items.filter(i => i.status !== 'done' && i.status !== 'dropped'); if (!open.length) return '';
  const wait = open.filter(i => i.status !== 'blocked' && waiting(i, now)); const live = open.filter(i => !wait.includes(i));
  const n = (s: QueueStatus) => live.filter(i => i.status === s).length; const blocked = live.filter(i => i.status === 'blocked');
  const parts = [`${n('in_progress')} in progress`, `${n('queued')} queued`];
  if (wait.length) parts.push(`${wait.length} waiting (${wait.slice(0, 2).map(i => `${i.id}: ${i.waitFor ?? 'window'} until ${String(i.waitUntil).slice(11, 16)}`).join('; ')})`);
  if (blocked.length) parts.push(`${blocked.length} blocked (${blocked.slice(0, 2).map(i => `${i.id}: ${String(i.blocker ?? 'no reason given').slice(0, 60)}`).join('; ')})`);
  return 'queue: ' + parts.join(', ');
}

/** What the status line says instead of "nothing due" while unblocked items exist. */
export function queueDoing(items: QueueItem[], now: number): string {
  const u = unblocked(items, now); if (!u.length) return '';
  const active = u.filter(i => i.status === 'in_progress');
  return active.length ? `in hand: ${active.slice(0, 3).map(i => i.id).join(', ')}` : `queue next: ${u.slice(0, 3).map(i => i.id).join(', ')}`;
}

/** Wakes the agent: unblocked items exist and none of them is in progress. */
export function queueAttention(items: QueueItem[], now: number): string {
  const u = unblocked(items, now); if (!u.length || u.some(i => i.status === 'in_progress')) return '';
  return `queue has ${u.length} unblocked item${u.length === 1 ? '' : 's'} and nobody is working on them (first: ${u[0].id})`;
}

/** Stall alarm: unblocked items exist and nothing was built and no queue status changed for 20 minutes. */
export function stalled(items: QueueItem[], lastActivityMs: number, now: number, minutes = STALL_MINUTES): string {
  const u = unblocked(items, now); if (!u.length) return '';
  const last = Math.max(lastActivityMs, ...items.map(i => Date.parse(i.updated) || 0));
  const idle = Math.floor((now - last) / 60000);
  return idle >= minutes ? `STALLED: ${idle} minutes without a build action or a queue change while ${u.length} unblocked item${u.length === 1 ? '' : 's'} wait (first: ${u[0].id})` : '';
}

/** The first item the loop can do by itself: owner code, an allowed tool, queued or in progress. */
export function nextCodeItem(items: QueueItem[], now: number): QueueItem | undefined {
  return unblocked(items, now).find(i => i.owner === 'code' && !!i.code && CODE_TOOLS.includes(i.code.tool));
}

/** Records the result of one code step on the item (returns the note for the status line). */
export function applyCodeResult(item: QueueItem, result: Record<string, any>, nowIso: string): string {
  item.updated = nowIso; const c = item.code!;
  const ok = c.tool === 'fix_services' ? (result.placed ?? []).length > 0 : !!result.ok;
  if (ok) { c.done = (c.done ?? 0) + 1; if (c.done >= (c.times ?? 1)) { item.status = 'done'; return `queue ${item.id}: done by code`; } item.status = 'in_progress'; return `queue ${item.id}: step ${c.done}/${c.times}`; }
  item.status = 'blocked'; item.blocker = `code could not do it: ${String(result.reason ?? result.error ?? (c.tool === 'fix_services' ? 'the service rule found nothing to place' : 'failed')).slice(0, 120)}`; item.owner = 'opus';
  return `queue ${item.id}: BLOCKED (${item.blocker})`;
}

/** The queue as a short list for progress.md, open items first by priority. */
export function queueMarkdown(items: QueueItem[], now: number): string {
  if (!items.length) return '';
  const rank: Record<string, number> = { in_progress: 0, queued: 1, blocked: 2, done: 3, dropped: 4 };
  const rows = [...items].sort((a, b) => rank[a.status] - rank[b.status] || byPriority(a, b)).map(i => `  - [${waiting(i, now) && i.status !== 'blocked' ? `waiting until ${String(i.waitUntil).slice(11, 16)} UTC for ${i.waitFor ?? 'a measurement'}` : i.status}] P${i.priority} ${i.id} (${i.owner}): ${i.title}${i.status === 'blocked' && i.blocker ? ` — BLOCKED: ${i.blocker}` : ''}`);
  return `- ${(queueLine(items, now) || 'queue: every item is done or dropped').replace('queue:', 'QUEUE:')}\n${rows.join('\n')}\n`;
}

export const queuePath = (repo: string) => join(repo, 'journals', 'queue.json');
export async function loadQueue(repo: string): Promise<{ items: QueueItem[]; mtime: number }> {
  try { const raw = JSON.parse(await fs.readFile(queuePath(repo), 'utf8')); const items = (Array.isArray(raw) ? raw : raw.items ?? []) as QueueItem[]; return { items, mtime: statSync(queuePath(repo)).mtimeMs }; } catch { return { items: [], mtime: 0 }; }
}
export async function saveQueue(repo: string, items: QueueItem[]): Promise<void> {
  const tmp = queuePath(repo) + '.tmp'; await fs.writeFile(tmp, JSON.stringify({ items }, null, 1)); await fs.rename(tmp, queuePath(repo));
}
