#requires -Version 7.0
# City health watch: one compact line (+ journals/status.json) from the game's own
# diagnostics, with ALERT tags when something needs action. Autoplay calls it after every
# simulation interval; it pauses the game (analysis), so never call it during a run.
param([string]$StatusPath = (Join-Path $PSScriptRoot 'journals\status.json'))
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
$d = Invoke-Bridge get_city_diagnostics
$ui = Invoke-Bridge get_ui_state @{ chirps = 8 }
$c = $d.city; $alerts = @()

# Happiness: the three most negative factors (native effect units; < -5 is notable).
$hf = @($d.happinessFactors.PSObject.Properties | Where-Object { $_.Value.effect -is [ValueType] -and !$_.Value.locked } |
    ForEach-Object { [pscustomobject]@{ n = $_.Name; e = [Math]::Round([double]$_.Value.effect, 1) } } | Sort-Object e | Select-Object -First 3)
foreach ($f in $hf) { if ($f.e -le -5) { $alerts += "unhappy:$($f.n)" } }
$pd = $d.populationDetails
$unemp = [Math]::Round([double]$pd.unemploymentRateNative, 1); $homeless = [int]$pd.homelessCitizens
if ($unemp -gt 10) { $alerts += "unemployment ${unemp}%" }
if ($homeless -gt 20) { $alerts += "homeless $homeless" }
# Persistent shortages by type, and service buildings running below full efficiency.
$short = @($d.persistentShortages | ForEach-Object { $_.shortages } | ForEach-Object { $_.type } | Group-Object | Sort-Object Count -Descending | ForEach-Object { "$($_.Name) $($_.Count)" })
if (@($d.persistentShortages).Count -gt 10) { $alerts += "shortages $(@($d.persistentShortages).Count)" }
$eff = @($d.efficiencyPenalties | ForEach-Object { $_.penalties } | ForEach-Object { $_.factor } | Group-Object | Sort-Object Count -Descending | Select-Object -First 2 | ForEach-Object { "$($_.Name) $($_.Count)" })
$u = $d.utilitiesRaw
function Pct($a, $b) { if ([double]$b -gt 0) { [Math]::Round(100 * [double]$a / [double]$b) } else { 0 } }
$elec = Pct $u.electricity.production $u.electricity.capacity; $wat = Pct $u.water.production $u.water.capacity; $sew = Pct $u.sewage.processing $u.sewage.capacity
if ($elec -gt 85) { $alerts += "power ${elec}%" }; if ($wat -gt 85) { $alerts += "water ${wat}%" }; if ($sew -gt 85) { $alerts += "sewage ${sew}%" }
# What citizens complain about (keyword buckets over the newest chirps).
$topics = [ordered]@{ health = 'health|sick|doctor|hospital|clinic'; deathcare = 'hearse|cemetery|dead'; fire = 'fire|burn'; crime = 'crime|police|robb|theft'; garbage = 'garbage|trash'; education = 'school|education'; traffic = 'traffic|jam|commute'; noise = 'noise|noisy'; pollution = 'pollut|smog|dirty'; housing = 'home|house|rent'; jobs = 'job|work|unemploy'; power = 'electric|power|blackout'; water = 'water|sewage' }
$said = @($ui.chirps | ForEach-Object { "$($_.text)" }) -join ' '
$complaints = @($topics.Keys | Where-Object { $said -match $topics[$_] })
if ($ui.likelyBlocker -and $ui.likelyBlocker -notin 'none', 'paused_by_player_or_bridge') { $alerts += "ui:$($ui.likelyBlocker)" }

$status = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); city = $c.cityName; population = $c.population; money = $c.money; net = $d.budget.balanceRaw
    happiness = $c.averageHappiness; health = $c.averageHealth; milestone = $ui.milestone.achieved; xpToNext = $ui.milestone.xpToNext
    unemployment = $unemp; homeless = $homeless; worstHappiness = $hf; shortages = $short; efficiency = $eff
    utilities = [ordered]@{ power = $elec; water = $wat; sewage = $sew }; complaints = $complaints; alerts = $alerts }
New-Item -ItemType Directory -Force -Path (Split-Path $StatusPath) | Out-Null
$status | ConvertTo-Json -Depth 5 | Set-Content $StatusPath
"watch: pop $($c.population) happy $($c.averageHappiness) health $($c.averageHealth) | unemp ${unemp}% homeless $homeless | worst " + (($hf | ForEach-Object { "$($_.n) $($_.e)" }) -join ', ') +
    " | util P${elec}/W${wat}/S${sew}% | short " + $(if ($short) { $short -join ', ' } else { 'none' }) + $(if ($eff) { " | eff " + ($eff -join ', ') } else { '' }) +
    $(if ($complaints) { " | complaints " + ($complaints -join ',') } else { '' }) + $(if ($alerts) { " | ALERT " + ($alerts -join '; ') } else { '' })
