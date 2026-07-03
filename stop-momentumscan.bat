@echo off
rem MomentumScan one-click stop (Windows).
cd /d "%~dp0"
docker compose down
echo MomentumScan stopped. Your data and settings are kept.
pause
