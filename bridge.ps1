param(
    [ValidateSet('batch_execute','build_network','build_road','building_upgrades','cancel_batch','cancel_simulation_step','clear_zoning','connected','corridor','coverage_gaps','create_district','crime_map','demolish','dev_tree','diagnose_connections','edit_district','execute_neighborhood','find_building_sites','find_free_lots','find_roadside_lots','garbage_system','get_batch','get_build_prefabs','get_buildings','get_camera','get_capabilities','get_city_diagnostics','get_city_management','get_city_map','get_city_state','get_district_atlas','get_metrics','get_neighborhood_plan','get_network','get_network_edges','get_operation','get_pause_state','get_prefab_details','get_selected','get_services','get_simulation_step','get_snapshot','get_tiles','get_ui_state','get_water_facilities','get_zone_cells','grid_connectors','home_clusters','inspect_entity','junction_info','load_save','multi','network_ends','notifications','pause_for_analysis','ping','place_building','plan_grid','plan_neighborhood','pollution_sources','preview_building','project','purchase_dev_node','purchase_tiles','quit_game','relocate_building','resolve_pause_blocker','road_option','sample_terrain','save_checkpoint','service_buildings','service_headroom','set_building_option','set_camera','set_service_budget','set_service_districts','set_simulation_speed','set_tax','simulate_step','stop','tile_options','trace_network','traffic_hotspots','transit_status','upgrade_network','utility_check','zone_area','zone_area_count','zone_rectangle')]
    [string]$Command = 'ping',
    [string]$ArgsJson = '{}',
    [ValidateRange(1,45)][int]$TimeoutSeconds = 15,
    [string]$MailboxPath = (Join-Path $env:LOCALAPPDATA 'CitiesIIAgentBridge')
)
$ErrorActionPreference = 'Stop'
function Read-MailboxText([string]$Path) {
    # DELETE sharing permits the mod's atomic replacement while this reader is open.
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = $null
    try {
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
        return $reader.ReadToEnd()
    } finally {
        if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
}
function Test-MailboxReadContention($ErrorRecord) {
    $cause = $ErrorRecord.Exception.GetBaseException()
    return $cause -is [IO.IOException] -and (($cause.HResult -band 0xffff) -in @(32,33))
}
function Record-JournalEvent($text,$requestId,$result) {
    # Logging failure must never change command delivery or cause a mutation retry.
    if(!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'journals\active.json'))){return}
    try {
        $event=@{text=$text;command=$Command;requestId=$requestId;args=($ArgsJson|ConvertFrom-Json);result=$result}
        & (Join-Path $PSScriptRoot 'journal.ps1') event -EventJson ($event|ConvertTo-Json -Depth 25 -Compress) | Out-Null
    } catch {Write-Warning "Journal update failed: $($_.Exception.Message)"}
}
if ($Command -eq 'stop') {
    New-Item -ItemType Directory -Force -Path $MailboxPath | Out-Null
    [IO.File]::WriteAllText((Join-Path $MailboxPath 'STOP'), [DateTime]::UtcNow.ToString('O'))
    Record-JournalEvent 'Control stop requested; inspection remains available.' '' $null
    Write-Output '{"ok":true,"message":"Control stop requested. Inspection remains available."}'
    return
}
$sessionPath = Join-Path $MailboxPath 'session.json'
# Heartbeat replacement can briefly make the file unavailable; retry only this read,
# before generating or sending any command, so mutations are never replayed.
for ($heartbeatAttempt = 0; $heartbeatAttempt -lt 10; $heartbeatAttempt++) {
    try { $session = Read-MailboxText $sessionPath | ConvertFrom-Json; break }
    catch { if ($heartbeatAttempt -eq 9) { throw }; Start-Sleep -Milliseconds 50 }
}
# PS7 ConvertFrom-Json already yields a UTC DateTime; re-parsing its string form is
# culture-dependent (e.g. en-IN reads 10/09 as 10 Sep) and falsely reports a stale heartbeat.
$heartbeat = $session.heartbeatUtc
$heartbeat = if ($heartbeat -is [datetime]) { [DateTimeOffset]$heartbeat.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$heartbeat, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal) }
if ($session.status -ne 'ready' -or ([DateTimeOffset]::UtcNow - $heartbeat).TotalSeconds -gt 10) {
    throw 'Bridge is not responding: heartbeat stale or game stopped.'
}
$arguments = $ArgsJson | ConvertFrom-Json
if ($null -eq $arguments -or $arguments -isnot [pscustomobject]) { throw 'ArgsJson must be a JSON object' }
$id = [Guid]::NewGuid().ToString('N')
$packet = [ordered]@{
    protocol = 1; id = $id; session = $session.session; citySession = $session.citySession
    command = $Command; args = $arguments; expiresUtc = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds).ToString('O')
}
$requestPath = Join-Path (Join-Path $MailboxPath 'requests') "$id.json"
$responsePath = Join-Path (Join-Path $MailboxPath 'responses') "$id.json"
$temp = "$requestPath.tmp"
# Compact JSON: the mod rejects request files over 16384 bytes, and indentation alone
# can push a valid 50-step batch past that limit.
$packetText = $packet | ConvertTo-Json -Depth 20 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($packetText) -gt 16384) { throw "Request is $([Text.Encoding]::UTF8.GetByteCount($packetText)) bytes; the bridge limit is 16384. Split the batch. Nothing was sent." }
[IO.File]::WriteAllText($temp, $packetText, [Text.UTF8Encoding]::new($false))
[IO.File]::Move($temp, $requestPath)
Record-JournalEvent "Sent $Command (request $id). Completion is not yet confirmed." $id $null
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds + 2)
while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $responsePath) {
        try { $responseText=Read-MailboxText $responsePath }
        catch {
            if (!(Test-MailboxReadContention $_)) { throw }
            # Poll the SAME response ID; never resend a mutation after a read failure.
            Start-Sleep -Milliseconds 50
            continue
        }
        try {
            $response=$responseText|ConvertFrom-Json
            $summary=@{ok=$response.ok;status=$response.result.status;operationId=$response.result.id;error=$response.error}
            Record-JournalEvent "$Command response: ok=$($summary.ok); status=$($summary.status)." $id $summary
        } catch {Write-Warning 'Could not summarize bridge response for the journal.'}
        Write-Output $responseText
        return
    }
    Start-Sleep -Milliseconds 100
}
Record-JournalEvent "$Command timed out; outcome unknown. Inspect before retrying." $id $null
throw "Request $id timed out. It expires automatically; inspect before retrying a control command."
