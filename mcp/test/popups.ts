// Offline test: fixPopups must survive a phase change between its read and its resolve.
// Uses a temp mailbox (never the real one) and an in-process fake mod. Makes no game calls.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 30000;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
  if (!ok) failures++;
};

async function main(): Promise<number> {
  const mailbox = await fs.mkdtemp(join(tmpdir(), 'cs2-popups-'));
  process.env.CS2_MAILBOX = mailbox; // MAILBOX is read at import time, so set it first
  await fs.mkdir(join(mailbox, 'requests'));
  await fs.mkdir(join(mailbox, 'responses'));

  const session = { status: 'ready', session: 's1', citySession: 'c1', heartbeatUtc: '' };
  const writeSession = async () => {
    session.heartbeatUtc = new Date().toISOString();
    const tmp = join(mailbox, 'session.json.tmp');
    await fs.writeFile(tmp, JSON.stringify(session), 'utf8');
    await fs.rename(tmp, join(mailbox, 'session.json'));
  };
  await writeSession();
  const heartbeat = setInterval(() => { writeSession().catch(() => {}); }, 500);

  // Fake mod state: the tutorial phase moves on the first resolve, as in the race.
  const state = { phase: 'CemeteryTutorialIntro', likelyBlocker: 'tutorial_phase', resolvableByBridge: true };
  let resolveCalls = 0;
  const seen: { command: string; args: any }[] = [];
  const handle = (command: string, args: any): { ok: boolean; result?: any; error?: string } => {
    seen.push({ command, args });
    if (command === 'get_ui_state') {
      return {
        ok: true,
        result: {
          likelyBlocker: state.likelyBlocker,
          resolvableByBridge: state.resolvableByBridge,
          tutorial: { activeTutorialPhase: state.phase },
          milestone: {},
        },
      };
    }
    if (command === 'resolve_pause_blocker') {
      resolveCalls++;
      if (resolveCalls === 1) {
        state.phase = 'HappinessTutorialIntro';
        return { ok: false, error: 'InvalidOperationException: tutorial_phase_changed: now HappinessTutorialIntro' };
      }
      if (args?.expectedPhase !== state.phase) {
        return { ok: false, error: `InvalidOperationException: tutorial_phase_changed: now ${state.phase}` };
      }
      state.likelyBlocker = 'none';
      state.resolvableByBridge = false;
      return { ok: true, result: { completedPhase: state.phase } };
    }
    return { ok: false, error: 'unknown_command: ' + command };
  };

  // Fake mod: every 30 ms take each request file, delete it, answer with the same id.
  // One tick at a time: under load two overlapping ticks answered the same request and the second rename failed (ENOENT).
  let ticking = false;
  const mod = setInterval(async () => {
    if (ticking) return; ticking = true;
    try { await tick(); } finally { ticking = false; }
  }, 30);
  const tick = async () => {
    let names: string[];
    try { names = (await fs.readdir(join(mailbox, 'requests'))).filter(n => n.endsWith('.json')); }
    catch { return; }
    for (const name of names) {
      const path = join(mailbox, 'requests', name);
      let packet: any;
      try { packet = JSON.parse(await fs.readFile(path, 'utf8')); }
      catch { continue; } // still being written; picked up next tick
      await fs.unlink(path).catch(() => {});
      const reply = handle(packet.command, packet.args);
      const out = join(mailbox, 'responses', packet.id + '.json');
      await fs.writeFile(out + '.tmp', JSON.stringify(reply), 'utf8');
      await fs.rename(out + '.tmp', out).catch(() => {});
    }
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const bridge = await import('../src/bridge.ts');
    const work = (async () => {
      const actions = await bridge.fixPopups(10);
      console.log('actions: ' + JSON.stringify(actions));
      return actions;
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    });
    const actions: string[] = await Promise.race([work, deadline]);

    const resolves = seen.filter(s => s.command === 'resolve_pause_blocker');
    check('first resolve targets CemeteryTutorialIntro', resolves[0]?.args?.expectedPhase === 'CemeteryTutorialIntro', String(resolves[0]?.args?.expectedPhase));
    check('actions contain a retry', actions.some(a => a.startsWith('retry:')));
    check('actions contain complete_tutorial_phase:HappinessTutorialIntro', actions.includes('complete_tutorial_phase:HappinessTutorialIntro'));
    check('last action is blocker=none', actions.at(-1) === 'blocker=none', String(actions.at(-1)));
  } catch (e: any) {
    check('fixPopups completed', false, String(e?.message ?? e));
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(mod);
    clearInterval(heartbeat);
    await fs.rm(mailbox, { recursive: true, force: true }).catch(() => {});
  }
  return failures ? 1 : 0;
}

process.exitCode = await main();
