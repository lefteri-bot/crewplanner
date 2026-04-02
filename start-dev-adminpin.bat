@echo off
setlocal enabledelayedexpansion
REM --- Zet hier je admin PIN ---
set ADMIN_KEY=1234

REM --- Start zoals start-dev.bat ---
if not exist "node_modules" (
  echo [INFO] node_modules ontbreekt. npm install wordt uitgevoerd...
  npm install
  if errorlevel 1 (
    echo [ERROR] npm install faalde. Controleer Node.js installatie.
    pause
    exit /b 1
  )
)

echo [INFO] Starten met ADMIN_KEY...
node start-dev.js
