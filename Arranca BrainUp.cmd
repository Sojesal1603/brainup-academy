@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BrainUp Academy

rem Node se busca a proposito sin depender del PATH: el PATH de un doble clic puede
rem venir recortado, y entonces "node" no existe aunque este instalado.
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto sinNode
if not exist "scripts\sirve.js" goto sinScript

echo.
echo   BrainUp Academy
echo   ----------------
echo   Arrancando la app. La primera vez tarda unos segundos.
echo.
echo   Esta ventana mantiene la app en marcha: puedes minimizarla.
echo   Si la cierras, la app se para; si el arranque automatico esta
echo   puesto, vuelve a levantarse sola en menos de 5 minutos.
echo.

"%NODE_EXE%" "scripts\sirve.js" --abrir
set "CODIGO=%ERRORLEVEL%"

rem Si la app ya estaba en pie, sirve.js termina en el acto y con exito: no hay
rem nada que avisar, la ventana se cierra y el navegador ya se ha abierto.
if "%CODIGO%"=="0" exit /b 0

echo.
echo   La app ha terminado con un error (codigo %CODIGO%).
echo   Lo ultimo que se sabe esta en:
echo     data\logs\arranque.log
echo     data\logs\servidor.log
echo.
echo   Copia este texto y pasalo para poder arreglarlo.
echo.
pause
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
echo   Falta el archivo scripts\sirve.js de este proyecto.
echo   Comprueba que esta carpeta es la carpeta completa del proyecto.
echo.
pause
exit /b 1
