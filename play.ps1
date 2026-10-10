#requires -Version 7.0
# Token-efficient front end for agents. Every verb prints a few dense lines; raw bridge
# JSON (often kilobytes per call) never reaches the agent unless asked for with `raw`.
#   play.ps1 help
# No declared parameters: PowerShell binding mangles mixes like "name -X -760", so the raw
# argument list is parsed below.
$Verb = if ($args.Count) { [string]$args[0] } else { 'help' }
$Rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] | ForEach-Object { "$_" } })
$ErrorActionPreference = 'Stop'
$H = $PSScriptRoot
Import-Module (Join-Path $H 'lib\BridgeClient.psm1') -Force

# --- tiny argument parser: "-X -880 -Zone res" style options after the verb -------------
$opt = @{}; $pos = @()
for ($i = 0; $i -lt $Rest.Count; $i++) {
    if ($Rest[$i] -match '^-([A-Za-z]\w*)$' -and $i + 1 -lt $Rest.Count -and $Rest[$i + 1] -notmatch '^-[A-Za-z]') { $opt[$Matches[1].ToLower()] = $Rest[++$i] }
    elseif ($Rest[$i] -match '^-([A-Za-z]\w*)$') { $opt[$Matches[1].ToLower()] = $true }
    else { $pos += $Rest[$i] }
}
function Opt($name, $default) { if ($opt.ContainsKey($name)) { $opt[$name] } else { $default } }
function Money($v) { ([double]$v).ToString('N0', [Globalization.CultureInfo]::InvariantCulture) }
function Try-Bridge($command, $arguments = @{}) { $r = Invoke-Bridge $command $arguments -AllowError; if ($r.ok) { $r.result } }

$Zones = @{ res = 'NA Residential Low'; com = 'NA Commercial Low'; ind = 'Industrial Manufacturing'; off = 'Office Low'; resmed = 'NA Residential Medium Row' }

function Show-Ui([switch]$Chirps) {
    $ui = Try-Bridge get_ui_state
    if (!$ui) { $ui = Try-Bridge get_pause_state }
    if (!$ui) { return 'ui: n/a (mod < 0.5.1)' }
    $bits = @("speed $($ui.selectedSpeed)")
    if ($ui.likelyBlocker -and $ui.likelyBlocker -ne 'none') { $bits += "PAUSED BY $($ui.likelyBlocker)" + $(if ($ui.resolvableByBridge) { ' (play fix)' } else { '' }) }
    if ($ui.screen) { $bits += "screen $($ui.screen)" }
    if ($ui.activePanel) { $bits += "panel $($ui.activePanel)" }
    function Short($t, $n) { if ($null -eq $t) { return '' }; $t = "$t"; if ($t.Length -gt $n) { $t.Substring(0, $n) + '…' } else { $t } }
    if ($ui.tutorial.activeTutorialPhase) {
        $txt = @($ui.tutorial.phaseText.PSObject.Properties.Value)
        $bits += "tutorial $($ui.tutorial.phaseKind) '$($ui.tutorial.activeTutorialPhase)'" + $(if ($txt) { ': ' + (Short $txt[0] 60) + $(if ($txt.Count -gt 1) { ' — ' + (Short $txt[1] 140) } else { '' }) } else { '' })
    }
    if ($ui.milestone.pending) { $bits += "MILESTONE '$($ui.milestone.pending)' reward $($ui.milestone.pendingReward)" + $(if ($ui.milestone.pendingText) { ': ' + (Short (@($ui.milestone.pendingText.PSObject.Properties.Value)[0]) 60) } else { '' }) }
    if ($ui.signatures.pending) { $bits += "SIGNATURE unlocked: " + (($ui.signatures.pending | ForEach-Object { $_.name }) -join ', ') }
    if ($ui.milestone.blockedBy -eq 'tutorial_intro') { $bits += "MILESTONES BLOCKED: tutorial intro unfinished ($(-[int]$ui.milestone.xpToNext) xp over; play fix)" }
    elseif ($null -ne $ui.milestone.xpToNext) { $bits += "next milestone in $($ui.milestone.xpToNext) xp" }
    if ($ui.dialogs) { $bits += "dialogs " + (($ui.dialogs | ForEach-Object { $_.title ?? $_.type }) -join '; ') }
    if ($ui.activeTool -and $ui.activeTool -ne 'DefaultToolSystem') { $bits += "tool $($ui.activeTool)" }
    if ($ui.infoview) { $bits += "infoview $($ui.infoview)" }
    if ($ui.hasFocus -eq $false) { $bits += 'window unfocused' }
    if ($Chirps -and $ui.chirps) { $bits += 'chirps: ' + (($ui.chirps | Select-Object -First 3 | ForEach-Object { $t = $_.text; if ($t.Length -gt 70) { $t.Substring(0, 70) + '…' } else { $t } }) -join ' | ') }
    'ui: ' + ($bits -join ' | ')
}

function Show-Look {
    $m = Invoke-Bridge get_city_management
    $c = $m.city; $b = $m.budget; $d = $m.demand
    $net = [double]$b.balanceRaw
    "{0} | pop {1} (+{2} moving in) | money {3} | net {4}{5}/period | happy {6} health {7} | xp {8}" -f $c.cityName, $c.population, ($c.populationWithMoveIn - $c.population), (Money $c.money), ($(if ($net -ge 0) { '+' } else { '' })), (Money $net), $c.averageHappiness, $c.averageHealth, $c.xp
    $res = @($d.residential) -join '/'
    "demand R(low/med/high) $res  C $($d.commercial)  I $($d.industrial)  O $($d.office)  storage $($d.storage) | tax R$($m.taxes.Residential) C$($m.taxes.Commercial) I$($m.taxes.Industrial) O$($m.taxes.Office)"
    $inc = $b.incomeBySourceRaw; $exp = $b.expenseBySourceRaw
    $water = Try-Bridge get_water_facilities
    $pumps = @($water.facilities | Where-Object waterProducer); $outs = @($water.facilities | Where-Object sewageOutlet)
    $wCap = ($pumps.waterProducer.capacityRaw | Measure-Object -Sum).Sum; $wUse = ($pumps.waterProducer.lastProductionRaw | Measure-Object -Sum).Sum
    $sCap = ($outs.sewageOutlet.capacityRaw | Measure-Object -Sum).Sum; $sUse = ($outs.sewageOutlet.lastProcessedRaw | Measure-Object -Sum).Sum
    $power = if ($exp.ImportElectricity) { "IMPORTING power ($(Money $exp.ImportElectricity))" } else { "power surplus (export $(Money $inc.ExportElectricity))" }
    "utilities: $power | water {0:P0} of cap ({1} pumps) | sewage {2:P0} of cap ({3} outlets)" -f ($(if ($wCap) { $wUse / $wCap } else { 0 })), $pumps.Count, ($(if ($sCap) { $sUse / $sCap } else { 0 })), $outs.Count
    $p = @(Get-BridgePaged diagnose_connections @{ limit = 4096 })
    $issues = ($p | ForEach-Object { $_.issues } | Group-Object | Sort-Object Count -Descending | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', '
    "problems: $($p.Count) buildings" + $(if ($issues) { " ($issues)" } else { '' })
    $top = $exp.PSObject.Properties | Where-Object { [double]$_.Value -ne 0 } | Sort-Object { [Math]::Abs([double]$_.Value) } -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name) $(Money $_.Value)" }
    "top expenses: " + ($top -join ', ')
    Show-Ui
}

# Empty, dry, flat, owned land for a cols x rows grid, ranked by whether a straight link
# from an existing road can reach it without crossing a building lot (occupancy raster
# from real lot rectangles; see lib Get-BridgeOccupancy).
# Phase 2: the mod computes the same search (raster, links, terrain, land-use score) in
# milliseconds. Falls back to the PowerShell raster on mods without find_free_lots.
function Find-Sites([int]$cols, [int]$rows, [double]$bw, [double]$bd, [int]$count, [string]$zoneKey = 'res') {
    $r = Invoke-Bridge find_free_lots @{ width = $cols * $bw; depth = $rows * $bd; count = $count; zone = $zoneKey } -AllowError
    if ($r.ok) { return @($r.result.sites) }
    if ("$($r.error)" -notmatch 'unknown_command') { throw "find_free_lots failed: $($r.error)" }
    Find-SitesRaster $cols $rows $bw $bd $count $zoneKey
}
function Find-SitesRaster([int]$cols, [int]$rows, [double]$bw, [double]$bd, [int]$count, [string]$zoneKey = 'res') {
    $w = $cols * $bw; $dpt = $rows * $bd
    $tiles = @((Invoke-Bridge get_tiles).tiles | Where-Object purchased | ForEach-Object {
        $xs = $_.polygon.x; $zs = $_.polygon.z
        [pscustomobject]@{ x0 = ($xs | Measure-Object -Minimum).Minimum; x1 = ($xs | Measure-Object -Maximum).Maximum; z0 = ($zs | Measure-Object -Minimum).Minimum; z1 = ($zs | Measure-Object -Maximum).Maximum } })
    function Owned($x, $z) { foreach ($t in $tiles) { if ($x -ge $t.x0 -and $x -le $t.x1 -and $z -ge $t.z0 -and $z -le $t.z1) { return $true } }; $false }
    $X0 = ($tiles.x0 | Measure-Object -Minimum).Minimum; $X1 = ($tiles.x1 | Measure-Object -Maximum).Maximum
    $Z0 = ($tiles.z0 | Measure-Object -Minimum).Minimum; $Z1 = ($tiles.z1 | Measure-Object -Maximum).Maximum
    $occ = Get-BridgeOccupancy -MinX $X0 -MinZ $Z0 -MaxX $X1 -MaxZ $Z1
    $edges = @((Invoke-Bridge get_network_edges @{ x = ($X0 + $X1) / 2; z = ($Z0 + $Z1) / 2; radius = 2000 }).edges | Where-Object { $_.prefab -match '^(?!Highway).*Road' })
    # Land-use context: where pollution sources, jobs and homes are, and highway noise.
    $allB = @(Get-BridgePaged get_buildings @{ limit = 4096 } | ForEach-Object { [pscustomobject]@{ x = $_.position.x; z = $_.position.z; p = "$($_.prefab)" } })
    $polluters = @($allB | Where-Object { $_.p -match 'Industrial|PowerPlant|Coal|Gas|Landfill|Incinerat|Sewage|Oil|Ore' })
    $jobs = @($allB | Where-Object { $_.p -match 'Commercial|Industrial|Office' })
    $homes = @($allB | Where-Object { $_.p -match 'Residential' })
    $hwy = @((Invoke-Bridge get_network_edges @{ x = ($X0 + $X1) / 2; z = ($Z0 + $Z1) / 2; radius = 2000 }).edges | Where-Object { $_.prefab -match 'Highway' } | ForEach-Object { $_.curve[0]; $_.curve[-1] })
    function MinDist($set, $x, $z) { $m = [double]::MaxValue; foreach ($q in $set) { $d = [Math]::Sqrt([Math]::Pow($q.x - $x, 2) + [Math]::Pow($q.z - $z, 2)); if ($d -lt $m) { $m = $d } }; $m }
    $roadPts = @(foreach ($ed in $edges) { foreach ($t in 0, 0.25, 0.5, 0.75, 1) { [pscustomobject]@{ x = $ed.curve[0].x + ($ed.curve[-1].x - $ed.curve[0].x) * $t; z = $ed.curve[0].z + ($ed.curve[-1].z - $ed.curve[0].z) * $t } } })
    $cands = foreach ($x in ([int]$X0)..([int]($X1 - $w)) | Where-Object { ($_ - [int]$X0) % 40 -eq 0 }) {
        foreach ($z in ([int]$Z0)..([int]($Z1 - $dpt)) | Where-Object { ($_ - [int]$Z0) % 40 -eq 0 }) {
            if (!(Owned $x $z) -or !(Owned ($x + $w) $z) -or !(Owned $x ($z + $dpt)) -or !(Owned ($x + $w) ($z + $dpt))) { continue }
            if (!(Test-OccupancyRectFree $occ $x $z ($x + $w) ($z + $dpt) 8)) { continue }
            $near = $roadPts | ForEach-Object { $px = [Math]::Min([Math]::Max($_.x, $x), $x + $w); $pz = [Math]::Min([Math]::Max($_.z, $z), $z + $dpt)
                [pscustomobject]@{ p = $_; t = [pscustomobject]@{ x = $px; z = $pz }; d = [Math]::Sqrt([Math]::Pow($_.x - $px, 2) + [Math]::Pow($_.z - $pz, 2)) } } |
                Where-Object { $_.d -ge 8 -and $_.d -le 400 } | Sort-Object d | Select-Object -First 1
            if ($near) { [pscustomobject]@{ x = $x; z = $z; link = [Math]::Round($near.d); nearest = $near } } } }
    # Rank: closest first, but only the top few get the (slower) clear-link test.
    $ranked = @($cands | Sort-Object link | Select-Object -First 30 | ForEach-Object {
        $site = $_; $sx1 = $site.x + $w; $sz1 = $site.z + $dpt
        $clearLink = $roadPts | ForEach-Object { $px = [Math]::Min([Math]::Max($_.x, $site.x), $sx1); $pz = [Math]::Min([Math]::Max($_.z, $site.z), $sz1)
            [pscustomobject]@{ p = $_; t = [pscustomobject]@{ x = $px; z = $pz }; d = [Math]::Sqrt([Math]::Pow($_.x - $px, 2) + [Math]::Pow($_.z - $pz, 2)) } } |
            Where-Object { $_.d -ge 8 -and $_.d -le 400 } | Sort-Object d | Select-Object -First 12 | Where-Object { Test-OccupancySegmentFree $occ $_.p $_.t 6 } | Select-Object -First 1
        $site | Add-Member clearLink ($(if ($clearLink) { [Math]::Round($clearLink.d) } else { $null })) -PassThru })
    $ordered = @($ranked | Sort-Object @{ e = { if ($null -ne $_.clearLink) { 0 } else { 1 } } }, link)
    # Terrain: 9 samples per finalist in one call; reject wet or >25 m relief (the native road pre-flight catches real SteepSlope).
    $final = @($ordered | Select-Object -First ([Math]::Max($count * 4, 20)))
    if (!$final) { return @() }
    $pts = foreach ($cnd in $final) { foreach ($fx in 0, 0.5, 1) { foreach ($fz in 0, 0.5, 1) { @{ x = $cnd.x + $fx * $w; z = $cnd.z + $fz * $dpt } } } }
    $sr = Invoke-Bridge sample_terrain @{ points = @($pts) }; $smp = @($sr.(Get-ResultArrayName $sr))
    $out = @(); $k = 0
    foreach ($cnd in $final) {
        $grp = $smp[$k..($k + 8)]; $k += 9
        $hs = $grp.position.y; $wet = @($grp | Where-Object { $_.waterDepth -gt 0.1 }).Count
        $relief = ($hs | Measure-Object -Maximum).Maximum - ($hs | Measure-Object -Minimum).Minimum
        if ($wet -ne 0 -or $relief -gt 25) { continue }
        $cx = $cnd.x + $w / 2; $cz = $cnd.z + $dpt / 2
        $pol = (($grp | ForEach-Object { [Math]::Max([double]$_.airPollutionRaw, [Math]::Max([double]$_.groundPollutionRaw, [double]$_.noisePollutionRaw)) }) | Measure-Object -Maximum).Maximum
        $dInd = MinDist $polluters $cx $cz; $dJob = MinDist $jobs $cx $cz; $dHome = MinDist $homes $cx $cz; $dHwy = MinDist $hwy $cx $cz
        # Higher is better. Link length always counts (cheap, connected, less traffic detour).
        $score = - $cnd.link / 10 - $(if ($null -eq $cnd.clearLink) { 50 } else { 0 })
        switch ($zoneKey) {
            { $_ -in 'res', 'resmed' } { $score += - $pol / 2 + [Math]::Min($dInd, 600) / 20 - $(if ($dHwy -lt 150) { 25 } else { 0 }) - $(if ($dJob -gt 1200) { ($dJob - 1200) / 40 } else { 0 }) }
            { $_ -in 'com', 'off' } { $score += - $(if ($dHome -gt 500) { ($dHome - 500) / 20 } else { 0 }) - $pol / 10 }
            'ind' { $score += [Math]::Min($dHome, 600) / 15 - $(if ($dHwy -gt 400) { ($dHwy - 400) / 20 } else { 0 }) }
        }
        $out += [pscustomobject]@{ x = $cnd.x; z = $cnd.z; link = $cnd.link; clearLink = $cnd.clearLink; relief = [Math]::Round($relief, 1); pollution = [Math]::Round($pol); toIndustry = [Math]::Round($dInd); toJobs = [Math]::Round($dJob); toHomes = [Math]::Round($dHome); toHighway = [Math]::Round($dHwy); score = [Math]::Round($score, 1) }
    }
    @($out | Sort-Object score -Descending | Select-Object -First $count)
}
# Adjacent unowned tiles ranked by dry/flat land and closeness to the city; buys the best N.
function Invoke-BuyTiles([int]$n, [long]$maxCost, [bool]$plan) {
    $all = @((Invoke-Bridge get_tiles).tiles | ForEach-Object {
        $xs = $_.polygon.x; $zs = $_.polygon.z
        [pscustomobject]@{ index = $_.index; version = $_.version; owned = $_.purchased; x0 = ($xs | Measure-Object -Minimum).Minimum; x1 = ($xs | Measure-Object -Maximum).Maximum; z0 = ($zs | Measure-Object -Minimum).Minimum; z1 = ($zs | Measure-Object -Maximum).Maximum } })
    $owned = @($all | Where-Object owned)
    $cx = (($owned | ForEach-Object { ($_.x0 + $_.x1) / 2 }) | Measure-Object -Average).Average; $cz = (($owned | ForEach-Object { ($_.z0 + $_.z1) / 2 }) | Measure-Object -Average).Average
    # -X/-Z: prefer tiles near that point (e.g. away from industry for housing).
    if ($opt.ContainsKey('x') -and $opt.ContainsKey('z')) { $cx = [double](Opt 'x' 0); $cz = [double](Opt 'z' 0) }
    $adjacent = @($all | Where-Object { !$_.owned } | Where-Object { $t = $_; @($owned | Where-Object {
        ([Math]::Abs($_.x1 - $t.x0) -lt 1 -or [Math]::Abs($_.x0 - $t.x1) -lt 1) -and $_.z0 -lt $t.z1 - 1 -and $_.z1 -gt $t.z0 + 1 -or
        ([Math]::Abs($_.z1 - $t.z0) -lt 1 -or [Math]::Abs($_.z0 - $t.z1) -lt 1) -and $_.x0 -lt $t.x1 - 1 -and $_.x1 -gt $t.x0 + 1 }).Count })
    if (!$adjacent) { 'buy: no adjacent unowned tiles'; return }
    $pts = foreach ($t in $adjacent) { foreach ($fx in 0.2, 0.5, 0.8) { foreach ($fz in 0.2, 0.5, 0.8) { @{ x = $t.x0 + ($t.x1 - $t.x0) * $fx; z = $t.z0 + ($t.z1 - $t.z0) * $fz } } } }
    $sr = Invoke-Bridge sample_terrain @{ points = @($pts) }; $smp = @($sr.(Get-ResultArrayName $sr)); $k = 0
    $scored = foreach ($t in $adjacent) {
        $grp = $smp[$k..($k + 8)]; $k += 9
        $dry = 9 - @($grp | Where-Object { $_.waterDepth -gt 0.1 -or $_.waterStatus -eq 'out_of_bounds' }).Count
        $hs = $grp.position.y; $relief = ($hs | Measure-Object -Maximum).Maximum - ($hs | Measure-Object -Minimum).Minimum
        $dist = [Math]::Sqrt([Math]::Pow(($t.x0 + $t.x1) / 2 - $cx, 2) + [Math]::Pow(($t.z0 + $t.z1) / 2 - $cz, 2))
        [pscustomobject]@{ tile = $t; dry = $dry; relief = [Math]::Round($relief); score = $dry * 100 - $relief * 2 - $dist / 50 } }
    $pick = @($scored | Sort-Object score -Descending | Select-Object -First $n)
    foreach ($s in $pick) { "buy: tile {0} at x {1:N0}..{2:N0} z {3:N0}..{4:N0}  dry {5}/9 relief {6}m" -f $s.tile.index, $s.tile.x0, $s.tile.x1, $s.tile.z0, $s.tile.z1, $s.dry, $s.relief }
    if ($plan) { 'buy: plan only, nothing purchased'; return }
    $r = Invoke-Bridge purchase_tiles @{ tiles = @($pick | ForEach-Object { @{ index = [int]$_.tile.index; version = [int]$_.tile.version } }); maxCost = $maxCost }
    if ($r.id) { $r = Wait-BridgeOperation $r.id }
    "buy: $($r.status) cost $(Money ($r.cost ?? $r.previewCost ?? $r.totalCost))" + $(if ($r.error) { " error $($r.error)" } else { '' })
}
function Invoke-Grid([double]$x, [double]$z, [int]$cols, [int]$rows, [string]$zoneKey, [bool]$plan, [bool]$demolish = $false, [bool]$screen = $false) {
    $zone = Resolve-BridgePrefab $Zones[$zoneKey] 'zone'
    $road = Resolve-BridgePrefab 'Small Road' 'network'
    $a = @{ X = $x; Z = $z; Columns = $cols; Rows = $rows; RoadPrefabIndex = $road.index; RoadPrefabVersion = $road.version; ZonePrefabIndex = $zone.index; ZonePrefabVersion = $zone.version }
    if ($plan) { $a.PlanOnly = $true }
    if ($demolish) { $a.AllowDemolition = $true }
    if ($screen) { $a.SkipNativePreview = $true }
    & (Join-Path $H 'grid.ps1') @a *>&1 | ForEach-Object { "$_" } |
        Where-Object { $_ -match '^(Plan |Batch|Grid connected|PlanOnly|Failed|zone:|Demolished|Stubs|Shared|Native preview|Grid streets|Connector rebuilt|  skipped|  road|Stub dropped)' -or $_ -match 'rror|: ready' } | ForEach-Object { $_ -replace '\s{2,}', ' ' } |
        Tee-Object -Variable lines
    # execute_neighborhood writes before/after saves; after a clean build keep only the newest.
    if (!$plan -and ($lines -match 'status=complete') -and !($lines -match 'Failed|rror')) { $cleanup = Clear-BridgeRollingSaves -KeepNewest 1; if ($cleanup.recycled) { "recycled $($cleanup.recycled.Count) automatic save(s)" } }
}

switch ($Verb.ToLower()) {
    'help' {
@'
play.ps1 <verb> [options]   (city must be loaded; tick "Allow local bridge controls")
  look                       city, demand, utilities, problems, budget, ui (one screen)
  ui                         what the UI is doing / why the game is paused
  fix                        resolve safe pause blockers (tutorial phase, milestone popup)
  sites [-Cols 3 -Rows 2 -N 3]      empty dry flat owned land near roads for a grid
  grid -X x -Z z [-Cols 3 -Rows 2 -Zone res|com|ind|resmed -Plan]   build+zone+connect
  buy [-N 1 -Max 300000 -X x -Z z -Plan]  buy best adjacent map tile(s) (dry, flat, near city or near x,z)
  grow [-Cols 3 -Rows 2 -Zone res|resmed|com|ind|off -Plan -Demolish -BuyTiles]   pick zone by demand, find site, build grid (-Demolish: may remove 1 house for a link)
  zone -X x -Z z [-R 300 -Zone res] zone all zonable cells in area
  run [-Seconds 600 -Speed 4 -Floor 150000]   bounded simulation, auto-fixes tutorials
  link -X x -Z z [-Road 'Medium Road' -Max 60000 -Plan]   arterial: clear corridor from existing roads, game-checked
  place <prefab> -X x -Z z [-R 300 -Max 150000]   place a building by name at a roadside site
  save [label] [-Keep]       rolling save (older bridge saves recycled); -Keep = permanent
  prefab <name> [kind]       resolve name -> index (cached)
  raw <command> [json]       bridge call, noisy fields stripped (add -Full for all)
'@
    }
    'look' { Show-Look }
    'ui' { Show-Ui -Chirps }
    'fix' {
        $n = 0
        while ($n -lt 10) {
            $ui = Try-Bridge get_ui_state; if (!$ui) { $ui = Try-Bridge get_pause_state }
            if (!$ui) { 'fix: needs mod 0.5.1+'; break }
            if ($ui.milestone.blockedBy -eq 'tutorial_intro' -and !$ui.resolvableByBridge) {
                $r = Invoke-Bridge resolve_pause_blocker @{ action = 'complete_tutorial_intro' }
                "fix: completed tutorial intro (milestones released: $(!$r.introUnfinishedAfter))"; $n++; Start-Sleep -Milliseconds 1200; continue
            }
            if (!$ui.resolvableByBridge) { "fix: nothing safe to resolve (blocker: $($ui.likelyBlocker))"; break }
            $arg = switch ($ui.likelyBlocker) {
                'milestone_popup' { @{ action = 'dismiss_milestone'; expectedMilestone = [string]$ui.milestone.pending } }
                'signature_popup' { @{ action = 'dismiss_signature'; expectedSignature = [string]$ui.signatures.pending[0].name } }
                default { @{ action = 'complete_tutorial_phase'; expectedPhase = [string]$ui.tutorial.activeTutorialPhase } } }
            $r = Invoke-Bridge resolve_pause_blocker $arg
            "fix: $($arg.action) -> $($r.completedPhase ?? $r.dismissed)"; $n++
            Start-Sleep -Milliseconds 1200
        }
        Show-Ui
    }
    'sites' {
        $cols = [int](Opt 'cols' 3); $rows = [int](Opt 'rows' 2)
        $found = Find-Sites $cols $rows 110 110 ([int](Opt 'n' 3)) ([string](Opt 'zone' 'res'))
        if (!$found) { "sites: none for ${cols}x${rows} (try smaller, or buy tiles)" }
        foreach ($s in $found) { "site: -X $($s.x) -Z $($s.z) -Cols $cols -Rows $rows   link $($s.link)m " + $(if ($null -ne $s.clearLink) { "clear-link $($s.clearLink)m" } else { "NO clear link (needs -Demolish)" }) + " relief $($s.relief)m | score $($s.score): pollution $($s.pollution), industry $($s.toIndustry)m, jobs $($s.toJobs)m, homes $($s.toHomes)m, highway $($s.toHighway)m" }
    }
    'grid' { Invoke-Grid ([double](Opt 'x' $null)) ([double](Opt 'z' $null)) ([int](Opt 'cols' 3)) ([int](Opt 'rows' 2)) (Opt 'zone' 'res') ([bool](Opt 'plan' $false)) ([bool](Opt 'demolish' $false)) }
    'grow' {
        $d = (Invoke-Bridge get_city_management).demand
        # residential demand is [low, medium, high]; medium/high only count once unlocked.
        $choices = @(@{ k = 'res'; v = [double]@($d.residential)[0] }, @{ k = 'resmed'; v = [double]@($d.residential)[1] }, @{ k = 'com'; v = [double]$d.commercial }, @{ k = 'ind'; v = [double]$d.industrial }, @{ k = 'off'; v = [double]$d.office }) | Sort-Object { $_.v } -Descending
        # Jobs before homes: with high unemployment (watch.ps1 status), build workplaces.
        $statusFile = Join-Path $H 'journals\status.json'
        # Live value from the non-pausing snapshot; watch.ps1's status.json is only a fallback.
        $unemp = try { [double](Invoke-Bridge get_snapshot).jobs.unemp } catch { try { [double](Get-Content $statusFile -Raw | ConvertFrom-Json).unemployment } catch { 0 } }
        if ($unemp -gt 10) { $choices = @($choices | Where-Object { $_.k -in 'com', 'ind', 'off' }) + @($choices | Where-Object { $_.k -notin 'com', 'ind', 'off' }); "grow: unemployment $unemp% -> jobs first" }
        # -Zone res|resmed|com|ind forces the zone type (demand >= 20 still required).
        if (Opt 'zone' $null) { $choices = @($choices | Where-Object { $_.k -eq [string](Opt 'zone' '') }); if (!$choices) { "grow: unknown -Zone (res, resmed, com, ind, off)"; break } }
        $pick = $null
        # First unlocked choice with real demand (>= 20); jobs-first only reorders, it never
        # forces zoning that nobody wants.
        foreach ($c in $choices) { if ($c.v -lt 20) { continue }; try { $null = Resolve-BridgePrefab $Zones[$c.k] 'zone'; $pick = $c; break } catch {} }
        if (!$pick -or $pick.v -lt 20) { "grow: demand too low (R $(@($d.residential)[0]) C $($d.commercial) I $($d.industrial)); simulate instead"; break }
        $cols = [int](Opt 'cols' 3); $rows = [int](Opt 'rows' 2)
        $growClock = [Diagnostics.Stopwatch]::StartNew()
        # Validate candidates read-only (geometric plan only, fast) in distance order; the
        # chosen site gets the native game check when it is built. Hard 4-minute budget.
        # Step down in size when the requested grid does not fit (land is often fragmented).
        $sites = @()
        foreach ($size in @(@($cols, $rows), @(2, 2), @(2, 1), @(1, 1)) | Where-Object { $_[0] * $_[1] -le $cols * $rows } | Select-Object -Unique) {
            $sites = @(Find-Sites $size[0] $size[1] 110 110 5 $pick.k)
            if ($sites) { if ($size[0] -ne $cols -or $size[1] -ne $rows) { "grow: ${cols}x${rows} does not fit; using $($size[0])x$($size[1])" }; $cols = $size[0]; $rows = $size[1]; break }
        }
        if (!$sites -and (Opt 'buytiles' $false) -and !(Opt 'plan' $false)) { Invoke-BuyTiles 1 ([long](Opt 'max' 300000)) $false; $sites = @(Find-Sites $cols $rows 110 110 5) }
        if (!$sites) { "grow: no free site for ${cols}x${rows}" + $(if (!(Opt 'buytiles' $false)) { ' (land is full: add -BuyTiles, or play.ps1 buy)' } else { '' }); break }
        $chosen = $null
        foreach ($site in $sites) {
            if ($growClock.Elapsed.TotalMinutes -gt 4) { "grow: time budget (4 min) used; stopping search"; break }
            $check = @(Invoke-Grid $site.x $site.z $cols $rows $pick.k $true $false $true 2>&1 | ForEach-Object { "$_" })
            if ($check -match 'PlanOnly: nothing changed') { $chosen = $site; break }
            "grow: site -X $($site.x) -Z $($site.z) rejected by plan"
        }
        if (!$chosen -and (Opt 'demolish' $false) -and !(Opt 'plan' $false)) {
            "grow: no clean link; trying -Demolish on nearest site -X $($sites[0].x) -Z $($sites[0].z)"
            Invoke-Grid $sites[0].x $sites[0].z $cols $rows $pick.k $false $true; break
        }
        if (!$chosen) { "grow: no candidate validated; nothing changed" + $(if (!(Opt 'demolish' $false)) { ' (add -Demolish to open a street through one house)' } else { '' }); break }
        "grow: zone $($pick.k) (demand $($pick.v)) at -X $($chosen.x) -Z $($chosen.z)"
        Invoke-Grid $chosen.x $chosen.z $cols $rows $pick.k ([bool](Opt 'plan' $false))
    }
    'zone' {
        $zone = Resolve-BridgePrefab $Zones[(Opt 'zone' 'res')] 'zone'
        & (Join-Path $H 'zone-fill.ps1') -X ([double](Opt 'x' 0)) -Z ([double](Opt 'z' 0)) -Radius ([double](Opt 'r' 300)) -ZonePrefabIndex $zone.index -ZonePrefabVersion $zone.version |
            Select-Object -Last 1
    }
    'run' {
        $log = Join-Path $H 'journals\run-session.jsonl'
        $before = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
        $out = & (Join-Path $H 'run-session.ps1') -TotalSeconds ([int](Opt 'seconds' 600)) -Speed ([int](Opt 'speed' 4)) -CashFloor ([int](Opt 'floor' 150000)) -ResolveTutorials *>&1 | ForEach-Object { "$_" }
        $steps = @(Get-Content $log | Select-Object -Skip $before | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $null -ne $_.population })
        if ($steps) {
            $f = $steps[0]; $l = $steps[-1]
            "run: {0} steps {1:N0}s | pop {2}->{3} | money {4}->{5}" -f $steps.Count, $l.usedSeconds, ($f.population - $f.delta.population), $l.population, (Money ($f.money - $f.delta.money)), (Money $l.money)
        }
        $out | Where-Object { $_ -match 'triage|pause:|completed tutorial|STOPPED|DONE|WARN|rror' }
    }
    'buy' { Invoke-BuyTiles ([int](Opt 'n' 1)) ([long](Opt 'max' 300000)) ([bool](Opt 'plan' $false)) }    'link' {
        # link -X x -Z z [-Road 'Medium Road' -Max 60000 -Plan]: shortest straight corridor from
        # an existing local road to (x,z) that crosses no building lot (occupancy raster),
        # checked by the game's own validator, then built. Arterials for planned growth.
        $tx = [double](Opt 'x' 0); $tz = [double](Opt 'z' 0); $roadName = [string](Opt 'road' 'Medium Road')
        $rd = Resolve-BridgePrefab $roadName 'network'
        $edges = @((Invoke-Bridge get_network_edges @{ x = $tx; z = $tz; radius = 2000 }).edges | Where-Object { $_.prefab -match '^(?!Highway).*Road' })
        $pts = @(foreach ($e in $edges) { foreach ($t in 0.1, 0.3, 0.5, 0.7, 0.9) { [pscustomobject]@{ x = $e.curve[0].x + ($e.curve[-1].x - $e.curve[0].x) * $t; z = $e.curve[0].z + ($e.curve[-1].z - $e.curve[0].z) * $t; e = $e; t = $t } } })
        $near = @($pts | Sort-Object { [Math]::Pow($_.x - $tx, 2) + [Math]::Pow($_.z - $tz, 2) } | Select-Object -First 60)
        if (!$near) { 'link: no road within 2 km'; break }
        $xs = @($near.x) + $tx; $zs = @($near.z) + $tz
        $occ = Get-BridgeOccupancy -MinX (($xs | Measure-Object -Minimum).Minimum - 20) -MinZ (($zs | Measure-Object -Minimum).Minimum - 20) -MaxX (($xs | Measure-Object -Maximum).Maximum + 20) -MaxZ (($zs | Measure-Object -Maximum).Maximum + 20)
        $target = [pscustomobject]@{ x = $tx; z = $tz }
        $ok = $null
        foreach ($s in $near) {
            $len = [Math]::Sqrt([Math]::Pow($s.x - $tx, 2) + [Math]::Pow($s.z - $tz, 2))
            if ($len -gt 1000 -or !(Test-OccupancySegmentFree $occ $s $target 9)) { continue }
            $args3 = @{ prefabIndex = $rd.index; prefabVersion = $rd.version; start = @{ x = [double]$s.x; z = [double]$s.z; index = [int]$s.e.index; version = [int]$s.e.version; curvePosition = [double]$s.t }; end = @{ x = $tx; z = $tz }; maxCost = [long](Opt 'max' 60000) }
            $pv = Wait-BridgeOperation (Invoke-Bridge build_road ($args3 + @{ previewOnly = $true })).id
            if ($pv.status -ne 'complete') { "link: candidate from $([int]$s.x),$([int]$s.z) rejected: $($pv.error) [$(@($pv.placementErrors.reasons | Select-Object -Unique) -join ',')]"; continue }
            $ok = $args3; "link: corridor from $([int]$s.x),$([int]$s.z) ($([int]$len) m, cost $(Money $pv.previewCost)) accepted by the game"; break
        }
        if (!$ok -and [int](Opt 'demolish' 0) -gt 0) {
            # Fewest-crossings corridor: count growable lots each straight link would cut.
            $limit = [int](Opt 'demolish' 0)
            $lots = @(); $seenLots = @{}
            foreach ($cx in ($xs | Measure-Object -Minimum).Minimum, ($xs | Measure-Object -Maximum).Maximum) { foreach ($cz in ($zs | Measure-Object -Minimum).Minimum, ($zs | Measure-Object -Maximum).Maximum) {
                foreach ($b in (Invoke-Bridge get_city_map @{ x = $cx; z = $cz; radius = 500 }).buildings) { if (!$seenLots[$b.index]) { $seenLots[$b.index] = 1; $lots += $b } } } }
            $best = $null
            foreach ($s in $near) {
                $len = [Math]::Sqrt([Math]::Pow($s.x - $tx, 2) + [Math]::Pow($s.z - $tz, 2)); if ($len -gt 1000) { continue }
                $hit = @($lots | Where-Object { $hs = [Math]::Sqrt([Math]::Pow($_.halfSize[0], 2) + [Math]::Pow($_.halfSize[1], 2)) + 9
                    $dx = $tx - $s.x; $dz = $tz - $s.z; $l2 = $dx * $dx + $dz * $dz; $u = [Math]::Max(0, [Math]::Min(1, (($_.position.x - $s.x) * $dx + ($_.position.z - $s.z) * $dz) / $l2))
                    [Math]::Sqrt([Math]::Pow($_.position.x - ($s.x + $u * $dx), 2) + [Math]::Pow($_.position.z - ($s.z + $u * $dz), 2)) -lt $hs })
                if ($hit.Count -gt $limit -or @($hit | Where-Object { $_.prefab -notmatch '^(NA_|EU_)?(Residential|Commercial|Industrial|Office)' }).Count) { continue }
                if (!$best -or $hit.Count -lt $best.hit.Count -or ($hit.Count -eq $best.hit.Count -and $len -lt $best.len)) { $best = [pscustomobject]@{ s = $s; len = $len; hit = $hit } }
            }
            if ($best) {
                "link: corridor from $([int]$best.s.x),$([int]$best.s.z) ($([int]$best.len) m) needs $($best.hit.Count) lot(s) cleared: " + (($best.hit | ForEach-Object { "$($_.prefab)@$([int]$_.position.x),$([int]$_.position.z)" }) -join '; ')
                if (Opt 'plan' $false) { 'link: plan only, nothing demolished or built'; break }
                foreach ($b in $best.hit) { $d = Invoke-Bridge demolish @{ index = [int]$b.index; version = [int]$b.version }; $dr = if ($d.id) { Wait-BridgeOperation $d.id } else { $d }; "link: demolished $($b.prefab): $($dr.status)" }
                $s = $best.s
                $ok = @{ prefabIndex = $rd.index; prefabVersion = $rd.version; start = @{ x = [double]$s.x; z = [double]$s.z; index = [int]$s.e.index; version = [int]$s.e.version; curvePosition = [double]$s.t }; end = @{ x = $tx; z = $tz }; maxCost = [long](Opt 'max' 60000) }
                $pv = Wait-BridgeOperation (Invoke-Bridge build_road ($ok + @{ previewOnly = $true })).id
                if ($pv.status -ne 'complete') { "link: game still rejects after clearing: $($pv.error) [$(@($pv.placementErrors.reasons | Select-Object -Unique) -join ',')]"; break }
            }
        }
        if (!$ok) { 'link: no clear corridor (all straight links cross lots or were rejected)' + $(if (!(Opt 'demolish' 0)) { '; -Demolish N allows clearing up to N homes/shops' } else { '' }); break }
        if (Opt 'plan' $false) { 'link: plan only, nothing built'; break }
        $r = Wait-BridgeOperation (Invoke-Bridge build_road $ok).id
        "link: $($r.status) $(Money $r.previewCost)" + $(if ($r.error) { " error $($r.error)" } else { '' })
    }    'place' {
        # place <prefab name> -X x -Z z [-R 300 -Max 150000]: roadside site search + native placement.
        $name = $pos -join ' '
        $pf = Resolve-BridgePrefab $name 'building'
        $px = [double](Opt 'x' 0); $pz = [double](Opt 'z' 0); $pr = [double](Opt 'r' 300)
        # Phase 2: the mod slides the real (rotated) lot along every nearby road on its own
        # occupancy raster in milliseconds (FAILURES #38: large lots found no site before).
        $cands = @()
        $rl = Invoke-Bridge find_roadside_lots @{ prefab = $name; x = $px; z = $pz; radius = $pr; count = 16 } -AllowError
        if ($rl.ok) {
            "place: $($rl.result.found) roadside spots for lot $($rl.result.halfSize[0]*2)x$($rl.result.halfSize[1]*2) m (mod, $($rl.result.ms) ms)"
            $cands = @($rl.result.candidates | ForEach-Object { @{ position = @{ x = [double]$_.position.x; z = [double]$_.position.z }; rotation = [double]$_.rotation } })
        }
        if (!$cands) {
            $found = Invoke-Bridge find_building_sites @{ prefabIndex = $pf.index; prefabVersion = $pf.version; x = $px; z = $pz; radius = $pr }
            $cands = @($found.(Get-ResultArrayName $found) | Select-Object -First 16 | ForEach-Object { @{ position = @{ x = [double]$_.position.x; z = [double]$_.position.z }; rotation = [double]$_.rotation } })
            # Large lots: the mod's finder ignores roads/intersections and samples 3 points per
            # edge. Use the occupancy raster (lots + roads) with the prefab's real lot size,
            # sliding along every nearby road edge on both sides.
            $lot = Find-BridgeValue (Invoke-Bridge get_prefab_details @{ index = $pf.index; version = $pf.version }).rawData 'm_LotSize'
            if ($lot -and ([double]$lot.x * [double]$lot.y) -ge 64) {
                $hw = [double]$lot.x * 4; $hd = [double]$lot.y * 4
                $occ = Get-BridgeOccupancy -MinX ($px - $pr - 120) -MinZ ($pz - $pr - 120) -MaxX ($px + $pr + 120) -MaxZ ($pz + $pr + 120)
                $roadsNear = @((Invoke-Bridge get_network_edges @{ x = $px; z = $pz; radius = $pr }).edges | Where-Object { $_.prefab -match '^(?!Highway).*Road' })
                $big = foreach ($e in $roadsNear) { $a = $e.curve[0]; $b = $e.curve[-1]; $len = [Math]::Sqrt([Math]::Pow($b.x - $a.x, 2) + [Math]::Pow($b.z - $a.z, 2)); if ($len -lt 2 * $hw) { continue }
                    $tx = ($b.x - $a.x) / $len; $tz = ($b.z - $a.z) / $len
                    for ($s = $hw + 4; $s -le $len - $hw - 4; $s += 8) { foreach ($side in -1, 1) {
                        $ox = - $tz * $side; $oz = $tx * $side; $cx = $a.x + $tx * $s + $ox * (9 + $hd); $cz = $a.z + $tz * $s + $oz * (9 + $hd)
                        $rot = [Math]::Atan2(- $ox, - $oz) * 180 / [Math]::PI
                        if (Test-OccupancyBoxFree $occ $cx $cz $hw $hd $rot) { [pscustomobject]@{ x = $cx; z = $cz; rot = $rot; d = [Math]::Sqrt([Math]::Pow($cx - $px, 2) + [Math]::Pow($cz - $pz, 2)) } } } } }
                $big = @($big | Sort-Object d | Select-Object -First 16)
                "place: lot $($lot.x)x$($lot.y) cells; $($big.Count) raster-clear roadside spots"
                if ($big) { $cands = @($big | ForEach-Object { @{ position = @{ x = [double]$_.x; z = [double]$_.z }; rotation = [double]$_.rot } }) }
            }
        }
        if (!$cands) { "place: no roadside site for $name near $(Opt 'x' 0),$(Opt 'z' 0)"; break }
        $op = Invoke-Bridge place_building @{ prefabIndex = $pf.index; prefabVersion = $pf.version; position = $cands[0].position; rotation = $cands[0].rotation; candidates = $cands; maxCost = [long](Opt 'max' 150000) }
        $r = Wait-BridgeOperation $op.id
        if ($r.status -eq 'complete') { "place: $name at {0:N0},{1:N0} cost {2}" -f $r.snappedPosition.x, $r.snappedPosition.z, (Money $r.previewCost) }
        else { "place: FAILED $name - $($r.error) (attempts $(@($r.attempts).Count)) reasons [$(@($r.placementErrors | ForEach-Object { $_.reasons } | Select-Object -Unique) -join ',')]" }
    }    'save' {
        # Default: rolling save (older bridge saves -> Recycle Bin). -Keep: permanent keep-<label>.
        $keep = [bool](Opt 'keep' $false)
        $label = if ($pos) { $pos[0] } else { 'autosave' }
        if ($keep) { $label = "keep-$label" }
        $op = Invoke-Bridge save_checkpoint @{ label = $label }
        $r = Wait-BridgeOperation $op.id
        "save: $($r.status) $($r.saveName)"
        if ($r.status -eq 'complete' -and !$keep) { $x = Clear-BridgeRollingSaves -KeepNewest 1; if ($x.recycled) { "recycled $($x.recycled.Count) older bridge save(s)" } }
    }
    'prefab' {
        $kind = if ($pos.Count -gt 1) { $pos[1] } else { 'all' }
        $p = Resolve-BridgePrefab $pos[0] $kind; "prefab: $($pos[0]) index $($p.index) version $($p.version) placeable $($p.placeable)"
    }
    'raw' {
        $json = if ($pos.Count -gt 1) { $pos[1] } else { '{}' }
        $r = Invoke-Bridge $pos[0] $json
        if (Opt 'full' $false) { $r | ConvertTo-Json -Depth 30 -Compress } else { $r | ConvertTo-BridgeLean | ConvertTo-Json -Depth 30 -Compress }
    }
    default { "unknown verb '$Verb' (play.ps1 help)" }
}
