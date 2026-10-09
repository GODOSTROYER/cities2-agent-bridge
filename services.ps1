#requires -Version 7.0
# Adds missing basic services (police, fire, clinic, school, landfill) near the homes that
# lack coverage. One call per autoplay cycle; prints one line per action.
#   services.ps1 [-MinCash 300000] [-MaxPlacements 2] [-Plan]
param([long]$MinCash = 300000, [int]$MaxPlacements = 2, [switch]$Plan)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
$play = Join-Path $PSScriptRoot 'play.ps1'

$city = (Invoke-Bridge get_city_management).city
$pop = [long]$city.population
if ([long]$city.money -lt $MinCash) { 'services: skipped (cash below MinCash)'; return }

$all = @(Get-BridgePaged get_buildings @{ limit = 4096 })
$ignore = 'Ruins|Upgrade|Extension|Wing|Sub0'
function ConvertTo-Pt($b) { [pscustomobject]@{ x = [double]$b.position.x; z = [double]$b.position.z } }
$homes = @($all | Where-Object { "$($_.prefab)" -match 'Residential' } | ForEach-Object { ConvertTo-Pt $_ })

# detect: regex for existing buildings of this service; need: count the population calls for.
$rules = [ordered]@{
    police   = @{ detect = '^(PoliceStation|RS_PoliceStation|CCP5_PoliceStation)'; prefab = 'PoliceStation01'; spacing = 900
                  need = { param($p) if ($p -ge 800) { [Math]::Max(1, [int][Math]::Floor($p / 4000)) } else { 0 } } }
    fire     = @{ detect = '^(FireHouse|RS_FireHouse)'; prefab = 'FireHouse01'; spacing = 1000
                  need = { param($p) if ($p -ge 800) { [Math]::Max(1, [int][Math]::Floor($p / 5000)) } else { 0 } } }
    clinic   = @{ detect = '^MedicalClinic'; prefab = 'MedicalClinic01'; spacing = 1000
                  need = { param($p) [int][Math]::Floor($p / 6000) } }
    school   = @{ detect = '^ElementarySchool'; prefab = 'ElementarySchool01'; spacing = 900
                  need = { param($p) [int][Math]::Floor($p / 4000) } }
    landfill = @{ detect = '^Landfill'; prefab = 'Landfill01'; spacing = 0
                  need = { param($p) [int]($p -ge 1000) } }
}

function Get-Existing($r) {
    @($all | Where-Object { "$($_.prefab)" -match $r.detect -and "$($_.prefab)" -notmatch $ignore } | ForEach-Object { ConvertTo-Pt $_ })
}
function Get-Dist($p, $pts) {
    $best = [double]::MaxValue
    foreach ($q in $pts) { $d = [Math]::Sqrt([Math]::Pow($p.x - $q.x, 2) + [Math]::Pow($p.z - $q.z, 2)); if ($d -lt $best) { $best = $d } }
    $best
}
function Get-Centroid($pts) {
    if (!$pts) { return $null }
    [pscustomobject]@{ x = ($pts.x | Measure-Object -Average).Average; z = ($pts.z | Measure-Object -Average).Average }
}
# Landfill sits at the industrial centroid. Other services go to the centroid of the homes
# farthest from existing coverage (all homes when every home is already within spacing).
function Get-Anchor($type, $r, $existing) {
    if ($type -eq 'landfill') { return Get-Centroid @($all | Where-Object { "$($_.prefab)" -match 'Industrial' } | ForEach-Object { ConvertTo-Pt $_ }) }
    $far = @($homes | Where-Object { !$existing -or (Get-Dist $_ $existing) -gt $r.spacing })
    if (!$far) { $far = $homes }
    Get-Centroid $far
}

$placed = 0; $needed = $false
foreach ($type in $rules.Keys) {
    if (!$Plan -and $placed -ge $MaxPlacements) { break }
    $r = $rules[$type]
    $existing = @(Get-Existing $r)
    $need = [Math]::Max(0, [int](& $r.need $pop) - $existing.Count)
    if ($need -eq 0) { continue }
    $needed = $true

    if ($Plan) {
        $a = Get-Anchor $type $r $existing
        if (!$a) { if ($type -eq 'landfill') { 'landfill: no industrial area yet' } else { "services(plan): no homes to anchor $type" }; continue }
        "services(plan): $type at $([int][Math]::Round($a.x)),$([int][Math]::Round($a.z)) (have $($existing.Count), need $need)"
        continue
    }

    for ($k = 0; $k -lt $need -and $placed -lt $MaxPlacements; $k++) {
        $a = Get-Anchor $type $r $existing   # recomputed so each new site moves the next target
        if (!$a) { if ($type -eq 'landfill') { 'landfill: no industrial area yet' } else { "services: no homes to anchor $type" }; break }
        $x = [int][Math]::Round($a.x); $z = [int][Math]::Round($a.z)
        try { $lines = @(& $play place $r.prefab -X $x -Z $z -R 400 -Max 250000 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -like 'place:*' }) }
        catch { $lines = @("place: ERROR $($type): $($_.Exception.Message)") }
        $lines
        $ok = @($lines | Where-Object { $_ -match '^place: \S+ at ' }).Count -gt 0
        if (!$ok) { break }   # a failed site is not retried this cycle; move to the next service
        $placed++; $existing += [pscustomobject]@{ x = $x; z = $z }
    }
}

if (!$needed) { "services: all basic services adequate (pop $pop)" }
elseif (!$Plan) { "services: placed $placed (max $MaxPlacements)" }
