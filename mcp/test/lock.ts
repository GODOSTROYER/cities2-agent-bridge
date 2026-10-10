// Offline test of the goal lock (GoalLock, goalLock, mutate). Uses a temp mailbox (CS2_MAILBOX is
// set before bridge.ts is imported) and makes no game calls.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 20000;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function lockChecks(b: any): Promise<void> {
  const { GoalLock, goalLock, state, mutate } = b;

  check('idle: held is null and nothing waits', goalLock.held === null && goalLock.waiting === 0, `held=${goalLock.held} waiting=${goalLock.waiting}`);

  // FIFO: three overlapping run() calls start and end in call order, never overlapping.
  {
    const lock = new GoalLock();
    const events: string[] = []; let inside = 0, maxInside = 0;
    const job = (name: string, ms: number) => lock.run(name, async () => {
      events.push(`start:${name}`); inside++; maxInside = Math.max(maxInside, inside);
      await sleep(ms);
      inside--; events.push(`end:${name}`);
    });
    await Promise.all([job('a', 30), job('b', 10), job('c', 5)]);
    const want = 'start:a end:a start:b end:b start:c end:c';
    check('FIFO: three overlapping run() calls run in call order', events.join(' ') === want, events.join(' '));
    check('FIFO: never more than one holder', maxInside === 1, `max=${maxInside}`);
  }

  // Release on throw: the failing holder's fn throws (async and sync), the next waiter still runs.
  {
    const lock = new GoalLock();
    const ran: string[] = [];
    const failing = lock.run('bad', async () => { ran.push('bad'); throw new Error('boom'); });
    const syncFail = lock.run('sync', (() => { ran.push('sync'); throw new Error('sync boom'); }) as any);
    const next = lock.run('next', async () => { ran.push('next'); return 42; });
    const [r1, r2, r3] = await Promise.allSettled([failing, syncFail, next]);
    check('throw: async throw rejects the caller', r1.status === 'rejected' && (r1.reason as Error).message === 'boom');
    check('throw: sync throw rejects the caller', r2.status === 'rejected' && (r2.reason as Error).message === 'sync boom');
    check('throw: next waiter still runs after throws', r3.status === 'fulfilled' && r3.value === 42 && ran.join() === 'bad,sync,next', ran.join());
    check('throw: lock is free afterwards', lock.held === null && lock.waiting === 0);
  }

  // Double release is harmless, including a stale release after a new holder took the lock.
  {
    const lock = new GoalLock();
    const r1 = await lock.acquire('a');
    r1(); r1();
    check('double release: lock free after two releases', lock.held === null);
    const rb = await lock.acquire('b');
    r1();
    check('double release: stale release does not free the new holder', lock.held === 'b', String(lock.held));
    rb();
    check('double release: holder release frees the lock', lock.held === null);
  }

  // waiting counts queued callers and drops as they are granted.
  {
    const lock = new GoalLock();
    const r1 = await lock.acquire('holder');
    const p2 = lock.acquire('w1'); const p3 = lock.acquire('w2');
    check('waiting: two queued callers counted behind the holder', lock.waiting === 2 && lock.held === 'holder', `waiting=${lock.waiting} held=${lock.held}`);
    r1();
    const r2 = await p2;
    check('waiting: drops to 1 when the first waiter is granted', lock.waiting === 1 && lock.held === 'w1', `waiting=${lock.waiting} held=${lock.held}`);
    r2();
    const r3 = await p3;
    check('waiting: second waiter granted next, queue empty', lock.waiting === 0 && lock.held === 'w2');
    r3();
    check('waiting: free after all releases', lock.held === null);
  }

  // Abandoned waiter (its signal aborts while queued): it leaves the queue and the next one advances.
  {
    const lock = new GoalLock();
    const r1 = await lock.acquire('holder');
    const ac = new AbortController();
    const abandoned = lock.acquire('abandoned', ac.signal).then(() => 'granted', () => 'rejected');
    const next = lock.acquire('next');
    ac.abort();
    check('abandon: aborted waiter leaves the queue', lock.waiting === 1, `waiting=${lock.waiting}`);
    r1();
    const rn = await next;
    check('abandon: queue advances past the abandoned waiter', lock.held === 'next', String(lock.held));
    rn();
    check('abandon: abandoned promise rejected, lock free', (await abandoned) === 'rejected' && lock.held === null);
  }

  // Nested mutate() inside mutate() completes (no deadlock) and state.mutating returns to 0.
  {
    let innerHeld: string | null = null;
    const outer = await mutate(async () => {
      const inner = await mutate(async () => { innerHeld = goalLock.held; return 'inner'; });
      const deepest = await mutate(() => mutate(async () => 'deep'));
      return `outer+${inner}+${deepest}`;
    });
    check('nested mutate: completes without deadlock', outer === 'outer+inner+deep', String(outer));
    check('nested mutate: inner call runs under the mutation lock', innerHeld === 'mutation', String(innerHeld));
    check('nested mutate: state.mutating back to 0', state.mutating === 0, String(state.mutating));
    check('nested mutate: lock released', goalLock.held === null);
  }

  // Two concurrent top-level mutate() calls never overlap; the queued one is counted in state.mutating.
  {
    let inside = 0, maxInside = 0, seenMutating = -1;
    const m = (n: number) => mutate(async () => {
      if (n === 1) seenMutating = state.mutating;
      inside++; maxInside = Math.max(maxInside, inside);
      await sleep(20);
      inside--;
      return n;
    });
    const [x, y] = await Promise.all([m(1), m(2)]);
    check('concurrent mutate: never overlap', maxInside === 1, `max=${maxInside}`);
    check('concurrent mutate: both complete, in call order', x === 1 && y === 2, `${x},${y}`);
    check('concurrent mutate: state.mutating counts the queued caller', seenMutating === 2, `seen=${seenMutating}`);
  }

  check('done: held is null and state.mutating is 0', goalLock.held === null && state.mutating === 0 && goalLock.waiting === 0);
}

async function main(): Promise<number> {
  const mailbox = await fs.mkdtemp(join(tmpdir(), 'cs2-lock-'));
  process.env.CS2_MAILBOX = mailbox; // MAILBOX is read at import time, so set it first
  let timer: NodeJS.Timeout | undefined;
  try {
    const bridge = await import('../src/bridge.ts');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS} ms (deadlock?)`)), TIMEOUT_MS);
    });
    await Promise.race([lockChecks(bridge), deadline]);
  } catch (e: any) {
    check('lock checks completed', false, String(e?.message ?? e));
  } finally {
    if (timer) clearTimeout(timer);
    await fs.rm(mailbox, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failures ? `RESULT: FAIL (${failures} failed)` : 'RESULT: PASS');
  return failures ? 1 : 0;
}

process.exitCode = await main();
