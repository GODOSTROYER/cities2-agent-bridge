#requires -Version 7.0
# Adds missing city services where citizens actually live. One call places at most
# -MaxPlacements buildings and prints one line per action; autoplay calls it each cycle.
#  - Coverage: homes farther than a service's radius from every existing building of
#    that type are "uncovered"; if they exceed -UncoveredShare, a new building goes at
#    their centroid (so new districts get their own clinic/fire/police/school).
#  - Population minimums cover small cities (e.g. one cemetery from 500 residents).
#  - Citizen complaints (chirps) move the matching service to the front of the queue.
param(
    [long]$MinCash = 250000,
    [int]$MaxPlacements = 2,
    [ValidateRange(0.01, 1)][double]$UncoveredShare = 0.15,
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
$play = Join-Path $PSScriptRoot 'play.ps1'

# type: existing-building regex, prefab to place, coverage radius (m), min population
# for the first one, chirp keywords that signal a shortage.
$rules = @(
    @{ t = 'health';    rx = '^(MedicalClinic|Hospital)';                 prefab = 'MedicalClinic01,MedicalClinic02';    r = 1100;  minPop = 300;  chirp = 'health|sick|doctor|clinic|hospital|medical' ; cov = 'Healthcare' }
    @{ t = 'deathcare'; rx = '^(Cemetery|Crematorium)';                   prefab = 'Cemetery01,Cemetery02,Crematorium01';         r = 99999; minPop = 500;  chirp = 'hearse|dead|cemetery|funeral|deceased' }
    @{ t = 'fire';      rx = '^(FireHouse|RS_FireHouse|FireStation)';     prefab = 'FireHouse01,FireHouse02';        r = 1100;  minPop = 600;  chirp = 'fire|burn|flame' ; cov = 'FireRescue' }
    @{ t = 'police';    rx = '^(PoliceStation|RS_PoliceStation|CCP5_PoliceStation)'; prefab = 'PoliceStation01,PoliceStation02'; r = 1000; minPop = 800; chirp = 'crime|police|robbed|theft|safe' ; cov = 'Police' }
    @{ t = 'school';    rx = '^ElementarySchool';                         prefab = 'ElementarySchool01,ElementarySchool02'; r = 1200;  minPop = 600;  chirp = 'school|education|kids' ; cov = 'Education' }
    @{ t = 'highschool'; rx = '^HighSchool';                            prefab = 'HighSchool01,HighSchool02'; r = 2000;  minPop = 2500; chirp = 'high school|teen' }
    @{ t = 'post';      rx = '^(PostOffice|PostSorting)';                 prefab = 'PostOffice01,PostOffice02'; r = 1500; minPop = 1500; chirp = 'mail|post|letter|parcel' ; cov = 'PostService' }
    @{ t = 'hospital';  rx = '^Hospital';                                 prefab = 'Hospital01';          r = 99999; minPop = 6000; chirp = 'hospital' }
    @{ t = 'garbage';   rx = '^(Landfill|Incinerat|Recycling)';           prefab = 'Landfill01,IncinerationPlant01';         r = 99999; minPop = 1000; chirp = 'garbage|trash|waste' }
)
$skip = 'Ruins|Upgrade|Extension|Wing|Sub0'

$m = Invoke-Bridge get_city_management
$pop = [int]$m.city.population; $money = [double]$m.city.money
# Below MinCash only critical utilities (power/water/sewage) may still be built.
$utilitiesOnly = $money -lt $MinCash -and !$Plan
if ($utilitiesOnly -and $money -lt 60000) { "services: skipped (cash $([int]$money) too low even for utilities)"; return }
# Upkeep discipline: every building adds permanent upkeep. While the city loses money,
# only services citizens are actively complaining about may be added (and power/water).
$net = [double]$m.budget.balanceRaw
$affordable = $net -ge 0
$all = @(Get-BridgePaged get_buildings @{ limit = 4096 } | Where-Object { "$($_.prefab)" -notmatch $skip } |
    ForEach-Object { [pscustomobject]@{ p = "$($_.prefab)"; x = $_.position.x; z = $_.position.z } })
$homes = @($all | Where-Object { $_.p -match 'Residential' })
$industry = @($all | Where-Object { $_.p -match 'Industrial' })
$complaints = @((Invoke-Bridge get_ui_state @{ chirps = 10 }).chirps | ForEach-Object { "$($_.text)" }) -join ' '
function Test-Near($a, $b, $r) { [Math]::Pow($a.x - $b.x, 2) + [Math]::Pow($a.z - $b.z, 2) -le $r * $r }

$needs = foreach ($rule in $rules) {
    if ($pop -lt $rule.minPop) { continue }
    $have = @($all | Where-Object { $_.p -match $rule.rx })
    # Phase 2: the game's own per-road coverage (coverage_gaps) when the mod has it;
    # distance-to-building only as a fallback.
    $gap = if ($rule.cov) { Invoke-Bridge coverage_gaps @{ service = $rule.cov; top = 1 } -AllowError } else { $null }
    if ($gap.ok) {
        $share = [double]$gap.result.uncoveredPct / 100
        $uncovered = @($gap.result.gapClusters | ForEach-Object { [pscustomobject]@{ x = [double]$_.x; z = [double]$_.z } })
    } else {
        $uncovered = @($homes | Where-Object { $h = $_; -not @($have | Where-Object { Test-Near $_ $h $rule.r }).Count })
        $share = if ($homes.Count) { $uncovered.Count / $homes.Count } else { 0 }
    }
    $missing = !$have.Count -or ($rule.r -lt 99999 -and $share -gt $UncoveredShare)
    if (!$missing) { continue }
    $complained = $complaints -match $rule.chirp
    if (!$affordable -and !$complained) { continue }   # cannot afford new upkeep yet
    $target = if ($rule.t -eq 'garbage' -and $industry) { $industry } elseif ($uncovered) { $uncovered } else { $homes }
    $cx = ($target.x | Measure-Object -Average).Average; $cz = ($target.z | Measure-Object -Average).Average
    [pscustomobject]@{ t = $rule.t; prefab = $rule.prefab; x = [Math]::Round($cx); z = [Math]::Round($cz); have = $have.Count; uncovered = [Math]::Round($share * 100); complained = [bool]$complained }
}
# Utilities: capacity triggers (supply above 70% of capacity, power imports, or
# widespread shortfall reports), placed near the existing facilities of that kind.
$wf = @((Invoke-Bridge get_water_facilities).facilities)
$pumps = @($wf | Where-Object waterProducer); $outlets = @($wf | Where-Object sewageOutlet)
$wUse = if ($pumps) { ($pumps.waterProducer.lastProductionRaw | Measure-Object -Sum).Sum / [Math]::Max(1, ($pumps.waterProducer.capacityRaw | Measure-Object -Sum).Sum) } else { 1 }
$sUse = if ($outlets) { ($outlets.sewageOutlet.lastProcessedRaw | Measure-Object -Sum).Sum / [Math]::Max(1, ($outlets.sewageOutlet.capacityRaw | Measure-Object -Sum).Sum) } else { 1 }
$problems = @(Get-BridgePaged diagnose_connections @{ limit = 4096 })
$powerShort = @($problems | Where-Object { $_.issues -contains 'electricity_shortfall' }).Count
$importing = [double]$m.budget.expenseBySourceRaw.ImportElectricity -gt 0
# City use vs production from the non-pausing snapshot (plants run flat out when exporting; FAILURES #33).
$snap = try { Invoke-Bridge get_snapshot } catch { $null }
$powerLoad = if ($snap.util.power) { [double]$snap.util.power.pct } else { 0 }
if ($snap.util.power.import -gt 0) { $importing = $true }
if ($powerLoad -gt 85) { $importing = $true }   # build before blackouts, not after
$powerSites = @($all | Where-Object { $_.p -match 'Power|WindTurbine|Transformer' })
$anchor = { param($set) if ($set) { [pscustomobject]@{ x = [Math]::Round(($set.x | Measure-Object -Average).Average); z = [Math]::Round(($set.z | Measure-Object -Average).Average) } } else { [pscustomobject]@{ x = [Math]::Round(($homes.x | Measure-Object -Average).Average); z = [Math]::Round(($homes.z | Measure-Object -Average).Average) } } }
if ($importing -or ($homes.Count -and $powerShort / [double]$all.Count -gt 0.05)) { $a = & $anchor $powerSites; $needs = @($needs) + [pscustomobject]@{ t = 'power'; prefab = 'WindTurbine01,SmallCoalPowerPlant01,SolarPowerStation01'; x = $a.x; z = $a.z; have = $powerSites.Count; uncovered = 0; complained = $true; note = "importing=$importing shortfall=$powerShort" } }
if ($wUse -gt 0.7) { $a = & $anchor $pumps.position; $needs = @($needs) + [pscustomobject]@{ t = 'water'; prefab = 'GroundwaterPumpingStation01,WaterTower01,WaterPumpingStation01'; x = $a.x; z = $a.z; have = $pumps.Count; uncovered = 0; complained = $true; note = "water at $([Math]::Round($wUse * 100))%" } }
if ($sUse -gt 0.7) { $a = & $anchor $outlets.position; $needs = @($needs) + [pscustomobject]@{ t = 'sewage'; prefab = 'SewageOutlet01'; x = $a.x; z = $a.z; have = $outlets.Count; uncovered = 0; complained = $true; note = "sewage at $([Math]::Round($sUse * 100))%" } }
if ($utilitiesOnly) { $needs = @($needs | Where-Object { $_.t -in 'power', 'water', 'sewage' }); if (!$needs) { "services: cash $([int]$money) below $MinCash; no critical utility needed"; return } }
$needs = @($needs | Sort-Object @{ e = { if ($_.complained) { 0 } else { 1 } } }, @{ e = { if ($_.have) { 1 } else { 0 } } }, @{ e = 'uncovered'; Descending = $true })
if (!$needs) { "services: all adequate (pop $pop)"; return }
$placed = 0
foreach ($n in $needs) {
    $why = "have $($n.have), $($n.uncovered)% homes uncovered" + $(if ($n.complained) { ', citizens complaining' } else { '' })
    if ($Plan) { "services(plan): $($n.t) $($n.prefab) at $($n.x),$($n.z) ($why)"; continue }
    if ($placed -ge $MaxPlacements) { "services: $($n.t) still needed ($why)"; continue }
    if ($n.note) { $why = $n.note }
    $results = @()
    foreach ($prefab in ($n.prefab -split ',')) {
        $out = @(& $play place $prefab -X $n.x -Z $n.z -R 450 -Max 300000 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -like 'place:*' -and $_ -notlike 'place: lot*' -or $_ -match 'locked|not found|not placeable' })
        $results += ($out -join '; ')
        if ($out -match 'cost') { $placed++; break }   # placed
        if (!($out -match 'locked|not found|not placeable')) { break }   # a real placement failure: report, do not try other types
    }
    "services: $($n.t) ($why) -> " + ($results -join ' | ')
}
