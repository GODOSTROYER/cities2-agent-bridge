#requires -Version 7.0
# Builds a connected road grid and zones it, in one validated step:
#  1. Generates grid roads (world-aligned) plus a connector from the nearest existing road
#     node, because plan_neighborhood's own `grid` roads do not attach to the network and
#     its zones are camera-oriented.
#  2. Validates with plan_neighborhood (spending bounds, cash/reserve), then
#     execute_neighborhood (saves before and after automatically).
#  3. Zones the new blocks with zone-fill.ps1 (block-attached, Blocked cells skipped).
#  4. Verifies the grid is connected to the existing network by graph search.
# -PlanOnly validates without changing the city.
param(
    [Parameter(Mandatory)][double]$X, [Parameter(Mandatory)][double]$Z,
    [ValidateRange(1,6)][int]$Columns = 2, [ValidateRange(1,6)][int]$Rows = 2,
    [ValidateRange(64,200)][double]$BlockWidth = 110, [ValidateRange(64,200)][double]$BlockDepth = 110,
    [int]$RoadPrefabIndex = -1, [int]$RoadPrefabVersion = 1,
    [int]$ZonePrefabIndex = -1, [int]$ZonePrefabVersion = 1,
    [long]$MaxCostPerRoad = 8000, [long]$MaxTotalCost = 200000, [long]$Reserve = 100000,
    [ValidateRange(0,2000)][double]$MaxConnectorLength = 400,
    [ValidateRange(0,60)][double]$Clearance = 20,
    [switch]$NoConnector, [switch]$NoZoning, [switch]$NoStubs, [switch]$AllowDemolition, [switch]$SkipNativePreview, [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
function Resolve-Prefab($index, $name, $kind) {
    if ($index -ge 0) { return $index }
    (Resolve-BridgePrefab -Name $name -Kind $kind).index
}
$road = Resolve-Prefab $RoadPrefabIndex 'Small Road' 'network'
$zone = if ($NoZoning) { $null } else { Resolve-Prefab $ZonePrefabIndex 'NA Residential Low' 'zone' }

$x1 = $X + $Columns * $BlockWidth; $z1 = $Z + $Rows * $BlockDepth
$roads = @()
function Add-Road($ax, $az, $bx, $bz) {
    $script:roads += @{ prefabIndex = $road; prefabVersion = $RoadPrefabVersion; start = @{ x = [double]$ax; z = [double]$az }; end = @{ x = [double]$bx; z = [double]$bz }; maxCost = $MaxCostPerRoad }
}
# One segment per block side keeps every road within network_length_must_be_8_to_1000.
for ($i = 0; $i -le $Columns; $i++) { for ($j = 0; $j -lt $Rows; $j++) { $gx = $X + $i * $BlockWidth; Add-Road $gx ($Z + $j * $BlockDepth) $gx ($Z + ($j + 1) * $BlockDepth) } }
for ($j = 0; $j -le $Rows; $j++) { for ($i = 0; $i -lt $Columns; $i++) { $gz = $Z + $j * $BlockDepth; Add-Road ($X + $i * $BlockWidth) $gz ($X + ($i + 1) * $BlockWidth) $gz } }

$graph = Get-BridgeRoadGraph -X (($X + $x1) / 2) -Z (($Z + $z1) / 2)
$corners = @(@($X, $Z), @($x1, $Z), @($X, $z1), @($x1, $z1))
# A grid placed against existing streets shares edges with them: drop generated roads
# whose start, middle and end all lie on existing roads. The remaining roads end on the
# shared street, native snapping joins them, and no connector through built lots is needed.
function Get-SegmentDistance($px, $pz, $a, $b) {
    $dx = $b.x - $a.x; $dz = $b.z - $a.z; $len2 = $dx * $dx + $dz * $dz
    $t = if ($len2 -gt 0) { [Math]::Max(0, [Math]::Min(1, (($px - $a.x) * $dx + ($pz - $a.z) * $dz) / $len2)) } else { 0 }
    [Math]::Sqrt([Math]::Pow($px - ($a.x + $t * $dx), 2) + [Math]::Pow($pz - ($a.z + $t * $dz), 2))
}
function Test-OnExistingRoad($px, $pz) { foreach ($e in $graph.Edges) { if ((Get-SegmentDistance $px $pz $e.curve[0] $e.curve[-1]) -le 8) { return $true } }; $false }
$generated = $roads.Count
$roads = @($roads | Where-Object { $r = $_
    -not ((Test-OnExistingRoad $r.start.x $r.start.z) -and (Test-OnExistingRoad $r.end.x $r.end.z) -and (Test-OnExistingRoad (($r.start.x + $r.end.x) / 2) (($r.start.z + $r.end.z) / 2))) })
if ($roads.Count -lt $generated) {
    "Shared edges: $($generated - $roads.Count) road(s) already exist; grid joins them directly."
    $NoConnector = $true
}
# Expansion stubs: one 64 m dead end pointing outward from the middle of each side, built
# before zoning so they stay clear and future grids can attach to open ends.
$stubRoads = @()
if (!$NoStubs) {
    $mx = $X + [Math]::Floor($Columns / 2) * $BlockWidth; $mz = $Z + [Math]::Floor($Rows / 2) * $BlockDepth
    foreach ($s in @(@($X, $mz, ($X - 64), $mz), @($x1, $mz, ($x1 + 64), $mz), @($mx, $Z, $mx, ($Z - 64)), @($mx, $z1, $mx, ($z1 + 64)))) {
        $stubRoads += @{ prefabIndex = $road; prefabVersion = $RoadPrefabVersion; start = @{ x = [double]$s[0]; z = [double]$s[1] }; end = @{ x = [double]$s[2]; z = [double]$s[3] }; maxCost = $MaxCostPerRoad } }
}if ($roads.Count -gt 61) { throw "Grid needs $($roads.Count) roads plus a connector; the neighbourhood limit is 62. Use fewer blocks." }
function New-Plan($roadList) { Invoke-Bridge plan_neighborhood @{ maxTotalCost = $MaxTotalCost; reserve = $Reserve; roads = $roadList } }
function Show-Plan($plan, $count) {
    "Plan $($plan.id): status=$($plan.status) roads=$count spendingUpperBound=$($plan.spendingUpperBound)"
    if ($plan.errors) { $plan.errors | ConvertTo-Json -Depth 6 -Compress }
    if ($plan.warnings) { "warnings: " + ($plan.warnings | ConvertTo-Json -Depth 4 -Compress) }
}
$best = $null
if ($NoConnector) { $coreCount = $roads.Count; $plan = New-Plan $roads; Show-Plan $plan $roads.Count }
else {
    # Candidate (existing node, grid corner) pairs by distance. Planning is read-only, so
    # each candidate is validated until one passes; a connector that cuts through a lot
    # is rejected by the plan's overlap check instead of by the game mid-build.
    # Starts: every road node plus points along road edges (attached mid-edge).
    # Targets: grid corners and points every half block around the grid perimeter.
    # A cheap local filter drops links passing within $Clearance m of a building centre
    # (lots are ~24 m deep), then the read-only plan validates the shortest survivors.
    $starts = @(foreach ($n in $graph.Positions.Keys) { [pscustomobject]@{ node = $n; p = $graph.Positions[$n] } }) +
        @(foreach ($e in $graph.Edges) { foreach ($t in 0.1, 0.3, 0.5, 0.7, 0.9) {
            $a = $e.curve[0]; $b = $e.curve[-1]
            [pscustomobject]@{ node = "edge $($e.index)@$t"; p = [pscustomobject]@{ x = $a.x + ($b.x - $a.x) * $t; z = $a.z + ($b.z - $a.z) * $t }; edge = $e; t = $t } } })
    $targets = [Collections.Generic.List[object]]::new()
    for ($gx = $X; $gx -le $x1 + 0.1; $gx += $BlockWidth / 2) { $targets.Add(@($gx, $Z)); $targets.Add(@($gx, $z1)) }
    for ($gz = $Z + $BlockDepth / 2; $gz -lt $z1 - 0.1; $gz += $BlockDepth / 2) { $targets.Add(@($X, $gz)); $targets.Add(@($x1, $gz)) }
    # Real lot rectangles from get_city_map, rasterised (lib Get-BridgeOccupancy).
    $occ = Get-BridgeOccupancy -MinX ($X - $MaxConnectorLength) -MinZ ($Z - $MaxConnectorLength) -MaxX ($x1 + $MaxConnectorLength) -MaxZ ($z1 + $MaxConnectorLength)
    $candidates = foreach ($st in $starts) { foreach ($tg in $targets) {
        $d = [Math]::Sqrt([Math]::Pow($st.p.x - $tg[0], 2) + [Math]::Pow($st.p.z - $tg[1], 2))
        if ($d -lt 8 -or $d -gt $MaxConnectorLength) { continue }
        [pscustomobject]@{ node = $st.node; p = $st.p; c = $tg; d = $d; edge = $st.edge; t = $st.t; clear = (Test-OccupancySegmentFree $occ $st.p ([pscustomobject]@{ x = $tg[0]; z = $tg[1] }) 6) } } }
    $all = @($candidates)
    $candidates = @($all | Where-Object clear)
    # With -AllowDemolition and no clear link, validate the shortest blocked links so the
    # single-house demolition path below has something to work with.
    if (!$candidates -and $AllowDemolition) { $candidates = @($all | Sort-Object d | Select-Object -First 12) }    $candidates = @($candidates | Sort-Object d | Select-Object -First 12)
    "Connector search: $($starts.Count) starts x $($targets.Count) targets, $($occ.Buildings) lots rasterised; $($candidates.Count) clear links to validate"
    if (!$candidates) { "Failed: no clear link from existing roads within $MaxConnectorLength m (lots block every route). Nothing was changed." + $(if (!$AllowDemolition) { ' (-AllowDemolition can open a street through one house)' } else { '' }); return }
    $coreCount = $roads.Count   # grid streets; stubs and the connector are appended after these
    $gridPlan = if ($stubRoads) { New-Plan ($roads + $stubRoads) }
    if ($stubRoads -and $gridPlan.status -eq 'ready') { $roads = $roads + $stubRoads }
    else { if ($stubRoads) { "Stubs dropped (blocked); planning grid without them." }; $gridPlan = New-Plan $roads }
    if ($gridPlan.status -ne 'ready') { Show-Plan $gridPlan $roads.Count; 'Failed: grid itself is blocked (before adding a connector). Nothing was changed.'; return }
    $tried = @()
    foreach ($cand in $candidates) {
        $withConnector = $roads
        $startPoint = @{ x = [double]$cand.p.x; z = [double]$cand.p.z }
        if ($cand.edge) { $startPoint.index = [int]$cand.edge.index; $startPoint.version = [int]$cand.edge.version; $startPoint.curvePosition = [double]$cand.t }
        if ($cand.d -ge 8) { $withConnector = $roads + @{ prefabIndex = $road; prefabVersion = $RoadPrefabVersion; start = $startPoint; end = @{ x = [double]$cand.c[0]; z = [double]$cand.c[1] }; maxCost = $MaxCostPerRoad } }
        $plan = New-Plan $withConnector
        $why = if ($plan.status -ne 'ready') { ' [' + ((@($plan.errors) | Select-Object -First 2 | ForEach-Object { "step $($_.step) $($_.reason)" + $(if ($_.building) { " $($_.building.prefab)@$([int]$_.building.position.x),$([int]$_.building.position.z)" } elseif ($_.message) { " $($_.message)" } else { '' }) }) -join '; ') + ']' } else { '' }
        "Connector candidate: $($cand.node) -> ($($cand.c -join ',')) {0:N0} m: $($plan.status)$why" -f $cand.d
        if ($plan.status -eq 'ready') { $best = $cand; $roads = $withConnector; break }
        $tried += [pscustomobject]@{ cand = $cand; roads = $withConnector; plan = $plan }
    }
    if (!$best -and $AllowDemolition -and !$PlanOnly) {
        # Opt-in: open a street by removing exactly one ordinary growable building that is
        # the only obstacle on the shortest link, then re-plan that link.
        foreach ($cand in $tried) {
            $blockers = @($cand.plan.errors | Where-Object { $_.reason -ne 'existing_building_overlap' })
            $houses = @($cand.plan.errors | Where-Object { $_.reason -eq 'existing_building_overlap' } | ForEach-Object { $_.building } | Sort-Object index -Unique)
            if ($blockers -or $houses.Count -ne 1 -or $houses[0].prefab -notmatch '^(NA_|EU_)?(Residential|Commercial|Industrial|Office)') { continue }
            $h1 = $houses[0]
            $op = Invoke-Bridge demolish @{ index = [int]$h1.index; version = [int]$h1.version }
            $done = if ($op.id) { Wait-BridgeOperation $op.id } else { $op }
            "Demolished $($h1.prefab) at $([int]$h1.position.x),$([int]$h1.position.z) to open a street: $($done.status)"
            if ($done.status -ne 'complete') { continue }
            $plan = New-Plan $cand.roads
            if ($plan.status -eq 'ready') { $best = $cand.cand; $roads = $cand.roads; Show-Plan $plan $roads.Count; break }
        }
    }
    if (!$best) { Show-Plan $plan $withConnector.Count | Select-Object -First 1; 'Failed: no connector candidate validated. Nothing was changed.' + $(if (!$AllowDemolition) { ' (-AllowDemolition can open a street through one house)' } else { '' }); return }
    Show-Plan $plan $roads.Count
}
if ($plan.status -ne 'ready') { 'Failed: plan is blocked. Nothing was changed.'; return }
# Native pre-flight: plan_neighborhood is geometric only; the game also rejects steep
# slopes, water, map limits and tight geometry. When the mod supports road previews, run
# every road through the game's own validator before anything is built. (An older mod
# would apply a "preview", so this is gated on the advertised capability.)
# Screening callers (grow) pass -SkipNativePreview: native checks cost ~1-2 s per road, so
# they run once on the chosen site, not on every candidate.
if (!$SkipNativePreview -and (Invoke-Bridge get_capabilities).roadPreview) {
    $i = 0; $dropped = @()
    foreach ($r in $roads) {
        $pv = Invoke-Bridge build_road ($r + @{ previewOnly = $true })
        $res = Wait-BridgeOperation $pv.id
        if ($res.status -ne 'complete') {
            $why = @($res.placementErrors | ForEach-Object { $_.reasons } | Select-Object -Unique) -join ','
            $isStub = $i -ge $coreCount -and @($stubRoads | Where-Object { $_ -eq $r }).Count -gt 0
            if ($isStub) { "Stub dropped ($([int]$r.end.x),$([int]$r.end.z)): $why"; $dropped += , $r; $i++; continue }
            "Failed: native preview rejected road $i ($([int]$r.start.x),$([int]$r.start.z) -> $([int]$r.end.x),$([int]$r.end.z)): $($res.error) [$why]. Nothing was changed."; return
        }
        $i++
    }
    if ($dropped) {
        # Stubs are optional; re-plan without the rejected ones so the batch matches.
        $roads = @($roads | Where-Object { $rr = $_; -not @($dropped | Where-Object { $_ -eq $rr }).Count })
        $plan = New-Plan $roads
        if ($plan.status -ne 'ready') { 'Failed: re-plan without rejected stubs is blocked. Nothing was changed.'; return }
    }
    "Native preview: $($roads.Count) roads accepted by the game" + $(if ($dropped) { " ($($dropped.Count) stub(s) dropped)" } else { '' }) + '.'
}
if ($PlanOnly) { 'PlanOnly: nothing changed.'; return }

$exec = Invoke-Bridge execute_neighborhood @{ id = $plan.id }
if (!$exec.batch) { throw "Execution was not started (plan status $($exec.status)); re-plan." }
$batch = Wait-BridgeBatch $exec.batch.id
"Batch $($batch.id): status=$($batch.status) completed=$($batch.completed)/$($batch.steps) spent=$($batch.moneySpent)"
if ($batch.status -ne 'complete') {
    # Step 0 is the automatic save, so road index = failedStep - 1.
    $roadIndex = [int]$batch.failedStep - 1
    $last = $batch.results | Select-Object -Last 1
    $why = @($last.placementErrors | ForEach-Object { $_.reasons } | Select-Object -Unique) -join ','
    "Failed at road ${roadIndex}: $($last.error) [$why]"
    if ($roadIndex -lt $coreCount) { throw 'Grid streets incomplete. Earlier steps remain applied; inspect before retrying.' }
    # Only a stub or the connector failed (roads interact once earlier ones exist, so an
    # individual preview can pass and the built sequence still fail). Keep the grid,
    # build the remaining optional roads one by one (each game-checked), and if the
    # connector was lost, try the other validated connector candidates.
    "Grid streets built; continuing with optional roads."
    $connectorLost = !$NoConnector -and $best -and $best.d -ge 8
    for ($k = $roadIndex + 1; $k -lt $roads.Count; $k++) {
        $isConnector = $connectorLost -and $k -eq $roads.Count - 1
        $pv = Wait-BridgeOperation (Invoke-Bridge build_road ($roads[$k] + @{ previewOnly = $true })).id
        if ($pv.status -ne 'complete') { "  skipped road ${k}: $($pv.error)"; continue }
        $r = Wait-BridgeOperation (Invoke-Bridge build_road $roads[$k]).id
        "  road ${k}: $($r.status)"; if ($isConnector -and $r.status -eq 'complete') { $connectorLost = $false }
    }
    if ($connectorLost -and $roadIndex -eq $roads.Count - 1) {
        foreach ($cand in @($candidates | Where-Object { $_ -ne $best -and $_.d -ge 8 } | Sort-Object d | Select-Object -First 10)) {
            $sp = @{ x = [double]$cand.p.x; z = [double]$cand.p.z }
            if ($cand.edge) { $sp.index = [int]$cand.edge.index; $sp.version = [int]$cand.edge.version; $sp.curvePosition = [double]$cand.t }
            $link = @{ prefabIndex = $road; prefabVersion = $RoadPrefabVersion; start = $sp; end = @{ x = [double]$cand.c[0]; z = [double]$cand.c[1] }; maxCost = $MaxCostPerRoad }
            $pv = Wait-BridgeOperation (Invoke-Bridge build_road ($link + @{ previewOnly = $true })).id
            if ($pv.status -ne 'complete') { continue }
            $r = Wait-BridgeOperation (Invoke-Bridge build_road $link).id
            if ($r.status -eq 'complete') { "Connector rebuilt from $($cand.node) ($([int]$cand.d) m)"; $best = $cand; $connectorLost = $false; break }
        }
        if ($connectorLost) { 'Failed: grid built but NOT connected; use play.ps1 link -X <corner x> -Z <corner z> -Road ''Small Road''' }
    }
}

if ($zone) {
    $radius = [Math]::Min(500, [Math]::Sqrt([Math]::Pow($x1 - $X, 2) + [Math]::Pow($z1 - $Z, 2)) / 2 + 40)
    & (Join-Path $PSScriptRoot 'zone-fill.ps1') -X (($X + $x1) / 2) -Z (($Z + $z1) / 2) -Radius $radius -ZonePrefabIndex $zone -ZonePrefabVersion $ZonePrefabVersion
}
if (!$NoConnector) {
    $after = Get-BridgeRoadGraph -X (($X + $x1) / 2) -Z (($Z + $z1) / 2)
    $gridNode = Find-BridgeNearestNode $after $x1 $z1
    $oldNode = Find-BridgeNearestNode $after $best.p.x $best.p.z
    "Grid connected to existing network: " + (Test-BridgeNodesConnected $after $gridNode $oldNode)
}
