@echo off
setlocal

echo ===========================
echo   Build para Node (PKG)
echo ===========================
echo.
echo 1. Build para Windows
echo 2. Build para Linux
echo.

set /p escolha=Escolha o sistema (1 ou 2): 

if "%escolha%"=="1" (
    echo Buildando para Windows...
    pkg . --targets node18-win-x64 --output firebase.exe
    goto :fim
)

if "%escolha%"=="2" (
    echo Buildando para Linux...
    pkg . --targets node18-linux-x64 --output firebase
    goto :fim
)

echo Opcao invalida. Use 1 ou 2.
goto :fim

:fim
pause

