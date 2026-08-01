'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const USER_CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE_CONFIG = path.join(ROOT, 'config.example.json');

/**
 * Defaults live here rather than in config.example.json so the app still runs
 * correctly if the user deletes or mangles both JSON files. The example file is
 * documentation; this object is the contract.
 */
const DEFAULTS = {
  display: {
    strategy: 'smallest',
    bounds: { x: 0, y: 0 },
    index: 0,
    fallback: 'primary',
  },
  window: {
    frame: false,
    alwaysOnTop: true,
    alwaysOnTopLevel: 'screen-saver',
    skipTaskbar: true,
    clickThrough: true,
    focusable: false,
    fillDisplay: true,
    opacity: 1.0,
  },
  polling: {
    fastMs: 1000,
    slowMs: 5000,
  },
  sensors: {
    nvidiaSmi: { enabled: true, path: 'nvidia-smi' },
    libreHardwareMonitor: {
      enabled: true,
      url: 'http://127.0.0.1:8085/data.json',
      timeoutMs: 1500,
    },
    network: { interface: null },
    nowPlaying: { enabled: true, intervalMs: 2000 },
  },
  theme: 'espresso',
  ui: {
    showSeconds: true,
    clock24h: true,
    scanlines: false,
    glow: true,
    historySamples: 90,
    panels: {
      gauges: true,
      reservoir: true,
      media: true,
      network: true,
      cores: true,
      footer: true,
    },
  },
  thresholds: {
    cpuTemp: { warn: 75, crit: 90 },
    gpuTemp: { warn: 72, crit: 85 },
    load: { warn: 70, crit: 90 },
    memory: { warn: 75, crit: 90 },
  },
  power: {
    preventDisplaySleep: true,
  },
};

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Drops the `$comment` documentation keys the JSON files carry. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '$comment') continue;
    out[k] = stripComments(v);
  }
  return out;
}

/** Deep-merge, with `override` winning. Arrays replace rather than concat. */
function merge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(base?.[k]) ? merge(base[k], v) : stripComments(v);
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return stripComments(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.warn(`[config] ignoring ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

/**
 * Precedence: DEFAULTS < config.example.json < config.json.
 * Reading the example file too means a fresh clone with no config.json still
 * picks up the shipped display coordinates rather than guessing.
 */
function load() {
  let cfg = DEFAULTS;
  const example = readJson(EXAMPLE_CONFIG);
  if (example) cfg = merge(cfg, example);
  const user = readJson(USER_CONFIG);
  if (user) cfg = merge(cfg, user);
  return cfg;
}

module.exports = { load, DEFAULTS, paths: { USER_CONFIG, EXAMPLE_CONFIG, ROOT } };
