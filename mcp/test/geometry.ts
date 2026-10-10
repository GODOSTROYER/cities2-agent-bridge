// Offline checks: arterial geometry (kinks become curves) and the quoted-cost rule.
import { corridorRoads, quotedCost } from '../src/city.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const P = (x: number, z: number) => ({ x, z });
const len = (r: any) => Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z);

let r = corridorRoads([P(0, 0), P(500, 0)]);
check(r.length === 1 && !r[0].control, 'a straight corridor is one straight road');

// The live failure: 23 m stub then a long run (FAILURES #63).
r = corridorRoads([P(-1158, -65), P(-1180, -57), P(-1660, -65)]);
check(r.length === 1 && !!r[0].control && r[0].a.x === -1158 && r[0].b.x === -1660 && r[0].control.x === -1180, 'a short stub plus a long run becomes one curve through the kink');

r = corridorRoads([P(0, 0), P(300, 0), P(300, 300)]);
check(r.length === 2 && r.every(x => !x.control), 'a corner between two long segments stays two straight roads');

r = corridorRoads([P(0, 0), P(300, 0), P(600, 10)]);
check(r.length === 2 && !r[0].control && !r[1].control, 'a gentle bend (under 15 degrees, long segments) stays two straight roads');

r = corridorRoads([P(0, 0), P(20, 8), P(400, 8), P(420, 0), P(800, 0)]);
check(r.every(x => x.control || len(x) >= 12), 'no straight stub shorter than 12 m is ever emitted');
check(r[0].a.x === 0 && r[r.length - 1].b.x === 800, 'the route still starts and ends at the corridor endpoints');
for (let k = 1; k < r.length; k++) check(r[k].a.x === r[k - 1].b.x && r[k].a.z === r[k - 1].b.z, `road ${k} starts where road ${k - 1} ends`);

r = corridorRoads([P(0, 0), P(600, 0), P(600, 600), P(0, 600)]);
check(r.length === 3 && r.every(x => !x.control), 'long segments meeting at right angles stay straight roads (a corner at a node is valid; only stubs and kinks need a curve)');
check(corridorRoads([P(0, 0), P(0, 0)]).length === 0 && corridorRoads([P(5, 5)]).length === 0, 'degenerate input gives no roads');
r = corridorRoads([P(0, 0), P(500, 0), P(500, 500)]);
check(r.length === 2, 'two long segments whose total exceeds 950 m are not merged into one curve');

check(JSON.stringify(quotedCost(5632, 100000, 250000)) === '{"cost":5632,"costSource":"quoted"}', 'quoted cost wins even when cash rose meanwhile (income or a milestone reward)');
check(JSON.stringify(quotedCost(undefined, 100000, 94000)) === '{"cost":6000,"costSource":"cash_delta"}', 'without a quote the cash delta is used and labelled');
check(quotedCost(0, 100, 100).costSource === 'quoted', 'a quoted zero is a real zero');
process.exit(failed ? 1 : 0);
