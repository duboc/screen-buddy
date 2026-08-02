'use strict';

/**
 * Metadata that describes the configuration to the admin UI.
 *
 * This file is the single source of truth for "what can be tuned, what type is
 * it, and what happens when it changes". The admin page never hardcodes a field
 * list — it fetches this over the API and renders itself. Adding a knob here is
 * all it takes for it to appear in the editor.
 *
 * It is also the allowlist the server validates against: a PUT that names a
 * path not described here is dropped rather than written. That keeps a config
 * editor reachable over HTTP from becoming a way to write arbitrary JSON into
 * the app's config file.
 */

/* ── fonts ───────────────────────────────────────────────────────
   Local faces only. The HUD is an offline appliance on a machine that may have
   no network at boot, and its CSP forbids remote fonts, so a webfont would be
   a blank panel waiting on a download that never lands. Every stack below ends
   in a generic family, so an absent face degrades instead of falling back to
   Times New Roman. */

const FONT_STACKS = [
  {
    id: 'bahnschrift',
    label: 'Bahnschrift',
    note: 'Condensed industrial. Reads like equipment lettering; narrow digits.',
    stack: "'Bahnschrift', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'segoe-display',
    label: 'Segoe UI Variable Display',
    note: 'Windows 11 display face. Open and neutral at large sizes.',
    stack: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'segoe',
    label: 'Segoe UI',
    note: 'The safe Windows default. Present on every machine since Vista.',
    stack: "'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'franklin',
    label: 'Franklin Gothic Medium',
    note: 'Heavier grotesque. Good if you read the panel from further away.',
    stack: "'Franklin Gothic Medium', 'Arial Narrow', system-ui, sans-serif",
  },
  {
    id: 'arial-narrow',
    label: 'Arial Narrow',
    note: 'Very condensed. Fits long GPU names without truncating.',
    stack: "'Arial Narrow', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'tahoma',
    label: 'Tahoma',
    note: 'Compact and unusually legible at small sizes.',
    stack: "'Tahoma', 'Verdana', system-ui, sans-serif",
  },
  {
    id: 'verdana',
    label: 'Verdana',
    note: 'Wide and airy. Costs horizontal room but very readable.',
    stack: "'Verdana', 'Tahoma', system-ui, sans-serif",
  },
  {
    id: 'consolas',
    label: 'Consolas',
    note: 'Monospace. Every digit the same width — numbers never shift.',
    stack: "'Consolas', 'Cascadia Mono', ui-monospace, monospace",
    mono: true,
  },
  {
    id: 'cascadia',
    label: 'Cascadia Mono',
    note: 'Monospace, shipped with Windows Terminal. Softer than Consolas.',
    stack: "'Cascadia Mono', 'Cascadia Code', 'Consolas', ui-monospace, monospace",
    mono: true,
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    note: 'Monospace. Only if you have installed it — falls back to Consolas.',
    stack: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', ui-monospace, monospace",
    mono: true,
  },
  {
    id: 'georgia',
    label: 'Georgia',
    note: 'Serif, with old-style figures. An odd but characterful choice.',
    stack: "'Georgia', 'Times New Roman', serif",
  },
  {
    id: 'system',
    label: 'System default',
    note: 'Whatever the OS considers its UI face.',
    stack: 'system-ui, sans-serif',
  },
];

/* ── theme tokens ────────────────────────────────────────────────
   The subset of the theme stylesheets' custom properties that is safe and
   useful to override at runtime. Grouped the way the panel is built up:
   material first, then ink, then the data layers.

   Halos are deliberately absent. They are decoration that always duplicates a
   mark drawn beside a numeral, so they are derived from their mark rather than
   edited separately — one fewer control, and it can never drift out of sync
   with the colour it is supposed to be glowing around. */

const THEME_TOKENS = [
  // material
  { key: 'surface', label: 'Background', group: 'Material', type: 'color' },
  {
    key: 'plate-bg',
    label: 'Plate fill',
    group: 'Material',
    type: 'paint',
    help: 'A colour, or any CSS gradient if you want the brushed-metal falloff.',
  },
  { key: 'plate-edge', label: 'Plate edge', group: 'Material', type: 'color' },
  { key: 'rule', label: 'Hairlines', group: 'Material', type: 'color' },
  {
    key: 'plate-radius',
    label: 'Corner radius',
    group: 'Material',
    type: 'length',
    min: 0,
    max: 24,
    step: 1,
    unit: 'px',
  },

  // ink
  { key: 'ink', label: 'Primary text', group: 'Ink', type: 'color' },
  { key: 'ink-title', label: 'Titles', group: 'Ink', type: 'color' },
  { key: 'ink-dim', label: 'Secondary', group: 'Ink', type: 'color' },
  { key: 'ink-muted', label: 'Labels', group: 'Ink', type: 'color' },
  { key: 'ink-faint', label: 'Faint', group: 'Ink', type: 'color' },
  {
    key: 'brass',
    label: 'Accent',
    group: 'Ink',
    type: 'color',
    help: 'Trim, arrows, the seconds counter, the flow trace.',
  },

  // status
  {
    key: 'mark-nominal',
    label: 'Nominal',
    group: 'Status marks',
    type: 'color',
    help: 'Fills: tank water, thread cells, the ready lamp.',
  },
  { key: 'mark-warn', label: 'Warn', group: 'Status marks', type: 'color' },
  { key: 'mark-crit', label: 'Critical', group: 'Status marks', type: 'color' },
  {
    key: 'read-nominal',
    label: 'Nominal',
    group: 'Status readouts',
    type: 'color',
    help: 'Text: the big numerals and the waterline. Lifted a step so thin marks hold up.',
  },
  { key: 'read-warn', label: 'Warn', group: 'Status readouts', type: 'color' },
  { key: 'read-crit', label: 'Critical', group: 'Status readouts', type: 'color' },

  // dial
  { key: 'dial-face', label: 'Face', group: 'Dial', type: 'color' },
  { key: 'dial-rim', label: 'Rim', group: 'Dial', type: 'color' },
  { key: 'dial-ink', label: 'Engraving', group: 'Dial', type: 'color' },
  { key: 'zone-crit', label: 'Danger band', group: 'Dial', type: 'color' },
  { key: 'needle', label: 'Needle', group: 'Dial', type: 'color' },
  { key: 'needle-hub', label: 'Hub', group: 'Dial', type: 'color' },

  // vessels
  { key: 'tank-well', label: 'Well', group: 'Vessels', type: 'color' },
  { key: 'tank-edge', label: 'Glass edge', group: 'Vessels', type: 'color' },
  { key: 'tank-graduation', label: 'Graduations', group: 'Vessels', type: 'color' },
  { key: 'lamp-well', label: 'Lamp housing', group: 'Vessels', type: 'color' },
  { key: 'art-well', label: 'Album well', group: 'Vessels', type: 'color' },

  // flow
  { key: 'flow-stroke', label: 'Trace', group: 'Flow', type: 'color' },
  { key: 'flow-fill', label: 'Area fill', group: 'Flow', type: 'paint' },
  { key: 'ok', label: 'Source lamp', group: 'Flow', type: 'color' },
];

const THEME_TOKEN_KEYS = new Set(THEME_TOKENS.map((t) => t.key));

/* ── themes ──────────────────────────────────────────────────────
   One list, so a theme is registered in exactly one place. It drives the
   picker in the settings editor and tells it which stylesheets to parse for
   the "unset" colour of every token, which is why adding a theme here needs no
   corresponding edit in the editor.

   `mode` is not decoration: it tells the editor which surface a palette must be
   validated against, and it is why "daylight" is a selected light theme rather
   than an inverted dark one.

   Every palette below passes scripts/validate_palette.mjs; each stylesheet
   carries its own command and results in its header. */

const THEMES = [
  {
    id: 'espresso',
    label: 'Espresso',
    mode: 'dark',
    note: 'Warm brushed steel, brass trim, cream manometer dials.',
  },
  {
    id: 'neon',
    label: 'Neon',
    mode: 'dark',
    note: 'The original cyberpunk treatment: cyan and magenta on near-black.',
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    mode: 'dark',
    note: 'Cyanotype drawing board. White paper dials on deep process blue.',
  },
  {
    id: 'daylight',
    label: 'Daylight',
    mode: 'light',
    note: 'Paper and ink. The one light theme — for a panel by a window.',
  },
  {
    id: 'slate',
    label: 'Slate',
    mode: 'dark',
    note: 'Flat graphite, no texture, no accent. Stays out of the way.',
  },
  {
    id: 'phosphor',
    label: 'Phosphor',
    mode: 'dark',
    note: 'P1 oscilloscope tube: blue-green bloom, scanlines, monospace.',
  },
];

/* ── panels ──────────────────────────────────────────────────────
   `kind` decides how a panel is laid out on a rotating page. A block panel
   stretches to fill the height it is given; a strip panel keeps its natural
   height and sits on its own full-width row. `weight` is the column share a
   block panel takes when it shares a row. */

const PANELS = [
  {
    id: 'gauges',
    label: 'Gauges',
    note: 'CPU and GPU dials, side by side',
    kind: 'block',
  },
  {
    id: 'reservoir',
    label: 'Reservoir',
    note: 'RAM and VRAM sight glasses',
    kind: 'block',
  },
  { id: 'media', label: 'Now brewing', note: 'Media session', kind: 'block' },
  { id: 'network', label: 'Flow', note: 'Throughput graph and ping', kind: 'block' },
  { id: 'cores', label: 'Grinder', note: 'Per-thread load strip', kind: 'strip' },
  { id: 'footer', label: 'Footer', note: 'Sources, drives, disk capacity', kind: 'strip' },
  {
    id: 'processes',
    label: 'Orders',
    note: 'What is actually using the CPU and the RAM',
    kind: 'block',
  },
  {
    id: 'storage',
    label: 'Portafilter',
    note: 'Disk read/write rates, endurance and free space',
    kind: 'block',
  },
  {
    id: 'trends',
    label: 'Log book',
    note: 'Temperature and load over time, with peaks',
    kind: 'block',
  },
  {
    id: 'forecast',
    label: 'Outside',
    note: 'Next 12 hours and 5 days',
    kind: 'block',
  },
  {
    id: 'pressure',
    label: 'Pressure',
    note: 'Every fan header, board temp, VCore, GPU power headroom',
    kind: 'block',
  },
];

const PANEL_IDS = PANELS.map((p) => p.id);

/** Sensible rotation to start from, offered as a one-click preset in the admin. */
const DEFAULT_PAGES = [
  // Each page answers a different question. Rotation is only worth its cost if
  // waiting for the next page gets you something you could not already see —
  // a set of pages showing the same six panels at different sizes would be a
  // wait in exchange for nothing.
  { id: 'machine', title: 'MACHINE', panels: ['gauges', 'reservoir', 'cores'] },
  { id: 'orders', title: 'ORDERS', panels: ['processes', 'cores'] },
  { id: 'logbook', title: 'LOG BOOK', panels: ['trends', 'footer'] },
  { id: 'flow', title: 'FLOW', panels: ['network', 'storage'] },
  { id: 'outside', title: 'OUTSIDE', panels: ['forecast'] },
  { id: 'media', title: 'NOW BREWING', panels: ['media'], when: 'media' },
];

const PAGE_CONDITIONS = [
  { id: '', label: 'Always show' },
  { id: 'media', label: 'Only while something is playing' },
  { id: 'network', label: 'Only while the link is busy' },
];

const TRANSITIONS = [
  { id: 'fade', label: 'Crossfade', note: 'Calmest. No direction, so it pulls the eye least.' },
  { id: 'slide', label: 'Slide', note: 'Directional motion — more noticeable in peripheral vision.' },
  { id: 'none', label: 'Cut', note: 'Instant. Cheapest, but the jump is startling.' },
];

const ALERT_OVERRIDES = [
  { id: 'off', label: 'Never interrupt' },
  { id: 'crit', label: 'On critical only' },
  { id: 'warn', label: 'On warning or worse' },
];

/* ── form description ────────────────────────────────────────────
   `reload` says what has to happen for a change to take effect:
     'live'    — the HUD applies it on the next frame
     'sensors' — the sensor hub is restarted (a blip in the readings, no more)
     'restart' — needs the app restarted; the admin says so next to the field */

const FORM = [
  // Sections are normally lists of fields; this one is a custom view, because
  // restore points are records rather than settings.
  {
    id: 'backups',
    label: 'Backups',
    custom: 'restore',
    blurb:
      'Every save takes a restore point first, so any change can be undone — including a reset. Pin one before an experiment and you have a named way back. Restore points are plain JSON files in config.backups/, and `npm run config:list` reads them with the app stopped, which is when you are most likely to need them.',
    fields: [],
  },
  {
    id: 'appearance',
    label: 'Theme',
    blurb: 'Pick a base theme, then override any of its colours. Overrides layer on top, so switching base themes keeps your edits.',
    fields: [
      {
        path: 'theme',
        label: 'Base theme',
        type: 'select',
        reload: 'live',
        options: THEMES.map((t) => ({ id: t.id, label: t.label, note: t.note })),
      },
      {
        path: 'ui.glow',
        label: 'Glow',
        type: 'boolean',
        reload: 'live',
        help: 'Halos around lit marks. Decoration only — turning it off loses no information.',
      },
      {
        path: 'ui.scanlines',
        label: 'Grain / scanlines',
        type: 'boolean',
        reload: 'live',
        help: 'A faint texture so the body does not read as flat digital black.',
      },
    ],
  },
  {
    id: 'type',
    label: 'Type',
    blurb: 'This panel is read from across a desk, not at laptop distance, so it runs larger than a normal screen UI. Scale moves everything together — type, dials and row heights — so the layout stays in proportion.',
    fields: [
      {
        path: 'ui.typography.family',
        label: 'Interface face',
        type: 'font',
        allowInherit: true,
        inheritLabel: 'The theme’s own face',
        reload: 'live',
        help: 'Labels, titles and text. Left unset, each theme brings its own — espresso uses the condensed industrial Bahnschrift, neon uses Segoe UI Variable Display.',
      },
      {
        path: 'ui.typography.numerals',
        label: 'Numeral face',
        type: 'font',
        allowInherit: true,
        inheritLabel: 'Same as the interface face',
        reload: 'live',
        help: 'The readouts only. A monospace here keeps digits from shifting as they tick.',
      },
      {
        path: 'ui.typography.scale',
        label: 'Scale',
        type: 'range',
        min: 0.8,
        max: 1.35,
        step: 0.01,
        reload: 'live',
        help: 'Above about 1.2 the classic all-in-one layout runs out of height — that is the point at which rotation starts to pay for itself.',
      },
      {
        path: 'ui.typography.numeralWeight',
        label: 'Numeral weight',
        type: 'range',
        min: 100,
        max: 700,
        step: 100,
        reload: 'live',
        help: 'The big readouts are set light by default; heavier reads better on a dim panel.',
      },
      {
        path: 'ui.typography.letterSpacing',
        label: 'Label tracking',
        type: 'range',
        min: 0,
        max: 0.3,
        step: 0.01,
        unit: 'em',
        reload: 'live',
        help: 'Applies to the small uppercase labels, which need more air than body text.',
      },
      {
        path: 'ui.typography.tabularNums',
        label: 'Tabular figures',
        type: 'boolean',
        reload: 'live',
        help: 'Fixed-width digits. Without this, readouts jitter sideways on every tick.',
      },
    ],
  },
  {
    id: 'rotation',
    label: 'Rotation',
    blurb: 'Rotating pages trade instant recognition for legibility: each page gets more room, but anything not on screen costs you a wait. The bar never rotates, so the clock and the ready lamp are always there — and a critical reading can pull the gauges page forward on its own.',
    fields: [
      {
        path: 'ui.rotation.enabled',
        label: 'Rotate pages',
        type: 'boolean',
        reload: 'live',
        help: 'Off keeps the classic single-screen layout exactly as it is.',
      },
      {
        path: 'ui.rotation.dwellSec',
        label: 'Dwell',
        type: 'range',
        min: 4,
        max: 120,
        step: 1,
        unit: 's',
        reload: 'live',
        help: 'How long each page holds. Under about 8s reads as restless; 15–30s is comfortable.',
      },
      {
        path: 'ui.rotation.transition',
        label: 'Transition',
        type: 'select',
        options: TRANSITIONS,
        reload: 'live',
      },
      {
        path: 'ui.rotation.transitionMs',
        label: 'Transition time',
        type: 'range',
        min: 0,
        max: 1500,
        step: 50,
        unit: 'ms',
        reload: 'live',
      },
      {
        path: 'ui.rotation.alertOverride',
        label: 'Interrupt on alert',
        type: 'select',
        options: ALERT_OVERRIDES,
        reload: 'live',
        help: 'Jumps to the gauges page and holds there until the reading clears, so an alarm is never hidden on a page you are not looking at.',
      },
      {
        path: 'ui.rotation.indicator',
        label: 'Page dots',
        type: 'boolean',
        reload: 'live',
        help: 'A row of dots in the bar. Without them a paused rotation looks like a frozen panel.',
      },
      {
        path: 'ui.rotation.pages',
        label: 'Pages',
        type: 'pages',
        reload: 'live',
      },
    ],
  },
  {
    id: 'panels',
    label: 'Panels',
    blurb: 'Hidden panels collapse and the rest expands to fill. A panel hidden here is dropped from every rotation page too.',
    fields: PANELS.map((p) => ({
      path: `ui.panels.${p.id}`,
      label: p.label,
      type: 'boolean',
      reload: 'live',
      help: p.note,
    })).concat([
      {
        path: 'ui.showSeconds',
        label: 'Seconds',
        type: 'boolean',
        reload: 'live',
      },
      {
        path: 'ui.clock24h',
        label: '24-hour clock',
        type: 'boolean',
        reload: 'live',
      },
      {
        path: 'ui.historySamples',
        label: 'Flow history',
        type: 'range',
        min: 20,
        max: 300,
        step: 10,
        unit: ' samples',
        reload: 'live',
        help: 'At the default 1s poll this is also the graph window in seconds.',
      },
    ]),
  },
  {
    id: 'thresholds',
    label: 'Thresholds',
    blurb: 'Where the dial’s printed danger band starts and where the ready lamp changes state. Celsius for temperatures, percent for the rest.',
    fields: [
      { path: 'thresholds.cpuTemp.warn', label: 'CPU warn', type: 'number', min: 0, max: 120, unit: '°C', reload: 'live' },
      { path: 'thresholds.cpuTemp.crit', label: 'CPU critical', type: 'number', min: 0, max: 120, unit: '°C', reload: 'live' },
      { path: 'thresholds.gpuTemp.warn', label: 'GPU warn', type: 'number', min: 0, max: 120, unit: '°C', reload: 'live' },
      { path: 'thresholds.gpuTemp.crit', label: 'GPU critical', type: 'number', min: 0, max: 120, unit: '°C', reload: 'live' },
      {
        path: 'thresholds.driveTemp.warn',
        label: 'Drive warn',
        type: 'number',
        min: 0,
        max: 120,
        unit: '°C',
        reload: 'live',
        help: 'NVMe idles warm and throttles around 70 — these are drive numbers, not CPU ones.',
      },
      { path: 'thresholds.driveTemp.crit', label: 'Drive critical', type: 'number', min: 0, max: 120, unit: '°C', reload: 'live' },
      { path: 'thresholds.load.warn', label: 'Load warn', type: 'number', min: 0, max: 100, unit: '%', reload: 'live' },
      { path: 'thresholds.load.crit', label: 'Load critical', type: 'number', min: 0, max: 100, unit: '%', reload: 'live' },
      { path: 'thresholds.memory.warn', label: 'Memory warn', type: 'number', min: 0, max: 100, unit: '%', reload: 'live' },
      { path: 'thresholds.memory.crit', label: 'Memory critical', type: 'number', min: 0, max: 100, unit: '%', reload: 'live' },
    ],
  },
  {
    id: 'sensors',
    label: 'Sensors',
    blurb: 'Where the numbers come from. The footer lamps say which of these are answering right now.',
    fields: [
      { path: 'polling.fastMs', label: 'Fast poll', type: 'number', min: 200, max: 10000, unit: 'ms', reload: 'sensors', help: 'Load, temperature, clocks and network. 500 is smoother and costs more CPU.' },
      { path: 'polling.slowMs', label: 'Slow poll', type: 'number', min: 1000, max: 60000, unit: 'ms', reload: 'sensors', help: 'Things that barely change: disk capacity, uptime.' },
      { path: 'sensors.nvidiaSmi.enabled', label: 'nvidia-smi', type: 'boolean', reload: 'sensors', help: 'Ships with the NVIDIA driver. No elevation needed.' },
      { path: 'sensors.nvidiaSmi.path', label: 'nvidia-smi path', type: 'text', reload: 'sensors' },
      { path: 'sensors.libreHardwareMonitor.enabled', label: 'LibreHardwareMonitor', type: 'boolean', reload: 'sensors', help: 'The only source for CPU package temperature, CPU power and fan RPM — Windows exposes no public API for them.' },
      { path: 'sensors.libreHardwareMonitor.url', label: 'LHM endpoint', type: 'text', reload: 'sensors' },
      { path: 'sensors.libreHardwareMonitor.fanSensor', label: 'Fan sensor', type: 'text', nullable: true, reload: 'sensors', help: 'Blank auto-picks the first fan reporting a non-zero speed, which is a guess on boards that label headers "Fan #1".."Fan #7". Run npm run doctor to list yours.' },
      { path: 'sensors.network.interface', label: 'Network adapter', type: 'text', nullable: true, reload: 'sensors', help: 'Blank auto-picks the busiest adapter reporting Up.' },
      { path: 'sensors.nowPlaying.enabled', label: 'Now playing', type: 'boolean', reload: 'sensors' },
      { path: 'sensors.nowPlaying.intervalMs', label: 'Media poll', type: 'number', min: 500, max: 30000, unit: 'ms', reload: 'sensors' },
      { path: 'sensors.processes.enabled', label: 'Process list', type: 'boolean', reload: 'sensors', help: 'Feeds the Orders panel. Read through a PowerShell helper, because systeminformation’s equivalent costs ~900ms of CPU per call and does not cache.' },
      { path: 'sensors.processes.intervalMs', label: 'Process poll', type: 'number', min: 1000, max: 60000, unit: 'ms', reload: 'sensors', help: 'CPU percentages are derived between consecutive samples, so a longer interval averages over a longer window rather than sampling less often.' },
      { path: 'sensors.processes.top', label: 'Processes shown', type: 'number', min: 3, max: 12, reload: 'sensors' },
      { path: 'ui.history.windowMinutes', label: 'Trend window', type: 'range', min: 2, max: 120, step: 1, unit: ' min', reload: 'sensors', help: 'How much past the Log Book panel keeps. Changing it starts the window over.' },
      { path: 'sensors.ping.enabled', label: 'Latency', type: 'boolean', reload: 'sensors' },
      { path: 'sensors.ping.host', label: 'Ping host', type: 'text', reload: 'sensors' },
      { path: 'sensors.ping.intervalMs', label: 'Ping interval', type: 'number', min: 2000, max: 300000, unit: 'ms', reload: 'sensors' },
      { path: 'sensors.weather.enabled', label: 'Weather', type: 'boolean', reload: 'sensors' },
      { path: 'sensors.weather.latitude', label: 'Latitude', type: 'number', min: -90, max: 90, step: 0.01, nullable: true, reload: 'sensors', help: 'Never guessed from your IP — that would hand your location to a third party on every start. Blank means off.' },
      { path: 'sensors.weather.longitude', label: 'Longitude', type: 'number', min: -180, max: 180, step: 0.01, nullable: true, reload: 'sensors' },
      { path: 'sensors.weather.units', label: 'Units', type: 'select', reload: 'sensors', options: [{ id: 'metric', label: 'Metric (°C)' }, { id: 'imperial', label: 'Imperial (°F)' }] },
      { path: 'sensors.weather.refreshMinutes', label: 'Weather refresh', type: 'number', min: 5, max: 180, unit: 'min', reload: 'sensors' },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    blurb: 'Where the HUD lives and how it behaves. Most of these are set when the window is created, so they need a restart — the admin marks which.',
    fields: [
      { path: 'window.opacity', label: 'Opacity', type: 'range', min: 0.2, max: 1, step: 0.01, reload: 'live' },
      { path: 'window.clickThrough', label: 'Click-through', type: 'boolean', reload: 'live', help: 'Clicks pass through to whatever is underneath, so the panel can never be focused or dragged by accident.' },
      { path: 'window.alwaysOnTop', label: 'Always on top', type: 'boolean', reload: 'live' },
      { path: 'power.preventDisplaySleep', label: 'Keep display awake', type: 'boolean', reload: 'restart', help: 'Holds off the display-sleep timer so Windows never reshuffles your windows off this monitor.' },
      { path: 'display.strategy', label: 'Display strategy', type: 'select', reload: 'restart', options: [
        { id: 'smallest', label: 'Smallest — almost always the sensor panel' },
        { id: 'bounds', label: 'Bounds — pin a specific monitor by position' },
        { id: 'primary', label: 'Primary' },
        { id: 'largest', label: 'Largest' },
        { id: 'index', label: 'Index — avoid, the order is not stable' },
      ] },
      { path: 'display.bounds.x', label: 'Bounds X', type: 'number', reload: 'restart' },
      { path: 'display.bounds.y', label: 'Bounds Y', type: 'number', reload: 'restart' },
      { path: 'admin.port', label: 'Admin port', type: 'number', min: 1024, max: 65535, reload: 'restart' },
      { path: 'admin.host', label: 'Admin bind address', type: 'text', reload: 'restart', help: 'Leave at 127.0.0.1 unless you want to reach this from another machine — and if you do, set a token first.' },
      { path: 'admin.token', label: 'Admin token', type: 'text', nullable: true, reload: 'restart', help: 'Required whenever the admin is bound to anything other than loopback.' },
    ],
  },
];

/** Every path the admin is allowed to write, flattened out of the form above. */
const WRITABLE_PATHS = new Set(
  FORM.flatMap((section) => section.fields.map((f) => f.path)),
);

const FIELD_BY_PATH = new Map(
  FORM.flatMap((section) => section.fields.map((f) => [f.path, f])),
);

module.exports = {
  THEMES,
  FONT_STACKS,
  THEME_TOKENS,
  THEME_TOKEN_KEYS,
  PANELS,
  PANEL_IDS,
  DEFAULT_PAGES,
  PAGE_CONDITIONS,
  TRANSITIONS,
  ALERT_OVERRIDES,
  FORM,
  WRITABLE_PATHS,
  FIELD_BY_PATH,
};
