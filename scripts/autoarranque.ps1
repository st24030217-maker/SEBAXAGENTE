# Activa o quita el arranque automático del agente al prender la PC.
#   Activar:  powershell -ExecutionPolicy Bypass -File scripts\autoarranque.ps1
#   Quitar:   powershell -ExecutionPolicy Bypass -File scripts\autoarranque.ps1 -Quitar
param([switch]$Quitar)

$inicio = [Environment]::GetFolderPath("Startup")
$acceso = Join-Path $inicio "Agente Sebax.lnk"

if ($Quitar) {
  Remove-Item $acceso -ErrorAction SilentlyContinue
  Write-Output "Arranque automático desactivado."
  exit 0
}

$vbs = Join-Path $PSScriptRoot "iniciar-oculto.vbs"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($acceso)
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = "`"$vbs`""
$lnk.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$lnk.Description = "Inicia el Agente Sebax en segundo plano"
$lnk.Save()
Write-Output "Arranque automático activado: $acceso"
