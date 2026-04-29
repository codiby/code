# Rebuild the server bundle + service wrapper binary, redeploy into
# `%PROGRAMDATA%\codiby\`, and restart the `CodibyCodeBridge` Windows service.
#
# Use this after editing anything under `server/`, `src/` (for the mobile UI
# dist), or the Rust service wrapper. Must be run from an elevated PowerShell.

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$ServiceName   = 'CodibyCodeBridge'
$ProjectDir    = Resolve-Path (Join-Path $PSScriptRoot '..')
$ServiceDir    = Join-Path $env:ProgramData 'codiby'
$ServiceExeSrc = Join-Path $ProjectDir 'src-tauri\target\release\codiby-code-service.exe'
$ServiceExeDst = Join-Path $ServiceDir 'codiby-code-service.exe'
$ServerJs      = Join-Path $ServiceDir 'server.js'

if (-not (Test-Path $ServiceDir)) {
    Write-Error "Service dir $ServiceDir doesn't exist. Run install-service.ps1 first."
    exit 1
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Error "Service '$ServiceName' is not registered. Run install-service.ps1 first."
    exit 1
}

$BunSrc = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $BunSrc) {
    $candidate = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $candidate) { $BunSrc = $candidate }
}
if (-not $BunSrc -or -not (Test-Path $BunSrc)) {
    Write-Error 'bun.exe not found on PATH — cannot rebuild server bundle.'
    exit 1
}

Write-Host 'Rebuilding server bundle...'
Push-Location $ProjectDir
try {
    & $BunSrc build .\server\index.ts --outfile $ServerJs --target bun --minify
    if ($LASTEXITCODE -ne 0) { throw "bun build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host 'Rebuilding codiby-code-service.exe (release)...'
Push-Location (Join-Path $ProjectDir 'src-tauri')
try {
    & cargo build --release --bin codiby-code-service
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# Drop legacy PTY helper / node-pty if they were left behind by a prior install
# (interactive PTYs now use Bun.Terminal directly).
$LegacyHelper = Join-Path $ServiceDir 'pty-helper.mjs'
if (Test-Path $LegacyHelper) { Remove-Item -Force $LegacyHelper }
$LegacyNodePty = Join-Path $ServiceDir 'node_modules\node-pty'
if (Test-Path $LegacyNodePty) { Remove-Item -Recurse -Force $LegacyNodePty }

# Refresh dist (mobile UI) if it exists in the repo
$DistSrc = Join-Path $ProjectDir 'dist'
if (Test-Path $DistSrc) {
    $DistDst = Join-Path $ServiceDir 'dist'
    if (Test-Path $DistDst) { Remove-Item -Recurse -Force $DistDst }
    Copy-Item -Recurse -Force $DistSrc $DistDst
}

Write-Host 'Stopping service...'
if ($svc.Status -ne 'Stopped') {
    & sc.exe stop $ServiceName | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        $svc.Refresh()
        if ($svc.Status -eq 'Stopped') { break }
    }
}

# The exe is locked while the service runs, so copy only after it's stopped.
Copy-Item -Force $ServiceExeSrc $ServiceExeDst

Write-Host 'Starting service...'
& sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 2

$svc.Refresh()
if ($svc.Status -eq 'Running') {
    try {
        Invoke-RestMethod -Uri 'http://localhost:3111/health' -TimeoutSec 3 | Out-Null
        Write-Host 'Service restarted — health check OK' -ForegroundColor Green
    } catch {
        Write-Warning "Service is running but /health did not respond: $($_.Exception.Message)"
    }
} else {
    Write-Error "Service failed to restart (state=$($svc.Status)). Check $ServiceDir\logs\stderr.log."
    exit 1
}
