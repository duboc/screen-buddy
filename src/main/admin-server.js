'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const schema = require('./schema');
const configLoader = require('./config');

const ADMIN_ROOT = path.resolve(__dirname, '..', 'admin');
// The editor reads the base themes' custom properties straight out of the
// stylesheets rather than keeping its own copy of every default colour, so a
// theme edited in CSS shows up in the editor with no second edit.
const THEME_ROOT = path.resolve(__dirname, '..', 'renderer', 'styles');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

const isLoopback = (host) => LOOPBACK.has(String(host).replace(/^\[|\]$/g, ''));

/**
 * The admin is a small local HTTP service, which means it is reachable by any
 * process on the machine and by any web page the user has open. Three guards,
 * each closing a different door:
 *
 *   1. Host header allowlist. A page on evil.example can point a DNS name at
 *      127.0.0.1 and have the browser connect here; the request still carries
 *      the attacker's hostname in Host, and gets refused.
 *   2. Origin check on writes. A cross-site form or fetch cannot change the
 *      Origin header, so requiring it to be same-origin stops a page you have
 *      open from silently rewriting your config.
 *   3. A shared token, mandatory whenever the service is bound to anything
 *      other than loopback. Nothing on the LAN gets in without it.
 *
 * No CORS headers are ever sent, so even a permitted connection cannot have its
 * response read by another origin's JavaScript.
 */
class AdminServer {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig      current merged config
   * @param {() => object|null} opts.getSnapshot latest sensor snapshot
   * @param {(patch) => object} opts.applyPatch persist a patch, return new config
   * @param {(patch) => void} opts.preview      push a patch to the HUD without saving
   * @param {(action) => object} opts.action    run a named side-effect
   * @param {object} opts.restore               config restore points
   */
  constructor(opts) {
    this.opts = opts;
    this.server = null;
    this.url = null;
    this.token = null;
    this.allowedHosts = new Set();
  }

  async start() {
    const cfg = this.opts.getConfig();
    const admin = cfg.admin ?? {};
    if (admin.enabled === false) return null;

    const host = admin.host || '127.0.0.1';
    const port = Number(admin.port) || 8787;

    if (!isLoopback(host)) {
      if (!admin.token) {
        // Refusing is the only honest option: silently generating a token would
        // leave a config editor listening on the network that the user cannot
        // reach and did not know was there.
        console.error(
          `[admin] refusing to bind ${host}: a non-loopback bind requires admin.token to be set. Falling back to 127.0.0.1.`,
        );
        return this.#listen('127.0.0.1', port);
      }
      this.token = String(admin.token);
    } else if (admin.token) {
      this.token = String(admin.token);
    }

    return this.#listen(host, port);
  }

  #listen(host, port) {
    this.allowedHosts = new Set([
      `${host}:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);

    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        console.error('[admin]', err);
        this.#json(res, 500, { error: err.message });
      });
    });

    return new Promise((resolve) => {
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(
            `[admin] port ${port} is already in use — settings will not be reachable. Change admin.port in config.json.`,
          );
        } else {
          console.error('[admin] failed to start:', err.message);
        }
        this.server = null;
        resolve(null);
      });

      this.server.listen(port, host, () => {
        const shown = isLoopback(host) ? '127.0.0.1' : host;
        this.url = `http://${shown}:${port}/${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
        console.log(`[admin] settings at ${this.url}`);
        resolve(this.url);
      });
    });
  }

  stop() {
    this.server?.close();
    this.server = null;
  }

  /* ── request handling ──────────────────────────────────────── */

  #authorised(req) {
    if (!this.allowedHosts.has(String(req.headers.host).toLowerCase())) {
      return 'bad host';
    }
    if (this.token) {
      const url = new URL(req.url, 'http://localhost');
      const supplied = req.headers['x-admin-token'] ?? url.searchParams.get('token');
      // Constant-time: a plain === on a secret leaks its prefix to a patient
      // caller, and this one is reachable over the network by design.
      if (!supplied || !safeEqual(String(supplied), this.token)) return 'bad token';
    }
    return null;
  }

  async #handle(req, res) {
    const denied = this.#authorised(req);
    if (denied) {
      this.#json(res, 403, { error: `forbidden: ${denied}` });
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (route.startsWith('/api/')) {
      // Writes additionally require a same-origin Origin header. Browsers set
      // it on every cross-origin fetch and forbid scripts from changing it, so
      // this is what keeps a random open tab from POSTing here.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) {
          const ok = this.allowedHosts.has(new URL(origin).host.toLowerCase());
          if (!ok) {
            this.#json(res, 403, { error: 'forbidden: cross-origin write' });
            return;
          }
        }
      }
      await this.#api(req, res, route);
      return;
    }

    await this.#static(res, route);
  }

  async #api(req, res, route) {
    if (route === '/api/state' && req.method === 'GET') {
      this.#json(res, 200, {
        config: this.opts.getConfig(),
        defaults: configLoader.DEFAULTS,
        schema: {
          form: schema.FORM,
          themes: schema.THEMES,
          fonts: schema.FONT_STACKS,
          tokens: schema.THEME_TOKENS,
          panels: schema.PANELS,
          transitions: schema.TRANSITIONS,
          pageConditions: schema.PAGE_CONDITIONS,
          defaultPages: schema.DEFAULT_PAGES,
        },
        snapshot: this.opts.getSnapshot(),
      });
      return;
    }

    if (route === '/api/snapshot' && req.method === 'GET') {
      this.#json(res, 200, { snapshot: this.opts.getSnapshot() });
      return;
    }

    if (route === '/api/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const { patch, rejected } = configLoader.sanitizePatch(body);
      this.opts.preview(patch);
      this.#json(res, 200, { ok: true, rejected });
      return;
    }

    if (route === '/api/config' && req.method === 'PUT') {
      const body = await readBody(req);
      const { patch, rejected } = configLoader.sanitizePatch(body);
      const config = this.opts.applyPatch(patch);
      this.#json(res, 200, { ok: true, config, rejected });
      return;
    }

    if (route === '/api/restore-points' && req.method === 'GET') {
      this.#json(res, 200, { points: this.opts.restore.list() });
      return;
    }

    if (route === '/api/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const result = this.opts.restore.apply(String(body.id ?? ''));
      this.#json(res, 200, { ok: true, ...result });
      return;
    }

    if (route === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req);
      const scope = body.scope === 'all' ? 'all' : 'appearance';
      this.#json(res, 200, { ok: true, ...this.opts.restore.reset(scope) });
      return;
    }

    if (route === '/api/checkpoint' && req.method === 'POST') {
      const body = await readBody(req);
      const entry = this.opts.restore.pin(String(body.label ?? ''));
      this.#json(res, entry ? 200 : 400, entry ? { ok: true, entry } : { error: 'nothing to pin' });
      return;
    }

    if (route === '/api/restore-delete' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        this.opts.restore.remove(String(body.id ?? ''));
      } catch (err) {
        // Refusing to delete the shipped floor, or a name that does not exist,
        // is the caller being wrong rather than the server breaking. A 500 with
        // a stack trace in the log would suggest otherwise.
        this.#json(res, 400, { error: err.message });
        return;
      }
      this.#json(res, 200, { ok: true, points: this.opts.restore.list() });
      return;
    }

    if (route === '/api/action' && req.method === 'POST') {
      const body = await readBody(req);
      const result = this.opts.action(String(body.action ?? ''));
      this.#json(res, result.ok ? 200 : 400, result);
      return;
    }

    this.#json(res, 404, { error: 'no such endpoint' });
  }

  async #static(res, route) {
    const rel = decodeURIComponent(route === '/' ? '/index.html' : route).replace(
      /^\/+/,
      '',
    );

    // Two roots, and only two: the editor's own files, and the read-only theme
    // stylesheets it parses for default colours.
    const themed = rel.startsWith('themes/');
    const root = themed ? THEME_ROOT : ADMIN_ROOT;
    const target = path.resolve(root, themed ? rel.slice('themes/'.length) : rel);

    // Refuse anything that escapes its root, the same guard the renderer's
    // app:// handler uses.
    if (target !== root && !target.startsWith(root + path.sep)) {
      this.#json(res, 403, { error: 'forbidden' });
      return;
    }

    let body;
    try {
      body = await fsp.readFile(target);
    } catch {
      this.#json(res, 404, { error: 'not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // The admin loads nothing from anywhere else; 'unsafe-inline' covers the
      // style attributes used for colour swatches and font previews.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  }

  #json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A config patch is a few kilobytes. Anything past 256 KB is either a bug
      // or someone trying to fill memory.
      if (size > 256 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { AdminServer, ADMIN_ROOT, isLoopback };
