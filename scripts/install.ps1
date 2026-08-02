<#
.SYNOPSIS
  One-command setup for screen-buddy.

.DESCRIPTION
  Takes a fresh clone to a running HUD. Every step is idempotent - re-running is
  safe and only fixes what is missing - and every step reports what it did.

  Run it like this, because Windows blocks .ps1 files by default:

      powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

  Steps:
    1. Check prerequisites (Node, npm) and offer to install what is missing.
    2. npm install.
    3. Detect your displays and write config.json.
    4. Install LibreHardwareMonitor and enable its web server (optional but
       recommended - it is the only source of CPU temperature on Windows).
    5. Hide the taskbar on secondary displays.
    6. Register autostart at login.
    7. Create a Restart shortcut on the Desktop.
    8. Verify every sensor source and report what is live.

.PARAMETER Minimal
  Only steps 1-3 and 8: dependencies, config and verification. Changes nothing
  else about the system - no installs, no registry, no shortcut.

.PARAMETER SkipLhm
  Skip LibreHardwareMonitor. CPU temperature, power and fan will read "--".

.PARAMETER SkipTaskbar
  Leave the taskbar showing on all displays. Skips the Explorer restart.

.PARAMETER SkipAutoStart
  Do not launch the HUD at login.

.PARAMETER NoLaunch
  Set everything up but do not start the HUD at the end.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Minimal
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Minimal,
    [switch]$SkipLhm,
    [switch]$SkipTaskbar,
    [switch]$SkipAutoStart,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if ($Minimal) { $SkipLhm = $true; $SkipTaskbar = $true; $SkipAutoStart = $true }

$script:Warnings = @()

function Write-Step { param($m) Write-Host "`n== $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "   [ok]   $m" -ForegroundColor Green }
function Write-Info { param($m) Write-Host "   [info] $m" -ForegroundColor Gray }
function Write-Warn {
    param($m)
    Write-Host "   [warn] $m" -ForegroundColor Yellow
    $script:Warnings += $m
}

function Get-Tool {
    param($Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    # A tool installed earlier in this same session is on the machine but not
    # yet in this process's PATH.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Find-Lhm {
    # winget ships LibreHardwareMonitor as a PORTABLE package, so it lands in
    # the WinGet package store rather than Program Files. Probing only the
    # conventional directories reports "not installed" for a good install.
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

Write-Host ''
Write-Host '  screen-buddy setup' -ForegroundColor White
Write-Host "  $ProjectRoot" -ForegroundColor DarkGray

# -- 1. prerequisites -----------------------------------------------------

Write-Step '1/8  Prerequisites'

if ([Environment]::OSVersion.Version.Major -lt 10) {
    throw 'screen-buddy targets Windows 10 or later.'
}
Write-Ok "Windows $([Environment]::OSVersion.Version)"

$node = Get-Tool 'node'
if (-not $node) {
    Write-Info 'Node.js not found; installing the LTS build with winget'
    if (-not (Get-Tool 'winget')) {
        throw 'Neither Node.js nor winget is available. Install Node 20+ from https://nodejs.org and re-run.'
    }
    if ($PSCmdlet.ShouldProcess('Node.js LTS', 'winget install')) {
        winget install --id OpenJS.NodeJS.LTS --exact --silent `
            --accept-package-agreements --accept-source-agreements
        $node = Get-Tool 'node'
    }
    if (-not $node) { throw 'Node.js install did not complete. Install it manually and re-run.' }
}

$nodeVersion = (& $node --version).TrimStart('v')
if ([int]($nodeVersion -split '\.')[0] -lt 20) {
    Write-Warn "Node $nodeVersion is older than the required 20; upgrade if the app misbehaves"
} else {
    Write-Ok "Node $nodeVersion"
}

$npm = Get-Tool 'npm.cmd'
if (-not $npm) { $npm = Get-Tool 'npm' }
if (-not $npm) { throw 'npm not found even though Node is installed.' }
Write-Ok "npm $(& $npm --version)"

# -- 2. dependencies ------------------------------------------------------

Write-Step '2/8  Installing dependencies'

if (Test-Path (Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe')) {
    Write-Ok 'Already installed (delete node_modules to force a clean install)'
} elseif ($PSCmdlet.ShouldProcess('npm install', 'run')) {
    Write-Info 'This downloads Electron and takes a few minutes'
    Push-Location $ProjectRoot
    try {
        & $npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
    Write-Ok 'Dependencies installed'
}

# -- 3. config ------------------------------------------------------------

Write-Step '3/8  Detecting displays and writing config.json'

$configPath = Join-Path $ProjectRoot 'config.json'
if (Test-Path $configPath) {
    Write-Ok 'config.json already exists; leaving it alone'
    Write-Info 'Re-run `npm run init-config -- --force` to regenerate it'
} elseif ($PSCmdlet.ShouldProcess('config.json', 'generate')) {
    Push-Location $ProjectRoot
    try { & $npm run --silent init-config } finally { Pop-Location }
    if (Test-Path $configPath) { Write-Ok 'config.json written' }
    else { Write-Warn 'config.json was not created; the app will fall back to the smallest display' }
}

# -- 4. LibreHardwareMonitor ----------------------------------------------

Write-Step '4/8  LibreHardwareMonitor (CPU temperature, power, fan)'

if ($SkipLhm) {
    Write-Info 'Skipped. CPU temperature, power and fan will read "--"'
} else {
    $lhm = Find-Lhm
    if ($lhm) {
        Write-Ok "Already installed: $lhm"
    } elseif ($PSCmdlet.ShouldProcess('LibreHardwareMonitor', 'winget install')) {
        if (-not (Get-Tool 'winget')) {
            Write-Warn 'winget not available; install LibreHardwareMonitor manually'
        } else {
            Write-Info 'Approve the UAC prompt - its PawnIO driver dependency needs elevation'
            winget install --id LibreHardwareMonitor.LibreHardwareMonitor --exact `
                --accept-package-agreements --accept-source-agreements
            $lhm = Find-Lhm
            if ($lhm) { Write-Ok "Installed: $lhm" }
            else { Write-Warn 'Install did not complete (was the UAC prompt approved?)' }
        }
    }

    if ($lhm) {
        # Pre-seed settings so the web server is on at first launch, instead of
        # requiring a trip through Options > Remote Web Server > Run. LHM writes
        # this file itself on exit, so only seed it when it has never run.
        $cfg = Join-Path (Split-Path -Parent $lhm) 'LibreHardwareMonitor.config'
        if (Test-Path $cfg) {
            Write-Info 'LHM already has settings; leaving them alone'
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
            Write-Ok 'Web server enabled on port 8085, starts minimised'
        }

        $responding = $false
        try {
            $null = Invoke-WebRequest 'http://127.0.0.1:8085/data.json' -TimeoutSec 2 -UseBasicParsing
            $responding = $true
        } catch { }

        if ($responding) {
            Write-Ok 'LHM web server responding on 127.0.0.1:8085'
        } elseif ($PSCmdlet.ShouldProcess('LibreHardwareMonitor', 'start')) {
            Write-Info 'Starting LibreHardwareMonitor'
            Start-Process -FilePath $lhm -WorkingDirectory (Split-Path -Parent $lhm)
            Start-Sleep -Seconds 8
            try {
                $null = Invoke-WebRequest 'http://127.0.0.1:8085/data.json' -TimeoutSec 3 -UseBasicParsing
                Write-Ok 'LHM web server responding on 127.0.0.1:8085'
            } catch {
                Write-Warn 'LHM started but its web server is not responding; enable Options > Remote Web Server > Run'
            }
        }

        Write-Info 'For full sensor access LHM must run as Administrator.'
        Write-Info 'From an elevated shell, register it to start at logon with:'
        Write-Info '  powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 -LhmAutoStart'
    }
}

# -- 5. taskbar -----------------------------------------------------------

Write-Step '5/8  Taskbar on secondary displays'

$mm = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' `
        -Name MMTaskbarEnabled -ErrorAction SilentlyContinue).MMTaskbarEnabled

if ($SkipTaskbar) {
    Write-Info 'Skipped'
} elseif ($mm -eq 0) {
    Write-Ok 'Already limited to the primary display'
} elseif ($PSCmdlet.ShouldProcess('MMTaskbarEnabled', 'set to 0')) {
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' `
        -Name MMTaskbarEnabled -Value 0 -Type DWord
    Write-Ok 'Taskbar limited to the primary display'
    Write-Info 'Restarting Explorer to apply - open Explorer windows will close'
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# -- 6. autostart ---------------------------------------------------------

Write-Step '6/8  Autostart at login'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$existing = (Get-ItemProperty -Path $runKey -Name 'screen-buddy' -ErrorAction SilentlyContinue).'screen-buddy'

if ($SkipAutoStart) {
    Write-Info 'Skipped'
} elseif ($existing) {
    Write-Ok "Already configured: $existing"
} elseif ($PSCmdlet.ShouldProcess('screen-buddy', 'register autostart')) {
    $vbs = Join-Path $ProjectRoot 'scripts\start-hidden.vbs'
    Set-ItemProperty -Path $runKey -Name 'screen-buddy' -Value "wscript.exe `"$vbs`""
    Write-Ok 'Will start at login, with no console window'
}

# -- 7. shortcut ----------------------------------------------------------

Write-Step '7/8  Desktop restart shortcut'

if ($Minimal) {
    Write-Info 'Skipped'
} elseif ($PSCmdlet.ShouldProcess('Restart screen-buddy.lnk', 'create')) {
    & (Join-Path $PSScriptRoot 'make-shortcut.ps1')
}

# -- 8. verify ------------------------------------------------------------

Write-Step '8/8  Verifying sensors'

Push-Location $ProjectRoot
try { & $node (Join-Path $ProjectRoot 'scripts\probe-sensors.js') }
catch { Write-Warn "Sensor probe failed: $($_.Exception.Message)" }
finally { Pop-Location }

# -- done -----------------------------------------------------------------

Write-Host ''
if ($script:Warnings.Count) {
    Write-Host '  Finished with warnings:' -ForegroundColor Yellow
    foreach ($w in $script:Warnings) { Write-Host "    - $w" -ForegroundColor Yellow }
    Write-Host ''
    Write-Host '  Run the diagnostics for suggested fixes:' -ForegroundColor Gray
    Write-Host '    powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1' -ForegroundColor Gray
} else {
    Write-Host '  Setup complete.' -ForegroundColor Green
}

Write-Host ''
Write-Host '  Tune it from the tray icon > Settings...  (or http://127.0.0.1:8787/)' -ForegroundColor Gray
Write-Host '  Theme, fonts, type scale, panels and page rotation, previewed live.' -ForegroundColor Gray

if (-not $NoLaunch -and -not $Minimal) {
    Write-Host ''
    if ($PSCmdlet.ShouldProcess('screen-buddy', 'start')) {
        & (Join-Path $PSScriptRoot 'restart.ps1')
    }
} else {
    Write-Host ''
    Write-Host '  Start it with:  npm start' -ForegroundColor Gray
}
Write-Host ''
