// Offline checks: live fee tuner with a fake `call` (no game access).
import { tuneFees, feeActions } from '../src/fees-live.ts';
import type { FeeState } from '../src/fees-live.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

const MIN = 60000, NOW = Date.parse('2026-10-11T12:00:00Z');
const site = (index: number, capacity: number, parked: number, fee: number) => ({ index, version: 7, x: index * 10, z: index * 20, capacity, parked, lanes: 1, lanesFull: 0, paid: fee > 0, fee });
const policy = (extra: any = {}) => ({ fees: { enabled: true, occupancyBand: [70, 85], raiseAbovePct: 85, lowerBelowPct: 50, parking: { min: 1, max: 50, start: 10, step: 2 }, service: {}, reviewMinutes: 20, ...extra } });
function fake(data: any, opts: { throwOn?: (cmd: string, a: any) => boolean; okFalseOn?: (cmd: string, a: any) => boolean } = {}) {
  const calls: { cmd: string; args: any }[] = [];
  const call = async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'get_fees') return data;
    if (opts.throwOn?.(cmd, args)) throw new Error('boom');
    if (opts.okFalseOn?.(cmd, args)) return { ok: false };
    return { ok: true, fee: args.fee };
  };
  return { call, calls, sets: () => calls.filter(c => c.cmd !== 'get_fees') };
}

// not due
{
  const f = fake({ parking: [site(1, 100, 95, 10)] });
  const r = await tuneFees(f.call, policy(), { lastRun: NOW - 10 * MIN }, NOW);
  check(r.skipped === 'not due' && r.changed.length === 0 && f.calls.length === 0, 'not due: 10 minutes after the last run makes no calls');
  const st = { lastRun: NOW - 10 * MIN, history: [] };
  check(r.state.lastRun === st.lastRun, 'not due: lastRun is kept');
  const f2 = fake({ parking: [site(1, 100, 95, 10)] });
  const r2 = await tuneFees(f2.call, policy({ reviewMinutes: undefined }), { lastRun: NOW - 29 * MIN }, NOW);
  check(r2.skipped === 'not due' && f2.calls.length === 0, 'not due: default review is 30 minutes (29 is too soon)');
  const f3 = fake({ parking: [site(1, 100, 95, 10)] });
  const r3 = await tuneFees(f3.call, policy({ reviewMinutes: undefined }), { lastRun: NOW - 30 * MIN }, NOW);
  check(!r3.skipped && f3.calls[0].cmd === 'get_fees', 'due: exactly 30 minutes runs');
}

// over-full parking
{
  const f = fake({ parking: [site(3, 100, 92, 10)] });
  const r = await tuneFees(f.call, policy(), {}, NOW);
  check(f.sets().length === 1 && f.sets()[0].cmd === 'set_parking_fee', 'over-full: exactly one set_parking_fee call');
  check(JSON.stringify(f.sets()[0].args) === JSON.stringify({ index: 3, version: 7, fee: 12 }), 'over-full: index, version and fee (10 + step 2 = 12) are right');
  check(r.changed.length === 1 && r.changed[0].kind === 'parking' && r.changed[0].from === 10 && r.changed[0].to === 12, 'over-full: changed row records 10 -> 12');
  check(r.lines.some(l => l === 'parking (30,60): 10 -> 12, occupancy 92% above the 70-85% band'), 'over-full: change line reads as specified: ' + r.lines.join(' | '));
  check(r.lines[0].startsWith('parking: 1 sites'), 'over-full: first line is the fees.ts summary');
  check(r.state.lastRun === NOW && r.state.history?.length === 1 && r.state.history[0].id === '3:7' && r.state.history[0].occupancyBefore === 92, 'over-full: state has lastRun and a history row with occupancy');
  check(r.lines.every(l => l.length <= 200), 'over-full: no line over 200 characters');
}

// raise capped at max
{
  const f = fake({ parking: [site(1, 100, 92, 49)] });
  await tuneFees(f.call, policy(), {}, NOW);
  check(f.sets()[0]?.args.fee === 50, 'cap: raise from 49 stops at max 50');
  const f2 = fake({ parking: [site(1, 100, 92, 50)] });
  await tuneFees(f2.call, policy(), {}, NOW);
  check(f2.sets().length === 0, 'cap: already at max, no call');
}

// under-used parking
{
  const f = fake({ parking: [site(2, 100, 30, 10)] });
  const r = await tuneFees(f.call, policy(), {}, NOW);
  check(f.sets()[0]?.args.fee === 8 && r.changed[0]?.to === 8, 'under-used: fee lowered by one step to 8');
  check(r.lines.some(l => /below the 70-85% band/.test(l)), 'under-used: line says below the band');
  const f2 = fake({ parking: [site(2, 100, 30, 2)] });
  await tuneFees(f2.call, policy(), {}, NOW);
  check(f2.sets()[0]?.args.fee === 1, 'under-used: never under min (2 -> 1, not 0)');
  const f3 = fake({ parking: [site(2, 100, 30, 1)] });
  await tuneFees(f3.call, policy(), {}, NOW);
  check(f3.sets().length === 0, 'under-used: already at min, no call');
}

// in band
{
  const f = fake({ parking: [site(1, 100, 78, 10), site(2, 100, 85, 10)] });
  const r = await tuneFees(f.call, policy(), {}, NOW);
  check(f.sets().length === 0 && r.changed.length === 0, 'in band: nothing changed, no set calls');
  check(r.state.lastRun === NOW && (r.state.history ?? []).length === 0, 'in band: lastRun set, history empty');
}

// failing sets
{
  const data = { parking: [site(1, 100, 95, 10), site(2, 100, 95, 10), site(3, 100, 95, 10)] };
  const f = fake(data, { throwOn: (c, a) => c === 'set_parking_fee' && a.index === 1 });
  const r = await tuneFees(f.call, policy(), {}, NOW);
  check(f.sets().length === 3, 'throwing set: all three sets were attempted');
  check(r.changed.length === 2 && r.changed.every(c => c.id !== '1:7'), 'throwing set: the other two are applied and the failed one is not recorded');
  check(r.lines.some(l => /parking \(10,20\).*refused \(boom\)/.test(l)), 'throwing set: reported as a refusal');
  check((r.state.history ?? []).length === 2, 'throwing set: history has only the applied changes');
  const f2 = fake(data, { okFalseOn: (c, a) => a.index === 2 });
  const r2 = await tuneFees(f2.call, policy(), {}, NOW);
  check(r2.changed.length === 2 && r2.lines.some(l => /refused/.test(l)), 'ok false: counted as a refusal, others applied');
}

// service fee hard rule
{
  const svcPolicy = policy({ service: { Water: { min: 50, max: 150, step: 10 }, Garbage: { min: 50, max: 150, step: 10 } } });
  const data = { parking: [], service: [{ name: 'Water', fee: 100, factor: 1 }, { name: 'Garbage', fee: 120, factor: -2 }], bounds: { Water: { default: 100, max: 200, adjustable: true }, Garbage: { default: 100, max: 200, adjustable: true } } };
  const f = fake(data);
  const r = await tuneFees(f.call, svcPolicy, {}, NOW);
  check(!f.sets().some(c => c.args.resource === 'Water'), 'service: a raise above the game default (Water 100 -> 110) is not sent');
  check(r.lines.some(l => /service fee Water: raise 100 -> 110 dropped.*default 100/.test(l)), 'service: the dropped raise is explained in lines');
  const g = f.sets().find(c => c.cmd === 'set_service_fee' && c.args.resource === 'Garbage');
  check(!!g && g.args.fee === 110, 'service: a lowering (Garbage 120 -> 110, still above default but a cut) is applied');
  check(r.changed.length === 1 && r.changed[0].kind === 'service' && r.changed[0].id === 'Garbage', 'service: changed lists only the lowering');
  const f2 = fake({ ...data, bounds: { Water: { default: 120 } }, service: [{ name: 'Water', fee: 100, factor: 1 }] });
  const r2 = await tuneFees(f2.call, svcPolicy, {}, NOW);
  check(f2.sets().length === 1 && f2.sets()[0].args.fee === 110, 'service: a raise that stays at or under the default is allowed');
  const f3 = fake({ parking: [], service: [{ name: 'Water', fee: 100, factor: 1 }] });
  const r3 = await tuneFees(f3.call, svcPolicy, {}, NOW);
  check(f3.sets().length === 0 && r3.lines.some(l => /dropped/.test(l)), 'service: a raise with no known default is dropped too');
  const f4 = fake({ parking: [], service: [{ name: 'Water', fee: 100, factor: 1 }], bounds: { Water: { default: 100 } } });
  await tuneFees(f4.call, policy(), {}, NOW);
  check(f4.sets().length === 0, 'service: an empty service policy changes nothing');
}

// policy off / missing
{
  const f = fake({ parking: [site(1, 100, 95, 10)] });
  const r = await tuneFees(f.call, policy({ enabled: false }), {}, NOW);
  check(f.calls.length === 0 && r.changed.length === 0 && /off/.test(r.lines[0]), 'policy off: no calls and a line saying the tuner is off');
  const f2 = fake({ parking: [site(1, 100, 95, 10)] });
  const r2 = await tuneFees(f2.call, {}, {}, NOW);
  check(f2.calls.length === 0 && /off/.test(r2.lines[0]), 'policy missing: no calls');
}

// read failure
{
  const call = async () => { throw new Error('bridge down'); };
  const r = await tuneFees(call, policy(), {}, NOW);
  check(r.changed.length === 0 && r.skipped === 'read failed' && /bridge down/.test(r.lines[0]) && r.state.lastRun === undefined, 'read failure: reported, nothing changed, lastRun not set');
}

// history append and cap, hold from history
{
  const old = Array.from({ length: 199 }, (_, i) => ({ t: NOW - 1000 * MIN + i, kind: 'parking', id: `x${i}`, from: 1, to: 2 }));
  const f = fake({ parking: [site(1, 100, 95, 10), site(2, 100, 95, 10)] });
  const r = await tuneFees(f.call, policy(), { lastRun: NOW - 60 * MIN, history: old }, NOW);
  check(r.state.history?.length === 200, 'history: capped at 200 (199 + 2 -> 200)');
  check(r.state.history?.[199].id === '2:7' && r.state.history?.[0].id === 'x1', 'history: oldest dropped, newest last');
  const f2 = fake({ parking: [site(1, 100, 95, 10)] });
  const r2 = await tuneFees(f2.call, policy(), { lastRun: NOW - 60 * MIN, history: [{ t: NOW - 5 * MIN, kind: 'parking', id: '1:7', from: 8, to: 10 }] }, NOW);
  check(f2.sets().length === 0 && r2.state.history?.length === 1, 'history: a site changed 5 minutes ago is held by the review rule');
  const orig: FeeState = { lastRun: NOW - 60 * MIN, history: [] };
  await tuneFees(fake({ parking: [site(1, 100, 95, 10)] }).call, policy(), orig, NOW);
  check(orig.history?.length === 0 && orig.lastRun === NOW - 60 * MIN, 'history: the input state object is not mutated');
}

// feeActions
{
  const rows = feeActions([
    { kind: 'parking', id: '3:7', from: 10, to: 12, why: 'occupancy 92% is above 85%' },
    { kind: 'service', id: 'Water', from: 120, to: 110, why: 'negative factor' },
  ]);
  check(rows.length === 2 && rows[0].need === 'parking' && rows[0].tool === 'set_parking_fee' && /3:7/.test(rows[0].detail) && /10 -> 12/.test(rows[0].detail), 'feeActions: parking row');
  check(rows[1].need === 'fees' && rows[1].tool === 'set_service_fee' && /Water/.test(rows[1].detail), 'feeActions: service row');
  check(feeActions([]).length === 0, 'feeActions: empty in, empty out');
}

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
