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
    [switch]$NoConnector, [switch]$NoZoning, [switch]$PlanOnly
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
if ($roads.Count -gt 61) { throw "Grid needs $($roads.Count) roads plus a connector; the neighbourhood limit is 62. Use fewer blocks." }
function New-Plan($roadList) { Invoke-Bridge plan_neighborhood @{ maxTotalCost = $MaxTotalCost; reserve = $Reserve; roads = $roadList } }
function Show-Plan($plan, $count) {
    "Plan $($plan.id): status=$($plan.status) roads=$count spendingUpperBound=$($plan.spendingUpperBound)"
    if ($plan.errors) { $plan.errors | ConvertTo-Json -Depth 6 -Compress }
    if ($plan.warnings) { "warnings: " + ($plan.warnings | ConvertTo-Json -Depth 4 -Compress) }
}
$best = $null
if ($NoConnector) { $plan = New-Plan $roads; Show-Plan $plan $roads.Count }
else {
    # Candidate (existing node, grid corner) pairs by distance. Planning is read-only, so
    # each candidate is validated until one passes; a connector that cuts through a lot
    # is rejected by the plan's overlap check instead of by the game mid-build.
    # Targets: grid corners, plus each node's perpendicular projection onto the grid
    # perimeter (a straight extension of a dead end usually avoids built lots).
    $candidates = foreach ($n in $graph.Positions.Keys) {
        $q = $graph.Positions[$n]
        $targets = @($corners) + ,@([Math]::Min([Math]::Max($q.x, $X), $x1), [Math]::Min([Math]::Max($q.z, $Z), $z1))
        foreach ($c in $targets) {
            $d = [Math]::Sqrt([Math]::Pow($q.x - $c[0], 2) + [Math]::Pow($q.z - $c[1], 2))
            if ($d -le $MaxConnectorLength) { [pscustomobject]@{ node = $n; p = $q; c = $c; d = $d } } } }
    $candidates = @($candidates | Sort-Object d | Select-Object -First 8)
    if (!$candidates) { throw "No existing road node within $MaxConnectorLength m of a grid corner; move the grid or raise -MaxConnectorLength." }
    $gridPlan = New-Plan $roads
    if ($gridPlan.status -ne 'ready') { Show-Plan $gridPlan $roads.Count; 'Failed: grid itself is blocked (before adding a connector). Nothing was changed.'; return }
    foreach ($cand in $candidates) {
        $withConnector = $roads
        if ($cand.d -ge 8) { $withConnector = $roads + @{ prefabIndex = $road; prefabVersion = $RoadPrefabVersion; start = @{ x = [double]$cand.p.x; z = [double]$cand.p.z }; end = @{ x = [double]$cand.c[0]; z = [double]$cand.c[1] }; maxCost = $MaxCostPerRoad } }
        $plan = New-Plan $withConnector
        "Connector candidate: node $($cand.node) -> corner ($($cand.c -join ',')) {0:N0} m: $($plan.status)" -f $cand.d
        if ($plan.status -eq 'ready') { $best = $cand; $roads = $withConnector; break }
    }
    if (!$best) { Show-Plan $plan $withConnector.Count | Select-Object -First 1; 'Failed: no connector candidate validated. Nothing was changed.'; return }
    Show-Plan $plan $roads.Count
}
if ($plan.status -ne 'ready') { 'Failed: plan is blocked. Nothing was changed.'; return }
if ($PlanOnly) { 'PlanOnly: nothing changed.'; return }

$exec = Invoke-Bridge execute_neighborhood @{ id = $plan.id }
if (!$exec.batch) { throw "Execution was not started (plan status $($exec.status)); re-plan." }
$batch = Wait-BridgeBatch $exec.batch.id
"Batch $($batch.id): status=$($batch.status) completed=$($batch.completed)/$($batch.steps) spent=$($batch.moneySpent)"
if ($batch.status -ne 'complete') {
    "Failed at step $($batch.failedStep): $($batch.error) / " + (($batch.results | Select-Object -Last 1) | ConvertTo-Json -Depth 6 -Compress)
    throw 'Grid build stopped. Earlier steps remain applied; inspect before retrying.'
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
