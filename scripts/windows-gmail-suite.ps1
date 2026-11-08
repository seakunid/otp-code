param([string]$EnvironmentFile='runtime\gmail-e2e.env')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location $root
$node=(Get-ChildItem "$root\tools\node" -Filter node.exe -Recurse|Select-Object -First 1).FullName
if(!$node){throw 'Portable Node 24 not found under tools\node'}
if(!(Test-Path $EnvironmentFile)){throw 'Private opt-in E2E environment file missing'}
$run=Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force artifacts|Out-Null
$steps=@(
 @{Name='matrix-first';Script='gmail-e2e'},
 @{Name='matrix-second';Script='gmail-e2e'},
 @{Name='original-fixtures';Script='gmail-original-fixtures'},
 @{Name='negative';Script='gmail-negative'},
 @{Name='reliability';Script='gmail-reliability'},
 @{Name='folders';Script='gmail-folders'}
)
foreach($step in $steps){
 if(Test-Path runtime\e2e-stop){throw 'E2E stop file exists; no further suite starts'}
 $log="artifacts\$run-$($step.Name).log"
 $ErrorActionPreference='Continue'
 & $node "--env-file=$EnvironmentFile" "dist\scripts\$($step.Script).js" *> $log
 $result=$LASTEXITCODE
 $ErrorActionPreference='Stop'
 if($result -ne 0){Write-Output "FAIL $($step.Name). Evidence: $log";exit $result}
 Write-Output "PASS $($step.Name). Evidence: $log"
}
