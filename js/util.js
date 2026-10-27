/* Vault: small helpers every other file uses (the V namespace, building elements, icons, dialogs, toasts, dates).
   Every script is a plain script sharing `V`, so the same files run on the phone (GitHub Pages), in the PC app
   (vault://app/ inside Qt) and in the tests, with nothing to build. User text only ever goes in as textContent. */
'use strict';

const V = (window.V = window.V || {});
V.VERSION = '1.0.1';
V.desktop = !!window.VAULT_DESKTOP;  // set by the PC app (vault/desktop.py) before any script runs
V.device = V.desktop ? 'pc' : 'phone';
V.other = V.desktop ? 'phone' : 'pc';
V.otherName = V.desktop ? 'your phone' : 'your PC';

/* ---------------------------------------------------------------- events */

V.bus = new EventTarget();
V.on = (type, fn) => V.bus.addEventListener(type, (event) => fn(event.detail));
V.emit = (type, detail) => V.bus.dispatchEvent(new CustomEvent(type, { detail }));

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

/* Line icons (drawn after Feather's, MIT): only these fixed strings ever go through innerHTML. */
const ICONS = {
  notes: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 12h8M8 16h6"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  clip: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checklist: '<path d="m3 7 2 2 4-4"/><path d="M13 7h8"/><path d="m3 17 2 2 4-4"/><path d="M13 17h8"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6M12 4v16"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  pc: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  cloud: '<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  restore: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};

V.icon = function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  return span;
};

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
  const item = V.h('div.toast' + (kind ? '.' + kind : ''), { role: 'status' }, V.h('span', { text }),
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

V.wide = () => window.matchMedia('(min-width: 900px)').matches;

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
