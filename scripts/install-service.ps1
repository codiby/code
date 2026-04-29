# Install the Codiby Code bridge server as a native Windows service.
#
# Registers a `CodibyCodeBridge` service via `sc.exe` that runs the
# codiby-code-service.exe wrapper binary, which in turn spawns
# `bun.exe run server.js` and forwards SCM stop/shutdown signals. Must be run
# from an elevated PowerShell.
#
# Equivalent of `scripts/install.sh` on macOS (launchd).
#
# Usage:
#   Right-click PowerShell → Run as administrator
#   .\scripts\install-service.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$ServiceName   = 'CodibyCodeBridge'
$DisplayName   = 'Codiby Code Bridge Server'
$Description   = 'Local bridge server for the Codiby Code desktop app (Claude Agent SDK, MCP, PTY).'
$ProjectDir    = Resolve-Path (Join-Path $PSScriptRoot '..')
$ServiceDir    = Join-Path $env:ProgramData 'codiby'
$LogDir        = Join-Path $ServiceDir 'logs'
$PortFile      = Join-Path $ServiceDir 'server.port'
$ServiceExeSrc = Join-Path $ProjectDir 'src-tauri\target\release\codiby-code-service.exe'
$ServiceExeDst = Join-Path $ServiceDir 'codiby-code-service.exe'
$ServerJs      = Join-Path $ServiceDir 'server.js'
$BunDst        = Join-Path $ServiceDir 'bun.exe'

Write-Host '=== Installing Codiby Code Bridge Server ===' -ForegroundColor Cyan

# --- Preflight: locate bun.exe ---------------------------------------------
$BunSrc = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $BunSrc) {
    $candidate = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $candidate) { $BunSrc = $candidate }
}
if (-not $BunSrc -or -not (Test-Path $BunSrc)) {
    Write-Error "bun.exe not found. Install from https://bun.sh and re-run (powershell -c `"irm bun.sh/install.ps1 | iex`")."
    exit 1
}
Write-Host "  bun: $BunSrc"

# --- Ensure service directories --------------------------------------------
New-Item -ItemType Directory -Force -Path $ServiceDir, $LogDir | Out-Null

# --- Build the service wrapper binary (Rust) -------------------------------
Write-Host 'Building codiby-code-service.exe (release)...'
Push-Location (Join-Path $ProjectDir 'src-tauri')
try {
    & cargo build --release --bin codiby-code-service
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
if (-not (Test-Path $ServiceExeSrc)) {
    Write-Error "Build succeeded but $ServiceExeSrc is missing."
    exit 1
}

# --- Bundle the server -----------------------------------------------------
Write-Host 'Bundling server into server.js...'
Push-Location $ProjectDir
try {
    & $BunSrc build .\server\index.ts --outfile $ServerJs --target bun --minify
    if ($LASTEXITCODE -ne 0) { throw "bun build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# --- Clean legacy PTY helper -----------------------------------------------
# Interactive PTYs now use Bun.Terminal (Bun >= 1.3.5) — no Node helper.
$LegacyHelper = Join-Path $ServiceDir 'pty-helper.mjs'
if (Test-Path $LegacyHelper) { Remove-Item -Force $LegacyHelper }
$LegacyNodePty = Join-Path $ServiceDir 'node_modules\node-pty'
if (Test-Path $LegacyNodePty) { Remove-Item -Recurse -Force $LegacyNodePty }

# --- Build dist for the mobile UI ------------------------------------------
$DistSrc = Join-Path $ProjectDir 'dist'
if (-not (Test-Path $DistSrc)) {
    Write-Host 'Building frontend (for mobile UI)...'
    Push-Location $ProjectDir
    try {
        & $BunSrc run build | Out-Null
    } finally {
        Pop-Location
    }
}
$DistDst = Join-Path $ServiceDir 'dist'
if (Test-Path $DistDst) { Remove-Item -Recurse -Force $DistDst }
Copy-Item -Recurse -Force $DistSrc $DistDst

# --- Copy bun + service wrapper into the service dir -----------------------
Copy-Item -Force $BunSrc $BunDst
Copy-Item -Force $ServiceExeSrc $ServiceExeDst

# --- Stop + delete any existing service before recreating ------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host 'Stopping and removing existing service...'
    if ($existing.Status -ne 'Stopped') {
        & sc.exe stop $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# --- Create the service ----------------------------------------------------
Write-Host "Registering $ServiceName with SCM..."
& sc.exe create $ServiceName binPath= "`"$ServiceExeDst`"" start= auto DisplayName= "`"$DisplayName`"" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'sc.exe create failed.'; exit 1 }
& sc.exe description $ServiceName $Description | Out-Null
# Restart automatically if the wrapper exits with a non-zero code.
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

# --- Start the service -----------------------------------------------------
Write-Host 'Starting service...'
& sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq 'Running') {
    Write-Host ''
    Write-Host "=== Service installed and running ===" -ForegroundColor Green
    Write-Host "  Name:      $ServiceName"
    Write-Host "  Dir:       $ServiceDir"
    Write-Host "  Logs:      $LogDir"
    Write-Host "  Port file: $PortFile"
    Write-Host ''
    Write-Host "  Health:    curl http://localhost:3111/health"
    Write-Host "  Uninstall: .\scripts\uninstall-service.ps1"
    Write-Host "  Restart:   .\scripts\restart-service.ps1"
} else {
    Write-Warning "Service registered but not running (state=$($svc.Status)). Check $LogDir\stderr.log."
    exit 1
}
