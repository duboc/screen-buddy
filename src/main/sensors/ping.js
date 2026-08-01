'use strict';

const net = require('node:net');

/**
 * Internet reachability and latency.
 *
 * Measures the time to complete a TCP handshake rather than shelling out to
 * ping.exe. Two reasons:
 *   - No process spawn per sample. ping.exe costs 150-300ms of startup to
 *     measure something that takes 10ms.
 *   - ICMP is filtered or deprioritised on plenty of networks, so a failed
 *     ICMP ping does not reliably mean "no internet", whereas a refused TCP
 *     connection to a well-known host on 443 is a much better proxy for what
 *     the user actually cares about: can this machine reach the internet.
 *
 * The number is one round trip (SYN -> SYN/ACK), so it is directly comparable
 * to an ICMP round-trip time, give or take the remote host's accept latency.
 */
class PingSource {
  constructor({
    enabled = true,
    host = '1.1.1.1',
    port = 443,
    intervalMs = 10_000,
    timeoutMs = 3000,
    samples = 3,
  } = {}) {
    this.enabled = enabled;
    this.host = host;
    this.port = port;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    // Keep a short rolling window and report the median, so one unlucky
    // sample does not make the panel look like the network is falling over.
    this.window = [];
    this.samples = Math.max(1, samples);

    this.latest = null;
    this.available = false;
    this.reason = 'not measured yet';
    this.timer = null;
    this.inFlight = false;
    // The very first outbound connection in a fresh process pays one-off costs
    // (route and ARP resolution, socket pool warm-up) that have nothing to do
    // with network latency - measured at 168ms against a link that actually
    // round-trips in 8ms. Throw the first sample away rather than showing it.
    this.warmedUp = false;
  }

  start() {
    if (!this.enabled) return;
    this.measure();
    this.timer = setInterval(() => this.measure(), this.intervalMs);
  }

  measure() {
    if (this.inFlight) return;
    this.inFlight = true;

    const started = process.hrtime.bigint();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ms, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      this.inFlight = false;

      if (ms === null) {
        this.window = [];
        this.available = false;
        this.reason = reason;
        this.latest = null;
        return;
      }

      // Discard the warm-up sample, but note that the host is reachable.
      if (!this.warmedUp) {
        this.warmedUp = true;
        this.reason = 'warming up';
        // Re-measure immediately so a real figure appears within a second
        // rather than after a full interval.
        setTimeout(() => this.measure(), 250);
        return;
      }

      this.window.push(ms);
      if (this.window.length > this.samples) this.window.shift();

      const sorted = [...this.window].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      this.latest = { ms: median, host: this.host, last: ms };
      this.available = true;
      this.reason = null;
    };

    socket.setTimeout(this.timeoutMs);
    socket.once('connect', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      finish(ms, null);
    });
    socket.once('timeout', () => finish(null, 'timed out'));
    socket.once('error', (err) =>
      finish(
        null,
        /ENOTFOUND|EAI_AGAIN/.test(err.code) ? 'DNS failure' : (err.code ?? 'unreachable'),
      ),
    );

    try {
      socket.connect(this.port, this.host);
    } catch (err) {
      finish(null, err.message);
    }
  }

  read() {
    if (!this.enabled) return { available: false, reason: 'disabled', data: null };
    if (!this.available) return { available: false, reason: this.reason, data: null };
    return { available: true, reason: null, data: this.latest };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { PingSource };
