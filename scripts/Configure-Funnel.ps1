param([ValidateSet('Enable','Status','Disable')][string]$Action='Status')
$ErrorActionPreference='Stop'
$tailscale=(Get-Command tailscale.exe -ErrorAction Stop).Source
$expected='windows.tailb37f08.ts.net'
$state=& $tailscale status --json | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $state.BackendState -ne 'Running' -or $state.Self.DNSName.TrimEnd('.') -ne $expected){throw 'Expected Windows Tailscale device must be signed in and running'}
if($Action -eq 'Enable'){
  # Configure only HTTPS 443. Do not reset other Serve/Funnel ports.
  & $tailscale funnel --bg --https=443 http://127.0.0.1:3010
  if($LASTEXITCODE -ne 0){throw 'Funnel setup failed; complete any Tailscale approval shown above, then retry'}
}elseif($Action -eq 'Disable'){
  & $tailscale funnel --https=443 off
  if($LASTEXITCODE -ne 0){throw 'Funnel disable failed'}
}
& $tailscale funnel status
if($LASTEXITCODE -ne 0){throw 'Cannot read Funnel status'}
Write-Output "Public endpoint: https://$expected"
Write-Output 'Every application route requires Authorization: Bearer <existing-api-key>.'
