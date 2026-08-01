'use strict';

/**
 * Prints the displays exactly as Electron sees them, so config.json can be
 * filled in with coordinates that actually match at runtime.
 *
 *   npm run displays
 *
 * Electron's DIP bounds are not always the same numbers other Windows tools
 * report — anything that is not per-monitor DPI aware reports a virtualized
 * layout. These are the authoritative values for this app.
 */

const { app, screen } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();

  const rows = displays.map((d, i) => ({
    index: i,
    id: d.id,
    primary: d.id === primary.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    internal: d.internal,
    pixels: d.bounds.width * d.bounds.height,
  }));

  console.log(JSON.stringify(rows, null, 2));

  const smallest = rows.reduce((a, b) => (b.pixels < a.pixels ? b : a));
  console.log('\nSmallest display (likely your HUD panel):');
  console.log(
    `  index ${smallest.index} - ${smallest.bounds.width}x${smallest.bounds.height} @ ${smallest.bounds.x},${smallest.bounds.y}`,
  );
  console.log('\nMatching config.json snippet:');
  console.log(
    JSON.stringify(
      {
        display: {
          strategy: 'bounds',
          bounds: { x: smallest.bounds.x, y: smallest.bounds.y },
          fallback: 'smallest',
        },
      },
      null,
      2,
    ),
  );

  app.quit();
});
