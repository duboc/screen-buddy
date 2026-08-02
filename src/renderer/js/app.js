import * as f from './format.js';
import { buildDialFace, needleAngle } from './dial.js';
import { renderWeatherIcon } from './weather-icons.js';
import { createDeck } from './deck.js';
import { applyTheme } from './theme.js';
import { linePath, areaPath, domainOf } from './sparkline.js';

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
  deck: document.getElementById('deck'),
  deckDots: document.getElementById('deck-dots'),
  panelStore: document.getElementById('panel-store'),
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
  procsTotal: document.getElementById('procs-total'),
  procsCpu: document.getElementById('procs-cpu'),
  procsMem: document.getElementById('procs-mem'),
  storeSub: document.getElementById('store-sub'),
  storeRead: document.getElementById('store-read'),
  storeReadUnit: document.getElementById('store-read-unit'),
  storeWrite: document.getElementById('store-write'),
  storeWriteUnit: document.getElementById('store-write-unit'),
  storeAreaR: document.getElementById('store-area-r'),
  storeLineR: document.getElementById('store-line-r'),
  storeAreaW: document.getElementById('store-area-w'),
  storeLineW: document.getElementById('store-line-w'),
  storeDrives: document.getElementById('store-drives'),
  trendsSpan: document.getElementById('trends-span'),
  trendsRows: document.getElementById('trends-rows'),
  fcSub: document.getElementById('fc-sub'),
  fcHours: document.getElementById('fc-hours'),
  fcDays: document.getElementById('fc-days'),
  pressSub: document.getElementById('press-sub'),
  pressFans: document.getElementById('press-fans'),
  pressMobo: document.getElementById('press-mobo'),
  pressVolts: document.getElementById('press-volts'),
  pressGpuPwr: document.getElementById('press-gpupwr'),
  pressSwap: document.getElementById('press-swap'),
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
let lastSnapshot = null;
const dialsBuilt = new WeakSet();

const deck = createDeck({
  deck: el.deck,
  dots: el.deckDots,
  store: el.panelStore,
});

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

/* ── processes ─────────────────────────────────────────────────── */

/**
 * One ranked list. Bars are scaled to the largest entry in THIS list rather
 * than to an absolute maximum: the question being asked is "what is the biggest
 * thing running", and against a fixed 0–100% axis five processes at 1% are five
 * empty rows.
 */
function renderProcList(node, rows, format) {
  const peak = rows.reduce((m, r) => Math.max(m, r.value ?? 0), 0) || 1;
  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'proc';

    const name = document.createElement('span');
    name.className = 'proc__name';
    name.textContent = row.name;
    // Grouped processes say so, because "chrome 3.6 GB" invites the question
    // and "chrome ×24" answers it.
    if (row.instances > 1) {
      const mult = document.createElement('i');
      mult.textContent = `×${row.instances}`;
      name.append(mult);
    }

    const bar = document.createElement('span');
    bar.className = 'proc__bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, ((row.value ?? 0) / peak) * 100)}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.className = 'proc__val';
    value.textContent = format(row.value);

    li.append(name, bar, value);
    frag.append(li);
  }
  node.replaceChildren(frag);
}

function renderProcesses(procs) {
  if (!procs) {
    el.procsTotal.textContent = '';
    el.procsCpu.replaceChildren();
    el.procsMem.replaceChildren();
    return;
  }
  el.procsTotal.textContent = `${procs.total} running`;

  renderProcList(
    el.procsCpu,
    procs.byCpu.map((p) => ({ ...p, value: p.cpuPct })),
    (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : f.DASH),
  );
  renderProcList(
    el.procsMem,
    procs.byMem.map((p) => ({ ...p, value: p.memBytes })),
    (v) => f.bytesInline(v),
  );
}

/* ── storage ───────────────────────────────────────────────────── */

let ioHistory = [];

function renderStorage(storage) {
  const read = storage.reduce((a, d) => a + (d.readBps ?? 0), 0);
  const write = storage.reduce((a, d) => a + (d.writeBps ?? 0), 0);

  ioHistory.push({ read, write });
  const limit = config.ui.historySamples;
  if (ioHistory.length > limit) ioHistory = ioHistory.slice(-limit);

  // Same encoding as the network plot: read above the axis, write below, on one
  // shared scale, so position carries identity and no second hue is needed.
  const peak = f.niceCeil(
    ioHistory.reduce((m, x) => Math.max(m, x.read, x.write), 1024 * 1024),
  );
  const half = { width: PLOT_W, height: PLOT_MID, min: 0, max: peak, pad: 2 };
  const reads = ioHistory.map((x) => x.read);
  const writes = ioHistory.map((x) => x.write);

  el.storeLineR.setAttribute('d', linePath(reads, half));
  el.storeAreaR.setAttribute('d', areaPath(reads, half));
  // Writes are drawn into the same half-height box and flipped underneath by
  // CSS, which is exact and avoids computing a mirrored coordinate set.
  el.storeLineW.setAttribute('d', linePath(writes, half));
  el.storeAreaW.setAttribute('d', areaPath(writes, half));

  const r = f.bytes(read, { perSecond: true });
  const w = f.bytes(write, { perSecond: true });
  el.storeRead.textContent = r.value;
  el.storeReadUnit.textContent = r.unit;
  el.storeWrite.textContent = w.value;
  el.storeWriteUnit.textContent = w.unit;
  el.storeSub.textContent = storage.length
    ? `${storage.length} drive${storage.length > 1 ? 's' : ''}`
    : 'needs LibreHardwareMonitor';

  const frag = document.createDocumentFragment();
  for (const d of storage.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'drivecard';
    row.dataset.status = f.statusOf(d.tempC, config.thresholds.driveTemp);

    const label = document.createElement('span');
    label.className = 'drivecard__label';
    label.textContent = d.label;

    const temp = document.createElement('span');
    temp.className = 'drivecard__temp';
    temp.textContent = `${f.celsius(d.tempC)}°`;

    const bar = document.createElement('span');
    bar.className = 'drivecard__bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, Math.max(0, d.usedPct ?? 0))}%`;
    bar.append(fill);

    const free = document.createElement('span');
    free.className = 'drivecard__free';
    free.textContent = Number.isFinite(d.freeBytes)
      ? `${f.bytesInline(d.freeBytes)} free`
      : f.DASH;

    // Endurance is the most actionable thing a drive reports and is invisible
    // everywhere else on this panel. Shown only once it has started falling —
    // a permanent "LIFE 100%" is noise that trains you to ignore the field.
    const life = document.createElement('span');
    life.className = 'drivecard__life';
    life.textContent =
      Number.isFinite(d.lifePct) && d.lifePct < 100 ? `LIFE ${f.pct(d.lifePct)}` : '';

    row.append(label, temp, bar, free, life);
    frag.append(row);
  }
  el.storeDrives.replaceChildren(frag);
}

/* ── trends ────────────────────────────────────────────────────── */

const TREND_ROWS = [
  { key: 'cpuTemp', label: 'BOILER', unit: '°', threshold: 'cpuTemp', floor: 10 },
  { key: 'gpuTemp', label: 'GROUP', unit: '°', threshold: 'gpuTemp', floor: 10 },
  { key: 'cpuLoad', label: 'LOAD', unit: '%', threshold: 'load', floor: 20 },
  { key: 'memPct', label: 'RAM', unit: '%', threshold: 'memory', floor: 10 },
];

const SPARK_W = 300;
const SPARK_H = 34;
const SVG_NS = 'http://www.w3.org/2000/svg';

function renderTrends(history, thresholds) {
  if (!history) {
    el.trendsRows.replaceChildren();
    el.trendsSpan.textContent = '';
    return;
  }

  el.trendsSpan.textContent = `last ${f.duration(history.spanSec)}`;
  const frag = document.createDocumentFragment();

  for (const spec of TREND_ROWS) {
    const values = history.series[spec.key] ?? [];
    const now = [...values].reverse().find((v) => Number.isFinite(v)) ?? null;
    const t = thresholds[spec.threshold] ?? {};

    const row = document.createElement('div');
    row.className = 'trend';
    row.dataset.status = f.statusOf(now, t);

    const label = document.createElement('span');
    label.className = 'micro trend__label';
    label.textContent = spec.label;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'spark trend__plot');
    svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const domain = domainOf(values, { floor: spec.floor });
    const opts = { width: SPARK_W, height: SPARK_H, ...domain, pad: 2 };

    // The warn line is drawn only when it actually falls inside the visible
    // range, so it marks a threshold being approached rather than sitting
    // uselessly pinned to the top edge of every idle graph.
    if (Number.isFinite(t.warn) && t.warn > domain.min && t.warn < domain.max) {
      const usable = SPARK_H - 4;
      const y = 2 + usable - ((t.warn - domain.min) / (domain.max - domain.min)) * usable;
      const rule = document.createElementNS(SVG_NS, 'line');
      rule.setAttribute('class', 'trend__warn');
      rule.setAttribute('x1', '0');
      rule.setAttribute('x2', String(SPARK_W));
      rule.setAttribute('y1', y.toFixed(2));
      rule.setAttribute('y2', y.toFixed(2));
      svg.append(rule);
    }

    const area = document.createElementNS(SVG_NS, 'path');
    area.setAttribute('class', 'trend__area');
    area.setAttribute('d', areaPath(values, opts));
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', 'trend__line');
    line.setAttribute('d', linePath(values, opts));
    svg.append(area, line);

    const nowEl = document.createElement('span');
    nowEl.className = 'trend__now';
    nowEl.textContent = Number.isFinite(now) ? `${f.num(now, 0)}${spec.unit}` : f.DASH;

    const peak = history.peaks[spec.key];
    const peakEl = document.createElement('span');
    peakEl.className = 'trend__peak';
    peakEl.textContent = Number.isFinite(peak?.value)
      ? `pk ${f.num(peak.value, 0)}${spec.unit}`
      : '';

    // Time spent over the warn line. This is what turns "it got hot once" into
    // "it has been hot for nine minutes", which are different problems.
    const over = history.aboveSec[spec.key];
    const overSec = (over?.warn ?? 0) + (over?.crit ?? 0);
    const overEl = document.createElement('span');
    overEl.className = 'trend__over';
    overEl.textContent = overSec > 0 ? `▲ ${f.duration(overSec)}` : '';

    row.append(label, svg, nowEl, peakEl, overEl);
    frag.append(row);
  }
  el.trendsRows.replaceChildren(frag);
}

/* ── forecast ──────────────────────────────────────────────────── */

function renderForecast(w) {
  if (!w || !w.hourly?.length) {
    el.fcHours.replaceChildren();
    el.fcDays.replaceChildren();
    el.fcSub.textContent = 'no forecast';
    return;
  }
  el.fcSub.textContent = `${w.label} now`;

  const hours = document.createDocumentFragment();
  for (const h of w.hourly) {
    const col = document.createElement('div');
    col.className = 'fchour';

    const hour = document.createElement('span');
    hour.className = 'fchour__h';
    hour.textContent = String(h.hour).padStart(2, '0');

    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('class', 'fchour__icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    renderWeatherIcon(icon, h.icon);

    const temp = document.createElement('span');
    temp.className = 'fchour__t';
    temp.textContent = `${f.num(h.tempC, 0)}°`;

    // Shown only once there is a real chance of rain. A row of "0%" under every
    // hour is twelve columns of ink saying nothing.
    const pop = document.createElement('span');
    pop.className = 'fchour__p';
    pop.textContent = Number.isFinite(h.pop) && h.pop >= 10 ? `${Math.round(h.pop)}%` : '';

    col.append(hour, icon, temp, pop);
    hours.append(col);
  }
  el.fcHours.replaceChildren(hours);

  const days = document.createDocumentFragment();
  for (const [i, d] of (w.days ?? []).entries()) {
    const cell = document.createElement('div');
    cell.className = 'fcday';

    const name = document.createElement('span');
    name.className = 'micro';
    name.textContent =
      i === 0
        ? 'TODAY'
        : new Date(d.at).toLocaleDateString(undefined, { weekday: 'short' });

    const hi = document.createElement('span');
    hi.className = 'fcday__hi';
    hi.textContent = `${f.num(d.highC, 0)}°`;

    const sep = document.createElement('span');
    sep.className = 'fcday__sep';
    sep.textContent = '/';

    const lo = document.createElement('span');
    lo.className = 'fcday__lo';
    lo.textContent = `${f.num(d.lowC, 0)}°`;

    cell.append(name, hi, sep, lo);
    days.append(cell);
  }
  el.fcDays.replaceChildren(days);
}

/* ── pressure ──────────────────────────────────────────────────── */

function renderPressure(s) {
  const fans = (s.cpu.fans ?? []).filter((fan) => Number.isFinite(fan.rpm));
  el.pressSub.textContent = fans.length ? `${fans.length} headers` : 'needs LibreHardwareMonitor';

  // Scaled to the fastest header rather than an assumed ceiling: case fans and
  // a pump top out at very different speeds.
  const peak = Math.max(1200, ...fans.map((fan) => fan.rpm));
  const frag = document.createDocumentFragment();

  for (const fan of fans.slice(0, 10)) {
    const row = document.createElement('div');
    // A header wired to nothing reads 0 and always will. Dimming it keeps the
    // list honest without pretending the header is not there.
    row.className = fan.rpm > 0 ? 'fanrow' : 'fanrow fanrow--idle';

    const name = document.createElement('span');
    name.className = 'fanrow__name';
    name.textContent = fan.name;

    const bar = document.createElement('span');
    bar.className = 'fanrow__bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, (fan.rpm / peak) * 100)}%`;
    bar.append(fill);

    const value = document.createElement('span');
    value.className = 'fanrow__val';
    value.textContent = fan.rpm > 0 ? String(Math.round(fan.rpm)) : '—';

    row.append(name, bar, value);
    frag.append(row);
  }
  el.pressFans.replaceChildren(frag);

  el.pressMobo.textContent = Number.isFinite(s.sys.moboTempC)
    ? `${f.celsius(s.sys.moboTempC)}°`
    : f.DASH;
  el.pressVolts.textContent = Number.isFinite(s.cpu.volts)
    ? `${s.cpu.volts.toFixed(3)} V`
    : f.DASH;
  // Against the limit, because 210 W means nothing without knowing whether the
  // card is allowed 220 or 450.
  el.pressGpuPwr.textContent =
    Number.isFinite(s.gpu.powerW) && Number.isFinite(s.gpu.powerLimitW)
      ? `${Math.round(s.gpu.powerW)}/${Math.round(s.gpu.powerLimitW)} W`
      : f.watts(s.gpu.powerW);
  el.pressSwap.textContent = Number.isFinite(s.mem.swapUsedBytes)
    ? f.memPair(s.mem.swapUsedBytes, s.mem.swapTotalBytes)
    : f.DASH;
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
  return worst;
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

  // The lamp's verdict is also what decides whether the deck parks itself on
  // the gauges: an alarm should never be sitting on a page nobody is looking at.
  deck.setAlert(renderLamp(s, t));
  deck.setAvailability({
    media: Boolean(s.media?.title),
    // "Busy" rather than "connected" — a page that appears for background
    // chatter would be on screen permanently and stop meaning anything.
    network: (s.net?.rxBps ?? 0) + (s.net?.txBps ?? 0) > 64 * 1024,
  });

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
  if (config.ui.panels.processes) renderProcesses(s.processes);
  if (config.ui.panels.storage) renderStorage(s.storage ?? []);
  if (config.ui.panels.trends) renderTrends(s.history, t);
  if (config.ui.panels.forecast) renderForecast(s.weather);
  if (config.ui.panels.pressure) renderPressure(s);
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

/**
 * Everything the settings editor can change, applied without a reload.
 *
 * Panel visibility is handled by the deck rather than by collapsing elements
 * with CSS: a hidden panel is simply never placed on a page, which means the
 * remaining ones genuinely get its room instead of leaving a gap where it was.
 */
function applyConfig(next) {
  config = next;
  applyTheme(config);
  deck.configure(config);
  renderClock();

  if (lastSnapshot) {
    // A config change can arrive between snapshots, so redraw from the last one
    // rather than leaving the new layout empty until the next tick — without
    // letting that redraw pass for fresh data and reset the staleness clock.
    const at = lastSnapshotAt;
    renderSafe(lastSnapshot);
    lastSnapshotAt = at;
  }
}

function onSnapshot(snapshot) {
  lastSnapshot = snapshot;
  renderSafe(snapshot);
}

async function boot() {
  applyConfig(await window.screenBuddy.getConfig());

  setInterval(renderClock, 250);

  // A dead feed dims the panel instead of freezing on stale numbers that still
  // look live. No skeleton, no layout jump.
  setInterval(() => {
    if (lastSnapshotAt && Date.now() - lastSnapshotAt > STALE_AFTER_MS) {
      el.hud.classList.add('hud--stale');
    }
  }, 1000);

  window.screenBuddy.onSnapshot(onSnapshot);

  // Pushed by the settings editor. The panel is meant to be tuned while you
  // watch it, so a change lands on the next frame rather than on a restart.
  window.screenBuddy.onConfigChanged(applyConfig);

  const latest = await window.screenBuddy.getLatest();
  if (latest) onSnapshot(latest);
}

boot().catch((err) => {
  console.error('[hud] boot failed', err);
});
