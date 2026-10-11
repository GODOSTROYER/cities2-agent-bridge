// Offline checks: what each action did to the metric it aimed at (verify and learn).
import { valueAt, judge, evaluate, effectsTable, undoCandidates, effectsLines, NEED_SYSTEM } from '../src/effects.ts';
import type { Evaluated } from '../src/effects.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

const MIN = 60000;
const T0 = Date.parse('2026-10-11T00:00:00Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const M = (min: number, values: Record<string, number>) => ({ utc: at(min), values });

// valueAt
const rows = [M(10, { Police: 2 }), M(0, { Police: -1 }), M(5, { Police: 1 })];
check(valueAt(rows, 'Police', T0 + 7 * MIN) === 1, 'valueAt: unsorted rows, the last row at or before the time wins (5 min, not 10)');
check(valueAt(rows, 'Police', T0 + 20 * MIN) === 2, 'valueAt: after the last row, that row still counts');
check(valueAt(rows, 'Police', T0 + 10 * MIN) === 2, 'valueAt: a row exactly at the time counts');
check(valueAt(rows, 'Police', T0 - MIN) === null, 'valueAt: a time before the first row is null');
check(valueAt(rows, 'Fire and rescue', T0 + 20 * MIN) === null, 'valueAt: a system no row reports is null');
check(valueAt([M(0, { Police: 1 }), M(5, { Water: 1 })], 'Police', T0 + 10 * MIN) === 1, 'valueAt: rows without the system are skipped, not read as zero');
check(valueAt([], 'Police', T0) === null, 'valueAt: no rows is null');
check(rows[0].utc === at(10), 'valueAt: the input array is not reordered');

// judge
check(judge(0, 0.3) === 'effective', 'judge: a change of exactly +0.3 is effective');
check(judge(0, 0.29) === 'ineffective', 'judge: a change of +0.29 is ineffective');
check(judge(1, 1.3) === 'effective', 'judge: 1.0 to 1.3 is effective (float noise does not push it under 0.3)');
check(judge(0.3, 0) === 'worse', 'judge: a change of exactly -0.3 is worse');
check(judge(0.3, 0.01) === 'ineffective', 'judge: a change of -0.29 is ineffective');
check(judge(2, 2) === 'ineffective', 'judge: no change is ineffective');
check(judge(null, 1) === 'unknown' && judge(1, null) === 'unknown' && judge(null, null) === 'unknown', 'judge: a missing value on either side is unknown');
check(judge(0, 0.5, 0.6) === 'ineffective', 'judge: minDelta can be raised');

// evaluate: A effective, B worse, C pending, D unmapped need, E no later row
const metrics = [M(0, { Police: 1 }), M(10, { Police: 1.5 }), M(30, { Police: 0.5 }), M(40, { Police: 0.2 })];
const actions = [
  { utc: at(0), need: 'police', tool: 'fix_services', detail: 'PoliceStation02@-1016,-321' },
  { utc: at(30), need: 'police', tool: 'fix_services', detail: 'PoliceStation03@0,0' },
  { utc: at(55), need: 'police', tool: 'fix_services' },
  { utc: at(5), need: 'mystery', tool: 'fix_services', detail: 'x' },
  { utc: at(45), need: 'police', tool: 'build_utility' },
];
const ev = evaluate(actions, metrics, T0 + 70 * MIN);
check(ev.length === 5, 'evaluate: one verdict per action');
check(ev[0].system === 'Police' && ev[0].before === 1 && ev[0].after === 1.5 && ev[0].delta === 0.5 && ev[0].verdict === 'effective', 'evaluate: police 1 -> 1.5 twenty minutes later is effective');
check(ev[1].verdict === 'worse' && ev[1].delta === -0.3, 'evaluate: 0.5 -> 0.2 twenty minutes later is worse');
check(ev[2].verdict === 'pending' && ev[2].after === null && ev[2].delta === null && ev[2].before === 0.2, 'evaluate: an action 15 min old is pending, with its before value only');
check(ev[3].system === null && ev[3].verdict === 'unknown', 'evaluate: a need missing from NEED_SYSTEM is unknown');
check(ev[4].after === null && ev[4].verdict === 'unknown', 'evaluate: no metric row later than the action, after the window, is unknown');
check(ev[0].detail === 'PoliceStation02@-1016,-321' && ev[4].detail === undefined, 'evaluate: detail is carried through; an absent detail stays absent');
const one = [actions[0]];
check(evaluate(one, metrics, T0 + 19 * MIN)[0].verdict === 'pending', 'evaluate: 19 min after the action is still pending');
check(evaluate(one, metrics, T0 + 20 * MIN)[0].verdict === 'effective', 'evaluate: exactly 20 min after the action is judged');
check(evaluate(one, metrics, T0 + 30 * MIN, 60)[0].verdict === 'pending', 'evaluate: windowMin sets the window (60 min here)');
check(evaluate([{ utc: at(0), need: 'water', tool: 't' }], metrics, T0 + 70 * MIN)[0].verdict === 'unknown', 'evaluate: a system with no metric rows is unknown');
check(evaluate([{ utc: at(0), need: 'constructor', tool: 't' }], metrics, T0 + 70 * MIN)[0].system === null, 'evaluate: inherited object keys are not needs');
check(NEED_SYSTEM.network === 'Electricity' && NEED_SYSTEM.police === 'Police', 'NEED_SYSTEM maps the needs to the metric names');

// effectsTable
const E = (tool: string, need: string, verdict: Evaluated['verdict'], delta: number | null = null): Evaluated => ({ utc: at(0), tool, need, system: NEED_SYSTEM[need] ?? null, before: null, after: null, delta, verdict });
const et = effectsTable([
  E('fix_services', 'police', 'effective', 0.5),
  E('build_utility', 'power', 'worse', -0.4),
  E('fix_services', 'police', 'effective', 0.7),
  E('fix_services', 'fire', 'unknown'),
  E('fix_services', 'police', 'ineffective', 0.1),
  E('build_utility', 'power', 'unknown'),
  E('fix_services', 'police', 'pending'),
]);
check(et.length === 3, 'effectsTable: one row per (tool, need)');
check(et.map(r => r.n).join() === '4,2,1', 'effectsTable: sorted by n, most actions first');
const p = et[0];
check(p.tool === 'fix_services' && p.need === 'police' && p.effective === 2 && p.ineffective === 1 && p.worse === 0 && p.pending === 1, 'effectsTable: counts per verdict');
check(p.avgDelta === 0.43, 'effectsTable: avgDelta is the mean of the non-null deltas, 2 decimals');
check(p.rate === 0.67, 'effectsTable: rate is effective / judged (2 of 3)');
const w = et[1];
check(w.n === 2 && w.worse === 1 && w.effective === 0 && w.ineffective === 0 && w.pending === 0, 'effectsTable: unknown is counted in n only');
check(w.rate === 0 && w.avgDelta === -0.4, 'effectsTable: a rate of 0 is a rate, not null');
check(et[2].n === 1 && et[2].rate === null && et[2].avgDelta === null, 'effectsTable: no judged action gives null rate and null avgDelta');
check(effectsTable([]).length === 0, 'effectsTable: nothing in, nothing out');

// undoCandidates
const U: Evaluated[] = [
  { ...E('fix_services', 'police', 'ineffective', -0.1), detail: 'PoliceStation02@-1016,-321' },
  { ...E('fix_services', 'police', 'ineffective', -0.1), detail: 'PoliceStation03@0,0' },
  E('fix_services', 'police', 'ineffective', -0.1),
  { ...E('fix_services', 'fire', 'ineffective', 0.1), detail: 'FireStation01@5,5' },
  { ...E('fix_services', 'fire', 'effective', 0.8), detail: 'FireStation02@6,6' },
  { ...E('build_utility', 'power', 'ineffective', 0), detail: 'PowerPlant01@1,1' },
  { ...E('build_utility', 'power', 'pending'), detail: 'PowerPlant02@2,2' },
  { ...E('fix_services', 'health', 'worse', -0.5), detail: 'Clinic01@1,2' },
  { ...E('fix_services', 'health', 'worse', -0.4), detail: 'Clinic02@3,4' },
];
const und = undoCandidates(U);
check(und.length === 2 && und[0].need === 'police' && und[1].need === 'health', 'undoCandidates: lists groups with 2+ judged actions and no effective one');
check(und[0].why === 'fix_services for police: 3 actions, none moved Police (avg delta -0.1)', 'undoCandidates: why gives the tool, the count, the system and the average');
check(und[0].details.join('|') === 'PoliceStation02@-1016,-321|PoliceStation03@0,0', 'undoCandidates: details are the judged actions\' detail strings; missing ones skipped');
check(und[1].tool === 'fix_services' && und[1].details.length === 2, 'undoCandidates: worse actions count as not moved');
check(!und.some(u => u.need === 'fire'), 'undoCandidates: a need with an effective action is not listed');
check(!und.some(u => u.need === 'power'), 'undoCandidates: one judged action (plus pending) is not enough');
check(undoCandidates(U, 3).length === 1, 'undoCandidates: minRepeats raises the bar (health with 2 is dropped)');

// effectsLines
const lineRows = [
  { tool: 'fix_services', need: 'police', n: 3, effective: 2, ineffective: 1, worse: 0, pending: 0, avgDelta: 0.6, rate: 0.67 },
  { tool: 'build_utility', need: 'power', n: 2, effective: 0, ineffective: 0, worse: 1, pending: 0, avgDelta: -0.4, rate: 0 },
  { tool: 'fix_services', need: 'fire', n: 1, effective: 0, ineffective: 0, worse: 0, pending: 1, avgDelta: null, rate: null },
];
const lines = effectsLines(lineRows);
check(lines[0] === 'fix_services/police: 2 of 3 effective, avg +0.6', 'effectsLines: tool/need, effective of judged, and the average with a sign');
check(lines[1] === 'build_utility/power: 0 of 1 effective, avg -0.4', 'effectsLines: a negative average keeps its minus sign');
check(lines[2] === 'fix_services/fire: no verdict yet', 'effectsLines: no rate reads "no verdict yet"');
check(effectsLines(lineRows, 2).length === 2 && effectsLines(lineRows, 0).length === 0, 'effectsLines: max caps the number of lines');
check(effectsLines(effectsTable(ev)).length === 3, 'effects pipeline: evaluate -> effectsTable -> effectsLines gives one line per group');
process.exit(failed ? 1 : 0);
