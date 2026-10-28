/* Vault: small helpers every other file uses (the V namespace, building elements, icons, dialogs, toasts, dates).
   Every script is a plain script sharing `V`, so the same files run on the phone (GitHub Pages), in the PC app
   (vault://app/ inside Qt) and in the tests, with nothing to build. User text only ever goes in as textContent. */
'use strict';

const V = (window.V = window.V || {});
V.VERSION = '1.4.0';
V.desktop = !!window.VAULT_DESKTOP;  // set by the PC app (vault/desktop.py) before any script runs

/* Which device this is: 'pc' (the PC app), 'phone' (the owner's Android phone: Vault installed there, or a tab of its
   Chrome) or 'web' (any other browser: a school Chromebook, a laptop). Each device only takes in what was sent to it,
   so a Chromebook never marks the phone's files as received. A wrong guess (Chrome on the phone set to ask for desktop
   sites leaves "Android" out) is put right in Settings, which keeps the answer in localStorage 'vault-device'. */
V.DEVICES = ['pc', 'phone', 'web'];
V.deviceKind = (() => {
  const agent = navigator.userAgent || '';
  const hints = navigator.userAgentData || {};
  const chromebook = /\bCrOS\b/.test(agent) || /^chrome ?os$/i.test(hints.platform || '');
  if (V.desktop) return { id: 'pc', chromebook: false };
  let chosen = '';
  try { chosen = localStorage.getItem('vault-device') || ''; } catch (error) { /* private browsing */ }
  if (chosen === 'phone' || chosen === 'web') return { id: chosen, chromebook };
  const android = /Android/i.test(agent) || hints.platform === 'Android';
  // Installed, on a touch screen that isn't a Chromebook, Windows or a Mac: the phone, even asking for desktop sites.
  const installed = window.matchMedia('(display-mode: standalone)').matches && navigator.maxTouchPoints > 0
    && !/Windows|Macintosh|iPhone|iPad/.test(agent);
  return { id: !chromebook && (android || installed) ? 'phone' : 'web', chromebook };
})();
V.device = V.deviceKind.id;
V.other = V.device === 'pc' ? 'phone' : 'pc';
V.otherName = V.device === 'pc' ? 'your phone' : 'your PC';
/* 'PC', 'Phone', and for 'web' what that browser said it is ('Chromebook' or 'Browser', kept in the settings row's
   extra.devices by js/send.js). */
V.deviceLabel = (id) => {
  if (id === 'pc') return 'PC';
  if (id === 'phone') return 'Phone';
  if (id !== 'web') return 'Another device';
  if (V.device === 'web') return V.deviceKind.chromebook ? 'Chromebook' : 'Browser';
  const seen = V.data && V.data.settings && V.data.settings.extra && V.data.settings.extra.devices;
  return seen && seen.web && seen.web.label === 'Browser' ? 'Browser' : 'Chromebook';
};
V.deviceName = (id) => ({ PC: 'your PC', Phone: 'your phone', Chromebook: 'your Chromebook', Browser: 'your web browser' })[
  V.deviceLabel(id)] || 'another device';
V.deviceIcon = (id) => (id === 'pc' ? 'pc' : id === 'phone' ? 'phone' : 'laptop');
V.setDevice = (id) => {
  if (V.desktop || id === V.device || !['phone', 'web'].includes(id)) return;
  try { localStorage.setItem('vault-device', id); } catch (error) { /* private browsing: until it closes */ }
  location.reload();
};

/* ---------------------------------------------------------------- light or dark

   Set first, before anything is drawn (the page's rules allow no inline script, so it's here): this device's own
   choice (Settings > Appearance, kept in localStorage 'vault-theme': system, light or dark), else the system's. In
   the PC app "system" means Windows' own app theme, which vault/desktop.py hands over (VAULT_SCHEME at the start,
   then a "scheme" event), as Qt's web view may not pass it on as prefers-color-scheme. */
V.theme = (() => {
  const KEY = 'vault-theme';
  const BARS = { light: '#f5f6f8', dark: '#0e0f12' };  // --bg, for the phone's status bar (the theme-color metas)
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let system = /^(light|dark)$/.test(window.VAULT_SCHEME || '') ? window.VAULT_SCHEME : '';
  let shown = '';
  const choice = () => {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch (error) {
      return 'system';
    }
  };
  const resolved = () => (choice() !== 'system' ? choice() : system || (media.matches ? 'dark' : 'light'));
  function apply() {
    const now = resolved();
    document.documentElement.dataset.theme = now;
    const own = choice() === 'system' && !system;  // each meta keeps its own colour, picked by the system
    for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
      meta.content = own ? BARS[/dark/.test(meta.media) ? 'dark' : 'light'] : BARS[now];
    }
    if (now !== shown) {
      shown = now;
      if (V.emit) V.emit('theme', now);
    }
  }
  media.addEventListener('change', apply);
  window.addEventListener('storage', (event) => { if (event.key === KEY) apply(); });  // changed in another tab
  apply();
  return {
    choice,
    current: () => shown,
    set(value) {
      try {
        if (value === 'light' || value === 'dark') localStorage.setItem(KEY, value);
        else localStorage.removeItem(KEY);
      } catch (error) { /* private browsing: it lasts until the page closes */ }
      apply();
    },
    system(value) {
      system = value === 'light' || value === 'dark' ? value : '';
      apply();
    },
  };
})();

/* ---------------------------------------------------------------- events */

V.bus = new EventTarget();
V.on = (type, fn) => V.bus.addEventListener(type, (event) => fn(event.detail));
V.emit = (type, detail) => V.bus.dispatchEvent(new CustomEvent(type, { detail }));

/* Out of sight: the phone's app in the background, or the PC's window hidden in the tray or minimised. The PC app
   keeps its page "visible" even then (a hidden page stops its timers and Realtime), so it says so itself (pc:window).
   'away' and 'back' go out when that changes, with <html class="away"> stopping the animations meanwhile. */
V.pcShown = true;
V.away = () => document.hidden || (V.desktop && !V.pcShown);
let wasAway = false;
const awayChanged = () => {
  const now = V.away();
  if (now === wasAway) return;
  wasAway = now;
  document.documentElement.classList.toggle('away', now);
  V.emit(now ? 'away' : 'back');
};
document.addEventListener('visibilitychange', awayChanged);
V.on('pc:window', ({ shown }) => { V.pcShown = shown !== false; awayChanged(); });
V.pcWindow = (shown) => { V.pcShown = shown !== false; awayChanged(); };

/* ---------------------------------------------------------------- elements */

V.h = function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'class') el.className += (el.className ? ' ' : '') + value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = !!value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

V.clear = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter(Boolean)); return el; };

/* Line icons (drawn after Lucide's and Feather's, ISC/MIT, on a 24 grid with a 1.75 stroke): only these fixed strings
   ever go through innerHTML. */
const ICONS = {
  notes: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
  send: '<path d="M20.5 3.5 3.5 10.2l7 3.1 3.1 7z"/><path d="M20.5 3.5 10.5 13.3"/>',
  clip: '<rect x="8.5" y="3" width="7" height="4" rx="1.5"/><path d="M15.5 5h1.5A2.5 2.5 0 0 1 19.5 7.5v11A2.5 2.5 0 0 1 17 21H7a2.5 2.5 0 0 1-2.5-2.5v-11A2.5 2.5 0 0 1 7 5h1.5"/>',
  settings: '<path d="M4 7.5h9M17.5 7.5H20M4 16.5h2.5M11 16.5h9"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="8.8" cy="16.5" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  back: '<path d="m14.5 18-6-6 6-6"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  pin: '<path d="M12 16v5"/><path d="M8.5 3.5h7l-1 5.5 3.5 3.5V15h-12v-2.5L9.5 9z"/>',
  'pin-on': '<path d="M12 16v5"/><path d="M8.5 3.5h7l-1 5.5 3.5 3.5V15h-12v-2.5L9.5 9z" fill="currentColor"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 7.6-1.75"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.5-2.5h4.4L15.7 6h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checklist: '<rect x="3.5" y="4.5" width="6" height="6" rx="1.5"/><path d="m4.6 16.3 1.7 1.7 3.2-3.5"/><path d="M13 7.5h7.5M13 17h7.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  stack: '<path d="M12 3.5 3.5 8 12 12.5 20.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  folder: '<path d="M3.5 7.5v10A2.5 2.5 0 0 0 6 20h12a2.5 2.5 0 0 0 2.5-2.5V10A2.5 2.5 0 0 0 18 7.5h-6.2L9.6 5H6a2.5 2.5 0 0 0-2.5 2.5z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 15.5v-11M7 9l5-5 5 5M5 20h14"/>',
  share: '<path d="M12 14V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  file: '<path d="M14 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V8.5z"/><path d="M14 3v5.5h5.5"/>',
  image: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.75"/><path d="m20.5 15.5-4.5-4.5L5.5 20"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  text: '<path d="M4.5 6.5h15M4.5 11.5h15M4.5 16.5h9"/>',
  x: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  pc: '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8.5 21h7M12 17v4"/>',
  'up-right': '<path d="M7 17 17 7M9 7h8v8"/>',
  'down-left': '<path d="M17 7 7 17M15 17H7V9"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A4 4 0 0 1 17 18.5z"/>',
  restore: '<path d="M19.5 10.5A7.5 7.5 0 0 0 6 6.6L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4.5 13.5A7.5 7.5 0 0 0 18 17.4l2-1.9"/><path d="M20 20v-4.5h-4.5"/>',
  qr: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20.5 14v.01M14 20.5h.01M17 20.5h3.5V17"/>',
  bolt: '<path d="M13 3 4.5 13.5h7L11 21l8.5-10.5h-7z"/>',
  open: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13"/><path d="M17.5 14v3.5A2.5 2.5 0 0 1 15 20H6.5A2.5 2.5 0 0 1 4 17.5V9a2.5 2.5 0 0 1 2.5-2.5H10"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5"/><circle cx="12" cy="16" r=".6" fill="currentColor"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="2"/><path d="M2.5 19h19"/>',
  play: '<path d="M8.5 6.2v11.6a.9.9 0 0 0 1.38.76l9-5.8a.9.9 0 0 0 0-1.52l-9-5.8a.9.9 0 0 0-1.38.76z" fill="currentColor" stroke="none"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  spark: '<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15a2 2 0 0 0-1.2-1.2L3.5 12 9 10.2A2 2 0 0 0 10.2 9z"/>',
  paperclip: '<path d="m19.5 11.2-7.8 7.8a4.9 4.9 0 0 1-6.9-6.9l8.2-8.2a3.25 3.25 0 0 1 4.6 4.6l-8.2 8.2a1.6 1.6 0 0 1-2.3-2.3l7.5-7.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5s1.1-6.2 3.4-8.5z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
};

V.icon = function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  return span;
};

/* Vault's mark: a rounded square split by a V-shaped seam (the wedge it frees is the note kept inside). One flat
   colour (currentColor; .mark makes it --brand). */
const MARK = [
  'M8 0L21.022 0A3.2 3.2 0 0 1 23.999 2.027L48.511 64.223A1.6 1.6 0 0 0 51.489 64.223L76.001 2.027A3.2 3.2 0 0 1 78.978 0L92 0A8 8 0 0 1 100 8L100 78A22 22 0 0 1 78 100L22 100A22 22 0 0 1 0 78L0 8A8 8 0 0 1 8 0Z',
  'M35.081 0L64.919 0A2.6 2.6 0 0 1 67.338 3.553L52.782 40.487A2.99 2.99 0 0 1 47.218 40.487L32.662 3.553A2.6 2.6 0 0 1 35.081 0Z',
];
const SVG = 'http://www.w3.org/2000/svg';
V.mark = (size = 40, cls = '') => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'mark' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of MARK) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
};

/* The mark with "vault" beside it, for the start and the screens before the app: the one drawn in index.html's boot
   screen (outlined letters, so no font is needed), copied before the app replaces that screen. */
const WORDMARK = document.querySelector('#boot .wordmark');
V.wordmark = () => (WORDMARK ? WORDMARK.cloneNode(true) : V.mark(40));

V.button = (label, opts = {}) => V.h('button.btn' + (opts.kind ? '.' + opts.kind : ''), {
  type: 'button', onclick: opts.onClick, title: opts.title, disabled: opts.disabled, 'aria-label': opts.aria || (label ? null : opts.title),
}, opts.icon ? V.icon(opts.icon) : null, label ? V.h('span', { text: label }) : null);

V.iconButton = (icon, title, onClick, cls) => V.h('button.icon-btn' + (cls ? '.' + cls : ''), {
  type: 'button', title, 'aria-label': title, onclick: onClick,
}, V.icon(icon));

/* ---------------------------------------------------------------- dialogs and toasts */

V.sheet = function sheet({ title, content, actions = [], wide = false, onClose, dismissable = true }) {
  const layers = document.getElementById('layers');
  const previous = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.add('leaving');
    document.removeEventListener('keydown', keys, true);
    setTimeout(() => wrap.remove(), 180);
    if (previous && previous.focus) previous.focus({ preventScroll: true });
    if (onClose) onClose();
  };
  const bar = actions.length ? V.h('div.sheet-actions', {}, actions.map((a) => V.h(
    'button.btn' + (a.kind ? '.' + a.kind : ''), {
      type: 'button',
      onclick: async () => {
        if (!a.onClick) return close();
        const keep = await a.onClick(close);
        if (keep !== true) close();
      },
    }, a.icon ? V.icon(a.icon) : null, V.h('span', { text: a.label })))) : null;
  const panel = V.h('div.sheet' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    title ? V.h('div.sheet-head', {}, V.h('h2', { text: title }),
      dismissable ? V.iconButton('x', 'Close', close, 'quiet') : null) : null,
    V.h('div.sheet-body', {}, content), bar);
  const wrap = V.h('div.layer', {
    onmousedown: (event) => { if (dismissable && event.target === wrap) close(); },
  }, panel);
  const keys = (event) => {
    if (event.key === 'Escape' && dismissable) { event.stopPropagation(); close(); }
    if (event.key === 'Enter' && !event.shiftKey && event.target.tagName === 'INPUT') {
      const primary = panel.querySelector('.sheet-actions .btn.primary, .sheet-actions .btn.danger');
      if (primary) { event.preventDefault(); primary.click(); }
    }
  };
  document.addEventListener('keydown', keys, true);
  layers.append(wrap);
  requestAnimationFrame(() => {
    wrap.classList.add('shown');
    const first = panel.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) first.focus();
  });
  return { close, el: panel };
};

V.ask = (title, { value = '', placeholder = '', label = '', ok = 'OK', type = 'text', hint = '' } = {}) =>
  new Promise((resolve) => {
    let answered = null;
    const input = V.h('input.field', { type, value, placeholder, autocomplete: 'off', 'aria-label': label || title });
    V.sheet({
      title,
      content: [label ? V.h('label.label', { text: label }) : null, input, hint ? V.h('p.hint', { text: hint }) : null],
      actions: [{ label: 'Cancel' }, { label: ok, kind: 'primary', onClick: () => { answered = input.value; } }],
      onClose: () => resolve(answered),
    });
  });

V.confirm = (title, text, { ok = 'OK', danger = false } = {}) => new Promise((resolve) => {
  let yes = false;
  V.sheet({
    title,
    content: text ? V.h('p', { text }) : null,
    actions: [{ label: 'Cancel' }, { label: ok, kind: danger ? 'danger' : 'primary', onClick: () => { yes = true; } }],
    onClose: () => resolve(yes),
  });
});

V.menu = function menu(anchor, items) {
  const rect = anchor.getBoundingClientRect();
  const list = V.h('div.menu', { role: 'menu' }, items.filter(Boolean).map((item) => V.h(
    'button.menu-item' + (item.danger ? '.danger' : ''), {
      type: 'button', role: 'menuitem',
      onclick: () => { done(); item.onClick(); },
    }, item.icon ? V.icon(item.icon) : null, V.h('span', { text: item.label }))));
  const wrap = V.h('div.layer.menu-layer', { onmousedown: (event) => { if (event.target === wrap) done(); } }, list);
  const done = () => { wrap.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = (event) => { if (event.key === 'Escape') { event.stopPropagation(); done(); } };
  document.addEventListener('keydown', esc, true);
  document.getElementById('layers').append(wrap);
  const width = list.offsetWidth, height = list.offsetHeight;
  list.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)) + 'px';
  list.style.top = (rect.bottom + height + 8 > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4) + 'px';
  const first = list.querySelector('button');
  if (first) first.focus();
};

V.toast = function toast(text, { kind = '', action, onAction, ms = 3200 } = {}) {
  const box = document.getElementById('toasts');
  const item = V.h('div.toast' + (kind ? '.' + kind : ''), { role: 'status' },
    kind === 'err' ? V.icon('alert') : null, V.h('span', { text }),
    action ? V.h('button.toast-action', { type: 'button', text: action, onclick: () => { onAction(); gone(); } }) : null);
  const gone = () => { item.classList.add('leaving'); setTimeout(() => item.remove(), 200); };
  box.append(item);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(gone, action ? Math.max(ms, 5000) : ms);
};

V.problem = (error) => {
  const text = (error && (error.message || error.error_description || error.msg)) || String(error);
  console.warn('Vault:', error);
  V.toast(text, { kind: 'err', ms: 5000 });
};

/* ---------------------------------------------------------------- little things */

V.uuid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

V.debounce = (fn, ms) => {
  let timer = null;
  const run = (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
  run.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  run.pending = () => timer !== null;
  run.cancel = () => { clearTimeout(timer); timer = null; };
  return run;
};

/* The same rule as vault/cloud.py's storage_name: Supabase Storage refuses most characters in a path. */
V.storageName = (name) => {
  const clean = String(name || '').trim();
  const dot = clean.lastIndexOf('.');
  let stem = dot < 0 ? clean : clean.slice(0, dot);
  let ext = dot < 0 ? '' : clean.slice(dot + 1);
  stem = stem.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
  ext = ext.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10);
  return (stem.slice(0, 80) + (ext ? '.' + ext : '')).toLowerCase();
};

V.size = (bytes) => {
  if (!bytes) return '0 KB';
  if (bytes < 1000 * 1000) return Math.max(1, Math.round(bytes / 1000)) + ' KB';
  if (bytes < 1000 * 1000 * 1000) return (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + ' MB';
  return (bytes / 1e9).toFixed(2) + ' GB';
};

const pad = (n) => String(n).padStart(2, '0');
V.dateText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
V.today = () => V.dateText(new Date());
V.addDays = (text, days) => { const d = V.parseDate(text); d.setDate(d.getDate() + days); return V.dateText(d); };
V.parseDate = (text) => { const [y, m, d] = String(text).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const DAY = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

V.due = (text, done) => {
  if (!text) return null;
  const days = Math.round((V.parseDate(text) - V.parseDate(V.today())) / DAY);
  const d = V.parseDate(text);
  let label;
  if (done) label = 'Done';
  else if (days < -1) label = `${-days} days late`;
  else if (days === -1) label = 'Due yesterday';
  else if (days === 0) label = 'Due today';
  else if (days === 1) label = 'Due tomorrow';
  else if (days < 7) label = `Due ${WEEKDAYS[d.getDay()]}`;
  else label = `Due ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return { label, days, cls: done ? 'done' : days < 0 ? 'late' : days <= 1 ? 'today' : days <= 3 ? 'soon' : '' };
};

V.ago = (iso) => {
  if (!iso) return '';
  const then = new Date(iso);
  const seconds = (Date.now() - then) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400 && then.getDate() === new Date().getDate()) {
    return then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const days = Math.round((V.parseDate(V.today()) - V.parseDate(V.dateText(then))) / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[then.getDay()];
  return `${MONTHS[then.getMonth()]} ${then.getDate()}` + (then.getFullYear() !== new Date().getFullYear() ? `, ${then.getFullYear()}` : '');
};

V.isLink = (text) => /^https?:\/\/\S+$/i.test(String(text || '').trim());

V.copy = async (text) => {
  if (V.desktop && V.pc) return V.pc.setClipboard(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const area = V.h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
};

/* The side-by-side layout (styles.css's 900 px line). `V.onWide` hears the window crossing it either way. */
const WIDE = window.matchMedia('(min-width: 900px)');
V.wide = () => WIDE.matches;
V.onWide = (fn) => WIDE.addEventListener('change', () => fn(WIDE.matches));

/* Words changed on two devices from the same starting point, put together line by line (a three-way merge, like
   diff3). Each side's changes are runs of lines replaced, added or removed; runs that touch different lines are all
   kept (when both add lines at the same spot, this device's come first: it's the line being typed). Where both
   changed the same lines differently, this device's lines stay and `conflict` says so. Lines that differ only by
   spaces at their end count as the same (Jarvis tidies those). `map(line)` tells where a line of `mine` ended up
   (-1 if it went), so the caret can follow its words. */
V.mergeLines = (start, mine, theirs) => {
  const B = start.split('\n');
  const M = mine.split('\n');
  const T = theirs.split('\n');
  const same = (a, b) => a === b || a.trimEnd() === b.trimEnd();
  function diff(to) {
    const n = B.length;
    const m = to.length;
    if (n * m > 4000000) return null;  // a huge note: not worth the memory
    const w = m + 1;
    const L = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = same(B[i], to[j]) ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    const hunks = [];
    const at = new Array(n).fill(-1);  // a starting line kept: where it is in `to`
    let i = 0;
    let j = 0;
    let hunk = null;
    while (i < n || j < m) {
      if (i < n && j < m && same(B[i], to[j])) { hunk = null; at[i] = j; i++; j++; continue; }
      if (!hunk) { hunk = { a: i, b: i, from: j, lines: [] }; hunks.push(hunk); }
      if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { hunk.lines.push(to[j]); j++; }
      else { i++; hunk.b = i; }
    }
    return { hunks, at };
  }
  const dm = diff(M);
  const dt = diff(T);
  if (!dm || !dt) return { text: mine, conflict: theirs !== start && theirs !== mine, map: (k) => k };
  const inside = (p, h) => h.a < p && p < h.b;
  const overlap = (x, y) => (x.a < y.b && y.a < x.b) || (x.a === x.b && inside(x.a, y)) || (y.a === y.b && inside(y.a, x));
  const alike = (x, y) => x.a === y.a && x.b === y.b && x.lines.length === y.lines.length
    && x.lines.every((line, k) => same(line, y.lines[k]));
  let conflict = false;
  const kept = dt.hunks.filter((t) => !dm.hunks.some((h) => {
    if (alike(h, t)) return true;  // the very same change on both: once
    if (overlap(h, t)) { conflict = true; return true; }
    return false;
  }));
  const all = [...dm.hunks.map((h) => ({ ...h, mine: true })), ...kept.map((h) => ({ ...h, mine: false }))];
  const covered = new Array(B.length).fill(false);
  for (const h of all) for (let q = h.a; q < h.b; q++) covered[q] = true;
  const out = [];
  const where = new Array(M.length).fill(-1);
  const emit = (h) => {
    // A line of `mine` that the other side rewrote (one this side left alone) is followed to its new version.
    if (!h.mine && h.lines.length) {
      for (let q = h.a; q < h.b; q++) if (dm.at[q] >= 0) where[dm.at[q]] = out.length + Math.min(q - h.a, h.lines.length - 1);
    }
    h.lines.forEach((line, k) => { if (h.mine) where[h.from + k] = out.length; out.push(line); });
  };
  for (let p = 0; p <= B.length; p++) {
    for (const h of all) if (h.mine && h.a === p && h.a === h.b) emit(h);
    for (const h of all) if (!h.mine && h.a === p && h.a === h.b) emit(h);
    for (const h of all) if (h.a === p && h.b > h.a) emit(h);
    if (p < B.length && !covered[p]) { const k = dm.at[p]; where[k] = out.length; out.push(M[k]); }
  }
  return { text: out.join('\n'), conflict, map: (k) => (k >= 0 && k < where.length ? where[k] : -1) };
};

/* How much differs between two texts (what's left once their common start and end are taken away). */
V.changeSize = (a, b) => {
  let from = 0;
  const most = Math.min(a.length, b.length);
  while (from < most && a[from] === b[from]) from++;
  let tail = 0;
  while (tail < most - from && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return a.length + b.length - 2 * (from + tail);
};

/* The PC app is told which theme shows (its window, the quick note box), and follows Windows' own. */
if (V.desktop) {
  V.on('pc:scheme', ({ scheme }) => V.theme.system(scheme));
  const tell = () => { if (V.pc) V.pc.call('theme', { dark: V.theme.current() === 'dark' }).catch(() => {}); };
  V.on('theme', tell);
  window.addEventListener('DOMContentLoaded', tell);  // once cloud.js has made V.pc
}
