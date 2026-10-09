param(
    [ValidateRange(1,262144)][int]$Frames=4096,
    [ValidateRange(1,50)][int]$WallSeconds=20,
    [ValidateSet(1,2,4)][int]$Speed=4,
    [int]$CashFloor=0,
    [ValidateRange(0,1000000)][int]$PopulationChange=0,
    [switch]$StopOnDemandChange,
    [switch]$StopOnConstructionComplete,
    [switch]$AcknowledgeNoProgress
)
$ErrorActionPreference='Stop'
$client=Join-Path $PSScriptRoot 'bridge.ps1'
$argsObject=@{frames=$Frames;wallSeconds=$WallSeconds;stallSeconds=[Math]::Min(5,$WallSeconds);speed=$Speed;cashFloor=$CashFloor;stopOnDemandChange=[bool]$StopOnDemandChange;stopOnConstructionComplete=[bool]$StopOnConstructionComplete;acknowledgeNoProgress=[bool]$AcknowledgeNoProgress}
if($PopulationChange -gt 0){$argsObject.populationChange=$PopulationChange}
$finished=$false
$operation=$null
$rejected=$false
try {
    $start=& $client simulate_step -ArgsJson ($argsObject|ConvertTo-Json -Compress) -TimeoutSeconds 5 | ConvertFrom-Json
    if(!$start.ok){$rejected=$true;throw ($start|ConvertTo-Json -Depth 12 -Compress)}
    if([string]::IsNullOrWhiteSpace([string]$start.result.id)){throw 'Simulation start did not return an operation ID; outcome unknown.'}
    $operation=[string]$start.result.id
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while($clock.Elapsed.TotalSeconds -lt ($WallSeconds+5)) {
        Start-Sleep -Milliseconds 500
        $response=& $client get_simulation_step -ArgsJson (@{id=$operation}|ConvertTo-Json -Compress) -TimeoutSeconds 2 | ConvertFrom-Json
        if(!$response.ok){throw ($response|ConvertTo-Json -Depth 12 -Compress)}
        if([string]$response.result.id -ne $operation){throw 'Simulation status returned a different operation ID.'}
        if($response.result.status -notin @('running','complete','failed','interrupted')){throw 'Unknown simulation status; inspect the original operation.'}
        if($response.result.status -ne 'running'){
            $finished=$true
            $response|ConvertTo-Json -Depth 40
            if(!$response.result.paused){Write-Warning 'Step ended, but pause was not confirmed. Do not assume the game is paused.'}
            return
        }
    }
    throw 'Bounded step exceeded the client deadline; requesting cancellation.'
} finally {
    if(!$finished -and $operation) {
        try {
            $cancel=& $client cancel_simulation_step -ArgsJson (@{id=$operation}|ConvertTo-Json -Compress) -TimeoutSeconds 3 | ConvertFrom-Json
            if(!$cancel.ok -or !$cancel.result.paused){Write-Warning 'Cancellation did not confirm pause.'}
            elseif($cancel.result.cancelledActiveOperation -eq $false){Write-Warning 'The original operation is no longer active. No newer interval was cancelled; its pause state is not asserted.'}
        } catch { Write-Warning 'The bridge did not confirm cancellation or pause. The game may be unresponsive.' }
    } elseif(!$finished -and !$rejected) {
        Write-Warning 'No original operation ID was received. No global cancellation was sent; inspect the request and bounded simulation watchdog before retrying.'
    }
}
