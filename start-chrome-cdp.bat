@echo off
setlocal
set "PORT=9222"
if not "%~1"=="" set "PORT=%~1"
set "PROFILE=%LOCALAPPDATA%\AutomationStudio\ChromeCDPProfile"
set "CHROME="

if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo [ERROR] Google Chrome not found.
  echo Please install Chrome or edit this BAT and set CHROME to chrome.exe.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

echo Starting Chrome CDP on 127.0.0.1:%PORT%
echo Profile: %PROFILE%
start "" "%CHROME%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run
exit /b 0
