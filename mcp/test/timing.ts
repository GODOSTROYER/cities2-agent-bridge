// Offline timing test: wraps a fake server, calls three tools in-process, checks the log and summary.
// Never touches the game. Points CS2_TIMINGS at a temp file before importing the module.
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
