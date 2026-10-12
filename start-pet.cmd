@echo off
rem ---------------------------------------------------------------
rem  Launch the Live2D desktop pet (Hiyori).
rem
rem  Clearing ELECTRON_RUN_AS_NODE is mandatory here: some shells set
rem  it to 1, which silently downgrades electron.exe into a plain Node
rem  runtime -- the app then exits instantly with no output at all.
rem ---------------------------------------------------------------
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
