@echo off
setlocal
cd /d "%~dp0"
REM Start server in background (hidden) if not already running
call windows\START_SERVER_SILENT.bat
REM Open as Edge "app" window (uses PWA icons)
call windows\OPEN_EDGE_APP.bat
