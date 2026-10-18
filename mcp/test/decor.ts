// LIVE helper: decorate the city with trees and decorative props (benches, lamps, fountains, statues, flower beds, plaza pieces).
// Every point goes through place_building with object:true, previewed first and built only when 'build' is given.
// Points the game refuses (roads, buildings, water, ...) are skipped and counted by reason. Max 200 placements per run.
//   node test/decor.ts list [filter]
//   node test/decor.ts row <prefab> <x0> <z0> <x1> <z1> <spacing> [build]
//   node test/decor.ts grove <prefab|mix:a,b,c> <cx> <cz> <radius> <count> [build]
//   node test/decor.ts ring <prefab> <cx> <cz> <radius> <count> [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';

const CAP = 200;                 // placements per run
const MIN_GAP = 6;               // metres between grove points
const LIST_ROWS = 42;            // keeps `list` under 60 lines
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const DECOR_TERMS = ['tree', 'bench', 'fountain', 'statue', 'streetlight', 'bush', 'hedge', 'flower', 'garden', 'plaza', 'decoration'];
const JUNK = /Billboard|Poster|Screen|Sign|Pylon|Placeholder| - /i;   // ad panels, theme-variant copies, editor placeholders
const ORDER = ['tree', 'bench', 'fountain', 'statue', 'lamp', 'plant', 'garden/plaza', 'decor'];

type Info = { name: string; found: boolean; index?: number; version?: number; locked?: boolean; construction?: number; similar?: string[] };
type Point = { info: Info; x: number; z: number; rotation: number };
type Outcome = { ok: boolean; reason?: string; cost?: number };

// Seeded PRNG (mulberry32, FNV-1a seed) so the same arguments always give the same layout.
function rng(seedText: string): () => number {
  let h = 2166136261; for (const ch of seedText) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Trees are kind 'tree' (TreeData); props are StaticObjectPrefab kind 'prop'. Exact-name lookup, cached by prefab().
async function resolve(name: string): Promise<Info> {
  let last: Info = { name, found: false };
  for (const kind of ['tree', 'prop']) { const p = await prefab(name, kind); if (p.found) return p as Info; last = p as Info; }
  return last;
}

// Sends one command; waits 10 s and retries (up to 6 times) while the game is busy with another build tool.
async function send(command: string, args: Record<string, unknown>): Promise<{ id?: string; error?: string }> {
  for (let t = 0; t <= 6; t++) {
    const r = await call(command, args, 15);
    if (r.ok) return { id: r.result?.id };
    const e = String(r.error ?? 'unknown');
    if (/finish_or_cancel_current_tool_first/.test(e) && t < 6) { await sleep(10000); continue; }
    return { error: e };
  }
  return { error: 'finish_or_cancel_current_tool_first (gave up after 6 retries)' };
}

const reasonOf = (op: any): string => {
  const reasons = (op.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []);
  return String(reasons[0] ?? op.error ?? op.status ?? 'unknown').slice(0, 60);
};

// Preview first; build only when asked and the preview passed.
async function placeAt(p: Point, build: boolean): Promise<Outcome> {
  const base = { prefabIndex: p.info.index, prefabVersion: p.info.version, position: { x: p.x, z: p.z }, rotation: p.rotation, maxCost: 50000, object: true };
  const pv = await send('place_building', { ...base, previewOnly: true });
  if (!pv.id) return { ok: false, reason: String(pv.error).slice(0, 60) };
  const pd = await waitOperation(pv.id, 60);
  if (pd.status !== 'complete') return { ok: false, reason: reasonOf(pd) };
  const cost = Number(pd.previewCost ?? p.info.construction ?? 0);
  if (!build) return { ok: true, cost };
  const bd0 = await send('place_building', base);
  if (!bd0.id) return { ok: false, reason: String(bd0.error).slice(0, 60) };
  const bd = await waitOperation(bd0.id, 60);
  return bd.status === 'complete' ? { ok: true, cost } : { ok: false, reason: reasonOf(bd) };
}

async function placeAll(label: Record<string, unknown>, points: Point[], build: boolean): Promise<void> {
  if (points.length > CAP) throw new Error(`cap_exceeded: ${points.length} points, max ${CAP} per run`);
  const refused: Record<string, number> = {}; let placed = 0; let cost = 0;
  for (const p of points) {
    let o: Outcome;
    try { o = await placeAt(p, build); } catch (e: any) { o = { ok: false, reason: 'exception: ' + String(e.message).slice(0, 40) }; }
    if (o.ok) { placed++; cost += o.cost ?? 0; } else refused[o.reason!] = (refused[o.reason!] ?? 0) + 1;
  }
  console.log(JSON.stringify({ ...label, mode: build ? 'build' : 'preview', requested: points.length, [build ? 'placed' : 'wouldPlace']: placed, refused, [build ? 'cost' : 'previewCost']: cost }));
}

const categoryOf = (n: string): string =>
  /Tree/.test(n) ? 'tree' : /Bench/i.test(n) ? 'bench' : /Fountain/i.test(n) ? 'fountain' : /Statue/i.test(n) ? 'statue' :
  /Street|Light|Lamp/i.test(n) ? 'lamp' : /Bush|Hedge|Flower/i.test(n) ? 'plant' : /Garden|Plaza/i.test(n) ? 'garden/plaza' : 'decor';

async function list(filter: string): Promise<void> {
  const seen = new Map<string, { name: string; category: string; index: number; version: number }>();
  const add = (p: any) => { if (!p.locked && !JUNK.test(p.name) && !seen.has(p.name)) seen.set(p.name, { name: p.name, category: categoryOf(p.name), index: p.index, version: p.version }); };
  for (const p of (await callOk('get_build_prefabs', { kind: 'tree', filter, limit: 200 }, 20)).prefabs ?? []) add(p);
  for (const term of (filter ? [filter] : DECOR_TERMS.slice(1))) for (const p of (await callOk('get_build_prefabs', { kind: 'prop', filter: term, limit: 200 }, 20)).prefabs ?? []) add(p);
  const all = [...seen.values()].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name));
  const shown = all.slice(0, LIST_ROWS);
  const costs = new Map<string, number>();
  for (const r of shown) costs.set(r.name, Number((await callOk('get_prefab_details', { index: r.index, version: r.version }, 10)).costs?.construction ?? 0));
  console.log(`unlocked decor prefabs: ${all.length}${filter ? ` matching "${filter}"` : ''} (trees, props; ads and placeholders hidden). Use a filter to narrow.`);
  let last = '';
  for (const r of shown) {
    if (r.category !== last) { const n = all.filter(a => a.category === r.category).length; console.log(`== ${r.category} (${n}) ==`); last = r.category; }
    console.log(`  ${r.name.padEnd(36)} cost ${costs.get(r.name)}`);
  }
  if (all.length > shown.length) console.log(`... ${all.length - shown.length} more: pass a filter`);
}

const num = (s: string | undefined, what: string): number => { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`${what} must be a number, got "${s}"`); return n; };

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const usage = 'usage: list [filter] | row <prefab> x0 z0 x1 z1 spacing [build] | grove <prefab|mix:a,b,c> cx cz radius count [build] | ring <prefab> cx cz radius count [build]';
  if (mode === 'list') return list(rest[0] ?? '');
  const build = rest[rest.length - 1] === 'build';
  const args = build ? rest.slice(0, -1) : rest;

  if (mode === 'row') {
    if (args.length !== 6) throw new Error(usage);
    const info = await resolve(args[0]); if (!info.found) return void console.log('NOT FOUND', JSON.stringify(info.similar ?? []).slice(0, 300));
    if (info.locked) return void console.log('LOCKED', args[0]);
    const [x0, z0, x1, z1, spacing] = args.slice(1).map((s, i) => num(s, ['x0', 'z0', 'x1', 'z1', 'spacing'][i]));
    const len = Math.hypot(x1 - x0, z1 - z0); if (spacing <= 0 || len === 0) throw new Error('spacing and line length must be > 0');
    const rand = rng(`row|${args.join('|')}`); const points: Point[] = [];
    for (let d = 0; d <= len + 1e-6; d += spacing) { const f = d / len; points.push({ info, x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, rotation: Math.round(rand() * 360) }); }
    return placeAll({ prefab: args[0], line: [x0, z0, x1, z1], spacing }, points, build);
  }

  if (mode === 'grove') {
    if (args.length !== 5) throw new Error(usage);
    const spec = args[0]; const names = spec.startsWith('mix:') ? spec.slice(4).split(',').map(s => s.trim()).filter(Boolean) : [spec];
    if (!names.length) throw new Error(usage);
    const infos = new Map<string, Info>();
    for (const n of names) { const i = await resolve(n); if (!i.found) return void console.log('NOT FOUND', n, JSON.stringify(i.similar ?? []).slice(0, 300)); if (i.locked) return void console.log('LOCKED', n); infos.set(n, i); }
    const [cx, cz, radius, count] = args.slice(1).map((s, i) => num(s, ['cx', 'cz', 'radius', 'count'][i]));
    const rand = rng(`grove|${args.join('|')}`); const accepted: { x: number; z: number }[] = []; const points: Point[] = [];
    for (let tries = 0; tries < 20000 && accepted.length < count; tries++) {
      const r = radius * Math.sqrt(rand()), th = 2 * Math.PI * rand(); const x = cx + r * Math.cos(th), z = cz + r * Math.sin(th);
      if (accepted.some(q => Math.hypot(q.x - x, q.z - z) < MIN_GAP)) continue;
      accepted.push({ x, z });
      const info = infos.get(names[Math.floor(rand() * names.length)])!;
      points.push({ info, x, z, rotation: Math.round(rand() * 360) });
    }
    if (points.length < count) console.log(JSON.stringify({ note: 'gap_unsatisfiable', planned: points.length, count }));
    return placeAll({ grove: spec, center: [cx, cz], radius, minGap: MIN_GAP }, points, build);
  }

  if (mode === 'ring') {
    if (args.length !== 5) throw new Error(usage);
    const info = await resolve(args[0]); if (!info.found) return void console.log('NOT FOUND', JSON.stringify(info.similar ?? []).slice(0, 300));
    if (info.locked) return void console.log('LOCKED', args[0]);
    const [cx, cz, radius, count] = args.slice(1).map((s, i) => num(s, ['cx', 'cz', 'radius', 'count'][i]));
    if (count < 1) throw new Error('count must be >= 1');
    const points: Point[] = [];
    for (let i = 0; i < count; i++) { const th = 2 * Math.PI * i / count; points.push({ info, x: cx + radius * Math.cos(th), z: cz + radius * Math.sin(th), rotation: Math.round((th * 180) / Math.PI) }); }
    return placeAll({ ring: args[0], center: [cx, cz], radius }, points, build);
  }

  console.log(usage);
}

main().catch(e => { console.error('decor failed:', e.message); process.exitCode = 1; });
