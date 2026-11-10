@echo off
chcp 65001 >nul
title ARC Raiders - сделки
cd /d "%~dp0"
node deals.js
pause
