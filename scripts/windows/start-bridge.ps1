# Runs at logon (scheduled task "MT5Bridge"): starts MT5 and keeps the bridge API alive.
param([int]$Port = 8765)
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BridgeDir = Join-Path $AppDir 'bridge'
$Python = Join-Path $BridgeDir '.venv\Scripts\python.exe'
$Terminal = 'C:\Program Files\MetaTrader 5\terminal64.exe'
$LogDir = Join-Path $BridgeDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'bridge.log'

function Write-Log([string]$msg) { Add-Content -Path $Log -Value "$(Get-Date -Format s) [runner] $msg" }

Set-Location $BridgeDir
while ($true) {
  if (-not (Get-Process terminal64 -ErrorAction SilentlyContinue)) {
    Write-Log 'Starting MetaTrader 5 terminal'
    Start-Process $Terminal
    Start-Sleep -Seconds 15
  }
  # Rotate the log at ~10 MB
  if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 10MB)) { Move-Item $Log "$Log.1" -Force }

  Write-Log "Starting bridge on port $Port"
  & $Python -m uvicorn app:app --host 0.0.0.0 --port $Port *>> $Log
  Write-Log "Bridge exited with code $LASTEXITCODE - restarting in 10s"
  Start-Sleep -Seconds 10
}
