# Round Rock: skyline and beauty plan

Written by the coordinator on 19 October 2026 for the owner's goal: a planned megalopolis that looks amazing, with a skyline like New York's, decor and parks everywhere, every service maxed out. It sits on top of `CITYPLAN-GRAND.md` (districts and structure) and draws on ten research notes in `journals/grand/research-*.md` (web sources were thin; anything marked there as unverified is to be checked in the game before relying on it).

## 1. The skyline (Manhattan on the river)
- **Where:** one tower core, not towers everywhere: Hawthorne (the existing towers) and South Bank along the river, between the subway stations S4, S5 and S6. Seen across the river from Museum Quay and the west bank, like Manhattan from Brooklyn. Height steps down from the core: high density within 400 m of the subway, medium beyond, garden suburbs on the slopes.
- **How towers grow in this game:** high-density zones (residential high, office high, commercial high, mixed) produce tall buildings; a building levels up (gets bigger) only when its rent covers its upkeep, which needs high land value and every service actually met. So: services maxed out and fully covering the core, parks and plazas in every block, no pollution or noise sources nearby, transit at the door.
- **Offices:** office towers are the glass skyline. Office demand is 0 today; the game names taxes (-20) and educated workforce (+40). First make sure colleges and universities have spare places (the 35,000 students become educated workers). An office tax trial at 8% is waiting for the owner's decision (taxes are pinned at 10-11%).
- **Signature buildings:** placeable now: `NA_MixedSignature01/02`, `OfficeLowSignature01-03`, `NA_ResidentialMediumSignature01/02`, `NA_ResidentialMediumRowSignature01/02`, `NA_ResidentialLowSignature01-03`, `IndustrialManufacturingSignature05-07`. Locked so far: `OfficeHighSignature01-03`, `NA_ResidentialHighSignature01-03`, `NA_CommercialHighSignature01-03` (the tall ones: they unlock with later milestones or conditions; place them in the core the moment they unlock). Place signatures at the end of view axes and on the waterfront, never in a back street.

## 2. Showpieces and tourist spots
- Placeable now: `BotanicalGarden01` (waterfront, Museum Quay or South Bank esplanade), `FerrisWheel01` (Museum Quay pier), `XianBellTower` (a plaza at the end of an avenue), large and small fountains (props) for plazas and roundabouts. Locked: `ObservationTower01`, `BronzeStatue01`.
- Each landmark ends a view line: the end of a boulevard, the centre of a square, a bend of the river.
- Tourism first needs a reason: read the tourism figures (attractiveness, hotels, arrivals) before building hotels.

## 3. Beauty everywhere
- Street trees on every road that accepts them (`node test/trees.ts build`); main streets as Medium or Large roads with tree or grass medians (Small Road has no tree variant).
- Groves, tree rows and plaza decoration with `node test/decor.ts` (rows along avenues and the river, groves in parks, rings of trees or fountains round plazas and roundabouts).
- Parks of varied types in every neighbourhood (coverage now: 1% of homes out of reach). Waterfront promenades on both banks.
- Hide the ugly: industry and utilities in the north behind tree belts; no service yards on boulevards.
- No dead ends, stubs or sharp kinks (the urban-design audit lists them).

## 4. Every service maxed out
- `node test/maxout.ts plan` then `build <budget>` after every district and every week of game time: all available upgrades and extensions on every service building, within the money floors. New buildings: best available type (policy `quality.bestAvailable`), then max out at once.

## 5. Traffic and transit (what the research adds)
- Fix the worst 3-5 junctions first (`node test/worstedges.ts`); turn lanes and signals on trunk junctions; wider junction spacing on the old-centre Large Roads where it can be done without demolishing homes; roundabouts on collectors with good exits; parking entrances from side streets, not arterials.
- District policies on residential districts: Heavy Traffic Ban, Speed Bumps; sound barriers where a highway passes homes.
- Transit: lines near full get vehicles (check the vehicle slider's direction: the test of 19 Oct decides it); remove lines with no riders; split long lines into overlapping loops; a second subway yard before the first is full.

## 6. Order of work
1. Max out every existing service building (maxout.ts), then keep doing it.
2. Decor pass over the built districts: trees on roads, groves and fountains in parks and plazas, Botanical Garden and Ferris wheel on the waterfront.
3. Skyline core: zone the South Bank and Hawthorne river blocks reshigh / office high / mixed; services and parks to full coverage there; signature buildings as they unlock.
4. Traffic: worst junctions, district policies.
5. Next districts from `CITYPLAN-GRAND.md`, each built to this standard from the start.
