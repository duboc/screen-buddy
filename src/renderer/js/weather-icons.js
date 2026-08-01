/**
 * Weather glyphs as inline SVG.
 *
 * Drawn rather than using text emoji or a webfont: emoji render in the
 * system's own colour and style, which fights the brushed-steel-and-brass
 * palette, and a webfont would be another asset to load under a strict CSP.
 * These inherit currentColor and the theme's brass, so they belong to the
 * machine.
 *
 * Every icon draws inside a 24x24 box.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const SUN_RAYS = [
  [12, 1.5, 12, 3.6],
  [12, 20.4, 12, 22.5],
  [1.5, 12, 3.6, 12],
  [20.4, 12, 22.5, 12],
  [4.6, 4.6, 6.1, 6.1],
  [17.9, 17.9, 19.4, 19.4],
  [19.4, 4.6, 17.9, 6.1],
  [6.1, 17.9, 4.6, 19.4],
];

// A single cloud outline, reused by every overcast/precipitation icon so they
// read as one family.
const CLOUD_PATH =
  'M7.2 18.5h9.9a3.9 3.9 0 0 0 .3-7.8 5.6 5.6 0 0 0-10.7-1.4 4.6 4.6 0 0 0 .5 9.2z';

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function sun(cx = 12, cy = 12, r = 4.6, rays = true) {
  const g = el('g', { class: 'wx-sun' });
  g.append(el('circle', { cx, cy, r }));
  if (rays) {
    for (const [x1, y1, x2, y2] of SUN_RAYS) {
      g.append(el('line', { x1, y1, x2, y2 }));
    }
  }
  return g;
}

function moon() {
  const g = el('g', { class: 'wx-sun' });
  // Crescent as a filled path, so it stays legible at 20px.
  g.append(
    el('path', {
      d: 'M17.4 14.9A6.6 6.6 0 0 1 9.1 6.6a6.6 6.6 0 1 0 8.3 8.3z',
      class: 'wx-fill',
    }),
  );
  return g;
}

function cloud(cls = 'wx-cloud') {
  return el('path', { d: CLOUD_PATH, class: cls });
}

function drops(count = 3, cls = 'wx-precip') {
  const g = el('g', { class: cls });
  const xs = count === 2 ? [9.5, 14.5] : [7.5, 12, 16.5];
  xs.forEach((x, i) => {
    const y = 19.5 + (i % 2 === 1 ? 1.2 : 0);
    g.append(el('line', { x1: x, y1: y, x2: x - 1.1, y2: y + 3 }));
  });
  return g;
}

function flakes() {
  const g = el('g', { class: 'wx-precip' });
  for (const x of [8, 12, 16]) {
    g.append(el('line', { x1: x - 1.3, y1: 21, x2: x + 1.3, y2: 21 }));
    g.append(el('line', { x1: x, y1: 19.7, x2: x, y2: 22.3 }));
  }
  return g;
}

function bolt() {
  const g = el('g', { class: 'wx-bolt' });
  g.append(el('path', { d: 'M13 18.6l-3.4 4.6h2.6l-.7 3.2 3.6-4.9h-2.6z' }));
  return g;
}

function fogLines() {
  const g = el('g', { class: 'wx-cloud' });
  const rows = [
    [4, 9, 20, 9],
    [6, 13, 18.5, 13],
    [4.5, 17, 19.5, 17],
    [7, 21, 17, 21],
  ];
  for (const [x1, y1, x2, y2] of rows) g.append(el('line', { x1, y1, x2, y2 }));
  return g;
}

const BUILDERS = {
  clear: () => [sun()],
  'clear-night': () => [moon()],
  'mostly-clear': () => [sun(9.5, 9.5, 3.6)],
  'mostly-clear-night': () => [moon()],
  'partly-cloudy': () => [sun(8.5, 8, 3.2), cloud()],
  overcast: () => [cloud()],
  fog: () => [fogLines()],
  drizzle: () => [cloud(), drops(2)],
  rain: () => [cloud(), drops(3)],
  snow: () => [cloud(), flakes()],
  thunder: () => [cloud(), bolt()],
  unknown: () => [cloud()],
};

/**
 * Replaces the contents of `host` with the named icon.
 * @param {SVGElement} host an <svg viewBox="0 0 24 24">
 * @param {string} name key from the weather source
 */
export function renderWeatherIcon(host, name) {
  const build = BUILDERS[name] ?? BUILDERS.unknown;
  host.replaceChildren(...build());
}
