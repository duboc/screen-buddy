'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * "Now playing", read from the Windows global media session.
 *
 * This is the OS-level session behind the volume-flyout media controls, so it
 * reports whatever is actually playing — Spotify, a browser tab, VLC — with no
 * API key, no OAuth and no per-application integration.
 *
 * Same shape as the nvidia-smi source: one long-lived helper process streaming
 * a JSON line per poll, rather than a spawn per tick. A PowerShell spawn costs
 * 200-400ms, which would be most of a poll interval.
 *
 * Windows PowerShell 5.1 specifically (powershell.exe, not pwsh) — PowerShell 7
 * dropped the WinRT type projection the script depends on.
 */

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'nowplaying-loop.ps1');

class NowPlayingSource {
  constructor({ enabled = true, intervalMs = 2000 } = {}) {
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.latest = null;
    this.available = false;
    this.reason = 'starting';
    this.proc = null;
    this.stopped = false;
    this.restartTimer = null;
    // Timestamp of the last line, used to interpolate playback position
    // between polls so the progress bar advances smoothly at 1Hz.
    this.receivedAt = 0;
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
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.consume(line);
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

  consume(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a partial or non-JSON line; the next one will be fine
    }

    if (!msg.ok) {
      this.fail(msg.error || 'media session error');
      return;
    }

    this.available = true;
    this.reason = null;
    this.receivedAt = Date.now();

    if (!msg.active) {
      this.latest = null;
      return;
    }

    this.latest = {
      playing: Boolean(msg.playing),
      status: msg.status ?? null,
      title: msg.title || null,
      artist: msg.artist || null,
      album: msg.album || null,
      app: cleanAppName(msg.app),
      posSec: Number.isFinite(msg.posSec) ? msg.posSec : null,
      endSec: Number.isFinite(msg.endSec) && msg.endSec > 0 ? msg.endSec : null,
      trackKey: msg.trackKey ?? null,
    };
  }

  fail(message) {
    this.available = false;
    this.reason = message;
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    if (!this.available) return { available: false, reason: this.reason, data: null };
    if (!this.latest) return { available: true, reason: null, data: null };

    // The helper polls every couple of seconds but the HUD redraws every
    // second; advance the position locally so the progress bar does not
    // visibly stutter between updates.
    const data = { ...this.latest };
    if (data.playing && data.posSec !== null) {
      const drift = (Date.now() - this.receivedAt) / 1000;
      data.posSec = data.endSec
        ? Math.min(data.endSec, data.posSec + drift)
        : data.posSec + drift;
    }
    return { available: true, reason: null, data };
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

/** "Spotify.exe" -> "Spotify"; AUMIDs like "Microsoft.Edge_8wek…!App" -> "Edge". */
function cleanAppName(raw) {
  if (!raw) return null;
  let name = String(raw);
  name = name.split('!')[0];
  name = name.replace(/\.exe$/i, '');
  name = name.split('_')[0];
  const parts = name.split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

module.exports = { NowPlayingSource };
