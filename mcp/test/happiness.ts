// Offline checks for src/happiness.ts: pure functions and temp files only. Never talks to the game.
// Usage: node test/happiness.ts (from the mcp folder). Exit 0 when all pass, 1 otherwise.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'happiness-test-'));
const historyFile = join(dir, 'history.jsonl');
const actionsFile = join(dir, 'actions.jsonl');
// Set before importing so the module picks up the temp paths instead of the repo journals.
process.env.CS2_HAPPINESS_HISTORY = historyFile;
process.env.CS2_ACTIONS = actionsFile;
const H: any = await import('../src/happiness.ts');

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
const lines = (file: string): any[] =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60000).toISOString();
const act = (min: number, need: string, factor?: number): any => ({ utc: ago(min), need, tool: 'test', factor });
// The assessed row for one factor (or undefined when it is not listed).
function row(factor: string, value: number, actions: any[] = [], history: any[] = [], nowMs = NOW): any {
  return H.assess({ factors: { [factor]: value }, history, actions, nowMs }).find((r: any) => r.factor === factor);
}

try {
  // priorityOf boundaries
  check('priorityOf(-5.1) is very_high', H.priorityOf(-5.1) === 'very_high');
  check('priorityOf(-5) is priority', H.priorityOf(-5) === 'priority');
  check('priorityOf(-3.1) is priority', H.priorityOf(-3.1) === 'priority');
  check('priorityOf(-3) is priority and -2 is normal (owner limit -2)', H.priorityOf(-3) === 'priority' && H.priorityOf(-2) === 'normal');
  check('priorityOf(0) is normal', H.priorityOf(0) === 'normal');

  // assess with no actions: sorted worst first, positives absent
  const rows = H.assess({ factors: { Crime: -7.4, TrafficPenalty: -3.4, Tax: -1.8, Leisure: 1.1 }, history: [], actions: [], nowMs: NOW });
  const names = rows.map((r: any) => r.factor);
  check('assess lists only negative factors, worst first', JSON.stringify(names) === '["Crime","TrafficPenalty","Tax"]', JSON.stringify(names));
  check('Crime with no actions is act_now', rows[0]?.verdict === 'act_now', String(rows[0]?.verdict));
  check('TrafficPenalty with no actions is act', rows[1]?.verdict === 'act', String(rows[1]?.verdict));
  check('Tax is exempt by owner decision: report_only, priority exempt', rows[2]?.verdict === 'report_only' && rows[2]?.priority === 'exempt', String(rows[2]?.verdict));
  check('Crime maps to the police need', rows[0]?.need === 'police' && rows[0]?.fix.startsWith('police stations'));

  // two actions: base is the first action's recorded factor
  const twoPolice = [act(20, 'police', -7.5), act(10, 'police', -7.5)];
  const inv = row('Crime', -7.4, twoPolice);
  check('two police actions, little change: investigate', inv?.verdict === 'investigate', String(inv?.verdict));
  check('two police actions are counted with lastActionMinAgo', inv?.actions === 2 && inv?.lastActionMinAgo === 10, JSON.stringify(inv));
  check('two police actions, -6.6 now: improving', row('Crime', -6.6, twoPolice)?.verdict === 'improving', String(row('Crime', -6.6, twoPolice)?.verdict));
  check('two actions, last 2 min ago: waiting', row('Crime', -7.4, [act(30, 'police', -7.5), act(2, 'police', -7.5)])?.verdict === 'waiting');

  // one action
  check('one action 2 min ago: waiting', row('Crime', -7.4, [act(2, 'police', -7.5)])?.verdict === 'waiting');
  check('one action 20 min ago, -7 now: act_now', row('Crime', -7, [act(20, 'police', -7.5)])?.verdict === 'act_now');

  // actions for another need do not count
  const other = row('Crime', -7, [act(20, 'traffic', -7.5), act(10, 'traffic', -7.5)]);
  check('actions for another need do not count', other?.actions === 0 && other?.verdict === 'act_now', JSON.stringify(other));

  // unknown factor
  const unknown = row('Gremlins', -6);
  check('unknown factor is no_fix_known', unknown?.verdict === 'no_fix_known' && unknown?.need === null && unknown?.fix === '', JSON.stringify(unknown));

  // delta: oldest history record in the window that has the factor
  const history = [
    { utc: ago(30), f: { Crime: -8 } },
    { utc: ago(300), f: { Crime: -2 } }, // 5 h old: outside the 3 h window
    { utc: ago(150), f: { Tax: 0 } }, // in the window but without Crime
    { utc: ago(120), f: { Crime: -9 } }, // oldest in the window that has Crime
  ];
  const trend = row('Crime', -7.4, [], history);
  check('delta uses the oldest in-window record', trend?.first === -9 && trend?.delta === 1.6, JSON.stringify(trend));

  // recordFactors: one line per 60 s
  const snap = { liveFrame: 1000, city: { pop: 5000 }, happy: 61, happiness: { Crime: -7.4, Tax: -1.8 } };
  check('recordFactors first call writes', (await H.recordFactors(snap, NOW)) === true);
  check('one history line after first call', lines(historyFile).length === 1);
  const rec = lines(historyFile)[0] ?? {};
  check('record holds utc, frame, pop, happy, f',
    rec.utc === ago(0) && rec.frame === 1000 && rec.pop === 5000 && rec.happy === 61 && rec.f?.Crime === -7.4,
    JSON.stringify(rec));
  check('second call within 60 s writes nothing', (await H.recordFactors(snap, NOW + 1000)) === false && lines(historyFile).length === 1);
  check('snapshot without happiness writes nothing', (await H.recordFactors({ happy: 3 }, NOW + 200000)) === false && lines(historyFile).length === 1);
  check('call 61 s later writes a second line', (await H.recordFactors(snap, NOW + 61000)) === true && lines(historyFile).length === 2);
  const fresh: any = await import('../src/happiness.ts?fresh=1'); // new module instance: must seed from the last line
  check('fresh module reads the last line and skips a write 1 s later', (await fresh.recordFactors(snap, NOW + 62000)) === false && lines(historyFile).length === 2);

  // recordAction appends
  await H.recordAction({ need: 'police', tool: 'place_building', detail: 'test', factor: -7.4 }, NOW);
  await H.recordAction({ need: 'police', tool: 'place_building', factor: -7.4 }, NOW + 1000);
  const acts = lines(actionsFile);
  check('recordAction appends two lines', acts.length === 2, String(acts.length));
  check('recordAction line carries utc and fields',
    acts[0]?.utc === ago(0) && acts[0]?.need === 'police' && acts[0]?.tool === 'place_building' && acts[0]?.factor === -7.4,
    JSON.stringify(acts[0]));
  check('paths come from the environment', H.HISTORY_PATH === historyFile && H.ACTIONS_PATH === actionsFile);

  // readJsonl
  const missing = await H.readJsonl(join(dir, 'missing.jsonl'));
  check('readJsonl of a missing file is []', Array.isArray(missing) && missing.length === 0);
  check('readJsonl parses the actions file', (await H.readJsonl(actionsFile)).length === 2);
} catch (err: any) {
  check('no unexpected exception', false, String(err?.stack ?? err));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
