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

Export-ModuleMember -Function Invoke-Bridge, Get-BridgePaged, Get-ResultArrayName, Wait-BridgeOperation, Wait-BridgeBatch, Invoke-BridgeSteps, Invoke-BridgeRoad, Get-BridgeRoadGraph, Find-BridgeNearestNode, Test-BridgeNodesConnected
