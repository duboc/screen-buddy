'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * Network throughput, read from Get-NetAdapterStatistics via a long-lived
 * PowerShell helper.
 *
 * Replaces systeminformation's networkStats(), which cannot read adapters whose
 * name contains a space. On a machine with an adapter named "Wi-Fi 6" it
 * returns rx_bytes = 0 for the real active adapter while reporting a
 * disconnected "Wi-Fi" adapter's counters instead — the HUD showed a permanent
 * 0 B/s. The OS's own accounting has no such problem.
 *
 * The helper reports cumulative byte totals; rates are derived here from the
 * delta between consecutive samples and their timestamps.
 */

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'netstats-loop.ps1');

class NetStatsSource {
  constructor({ interface: ifaceOverride = null, intervalMs = 1000 } = {}) {
    this.ifaceOverride = ifaceOverride;
    this.intervalMs = intervalMs;
    this.prev = null; // { at, byName: Map<name, {rx, tx}> }
    this.rates = new Map(); // name -> { rxBps, txBps, up, state }
    this.available = false;
    this.reason = 'starting';
    this.proc = null;
    this.stopped = false;
    this.restartTimer = null;
    // Sticky choice, so the displayed adapter does not flicker between two
    // adapters that happen to trade places for busiest on a quiet link.
    this.selected = null;
  }

  start() {
    if (this.stopped) return;
    this.spawnProc();
  }

  spawnProc() {
    let proc;
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT,
          '-IntervalMs',
          String(this.intervalMs),
        ],
        { windowsHide: true },
      );
    } catch (err) {
      this.fail(err.message);
      return;
    }
    this.proc = proc;

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const lineText = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (lineText) this.consume(lineText);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      const msg = d.trim();
      if (msg) this.reason = msg.split('\n')[0].slice(0, 120);
    });

    proc.on('error', (err) => this.fail(err.message));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.fail(`helper exited (${code})`);
      this.restartTimer = setTimeout(() => this.spawnProc(), 15_000);
    });
  }

  consume(lineText) {
    let msg;
    try {
      msg = JSON.parse(lineText);
    } catch {
      return;
    }
    if (!msg.ok) {
      this.fail(msg.error || 'adapter query failed');
      return;
    }

    // A single adapter comes back as an object rather than an array, because
    // ConvertTo-Json does not preserve one-element arrays.
    const list = Array.isArray(msg.adapters)
      ? msg.adapters
      : msg.adapters
        ? [msg.adapters]
        : [];

    const byName = new Map();
    for (const a of list) {
      if (a && typeof a.name === 'string') {
        byName.set(a.name, { rx: Number(a.rx), tx: Number(a.tx), up: !!a.up, state: a.state });
      }
    }

    if (this.prev) {
      const dtSec = (msg.at - this.prev.at) / 1000;
      if (dtSec > 0.05) {
        for (const [name, cur] of byName) {
          const before = this.prev.byName.get(name);
          if (!before) continue;
          // A counter reset (adapter disable/enable) yields a negative delta.
          const dRx = Math.max(0, cur.rx - before.rx);
          const dTx = Math.max(0, cur.tx - before.tx);
          this.rates.set(name, {
            rxBps: dRx / dtSec,
            txBps: dTx / dtSec,
            up: cur.up,
            state: cur.state,
          });
        }
        this.available = true;
        this.reason = null;
      }
    }

    this.prev = { at: msg.at, byName };
  }

  /**
   * Chooses which adapter to display. An explicit config name always wins.
   * Otherwise: only adapters reporting Up, preferring the one with the most
   * traffic, and keeping the current pick unless something clearly beats it.
   */
  pick() {
    if (this.ifaceOverride) return this.ifaceOverride;

    const up = [...this.rates.entries()].filter(([, r]) => r.up);
    if (!up.length) return this.selected;

    const total = ([, r]) => r.rxBps + r.txBps;
    const busiest = up.reduce((a, b) => (total(b) > total(a) ? b : a));

    const current = this.selected ? this.rates.get(this.selected) : null;
    if (!current || !current.up) {
      this.selected = busiest[0];
      return this.selected;
    }

    // Hysteresis: only switch if the challenger is meaningfully busier, so an
    // idle machine does not flip the label back and forth.
    const currentTotal = current.rxBps + current.txBps;
    if (total(busiest) > currentTotal * 2 + 8192) this.selected = busiest[0];
    return this.selected;
  }

  read() {
    if (!this.available) {
      return { available: false, reason: this.reason, data: null };
    }
    const name = this.pick();
    const r = name ? this.rates.get(name) : null;
    if (!r) {
      return {
        available: true,
        reason: null,
        data: { iface: name ?? null, rxBps: 0, txBps: 0 },
      };
    }
    return {
      available: true,
      reason: null,
      data: { iface: name, rxBps: r.rxBps, txBps: r.txBps },
    };
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { NetStatsSource };
