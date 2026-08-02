/* ── screen-buddy settings ────────────────────────────────────────
   The form is generated from the schema the server hands over, so there is no
   second list of fields here to fall out of date with the first one.

   Editing model: every change goes into a local draft and is pushed to the HUD
   as an unsaved preview. You judge a colour or a font by looking at the panel,
   not at a mock-up of it — so the panel IS the preview, and the only question
   left is whether to keep it. Discard drops the preview; Save writes the draft
   into config.json and merges it in as the new baseline. */

const TOKEN_PARAM = new URLSearchParams(location.search).get('token');

const el = {
  tabs: document.getElementById('tabs'),
  sheet: document.getElementById('sheet'),
  status: document.getElementById('status'),
  save: document.getElementById('save'),
  revert: document.getElementById('revert'),
  pulseDot: document.querySelector('.pulse__dot'),
  pulseText: document.getElementById('pulse-text'),
};

let schema = null;
let saved = null; // last known on-disk config
let draft = null; // what the panel is currently previewing
let themeDefaults = {}; // theme name -> { token: value }
let activeTab = 'appearance';
let restorePoints = [];
let dirty = false;

/* ── transport ───────────────────────────────────────────────── */

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (TOKEN_PARAM) headers['X-Admin-Token'] = TOKEN_PARAM;
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/* ── object helpers ──────────────────────────────────────────── */

const clone = (v) => structuredClone(v);

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function set(obj, dotted, value) {
  const keys = dotted.split('.');
  let node = obj;
  for (const k of keys.slice(0, -1)) {
    if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[keys.at(-1)] = value;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What this session actually changed, relative to the running configuration.
 *
 * Sending the whole draft would work — the server ignores anything the schema
 * does not describe — but it would also write every default the user never
 * touched into config.json, turning a readable twenty-line file into a full
 * dump. Arrays compare whole: a page list is one value, not five.
 */
function diff(base, next) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    const b = base?.[k];
    if (isObj(v) && isObj(b)) {
      const sub = diff(b, v);
      if (Object.keys(sub).length) out[k] = sub;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) {
      out[k] = v;
    }
  }
  return out;
}

/* ── theme defaults ──────────────────────────────────────────────
   Parsed out of the real stylesheets the HUD loads, so the editor's "unset"
   value is genuinely what the theme does rather than a copy that drifts. */

async function loadThemeDefaults(name) {
  if (themeDefaults[name]) return themeDefaults[name];
  const css = await fetch(`/themes/theme-${name}.css`).then((r) =>
    r.ok ? r.text() : '',
  );
  // The block that defines the theme, i.e. `body[data-theme='name'] { … }`.
  const block = new RegExp(
    `body\\[data-theme=['"]${name}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(css);
  const tokens = {};
  if (block) {
    // Comments go first: the theme files are heavily annotated, and a `/* … */`
    // sitting between two declarations would otherwise become part of the next
    // one's name and drop it silently. Declarations never contain a bare
    // semicolon — a gradient's commas and parentheses are fine — so splitting
    // on ';' is safe once the comments are gone.
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const decl of body.split(';')) {
      const m = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(decl);
      if (m) tokens[m[1]] = m[2].replace(/\s+/g, ' ').trim();
    }
  }
  themeDefaults[name] = tokens;
  return tokens;
}

/** What a token resolves to right now: the override if set, else the theme. */
function tokenValue(key) {
  const override = draft.ui?.themeOverrides?.[key];
  if (override) return { value: override, overridden: true };
  const base = themeDefaults[draft.theme]?.[key] ?? '';
  return { value: base, overridden: false };
}

/* ── preview & save ──────────────────────────────────────────── */

let previewTimer = null;

function markDirty() {
  dirty = true;
  el.save.disabled = false;
  el.revert.disabled = false;
  setStatus('Previewing on the panel — not saved yet.', 'dirty');
}

function setStatus(text, tone = '') {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

/** Debounced: dragging a slider should not be one HTTP round trip per pixel. */
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const { rejected } = await api('/api/preview', {
        method: 'POST',
        body: JSON.stringify(diff(saved, draft)),
      });
      if (rejected?.length) {
        setStatus(`Previewing. Ignored invalid: ${rejected.join(', ')}`, 'error');
      }
    } catch (err) {
      setStatus(`Preview failed: ${err.message}`, 'error');
    }
  }, 120);
}

function change() {
  markDirty();
  schedulePreview();
}

async function save() {
  el.save.disabled = true;
  try {
    const { config, rejected } = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(diff(saved, draft)),
    });
    saved = config;
    draft = clone(config);
    dirty = false;
    el.revert.disabled = true;
    setStatus(
      rejected?.length
        ? `Saved. Ignored invalid: ${rejected.join(', ')}`
        : 'Saved to config.json. The previous version is a restore point under Backups.',
      rejected?.length ? 'error' : 'saved',
    );
    render();
  } catch (err) {
    el.save.disabled = false;
    setStatus(`Save failed: ${err.message}`, 'error');
  }
}

async function revert() {
  draft = clone(saved);
  dirty = false;
  el.save.disabled = true;
  el.revert.disabled = true;
  try {
    await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'revert-preview' }),
    });
    setStatus('Discarded. The panel is back on its saved configuration.');
  } catch (err) {
    setStatus(`Discard failed: ${err.message}`, 'error');
  }
  render();
}

/* ── control builders ────────────────────────────────────────── */

const h = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter((c) => c != null));
  return node;
};

function fieldShell(field, control) {
  const label = h('label', { className: 'field__label' }, field.label);
  if (field.reload === 'restart') {
    label.append(h('span', { className: 'field__tag', title: 'Takes effect after restarting screen-buddy' }, 'restart'));
  } else if (field.reload === 'sensors') {
    label.append(h('span', { className: 'field__tag', title: 'Restarts the sensor hub — a one-tick blip in the readings' }, 'resensor'));
  }

  const wrap = h('div', { className: 'field' }, label, control);
  if (field.help) wrap.append(h('div', { className: 'field__help' }, field.help));
  return wrap;
}

function buildBoolean(field) {
  const input = h('input', { type: 'checkbox', checked: Boolean(get(draft, field.path)) });
  const word = h('span', { className: 'switch__word' }, input.checked ? 'On' : 'Off');
  input.addEventListener('change', () => {
    set(draft, field.path, input.checked);
    word.textContent = input.checked ? 'On' : 'Off';
    change();
  });
  return fieldShell(
    field,
    h(
      'div',
      { className: 'field__control' },
      h('label', { className: 'switch' }, input, h('span', { className: 'switch__track' }), word),
    ),
  );
}

function buildRange(field) {
  const value = Number(get(draft, field.path) ?? field.min ?? 0);
  const input = h('input', {
    type: 'range',
    min: String(field.min ?? 0),
    max: String(field.max ?? 100),
    step: String(field.step ?? 1),
    value: String(value),
  });
  const readout = h(
    'span',
    { className: 'field__value' },
    `${value}${field.unit ?? ''}`,
  );
  input.addEventListener('input', () => {
    const n = Number(input.value);
    set(draft, field.path, n);
    readout.textContent = `${n}${field.unit ?? ''}`;
    change();
  });
  return fieldShell(field, h('div', { className: 'field__control' }, input, readout));
}

function buildNumber(field) {
  const raw = get(draft, field.path);
  const input = h('input', {
    type: 'number',
    value: raw == null ? '' : String(raw),
    placeholder: field.nullable ? 'unset' : '',
  });
  if (field.min != null) input.min = String(field.min);
  if (field.max != null) input.max = String(field.max);
  if (field.step != null) input.step = String(field.step);

  input.addEventListener('change', () => {
    const text = input.value.trim();
    set(draft, field.path, text === '' ? null : Number(text));
    change();
  });
  return fieldShell(
    field,
    h(
      'div',
      { className: 'field__control' },
      input,
      field.unit ? h('span', { className: 'field__value' }, field.unit) : null,
    ),
  );
}

function buildText(field) {
  const raw = get(draft, field.path);
  const input = h('input', {
    type: 'text',
    value: raw == null ? '' : String(raw),
    placeholder: field.nullable ? 'auto' : '',
  });
  input.addEventListener('change', () => {
    const text = input.value.trim();
    set(draft, field.path, text === '' && field.nullable ? null : text);
    change();
  });
  return fieldShell(field, h('div', { className: 'field__control' }, input));
}

function buildSelect(field) {
  const current = String(get(draft, field.path) ?? '');
  const select = h(
    'select',
    {},
    field.options.map((o) =>
      h('option', { value: o.id, selected: o.id === current }, o.label ?? o.id),
    ),
  );
  const note = h(
    'span',
    { className: 'field__value' },
    field.options.find((o) => o.id === current)?.note ?? '',
  );
  note.style.minWidth = '0';
  select.addEventListener('change', () => {
    set(draft, field.path, select.value);
    note.textContent = field.options.find((o) => o.id === select.value)?.note ?? '';
    change();
    // The theme's own defaults change what every unset token resolves to.
    if (field.path === 'theme') refreshAfterThemeChange();
  });
  return fieldShell(field, h('div', { className: 'field__control' }, select, note));
}

function buildFont(field) {
  const current = get(draft, field.path);
  const select = h('select', {});
  if (field.allowInherit) {
    // Unset has to be a visible choice. Without it the browser shows whichever
    // option happens to be first, which reads as "Bahnschrift is selected" when
    // in fact nothing is and the theme is still deciding.
    select.append(
      h('option', { value: '', selected: !current }, field.inheritLabel ?? 'Unset'),
    );
  }
  for (const font of schema.fonts) {
    const option = h(
      'option',
      { value: font.id, selected: font.id === current },
      font.label,
    );
    // Preview the face in its own option, which is the only honest way to show
    // whether it is actually installed on this machine.
    option.style.fontFamily = font.stack;
    select.append(option);
  }
  // A stack the user typed by hand rather than one of the presets.
  const isCustom = current && !schema.fonts.some((f) => f.id === current);
  select.append(h('option', { value: '__custom', selected: Boolean(isCustom) }, 'Custom stack…'));

  const custom = h('input', {
    type: 'text',
    value: isCustom ? String(current) : '',
    placeholder: "'My Font', system-ui, sans-serif",
    hidden: !isCustom,
  });

  const note = h(
    'span',
    { className: 'field__value' },
    schema.fonts.find((f) => f.id === current)?.note ?? '',
  );
  note.style.minWidth = '0';

  const commit = () => {
    if (select.value === '__custom') {
      custom.hidden = false;
      set(draft, field.path, custom.value.trim() || null);
      note.textContent = '';
    } else {
      custom.hidden = true;
      set(draft, field.path, select.value || null);
      note.textContent = schema.fonts.find((f) => f.id === select.value)?.note ?? '';
    }
    change();
  };
  select.addEventListener('change', commit);
  custom.addEventListener('change', commit);

  return fieldShell(
    field,
    h('div', { className: 'field__control' }, select, custom, note),
  );
}

/* ── pages editor ────────────────────────────────────────────── */

function buildPages(field) {
  const pages = get(draft, field.path) ?? [];

  const list = h('div', { className: 'pages' });

  const commit = (next) => {
    set(draft, field.path, next);
    change();
    render();
  };

  pages.forEach((page, i) => {
    const title = h('input', {
      type: 'text',
      value: page.title ?? '',
      placeholder: 'Page name (for your reference)',
    });
    title.addEventListener('change', () => {
      const next = clone(pages);
      next[i].title = title.value;
      commit(next);
    });

    const when = h(
      'select',
      {},
      schema.pageConditions.map((c) =>
        h('option', { value: c.id, selected: (page.when ?? '') === c.id }, c.label),
      ),
    );
    when.addEventListener('change', () => {
      const next = clone(pages);
      next[i].when = when.value;
      commit(next);
    });

    const move = (delta) => {
      const next = clone(pages);
      const to = i + delta;
      if (to < 0 || to >= next.length) return;
      [next[i], next[to]] = [next[to], next[i]];
      commit(next);
    };

    const chips = h(
      'div',
      { className: 'chips' },
      schema.panels.map((p) => {
        const box = h('input', {
          type: 'checkbox',
          checked: (page.panels ?? []).includes(p.id),
        });
        // A panel switched off in the Panels tab cannot appear anywhere, so
        // offering it here would be a control that silently does nothing.
        const globallyOff = draft.ui?.panels?.[p.id] === false;
        box.disabled = globallyOff;
        box.addEventListener('change', () => {
          const next = clone(pages);
          const set_ = new Set(next[i].panels ?? []);
          if (box.checked) set_.add(p.id);
          else set_.delete(p.id);
          next[i].panels = schema.panels.map((x) => x.id).filter((x) => set_.has(x));
          commit(next);
        });
        return h(
          'label',
          { className: 'chip', title: globallyOff ? 'Turned off in Panels' : p.note },
          box,
          p.label,
          h('small', {}, globallyOff ? '(off)' : p.kind === 'strip' ? 'strip' : ''),
        );
      }),
    );

    list.append(
      h(
        'div',
        { className: 'page-card' },
        h(
          'div',
          { className: 'page-card__head' },
          h('span', { className: 'page-card__ord' }, String(i + 1)),
          title,
          when,
          h('span', { className: 'page-card__spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn--small',
              disabled: i === 0,
              onclick: () => move(-1),
              title: 'Move earlier',
            },
            '↑',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn--small',
              disabled: i === pages.length - 1,
              onclick: () => move(1),
              title: 'Move later',
            },
            '↓',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn--small btn--danger',
              onclick: () => commit(pages.filter((_, j) => j !== i)),
            },
            'Remove',
          ),
        ),
        chips,
      ),
    );
  });

  if (!pages.length) {
    list.append(
      h(
        'p',
        { className: 'field__help' },
        'No pages defined. Rotation stays off until there is at least one, so the panel can never end up blank.',
      ),
    );
  }

  list.append(
    h(
      'div',
      { className: 'row-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'btn',
          onclick: () =>
            commit([
              ...pages,
              { id: `page${pages.length + 1}`, title: '', panels: ['gauges'], when: '' },
            ]),
        },
        'Add page',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'btn',
          onclick: () => commit(clone(schema.defaultPages)),
        },
        'Use suggested pages',
      ),
    ),
  );

  return h(
    'div',
    { className: 'field' },
    h('label', { className: 'field__label' }, field.label),
    list,
  );
}

/* ── colour tokens ───────────────────────────────────────────── */

function buildToken(token) {
  const { value, overridden } = tokenValue(token.key);

  const row = h('div', { className: `token${overridden ? ' is-overridden' : ''}` });

  const picker = h('input', { type: 'color' });
  // A colour input only understands #rrggbb, so an 8-digit hex or a gradient
  // still gets a usable picker while the text field stays authoritative.
  const hex = /^#[0-9a-f]{6}/i.exec(value);
  if (hex) picker.value = hex[0];
  else picker.disabled = true;

  const swatch = h('span', { className: 'token__swatch' }, picker);
  swatch.style.background = value || 'transparent';

  const text = h('input', { type: 'text', className: 'token__text', value });

  const reset = h(
    'button',
    {
      type: 'button',
      className: 'token__reset',
      title: 'Back to the theme’s value',
      disabled: !overridden,
    },
    '↺',
  );

  const apply = (next) => {
    if (!draft.ui.themeOverrides) draft.ui.themeOverrides = {};
    draft.ui.themeOverrides[token.key] = next;
    swatch.style.background = next;
    change();
  };

  picker.addEventListener('input', () => {
    text.value = picker.value;
    apply(picker.value);
    row.classList.add('is-overridden');
    reset.disabled = false;
  });
  text.addEventListener('change', () => {
    apply(text.value.trim());
    row.classList.add('is-overridden');
    reset.disabled = false;
  });
  reset.addEventListener('click', () => {
    // null rather than delete: the server needs to be told to clear it, and a
    // missing key would just mean "unchanged".
    if (draft.ui.themeOverrides) draft.ui.themeOverrides[token.key] = null;
    change();
    render();
  });

  row.append(
    h(
      'span',
      { className: 'token__name' },
      token.label,
      h('code', {}, `--${token.key}`),
    ),
    swatch,
    text,
    reset,
  );
  if (token.help) {
    const help = h('div', { className: 'field__help' }, token.help);
    help.style.gridColumn = '1 / -1';
    row.append(help);
  }
  return row;
}

function buildTokenGroups() {
  const groups = new Map();
  for (const token of schema.tokens) {
    if (!groups.has(token.group)) groups.set(token.group, []);
    groups.get(token.group).push(token);
  }

  const out = [];
  for (const [name, tokens] of groups) {
    out.push(
      h(
        'div',
        { className: 'group' },
        h('div', { className: 'group__title' }, name),
        h('div', { className: 'tokens' }, tokens.map(buildToken)),
      ),
    );
  }

  out.push(
    h(
      'div',
      { className: 'group' },
      h(
        'div',
        { className: 'row-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn--danger',
            onclick: () => {
              // Explicit nulls, so every override is actively cleared rather
              // than merely omitted from the patch.
              const cleared = {};
              for (const t of schema.tokens) cleared[t.key] = null;
              draft.ui.themeOverrides = cleared;
              change();
              render();
            },
          },
          'Clear all colour overrides',
        ),
      ),
    ),
  );
  return out;
}

async function refreshAfterThemeChange() {
  await loadThemeDefaults(draft.theme);
  render();
}

/* ── restore points ────────────────────────────────────────────── */

const KIND_NOTE = {
  auto: 'taken automatically',
  pinned: 'pinned by you — never pruned',
  shipped: 'the template shipped with screen-buddy',
};

function ago(at) {
  if (!at) return '';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshRestorePoints() {
  const { points } = await api('/api/restore-points');
  restorePoints = points;
  render();
}

/**
 * Confirmation is a second click on the same button rather than a dialog: a
 * browser confirm() blocks, and these actions are all undoable anyway — the
 * point is to stop a stray click, not to solemnise the decision.
 */
function arming(button, label, run) {
  let armed = false;
  const reset = () => {
    armed = false;
    button.textContent = label;
    button.classList.remove('btn--armed');
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Click again to confirm';
      button.classList.add('btn--armed');
      setTimeout(() => armed && reset(), 4000);
      return;
    }
    reset();
    await run();
  });
  return button;
}

function buildRestoreView() {
  const wrap = h('div', {});

  const actions = h(
    'div',
    { className: 'group' },
    h('div', { className: 'group__title' }, 'Make a restore point'),
    h(
      'div',
      { className: 'row-actions' },
      (() => {
        const name = h('input', {
          type: 'text',
          placeholder: 'Name it, e.g. "before trying neon"',
        });
        name.style.maxWidth = '280px';
        const go = h('button', { type: 'button', className: 'btn btn--primary' }, 'Pin current configuration');
        go.addEventListener('click', async () => {
          try {
            await api('/api/checkpoint', {
              method: 'POST',
              body: JSON.stringify({ label: name.value }),
            });
            name.value = '';
            setStatus('Pinned. It will not be pruned automatically.', 'saved');
            await refreshRestorePoints();
          } catch (err) {
            setStatus(`Could not pin: ${err.message}`, 'error');
          }
        });
        return [name, go];
      })(),
    ),
  );

  const resets = h(
    'div',
    { className: 'group' },
    h('div', { className: 'group__title' }, 'Reset'),
    h(
      'div',
      { className: 'row-actions' },
      arming(
        h('button', { type: 'button', className: 'btn' }, 'Reset theme and layout'),
        'Reset theme and layout',
        async () => {
          try {
            await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope: 'appearance' }) });
            setStatus('Theme and layout reset. Display, window and sensor settings kept.', 'saved');
            await reloadState();
          } catch (err) {
            setStatus(`Reset failed: ${err.message}`, 'error');
          }
        },
      ),
      arming(
        h('button', { type: 'button', className: 'btn btn--danger' }, 'Reset everything'),
        'Reset everything',
        async () => {
          try {
            await api('/api/reset', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
            setStatus('Reset to the shipped template.', 'saved');
            await reloadState();
          } catch (err) {
            setStatus(`Reset failed: ${err.message}`, 'error');
          }
        },
      ),
      h(
        'p',
        { className: 'field__help' },
        'Both are undoable: the configuration being replaced becomes a restore point first. "Reset theme and layout" keeps your display, window and sensor setup, which is usually the reset you actually want.',
      ),
    ),
  );

  const list = h(
    'div',
    { className: 'group' },
    h('div', { className: 'group__title' }, `Restore points (${restorePoints.length})`),
  );

  for (const point of restorePoints) {
    const row = h('div', { className: `restore restore--${point.kind}` });

    const label = h(
      'div',
      { className: 'restore__main' },
      h('span', { className: 'restore__label' }, point.label || 'automatic snapshot'),
      h(
        'span',
        { className: 'restore__meta' },
        [ago(point.at), KIND_NOTE[point.kind], point.bytes ? `${(point.bytes / 1024).toFixed(1)} kB` : '']
          .filter(Boolean)
          .join('  ·  '),
      ),
      h('code', { className: 'restore__id' }, point.id),
    );

    const buttons = h('div', { className: 'restore__actions' });
    buttons.append(
      arming(
        h('button', { type: 'button', className: 'btn btn--small' }, 'Restore'),
        'Restore',
        async () => {
          try {
            const r = await api('/api/restore', {
              method: 'POST',
              body: JSON.stringify({ id: point.id }),
            });
            setStatus(
              `Restored. The configuration you replaced is saved as ${r.previous ?? 'a new restore point'}.`,
              'saved',
            );
            await reloadState();
          } catch (err) {
            setStatus(`Restore failed: ${err.message}`, 'error');
          }
        },
      ),
    );
    // The shipped template is not a file and cannot be deleted; that is the
    // property that makes it the guaranteed floor.
    if (point.kind !== 'shipped') {
      buttons.append(
        arming(
          h('button', { type: 'button', className: 'btn btn--small btn--danger' }, 'Delete'),
          'Delete',
          async () => {
            try {
              await api('/api/restore-delete', {
                method: 'POST',
                body: JSON.stringify({ id: point.id }),
              });
              await refreshRestorePoints();
            } catch (err) {
              setStatus(`Delete failed: ${err.message}`, 'error');
            }
          },
        ),
      );
    }

    row.append(label, buttons);
    list.append(row);
  }

  wrap.append(actions, resets, list);
  return wrap;
}

/* ── rendering ───────────────────────────────────────────────── */

const BUILDERS = {
  boolean: buildBoolean,
  range: buildRange,
  number: buildNumber,
  text: buildText,
  select: buildSelect,
  font: buildFont,
  pages: buildPages,
};

function renderTabs() {
  el.tabs.replaceChildren(
    ...schema.form.map((section) => {
      const tab = h(
        'button',
        { type: 'button', className: 'tab' },
        section.label,
      );
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(section.id === activeTab));
      tab.addEventListener('click', () => {
        activeTab = section.id;
        render();
      });
      return tab;
    }),
  );
}

function render() {
  renderTabs();

  const section = schema.form.find((s) => s.id === activeTab) ?? schema.form[0];
  const body = h('div', { className: 'section' });

  if (section.blurb) {
    body.append(h('p', { className: 'section__blurb' }, section.blurb));
  }

  if (section.custom === 'restore') {
    body.append(buildRestoreView());
    el.sheet.replaceChildren(body);
    return;
  }

  const group = h('div', { className: 'group' });
  for (const field of section.fields) {
    const build = BUILDERS[field.type];
    if (build) group.append(build(field));
  }
  body.append(group);

  // Colour tokens live under the theme tab, where you are already choosing how
  // the panel looks.
  if (section.id === 'appearance') body.append(...buildTokenGroups());

  el.sheet.replaceChildren(body);
}

/* ── live pulse ──────────────────────────────────────────────── */

async function pollPulse() {
  try {
    const { snapshot } = await api('/api/snapshot');
    if (!snapshot) {
      el.pulseDot.dataset.state = 'wait';
      el.pulseText.textContent = 'panel running, no readings yet';
      return;
    }
    el.pulseDot.dataset.state = 'live';
    const cpu = snapshot.cpu?.tempC;
    const gpu = snapshot.gpu?.tempC;
    const parts = [];
    if (Number.isFinite(cpu)) parts.push(`CPU ${Math.round(cpu)}°`);
    if (Number.isFinite(gpu)) parts.push(`GPU ${Math.round(gpu)}°`);
    if (Number.isFinite(snapshot.mem?.pct)) {
      parts.push(`RAM ${Math.round(snapshot.mem.pct)}%`);
    }
    el.pulseText.textContent = parts.join('  ·  ') || 'live';
  } catch {
    el.pulseDot.dataset.state = 'down';
    el.pulseText.textContent = 'panel not responding';
  }
}

/* ── boot ────────────────────────────────────────────────────── */

/** Re-read everything from the app. Used after a restore replaces the file. */
async function reloadState() {
  const state = await api('/api/state');
  saved = state.config;
  draft = clone(state.config);
  draft.ui ??= {};
  draft.ui.themeOverrides ??= {};
  dirty = false;
  el.save.disabled = true;
  el.revert.disabled = true;
  const { points } = await api('/api/restore-points');
  restorePoints = points;
  render();
}

async function boot() {
  try {
    const state = await api('/api/state');
    schema = state.schema;
    saved = state.config;
    draft = clone(state.config);
    // Fields the user has never set are absent; give every builder something
    // to read so an unset value shows as unset rather than throwing.
    draft.ui ??= {};
    draft.ui.themeOverrides ??= {};

    // Every registered theme, so the token editor can show what "unset" means
    // for whichever one is selected — and so adding a theme to the schema needs
    // no edit here.
    await Promise.all(schema.themes.map((t) => loadThemeDefaults(t.id)));
    restorePoints = (await api('/api/restore-points')).points;
    render();
    pollPulse();
    setInterval(pollPulse, 2000);
  } catch (err) {
    el.sheet.replaceChildren(
      h(
        'p',
        { className: 'loading' },
        `Could not reach screen-buddy: ${err.message}`,
      ),
    );
  }
}

el.save.addEventListener('click', save);
el.revert.addEventListener('click', revert);

boot();
