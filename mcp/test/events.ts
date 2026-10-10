// Offline test of event paging (pageEvents, and readEvents over a temp mailbox). Makes no game calls.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// bridge.ts reads CS2_MAILBOX at import time, so it is set first and bridge.ts imported after.
const dir = await fs.mkdtemp(join(tmpdir(), 'cs2-events-'));
process.env.CS2_MAILBOX = dir;
const { pageEvents, readEvents } = await import('../src/bridge.ts');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || !detail ? '' : ' (' + detail + ')'}`);
  if (!ok) failures++;
};

const S = 'aaaaaaaa', B = 'bbbbbbbb', EARLY = '2026-01-01T00:00:00Z';
const utcAt = (n: number) => `2026-10-10T10:00:${String(n).padStart(2, '0')}.0000000Z`;
const ev = (s: string | null, seq: number, type = 'x', utc = utcAt(seq)): any =>
  ({ ...(s === null ? {} : { s }), seq, type, frame: seq * 100, utc, data: {} });
const run = (s: string, from: number, to: number, type = 'x'): any[] => {
  const out: any[] = [];
  for (let n = from; n <= to; n++) out.push(ev(s, n, type));
  return out;
};
const nums = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const seqs = (evs: any[]): number[] => evs.map(e => e.seq);
const ids = (evs: any[]): string[] => evs.map(e => `${e.s ?? ''}:${e.seq}`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown): string => JSON.stringify(v);

// 1. First look: newest `limit`, no more, cursor of the last event.
{
  const r = pageEvents(run(S, 1, 25), undefined, 10);
  check('no since: newest limit, hasMore false, cursor of last',
    same(seqs(r.events), nums(16, 25)) && r.hasMore === false && r.cursor === `${S}:25` && r.gap === undefined, show(r));
}

// 2. Cursor paging: 25 events, limit 10 -> 10, 10, 5; hasMore true, true, false; no dups, no skips.
{
  const list = run(S, 1, 25);
  const pages: any[] = [];
  let r = pageEvents(list, EARLY, 10);
  pages.push(r);
  while (r.hasMore) { r = pageEvents(list, r.cursor, 10); pages.push(r); }
  const got = pages.flatMap(p => seqs(p.events));
  check('cursor paging 25/10: sizes 10,10,5 and hasMore true,true,false',
    same(pages.map(p => p.events.length), [10, 10, 5]) && same(pages.map(p => p.hasMore), [true, true, false]), show(pages.map(p => [p.events.length, p.hasMore])));
  check('cursor paging 25/10: all 25 in order, no duplicates, no gap',
    same(got, nums(1, 25)) && pages.every(p => p.gap === undefined), show(got));
}

// 3. Three events sharing one utc are each returned exactly once across pages.
{
  const list = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ev(S, n, 'x', (n >= 4 && n <= 6) ? '2026-10-10T10:00:04.0000000Z' : utcAt(n)));
  const got: number[] = [];
  let r = pageEvents(list, EARLY, 2);
  got.push(...seqs(r.events));
  while (r.hasMore) { r = pageEvents(list, r.cursor, 2); got.push(...seqs(r.events)); }
  check('same utc shared by 3 events: each returned exactly once', same(got, nums(1, 9)), show(got));
}

// 4. Types filter: non-matching events are passed over by the cursor, not re-read.
{
  const list = [ev(S, 1), ev(S, 2), ...nums(3, 10).map(n => ev(S, n, 'y'))];
  const p1 = pageEvents(list, EARLY, 5, ['x']);
  const p2 = pageEvents(list, p1.cursor, 5, ['x']);
  check('types filter: cursor moves past non-matching events to the last scanned',
    same(seqs(p1.events), [1, 2]) && p1.cursor === `${S}:10` && p1.hasMore === false && p2.events.length === 0 && p2.cursor === `${S}:10` && p2.hasMore === false,
    show({ p1: [seqs(p1.events), p1.cursor, p1.hasMore], p2: [p2.events.length, p2.cursor] }));
  const q1 = pageEvents(list, EARLY, 2, ['y']);
  const q2 = pageEvents(list, q1.cursor, 2, ['y']);
  check('types filter with a full page: cursor stops at the last scanned match, hasMore true',
    same(seqs(q1.events), [3, 4]) && q1.cursor === `${S}:4` && q1.hasMore === true && same(seqs(q2.events), [5, 6]) && q2.cursor === `${S}:6`,
    show({ q1: [seqs(q1.events), q1.cursor, q1.hasMore], q2: [seqs(q2.events), q2.cursor] }));
}

// 5. cursor_not_found: the cursor's event is absent (other session, or rotated away within its session).
{
  const r = pageEvents(run(S, 1, 5), `cccccccc:3`, 10);
  check('cursor_not_found: unknown session returns oldest available with gap',
    same(seqs(r.events), nums(1, 5)) && r.gap?.reason === 'cursor_not_found' && r.gap?.from === 'cccccccc:3' && r.gap?.firstAvailable === `${S}:1` && r.cursor === `${S}:5`,
    show({ gap: r.gap, cursor: r.cursor }));
  const r2 = pageEvents(run(S, 3, 5), `${S}:2`, 10);
  check('cursor_not_found: rotated-away seq resumes at the next unread event',
    same(seqs(r2.events), [3, 4, 5]) && r2.gap?.reason === 'cursor_not_found' && r2.gap?.firstAvailable === `${S}:3`,
    show({ events: seqs(r2.events), gap: r2.gap }));
}

// 6. session_restarted: seq 1 again under a new session id; everything returned in order, gap once.
{
  const list = [...run(S, 1, 3), ...run(B, 1, 4)];
  const r = pageEvents(list, `${S}:2`, 10);
  check('session restart: old tail then new session in order, gap session_restarted',
    same(ids(r.events), [`${S}:3`, `${B}:1`, `${B}:2`, `${B}:3`, `${B}:4`]) && r.gap?.reason === 'session_restarted' && r.cursor === `${B}:4` && r.hasMore === false,
    show({ ids: ids(r.events), gap: r.gap, cursor: r.cursor }));
  const a = pageEvents(list, `${S}:2`, 2);
  const b = pageEvents(list, a.cursor, 2);
  const c = pageEvents(list, b.cursor, 2);
  check('session restart paged: gap reported on the page that crosses it, then none',
    same(ids(a.events), [`${S}:3`, `${B}:1`]) && a.gap?.reason === 'session_restarted' && a.hasMore === true
      && same(ids(b.events), [`${B}:2`, `${B}:3`]) && b.gap === undefined
      && same(ids(c.events), [`${B}:4`]) && c.gap === undefined && c.hasMore === false,
    show({ a: ids(a.events), b: ids(b.events), c: ids(c.events) }));
}

// 7. sequence_jump: seq 3 missing inside one session.
{
  const list = [ev(S, 1), ev(S, 2), ev(S, 4), ev(S, 5)];
  const r = pageEvents(list, `${S}:1`, 10);
  check('sequence_jump: non-consecutive seq within a session reported with expected/got',
    same(seqs(r.events), [2, 4, 5]) && r.gap?.reason === 'sequence_jump' && r.gap?.expected === 3 && r.gap?.got === 4,
    show({ events: seqs(r.events), gap: r.gap }));
}

// 8. Legacy ISO since, and legacy lines without "s" (session '').
{
  const list = run(S, 1, 10);
  const r = pageEvents(list, utcAt(3), 20);
  const r3 = pageEvents(list, utcAt(3), 3);
  check('legacy ISO since: events strictly after that time, next = last utc',
    same(seqs(r.events), nums(4, 10)) && r.next === utcAt(10) && r.hasMore === false
      && same(seqs(r3.events), [4, 5, 6]) && r3.hasMore === true && r3.next === utcAt(6),
    show({ r: seqs(r.events), r3: seqs(r3.events) }));
  const legacy = [1, 2, 3, 4, 5].map(n => ev(null, n));
  const lc = pageEvents(legacy, undefined, 10).cursor;
  const lp = pageEvents(legacy, ':2', 10);
  check('legacy lines without "s" are session \'\': cursor ":n" pages them',
    lc === ':5' && same(seqs(lp.events), [3, 4, 5]) && lp.gap === undefined, show({ lc, events: seqs(lp.events), gap: lp.gap }));
}

// 9. Legacy numeric since: seq > N within the newest session.
{
  const r = pageEvents(run(S, 1, 10), 5, 20);
  const r2 = pageEvents(run(S, 1, 10), '5', 20);
  check('legacy numeric since (number and digit string): seq > N, oldest first',
    same(seqs(r.events), nums(6, 10)) && same(seqs(r2.events), nums(6, 10)) && r.hasMore === false,
    show({ r: seqs(r.events), r2: seqs(r2.events) }));
  const mixed = [...run(S, 1, 10), ...run(B, 1, 3)];
  const m = pageEvents(mixed, '2', 20);
  check('legacy numeric since looks only at the newest session', same(ids(m.events), [`${B}:3`]), show(ids(m.events)));
}

// 10. Empty list.
{
  const a = pageEvents([], undefined, 10);
  const b = pageEvents([], `${S}:3`, 10);
  check('empty list: events [], hasMore false',
    same(a.events, []) && a.hasMore === false && a.cursor === '' && same(b.events, []) && b.hasMore === false && b.gap?.reason === 'cursor_not_found',
    show({ a, b }));
}

// 11. readEvents reads events.1.jsonl then events.jsonl and skips a torn last line.
{
  const lines = (evs: any[]) => evs.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(join(dir, 'events.1.jsonl'), lines(run(S, 1, 3)), 'utf8');
  await fs.writeFile(join(dir, 'events.jsonl'), lines(run(S, 4, 5)) + '{"s":"aaaaaaaa","seq":6,', 'utf8');
  const all = await readEvents(undefined, 10);
  const page = await readEvents(`${S}:2`, 2);
  check('readEvents: files read in order, torn line skipped, cursor paging works',
    same(seqs(all.events), nums(1, 5)) && all.cursor === `${S}:5`
      && same(seqs(page.events), [3, 4]) && page.cursor === `${S}:4` && page.hasMore === true,
    show({ all: seqs(all.events), page: [seqs(page.events), page.cursor, page.hasMore] }));
}

await fs.rm(dir, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all events checks passed');
process.exitCode = failures ? 1 : 0;
