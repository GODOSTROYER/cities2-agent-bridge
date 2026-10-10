# Offline regression tests for the harness. Pure helpers only: no bridge calls, no game,
# no writes to the game mailbox. Run: pwsh -NoProfile -File tests\HarnessTests.ps1
# Exit 0 = every test passed, 1 = at least one failed.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\lib\BridgeClient.psm1') -Force
$repo = Split-Path $PSScriptRoot
$script:Ran = 0
$script:Failed = 0

function Assert-That([bool]$Condition, [string]$Detail) { if (-not $Condition) { throw $Detail } }

function Invoke-HarnessTest {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    $script:Ran++
    try { & $Body; Write-Output "PASS: $Name" }
    catch { $script:Failed++; Write-Output "FAIL: $Name - $($_.Exception.Message)" }
}

# Same shape Get-BridgeOccupancy builds, constructed by hand so no get_city_map call happens.
function New-TestOccupancy {
    [pscustomobject]@{ MinX = 0; MinZ = 0; Cell = 4; W = 100; H = 100; Grid = (New-Object 'byte[,]' 100, 100); Buildings = 0; Edges = 0 }
}
function New-Pt([double]$X, [double]$Z) { [pscustomobject]@{ x = $X; z = $Z } }
function New-RotatedRect([double]$Cx, [double]$Cz, [double]$HalfU, [double]$HalfV, [double]$Angle) {
    $c = [Math]::Cos($Angle); $s = [Math]::Sin($Angle)
    foreach ($corner in @(@(-1, -1), @(1, -1), @(1, 1), @(-1, 1))) {
        $u = $corner[0] * $HalfU; $v = $corner[1] * $HalfV
        New-Pt ($Cx + $u * $c - $v * $s) ($Cz + $u * $s + $v * $c)
    }
}
function New-LotSquare { @((New-Pt 100 100), (New-Pt 140 100), (New-Pt 140 140), (New-Pt 100 140)) }

# 1a. Axis-aligned lot polygon
Invoke-HarnessTest 'occupancy: square lot blocks its own rect, open rect is free' {
    $occ = New-TestOccupancy
    Set-OccupancyPolygon $occ (New-LotSquare)
    Assert-That (-not (Test-OccupancyRectFree $occ 100 100 140 140)) 'lot rect 100..140 reported free'
    Assert-That (Test-OccupancyRectFree $occ 300 300 340 340) 'open rect 300..340 reported blocked'
}

# 1b. Rotated rectangle
Invoke-HarnessTest 'occupancy: 45-degree rectangle occupies centre, point 60 m away is free' {
    $occ = New-TestOccupancy
    Set-OccupancyPolygon $occ @(New-RotatedRect 200 200 20 10 ([Math]::PI / 4))
    Assert-That (-not (Test-OccupancyRectFree $occ 199 199 201 201 0)) 'centre of rotated rect reported free'
    Assert-That (Test-OccupancyRectFree $occ 259 199 261 201 0) 'point 60 m from centre reported blocked'
}

# 1c. Roads block sites but not connectors; lots block connectors
Invoke-HarnessTest 'occupancy: road blocks sites, not connectors; lot blocks connectors' {
    $occ = New-TestOccupancy
    Set-OccupancyPolygon $occ (New-LotSquare)
    Set-OccupancySegment $occ (New-Pt 0 300) (New-Pt 400 300) 8
    Assert-That (-not (Test-OccupancyRectFree $occ 150 290 170 310)) 'rect straddling road reported free'
    Assert-That (Test-OccupancySegmentFree $occ (New-Pt 200 250) (New-Pt 200 350)) 'connector crossing road reported blocked'
    Assert-That (-not (Test-OccupancySegmentFree $occ (New-Pt 120 60) (New-Pt 120 180))) 'connector crossing lot reported free'
}

# 1d. Bounds
Invoke-HarnessTest 'occupancy: rect partly outside grid returns false' {
    $occ = New-TestOccupancy
    Assert-That (-not (Test-OccupancyRectFree $occ 390 390 420 420 0)) 'rect past max bound reported free'
    Assert-That (-not (Test-OccupancyRectFree $occ -10 -10 20 20 0)) 'rect below min bound reported free'
    Assert-That (Test-OccupancyRectFree $occ 10 10 20 20 0) 'in-bounds empty rect reported blocked'
}

# 2. ConvertTo-BridgeLean
$lean = $null; $leanKept = $null
$leanInput = [pscustomobject]@{
    name       = 'x'
    value      = 3.14159
    components = @(1, 2)
    curve      = @((New-Pt 0 0), (New-Pt 1 1))
    polygon    = @((New-Pt 0 0))
    child      = [pscustomobject]@{ rotationQuaternion = [pscustomobject]@{ x = 0.1; y = 0.2; z = 0.3; w = 0.9 }; keep = 'yes' }
}
Invoke-HarnessTest 'lean: drops noisy keys, keeps name, rounds doubles to 1 dp' {
    $lean = ConvertTo-BridgeLean -InputObject $leanInput
    $top = @($lean.PSObject.Properties.Name)
    foreach ($noisy in 'components', 'curve', 'polygon') {
        Assert-That ($top -notcontains $noisy) "top-level '$noisy' not removed"
    }
    Assert-That ($lean.name -eq 'x') "name was '$($lean.name)'"
    Assert-That ($lean.value -eq 3.1) "value was '$($lean.value)', expected 3.1"
    Assert-That (@($lean.child.PSObject.Properties.Name) -notcontains 'rotationQuaternion') 'nested rotationQuaternion not removed'
    Assert-That ($lean.child.keep -eq 'yes') 'nested non-noisy key lost'
}
Invoke-HarnessTest 'lean: -Keep curve retains curve' {
    $leanKept = ConvertTo-BridgeLean -InputObject $leanInput -Keep 'curve'
    Assert-That (@($leanKept.PSObject.Properties.Name) -contains 'curve') 'curve dropped despite -Keep curve'
    Assert-That (@($leanKept.PSObject.Properties.Name) -notcontains 'polygon') 'polygon kept without -Keep polygon'
}

# 3. Get-ResultArrayName
Invoke-HarnessTest 'result array name: picks the array property' {
    $r = [pscustomobject]@{ total = 5; buildings = @(1, 2) }
    $name = Get-ResultArrayName $r
    Assert-That ($name -eq 'buildings') "got '$name'"
}

# 4. play.ps1 argument binding (static only; play.ps1 is never run)
Invoke-HarnessTest 'play.ps1: no top-level param block before $Verb assignment' {
    $play = Get-Content -LiteralPath (Join-Path $repo 'play.ps1') -Raw
    $verbAt = $play.IndexOf('$Verb =')
    Assert-That ($verbAt -gt 0) 'no $Verb = assignment found'
    $head = $play.Substring(0, $verbAt)
    Assert-That (-not [regex]::IsMatch($head, '(?m)^\s*param\s*\(')) 'param( block precedes $Verb = (breaks argument binding)'
}
Invoke-HarnessTest "play.ps1: contains Opt 'demolish' and Opt 'plan'" {
    $play = Get-Content -LiteralPath (Join-Path $repo 'play.ps1') -Raw
    Assert-That ($play.Contains("Opt 'demolish'")) "missing Opt 'demolish'"
    Assert-That ($play.Contains("Opt 'plan'")) "missing Opt 'plan'"
}

# 5. grid.ps1 plan-failure reporting (static)
Invoke-HarnessTest 'grid.ps1: PlanOnly early return text present' {
    $grid = Get-Content -LiteralPath (Join-Path $repo 'grid.ps1') -Raw
    Assert-That ($grid.Contains('PlanOnly: nothing changed.')) 'PlanOnly early-return text missing'
}
Invoke-HarnessTest 'grid.ps1: plan failures are reported, not thrown' {
    $grid = Get-Content -LiteralPath (Join-Path $repo 'grid.ps1') -Raw
    Assert-That (-not $grid.Contains("throw 'Plan is blocked")) "found throw 'Plan is blocked'"
}

# 6. No one-letter function names (alias collisions such as R = Invoke-History)
$oneLetter = [regex]'function\s+[A-Za-z]\s*[\(\{]'
foreach ($rel in 'play.ps1', 'grid.ps1', 'zone-fill.ps1', 'run-session.ps1', 'lib\BridgeClient.psm1') {
    Invoke-HarnessTest "no one-letter functions: $rel" {
        $text = Get-Content -LiteralPath (Join-Path $repo $rel) -Raw
        $hits = @($oneLetter.Matches($text) | ForEach-Object { $_.Value })
        Assert-That ($hits.Count -eq 0) "found: $($hits -join '; ')"
    }
}

# 7. Parse every script and module in root, lib and tests
$parseTargets = @(
    Get-ChildItem -LiteralPath $repo -File | Where-Object { $_.Extension -in '.ps1', '.psm1' }
    Get-ChildItem -LiteralPath (Join-Path $repo 'lib') -File | Where-Object { $_.Extension -in '.ps1', '.psm1' }
    Get-ChildItem -LiteralPath (Join-Path $repo 'tests') -File | Where-Object { $_.Extension -in '.ps1', '.psm1' }
)
foreach ($target in $parseTargets) {
    $rel = $target.FullName.Substring($repo.Length + 1)
    Invoke-HarnessTest "parse: $rel" {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($target.FullName, [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw "$($errors.Count) parse error(s); first: $($errors[0].Message) at line $($errors[0].Extent.StartLineNumber)" }
    }
}

# 8. upgrade.ps1 launch behaviour (static only; upgrade.ps1 is read, never run)
$upgradePath = Join-Path $repo 'upgrade.ps1'
$upgradeText = Get-Content -LiteralPath $upgradePath -Raw

Invoke-HarnessTest 'upgrade: QuitOnly never launches' {
    $early = [regex]::Match($upgradeText, '(?m)^if\s*\(\$QuitOnly\)\s*\{[^}\r\n]*quit only: not launching[^}\r\n]*\breturn\b')
    Assert-That ($early.Success) 'no if ($QuitOnly) { ... quit only: not launching ... return } statement found'
    $start = [regex]::Match($upgradeText, 'Start-Process\s+-FilePath')
    Assert-That ($start.Success) 'no Start-Process launch found'
    Assert-That ($early.Index -lt $start.Index) "QuitOnly return at char $($early.Index) is not before Start-Process at char $($start.Index)"
}

Invoke-HarnessTest 'upgrade: launches exactly as before' {
    Assert-That ($upgradeText.Contains("-ArgumentList '-continuelastsave'")) "upgrade.ps1 lacks -ArgumentList '-continuelastsave'"
    Assert-That (-not $upgradeText.Contains('-popupwindow')) 'upgrade.ps1 still contains -popupwindow'
    Assert-That (-not $upgradeText.Contains('CooldownSeconds')) 'upgrade.ps1 still contains CooldownSeconds'
    Assert-That (-not $upgradeText.Contains('AllowRelaunch')) 'upgrade.ps1 still contains AllowRelaunch'
}

# 9. commands.json and the bridge.ps1 ValidateSet are generated from the mod dispatcher (static, no game)
Invoke-HarnessTest 'commands.json and bridge.ps1 match the dispatcher' {
    Push-Location $repo
    try { $genOutput = & node gen-commands.mjs --check 2>&1; $genExit = $LASTEXITCODE }
    finally { Pop-Location }
    Assert-That ($genExit -eq 0) "node gen-commands.mjs --check exited ${genExit}: $($genOutput -join ' | ')"
}

Invoke-HarnessTest 'commands.json: every command has boolean pausing and control' {
    $entries = @(Get-Content -LiteralPath (Join-Path $repo 'commands.json') -Raw | ConvertFrom-Json)
    Assert-That ($entries.Count -gt 0) 'commands.json has no entries'
    foreach ($entry in $entries) {
        Assert-That ($entry.pausing -is [bool] -and $entry.control -is [bool]) "$($entry.name) lacks boolean pausing/control"
    }
}

Write-Output ("{0} tests: {1} passed, {2} failed" -f $script:Ran, ($script:Ran - $script:Failed), $script:Failed)
if ($script:Failed) { exit 1 }
exit 0
