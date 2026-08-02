<#
.SYNOPSIS
  Diagnoses a screen-buddy install and prints the fix for anything broken.

.DESCRIPTION
      powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1

  Read-only: it changes nothing, it only reports. Every check here corresponds
  to a failure that has actually happened on a real machine, not a hypothetical.

.PARAMETER Verbose
  Also dump every fan header and network adapter found.
#>

[CmdletBinding()]
param()

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:Problems = @()

function Write-Head { param($m) Write-Host "`n== $m" -ForegroundColor Cyan }
function Pass { param($m) Write-Host "   [pass] $m" -ForegroundColor Green }
function Info { param($m) Write-Host "   [info] $m" -ForegroundColor Gray }
function Fail {
    param($What, $Fix)
    Write-Host "   [FAIL] $What" -ForegroundColor Red
    Write-Host "          fix: $Fix" -ForegroundColor Yellow
    $script:Problems += $What
}
function Warn {
    param($What, $Fix)
    Write-Host "   [warn] $What" -ForegroundColor Yellow
    if ($Fix) { Write-Host "          fix: $Fix" -ForegroundColor DarkYellow }
}

function Get-Tool {
    param($Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Find-Lhm {
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
Write-Host '  screen-buddy doctor' -ForegroundColor White

# -- environment ----------------------------------------------------------

Write-Head 'Environment'

if ([Environment]::OSVersion.Version.Major -ge 10) {
    Pass "Windows $([Environment]::OSVersion.Version)"
} else {
    Fail 'Windows 10 or later is required' 'Upgrade Windows.'
}

# PowerShell 5.1 specifically: the media helper uses WinRT type projection,
# which PowerShell 7 dropped.
if (Test-Path "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe") {
    Pass 'Windows PowerShell 5.1 present (needed by the media and network helpers)'
} else {
    Fail 'powershell.exe (5.1) not found' 'The now-playing and network helpers cannot run without it.'
}

$effective = Get-ExecutionPolicy
if ($effective -in @('Restricted', 'AllSigned')) {
    Info "Execution policy is $effective, so .ps1 files will not run when double-clicked"
    Info 'That is fine - every script here is meant to be invoked as:'
    Info '  powershell -ExecutionPolicy Bypass -File .\scripts\<name>.ps1'
} else {
    Pass "Execution policy: $effective"
}

$node = Get-Tool 'node'
if ($node) {
    $v = (& $node --version).TrimStart('v')
    if ([int]($v -split '\.')[0] -ge 20) { Pass "Node $v" }
    else { Fail "Node $v is older than 20" 'Install Node 20+ from https://nodejs.org' }
} else {
    Fail 'Node.js not found' 'Run: winget install OpenJS.NodeJS.LTS'
}

if (Test-Path (Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe')) {
    Pass 'Electron installed'
} else {
    Fail 'Dependencies not installed' 'Run: npm install'
}

# -- locale ---------------------------------------------------------------

Write-Head 'Locale'

$sep = (Get-Culture).NumberFormat.NumberDecimalSeparator
if ($sep -eq ',') {
    Info "Your locale ($((Get-Culture).Name)) uses ',' as the decimal separator"
    Info 'LibreHardwareMonitor formats readings that way too, and the app'
    Info 'detects it automatically. If temperatures read ~10x too high'
    Info '(e.g. 639 C instead of 63,9 C), that detection has failed - please'
    Info 'open an issue with your locale name.'
} else {
    Pass "Decimal separator is '$sep' ($((Get-Culture).Name))"
}

# -- displays -------------------------------------------------------------

Write-Head 'Displays'

Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Count -lt 2) {
    Fail 'Only one display detected' 'Connect the second screen; the HUD would otherwise take over your main monitor.'
} else {
    Pass "$($screens.Count) displays attached"
}
Info 'Authoritative bounds come from Electron, not from here. Run: npm run displays'

$configPath = Join-Path $ProjectRoot 'config.json'
if (Test-Path $configPath) {
    Pass 'config.json present'
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        Info "  display.strategy = $($cfg.display.strategy)"
        if ($cfg.display.strategy -eq 'bounds') {
            Info "  display.bounds   = $($cfg.display.bounds.x),$($cfg.display.bounds.y)"
        }
        Info "  theme            = $($cfg.theme)"
    } catch {
        Fail 'config.json is not valid JSON' 'Delete it and run: npm run init-config'
    }
} else {
    Info 'No config.json - defaults apply (HUD goes to the smallest display)'
    Info 'Generate one with: npm run init-config'
}

# -- GPU ------------------------------------------------------------------

Write-Head 'GPU'

if (Get-Tool 'nvidia-smi') {
    try {
        $gpu = & nvidia-smi --query-gpu=name,temperature.gpu --format=csv,noheader 2>$null
        Pass "nvidia-smi works: $gpu"
    } catch {
        Fail 'nvidia-smi found but failed to run' 'Reinstall or update your NVIDIA driver.'
    }
} else {
    $vendor = (Get-CimInstance Win32_VideoController |
               Where-Object { $_.Name -notmatch 'Idd|Remote|Basic|Meta' } |
               Select-Object -First 1).Name
    Warn "nvidia-smi not found (GPU detected: $vendor)" `
         'The GPU panel needs an NVIDIA card. On AMD/Intel, LibreHardwareMonitor still supplies GPU temp and load; other GPU fields read "--".'
}

# -- LibreHardwareMonitor -------------------------------------------------

Write-Head 'LibreHardwareMonitor (CPU temperature, power, fan)'

$lhm = Find-Lhm
if ($lhm) {
    Pass "Installed: $lhm"
    if ($lhm -like '*WinGet\Packages*') {
        Info 'This is a portable winget install - not in Program Files, which is normal.'
    }
} else {
    Fail 'Not installed' 'Run: winget install LibreHardwareMonitor.LibreHardwareMonitor  (approve the UAC prompt)'
}

$running = Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue
if ($running) { Pass 'Running' }
else { Fail 'Not running' 'Start it, or register it at logon with: scripts\setup-windows.ps1 -LhmAutoStart (elevated)' }

$data = $null
try {
    $resp = Invoke-WebRequest 'http://127.0.0.1:8085/data.json' -TimeoutSec 3 -UseBasicParsing
    $data = $resp.Content
    Pass "Web server responding on 127.0.0.1:8085 ($([math]::Round($data.Length / 1024)) KB)"
} catch {
    Fail 'Web server not responding on 127.0.0.1:8085' `
         'In LHM: Options > Remote Web Server > Run. Confirm the port is 8085.'
}

if ($data) {
    if ($data -match '"Text":"Core \(Tctl/Tdie\)"' -or $data -match '"Type":"Temperature"[^}]*"Text":"CPU Package"') {
        Pass 'CPU package temperature is being reported'
    } else {
        Warn 'No CPU package temperature in the feed' `
             'LHM must run as Administrator; unelevated it reports far fewer sensors.'
    }

    # List fan headers, because auto-picking one is a guess on most boards.
    $fans = [regex]::Matches($data, '"Text":"([^"]*)","Min":"[^"]*","Value":"([^"]*RPM)"')
    if ($fans.Count) {
        Info 'Fan headers found:'
        foreach ($f in $fans) {
            Info ("    {0,-16} {1}" -f $f.Groups[1].Value, $f.Groups[2].Value)
        }
        Info 'Boards often label these generically, so the auto-pick may be a case fan.'
        Info 'Pin the right one via sensors.libreHardwareMonitor.fanSensor in config.json.'
    }
}

# -- network --------------------------------------------------------------

Write-Head 'Network'

try {
    $adapters = Get-NetAdapter -ErrorAction Stop
    Pass "Get-NetAdapterStatistics available ($($adapters.Count) adapters)"
    $up = $adapters | Where-Object { $_.Status -eq 'Up' }
    if ($up) {
        foreach ($a in $up) { Info "  up: $($a.Name)  [$($a.InterfaceDescription)]" }
        if ($up | Where-Object { $_.Name -match '\s' }) {
            Info 'One of these has a space in its name. That breaks systeminformation,'
            Info 'which is exactly why the app reads adapters through Windows instead.'
        }
    } else {
        Warn 'No adapter reporting Up' 'Flow will show 0 B/s until something connects.'
    }
} catch {
    Fail 'Get-NetAdapter unavailable' 'Network throughput cannot be read on this system.'
}

# -- media ----------------------------------------------------------------

Write-Head 'Now playing'

$mediaTest = @'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $t = $m.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]).Invoke($null, @([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()))
  $t.Wait(-1) | Out-Null
  if ($t.Result.GetCurrentSession()) { 'SESSION' } else { 'NOSESSION' }
} catch { 'ERROR: ' + $_.Exception.Message }
'@

$result = & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -NoProfile -NonInteractive -Command $mediaTest 2>&1 | Select-Object -Last 1

switch -Wildcard ("$result") {
    'SESSION'   { Pass 'Windows media session reachable, and something is loaded' }
    'NOSESSION' { Pass 'Windows media session reachable (nothing playing right now)' }
    default     { Fail "Media session unavailable: $result" 'Set sensors.nowPlaying.enabled = false in config.json to hide the panel.' }
}

Info 'Album art is not shown - PowerShell 5.1 cannot marshal the WinRT thumbnail stream.'

# -- integration ----------------------------------------------------------

Write-Head 'Integration'

$runEntry = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'screen-buddy' -ErrorAction SilentlyContinue).'screen-buddy'
if ($runEntry) { Pass 'Autostart registered' }
else { Info 'Autostart not configured (scripts\install.ps1 sets it up)' }

$mm = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' `
    -Name MMTaskbarEnabled -ErrorAction SilentlyContinue).MMTaskbarEnabled
if ($mm -eq 0) { Pass 'Taskbar limited to the primary display' }
else { Info 'Taskbar still shows on all displays (scripts\install.ps1 can change this)' }

$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Restart screen-buddy.lnk'
if (Test-Path $lnk) { Pass 'Desktop restart shortcut present' }
else { Info 'No desktop shortcut (scripts\make-shortcut.ps1 creates one)' }

$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProjectRoot*" })
if ($procs.Count) { Pass "HUD is running ($($procs.Count) processes)" }
else { Info 'HUD is not running. Start it with: npm start' }

# -- restore points -------------------------------------------------------
# Reported here because doctor is what you run when something is wrong, and
# "put it back how it was" is often the shortest fix.

$backupDir = Join-Path $ProjectRoot 'config.backups'
$points = @()
if (Test-Path $backupDir) {
    $points = @(Get-ChildItem -Path $backupDir -Filter '*.json' -ErrorAction SilentlyContinue)
}
if ($points.Count) {
    $newest = ($points | Sort-Object LastWriteTime -Descending)[0]
    Pass "$($points.Count) config restore point(s), newest $($newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
} else {
    Info 'No config restore points yet (one is taken automatically before each save)'
}

# The tracked template is the floor: even with no restore points and no
# config.json, this is what a reset returns to.
if (Test-Path (Join-Path $ProjectRoot 'config.example.json')) {
    Pass 'Shipped template present, so a full reset is always available'
} else {
    Fail 'config.example.json is missing' 'Restore it from git: git checkout config.example.json. Reset still works from built-in defaults.'
}

# -- summary --------------------------------------------------------------

Write-Host ''
if ($script:Problems.Count) {
    Write-Host "  $($script:Problems.Count) problem(s) found:" -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host "    - $p" -ForegroundColor Red }
} else {
    Write-Host '  No problems found.' -ForegroundColor Green
}
Write-Host ''
Write-Host '  Undo a config change:  npm run config:list  then  npm run config:restore' -ForegroundColor Gray
Write-Host ''
