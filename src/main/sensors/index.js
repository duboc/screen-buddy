'use strict';

const { EventEmitter } = require('node:events');
const { SystemSource } = require('./system');
const { NvidiaSource } = require('./nvidia');
const { LhmSource } = require('./lhm');
const { NowPlayingSource } = require('./nowplaying');

/**
 * Merges the three sources into one normalized snapshot and emits it on a timer.
 *
 * Merge rule for overlapping fields: prefer the source closest to the hardware.
 * LHM reads the CPU's own SMU, so its clock and load figures beat anything
 * derived from OS counters; nvidia-smi owns everything GPU. Every field is
 * nullable, and the renderer prints "--" for null rather than 0 — an absent
 * sensor must never be mistaken for a real zero.
 */
class SensorHub extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.system = new SystemSource(config.sensors.network);
    this.nvidia = new NvidiaSource(config.sensors.nvidiaSmi);
    this.lhm = new LhmSource(config.sensors.libreHardwareMonitor);
    this.nowPlaying = new NowPlayingSource(config.sensors.nowPlaying);
    this.fastTimer = null;
    this.slowTimer = null;
    this.lastSnapshot = null;
  }

  async start() {
    this.nvidia.start();
    this.nowPlaying.start();
    await this.system.init();
    await Promise.all([this.system.pollFast(), this.lhm.poll()]);
    this.emitSnapshot();

    const { fastMs, slowMs } = this.config.polling;
    this.fastTimer = setInterval(() => this.tickFast(), fastMs);
    this.slowTimer = setInterval(() => this.system.pollSlow(), slowMs);
  }

  async tickFast() {
    // nvidia-smi streams on its own; only these two need pulling.
    await Promise.all([this.system.pollFast(), this.lhm.poll()]);
    this.emitSnapshot();
  }

  emitSnapshot() {
    this.lastSnapshot = this.buildSnapshot();
    this.emit('snapshot', this.lastSnapshot);
  }

  buildSnapshot() {
    const sys = this.system.read();
    const gpu = this.nvidia.read();
    const lhm = this.lhm.read();
    const media = this.nowPlaying.read();

    const s = sys.data || {};
    const g = gpu.data || {};
    const l = lhm.data || {};

    return {
      ts: Date.now(),

      cpu: {
        brand: s.cpuBrand ?? null,
        cores: s.cpuCores ?? null,
        physicalCores: s.cpuPhysicalCores ?? null,
        load: s.cpuLoad ?? null,
        coreLoads: s.coreLoads ?? [],
        // LHM reads per-core clocks off the SMU; si.cpuCurrentSpeed() reports a
        // averaged figure that misses boost spikes. Prefer LHM, fall back to si.
        clockMHz: l.cpuClockMHz ?? (s.cpuClockGHz ? s.cpuClockGHz * 1000 : null),
        tempC: l.cpuTempC ?? null,
        tempLabel: l.cpuTempLabel ?? null,
        powerW: l.cpuPowerW ?? null,
        volts: l.cpuVolts ?? null,
        fanRpm: l.cpuFanRpm ?? null,
      },

      gpu: {
        name: g.name ?? null,
        load: g.load ?? null,
        memLoad: g.memLoad ?? null,
        tempC: g.tempC ?? null,
        powerW: g.powerW ?? null,
        powerLimitW: g.powerLimitW ?? null,
        clockMHz: g.clockMHz ?? null,
        memClockMHz: g.memClockMHz ?? null,
        memUsedMB: g.memUsedMB ?? null,
        memTotalMB: g.memTotalMB ?? null,
        fanPct: g.fanPct ?? null,
      },

      mem: {
        usedBytes: s.memUsedBytes ?? null,
        totalBytes: s.memTotalBytes ?? null,
        pct:
          s.memUsedBytes && s.memTotalBytes
            ? (s.memUsedBytes / s.memTotalBytes) * 100
            : null,
        swapUsedBytes: s.swapUsedBytes ?? null,
        swapTotalBytes: s.swapTotalBytes ?? null,
      },

      net: {
        iface: s.netIface ?? null,
        rxBps: s.netRxBps ?? null,
        txBps: s.netTxBps ?? null,
      },

      disks: s.disks ?? [],

      // null when nothing is loaded in any player; the panel shows an idle
      // state rather than disappearing, so the layout never shifts.
      media: media.data ?? null,

      sys: {
        host: s.host ?? null,
        os: s.os ?? null,
        uptimeSec: s.uptimeSec ?? null,
        moboTempC: l.moboTempC ?? null,
      },

      // Surfaced in the footer so a missing source is visibly a setup gap
      // rather than a silently dead panel.
      sources: {
        system: { ok: sys.available, reason: sys.reason },
        nvidia: { ok: gpu.available, reason: gpu.reason },
        lhm: { ok: lhm.available, reason: lhm.reason },
        media: { ok: media.available, reason: media.reason },
      },
    };
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.nvidia.stop();
    this.nowPlaying.stop();
  }
}

module.exports = { SensorHub };
