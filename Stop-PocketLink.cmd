@echo off
chcp 65001 >nul
title Stop PocketLink
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" -Stop
if errorlevel 1 pause
