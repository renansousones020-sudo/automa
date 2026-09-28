@echo off
title togag — Servidor
echo.
echo  Iniciando togag...
echo  Acesse: http://localhost:3000/video
echo  Usuario: admin
echo  Senha:   KpjUyTAFLaVAwLRS
echo.

set NODE=%USERPROFILE%\node-portable\node-v22.12.0-win-x64\node.exe
cd /d "C:\Users\renan.andrade\Desktop\testes gag\togag-main"

taskkill /IM node.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

"%NODE%" server/index.js
pause
