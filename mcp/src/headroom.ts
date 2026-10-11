// Owner policy (FAILURES #96): every service stays AHEAD of need. Capacity must be at least
// 125-130% of use, so usage above 78% of capacity is "low" and the planner adds capacity in the
// same cycle; above 100% is "over" (critical: the reserve does not hold it back). Coverage gaps
// are unmet need even when total capacity is fine (the planner checks those separately).
// Before a district is zoned, its people are added to the projection so services are built WITH
// the district. PURE: no bridge imports, unit-tested in test/headroom.ts.
export const TARGET_PCT = 78;
export type Status = 'ok' | 'low' | 'over' | 'none';
export interface Row { use: number; cap: number; pct: number | null; projected: number | null; status: Status; unit: string }

export function status(use: number, cap: number, target = TARGET_PCT): Status {
  if (!(cap > 0)) return use > 0 ? 'none' : 'ok';
  const pct = (use / cap) * 100;
  return pct > 100 ? 'over' : pct > target ? 'low' : 'ok';
}
const row = (use: number, cap: number, growth: number, unit: string): Row => {
  const u = Math.max(0, Math.round(use)), c = Math.max(0, Math.round(cap)); const proj = u * growth;
  const worst = status(proj, c);        // judged on the PROJECTED use: ahead of growth
  return { use: u, cap: c, pct: c > 0 ? Math.round((u / c) * 100) : null, projected: c > 0 ? Math.round((proj / c) * 100) : null, status: worst, unit };
};

// Vehicles per 10,000 residents the city should own (a planning norm, not a game constant: the
// game exposes no "use" for these services, only complaints once they fail).
export const NORMS: Record<string, number> = { fire: 5, police: 5, deathcare: 3, health: 4, garbage: 8, post: 5 };

// People a planned district brings, by zone key (rough, from the live city: about 3 residents
// per low-density cell block, far more in rows and towers).
export function plannedPeople(districts: { zone: string; cols: number; rows: number }[]): number {
  const per: Record<string, number> = { res: 180, resmed: 450, resmid: 700, mixed: 600, reshigh: 1500 };
  return districts.reduce((sum, d) => sum + (per[d.zone] ?? 0) * d.cols * d.rows, 0);
}

// One row per service, keyed by the planner's rule type (services.ts RULES.t) plus the utilities.
export function serviceTable(h: Record<string, any>, snap: Record<string, any>, addedPeople = 0): Record<string, Row> {
  const pop = Math.max(1, Number(snap?.city?.pop ?? 0)); const growth = (pop + Math.max(0, addedPeople)) / pop; const per10k = pop / 10000;
  const util = snap?.util ?? {}; const e = h?.education ?? {}; const people = h?.people ?? {};
  // Enrolment can lag behind the children who should be in school, so the larger number counts.
  const eligible = (students: number, cohort: number, share: number) => Math.max(Number(students ?? 0), Number(cohort ?? 0) * share);
  // The game's own usage of the service buildings (0-100%, average) is the real load: when it
  // is known it is compared with the norm and the WORSE of the two decides (FAILURES #107).
  const u = h?.usage ?? {};
  // Capacity services (schools, clinics): the game's usage. Vehicle services: the share of
  // facilities with no vehicle free, scaled so that "every station busy" reads 100%.
  const v = h?.vehicles ?? {};
  const worse = (r: Row, key: string): Row => {
    const veh = v[key]; const g = u[key];
    const cand = veh && Number(veh.buildings) > 0 ? row(Number(veh.busyPct), 100, growth, 'stations with no vehicle free %') : (g && Number(g.buildings) > 0 && ['school', 'highschool', 'college', 'university', 'health'].includes(key) ? row(Number(g.avgPct), 100, growth, 'usage %') : null);
    return cand && (cand.projected ?? 0) > (r.projected ?? 0) ? cand : r;
  };
  return {
    power: row(Number(util.power?.use ?? 0), Number(util.power?.prod ?? 0), growth, 'kW'),
    water: row(Number(util.water?.use ?? 0), Number(util.water?.cap ?? 0), growth, 'm3'),
    sewage: row(Number(util.sewage?.use ?? 0), Number(util.sewage?.cap ?? 0), growth, 'm3'),
    school: worse(row(eligible(e.elementary?.students, people.children, 0.9), Number(e.elementary?.capacity ?? 0), growth, 'pupils'), 'school'),
    highschool: worse(row(eligible(e.high?.students, people.teens, 0.6), Number(e.high?.capacity ?? 0), growth, 'students'), 'highschool'),
    college: worse(row(Math.max(Number(e.college?.students ?? 0), Number(people.adults ?? 0) * 0.03), Number(e.college?.capacity ?? 0), growth, 'students'), 'college'),
    university: worse(row(Math.max(Number(e.university?.students ?? 0), Number(people.adults ?? 0) * 0.015), Number(e.university?.capacity ?? 0), growth, 'students'), 'university'),
    health: worse(row(Math.max(Number(h?.health?.patients ?? 0), Number(snap?.needs?.health?.sick ?? 0)), Number(h?.health?.capacity ?? 0), growth, 'patients'), 'health'),
    ambulances: worse(row(per10k * NORMS.health, Number(h?.health?.ambulances ?? 0), growth, 'vehicles'), 'ambulances'),
    deathcare: worse(row(per10k * NORMS.deathcare + Number(snap?.needs?.deathcare?.dead ?? 0) / 5, Number(h?.deathcare?.hearses ?? 0), growth, 'hearses'), 'deathcare'),
    garbage: worse(row(per10k * NORMS.garbage, Number(h?.garbage?.trucks ?? 0), growth, 'trucks'), 'garbage'),
    fire: worse(row(per10k * NORMS.fire, Number(h?.fire?.engines ?? 0), growth, 'engines'), 'fire'),
    police: worse(row(per10k * NORMS.police, Number(h?.police?.cars ?? 0), growth, 'cars'), 'police'),
    post: worse(row(per10k * NORMS.post, Number(h?.post?.vans ?? 0), growth, 'vans'), 'post'),
  };
}

// Planner rule type -> the worst row that speaks for it.
export function headroomFor(table: Record<string, Row>): Record<string, { status: Status; pct: number | null; projected: number | null }> {
  const pick = (...keys: string[]) => keys.map(k => table[k]).filter(Boolean).sort((a, b) => rank(b.status) - rank(a.status) || (b.projected ?? 0) - (a.projected ?? 0))[0];
  const rank = (s: Status) => s === 'over' || s === 'none' ? 3 : s === 'low' ? 2 : 1;
  const out: Record<string, { status: Status; pct: number | null; projected: number | null }> = {};
  for (const [t, keys] of Object.entries({ health: ['health', 'ambulances'], deathcare: ['deathcare'], fire: ['fire'], police: ['police'], school: ['school'], highschool: ['highschool'], college: ['college'], university: ['university'], post: ['post'], garbage: ['garbage'] })) {
    const r = pick(...keys); if (r) out[t] = { status: r.status, pct: r.pct, projected: r.projected };
  }
  return out;
}

// One line for progress.md and the brief snapshot: "power 39% ok | school 112%->129% OVER | ...".
export function tableLine(table: Record<string, Row>): string {
  return Object.entries(table).map(([k, r]) => `${k} ${r.pct ?? '-'}%${r.projected !== null && r.projected !== r.pct ? '->' + r.projected + '%' : ''}${r.status === 'ok' ? '' : ' ' + r.status.toUpperCase()}`).join(' | ');
}

// Utilities the planner cannot site by itself: what to raise.
export function utilityAlerts(table: Record<string, Row>): string[] {
  return ['power', 'water', 'sewage'].filter(k => table[k] && table[k].status !== 'ok').map(k => `${k} at ${table[k].pct}% of capacity (projected ${table[k].projected}%): add capacity before it passes 100%`);
}
