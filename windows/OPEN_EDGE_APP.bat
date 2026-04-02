@echo off
setlocal
set URL=http://localhost:%PORT%/
if "%PORT%"=="" set URL=http://localhost:3000/

REM Try common Edge locations
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if exist "%EDGE%" goto run
set EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
if exist "%EDGE%" goto run

REM Fallback: try where
for /f "delims=" %%P in ('where msedge 2^>nul') do (
  set EDGE=%%P
  goto run
)

echo Edge (msedge.exe) niet gevonden. Open manueel: %URL%
exit /b 1

:run
start "" "%EDGE%" --app=%URL% --new-window
exit /b 0
