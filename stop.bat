@echo off
title SLATE Teams Stop
setlocal

set "PORT=8130"
set "FOUND="

echo [SLATE Teams] Stopping service on port %PORT%...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo [SLATE Teams] Killing PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

if not defined FOUND (
  echo [SLATE Teams] No process is listening on port %PORT%.
) else (
  echo [SLATE Teams] Port %PORT% is clear.
)

endlocal
pause
