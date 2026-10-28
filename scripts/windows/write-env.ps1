# Writes bridge\.env from AWS SSM Parameter Store (secrets never live in git).
param(
  [string]$Region = 'ap-south-1',
  [string]$Prefix = '/fundednext-bot'
)
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EnvFile = Join-Path $AppDir 'bridge\.env'

function Get-Param([string]$Name) {
  (Get-SSMParameter -Name "$Prefix/$Name" -WithDecryption $true -Region $Region).Value
}

$lines = @(
  "BRIDGE_TOKEN=$(Get-Param 'bridge_token')",
  "MT5_LOGIN=$(Get-Param 'mt5_login')",
  "MT5_PASSWORD=$(Get-Param 'mt5_password')",
  "MT5_SERVER=$(Get-Param 'mt5_server')",
  'MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe',
  'ALLOWED_SYMBOLS=XAUUSD',
  'MT5_MAGIC=260101',
  'BRIDGE_LOG_LEVEL=INFO',
  'BRIDGE_MOCK=0'
)
Set-Content -Path $EnvFile -Value $lines -Encoding ascii
# only Administrators/SYSTEM may read it
icacls $EnvFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Write-Output "Wrote $EnvFile"
