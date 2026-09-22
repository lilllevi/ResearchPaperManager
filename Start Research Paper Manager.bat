@echo off
rem Double-click to start Research Paper Manager (opens in your browser).
rem Runs run.ps1 without needing a terminal or a PowerShell execution-policy change.
title Research Paper Manager
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
if errorlevel 1 pause
