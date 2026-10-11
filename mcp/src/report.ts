// journals/REPORT.md: one table of every city system, worst first, regenerated from code at each
// checkpoint (zero tokens). Each system is scored on the WORSE of two things (FAILURES #99):
// its capacity headroom (use against capacity, coverage) and its OUTCOME (what citizens get: the
// happiness factor the game computes, icons on the map, traffic flow, people waiting).
// "Post at 20% of capacity" read fine while the owner saw the service failing.
// PURE: buildReport() takes plain data and the previous values and returns markdown.
export type Grade = 'critical' | 'bad' | 'ok' | 'good' | 'unknown';
export interface SystemRow { system: string; status: Grade; outcome: string; capacity: string; coverage: string; trend: string; action: string; blocked: string; value: number | null }
interface Spec { system: string; factors?: string[]; table?: string[]; cov?: string; icons?: RegExp; need?: string; action: string; view?: string }

// One entry per infoview of the game (names as the game shows them) plus the budget rows.
export const SYSTEMS: Spec[] = [
  { system: 'Traffic', factors: ['TrafficPenalty'], icons: /traffic/i, need: 'traffic', action: 'fix_traffic ladder; arterials, more highway links and river crossings (agent)' },
  { system: 'Post', factors: ['Mail'], table: ['post'], cov: 'PostService', icons: /mail|post/i, need: 'post', action: 'post offices by coverage' },
  { system: 'Parks and recreation (leisure)', factors: ['Leisure', 'Entertainment'], cov: 'Park', need: 'entertainment', action: 'parks, playgrounds and plazas by coverage' },
  { system: 'Fire and rescue', table: ['fire'], cov: 'FireRescue', icons: /fire|burned/i, need: 'fire', action: 'fire houses by headroom and coverage' },
  { system: 'Police', factors: ['Crime'], table: ['police'], cov: 'Police', icons: /crime/i, need: 'police', action: 'police stations by coverage and crime' },
  { system: 'Healthcare', factors: ['Healthcare'], table: ['health', 'ambulances'], cov: 'Healthcare', icons: /ambulance|sick/i, need: 'health', action: 'clinics by headroom and coverage' },
  { system: 'Deathcare', factors: ['DeathPenalty'], table: ['deathcare'], icons: /hearse/i, need: 'deathcare', action: 'cemetery or crematorium by headroom' },
  { system: 'Garbage', factors: ['Garbage'], table: ['garbage'], icons: /garbage/i, need: 'garbage', action: 'landfill, recycling, incinerator' },
  { system: 'Electricity', factors: ['Electricity'], table: ['power'], icons: /electric|powerline/i, need: 'power', action: 'turbines or a plant before 78% (agent sites plants)' },
  { system: 'Water', factors: ['Water', 'WaterPollution'], table: ['water'], icons: /^water|no water|dirty water/i, need: 'water', action: 'pumping capacity before 78% (agent)' },
  { system: 'Sewage', factors: ['Sewage'], table: ['sewage'], icons: /sewage/i, need: 'sewage', action: 'outlet or treatment before 78% (agent)' },
  { system: 'Education: elementary', factors: ['Education'], table: ['school'], cov: 'Education', action: 'elementary schools by places and coverage' },
  { system: 'Education: high school', table: ['highschool'], action: 'high schools by places' },
  { system: 'Education: college', table: ['college'], action: 'college by places' },
  { system: 'Education: university', table: ['university'], action: 'university by places' },
  { system: 'Telecom', factors: ['Telecom'], need: 'telecom', action: 'radio masts, telecom tower' },
  { system: 'Air pollution', factors: ['AirPollution'], icons: /air pollution/i, action: 'pollution_sources; move the source, site rules' },
  { system: 'Ground pollution', factors: ['GroundPollution'], icons: /ground pollution/i, action: 'keep homes off polluted ground' },
  { system: 'Noise pollution', factors: ['NoisePollution'], icons: /noise/i, action: 'site rules; no homes by highways and plants' },
  { system: 'Welfare', factors: ['Welfare'], action: 'welfare office (development tree)' },
  { system: 'Homelessness', factors: ['Homelessness'], action: 'housing by demand' },
];
// Infoviews the bridge does not read yet: listed so nothing is silently missing.
// Names are the game's own InfoviewPrefab names (get_metrics.infoviews); parking has no infoview of its own.
export const NOT_READ = ['Roads', 'Parking (under Roads/Traffic)', 'Transport', 'Bicycles', 'DisasterControl', 'Administration', 'Tourism', 'OutsideConnections', 'LandValue', 'Profitability', 'Wealth', 'Level', 'Extractors', 'WaterPollution'];

const rank: Record<Grade, number> = { critical: 0, bad: 1, ok: 2, good: 3, unknown: 4 };
const worst = (a: Grade, b: Grade): Grade => rank[a] <= rank[b] ? a : b;
const arrow = (now: number | null, before: number | undefined) => now === null || before === undefined ? '' : now > before + 0.2 ? 'better' : now < before - 0.2 ? 'worse' : 'same';

export interface ReportInput {
  snap: Record<string, any>; table?: Record<string, { pct: number | null; projected: number | null; status: string }>; coverage?: Record<string, number>;
  blocked?: Record<string, string>; did?: string[]; diagnosis?: string; when: string; prev?: Record<string, number>;
}

export function gradeOf(factor: number | null, tableStatus: string | null, uncoveredPct: number | null, extra: Grade = 'good'): Grade {
  let g: Grade = factor === null && tableStatus === null && uncoveredPct === null ? 'unknown' : 'good';
  if (factor !== null) g = worst(g, factor < -5 ? 'critical' : factor < -3 ? 'bad' : factor < 1 ? 'ok' : 'good');
  if (tableStatus !== null) g = worst(g, tableStatus === 'over' || tableStatus === 'none' ? 'critical' : tableStatus === 'low' ? 'bad' : 'ok');
  if (uncoveredPct !== null) g = worst(g, uncoveredPct > 30 ? 'bad' : uncoveredPct > 8 ? 'ok' : 'good');
  return g === 'unknown' ? g : worst(g, extra);
}

export function buildReport(i: ReportInput): { markdown: string; values: Record<string, number>; rows: SystemRow[] } {
  const snap = i.snap; const factors = snap.happiness ?? {}; const icons = snap.icons ?? {}; const rows: SystemRow[] = []; const values: Record<string, number> = {};
  const add = (r: SystemRow) => { if (r.value !== null) values[r.system] = r.value; r.trend = arrow(r.value, i.prev?.[r.system]); rows.push(r); };
  for (const s of SYSTEMS) {
    const fs = (s.factors ?? []).filter(f => factors[f] !== undefined).map(f => Number(factors[f])); const factor = fs.length ? Math.min(...fs) : null;
    const ts = (s.table ?? []).map(k => i.table?.[k]).filter(Boolean) as { pct: number | null; projected: number | null; status: string }[];
    const t = ts.sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))[0] ?? null;
    const cov = s.cov && i.coverage?.[s.cov] !== undefined ? Number(i.coverage[s.cov]) : null;
    const iconCount = s.icons ? Object.entries(icons).filter(([k]) => s.icons!.test(k)).reduce((a, [, v]) => a + Number(v), 0) : 0;
    const need = s.need ? snap.needs?.[s.need] : null; const waiting = Number(need?.dead ?? 0) + Number(need?.sick ?? 0) + Number(need?.unserved ?? 0);
    let extra: Grade = iconCount >= 20 ? 'bad' : 'good'; let outcome = [factor !== null ? `factor ${factor}` : '', iconCount ? `${iconCount} icons` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(', ');
    let value: number | null = factor;
    if (s.system === 'Traffic') { const flow = Number(snap.cityFlow ?? NaN); if (Number.isFinite(flow)) { outcome = `flow ${flow}% (target 75+), ${outcome}`; extra = worst(extra, flow < 50 ? 'critical' : flow < 75 ? 'bad' : 'good'); value = flow / 10; } }
    if (Number(need?.unserved ?? 0) > 0) extra = 'critical';
    add({ system: s.system, status: gradeOf(factor, t?.status ?? null, cov, extra), outcome: outcome || '-', capacity: t ? `${t.pct ?? '-'}%${t.projected !== null && t.projected !== t.pct ? ' -> ' + t.projected + '% planned' : ''}` : '-', coverage: cov === null ? '-' : `${cov}% homes uncovered`, trend: '', action: s.action, blocked: i.blocked?.[s.need ?? ''] ?? '', value: value ?? (t?.pct !== null && t?.pct !== undefined ? -t.pct / 20 : null) });
  }
  const d = snap.demand ?? {}; const maxRes = Math.max(Number(d.rL ?? 0), Number(d.rM ?? 0), Number(d.rH ?? 0));
  add({ system: 'Zones: housing (demand low/medium/high)', status: maxRes >= 90 ? 'bad' : maxRes >= 50 ? 'ok' : 'good', outcome: `${d.rL ?? 0}/${d.rM ?? 0}/${d.rH ?? 0}`, capacity: '-', coverage: '-', trend: '', action: 'a district for every bar at 50+ each cycle', blocked: i.blocked?.grow ?? '', value: -maxRes / 10 });
  add({ system: 'Zones: commercial/industrial/office (demand)', status: 'ok', outcome: `${d.c ?? 0}/${d.i ?? 0}/${d.o ?? 0}; ${JSON.stringify(snap.demandWhy ?? {}).slice(0, 110)}`, capacity: '-', coverage: '-', trend: '', action: 'zoned when a bar reaches 50', blocked: '', value: null });
  const unemp = Number(snap.jobs?.unemp ?? 0);
  add({ system: 'Workplaces and jobs', status: unemp >= 20 ? 'bad' : unemp >= 10 ? 'ok' : 'good', outcome: `unemployment ${unemp}%, vacancies by education ${JSON.stringify(snap.jobs?.vacantByEdu ?? [])}`, capacity: '-', coverage: '-', trend: '', action: i.diagnosis ?? 'diagnose: no jobs or education mismatch', blocked: '', value: -unemp / 5 });
  add({ system: 'Population and happiness', status: Number(snap.happy ?? 0) >= 65 ? 'good' : Number(snap.happy ?? 0) >= 50 ? 'ok' : 'bad', outcome: `pop ${snap.city?.pop}, happiness ${snap.happy}, health ${snap.health}`, capacity: '-', coverage: '-', trend: '', action: '-', blocked: '', value: Number(snap.happy ?? 0) / 10 });
  const cash = Number(snap.city?.money ?? 0), net = Number(snap.city?.net ?? 0);
  add({ system: 'Budget', status: net < 0 ? 'critical' : cash < 1_000_000 ? 'ok' : 'good', outcome: `cash ${cash}, net ${net}/month, taxes ${JSON.stringify(snap.tax ?? {})}, Tax factor ${factors.Tax ?? '-'} (exempt)`, capacity: '-', coverage: '-', trend: '', action: 'reserve 1,000,000; taxes pinned', blocked: '', value: net / 100000 });
  add({ system: 'Milestone', status: 'ok', outcome: `milestone ${snap.milestone?.achieved}, XP ${snap.milestone?.xp}/${snap.milestone?.nextXp}`, capacity: '-', coverage: '-', trend: '', action: 'grow population and happiness', blocked: '', value: Number(snap.milestone?.xp ?? 0) / 1000 });
  for (const n of NOT_READ) rows.push({ system: n, status: 'unknown', outcome: 'not read by the bridge yet', capacity: '-', coverage: '-', trend: '', action: 'add a reader', blocked: 'harness', value: null });
  rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.value ?? 0) - (b.value ?? 0));
  const top = rows.filter(r => r.status === 'critical' || r.status === 'bad').slice(0, 5);
  const md = [`# City report ${i.when}`, '', '## Top problems and what is being done',
    ...(top.length ? top.map((r, k) => `${k + 1}. **${r.system}** (${r.status}): ${r.outcome}${r.capacity !== '-' ? ', capacity ' + r.capacity : ''}. ${r.action}${r.blocked ? '. Blocked by: ' + r.blocked : ''}`) : ['Nothing critical or bad.']),
    '', `Last actions: ${(i.did ?? []).slice(-6).join('; ') || '-'}`, '',
    '| system | status | outcome | use / capacity | coverage | trend | action | blocked by |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.system} | ${r.status} | ${r.outcome} | ${r.capacity} | ${r.coverage} | ${r.trend || '-'} | ${r.action} | ${r.blocked || '-'} |`), ''].join('\n');
  return { markdown: md, values, rows };
}
