param([switch] $Launch)
# Keeps Codiby's WSL server up when WSL is the base. Run at logon (task
# "Codiby WSL Bridge") and by the "Codiby Code (WSL)" shortcut (-Launch).
# Written by the Codiby installer to %LOCALAPPDATA%\codiby-base\bridge.ps1.
$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:LOCALAPPDATA 'codiby-base'
$cfg = Get-Content (Join-Path $StateDir 'config.json') -Raw | ConvertFrom-Json
if ($cfg.base -ne 'WSL') { exit 0 }
$AppDir   = Join-Path $env:LOCALAPPDATA 'Programs\codiby-code'
$AppExe   = Join-Path $AppDir 'Codiby Code.exe'
$ServerJs = Join-Path $AppDir 'resources\server.js'
$HashFile = Join-Path $StateDir 'server.sha256'
$Log      = Join-Path $StateDir 'bridge.log'
function Write-Log($m) { Add-Content $Log ("[{0:s}] {1}" -f (Get-Date), $m) }
function Test-Health { try { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$($cfg.port)/health" -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }

$appRunning = [bool](Get-Process 'Codiby Code' -ErrorAction SilentlyContinue)

# The app updated: copy its new server.js to WSL, only while the app is closed
# so an open window keeps its server.
$hash = (Get-FileHash $ServerJs).Hash
$old = if (Test-Path $HashFile) { (Get-Content $HashFile -Raw).Trim() } else { '' }
if ($hash -ne $old -and -not $appRunning) {
  Write-Log "server.js changed; copying it to $($cfg.distro)"
  $src = (& wsl.exe -d $cfg.distro --exec wslpath -u $ServerJs).Trim()
  & wsl.exe -d $cfg.distro --exec sh -c "D=`$HOME/.codiby/wsl-bridge; if [ -f `$D/bridge.pid ]; then kill `$(cat `$D/bridge.pid) 2>/dev/null; rm -f `$D/bridge.pid; sleep 1; fi; cp '$src' `$D/server.js.tmp && mv `$D/server.js.tmp `$D/server.js"
  Set-Content $HashFile $hash
}

# A wsl.exe has to stay alive, or WSL shuts the distro (and the server) down.
$keeper = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.CommandLine -match 'wsl-bridge/start\.sh' -and $_.CommandLine -match [regex]::Escape($cfg.distro) }
if (-not $keeper) {
  Write-Log "Starting the server in $($cfg.distro)"
  Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d', $cfg.distro, '--exec', 'sh', '-c', '"$HOME/.codiby/wsl-bridge/start.sh && exec sleep infinity"'
}

$ok = $false
for ($i = 0; $i -lt 40; $i++) { if (Test-Health) { $ok = $true; break }; Start-Sleep -Milliseconds 500 }
Write-Log ("Server on port {0}: {1}" -f $cfg.port, $(if ($ok) { 'ok' } else { 'NOT RESPONDING' }))

if ($Launch) {
  if (-not $ok) {
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show("Codiby's WSL server ($($cfg.distro)) didn't respond. See $Log.", 'Codiby Code (WSL)')
    exit 1
  }
  if (-not $appRunning) { Start-Process $AppExe }
}
