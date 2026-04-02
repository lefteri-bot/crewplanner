@echo off
setlocal enabledelayedexpansion

REM --- Schelle Crew Planner (dev) ---
REM Installeer dependencies als node_modules ontbreekt
if not exist "node_modules" (
  echo [INFO] node_modules ontbreekt. npm install wordt uitgevoerd...
  npm install
  if errorlevel 1 (
    echo [ERROR] npm install faalde. Controleer Node.js installatie.
    pause
    exit /b 1
  )
)

echo [INFO] Starten...
node start-dev.js
