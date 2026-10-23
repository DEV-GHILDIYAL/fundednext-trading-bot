# Pull the latest code and restart the bridge. Run by GitHub Actions through SSM (as SYSTEM)
# or manually from an Administrator PowerShell.
param(
  [string]$Branch = 'main',
  [string]$Region = 'ap-south-1',
  [string]$Prefix = '/fundednext-bot',
  [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$AppDir = 'C:\fundednext-bot'
$git = 'C:\Program Files\Git\cmd\git.exe'

Write-Output "Deploying $Branch to $AppDir"
& $git -c safe.directory=* -C $AppDir fetch --prune origin
& $git -c safe.directory=* -C $AppDir reset --hard "origin/$Branch"
if ($LASTEXITCODE -ne 0) { throw 'git update failed' }

$py = Join-Path $AppDir 'bridge\.venv\Scripts\python.exe'
& $py -m pip install -r (Join-Path $AppDir 'bridge\requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

& (Join-Path $AppDir 'scripts\windows\write-env.ps1') -Region $Region -Prefix $Prefix

Write-Output 'Restarting bridge...'
Stop-ScheduledTask -TaskName 'MT5Bridge' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*uvicorn app:app*' -or $_.CommandLine -like '*start-bridge.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'MT5Bridge'

# Health check (MT5 login can take a few seconds)
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 5
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if ($h.ok) { Write-Output "Bridge healthy (tradeAllowed=$($h.tradeAllowed))"; exit 0 }
    Write-Output 'Bridge up, MT5 not connected yet...'
  } catch { Write-Output 'Waiting for bridge...' }
}
throw 'Bridge did not become healthy within 60s (is the Administrator session logged on?)'
