@echo off
setlocal
cd /d "%~dp0\.."

REM Port check (default 3000)
if "%PORT%"=="" set PORT=3000

REM If already listening, do nothing
for /f "tokens=1,2,3,4,5" %%A in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
  exit /b 0
)

REM Start server hidden
set CMD=%CD%\RUN_SERVER.bat
wscript.exe "%~dp0run-silent.vbs" "%CMD%"

REM Give it a moment
ping 127.0.0.1 -n 2 >nul
exit /b 0
