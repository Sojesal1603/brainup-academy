@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BrainUp Academy - Reinicio Automatico

rem Node se busca a proposito sin depender del PATH: el PATH de un doble clic puede
venir recortado, y entonces "node" no existe aunque este instalado.
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto sinNode

rem Matar procesos Node/Next anteriores que puedan ocupar el puerto
echo Limpiando procesos anteriores...
taskkill /F /IM "node.exe" 2>nul
taskkill /F /IM "next dev" 2>nul
timeout /t 3 /nobreak >nul

rem Intentar arrancar en el puerto 3000
echo Arrancando BrainUp Academy en http://localhost:3000...
"%NODE_EXE%" "scripts\sirve.js" --abrir
set "CODIGO=%ERRORLEVEL%"

rem Si la app ya estaba en pie, sirve.js termina en el acto y con exito
if "%CODIGO%"=="0" (
    echo.
    echo ¡App levantada exitosamente!
    echo Accede en: http://localhost:3000
    pause >nul
    exit /b 0
)

echo.
echo La app no arrancó con el método normal.
echo Intentando arranque manual...
echo.

rem Fallback: intentar npx next dev -p 3000
cd /d "%~dp0"
npx next dev -p 3000 >nul 2>&1 &
set "CODIGO2=%ERRORLEVEL%"
timeout /t 5 /nobreak >nul

if "%CODIGO2%"=="0" (
    echo.
    echo App intentando levantarse en segundo plano...
    echo Accede en breve en: http://localhost:3000
    pause >nul
    exit /b 0
)

:sinNode
echo.
echo No encuentro Node.js en este ordenador.
echo Instalalo desde https://nodejs.org (version 20 o mas nueva)
echo y vuelve a hacer doble clic aqui.
pause
exit /b 1

:sirveScript
echo.
echo Falta el archivo scripts\sirve.js de este proyecto.
echo Comprueba que esta carpeta es la carpeta completa del proyecto.
pause
exit /b 1