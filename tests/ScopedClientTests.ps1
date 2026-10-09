$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('bridge-scoped-client-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\advance.ps1') -Destination $root
    @'
param([string]$Command,[string]$ArgsJson,[int]$TimeoutSeconds)
$scenario=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'scenario.txt')
$argsObject=if($ArgsJson){$ArgsJson|ConvertFrom-Json}else{$null}
@{command=$Command;args=$argsObject}|ConvertTo-Json -Compress|Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.jsonl')
if($Command -eq 'simulate_step') {
    if($scenario -eq 'lost-start'){throw 'Response was lost after possible submission'}
    if($scenario -eq 'missing-id'){'{"ok":true,"result":{"status":"running"}}';return}
    if($scenario -eq 'rejected'){'{"ok":false,"error":"busy"}';return}
    '{"ok":true,"result":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"running"}}';return
}
if($Command -eq 'get_simulation_step') {
    if($scenario -eq 'wrong-poll'){'{"ok":true,"result":{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"complete","paused":true}}';return}
    if($scenario -eq 'success'){'{"ok":true,"result":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"complete","paused":true}}';return}
    throw 'Synthetic poll failure after client B started'
}
if($Command -eq 'cancel_simulation_step') {
    if($argsObject.id -ne 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'){throw 'Unscoped cancellation could stop client B'}
    '{"ok":true,"result":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"complete","paused":true,"cancelledActiveOperation":false}}';return
}
throw "Unexpected command $Command"
'@ | Set-Content -LiteralPath (Join-Path $root 'bridge.ps1')
    foreach($scenario in @('success','rejected','lost-start','missing-id','poll-failure','wrong-poll')) {
        Set-Content -LiteralPath (Join-Path $root 'scenario.txt') -Value $scenario
        Set-Content -LiteralPath (Join-Path $root 'calls.jsonl') -Value ''
        $failed=$false
        try { & (Join-Path $root 'advance.ps1') -Frames 1 -WallSeconds 1 -WarningAction SilentlyContinue | Out-Null } catch { $failed=$true }
        $calls=@(Get-Content -LiteralPath (Join-Path $root 'calls.jsonl') | Where-Object {$_} | ForEach-Object {$_|ConvertFrom-Json})
        $cancel=@($calls|Where-Object {$_.command -eq 'cancel_simulation_step'})
        if($scenario -in @('poll-failure','wrong-poll')) {
            if(!$failed -or $cancel.Count -ne 1 -or $cancel[0].args.id -ne 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'){throw "Unsafe cancellation in $scenario"}
        } elseif($cancel.Count -ne 0){throw "Unwanted cancellation in $scenario"}
        if(($scenario -eq 'success') -eq $failed){throw "Unexpected result in $scenario"}
        Write-Output "PASS: scoped client $scenario"
    }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
