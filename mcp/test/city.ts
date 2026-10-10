// Offline checks for the pure helpers in src/city.ts. Nothing here calls a bridge function.
// city.ts is imported only after fs.promises and fetch are replaced with spies that record
// (and refuse) any I/O, so a module that touches the disk or network at import time fails.
import { promises as fsp } from 'node:fs';

const ioCalls: string[] = [];
const spied: Record<string, unknown> = {};
const fsNames = ['readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'mkdir', 'rm', 'rename', 'unlink', 'open', 'access', 'copyFile'];
const fsObj = fsp as unknown as Record<string, unknown>;
for (const n of fsNames) {
  spied[n] = fsObj[n];
  fsObj[n] = async () => { ioCalls.push(`fs.promises.${n}`); throw new Error(`io during import: fs.promises.${n}`); };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { ioCalls.push('fetch'); throw new Error('io during import: fetch'); }) as typeof fetch;

const city = await import('../src/city.ts');

for (const n of fsNames) fsObj[n] = spied[n];
globalThis.fetch = realFetch;

let failures = 0;
function run(name: string, fn: () => boolean, detail = '') {
  let pass = false; let note = detail;
  try { pass = fn(); } catch (e) { note = `threw: ${String((e as Error)?.message ?? e)}`; }
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : note ? ` (${note})` : ''}`);
}

// ---- import-time I/O ----
run('import city.ts performs no fs or fetch I/O', () => ioCalls.length === 0, ioCalls.join(', '));
run('invalidatePrefabCache is exported and callable', () => { city.invalidatePrefabCache(); return true; });

// ---- gridOutcome ----
const good = { linked: true, connectorUsed: true, connected: true, zoneStatus: 'complete', leftZonable: 0 };
run('gridOutcome: all good -> ok', () => {
  const r = city.gridOutcome(good);
  return r.ok === true && r.partial === undefined && r.reason === undefined;
});
run('gridOutcome: nothing_to_zone with 0 left and no connector -> ok', () => {
  const r = city.gridOutcome({ linked: true, connectorUsed: false, connected: false, zoneStatus: 'nothing_to_zone', leftZonable: 0 });
  return r.ok === true;
});
run('gridOutcome: not linked -> partial grid_built_but_not_connected', () => {
  const r = city.gridOutcome({ ...good, linked: false });
  return r.ok === false && r.partial === true && r.reason === 'grid_built_but_not_connected';
});
run('gridOutcome: not linked wins over a zoning failure (first failed check)', () => {
  const r = city.gridOutcome({ ...good, linked: false, zoneStatus: 'failed', leftZonable: 5 });
  return r.reason === 'grid_built_but_not_connected';
});
run('gridOutcome: connector used but not connected -> partial connectivity_check_failed', () => {
  const r = city.gridOutcome({ ...good, connected: false });
  return r.ok === false && r.partial === true && r.reason === 'connectivity_check_failed';
});
run('gridOutcome: connector not used ignores connected', () => {
  const r = city.gridOutcome({ ...good, connectorUsed: false, connected: false });
  return r.ok === true;
});
run('gridOutcome: zoneStatus interrupted -> not ok', () => {
  const r = city.gridOutcome({ ...good, zoneStatus: 'interrupted' });
  return r.ok === false && r.partial === true && r.reason === 'zoning_interrupted';
});
run('gridOutcome: complete with leftZonable 5 -> zoning_incomplete', () => {
  const r = city.gridOutcome({ ...good, leftZonable: 5 });
  return r.ok === false && r.partial === true && r.reason === 'zoning_incomplete';
});
run('gridOutcome: zoneStatus failed -> zoning_failed', () => {
  const r = city.gridOutcome({ ...good, zoneStatus: 'failed' });
  return r.ok === false && r.reason === 'zoning_failed';
});

// ---- zoneOutcome: every status ----
const zoneCases: [string, number, boolean, string | undefined][] = [
  ['complete', 0, true, undefined],
  ['nothing_to_zone', 0, true, undefined],
  ['complete', 5, false, 'zoning_incomplete'],
  ['nothing_to_zone', 5, false, 'zoning_incomplete'],
  ['failed', 0, false, 'zoning_failed'],
  ['interrupted', 0, false, 'zoning_interrupted'],
  ['running', 0, false, 'zoning_still_running'],
  ['queued', 0, false, 'zoning_still_running'],
  ['validating', 0, false, 'zoning_still_running'],
  ['applying', 0, false, 'zoning_still_running'],
  ['weird', 0, false, 'zoning_status_unknown:weird'],
];
for (const [status, left, ok, reason] of zoneCases) {
  run(`zoneOutcome(${status}, ${left}) -> ${ok ? 'ok' : reason}`, () => {
    const r = city.zoneOutcome(status, left);
    return r.ok === ok && r.reason === reason;
  });
}

// ---- chunkSteps ----
const LIMIT = 15000, ENVELOPE = 600;
const bytesOf = (s: string) => new TextEncoder().encode(s).length;
const wire = (chunk: unknown[], extra: object = {}) => bytesOf(JSON.stringify({ steps: chunk, compact: true, ...extra })) + ENVELOPE;
const sameOrder = (flat: unknown[], input: unknown[]) => flat.length === input.length && flat.every((s, i) => s === input[i]);

const small = Array.from({ length: 200 }, (_, i) => ({ command: 'build_road', args: { id: i, x: i * 8, z: 0 } }));
const smallChunks: any[][] = city.chunkSteps(small);
run('chunkSteps: 200 small steps -> chunks of at most 60', () => smallChunks.every(c => c.length >= 1 && c.length <= 60));
run('chunkSteps: 200 small steps -> 4 chunks (60, 60, 60, 20)', () => smallChunks.map(c => c.length).join(',') === '60,60,60,20');
run('chunkSteps: every small chunk within 15000 bytes with envelope', () => smallChunks.every(c => wire(c) <= LIMIT));
run('chunkSteps: order preserved (200 small)', () => sameOrder(smallChunks.flat(), small));
run('chunkSteps: total count preserved (200 small)', () => smallChunks.flat().length === 200);

const long = Array.from({ length: 10 }, (_, i) => ({ command: 'build_road', args: { id: i, pad: 'x'.repeat(2000) } }));
const longChunks: any[][] = city.chunkSteps(long);
run('chunkSteps: long args split by bytes (more than one chunk, under 60 each)', () => longChunks.length > 1 && longChunks.every(c => c.length < 60));
run('chunkSteps: every long-args chunk within 15000 bytes with envelope', () => longChunks.every(c => wire(c) <= LIMIT));
run('chunkSteps: order and count preserved (long args)', () => sameOrder(longChunks.flat(), long));

// UTF-8 bytes, not characters: 3 steps of 3000 'e-acute' are 9000 characters but about 18000 bytes.
const multi = Array.from({ length: 3 }, (_, i) => ({ command: 'x', args: { id: i, s: 'é'.repeat(3000) } }));
const multiChunks: any[][] = city.chunkSteps(multi);
run('chunkSteps: budget counts UTF-8 bytes (multibyte steps split)', () => multiChunks.length === 2 && multiChunks.every(c => wire(c) <= LIMIT));

run('chunkSteps: one oversized step throws batch_step_too_large', () => {
  try { city.chunkSteps([small[0], { command: 'x', args: { s: 'x'.repeat(15000) } }]); return false; }
  catch (e) { return String((e as Error).message).includes('batch_step_too_large'); }
});
run('chunkSteps: extra fields count toward the budget', () => {
  const step = { command: 'x', args: { s: 'x'.repeat(1500) } };
  try { city.chunkSteps([step], { pad: 'z'.repeat(13000) }); return false; }
  catch (e) { return String((e as Error).message).includes('batch_step_too_large'); }
});
run('chunkSteps: the same step fits without the extra', () => city.chunkSteps([{ command: 'x', args: { s: 'x'.repeat(1500) } }]).length === 1);
run('chunkSteps: maxSteps argument is honoured (10 steps, cap 4 -> 4,4,2)', () => city.chunkSteps(small.slice(0, 10), {}, 15000, 4).map((c: unknown[]) => c.length).join(',') === '4,4,2');
run('chunkSteps: empty input -> []', () => { const r = city.chunkSteps([]); return Array.isArray(r) && r.length === 0; });

console.log(failures ? `FAILED: ${failures} check(s)` : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
