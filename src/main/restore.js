'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Restore points for config.json.
 *
 * What was here before was a single `config.json.bak`, overwritten on every
 * save. That is a safety net that catches exactly one mistake: make two edits
 * and the state you actually wanted back is gone. This keeps a rolling set of
 * automatic snapshots plus any number of pinned ones, and can always fall back
 * to the shipped template, which is tracked in git and therefore cannot be lost.
 *
 * Three properties matter more than features here:
 *
 *   1. It works with the app stopped. Restore points are plain JSON files in a
 *      plain directory with the timestamp in the name, so `scripts/config-
 *      restore.js` — or a file manager, or `copy` — can do the job when the HUD
 *      will not start. A backup you can only reach through the thing that is
 *      broken is not a backup.
 *   2. Restoring is itself undoable. Every restore snapshots the current file
 *      first, so picking the wrong restore point costs nothing.
 *   3. There is always at least one option. Even with the whole directory
 *      deleted, "shipped defaults" is synthesised from config.example.json, and
 *      failing that from the defaults compiled into the app.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const USER_CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE_CONFIG = path.join(ROOT, 'config.example.json');
const DIR = path.join(ROOT, 'config.backups');

/** How many automatic snapshots to keep. Pinned ones are never pruned. */
const KEEP_AUTO = 12;

const SHIPPED = 'shipped-defaults';

/** Timestamp that sorts lexicographically and is legal in a Windows filename. */
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');

/** Labels go in the filename, so they have to survive being one. */
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

/** `auto--<stamp>.json` or `pinned--<stamp>--<label>.json` */
function parseName(file) {
  const m = /^(auto|pinned)--([0-9TZ-]+?)(?:--(.*))?\.json$/.exec(file);
  if (!m) return null;
  // The stamp is written with ':' and '.' replaced by '-'; put them back so it
  // parses as a date again.
  const iso = m[2].replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const at = Date.parse(iso);
  return {
    id: file.replace(/\.json$/, ''),
    file,
    kind: m[1],
    label: m[3] ? m[3].replace(/-/g, ' ') : '',
    at: Number.isFinite(at) ? at : null,
  };
}

/**
 * Every restore point, newest first, with the shipped template pinned to the
 * end so there is always a floor to fall back to.
 */
function list() {
  let entries = [];
  try {
    entries = fs
      .readdirSync(DIR)
      .map(parseName)
      .filter(Boolean)
      .map((e) => {
        let bytes = null;
        try {
          bytes = fs.statSync(path.join(DIR, e.file)).size;
        } catch {}
        return { ...e, bytes };
      })
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  } catch {
    // No directory yet is not an error — it just means nothing has been saved.
  }

  entries.push({
    id: SHIPPED,
    file: null,
    kind: 'shipped',
    label: 'Shipped defaults',
    at: null,
    bytes: null,
  });
  return entries;
}

/** The JSON text a restore point would write. */
function read(id) {
  if (id === SHIPPED) {
    // config.example.json is tracked in git, so it is the one file that cannot
    // be lost by anything the app does. Used verbatim, comments and all.
    if (fs.existsSync(EXAMPLE_CONFIG)) return fs.readFileSync(EXAMPLE_CONFIG, 'utf8');
    // Last resort: the defaults compiled into the app. Reached only if the
    // template has been deleted from the checkout.
    const { DEFAULTS } = require('./config');
    return `${JSON.stringify(
      {
        $comment:
          'Regenerated from the defaults built into screen-buddy, because config.example.json was missing.',
        ...DEFAULTS,
      },
      null,
      2,
    )}\n`;
  }

  const entry = list().find((e) => e.id === id);
  if (!entry || !entry.file) throw new Error(`no such restore point: ${id}`);
  return fs.readFileSync(path.join(DIR, entry.file), 'utf8');
}

/** Drop the oldest automatic snapshots past the keep limit. */
function prune() {
  const autos = list().filter((e) => e.kind === 'auto');
  for (const old of autos.slice(KEEP_AUTO)) {
    try {
      fs.unlinkSync(path.join(DIR, old.file));
    } catch {}
  }
}

/**
 * Copy the current config.json into the backup directory.
 * Returns the new entry, or null when there is nothing to snapshot.
 */
function snapshot({ kind = 'auto', label = '', now = new Date() } = {}) {
  if (!fs.existsSync(USER_CONFIG)) return null;
  ensureDir();

  const suffix = label ? `--${slug(label)}` : '';
  const file = `${kind}--${stamp(now)}${suffix}.json`;
  fs.copyFileSync(USER_CONFIG, path.join(DIR, file));
  if (kind === 'auto') prune();
  return parseName(file);
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Replace config.json with a restore point.
 *
 * The current file is snapshotted first and unconditionally, so restoring the
 * wrong thing is never a dead end — the state you just left is at the top of
 * the list.
 */
function restore(id) {
  const text = read(id);
  // Parsed before anything is overwritten: a corrupt restore point should fail
  // here, with the live config still in place, rather than halfway through.
  JSON.parse(text);

  const previous = snapshot({ kind: 'auto', label: 'before restore' });
  writeAtomic(USER_CONFIG, text);
  return { restored: id, previous: previous?.id ?? null };
}

/**
 * Drop config.json back to the shipped template.
 *
 * `scope: 'appearance'` removes only the keys that describe how the panel
 * looks, leaving display, window and sensor setup alone — that is the reset
 * people actually want after an evening of experimenting with themes, and a
 * full reset that also un-pins their monitor is a punishment rather than a fix.
 */
function reset({ scope = 'all' } = {}) {
  if (scope === 'all') return restore(SHIPPED);

  const previous = snapshot({ kind: 'auto', label: 'before reset' });
  let raw = {};
  if (fs.existsSync(USER_CONFIG)) {
    try {
      raw = JSON.parse(fs.readFileSync(USER_CONFIG, 'utf8'));
    } catch {
      // An unparseable file has nothing worth preserving; take the template.
      return restore(SHIPPED);
    }
  }
  // Deleting the keys rather than writing defaults into them means the merge
  // falls through to config.example.json and then to the built-in defaults, so
  // "reset" means the same thing here as it does on a fresh clone.
  for (const key of ['theme', 'ui', '$theme']) delete raw[key];

  writeAtomic(USER_CONFIG, `${JSON.stringify(raw, null, 2)}\n`);
  return { restored: 'shipped-appearance', previous: previous?.id ?? null };
}

/** A snapshot the user asked for by name, exempt from pruning. */
const pin = (label) => snapshot({ kind: 'pinned', label: label || 'checkpoint' });

const remove = (id) => {
  const entry = list().find((e) => e.id === id);
  if (!entry || !entry.file) throw new Error(`cannot delete: ${id}`);
  fs.unlinkSync(path.join(DIR, entry.file));
};

module.exports = {
  list,
  read,
  snapshot,
  restore,
  reset,
  pin,
  remove,
  paths: { DIR, USER_CONFIG, EXAMPLE_CONFIG },
  SHIPPED,
  KEEP_AUTO,
};
