#!/usr/bin/env node
/**
 * Re-validate every theme's status ramp against its own surface.
 *
 * The colours and the surface are read out of the stylesheets themselves, so
 * this cannot drift from what the panel actually renders — edit a hex in a
 * theme file and this run tells you whether it still passes. Both theme
 * headers quote their results; this is the command that reproduces them.
 *
 *   npm run themes
 *
 * Exits non-zero if any theme fails, so it can gate a commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validate } from './validate_palette.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { THEMES } = createRequire(import.meta.url)(path.join(ROOT, 'src/main/schema.js'));

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', GREY = '\x1b[90m', OFF = '\x1b[0m';

/** Pull the theme's own custom properties out of its stylesheet. */
function tokensOf(id) {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles', `theme-${id}.css`), 'utf8');
  const block = new RegExp(`body\\[data-theme=['"]${id}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!block) throw new Error(`theme block not found in theme-${id}.css`);
  // Comments first: these files are heavily annotated, and a comment between
  // two declarations would otherwise swallow the next one's name.
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const decl of body.split(';')) {
    const m = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(decl);
    if (m) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}

let failed = 0;
console.log('');

for (const theme of THEMES) {
  const t = tokensOf(theme.id);
  const ramp = [t['mark-nominal'], t['mark-warn'], t['mark-crit']];
  const surface = t.surface;

  // --pairs all rather than adjacent: three status steps are compared against
  // each other in every combination on this panel, not just in sequence.
  const r = validate(ramp, { mode: theme.mode, surface, pairs: 'all' });
  const ok = r.ok;
  if (!ok) failed += 1;

  console.log(
    `${ok ? GREEN + 'PASS' : RED + 'FAIL'}${OFF}  ${theme.label.padEnd(10)} ` +
    `${GREY}${theme.mode.padEnd(5)} on ${surface}${OFF}`,
  );
  // report rows are [name, state, detail]; state is true/false for the boolean
  // checks and 'pass' | 'warn' | 'fail' for the graded ones.
  for (const [name, state, detail] of r.report) {
    const label = state === true || state === 'pass' ? 'PASS' : state === 'warn' ? 'WARN' : 'FAIL';
    const colour = label === 'PASS' ? GREY : label === 'WARN' ? YELLOW : RED;
    console.log(`        ${colour}[${label}] ${String(name).padEnd(22)} ${detail}${OFF}`);
  }
}

console.log('');
console.log(
  failed
    ? `${RED}${failed} theme(s) failed. Fix the marked checks before shipping.${OFF}`
    : `${GREEN}All ${THEMES.length} themes pass.${OFF}`,
);
console.log('');
process.exit(failed ? 1 : 0);
