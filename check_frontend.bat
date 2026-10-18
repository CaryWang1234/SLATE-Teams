@echo off
setlocal
cd /d "%~dp0"
node scripts\check_frontend_integrity.mjs
exit /b %ERRORLEVEL%
