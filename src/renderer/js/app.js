import * as f from './format.js';
import { buildDialFace, needleAngle } from './dial.js';
import { renderWeatherIcon } from './weather-icons.js';

/* ── constants ─────────────────────────────────────────────────── */

const PLOT_W = 300;
const PLOT_H = 52;
const PLOT_MID = PLOT_H / 2;
const PLOT_AMPLITUDE = PLOT_MID - 2;

// Floor for the flow scale. Without it, an idle link auto-scales a few bytes
// of background chatter into a dramatic full-height waveform.
const NET_SCALE_FLOOR = 256 * 1024;

const STALE_AFTER_MS = 6000;

/* ── element refs ──────────────────────────────────────────────── */

const el = {
  hud: document.getElementById('hud'),
  host: document.getElementById('host'),
  uptime: document.getElementById('uptime'),
  clock: document.getElementById('clock'),
  clockSecs: document.getElementById('clock-secs'),
  date: document.getElementById('date'),
  weather: document.getElementById('weather'),
  weatherIcon: document.getElementById('weather-icon'),
  weatherTemp: document.getElementById('weather-temp'),
  weatherUnit: document.getElementById('weather-unit'),
  weatherLabel: document.getElementById('weather-label'),
  weatherHigh: document.getElementById('weather-high'),
  weatherLow: document.getElementById('weather-low'),
  ping: document.getElementById('ping'),
  pingValue: document.getElementById('ping-value'),
  drives: document.getElementById('drives'),
  lamp: document.getElementById('lamp'),
  lampText: document.getElementById('lamp-text'),
  cpu: document.getElementById('gauge-cpu'),
  gpu: document.getElementById('gauge-gpu'),
  coresGrid: document.getElementById('cores-grid'),
  coresCount: document.getElementById('cores-count'),
  netIface: document.getElementById('net-iface'),
  netRx: document.getElementById('net-rx'),
  netRxUnit: document.getElementById('net-rx-unit'),
  netTx: document.getElementById('net-tx'),
  netTxUnit: document.getElementById('net-tx-unit'),
  netAreaRx: document.getElementById('net-area-rx'),
  netLineRx: document.getElementById('net-line-rx'),
  netAreaTx: document.getElementById('net-area-tx'),
  netLineTx: document.getElementById('net-line-tx'),
  netPeak: document.getElementById('net-peak'),
  mediaApp: document.getElementById('media-app'),
  mediaState: document.getElementById('media-state'),
  mediaTitle: document.getElementById('media-title'),
  mediaArtist: document.getElementById('media-artist'),
  mediaAlbum: document.getElementById('media-album'),
  mediaPos: document.getElementById('media-pos'),
  mediaEnd: document.getElementById('media-end'),
  mediaFill: document.getElementById('media-fill'),
  sources: document.getElementById('sources'),
  disks: document.getElementById('disks'),
};

const tanks = {};
for (const node of document.querySelectorAll('.tank')) {
  tanks[node.dataset.tank] = {
    root: node,
    fill: node.querySelector('.tank__fill'),
    pct: node.querySelector('[data-field="pct"]'),
    abs: node.querySelector('[data-field="abs"]'),
  };
}

/* ── state ─────────────────────────────────────────────────────── */

let config = null;
let netHistory = [];
let coreCells = [];
let lastSnapshotAt = 0;
const dialsBuilt = new WeakSet();

/* ── gauges ────────────────────────────────────────────────────── */

/** Domain for a temperature dial, derived from its thresholds. */
const dialDomain = (thresholds) => ({ min: 20, max: thresholds.crit + 10 });

function renderGauge(root, reading, thresholds) {
  const domain = dialDomain(thresholds);
  const dial = root.querySelector('[data-dial] svg');

  // Ticks, numerals and the printed danger zone depend only on the domain and
  // thresholds, so they are drawn once and then left alone.
  if (!dialsBuilt.has(root)) {
    buildDialFace(dial, domain, thresholds);
    dialsBuilt.add(root);
  }

  const status = f.statusOf(reading.temp, thresholds);
  root.dataset.status = status;

  // A parked needle at the scale minimum would read as a real 20 C reading, so
  // when the sensor is absent the needle is removed rather than pinned.
  const needle = root.querySelector('[data-needle]');
  const hasTemp = Number.isFinite(reading.temp);
  needle.style.visibility = hasTemp ? '' : 'hidden';
  if (hasTemp) {
    needle.firstElementChild.style.transform = `rotate(${needleAngle(
      reading.temp,
      domain,
    )}deg)`;
  }

  root.querySelector('[data-field="temp"]').textContent = f.celsius(reading.temp);
  root.querySelector('[data-field="name"]').textContent = reading.name ?? '—';
  root.querySelector('[data-field="load"]').textContent = f.pct(reading.load);
  root.querySelector('[data-field="clock"]').textContent = f.clock(reading.clock);
  root.querySelector('[data-field="power"]').textContent = f.watts(reading.power);
  root.querySelector('[data-field="fan"]').textContent = reading.fan;
}

/* ── reservoir ─────────────────────────────────────────────────── */

function renderTank(key, { pct, abs, thresholds }) {
  const t = tanks[key];
  if (!t) return;
  t.root.dataset.status = f.statusOf(pct, thresholds);
  t.pct.textContent = f.pct(pct);
  t.abs.textContent = abs;
  t.fill.style.height = Number.isFinite(pct)
    ? `${Math.min(100, Math.max(0, pct))}%`
    : '0%';
}

/* ── thread strip ──────────────────────────────────────────────── */

function buildCoreGrid(count) {
  if (coreCells.length === count) return;
  el.coresGrid.replaceChildren();
  coreCells = [];
  // One row: 32 narrow columns read as a bank of indicators across the strip.
  el.coresGrid.style.gridTemplateColumns = `repeat(${count}, 1fr)`;

  for (let i = 0; i < count; i += 1) {
    const cell = document.createElement('div');
    cell.className = 'strip__cell';
    const fill = document.createElement('i');
    cell.append(fill);
    el.coresGrid.append(cell);
    coreCells.push({ cell, fill });
  }
  el.coresCount.textContent = `${count} THREADS`;
}

function renderCores(loads, thresholds) {
  if (!loads || !loads.length) return;
  buildCoreGrid(loads.length);
  for (let i = 0; i < loads.length; i += 1) {
    const load = Number.isFinite(loads[i]) ? loads[i] : 0;
    const { cell, fill } = coreCells[i];
    // Floor of 5% so an idle thread shows a baseline tick rather than an empty
    // cell, which would read as "no data".
    fill.style.height = `${Math.min(100, Math.max(5, load))}%`;
    cell.dataset.status = f.statusOf(load, thresholds);
  }
}

/* ── flow ──────────────────────────────────────────────────────── */

function buildPaths(samples, peak) {
  if (samples.length < 2) return { rxLine: '', rxArea: '', txLine: '', txArea: '' };

  const step = PLOT_W / (samples.length - 1);
  const rxPts = [];
  const txPts = [];

  for (let i = 0; i < samples.length; i += 1) {
    const x = (i * step).toFixed(2);
    const rxY = PLOT_MID - Math.min(1, samples[i].rx / peak) * PLOT_AMPLITUDE;
    const txY = PLOT_MID + Math.min(1, samples[i].tx / peak) * PLOT_AMPLITUDE;
    rxPts.push(`${x},${rxY.toFixed(2)}`);
    txPts.push(`${x},${txY.toFixed(2)}`);
  }

  const lastX = PLOT_W.toFixed(2);
  return {
    rxLine: `M${rxPts.join('L')}`,
    rxArea: `M0,${PLOT_MID}L${rxPts.join('L')}L${lastX},${PLOT_MID}Z`,
    txLine: `M${txPts.join('L')}`,
    txArea: `M0,${PLOT_MID}L${txPts.join('L')}L${lastX},${PLOT_MID}Z`,
  };
}

function renderNetwork(net) {
  const rx = Number.isFinite(net.rxBps) ? net.rxBps : 0;
  const tx = Number.isFinite(net.txBps) ? net.txBps : 0;

  netHistory.push({ rx, tx });
  const limit = config.ui.historySamples;
  if (netHistory.length > limit) netHistory = netHistory.slice(-limit);

  const observed = netHistory.reduce(
    (max, s) => Math.max(max, s.rx, s.tx),
    NET_SCALE_FLOOR,
  );
  const peak = f.niceCeil(observed);

  const paths = buildPaths(netHistory, peak);
  el.netLineRx.setAttribute('d', paths.rxLine);
  el.netAreaRx.setAttribute('d', paths.rxArea);
  el.netLineTx.setAttribute('d', paths.txLine);
  el.netAreaTx.setAttribute('d', paths.txArea);

  const rxF = f.bytes(rx, { perSecond: true });
  const txF = f.bytes(tx, { perSecond: true });
  el.netRx.textContent = rxF.value;
  el.netRxUnit.textContent = rxF.unit;
  el.netTx.textContent = txF.value;
  el.netTxUnit.textContent = txF.unit;

  el.netIface.textContent = net.iface ?? '';
  el.netPeak.textContent = f.bytesInline(peak, { perSecond: true, digits: 0 });
}

/* ── now playing ───────────────────────────────────────────────── */

function renderMedia(media) {
  if (!media || !media.title) {
    el.mediaTitle.textContent = 'Nothing playing';
    el.mediaArtist.textContent = '';
    el.mediaAlbum.textContent = '';
    el.mediaApp.textContent = '';
    el.mediaState.textContent = '';
    el.mediaPos.textContent = f.DASH;
    el.mediaEnd.textContent = f.DASH;
    el.mediaFill.style.width = '0%';
    return;
  }

  el.mediaTitle.textContent = media.title;
  el.mediaArtist.textContent = media.artist ?? '';
  el.mediaAlbum.textContent = media.album ?? '';
  el.mediaApp.textContent = media.app ?? '';
  el.mediaState.textContent = media.playing ? 'PLAYING' : 'PAUSED';

  el.mediaPos.textContent = f.mmss(media.posSec);
  el.mediaEnd.textContent = f.mmss(media.endSec);
  el.mediaFill.style.width =
    media.endSec && media.posSec !== null
      ? `${Math.min(100, (media.posSec / media.endSec) * 100)}%`
      : '0%';
}

/* ── footer ────────────────────────────────────────────────────── */

const SOURCE_LABELS = {
  system: 'system',
  nvidia: 'nvidia-smi',
  lhm: 'lhm',
  media: 'media',
  net: 'net',
};

function renderSources(sources) {
  const frag = document.createDocumentFragment();
  for (const [key, label] of Object.entries(SOURCE_LABELS)) {
    const s = sources[key] ?? { ok: false, reason: 'unknown' };
    const node = document.createElement('span');
    node.className = `source ${s.ok ? 'source--ok' : 'source--off'}`;

    const dot = document.createElement('i');
    dot.className = 'source__dot';
    node.append(dot, document.createTextNode(label));

    if (!s.ok && s.reason) {
      const reason = document.createElement('span');
      reason.className = 'source__reason';
      reason.textContent = ` ${s.reason}`;
      node.append(reason);
    }
    frag.append(node);
  }
  el.sources.replaceChildren(frag);
}

function renderDisks(disks) {
  const frag = document.createDocumentFragment();
  for (const d of disks.slice(0, 3)) {
    const node = document.createElement('span');
    node.className = 'disk';

    const label = document.createElement('span');
    label.textContent = d.mount.replace(/\\$/, '');

    const bar = document.createElement('span');
    bar.className = 'disk__bar';
    const fill = document.createElement('i');
    fill.className = 'disk__fill';
    fill.style.width = `${Math.min(100, Math.max(0, d.pct))}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.textContent = f.pct(d.pct);

    node.append(label, bar, value);
    frag.append(node);
  }
  el.disks.replaceChildren(frag);
}

/* ── weather ───────────────────────────────────────────────────── */

let lastWeatherIcon = null;

function renderWeather(w) {
  // Hidden rather than blanked when unconfigured or offline, so an unset
  // option or a dropped connection costs no layout and leaves no empty frame.
  if (!w) {
    el.weather.hidden = true;
    return;
  }
  el.weather.hidden = false;

  if (w.icon !== lastWeatherIcon) {
    renderWeatherIcon(el.weatherIcon, w.icon);
    lastWeatherIcon = w.icon;
  }

  el.weatherTemp.textContent = f.num(w.tempC, 0);
  el.weatherUnit.textContent = `°${w.unit}`;
  // "Overcast 20°" reads better than a bare condition, and feels-like is the
  // number people actually want when it differs from the raw temperature.
  el.weatherLabel.textContent =
    Number.isFinite(w.feelsC) && Math.round(w.feelsC) !== Math.round(w.tempC)
      ? `${w.label} · feels ${f.num(w.feelsC, 0)}°`
      : w.label;
  el.weatherHigh.textContent = `${f.num(w.highC, 0)}°`;
  el.weatherLow.textContent = `${f.num(w.lowC, 0)}°`;
}

/* ── latency ───────────────────────────────────────────────────── */

// Thresholds in ms: anything under 60 is a good connection, over 150 is
// noticeable. Fixed rather than configurable — these are properties of human
// perception, not of the machine.
const PING_THRESHOLDS = { warn: 60, crit: 150 };

function renderPing(p) {
  if (!p) {
    el.ping.dataset.status = 'crit';
    el.pingValue.textContent = f.DASH;
    return;
  }
  el.ping.dataset.status = f.statusOf(p.ms, PING_THRESHOLDS);
  el.pingValue.textContent = `${f.num(p.ms, 0)} ms`;
}

/* ── drive temperatures ────────────────────────────────────────── */

function renderDrives(drives, thresholds) {
  const frag = document.createDocumentFragment();
  for (const d of drives.slice(0, 3)) {
    const node = document.createElement('span');
    node.className = 'drive';
    node.dataset.status = f.statusOf(d.tempC, thresholds);

    const label = document.createElement('span');
    label.className = 'micro';
    label.textContent = d.label;

    const temp = document.createElement('span');
    temp.className = 'drive__temp';
    temp.textContent = `${f.celsius(d.tempC)}°`;

    node.append(label, temp);
    frag.append(node);
  }
  el.drives.replaceChildren(frag);
}

/* ── ready lamp ────────────────────────────────────────────────── */

const LAMP_WORDS = { nominal: 'READY', warn: 'HEATING', crit: 'OVER TEMP' };

/** Worst of the two temperature readings drives the machine's ready lamp. */
function renderLamp(snapshot, thresholds) {
  const states = [
    f.statusOf(snapshot.cpu.tempC, thresholds.cpuTemp),
    f.statusOf(snapshot.gpu.tempC, thresholds.gpuTemp),
  ];
  const worst = states.includes('crit')
    ? 'crit'
    : states.includes('warn')
      ? 'warn'
      : 'nominal';
  el.lamp.dataset.status = worst;
  el.lampText.textContent = LAMP_WORDS[worst];
}

/* ── clock ─────────────────────────────────────────────────────── */

function renderClock() {
  const now = new Date();
  const h = config.ui.clock24h
    ? String(now.getHours()).padStart(2, '0')
    : String(now.getHours() % 12 || 12);
  el.clock.textContent = `${h}:${String(now.getMinutes()).padStart(2, '0')}`;
  el.clockSecs.textContent = config.ui.showSeconds
    ? String(now.getSeconds()).padStart(2, '0')
    : '';

  // Locale-formatted, so it reads naturally wherever the machine lives.
  el.date.textContent = now.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/* ── snapshot ──────────────────────────────────────────────────── */

/**
 * Draws one snapshot.
 *
 * Wrapped by `renderSafe` below: this function touches a lot of elements, and
 * a single missing node used to throw partway through and silently leave every
 * panel after that point frozen or blank. On a display nobody interacts with,
 * that failure is invisible - the numbers just quietly stop being true.
 */
function render(s) {
  lastSnapshotAt = Date.now();
  el.hud.classList.remove('hud--stale');

  const t = config.thresholds;

  el.host.textContent = s.sys.host ?? '—';
  el.uptime.textContent = f.duration(s.sys.uptimeSec);

  renderLamp(s, t);
  renderWeather(s.weather);

  renderGauge(
    el.cpu,
    {
      temp: s.cpu.tempC,
      name: s.cpu.brand,
      load: s.cpu.load,
      clock: s.cpu.clockMHz,
      power: s.cpu.powerW,
      fan: f.rpm(s.cpu.fanRpm),
    },
    t.cpuTemp,
  );

  renderGauge(
    el.gpu,
    {
      temp: s.gpu.tempC,
      name: s.gpu.name,
      load: s.gpu.load,
      clock: s.gpu.clockMHz,
      power: s.gpu.powerW,
      fan: Number.isFinite(s.gpu.fanPct) ? f.pct(s.gpu.fanPct) : f.DASH,
    },
    t.gpuTemp,
  );

  if (config.ui.panels.reservoir) {
    renderTank('mem', {
      pct: s.mem.pct,
      abs: f.memPair(s.mem.usedBytes, s.mem.totalBytes),
      thresholds: t.memory,
    });

    const vramPct =
      Number.isFinite(s.gpu.memUsedMB) && s.gpu.memTotalMB
        ? (s.gpu.memUsedMB / s.gpu.memTotalMB) * 100
        : null;
    renderTank('vram', {
      pct: vramPct,
      abs: f.mbPair(s.gpu.memUsedMB, s.gpu.memTotalMB),
      thresholds: t.memory,
    });
  }

  if (config.ui.panels.cores) renderCores(s.cpu.coreLoads, t.load);
  if (config.ui.panels.network) {
    renderNetwork(s.net);
    renderPing(s.ping);
  }
  if (config.ui.panels.media) renderMedia(s.media);
  if (config.ui.panels.footer) {
    renderSources(s.sources);
    renderDrives(s.drives ?? [], t.driveTemp);
    renderDisks(s.disks ?? []);
  }
}

let renderErrors = 0;

/**
 * Never let one broken field take the rest of the panel down with it. Logs
 * loudly to devtools (`npm run dev`) so the failure is still findable.
 */
function renderSafe(snapshot) {
  try {
    render(snapshot);
  } catch (err) {
    renderErrors += 1;
    // Only the first few, or a genuinely broken build would spam the console
    // once per second forever.
    if (renderErrors <= 5) {
      console.error(`[hud] render failed (${renderErrors})`, err);
    }
  }
}

/* ── boot ──────────────────────────────────────────────────────── */

function applyUiConfig() {
  document.body.dataset.theme = config.theme || 'espresso';
  document.body.dataset.glow = config.ui.glow ? 'on' : 'off';
  document.body.dataset.scanlines = config.ui.scanlines ? 'on' : 'off';
  for (const [panel, visible] of Object.entries(config.ui.panels)) {
    el.hud.dataset[`hidden${panel[0].toUpperCase()}${panel.slice(1)}`] = String(
      !visible,
    );
  }
}

async function boot() {
  config = await window.screenBuddy.getConfig();
  applyUiConfig();

  renderClock();
  setInterval(renderClock, 250);

  // A dead feed dims the panel instead of freezing on stale numbers that still
  // look live. No skeleton, no layout jump.
  setInterval(() => {
    if (lastSnapshotAt && Date.now() - lastSnapshotAt > STALE_AFTER_MS) {
      el.hud.classList.add('hud--stale');
    }
  }, 1000);

  window.screenBuddy.onSnapshot(renderSafe);

  const latest = await window.screenBuddy.getLatest();
  if (latest) renderSafe(latest);
}

boot().catch((err) => {
  console.error('[hud] boot failed', err);
});
