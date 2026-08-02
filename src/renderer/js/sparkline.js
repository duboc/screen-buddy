/* ── sparklines ───────────────────────────────────────────────────
   Small SVG traces for the trend and storage panels. Shared rather than
   copied because the flow plot's path-building already existed and a third
   hand-rolled version would be the point at which they start disagreeing about
   how a gap is drawn.

   Everything draws into a caller-supplied viewBox and is stretched by CSS with
   preserveAspectRatio="none", so nothing here needs to know the pixel size of
   the element it lands in. */

/**
 * Project values onto the box, split into continuous runs.
 *
 * Nulls are BREAKS, not zeroes. A sensor that was not reporting for part of the
 * window is a gap in knowledge, and drawing it as a plunge to zero would invent
 * a dramatic event that never happened — the same reason every readout on this
 * panel prints "--" rather than 0 when a sensor is absent.
 */
function segments(values, { width, height, min, max, pad = 1 }) {
  const span = max - min || 1;
  const usable = height - pad * 2;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const runs = [];
  let run = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      run = null;
      continue;
    }
    const x = i * step;
    const y = pad + usable - ((v - min) / span) * usable;
    if (!run) {
      run = [];
      runs.push(run);
    }
    run.push([x, y]);
  }
  return runs;
}

const draw = (run) =>
  run.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');

export function linePath(values, opts) {
  return segments(values, opts).map(draw).join('');
}

/** The same trace closed down to the baseline, one closed shape per run. */
export function areaPath(values, opts) {
  return segments(values, opts)
    .filter((run) => run.length > 1)
    .map(
      (run) =>
        `M${run[0][0].toFixed(2)},${opts.height}` +
        draw(run).slice(1) +
        `L${run.at(-1)[0].toFixed(2)},${opts.height}Z`,
    )
    .join('');
}

/**
 * A domain that makes the shape of the data visible.
 *
 * Deliberately not anchored at zero: a CPU idling between 45 and 48 C is a flat
 * line along the bottom of a 0–100 axis and a legible trace on a 40–55 one. The
 * panel prints the actual numbers beside every sparkline, so the trace's job is
 * shape, not magnitude.
 */
export function domainOf(values, { floor = 1 } = {}) {
  const real = values.filter((v) => Number.isFinite(v));
  if (!real.length) return { min: 0, max: floor };
  const hi = Math.max(...real);
  const lo = Math.min(...real);
  const pad = Math.max((hi - lo) * 0.2, floor * 0.5);
  return { min: Math.max(0, lo - pad), max: hi + pad };
}
