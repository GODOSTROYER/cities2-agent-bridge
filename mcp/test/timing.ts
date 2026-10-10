// Offline timing test: wraps a fake server, calls three tools in-process, checks the log and summary.
// Never touches the game. Points CS2_TIMINGS at a temp file before importing the module.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpFile = join(tmpdir(), `cs2-timings-test-${process.pid}-${Date.now()}.jsonl`);
process.env.CS2_TIMINGS = tmpFile;
const { instrument, summarize } = await import('../src/timing.ts');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${!ok && detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const fake: any = {
    tools: {} as Record<string, any>,
    registerTool(name: string, _config: unknown, cb: any) {
      this.tools[name] = cb;
    },
  };
  instrument(fake);

  fake.registerTool('a', {}, async () => {
    await sleep(30);
    return { content: [{ type: 'text', text: JSON.stringify({ x: 1, phases: { plan: 5 } }) }] };
  });
  fake.registerTool('b', {}, async () => ({ content: [{ type: 'text', text: 'not json' }] }));
  fake.registerTool('c', {}, async () => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ err: 'boom' }) }],
  }));

  const ra = await fake.tools.a({}, {});
  const rb = await fake.tools.b({}, {});
  const rc = await fake.tools.c({}, {});

  // Handler result handling
  let aObj: any = null;
  try {
    aObj = JSON.parse(ra.content[0].text);
  } catch {
    aObj = null;
  }
  check('a: result text parses to object with x === 1', aObj?.x === 1);
  check('a: ms >= 25', typeof aObj?.ms === 'number' && aObj.ms >= 25, String(aObj?.ms));
  check('b: non-JSON text unchanged', rb.content[0].text === 'not json');
  check('c: isError preserved', rc.isError === true);

  // Log file
  const lines = existsSync(tmpFile) ? readFileSync(tmpFile, 'utf8').split('\n').filter(Boolean) : [];
  check('log has 3 lines', lines.length === 3, `got ${lines.length}`);
  const entries: any[] = lines.map(l => JSON.parse(l));
  const names = entries.map(e => e.tool).join(',');
  check('log tool names are a,b,c', names === 'a,b,c', names);
  const oks = entries.map(e => e.ok).join(',');
  check('log ok flags are true,true,false', oks === 'true,true,false', oks);
  check('first log line has phases.plan === 5', entries[0]?.phases?.plan === 5);

  // Summary
  const s: any = await summarize();
  check('summary calls === 3', s.calls === 3, String(s.calls));
  check('summary tools sorted by totalMs desc, a first', s.tools[0]?.tool === 'a' &&
    s.tools.every((t: any, i: number, arr: any[]) => i === 0 || arr[i - 1].totalMs >= t.totalMs));
  check('summary counts c as failed', s.tools.find((t: any) => t.tool === 'c')?.failed === 1);
  check('summary slowest[0] is a', s.slowest?.[0]?.tool === 'a');
  const future = await summarize(new Date(Date.now() + 60_000).toISOString());
  check('summary with future since has calls === 0', future.calls === 0, String(future.calls));

  // Domain / transport / verified classes (B12). Runs after the checks above, which see only a, b, c.
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
  fake.registerTool('d', {}, async () => text(JSON.stringify({ ok: false, reason: 'grid_blocked' })));
  fake.registerTool('e', {}, async () => text(JSON.stringify({ ok: false, partial: true, reason: 'half_built' })));
  fake.registerTool('f', {}, async () => text(JSON.stringify({ ok: true, connected: true })));
  fake.registerTool('g', {}, async () => text(JSON.stringify({ ok: true })));
  fake.registerTool('h', {}, async () => {
    throw new Error('bridge down');
  });
  fake.registerTool('i', {}, async () => text('plain words, not json'));
  fake.registerTool('k', {}, async () => text(JSON.stringify({ ok: true, at: { x: 1, z: 2 } })));

  await fake.tools.d({}, {});
  await fake.tools.e({}, {});
  await fake.tools.f({}, {});
  await fake.tools.g({}, {});
  let thrown = '';
  try {
    await fake.tools.h({}, {});
  } catch (err: any) {
    thrown = String(err?.message);
  }
  await fake.tools.i({}, {});
  await fake.tools.k({}, {});
  // Old-format lines (written before B12, only `ok`) must still be summarised.
  appendFileSync(tmpFile, JSON.stringify({ utc: '2020-01-01T00:00:00.000Z', tool: 'old', ms: 7, ok: false }) + '\n');
  appendFileSync(tmpFile, JSON.stringify({ utc: '2020-01-01T00:00:01.000Z', tool: 'oldOk', ms: 3, ok: true }) + '\n');

  const all: any[] = existsSync(tmpFile)
    ? readFileSync(tmpFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const by = (tool: string): any => all.find(e => e.tool === tool) ?? {};

  check('d: transport ok, domain failed, ok false', by('d').transport === 'ok' && by('d').domain === 'failed' && by('d').ok === false,
    JSON.stringify(by('d')));
  check('d: reason grid_blocked logged', by('d').reason === 'grid_blocked', String(by('d').reason));
  check('e: domain partial (over failed), ok false, verified false', by('e').domain === 'partial' && by('e').ok === false && by('e').verified === false,
    JSON.stringify(by('e')));
  check('e: reason half_built logged', by('e').reason === 'half_built', String(by('e').reason));
  check('f: {ok:true,connected:true} -> verified true, domain ok, ok true', by('f').verified === true && by('f').domain === 'ok' && by('f').ok === true,
    JSON.stringify(by('f')));
  check('g: {ok:true} -> verified null', by('g').verified === null && by('g').ok === true, JSON.stringify(by('g')));
  check('h: throwing handler -> transport error, ok false, error rethrown',
    by('h').transport === 'error' && by('h').ok === false && by('h').domain === 'n/a' && thrown === 'bridge down',
    `thrown=${thrown}`);
  check('i: non-JSON text -> domain n/a, transport ok', by('i').domain === 'n/a' && by('i').transport === 'ok' && by('i').ok === true,
    JSON.stringify(by('i')));
  check('k: {ok:true,at:{...}} -> verified true', by('k').verified === true, JSON.stringify(by('k')));

  const s2: any = await summarize();
  const row = (tool: string): any => s2.tools.find((t: any) => t.tool === tool) ?? {};
  const NUMERIC = ['n', 'avgMs', 'p50Ms', 'maxMs', 'totalMs', 'transportErrors', 'domainFailed', 'partial', 'verified', 'failed'];
  check('summary rows carry all numeric fields', s2.tools.every((t: any) => NUMERIC.every(k => typeof t[k] === 'number')));
  check('summary d: domainFailed 1, transportErrors 0, failed 1',
    row('d').domainFailed === 1 && row('d').transportErrors === 0 && row('d').failed === 1, JSON.stringify(row('d')));
  check('summary e: partial 1, domainFailed 0, failed 1',
    row('e').partial === 1 && row('e').domainFailed === 0 && row('e').failed === 1, JSON.stringify(row('e')));
  check('summary f: verified 1; g: verified 0', row('f').verified === 1 && row('g').verified === 0);
  check('summary h: transportErrors 1, failed 1', row('h').transportErrors === 1 && row('h').failed === 1, JSON.stringify(row('h')));
  check('summary i: no failure classes', row('i').failed === 0 && row('i').domainFailed === 0 && row('i').partial === 0);
  check('summary c (isError): transportErrors 1', row('c').transportErrors === 1 && row('c').failed === 1);
  check('old ok:false line -> transportErrors 1', row('old').transportErrors === 1 && row('old').failed === 1 && row('old').domainFailed === 0,
    JSON.stringify(row('old')));
  check('old ok:true line -> transport ok, domain n/a, failed 0', row('oldOk').n === 1 && row('oldOk').failed === 0);
  check('totals: transportErrors 3 (c, h, old)', s2.totals?.transportErrors === 3, JSON.stringify(s2.totals));
  check('totals: domainFailed 1, partial 1, verified 2 (f, k)',
    s2.totals?.domainFailed === 1 && s2.totals?.partial === 1 && s2.totals?.verified === 2, JSON.stringify(s2.totals));
}

try {
  await main();
} catch (err: any) {
  console.log(`FAIL: unexpected error: ${String(err?.stack ?? err)}`);
  failures++;
} finally {
  rmSync(tmpFile, { force: true });
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
