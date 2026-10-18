@echo off
title Build SLATE Teams Installer
rem Usage: build_installer.bat [version]
rem   version: full version, prerelease suffix allowed (0.4.5 / 0.4.5-rc1 / 0.4.5-beta2).
rem   Omit to use MyAppVersion defined in SLATE_Teams.iss.

set ISCC=ISCC.exe
set ISCC_FOUND=0
where ISCC.exe >nul 2>&1
if %errorlevel% equ 0 (
  set ISCC_FOUND=1
) else (
  if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
    set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files (x86)\Inno Setup 7\ISCC.exe" (
    set "ISCC=C:\Program Files (x86)\Inno Setup 7\ISCC.exe"
    set ISCC_FOUND=1
  )
  if exist "C:\Program Files\Inno Setup 7\ISCC.exe" (
    set "ISCC=C:\Program Files\Inno Setup 7\ISCC.exe"
    set ISCC_FOUND=1
  )
)

if "%ISCC_FOUND%" neq "1" (
  echo [SLATE Teams] Inno Setup compiler was not found.
  echo [SLATE Teams] Install Inno Setup 6/7 or add ISCC.exe to PATH.
  pause
  exit /b 1
)

if not exist "dist\SLATE-Teams\SLATE-Teams.exe" (
  echo [SLATE Teams] dist\SLATE-Teams\SLATE-Teams.exe not found.
  echo [SLATE Teams] Run build_desktop.bat first.
  pause
  exit /b 1
)

echo [SLATE Teams] Building installer...
rem Optional arg 1 = full version incl. prerelease suffix, e.g. 0.4.5-rc1.
set "VER_ARG="
if not "%~1"=="" set "VER_ARG=/DMyAppVersion=%~1"
if not "%~1"=="" echo [SLATE Teams] Version override: %~1
"%ISCC%" %VER_ARG% "SLATE_Teams.iss"
if %errorlevel% neq 0 (
  echo [SLATE Teams] Inno Setup compiler failed or was not found.
  echo [SLATE Teams] Install Inno Setup 6 or open SLATE_Teams.iss manually.
  pause
  exit /b 1
)

echo [SLATE Teams] Done. See installer\SLATE-Teams-Setup-*.exe
pause
