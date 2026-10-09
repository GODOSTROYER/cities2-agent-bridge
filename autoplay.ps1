#requires -Version 7.0
# Growth loop for agents: each cycle grows housing when demand is high (buying adjacent
# land when the city is full), simulates a bounded interval (tutorial/milestone popups
# pass automatically), and prints ONE summary line. Stops on any abnormal run stop, on a
# reached milestone with -UntilMilestone, or after -Cycles. Saves (rolling) at the end.
param(
    [ValidateRange(1, 100)][int]$Cycles = 5,
    [ValidateRange(30, 600)][int]$SecondsPerCycle = 120,
    [ValidateRange(0, 100)][int]$GrowDemand = 50,
    [int]$CashFloor = 150000,
    [switch]$UntilMilestone,
    [switch]$NoBuyTiles
)
$ErrorActionPreference = 'Stop'
$play = Join-Path $PSScriptRoot 'play.ps1'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
function Get-Milestone { (Invoke-Bridge get_ui_state @{ chirps = 0 }).milestone }
$start = Get-Milestone
"autoplay: milestone $($start.achieved), next in $($start.xpToNext) xp"
for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
    $m = Invoke-Bridge get_city_management
    $resDemand = [double]@($m.demand.residential)[0]
    $built = ''
    # An interrupted earlier command can leave the bridge road/zone tool active, and every
    # build then fails with finish_or_cancel_current_tool_first. Wait for it to clear.
    for ($w = 0; $w -lt 15; $w++) { $tool = (Invoke-Bridge get_ui_state @{ chirps = 0 }).activeTool; if (!$tool -or $tool -eq 'DefaultToolSystem') { break }; Start-Sleep 1 }
    if ($tool -and $tool -ne 'DefaultToolSystem') { "autoplay stopped: tool $tool still active after 15 s (an interrupted command); run play.ps1 ui, then retry"; break }
    if ($resDemand -ge $GrowDemand -and $m.city.money -gt $CashFloor + 150000) {
        $args2 = @('grow', '-Cols', '3', '-Rows', '2')
        if (!$NoBuyTiles) { $args2 += '-BuyTiles' }
        $g = @(& $play @args2 2>&1 | ForEach-Object { "$_" })
        $built = if ($g -match 'status=complete|Grid streets built') { 'grid built' } elseif ($g -match 'buy: complete') { 'tile bought' } else { 'no build (' + (($g | Select-Object -Last 1) -replace '^grow: ', '') + ')' }
    }
    $r = @(& $play run -Seconds $SecondsPerCycle -Floor $CashFloor 2>&1 | ForEach-Object { "$_" })
    $summary = ($r | Where-Object { $_ -like 'run:*' } | Select-Object -First 1) -replace '^run: ', ''
    $ms = Get-Milestone
    "cycle ${cycle}: $built | $summary | R demand $resDemand | next milestone in $($ms.xpToNext) xp" + $(if ($r -match 'resolved') { ' | popups passed: ' + (@($r -match 'resolved').Count) } else { '' })
    $stop = $r | Where-Object { $_ -match 'STOPPED' }
    if ($stop) { "autoplay stopped: $stop"; break }
    if ($UntilMilestone -and [int]$ms.achieved -gt [int]$start.achieved) { "MILESTONE reached: $($ms.achieved) (was $($start.achieved))"; break }
}
& $play save 2>&1
