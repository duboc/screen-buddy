<#
  Streams the Windows "now playing" media session as one JSON line per poll.

  Uses GlobalSystemMediaTransportControlsSessionManager - the same OS-level
  session that drives the volume-flyout media controls. That means it works for
  Spotify, any browser tab, VLC, Groove, whatever is playing, with no API key,
  no OAuth and no per-app integration.

  Must run under Windows PowerShell 5.1 (powershell.exe). PowerShell 7 dropped
  the built-in WinRT type projection this relies on.

  Spawned once and left running by src/main/sensors/nowplaying.js, which reads
  stdout line by line - the same trick used for nvidia-smi, so no process spawn
  cost per poll.
#>

param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'Stop'
# Track titles are full of accents, dashes and CJK; without this they arrive mangled.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# No album art. The thumbnail is reachable as a RandomAccessStreamReference,
# but Windows PowerShell 5.1 cannot marshal the stream OpenReadAsync returns -
# it arrives as an unprojected System.__ComObject that will not bind to
# IInputStream, so DataReader cannot consume it. Getting art would mean a
# compiled WinRT helper; the HUD shows a machine-themed placeholder instead.

while ($true) {
    try {
        $s = $mgr.GetCurrentSession()
        if (-not $s) {
            [PSCustomObject]@{ ok = $true; active = $false } | ConvertTo-Json -Compress
        } else {
            $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $info = $s.GetPlaybackInfo()
            $tl = $s.GetTimelineProperties()

            $key = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"

            $out = [ordered]@{
                ok       = $true
                active   = $true
                playing  = ($info.PlaybackStatus -eq 'Playing')
                status   = "$($info.PlaybackStatus)"
                title    = $p.Title
                artist   = $p.Artist
                album    = $p.AlbumTitle
                app      = $s.SourceAppUserModelId
                posSec   = [math]::Round($tl.Position.TotalSeconds, 1)
                endSec   = [math]::Round($tl.EndTime.TotalSeconds, 1)
                trackKey = $key
            }

            [PSCustomObject]$out | ConvertTo-Json -Compress
        }
    } catch {
        # One bad poll (a player closing mid-query) must not kill the loop.
        [PSCustomObject]@{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }

    Start-Sleep -Milliseconds $IntervalMs
}
