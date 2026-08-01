<#
.SYNOPSIS
  Configures Windows so the HUD monitor is a dedicated panel and nothing else
  wanders onto it.

.DESCRIPTION
  Every action is opt-in via a switch, every one reports what it changed, and
  -WhatIf works throughout. Run with no switches for a report of the current
  state without touching anything.

  Actions:
    -HideTaskbar     Stop Windows showing the taskbar on secondary displays.
    -AutoStart       Launch screen-buddy at login (per-user, no elevation).
    -InstallLhm      winget-install LibreHardwareMonitor (optional CPU sensors).
    -LhmAutoStart    Scheduled task to start LHM elevated at logon.
    -All             Everything above.

.EXAMPLE
  .\scripts\setup-windows.ps1
  Reports current state, changes nothing.

.EXAMPLE
  .\scripts\setup-windows.ps1 -HideTaskbar -AutoStart

.EXAMPLE
  .\scripts\setup-windows.ps1 -All -WhatIf
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$HideTaskbar,
    [switch]$AutoStart,
    [switch]$InstallLhm,
    [switch]$LhmAutoStart,
    [switch]$All,
    [switch]$Undo
)

$ErrorActionPreference = 'Stop'

if ($All) {
    $HideTaskbar = $true; $AutoStart = $true
    $InstallLhm = $true;  $LhmAutoStart = $true
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskName    = 'screen-buddy-lhm'
$RunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValue    = 'screen-buddy'

function Write-Step { param($Message) Write-Host "`n== $Message" -ForegroundColor Cyan }
function Write-Ok   { param($Message) Write-Host "   [ok]   $Message" -ForegroundColor Green }
function Write-Info { param($Message) Write-Host "   [info] $Message" -ForegroundColor Gray }
function Write-Warn { param($Message) Write-Host "   [warn] $Message" -ForegroundColor Yellow }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Find-Lhm {
    # winget ships LibreHardwareMonitor as a PORTABLE package, so it does not
    # land in Program Files at all — it goes under the WinGet package store.
    # Checking only the conventional install directories reports "not
    # installed" for a perfectly good install.
    $fixed = @(
        "$env:ProgramFiles\LibreHardwareMonitor\LibreHardwareMonitor.exe",
        "${env:ProgramFiles(x86)}\LibreHardwareMonitor\LibreHardwareMonitor.exe",
        "$env:LOCALAPPDATA\Programs\LibreHardwareMonitor\LibreHardwareMonitor.exe"
    )
    foreach ($p in $fixed) { if (Test-Path $p) { return $p } }

    foreach ($store in @("$env:LOCALAPPDATA\Microsoft\WinGet\Packages",
                         "$env:ProgramFiles\WinGet\Packages")) {
        if (-not (Test-Path $store)) { continue }
        $hit = Get-ChildItem $store -Recurse -Filter 'LibreHardwareMonitor.exe' `
                   -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

# ── report ───────────────────────────────────────────────────────────────

Write-Step 'Current state'

$mmValue = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name 'MMTaskbarEnabled' -ErrorAction SilentlyContinue).MMTaskbarEnabled
if ($null -eq $mmValue -or $mmValue -eq 1) {
    Write-Info 'Taskbar: shown on all displays (including the HUD panel)'
} else {
    Write-Ok 'Taskbar: primary display only'
}

$runEntry = (Get-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction SilentlyContinue).$RunValue
if ($runEntry) { Write-Ok "Autostart: $runEntry" } else { Write-Info 'Autostart: not configured' }

$lhmInstalled = Find-Lhm

if ($lhmInstalled) { Write-Ok "LibreHardwareMonitor: $lhmInstalled" }
else { Write-Info 'LibreHardwareMonitor: not installed (CPU temp/power will read "--")' }

try {
    $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8085/data.json' -TimeoutSec 2 -UseBasicParsing
    Write-Ok 'LHM web server: responding on 127.0.0.1:8085'
} catch {
    Write-Info 'LHM web server: not responding on 127.0.0.1:8085'
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Ok "Scheduled task '$TaskName': present"
} else {
    Write-Info "Scheduled task '$TaskName': not present"
}

if (-not ($HideTaskbar -or $AutoStart -or $InstallLhm -or $LhmAutoStart -or $Undo)) {
    Write-Host "`nNo actions requested. Re-run with -All, or pick individual switches." -ForegroundColor Yellow
    Write-Host "See: Get-Help .\scripts\setup-windows.ps1 -Detailed`n"
    return
}

# ── undo ─────────────────────────────────────────────────────────────────

if ($Undo) {
    Write-Step 'Reverting'

    if ($PSCmdlet.ShouldProcess('taskbar on all displays', 'restore')) {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name 'MMTaskbarEnabled' -Value 1 -Type DWord
        Write-Ok 'Taskbar restored on all displays (restart Explorer to apply)'
    }
    if ($runEntry -and $PSCmdlet.ShouldProcess($RunValue, 'remove autostart')) {
        Remove-ItemProperty -Path $RunKey -Name $RunValue
        Write-Ok 'Autostart removed'
    }
    if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and
        $PSCmdlet.ShouldProcess($TaskName, 'unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Ok "Scheduled task '$TaskName' removed"
    }
    Write-Host ''
    return
}

# ── taskbar ──────────────────────────────────────────────────────────────

if ($HideTaskbar) {
    Write-Step 'Hiding the taskbar on secondary displays'
    # Equivalent to Settings > Personalization > Taskbar > Taskbar behaviors >
    # "Show my taskbar on all displays" (unchecked). Per-user, no elevation.
    if ($PSCmdlet.ShouldProcess('MMTaskbarEnabled', 'set to 0')) {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' `
            -Name 'MMTaskbarEnabled' -Value 0 -Type DWord
        Write-Ok 'Taskbar limited to the primary display'
        Write-Info 'Restarting Explorer so the change takes effect now'
        Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
        # Explorer relaunches itself; this is the documented way to apply it.
    }
}

# ── autostart ────────────────────────────────────────────────────────────

if ($AutoStart) {
    Write-Step 'Configuring autostart at login'

    # No null-conditional (?.) here: this script has to parse under Windows
    # PowerShell 5.1, which does not support it.
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if (-not $npm) {
        Write-Warn 'npm not found on PATH; skipping autostart'
    } else {
        # Start via a hidden wrapper so no console window flashes at login.
        $vbs = Join-Path $ProjectRoot 'scripts\start-hidden.vbs'
        $cmd = "wscript.exe `"$vbs`""
        if ($PSCmdlet.ShouldProcess($RunValue, 'register autostart')) {
            Set-ItemProperty -Path $RunKey -Name $RunValue -Value $cmd
            Write-Ok "Autostart set: $cmd"
        }
    }
}

# ── LibreHardwareMonitor ─────────────────────────────────────────────────

if ($InstallLhm) {
    if ($lhmInstalled) {
        Write-Step 'LibreHardwareMonitor'
        Write-Info "Already installed at $lhmInstalled; skipping"
    } else {
        Write-Step 'Installing LibreHardwareMonitor'
        # No --disable-interactivity: this needs elevation for its PawnIO
        # dependency, and suppressing the prompt just makes it fail with
        # "cancelled by user". Let the UAC dialog through.
        if ($PSCmdlet.ShouldProcess('LibreHardwareMonitor', 'winget install')) {
            winget install --id LibreHardwareMonitor.LibreHardwareMonitor --exact `
                --accept-package-agreements --accept-source-agreements
            $lhmInstalled = Find-Lhm
            if ($lhmInstalled) { Write-Ok "Installed at $lhmInstalled" }
            else { Write-Warn 'Install did not complete (was the UAC prompt approved?)' }
        }
    }
}

# Pre-seed LHM's settings so the web server is already on at first launch,
# instead of requiring a trip through Options > Remote Web Server > Run.
# LHM writes this file itself on exit; it only reads ours if it has never run.
if ($InstallLhm -or $LhmAutoStart) {
    $exe = if ($lhmInstalled) { $lhmInstalled } else { Find-Lhm }
    if ($exe) {
        $cfg = Join-Path (Split-Path -Parent $exe) 'LibreHardwareMonitor.config'
        if (Test-Path $cfg) {
            Write-Info 'LHM already has a config; leaving its settings alone'
        } elseif ($PSCmdlet.ShouldProcess($cfg, 'seed settings')) {
            @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerPort" value="8085" />
    <add key="startMinMenuItem" value="true" />
    <add key="minTrayMenuItem" value="true" />
    <add key="minCloseMenuItem" value="true" />
  </appSettings>
</configuration>
'@ | Set-Content -Path $cfg -Encoding UTF8
            Write-Ok 'Seeded LHM config: web server on, port 8085, starts minimised'
        }
    }
}

if ($LhmAutoStart) {
    Write-Step 'Scheduling LibreHardwareMonitor to start elevated at logon'

    if (-not (Test-Admin)) {
        Write-Warn 'Creating a highest-privilege scheduled task needs an elevated shell.'
        Write-Warn 'Re-run this script from an Administrator PowerShell to set it up.'
    } else {
        $exe = $lhmInstalled
        if (-not $exe) { $exe = Find-Lhm }

        if (-not $exe) {
            Write-Warn 'LibreHardwareMonitor not found; install it first (-InstallLhm)'
        } elseif ($PSCmdlet.ShouldProcess($TaskName, 'register scheduled task')) {
            # RunLevel Highest is the point: unelevated, LHM silently reports far
            # fewer sensors and CPU package temp is simply absent.
            # WorkingDirectory matters: the winget build is portable and keeps
            # its config and DLLs beside the exe.
            $action    = New-ScheduledTaskAction -Execute $exe `
                            -WorkingDirectory (Split-Path -Parent $exe)
            $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
            $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
                            -LogonType Interactive -RunLevel Highest
            $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                            -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0

            Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
                -Principal $principal -Settings $settings -Force | Out-Null
            Write-Ok "Scheduled task '$TaskName' registered (elevated, at logon)"
        }
    }
}

Write-Host "`nDone.`n" -ForegroundColor Cyan
