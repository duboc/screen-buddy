'use strict';

const { screen } = require('electron');

/**
 * Chooses which monitor the HUD occupies.
 *
 * Matching on bounds rather than an index because Electron's display order is
 * not stable across reboots, driver updates or hot-plugs — an index that points
 * at the little panel today can point at your main monitor tomorrow, which is
 * exactly the failure the user notices at the worst moment.
 */

const area = (d) => d.bounds.width * d.bounds.height;

function byBounds(displays, want) {
  if (!want) return null;
  // Exact corner match first; then nearest corner within a tolerance, so a
  // small drift after rearranging monitors still resolves correctly.
  const exact = displays.find(
    (d) => d.bounds.x === want.x && d.bounds.y === want.y,
  );
  if (exact) return exact;

  const TOLERANCE = 200;
  let best = null;
  let bestDist = Infinity;
  for (const d of displays) {
    const dist = Math.hypot(d.bounds.x - want.x, d.bounds.y - want.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return bestDist <= TOLERANCE ? best : null;
}

function resolveStrategy(strategy, displays, config) {
  switch (strategy) {
    case 'bounds':
      return byBounds(displays, config.display.bounds);
    case 'index':
      return displays[config.display.index] ?? null;
    case 'primary':
      return screen.getPrimaryDisplay();
    case 'largest':
      return displays.reduce((a, b) => (area(b) > area(a) ? b : a));
    case 'smallest':
      return displays.reduce((a, b) => (area(b) < area(a) ? b : a));
    default:
      return null;
  }
}

/**
 * @returns {{display: Electron.Display, strategy: string, fellBack: boolean}}
 */
function pickDisplay(config) {
  const displays = screen.getAllDisplays();
  const wanted = config.display.strategy;

  let display = resolveStrategy(wanted, displays, config);
  if (display) return { display, strategy: wanted, fellBack: false };

  const fallback = config.display.fallback || 'primary';
  display = resolveStrategy(fallback, displays, config) || screen.getPrimaryDisplay();
  return { display, strategy: fallback, fellBack: true };
}

function describe(d) {
  const { x, y, width, height } = d.bounds;
  return `id=${d.id} ${width}x${height} @ ${x},${y} scale=${d.scaleFactor}${
    d.internal ? ' internal' : ''
  }`;
}

module.exports = { pickDisplay, describe };
