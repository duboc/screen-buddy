<#
.SYNOPSIS
  Creates a "Restart screen-buddy" shortcut on the Desktop.

.DESCRIPTION
  The shortcut points at wscript.exe running restart-hidden.vbs, not at
  powershell.exe directly, so double-clicking it does not flash a console
  window - which would rather defeat the point of a HUD you are looking at.

  Uses [Environment]::GetFolderPath('Desktop') rather than "$env:USERPROFILE\
  Desktop" so it still lands in the right place when the Desktop is redirected
  to OneDrive.

.PARAMETER Name
  Shortcut filename, without the .lnk extension.

.PARAMETER Remove
  Delete the shortcut instead of creating it.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Name = 'Restart screen-buddy',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath('Desktop')
$LinkPath = Join-Path $Desktop "$Name.lnk"

if ($Remove) {
    if (Test-Path $LinkPath) {
        if ($PSCmdlet.ShouldProcess($LinkPath, 'delete')) {
            Remove-Item $LinkPath -Force
            Write-Host "Removed $LinkPath" -ForegroundColor Green
        }
    } else {
        Write-Host "Nothing to remove at $LinkPath" -ForegroundColor Gray
    }
    return
}

$target = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbs = Join-Path $ProjectRoot 'scripts\restart-hidden.vbs'
$icon = Join-Path $ProjectRoot 'assets\screen-buddy.ico'

foreach ($required in @($vbs, $icon)) {
    if (-not (Test-Path $required)) { throw "Missing required file: $required" }
}

if ($PSCmdlet.ShouldProcess($LinkPath, 'create shortcut')) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($LinkPath)
    $lnk.TargetPath = $target
    $lnk.Arguments = "`"$vbs`""
    $lnk.WorkingDirectory = $ProjectRoot
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = 'Stop and restart the screen-buddy HUD'
    $lnk.WindowStyle = 7   # minimized; wscript hides it entirely anyway
    $lnk.Save()

    Write-Host "Created $LinkPath" -ForegroundColor Green
    Write-Host '  Double-click it any time the HUD needs restarting.' -ForegroundColor Gray
}
