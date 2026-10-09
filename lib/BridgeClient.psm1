#requires -Version 7.0
# Shared helpers on top of bridge.ps1. Import with:
#   Import-Module (Join-Path <harness> 'lib\BridgeClient.psm1') -Force
# Every helper returns parsed objects and throws on ok:false so callers never mistake an
# error response for data. Mutations are never resent after a timeout or uncertain result.
$script:Client = Join-Path (Split-Path $PSScriptRoot) 'bridge.ps1'
$script:MaxRequestBytes = 15000   # mod limit is 16384 for the whole packet; leave envelope room
# Errors that prove a step changed nothing, so the rest of a batch may continue safely.
$script:BenignStepErrors = @('no_zone_cells_in_rectangle')
$script:PendingStatuses = @('queued','validating','applying','running')

function Invoke-Bridge {
    param([Parameter(Mandatory)][string]$Command, $Arguments = @{}, [int]$TimeoutSeconds = 30, [switch]$AllowError)
    $json = if ($Arguments -is [string]) { $Arguments } else { $Arguments | ConvertTo-Json -Depth 12 -Compress }
    $raw = & $script:Client $Command -ArgsJson $json -TimeoutSeconds $TimeoutSeconds
    $response = $raw | ConvertFrom-Json
    if (!$response.ok -and !$AllowError) { throw "bridge $Command failed: $($response.error)" }
    if ($AllowError) { return $response }
    $response.result
}

# The paginated commands name their array differently (prefabs/buildings/cells/edges/...).
function Get-ResultArrayName($result) {
    ($result.PSObject.Properties | Where-Object { $_.Value -is [array] } | Select-Object -First 1).Name
}

# Follows nextOffset until null and returns the concatenated items. Pagination is only
# consistent while paused; the city session is checked on every page.
function Get-BridgePaged {
    param([Parameter(Mandatory)][string]$Command, [hashtable]$Arguments = @{})
    $offset = 0; $session = $null; $items = [Collections.Generic.List[object]]::new()
    do {
        $page = Invoke-Bridge $Command ($Arguments + @{ offset = $offset })
        if ($session -and $page.citySession -and $page.citySession -ne $session) { throw 'City session changed during pagination; discard and retry.' }
        $session = $page.citySession
        $name = Get-ResultArrayName $page
        if ($name) { $items.AddRange([object[]]$page.$name) }
        $offset = $page.nextOffset
    } while ($null -ne $offset -and "$offset" -ne '')
    # Emit items individually; wrap calls in @() to always get an array (count works).
    $items.ToArray()
}

function Wait-BridgeOperation {
    param([Parameter(Mandatory)][string]$Id, [int]$TimeoutSeconds = 120)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $op = Invoke-Bridge get_operation @{ id = $Id }
        if ($op.status -notin $script:PendingStatuses) { return $op }
        Start-Sleep -Milliseconds 400
    }
    throw "Operation $Id still pending after ${TimeoutSeconds}s; inspect before retrying."
}

function Wait-BridgeBatch {
    param([Parameter(Mandatory)][string]$Id, [int]$TimeoutSeconds = 620)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $batch = Invoke-Bridge get_batch @{ id = $Id }
        if ($batch.status -notin $script:PendingStatuses) { return $batch }
        Start-Sleep -Seconds 2
    }
    throw "Batch $Id still running after ${TimeoutSeconds}s; inspect before retrying."
}

# Splits steps into batches that fit the request limit (max 64 steps each). When a step
# fails with a benign no-op error, the batch is resumed after that step; any other
# failure stops everything and is returned for inspection.
function Invoke-BridgeSteps {
    param([Parameter(Mandatory)][object[]]$Steps, [long]$Reserve = 0, [switch]$StopOnBenign)
    $results = [Collections.Generic.List[object]]::new(); $spent = 0; $i = 0
    while ($i -lt $Steps.Count) {
        $chunk = [Collections.Generic.List[object]]::new()
        while ($i + $chunk.Count -lt $Steps.Count -and $chunk.Count -lt 64) {
            $candidate = @($chunk) + @($Steps[$i + $chunk.Count])
            $size = [Text.Encoding]::UTF8.GetByteCount((@{ steps = $candidate; reserve = $Reserve } | ConvertTo-Json -Depth 12 -Compress))
            if ($size -gt $script:MaxRequestBytes -and $chunk.Count) { break }
            $chunk.Add($Steps[$i + $chunk.Count])
        }
        $batch = Wait-BridgeBatch (Invoke-Bridge batch_execute @{ steps = $chunk.ToArray(); reserve = $Reserve }).id
        $spent += [long]$batch.moneySpent
        $done = @($batch.results)
        for ($k = 0; $k -lt $done.Count; $k++) { $results.Add([pscustomobject]@{ step = $i + $k; result = $done[$k] }) }
        if ($batch.status -eq 'complete') { $i += $chunk.Count; continue }
        $failed = $done | Select-Object -Last 1
        $failIndex = $i + [int]$batch.failedStep
        if (!$StopOnBenign -and $failed -and $failed.error -in $script:BenignStepErrors) { $i = $failIndex + 1; continue }
        return [pscustomobject]@{ status = 'failed'; failedStep = $failIndex; error = $batch.error; stepError = $failed.error; results = $results.ToArray(); moneySpent = $spent }
    }
    [pscustomobject]@{ status = 'complete'; results = $results.ToArray(); moneySpent = $spent }
}

# Builds one road with native snapping. On game_rejected_placement it inspects the
# blocking entity and, if allowed, tries the same road shifted perpendicular by each offset.
function Invoke-BridgeRoad {
    param([Parameter(Mandatory)][int]$PrefabIndex, [int]$PrefabVersion = 1,
        [Parameter(Mandatory)][hashtable]$Start, [Parameter(Mandatory)][hashtable]$End,
        [long]$MaxCost = 30000, [double[]]$RetryOffsets = @())
    $attempts = @(0.0) + $RetryOffsets
    $dx = [double]$End.x - [double]$Start.x; $dz = [double]$End.z - [double]$Start.z
    $len = [Math]::Sqrt($dx * $dx + $dz * $dz); $nx = - $dz / $len; $nz = $dx / $len
    $log = @()
    foreach ($o in $attempts) {
        $s = @{} + $Start; $e = @{} + $End
        if ($o -ne 0) {
            # A shifted endpoint can no longer attach to the original edge position.
            $s.Remove('index'); $s.Remove('version'); $s.Remove('curvePosition')
            $s.x = [double]$Start.x + $nx * $o; $s.z = [double]$Start.z + $nz * $o
            $e.x = [double]$End.x + $nx * $o; $e.z = [double]$End.z + $nz * $o
        }
        $op = Wait-BridgeOperation (Invoke-Bridge build_road @{ prefabIndex = $PrefabIndex; prefabVersion = $PrefabVersion; start = $s; end = $e; maxCost = $MaxCost }).id
        if ($op.status -eq 'complete') { return [pscustomobject]@{ status = 'complete'; offset = $o; operation = $op; attempts = $log } }
        $blockers = @($op.placementErrors | Where-Object { $_.prefab.index -ne $PrefabIndex } | ForEach-Object {
            try { (Invoke-Bridge inspect_entity @{ index = $_.index; version = $_.version }).prefab } catch { "entity $($_.index)" } })
        $log += [pscustomobject]@{ offset = $o; error = $op.error; blockers = $blockers }
        if ($op.error -ne 'game_rejected_placement') { break }   # spending or other errors: don't shift
    }
    [pscustomobject]@{ status = 'failed'; attempts = $log }
}

# Road graph from get_network_edges (radius <= 2000). trace_network needs live node IDs,
# and edges are renumbered when roads attach to them, so a local search is more robust.
function Get-BridgeRoadGraph {
    param([double]$X, [double]$Z, [double]$Radius = 2000, [string]$PrefabPattern = '^(?!Highway).*Road')
    $edges = (Invoke-Bridge get_network_edges @{ x = $X; z = $Z; radius = [Math]::Min(2000, $Radius) }).edges |
        Where-Object { $_.prefab -match $PrefabPattern }
    $adj = @{}; $pos = @{}
    foreach ($e in $edges) {
        $a = "$($e.startNode.index)"; $b = "$($e.endNode.index)"
        $adj[$a] += @($b); $adj[$b] += @($a); $pos[$a] = $e.curve[0]; $pos[$b] = $e.curve[-1]
    }
    [pscustomobject]@{ Edges = @($edges); Adjacency = $adj; Positions = $pos }
}
function Find-BridgeNearestNode {
    param([Parameter(Mandatory)]$Graph, [double]$X, [double]$Z, [string[]]$Exclude = @())
    $Graph.Positions.Keys | Where-Object { $_ -notin $Exclude } |
        Sort-Object { [Math]::Pow($Graph.Positions[$_].x - $X, 2) + [Math]::Pow($Graph.Positions[$_].z - $Z, 2) } |
        Select-Object -First 1
}
function Test-BridgeNodesConnected {
    param([Parameter(Mandatory)]$Graph, [Parameter(Mandatory)][string]$From, [Parameter(Mandatory)][string]$To)
    $seen = @{ $From = $true }; $queue = [Collections.Queue]::new(); $queue.Enqueue($From)
    while ($queue.Count) { foreach ($m in $Graph.Adjacency[$queue.Dequeue()]) { if (!$seen[$m]) { $seen[$m] = $true; $queue.Enqueue($m) } } }
    [bool]$seen[$To]
}

# Keys that dominate response size but rarely matter for decisions. Lean output drops them.
$script:NoisyKeys = @('components','rotationQuaternion','serviceDataRaw','serviceCoverageNative','trafficDistanceRaw',
    'trafficDurationRaw','normal','polygon','curve','citySession','session','dateMeaning','protocol')
function ConvertTo-BridgeLean {
    param([Parameter(ValueFromPipeline)]$InputObject, [string[]]$Keep = @())
    process {
        $v = $InputObject
        if ($null -eq $v -or $v -is [string] -or $v -is [ValueType]) {
            if ($v -is [double] -or $v -is [single]) { return [Math]::Round($v, 1) }   # metres/ratios: 0.1 is plenty
            return $v
        }
        if ($v -is [Collections.IEnumerable] -and $v -isnot [Collections.IDictionary]) { return , @($v | ForEach-Object { ConvertTo-BridgeLean $_ -Keep $Keep }) }
        $o = [ordered]@{}
        foreach ($p in $v.PSObject.Properties) {
            if ($p.Name -in $script:NoisyKeys -and $p.Name -notin $Keep) { continue }
            $o[$p.Name] = ConvertTo-BridgeLean $p.Value -Keep $Keep
        }
        [pscustomobject]$o
    }
}

# Prefab name -> {index,version}, cached per city session (prefab indexes are only
# stable within a session). Avoids re-paging thousands of prefabs on every build.
$script:CachePath = Join-Path (Split-Path $PSScriptRoot) 'journals\prefab-cache.json'
function Resolve-BridgePrefab {
    param([Parameter(Mandatory)][string]$Name, [string]$Kind = 'all')
    $session = (& $script:Client ping | ConvertFrom-Json).citySession
    $cache = @{}
    if (Test-Path $script:CachePath) {
        try { $raw = Get-Content $script:CachePath -Raw | ConvertFrom-Json -AsHashtable; if ($raw.session -eq $session) { $cache = $raw.prefabs } } catch {}
    }
    if (!$cache.ContainsKey($Name)) {
        $hit = @(Get-BridgePaged get_build_prefabs @{ kind = $Kind; filter = $Name; limit = 20000 }) |
            Where-Object { $_.name -eq $Name } | Select-Object -First 1
        if (!$hit) { throw "Prefab '$Name' not found (kind=$Kind)." }
        $cache[$Name] = @{ index = $hit.index; version = $hit.version; locked = $hit.locked; placeable = $hit.bridgePlacementSupported }
        New-Item -ItemType Directory -Force -Path (Split-Path $script:CachePath) | Out-Null
        @{ session = $session; prefabs = $cache } | ConvertTo-Json -Depth 4 -Compress | Set-Content $script:CachePath
    }
    $p = $cache[$Name]
    if ($p.locked) { throw "Prefab '$Name' is locked (needs a milestone)." }
    if (!$p.placeable) { throw "Prefab '$Name' is not placeable through the bridge." }
    [pscustomobject]$p
}

# Occupancy raster from get_city_map: real lot rectangles and road chords drawn onto a
# grid (default 4 m). Site and connector tests use it instead of building centre points,
# which let the harness propose spots that lots actually cover.
function Get-BridgeOccupancy {
    param([double]$MinX, [double]$MinZ, [double]$MaxX, [double]$MaxZ, [double]$Cell = 4, [double]$RoadHalfWidth = 8)
    $w = [int][Math]::Ceiling(($MaxX - $MinX) / $Cell); $hgt = [int][Math]::Ceiling(($MaxZ - $MinZ) / $Cell)
    $grid = New-Object 'byte[,]' $w, $hgt
    $occ = [pscustomobject]@{ MinX = $MinX; MinZ = $MinZ; Cell = $Cell; W = $w; H = $hgt; Grid = $grid; Buildings = 0; Edges = 0 }
    $seen = @{}
    # Tile the area with map queries (radius <= 500 each).
    for ($cx = $MinX + 450; $cx -lt $MaxX + 450; $cx += 900) { for ($cz = $MinZ + 450; $cz -lt $MaxZ + 450; $cz += 900) {
        $m = Invoke-Bridge get_city_map @{ x = [Math]::Min($cx, $MaxX); z = [Math]::Min($cz, $MaxZ); radius = 500 }
        foreach ($b in $m.buildings) {
            if ($seen["b$($b.index)"]) { continue }; $seen["b$($b.index)"] = 1; $occ.Buildings++
            Set-OccupancyPolygon $occ $b.polygon
        }
        foreach ($e in $m.network.edges) {
            if ($seen["e$($e.index)"]) { continue }; $seen["e$($e.index)"] = 1; $occ.Edges++
            for ($k = 0; $k -lt $e.curve.Count - 1; $k++) { Set-OccupancySegment $occ $e.curve[$k] $e.curve[$k + 1] $RoadHalfWidth }
        } } }
    $occ
}
function Set-OccupancyPolygon($occ, $poly) {
    $xs = $poly.x; $zs = $poly.z
    $i0 = [Math]::Max(0, [int][Math]::Floor((($xs | Measure-Object -Minimum).Minimum - $occ.MinX) / $occ.Cell)); $i1 = [Math]::Min($occ.W - 1, [int][Math]::Floor((($xs | Measure-Object -Maximum).Maximum - $occ.MinX) / $occ.Cell))
    $j0 = [Math]::Max(0, [int][Math]::Floor((($zs | Measure-Object -Minimum).Minimum - $occ.MinZ) / $occ.Cell)); $j1 = [Math]::Min($occ.H - 1, [int][Math]::Floor((($zs | Measure-Object -Maximum).Maximum - $occ.MinZ) / $occ.Cell))
    for ($i = $i0; $i -le $i1; $i++) { for ($j = $j0; $j -le $j1; $j++) {
        $px = $occ.MinX + ($i + 0.5) * $occ.Cell; $pz = $occ.MinZ + ($j + 0.5) * $occ.Cell; $in = $false
        $b = $poly.Count - 1
        for ($a = 0; $a -lt $poly.Count; $a++) {
            if ((($poly[$a].z -gt $pz) -ne ($poly[$b].z -gt $pz)) -and ($px -lt ($poly[$b].x - $poly[$a].x) * ($pz - $poly[$a].z) / ($poly[$b].z - $poly[$a].z) + $poly[$a].x)) { $in = !$in }
            $b = $a }
        if ($in) { $occ.Grid[$i, $j] = 1 } } }
}
function Set-OccupancySegment($occ, $a, $b, [double]$halfWidth) {
    $len = [Math]::Sqrt([Math]::Pow($b.x - $a.x, 2) + [Math]::Pow($b.z - $a.z, 2)); $steps = [Math]::Max(1, [int]($len / ($occ.Cell / 2)))
    $r = [int][Math]::Ceiling($halfWidth / $occ.Cell)
    for ($s = 0; $s -le $steps; $s++) {
        $px = $a.x + ($b.x - $a.x) * $s / $steps; $pz = $a.z + ($b.z - $a.z) * $s / $steps
        $ci = [int][Math]::Floor(($px - $occ.MinX) / $occ.Cell); $cj = [int][Math]::Floor(($pz - $occ.MinZ) / $occ.Cell)
        for ($i = $ci - $r; $i -le $ci + $r; $i++) { for ($j = $cj - $r; $j -le $cj + $r; $j++) {
            if ($i -ge 0 -and $j -ge 0 -and $i -lt $occ.W -and $j -lt $occ.H) { $occ.Grid[$i, $j] = [Math]::Max($occ.Grid[$i, $j], 2) } } } }
}
# 0 = free; 1 = building lot; 2 = road. Rect test fails on any occupied cell (margin added).
function Test-OccupancyRectFree($occ, [double]$x0, [double]$z0, [double]$x1, [double]$z1, [double]$margin = 8) {
    $i0 = [int][Math]::Floor(($x0 - $margin - $occ.MinX) / $occ.Cell); $i1 = [int][Math]::Floor(($x1 + $margin - $occ.MinX) / $occ.Cell)
    $j0 = [int][Math]::Floor(($z0 - $margin - $occ.MinZ) / $occ.Cell); $j1 = [int][Math]::Floor(($z1 + $margin - $occ.MinZ) / $occ.Cell)
    if ($i0 -lt 0 -or $j0 -lt 0 -or $i1 -ge $occ.W -or $j1 -ge $occ.H) { return $false }
    for ($i = $i0; $i -le $i1; $i++) { for ($j = $j0; $j -le $j1; $j++) { if ($occ.Grid[$i, $j]) { return $false } } }
    $true
}
# Rotated lot test for building placement: samples the box every half cell; any lot (1)
# or road (2) cell blocks. rotationDeg follows the bridge convention (local +Z = lot front).
function Test-OccupancyBoxFree($occ, [double]$cx, [double]$cz, [double]$halfW, [double]$halfD, [double]$rotationDeg) {
    $r = $rotationDeg * [Math]::PI / 180; $cos = [Math]::Cos($r); $sin = [Math]::Sin($r); $step = $occ.Cell / 2
    for ($u = -$halfW; $u -le $halfW; $u += $step) { for ($v = -$halfD; $v -le $halfD; $v += $step) {
        # Unity Y rotation: x' = x cos + z sin, z' = -x sin + z cos
        $px = $cx + $u * $cos + $v * $sin; $pz = $cz - $u * $sin + $v * $cos
        $i = [int][Math]::Floor(($px - $occ.MinX) / $occ.Cell); $j = [int][Math]::Floor(($pz - $occ.MinZ) / $occ.Cell)
        if ($i -lt 0 -or $j -lt 0 -or $i -ge $occ.W -or $j -ge $occ.H -or $occ.Grid[$i, $j]) { return $false } } }
    $true
}
# Finds a value by property name anywhere in a nested object (prefab rawData layouts vary).
function Find-BridgeValue($obj, [string]$name) {
    if ($null -eq $obj -or $obj -is [string] -or $obj -is [ValueType]) { return $null }
    if ($obj -is [Collections.IEnumerable] -and $obj -isnot [Collections.IDictionary]) { foreach ($x in $obj) { $f = Find-BridgeValue $x $name; if ($null -ne $f) { return $f } }; return $null }
    foreach ($p in $obj.PSObject.Properties) { if ($p.Name -eq $name) { return $p.Value }; $f = Find-BridgeValue $p.Value $name; if ($null -ne $f) { return $f } }
    $null
}

# Connector test: a road strip of +-halfWidth must not touch any building lot. Roads are
# allowed (the link starts on one), so only value 1 blocks.
function Test-OccupancySegmentFree($occ, $a, $b, [double]$halfWidth = 6) {
    $len = [Math]::Sqrt([Math]::Pow($b.x - $a.x, 2) + [Math]::Pow($b.z - $a.z, 2)); $steps = [Math]::Max(1, [int]($len / ($occ.Cell / 2)))
    $r = [int][Math]::Ceiling($halfWidth / $occ.Cell)
    for ($s = 0; $s -le $steps; $s++) {
        $ci = [int][Math]::Floor(($a.x + ($b.x - $a.x) * $s / $steps - $occ.MinX) / $occ.Cell); $cj = [int][Math]::Floor(($a.z + ($b.z - $a.z) * $s / $steps - $occ.MinZ) / $occ.Cell)
        for ($i = $ci - $r; $i -le $ci + $r; $i++) { for ($j = $cj - $r; $j -le $cj + $r; $j++) {
            if ($i -ge 0 -and $j -ge 0 -and $i -lt $occ.W -and $j -lt $occ.H -and $occ.Grid[$i, $j] -eq 1) { return $false } } } }
    $true
}

# Rolling-save policy: bridge saves accumulate (each save_checkpoint is a new unique file,
# and execute_neighborhood adds two). Keep the newest N bridge saves; saves labelled
# keep-* and every save not created by the bridge (owner's own cities) are never touched.
# Removed files go to the Recycle Bin, so a mistake is recoverable.
$script:SavesRoot = Join-Path $env:USERPROFILE 'AppData\LocalLow\Colossal Order\Cities Skylines II\Saves'
function Clear-BridgeRollingSaves {
    param([ValidateRange(1, 20)][int]$KeepNewest = 1, [switch]$WhatIf)
    Add-Type -AssemblyName Microsoft.VisualBasic
    $saves = @(Get-ChildItem -LiteralPath $script:SavesRoot -Recurse -File -Filter 'CitiesIIAgentBridge-*.cok' |
        Where-Object { $_.Name -notlike 'CitiesIIAgentBridge-keep-*' } | Sort-Object LastWriteTimeUtc -Descending)
    $removed = @()
    foreach ($save in ($saves | Select-Object -Skip $KeepNewest)) {
        foreach ($file in @($save.FullName, "$($save.FullName).cid")) {
            if (!(Test-Path -LiteralPath $file)) { continue }
            if (!$WhatIf) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file, 'OnlyErrorDialogs', 'SendToRecycleBin') }
        }
        $removed += $save.BaseName
    }
    [pscustomobject]@{ kept = @($saves | Select-Object -First $KeepNewest | ForEach-Object BaseName); recycled = $removed }
}

Export-ModuleMember -Function Invoke-Bridge, Get-BridgePaged, Get-ResultArrayName, Wait-BridgeOperation, Wait-BridgeBatch, Invoke-BridgeSteps, Invoke-BridgeRoad, Get-BridgeRoadGraph, Find-BridgeNearestNode, Test-BridgeNodesConnected, ConvertTo-BridgeLean, Resolve-BridgePrefab, Clear-BridgeRollingSaves, Get-BridgeOccupancy, Test-OccupancyRectFree, Test-OccupancySegmentFree, Test-OccupancyBoxFree, Find-BridgeValue, Set-OccupancyPolygon, Set-OccupancySegment
