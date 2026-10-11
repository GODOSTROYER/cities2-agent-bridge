// Names the CAUSE of a bad city-system grade, so the planner picks the matching fix, and ranks
// root causes before the systems they knock on. Rules run in order; the first match wins.
// PURE: imports nothing, unit-tested in test/diagnose.ts.
export type Cause = 'none' | 'locked' | 'staffing' | 'capacity' | 'coverage' | 'access_traffic' | 'siting_pollution' | 'knock_on' | 'unknown';
export interface DiagnoseInput {
  system: string;                 // row name, e.g. 'Police', 'Post', 'Healthcare', 'Air pollution'
  status: 'critical' | 'bad' | 'ok' | 'good' | 'unknown';
  capacityPct?: number | null;    // use as % of capacity now
  projectedPct?: number | null;   // use as % of capacity with planned growth
  uncoveredPct?: number | null;   // % of homes outside coverage
  factor?: number | null;         // happiness factor of the system (negative = bad)
  busyPct?: number | null;        // % of stations with no vehicle free
  efficiencyPct?: number | null;  // average efficiency of the service buildings (100 = normal)
  blocked?: string | null;        // why the last placement failed, e.g. 'prefab_locked', 'no_roadside_site'
  flowPct?: number | null;        // citywide traffic flow %
  icons?: number | null;
}
export interface Diagnosis { cause: Cause; why: string; fix: string }

// Systems whose service vehicles and citizens depend on the road network.
export const TRAFFIC_DEPENDENT: string[] = ['Fire and rescue', 'Police', 'Healthcare', 'Deathcare', 'Garbage', 'Post'];
// root -> systems it drives
export const LINKS: Record<string, string[]> = { 'Traffic': TRAFFIC_DEPENDENT, 'Air pollution': ['Healthcare'], 'Ground pollution': ['Healthcare'], 'Garbage': ['Healthcare'], 'Education: high school': ['Workplaces and jobs'], 'Education: college': ['Workplaces and jobs'] };
export interface Ranked { system: string; status: string; cause: Cause; rootOf: string[]; drivenBy: string | null }

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pct = (x: number | null | undefined) => num(x) ? `${x}%` : 'unknown';
const drives = (s: string): string[] => Object.prototype.hasOwnProperty.call(LINKS, s) ? LINKS[s] : [];

export function diagnose(i: DiagnoseInput): Diagnosis {
  // 1-2: nothing to fix, or nothing to read.
  if (i.status === 'good' || i.status === 'ok') return { cause: 'none', why: `status is ${i.status}`, fix: 'no action' };
  if (i.status === 'unknown') return { cause: 'unknown', why: 'no reading for this system', fix: 'add a reader' };
  // 3: a locked prefab or node blocks any placement, whatever the numbers say.
  if (/locked/i.test(i.blocked ?? '')) return { cause: 'locked', why: `placement blocked by ${i.blocked}`, fix: 'buy the development node or reach the milestone' };
  // 4: buildings that are not staffed or connected run below normal, so more capacity would not help.
  if (num(i.efficiencyPct) && i.efficiencyPct < 70) return { cause: 'staffing', why: `buildings run at ${i.efficiencyPct}% efficiency`, fix: 'staff, power, water and road access of the buildings; budget to 100%+' };
  // 5: more people than the capacity now or after planned growth.
  if ((num(i.capacityPct) && i.capacityPct > 100) || (num(i.projectedPct) && i.projectedPct > 100)) return { cause: 'capacity', why: `capacity is ${pct(i.capacityPct)} now and ${pct(i.projectedPct)} with planned growth`, fix: 'add capacity (a larger building or an extension)' };
  // 6: capacity is fine but homes lie outside the service area.
  if (num(i.uncoveredPct) && i.uncoveredPct > 8) return { cause: 'coverage', why: `${i.uncoveredPct}% of homes are outside coverage`, fix: 'a building in the uncovered district' };
  // 7-8: vehicles are out; if traffic is also jammed the roads are the cause.
  const busy = num(i.busyPct) && i.busyPct >= 78;
  if (busy && num(i.flowPct) && i.flowPct < 60) return { cause: 'access_traffic', why: `stations busy (${i.busyPct}%) and traffic flow is ${i.flowPct}%`, fix: 'fix traffic first; vehicles are out and stuck' };
  if (busy) return { cause: 'capacity', why: `${i.busyPct}% of stations have no vehicle free`, fix: 'more vehicles: another station or a larger one' };
  // 9: pollution is a placement problem, not a capacity one.
  if (/pollution/i.test(i.system)) return { cause: 'siting_pollution', why: `pollution is a siting problem${num(i.icons) ? ` (${i.icons} icons)` : ''}`, fix: 'find the source (pollution_sources) and move it or the homes; site rules' };
  // 10: a traffic-dependent system with jammed traffic is fixed by its root.
  if (TRAFFIC_DEPENDENT.includes(i.system) && num(i.flowPct) && i.flowPct < 60) return { cause: 'knock_on', why: `traffic flow is ${i.flowPct}% and ${i.system} depends on traffic`, fix: 'traffic is the root cause' };
  return { cause: 'unknown', why: `no rule matched for ${i.system} (status ${i.status})`, fix: 'inspect: no rule matched' };
}

// Order for action: a bad/critical root of other bad/critical systems first, then critical before
// bad, then knock-on and access-traffic causes last (their root fixes them). Ok/good/unknown are left out.
export function rankRootCauses(rows: { system: string; status: string; cause: Cause }[]): Ranked[] {
  const live = rows.filter(r => r.status === 'bad' || r.status === 'critical');
  const names = new Set(live.map(r => r.system));
  const out: Ranked[] = live.map(r => {
    const rootOf = drives(r.system).filter(s => names.has(s));
    const root = live.find(o => o.system !== r.system && drives(o.system).includes(r.system));
    return { system: r.system, status: r.status, cause: r.cause, rootOf, drivenBy: root ? root.system : null };
  });
  const group = (r: Ranked) => r.cause === 'knock_on' || r.cause === 'access_traffic' ? 2 : r.rootOf.length > 0 ? 0 : 1;
  const crit = (r: Ranked) => r.status === 'critical' ? 0 : 1;
  return out.sort((a, b) => group(a) - group(b) || crit(a) - crit(b));
}
