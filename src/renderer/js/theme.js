/* ── theme & type application ─────────────────────────────────────
   A base theme is a stylesheet; this layers the user's edits on top of it as
   inline custom properties on <body>, which beat the theme's own rules without
   touching them. Two consequences worth having: switching base themes keeps
   your overrides, and clearing an override restores the theme's value exactly
   rather than some remembered copy of it. */

/** Custom properties written by the last apply, so a removed one is cleared. */
let applied = new Set();

/* ── helpers ──────────────────────────────────────────────────── */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** #rgb / #rrggbb / #rrggbbaa → [r,g,b], or null for anything else. */
function parseHex(value) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(value).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

/* ── apply ────────────────────────────────────────────────────── */

/**
 * Halos are decoration that always duplicates a mark drawn beside a numeral, so
 * they are derived from the readout colour rather than being a control of their
 * own. One fewer thing to set, and it can never drift out of sync with the
 * colour it is supposed to be glowing around.
 */
const DERIVED_HALOS = [
  ['read-nominal', 'halo-nominal', 0.5],
  ['read-warn', 'halo-warn', 0.5],
  ['read-crit', 'halo-crit', 0.55],
  ['ok', 'ok-halo', 0.6],
];

export function applyTheme(config) {
  const body = document.body;
  const ui = config.ui ?? {};
  const type = ui.typography ?? {};
  const overrides = ui.themeOverrides ?? {};

  body.dataset.theme = config.theme || 'espresso';
  body.dataset.glow = ui.glow ? 'on' : 'off';
  body.dataset.scanlines = ui.scanlines ? 'on' : 'off';
  body.dataset.tabular = type.tabularNums === false ? 'off' : 'on';

  const next = new Map();

  /* One scale drives font size, dial size and row heights together, so the
     layout stays in proportion instead of type outgrowing its plate.

     It goes on <html>, not <body>, because the root font size is what every
     rem in the stylesheet resolves against — a custom property set on <body>
     is simply not in scope for a declaration on <html>. */
  const scale = Number(type.scale);
  document.documentElement.style.setProperty(
    '--ui-scale',
    String(Number.isFinite(scale) ? clamp(scale, 0.6, 1.6) : 1),
  );

  if (type.resolvedFamily) next.set('--font-ui', type.resolvedFamily);
  // Falling back to the interface face rather than a hardcoded stack means
  // "inherit" genuinely follows whatever the theme or the user chose above.
  next.set('--font-num', type.resolvedNumerals || 'var(--font-ui)');

  const weight = Number(type.numeralWeight);
  if (Number.isFinite(weight)) next.set('--num-weight', clamp(weight, 100, 900));

  const tracking = Number(type.letterSpacing);
  if (Number.isFinite(tracking)) {
    next.set('--label-tracking', `${clamp(tracking, 0, 0.5)}em`);
  }

  /* colour tokens */
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === '') continue;
    next.set(`--${key}`, value);
  }
  for (const [source, halo, alpha] of DERIVED_HALOS) {
    const rgb = parseHex(overrides[source]);
    // Only derive when the source was actually overridden, and only from a hex
    // — a gradient or a named colour has no channels to take an alpha from.
    if (rgb && !(halo in overrides)) next.set(`--${halo}`, rgba(rgb, alpha));
  }

  // Clear anything the previous apply set that this one does not, so removing
  // an override really removes it.
  for (const prop of applied) {
    if (!next.has(prop)) body.style.removeProperty(prop);
  }
  for (const [prop, value] of next) body.style.setProperty(prop, String(value));
  applied = new Set(next.keys());
}
