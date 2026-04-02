@echo off
setlocal
cd /d "%~dp0"
REM Optional: change port / admin key here
REM set PORT=3000
REM set ADMIN_KEY=1234
node backend\server.js
