@echo off
cd /d "%~dp0"
node scripts\studio-local.mjs
if errorlevel 1 pause
