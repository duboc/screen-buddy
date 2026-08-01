/**
 * Formatting helpers.
 *
 * Rule that runs through all of these: null means "no sensor", and renders as
 * DASH. Never coerce a missing reading to 0 — a HUD that shows a confident
 * "0 W" when nothing is being measured is worse than one that shows "--".
 */

export const DASH = '--';

const has = (v) => v !== null && v !== undefined && Number.isFinite(v);

export function num(value, digits = 0) {
  return has(value) ? value.toFixed(digits) : DASH;
}

/** Integer percent, clamped for display so a 100.4 never renders as "100.4%". */
export function pct(value, digits = 0) {
  if (!has(value)) return DASH;
  return `${Math.min(100, Math.max(0, value)).toFixed(digits)}%`;
}

export function watts(value) {
  return has(value) ? `${value.toFixed(0)} W` : DASH;
}

export function celsius(value) {
  return has(value) ? value.toFixed(0) : DASH;
}

export function rpm(value) {
  return has(value) && value > 0 ? `${value.toFixed(0)} RPM` : DASH;
}

/** MHz in, GHz out once it gets big enough to be easier to read that way. */
export function clock(mhz) {
  if (!has(mhz)) return DASH;
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** @returns {{value: string, unit: string}} split so the unit can be styled down. */
export function bytes(n, { perSecond = false, digits = 1 } = {}) {
  if (!has(n)) return { value: DASH, unit: '' };
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  // Big magnitudes don't need a decimal; small ones do or they read as static.
  const d = v >= 100 ? 0 : digits;
  return {
    value: v.toFixed(i === 0 ? 0 : d),
    unit: BYTE_UNITS[i] + (perSecond ? '/s' : ''),
  };
}

export function bytesInline(n, opts) {
  const { value, unit } = bytes(n, opts);
  return unit ? `${value} ${unit}` : value;
}

/** Gigabytes used/total, the form people actually read memory in. */
export function memPair(usedBytes, totalBytes) {
  if (!has(usedBytes) || !has(totalBytes)) return DASH;
  const g = 1024 ** 3;
  return `${(usedBytes / g).toFixed(1)} / ${(totalBytes / g).toFixed(1)} GB`;
}

export function mbPair(usedMB, totalMB) {
  if (!has(usedMB) || !has(totalMB)) return DASH;
  return `${(usedMB / 1024).toFixed(1)} / ${(totalMB / 1024).toFixed(1)} GB`;
}

/** Track position as m:ss — the form a player shows it in. */
export function mmss(seconds) {
  if (!has(seconds) || seconds < 0) return DASH;
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function duration(seconds) {
  if (!has(seconds)) return DASH;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Maps a reading onto the three-step status ramp.
 * Discrete steps, not a continuous ramp: three states a glance can resolve,
 * and each one always renders beside its own numeral.
 */
export function statusOf(value, { warn, crit }) {
  if (!has(value)) return 'nominal';
  if (value >= crit) return 'crit';
  if (value >= warn) return 'warn';
  return 'nominal';
}

/** Rounds a peak up to a friendly 1/2/5 x 10^n so the scale label is readable. */
export function niceCeil(value) {
  if (!has(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const mag = 10 ** exp;
  const frac = value / mag;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * mag;
}
