#requires -Version 7.0
# Unattended mod upgrade / game restart (owner-authorised):
#   1. rolling save, verified complete
#   2. quit_game (mod refuses unless that save is < 5 min old); wait for a clean exit
#   3. optional: build package + run package tests; install (backs up the old DLL)
#   4. launch Cities2.exe -continuelastsave (loads the save from step 1)
#   5. wait until the city is loaded, controls are on and the bridge answers
# Never force-kills the game: if it does not exit cleanly, stops and reports.
param(
    [string]$GamePath = 'Z:\Games\Cities - Skylines II',
    [switch]$Build,          # run package.ps1 + PackageTests first
    [switch]$NoInstall,      # restart only
    [switch]$QuitOnly,       # verified save + clean quit, no install, no launch
    [ValidateRange(60, 1800)][int]$LoadTimeoutSeconds = 600
)
$ErrorActionPreference = 'Stop'
$H = $PSScriptRoot
Import-Module (Join-Path $H 'lib\BridgeClient.psm1') -Force
$mailbox = Join-Path $env:LOCALAPPDATA 'CitiesIIAgentBridge'
function Step($text) { "[{0:HH:mm:ss}] $text" -f (Get-Date) }
# Package first, while the game still runs (no downtime if the build fails).
$package = $null
if ($QuitOnly) { $NoInstall = $true }
if (!$NoInstall) {
    if ($Build) {
        $out = & (Join-Path $H 'package.ps1') -GamePath $GamePath 2>&1 | ForEach-Object { "$_" }
        if (!($out -match 'Release ZIP')) { throw "Package build failed: $($out | Select-Object -Last 3)" }
    }
    $zip = Get-ChildItem (Join-Path $H 'artifacts\releases') -Recurse -Filter 'CitiesIIAgentBridge-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$zip) { throw 'No package found; run with -Build.' }
    $tests = & (Join-Path $H 'tests\PackageTests.ps1') -PackageZip $zip.FullName -GamePath $GamePath 2>&1 | ForEach-Object { "$_" }
    if ($tests -match 'FAIL' -or !($tests -match 'package tampering rejected')) { throw "Package tests failed: $($tests -match 'FAIL')" }
    $package = Join-Path $zip.DirectoryName ($zip.BaseName)
    Step "package ready: $($zip.Name) (tests passed)"
}

$game = Get-Process Cities2 -ErrorAction SilentlyContinue
$atMenu = $false; try { $atMenu = (Get-Content (Join-Path $mailbox 'session.json') -Raw | ConvertFrom-Json).gameMode -ne 'Game' } catch {}
if ($game -and $atMenu) {
    $q = Invoke-Bridge quit_game @{ } -AllowError
    if (!$q.ok) { throw "Game is at the main menu but quit_game failed ($($q.error)); exit it manually once." }
    Step 'quit requested at main menu (no city loaded)'
    if (!$game.WaitForExit(180000)) { throw 'Game did not exit within 3 minutes. It was NOT force-closed.' }
    Step 'game exited cleanly'; $game = $null
}
if ($game) {
    $save = Invoke-Bridge save_checkpoint @{ label = 'autosave' }
    $saved = Wait-BridgeOperation $save.id
    if ($saved.status -ne 'complete') { throw "Save did not complete ($($saved.status)); not quitting." }
    $null = Clear-BridgeRollingSaves -KeepNewest 1
    Step "saved $($saved.saveName)"
    $q = Invoke-Bridge quit_game @{ afterSave = $saved.saveName }
    Step "quit requested (save age $($q.saveAgeSeconds) s)"
    if (!$game.WaitForExit(180000)) { throw 'Game did not exit within 3 minutes. It was NOT force-closed; check the screen.' }
    Step 'game exited cleanly'
}
if ($QuitOnly) { Step 'quit only: not launching'; return }

if ($package) {
    $inst = & (Join-Path $package 'install.ps1') -GamePath $GamePath 2>&1 | ForEach-Object { "$_" }
    if (!($inst -match 'installed and hash-verified')) { throw "Install failed: $($inst | Select-Object -Last 2)" }
    Step 'mod installed and hash-verified (previous DLL backed up)'
}

$modsDir = Join-Path $env:USERPROFILE 'AppData\LocalLow\Colossal Order\Cities Skylines II\Mods'
$copies = @(Get-ChildItem $modsDir -Recurse -Filter 'CitiesIIAgentBridge*.dll' -ErrorAction SilentlyContinue)
if ($copies.Count -ne 1) { throw "$($copies.Count) bridge DLLs under Mods; duplicates would fail to load. Not launching." }
$sessionFile = Join-Path $mailbox 'session.json'
$launchedUtc = [DateTime]::UtcNow
Start-Process -FilePath (Join-Path $GamePath 'Cities2.exe') -ArgumentList '-continuelastsave' -WorkingDirectory $GamePath | Out-Null
Step 'launched Cities2.exe -continuelastsave'

$clock = [Diagnostics.Stopwatch]::StartNew(); $loadRequested = $false
while ($clock.Elapsed.TotalSeconds -lt $LoadTimeoutSeconds) {
    Start-Sleep -Seconds 5
    try { $s = Get-Content $sessionFile -Raw | ConvertFrom-Json } catch { continue }
    $beat = if ($s.heartbeatUtc -is [datetime]) { $s.heartbeatUtc.ToUniversalTime() } else { [DateTime]::Parse([string]$s.heartbeatUtc, [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime() }
    if ($beat -lt $launchedUtc) { continue }   # still the previous run's heartbeat
    # CS2's Continue / -continuelastsave ignore bridge-made saves: load the newest
    # rolling autosave through the bridge as soon as the main menu is up.
    if ($s.status -eq 'ready' -and $s.gameMode -eq 'MainMenu' -and !$s.loading -and !$loadRequested) {
        $l = Invoke-Bridge load_save @{ } -AllowError
        if ($l.ok) { Step "loading $($l.result.loading)"; $loadRequested = $true } else { Step "load_save not available yet: $($l.error)" }
        continue
    }
    if ($s.status -eq 'ready' -and $s.gameMode -eq 'Game' -and !$s.loading) {
        if (!$s.controlEnabled) { Step 'city loaded, but bridge controls are OFF (enable "Keep bridge controls enabled across city loads")'; return }
        $v = (Invoke-Bridge ping).modVersion
        $c = Invoke-Bridge get_city_state
        Step ("city ready in {0:N0} s: {1}, pop {2}, money {3:N0}, mod {4}" -f $clock.Elapsed.TotalSeconds, $c.cityName, $c.population, $c.money, $v)
        if ($s.display) { Step "display: $($s.display)" }   # informational (reported by the mod)
        return
    }
}
throw "City not ready after $LoadTimeoutSeconds s (last status: $($s.status) / $($s.gameMode) / loading=$($s.loading)). Check the screen. If the game hung or the GPU driver reset: save if possible, quit and report."
