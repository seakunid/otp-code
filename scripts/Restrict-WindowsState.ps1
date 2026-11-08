$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$state=Join-Path $env:LOCALAPPDATA 'OTP-Retrieval'
New-Item $state -ItemType Directory -Force | Out-Null
$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $state /inheritance:r /grant:r "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot restrict state directory'}
Write-Output "Restricted state directory ready: $state"
Write-Output 'Stop the service and active test tasks before moving state.sqlite, state.sqlite-wal and state.sqlite-shm together. Keep the same encryption key.'
Write-Output 'Set OTP_STATE_DB in .env to that directory plus state.sqlite, then verify restart and replay. Do not copy authenticated Chrome profiles.'
