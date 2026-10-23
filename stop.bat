@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4173" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
echo Automation Studio stopped.
timeout /t 2 >nul
