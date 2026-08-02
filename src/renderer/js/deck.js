/* ── the deck: one page, or several in rotation ───────────────────
   A rotating panel trades instant recognition for legibility. Spatial
   constancy is most of what makes an ambient display readable — you learn that
   the boiler temperature is top-left and after that you read it without
   looking properly — and rotation throws that away: two thirds of the time the
   number you want is simply not there, so a glance becomes a wait.

   It is still the right trade on a panel too small to hold everything legibly.
   So the cost is paid down rather than ignored:

     · The bar never rotates. Clock, weather and ready lamp are always present,
       which covers the two things anyone actually glances up for.
     · An alert pulls the gauges page forward and holds it there, so a rising
       temperature can never be hidden on a page you are not on.
     · A page can declare a condition, so the media page is skipped outright
       when nothing is playing instead of showing a dead frame.
     · The default transition is a crossfade. Sliding introduces direction, and
       directional motion in peripheral vision is far harder to ignore.

   With rotation off this module still runs, building exactly one page whose
   rows reproduce the original layout — so the feature costs nothing when
   unused and there is only ever one layout code path. */

/**
 * How each panel behaves in a row.
 *   block — stretches to fill the height it is given; `weight` is its column
 *           share when it sits beside other blocks.
 *   strip — keeps its natural height on its own full-width row.
 */
const META = {
  gauges: { kind: 'block', weight: 2 },
  reservoir: { kind: 'block', weight: 0.78 },
  media: { kind: 'block', weight: 1.92 },
  network: { kind: 'block', weight: 1 },
  cores: { kind: 'strip' },
  footer: { kind: 'strip' },
  // Added because rotation made room for them, not to restate what is already
  // on the machine page at a different size.
  processes: { kind: 'block', weight: 2 },
  storage: { kind: 'block', weight: 1.4 },
  trends: { kind: 'block', weight: 2 },
  forecast: { kind: 'block', weight: 2.4 },
  pressure: { kind: 'block', weight: 1.2 },
};

/**
 * The layout the panel has always had. Row heights are the originals, so
 * turning rotation off is pixel-neutral rather than approximately the same.
 */
const CLASSIC_ROWS = [
  { panels: ['gauges', 'reservoir'], height: '16.75rem' },
  { panels: ['media', 'network'], height: 'flex' },
  { panels: ['cores'], height: 'auto' },
  { panels: ['footer'], height: 'auto' },
];

const STATUS_RANK = { nominal: 0, warn: 1, crit: 2 };

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createDeck({ deck, dots, store }) {
  let pages = [];
  let index = 0;
  let timer = null;
  let settings = null;
  let alert = 'nominal';
  let availability = { media: false, network: false };
  let held = false;

  /* ── building ────────────────────────────────────────────────── */

  /** Split a page's panels into rows: blocks share one, strips get their own. */
  function autoRows(panels) {
    const blocks = panels.filter((p) => META[p]?.kind === 'block');
    const strips = panels.filter((p) => META[p]?.kind === 'strip');
    const rows = [];

    // Four blocks on one row leaves each too narrow for its numerals, so past
    // three they split across two rows instead of getting thinner.
    if (blocks.length > 3) {
      const half = Math.ceil(blocks.length / 2);
      rows.push({ panels: blocks.slice(0, half), height: 'flex' });
      rows.push({ panels: blocks.slice(half), height: 'flex' });
    } else if (blocks.length) {
      rows.push({ panels: blocks, height: 'flex' });
    }

    for (const s of strips) rows.push({ panels: [s], height: 'auto' });
    return rows;
  }

  function buildRow(spec, visible) {
    const panels = spec.panels.filter((p) => visible.has(p));
    if (!panels.length) return null;

    const row = document.createElement('div');
    row.className = 'page__row';
    row.style.gridTemplateColumns = panels
      .map((p) => `${META[p]?.weight ?? 1}fr`)
      .join(' ');

    if (spec.height === 'flex') {
      row.style.flex = '1 1 0';
      // A floor, so a stretching row can never be squeezed into a sliver by
      // the fixed rows above it — which is what happens on a short panel, or
      // at a type scale the classic layout was not drawn for. Below this the
      // row stops giving ground and the fixed rows shrink instead.
      row.style.minHeight = '5.5rem';
    } else if (spec.height === 'auto') {
      row.style.flex = '0 0 auto';
    } else {
      // Shrinkable, not rigid: it holds its height while there is room and
      // yields once the floor above starts to bite.
      row.style.flex = `0 1 ${spec.height}`;
    }

    for (const p of panels) {
      const node = store.querySelector(`[data-panel="${p}"]`);
      if (node) row.append(node);
    }
    return row;
  }

  function buildPage(spec, visible) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.page = spec.id;

    const rows = (spec.rows ?? autoRows(spec.panels)).map((r) =>
      buildRow(r, visible),
    );
    const kept = rows.filter(Boolean);
    if (!kept.length) return null;

    page.append(...kept);
    return { id: spec.id, when: spec.when ?? '', el: page, panels: spec.panels };
  }

  /**
   * Rebuild from scratch. Every panel is returned to the store first, so a
   * panel that moved between pages is never left orphaned on a page that no
   * longer exists — and the element references app.js holds stay valid, because
   * the nodes are moved rather than recreated.
   */
  function build() {
    for (const node of deck.querySelectorAll('[data-panel]')) store.append(node);
    deck.replaceChildren();
    pages = [];

    const visible = new Set(
      Object.entries(settings.panels)
        .filter(([, on]) => on !== false)
        .map(([id]) => id),
    );

    const specs = settings.rotation.enabled
      ? settings.rotation.pages
      : [{ id: 'all', rows: CLASSIC_ROWS, panels: CLASSIC_ROWS.flatMap((r) => r.panels) }];

    for (const spec of specs) {
      const page = buildPage(spec, visible);
      if (page) {
        pages.push(page);
        deck.append(page.el);
      }
    }

    deck.dataset.rotating = String(settings.rotation.enabled);
    deck.dataset.transition = settings.rotation.transition;
    deck.style.setProperty(
      '--deck-fade',
      `${prefersReducedMotion() ? 0 : settings.rotation.transitionMs}ms`,
    );

    index = 0;
    buildDots();
    show(firstEligible(0), { immediate: true });
    schedule();
  }

  function buildDots() {
    const wanted =
      settings.rotation.enabled && settings.rotation.indicator && pages.length > 1;
    dots.hidden = !wanted;
    if (!wanted) {
      dots.replaceChildren();
      return;
    }
    dots.replaceChildren(
      ...pages.map(() => {
        const dot = document.createElement('i');
        dot.className = 'dots__dot';
        return dot;
      }),
    );
  }

  /* ── eligibility ─────────────────────────────────────────────── */

  function eligible(page) {
    if (page.when === 'media') return availability.media;
    if (page.when === 'network') return availability.network;
    return true;
  }

  /** Next eligible page at or after `from`, or the current one if none is. */
  function firstEligible(from) {
    for (let i = 0; i < pages.length; i += 1) {
      const at = (from + i) % pages.length;
      if (eligible(pages[at])) return at;
    }
    return from % Math.max(1, pages.length);
  }

  /** The page carrying the gauges, which is where an alert belongs. */
  const alertPage = () => pages.findIndex((p) => p.panels.includes('gauges'));

  function alertActive() {
    const level = settings.rotation.alertOverride;
    if (level === 'off' || !settings.rotation.enabled) return false;
    return STATUS_RANK[alert] >= STATUS_RANK[level];
  }

  /* ── showing ─────────────────────────────────────────────────── */

  function show(next, { immediate = false } = {}) {
    if (!pages.length) return;
    index = Math.max(0, Math.min(pages.length - 1, next));

    // Suppressing the transition has to happen before the classes change, or
    // the animation has already been committed by the time it is turned off.
    if (immediate) deck.classList.add('deck--instant');

    pages.forEach((p, i) => {
      p.el.classList.toggle('is-active', i === index);
      // Direction only matters for the slide transition; a crossfade looks the
      // same either way.
      p.el.classList.toggle('is-before', i < index);
    });

    for (const [i, dot] of [...dots.children].entries()) {
      dot.classList.toggle('is-active', i === index);
    }
    dots.classList.toggle('is-held', held);

    if (immediate) {
      // Force a reflow so the no-transition class applies to this change only.
      void deck.offsetHeight;
      deck.classList.remove('deck--instant');
    }
  }

  function advance() {
    if (pages.length < 2) return;
    show(firstEligible(index + 1));
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!settings.rotation.enabled || pages.length < 2 || held) return;
    const ms = Math.max(2000, settings.rotation.dwellSec * 1000);
    timer = setInterval(advance, ms);
  }

  /** Re-evaluate whether the deck should be parked on the alert page. */
  function reconcile() {
    const shouldHold = alertActive() && alertPage() >= 0;
    if (shouldHold !== held) {
      held = shouldHold;
      schedule();
    }
    if (held) {
      show(alertPage());
      return;
    }
    // A condition can go false while its page is on screen — the media page
    // when playback stops. Move on rather than sitting on a dead frame.
    if (pages[index] && !eligible(pages[index])) advance();
    else dots.classList.toggle('is-held', held);
  }

  /* ── public surface ──────────────────────────────────────────── */

  return {
    /** Rebuild for a new (or changed) configuration. Safe to call repeatedly. */
    configure(config) {
      const ui = config.ui ?? {};
      const r = ui.rotation ?? {};
      settings = {
        panels: ui.panels ?? {},
        rotation: {
          enabled: Boolean(r.enabled),
          dwellSec: Number(r.dwellSec) || 20,
          transition: r.transition ?? 'fade',
          transitionMs: Number.isFinite(r.transitionMs) ? r.transitionMs : 600,
          alertOverride: r.alertOverride ?? 'crit',
          indicator: r.indicator !== false,
          pages: Array.isArray(r.pages) && r.pages.length ? r.pages : [],
        },
      };
      if (settings.rotation.enabled && !settings.rotation.pages.length) {
        // Rotation on with no pages defined would blank the panel entirely.
        settings.rotation.enabled = false;
      }
      held = false;
      build();
      reconcile();
    },

    /** Worst live status, used to decide whether to park on the gauges. */
    setAlert(status) {
      if (status === alert) return;
      alert = status;
      if (settings) reconcile();
    },

    /** Which conditional pages currently have anything to show. */
    setAvailability(next) {
      const changed =
        next.media !== availability.media || next.network !== availability.network;
      availability = { ...availability, ...next };
      if (changed && settings) reconcile();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
