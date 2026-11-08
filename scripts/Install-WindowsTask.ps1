$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$node=(Get-ChildItem "$root\tools\node" -Filter node.exe -Recurse|Select-Object -First 1).FullName
if(!$node){throw 'Portable Node 24 not found under tools\node'}
if(!(Test-Path "$root\.env")){throw 'Configure .env first'}
& "$PSScriptRoot\Restrict-WindowsState.ps1"
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$action=New-ScheduledTaskAction -Execute $node -Argument '--env-file=.env dist\src\server.js' -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName OTP-Retrieval-Service -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force|Out-Null
Start-ScheduledTask OTP-Retrieval-Service
Write-Output 'Registered interactive sign-in task OTP-Retrieval-Service.'
