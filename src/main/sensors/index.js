'use strict';

const { EventEmitter } = require('node:events');
const { SystemSource } = require('./system');
const { NvidiaSource } = require('./nvidia');
const { LhmSource } = require('./lhm');
const { NowPlayingSource } = require('./nowplaying');
const { NetStatsSource } = require('./netstats');
const { WeatherSource } = require('./weather');
const { PingSource } = require('./ping');
const { ProcessesSource } = require('./processes');
const { History } = require('../history');

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
    this.netStats = new NetStatsSource({
      ...config.sensors.network,
      intervalMs: config.polling.fastMs,
    });
    this.weather = new WeatherSource(config.sensors.weather);
    this.ping = new PingSource(config.sensors.ping);
    this.processes = new ProcessesSource(config.sensors.processes);
    this.history = new History({
      windowSec: Math.max(60, (config.ui?.history?.windowMinutes ?? 15) * 60),
      points: config.ui?.history?.points ?? 60,
      thresholds: config.thresholds,
    });
    this.fastTimer = null;
    this.slowTimer = null;
    this.lastSnapshot = null;
  }

  async start() {
    this.nvidia.start();
    this.nowPlaying.start();
    this.netStats.start();
    this.weather.start();
    this.ping.start();
    this.processes.start();
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
    const snapshot = this.buildSnapshot();
    // Recorded before the trend block is attached, so history never folds its
    // own output back into itself.
    this.history.push(snapshot);
    snapshot.history = this.history.read();
    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);
  }

  buildSnapshot() {
    const sys = this.system.read();
    const gpu = this.nvidia.read();
    const lhm = this.lhm.read();
    const media = this.nowPlaying.read();
    const net = this.netStats.read();
    const weather = this.weather.read();
    const ping = this.ping.read();
    const procs = this.processes.read();

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
        fanLabel: l.cpuFanLabel ?? null,
        fanPinned: l.cpuFanPinned ?? false,
        fans: l.fans ?? [],
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

      // Get-NetAdapterStatistics is authoritative; systeminformation is only a
      // fallback for when the helper has not produced a sample yet, and it
      // silently reports zero for any adapter whose name contains a space.
      net: net.available
        ? {
            iface: net.data.iface,
            rxBps: net.data.rxBps,
            txBps: net.data.txBps,
          }
        : {
            iface: s.netIface ?? null,
            rxBps: s.netRxBps ?? null,
            txBps: s.netTxBps ?? null,
          },

      disks: s.disks ?? [],

      // Drive temperatures ride along in the LHM feed; empty when it is absent.
      drives: l.drives ?? [],

      // Read/write rates, endurance and free space, also from the LHM feed.
      // Windows gives systeminformation nothing here - fsStats() and disksIO()
      // both return null - so this is the only source of disk throughput.
      storage: l.storage ?? [],

      // Which processes are actually responsible for the numbers above.
      processes: procs.data ?? null,

      weather: weather.data ?? null,
      ping: ping.data ?? null,

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
        net: { ok: net.available, reason: net.reason },
        weather: { ok: weather.available, reason: weather.reason },
        processes: { ok: procs.available, reason: procs.reason },
      },
    };
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.nvidia.stop();
    this.nowPlaying.stop();
    this.netStats.stop();
    this.weather.stop();
    this.ping.stop();
    this.processes.stop();
  }
}

module.exports = { SensorHub };
