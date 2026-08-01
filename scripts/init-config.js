'use strict';

/**
 * Generates config.json from the displays Electron actually reports.
 *
 *   npm run init-config              # pick the smallest display
 *   npm run init-config -- --index 2 # pick a specific one
 *   npm run init-config -- --force   # overwrite an existing config.json
 *
 * Runs under Electron rather than plain Node because only Electron's screen
 * module gives the DIP bounds the app itself will use. Tools that are not
 * per-monitor DPI aware report a different virtual-desktop layout, so
 * coordinates taken from them can point at the wrong monitor.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const TARGET = path.join(ROOT, 'config.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const area = (d) => d.bounds.width * d.bounds.height;

  console.log('Displays Electron reports:\n');
  displays.forEach((d, i) => {
    const { x, y, width, height } = d.bounds;
    const tags = [
      d.id === primary.id ? 'primary' : null,
      d.internal ? 'internal' : null,
    ].filter(Boolean);
    console.log(
      `  [${i}] ${String(width).padStart(5)}x${String(height).padEnd(5)} at ${String(x).padStart(6)},${String(y).padEnd(6)}  scale ${d.scaleFactor}${tags.length ? '  (' + tags.join(', ') + ')' : ''}`,
    );
  });

  const indexArg = valueOf('--index');
  let chosen;
  if (indexArg !== null) {
    chosen = displays[Number(indexArg)];
    if (!chosen) {
      console.error(`\nNo display at index ${indexArg}.`);
      app.exit(1);
      return;
    }
  } else {
    chosen = displays.reduce((a, b) => (area(b) < area(a) ? b : a));
  }

  console.log(
    `\nChosen: ${chosen.bounds.width}x${chosen.bounds.height} at ${chosen.bounds.x},${chosen.bounds.y}`,
  );

  if (displays.length === 1) {
    console.log(
      '\n  Note: only one display detected. The HUD will take it over entirely,',
    );
    console.log(
      '  which is probably not what you want - connect the second screen first.',
    );
  }

  if (fs.existsSync(TARGET) && !has('--force')) {
    console.log(
      `\nconfig.json already exists; leaving it alone. Re-run with --force to overwrite.`,
    );
    app.exit(0);
    return;
  }

  // Start from the annotated template so the user's config.json keeps every
  // explanatory comment, rather than being an opaque blob of values.
  let config;
  try {
    config = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  } catch (err) {
    console.error(`\nCould not read config.example.json: ${err.message}`);
    app.exit(1);
    return;
  }

  // Match on position rather than index: Electron's display order is not
  // stable across reboots or hot-plugs, but a monitor's corner is.
  config.display.strategy = 'bounds';
  config.display.bounds = { x: chosen.bounds.x, y: chosen.bounds.y };
  config.display.fallback = 'smallest';

  fs.writeFileSync(TARGET, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${TARGET}`);
  console.log('  display.strategy = bounds, falling back to smallest');

  app.exit(0);
});
