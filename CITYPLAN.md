# Round Rock — city plan

Agents: read before building. Update the "Built" and "Next" sections when you finish work.
Coordinates are world metres (x east, z north). The core sits at roughly x -935..-85, z -495..935.

## 2026-10-10 state
- Population about 7,100. Milestone 6 (XP ~27,200 / 32,100).
- Taxes R15 C10 I10 O10: owner pins (`journals/tax-pins.json`; Residential 15, business rates 10-11). The Tax factor is exempt from the priority rules.
- Unemployment ~12% (8.2% before the latest housing).
- New today: second highway connection at (-1303,-100) via a curved Medium Road from the west grid; bus depot at (-1246,-141); north tile bought with a 3x2 medium-density grid; housing in the far-west tile.
- Services added today: cemetery, 2 clinics, 3 police stations, fire house, coal plant, wind turbine, 6 parks, radio mast.
- Tiles bought: south, north, west, far-west.
- Known problems: traffic -3.7 (local jams in dense blocks, single spur junction); job-zone demand 0 (industry limited by uneducated workforce, offices by empty buildings); highway junction jam at (-800, 17) (FAILURES #63, open); about 60 noise pollution icons.
- The "Built" and "Next" sections below predate this block; this block is current.

## Principles
1. **Arterials first.** New districts attach to arterials (Medium Road via `play.ps1 link`), never through another district's back streets. Lots line every road, so enclosed districts cannot be reached later without demolition.
2. **Every grid leaves stubs.** `grid.ps1` builds four 64 m stubs outward before zoning. Do not zone over or build on stub ends; they are the next district's connection.
3. **Zoning by role.**
   - Residential: interior blocks.
   - Commercial: arterial frontage and district entrances.
   - Industry: its own district near the highway, downwind and away from homes.
   - Office: next to commercial once it unlocks.
4. **Services at district centres:**
   - one clinic and one elementary school per ~2–3k residents
   - police and fire per district
   - landfill and, later, recycling in the industrial district
5. **Land:** buy tiles adjacent to arterials. Prefer dry, flat land (`play.ps1 buy` scores tiles by dryness, relief and distance).
6. **Budget:**
   - keep net per period ≥ 0 and a cash reserve of at least ₡150k
   - taxes R12 / C13 / I12 while demand stays high
   - lower service budgets before raising taxes above 15
7. **Upgrade path:**
   - Medium density along arterials once unlocked (rezone only empty or new blocks; never mass-demolish).
   - Bus lines along arterials at about 2k population.
   - Then high schools, parks, and a fire/police station per district.

## Site scoring (play.ps1 Find-Sites, automatic in grow/sites)
- Residential: penalise pollution (air/ground/noise samples), prefer ≥600 m from industry/power/landfill, penalise <150 m from highways, keep jobs within ~1.2 km.
- Commercial: within ~500 m of homes; mild pollution penalty; arterial frontage preferred.
- Industrial: ≥600 m from homes preferred, within ~400 m of a highway for trucks.
- All: short, clear links (less detour traffic); sites needing demolition rank last.
- Not yet modelled: wind direction, per-road traffic load (edges expose raw counters), public transport (the bridge has no transit-line commands; needs a mod extension around 2k population).

## Built
- Core: old town (north-west), original grids, entrance Medium Road from the highway at (-800, 17).
- South grids: x -880..-550, z -460..-350; x -415..-85, z -495..-275 (both enclosed, no stubs; built before this plan).
- Services: MedicalClinic01 (-746, 454), ElementarySchool01 (-738, 526).
- Tiles: 9 starting tiles plus the south tile (x -312..312, z -1558..-935).
- Arterial A1: Medium Road from (-85, -484) to (0, -1000) into the south tile; one house cleared.
- District S1: 3×2 residential grid at x -415..-85, z -838..-618, connected to A1, with stubs.
- District S2: 2×2 residential grid at x 25..245, z -1198..-978 (south tile), connected near A1 end; one stub dropped (city limit).
- Taxes R12 / C13 / I12.

## Next
1. Grow residential along A1 into the south tile, keeping commercial frontage on A1.
2. Landfill: occupancy-based site in an industrial area (open issue: large-building placement).
3. Industrial district near the highway (needs a tile purchase west or south-west).
4. Police and fire coverage for S1 and the core.
5. Extend A1 south through the south tile as districts fill. Second arterial east when the next tile is bought.

## Strategic review 2026-10-11 (milestone 9, pop 19k)

Decisions:
- Growth is demand-driven (every bar at 50+ gets a district); services are built ahead of need (usage under 78% of capacity, coverage gap under 8%), sized for the planned districts.
- Land: the east tiles (x 458..1558, z -935..-312) and the west side behind the highway (arterial x about -1650 from z 219 to 1750) are the expansion areas. West-side traffic depends on ONE small-road underpass at z=130: upgrade it and add a second underpass before the west passes about 8,000 residents.
- Traffic push done 2026-10-11: Large Road corridors highway entry -> centre -> east district, centre -> south, centre -> north; second river crossing for the north district at (-355,1100); west arterial; south-west office grid connected at (-1185,-2445)->(-895,-2445).
- NOT done, next road work (needs ramp design, preview every leg):
  1. Second highway connection. Best place: east carriageway (flows toward -z) at about (-1303,-97) with an off-ramp to the road node (-1158,-173) and an on-ramp from (-1158,-285) to the carriageway near z=-420. The bus depot at (-1246,-141) is in the way of the off-ramp: move the depot first.
  2. West carriageway (flows toward +z): off-ramp from node (-1325,-85) to the west district corner (-1405,-65) as a ONE-WAY ramp (the old at-grade piece), on-ramp further north.
  3. The highway terminus at (-877,33) feeds one road; the double nodes at (-800,17)/(-798,21) and (-660,8)/(-664,8) are 4 m apart and should be merged into one junction each.
  4. North district junction at (-519,1371): four Large Road arms at 1% flow with traffic data: inspect lane connections, try a roundabout (RoundaboutsNode is bought).
- Power: 81% of capacity at 19k residents. Wind turbines need 190 m clearance and roadside sites are scarce: buy GasPowerPlantNode or place a second coal plant on the east road (no homes downwind) before 90%.
- Bank mode (owner): no districts, tiles or amenities until cash reaches 5,000,000; only over-capacity and very-high needs are paid.

## Traffic engineering rules and results (2026-10-11)

Diagnosis of the highway congestion (the only highway: mainline north-south at x about -1300..-1650, one spur into the city):
- Queue origin: the spur ENDS at (-877,33) directly into a city street with three junctions inside 190 m ((-800,17), (-664,8)/(-660,8) 4 m apart, (-622,6)/(-615,10)); the queue backs up the spur to the interchange ramps (1 lane, flow 1-2%). Classes: one interchange for the whole city (missing links), junction spacing at the terminus, missing hierarchy (local grid streets on the entry road).
- The five north-district segments around (-519,1371) at 1% flow: junction capacity (four Large Road arms meeting at one signal), and the district had one river crossing (missing link).

Rules used:
- Hierarchy highway -> arterial -> collector -> local. A ramp feeds an arterial; the arterial runs continuously to the centre.
- A highway is entered and left only by one-way ramps that diverge or merge at a shallow angle at carriageway nodes, preferably where a lane is added or dropped. Never a crossing at grade; the other carriageway is reached by an underpass.
- Every district needs two independent ways out. Roads cross water as bridges, cables as overhead lines.
- Measure flow per changed segment only after a game day: a new or upgraded road starts with empty counters and reads low.

Built in the push (cost about 20,000 in total):
| change | where | class addressed |
|---|---|---|
| Large Road corridor | highway entry (-800,17) -> centre -> east (110,-139), 15 edges | hierarchy |
| Large Road corridor | centre -> south (-559,-1428), 15 edges; centre -> north (-720,1132), 12 edges | hierarchy |
| Second river crossing | north district to (-355,1100), 297 m bridge | missing link |
| Half interchange (southbound exit and entry) | off-ramp from the lane-drop node (-1311,-224) to (-1158,-175); on-ramp (-1158,-285) -> (-1318,-362); collector and corridor to (-664,-120) upgraded to Large Road | one interchange for the whole city |
| Southbound exit for the south | off-ramp (-1471,-1924) -> (-1405,-2085) into the south-west grid, linked to the south district | missing link |
| West arterial | (-1612,219) -> (-1650,1750) Medium Road | access to new land |

Still to do: northbound ramps (west carriageway) with an underpass; an entry ramp for the south (city limit in the way: buy the tile west of x=-1558 first); merge the double nodes at the spur terminus; a roundabout at (-519,1371); move the bus depot if a ramp needs its site.
Before: flow 53-55%, TrafficPenalty -4.3, 24 bottleneck icons. After-numbers go into progress.md once a game day has passed.
