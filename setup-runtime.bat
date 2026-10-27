@echo off
setlocal EnableExtensions
cd /d "%~dp0" || goto failed
rem Keep all temporary files on the same drive/volume as this portable project.
set "STUDIO_TEMP=%~dp0.local\setup-temp"
if not exist "%STUDIO_TEMP%" mkdir "%STUDIO_TEMP%" || goto failed
set "TEMP=%STUDIO_TEMP%"
set "TMP=%STUDIO_TEMP%"
set "TMPDIR=%STUDIO_TEMP%"
set "NODE_USE_SYSTEM_CA=1"
rem Never disable TLS verification for the main setup process.
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "STUDIO_NODE=%~dp0runtime\node\node.exe"
set "NODE_URL=https://nodejs.org/dist/v24.13.0/win-x64/node.exe"
set "NODE_SHA256=D14BA95CDCE1EF7DC9AD3AC74949CA5DB38B27378EE30F30A23CF26F9E875A11"

if exist "%STUDIO_NODE%" goto node_ready
echo [Setup] Bundled Node.js is missing. Downloading pinned Windows x64 executable...
where curl.exe >nul 2>&1 || goto missing_tools
where certutil.exe >nul 2>&1 || goto missing_tools
if not exist "runtime\node" mkdir "runtime\node" || goto failed
set "NODE_TEMP=%STUDIO_TEMP%\node-v24.13.0-win-x64.exe.download"
if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
curl.exe --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
if not errorlevel 1 goto node_downloaded
set "NODE_CURL_ERROR=%ERRORLEVEL%"
rem Schannel can report a blocked certificate revocation lookup as curl exit 35,
rem NOT exit 60. Handle revocation only; do not globally relax TLS checks.
if "%NODE_CURL_ERROR%"=="35" goto node_revocation_retry
if "%NODE_CURL_ERROR%"=="60" goto node_issuer_retry
goto node_curl_failed

:node_revocation_retry
if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
echo [Setup] Windows Schannel TLS handshake failed (curl 35).
echo [Setup] Retrying Node.js transfer with best-effort revocation lookup; normal certificate chain validation stays ON.
curl.exe --ssl-revoke-best-effort --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
if not errorlevel 1 goto node_downloaded
set "NODE_CURL_ERROR=%ERRORLEVEL%"
if "%NODE_CURL_ERROR%"=="60" goto node_issuer_retry
if not "%NODE_CURL_ERROR%"=="35" goto node_curl_failed
if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
echo [Setup] Revocation lookup is still blocked. Retrying ONLY this transfer without revocation checks; certificate chain verification stays ON.
curl.exe --ssl-no-revoke --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
if not errorlevel 1 goto node_downloaded
set "NODE_CURL_ERROR=%ERRORLEVEL%"
if "%NODE_CURL_ERROR%"=="60" goto node_issuer_retry
goto node_curl_failed

:node_issuer_retry
rem Keep the legacy v2.4.4 issuer-chain fallback strictly limited to this
rem pinned node.exe transfer. The mandatory SHA-256 check below still applies.
if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
echo [Setup] TLS certificate chain verification failed (curl 60).
echo [Setup] Retrying ONLY this Node.js transfer with --insecure; pinned SHA-256 verification remains mandatory.
curl.exe --insecure --fail --location --retry 2 --connect-timeout 20 --max-time 600 --output "%NODE_TEMP%" "%NODE_URL%"
if not errorlevel 1 goto node_downloaded
set "NODE_CURL_ERROR=%ERRORLEVEL%"
goto node_curl_failed

:node_curl_failed
echo [Setup] Node.js download failed, curl exit code %NODE_CURL_ERROR%.
echo [Setup] Check company proxy, HTTPS certificate/revocation access, or supply runtime\node\node.exe from a trusted source.
goto failed

:node_downloaded
rem SHA-256 verification is mandatory even after an insecure transport fallback.
certutil.exe -hashfile "%NODE_TEMP%" SHA256 | findstr /i /c:"%NODE_SHA256%" >nul
if errorlevel 1 (
  echo [Setup] Node.js SHA-256 mismatch; refusing to execute the downloaded file.
  goto failed
)
move /y "%NODE_TEMP%" "%STUDIO_NODE%" >nul || goto failed

:node_ready
"%STUDIO_NODE%" --version || goto failed
if not exist "scripts\setup-portable-runtime.mjs" goto failed
if not exist "scripts\portable-runtime-packages.json" goto failed
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\browsers"
echo [Setup] Checking runtime packages and existing Google Chrome...
echo [Setup] Temporary files: "%STUDIO_TEMP%"
rem The installer handles certificate-specific retries per HTTPS request; no global TLS bypass.
"%STUDIO_NODE%" "scripts\setup-portable-runtime.mjs" %*
if errorlevel 1 goto failed

echo [Setup] Runtime is ready. TLS validation remains enabled for normal startup.
echo Run start.bat.
pause
exit /b 0

:missing_tools
echo [Setup] Windows curl.exe and certutil.exe are required to bootstrap Node.js.
:failed
set "NODE_TLS_REJECT_UNAUTHORIZED="
if defined NODE_TEMP if exist "%NODE_TEMP%" del /q "%NODE_TEMP%"
echo [Setup] Runtime setup did not complete. Check the error above.
pause
exit /b 1
