#requires -Version 7.0
# Token-efficient front end for agents. Every verb prints a few dense lines; raw bridge
# JSON (often kilobytes per call) never reaches the agent unless asked for with `raw`.
#   play.ps1 help
param(
    [Parameter(Position = 0)][string]$Verb = 'help',
    [Parameter(Position = 1, ValueFromRemainingArguments)][string[]]$Rest = @()
)
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

$Zones = @{ res = 'NA Residential Low'; com = 'NA Commercial Low'; ind = 'Industrial Manufacturing'; off = 'Office'; resmed = 'NA Residential Medium Row' }

function Show-Ui {
    $ui = Try-Bridge get_ui_state
    if (!$ui) { $ui = Try-Bridge get_pause_state }
    if (!$ui) { return 'ui: n/a (mod < 0.5.1)' }
    $bits = @("speed $($ui.selectedSpeed)")
    if ($ui.likelyBlocker -and $ui.likelyBlocker -ne 'none') { $bits += "PAUSED BY $($ui.likelyBlocker)" + $(if ($ui.resolvableByBridge) { ' (play fix)' } else { '' }) }
    if ($ui.screen) { $bits += "screen $($ui.screen)" }
    if ($ui.activePanel) { $bits += "panel $($ui.activePanel)" }
    if ($ui.tutorial.activeTutorialPhase) { $bits += "tutorial '$($ui.tutorial.activeTutorialPhase)'" }
    if ($ui.milestone.pending) { $bits += "milestone popup '$($ui.milestone.pending)'" }
    if ($ui.dialogs) { $bits += "dialogs " + (($ui.dialogs | ForEach-Object { $_.title ?? $_.type }) -join '; ') }
    if ($ui.activeTool -and $ui.activeTool -ne 'DefaultToolSystem') { $bits += "tool $($ui.activeTool)" }
    if ($ui.infoview) { $bits += "infoview $($ui.infoview)" }
    if ($ui.hasFocus -eq $false) { $bits += 'window unfocused' }
    if ($ui.chirps) { $bits += "chirps: " + (($ui.chirps | Select-Object -First 2 | ForEach-Object { $_.text }) -join ' | ') }
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

# Empty, dry, flat, owned land near existing roads where a cols x rows grid fits.
function Find-Sites([int]$cols, [int]$rows, [double]$bw, [double]$bd, [int]$count) {
    $w = $cols * $bw; $dpt = $rows * $bd
    $tiles = @((Invoke-Bridge get_tiles).tiles | Where-Object purchased | ForEach-Object {
        $xs = $_.polygon.x; $zs = $_.polygon.z
        [pscustomobject]@{ x0 = ($xs | Measure-Object -Minimum).Minimum; x1 = ($xs | Measure-Object -Maximum).Maximum; z0 = ($zs | Measure-Object -Minimum).Minimum; z1 = ($zs | Measure-Object -Maximum).Maximum } })
    function Owned($x, $z) { foreach ($t in $tiles) { if ($x -ge $t.x0 -and $x -le $t.x1 -and $z -ge $t.z0 -and $z -le $t.z1) { return $true } }; $false }
    $X0 = ($tiles.x0 | Measure-Object -Minimum).Minimum; $X1 = ($tiles.x1 | Measure-Object -Maximum).Maximum
    $Z0 = ($tiles.z0 | Measure-Object -Minimum).Minimum; $Z1 = ($tiles.z1 | Measure-Object -Maximum).Maximum
    $cx = ($X0 + $X1) / 2; $cz = ($Z0 + $Z1) / 2
    $obstacles = [Collections.Generic.List[object]]::new()
    foreach ($b in @(Get-BridgePaged get_buildings @{ limit = 4096 })) { $obstacles.Add(@($b.position.x, $b.position.z)) }
    $edges = (Invoke-Bridge get_network_edges @{ x = $cx; z = $cz; radius = 2000 }).edges
    foreach ($e in $edges) { foreach ($pt in $e.curve) { $obstacles.Add(@($pt.x, $pt.z)) }
        for ($t = 0.25; $t -lt 1; $t += 0.25) { $obstacles.Add(@(($e.curve[0].x * (1 - $t) + $e.curve[-1].x * $t), ($e.curve[0].z * (1 - $t) + $e.curve[-1].z * $t))) } }
    $nodes = @($edges | Where-Object { $_.prefab -match '^(?!Highway).*Road' } | ForEach-Object { $_.curve[0]; $_.curve[-1] })
    $margin = 24
    $cands = foreach ($x in ([int]$X0)..([int]($X1 - $w)) | Where-Object { ($_ - [int]$X0) % 40 -eq 0 }) {
        foreach ($z in ([int]$Z0)..([int]($Z1 - $dpt)) | Where-Object { ($_ - [int]$Z0) % 40 -eq 0 }) {
            if (!(Owned $x $z) -or !(Owned ($x + $w) $z) -or !(Owned $x ($z + $dpt)) -or !(Owned ($x + $w) ($z + $dpt))) { continue }
            $hit = $false
            foreach ($o in $obstacles) { if ($o[0] -gt $x - $margin -and $o[0] -lt $x + $w + $margin -and $o[1] -gt $z - $margin -and $o[1] -lt $z + $dpt + $margin) { $hit = $true; break } }
            if ($hit) { continue }
            $best = [double]::MaxValue
            foreach ($n in $nodes) { $dx = [Math]::Max([Math]::Max($x - $n.x, 0), $n.x - ($x + $w)); $dz = [Math]::Max([Math]::Max($z - $n.z, 0), $n.z - ($z + $dpt)); $best = [Math]::Min($best, [Math]::Sqrt($dx * $dx + $dz * $dz)) }
            if ($best -le 400) { [pscustomobject]@{ x = $x; z = $z; link = [Math]::Round($best) } }
        } }
    $cands = @($cands | Sort-Object link | Select-Object -First 40)
    if (!$cands) { return @() }
    # Terrain check on the closest candidates: 9 points each, one bridge call.
    $pts = foreach ($c in $cands) { foreach ($fx in 0, 0.5, 1) { foreach ($fz in 0, 0.5, 1) { @{ x = $c.x + $fx * $w; z = $c.z + $fz * $dpt } } } }
    $sr = Invoke-Bridge sample_terrain @{ points = @($pts) }; $s = @($sr.(Get-ResultArrayName $sr))
    $out = @(); $k = 0
    foreach ($c in $cands) {
        $grp = $s[$k..($k + 8)]; $k += 9
        $h = $grp.position.y; $wet = @($grp | Where-Object { $_.waterDepth -gt 0.1 }).Count
        $relief = ($h | Measure-Object -Maximum).Maximum - ($h | Measure-Object -Minimum).Minimum
        if ($wet -eq 0 -and $relief -le 15) { $out += [pscustomobject]@{ x = $c.x; z = $c.z; link = $c.link; relief = [Math]::Round($relief, 1) } }
        if ($out.Count -ge $count) { break }
    }
    $out
}

function Invoke-Grid([double]$x, [double]$z, [int]$cols, [int]$rows, [string]$zoneKey, [bool]$plan) {
    $zone = Resolve-BridgePrefab $Zones[$zoneKey] 'zone'
    $road = Resolve-BridgePrefab 'Small Road' 'network'
    $a = @{ X = $x; Z = $z; Columns = $cols; Rows = $rows; RoadPrefabIndex = $road.index; RoadPrefabVersion = $road.version; ZonePrefabIndex = $zone.index; ZonePrefabVersion = $zone.version }
    if ($plan) { $a.PlanOnly = $true }
    & (Join-Path $H 'grid.ps1') @a *>&1 | ForEach-Object { "$_" } |
        Where-Object { $_ -match '^(Plan |Batch|Grid connected|PlanOnly|Failed|zone:)' -or $_ -match 'rror|: ready' } | ForEach-Object { $_ -replace '\s{2,}', ' ' }
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
  grow [-Cols 3 -Rows 2 -Plan]      pick zone by demand, find site, build grid
  zone -X x -Z z [-R 300 -Zone res] zone all zonable cells in area
  run [-Seconds 600 -Speed 4 -Floor 150000]   bounded simulation, auto-fixes tutorials
  save [label]               checkpoint + verify
  prefab <name> [kind]       resolve name -> index (cached)
  raw <command> [json]       bridge call, noisy fields stripped (add -Full for all)
'@
    }
    'look' { Show-Look }
    'ui' { Show-Ui }
    'fix' {
        $n = 0
        while ($n -lt 10) {
            $ui = Try-Bridge get_ui_state; if (!$ui) { $ui = Try-Bridge get_pause_state }
            if (!$ui) { 'fix: needs mod 0.5.1+'; break }
            if (!$ui.resolvableByBridge) { "fix: nothing safe to resolve (blocker: $($ui.likelyBlocker))"; break }
            $arg = if ($ui.likelyBlocker -eq 'milestone_popup') { @{ action = 'dismiss_milestone'; expectedMilestone = [string]$ui.milestone.pending } } else { @{ action = 'complete_tutorial_phase'; expectedPhase = [string]$ui.tutorial.activeTutorialPhase } }
            $r = Invoke-Bridge resolve_pause_blocker $arg
            "fix: $($arg.action) -> $($r.completedPhase ?? $r.dismissed)"; $n++
            Start-Sleep -Milliseconds 1200
        }
        Show-Ui
    }
    'sites' {
        $cols = [int](Opt 'cols' 3); $rows = [int](Opt 'rows' 2)
        $found = Find-Sites $cols $rows 110 110 ([int](Opt 'n' 3))
        if (!$found) { "sites: none for ${cols}x${rows} (try smaller, or buy tiles)" }
        foreach ($s in $found) { "site: -X $($s.x) -Z $($s.z) -Cols $cols -Rows $rows   link $($s.link)m relief $($s.relief)m" }
    }
    'grid' { Invoke-Grid ([double](Opt 'x' $null)) ([double](Opt 'z' $null)) ([int](Opt 'cols' 3)) ([int](Opt 'rows' 2)) (Opt 'zone' 'res') ([bool](Opt 'plan' $false)) }
    'grow' {
        $d = (Invoke-Bridge get_city_management).demand
        $choices = @(@{ k = 'res'; v = [double]@($d.residential)[0] }, @{ k = 'com'; v = [double]$d.commercial }, @{ k = 'ind'; v = [double]$d.industrial }) | Sort-Object { $_.v } -Descending
        $pick = $null
        foreach ($c in $choices) { try { $null = Resolve-BridgePrefab $Zones[$c.k] 'zone'; $pick = $c; break } catch {} }
        if (!$pick -or $pick.v -lt 20) { "grow: demand too low (R $(@($d.residential)[0]) C $($d.commercial) I $($d.industrial)); simulate instead"; break }
        $cols = [int](Opt 'cols' 3); $rows = [int](Opt 'rows' 2)
        $site = Find-Sites $cols $rows 110 110 1 | Select-Object -First 1
        if (!$site) { "grow: no free site for ${cols}x${rows}"; break }
        "grow: zone $($pick.k) (demand $($pick.v)) at -X $($site.x) -Z $($site.z)"
        Invoke-Grid $site.x $site.z $cols $rows $pick.k ([bool](Opt 'plan' $false))
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
    'save' {
        $label = if ($pos) { $pos[0] } else { 'agent-' + (Get-Date -Format 'HHmm') }
        $op = Invoke-Bridge save_checkpoint @{ label = $label }
        $r = Wait-BridgeOperation $op.id
        "save: $($r.status) $($r.saveName)"
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
