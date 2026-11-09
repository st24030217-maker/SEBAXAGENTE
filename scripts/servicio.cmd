@echo off
rem ============================================================
rem  Mantiene el agente prendido: si se cae, lo vuelve a iniciar.
rem  Lo lanza scripts\iniciar-oculto.vbs (sin ventana) al prender la PC.
rem  Registro en logs\agente.log
rem ============================================================
cd /d "%~dp0.."
if not exist logs mkdir logs

rem Si ya hay un agente corriendo en el puerto 3000, no abrimos otro.
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul && exit /b 0

set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node

:loop
echo [%date% %time%] Iniciando agente >> logs\agente.log
%NODE% --disable-warning=ExperimentalWarning src\server.js >> logs\agente.log 2>&1
echo [%date% %time%] El agente se detuvo. Reinicio en 10 segundos >> logs\agente.log
timeout /t 10 /nobreak >nul
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul && exit /b 0
goto loop
