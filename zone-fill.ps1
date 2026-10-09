#requires -Version 7.0
# Zones every zonable (Visible, unzoned) cell in an area with one zone prefab, using one
# block-attached rectangle per block so orientation never depends on the camera.
# Cells flagged Blocked are overlap duplicates the game will not zone; they are ignored.
# Reports verified before/after counts from live cell state, not from operation claims.
param(
    [Parameter(Mandatory)][double]$X, [Parameter(Mandatory)][double]$Z,
    [ValidateRange(16,500)][double]$Radius = 300,
    [Parameter(Mandatory)][int]$ZonePrefabIndex, [int]$ZonePrefabVersion = 1,
    [int[]]$OnlyBlocks, [int[]]$ExcludeBlocks,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
function Get-Cells { Get-BridgePaged get_zone_cells @{ x = $X; z = $Z; radius = $Radius; limit = 65536 } }
function Test-Zonable($cell) { $cell.zone -eq 0 -and "$($cell.flags)" -match '\bVisible\b' }

$cells = Get-Cells
$steps = @()
foreach ($block in ($cells | Group-Object blockIndex)) {
    $id = [int]$block.Name
    if ($OnlyBlocks -and $id -notin $OnlyBlocks) { continue }
    if ($ExcludeBlocks -and $id -in $ExcludeBlocks) { continue }
    $open = @($block.Group | Where-Object { Test-Zonable $_ })
    if (!$open) { continue }
    # Rectangle over the zonable cells only, in the block's own grid coordinates.
    $minX = ($open | Measure-Object x -Minimum).Minimum; $maxX = ($open | Measure-Object x -Maximum).Maximum
    $minY = ($open | Measure-Object y -Minimum).Minimum; $maxY = ($open | Measure-Object y -Maximum).Maximum
    $start = $block.Group | Where-Object { $_.x -eq $minX -and $_.y -eq $minY } | Select-Object -First 1
    $end = $block.Group | Where-Object { $_.x -eq $maxX -and $_.y -eq $maxY } | Select-Object -First 1
    if (!$start -or !$end) { continue }
    $steps += @{ command = 'zone_rectangle'; args = @{ prefabIndex = $ZonePrefabIndex; prefabVersion = $ZonePrefabVersion
        start = @{ x = [double]$start.position.x; z = [double]$start.position.z; index = $id; version = [int]$start.blockVersion }
        end = @{ x = [double]$end.position.x; z = [double]$end.position.z } } }
}
$before = @($cells | Where-Object { Test-Zonable $_ }).Count
"Zonable cells before: $before in $($steps.Count) blocks."
if ($WhatIf -or !$steps) { return }
$run = Invoke-BridgeSteps -Steps $steps
$after = @(Get-Cells)
$zoned = @($after | Where-Object { $_.zone -eq $ZonePrefabIndex -or ($_.zone -ne 0 -and $_.zone -ne $null) }).Count
$left = @($after | Where-Object { Test-Zonable $_ }).Count
$noop = @($run.results | Where-Object { $_.result.error -eq 'no_zone_cells_in_rectangle' }).Count
[pscustomobject]@{ status = $run.status; steps = $steps.Count; noOpSteps = $noop; zonableBefore = $before; zonableAfter = $left
    newlyZoned = $before - $left; failedStep = $run.failedStep; stepError = $run.stepError } | Format-List
