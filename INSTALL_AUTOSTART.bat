@echo off
setlocal
cd /d "%~dp0"
set ROOT=%CD%\
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS=%STARTUP%\SchelleCrewPlanner-Server.vbs

(
  echo ' Schelle Crew Planner - autostart server (generated)
  echo On Error Resume Next
  echo Dim shell
  echo Set shell = CreateObject("WScript.Shell")
  echo shell.CurrentDirectory = "%ROOT%"
  echo shell.Run Chr(34) ^& "%ROOT%windows\START_SERVER_SILENT.bat" ^& Chr(34), 0, False
) > "%VBS%"

echo ✅ Autostart gezet.
echo - Server start automatisch bij aanmelden.
echo - Wil je dit verwijderen? Run UNINSTALL_AUTOSTART.bat
pause
