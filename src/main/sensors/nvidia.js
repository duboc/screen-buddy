'use strict';

const { spawn } = require('node:child_process');

/**
 * NVIDIA GPU telemetry via nvidia-smi.
 *
 * Rather than spawning a process per poll (nvidia-smi takes ~150-300ms to start,
 * which would dominate a 1s budget), we start ONE long-lived `nvidia-smi -l 1`
 * that streams a CSV line every second, and just keep the most recent line.
 * Costs one idle process; no per-poll latency.
 *
 * Requires no elevation.
 */

const FIELDS = [
  'name',
  'temperature.gpu',
  'utilization.gpu',
  'utilization.memory',
  'power.draw',
  'power.limit',
  'clocks.sm',
  'clocks.mem',
  'memory.used',
  'memory.total',
  'fan.speed',
];

/** nvidia-smi prints "[N/A]" / "[Not Supported]" for fields a card doesn't expose. */
function num(raw) {
  const v = Number.parseFloat(String(raw).trim());
  return Number.isFinite(v) ? v : null;
}

function str(raw) {
  const v = String(raw).trim();
  return v && !v.startsWith('[') ? v : null;
}

class NvidiaSource {
  constructor({ enabled = true, path = 'nvidia-smi', intervalSec = 1 } = {}) {
    this.enabled = enabled;
    this.exe = path;
    this.intervalSec = Math.max(1, Math.round(intervalSec));
    this.latest = null;
    this.available = false;
    this.error = null;
    this.proc = null;
    this.stopped = false;
    this.restartTimer = null;
  }

  start() {
    if (!this.enabled || this.stopped) return;
    this.spawnProc();
  }

  spawnProc() {
    const args = [
      `--query-gpu=${FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
      `-l`,
      String(this.intervalSec),
    ];

    let proc;
    try {
      proc = spawn(this.exe, args, { windowsHide: true });
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
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.consume(line);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      const msg = d.trim();
      if (msg) this.error = msg.split('\n')[0];
    });

    proc.on('error', (err) => this.fail(err.message));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      // Exit is unexpected while we're running; back off and retry so a driver
      // reload or a GPU reset doesn't permanently kill the panel.
      this.fail(this.error || `nvidia-smi exited with code ${code}`);
      this.restartTimer = setTimeout(() => this.spawnProc(), 10_000);
    });
  }

  consume(line) {
    // Only the first GPU. Multi-GPU rigs would emit one line per card per tick.
    const parts = line.split(',');
    if (parts.length < FIELDS.length) return;

    const [
      name, temp, util, memUtil, power, powerLimit,
      clockSm, clockMem, memUsed, memTotal, fan,
    ] = parts;

    this.latest = {
      name: str(name),
      tempC: num(temp),
      load: num(util),
      memLoad: num(memUtil),
      powerW: num(power),
      powerLimitW: num(powerLimit),
      clockMHz: num(clockSm),
      memClockMHz: num(clockMem),
      memUsedMB: num(memUsed),
      memTotalMB: num(memTotal),
      fanPct: num(fan),
    };
    this.available = true;
    this.error = null;
  }

  fail(message) {
    this.available = false;
    this.error = message;
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    if (!this.available) {
      return {
        available: false,
        reason: this.error || 'waiting for nvidia-smi',
        data: null,
      };
    }
    return { available: true, reason: null, data: this.latest };
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

module.exports = { NvidiaSource };
