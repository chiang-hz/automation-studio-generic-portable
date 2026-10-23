@echo off
setlocal
cd /d "%~dp0"
set "NODE_USE_SYSTEM_CA=1"
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "STUDIO_NODE=%~dp0runtime\node\node.exe"
if not exist "%STUDIO_NODE%" (
  echo [Automation Studio] Portable Node runtime is missing.
echo Run setup-runtime.bat to download Node.js, or restore runtime\node\node.exe from your existing installation.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\playwright\package.json" (
  echo [Automation Studio] Required node_modules are missing.
  pause
  exit /b 1
)
if "%UI_PORT%"=="" set "UI_PORT=4173"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\browsers"
set "REPORT_ADAPTER=ebas"
set "HEADLESS=false"
set "SLOW_MO=300"
if "%DOWNLOAD_DIR%"=="" set "DOWNLOAD_DIR=%~dp0downloads"
if "%EBAS_STORAGE_STATE%"=="" set "EBAS_STORAGE_STATE=%~dp0.auth\ebas-storage-state.json"
if "%EBAS_DEBUG_DIR%"=="" set "EBAS_DEBUG_DIR=%~dp0debug\ebas"
if "%EBAS_ENTRY_URL%"=="" set "EBAS_ENTRY_URL=https://ebasnew.ebas.gov.tw/SSO/ToLink/0/1103"
if not exist "downloads" mkdir "downloads"
if not exist "data" mkdir "data"
if not exist ".auth" mkdir ".auth"
echo Automation Studio EBAS is starting at http://127.0.0.1:%UI_PORT%/legacy/
start "" "http://127.0.0.1:%UI_PORT%/legacy/"
"%STUDIO_NODE%" --experimental-strip-types src\ui\server.ts
if errorlevel 1 pause
exit /b %errorlevel%
