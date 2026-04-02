@echo off
setlocal
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS=%STARTUP%\SchelleCrewPlanner-Server.vbs
if exist "%VBS%" del "%VBS%"
echo ✅ Autostart verwijderd.
pause
