'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * The busiest processes, by CPU and by memory, from a long-lived PowerShell
 * helper.
 *
 * This is the one thing the panel could not answer before: it could tell you
 * the machine was at 80% and 84 C, but not what was doing it, which is the
 * next question every single time. It exists as a helper rather than a
 * systeminformation call because si.processes() costs ~900ms of CPU per call
 * and does not cache — a stiff price for a panel that is supposed to be
 * watching CPU, not consuming it.
 *
 * The helper ranks and trims, and reports CPU as a percentage of the whole
 * machine; see scripts/processes-loop.ps1 for why that division of labour
 * differs from the network helper's.
 */

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'processes-loop.ps1');

/** ConvertTo-Json emits a bare object rather than a one-element array. */
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

class ProcessesSource {
  constructor({ enabled = true, intervalMs = 3000, top = 6 } = {}) {
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.top = top;
    this.latest = null;
    this.available = false;
    this.reason = 'starting';
    this.proc = null;
    this.stopped = false;
    this.restartTimer = null;
  }

  start() {
    if (!this.enabled || this.stopped) return;
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
          '-Top',
          String(this.top),
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
      this.fail(msg.error || 'process query failed');
      return;
    }

    const clean = (list) =>
      asArray(list)
        .filter((p) => p && typeof p.name === 'string')
        .map((p) => ({
          name: p.name,
          cpuPct: Number.isFinite(p.cpuPct) ? p.cpuPct : null,
          memBytes: Number(p.memBytes) || 0,
          instances: Number(p.instances) || 1,
        }));

    this.latest = {
      total: Number(msg.total) || 0,
      byCpu: clean(msg.byCpu),
      byMem: clean(msg.byMem),
    };

    // The first sample has no previous reading to difference against, so every
    // CPU figure in it is unknown. Reporting unavailable until the second
    // sample keeps the panel showing "--" rather than a column of zeroes that
    // look like a genuinely idle machine.
    if (msg.warm) {
      this.available = true;
      this.reason = null;
    }
  }

  fail(reason) {
    this.available = false;
    this.reason = reason;
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    return {
      available: this.available,
      reason: this.reason,
      data: this.available ? this.latest : null,
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

module.exports = { ProcessesSource };
