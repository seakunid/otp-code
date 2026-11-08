$ErrorActionPreference='Stop'
$target='C:\Users\nebula\otp-browser-profiles\nebula.together'
$processes=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($target) -and $_.CommandLine -notmatch '--type='}
foreach($item in $processes){$p=Get-Process -Id $item.ProcessId; $closed=$p.CloseMainWindow(); if($closed){try{$p.WaitForExit(15000)|Out-Null}catch{}}}
