@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0setup-native-host.ps1" (
  echo setup-native-host.ps1 is missing. Extract the complete v0.3 package.
  pause
  exit /b 1
)

echo Registering the reserved seat helper for this Windows user's Edge.
powershell.exe -NoProfile -File "%~dp0setup-native-host.ps1"
set "PARTY_AUTO_SETUP_EXIT=%ERRORLEVEL%"
if not "%PARTY_AUTO_SETUP_EXIT%"=="0" (
  echo Setup failed. Read the PowerShell error above.
  echo This launcher does not change or bypass the PowerShell execution policy.
) else (
  echo Setup complete. Load the extension folder in edge://extensions.
)
pause
exit /b %PARTY_AUTO_SETUP_EXIT%
