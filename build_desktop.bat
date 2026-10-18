@echo off
title Build SLATE Teams Desktop

set PYTHON_EXE=C:\Users\caryw\AppData\Local\Programs\Python\Python314\python.exe

echo [SLATE Teams] Building desktop package...
"%PYTHON_EXE%" -m PyInstaller --noconfirm --clean SLATE_Teams.spec

if not exist "dist\SLATE-Teams\data\skills" mkdir "dist\SLATE-Teams\data\skills"
if exist "data\constitution.json" copy /Y "data\constitution.json" "dist\SLATE-Teams\data\constitution.json" >nul
if exist "data\skills\.gitkeep" copy /Y "data\skills\.gitkeep" "dist\SLATE-Teams\data\skills\.gitkeep" >nul
rem NOTE: keep this file ASCII-only. cmd.exe parses .bat in the OEM code page, so a
rem non-ASCII line with LF endings makes it swallow the next newline and run the
rem following command as garbage. Bundled SKILL.md skills and expert packs are
rem shipped as whole dirs; the installer uses onlyifdoesntexist so user edits stay.
if exist "data\skills" xcopy "data\skills" "dist\SLATE-Teams\data\skills\" /E /I /Y /Q >nul
if exist "data\experts" xcopy "data\experts" "dist\SLATE-Teams\data\experts\" /E /I /Y /Q >nul

echo [SLATE Teams] Done: dist\SLATE-Teams\SLATE-Teams.exe
pause
