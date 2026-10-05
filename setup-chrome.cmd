@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"

if not exist "%~dp0setup-native-host.ps1" (
  echo setup-native-host.ps1 is missing. Extract the complete package.
  pause
  exit /b 1
)

echo Registering the reserved seat helper for this Windows user's Chrome.
powershell.exe -NoProfile -File "%~dp0setup-native-host.ps1" -Browser Chrome
set "PARTY_CHROME_SETUP_EXIT=%ERRORLEVEL%"
if not "%PARTY_CHROME_SETUP_EXIT%"=="0" (
  echo Setup failed. Read the PowerShell error above.
  echo This launcher does not change or bypass the PowerShell execution policy.
) else (
  echo Setup complete. Load the extension folder in chrome://extensions.
)
pause
exit /b %PARTY_CHROME_SETUP_EXIT%
