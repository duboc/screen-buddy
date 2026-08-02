# screen-buddy

A system-stats HUD for a spare monitor, styled to look like part of an espresso
machine. It takes over one display, sits above everything, ignores your mouse
entirely, and shows what the machine is doing.

Built for a small secondary panel — the 1024×600 boards sold as "sensor panels"
are the reference size — but it fills whatever display you point it at.

Six themes, a live [settings page](#settings) that previews every change on the
panel before you commit it, and optional [page rotation](#rotating-pages) for
panels too small to show everything at once.

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

Five more panels exist for [rotating pages](#rotating-pages), which is what makes
room for them — they are not shown in the all-in-one layout:

| Panel | Metrics |
|---|---|
| **Orders** | Which processes are actually using the CPU and the RAM, grouped by name and ranked |
| **Log book** | Temperature and load over the last 15 minutes, with session peaks and time spent above the warn line |
| **Portafilter** | Disk read/write rates, drive endurance, temperature and free space |
| **Outside** | The next 12 hours and 5 days |
| **Pressure** | Every fan header, board temperature, VCore, GPU power against its limit, swap |

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

## Settings

Right-click the tray icon and pick **Settings…**, or open
<http://127.0.0.1:8787/>. Every change previews on the panel as you make it and
nothing is written until you press save — you judge a colour or a font by
looking at the panel, so the panel is the preview.

It covers the base theme and every one of its colours, the type (face, scale,
weight, tracking), which panels are shown, page rotation, thresholds, sensors
and the window. Fields that need a restart say so.

It is a small local HTTP service that writes `config.json` and nothing else: it
runs no commands and reads no file outside its own directory. It binds to
loopback, checks the `Host` header (so a web page you have open cannot reach it
by pointing a DNS name at 127.0.0.1), requires a same-origin `Origin` on writes,
and validates every value against a schema allowlist rather than merging what it
is handed. Binding it to a LAN address requires `admin.token` and is refused
without one. Set `admin.enabled` to `false` to not listen at all.

### Themes

Six, each a single stylesheet of custom properties. Set `theme`, or pick one in
the settings page — and recolour any of them token by token with
`ui.themeOverrides`, which layers on top so switching base themes keeps your edits.

| Theme | | Character |
|---|---|---|
| `espresso` | dark | Warm brushed steel, brass trim, cream manometer dials |
| `neon` | dark | The original cyberpunk treatment: cyan and magenta on near-black |
| `blueprint` | dark | Cyanotype drawing board; the white paper dials are the only unblued objects on it |
| `daylight` | **light** | Paper and ink — for a panel by a window, where a dark surface just reflects the room |
| `slate` | dark | Flat graphite, no texture, no accent. Stays out of the way |
| `phosphor` | dark | P1 oscilloscope tube: blue-green bloom, heavy scanlines, monospace |

**Every status ramp is validated, not eyeballed.** Amber and red are adjacent
hues that collapse under deuteranopia, so each theme's three steps are checked
for lightness band, chroma floor, colour-vision separation, a normal-vision
floor and contrast against that theme's own surface:

```powershell
npm run themes      # re-validate all six; exits non-zero on any failure
```

It reads the colours and the surface out of the stylesheets, so it cannot drift
from what the panel renders — change a hex and this tells you whether it still
passes. Each theme's header quotes its own numbers and the command that
reproduces them.

Two consequences worth knowing if you write your own:

- **`daylight` is a selected light theme, not an inverted dark one.** Inverting a
  dark palette gives marks far too light to hold 3:1 against paper. Its read
  layer is *darker* than its mark layer — the opposite of every dark theme —
  because on paper a thin mark has to be deepened, not lifted.
- **A single-hue theme cannot have a validated three-step ramp.** The dark
  lightness band is only 0.19 wide, so three shades of one hue land inside ΔE 6
  of each other. That is why `phosphor` keeps a monochrome *body* but gives the
  three data steps real hues — the honest version of a one-colour tube.

### Rotating pages

Off by default, and worth understanding before turning on. Rotation trades
instant recognition for legibility. Most of what makes an ambient panel readable
is that things stay put — you learn the boiler temperature is top-left and after
that you stop looking properly — and rotation gives that up: some of the time
the reading you want simply is not on screen, so a glance becomes a wait. Motion
in the corner of your eye is also hard to ignore while you are doing something
else.

The point is not to show the same six panels at different sizes — that is a wait
in exchange for nothing. Rotation buys **capacity**: pages carrying information
the single-screen layout has no room for at all.

| Page | Answers |
|---|---|
| **MACHINE** | The vitals: dials, RAM/VRAM, per-thread load |
| **ORDERS** | *What is actually using the CPU and the RAM*, by process, grouped and ranked |
| **LOG BOOK** | *How it got here*: temperature and load over the last 15 min, with peaks and time spent above the warn line |
| **FLOW** | Network throughput **and disk read/write rates**, drive endurance and free space |
| **OUTSIDE** | The next 12 hours and 5 days, not just the current reading in the bar |
| **PRESSURE** | Every fan header, board temperature, VCore, GPU power against its limit |
| **NOW BREWING** | The media session — skipped entirely when nothing is playing |

Several of those are built from readings the panel was already taking and
throwing away: every fan header, CPU voltage, board temperature, GPU power limit
and swap were all in the sensor feed and drawn nowhere.

Rotation also buys legibility. On a 1024×600 board a gauge gets 268px of height
in the all-in-one layout and 480 on a page of its own, which is the difference
between squinting and reading it from the far side of the room. Four things pay
down the cost:

- **The bar never rotates.** Clock, weather and ready lamp are always there.
- **An alert takes over.** A critical reading pulls the gauges page forward and
  holds it until it clears, so an alarm is never hidden on a page you are not
  on. Configurable, including off.
- **Conditional pages.** A page can require something to be true — the media
  page only appears while something is playing, rather than showing an empty
  frame two thirds of the time.
- **Crossfade, not slide.** Direction is what makes motion catch the eye; the
  default transition has none.

Pages are lists of panels, edited in the settings page or in `ui.rotation.pages`.
Each page should answer a different question; if two pages tell you the same
thing, one of them is only costing you a wait.

Two of the new panels need a source the others do not:

- **ORDERS** reads processes through `scripts/processes-loop.ps1`. systeminformation's
  `processes()` costs ~900ms of CPU per call and does not cache — an absurd price
  for a panel whose job is to watch CPU rather than consume it. `Get-Process` is a
  single API call, and the long-lived helper keeps the previous sample so it can
  report real CPU percentages rather than cumulative processor-seconds.
- **PORTAFILTER** takes disk throughput from LibreHardwareMonitor, because Windows
  gives systeminformation nothing here — `fsStats()` and `disksIO()` both return
  `null`. LHM already publishes read/write rates, endurance and free space in the
  feed fetched for the CPU, so it costs no extra polling; without LHM the panel
  has only what the footer already showed.

### Type scale

`ui.typography.scale` moves type, dial diameter and row heights together, so the
layout stays in proportion instead of type outgrowing its plate. The panel is
read from across a desk and how big "big" should be depends on the desk. Past
about 1.2 the all-in-one layout runs out of room on a 1024×600 board — which is
the point at which rotation starts to pay for itself.

Fonts are local faces only. The HUD may boot before the network is up and its
CSP forbids remote resources, so a webfont would be a blank panel waiting on a
download that never arrives.

## Configuration

Everything the settings page writes lives in `config.json` (gitignored — your
copy stays yours), and it is a plain file you can edit by hand instead.
`config.example.json` is the annotated template listing every key with defaults
and an explanation. Saving from the settings page merges only what you changed
and keeps the `$comment` documentation intact.

### Rolling back

Every save takes a restore point first, so any change can be undone — including
a reset, which snapshots the configuration it is about to replace. They live in
`config.backups/` as plain timestamped JSON.

```powershell
npm run config:list                      # what you can go back to
npm run config:restore                   # undo the last change
npm run config:restore -- <id>           # go back to a specific one
npm run config:pin -- "before neon"      # name one; never pruned automatically
npm run config:reset                     # theme and layout only
npm run config:reset -- --all            # everything, back to the template
```

The same list is in the settings page under **Backups**, but the CLI is the one
that matters: the moment you most need to undo a config change is the moment the
app will not start because of it, so the recovery tool deliberately runs without
Electron and works with screen-buddy stopped.

Twelve automatic snapshots are kept, pruned oldest-first; pinned ones are never
pruned. `npm run config:reset` keeps your display, window and sensor setup and
resets only how the panel looks — that is usually the reset you actually want,
and it means experimenting with themes can never cost you your monitor pinning.

There is always at least one way back. `config.example.json` is tracked in git,
so **shipped defaults** is available even with `config.backups/` deleted, and if
the template itself is missing the defaults compiled into the app are used
instead.

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
| `theme` | One of six; see Themes below |
| `ui.themeOverrides.*` | Override any of the theme's colours; layered on top, so switching themes keeps your edits |
| `ui.typography.*` | Face, scale, numeral weight, label tracking |
| `ui.rotation.*` | Cycle pages instead of showing everything at once |
| `ui.history.windowMinutes` | How much past the Log Book panel keeps |
| `sensors.processes.*` | The process list behind the Orders panel |
| `window.clickThrough` | `false` to let the HUD accept clicks |
| `window.alwaysOnTop` | `false` to let other windows cover it |
| `polling.fastMs` | Refresh rate. 1000 default; 500 is smoother and costs more CPU |
| `ui.panels.*` | Hide whole sections; the rest expands to fill |
| `admin.*` | The settings page: port, bind address, or `enabled: false` to turn it off |
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
`theme-espresso.css`, change the values, and set `theme` in your config. The
settings page reads its "unset" colours straight out of those stylesheets, so a
new theme needs no second declaration anywhere.

`src/main/schema.js` is the single description of what can be configured: it
generates the settings form *and* is the allowlist the server validates writes
against. Adding a field there is all it takes for it to appear in the editor and
become writable — and a path that is not in it cannot be written at all.

`src/renderer/js/deck.js` owns page layout. With rotation off it builds exactly
one page whose rows reproduce the original grid, so there is only ever one
layout code path and turning the feature off is pixel-neutral.

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
node scripts/validate_palette.mjs "#4795c0,#bf8a24,#c2392e" \
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
