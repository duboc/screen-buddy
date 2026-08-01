'use strict';

/**
 * OPTIONAL source: LibreHardwareMonitor's built-in web server.
 *
 * Why it exists: Windows does not expose AMD desktop CPU package temperature or
 * CPU power draw through any public API. WMI's MSAcpi_ThermalZoneTemperature is
 * absent or meaningless on most desktop boards. LHM reads the Zen SMU directly,
 * so it is the only practical way to get a real Tctl/Tdie number.
 *
 * Setup: install LibreHardwareMonitor, Options > Remote Web Server > Run,
 * and run it elevated (unelevated it silently reports far fewer sensors).
 *
 * Everything here is best-effort. If LHM is not running, `read()` reports
 * unavailable and the HUD renders those fields as "--".
 */

/**
 * LHM formats its values for display using the machine's locale, so the same
 * sensor reads "63.9 °C" on en-US and "63,9 °C" on pt-BR or de-DE — and with
 * grouping, "5,530.0 MHz" versus "5.530,0 MHz".
 *
 * Assuming a comma is always a thousands separator is therefore wrong, and
 * wrong in the worst way: "63,9 °C" silently becomes 639 °C, and "109,9 W"
 * becomes 1099 W. The numbers stay plausible-looking enough to render.
 *
 * So detect the decimal separator from the runtime's own locale — LHM (.NET)
 * and Electron (ICU) both follow the Windows user locale — then treat the other
 * separator as grouping and discard it.
 */
const DECIMAL_SEPARATOR = (() => {
  try {
    const part = new Intl.NumberFormat()
      .formatToParts(1.1)
      .find((p) => p.type === 'decimal');
    return part ? part.value : '.';
  } catch {
    return '.';
  }
})();

const GROUP_SEPARATOR = DECIMAL_SEPARATOR === ',' ? '.' : ',';

function parseValue(raw) {
  if (typeof raw !== 'string') return null;

  // Grab the numeric run, allowing either separator and any spacing inside it.
  const m = raw.match(/-?[\d.,   ]*\d/);
  if (!m) return null;

  const normalized = m[0]
    .split(GROUP_SEPARATOR)
    .join('')
    .replace(/[\s  ]/g, '')
    .replace(DECIMAL_SEPARATOR, '.');

  const v = Number.parseFloat(normalized);
  return Number.isFinite(v) ? v : null;
}

/** Walk the nested Children tree into a flat list of leaf sensors. */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.SensorId && node.Type) {
    out.push({
      id: String(node.SensorId),
      text: String(node.Text ?? ''),
      type: String(node.Type),
      value: parseValue(node.Value),
      max: parseValue(node.Max),
    });
  }
  if (Array.isArray(node.Children)) {
    for (const child of node.Children) flatten(child, out);
  }
  return out;
}

/** First sensor satisfying `predicate`, in the order the candidates are listed. */
function pickFirst(sensors, predicates) {
  for (const predicate of predicates) {
    const hit = sensors.find((s) => s.value !== null && predicate(s));
    if (hit) return hit;
  }
  return null;
}

const isCpuNode = (s) => /\/(amdcpu|intelcpu|cpu)\/\d+\//i.test(s.id);

function extract(sensors) {
  const cpuTemp = pickFirst(sensors, [
    // Preference order matters: Tctl/Tdie is the number enthusiasts quote,
    // "CPU Package" is the Intel equivalent, then any CPU-ish temperature.
    (s) => s.type === 'Temperature' && isCpuNode(s) && /tctl|tdie/i.test(s.text),
    (s) => s.type === 'Temperature' && isCpuNode(s) && /package/i.test(s.text),
    (s) => s.type === 'Temperature' && isCpuNode(s) && /^core average$/i.test(s.text),
    (s) => s.type === 'Temperature' && isCpuNode(s),
    (s) => s.type === 'Temperature' && /cpu/i.test(s.text),
  ]);

  const cpuPower = pickFirst(sensors, [
    (s) => s.type === 'Power' && isCpuNode(s) && /^(cpu )?package$/i.test(s.text),
    (s) => s.type === 'Power' && isCpuNode(s) && /package|total/i.test(s.text),
    (s) => s.type === 'Power' && isCpuNode(s),
  ]);

  // Boost clock is the interesting figure, so take the fastest core rather than
  // an average that idle cores would drag down.
  const coreClocks = sensors.filter(
    (s) => s.type === 'Clock' && isCpuNode(s) && /core/i.test(s.text) && s.value,
  );
  const cpuClockMHz = coreClocks.length
    ? Math.max(...coreClocks.map((s) => s.value))
    : null;

  const cpuVolts = pickFirst(sensors, [
    (s) => s.type === 'Voltage' && isCpuNode(s) && /core|vid|svi/i.test(s.text),
    (s) => s.type === 'Voltage' && isCpuNode(s),
  ]);

  const cpuFan = pickFirst(sensors, [
    (s) => s.type === 'Fan' && /cpu/i.test(s.text),
    (s) => s.type === 'Fan' && s.value > 0,
  ]);

  const mobo = pickFirst(sensors, [
    (s) => s.type === 'Temperature' && /motherboard|system|systin/i.test(s.text),
    (s) => s.type === 'Temperature' && /\/lpc\//i.test(s.id),
  ]);

  return {
    cpuTempC: cpuTemp?.value ?? null,
    cpuTempLabel: cpuTemp?.text ?? null,
    cpuPowerW: cpuPower?.value ?? null,
    cpuClockMHz,
    cpuVolts: cpuVolts?.value ?? null,
    cpuFanRpm: cpuFan?.value ?? null,
    cpuFanLabel: cpuFan?.text ?? null,
    moboTempC: mobo?.value ?? null,
    sensorCount: sensors.length,
  };
}

class LhmSource {
  constructor({ enabled = true, url = 'http://127.0.0.1:8085/data.json', timeoutMs = 1500 } = {}) {
    this.enabled = enabled;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.latest = null;
    this.available = false;
    this.reason = 'not polled yet';
    this.inFlight = false;
  }

  async poll() {
    if (!this.enabled || this.inFlight) return;
    this.inFlight = true;
    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sensors = flatten(await res.json());
      if (!sensors.length) throw new Error('no sensors in response');
      this.latest = extract(sensors);
      this.available = true;
      this.reason = null;
    } catch (err) {
      this.available = false;
      // ECONNREFUSED is the overwhelmingly common case (LHM simply not running),
      // so say something the user can act on instead of surfacing errno noise.
      this.reason = /ECONNREFUSED|fetch failed/i.test(err.message)
        ? 'LibreHardwareMonitor not running'
        : err.message;
    } finally {
      this.inFlight = false;
    }
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    return {
      available: this.available,
      reason: this.reason,
      data: this.available ? this.latest : null,
    };
  }
}

module.exports = { LhmSource, flatten, extract, parseValue };
