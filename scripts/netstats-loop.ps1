<#
  Streams per-adapter network byte counters as one JSON line per poll.

  Why this exists rather than using systeminformation's networkStats():
  that library cannot read adapters whose name contains a space. On a machine
  with an adapter called "Wi-Fi 6" it reports rx_bytes = 0 and operstate =
  unknown for the real, active adapter, while happily reporting the counters of
  a disconnected adapter called "Wi-Fi". The HUD read a flat 0 B/s as a result.

  Get-NetAdapterStatistics is the OS's own accounting and has no such problem.
  It reports cumulative byte totals; the Node side turns those into rates.

  Spawned once and left running by src/main/sensors/netstats.js, which reads
  stdout line by line - same approach as nvidia-smi and the media helper, so
  there is no process-spawn cost per tick.
#>

param([int]$IntervalMs = 1000)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    try {
        # Status lives on Get-NetAdapter, byte counters on Get-NetAdapterStatistics.
        # Keyed by name so the two can be joined.
        $status = @{}
        foreach ($a in Get-NetAdapter -ErrorAction SilentlyContinue) {
            $status[$a.Name] = @{
                status = "$($a.Status)"
                speed  = [int64]$a.ReceiveLinkSpeed
                desc   = "$($a.InterfaceDescription)"
            }
        }

        $adapters = @()
        foreach ($s in Get-NetAdapterStatistics -ErrorAction SilentlyContinue) {
            $meta = $status[$s.Name]
            $adapters += [ordered]@{
                name  = $s.Name
                rx    = [int64]$s.ReceivedBytes
                tx    = [int64]$s.SentBytes
                up    = if ($meta) { $meta.status -eq 'Up' } else { $false }
                state = if ($meta) { $meta.status } else { 'Unknown' }
                desc  = if ($meta) { $meta.desc } else { '' }
            }
        }

        [PSCustomObject]@{
            ok       = $true
            at       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            adapters = $adapters
        } | ConvertTo-Json -Compress -Depth 4
    } catch {
        [PSCustomObject]@{ ok = $false; error = "$($_.Exception.Message)" } |
            ConvertTo-Json -Compress
    }

    Start-Sleep -Milliseconds $IntervalMs
}
