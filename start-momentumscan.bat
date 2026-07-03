@echo off
rem MomentumScan one-click start (Windows). Requires Docker Desktop running.
cd /d "%~dp0"
if not exist .env (
  echo.
  echo  No .env file found. Copying the template...
  copy .env.example .env >nul
  echo  Now open .env in Notepad and paste your Upstox API key and secret,
  echo  then run this file again.
  notepad .env
  exit /b 1
)
echo Starting MomentumScan (first run builds images - takes a few minutes)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo  Something failed. Is Docker Desktop running? (whale icon in the tray)
  pause
  exit /b 1
)
echo Opening the dashboard...
start http://localhost:3000
echo.
echo MomentumScan is running. To stop it, run stop-momentumscan.bat
pause
