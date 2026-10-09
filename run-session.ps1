#requires -Version 7.0
# Chains bounded simulate_step intervals until a total simulated wall-clock budget is used.
# Stops (game left paused) on any reason other than a normal frame/wall deadline so the
# operator can inspect before continuing. Never retries a failed step automatically.
param(
    [ValidateRange(1,7200)][int]$TotalSeconds=600,
    [ValidateRange(5,55)][int]$StepSeconds=50,
    [ValidateSet(1,2,4)][int]$Speed=4,
    [int]$CashFloor=0,
    [switch]$IgnoreNewShortage,
    [ValidateRange(0,20)][int]$MaxShortageGrowth=3,
    [string]$LogPath=(Join-Path $PSScriptRoot 'journals\run-session.jsonl')
)
$ErrorActionPreference='Stop'
$client=Join-Path $PSScriptRoot 'bridge.ps1'
Import-Module (Join-Path $PSScriptRoot 'lib\BridgeClient.psm1') -Force
$lastProblemCount=[int]::MaxValue; $shortageGrowth=0
function Invoke-Bridge($command,$arguments,$timeout=5){
    $r=& $client $command -ArgsJson ($arguments|ConvertTo-Json -Compress -Depth 6) -TimeoutSeconds $timeout | ConvertFrom-Json
    if(!$r.ok){throw "$command failed: $($r.error)"}
    $r.result
}
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
$normal='frame_limit','wall_deadline'
$used=0.0; $step=0
while($used -lt $TotalSeconds -and ($TotalSeconds-$used) -ge 1){
    $wall=[Math]::Min($StepSeconds,[Math]::Ceiling($TotalSeconds-$used))
    $stepArgs=@{frames=262144;wallSeconds=$wall;stallSeconds=[Math]::Min(5,$wall);speed=$Speed;stopOnNewShortage=(!$IgnoreNewShortage)}
    if($CashFloor -gt 0){$stepArgs.cashFloor=$CashFloor}
    $finished=$false
    try{
        $op=(Invoke-Bridge simulate_step $stepArgs).id
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while($clock.Elapsed.TotalSeconds -lt $wall+8){
            Start-Sleep -Milliseconds 1000
            $res=Invoke-Bridge get_simulation_step @{id=$op} 3
            if($res.status -ne 'running'){$finished=$true;break}
        }
        if(!$finished){throw 'Step exceeded client deadline.'}
    } finally {
        if(!$finished){ try{ Invoke-Bridge cancel_simulation_step @{} 3 | Out-Null }catch{ Write-Warning 'Cancellation not confirmed; pause manually.' } }
    }
    $step++; $used+=[double]$res.elapsedSeconds
    $c=$res.after.city
    $entry=[ordered]@{step=$step;utc=[DateTime]::UtcNow.ToString('o');reason=$res.reason;paused=$res.paused;elapsed=[Math]::Round($res.elapsedSeconds,1);usedSeconds=[Math]::Round($used,1);frames=$res.advancedFrames;population=$c.population;money=$c.money;delta=$res.delta;stagnantSteps=$res.stagnantSteps}
    ($entry|ConvertTo-Json -Compress -Depth 5) | Add-Content -LiteralPath $LogPath
    "step {0}: {1} {2:N1}s (total {3:N0}/{4}s) pop={5} money={6:N0} dPop={7} dMoney={8:N0}" -f $step,$res.reason,$res.elapsedSeconds,$used,$TotalSeconds,$c.population,$c.money,$res.delta.population,$res.delta.money
    if(!$res.paused){ Write-Warning 'Pause not confirmed; stopping.'; exit 2 }
    if($res.reason -eq 'new_utility_shortage'){
        # New buildings often report a brief shortfall before supply catches up. Continue
        # only while every problem is a supply shortfall and the count is not climbing.
        $problems=@(Get-BridgePaged diagnose_connections @{limit=4096})
        $issues=@($problems|ForEach-Object{$_.issues})|Group-Object|ForEach-Object{"$($_.Name)=$($_.Count)"}
        $hard=@($problems|ForEach-Object{$_.issues}|Where-Object{$_ -notmatch '_shortfall$'})
        $shortageGrowth = if($problems.Count -gt $lastProblemCount){$shortageGrowth+1}else{0}; $lastProblemCount=$problems.Count
        ([ordered]@{step=$step;triage=$true;buildings=$problems.Count;issues=$issues;growthStreak=$shortageGrowth}|ConvertTo-Json -Compress) | Add-Content -LiteralPath $LogPath
        "  triage: $($problems.Count) buildings [$($issues -join ', ')] growthStreak=$shortageGrowth"
        if($hard){ "STOPPED for inspection: non-shortfall connection issues ($(($hard|Sort-Object -Unique) -join ', '))"; exit 3 }
        if($shortageGrowth -ge $MaxShortageGrowth){ "STOPPED for inspection: shortfalls rising for $shortageGrowth steps; check capacity"; exit 3 }
        continue
    }
    if($res.reason -notin $normal){ "STOPPED for inspection: $($res.reason)"; exit 3 }
}
"DONE: simulated {0:N0}s in {1} steps; game paused." -f $used,$step
