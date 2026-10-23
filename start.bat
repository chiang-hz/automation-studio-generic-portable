@echo off
setlocal
cd /d "%~dp0"

rem Use Windows trusted certificates and enforce TLS verification for normal operation.
set "NODE_USE_SYSTEM_CA=1"
set "NODE_TLS_REJECT_UNAUTHORIZED="
rem Optional corporate Root/Intermediate CA PEM chain can be set with NODE_EXTRA_CA_CERTS.
if defined NODE_EXTRA_CA_CERTS echo [TLS] Extra CA: %NODE_EXTRA_CA_CERTS%

set "STUDIO_NODE=%~dp0runtime\node\node.exe"
if not exist "%STUDIO_NODE%" goto missing

:run
if not exist "%~dp0node_modules\playwright\package.json" (
  echo [Automation Studio] Playwright runtime is missing.
  echo Please extract the complete portable ZIP again.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\playwright-core\package.json" (
  echo [Automation Studio] Playwright Core runtime is missing.
  pause
  exit /b 1
)
if "%UI_PORT%"=="" set "UI_PORT=4173"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\browsers"
if "%REPORT_ADAPTER%"=="" set "REPORT_ADAPTER=ebas"
if "%HEADLESS%"=="" set "HEADLESS=false"
if "%DOWNLOAD_DIR%"=="" set "DOWNLOAD_DIR=%CD%\downloads"
if "%EBAS_STORAGE_STATE%"=="" set "EBAS_STORAGE_STATE=%CD%\.auth\ebas-storage-state.json"
if "%EBAS_DEBUG_DIR%"=="" set "EBAS_DEBUG_DIR=%CD%\debug\ebas"

if not exist "downloads" mkdir "downloads"
if not exist "debug" mkdir "debug"
if not exist ".auth" mkdir ".auth"

echo.
echo Automation Studio is starting...
echo URL: http://127.0.0.1:%UI_PORT%
echo EBAS compatibility workspace: http://127.0.0.1:%UI_PORT%/legacy/
echo Keep this window open. Press Ctrl+C to stop.
echo.

rem The server opens the interface after startup, always opening it automatically.
"%STUDIO_NODE%" --experimental-strip-types src\ui\server.ts
if errorlevel 1 pause
exit /b %errorlevel%

:missing
echo [Automation Studio] Portable Node runtime was not found.
echo Expected: runtime\node\node.exe
echo Run setup-runtime.bat to download Node.js, or restore runtime\node\node.exe from your existing installation.
pause
exit /b 1
