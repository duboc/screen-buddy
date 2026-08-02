'use strict';

/**
 * Retains the readings the panel already takes, so it can show a trend instead
 * of only an instant.
 *
 * The HUD polls temperature and load every second and then throws each sample
 * away, which means it can tell you the CPU is at 62 C but not whether that is
 * on the way up from 50 or down from 84 — and those mean opposite things. This
 * costs one extra source of nothing: the data is already arriving.
 *
 * It lives in the main process rather than the renderer so that peaks survive a
 * HUD reload. A "peak since boot" that silently resets whenever the window
 * reloads is worse than no peak at all, because it still looks authoritative.
 */

/** What is tracked, and how each is pulled out of a snapshot. */
const SERIES = {
  cpuTemp: { pick: (s) => s.cpu?.tempC, threshold: (t) => t.cpuTemp },
  gpuTemp: { pick: (s) => s.gpu?.tempC, threshold: (t) => t.gpuTemp },
  cpuLoad: { pick: (s) => s.cpu?.load, threshold: (t) => t.load },
  gpuLoad: { pick: (s) => s.gpu?.load, threshold: (t) => t.load },
  memPct: { pick: (s) => s.mem?.pct, threshold: (t) => t.memory },
};

const KEYS = Object.keys(SERIES);

class History {
  /**
   * @param {object} opts
   * @param {number} opts.windowSec how much past to keep
   * @param {number} opts.points    how many buckets the renderer is sent
   * @param {object} opts.thresholds warn/crit levels, for time-above accounting
   */
  constructor({ windowSec = 900, points = 60, thresholds = {} } = {}) {
    this.windowSec = windowSec;
    this.points = points;
    this.thresholds = thresholds;
    this.startedAt = Date.now();
    this.samples = []; // { at, cpuTemp, gpuTemp, ... }
    this.peaks = Object.fromEntries(KEYS.map((k) => [k, { value: null, at: null }]));
    this.aboveMs = Object.fromEntries(KEYS.map((k) => [k, { warn: 0, crit: 0 }]));
    this.lastAt = null;
  }

  push(snapshot) {
    const at = snapshot.ts ?? Date.now();
    const row = { at };

    // Elapsed since the previous sample, not the nominal poll interval: the
    // interval is configurable and a slow LHM response can stretch a tick, so
    // "time spent above 75 C" has to be measured rather than counted.
    const dtMs = this.lastAt === null ? 0 : Math.max(0, Math.min(10_000, at - this.lastAt));
    this.lastAt = at;

    for (const key of KEYS) {
      const raw = SERIES[key].pick(snapshot);
      const v = Number.isFinite(raw) ? raw : null;
      row[key] = v;
      if (v === null) continue;

      const peak = this.peaks[key];
      if (peak.value === null || v > peak.value) {
        peak.value = v;
        peak.at = at;
      }

      const t = SERIES[key].threshold(this.thresholds) ?? {};
      if (Number.isFinite(t.crit) && v >= t.crit) this.aboveMs[key].crit += dtMs;
      else if (Number.isFinite(t.warn) && v >= t.warn) this.aboveMs[key].warn += dtMs;
    }

    this.samples.push(row);
    const cutoff = at - this.windowSec * 1000;
    // Trimmed by time rather than by count, so the window stays honest when the
    // poll interval is changed at runtime.
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
  }

  /**
   * Downsampled series for the renderer.
   *
   * Buckets take the MAXIMUM, not the mean. On a thermal trace the spike is the
   * story — averaging a two-second 92 C excursion into its neighbours hides
   * exactly the event worth seeing, and a panel that smooths away the problem
   * it exists to report is worse than no panel.
   */
  read() {
    const n = this.samples.length;
    if (!n) return null;

    const first = this.samples[0].at;
    const last = this.samples[n - 1].at;
    const span = Math.max(1, last - first);
    const width = span / this.points;

    const series = Object.fromEntries(KEYS.map((k) => [k, new Array(this.points).fill(null)]));

    for (const row of this.samples) {
      const b = Math.min(this.points - 1, Math.floor((row.at - first) / width));
      for (const key of KEYS) {
        const v = row[key];
        if (v === null) continue;
        const cur = series[key][b];
        if (cur === null || v > cur) series[key][b] = v;
      }
    }

    return {
      series,
      peaks: this.peaks,
      // Seconds, because that is what the panel prints and the renderer should
      // not have to know these were accumulated in milliseconds.
      aboveSec: Object.fromEntries(
        KEYS.map((k) => [
          k,
          { warn: Math.round(this.aboveMs[k].warn / 1000), crit: Math.round(this.aboveMs[k].crit / 1000) },
        ]),
      ),
      spanSec: Math.round(span / 1000),
      windowSec: this.windowSec,
      sinceMs: this.startedAt,
    };
  }
}

module.exports = { History, SERIES_KEYS: KEYS };
