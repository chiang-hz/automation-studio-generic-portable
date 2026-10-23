@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "NODE_USE_SYSTEM_CA=1"
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "STUDIO_NODE=%~dp0runtime\node\node.exe"
set "NODE_URL=https://nodejs.org/dist/v24.13.0/win-x64/node.exe"
set "NODE_SHA256=D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11"

if exist "%STUDIO_NODE%" goto node_ready
echo [Setup] Bundled Node.js is missing. Downloading the pinned Windows x64 executable...
where curl.exe >nul 2>&1 || goto missing_tools
where certutil.exe >nul 2>&1 || goto missing_tools
if not exist "runtime\node" mkdir "runtime\node" || goto failed
set "NODE_TEMP=%STUDIO_NODE%.download"
if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
rem Try the Windows trust store first. Only this setup download may fall back to -k.
curl.exe --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
if errorlevel 1 (
  if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
  echo [Setup] Verified TLS download failed; retrying this bootstrap transfer without certificate verification.
  curl.exe --insecure --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
  if errorlevel 1 goto failed
)
rem The SHA-256 check is mandatory before the downloaded executable can run.
certutil.exe -hashfile "%NODE_TEMP%" SHA256 | findstr /i /c:"%NODE_SHA256%" >nul
if errorlevel 1 (
  echo [Setup] Node.js SHA-256 mismatch; refusing to run the downloaded file.
  goto failed
)
move /y "%NODE_TEMP%" "%STUDIO_NODE%" >nul || goto failed

:node_ready
"%STUDIO_NODE%" --version || goto failed
if not exist "scripts\setup-portable-runtime.mjs" goto failed
if not exist "scripts\portable-runtime-packages.json" goto failed
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\browsers"
echo [Setup] Checking runtime packages and Playwright Chromium...
"%STUDIO_NODE%" "scripts\setup-portable-runtime.mjs"
if not errorlevel 1 goto ready
rem The exception applies only to the retry subprocess, never to start.bat.
echo [Setup] Verified TLS download failed or a required file is unavailable.
echo [Setup] Retrying missing runtime downloads with TLS certificate validation temporarily disabled.
set "NODE_TLS_REJECT_UNAUTHORIZED=0"
"%STUDIO_NODE%" "scripts\setup-portable-runtime.mjs"
if errorlevel 1 goto failed
set "NODE_TLS_REJECT_UNAUTHORIZED="

:ready
echo [Setup] Runtime is ready. Normal startup uses Windows system certificates and TLS verification.
echo Run start.bat.
pause
exit /b 0

:missing_tools
echo [Setup] Windows curl.exe and certutil.exe are required to fetch and verify bundled Node.js.
:failed
set "NODE_TLS_REJECT_UNAUTHORIZED="
if defined NODE_TEMP if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
echo [Setup] Runtime setup did not complete. Check network access and the error above.
pause
exit /b 1
