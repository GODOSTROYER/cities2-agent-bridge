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


## Utopia plan (owner direction, 2026-10-11): long-term optimal solutions only

### A. Garbage system (numbers read from the game, garbage_system reader)
- City production: 1,802,800 a month. With 30% headroom the system must process and collect 2,340,000.
- Facility types (processing a month / storage / trucks + transfer trucks / build cost / listed upkeep a month / air, ground, noise):
  - Recycling centre: 1,500,000 / 1,500,000 / 15 + 5 / 880,000 / 80,000 / 5,000, 10,000, 15,000. Extensions: truck depot +10 trucks (200,000, 15,000 a month, noise 5,000), storage +250,000 (150,000, 10,000), hazardous waste point +250,000 processing (200,000, 20,000).
  - Landfill: 100,000 / 100,000 / 20 + 3 / 70,000 / 15,000 / 20,000, 20,000, 40,000. Depot +10 trucks (7,500 a month). It fills at once at this city size; a full landfill accepts nothing and its 20 trucks stand idle.
  - Incineration plant: 3,000,000 / 3,000,000 / 50 + 10 / 1,000,000 / 105,000 / 40,000 each. Extensions: furnace +1,500,000 (50,000 a month), depot +25 trucks (20,000), storage +300,000.
  - Hazardous (industrial) waste site: locked; industrial waste only; 6,360,000, 225,000 a month.
- Game rules read: a building asks for collection at 400 units and loses happiness from 500 (one point per 1,000 more), so the factor is a matter of how fast a truck arrives, not of storage.
- Found: both landfills full, 40 of 70 trucks idle; 30 working trucks collected about 1,340,000 a month (about 45,000 per truck), 460,000 less than the city produces.
- Design: recycling is the backbone. Two centres process 3,000,000 nominal (128% of the target). Trucks decide the outcome: target 52 working trucks (production with 30% headroom at 45,000 per truck). West centre (-1439,614) with depot = 25, east centre (1206,1081) = 15 (its depot site is blocked: the game answers InvalidShape; to be cleared), third centre with depot in the south-east where the piles are = 25: total 65. Each side of the river and of the highway then has its own centre. Landfills: set to Empty (done), removed when empty (40,000 of air and ground pollution and 30,000 a month of upkeep go). District assignment is tried last, only if trips stay long.
- Cost still to come: third centre 880,000 + depot 200,000, listed upkeep 95,000 (about 257,000 real); removing the landfills frees 30,000 listed. Inside the floors. No incinerator is needed for capacity; it stays an owner decision (NEEDS OWNER in progress.md).

### B. Remote zone "Northgate" for everything citizens dislike
- Facts read from the game: the wind blows to the north-north-east (0.19, 0.35 at every sampled point); the river flows north (velocity +z at (-640,700)); the highway leaves the city to the north-east over a bridge at (-400,2208)-(6,2546) and runs on the east bank through (349,2827), (756,3140), (1281,3595) to the map edge; the land east of the river and north of z 2200 is open, rising gently (455-505 m), with no home within 1,300 m; the nearest homes are across the river to the south-west, upwind.
- Chosen site: the east bank beside the highway, x 312..1558, z 2182..2805 (two tiles of zone land), with its own interchange on the highway in the tile x 312..935, z 2805..3428, and an arterial south through the tile x 935..1558, z 1558..2182 to the north-east utility area and the east districts. Four tiles: (935,1558), (935,2182), (312,2182), (312,2805). Why: it is downwind of the whole city, so every plume leaves over open land; it is downstream; trucks from the outside connection reach it without entering the city (today all of them use the spur into the centre); workers come by the highway or the arterial; power, water and sewage come along the arterial. Tiles can only be bought next to owned land, so the chain starts at the north-east utility tile.
- What moves there: industry (510 buildings today, the largest source of noise and air pollution near homes), in step with rezoning the old industrial blocks nearest to homes into offices and commerce so that jobs are kept; any future heavy processing (an incinerator only if the owner agrees); new wind turbines. What stays near the customers: recycling centres, post, depots, clinics (dispatch points with low pollution). Coal plants are not moved, they are removed (clean-energy stream). Sewage: treatment needs the WaterTreatmentPlant development node (2 points); its place is the river bank downstream of the pumps.
- Stages: 1 tiles, arterial and interchange; 2 utilities verified at the zone; 3 first industrial blocks zoned there; 4 the old blocks nearest to homes rezoned one at a time (check noise icons at (-1298,1721) and (-1165,1679) and the factor after each); 5 buffers of trees on the city side. Nothing old is removed before its replacement works.

### Status 2026-10-11 10:40 (what the plan has become on the ground)
- Garbage: three recycling centres with truck depots (west (-1439,614), south (-1037,-2530), east (1206,1081)); 75 trucks; live processing 3.07M against 1.71M produced; landfills emptied and removed.
- Northgate: tiles (935,1558), (935,2182), (312,2182), (312,2805) owned; Large Road (1300,1520)-(1300,2500)-(560,2500)-(560,2800); half interchange on the city-bound carriageway at (630,3015) (exit) and (367,2806) (entry); wind park of 12 turbines with transformers (1256,1608) and (636,2548). Still to build there: the two ramps for the outbound carriageway (needs an overpass), rail freight (Train node, 1 point; double track at x 1430..1560), industrial blocks when industrial demand returns.
- Energy: 24 wind turbines, 1.40M produced for 0.77M used; no coal plant left.
- Sewage: treatment plant at (-152,1696) on the river downstream (tile x -312..311, z 1558..2181); no raw outlet left.
- Traffic: inbound exits now exist at the north (-1032,1325), the centre (spur and z -224), and the south (tunnel exit to (-1401,-2445)); 21 needless signals removed.

### Status 2026-10-11 12:35
- Sewage: 100% exported through the outside pipe connection at (1470,7168) (trunk pipe from (1300,2500) along x 1470; 7 tiles north of Northgate; stream crossed on a road bridge at z 3600-3920). No outlet and no treatment plant left; both types are forbidden in policy.json.
- Power: wind 1.55M + solar station (1084,2212) 0.28M; battery stations at (932,2560) and (-1884,-406) on high voltage.
- Hospital at (-1500,940). Traffic lights removed at 51 junctions and ramp ends where they stopped a main flow for a trickle.

## Design standard (owner's standing instruction, 2026-10-11)
Decide as the city's architect: the city must look good and function well. Urban-design trade-offs are decided without asking and recorded in journals/progress.md under "Design decisions" (what, why, what was removed or moved). The owner is asked only for what changes the goals or the floors: spending below the cash or net floor, raising taxes, anything on the forbidden list, expansion beyond what a fix needs, the order of development points, demolishing something large. The same text is data in policy.json (designStandard); the audit and the plan check are mcp/src/design.ts.
- Function: a clear road hierarchy with continuous trunks and few conflict points; every district has two or more ways out; services inside the area they serve; transit on the main desire lines with stops at real destinations; freight apart from housing; nothing cut off by a river, a railway or a highway.
- Form: a recognisable centre, district centres, clean edges; regular blocks; no slivers, stub roads, dead ends or orphaned lots; clean angles; smooth, deliberate curves.
- Consistency: one road type along a corridor, no lane drops; the same junction type along a route.
- Green and public space: tree-lined arterials; parks and plazas as focal points and buffers; waterfronts as promenades and parks; planted buffers along highways and railways.
- Density: high near the centre, the transit stops and the amenities, stepping down gradually; schools, clinics and shops within walking distance; no towers behind a single road.
- Tidy infrastructure: bridges and underpasses aligned with their corridors; ramps of 6% or less where a longer one fits (never over 8%); utilities along roads; unsightly or noisy things in Northgate.
- Repair as you go: when an area is touched, remove redundant stubs and double junctions, merge node pairs, re-zone leftover strips, fill gaps with green.
- When function and looks conflict, function wins for safety-critical and service items; otherwise the design that gives both, even if it costs more.
- Checks: the loop runs the urban design audit at every review (REPORT.md system "Urban design", count and trend) and puts the four worst defect kinds into journals/queue.json as design-* items. Road plans are checked before building (checkRoadPlan): dead ends, lane drops, steep ramps and at-grade rail or highway crossings are refused.
