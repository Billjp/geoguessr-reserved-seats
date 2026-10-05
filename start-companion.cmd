@echo off
setlocal
cd /d "%~dp0"

set "PARTY_JOIN_NODE=node.exe"
where node.exe >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PARTY_JOIN_NODE=C:\Program Files\nodejs\node.exe"
  ) else (
    echo Node.js 20.3 or newer is required.
    echo Install Node.js, then run this file again.
    goto :startup_error
  )
)

"%PARTY_JOIN_NODE%" -e "const [major,minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 3) ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 20.3 or newer is required.
  goto :startup_error
)

if not exist "node_modules\ws\package.json" (
  echo Dependencies are missing. Open a terminal in this folder and run:
  echo npm ci --ignore-scripts
  echo Then run this file again.
  goto :startup_error
)

if not exist "companion.mjs" (
  echo companion.mjs is missing. Restore the complete v0.2 folder.
  goto :startup_error
)

echo Starting GeoGuessr reserved seat companion.
echo Keep this window open. Press Ctrl+C here to stop.
"%PARTY_JOIN_NODE%" companion.mjs
set "PARTY_JOIN_EXIT=%ERRORLEVEL%"
echo Companion stopped.
pause
exit /b %PARTY_JOIN_EXIT%

:startup_error
pause
exit /b 1
