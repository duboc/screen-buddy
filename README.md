# screen-buddy

A system-stats HUD for a spare monitor. It takes over one display, sits above
everything, ignores your mouse entirely, and shows what the machine is doing.

Built for a small secondary panel — the 1024×600 boards that get sold as
"sensor panels" are the reference size — but it fills whatever display you point
it at.

```
┌──────────────────────────────────────────────────────────────┐
│ SCREEN·BUDDY  hostname · Windows 11        UPTIME    21:47:03│
├──────────────────┬──────────────────┬────────────────────────┤
│    ◜ 72 ◝        │    ◜ 61 ◝        │  THREADS 32×           │
│   ◟  °C  ◞       │   ◟  °C  ◞       │  ▁▃▂█▁▁▂▁▁▅▁▂▁▁▁▃      │
│  CPU  9950X3D    │  GPU  RTX 5080   │  ▂▁▁▁▄▁▁▁▂▁▁▆▁▁▂▁      │
│  LOAD 48%        │  LOAD 77%        │                        │
│  CLOCK 4.82 GHz  │  CLOCK 2.61 GHz  │  idle  busy  saturated │
├──────────────────┴──────────────────┴────────────────────────┤
│ CPU LOAD 48%   GPU LOAD 77%   MEMORY 14.2/61.7   VRAM 2.0/16 │
│ ▬▬▬▬▬▬▭▭▭▭▭▭   ▬▬▬▬▬▬▬▬▬▭▭▭   ▬▬▬▭▭▭▭▭▭▭▭▭▭▭▭    ▬▬▭▭▭▭▭▭▭▭▭ │
├──────────────────────────────────────────────────────────────┤
│ NETWORK  Ethernet          ↓ 42.1 MB/s      ↑ 1.8 MB/s       │
│      ╱╲      ╱╲╱╲                                            │
│ ─────────────────────────────────────────────────────── axis │
│   ╲╱                    ╲╱                                   │
├──────────────────────────────────────────────────────────────┤
│ ● system  ● nvidia-smi  ○ lhm not running    C: 68%  D: 41%  │
└──────────────────────────────────────────────────────────────┘
```

## What it shows

| Panel | Metrics |
|---|---|
| Gauges | CPU and GPU temperature (arc + numeral), model, load, clock, power, fan |
| Threads | Per-thread load, one cell each — 32 cells on a 16-core part |
| Meters | CPU load, GPU load, system memory, VRAM |
| Network | Receive above the axis, transmit below, on one shared scale |
| Footer | Which sensor sources are live, and disk capacity |

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

## Sensor sources

Three independent sources; each degrades on its own, and the footer says which
are live.

| Source | Provides | Needs |
|---|---|---|
| `systeminformation` | CPU load & per-thread load, memory, network, disks, uptime | nothing |
| `nvidia-smi` | GPU temp, load, clocks, power, VRAM, fan | NVIDIA driver |
| LibreHardwareMonitor | **CPU temp, CPU power, fan RPM, mobo temp** | LHM running elevated |

Only the third is optional, and it exists for one reason: **Windows has no public
API for AMD/Intel desktop CPU package temperature.** `MSAcpi_ThermalZoneTemperature`
is either absent or reports a chipset sensor that reads well below the real die
temperature. LibreHardwareMonitor talks to the CPU's own management unit, so it is
the only source that gets this right.

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
running (`power.preventDisplaySleep`), and re-places itself 1.5s after any
monitor hot-plug or resolution change, which is when Windows would otherwise
reshuffle it onto another screen.

## Configuration

Everything lives in `config.json` (gitignored — your copy stays yours).
`config.example.json` is the annotated template and lists every key with defaults.

The settings worth knowing:

| Key | Why you'd change it |
|---|---|
| `display.strategy` | `bounds` (match a monitor's position), `smallest`, `largest`, `index`, `primary` |
| `window.clickThrough` | `false` if you want the HUD to accept clicks |
| `window.alwaysOnTop` | `false` to let other windows cover it |
| `polling.fastMs` | Refresh rate for load/temp/network. 1000 is a good default; 500 is smoother and costs more CPU |
| `ui.glow` / `ui.scanlines` | Turn off the CRT treatment |
| `ui.panels.*` | Hide whole sections; the rest expands to fill |
| `thresholds.*` | Where readings turn amber, then magenta |

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

The theme is one stylesheet. `src/renderer/styles/base.css` is structure only;
every colour is a custom property defined in `src/renderer/styles/theme-neon.css`.
To add a theme, copy that file, change the values, and set `theme` in your config.

### About the colours

The palette is split into two layers on purpose:

- The **mark layer** carries the data — gauge arcs, meter fills, heatmap cells,
  network areas. Those four steps (`#0e9fb6`, `#c4841a`, `#e0247f`, `#7d5fe0`)
  are validated against the `#04070d` surface for lightness band, chroma floor,
  colour-vision-deficiency separation, normal-vision separation, and contrast.
- The **glow layer** is decoration — 2px inner strokes, numerals, CSS shadows. It
  always duplicates a mark that is already drawn and always sits next to a
  numeral, so it never encodes anything on its own. Those steps run brighter than
  a chart palette normally would, because on a 5-inch panel across a desk the
  lift is what makes it readable.

Status colours mean *state* (nominal / warning / critical) and are never reused as
series identity. The two network series are separated by **position** — receive
above the axis, transmit below, on one shared scale — and by direct labels; hue
only reinforces that.

A missing sensor renders as `--`, never `0`. A feed that stops dims the whole
panel rather than leaving stale numbers looking live.

## Licence

MIT
