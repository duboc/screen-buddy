<#
.SYNOPSIS
  Restarts the screen-buddy HUD.

.DESCRIPTION
  Stops any running instance and starts a fresh one, hidden.

  Deliberately does NOT kill electron.exe by name — VS Code, Discord, Slack and
  plenty of other apps are Electron too, and a name match would take them all
  down. Instead it matches on the command line containing this project's own
  path, so only this app's processes are touched.

.PARAMETER StopOnly
  Stop the HUD without starting it again.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$StopOnly)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Get-HudProcesses {
    # CommandLine is only available through CIM, not Get-Process.
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProjectRoot*" }
}

$running = @(Get-HudProcesses)

if ($running.Count -gt 0) {
    Write-Host "Stopping $($running.Count) screen-buddy process(es)..." -ForegroundColor Gray
    foreach ($p in $running) {
        if ($PSCmdlet.ShouldProcess("PID $($p.ProcessId)", 'stop')) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    # Give the single-instance lock time to clear, or the new instance will see
    # the old one still holding it and immediately quit.
    Start-Sleep -Milliseconds 1200
} else {
    Write-Host 'screen-buddy was not running.' -ForegroundColor Gray
}

# The media helper is a child powershell.exe; if it outlived its parent, clear it.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*nowplaying-loop.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($StopOnly) {
    Write-Host 'Stopped.' -ForegroundColor Green
    return
}

if ($PSCmdlet.ShouldProcess('screen-buddy', 'start')) {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if (-not $npm) { throw 'npm was not found on PATH.' }

    Start-Process -FilePath $npm -ArgumentList 'start' `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden
    Write-Host 'screen-buddy started.' -ForegroundColor Green
}
