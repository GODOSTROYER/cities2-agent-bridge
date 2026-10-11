// Offline checks: the shared work queue (status line, attention, stall alarm, code items).
import { unblocked, queueLine, queueDoing, queueAttention, stalled, nextCodeItem, applyCodeResult, queueMarkdown } from '../src/queue.ts';
import type { QueueItem } from '../src/queue.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const now = Date.parse('2026-10-11T13:00:00Z'); const iso = (min: number) => new Date(now + min * 60000).toISOString();
const it = (id: string, priority: number, status: QueueItem['status'], extra: Partial<QueueItem> = {}): QueueItem => ({ id, title: id + ' title', priority, status, owner: 'opus', created: iso(-300), updated: iso(-300), ...extra });

check(queueLine([], now) === '' && queueAttention([], now) === '' && stalled([], 0, now) === '', 'an empty queue adds nothing to the status line and raises nothing');
const q = [it('a', 1, 'in_progress'), it('b', 2, 'queued'), it('c', 3, 'queued'), it('d', 4, 'blocked', { blocker: 'needs 4 points' }), it('e', 5, 'done'), it('f', 6, 'dropped')];
check(queueLine(q, now) === 'queue: 1 in progress, 2 queued, 1 blocked (d: needs 4 points)', 'the status line counts in progress, queued and blocked with the reason: ' + queueLine(q, now));
check(unblocked(q, now).map(i => i.id).join() === 'a,b,c', 'unblocked items are the queued and in-progress ones, in priority order');
check(queueDoing(q, now) === 'in hand: a', 'instead of "nothing due" the line names the item in hand');
check(queueAttention(q, now) === '', 'no attention while somebody works on an item');
const idle = [it('b', 2, 'queued'), it('c', 1, 'queued'), it('d', 4, 'blocked', { blocker: 'x' })];
check(queueAttention(idle, now) === 'queue has 2 unblocked items and nobody is working on them (first: c)', 'two queued items and nobody on them wakes the agent: ' + queueAttention(idle, now));
check(queueDoing(idle, now) === 'queue next: c, b', 'with nobody on them the line names the next items by priority');
check(queueAttention([it('d', 1, 'blocked', { blocker: 'x' }), it('e', 2, 'done')], now) === '' && queueDoing([it('d', 1, 'blocked', { blocker: 'x' })], now) === '', 'a queue of blocked and done items is quiet ("nothing due" is allowed)');
// waiting for a measurement window or for money is not "unblocked"
const w = [it('m', 1, 'in_progress', { waitUntil: iso(30), waitFor: 'a game day of ridership' }), it('n', 2, 'done')];
check(unblocked(w, now).length === 0 && queueAttention(w, now) === '' && stalled(w, 0, now) === '', 'an item waiting for a window neither wakes the agent nor stalls');
check(/1 waiting \(m: a game day of ridership until 13:30\)/.test(queueLine(w, now)), 'the line says what is waited for and until when: ' + queueLine(w, now));
check(unblocked(w, now + 31 * 60000).length === 1, 'when the window ends the item is unblocked again');
// stall alarm
check(stalled(q, now - 19 * 60000, now) === '', '19 minutes without a build is not yet a stall');
check(/^STALLED: 21 minutes without a build action or a queue change while 3 unblocked items wait \(first: a\)/.test(stalled(q, now - 21 * 60000, now)), '21 minutes without a build action or a queue change is STALLED: ' + stalled(q, now - 21 * 60000, now));
check(stalled([it('a', 1, 'in_progress', { updated: iso(-5) })], now - 60 * 60000, now) === '', 'a queue status change 5 minutes ago resets the stall clock');
check(stalled([it('d', 1, 'blocked', { blocker: 'x' })], 0, now) === '', 'blocked items alone never stall');
// code items
const c = [it('x', 1, 'queued'), it('school', 2, 'queued', { owner: 'code', code: { tool: 'fix_services', args: { maxPlacements: 2 }, times: 2 } }), it('bad', 3, 'queued', { owner: 'code', code: { tool: 'remove_road', args: {} } })];
check(nextCodeItem(c, now)?.id === 'school', 'the loop takes the code-owned item with an allowed tool, never an opus item or a tool outside the list');
const s = c[1]; const n1 = applyCodeResult(s, { placed: [{ prefab: 'ElementarySchool01' }] }, iso(0));
check(s.status === 'in_progress' && s.code!.done === 1 && n1 === 'queue school: step 1/2' && s.updated === iso(0), 'one successful step of two leaves the item in progress');
applyCodeResult(s, { placed: [{ prefab: 'ElementarySchool01' }] }, iso(1)); check(s.status === 'done', 'the last step marks the item done');
const e = it('sch', 1, 'queued', { owner: 'code', code: { tool: 'fix_services', args: { only: ['education'] } } }); applyCodeResult(e, { placed: [] }, iso(0));
check(e.status === 'blocked' && /nothing to place/.test(e.blocker ?? ''), 'a service rule that places nothing hands the item to the agent (two parks were built once by an unfiltered step)');
const f = it('p', 1, 'queued', { owner: 'code', code: { tool: 'place_service', args: {} } }); const n2 = applyCodeResult(f, { ok: false, reason: 'no_site' }, iso(0));
check(f.status === 'blocked' && f.owner === 'opus' && /no_site/.test(f.blocker ?? '') && /BLOCKED/.test(n2), 'a step code cannot do is handed to the agent as blocked with the reason, not retried in silence');
const md = queueMarkdown(q, now);
check(md.startsWith('- QUEUE: 1 in progress') && md.indexOf(' a (opus)') < md.indexOf(' b (opus)') && /BLOCKED: needs 4 points/.test(md), 'progress.md lists the queue, open items first, with the blocker');
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`); process.exit(failed ? 1 : 0);
