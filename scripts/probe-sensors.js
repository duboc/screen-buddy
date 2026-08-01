'use strict';

/**
 * Prints one sensor snapshot and exits — the fast way to tell whether a missing
 * value is a UI bug or a sensor that simply is not reporting.
 *
 *   npm run probe
 *
 * Runs in plain Node; none of the sensor modules depend on Electron.
 */

const configLoader = require('../src/main/config');
const { SensorHub } = require('../src/main/sensors');

const DASH = '--';
const show = (v, digits = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : DASH;

async function main() {
  const config = configLoader.load();
  const hub = new SensorHub(config);

  await hub.start();
  // One extra beat: networkStats and currentLoad are delta-based, so the first
  // sample has no previous reading to diff against and always reads zero.
  await new Promise((r) => setTimeout(r, config.polling.fastMs + 250));

  const s = hub.buildSnapshot();
  hub.stop();

  const line = (label, value) => console.log(`  ${label.padEnd(14)} ${value}`);

  console.log('\nSOURCES');
  for (const [name, state] of Object.entries(s.sources)) {
    line(name, state.ok ? 'ok' : `unavailable - ${state.reason}`);
  }

  console.log('\nCPU');
  line('model', s.cpu.brand ?? DASH);
  line('threads', s.cpu.cores ?? DASH);
  line('load', `${show(s.cpu.load)} %`);
  line('clock', `${show(s.cpu.clockMHz, 0)} MHz`);
  line('temp', `${show(s.cpu.tempC)} C  ${s.cpu.tempLabel ?? ''}`);
  line('power', `${show(s.cpu.powerW)} W`);
  line(
    'fan',
    `${show(s.cpu.fanRpm, 0)} RPM  ${s.cpu.fanLabel ?? ''}${
      s.cpu.fanLabel && !s.cpu.fanPinned ? '  (auto-picked - see below)' : ''
    }`,
  );

  console.log('\nGPU');
  line('model', s.gpu.name ?? DASH);
  line('load', `${show(s.gpu.load)} %`);
  line('clock', `${show(s.gpu.clockMHz, 0)} MHz`);
  line('temp', `${show(s.gpu.tempC)} C`);
  line('power', `${show(s.gpu.powerW)} / ${show(s.gpu.powerLimitW)} W`);
  line('vram', `${show(s.gpu.memUsedMB, 0)} / ${show(s.gpu.memTotalMB, 0)} MB`);
  line('fan', `${show(s.gpu.fanPct)} %`);

  console.log('\nMEMORY');
  const g = 1024 ** 3;
  line(
    'used',
    `${show(s.mem.usedBytes / g)} / ${show(s.mem.totalBytes / g)} GB  (${show(s.mem.pct)} %)`,
  );

  console.log('\nNETWORK');
  line('interface', s.net.iface ?? DASH);
  line('rx', `${show(s.net.rxBps / 1024)} KB/s`);
  line('tx', `${show(s.net.txBps / 1024)} KB/s`);

  console.log('\nDISKS');
  for (const d of s.disks) {
    line(d.mount, `${show(d.pct)} % of ${show(d.sizeBytes / g, 0)} GB`);
  }

  if (s.cpu.fans.length) {
    console.log('\nFAN HEADERS');
    for (const f of s.cpu.fans) {
      const mark = f.name === s.cpu.fanLabel ? ' <- shown on the HUD' : '';
      line(f.name, `${show(f.rpm, 0)} RPM${mark}`);
    }
    if (!s.cpu.fanPinned) {
      console.log(
        '\n  The CPU fan was auto-picked (first header with a non-zero speed).',
      );
      console.log(
        '  Many boards label every header generically, so this can be a case fan.',
      );
      console.log(
        '  Pin the right one with sensors.libreHardwareMonitor.fanSensor in config.json.',
      );
    }
  }

  if (!s.sources.lhm.ok) {
    console.log(
      '\nNote: CPU temperature, CPU power and fan RPM come from LibreHardwareMonitor.',
    );
    console.log(
      '      Install it, enable Options > Remote Web Server > Run, and run it as',
    );
    console.log(
      '      Administrator to fill those fields in, or run:',
    );
    console.log(
      '        .\\scripts\\setup-windows.ps1 -InstallLhm -LhmAutoStart',
    );
  }

  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
