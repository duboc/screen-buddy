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
  powerSaveBlocker,
  nativeImage,
  protocol,
  net,
} = require('electron');

const configLoader = require('./config');
const { pickDisplay, describe } = require('./display');
const { SensorHub } = require('./sensors');
const { TRAY_ICON_DATA_URL } = require('./tray-icon');

const argv = new Set(process.argv.slice(1));
const DEV = argv.has('--dev');
const WINDOWED = argv.has('--windowed');

const config = configLoader.load();

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
let blockerId = null;
let clickThrough = config.window.clickThrough && !WINDOWED;
let placementTimer = null;

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
  hub = new SensorHub(config);
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

ipcMain.handle('config:get', () => config);
ipcMain.handle('sensors:latest', () => hub?.lastSnapshot ?? null);

app.whenReady().then(async () => {
  registerAppProtocol();
  createWindow();
  buildTray();
  watchDisplays();
  startPowerBlocker();
  await startSensors();
});

// The HUD is a background appliance: closing the window should not be the only
// way out, and quitting must actually tear the timers down.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  hub?.stop();
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
});
