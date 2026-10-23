# One-time setup of the Windows MT5 host. Safe to re-run.
#   Called by the Terraform bootstrap; manual run (as Administrator):
#   powershell -ExecutionPolicy Bypass -File C:\fundednext-bot\scripts\windows\setup.ps1
param(
  [string]$Region = 'ap-south-1',
  [string]$Prefix = '/fundednext-bot',
  [int]$BridgePort = 8765,
  [switch]$NoReboot
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BridgeDir = Join-Path $AppDir 'bridge'
$Python = 'C:\Program Files\Python311\python.exe'
$Terminal = 'C:\Program Files\MetaTrader 5\terminal64.exe'

function Get-Param([string]$Name) {
  try { return (Get-SSMParameter -Name "$Prefix/$Name" -WithDecryption $true -Region $Region).Value } catch { return '' }
}

# 1. Python 3.11
if (-not (Test-Path $Python)) {
  Write-Output 'Installing Python 3.11...'
  $exe = Join-Path $env:TEMP 'python-3.11.9-amd64.exe'
  Invoke-WebRequest 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile $exe
  Start-Process $exe -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0' -Wait
}

# 2. MetaTrader 5 terminal
if (-not (Test-Path $Terminal)) {
  Write-Output 'Installing MetaTrader 5...'
  $exe = Join-Path $env:TEMP 'mt5setup.exe'
  Invoke-WebRequest 'https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe' -OutFile $exe
  Start-Process $exe -ArgumentList '/auto' -Wait
  # the installer starts the terminal when done; close it, the bridge launches it with the login
  Start-Sleep -Seconds 20
  Get-Process terminal64 -ErrorAction SilentlyContinue | Stop-Process -Force
}

# 3. Python venv + bridge dependencies
$Venv = Join-Path $BridgeDir '.venv'
if (-not (Test-Path "$Venv\Scripts\python.exe")) { & $Python -m venv $Venv }
& "$Venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
& "$Venv\Scripts\python.exe" -m pip install -r (Join-Path $BridgeDir 'requirements.txt') --quiet

# 4. bridge\.env from SSM
& (Join-Path $PSScriptRoot 'write-env.ps1') -Region $Region -Prefix $Prefix

# 5. Firewall (the AWS security group still limits who can reach it)
if (-not (Get-NetFirewallRule -DisplayName 'MT5 Bridge' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'MT5 Bridge' -Direction Inbound -Protocol TCP -LocalPort $BridgePort -Action Allow | Out-Null
}

# 6. Administrator password + auto-logon (MT5 needs a desktop session after every reboot)
$adminPassword = Get-Param 'windows_admin_password'
if ($adminPassword) {
  net user Administrator $adminPassword | Out-Null
  $autologon = Join-Path $env:TEMP 'Autologon64.exe'
  try {
    Invoke-WebRequest 'https://live.sysinternals.com/Autologon64.exe' -OutFile $autologon
    # stores the password as an encrypted LSA secret (not plain text in the registry)
    Start-Process $autologon -ArgumentList "Administrator $env:COMPUTERNAME `"$adminPassword`" /accepteula" -Wait
  } catch {
    Write-Output "Autologon64 failed ($_), falling back to registry auto-logon"
    $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty $wl AutoAdminLogon '1'
    Set-ItemProperty $wl DefaultUserName 'Administrator'
    Set-ItemProperty $wl DefaultPassword $adminPassword
  }
}

# 7. Scheduled task: start the bridge (and MT5) at logon, restart on failure
$start = Join-Path $PSScriptRoot 'start-bridge.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$start`" -Port $BridgePort"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'Administrator'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'MT5Bridge' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# Keep the box awake / avoid surprise reboots during the session
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Force | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoRebootWithLoggedOnUsers 1

Write-Output 'Setup complete.'
if (-not $NoReboot) {
  Write-Output 'Rebooting to auto-logon and start MT5 + bridge...'
  Restart-Computer -Force
}
