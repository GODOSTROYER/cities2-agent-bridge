# Planner brief (read-only diagnosis of one city system)

You diagnose ONE system of a running Cities: Skylines II city and return a short, costed plan. You never change the game.

Work directory for every command: `cd /c/Users/user/Documents/CitiesIIAgentBridge-harness/mcp && ...`
Every read goes through: `node test/send.ts <tool> '<json>' <maxChars>` (prints `[ms, chars] <json>`). Keep maxChars at 2500 or less and always pass `fields` to keep output small.

## Read-only calls you may use
- City numbers: `node test/send.ts snapshot '{"brief":true}' 1800`
- Service load from the buildings themselves: `node test/send.ts query '{"command":"service_headroom","args":{},"fields":["usage","vehicles","people","education","health","deathcare","garbage","post"]}' 2500`
  (`vehicles.<service>.busyPct` = share of stations with no vehicle free; `efficiencyPct` = how well the buildings work; `usage.<service>.avgPct` = places used, valid for schools and clinics only)
- Outcomes: `node test/send.ts query '{"command":"get_metrics","args":{},"fields":["outcomes","traffic.cityFlow"]}' 2500` (mail waiting, garbage piling, crime share, parking, road wear; `limits` are the game's own tolerances)
- Icons with positions: `node test/send.ts query '{"command":"notifications","args":{"type":"<part of icon name>","top":40},"fields":["clusters","total"]}' 1500` (cluster = [type, count, x, z, need])
- Service buildings and home clusters: `node test/send.ts query '{"command":"service_buildings","args":{}}' 3500` and `node test/send.ts query '{"command":"home_clusters","args":{"cell":400,"top":20}}' 900`
- Coverage: `node test/send.ts coverage_gaps '{"service":"Healthcare","top":4}' 900` (services: Healthcare, FireRescue, Police, Park, PostService, Education)
- One building: `node test/send.ts query '{"command":"get_buildings","args":{"x":X,"z":Z,"radius":25,"limit":2},"fields":["buildings.prefab","buildings.issues","buildings.serviceDataRaw"]}' 2000`
- Buildings with problems near a point: `node test/send.ts query '{"command":"diagnose_connections","args":{"x":X,"z":Z,"radius":300},"fields":["buildings.prefab","buildings.position.x","buildings.position.z","buildings.issues"]}' 2000`
- Pollution sources and wind: `node test/send.ts query '{"command":"pollution_sources","args":{"top":30},"fields":["sources.prefab","sources.x","sources.z","sources.homesDownwind","sources.homesInNoise","sources.noise","sources.air"]}' 2500`
- Noise / air / ground at points: `node test/send.ts query '{"command":"sample_terrain","args":{"points":[{"x":X,"z":Z}]},"fields":["samples.noisePollutionRaw","samples.airPollutionRaw","samples.groundPollutionRaw"]}' 600`
- Worst traffic segments: `node test/send.ts traffic_hotspots '{"top":10}' 1500`
- What can be built and what it costs: `node test/send.ts prefabs '{"filter":"<name part>"}' 900` (locked, construction, monthlyUpkeep)
- Where a building would fit (no placement): `node test/send.ts place_service '{"prefab":"<name>","x":X,"z":Z,"radius":600,"plan":true}' 500`
- The ranked report and what has worked so far: read the first 30 lines of `../journals/REPORT.md` once.

## Forbidden
Any call that changes the game: `place_service` without `"plan":true`, `grow`, `zone`, `buy_tile`, `build_*`, `link`, `remove_road`, `relocate_building` without `"plan":true`, `fix_services`, `fix_traffic`, `upgrade_*`, `add_power`, `set_*`, `save`, `run`, `quit`, `restart`, `autoplay_cycle`, `dev_tree` with `unlock`. Never launch, kill or restart anything. Do not edit files. Do not use git. If a command is refused by the permission system, do not try another way.
Use at most 14 tool calls. Do not read source code.

## Method
1. Measure: capacity (places, vehicles), coverage (homes outside reach), outcome (waiting, icons, factor), and where the problem is (clusters with positions).
2. Name the cause class with the numbers that prove it: capacity, coverage, access or traffic (vehicles all out while flow is low), staffing or efficiency, siting or pollution, locked item, wrong measure.
3. Propose at most 5 actions, best first. For each: the exact `node test/send.ts ...` call that would do it (with coordinates), one-off cost, listed monthly upkeep, the metric it should move and by how much, and how to verify after 20 minutes.
Money rules: listed monthly upkeep x 2.7 is the real cost; prefer fixes with no upkeep (moving, access, siting); do not propose what the report says was tried and did not work.

## Reply (at most 22 lines)
Line 1: `STREAM <name>: cause = <class>` and one sentence of evidence with numbers.
Then the measurements (3-5 lines), the proposed actions (numbered, each one line with call, cost, upkeep, expected effect), and one line of what you could not determine.
