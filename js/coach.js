/* Wefty: the one-time "Two things moved" tip (1.16). On a phone, Select, Sort and View went into the Notes screen's ⋯,
   and Settings went behind your picture: someone who used Wefty before this version is shown where, once.

   - A phone: on Today, "Settings is behind your picture", pointing at the picture; on Notes, "Select, Sort and View
     are in ⋯ now", pointing at the ⋯ (with the picture's line too, when Today's tip hasn't been seen: the mockup's g3).
   - Wide (a Chromebook, the PC): only the picture's line, at the rail's foot (Select, Sort and View are still in sight
     there).
   - Once per device (localStorage vault-coach-116: the lines seen), "Got it" (or a tap on what it points at) puts each
     line away for good. Never for a new account (no note older than today: a PC that starts on a downloaded version
     has no update "from" to go by, so the notes are the test), never during the welcome steps, and only at a calm
     moment: nothing over the app (a sheet, a menu, an announcement, the full-screen note), no toast showing (the
     update's "Updated to Wefty..." goes first), nothing being typed, a locked note not showing. js/news.js counts the
     tip as something over the app, so an announcement waits for it too.
   It never takes the keyboard's place, never stops anything behind it, and can't throw into the screen it's on. */
'use strict';

V.coach = (() => {
  const KEY = 'vault-coach-116';
  const LOOK_EVERY = 1500;     // ms between looks for a calm moment
  const LOOK_FOR = 120000;     // ...for this long on one screen, then it waits for the next screen
  let memory = null;           // the lines seen, when storage can't be used
  let tip = null;              // { el, anchors, lines, place }
  let timer = null;
  let since = 0;

  function seen() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(saved)) return new Set(saved.filter((x) => typeof x === 'string'));
    } catch (error) { /* (memory, below) */ }
    return new Set(memory || []);
  }
  function remember(lines) {
    const all = seen();
    for (const line of lines) all.add(line);
    memory = [...all];
    try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch (error) { /* lasts until the page closes */ }
  }

  /* Someone who had notes before today: the tip is about things that moved, and a new account saw nothing move. Both
     times are the cloud's own (a note's created_at against the newest change it stamped in the account), so a device
     whose clock is off can't tell a new account it's an old one, or the other way round. */
  const OLDER_BY = 20 * 3600 * 1000;
  function oldHand() {
    const user = V.data && V.data.user;
    if (!user || !user.id) return false;
    if (V.welcome && V.welcome.pending && V.welcome.pending(user.id)) return false;
    let newest = 0, oldest = Infinity;
    const look = (row, made) => {
      const changed = Date.parse((row && row.updated_at) || '');
      if (changed > newest) newest = changed;
      const born = made ? Date.parse(row.created_at || '') : NaN;
      if (born < oldest) oldest = born;
    };
    for (const note of V.data.notes.values()) look(note, true);
    for (const folder of V.data.folders.values()) look(folder, false);
    if (V.data.settings) look(V.data.settings, false);
    return Number.isFinite(oldest) && newest - oldest > OLDER_BY;
  }

  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  // Something came over the app since the tip showed: a sheet, a menu, an announcement, the full-screen note.
  const covered = () => !!document.querySelector('#layers > :not(.nt-strip):not(.coach)')
    || !!(V.editor && V.editor.covering && V.editor.covering());
  const picture = () => [...document.querySelectorAll('button.me')].find(shown) || null;
  const more = () => [...document.querySelectorAll('.view[data-tab=notes] .notes-more')].find(shown) || null;

  function calm() {
    const app = document.getElementById('app');
    if (!app || !app.classList.contains('ready') || app.classList.contains('gate')) return false;
    if (V.away && V.away()) return false;
    if (covered()) return false;  // a sheet, menu, announcement, the full-screen note...
    if (document.querySelector('#toasts > .toast:not(.leaving), #toasts > .notice')) return false;
    const current = V.editor && V.editor.openId && V.editor.openId() && V.editor.current ? V.editor.current() : null;
    if (current && current.locked) return false;
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(String(el.type))))) return false;
    return true;
  }

  /* What this screen's tip would say (and where it points), or null. */
  function plan() {
    const view = V.tab ? V.tab() : '';
    const have = seen();
    const wide = V.wide();
    if (wide) {
      if (have.has('me') || (view !== 'today' && view !== 'notes')) return null;
      const anchor = picture();
      return anchor ? { lines: ['me'], anchor, anchors: [anchor], place: 'side' } : null;
    }
    if (view === 'notes' && !have.has('more')) {
      const anchor = more();
      if (!anchor) return null;
      const lines = have.has('me') ? ['more'] : ['more', 'me'];
      return { lines, anchor, anchors: [anchor, lines.includes('me') ? picture() : null].filter(Boolean), place: 'below' };
    }
    if (view === 'today' && !have.has('me')) {
      const anchor = picture();
      return anchor ? { lines: ['me'], anchor, anchors: [anchor], place: 'below' } : null;
    }
    return null;
  }

  const LINES = {
    more: { icon: () => V.icon('more'), strong: 'Select, Sort and View', rest: ' are in ⋯ now.' },
    me: { icon: () => {
      const letter = (Array.from(String((V.data.user || {}).name || (V.data.user || {}).email || '').trim())[0] || '?').toUpperCase();
      return V.h('span.av.mini', { text: letter });
    }, strong: 'Settings', rest: ' is behind your picture.' },
  };

  function show(chosen) {
    hide();
    const close = () => { remember(chosen.lines); hide(); };
    const el = V.h('div.coach', { role: 'dialog', 'aria-label': chosen.lines.length > 1 ? 'Two things moved' : 'Something moved' },
      V.h('span.coach-arrow', { 'aria-hidden': 'true' }),
      chosen.lines.length > 1 ? V.h('p.coach-title', { text: 'Two things moved' }) : null,
      chosen.lines.map((key) => V.h('div.coach-row', { dataset: { line: key } },
        V.h('span.coach-ic', { 'aria-hidden': 'true' }, LINES[key].icon()),
        V.h('span', {}, V.h('b', { text: LINES[key].strong }), LINES[key].rest))),
      V.h('div.coach-foot', {}, V.button('Got it', { kind: 'primary', onClick: close })));
    el.classList.add(chosen.place);
    document.getElementById('layers').append(el);
    for (const anchor of chosen.anchors) {
      anchor.classList.add('coach-lit');
      anchor.addEventListener('click', close, { once: true });
    }
    tip = { el, ...chosen, close };
    watchLayers();
    place();
  }

  /* A sheet or menu opening over the app (they sit under the tip) puts the tip away for now, unseen. */
  let watching = null;
  function watchLayers() {
    if (watching || typeof MutationObserver !== 'function') return;
    const layers = document.getElementById('layers');
    if (!layers) return;
    // (A task later, not at once: a tap on what the tip points at may open its menu, and its own Got-it listener,
    // which puts the line away for good, runs first.)
    watching = new MutationObserver(() => setTimeout(() => { if (tip && covered()) later(); }));
    watching.observe(layers, { childList: true });
  }

  /* The tip put away unseen (what it pointed at was drawn again, or something came over it), and looked for again. */
  function later() {
    hide();
    clearTimeout(timer);
    since = Date.now();
    timer = setTimeout(look, LOOK_EVERY);
  }

  function hide() {
    if (!tip) return;
    for (const anchor of tip.anchors) {
      anchor.classList.remove('coach-lit');
      anchor.removeEventListener('click', tip.close);
    }
    tip.el.remove();
    tip = null;
  }

  /* Beside what it points at: under it on a phone (the arrow up at its middle), to its right at the rail's foot. */
  function place() {
    if (!tip) return;
    const { el, anchor } = tip;
    // (Today and Notes draw their top rows again with the data: the new picture or ⋯ is found at the next look.)
    if (!anchor.isConnected || covered()) { later(); return; }
    if (!shown(anchor)) { el.hidden = true; return; }
    el.hidden = false;
    const r = anchor.getBoundingClientRect();
    const width = el.offsetWidth, height = el.offsetHeight;
    const arrow = el.querySelector('.coach-arrow');
    if (tip.place === 'side') {
      const top = Math.max(8, Math.min(window.innerHeight - height - 8, r.bottom - height));
      el.style.left = (r.right + 12) + 'px';
      el.style.top = top + 'px';
      arrow.style.top = (r.top + r.height / 2 - top - 6) + 'px';
      arrow.style.left = '';
    } else {
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
      el.style.left = left + 'px';
      el.style.top = (r.bottom + 10) + 'px';
      arrow.style.left = (r.left + r.width / 2 - left - 6) + 'px';
      arrow.style.top = '';
    }
  }

  function look() {
    clearTimeout(timer);
    timer = null;
    try {
      if (tip) { place(); return; }
      if (!oldHand()) return;
      const chosen = plan();
      if (!chosen) return;
      if (calm()) { show(chosen); return; }
    } catch (error) {
      console.error(error);  // (a tip that can't be shown is no reason to trouble anything else)
      return;
    }
    if (Date.now() - since < LOOK_FOR) timer = setTimeout(look, LOOK_EVERY);
  }

  /* A screen was opened: the tip of the last one goes (unseen, so it can come back), and this one's is looked for. */
  function maybe() {
    hide();
    clearTimeout(timer);
    since = Date.now();
    timer = setTimeout(look, LOOK_EVERY);
  }

  V.on('tab', maybe);
  V.on('note-opened', () => { if (tip) setTimeout(place); });  // (a note over Today on a phone: the tip mustn't sit on it)
  const stop = () => { hide(); clearTimeout(timer); timer = null; };
  V.on('signing-out', stop);
  V.on('signed-out', stop);
  if (V.onWide) V.onWide(() => maybe());
  window.addEventListener('resize', () => place());
  document.addEventListener('scroll', () => place(), { capture: true, passive: true });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && tip) hide(); });

  return { maybe, hide, showing: () => !!tip, lines: () => (tip ? [...tip.lines] : []), KEY };
})();
