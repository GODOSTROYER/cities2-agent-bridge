# Round Rock — city plan

Agents: read before building. Update the "Built" and "Next" sections when you finish work.
Coordinates are world metres (x east, z north). The core sits at roughly x -935..-85, z -495..935.

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

## Built
- Core: old town (north-west), original grids, entrance Medium Road from the highway at (-800, 17).
- South grids: x -880..-550, z -460..-350; x -415..-85, z -495..-275 (both enclosed, no stubs; built before this plan).
- Services: MedicalClinic01 (-746, 454), ElementarySchool01 (-738, 526).
- Tiles: 9 starting tiles plus the south tile (x -312..312, z -1558..-935).
- Arterial A1: Medium Road from (-85, -484) to (0, -1000) into the south tile; one house cleared.
- District S1: 3×2 residential grid at x -415..-85, z -838..-618, connected to A1, with stubs.

## Next
1. Grow residential along A1 into the south tile, keeping commercial frontage on A1.
2. Landfill: occupancy-based site in an industrial area (open issue: large-building placement).
3. Industrial district near the highway (needs a tile purchase west or south-west).
4. Police and fire coverage for S1 and the core.
5. Extend A1 south through the south tile as districts fill. Second arterial east when the next tile is bought.
