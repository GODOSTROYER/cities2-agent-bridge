// Offline checks: the headroom threshold and the growth projection (owner policy: services ahead of need).
import { status, serviceTable, headroomFor, tableLine, utilityAlerts, plannedPeople, TARGET_PCT } from '../src/headroom.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

check(TARGET_PCT === 78, 'the target is usage at or below 78% of capacity (capacity 128% of use)');
check(status(70, 100) === 'ok' && status(78, 100) === 'ok', 'at or below the target is ok');
check(status(79, 100) === 'low', 'above the target is low: add capacity this cycle');
check(status(101, 100) === 'over', 'above capacity is over');
check(status(40, 0) === 'none' && status(0, 0) === 'ok', 'use without any capacity is "none"; no use and no capacity is ok');

const snap = { city: { pop: 16000 }, util: { power: { use: 178000, prod: 447000 }, water: { use: 90000, cap: 200000 }, sewage: { use: 90000, cap: 300000 } }, needs: { health: { sick: 37 }, deathcare: { dead: 5 } } };
const h = { people: { children: 1800, teens: 1200, adults: 10500, elderly: 2500 }, education: { elementary: { students: 900, capacity: 1500 }, high: { students: 300, capacity: 800 }, college: { students: 0, capacity: 1000 }, university: { students: 0, capacity: 0 } }, health: { patients: 30, capacity: 80, ambulances: 6 }, deathcare: { hearses: 6 }, garbage: { trucks: 10 }, fire: { engines: 6 }, police: { cars: 12 }, post: { vans: 12 } };
let t = serviceTable(h, snap);
check(t.power.pct === 40 && t.power.status === 'ok', 'power at 40% is ok');
check(t.school.use === 1620 && t.school.status === 'over', 'elementary: 1,800 children against 1,500 places is over even though only 900 are enrolled');
check(t.highschool.use === 720 && t.highschool.pct === 90 && t.highschool.status === 'low', 'high school at 90% is low');
check(t.university.status === 'none', 'adults with no university capacity at all is "none"');
check(t.fire.use === 8 && t.fire.cap === 6 && t.fire.status === 'over', 'fire engines: the norm for 16,000 residents is 8, the city owns 6');
check(t.police.status === 'ok' && t.post.status === 'ok', 'police cars and post vans are above the norm');
check(t.health.use === 37 && t.health.pct === 46, 'health uses the larger of patients in beds and the sick count');

// Projection: a planned district is counted before it is zoned.
check(plannedPeople([{ zone: 'reshigh', cols: 4, rows: 3 }, { zone: 'res', cols: 4, rows: 3 }]) === 20160, 'a 4x3 high-density and a 4x3 low-density district bring about 20,000 people');
check(plannedPeople([{ zone: 'off', cols: 3, rows: 2 }]) === 0, 'job zones bring no residents');
t = serviceTable(h, snap, 8000);
check(t.power.pct === 40 && t.power.projected === 60 && t.power.status === 'ok', 'power: 40% now, 60% with the planned 8,000 people, still ok');
check(t.police.pct === 67 && t.police.projected === 100 && t.police.status === 'low', 'police: fine today, low once the planned district fills, so it is built WITH the district');
const water = serviceTable(h, { ...snap, util: { ...snap.util, water: { use: 150000, cap: 200000 } } }, 8000).water;
check(water.pct === 75 && water.projected === 113 && water.status === 'over', 'water at 75% today is over capacity after the planned growth');

const f = headroomFor(serviceTable(h, snap));
check(f.school.status === 'over' && f.highschool.status === 'low' && f.university.status === 'none' && f.fire.status === 'over' && f.police.status === 'ok', 'the planner gets one status per rule type');
check(headroomFor(serviceTable({ ...h, health: { patients: 30, capacity: 80, ambulances: 2 } }, snap)).health.status === 'over', 'health takes the worse of beds and ambulances');
const line = tableLine(serviceTable(h, snap, 8000));
check(line.includes('power 40%->60%') && line.includes('school 108%->162% OVER') && !line.includes('\n'), 'the service table is one line with use, projection and status');
check(utilityAlerts(serviceTable(h, { ...snap, util: { ...snap.util, sewage: { use: 250000, cap: 300000 } } }))[0].startsWith('sewage at 83%'), 'a utility past the target is raised for the agent');
check(utilityAlerts(serviceTable(h, snap)).length === 0, 'utilities under the target raise nothing');
process.exit(failed ? 1 : 0);
