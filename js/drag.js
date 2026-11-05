/* Wefty: picking something up and putting it somewhere else by dragging (1.17). js/notes.js drags notes onto folders
   and folders into order or into each other; js/organise.js's "Arrange folders" sheet drags folders by their handles.

   One way for every pointer, so a mouse, a finger, the S Pen and a Chromebook's touchscreen all work alike (the
   browser's own drag and drop is left out: phones barely have it, and its picture can't say where a drop would go):
   - a mouse drags once it has moved a few pixels (less is a click, so Ctrl/Shift+click and opening still work);
   - a finger or a pen holds first (a long press, which still picks a note or, let go, opens a folder's options), then
     moves; moving before the hold is a scroll, left to the browser. A handle (`handle`) needs no hold.
   While dragging, a small label follows the pointer; the thing under it is asked (`resolve`) what a drop there would
   do: lit to drop into it, a line between two things to go there, or crossed out with the reason said on a drop. The
   lists it can reach (`scroll`) scroll by themselves near their edges. Esc, a second finger, the browser taking the
   touch back, or Wefty going to the background puts it down where it was. What a drop does (and its Undo) is the
   caller's. */
'use strict';

V.drag = (() => {
  const HOLD = V.LONG_PRESS || 450;  // ms a finger or the S Pen stays down before it can drag (js/util.js: a long press)
  const SLOP = 10;           // px a finger may wander during that (more is a scroll)
  const START_MOUSE = 5;     // px a mouse moves before it's a drag (less is a click)
  const START_HELD = 6;      // px a held finger moves before it's a drag (less: it was only held, then let go)
  const EDGE = 44;           // px from a list's edge where it scrolls by itself...
  const SPEED = 16;          // ...this many px a frame at the very edge
  const root = document.documentElement;

  let pending = null;        // a pointer down on something that can be dragged: {el, opts, id, touchy, x0, y0, ...}
  let active = null;         // the drag going on: pending's fields, plus {data, target, ghost, line, frame}
  let since = 0;             // when the drag going on started
  let swallow = null;        // {until, types, x, y}: the mouse events a lift or a drop makes there, kept from what's under

  const buzz = () => { try { if (navigator.vibrate) navigator.vibrate(12); } catch (error) { /* no buzz, no matter */ } };

  /* `el` can be dragged. Options:
     data()          what's dragged, as {label, icon, ...anything resolve needs}; null: nothing to drag now
     resolve(under, x, y, data)   what a drop at (x, y) would do, `under` being the element there (never the label):
                     null (nothing), or {ok, why, el, into, line, run}: `el` lit (into: true) or crossed out (ok: false),
                     `line` {x, y, w, h} a line drawn there, `run()` what a drop does, `why` said for a drop refused
     onHold()        a finger or pen held on it (before any drag): js/notes.js picks a note
     onHoldUp()      ...and let go without dragging: a folder's options
     scroll()        the lists to scroll near their edges: [{el, axis: 'x' | 'y', top: () => px, pastTop: px}] (top:
                     where the list's own top edge is, when something sticks over it; pastTop: how far above that
                     still scrolls it, 88 px unless said)
     mouse           false: a mouse never drags it
     handle          a selector inside `el` where a finger drags at once, without holding */
  // While a finger is held on something that can be dragged, nothing starts picking words.
  document.addEventListener('selectstart', (event) => {
    if ((pending && pending.touchy) || (active && active.touchy)) event.preventDefault();
  }, true);

  function source(el, opts) {
    el.addEventListener('pointerdown', (event) => down(event, el, opts));
    // A held finger mustn't scroll the list instead (a listener on the element itself is never passive, and it's
    // still heard when the list is drawn again under the finger and the element is no longer in the page).
    el.addEventListener('touchmove', (event) => {
      if ((active && active.el === el) || (pending && pending.el === el && pending.armed)) {
        if (event.cancelable) event.preventDefault();
      }
    });
    // Android's own long press (a contextmenu from the finger): never the right-click menu or text selection, and
    // never the hold itself (1.19.8: HOLD's timer is the one source, so a phone set to a short touch-and-hold can't
    // pick a note at one moment and open a menu at another). A finger's contextmenu with no press seen (the list drawn
    // again under it) is cancelled too: nothing but the timer picks.
    // The S Pen's side button (or a Chromebook stylus's) is a right-click, not the browser's long press: it holds at
    // once, as before 1.19.8 (its tap is shorter than HOLD).
    el.addEventListener('contextmenu', (event) => {
      const pen = event.pointerType === 'pen';
      const finger = !pen && (event.pointerType === 'touch'
        || !!(event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents));
      const pressed = pending && pending.el === el && pending.touchy;
      const mine = (active && active.el === el) || pressed || finger || (pen && !!opts.onHold);
      if (!mine) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!pen || active) return;
      if (pressed) {
        if (!pending.held) hold();
      } else {
        buzz();
        try { opts.onHold(); } catch (error) { console.error(error); }
      }
    }, true);
    el.addEventListener('dragstart', (event) => event.preventDefault());  // (a picture or link's own drag)
    return el;
  }

  function down(event, el, opts) {
    if (active || !event.isPrimary) return;
    const touchy = event.pointerType !== 'mouse';
    if (!touchy && (event.button !== 0 || opts.mouse === false)) return;
    clearPending();
    const quick = touchy && !!opts.handle && !!event.target.closest(opts.handle);
    pending = { el, opts, id: event.pointerId, touchy, x0: event.clientX, y0: event.clientY, x: event.clientX,
      y: event.clientY, armed: !touchy || quick, held: false, timer: 0, at: Date.now() };
    if (touchy && !quick) pending.timer = setTimeout(hold, HOLD);
    listen(true);
  }

  function hold() {
    const p = pending;
    if (!p || p.held) return;
    clearTimeout(p.timer);
    p.held = true;
    p.armed = true;
    p.x0 = p.x;
    p.y0 = p.y;
    buzz();
    p.el.classList.add('drag-held');
    if (p.opts.onHold) {
      try { p.opts.onHold(); } catch (error) { console.error(error); }
    }
  }

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.el.classList.remove('drag-held');
    pending = null;
    if (!active) listen(false);
  }

  function moved(event) {
    if (active) {
      if (event.pointerId !== active.id) return;
      if (!active.touchy && !event.buttons) { drop(false); return; }  // (let go outside the window)
      active.x = event.clientX;
      active.y = event.clientY;
      follow();
      aim();
      return;
    }
    const p = pending;
    if (!p || event.pointerId !== p.id) return;
    if (!p.touchy && !event.buttons) { clearPending(); return; }
    p.x = event.clientX;
    p.y = event.clientY;
    const far = Math.hypot(p.x - p.x0, p.y - p.y0);
    if (!p.armed) {
      if (far > SLOP) clearPending();  // it's a scroll
      return;
    }
    if (p.dead) return;
    if (far > (p.touchy ? START_HELD : START_MOUSE)) begin();
  }

  function lifted(event) {
    if (active) {
      if (event.pointerId === active.id) drop(true);
      return;
    }
    const p = pending;
    if (!p || event.pointerId !== p.id) return;
    clearPending();
    if (p.held) {
      // Let go after holding: the tap the browser may make of it lands on nothing.
      swallowNext(['mousedown', 'mouseup', 'click'], p.x, p.y);
      if (p.opts.onHoldUp) {
        try { p.opts.onHoldUp(); } catch (error) { console.error(error); }
      }
    }
  }

  /* Another finger down while one is held or dragging: a pinch or a second tap, not a drag. */
  function another(event) {
    if (active && event.pointerId !== active.id) drop(false);
    else if (pending && event.pointerId !== pending.id) clearPending();
  }

  function cancelled(event) {
    if (active && event.pointerId === active.id) drop(false);
    else if (pending && event.pointerId === pending.id) clearPending();
  }

  function keyed(event) {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    drop(false);
  }

  const away = () => { if (active) drop(false); else clearPending(); };
  const hidden = () => { if (document.hidden) away(); };

  let listening = false;
  function listen(on) {
    if (on === listening) return;
    listening = on;
    const how = on ? 'addEventListener' : 'removeEventListener';
    window[how]('pointerdown', another, true);
    window[how]('pointermove', moved, true);
    window[how]('pointerup', lifted, true);
    window[how]('pointercancel', cancelled, true);
    window[how]('keydown', keyed, true);
    window[how]('blur', away);
    document[how]('visibilitychange', hidden);
  }

  /* -- dragging */

  function begin() {
    const p = pending;
    let data = null;
    try { data = p.opts.data ? p.opts.data() : null; } catch (error) { console.error(error); }
    if (!data) { p.dead = true; return; }  // nothing to drag here now (held notes in the Trash): just held
    clearTimeout(p.timer);
    pending = null;
    since = Date.now();
    active = { ...p, data, target: null, scrollers: [] };
    try { active.scrollers = (p.opts.scroll ? p.opts.scroll() : []).filter((s) => s && s.el); } catch (error) { console.error(error); }
    p.el.classList.remove('drag-held');
    p.el.classList.add('drag-source');
    root.classList.add('dragging', 'dragging-notes');
    try { const sel = getSelection(); if (sel && sel.rangeCount) sel.removeAllRanges(); } catch (error) { /* nothing selected */ }
    active.ghost = ghost(data, p.touchy);
    active.line = V.h('div.drop-line', { hidden: true, 'aria-hidden': 'true' });
    document.body.append(active.ghost, active.line);
    if (!p.held) buzz();
    follow();
    aim();
    active.frame = requestAnimationFrame(edges);
  }

  /* The label under the pointer: the folder's emoji and name, the note's title or "3 notes". */
  function ghost(data, touchy) {
    const lead = typeof data.icon === 'string' ? V.h('span.emoji', { text: data.icon }) : data.icon || V.icon('notes');
    const el = V.h('div.drag-ghost' + (touchy ? '.touchy' : ''), { 'aria-hidden': 'true' }, lead,
      V.h('span.drag-label', { text: data.label || '' }),
      data.count > 1 ? V.h('span.drag-count', { text: String(data.count) }) : null);
    return el;
  }

  /* The label beside the pointer: below and right of a mouse, above a finger (where it can be seen). */
  function follow() {
    const { ghost: el, x, y, touchy } = active;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    let left = touchy ? x - w / 2 : x + 14;
    let top = touchy ? y - h - 40 : y + 16;
    left = Math.max(4, Math.min(window.innerWidth - w - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - h - 4, top));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /* What's under the pointer, and what a drop there would do, shown. */
  function aim() {
    const a = active;
    const under = document.elementFromPoint(a.x, a.y);
    let target = null;
    try { target = under ? a.opts.resolve(under, a.x, a.y, a.data) : null; } catch (error) { console.error(error); }
    if (a.target && a.target.el && (!target || a.target.el !== target.el || a.target.ok !== target.ok)) {
      a.target.el.classList.remove('drop-on', 'drop-no');
    }
    a.target = target;
    if (target && target.el && target.into) target.el.classList.add(target.ok ? 'drop-on' : 'drop-no');
    a.ghost.classList.toggle('refused', !!target && !target.ok && !!target.why);
    const line = target && target.ok && target.line;
    a.line.hidden = !line;
    if (line) {
      a.line.classList.toggle('across', line.h > line.w);
      Object.assign(a.line.style, { left: line.x + 'px', top: line.y + 'px', width: line.w + 'px', height: line.h + 'px' });
    }
  }

  /* A list scrolls by itself while the pointer is near its edge (or past it: the tabs under a phone's list). */
  function edges() {
    const a = active;
    if (!a) return;
    let scrolled = false;
    const pace = (inside) => Math.ceil(SPEED * Math.min(1, Math.max(0, (EDGE - inside) / EDGE)) ** 2);
    for (const s of a.scrollers) {
      const el = s.el;
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let step = 0;
      if (s.axis === 'x') {
        if (a.y < r.top || a.y > r.bottom || el.scrollWidth <= el.clientWidth) continue;
        if (a.x < r.left + EDGE && a.x > r.left - EDGE) step = -pace(a.x - r.left);
        else if (a.x > r.right - EDGE && a.x < r.right + EDGE) step = pace(r.right - a.x);
        if (step) { const was = el.scrollLeft; el.scrollLeft += step; scrolled = scrolled || el.scrollLeft !== was; }
      } else {
        if (a.x < r.left || a.x > r.right || el.scrollHeight <= el.clientHeight) continue;
        const top = s.top ? s.top() : r.top;
        const past = typeof s.pastTop === 'number' ? s.pastTop : EDGE * 2;  // (0: nothing above it scrolls it)
        if (a.y < top + EDGE && a.y >= top - past) step = -pace(a.y - top);
        else if (a.y > r.bottom - EDGE && a.y < r.bottom + EDGE * 2) step = pace(r.bottom - a.y);
        if (step) { const was = el.scrollTop; el.scrollTop += step; scrolled = scrolled || el.scrollTop !== was; }
      }
    }
    if (scrolled) aim();
    a.frame = requestAnimationFrame(edges);
  }

  /* The drag over: put down there (`land`), or where it came from. */
  function drop(land) {
    const a = active;
    if (!a) return;
    active = null;
    cancelAnimationFrame(a.frame);
    a.ghost.remove();
    a.line.remove();
    a.el.classList.remove('drag-source');
    if (a.target && a.target.el) a.target.el.classList.remove('drop-on', 'drop-no');
    root.classList.remove('dragging', 'dragging-notes');
    listen(false);
    if (!a.touchy) swallowNext(['click'], a.x, a.y);  // (the click a mouse makes as it's let go)
    if (a.opts.onEnd) {
      try { a.opts.onEnd(); } catch (error) { console.error(error); }
    }
    const t = a.target;
    if (!land || !t) return;
    if (!t.ok) {
      if (t.why) V.toast(t.why, { kind: 'err', ms: 5000 });
      return;
    }
    Promise.resolve().then(t.run).catch(V.problem);
  }

  /* -- the mouse events a lift makes */

  /* Only at the place it was let go, and only once each: a real tap a moment later somewhere else (the next note to
     pick) is never lost. */
  function swallowNext(types, x, y) {
    swallow = { until: performance.now() + 350, types: new Set(types), x, y };
  }
  for (const type of ['mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, (event) => {
      if (!swallow) return;
      if (performance.now() > swallow.until) { swallow = null; return; }
      if (!swallow.types.has(type) || Math.hypot(event.clientX - swallow.x, event.clientY - swallow.y) > 16) return;
      swallow.types.delete(type);
      if (type === 'click' || !swallow.types.size) swallow = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  /* -- where things go, for the callers' resolve() */

  /* Which part of `el` the pointer is in, along `axis`: the first `edge` of it is 'before', the last 'after', the
     middle 'into'. */
  function zone(el, x, y, axis = 'y', edge = 0.28) {
    const r = el.getBoundingClientRect();
    const at = axis === 'x' ? (x - r.left) / (r.width || 1) : (y - r.top) / (r.height || 1);
    return at < edge ? 'before' : at > 1 - edge ? 'after' : 'into';
  }

  /* A line on `side` ('before' or 'after') of `el`: across a list's rows (from `from` px in from its left), or
     upright between the chips of a row (axis 'x'). */
  function lineBy(el, side, axis = 'y', from = 0) {
    const r = el.getBoundingClientRect();
    if (axis === 'x') {
      const x = side === 'before' ? r.left - 5 : r.right + 3;
      return { x, y: r.top + 2, w: 2, h: Math.max(8, r.height - 4) };
    }
    const y = side === 'before' ? r.top - 2 : r.bottom - 1;
    const left = Math.max(r.left, from);
    return { x: left, y, w: Math.max(12, r.right - left - 4), h: 3 };
  }

  return {
    source, zone, lineBy, HOLD,
    // Something pressed (a finger held, maybe about to drag) or dragged: lists aren't drawn again under it till it's
    // let go (a sync landing then would take the thing from under the finger, and its touch with it).
    busy: () => !!(active || pending),
    since: () => (active ? since : pending ? pending.at : 0),
    dragging: () => !!active,
    cancel: () => drop(false),
  };
})();
