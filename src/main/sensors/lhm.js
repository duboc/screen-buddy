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

// Allows either decimal separator, and any spacing inside the number.
const NUMERIC_RUN = /-?[\d.,   ]*\d/;

function parseValue(raw) {
  if (typeof raw !== 'string') return null;

  const m = raw.match(NUMERIC_RUN);
  if (!m) return null;

  const normalized = m[0]
    .split(GROUP_SEPARATOR)
    .join('')
    .replace(/[\s  ]/g, '')
    .replace(DECIMAL_SEPARATOR, '.');

  const v = Number.parseFloat(normalized);
  return Number.isFinite(v) ? v : null;
}

/** Whatever trails the number: "°C", "%", "KB/s", "GB". */
function parseUnit(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(NUMERIC_RUN);
  if (!m) return null;
  return raw.slice(m.index + m[0].length).trim() || null;
}

const SCALE = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/**
 * Convert a value to bytes (or bytes per second) using the unit LHM printed
 * beside it.
 *
 * This has to read the unit and cannot be a fixed multiplier: LHM rescales
 * every reading independently, so one sensor reads "153,2 KB/s" on one poll and
 * "1,5 MB/s" on the next. Taking the bare number would rank the 1.5 MB/s write
 * as a hundred times smaller than the 153 KB/s one - a graph that moves
 * convincingly and is entirely wrong. Binary multiples, which is what LHM
 * formats with.
 */
function toBytes(value, unit) {
  if (value === null || value === undefined || !unit) return null;
  const m = /^([kmgt]?b)(\/s)?$/i.exec(unit.replace(/\s+/g, ''));
  if (!m) return null;
  return value * SCALE[m[1].toLowerCase()];
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
      unit: parseUnit(node.Value),
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

/* ── storage ───────────────────────────────────────────────
   Everything the drives publish is already in the feed fetched for the CPU, so
   it costs nothing extra. Worth having in full: Windows exposes no disk
   throughput through systeminformation at all - fsStats() and disksIO() both
   return null - so LHM is the only source of read/write rates here.

   LHM groups storage under /nvme/N/ or /hdd/N/. The flattener keeps only a
   sensor's own text and not its parent hardware node, whose model name is far
   too long for the panel anyway, so drives are numbered in the order LHM
   reports them. */

const STORAGE_ID = /\/(nvme|hdd|ssd|storage)\/(\d+)\//i;

function buildStorage(sensors) {
  const byDrive = new Map();
  for (const s of sensors) {
    const m = STORAGE_ID.exec(s.id);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}/${m[2]}`;
    if (!byDrive.has(key)) {
      byDrive.set(key, { kind: m[1].toLowerCase(), index: Number(m[2]), sensors: [] });
    }
    byDrive.get(key).sensors.push(s);
  }

  return [...byDrive.values()]
    .sort((a, b) => a.index - b.index)
    .map((drive, i) => {
      const of = (type, re) =>
        drive.sensors.find((s) => s.type === type && re.test(s.text) && s.value !== null);
      const val = (type, re) => of(type, re)?.value ?? null;
      const bytes = (type, re) => {
        const hit = of(type, re);
        return hit ? toBytes(hit.value, hit.unit) : null;
      };

      // NVMe drives publish their shutdown limits as temperature sensors:
      // "Warning Temperature" (99 C) and "Critical Temperature" (109 C) are
      // constants describing the hardware, not readings. Taking the hottest
      // sensor per drive picks those every time and reports a healthy 48 C
      // drive as 109 C. Composite is the NVMe spec's primary sensor and what
      // every other tool quotes, so prefer it explicitly.
      const temps = drive.sensors.filter(
        (s) =>
          s.type === 'Temperature' &&
          s.value !== null &&
          !/warning|critical|limit|threshold/i.test(s.text),
      );
      const temp =
        temps.find((s) => /composite/i.test(s.text)) ??
        temps.find((s) => /^temperature/i.test(s.text)) ??
        temps[0] ??
        null;

      return {
        label: `${drive.kind === 'nvme' ? 'NVME' : 'DISK'}${i}`,
        kind: drive.kind,
        tempC: temp?.value ?? null,
        readBps: bytes('Throughput', /read/i),
        writeBps: bytes('Throughput', /write/i),
        usedPct: val('Load', /used space/i),
        activityPct: val('Load', /total activity/i),
        // "Life" is the drive's own estimate of remaining endurance; a drive
        // reporting 6% left is the single most actionable number here and is
        // invisible everywhere else on this panel.
        lifePct: val('Level', /^life$/i),
        freeBytes: bytes('Data', /free space/i),
        totalBytes: bytes('Data', /total space/i),
        readTotalBytes: bytes('Data', /data read/i),
        writtenTotalBytes: bytes('Data', /data written/i),
      };
    });
}

const isCpuNode = (s) => /\/(amdcpu|intelcpu|cpu)\/\d+\//i.test(s.id);

function extract(sensors, { fanSensor = null } = {}) {
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

  // Fan choice, best effort in descending order of confidence:
  //   1. an exact name the user pinned in config (or its SensorId)
  //   2. a header the board actually calls "CPU"
  //   3. the first header reporting a non-zero speed
  // Step 3 is a genuine guess: plenty of boards label every header
  // "Fan #1".."Fan #7" with nothing to say which one cools the CPU, so the
  // fastest-spinning case fan can win. `npm run doctor` lists them all so the
  // user can pin the right one.
  const cpuFan = pickFirst(sensors, [
    ...(fanSensor
      ? [
          (s) =>
            s.type === 'Fan' &&
            (s.text.toLowerCase() === String(fanSensor).toLowerCase() ||
              s.id.toLowerCase() === String(fanSensor).toLowerCase()),
        ]
      : []),
    (s) => s.type === 'Fan' && /cpu/i.test(s.text),
    (s) => s.type === 'Fan' && s.value > 0,
  ]);

  // Flagged so the UI can mark an auto-picked fan as unverified rather than
  // presenting a guess as fact.
  const fanPinned =
    Boolean(fanSensor) && cpuFan
      ? cpuFan.text.toLowerCase() === String(fanSensor).toLowerCase() ||
        cpuFan.id.toLowerCase() === String(fanSensor).toLowerCase()
      : false;

  const mobo = pickFirst(sensors, [
    (s) => s.type === 'Temperature' && /motherboard|system|systin/i.test(s.text),
    (s) => s.type === 'Temperature' && /\/lpc\//i.test(s.id),
  ]);

  const storage = buildStorage(sensors);

  return {
    // Kept as its own field because the footer only ever wanted the
    // temperature, and it should not have to know about the rest.
    drives: storage
      .filter((d) => d.tempC !== null)
      .map((d) => ({ label: d.label, tempC: d.tempC })),
    storage,
    cpuTempC: cpuTemp?.value ?? null,
    cpuTempLabel: cpuTemp?.text ?? null,
    cpuPowerW: cpuPower?.value ?? null,
    cpuClockMHz,
    cpuVolts: cpuVolts?.value ?? null,
    cpuFanRpm: cpuFan?.value ?? null,
    cpuFanLabel: cpuFan?.text ?? null,
    cpuFanPinned: fanPinned,
    // Every fan the board exposes, so `npm run probe` can list them and the
    // user has something concrete to pin.
    fans: sensors
      .filter((s) => s.type === 'Fan')
      .map((s) => ({ name: s.text, rpm: s.value, id: s.id })),
    moboTempC: mobo?.value ?? null,
    sensorCount: sensors.length,
  };
}

class LhmSource {
  constructor({
    enabled = true,
    url = 'http://127.0.0.1:8085/data.json',
    timeoutMs = 1500,
    fanSensor = null,
  } = {}) {
    this.enabled = enabled;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.fanSensor = fanSensor;
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
      this.latest = extract(sensors, { fanSensor: this.fanSensor });
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

module.exports = { LhmSource, flatten, extract, parseValue, parseUnit, toBytes };
