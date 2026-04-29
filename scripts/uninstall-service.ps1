# Uninstall the Codiby Code bridge server Windows service.
#
# Stops the `CodibyCodeBridge` service, deletes it from the SCM, and removes
# the `%PROGRAMDATA%\codiby\` directory (server bundle, bun.exe, logs, port
# file). Must be run from an elevated PowerShell.

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$ServiceName = 'CodibyCodeBridge'
$ServiceDir  = Join-Path $env:ProgramData 'codiby'
$PortFile    = Join-Path $ServiceDir 'server.port'

Write-Host '=== Uninstalling Codiby Code Bridge Server ===' -ForegroundColor Cyan

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne 'Stopped') {
        Write-Host 'Stopping service...'
        & sc.exe stop $ServiceName | Out-Null
        # Wait up to 10s for a clean stop before forcing a delete
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            $svc.Refresh()
            if ($svc.Status -eq 'Stopped') { break }
        }
    }
    Write-Host 'Removing service...'
    & sc.exe delete $ServiceName | Out-Null
} else {
    Write-Host "Service '$ServiceName' was not registered — skipping SCM steps."
}

# Port file (defensive — the bundle server removes this on clean shutdown)
if (Test-Path $PortFile) { Remove-Item -Force $PortFile }

# Service directory
if (Test-Path $ServiceDir) {
    Write-Host "Removing $ServiceDir..."
    Remove-Item -Recurse -Force $ServiceDir
}

Write-Host ''
Write-Host '=== Service uninstalled ===' -ForegroundColor Green
