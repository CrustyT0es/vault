/* Vault: two reading aids, for every device the person signs in on (Settings > Appearance > Reading).

   Dyslexia-friendly text: an easy-to-read font (Lexend or OpenDyslexic, vendored in fonts/ and only fetched once
   chosen), more room between letters, words and lines, a soft page colour behind the words and slightly softer
   letters, italics shown upright in the accent colour, and (its own switch) a reading ruler in the Read view: a soft
   band one line high that follows the pointer, or the line last pressed.

   Quick read: the first third of each word (ceil(letters / 3): "Reading" -> "Rea", a word of one to three letters ->
   its first) drawn heavier on a soft colour (the colour has its own switch: off, just the heavier letters), so the eye
   can jump from word to word. In reading text only: a note's
   Read view and its formatted words in the editor (js/editor.js draws the box being written in itself, in its copies,
   without changing a letter's width), flash cards in Review and Learn, Chat's answers and announcements. Never in
   the app's own labels, list titles, `code`, links, or a locked note.

   The choices live in the settings row's extra.reading (changed through V.cloud.changeExtra, like "Use Claude too",
   so they follow the person everywhere), with a copy in localStorage 'vault-reading' so they're on from the very first
   frame, before the cloud answers. They're attributes on <html> (data-reading, data-reading-font, data-reading-tint,
   data-reading-ruler, data-quick, data-quick-plain) and styles.css does the rest; Quick read's pieces are spans put round the first
   letters of each word in what's already drawn (textContent only, never innerHTML), so copying gives the words as
   they are. */
'use strict';

V.reading = (() => {
  const KEY = 'vault-reading';
  const FONTS = ['lexend', 'opendyslexic'];
  const TINTS = ['none', 'cream', 'peach', 'mint', 'sky', 'lilac'];
  const COLOURS = ['blue', 'yellow', 'green', 'pink', 'purple'];
  const DEFAULTS = { dyslexia: false, font: 'lexend', tint: 'none', ruler: false, quick: false, quickColour: 'blue',
    quickHighlight: true };

  /* Whatever was stored, made into a whole, sensible set of choices (unknown values: the defaults). */
  function tidy(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      dyslexia: r.dyslexia === true,
      font: FONTS.includes(r.font) ? r.font : DEFAULTS.font,
      tint: TINTS.includes(r.tint) ? r.tint : DEFAULTS.tint,
      ruler: r.ruler === true,
      quick: r.quick === true,
      quickColour: COLOURS.includes(r.quickColour) ? r.quickColour : DEFAULTS.quickColour,
      quickHighlight: r.quickHighlight !== false,  // (on unless switched off: choices kept before it existed have it on)
    };
  }
  const same = (a, b) => Object.keys(DEFAULTS).every((k) => a[k] === b[k]);

  function cached() {
    try { return tidy(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (error) { return tidy(null); }
  }
  function keep(choices) {
    try {
      if (same(choices, DEFAULTS)) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(choices));
    } catch (error) { /* private browsing: they still come from the cloud */ }
  }

  let now = cached();

  /* The choices as attributes on <html>: the font, spacing, colour and ruler only while dyslexia-friendly text is on. */
  function apply() {
    const html = document.documentElement;
    const set = (name, value) => { if (value) html.setAttribute(name, value); else html.removeAttribute(name); };
    set('data-reading', now.dyslexia ? 'on' : '');
    set('data-reading-font', now.dyslexia ? now.font : '');
    set('data-reading-tint', now.dyslexia && now.tint !== 'none' ? now.tint : '');
    set('data-reading-ruler', now.dyslexia && now.ruler ? 'on' : '');
    set('data-quick', now.quick ? now.quickColour : '');
    set('data-quick-plain', now.quick && !now.quickHighlight ? 'on' : '');  // (just the heavier letters, no colour)
  }
  apply();  // (at once: this file comes right after util.js, before anything is drawn)

  /* The settings row changed (here, or on another device): its extra.reading is what counts from now on. A row not
     read yet (a new device, nothing kept) changes nothing. */
  function follow() {
    const extra = (V.data && V.data.settings && V.data.settings.extra) || null;
    if (!extra || typeof extra !== 'object') return;
    const fresh = tidy(extra.reading);
    if (same(fresh, now)) return;
    const was = now;
    now = fresh;
    keep(now);
    apply();
    V.emit('reading', { was, now });
  }
  V.on('data', (table) => { if (table === 'settings') follow(); });
  // Someone else may sign in here next: their own choices come with their settings, never these.
  const forget = () => { keep(DEFAULTS); };
  V.on('signing-out', forget);
  V.on('signed-out', forget);

  /* Changes some of the choices for every device. Throws (nothing changed, here or anywhere) when the cloud can't be
     reached in time; the caller says so and puts its switch back. */
  async function set(changes) {
    await V.cloud.changeExtra((extra) => ({ ...extra, reading: { ...tidy(extra.reading), ...changes } }));
    follow();  // (the cloud's answer is kept by then: drawn here at once)
  }

  /* The plain sentence for a change that didn't go through. */
  const NOT_CHANGED = 'That reading setting wasn\'t changed: Wefty couldn\'t reach your cloud. Check you\'re online and try again.';

  /* One of the switches turned on or off (a note's ⋯ menu), with a line saying so either way. */
  const NAMES = { quick: 'Quick read', quickHighlight: 'Quick read\'s colour', dyslexia: 'Dyslexia-friendly text' };
  async function toggle(name) {
    const want = !now[name];
    try {
      await set({ [name]: want });
      V.toast(`${NAMES[name]} is ${want ? 'on' : 'off'}, on every device you use.`);
    } catch (error) {
      console.warn('Vault:', error);
      V.toast(NOT_CHANGED, { kind: 'err', ms: 5000 });
    }
  }

  /* -- Quick read */

  // A word: letters and numbers (with their accents), joined by an apostrophe ("don't", "Friday's", "o'clock").
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;
  const LETTER = /[\p{L}\p{N}]/u;
  const MARK = /\p{M}/u;

  /* Where Quick read's pieces go in `text`: [start, end) of the first ceil(n / 3) letters of each word (n: its letters
     and numbers; the accents written after a letter go with it, an apostrophe between two of them too). */
  function ranges(text) {
    const out = [];
    if (!text || !LETTER.test(text)) return out;
    WORD.lastIndex = 0;
    for (let found = WORD.exec(text); found; found = WORD.exec(text)) {
      const word = found[0];
      let count = 0;
      for (const ch of word) if (LETTER.test(ch)) count++;
      const want = Math.ceil(count / 3);
      let seen = 0;
      let end = 0;
      for (const ch of word) {
        if (seen === want && !MARK.test(ch)) break;
        if (LETTER.test(ch)) seen++;
        end += ch.length;
      }
      out.push([found.index, found.index + end]);
    }
    return out;
  }

  const QUICK = 'quick-lead';
  // Never inside these: code, links (their words and their addresses), the app's own controls, and what's already one.
  const SKIP = 'code, pre, kbd, samp, a, button, input, textarea, select, label, [contenteditable], .quick-lead, .no-quick';

  /* Quick read's pieces put into what's drawn in `container`: each text node's words get a span round their first
     letters. `map` (text node -> { col, ... }, as js/format.js's Read view and js/editor.js's formatted copies keep
     them) learns the pieces a node is split into, each at its own place, so a tap still lands on the right letter.
     `from` (a text node) leaves out what comes before it. Returns how many pieces were made. */
  function quick(container, map = null, from = null) {
    if (!container) return 0;
    const inside = (node) => {
      const parent = node.parentElement;
      const skip = parent && parent.closest(SKIP);
      return skip && container.contains(skip) && skip !== container;
    };
    const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let started = !from;
    while (walk.nextNode()) {
      const node = walk.currentNode;
      if (!started) { started = node === from; if (!started) continue; }
      if (node.length && LETTER.test(node.data) && !inside(node)) nodes.push(node);
    }
    let made = 0;
    for (const node of nodes) made += wrap(node, ranges(node.data), QUICK, map);
    return made;
  }

  /* The spans (class `cls`) round [start, end) pieces of one text node, the node split as it goes. */
  function wrap(node, list, cls, map) {
    if (!list.length) return 0;
    const at = map ? map.get(node) : null;
    const note = (piece, offset) => { if (at) map.set(piece, { ...at, col: at.col + offset }); };
    let rest = node;
    let start = 0;  // where `rest` starts in the node's words
    for (const [a, b] of list) {
      if (a > start) { rest = rest.splitText(a - start); note(rest, a); start = a; }
      let tail = null;
      if (b - start < rest.length) { tail = rest.splitText(b - start); note(tail, b); }
      const span = document.createElement('span');
      span.className = cls;
      rest.parentNode.insertBefore(span, rest);
      span.append(rest);
      if (!tail) break;
      rest = tail;
      start = b;
    }
    return list.length;
  }

  /* Spans (class `cls`) round [start, end) pieces of a line's words, in a copy of them laid out as a line (js/editor.js:
     the copies of a box's words): `holder`'s text, read in order, is the line's words. Pieces that run across two
     text nodes get a span in each. */
  function wrapLine(holder, list, cls) {
    if (!list.length) return 0;
    const walk = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let at = 0;
    while (walk.nextNode()) { nodes.push([walk.currentNode, at]); at += walk.currentNode.length; }
    for (const [node, start] of nodes) {
      const end = start + node.length;
      const mine = list.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
      wrap(node, mine, cls, null);
    }
    return list.length;
  }

  /* Takes Quick read's pieces out of `container` again, the words put back together (so they're split right when
     they go in again): each run of text nodes becomes its first, which keeps its place in `map` (it starts where the
     run starts). */
  function unquick(container) {
    const parents = new Set();
    for (const span of container.querySelectorAll('span.' + QUICK)) {
      parents.add(span.parentNode);
      span.replaceWith(...span.childNodes);
    }
    for (const parent of parents) {
      let node = parent.firstChild;
      while (node) {
        const next = node.nextSibling;
        if (node.nodeType === Node.TEXT_NODE && next && next.nodeType === Node.TEXT_NODE) {
          node.appendData(next.data);
          next.remove();
        } else node = next;
      }
    }
  }

  /* A piece of reading text drawn somewhere (a Read view, an answer, a card): Quick read's pieces go in now if it's
     on, and come and go with the setting. `map`: see quick. */
  const maps = new WeakMap();
  function area(container, map = null) {
    if (!container) return container;
    container.setAttribute('data-quick-area', '');
    if (map) maps.set(container, map);
    if (now.quick) quick(container, map);
    return container;
  }
  V.on('reading', ({ was }) => {
    if (was.quick === now.quick) return;
    for (const container of document.querySelectorAll('[data-quick-area]')) {
      if (now.quick) quick(container, maps.get(container) || null); else unquick(container);
    }
  });

  /* -- the reading ruler (the Read view only) */

  /* A soft band one line high across `view` (the Read view), on the line under the pointer as it moves, or the line
     last pressed. It's drawn behind nothing and never takes a press (pointer-events: none). */
  function ruler(view) {
    const band = V.h('div.reading-ruler', { 'aria-hidden': 'true', hidden: true });
    view.prepend(band);
    const place = (x, y) => {
      if (!now.dyslexia || !now.ruler || !band.isConnected) { band.hidden = true; return; }
      const spot = lineAt(view, x, y);
      if (!spot) return;
      const box = view.getBoundingClientRect();
      band.style.top = `${spot.top - box.top}px`;
      band.style.height = `${spot.height}px`;
      band.hidden = false;
    };
    view.addEventListener('pointermove', (event) => { if (event.pointerType !== 'touch') place(event.clientX, event.clientY); });
    view.addEventListener('pointerdown', (event) => place(event.clientX, event.clientY));
    return band;  // (switched off meanwhile, styles.css hides it)
  }

  /* The line of words under a point in `view`: { top, height } on the screen, one line high round the letter there. */
  function lineAt(view, x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const found = document.caretPositionFromPoint(x, y);
      if (found) { node = found.offsetNode; offset = found.offset; }
    } else if (document.caretRangeFromPoint) {
      const found = document.caretRangeFromPoint(x, y);
      if (found) { node = found.startContainer; offset = found.startOffset; }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !view.contains(node) || !node.length) return null;
    const range = document.createRange();
    const at = Math.min(offset, node.length - 1);
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const rect = [...range.getClientRects()].find((r) => r.height > 0);
    if (!rect) return null;
    const style = getComputedStyle(node.parentElement);
    const line = parseFloat(style.lineHeight) || rect.height;
    const middle = (rect.top + rect.bottom) / 2;
    return { top: middle - line / 2, height: line };
  }

  return {
    FONTS, TINTS, COLOURS, DEFAULTS, NOT_CHANGED,
    get: () => ({ ...now }),
    quickOn: () => now.quick,
    look: () => (now.quick ? now.quickColour : ''),
    highlightOn: () => now.quick && now.quickHighlight,
    set, toggle, tidy, ranges, quick, unquick, wrapLine, area, ruler,
  };
})();
