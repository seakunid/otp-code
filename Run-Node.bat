@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
for /d %%N in ("tools\node\node-v*-win-x64") do set "OTP_NODE=%%~fN\node.exe"
if not defined OTP_NODE set "OTP_NODE=node"
"%OTP_NODE%" --env-file-if-exists=.env %*
