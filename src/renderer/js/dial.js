/**
 * Manometer dial geometry.
 *
 * The dial is drawn the way a real pressure gauge is: a 270-degree sweep with
 * the origin at the lower left, engraved tick marks, printed numerals, and a
 * fixed red danger zone painted on the face.
 *
 * That is not decoration — it is what makes the reading colour-independent.
 * The value is carried by needle POSITION against printed graduations, so it
 * survives any colour-vision deficiency, and the danger zone is a static
 * reference band rather than a mark that changes with the data.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const CENTER = 50;
const START_ANGLE = -135; // lower left
const SWEEP = 270;

const TICK_OUTER = 38;
const TICK_MAJOR_INNER = 30;
const TICK_MINOR_INNER = 34;
const NUMERAL_RADIUS = 24;
const ZONE_RADIUS = 40.5;

const MAJOR_TICKS = 5; // 6 labelled graduations including both ends
const MINORS_PER_MAJOR = 4;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Fraction of the domain a value sits at, clamped to the dial's range. */
function fractionOf(value, { min, max }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return clamp01((value - min) / (max - min));
}

/** Needle rotation in degrees. A missing reading parks the needle at zero. */
export function needleAngle(value, domain) {
  const frac = fractionOf(value, domain);
  return START_ANGLE + SWEEP * (frac ?? 0);
}

/** Polar to cartesian, in the SVG's coordinate space. */
function point(angleDeg, radius) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: CENTER + Math.cos(rad) * radius,
    y: CENTER + Math.sin(rad) * radius,
  };
}

function line(x1, y1, x2, y2, className) {
  const node = document.createElementNS(SVG_NS, 'line');
  node.setAttribute('x1', x1.toFixed(2));
  node.setAttribute('y1', y1.toFixed(2));
  node.setAttribute('x2', x2.toFixed(2));
  node.setAttribute('y2', y2.toFixed(2));
  node.setAttribute('class', className);
  return node;
}

function text(x, y, value) {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', x.toFixed(2));
  node.setAttribute('y', y.toFixed(2));
  node.setAttribute('class', 'dial__num');
  node.textContent = value;
  return node;
}

/** Arc path between two fractions of the sweep, at a fixed radius. */
function arcPath(fromFrac, toFrac, radius) {
  const a0 = START_ANGLE + SWEEP * clamp01(fromFrac);
  const a1 = START_ANGLE + SWEEP * clamp01(toFrac);
  const p0 = point(a0, radius);
  const p1 = point(a1, radius);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${radius},${radius} 0 ${largeArc} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
}

/**
 * Draws ticks, numerals and the danger zone into a dial SVG. Depends only on
 * the domain and thresholds, so it runs once per gauge rather than per frame.
 *
 * @param {SVGElement} svg   the dial's <svg>
 * @param {{min:number,max:number}} domain
 * @param {{warn:number,crit:number}} thresholds
 */
export function buildDialFace(svg, domain, thresholds) {
  const ticks = svg.querySelector('[data-ticks]');
  const zone = svg.querySelector('[data-zone]');
  if (!ticks) return;

  ticks.replaceChildren();
  const frag = document.createDocumentFragment();

  const totalMinor = MAJOR_TICKS * MINORS_PER_MAJOR;
  for (let i = 0; i <= totalMinor; i += 1) {
    const frac = i / totalMinor;
    const angle = START_ANGLE + SWEEP * frac;
    const isMajor = i % MINORS_PER_MAJOR === 0;

    const outer = point(angle, TICK_OUTER);
    const inner = point(angle, isMajor ? TICK_MAJOR_INNER : TICK_MINOR_INNER);
    frag.append(
      line(
        outer.x,
        outer.y,
        inner.x,
        inner.y,
        isMajor ? 'dial__tick dial__tick--major' : 'dial__tick',
      ),
    );

    if (isMajor) {
      const at = point(angle, NUMERAL_RADIUS);
      const value = Math.round(domain.min + (domain.max - domain.min) * frac);
      frag.append(text(at.x, at.y, String(value)));
    }
  }
  ticks.append(frag);

  // Printed danger zone, from the warning threshold to the end of the scale.
  if (zone) {
    const from = fractionOf(thresholds.warn, domain) ?? 1;
    zone.setAttribute('d', arcPath(from, 1, ZONE_RADIUS));
  }
}
