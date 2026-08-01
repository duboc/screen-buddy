'use strict';

const si = require('systeminformation');

/**
 * Baseline source, always available, no elevation and no third-party app.
 *
 * Covers CPU load (overall and per-core), memory, network throughput, disks and
 * OS facts. Deliberately does NOT try to read CPU temperature here — on Windows
 * `si.cpuTemperature()` falls back to WMI's MSAcpi_ThermalZoneTemperature, which
 * on desktop AMD boards is either missing or reports a chipset sensor that reads
 * ~20 C low. Temperature comes from the LHM source instead; if that is absent we
 * show "--" rather than a confidently wrong number.
 */

/** Split metrics by cost: cheap ones every tick, expensive ones rarely. */
class SystemSource {
  constructor({ interface: ifaceOverride = null } = {}) {
    this.ifaceOverride = ifaceOverride;
    this.iface = ifaceOverride;
    this.fast = null;
    this.slow = null;
    this.staticInfo = null;
    this.available = false;
    this.reason = 'not polled yet';
    this.fastInFlight = false;
    this.slowInFlight = false;
  }

  async init() {
    const [cpu, os, iface] = await Promise.all([
      si.cpu(),
      si.osInfo(),
      this.ifaceOverride ? Promise.resolve(this.ifaceOverride) : si.networkInterfaceDefault(),
    ]);
    this.iface = this.ifaceOverride || iface || null;
    this.staticInfo = {
      // "AMD Ryzen 9 9950X3D 16-Core Processor" is too long for the panel and
      // the core count is already shown by the thread grid.
      cpuBrand: `${cpu.manufacturer} ${cpu.brand}`
        .replace(/\s*\d+-Core Processor\s*$/i, '')
        .replace(/\s*\bCPU\b\s*@.*$/i, '')
        .replace(/\(R\)|\(TM\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
      cpuCores: cpu.cores,
      cpuPhysicalCores: cpu.physicalCores,
      cpuBaseGHz: Number.parseFloat(cpu.speed) || null,
      host: os.hostname,
      os: `${os.distro} ${os.release}`.trim(),
      arch: os.arch,
    };
    await this.pollSlow();
  }

  async pollFast() {
    if (this.fastInFlight) return;
    this.fastInFlight = true;
    try {
      const [load, mem, speed, net] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.cpuCurrentSpeed(),
        this.iface ? si.networkStats(this.iface) : Promise.resolve([]),
      ]);

      const n = Array.isArray(net) ? net[0] : null;

      this.fast = {
        cpuLoad: load.currentLoad,
        cpuLoadUser: load.currentLoadUser,
        cpuLoadSystem: load.currentLoadSystem,
        coreLoads: (load.cpus || []).map((c) => c.load),
        cpuClockGHz: speed.avg || null,
        cpuClockMaxGHz: speed.max || null,
        memUsedBytes: mem.active,
        memTotalBytes: mem.total,
        swapUsedBytes: mem.swapused,
        swapTotalBytes: mem.swaptotal,
        // rx_sec is null on the very first sample (no previous reading to diff).
        netRxBps: n && n.rx_sec >= 0 ? n.rx_sec : 0,
        netTxBps: n && n.tx_sec >= 0 ? n.tx_sec : 0,
        netIface: n?.iface ?? this.iface,
      };
      this.available = true;
      this.reason = null;
    } catch (err) {
      this.available = false;
      this.reason = err.message;
    } finally {
      this.fastInFlight = false;
    }
  }

  async pollSlow() {
    if (this.slowInFlight) return;
    this.slowInFlight = true;
    try {
      const disks = await si.fsSize();
      this.slow = {
        uptimeSec: si.time().uptime,
        disks: disks
          .filter((d) => d.size > 0 && /^[A-Z]:/i.test(d.mount || ''))
          .map((d) => ({
            mount: d.mount,
            usedBytes: d.used,
            sizeBytes: d.size,
            pct: d.use,
          })),
      };
    } catch (err) {
      // A failing disk enumeration should not blank out the whole panel.
      this.slow = this.slow || { uptimeSec: si.time().uptime, disks: [] };
    } finally {
      this.slowInFlight = false;
    }
  }

  read() {
    return {
      available: this.available,
      reason: this.reason,
      data: this.available
        ? { ...this.staticInfo, ...this.fast, ...this.slow }
        : null,
    };
  }
}

module.exports = { SystemSource };
