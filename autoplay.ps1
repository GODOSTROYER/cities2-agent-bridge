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
    [switch]$NoBuyTiles,
    [switch]$NoBudgetPilot,
    [ValidateRange(5, 20)][int]$MaxTax = 15
)
$ErrorActionPreference = 'Stop'
$play = Join-Path $PSScriptRoot 'play.ps1'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
function Get-Milestone { (Invoke-Bridge get_ui_state @{ chirps = 0 }).milestone }
$start = Get-Milestone
"autoplay: milestone $($start.achieved), next in $($start.xpToNext) xp"
$negStreak = 0
for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
    $m = Invoke-Bridge get_city_management
    $resDemand = [Math]::Max([double]@($m.demand.residential)[0], [Math]::Max([double]@($m.demand.residential)[1], [double]$m.demand.commercial))
    $built = ''
    # An interrupted earlier command can leave the bridge road/zone tool active, and every
    # build then fails with finish_or_cancel_current_tool_first. Wait for it to clear.
    for ($w = 0; $w -lt 15; $w++) { $tool = (Invoke-Bridge get_ui_state @{ chirps = 0 }).activeTool; if (!$tool -or $tool -eq 'DefaultToolSystem') { break }; Start-Sleep 1 }
    if ($tool -and $tool -ne 'DefaultToolSystem') { "autoplay stopped: tool $tool still active after 15 s (an interrupted command); run play.ps1 ui, then retry"; break }
    # Grids are cheap (~6-8k); only keep a modest reserve above the floor for them.
    if ($resDemand -ge $GrowDemand -and $m.city.money -gt $CashFloor + 30000) {
        # -Demolish: when every free site is walled off by lots, clear at most one ordinary
        # home for the link (grow tries clean sites first). Saves a wasted 4-minute search.
        $args2 = @('grow', '-Cols', '3', '-Rows', '2', '-Demolish')
        if (!$NoBuyTiles) { $args2 += '-BuyTiles' }
        $g = @(& $play @args2 2>&1 | ForEach-Object { "$_" })
        $built = if ($g -match 'status=complete|Grid streets built') { 'grid built' } elseif ($g -match 'buy: complete') { 'tile bought' } else { 'no build (' + (($g | Select-Object -Last 1) -replace '^grow: ', '') + ')' }
    }
    if (Test-Path (Join-Path $PSScriptRoot 'services.ps1')) {   # every cycle: coverage, utilities, complaints
        $svc = @(& (Join-Path $PSScriptRoot 'services.ps1') -MaxPlacements 3 -MinCash 200000 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '^(place|services)' })
        if ($svc) { $built = ($built, ($svc -join '; ')) -join ' | ' }
    }
    $r = @(& $play run -Seconds $SecondsPerCycle -Floor $CashFloor 2>&1 | ForEach-Object { "$_" })
    $summary = ($r | Where-Object { $_ -like 'run:*' } | Select-Object -First 1) -replace '^run: ', ''
    if (Test-Path (Join-Path $PSScriptRoot 'watch.ps1')) { try { & (Join-Path $PSScriptRoot 'watch.ps1') 2>&1 | ForEach-Object { "  $_" } } catch { "  watch failed: $($_.Exception.Message)" } }
    $ms = Get-Milestone
    "cycle ${cycle}: $built | $summary | R demand $resDemand | next milestone in $($ms.xpToNext) xp" + $(if ($r -match 'resolved') { ' | popups passed: ' + (@($r -match 'resolved').Count) } else { '' })
    if ($ms.blockedBy -eq 'tutorial_intro') { "  milestones held by unfinished tutorial intro; " + ((& $play fix 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -like 'fix:*' }) -join '; ') }
    # Budget autopilot: keep net >= 0 (raise R/C by 1 after two negative cycles, up to
    # MaxTax); give growth back (lower by 1, not below 10) when net is strongly positive
    # and residential demand has fallen off.
    if (!$NoBudgetPilot) {
        $mm = Invoke-Bridge get_city_management
        $net = [double]$mm.budget.balanceRaw
        $negStreak = if ($net -lt 0) { $negStreak + 1 } else { 0 }
        # Deep deficit: act this cycle, not after two. Taxes first (R/I up to MaxTax; C only
        # while commercial demand holds), then trim service budgets toward 70%.
        if ($net -lt -20000) {
            foreach ($area in 'Residential', 'Industrial', 'Commercial') {
                $rate = [int]$mm.taxes.$area
                if ($area -eq 'Commercial' -and [double]$mm.demand.commercial -lt 30) { continue }
                if ($rate -lt $MaxTax) { $null = Invoke-Bridge set_tax @{ area = $area; rate = [Math]::Min($MaxTax, $rate + 2) }; "  budget: $area tax $rate -> $([Math]::Min($MaxTax, $rate + 2)) (net $([int]$net))" }
            }
            if ([int]$mm.taxes.Residential -ge $MaxTax) {
                foreach ($sv in @((Invoke-Bridge get_services).services)) {
                    $bud = [int]$sv.budget; if ($bud -le 70) { continue }
                    if ($sv.name -match 'Electricity|Water|Garbage') { continue }   # utilities: trimming cuts output
                    $res = Invoke-Bridge set_service_budget @{ prefabIndex = [int]$sv.index; prefabVersion = [int]$sv.version; budget = $bud - 10 } -AllowError
                    if ($res.ok) { "  budget: $($sv.name) $bud% -> $($bud - 10)%" }
                }
            }
            $negStreak = 0
        }
        if ($negStreak -ge 2) {
            foreach ($area in 'Residential', 'Commercial') { $rate = [int]$mm.taxes.$area; if ($rate -lt $MaxTax) { $null = Invoke-Bridge set_tax @{ area = $area; rate = $rate + 1 }; "  budget: $area tax $rate -> $($rate + 1) (net $([int]$net))" } }
            $negStreak = 0
        } elseif ($net -gt 20000 -and [double]@($mm.demand.residential)[0] -lt 30 -and [double]@($mm.demand.residential)[1] -lt 30) {
            foreach ($area in 'Residential', 'Commercial') { $rate = [int]$mm.taxes.$area; if ($rate -gt 10) { $null = Invoke-Bridge set_tax @{ area = $area; rate = $rate - 1 }; "  budget: $area tax $rate -> $($rate - 1) (net +$([int]$net), demand low)" } }
        }
    }    $stop = $r | Where-Object { $_ -match 'STOPPED' }
    if ($stop) { "autoplay stopped: $stop"; break }
    if ($UntilMilestone -and [int]$ms.achieved -gt [int]$start.achieved) { "MILESTONE reached: $($ms.achieved) (was $($start.achieved))"; break }
}
& $play save 2>&1
