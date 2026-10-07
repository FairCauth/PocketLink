@echo off
chcp 65001 >nul
title PocketLink - Uninstall audio driver
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-cable.ps1" -Action Uninstall
pause
