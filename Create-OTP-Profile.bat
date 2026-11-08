@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
call Run-Node.bat dist\scripts\profiles.js create
set "OTP_EXIT=%ERRORLEVEL%"
if not "%OTP_EXIT%"=="0" echo Profile creation failed. See error above.
pause
exit /b %OTP_EXIT%
