# screen-buddy

A system-stats HUD for a spare monitor, styled to look like part of an espresso
machine. It takes over one display, sits above everything, ignores your mouse
entirely, and shows what the machine is doing.

Built for a small secondary panel — the 1024×600 boards sold as "sensor panels"
are the reference size — but it fills whatever display you point it at.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ☕ COFFEE-MACHINE   Windows 11         ● READY   ON SINCE 1h 7m   19:34 04 │
├─────────────────────────┬─────────────────────────┬────────────────────────┤
│ BOILER   Ryzen 9 9950X3D│ GROUP HEAD    RTX 5080  │ RESERVOIR              │
│    ╭────────╮           │    ╭────────╮           │  ┌────┐  ┌────┐        │
│   │ ·36·52· │  ┌──┐     │   │ ·35·65· │   ┌──┐    │  │    │  │    │        │
│   │ ╲  ·84· │  │62│°C   │   │  ╲ ·80· │   │54│°C  │  │▓▓▓▓│  │▓▓▓▓│        │
│    ╰────────╯  └──┘     │    ╰────────╯   └──┘    │  └────┘  └────┘        │
│              LOAD 10%   │              LOAD  2%   │   28%      18%         │
│ CLOCK      POWER   FAN  │ CLOCK     POWER    FAN  │   RAM      VRAM        │
│ 5.59 GHz   88 W  1270r  │ 457 MHz   28 W     0%   │ 17.2/61.7  2.8/15.9 GB │
├─────────────────────────┴─────────────────────────┼────────────────────────┤
│ NOW BREWING   Spotify                      PAUSED │ FLOW   Wi-Fi 6         │
│  ┌────┐  Levitating                               │  ↓ 16.9 MB/s ↑ 214KB/s │
│  │ ◎  │  Dua Lipa                                 │  ────────────────────  │
│  └────┘  Future Nostalgia                         │  PEAK 48 MB/s          │
│  0:10 ▬▬▬───────────────────────────────── 3:23   │              LAST 11s  │
├───────────────────────────────────────────────────┴────────────────────────┤
│ GRINDER    ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▃▅▄▁▁▂▃▁▁▄▁▁▁▁  (32 threads)                    │
├────────────────────────────────────────────────────────────────────────────┤
│ ● SYSTEM ● NVIDIA-SMI ● LHM ● MEDIA ● NET             C: 20%   D: 43%      │
└────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```powershell
git clone https://github.com/duboc/screen-buddy.git
cd screen-buddy
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

That's it. The installer checks your prerequisites, installs Node if it's
missing, pulls dependencies, detects your displays and writes a `config.json`,
sets up LibreHardwareMonitor, hides the taskbar on secondary displays, registers
autostart, drops a restart shortcut on your Desktop, and verifies every sensor.
It's idempotent — re-run it any time.

> **Why `-ExecutionPolicy Bypass`?** Windows refuses to run `.ps1` files out of
> the box. This doesn't change any system setting; it applies to that one
> invocation only.

Want to change nothing about your system? `-Minimal` does dependencies, config
and verification and nothing else:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Minimal
```

If anything looks wrong afterwards:

```powershell
npm run doctor
```

It checks every failure mode listed below and prints the fix for each. It only
reads — it never changes anything.

## What it shows

| Panel | Metrics |
|---|---|
| **Boiler** / **Group head** | CPU and GPU temperature on a cream manometer dial, plus load, clock, power, fan |
| **Reservoir** | System memory and VRAM as water tanks with sight-glass graduations |
| **Now brewing** | Whatever is playing — track, artist, album, elapsed/total, play state |
| **Flow** | Network receive above the axis, transmit below, on one shared scale |
| **Grinder** | Per-thread CPU load, one cell each — 32 cells on a 16-core part |
| **Ready lamp** | READY / HEATING / OVER TEMP, from the worse of the two temperatures |

## Requirements

| | |
|---|---|
| **OS** | Windows 10 or 11. Windows PowerShell 5.1 must be present (it is, by default) |
| **Node** | 20 or newer. The installer will fetch it via winget if missing |
| **Displays** | Two or more. With one display the HUD would take over your only screen |
| **GPU** | NVIDIA for the full GPU panel. AMD/Intel works but some fields read `--` |
| **Optional** | [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) for CPU temperature, power and fan |

Nothing here needs a paid app, an API key, or a login.

## Sensor sources

Five independent sources. Each degrades on its own, and the footer shows which
are live — so a blank field reads as a setup gap, not a broken panel.

| Source | Provides | Needs |
|---|---|---|
| `systeminformation` | CPU load & per-thread load, memory, disks, uptime | nothing |
| `nvidia-smi` | GPU temp, load, clocks, power, VRAM, fan | NVIDIA driver |
| `Get-NetAdapterStatistics` | Network throughput per adapter | nothing |
| Windows media session | Now-playing track, artist, album, position, state | nothing |
| LibreHardwareMonitor | **CPU temp, CPU power, fan RPM, mobo temp** | LHM running elevated |

Check what's actually being read at any time:

```powershell
npm run probe
```

### Why LibreHardwareMonitor is needed for CPU temperature

**Windows has no public API for AMD or Intel desktop CPU package temperature.**
`MSAcpi_ThermalZoneTemperature` is either absent or reports a chipset sensor
reading well below the real die temperature. LHM talks to the CPU's own
management unit, so it is the only source that gets this right.

Without it, four fields show `--` and everything else works normally.

The installer handles it, including pre-seeding LHM's config so its web server
is already enabled on port 8085 — no trip through Options menus. For **full**
sensor access LHM must run **as Administrator**; register that from an elevated
shell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 -LhmAutoStart
```

### Now playing

Reads the Windows **global media session** — the same one behind the volume
flyout's media controls. It shows whatever is actually playing: Spotify, a
browser tab, VLC. No API key, no OAuth, no per-app integration, no setup.

**No album art.** The thumbnail is reachable as a `RandomAccessStreamReference`,
but PowerShell 5.1 cannot marshal the stream `OpenReadAsync` returns — it arrives
as an unprojected `System.__ComObject` that won't bind to `IInputStream`. It
would need a compiled WinRT helper; the panel shows a record-disc placeholder.

## Keeping it out of the way

The installer does the first two; `scripts/setup-windows.ps1` exposes them
individually. Run it with no switches for a report that changes nothing.

| Switch | What it does |
|---|---|
| `-HideTaskbar` | Stops Windows drawing the taskbar on secondary displays |
| `-AutoStart` | Launches screen-buddy at login, no console flash |
| `-InstallLhm` | winget-installs LibreHardwareMonitor and enables its web server |
| `-LhmAutoStart` | Scheduled task to start LHM elevated at logon (needs an admin shell) |
| `-All` | All of the above |
| `-Undo` | Reverts every change it made |

Supports `-WhatIf` throughout.

Three things it deliberately does **not** do:

- **Stop the cursor drifting onto the panel.** Windows has no setting for this.
  [Dual Monitor Tools](https://dualmonitortool.sourceforge.net/) has a *Cursor*
  module that adds a sticky edge you must push through on purpose.
- **Stop windows opening there.** The HUD is click-through and unfocusable so it
  never steals anything, but Windows may still place a new window on that
  monitor. FancyZones is the fix if it bothers you.
- **Change your display arrangement.** Do that in Settings.

The app handles display sleep itself: it holds off the sleep timer while running
and re-places itself 1.5s after any monitor hot-plug or resolution change, which
is when Windows would otherwise reshuffle it onto another screen.

### Restarting it

The desktop shortcut the installer creates is the easy way. Otherwise:

```powershell
npm run restart                    # stop and start
.\scripts\restart.ps1 -StopOnly    # just stop
```

`restart.ps1` deliberately does **not** kill `electron.exe` by name — VS Code,
Discord and Slack are Electron too. It matches on the command line containing
this project's path, and also clears the two PowerShell helpers, which a
force-kill would otherwise orphan.

## Troubleshooting

Every entry here is a failure that actually happened on a real machine.
`npm run doctor` checks all of them automatically.

| Symptom | Cause | Fix |
|---|---|---|
| `running scripts is disabled on this system` | Windows blocks `.ps1` by default | Prefix with `powershell -ExecutionPolicy Bypass -File`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| CPU temp / power / fan show `--` | LibreHardwareMonitor not running | `npm run doctor` — it reports which step is missing |
| Temperatures ~10× too high (639 °C) | Locale decimal separator | Fixed in the parser; if it recurs, open an issue with your locale |
| `winget` says LHM isn't installed, but it is | winget installs it **portable**, under `%LOCALAPPDATA%\Microsoft\WinGet\Packages`, not Program Files | Already handled — the scripts search there |
| LHM install fails, "cancelled by user" | Its PawnIO dependency needs elevation | Re-run and approve the UAC prompt |
| Network flow stuck at 0 B/s | An adapter name containing a space breaks `systeminformation` | Already fixed — throughput comes from `Get-NetAdapterStatistics` |
| Wrong fan RPM | Boards label headers `Fan #1`…`#7` with no CPU marker, so auto-pick guesses | `npm run probe` lists them; set `sensors.libreHardwareMonitor.fanSensor` |
| HUD on the wrong monitor | Display order isn't stable across reboots | `npm run init-config -- --force`, or `--index N` |
| GPU panel empty | No NVIDIA GPU | Expected; LHM still supplies GPU temp and load |
| Console window flashes at login | Autostart pointing at `npm` directly | The installer uses a `wscript` wrapper; re-run it |

## Configuration

Everything lives in `config.json` (gitignored — your copy stays yours).
`config.example.json` is the annotated template listing every key with defaults
and an explanation.

```powershell
npm run init-config              # generate from your actual displays
npm run init-config -- --force   # overwrite an existing config.json
npm run init-config -- --index 2 # pick a specific display
npm run displays                 # just list them
```

The settings worth knowing:

| Key | Why you'd change it |
|---|---|
| `display.strategy` | `smallest` (default, needs no config), `bounds` (pin a monitor by position), `index`, `primary`, `largest` |
| `theme` | `espresso` (default) or `neon` for the original cyberpunk look |
| `window.clickThrough` | `false` to let the HUD accept clicks |
| `window.alwaysOnTop` | `false` to let other windows cover it |
| `polling.fastMs` | Refresh rate. 1000 default; 500 is smoother and costs more CPU |
| `ui.panels.*` | Hide whole sections; the rest expands to fill |
| `thresholds.*` | Where the dial's danger zone starts and the lamp changes state |
| `sensors.libreHardwareMonitor.fanSensor` | Pin which fan header to display |
| `sensors.network.interface` | Pin a network adapter by exact name |
| `sensors.nowPlaying.enabled` | `false` to skip the media helper entirely |

`display.strategy: "bounds"` matches on monitor *position* rather than index
because Electron's display ordering isn't stable across reboots and hot-plugs —
an index that points at the little panel today can point at your main monitor
tomorrow.

## Development

```powershell
npm run windowed   # normal 1024x600 window, focusable, movable
npm run dev        # HUD mode + detached devtools
npm run probe      # one sensor snapshot, no UI
npm run doctor     # full diagnostic
npm run displays   # what Electron thinks your monitors are
```

`src/renderer/styles/base.css` is structure only; every colour and material is a
custom property defined in a theme file. To add a theme, copy
`theme-espresso.css`, change the values, and set `theme` in your config.

Scripts are ASCII-only on purpose: Windows PowerShell 5.1 reads `.ps1` files as
ANSI unless they carry a BOM, so a stray em dash turns into mojibake in the
console output.

### How readings are encoded

In priority order, and deliberately so:

1. **Needle position** on the dial and the big numeral beside it. This is the
   real encoding, and it's entirely colour-independent.
2. **A printed danger zone** on the dial face — a static reference band, like a
   real manometer. It never moves and never changes colour.
3. **Status colour**, on the dark machine body only — ready lamp, tank fills,
   thread cells.

That ordering exists because amber and red are adjacent hues that collapse under
deuteranopia — measured ΔE 1.8 against the cream dial face. So no live reading
depends on telling them apart.

The status ramp is cool→hot (steel blue → brass → red), which matches what it
means. Its three steps are validated against the machine body for lightness
band, chroma floor, colour-vision-deficiency separation, normal-vision
separation and contrast:

```
node scripts/validate_palette.js "#4795c0,#bf8a24,#c2392e" \
     --mode dark --surface "#17120f" --pairs all
```

Network needs no second hue: receive sits above the axis and transmit below on
one shared scale, so position and the direct labels carry identity.

A missing sensor renders as `--`, never `0`, and its needle is removed rather
than parked at the scale minimum — a pinned needle would read as a real low
value. A feed that stops dims the whole panel rather than leaving stale numbers
looking live.

## Licence

MIT
