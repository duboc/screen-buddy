<#
  Streams the busiest processes as one JSON line per poll.

  Why this exists rather than using systeminformation's processes(): that call
  costs about 900ms of CPU every time it is made - measured on this machine, and
  it does not cache - which is an absurd price for a panel whose entire job is
  to show you what is using your CPU. Get-Process is a single API call and costs
  a few milliseconds.

  Processes are grouped by name and summed, because "chrome 34%" is the useful
  answer and "43 chrome processes at 0.8% each" is not. Instance counts ride
  along so the panel can still say how many there are.

  Unlike the network helper, this one derives the rate itself instead of
  emitting raw counters for Node to difference. Windows accounts CPU as
  cumulative processor-seconds, so ranking by "busiest right now" is only
  possible once two samples have been compared - and the alternative to doing
  that here is shipping all ~300 processes down stdout every poll so that Node
  can rank them and discard 95%. The loop is long-lived and already holds state,
  so it keeps the previous sample and sends the short list.

  Spawned once and left running by src/main/sensors/processes.js, which reads
  stdout line by line - same approach as nvidia-smi, the media helper and the
  network helper, so there is no process-spawn cost per tick.
#>

param([int]$IntervalMs = 3000, [int]$Top = 6)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cores = [Environment]::ProcessorCount
$prev = $null
$prevAt = 0

while ($true) {
    try {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

        # 'Idle' is the kernel's accounting bucket for unused time. It reports
        # whatever fraction of the machine is NOT busy, so leaving it in puts a
        # permanent 95%-CPU entry at the top of a panel meant to show load.
        $procs = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -ne 'Idle' }

        $curr = @{}
        $mem = @{}
        $count = @{}
        foreach ($p in $procs) {
            $n = $p.ProcessName
            # TotalProcessorTime and WorkingSet64 throw on processes this session
            # cannot open (other users, protected system services). Those are
            # skipped rather than failing the whole sample.
            try { $curr[$n] = [double]$curr[$n] + [double]$p.CPU } catch {}
            try { $mem[$n] = [int64]$mem[$n] + [int64]$p.WorkingSet64 } catch {}
            $count[$n] = [int]$count[$n] + 1
        }

        $rows = @()
        $elapsed = ($now - $prevAt) / 1000.0
        foreach ($n in $curr.Keys) {
            $pct = $null
            if ($prev -and $prev.ContainsKey($n) -and $elapsed -gt 0) {
                # Divided by core count, so a process saturating one thread of
                # 32 reads as 3% of the machine rather than 100% of a core.
                # That matches the load figure on the gauges beside it.
                $d = [double]$curr[$n] - [double]$prev[$n]
                if ($d -ge 0) { $pct = [math]::Round(($d / $elapsed / $cores) * 100, 2) }
            }
            $rows += [PSCustomObject]@{
                name      = $n
                cpuPct    = $pct
                memBytes  = [int64]$mem[$n]
                instances = [int]$count[$n]
            }
        }

        # Two separate rankings, because the process eating the CPU and the one
        # eating the RAM are usually not the same process, and a single combined
        # list would hide whichever one you were looking for.
        $byCpu = @($rows | Where-Object { $null -ne $_.cpuPct } |
            Sort-Object -Property cpuPct -Descending | Select-Object -First $Top)
        $byMem = @($rows | Sort-Object -Property memBytes -Descending |
            Select-Object -First $Top)

        [PSCustomObject]@{
            ok     = $true
            at     = $now
            total  = $procs.Count
            # False on the very first sample, where there is no previous reading
            # to difference against and every cpuPct is therefore unknown.
            warm   = [bool]($prev -ne $null)
            byCpu  = $byCpu
            byMem  = $byMem
        } | ConvertTo-Json -Compress -Depth 4

        $prev = $curr
        $prevAt = $now
    } catch {
        [PSCustomObject]@{ ok = $false; error = "$($_.Exception.Message)" } |
            ConvertTo-Json -Compress
    }

    Start-Sleep -Milliseconds $IntervalMs
}
