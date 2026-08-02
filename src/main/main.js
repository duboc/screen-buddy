'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  shell,
  powerSaveBlocker,
  nativeImage,
  protocol,
  net,
} = require('electron');

const configLoader = require('./config');
const { pickDisplay, describe } = require('./display');
const { SensorHub } = require('./sensors');
const { TRAY_ICON_DATA_URL } = require('./tray-icon');
const { AdminServer } = require('./admin-server');
const restorePoints = require('./restore');

const argv = new Set(process.argv.slice(1));
const DEV = argv.has('--dev');
const WINDOWED = argv.has('--windowed');

let config = configLoader.load();

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'app://hud';

/**
 * The renderer is served over a custom scheme rather than loaded from disk with
 * loadFile. Two reasons, both hard requirements:
 *   1. Chromium blocks ES module imports from file:// (opaque origin, CORS), so
 *      app.js could not import format.js.
 *   2. A CSP of `script-src 'self'` is meaningless for a file:// origin. Under
 *      app://hud it means exactly what it looks like.
 * Must be registered before the app is ready.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const target = path.resolve(RENDERER_ROOT, rel);

    // Refuse anything that escapes the renderer directory.
    if (target !== RENDERER_ROOT && !target.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

let win = null;
let tray = null;
let hub = null;
let admin = null;
let blockerId = null;
let clickThrough = config.window.clickThrough && !WINDOWED;
let placementTimer = null;

/**
 * An unsaved patch from the admin's live preview. Kept separate from `config`
 * so that "revert" is just dropping it, and so a preview can never be written
 * to disk by some later save that happens to run while it is active.
 */
let previewPatch = null;

/** What the HUD should actually be drawing right now. */
const effectiveConfig = () =>
  configLoader.resolveTypography(
    previewPatch ? configLoader.merge(config, previewPatch) : config,
  );

// A single instance only — two HUDs stacked on the same monitor is never wanted
// and the second one silently steals the always-on-top slot.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) applyPlacement();
  });
}

function createWindow() {
  const { display, strategy, fellBack } = pickDisplay(config);
  if (fellBack) {
    console.warn(
      `[display] strategy "${config.display.strategy}" matched nothing; fell back to "${strategy}"`,
    );
  }
  console.log(`[display] using ${describe(display)}`);

  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    // Windowed dev mode gets a normal, movable, focusable window so devtools
    // and interaction work; everything else is HUD mode.
    x: WINDOWED ? undefined : x,
    y: WINDOWED ? undefined : y,
    width: WINDOWED ? 1024 : width,
    height: WINDOWED ? 600 : height,
    frame: WINDOWED ? true : config.window.frame,
    transparent: false,
    backgroundColor: '#04070d',
    resizable: WINDOWED,
    movable: WINDOWED,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: WINDOWED ? true : config.window.focusable,
    skipTaskbar: WINDOWED ? false : config.window.skipTaskbar,
    alwaysOnTop: WINDOWED ? false : config.window.alwaysOnTop,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    title: 'screen-buddy',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  if (!WINDOWED) {
    if (config.window.alwaysOnTop) {
      // "screen-saver" is the highest level Electron offers and is what keeps
      // the panel above the taskbar and above other topmost windows.
      win.setAlwaysOnTop(true, config.window.alwaysOnTopLevel || 'screen-saver');
    }
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    applyClickThrough(clickThrough);
    if (config.window.opacity < 1) win.setOpacity(config.window.opacity);
  }

  win.loadURL(`${APP_ORIGIN}/index.html`);

  win.once('ready-to-show', () => {
    win.showInactive(); // showInactive, not show — never steal focus on launch
    if (!WINDOWED) applyPlacement();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    win = null;
  });
}

function applyClickThrough(enabled) {
  if (!win || WINDOWED) return;
  clickThrough = enabled;
  // forward:true still lets the renderer see mouse-move events for hover effects
  // while clicks pass through to whatever is behind.
  win.setIgnoreMouseEvents(enabled, { forward: true });
}

/** Re-assert bounds. Cheap, and the fix for every monitor hot-plug edge case. */
function applyPlacement() {
  if (!win || WINDOWED) return;
  const { display } = pickDisplay(config);
  const { x, y, width, height } = display.bounds;
  if (config.window.fillDisplay) {
    win.setBounds({ x, y, width, height });
  } else {
    win.setPosition(x, y);
  }
  if (config.window.alwaysOnTop) {
    win.setAlwaysOnTop(true, config.window.alwaysOnTopLevel || 'screen-saver');
  }
}

/**
 * Windows reshuffles windows off a display when it sleeps or is unplugged, and
 * puts them back somewhere arbitrary on wake. Debounced because a single
 * resolution change fires several of these in a burst.
 */
function watchDisplays() {
  const reschedule = () => {
    if (placementTimer) clearTimeout(placementTimer);
    placementTimer = setTimeout(applyPlacement, 1500);
  };
  screen.on('display-added', reschedule);
  screen.on('display-removed', reschedule);
  screen.on('display-metrics-changed', reschedule);
}

function startPowerBlocker() {
  if (!config.power.preventDisplaySleep) return;
  blockerId = powerSaveBlocker.start('prevent-display-sleep');
  console.log('[power] display sleep suppressed');
}

/* ── live configuration ──────────────────────────────────────────
   The admin edits a running panel, so a change should be visible immediately.
   Most of the config is renderer-side and needs nothing but a push. The rest
   splits into what the window can be told at runtime, what needs the sensor hub
   restarted, and what is fixed when the window is created — which the schema
   marks so the admin can say so rather than leaving the user wondering why a
   setting did nothing. */

function pushConfig() {
  const cfg = effectiveConfig();
  if (win && !win.isDestroyed()) win.webContents.send('config:changed', cfg);
  return cfg;
}

/** The handful of window properties Electron will change after creation. */
function applyWindowConfig(cfg) {
  if (!win || WINDOWED) return;
  win.setOpacity(typeof cfg.window.opacity === 'number' ? cfg.window.opacity : 1);
  win.setAlwaysOnTop(
    Boolean(cfg.window.alwaysOnTop),
    cfg.window.alwaysOnTopLevel || 'screen-saver',
  );
  if (cfg.window.clickThrough !== clickThrough) {
    applyClickThrough(Boolean(cfg.window.clickThrough));
    refreshTrayMenu();
  }
}

/** Deep-equality over the slices of config the sensor hub reads at startup. */
const sensorSignature = (cfg) =>
  JSON.stringify({ polling: cfg.polling, sensors: cfg.sensors });

async function restartSensors() {
  hub?.stop();
  await startSensors();
}

function preview(patch) {
  previewPatch = patch && Object.keys(patch).length ? patch : null;
  const cfg = pushConfig();
  applyWindowConfig(cfg);
}

function applyPatch(patch) {
  const before = sensorSignature(effectiveConfig());
  previewPatch = null; // saving supersedes whatever was being previewed
  config = configLoader.saveUserPatch(patch);

  const cfg = pushConfig();
  applyWindowConfig(cfg);
  if (sensorSignature(cfg) !== before) restartSensors();
  return cfg;
}

/**
 * Re-read config.json from disk and bring the running app in line with it.
 *
 * Used after a restore, where the file has been replaced wholesale rather than
 * patched, so there is no patch to apply — the file is now the truth and
 * everything downstream has to be told again.
 */
function reloadFromDisk() {
  const before = sensorSignature(effectiveConfig());
  previewPatch = null;
  config = configLoader.load();

  const cfg = pushConfig();
  applyWindowConfig(cfg);
  if (sensorSignature(cfg) !== before) restartSensors();
  return cfg;
}

/**
 * Restore points, exposed to the settings page. Every one of these leaves the
 * previous configuration as a new restore point, so none of them is a one-way
 * door — including the resets.
 */
const restoreApi = {
  list: () => restorePoints.list(),
  apply: (id) => {
    const result = restorePoints.restore(id);
    reloadFromDisk();
    return result;
  },
  reset: (scope) => {
    const result = restorePoints.reset({ scope });
    reloadFromDisk();
    return result;
  },
  pin: (label) => restorePoints.pin(label),
  remove: (id) => restorePoints.remove(id),
};

function runAction(name) {
  switch (name) {
    case 'revert-preview':
      preview(null);
      return { ok: true };
    case 'reload-hud':
      win?.reload();
      return { ok: true };
    case 'replace':
      applyPlacement();
      return { ok: true };
    case 'restart-sensors':
      restartSensors();
      return { ok: true };
    default:
      return { ok: false, error: `unknown action "${name}"` };
  }
}

function buildTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('screen-buddy — system HUD');
  refreshTrayMenu();
}

// Rebuilt on toggle so the checkbox state stays truthful.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'screen-buddy', enabled: false },
      { type: 'separator' },
      {
        label: admin?.url ? 'Settings…' : 'Settings unavailable',
        enabled: Boolean(admin?.url),
        click: () => shell.openExternal(admin.url),
      },
      { label: 'Re-place on target display', click: applyPlacement },
      {
        label: 'Click-through',
        type: 'checkbox',
        checked: clickThrough,
        enabled: !WINDOWED,
        click: (item) => {
          applyClickThrough(item.checked);
          refreshTrayMenu();
        },
      },
      { label: 'Reload HUD', click: () => win?.reload() },
      {
        label: 'Toggle DevTools',
        click: () => win?.webContents.toggleDevTools(),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

async function startSensors() {
  hub = new SensorHub(effectiveConfig());
  hub.on('snapshot', (snapshot) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sensors:snapshot', snapshot);
    }
  });
  try {
    await hub.start();
  } catch (err) {
    console.error('[sensors] failed to start:', err.message);
  }
}

async function startAdmin() {
  admin = new AdminServer({
    getConfig: effectiveConfig,
    getSnapshot: () => hub?.lastSnapshot ?? null,
    applyPatch,
    preview,
    action: runAction,
    restore: restoreApi,
  });
  await admin.start();
  refreshTrayMenu();
}

ipcMain.handle('config:get', () => effectiveConfig());
ipcMain.handle('sensors:latest', () => hub?.lastSnapshot ?? null);

app.whenReady().then(async () => {
  registerAppProtocol();
  createWindow();
  buildTray();
  watchDisplays();
  startPowerBlocker();

  // Guarantee there is always something to go back to that is not the shipped
  // template. Taken before the app has had any chance to write, so on a machine
  // that has been running happily for months this is still the configuration
  // that was working when the feature arrived.
  if (!restorePoints.list().some((e) => e.kind !== 'shipped')) {
    const first = restorePoints.pin('first run');
    if (first) console.log(`[config] first-run restore point saved: ${first.id}`);
  }

  await startSensors();
  await startAdmin();
});

// The HUD is a background appliance: closing the window should not be the only
// way out, and quitting must actually tear the timers down.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  hub?.stop();
  admin?.stop();
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
});
