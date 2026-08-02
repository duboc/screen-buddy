'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PAGES,
  PANEL_IDS,
  THEME_TOKEN_KEYS,
  FONT_STACKS,
  WRITABLE_PATHS,
  FIELD_BY_PATH,
} = require('./schema');

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
    // 'smallest' needs no configuration and is right on almost every setup:
    // the little sensor panel is the lowest-resolution display attached.
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
      // null = auto-pick, which is only a guess on boards that label headers
      // generically ("Fan #1".."Fan #7"). Pin an exact sensor name to be sure.
      fanSensor: null,
    },
    network: { interface: null },
    nowPlaying: { enabled: true, intervalMs: 2000 },
    // Coordinates are never guessed from the IP address: that would send the
    // user's location to a third party on every start. Null means "off".
    weather: {
      enabled: true,
      latitude: null,
      longitude: null,
      units: 'metric',
      refreshMinutes: 15,
      timeoutMs: 8000,
    },
    ping: {
      enabled: true,
      host: '1.1.1.1',
      port: 443,
      intervalMs: 10000,
      timeoutMs: 3000,
      samples: 3,
    },
    // Read through a PowerShell helper rather than systeminformation, whose
    // processes() call costs ~900ms of CPU every time and does not cache.
    processes: { enabled: true, intervalMs: 3000, top: 6 },
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
      // The panels that only exist because rotation made room for them. On
      // means 'may appear on a page', not 'is on screen' — with rotation off
      // the classic layout has no room for them and does not place them.
      processes: true,
      storage: true,
      trends: true,
      forecast: true,
      pressure: true,
    },
    // Type is a first-class setting, not a theme detail: this panel is read
    // from across a desk, and the right size depends on the desk.
    typography: {
      // null means "whatever the theme picked", so a base theme change still
      // brings its own face along until the user overrides one deliberately.
      family: null,
      numerals: null,
      scale: 1.0,
      numeralWeight: 300,
      letterSpacing: 0.14,
      tabularNums: true,
    },
    // Layered over the base theme's custom properties. Keeping them separate
    // from `theme` means switching base themes does not discard the edits.
    themeOverrides: {},
    // How much past the trend panel keeps. Costs nothing to collect — these
    // are the readings the panel already takes every second.
    history: { windowMinutes: 15, points: 60 },
    rotation: {
      // Off by default. Rotation trades instant recognition for legibility,
      // and that is only a good trade on a panel too small to hold everything.
      enabled: false,
      dwellSec: 20,
      transition: 'fade',
      transitionMs: 600,
      // A critical reading pulls the gauges page forward and holds it there,
      // so an alarm is never hidden on a page nobody is looking at.
      alertOverride: 'crit',
      indicator: true,
      pages: DEFAULT_PAGES,
    },
  },
  thresholds: {
    cpuTemp: { warn: 75, crit: 90 },
    gpuTemp: { warn: 72, crit: 85 },
    // NVMe drives idle warm and throttle around 70; these are drive numbers,
    // not CPU ones.
    driveTemp: { warn: 60, crit: 72 },
    load: { warn: 70, crit: 90 },
    memory: { warn: 75, crit: 90 },
  },
  power: {
    preventDisplaySleep: true,
  },
  admin: {
    // A loopback-only config editor. It writes config.json and nothing else —
    // it runs no commands and reads no file outside the admin directory.
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
    // Only consulted when host is not loopback, where it is mandatory.
    token: null,
  },
};

/** Lazy, because restore.js reads DEFAULTS back out of this module. */
const restorePoints = () => require('./restore');

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Drops the `$comment` documentation keys the JSON files carry. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$')) continue;
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
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  if (example) cfg = merge(cfg, stripComments(example));
  const user = readJson(USER_CONFIG);
  if (user) cfg = merge(cfg, stripComments(user));
  return cfg;
}

/* ── writing ─────────────────────────────────────────────────────
   The admin edits a running config, but config.json is a hand-editable file
   full of `$comment` documentation. Writing the merged in-memory config back
   would flatten all of that into a wall of anonymous keys, so instead the patch
   is merged into the RAW user file — comments and all — and only the keys the
   user actually changed ever appear there. A config.json stays a short diff
   against the defaults rather than growing into a full dump. */

/** Deep-merge a patch into a raw JSON tree, leaving `$comment` keys alone. */
function mergeRaw(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) ? mergeRaw(out[k], v) : v;
  }
  return out;
}

/**
 * Write via a temp file in the same directory, then rename. A rename is atomic
 * on NTFS, so a crash mid-write can never leave a half-written config.json —
 * which the app would refuse to parse on the next start.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Merge `patch` into config.json and return the freshly loaded config.
 * Keeps one backup of the previous file, so a bad edit made from the admin is
 * always one file-copy away from being undone.
 */
function saveUserPatch(patch) {
  const raw = readJson(USER_CONFIG) ?? {};
  const next = mergeRaw(raw, patch);

  // A cleared theme override arrives as an explicit null, because the renderer
  // has to be told to drop it rather than left to infer it from an absent key.
  // On disk that distinction is meaningless, so the key just goes.
  const tokens = next.ui?.themeOverrides;
  if (tokens) {
    for (const [k, v] of Object.entries(tokens)) {
      if (v === null) delete tokens[k];
    }
  }

  // A restore point per write, rather than one rolling .bak that the very next
  // save overwrites — a net that only ever catches the most recent mistake is
  // not much of a net. Required rather than best-effort: if the snapshot cannot
  // be taken the write does not happen, because its whole purpose is that the
  // previous state survives this one.
  restorePoints().snapshot({ kind: 'auto', label: 'before save' });

  writeAtomic(USER_CONFIG, `${JSON.stringify(next, null, 2)}\n`);
  return load();
}

/* ── validation ──────────────────────────────────────────────────
   The admin is reachable over HTTP, so nothing it sends is trusted. A patch is
   rebuilt key by key from the schema rather than merged as given: a path the
   schema does not describe is dropped, and every value is coerced and clamped
   to the type the field declares. */

const FONT_IDS = new Set(FONT_STACKS.map((f) => f.id));
const PANEL_SET = new Set(PANEL_IDS);

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let node = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(node[k])) node[k] = {};
    node = node[k];
  }
  node[keys.at(-1)] = value;
}

const clamp = (n, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, n));

/** Rejects anything that could break out of a CSS declaration. */
function cleanPaint(value) {
  const s = String(value).trim();
  if (!s || s.length > 400) return null;
  // No braces, semicolons, at-rules, comments or url() — a token is a value,
  // not a place to smuggle in a rule. `url()` in particular would be a way to
  // make the HUD fetch a remote resource despite its CSP.
  if (/[{};<>]|\/\*|@import|url\s*\(|expression\s*\(/i.test(s)) return null;
  return s;
}

function coerceField(field, value) {
  if (value === null || value === '') {
    return field.nullable || field.allowInherit ? null : undefined;
  }

  switch (field.type) {
    case 'boolean':
      return Boolean(value);

    case 'number':
    case 'range': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return clamp(n, field.min, field.max);
    }

    case 'select': {
      const s = String(value);
      return field.options.some((o) => o.id === s) ? s : undefined;
    }

    case 'font': {
      const s = String(value);
      // Either a known preset or a hand-written stack, which still has to be a
      // safe CSS value.
      if (FONT_IDS.has(s)) return s;
      return cleanPaint(s) ?? undefined;
    }

    case 'text':
      return String(value).slice(0, 500);

    case 'pages':
      return cleanPages(value);

    default:
      return undefined;
  }
}

/** Rotation pages, rebuilt from scratch: unknown panels and ids are dropped. */
function cleanPages(value) {
  if (!Array.isArray(value)) return undefined;
  const pages = [];
  for (const raw of value.slice(0, 12)) {
    if (!isPlainObject(raw)) continue;
    const panels = Array.isArray(raw.panels)
      ? raw.panels.filter((p) => PANEL_SET.has(p))
      : [];
    if (!panels.length) continue;
    pages.push({
      id: String(raw.id ?? `page${pages.length + 1}`).slice(0, 40),
      title: String(raw.title ?? '').slice(0, 40),
      panels,
      when: ['media', 'network'].includes(raw.when) ? raw.when : '',
    });
  }
  return pages.length ? pages : undefined;
}

/** Free-form keys, so it gets its own allowlist rather than a schema path. */
function cleanThemeOverrides(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!THEME_TOKEN_KEYS.has(k)) continue;
    if (v === null) {
      out[k] = null; // an explicit null clears the override
      continue;
    }
    const clean = cleanPaint(v);
    if (clean !== null) out[k] = clean;
  }
  return out;
}

/**
 * Turn an arbitrary object from the admin into a patch that is safe to merge.
 * Returns { patch, rejected } — rejected paths are reported back so a typo in a
 * hand-edited request is visible rather than silently ignored.
 */
function sanitizePatch(input) {
  const patch = {};
  const rejected = [];
  if (!isPlainObject(input)) return { patch, rejected: ['(not an object)'] };

  for (const p of WRITABLE_PATHS) {
    const value = getPath(input, p);
    if (value === undefined) continue;
    const coerced = coerceField(FIELD_BY_PATH.get(p), value);
    if (coerced === undefined) {
      rejected.push(p);
      continue;
    }
    setPath(patch, p, coerced);
  }

  if (input.ui && 'themeOverrides' in input.ui) {
    const tokens = cleanThemeOverrides(input.ui.themeOverrides);
    if (tokens) setPath(patch, 'ui.themeOverrides', tokens);
    else rejected.push('ui.themeOverrides');
  }

  return { patch, rejected };
}

/**
 * Turn the typography font *ids* stored in config.json into the CSS stacks the
 * renderer needs. Resolving here rather than in the renderer keeps the font
 * table in exactly one place, and keeps config.json readable — "bahnschrift"
 * rather than a quoted five-family fallback chain. The resolved fields are
 * computed on every read and never written back to disk.
 */
function resolveTypography(cfg) {
  const type = cfg.ui?.typography;
  if (!type) return cfg;

  const stackFor = (value) => {
    if (!value) return null;
    const preset = FONT_STACKS.find((f) => f.id === value);
    if (preset) return preset.stack;
    // Anything unrecognised is treated as a hand-written stack, but still has
    // to survive the same check a token does before it reaches a stylesheet.
    return cleanPaint(value);
  };

  return {
    ...cfg,
    ui: {
      ...cfg.ui,
      typography: {
        ...type,
        resolvedFamily: stackFor(type.family),
        resolvedNumerals: stackFor(type.numerals),
      },
    },
  };
}

module.exports = {
  load,
  saveUserPatch,
  sanitizePatch,
  resolveTypography,
  merge,
  DEFAULTS,
  paths: { USER_CONFIG, EXAMPLE_CONFIG, ROOT },
};
