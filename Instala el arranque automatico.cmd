@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BrainUp Academy - arranque automatico

rem Node se busca sin depender del PATH, igual que en "Arranca BrainUp.cmd": asi
rem este doble clic funciona aunque el entorno venga recortado.
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto sinNode
if not exist "scripts\instala-arranque.js" goto sinScript

echo.
echo   BrainUp Academy: poniendo el arranque automatico
echo   (acceso directo al iniciar sesion + latido cada 5 minutos)
echo.

"%NODE_EXE%" "scripts\instala-arranque.js"
set "CODIGO=%ERRORLEVEL%"

echo.
if not "%CODIGO%"=="0" echo   No se ha podido terminar: copia lo de arriba y pasalo.
if "%CODIGO%"=="0" echo   Hecho. La app se abre en http://localhost:3000
if "%CODIGO%"=="0" echo   Desde el movil, en la misma Wi-Fi, con la direccion "Movil:" de arriba.
echo.
echo   Pulsa una tecla para cerrar esta ventana.
pause >nul
exit /b %CODIGO%

:sinNode
echo.
echo   No encuentro Node.js en este ordenador.
echo   Instalalo desde https://nodejs.org (version 20 o mas nueva)
echo   y vuelve a hacer doble clic aqui.
echo.
pause
exit /b 1

:sinScript
echo.
echo   Falta el archivo scripts\instala-arranque.js de este proyecto.
echo   Comprueba que esta carpeta es la carpeta completa del proyecto.
echo.
pause
exit /b 1
