$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$node=(Get-ChildItem "$root\tools\node" -Filter node.exe -Recurse|Select-Object -First 1).FullName
Set-Location $root
$tests=Get-ChildItem dist\tests\*.test.js | Where-Object { $_.Name -ne 'scale.test.js' -and $_.Name -notlike '._*' } | ForEach-Object FullName
& $node --test $tests
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& $node --test dist\tests\scale.test.js
exit $LASTEXITCODE
