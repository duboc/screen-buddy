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
│   │ ╲  ·84· │  │54│°C   │   │  ╲ ·80· │   │54│°C  │  │▓▓▓▓│  │▓▓▓▓│        │
│    ╰────────╯  └──┘     │    ╰────────╯   └──┘    │  └────┘  └────┘        │
│              LOAD 10%   │              LOAD  2%   │   27%      16%         │
│ CLOCK      POWER   FAN  │ CLOCK     POWER    FAN  │   RAM      VRAM        │
│ 4.29 GHz   --      --   │ 637 MHz   31 W     0%   │ 16.8/61.7  2.5/15.9 GB │
├─────────────────────────┴─────────────────────────┼────────────────────────┤
│ NOW BREWING   Spotify                      PAUSED │ FLOW   Wi-Fi6          │
│  ┌────┐  Levitating                               │  ↓ 0 B/s    ↑ 0 B/s    │
│  │ ◎  │  Dua Lipa                                 │  ────────────────────  │
│  └────┘  Future Nostalgia                         │  PEAK 488 KB/s         │
│  0:10 ▬▬▬───────────────────────────────── 3:23   │              LAST 11s  │
├───────────────────────────────────────────────────┴────────────────────────┤
│ GRINDER    ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▃▅▄▁▁▂▃▁▁▄▁▁▁▁  (32 threads)                    │
├────────────────────────────────────────────────────────────────────────────┤
│ ● SYSTEM  ● NVIDIA-SMI  ○ LHM not running  ● MEDIA      C: 20%   D: 43%    │
└────────────────────────────────────────────────────────────────────────────┘
```

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

- Windows 10/11
- Node.js 20+
- An NVIDIA GPU for the GPU panel (uses `nvidia-smi`, which ships with the driver)
- **Optional:** [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
  for CPU temperature, CPU power and fan RPM

## Install

```powershell
git clone https://github.com/duboc/screen-buddy.git
cd screen-buddy
npm install
```

Find your HUD monitor and get a config snippet for it:

```powershell
npm run displays
```

Copy `config.example.json` to `config.json` and paste in the `display` block it
printed. Then:

```powershell
npm start
```

The window has no frame and ignores the mouse, so use the **tray icon** to quit,
reload, re-place it, or turn click-through off.

### Restarting it

```powershell
.\scripts\make-shortcut.ps1
```

Puts a **Restart screen-buddy** shortcut on your Desktop, with the espresso-cup
icon. Double-click it to stop and restart the HUD; no console window appears.
`-Remove` deletes it again.

Or from a terminal:

```powershell
.\scripts\restart.ps1              # stop and start
.\scripts\restart.ps1 -StopOnly    # just stop
```

`restart.ps1` deliberately does **not** kill `electron.exe` by name — VS Code,
Discord, Slack and plenty of other apps are Electron too. It matches on the
command line containing this project's path, so only this app is touched. It
also clears the media helper, which is a child process and would otherwise be
orphaned by a force-kill.

## Sensor sources

Four independent sources. Each degrades on its own, and the footer says which
are live.

| Source | Provides | Needs |
|---|---|---|
| `systeminformation` | CPU load & per-thread load, memory, network, disks, uptime | nothing |
| `nvidia-smi` | GPU temp, load, clocks, power, VRAM, fan | NVIDIA driver |
| Windows media session | Now-playing track, artist, album, position, play state | nothing |
| LibreHardwareMonitor | **CPU temp, CPU power, fan RPM, mobo temp** | LHM running elevated |

Only the last is optional-with-setup, and it exists for one reason: **Windows has
no public API for AMD/Intel desktop CPU package temperature.**
`MSAcpi_ThermalZoneTemperature` is either absent or reports a chipset sensor that
reads well below the real die temperature. LibreHardwareMonitor talks to the CPU's
own management unit, so it is the only source that gets this right.

Without it, those four fields show `--`. Everything else works normally. Set it up
with:

```powershell
.\scripts\setup-windows.ps1 -InstallLhm -LhmAutoStart
```

Then open LHM once and tick **Options → Remote Web Server → Run**, plus
**Options → Start Minimized**. It must run **as Administrator** — unelevated it
silently reports far fewer sensors.

Check what is actually being read at any time:

```powershell
npm run probe
```

### Now playing

Reads the Windows **global media session** — the same one behind the volume
flyout's media controls. That means it shows whatever is actually playing:
Spotify, a browser tab, VLC, anything. No API key, no OAuth, no per-app
integration, no setup.

A long-lived `powershell.exe` helper streams one JSON line every couple of
seconds (`scripts/nowplaying-loop.ps1`). It must be Windows PowerShell 5.1 —
PowerShell 7 dropped the WinRT type projection it depends on.

**No album art.** The thumbnail is reachable as a `RandomAccessStreamReference`,
but PowerShell 5.1 cannot marshal the stream `OpenReadAsync` hands back — it
arrives as an unprojected `System.__ComObject` that will not bind to
`IInputStream`. Getting art would need a compiled WinRT helper; the panel shows a
record-disc placeholder instead.

## Keeping it out of the way

`scripts/setup-windows.ps1` handles the Windows-side configuration. Run it with no
switches for a report that changes nothing:

```powershell
.\scripts\setup-windows.ps1
```

| Switch | What it does |
|---|---|
| `-HideTaskbar` | Stops Windows drawing the taskbar on secondary displays |
| `-AutoStart` | Launches screen-buddy at login, no console flash |
| `-InstallLhm` | winget-installs LibreHardwareMonitor |
| `-LhmAutoStart` | Scheduled task to start LHM elevated at logon (needs an admin shell) |
| `-All` | All of the above |
| `-Undo` | Reverts every change it made |

It supports `-WhatIf` throughout.

Three things it deliberately does **not** do, because they are outside a script's
remit:

- **Stop the cursor drifting onto the panel.** Windows has no setting for this.
  [Dual Monitor Tools](https://dualmonitortool.sourceforge.net/) has a *Cursor*
  module that adds a sticky edge you have to push through on purpose.
- **Stop windows opening there.** The HUD is click-through and unfocusable, so it
  never steals anything — but Windows may still place a new window on that
  monitor. A window manager like FancyZones is the fix if it bothers you.
- **Change your display arrangement.** Do that in Settings.

The app handles display sleep itself: it holds off the display-sleep timer while
running (`power.preventDisplaySleep`), and re-places itself 1.5s after any monitor
hot-plug or resolution change, which is when Windows would otherwise reshuffle it
onto another screen.

## Configuration

Everything lives in `config.json` (gitignored — your copy stays yours).
`config.example.json` is the annotated template and lists every key with defaults.

The settings worth knowing:

| Key | Why you'd change it |
|---|---|
| `display.strategy` | `bounds` (match a monitor's position), `smallest`, `largest`, `index`, `primary` |
| `theme` | `espresso` (default) or `neon` for the original cyberpunk look |
| `window.clickThrough` | `false` if you want the HUD to accept clicks |
| `window.alwaysOnTop` | `false` to let other windows cover it |
| `polling.fastMs` | Refresh rate. 1000 is a good default; 500 is smoother and costs more CPU |
| `ui.panels.*` | Hide whole sections; the rest expands to fill |
| `thresholds.*` | Where the dial's danger zone starts and the lamp changes state |
| `sensors.nowPlaying.enabled` | `false` to skip the media helper entirely |

`display.strategy: "bounds"` matches on monitor *position* rather than index
because Electron's display ordering is not stable across reboots and hot-plugs —
an index that points at the little panel today can point at your main monitor
tomorrow.

## Development

```powershell
npm run windowed   # normal 1024x600 window, focusable, movable
npm run dev        # HUD mode + detached devtools
npm run probe      # one sensor snapshot, no UI
npm run displays   # what Electron thinks your monitors are
```

`src/renderer/styles/base.css` is structure only; every colour and material is a
custom property defined in a theme file. To add a theme, copy
`theme-espresso.css`, change the values, and set `theme` in your config.

### How readings are encoded

In priority order, and deliberately so:

1. **Needle position** on the dial and the big numeral beside it. This is the
   real encoding, and it is entirely colour-independent.
2. **A printed danger zone** on the dial face — a static reference band, like a
   real manometer. It never moves and never changes colour, so it is not
   carrying a variable.
3. **Status colour**, on the dark machine body only — the ready lamp, the tank
   fills, the thread cells.

That ordering exists because amber and red are adjacent hues that collapse under
deuteranopia — measured ΔE 1.8 against the cream dial face. So no live reading is
left depending on telling them apart.

The status ramp is cool→hot (steel blue → brass → red), which matches what it
means. Its three steps are validated against the machine body for lightness band,
chroma floor, colour-vision-deficiency separation, normal-vision separation and
contrast:

```
node scripts/validate_palette.js "#4795c0,#bf8a24,#c2392e" \
     --mode dark --surface "#17120f" --pairs all
```

Network needs no second hue at all: receive sits above the axis and transmit
below on one shared scale, so position and the direct labels carry identity.

A missing sensor renders as `--`, never `0`, and its needle is removed rather
than parked at the scale minimum — a pinned needle would read as a real low
reading. A feed that stops dims the whole panel rather than leaving stale numbers
looking live.

## Licence

MIT
