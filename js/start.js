/* Vault: starting up. Works out where it's running (the PC app, or a phone's browser), what's set up, and shows the
   right first screen: the PC's cloud setup, the phone's "connect to your PC", signing in, or the app itself. */
'use strict';

(() => {
  // A page whose js/update.js didn't load still opens, only without updates this time (Vault 1.0.1's worker kept
  // the new page and scripts but never js/update.js: opened offline right after the update came out).
  V.update = V.update || { atBoot: async () => false, resume: () => null, started() {}, whatsNew() {},
    check: async () => ({ state: 'error', message: 'Wefty couldn\'t check just now.' }), now: async () => false,
    useBuiltIn: async () => {}, state: () => ({ version: V.VERSION, ready: '', needsShell: '', checked: '',
      canCheck: false, downloaded: false }) };
  const app = document.getElementById('app');
  /* The four tabs (1.16). The Chat tab's id stays 'claude', as older links (#claude), places kept across an update and
     tests use it. Send, Files and Clipboard are parts of Share now; Settings is behind your picture. */
  const NAV = [['today', 'today', 'Today'], ['notes', 'notes', 'Notes'], ['share', 'share', 'Share'], ['claude', 'spark', 'Chat']];
  /* The screens, each a module with render(container, opts). Looked up when one is opened, not now: js/today.js loads
     after this file (main() waits for the page's scripts before the first one). The view keeps the screen's own id in
     data-tab ('send', 'files', 'clips' and 'settings' too), which is how each module tells whether it's showing. */
  const VIEWS = { today: () => V.today, notes: () => V.notes, send: () => V.send, files: () => V.files, clips: () => V.clips,
    claude: () => V.chat, settings: () => V.settings };
  const NAV_OF = { today: 'today', notes: 'notes', send: 'share', files: 'share', clips: 'share', claude: 'claude', settings: '' };
  const NAMES = { today: 'Today', notes: 'your notes', send: 'Share', files: 'Share', clips: 'Share', claude: 'Chat', settings: 'Settings' };
  // This page's life: history steps it makes carry it, so one left by the page before a reload (an update switching
  // over, a device change) is never taken for its own.
  const BOOT = Math.random().toString(36).slice(2, 10);
  V.pageLife = BOOT;  // (Settings' pages put it on their own steps: { vault: 'settings-page', boot: V.pageLife })
  let current = 'today';
  let shell = null;
  let shown = false;           // the first screen is up (until then a tab tapped, or a link opened, is kept for it)
  let askedFirst = '';
  let settingsFrom = 'today';  // where Settings was opened from: its back arrow and Back go there again
  let settingsStep = false;    // Settings has a step in history (on a phone): Back leaves it

  /* ---------------------------------------------------------------- each screen's own address (1.22)

     The owner: "for tabs could we do a slightly different wefty web address for each?" (tabs and Settings' pages
     only, never single folders or notes). Today is <app>/today/, Notes /notes/, Share /share/ (its Clipboard and
     Files parts /share/clipboard/ and /share/files/), Chat /chat/, Settings /settings/ (a page /settings/<page>/) and
     Help /help/, where <app> is this app's own address (wefty.org/, or an old address's folder). vault/publish.py
     puts a copy of index.html at each, with a <base> pointing back at <app>, as GitHub Pages only serves files that
     are there; sw.js serves the kept copy for an address offline. Going from one screen to another makes a step in
     history (Back and Forward go between them), except where Settings has its own steps (a phone's Settings and its
     pages, which now carry their addresses) and while the tour or a step back is moving things. The first screen
     never makes one. The PC app (vault://app/) has no address bar: nothing here touches it. */
  const APP = (() => { try { return new URL('.', document.baseURI).href; } catch (error) { return location.href; } })();
  V.appBase = APP;  // this app's own address, whichever screen's address the page was opened at
  const ROUTES = { today: 'today/', notes: 'notes/', send: 'share/', clips: 'share/clipboard/', files: 'share/files/',
    claude: 'chat/', settings: 'settings/' };
  const SETTINGS_PAGES = ['account', 'appearance', 'ai', 'devices', 'notifications', 'notes', 'friends', 'about'];
  V.routes = { ROUTES, SETTINGS_PAGES, HELP: 'help/' };  // (vault/publish.py makes the same: a test keeps them equal)
  const addressed = () => !V.desktop && /^https?:$/.test(location.protocol);
  const addressOf = (view, page = '') => APP + (view === 'settings' && SETTINGS_PAGES.includes(page)
    ? `settings/${page}/` : ROUTES[view] || '');
  V.addressOf = addressOf;
  // The address to give a history step made together with a V.go (js/chat.js's from-chat step), so V.go makes none of its
  // own: the step is the screen's. Undefined where screens have no addresses (the PC app, a file).
  V.addressFor = (view, page = '') => (addressed() && ROUTES[view] ? addressOf(view, page) : undefined);
  /* What this page's address names: { view, page } or { view: 'today', help: true }, else null (the app's own
     address, or anything else). */
  function routeHere() {
    if (!addressed()) return null;
    let rest = location.href.split(/[?#]/)[0];
    if (!rest.startsWith(APP)) return null;
    rest = rest.slice(APP.length).replace(/index\.html$/, '');
    if (rest && !rest.endsWith('/')) rest += '/';
    if (rest === 'help/') return { view: 'today', help: true };
    const page = /^settings\/([a-z-]+)\/$/.exec(rest);
    if (page && SETTINGS_PAGES.includes(page[1])) return { view: 'settings', page: page[1] };
    const view = Object.keys(ROUTES).find((id) => ROUTES[id] === rest);
    return view ? { view } : null;
  }
  const here = () => location.href.split('#')[0].split('?')[0];
  let stepping = 0;  // a step back or forward is being taken: what it opens makes no step of its own
  let holding = false;  // the first screen at the app's own address: that address stays (the front page's, later)
  /* This screen's address: a new step in history (`push`), this step's address changed (`replace`: its ?search and
     #hash kept, as a link's own part may still be read), or this step made the screen's own (`swap`: Settings left on
     a phone by a tab, whose step then needs no stepping over). */
  function address(view, how = 'push', page = '') {
    if (!addressed() || !ROUTES[view] || holding) return;
    const url = addressOf(view, page);
    const mine = { vault: 'tab', view, page, boot: BOOT };
    try {
      const state = history.state;
      if (how === 'swap') history.replaceState(mine, '', url);
      else if (url === here()) return;
      else if (how === 'push') history.pushState(mine, '', url);
      else history.replaceState(state && state.vault === 'tab' ? { ...state, view, page } : state, '', url + location.search + location.hash);
    } catch (error) { /* (a browser that won't: the screen still changed) */ }
  }
  V.address = (view, page) => address(view, 'replace', page);  // (js/settingsui.js: a wide screen's page switched)

  /* ---------------------------------------------------------------- the app's frame */

  V.tab = () => current;  // the screen's own id: 'today', 'notes', 'send', 'files', 'clips', 'claude' or 'settings'
  V.navTab = () => NAV_OF[current] || '';  // the tab it's under ('' for Settings)
  /* `opts.top`: opened at its top, whatever place it was left at (the logo, a tab tapped again, a search from another
     screen). Otherwise a screen opened again is back where it was left (below). */
  V.go = (view, opts = {}) => {
    if (view === 'chat') view = 'claude';  // the Chat tab, by its name since 1.8.3
    if (view === 'share') view = sharePart();
    if (view === 'files' && V.share && V.share.shows && !V.share.shows('files')) view = 'send';  // (Files is off: 1.19)
    if (!VIEWS[view]) view = 'notes';  // (an id this version doesn't know)
    const was = current;
    const ownStep = settingsStep;  // (a phone's Settings, with its own step in history)
    if (shell && shown && was) keepPlace(was);  // (before anything is drawn over it)
    current = view;
    if (!shell) return;
    if (!shown) { askedFirst = view; return; }  // (main() shows it, once this device's notes are loaded)
    if (view === 'settings' && was !== 'settings') openedSettings(was, opts || {});
    else if (view !== 'settings' && was === 'settings') leftSettings();
    show(view, opts || {});
    // (its address: a step of its own, unless Back or Forward brought it, the tour is moving things, or it's still the
    // same screen; Settings makes its own on a phone, openedSettings)
    // (a step back or forward, or the first screen, already has its address; one the app is taking itself, like a note
    // closing, lands first and then reconciles with the screen, `reconcile` below)
    if (view !== 'settings' && view !== was && !stepping && !hopping.length) {
      address(view, tourHolds() ? 'replace' : was === 'settings' && ownStep ? 'swap' : 'push');
    }
  };

  /* ---------------------------------------------------------------- each screen's place (1.18)

     The owner: "when you go to click notes or any tab then it refreshes and goes back to the default for the page."
     A screen is still drawn afresh each time it's opened (so whatever changed while it was away shows), but the place
     it was left at comes back: each module keeps its own state (Notes' folder and search, the chat open and the words
     in its box, Share's part, Today's days), and this keeps how far each of the screen's lists was scrolled, by the
     item at its top (a note that came in above it while away doesn't push the place down), else by pixels. A list
     marked with `data-place` (Notes' list: its folder and search; a chat: its id; an open note: its id) only gets its
     place back when it's still the same list. Tapping the tab you're on goes to its top (and then its start: each
     module's `again`); the logo goes to Today's top; Settings opens at its top. */
  const places = new Map();  // screen id -> { scrolls: [{ key, n, place, top, left, end, anchors }] }
  const OWN_PLACE = '.today-week-days';  // (js/today.js keeps the days' place itself: they snap to a day)
  const ANCHORS = '[data-id], [data-key], [data-turn], [data-day], [data-section]';
  let placing = 0;  // the putting back going on (a newer one, or a person scrolling, ends it)

  const placeOf = (el) => { const owner = el.closest('[data-place]'); return owner ? owner.dataset.place : ''; };
  const keyOf = (el) => (el === shell.view ? 'view' : el.classList.length ? `${el.tagName.toLowerCase()}.${CSS.escape(el.classList[0])}` : '');
  const findKey = (key, n) => (key === 'view' ? shell.view : shell.view.querySelectorAll(key)[n] || null);
  // (the nearest box that scrolls up and down, as an item's place is measured in it)
  function scrollerOf(el) {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (up === shell.view) return up;
      if (/(auto|scroll)/.test(getComputedStyle(up).overflowY)) return up;
    }
    return null;
  }
  function anchorSelector(el) {
    for (const name of ['id', 'key', 'turn', 'day', 'section']) {
      const value = el.dataset[name];
      if (value === undefined || value === '') continue;
      return `${el.tagName.toLowerCase()}${el.classList.length ? '.' + CSS.escape(el.classList[0]) : ''}[data-${name}="${CSS.escape(value)}"]`;
    }
    return '';
  }
  // The first few items at the box's top edge, and how far below the edge each starts.
  function anchorsIn(box) {
    const edge = box.getBoundingClientRect().top;
    const found = [];
    for (const el of box.querySelectorAll(ANCHORS)) {
      const at = el.getBoundingClientRect();
      if (!at.height || at.bottom <= edge + 1) continue;
      if (found.some((one) => one.el.contains(el))) continue;  // (one item's own parts)
      if (scrollerOf(el) !== box) continue;
      const sel = anchorSelector(el);
      if (sel) found.push({ el, sel, at: at.top - edge });
      if (found.length === 3 || at.top - edge > box.clientHeight) break;
    }
    return found.map(({ sel, at }) => ({ sel, at }));
  }
  /* The item to put back at its place: the first one still followed by the next as it was (an item that moved, such as
     a note edited elsewhere that went to the top of a list sorted by when it was edited, is passed over). */
  function markIn(el, anchors) {
    const found = anchors.map((one) => {
      const mark = el.querySelector(one.sel);
      return mark && scrollerOf(mark) === el ? { one, top: mark.getBoundingClientRect().top } : null;
    });
    for (let i = 0; i < found.length; i++) {
      if (!found[i]) continue;
      const next = found[i + 1];
      if (i === found.length - 1 || (next && Math.abs((next.top - found[i].top) - (next.one.at - found[i].one.at)) <= 2)) return found[i];
    }
    return found.find(Boolean) || null;
  }

  /* The boxes that have been scrolled (scroll events don't bubble: caught on the way down), the only ones keepPlace
     looks at (1.22.2). It used to read the scroll place of every element on the screen: a long chat has tens of
     thousands (Quick read's pieces round each word), and its turns off screen aren't laid out (js/chat.js), which
     reading inside them undoes, so leaving Chat took most of a second on a phone. */
  const scrolled = new Set();
  document.addEventListener('scroll', (event) => {
    if (event.target && event.target.nodeType === 1) scrolled.add(event.target);
  }, { capture: true, passive: true });
  function scrolledIn(view) {
    const found = [view];
    for (const el of scrolled) {
      if (!el.isConnected) scrolled.delete(el);
      else if (el !== view && view.contains(el)) found.push(el);
    }
    // (in the screen's own order, as they were found before)
    return found.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function keepPlace(view) {
    if (view === 'settings' || shell.view.dataset.tab !== view) return;
    const scrolls = [];
    try {
      for (const el of scrolledIn(shell.view)) {
        const top = el.scrollTop;
        const left = el.scrollLeft;
        if (!top && !left) continue;
        if (el.matches(OWN_PLACE)) continue;
        const key = keyOf(el);
        if (!key) continue;
        const n = key === 'view' ? 0 : [...shell.view.querySelectorAll(key)].indexOf(el);
        // (at the very end of a list, such as a chat read to its newest message: at its end again, however long it got)
        const end = top > 0 && el.scrollHeight - top - el.clientHeight < 4;
        scrolls.push({ key, n, place: placeOf(el), top, left, end, anchors: top && !end ? anchorsIn(el) : [] });
      }
    } catch (error) { console.error(error); }
    places.set(view, { scrolls });
  }

  /* Puts one list back: `true` once it's there (or it can't be: gone, another list now, or moved meanwhile by
     something else, such as Notes' search opening at the list's top). */
  function putOne(item) {
    const el = item.el;
    if (!el || !el.isConnected || placeOf(el) !== item.place) return true;
    if (item.set !== undefined) {
      const most = el.scrollHeight - el.clientHeight;
      if (Math.abs(el.scrollTop - item.set) > 1 && el.scrollTop < most - 1) return true;
    }
    let there = !item.top;
    if (item.end) {
      el.scrollTop = el.scrollHeight;
      there = el.scrollHeight - el.clientHeight >= item.top - 1 && el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    } else if (item.top && item.anchors.length) {
      const mark = markIn(el, item.anchors);
      if (mark) {
        const off = mark.top - el.getBoundingClientRect().top - mark.one.at;
        if (Math.abs(off) > 0.5) el.scrollTop += off;
        there = Math.abs(el.querySelector(mark.one.sel).getBoundingClientRect().top - el.getBoundingClientRect().top - mark.one.at) <= 1;
      }
    }
    if (!there && item.top && !item.end) {
      if (el.scrollTop !== item.top) el.scrollTop = item.top;
      there = Math.abs(el.scrollTop - item.top) <= 1;
    }
    item.set = el.scrollTop;
    if (item.left && el.scrollLeft !== item.left) el.scrollLeft = item.left;
    return there && (!item.left || Math.abs(el.scrollLeft - item.left) <= 1);
  }

  /* The screen's lists back where they were: at once, and again each frame for a moment while what they hold is still
     coming (a chat, a PC's folder), unless a person scrolls, taps or types meanwhile. */
  function putBack(place) {
    const ticket = ++placing;
    const items = place.scrolls.map((item) => ({ ...item, el: findKey(item.key, item.n), done: false }));
    const left = () => {
      let count = 0;
      for (const item of items) {
        if (!item.done) item.done = putOne(item);
        if (!item.done) count++;
      }
      return count;
    };
    if (!left()) return;
    const until = performance.now() + 1500;
    const again = () => {
      if (ticket !== placing || !left() || performance.now() > until) return;
      requestAnimationFrame(again);
    };
    requestAnimationFrame(again);
  }
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    window.addEventListener(type, () => { placing++; }, { capture: true, passive: true });
  }

  /* A tab tapped: its screen, back where it was left; the one you're on: its top (each module's `again`: Notes then
     goes back to all your notes, a phone's Chat to its list), else drawn afresh at its top, as before. A tap that
     only took the note-taker's screen away (it covered the tab you're on) just shows that tab. */
  let coveredTap = false;
  const smoothly = () => (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  document.addEventListener('click', (event) => {
    if (event.target && event.target.closest && event.target.closest('#app > nav.tabs .tab')) {
      coveredTap = !!document.querySelector('#layers > .nt-layer.shown');
    }
  }, true);  // (before js/notetaker.js's own, which takes its screen away: this file loads first)
  function tapped(id) {
    const covered = coveredTap;
    coveredTap = false;
    if (!shown || NAV_OF[current] !== id || covered) { V.go(id); return; }
    places.delete(current);
    const module = VIEWS[current]();
    try {
      if (module && typeof module.again === 'function' && module.again() !== false) return;
    } catch (error) { console.error(error); }
    if (shell.view.scrollTop > 0) shell.view.scrollTo({ top: 0, behavior: smoothly() });
    else V.go(current, { top: true });
  }

  // Share opens on the part used last on this device, or on Send while something sent here hasn't been seen yet.
  function sharePart() {
    try { return V.share && V.share.last ? V.share.last() : 'send'; } catch (error) { console.error(error); return 'send'; }
  }

  /* A screen, drawn. One that throws never takes the app down: your notes show instead, with a line saying so (the
     first screen at every start is Today, and a phone can't go back to an older Wefty by itself). */
  function show(view, opts, fallen = false) {
    shell.view.dataset.tab = view;
    shell.view.dataset.nav = NAV_OF[view];
    app.dataset.view = view;
    for (const button of shell.nav.querySelectorAll('.tab')) {
      const on = button.dataset.tab === NAV_OF[view];
      button.classList.toggle('on', on);
      if (on) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (shell.me) shell.me.classList.toggle('on', view === 'settings');
    // (opened again: back where it was left, unless asked for its top; Settings always at its top)
    if (opts.top) places.delete(view);
    const place = view !== 'settings' && !fallen ? places.get(view) || null : null;
    placing++;  // (a putting back still going on was for the screen before)
    try {
      VIEWS[view]().render(shell.view, place ? { ...opts, back: true } : opts);
    } catch (error) {
      console.error(error);
      if (view !== 'notes' && !fallen) {
        if (view === 'settings') leftSettings();
        current = 'notes';
        V.toast(`Couldn't open ${NAMES[view]}: showing your notes`, { kind: 'err', ms: 6000 });
        show('notes', {}, true);
        return;
      }
      V.clear(shell.view, V.h('div.page.frame-trouble', {},
        V.h('p', { text: 'Wefty couldn\'t show this just now.' }),
        V.button('Try again', { kind: 'primary', onClick: () => V.go(current) })));
    }
    shell.view.scrollTop = 0;
    if (place && current === view) {
      try { putBack(place); } catch (error) { console.error(error); }
    }
    badge();
    V.emit('tab', current);
  }

  /* Settings on a phone is a page of its own, over the tabs: Back (Android's, or an iPhone's swipe) and its arrow take
     you to where you were. Wide, the rail stays and simply switches. */
  const settingsState = (state) => !!state && /^settings(-page)?$/.test(state.vault || '') && state.boot === BOOT;
  // (the tour, js/tour.js, opening and leaving Settings touches neither: Back after it goes where it went before)
  const tourHolds = () => { try { return !!(V.tour && V.tour.holds && V.tour.holds()); } catch (error) { return false; } };
  function openedSettings(from, opts = {}) {
    const page = typeof opts.page === 'string' ? opts.page : '';
    if (tourHolds()) { if (!stepping) address('settings', 'replace', page); return; }
    settingsFrom = from;
    if (V.wide()) { if (!stepping) address('settings', 'push', page); return; }
    try {
      if (stepping) return;  // (Forward into it: its step is already there)
      if (addressed()) history.pushState({ vault: 'settings', boot: BOOT }, '', addressOf('settings'));
      else history.pushState({ vault: 'settings', boot: BOOT }, '');
      settingsStep = true;
    } catch (error) { /* (its arrow still leaves it) */ }
  }
  /* Settings left another way (a toast's Open, a note opened from it, the rail): its step is made a dead one, never
     gone back over (a step back now could close a note that has just opened). */
  function leftSettings() {
    if (!settingsStep || tourHolds()) return;
    settingsStep = false;
    if (settingsState(history.state)) history.replaceState({ vault: 'settings-left', boot: BOOT }, '');
  }
  V.leaveSettings = () => {
    if (current !== 'settings') return;
    if (settingsStep && settingsState(history.state)) { history.back(); return; }  // (popstate below does the rest)
    V.go(settingsFrom || 'today');
  };
  /* Steps the app takes itself (a note closing, Settings leaving, "Back to Chat": history.back() and go()) are told
     apart from a person's Back or Forward: they land without navigating, and whatever screen was opened meanwhile
     (V.editor.close() then V.go('send') is the usual pair) then gets its own step on top of where they landed. */
  const hopping = [];  // the app's own steps not landed yet (a timer each, in case one lands nowhere)
  const stepOver = history.back.bind(history);  // (a dead step stepped over for a person's Back: that Back goes on)
  for (const name of ['back', 'forward', 'go']) {
    const native = history[name].bind(history);
    history[name] = (...args) => {
      const timer = setTimeout(() => { const at = hopping.indexOf(timer); if (at >= 0) hopping.splice(at, 1); }, 800);
      hopping.push(timer);
      return native(...args);
    };
  }
  function reconcile() {
    if (!shell || !shown || !addressed() || current === 'settings') return;
    const state = history.state;
    if (state && state.vault && state.vault !== 'tab') return;  // (a layer's step: its own code's)
    if (state && state.vault === 'tab' && state.view === current) return;  // (landed on the screen that shows)
    address(current, 'push');
  }
  window.addEventListener('popstate', () => {
    stepping++;
    setTimeout(() => { stepping = Math.max(0, stepping - 1); }, 0);  // (whatever this step opens makes none of its own)
    const own = hopping.length > 0;
    if (own) { clearTimeout(hopping.shift()); setTimeout(reconcile, 0); }  // (after every other listener has had its say)
    if (own || !shell || !shown || !addressed()) return;
    const state = history.state;
    if (state && state.vault && state.vault !== 'tab') return;  // (Settings', a layer's, a note's: their own code's)
    if (current === 'settings') return;  // (Settings' own listener, below, goes back to where it was opened from)
    const route = state && state.vault === 'tab' && ROUTES[state.view] ? { view: state.view, page: state.page || '' }
      : routeHere() || { view: 'today' };
    if (route.view === current) return;
    V.go(route.view, route.view === 'settings' && route.page ? { page: route.page } : {});
  });
  window.addEventListener('popstate', () => {
    // (1.22: a wide screen's Settings has a screen's step of its own, gone forward into above: it stays)
    if (history.state && history.state.vault === 'tab' && history.state.view === 'settings') return;
    // A Settings step left behind (Settings left from one of its pages: only the top step was made a dead one) is
    // stepped over, so that Back press does something and the next Settings leaves with one.
    if (current !== 'settings' && settingsState(history.state)) { stepOver(); return; }
    // (Back from a note shown over Settings lands on Settings' own step: Settings stays.)
    if (current !== 'settings' || settingsState(history.state)) return;
    settingsStep = false;
    V.go(settingsFrom || 'today');
  });

  /* The numbers on the tabs: on Share, what was sent here and not seen yet (js/share.js puts the same on its Send
     part); on Chat, messages waiting to be sent and answers that ended while they weren't shown (1.18). While another
     screen shows, Chat has a small dot instead (no number) as long as an answer is being written. */
  function badge() {
    if (!shell) return;
    let count = 0;
    let waiting = 0;
    let writing = false;
    try { count = V.send && V.send.unseen ? V.send.unseen() : 0; } catch (error) { console.error(error); }
    try { waiting = V.chat ? (V.chat.badge || V.chat.waiting)() : 0; } catch (error) { console.error(error); }
    try { writing = !!(V.chat && V.chat.writing && V.chat.writing()) && current !== 'claude'; } catch (error) { console.error(error); }
    for (const [id, n] of [['share', count], ['claude', waiting]]) {
      const dot = shell.nav.querySelector(`[data-tab=${id}] .badge`);
      if (dot) { dot.textContent = n ? String(n) : ''; dot.hidden = !n; }
    }
    const working = shell.nav.querySelector('[data-tab=claude] .tab-dot');
    if (working) working.hidden = !writing || !!waiting;
    const said = shell.nav.querySelector('[data-tab=claude] .tab-said');
    if (said) {
      let sending = 0;
      try { sending = V.chat && V.chat.waiting ? V.chat.waiting() : 0; } catch (error) { console.error(error); }
      const fresh = Math.max(0, waiting - sending);
      said.textContent = [writing ? 'writing an answer' : '', fresh ? `${fresh} new ${fresh === 1 ? 'answer' : 'answers'}` : '',
        sending ? `${sending} waiting to send` : ''].filter(Boolean).map((part) => `, ${part}`).join('');
    }
  }

  /* Ctrl+N (a new note) and Ctrl+F (search your notes) from any screen: Notes has its own, so these only act while
     another one shows, and never through a sheet, a note over everything, or a box being typed in. */
  document.addEventListener('keydown', (event) => {
    if (!shell || current === 'notes' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    if ((key !== 'n' && key !== 'f') || !app.classList.contains('ready') || app.classList.contains('gate')) return;
    if (document.querySelector('#layers > .layer:not(.leaving), #layers > .nt-layer.shown')) return;
    if (V.editor && V.editor.covering && V.editor.covering()) return;
    const target = event.target;
    if (target && ((target.matches && target.matches('input, textarea, select')) || target.isContentEditable)) return;
    event.preventDefault();
    V.go('notes', key === 'f' ? { top: true } : {});  // (the search box is at the list's top)
    if (key === 'n') V.notes.chooseTemplate({ fresh: true });
    else V.notes.search();
  });

  /* The rail's logo (1.17, the owner: "click the logo at the top there and have it go to Today"): Today's top, from
     any screen (never the place Today was left at), or again when it's showing (js/today.js). Only in the app: the
     setup and sign-in screens have their own wordmark, which isn't a button. */
  function goToday() {
    if (!shell || !app.classList.contains('ready') || app.classList.contains('gate')) return;
    if (shown && current === 'today' && V.today && V.today.toTop) { V.today.toTop(); return; }
    V.go('today', { top: true });
  }

  function buildShell() {
    let me = null;
    try { me = V.profileButton('rail-me'); } catch (error) { console.error(error); }
    const home = V.h('button.rail-home', { type: 'button', 'aria-label': 'Today', title: 'Today', onclick: goToday },
      V.mark(30, 'rail-mark', { colour: true }));
    const nav = V.h('nav.tabs', { 'aria-label': 'Wefty' }, home,
      NAV.map(([id, icon, label]) => V.h('button.tab', {
        type: 'button', dataset: { tab: id }, onclick: () => tapped(id),
      }, V.h('span.tab-icon', {}, V.icon(icon), id === 'share' || id === 'claude' ? V.h('span.badge', { hidden: true, 'aria-hidden': id === 'claude' ? 'true' : null }) : null,
        // (Chat's dot while an answer is written and another screen shows; what it and the badge say, for a screen reader)
        id === 'claude' ? V.h('span.tab-dot', { hidden: true, 'aria-hidden': 'true', title: 'Writing an answer' }) : null),
      V.weave('tab-weave'), V.h('span.tab-label', { text: label }), id === 'claude' ? V.h('span.sr-only.tab-said') : null)),
      V.h('span.rail-spacer'), me);
    const view = V.h('main.view');
    shell = { nav, view, me };
    V.clear(app, nav, view);
    app.className = 'ready ' + (V.desktop ? 'on-pc' : 'on-phone');
  }

  /* ---------------------------------------------------------------- screens before the app */

  /* "This version started", to the PC app: said once the app, or the setup or sign-in screen, is up, so a downloaded
     version that breaks while starting never says it and is taken back (an older PC app doesn't know the call). */
  let saidHello = false;
  function hello() {
    if (!V.desktop || saidHello) return;
    saidHello = true;
    V.pc.call('hello', { version: V.VERSION }).catch(() => {});
  }

  function screen(...kids) {
    app.className = 'ready gate ' + (V.desktop ? 'on-pc' : 'on-phone');
    V.clear(app, V.h('div.gate-box', {}, V.h('div.gate-brand', {}, V.wordmark()), kids));
  }

  function field(label, attrs) {
    const input = V.h('input.field', attrs);
    return [V.h('label.label', {}, label, input), input];
  }
  // (for the other parts' own gate screens: js/doors.js's sign-up and js/pair.js's code from another device)
  V.gate = { screen, field };
  // (js/doors.js's screens that offer Sign in: "Already on Wefty?" after a sign-up)
  if (V.doors) V.doors.signInFrom(({ email, back, done }) => signInScreen(email, '', false, back).then(done));

  /* `offerPass`: a move pass that had run out was pasted just before (an iPhone's new icon): a fresh one from the old
     icon's Copy it again can go here too. Never after one the cloud turned down: the old icon has nothing better to
     give, and its Copy it again would only copy the same one.
     `back` (1.21): opened from js/doors.js's first screen, which it goes back to. On the web the other ways in are
     here too (js/doors.js: Forgot password?, a code by e-mail, Google, a code from another device, Create an account
     when the cloud takes new ones); on the PC, the PC app's own (a code from another device; a reset at wefty.org). */
  function signInScreen(email = '', note = '', offerPass = false, back = null) {
    return new Promise((resolve) => {
      const web = !V.desktop && !!V.doors;
      const draw = (typed = email, said = note) => {
        const [emailRow, emailBox] = field('E-mail', { type: 'email', value: typed, autocomplete: 'username' });
        const [passRow, passBox] = field('Wefty password', { type: 'password', autocomplete: 'current-password' });
        const problem = V.h('p.error-text', { text: said });
        const more = V.h('div.doors-more');
        const again = () => draw(emailBox.value.trim(), '');
        // (1.22.2) Paste my sign-in leads when this page was opened from the old Wefty's move (its Open wefty.org link
        // says so: the copied sign-in is likely on the clipboard); after one that ran out, it's further down.
        const leading = cameMoving && !offerPass && passHere();
        const go = V.button('Sign in', { kind: `${leading ? '' : 'primary '}wide-btn`, onClick: async () => {
          problem.textContent = '';
          V.clear(more);
          go.disabled = true;
          try {
            await V.cloud.signIn(emailBox.value, passBox.value);
            resolve();
          } catch (error) {
            if (web) V.doors.signInTrouble(error, { email: emailBox.value.trim(), problem, more, back: again, done: resolve });
            else if (V.desktop) pcTrouble(error, problem);
            else problem.textContent = error.message || String(error);
          } finally {
            go.disabled = false;
          }
        } });
        passBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
        const pasteSaid = leading ? V.h('p.error-text', { role: 'alert' }) : problem;
        // Wefty at its own address: a move pass pasted into a box is never shown there (catchPaste).
        const pasting = passHere() ? pasteButton('Paste my sign-in', `${leading ? 'primary ' : ''}wide-btn`, pasteSaid,
          (text) => { if (!openPasted(text)) pasteSaid.textContent = PASS_WORDS.none; }, () => {},
          { box: true, here: leading && tabMoving }) : null;
        if (pasting) for (const box of [emailBox, passBox]) catchPaste(box, pasting.mover);  // (pasted in the wrong box)
        const doors = web ? V.doors.signInWays({ email: () => emailBox.value.trim(), back: again, done: resolve }) : null;
        const using = V.cloud.cloudConfig ? V.cloud.cloudConfig() : null;
        screen(V.h('h1', { text: 'Sign in' }),
          web && using ? cloudNote(using.url) : null,
          pasting && leading ? [V.h('p.muted.pass-mover', { text: PASS_WORDS.moverHere }), pasting.button, pasteSaid,
            pasting.box.row] : null,
          V.h('p.muted', { text: V.desktop ? 'Wefty on this PC got signed out. Sign in again with your Wefty e-mail and password.'
            : leading ? 'Or use your Wefty e-mail and password.' : 'Use your Wefty e-mail and password.' }),
          emailRow, passRow, problem, more, go,
          doors ? doors.forgot : null,
          doors ? doors.ways : null,
          V.desktop ? pcWays(again, resolve) : null,
          pasting && offerPass ? [pasting.button, pasting.box.row] : null,
          doors ? doors.create : null,
          V.desktop || back ? null : V.h('button.link-btn', { type: 'button', text: 'Connect to a different cloud', onclick: () => {
            localStorage.removeItem('vault-config'); location.reload();
          } }),
          back ? V.h('button.link-btn', { type: 'button', text: 'Back', onclick: () => back() }) : null);
        hello();
        // (Leading with Paste my sign-in: no box takes the focus, so a phone's keyboard doesn't cover the button.)
        if (!leading) requestAnimationFrame(() => (typed ? passBox : emailBox).focus());
      };
      // (A code screen this page had open before it reloaded: back to it.)
      if (!(web && V.doors.resume({ back: () => draw(), done: resolve }))) draw();
    });
  }

  /* ---------------------------------------------------------------- the PC's sign-in (1.21)

     A code from another device (js/pair.js and the PC app's pair calls, vault/desktop.py), and what to do about a
     forgotten password: reset it at wefty.org, then sign in here. A cloud that asks for a CAPTCHA (sign-ups open to
     everyone) can't be answered here (the PC app can't show the check): Python's sign-in says "captcha", and the code
     from another device is the way in. */
  const WEFTY_ORG = 'https://wefty.org/';
  const pcCanPair = () => !!(V.desktop && V.pair && V.pc.can('pairOpen'));
  function pcPairButton(back, done) {
    if (!pcCanPair()) return null;
    return V.button('Use a code from another device', { kind: 'wide-btn doors-pair', icon: 'devices', onClick: async () => {
      let got = 'back';
      try { got = await V.pair.signInScreen({ cloud: null }); } catch (error) { console.error(error); }
      if (got === 'in') done();
      else back();
    } });
  }
  function pcWays(back, done) {
    return [pcPairButton(back, done),
      V.h('p.hint.pc-forgot', { text: 'Forgot your password? Reset it at wefty.org (Sign in > Forgot password), then sign in here with the new one.' }),
      V.button('Open wefty.org', { kind: 'wide-btn pc-open-site', icon: 'open',
        onClick: () => V.pc.call('openLink', { url: WEFTY_ORG }).catch(V.problem) })];
  }
  // (The code from another device's button is on the screen already, under Sign in.)
  function pcTrouble(error, problem) {
    const said = error.message || String(error);
    if (!/captcha/i.test(said)) { problem.textContent = said; return; }
    problem.textContent = 'This cloud asks for a quick check that the PC app can\'t show. ' + (pcCanPair()
      ? 'Tap Use a code from another device below, then type the code on your phone or Chromebook (Settings > Devices > Sign in another device).'
      : 'Update Jarvis, then sign in here with a code from another device.');
  }

  /* A Wefty link (an invite, a join code's link, #connect=) pasted on the first screen or the sign-in screen: opened
     here as if it had been tapped. False when `text` has none. */
  function openPasted(text) {
    const found = /#(invite|join|connect)=([A-Za-z0-9_-]+)/.exec(String(text || ''));
    if (!found) return false;
    history.replaceState(null, '', `${location.pathname}${location.search}#${found[1]}=${found[2]}`);
    location.reload();
    return true;
  }

  /* Nothing set up in this browser yet. The link that sets it up (an invite, a join QR code's link, or #connect= from
     the PC's QR code or an iPhone's "Copy the sign-in link") is opened, or pasted here: on an iPhone or iPad, a new
     home screen icon starts with nothing of Safari's, so this is where it lands. There its button is "Paste my
     sign-in", which takes the old Vault icon's move pass too (no password: see "an iPhone's sign-in" below). */
  function connectScreen(back = null) {
    const icon = passHere();  // (a sign-in pass can be pasted here: any device at wefty.org)
    const apple = iconHere();  // (an iPhone or iPad's home screen icon: its own words about Safari)
    const [linkRow, linkBox] = field('Or paste it here', { type: 'url', placeholder: 'https://...#invite=..., #join=... or #connect=...',
      autocomplete: 'off', spellcheck: 'false' });
    const problem = V.h('p.error-text', { role: 'alert' });
    const use = (text) => {
      if (openPasted(text)) return;
      problem.textContent = icon ? PASS_WORDS.none
        : 'That isn\'t a Wefty link. Copy the whole link (an invite, a join code\'s link, or #connect=) and try again.';
    };
    const { button: paste, mover } = pasteButton(icon ? 'Paste my sign-in' : 'Paste the link', 'primary wide-btn', problem, use, () => {
      problem.textContent = icon ? PASS_WORDS.unread
        : 'Wefty couldn\'t read what you copied. Paste the link in the box instead (press and hold, then Paste).';
      linkBox.focus();
    });
    // Pasted into the box instead: a move pass never goes in (catchPaste), and if it got there anyway it's taken out.
    catchPaste(linkBox, mover);
    const connect = () => {
      const text = linkBox.value;
      if (readPass(text)) linkBox.value = '';
      if (!mover.busy() && !mover.take(text)) use(text);
    };
    linkBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
    const [urlRow, urlBox] = field('Cloud address', { type: 'url', placeholder: 'https://....supabase.co' });
    const [keyRow, keyBox] = field('Cloud key', { type: 'text', placeholder: 'sb_publishable_...', autocomplete: 'off' });
    const typed = V.h('p.error-text');
    const manual = V.h('details.manual', {}, V.h('summary', { text: 'Type the cloud\'s address and key instead' }), urlRow, keyRow, typed,
      V.button('Connect', { kind: 'primary', onClick: () => {
        const url = urlBox.value.trim().replace(/\/+$/, '');
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || keyBox.value.trim().length < 20) {
          typed.textContent = 'That doesn\'t look right. Both are on the PC: Wefty > Settings > Devices > Add a phone or computer > Copy the link.';
          return;
        }
        localStorage.setItem('vault-config', JSON.stringify({ url, key: keyBox.value.trim() }));
        location.reload();
      } }));
    screen(V.h('h1', { text: 'Connect Wefty' }),
      V.h('p.muted', { text: apple ? PASS_WORDS.firstScreen : icon ? PASS_WORDS.firstElsewhere
        : 'Open the link you were sent (an invite or a join code\'s link from a friend, or the link from Wefty on your PC). Or copy it, then tap Paste the link.' }),
      apple ? V.h('p.muted.pass-mover', { text: PASS_WORDS.mover }) : null,  // (second: most who see this never had Vault)
      paste, linkRow, V.button('Connect', { kind: 'wide-btn', onClick: connect }), problem,
      V.h('p.hint', { text: apple
        // (A scanned code opens in Safari, never in this icon: the link comes from Safari's Vault instead.)
        ? `In Safari's Wefty, open Settings > Devices > Copy the sign-in link, then come back and tap Paste my sign-in. `
          + 'Or on the PC: Wefty > Settings > Devices > Add a phone or computer > Copy the link, and send it to this phone.'
        : 'Setting up your own phone? In Wefty on your PC, open Settings > Devices > Add a phone or computer and point this phone\'s camera at the code.' }),
      manual,
      // (1.21: opened by "I have an invite" on js/doors.js's first screen, which it goes back to)
      back ? V.h('button.link-btn.connect-back', { type: 'button', text: 'Back', onclick: () => back() }) : null);
  }

  /* The PC's first start: making the owner's own free cloud (vault/cloudsetup.py does the work), or joining a
     friend's with the invite link they sent (joinScreen, further down). */
  function setupScreen() {
    return new Promise((resolve) => {
      const open = (url) => V.pc.call('openLink', { url }).catch(V.problem);
      const [tokenRow, tokenBox] = field('Your access token', { type: 'password', placeholder: 'sbp_...', autocomplete: 'off' });
      const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'username' });
      const [passRow, passBox] = field('Pick a Wefty password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text');
      const log = V.h('div.setup-log');
      const go = V.button('Set up my cloud', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        if (!tokenBox.value.trim()) { problem.textContent = 'Paste your access token from step 2 first.'; return; }
        if (!emailBox.value.includes('@')) { problem.textContent = 'Type your e-mail.'; return; }
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        V.clear(log, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text: 'Starting...' })));
        try {
          await V.pc.call('setUp', { token: tokenBox.value.trim(), email: emailBox.value.trim(), password: passBox.value });
          resolve();
        } catch (error) {
          V.clear(log);
          problem.textContent = error.message || String(error);
          go.disabled = false;
        }
      } });
      V.on('pc:setup-progress', ({ text }) => {
        V.clear(log, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text })));
      });
      screen(V.h('h1', { text: 'Set up Wefty' }),
        V.h('p.muted', { text: 'Wefty keeps your notes, files and clipboard in your own free cloud (Supabase). Setting it up takes about 3 minutes, once.' }),
        V.pc.can('joinInvite') ? V.h('button.link-btn', { type: 'button', text: 'Got an invite from a friend? Join with it instead',
          onclick: () => joinScreen(() => setupScreen().then(resolve), resolve) }) : null,
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '1' }), V.h('div', {},
          V.h('strong', { text: 'Make a free Supabase account' }),
          V.h('p.muted', { text: '"Continue with GitHub" is quickest. If it asks for an organization, any name is fine, on the Free plan.' }),
          V.button('Open supabase.com', { icon: 'open', onClick: () => open('https://supabase.com/dashboard/sign-up') }))),
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '2' }), V.h('div', {},
          V.h('strong', { text: 'Make an access token' }),
          V.h('p.muted', { text: 'On the page that opens, choose "Create legacy token" (a normal token can\'t reach enough), call it Wefty, create it, then Copy. Paste it below. Wefty uses it once to build your cloud and never keeps it: you can delete it afterwards.' }),
          V.button('Open the tokens page', { icon: 'open', onClick: () => open('https://supabase.com/dashboard/account/tokens') }),
          tokenRow)),
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '3' }), V.h('div', {},
          V.h('strong', { text: 'Your Wefty sign-in' }),
          V.h('p.muted', { text: 'What you\'ll type on your phone. Your e-mail isn\'t sent anything.' }),
          emailRow, passRow, againRow)),
        problem, log, go);
      hello();
    });
  }

  /* ---------------------------------------------------------------- invites (vault/invites.py, js/access.js)

     A friend's account is made by the owner, with a one-time code as its first password. The invite link carries
     the owner's cloud (like #connect=) plus the e-mail and the code, so opening it signs them in; until they choose
     their own password (chooseScreen), the account says must_change_password and nothing else opens. The code only
     ever lives in memory here: never saved, and taken out of the address bar at once. */

  // An invite code as the account has it (K7QX9MRT2B), from however it was typed; '' when it isn't one.
  V.inviteCode = (text) => {
    const code = String(text || '').replace(/[\s\-_.]/g, '').toUpperCase();
    return /^[2-9A-HJKMNP-Z]{10}$/.test(code) ? code : '';
  };

  const CLOUD = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
  function readLink(raw) {
    const plain = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(plain + '='.repeat((4 - plain.length % 4) % 4)))));
  }

  let invite = null;
  function takeInviteLink() {
    const match = /#invite=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);  // the code never stays in the address bar
    let found = null;
    try { found = readLink(match[1]); } catch (error) { /* said below */ }
    const email = found && String(found.e || '').trim();
    if (!found || !CLOUD.test(found.u || '') || !found.k || !email || !email.includes('@') || !V.inviteCode(found.c)) {
      console.warn('Vault: that invite link was damaged');
      return;
    }
    invite = { url: found.u, key: String(found.k), email, code: V.inviteCode(found.c), name: String(found.n || '').slice(0, 60),
      // The link itself (code and all), in memory only: inAppScreen's "Copy the invite link" hands it to Chrome or Safari.
      link: `${location.origin}${location.pathname}${location.search}#invite=${match[1]}` };
    // Someone already signed in to Vault in this browser stays signed in: an invite never swaps them out.
    let saved = null;
    let who = null;
    try {
      saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
      who = JSON.parse(localStorage.getItem('vault-user') || 'null');
    } catch (error) { /* nothing usable kept */ }
    if (saved && localStorage.getItem('vault-auth')) {
      const same = saved.url === invite.url && who && String(who.email || '').toLowerCase() === email.toLowerCase();
      if (!same) invite.busy = (who && who.email) || 'someone else';
      return;  // (the same person, signed in here already: nothing to set up)
    }
    // (1.22.5: its cloud is kept once it's known to be all right, takeLinkCloud: asked first when it isn't Wefty's own)
    invite.config = { url: invite.url, key: invite.key, email };
  }

  /* A join QR code's link (js/access.js's joinLinkFor): #join= with the owner's cloud and a join code that anyone may
     use for a while to make their own account there (joinCodeScreen). Like an invite's, the code is taken out of the
     address bar at once and kept in memory only: never saved, logged or put back in the address. */
  const JOIN_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;  // the helper's payload.signature (vault/invites.py's check)
  let join = null;
  function takeJoinLink() {
    const match = /#join=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);  // the code never stays in the address bar
    let found = null;
    try { found = readLink(match[1]); } catch (error) { /* said below */ }
    const token = found && typeof found.t === 'string' ? found.t : '';
    if (!found || !CLOUD.test(found.u || '') || !found.k || token.length > 600 || !JOIN_TOKEN.test(token)) {
      console.warn('Vault: that join link was damaged');
      return;
    }
    join = { url: found.u, key: String(found.k), token, name: String(found.n || '').trim().slice(0, 60),
      // (in memory only: inAppScreen's "Copy the link" hands it to Chrome or Safari)
      link: `${location.origin}${location.pathname}${location.search}#join=${match[1]}` };
    // Someone already signed in to Vault in this browser stays signed in: a join code never swaps them out.
    let saved = null;
    let who = null;
    try {
      saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
      who = JSON.parse(localStorage.getItem('vault-user') || 'null');
    } catch (error) { /* nothing usable kept */ }
    if (saved && localStorage.getItem('vault-auth')) {
      join.busy = (who && who.email) || 'someone else';
      return;
    }
    join.config = { url: join.url, key: join.key };  // (kept by takeLinkCloud, 1.22.5)
  }

  /* (1.22.5) An invite's or join code's cloud, kept here once it's all right: the one saved here, Wefty's own, or one
     the person said yes to (cloudQuestion). Said no to: the link is let go, as if it hadn't been opened. */
  async function takeLinkCloud() {
    const link = invite || join;
    if (!link || !link.config) return;
    if (await mayUseCloud(link.config)) {
      link.config.key = await keyFor(link.config.url, link.config.key);
      link.key = link.config.key;  // (a join code's own request goes with it too)
      localStorage.setItem('vault-config', JSON.stringify(link.config));
      link.other = !(await officialCloud(link.url));  // (its screens name the cloud: SEC-02)
      return;
    }
    invite = null;
    join = null;
  }

  /* The invite (or a join code's link) was opened inside an app's own browser (tapped in Instagram, Snapchat...:
     V.deviceKind.inApp). Vault works there, but only there: that browser keeps its own storage, can't put Vault on
     the home screen, and Google won't sign anyone in inside it (the free AI key). So Chrome (Android) or Safari
     (iPhone) is offered first: the code still works there until a password is chosen (or the join code runs out), so
     the whole thing can start again in the real browser. The link only reaches the clipboard from a tap here, never
     the address bar. Chrome's own button can't carry it (an intent:// link uses the part after # itself), so it's
     copied first and pasted on Chrome's "Connect Vault". */
  function inAppScreen() {
    return new Promise((resolve) => {
      const ios = V.deviceKind.ios;
      const browser = ios ? 'Safari' : 'Chrome';
      const joining = !invite && !!join;
      const copy = joining ? 'Copy the link' : 'Copy the invite link';
      const page = new URL(location.origin + location.pathname);
      const chrome = `intent://${page.host}${page.pathname}#Intent;scheme=https;package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(page.href)};end`;
      screen(V.h('h1', { text: joining ? `Open this link in ${browser}` : `Open your invite in ${browser}` }),
        V.h('p.muted', { text: `This page opened inside an app's own browser. Wefty only stays here, can't go on your home `
          + `screen, and Google won't let you sign in here for the free AI. In ${browser} it all works.` }),
        V.h('ol.steps.in-app-how', {},
          V.h('li', { text: `Tap ${copy}.` }),
          V.h('li', { text: ios ? 'Tap ••• (or the compass) and choose Open in Safari (or Open in external browser).'
            : 'Tap Open in Chrome below, or ⋮ at the top and Open in Chrome (or Open in browser).' }),
          V.h('li', { text: `In ${browser}, tap Paste the link (or paste it into the address bar and go).` })),
        V.button(copy, { kind: 'primary wide-btn', icon: 'copy', onClick: async () => {
          await V.copy((joining ? join : invite).link, { cloud: true });  // (never shared to other devices: it holds the code)
          V.toast(`Copied. Now open ${browser} and paste it there.`, { ms: 6000 });
        } }),
        ios ? null : V.h('a.btn.wide-btn.in-app-chrome', { href: chrome, rel: 'noopener' }, V.icon('open'),
          V.h('span', { text: 'Open in Chrome' })),
        V.h('p.hint', { text: 'Carrying on here works, but Wefty stays inside this app.' }),
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Continue here anyway', onclick: () => resolve() }));
    });
  }

  /* This browser's Vault is someone else's: the invite (or join code) waits until they've signed out. */
  function busyScreen() {
    return new Promise((resolve) => {
      const open = V.button('Open Wefty', { kind: 'primary wide-btn', onClick: () => { invite = null; join = null; resolve(); } });
      if (!invite && join) {
        screen(V.h('h1', { text: 'Already signed in' }),
          V.h('p.muted', { text: `This browser's Wefty is signed in as ${join.busy}. Sign out there first, or open the code's `
            + 'link in another browser.' }),
          open);
        return;
      }
      screen(V.h('h1', { text: 'Already signed in' }),
        V.h('p.muted', { text: `This invite is for ${invite.email}, but Wefty in this browser is signed in as ${invite.busy}.` }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Open Wefty here, tap your picture at the top, then Sign out.' }),
          V.h('li', { text: 'Then open the invite link again.' })),
        V.h('p.hint', { text: 'Or open the link in another browser (or a private window) instead.' }),
        open);
    });
  }

  /* What only this device has: changes the cloud hasn't got yet (made offline, or a note too big to go up), files
     waiting to be sent, shares not taken in yet, a drawing not saved. Read from this device's own copy, as the cloud
     hasn't started yet when the move screen shows. -1 when it can't tell. */
  async function waitingHere() {
    try {
      let count = (await V.db.all('outgoing')).length + (await V.db.all('shared')).length;
      for (const table of ['folders', 'notes', 'transfers']) count += (await V.db.all(table)).filter((row) => row._dirty).length;
      const settings = await V.db.meta('settings');
      if (settings && settings._dirty) count += 1;
      if (await V.db.meta('ink-draft')) count += 1;
      return count;
    } catch (error) {
      return -1;
    }
  }

  const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const stored = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; } };

  /* ---------------------------------------------------------------- an iPhone's sign-in, moved without a password

     An iPhone or iPad keeps each home screen icon's storage apart, so the new Wefty icon starts with nothing of the
     old Vault icon's, and a sign-in there would need a password many have forgotten. So the old icon hands its own
     sign-in over as a MOVE PASS: "wefty-move:" + base64url of {v: 1, u: the cloud, k: its public key, e: the
     e-mail, r: the session's refresh token, x: ten minutes from now}, put on the clipboard by Copy my sign-in (on the
     move screen, only while this icon is signed in and has nothing the cloud hasn't got). Then this icon forgets that
     session WITHOUT a word to the cloud: supabase-js's signOut, even with scope 'local', asks the cloud's /logout,
     which would end the very session just handed over; and Supabase swaps the refresh token at every renewal, so if
     both icons went on renewing it, the second one (outside its few seconds' grace) would get the whole session ended
     and both icons signed out. So nothing renews it here any more, and a reload here is signed out.
     The new icon reads it in a tap (Paste my sign-in, which takes links too), takes it off the clipboard (see
     emptyClipboard), and swaps the refresh token, twice, for a session of its own at the cloud's token endpoint, the
     only place it ever goes (see swapPass: after that the pass is only good for ending the session). The ten minutes
     are Wefty's own: the cloud knows nothing of them, and would take an unused pass's token for as long as the session
     lives (nothing here can end it safely: presenting it again could hand out, then end, the new icon's session). The
     pass is never shown, put in an address, kept in any storage, sent anywhere else or logged; the old icon holds it
     in memory only, for Copy it again (with ten fresh minutes), until its screen closes. Only on an iPhone or iPad. */
  const PASS = 'wefty-move:';
  const PASS_MINUTES = 10;
  // A cloud's public key: a publishable one, or an older project's anon key (a JWT). Never a secret key.
  const PUBLIC_KEY = /^(?:sb_publishable_[A-Za-z0-9_-]{8,200}|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})$/;
  const REFRESH = /^[A-Za-z0-9._~+/=-]{8,512}$/;
  const PASS_NOTE = 'wefty-pass';  // sessionStorage: what became of a pass across the reload ('in', 'used', 'expired')
  // (1.22.2) This page was opened from an old address's move (#connect= with m: 1, or Move to wefty.org's window that
  // got nothing): the person may have their sign-in copied, so Paste my sign-in leads on the sign-in screen.
  let cameMoving = false;
  let tabMoving = false;  // (and from a browser tab, not an installed app: on an iPhone, Safari is the place for it)
  // (1.22.2: no "pass" or "token" on screen: it's "your sign-in", copied and pasted)
  const PASS_WORDS = {
    in: 'Signed in. You can remove the old Wefty (or Vault) icon now.',
    inSafari: 'Signed in here in Safari.',
    expired: 'That copied sign-in ran out (it works for 10 minutes). If the old Wefty (or Vault) still shows Copy it '
      + 'again, tap it, then tap Paste my sign-in here. If not, sign in with your e-mail and password.',
    used: 'That copied sign-in was already used, or it stopped working. Sign in with your e-mail and password.',
    bad: 'That copied sign-in didn\'t come through right. Copy it again from the old Wefty (or Vault).',
    // (1.22.5) "Sign in as <e-mail>?" answered No, or a copied sign-in that wasn't for the account it named
    notYou: 'Nobody was signed in. Sign in with your own e-mail and password.',
    notFor: (email) => `That copied sign-in wasn't for ${email}, so nobody was signed in.`,
    offline: 'You\'re offline. Connect to the internet, then tap Paste my sign-in again.',
    unreachable: 'Wefty couldn\'t reach the cloud just now. Check the internet, then tap Paste my sign-in again.',
    safari: 'That\'s your sign-in for the new Wefty icon. Add Wefty to your Home Screen first (Share > Add to Home '
      + 'Screen, and keep Open as Web App on), then open the new icon and tap Paste my sign-in there. If your new '
      + 'icon opens in Safari, remove it and add it again with Open as Web App on.',
    safariHere: 'Sign in here in Safari instead',
    elsewhere: 'That sign-in is for Wefty at wefty.org. Open wefty.org and tap Paste my sign-in there.',
    none: 'That isn\'t a Wefty sign-in or link. Copy it again, then tap Paste my sign-in.',
    unread: 'Wefty couldn\'t read what you copied. Paste it in the box below instead: press and hold in it, then Paste '
      + '(on a computer, click it and press Ctrl+V).',
    box: 'Paste it here',
    firstElsewhere: 'Open the link you were sent (an invite or a join code\'s link from a friend, or the link from Wefty on your '
      + 'PC). Coming from the old Wefty (or Vault)? Tap Copy my sign-in there, then Paste my sign-in here. No password needed.',
    firstScreen: 'Copy the link you were sent (an invite, or the sign-in link from Wefty in Safari), then tap Paste '
      + 'my sign-in.',
    mover: 'Coming from the old Wefty (or Vault)? Tap Copy my sign-in there, then Paste my sign-in here. No password '
      + 'needed.',
    moverHere: 'Tapped Copy my sign-in in the old Wefty? Tap Paste my sign-in. No password needed.',
    // (the first screen while the cloud takes no new accounts: js/doors.js)
    pasteOld: 'Paste my sign-in from the old Wefty',
    handOver: 'No password needed: this hands your sign-in to the new Wefty and signs this old one out.',
    copied: 'Copied. This old one is signed out now: your sign-in is waiting for the new Wefty.',
    // (anywhere but an iPhone's icon: wefty.org is the next stop, in this browser)
    copiedGo: 'Copied. Now open wefty.org and tap Paste my sign-in. This old one is signed out now: your sign-in is '
      + 'waiting there.',
    again: 'Copied again. It works for 10 minutes.',
    once: 'Paste it on one new icon only, within 10 minutes. Lost it before pasting? Tap Copy it again.',
    notCopied: 'Wefty couldn\'t copy it. Tap the button again.',
    handed: 'You already moved your sign-in to the new Wefty. If it worked there, remove this old one. If not, sign in '
      + 'there with your e-mail and password.',
    moving: 'Signing you in at wefty.org…',
    moved: 'Done: you\'re signed in at wefty.org, in the window that opened. This old one is signed out.',
    slow: 'wefty.org didn\'t answer this old one. No problem: do it the copy and paste way below.',
    blocked: 'Your browser didn\'t open wefty.org. No problem: do it the copy and paste way below.',
    retry: 'wefty.org couldn\'t reach the cloud just now. Check the internet, then tap Try again.',
    other: 'wefty.org is signed in as someone else in this browser, so nothing was moved. This one is still signed in.',
    arrived: 'Signed in. Welcome to Wefty\'s new home, wefty.org.',
    // (1.22.2) wefty.org opened by Move to wefty.org, but nothing came from the old one (an installed app's window
    // opened in another browser, say): the copy and paste way, from this end.
    lostTitle: 'Almost there',
    lost: 'The old Wefty couldn\'t send your sign-in to this window. Do it by copy and paste:',
    lostSteps: ['Go back to the old Wefty and tap Copy my sign-in.', 'Come back here and tap Paste my sign-in.'],
    lostOther: 'Sign in another way',
    // (1.22.2) the popup and Settings' card on an old address
    popTitle: 'Wefty has moved to wefty.org',
    popText: 'Copy your sign-in here, then open wefty.org and tap Paste my sign-in. No password needed.',
    waitFirst: (n) => `${n === 1 ? '1 change here isn\'t' : `${n} changes here aren't`} in your cloud yet. Wait until the `
      + 'dot on your picture is gone, then copy your sign-in.',
    listening: 'Stop the note-taker first, then copy your sign-in.',
    cardLine: 'Copy your sign-in here, then open wefty.org and tap Paste my sign-in there. No password needed. This old '
      + 'one signs out.',
    cardCode: 'Or at wefty.org tap Use a code from another device, then type its code here under Sign in another '
      + 'device. This one stays signed in that way.',
  };
  // The copy and paste way, step by step (the move screen, once Move to wefty.org didn't get through).
  const COPY_STEPS = ['Tap Copy my sign-in.', 'Tap Open wefty.org (or go to the wefty.org window that opened).',
    'There, tap Paste my sign-in. You\'re in.'];
  // What says everything here reached the cloud, now that there's no Synced pill (1.16): the old icon runs this
  // version too, so its steps point at the picture's mark (js/profile.js).
  const NO_DOT = 'wait until the small dot on your picture at the top is gone (tap the picture: while it says Sending, '
    + 'changes are still going up; with nothing at the top, it\'s all in your cloud)';
  const HANDED = 'vault-handed';  // localStorage: when this old icon handed its sign-in over (a time, nothing secret)
  // Here: an iPhone's or iPad's new home screen icon. (A Safari tab keeps a storage of its own, and the old Vault icon,
  // at the old address, is the one handing its sign-in over: a pass is for the new icon.)
  const iconHere = () => !V.desktop && V.deviceKind.ios && V.install.installed() && !(V.moved && V.moved.old);
  /* Where a move pass can be pasted (1.20): Wefty at its own address, on any device and browser (1.22.2: a Safari tab
     on an iPhone or iPad too, though there it asks first, `safariTab`: a Safari tab keeps a storage of its own, apart
     from the home screen icon's, so the sign-in is usually for the icon). Never on an old address: it's the one
     handing over. */
  const passHere = () => !V.desktop && !(V.moved && V.moved.old);
  const safariTab = () => !V.desktop && V.deviceKind.ios && !V.install.installed();

  /* What this icon could hand over: its cloud, e-mail and session's refresh token (supabase-js keeps the session in
     localStorage 'vault-auth'), or null when it isn't signed in or the cloud isn't a Supabase one with a public key. */
  function ownSignIn() {
    const saved = stored('vault-config');
    const session = stored('vault-auth');
    const refresh = session && typeof session.refresh_token === 'string' ? session.refresh_token : '';
    if (!saved || !CLOUD.test(String(saved.url || '')) || !PUBLIC_KEY.test(String(saved.key || '')) || !REFRESH.test(refresh)) return null;
    // (1.22.5: a session another cloud made is never handed over as this cloud's)
    if (!V.cloud.madeBy(session, saved.url)) return null;
    const email = (session.user && session.user.email) || saved.email || (stored('vault-user') || {}).email || '';
    return { url: saved.url, key: saved.key, email: String(email), refresh };
  }

  const makePass = (from) => PASS + b64url(JSON.stringify({ v: 1, u: from.url, k: from.key, e: from.email, r: from.refresh,
    x: Date.now() + PASS_MINUTES * 60000 }));

  /* This icon stops using its session and tells the cloud nothing (never signOut: see above). Nothing renews it here
     again and a reload here is signed out: supabase-js keeps it under 'vault-auth' (with "vault-auth-..." beside it),
     and 'vault-user' is what keeps an offline icon signed in (js/cloud.js's user()). Its notes stay (all in the cloud). */
  function dropSession() {
    try {
      if (V.cloud && V.cloud.sb) V.cloud.sb.auth.stopAutoRefresh().catch(() => {});  // (none at the move screen)
    } catch (error) { /* none running */ }
    const drop = () => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key === 'vault-auth' || key.startsWith('vault-auth-') || key === 'vault-user') localStorage.removeItem(key);
        }
      } catch (error) { /* private browsing */ }
    };
    drop();
    try { localStorage.setItem(HANDED, String(Date.now())); } catch (error) { /* (so this screen says so when opened again) */ }
    /* (1.22.2) Handed over from inside the app (the move popup, Settings): Wefty running here lets go too. Nothing
       listens or renews any more, and a sync that finds no sign-in says nothing (no sign-in screen over the move's
       steps). A renewal already under way as the sign-in was copied may still write it back: taken out again, unless
       this one took its sign-in back meanwhile (nothing moved: takeBack clears HANDED). */
    if (!V.cloud || !V.cloud.sb || quieted) return;
    quieted = true;
    const emit = V.emit;
    V.emit = (type, detail) => (type === 'signed-out' ? undefined : emit(type, detail));
    try { if (V.cloud.sb.removeAllChannels) V.cloud.sb.removeAllChannels(); } catch (error) { /* (only background work) */ }
    for (const ms of [1500, 6000, 15000]) {
      setTimeout(() => { try { if (localStorage.getItem(HANDED)) drop(); } catch (error) { /* */ } }, ms);
    }
  }
  let quieted = false;

  /* A pasted text as a move pass: null when it isn't one at all; else { pass }, { problem: 'bad' } (damaged, or naming
     anything but a Supabase cloud and its public key: never used, never saved) or { problem: 'expired', pass } (its
     cloud and e-mail only). */
  function readPass(text) {
    const words = String(text || '').trim();
    if (!words.startsWith(PASS)) return null;
    let found = null;
    try {
      const raw = words.slice(PASS.length);
      found = /^[A-Za-z0-9_-]{8,8000}$/.test(raw) ? readLink(raw) : null;
    } catch (error) { /* damaged */ }
    if (!found || typeof found !== 'object' || found.v !== 1 || !CLOUD.test(String(found.u || ''))
      || !PUBLIC_KEY.test(String(found.k || '')) || typeof found.r !== 'string' || !REFRESH.test(found.r)
      || typeof found.x !== 'number' || !Number.isFinite(found.x)) return { problem: 'bad' };
    const email = typeof found.e === 'string' && /^[^@\s]+@[^@\s]+$/.test(found.e.trim()) ? found.e.trim().slice(0, 254) : '';
    const expired = { url: found.u, key: found.k, email, refresh: '', x: found.x };
    if (found.x <= Date.now()) return { problem: 'expired', pass: expired };
    return { pass: { ...expired, refresh: found.r } };
  }

  /* The pass leaves the clipboard once it's been read here. It's tried in the paste tap itself, but by then a phone
     may not count it as a tap any more (the clipboard was read first, and Safari only lets a tap write to it), so
     it's tried again at the next tap in Wefty: never one on Paste my sign-in (it reads the clipboard itself), and
     never once Wefty has been in the background (what's on the clipboard then may be something new, and that's the
     person's own). A pass Wefty took stays good for nothing but a sign-out after that (see swapPass); one that ran
     out still has a live token in it, which is why it's worth taking off. */
  const TAPS = ['touchend', 'click'];
  let wiping = null;
  function emptyClipboard() {
    try { return Promise.resolve(navigator.clipboard.writeText('')); } catch (error) { return Promise.reject(error); }
  }
  function clearAtNextTap() {
    if (wiping) return;
    const stop = () => {
      for (const kind of TAPS) document.removeEventListener(kind, tap, true);
      document.removeEventListener('visibilitychange', away);
      if (wiping === stop) wiping = null;
    };
    const tap = (event) => {
      if (event.target && event.target.closest && event.target.closest('.pass-paste')) return;
      emptyClipboard().then(stop, () => {});  // (refused, as after a scroll: the next tap tries again)
    };
    const away = () => { if (document.hidden) stop(); };
    for (const kind of TAPS) document.addEventListener(kind, tap, true);
    document.addEventListener('visibilitychange', away);
    wiping = stop;
  }
  const keepClipboard = () => { if (wiping) wiping(); };

  let swaps = 0;
  const AGAIN_MS = 10000;  // how long the second swap (below) is waited for; the session from the first does without
  /* The pass's refresh token swapped at the cloud's token endpoint for this icon's own session: { session (the text
     supabase-js keeps for one, for localStorage 'vault-auth'), email }, 'used' (the cloud said no: used already, or
     ended) or 'unreachable'. A client of its own each try, keeping what it gets in memory: nothing is kept until it
     worked, and a try after one that couldn't get through isn't turned away by supabase-js's minute's wait for that
     token. (Its storage key is its own too: one shared with js/cloud.js's client would make supabase-js complain.)
     Swapped twice in a row: Supabase takes a used token whose next one is the session's newest for an answer that
     never arrived, and hands that session out again, with no time limit, so after one swap the same pass would sign
     anyone in until this icon next renewed (an hour later). Two behind, it's turned down once Supabase's few seconds'
     grace are over, and that ends the whole session (this icon signed out too: nobody else gets in). */
  async function swapPass(pass) {
    const kept = new Map();
    const storageKey = `wefty-pass-${++swaps}`;
    const storage = { getItem: (key) => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => { kept.set(key, String(value)); },
      removeItem: (key) => { kept.delete(key); } };
    let answer = null;
    try {
      const client = window.supabase.createClient(pass.url, pass.key, { auth: { storage, storageKey, persistSession: true,
        autoRefreshToken: false, detectSessionInUrl: false } });
      answer = await client.auth.refreshSession({ refresh_token: pass.refresh });
      // (Without an answer in time, this icon renews from the first swap's token later: the cloud takes that one too.)
      if (answer && !answer.error && answer.data && answer.data.session) {
        await Promise.race([client.auth.refreshSession().catch(() => null),
          new Promise((done) => { setTimeout(done, AGAIN_MS); })]);
      }
    } catch (error) {
      return 'unreachable';
    }
    const { data, error } = answer || {};
    const session = kept.get(storageKey);
    if (!error && data && data.session && session) return { session, email: (data.session.user && data.session.user.email) || '' };
    const status = error && error.status;
    return !error || error.name === 'AuthRetryableFetchError' || !status || status === 429 || status >= 500 ? 'unreachable' : 'used';
  }

  /* The move pass on this icon's first screen or its sign-in screen (`button` is the Paste one). `take(text)`: false
     when `text` isn't a move pass; else it's dealt with, any sentence for what stopped it in `problem`. A pass that
     works opens Wefty signed in; one the cloud turned down, or that ran out, leaves the cloud and the e-mail (as a
     #connect= link would) for the sign-in screen, which says why. Both by a reload, with only the outcome's word kept
     for it (PASS_NOTE). A pass the cloud couldn't be asked about waits in memory for `again()` (a tap on Paste). */
  function passTaker(problem, button, { here = false } = {}) {
    let held = null;
    let busy = false;
    let choice = null;  // (a Safari tab's "Sign in here in Safari instead", while it's offered)
    const say = (text) => {
      problem.textContent = text;
      if (choice) { choice.remove(); choice = null; }
    };
    const reload = async (pass, outcome, session) => {
      busy = true;  // (nothing more from here: the page starts again)
      if (session) localStorage.setItem('vault-auth', session);
      // (no sign-in came of it: its key is only kept once it's known to be the cloud's, keyFor)
      const key = session ? pass.key : await keyFor(pass.url, pass.key);
      localStorage.setItem('vault-config', JSON.stringify({ url: pass.url, key, email: pass.email }));
      try { sessionStorage.setItem(PASS_NOTE, outcome); } catch (error) { /* the sign-in screen just won't say why */ }
      location.reload();
    };
    // (1.22.5) A copied sign-in names its cloud and account: whose it is is asked first (and the cloud's name, when it
    // isn't Wefty's own or the one saved here), as a link's is (js/doors.js's signInAs).
    const otherCloud = async (url) => {
      const saved = stored('vault-config');
      return !(saved && saved.url === url) && !(await officialCloud(url));
    };
    const askWho = async (email, url) => (!V.doors || !V.doors.signInAs ? true
      : V.doors.signInAs(email, { line: await V.doors.cloudLine(url, { saved: (stored('vault-config') || {}).url || '' }) }));
    // One that ran out: its cloud and e-mail are kept for the sign-in screen (as a #connect= link's); a cloud that's
    // neither the one saved nor Wefty's own only once they said yes to it (as for a link: cloudQuestion).
    async function expired(pass) {
      if ((await otherCloud(pass.url)) && !(await cloudQuestion(pass.url))) { location.reload(); return; }
      reload({ ...pass, refresh: '' }, 'expired');
    }
    async function swap(pass) {
      if (busy) return;
      // (Wefty's own ten minutes, checked again for one held since a tap the cloud couldn't answer: the cloud itself
      // knows nothing of them, and would take the token as long as the session lives.)
      if (!(pass.x > Date.now())) { held = null; await expired(pass); return; }
      if (!navigator.onLine) { held = pass; say(PASS_WORDS.offline); return; }
      busy = true;
      say('');
      if (pass.email && !pass.asked) {
        const yes = await askWho(pass.email, pass.url);
        if (!yes) { busy = false; held = null; say(PASS_WORDS.notYou); return; }
        pass.asked = true;  // (tried again after the cloud couldn't be reached: not asked twice)
      }
      const label = button.querySelector(':scope > span:not(.icon)');
      const was = label ? label.textContent : '';
      if (label) label.textContent = 'Signing in…';
      button.disabled = true;
      const got = await swapPass(pass);
      busy = false;
      button.disabled = false;
      if (label) label.textContent = was;
      if (got === 'unreachable') { held = pass; say(PASS_WORDS.unreachable); return; }
      held = null;
      if (got === 'used') { reload(pass, 'used'); return; }
      // Never kept unless it's the account it said it was (or, saying none, the one they said yes to now).
      const email = String(got.email || '');
      if (pass.email ? email.toLowerCase() !== pass.email.toLowerCase() : !(await askWho(email, pass.url))) {
        say(pass.email ? PASS_WORDS.notFor(pass.email) : PASS_WORDS.notYou);
        return;
      }
      reload({ ...pass, email: email || pass.email }, safariTab() ? 'safari' : 'in', got.session);
    }
    // Taken here, in this very tap (a paste, a tap on Paste my sign-in, or Safari's "here instead"): off the clipboard.
    function use(read) {
      emptyClipboard().catch(() => {});
      clearAtNextTap();
      held = null;
      if (read.problem === 'bad') say(PASS_WORDS.bad);
      else if (read.problem === 'expired') expired(read.pass);
      else swap(read.pass);
    }
    return {
      busy: () => busy,
      take(text) {
        const read = readPass(text);
        if (!read) return false;
        if (!passHere()) {  // an old address: left on the clipboard for Wefty at its own address
          say(PASS_WORDS.elsewhere);
          return true;
        }
        if (!navigator.onLine) { keepClipboard(); say(PASS_WORDS.offline); return true; }  // (there for the next tap)
        // A Safari tab on an iPhone or iPad: the sign-in is usually for the new home screen icon (its storage is its
        // own), so it stays on the clipboard for the icon unless they say it's for Safari.
        if (safariTab() && !here && read.problem !== 'bad') {
          say(PASS_WORDS.safari);
          choice = V.button(PASS_WORDS.safariHere, { kind: 'wide-btn pass-safari', onClick: () => {
            if (busy) return;
            use(read);
          } });
          problem.after(choice);
          return true;
        }
        use(read);
        return true;
      },
      again(text) {
        if (!held || busy || /#(invite|join|connect)=/.test(String(text || ''))) return false;
        swap(held);
        return true;
      },
    };
  }

  /* A Paste button that reads the clipboard in its own tap (only a tap lets a page read it): a move pass goes to its
     passTaker (`mover`), anything else to `other(text)`; `unread()` when it couldn't be read. With `box` (1.22.2),
     a browser that won't let a page read the clipboard (an app's own browser, a school's settings, a "Don't allow")
     gets a box to paste into instead: `box.row` goes on the screen (hidden until it's needed), and `unread` shows it
     and says so. */
  function pasteButton(label, kind, problem, other, unread, { box = false, here = false } = {}) {
    let mover = null;
    let paste = null;
    const button = V.button(label, { kind: `${kind} pass-paste`, icon: 'clip', onClick: () => {
      if (mover.busy()) return;
      problem.textContent = '';
      let reading;
      try { reading = navigator.clipboard.readText(); } catch (error) { reading = Promise.reject(error); }
      Promise.resolve(reading).then((text) => {
        if (!readPass(text)) keepClipboard();  // (no pass on it now: whatever is there is the person's own)
        if (mover.busy()) return;  // (a second tap while the first one's pass is being swapped)
        if (!mover.take(text) && !mover.again(text)) other(text);
      }, () => {
        if (mover.busy() || mover.again('')) return;
        if (paste) { problem.textContent = PASS_WORDS.unread; paste.show(); }
        unread();
      });
    } });
    mover = passTaker(problem, button, { here });
    if (box) paste = pasteBox(mover, other);
    return { button, mover, box: paste };
  }

  /* The box a sign-in can be pasted into by hand, when the clipboard can't be read (pasteButton's `box`): what's pasted
     never stays in it (catchPaste, and a keyboard that puts it in without a paste: taken out at once), and while it
     is in it, it shows as dots. A link (an invite, #connect=...) goes where Paste would send it. */
  function pasteBox(mover, other) {
    const input = V.h('input.field.pass-box', { type: 'text', autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', placeholder: PASS_WORDS.box, 'aria-label': PASS_WORDS.box });
    const row = V.h('div.pass-box-row', { hidden: true }, input);
    catchPaste(input, mover);
    const hand = (text) => {
      if (readPass(text)) {
        input.value = '';
        if (!mover.busy()) mover.take(text);
        return true;
      }
      if (/#(invite|join|connect)=/.test(text)) { input.value = ''; other(text); return true; }
      return false;
    };
    input.addEventListener('input', () => { hand(input.value); });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !input.value.trim()) return;
      const text = input.value;
      if (!hand(text)) { input.value = ''; other(text); }
    });
    return { row, input, show() { row.hidden = false; requestAnimationFrame(() => input.focus()); } };
  }

  /* A move pass pasted into a box by hand (when Paste couldn't read the clipboard): taken as Paste would take it, and
     never let into the box, so it's never on the screen. */
  function catchPaste(box, mover) {
    box.addEventListener('paste', (event) => {
      const text = event.clipboardData ? event.clipboardData.getData('text') : '';
      if (!readPass(text)) return;
      event.preventDefault();
      if (!mover.busy()) mover.take(text);
    });
  }

  /* What became of a move pass before this page reloaded (only that word, never the pass): read once. */
  function passOutcome() {
    try {
      const outcome = sessionStorage.getItem(PASS_NOTE) || '';
      sessionStorage.removeItem(PASS_NOTE);
      return outcome;
    } catch (error) {
      return '';
    }
  }

  /* ---------------------------------------------------------------- the move to wefty.org (1.20)

     wefty.org is a new site to the browser, so nothing kept at an old address (crustyt0es.github.io/wefty/ or /vault/)
     is there: not the sign-in, not the offline copy, not this device's settings. A tab that's signed in, and every old
     installed app, gets the move screen (js/moved.js's 'ask'), and one tap carries everything over without a password:

     Move to wefty.org opens wefty.org in a new window with #moving, keeping the link between the two (no noopener). The
     new page (takeHandOver, below) says it's ready to this page, by postMessage, to the old addresses' origin only;
     this page answers only a message from the very window it opened and only from wefty.org's origin, and sends back,
     to that origin only, its cloud, e-mail and session's refresh token (the move pass, as an object: nothing in an
     address, a clipboard or any storage) and its settings (CARRY: never the sign-in's own keys, push sign-ups, update
     state or admin keys). This page lets go of its session right then (dropSession: never signOut, see "an iPhone's
     sign-in" above), as two pages renewing one session get it ended. wefty.org swaps the token twice (swapPass) for a
     session of its own and says how it went: 'in', or 'failed' with why ('unreachable': this page still holds the pass
     in memory and Try again opens a window again; 'used'; 'other': wefty.org is signed in as someone else in this
     browser, so nothing moved and this page signs back in with what it held). With no answer in moveWaits.fallback
     (1.22.2: also as soon as this page is back in sight with none: the person went to look), or a window that didn't
     open, the screen turns to the copy and paste way: Copy my sign-in puts the same pass on the clipboard for
     wefty.org's Paste my sign-in (any device and browser there), with its steps; and wefty.org's window, if it got
     nothing, says the same from its end (lostScreen). An iPhone or iPad icon only ever gets the clipboard pass: each
     icon keeps its storage apart, and one opens wefty.org in Safari.
     The same sign-in can be handed over from inside the app too (1.22.2): the move popup on whatever screen (once a
     session, at a calm moment) and Settings > Devices' "Sign in on wefty.org" (copyHere, below).

     Changes this device has that the cloud hasn't got (waitingHere) would be stranded: then there's no pass, only "Keep
     using this one for now" until they're up. Signed out here: the link to wefty.org carries the cloud and e-mail
     (#connect=), so its sign-in screen knows them. Opened again after it handed its sign-in over, it says so
     (HANDED). */
  const MOVE = { ready: 'wefty-move-ready', pass: 'wefty-move-pass', in: 'wefty-move-in', failed: 'wefty-move-failed' };
  // (1.22.2) How long things wait (tests shorten them): wefty.org's window for the old one's sign-in (lost), the old one
  // for its window's answer (fallback; heard: once it answered), and the popup (popAfter after the app opened, then a
  // look for a calm moment every popLook; popUp: how long wefty.org gets to answer when the start didn't hear it).
  // (popAfter is four times as long when the move screen was shown at the start and Keep using was pressed.)
  const moveWaits = { lost: 8000, fallback: 6000, heard: 20000, popAfter: 15000, popLook: 1500, popUp: 15000,
    ...(window.__weftyMoveWaits || {}) };
  // This device's settings that go along: every 'vault-...' key but the sign-in itself, push sign-ups (they belong to
  // the old address's worker), update state and admin keys. Each up to CARRY_MOST letters.
  const NOT_CARRIED = /^vault-(?:auth|user$|config$|handed$|update|push|admin|files-host|share)/;
  const CARRY_MOST = 20000;
  const carriable = (key, value) => /^vault-[a-z0-9-]+$/.test(key) && !NOT_CARRIED.test(key) && typeof value === 'string'
    && value.length <= CARRY_MOST;
  function carried() {
    const out = {};
    let total = 0;
    try {
      for (const key of Object.keys(localStorage).sort()) {
        const value = localStorage.getItem(key);
        if (!carriable(key, value) || total + value.length > 10 * CARRY_MOST) continue;
        out[key] = value;
        total += value.length;
      }
    } catch (error) { /* private browsing: nothing to carry */ }
    return out;
  }
  /* What came along, kept where wefty.org has nothing of its own yet, and the look put on at once. */
  function keepCarried(keep) {
    if (!keep || typeof keep !== 'object') return;
    try {
      for (const [key, value] of Object.entries(keep).slice(0, 200)) {
        if (carriable(key, value) && localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
    } catch (error) { /* full or private: the settings just start fresh */ }
    try {
      if (V.theme) {
        V.theme.set(localStorage.getItem('vault-theme'));
        V.theme.setBlack(localStorage.getItem('vault-black') === 'on');
      }
    } catch (error) { /* (the look follows at the next start) */ }
  }

  /* The pass as sent by postMessage, checked like a pasted one (readPass): { url, key, email, refresh, x } or null. */
  function checkedPass(data) {
    if (!data || typeof data !== 'object' || !CLOUD.test(String(data.u || '')) || !PUBLIC_KEY.test(String(data.k || ''))
      || typeof data.r !== 'string' || !REFRESH.test(data.r)) return null;
    const email = typeof data.e === 'string' && /^[^@\s]+@[^@\s]+$/.test(data.e.trim()) ? data.e.trim().slice(0, 254) : '';
    return { url: data.u, key: data.k, email, refresh: data.r, x: Date.now() + PASS_MINUTES * 60000 };
  }

  /* `handed` (1.22.2): the sign-in already copied from inside the app (the move popup, Settings > Devices), this
     page signed out: the screen opens at the copy and paste way's next step, with Copy it again. `inApp`: opened over
     the running app (the popup's Move to wefty.org): Keep using this one for now opens it again (a reload). */
  async function movedScreen({ handed: handedHere = null, inApp = false } = {}) {
    const how = V.welcome.howToInstall();
    const apple = how.kind === 'ios' || V.deviceKind.ios;
    const icon = apple && V.moved.installed;  // an iPhone's home screen icon: the clipboard pass only
    const waiting = handedHere ? 0 : await waitingHere();
    const host = V.moved.host;
    return new Promise((resolve) => {
      const saved = stored('vault-config');
      const email = (saved && saved.email) || ((stored('vault-user') || {}).email) || (handedHere && handedHere.email) || '';
      const linkTo = (extra = {}) => (saved && saved.url && saved.key
        ? `${V.moved.to}#connect=${b64url(JSON.stringify({ u: saved.url, k: saved.key, e: email, ...extra }))}` : '');
      const link = linkTo();
      // (1.22.2) Once this one can hand its sign-in over, wefty.org's sign-in screen is told so (m: 1), and that it's
      // for that browser (h: 1) unless this is an installed app (an iPhone's icon: its sign-in is for the new icon).
      const moveLink = linkTo(V.moved.installed ? { m: 1 } : { m: 1, h: 1 });
      const model = V.deviceKind.model || 'iPhone';
      const session = !!ownSignIn();
      let passable = (session && waiting === 0) || !!handedHere;
      const later = session && waiting > 0;  // a sign-in to hand over once the changes are up: come back for it then
      if (session) {
        try { localStorage.removeItem(HANDED); } catch (error) { /* (signed in here again since) */ }
      }
      const handed = !session && !handedHere && !!stored(HANDED);
      let given = handedHere;  // the sign-in handed over (memory only), for Try again / Copy it again
      let state = handedHere ? 'copied' : '';  // '', 'moving', 'slow', 'blocked', 'retry', 'moved', 'used', 'copied'
      const said = V.h('p.moved-done', { role: 'status', hidden: true });
      // (1.22: a move that didn't work offers Help, js/help.js: what to do next, never a dead end)
      const helpLink = V.h('button.link-btn.moved-help', { type: 'button', hidden: true, text: 'Help with moving',
        onclick: () => { if (V.help) V.help.open({ card: 'move' }); } });
      const say = (text, trouble = false) => {
        said.textContent = text;
        said.hidden = !text;
        said.classList.toggle('trouble', trouble);
        helpLink.hidden = !(trouble && V.help && V.help.forError && V.help.forError({ message: text, move: true }) === 'move');
      };
      const KEEP_DATA = 'If it offers to clear data too, it doesn\'t matter now: your notes are in your cloud.';
      const what = V.moved.vault ? 'Vault' : 'Wefty';
      let held = null;  // this page's own sign-in keys, kept in memory when it lets go (put back if nothing moved)
      const lettingGo = (from) => {
        if (!given) {
          held = {};
          try {
            for (const key of Object.keys(localStorage)) {
              if (key === 'vault-auth' || key.startsWith('vault-auth-') || key === 'vault-user') held[key] = localStorage.getItem(key);
            }
          } catch (error) { /* private browsing */ }
          dropSession();
        }
        given = from;
      };
      // Notifications (js/push.js) belong to this address's service worker, so they'd keep coming here, and twice
      // once turned on at wefty.org: this browser's sign-up is ended (the helper drops it at its next send) once the
      // sign-in has moved, and the steps say to turn them on again there.
      const hadPush = !!stored('vault-push');
      const stopPush = () => {
        try {
          localStorage.removeItem('vault-push');
          if (!navigator.serviceWorker) return;
          navigator.serviceWorker.getRegistration()
            .then((registration) => registration && registration.pushManager && registration.pushManager.getSubscription())
            .then((subscription) => subscription && subscription.unsubscribe())
            .catch(() => {});
        } catch (error) { /* (the helper drops it when it next fails anyway) */ }
      };
      if (handedHere) stopPush();  // (handed over from inside the app: the sign-up here ends as with the screen's own)
      const takeBack = () => {
        try {
          for (const [key, value] of Object.entries(held || {})) localStorage.setItem(key, value);
          localStorage.removeItem(HANDED);
        } catch (error) { /* */ }
        given = null;
        held = null;
      };

      // Move to wefty.org's window, while it's being waited for (see moveByWindow).
      let listening = null;
      let timer = null;
      let watching = null;
      const stopWaiting = () => {
        clearTimeout(timer);
        if (listening) window.removeEventListener('message', listening);
        if (watching) document.removeEventListener('visibilitychange', watching);
        listening = null;
        watching = null;
      };

      // Copy my sign-in: made and written in this very tap (Safari only lets a page write the clipboard during one);
      // this page lets go of its session only once the pass is on the clipboard.
      const copyPass = () => {
        const from = given || ownSignIn();
        if (!from) { passable = false; draw(); return; }
        let writing;
        try { writing = navigator.clipboard.writeText(makePass(from)); } catch (error) { writing = Promise.reject(error); }
        Promise.resolve(writing).then(() => {
          const first = !given;
          stopWaiting();  // (1.22.2: the copy and paste way now: a window that answers late gets nothing, never a "used")
          lettingGo(from);
          stopPush();
          state = 'copied';
          draw();
          say(!first ? PASS_WORDS.again : icon ? PASS_WORDS.copied : PASS_WORDS.copiedGo);
        }, () => say(PASS_WORDS.notCopied, true));
      };

      /* Move to wefty.org: the window, then the pass by postMessage (see above). 1.22.2: never left waiting. No answer
         from the window in moveWaits.fallback (an installed app's window may open in another browser, with no way back
         here), or none at all once this one's in sight again after being away (the person went to look at it), and it
         turns to the copy and paste way, with its steps. A window that did answer gets moveWaits.heard to finish. */
      const moveByWindow = () => {
        const from = given || ownSignIn();
        if (!from) { passable = false; draw(); return; }
        stopWaiting();
        let win = null;
        try { win = window.open(V.moved.to + '#moving', '_blank'); } catch (error) { win = null; }
        if (!win) { state = 'blocked'; draw(); say(PASS_WORDS.blocked, true); return; }
        state = 'moving';
        draw();
        say(PASS_WORDS.moving);
        const opened = Date.now();
        let heard = false;
        const fallBack = () => {
          if (state !== 'moving') return;
          // (Still listening: a window that answers late still gets the sign-in, unless it's been copied by then.)
          clearTimeout(timer);
          if (watching) document.removeEventListener('visibilitychange', watching);
          watching = null;
          state = 'slow';
          draw();
          say(PASS_WORDS.slow, true);
        };
        timer = setTimeout(fallBack, moveWaits.fallback);
        watching = () => {
          if (!document.hidden && !heard && Date.now() - opened > 1500) fallBack();
        };
        document.addEventListener('visibilitychange', watching);
        listening = (event) => {
          if (event.origin !== V.moved.toOrigin || event.source !== win) return;
          const data = event.data && typeof event.data === 'object' ? event.data : {};
          if (data.type === MOVE.ready) {
            if (heard) return;
            heard = true;
            clearTimeout(timer);
            timer = setTimeout(fallBack, moveWaits.heard);
            lettingGo(from);
            try {
              win.postMessage({ type: MOVE.pass, u: from.url, k: from.key, e: from.email, r: from.refresh, keep: carried() },
                V.moved.toOrigin);
            } catch (error) { /* the window closed: Try again */ }
            return;
          }
          if (data.type !== MOVE.in && data.type !== MOVE.failed) return;
          stopWaiting();
          if (data.type === MOVE.in) {
            stopPush();
            state = 'moved';
            draw();
            say(PASS_WORDS.moved);
          } else if (data.why === 'other') {
            takeBack();  // (nothing was taken there: this page keeps its session)
            state = '';
            draw();
            say(PASS_WORDS.other, true);
          } else if (data.why === 'unreachable') {
            state = 'retry';
            draw();
            say(PASS_WORDS.retry, true);
          } else {
            state = 'used';
            draw();
            say(PASS_WORDS.used, true);
          }
        };
        window.addEventListener('message', listening);
      };

      const draw = () => {
        let steps = [];
        // (With no #hash of its own, the cloud and e-mail go along as #connect=, so wefty.org's sign-in knows them.)
        const going = passable ? moveLink : link;
        const goNew = V.h(`a.btn${state === 'moved' || state === 'copied' || !passable ? '.primary' : ''}.wide-btn.moved-open`, {
          href: location.hash || !going ? V.moved.target() : V.moved.target() + going.slice(going.indexOf('#')),
          target: '_blank', rel: 'noopener' }, V.icon('open'), V.h('span', { text: `Open ${host}` }));
        const install = icon || apple
          ? 'There, tap Share, then Add to Home Screen (keep Open as Web App on).'
          : how.kind === 'chromebook' ? 'There, click Install in the address bar (or ⋮ > Cast, save and share > Install page as app).'
            : how.kind === 'android' || V.deviceKind.android ? 'There, tap Install (or ⋮ > Add to Home screen).'
              : `There, install it if you like. ${how.steps.join(' ')}`;
        const removeOld = V.moved.installed
          ? (apple ? `Then remove this old ${what} icon: press and hold it, then Remove App.`
            : `Then remove this old ${what} app. ${KEEP_DATA}`)
          : 'Then close this tab, and use wefty.org from now on (update your bookmark).';
        const again = hadPush ? 'Notifications: turn them on again there (tap your picture, then Settings > Notifications).' : null;
        let buttons = [];
        if (icon && passable) {
          steps = [given ? null : 'Tap Copy my sign-in.', `Tap Open ${host}. It opens in Safari.`, install,
            'Open the new Wefty icon and tap Paste my sign-in.', again, removeOld];
          const pass = V.button(given ? 'Copy it again' : 'Copy my sign-in', {
            kind: given ? 'wide-btn moved-pass' : 'primary wide-btn moved-pass', icon: 'copy', onClick: copyPass });
          buttons = given ? [goNew, pass] : [pass, V.h('p.hint.moved-hint', { text: PASS_WORDS.handOver }), goNew];
        } else if (passable) {
          const move = V.button(state === 'retry' ? 'Try again' : state === 'slow' ? `Try Move to ${host} again` : `Move to ${host}`, {
            kind: `${['moved', 'slow', 'blocked'].includes(state) ? '' : 'primary '}wide-btn moved-move`, icon: 'open',
            onClick: moveByWindow });
          if (state === 'moved') {
            steps = [install, again, removeOld];
            buttons = [goNew];
          } else if (['slow', 'blocked', 'copied'].includes(state)) {
            // (1.22.2) The copy and paste way: Copy my sign-in, Open wefty.org, Paste my sign-in there.
            const pass = V.button(given && state === 'copied' ? 'Copy it again' : 'Copy my sign-in', {
              kind: `${state === 'copied' ? '' : 'primary '}wide-btn moved-pass`, icon: 'copy', onClick: copyPass });
            steps = [state === 'copied' ? null : COPY_STEPS[0], COPY_STEPS[1], COPY_STEPS[2], install, again, removeOld];
            buttons = state === 'copied' ? [goNew, pass] : [pass, goNew, state === 'slow' ? move : null];
          } else {
            const pass = state === 'retry' ? V.button('Copy my sign-in', { kind: 'wide-btn moved-pass', icon: 'copy', onClick: copyPass })
              : null;
            steps = [`Tap Move to ${host}. It opens in a new window, already signed in.`, install, again, removeOld];
            buttons = [move, state ? null : V.h('p.hint.moved-hint', { text: PASS_WORDS.handOver }), pass];
          }
        } else if (later) {
          steps = [`Tap Keep using this one for now and ${NO_DOT}.`,
            'Then close it and open this old one again.',
            icon ? 'Tap Copy my sign-in. No password needed.' : `Tap Move to ${host}. No password needed.`];
        } else {
          const tap = apple || how.kind === 'android' || V.deviceKind.android ? 'Tap' : 'Click';
          steps = [apple && link ? 'Tap Copy the sign-in link.' : null, `${tap} Open ${host}.`,
            apple && link ? 'There, tap Paste my sign-in, then sign in with your e-mail and password.'
              : 'Sign in there with your e-mail and password.', install,
            waiting > 0 ? null : removeOld];
          const copy = apple && link ? V.button('Copy the sign-in link', { kind: 'wide-btn moved-copy', icon: 'copy',
            onClick: async () => {
              await V.copy(link);
              V.toast('Copied. In Wefty at wefty.org, tap Paste my sign-in.', { ms: 6000 });
            } }) : null;
          buttons = [goNew, copy];
        }
        const things = waiting === 1 ? `1 change on this ${apple ? model : 'device'} isn't in your cloud yet`
          : `${waiting} changes on this ${apple ? model : 'device'} aren't in your cloud yet`;
        screen(V.h('img.moved-icon', { src: 'icons/wefty-192.png', alt: '', width: 72, height: 72 }),
          V.h('h1', { text: V.moved.vault ? 'Vault is now Wefty' : `Wefty has moved to ${host}` }),
          V.h('p.muted', { text: V.moved.vault
            ? `Same notes, a new name and a new home: ${host}. Your notes are all in your cloud, so nothing is lost.`
            : `Same notes, same everything, at a shorter address. Your notes are all in your cloud, so nothing is lost.` }),
          said,
          helpLink,
          buttons,
          V.h('ol.steps.moved-steps', {}, steps.filter(Boolean).map((text) => V.h('li', { text }))),
          given && icon ? V.h('p.hint.moved-hint', { text: PASS_WORDS.once }) : null,
          waiting > 0 ? V.h('p.moved-waiting', { role: 'note', text: later ? `${things}.`
            : `${things}. Tap Keep using this one for now and ${NO_DOT}.` }) : null,
          // (Signed out here once the sign-in is handed over: this one can't carry on without the password.)
          given ? null : V.h('button.link-btn.welcome-skip.moved-keep', { type: 'button', text: 'Keep using this one for now',
            onclick: () => {
              stopWaiting();
              if (!inApp) { resolve(); return; }
              // (Over the running app: it opens again, without this screen first this time.)
              try { sessionStorage.setItem(KEPT_HERE, '1'); } catch (error) { /* (it just asks again) */ }
              location.reload();
            } }));
      };
      if (handed) say(PASS_WORDS.handed);
      draw();
      if (handedHere) say(icon ? PASS_WORDS.copied : PASS_WORDS.copiedGo);
    });
  }
  const KEPT_HERE = 'wefty-move-kept';  // sessionStorage: "Keep using this one for now" pressed over the running app

  /* ---------------------------------------------------------------- moving from inside the app (1.22.2)

     The owner: friends had trouble with the move screen, and asked for "a popup on whatever screen they are on in
     Wefty to quick paste into" wefty.org. On an old address, signed in (after "Keep using this one for now", or when
     wefty.org was too slow to answer at the start), Wefty shows a small popup once a session, at a calm moment (nothing
     over the app, nothing being typed, no locked note open, not recording), only once wefty.org answers: "Wefty has
     moved to wefty.org", with Copy my sign-in, Open wefty.org and Move to wefty.org (the move screen, over the app).
     Settings > Devices has the same Copy my sign-in ("Sign in on wefty.org"). Copy my sign-in is the move pass, on any
     device and browser, made and written in the tap; once it's on the clipboard this page lets go of its session
     (dropSession: the running app too) and the move screen takes over at its next step (Open wefty.org, then Paste my
     sign-in there), with Copy it again. Never while changes made here aren't in the cloud yet, or while the
     note-taker is listening. */
  const POP_DONE = 'wefty-move-pop';  // sessionStorage: the popup was answered or closed this session
  let popEl = null;
  let popTimer = null;
  let popWatch = null;
  let waitingLooked = 0;  // what's waiting to go up, as last looked at (outgoing files, settings...): V.cloud.unsent()
  const popDone = () => { try { return !!sessionStorage.getItem(POP_DONE); } catch (error) { return false; } };
  const markPop = () => { try { sessionStorage.setItem(POP_DONE, '1'); } catch (error) { /* (asked again next time) */ } };
  const movingHere = () => !V.desktop && !!V.moved && V.moved.old && !!ownSignIn();
  // Notes, folders and files changed here and not sent yet, as of now (the async look may be a moment old).
  function dirtyNow() {
    let count = 0;
    try {
      for (const table of ['folders', 'notes', 'transfers']) {
        for (const row of (V.data[table] || new Map()).values()) if (row._dirty) count += 1;
      }
      if (V.data.settings && V.data.settings._dirty) count += 1;
    } catch (error) { /* */ }
    return count;
  }
  async function lookWaiting() {
    try { waitingLooked = V.cloud && V.cloud.unsent ? await V.cloud.unsent() : await waitingHere(); } catch (error) { waitingLooked = 0; }
    return waitingLooked;
  }

  /* Copy my sign-in from inside the app (the popup, Settings > Devices): `trouble(text)` says what stopped it. */
  function copyHere(trouble) {
    if (V.notetaker && V.notetaker.listening && V.notetaker.listening()) { trouble(PASS_WORDS.listening); return; }
    const waiting = Math.max(dirtyNow(), waitingLooked);
    if (waiting > 0) { trouble(PASS_WORDS.waitFirst(waiting)); lookWaiting(); return; }
    const from = ownSignIn();
    if (!from) { trouble(PASS_WORDS.handed); return; }
    let writing;
    try { writing = navigator.clipboard.writeText(makePass(from)); } catch (error) { writing = Promise.reject(error); }
    Promise.resolve(writing).then(() => {
      markPop();
      hidePop();
      dropSession();
      movedScreen({ handed: from }).catch((error) => console.error('Wefty: the move', error));
    }, () => trouble(PASS_WORDS.notCopied));
  }

  // The link to wefty.org from here: its sign-in screen knows the cloud and e-mail, and leads with Paste my sign-in.
  const openLink = () => {
    const connect = V.moved.connect(V.moved.installed ? 'app' : 'tab');
    return location.hash || !connect ? V.moved.target() : V.moved.target() + connect;
  };

  /* -- the popup */

  const NOT_TYPED = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'];
  function popCalm() {
    if (!app.classList.contains('ready') || app.classList.contains('gate')) return false;
    if (V.away && V.away()) return false;
    if (V.welcome && V.welcome.pending && V.data.user && V.welcome.pending(V.data.user.id)) return false;
    if (document.querySelector('#layers > :not(.nt-strip):not(.move-pop)')) return false;  // a sheet, a menu, the tour...
    if (V.editor && V.editor.covering && V.editor.covering()) return false;  // a note over everything
    const note = V.editor && V.editor.openId && V.editor.openId() && V.editor.current ? V.editor.current() : null;
    if (note && note.locked) return false;  // never over a locked note
    if (V.notetaker && V.notetaker.listeningTo && V.notetaker.listeningTo()) return false;  // recording: never
    if (V.drag && V.drag.busy && V.drag.busy()) return false;
    const el = document.activeElement;
    if (el && el !== document.body && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
      || (el.tagName === 'INPUT' && !NOT_TYPED.includes(String(el.type).toLowerCase())))) return false;
    return true;
  }
  function hidePop() {
    clearInterval(popWatch);
    popWatch = null;
    if (popEl) { popEl.remove(); popEl = null; }
  }
  function lookForPop(ms = moveWaits.popLook) {
    clearTimeout(popTimer);
    popTimer = setTimeout(async () => {
      if (popEl || popDone() || !movingHere()) return;
      if (!popCalm()) { lookForPop(); return; }
      if (await lookWaiting() > 0 || dirtyNow() > 0) { lookForPop(moveWaits.popLook * 4); return; }  // (once it's up)
      if (popEl || popDone() || !popCalm()) { lookForPop(); return; }
      showPop();
    }, ms);
  }
  function showPop() {
    const said = V.h('p.move-pop-said', { role: 'status' });
    const trouble = (text) => { said.textContent = text; };
    popEl = V.h('div.move-pop', { role: 'region', 'aria-label': PASS_WORDS.popTitle },
      V.h('span.move-pop-ic', { 'aria-hidden': 'true' }, V.icon('open')),
      V.h('div.move-pop-text', {}, V.h('strong', { text: PASS_WORDS.popTitle }), V.h('p', { text: PASS_WORDS.popText })),
      V.iconButton('x', 'Not now', () => { markPop(); hidePop(); }, 'move-pop-close'),
      said,
      V.h('div.move-pop-buttons', {},
        V.button('Copy my sign-in', { kind: 'primary move-pop-copy', icon: 'copy', onClick: () => copyHere(trouble) }),
        V.h('a.btn.move-pop-open', { href: openLink(), target: '_blank', rel: 'noopener', onclick: () => markPop() },
          V.icon('open'), V.h('span', { text: `Open ${V.moved.host}` })),
        V.button(`Move to ${V.moved.host}`, { kind: 'move-pop-move', onClick: () => {
          markPop();
          hidePop();
          movedScreen({ inApp: true }).catch((error) => console.error('Wefty: the move', error));
        } })));
    document.getElementById('layers').append(popEl);
    // Something else needs the screen (a sheet, typing, a locked note): it steps aside, and comes back later.
    popWatch = setInterval(() => {
      if (!popEl) return;
      if (!movingHere()) { hidePop(); return; }
      if (!popCalm() && !popEl.contains(document.activeElement)) { hidePop(); lookForPop(); }
    }, 400);
  }

  /* After main(): the popup, once a session, when this is an old address, signed in, and wefty.org answers. */
  function startMovePop(moving, askedAtStart = false) {
    if (!movingHere() || popDone()) return;
    const up = moving === 'ask' ? Promise.resolve(true) : V.moved.answers(moveWaits.popUp);
    const after = moveWaits.popAfter * (askedAtStart ? 4 : 1);  // (just said no to the move screen: later)
    up.then((answered) => { if (answered) lookForPop(after); }).catch(() => {});
    V.on('back', () => { if (!popEl && !popDone() && movingHere()) lookForPop(); });
  }

  /* -- Settings > Devices (an old address, signed in): "Sign in on wefty.org" */

  function moveCard(ui) {
    if (!movingHere()) return null;
    lookWaiting();
    const said = V.h('p.error-text.move-card-said', { role: 'status' });
    const card = ui.card('Wefty has moved',
      ui.line('Sign in on wefty.org', PASS_WORDS.cardLine, V.h('div.setting-buttons', {},
        V.button('Copy my sign-in', { kind: 'primary', icon: 'copy', onClick: () => copyHere((text) => { said.textContent = text; }) }),
        V.h('a.btn', { href: openLink(), target: '_blank', rel: 'noopener' }, V.icon('open'), V.h('span', { text: `Open ${V.moved.host}` }))),
      'sign-in-on-wefty-org'),
      said,
      V.pair ? V.h('p.hint.move-card-code', { text: PASS_WORDS.cardCode }) : null);
    return card;
  }
  V.move = { card: moveCard, here: movingHere, waits: moveWaits, words: PASS_WORDS };

  /* wefty.org's half of the move (1.20, see above): opened with #moving by an old address's Move to wefty.org. Says
     ready to the window that opened it (its opener, at the old addresses' origin only), takes one pass from that very
     window and that origin, swaps it for a session of its own, keeps what came along, and says how it went. Returns
     'in', 'here' (already signed in here as the same person), 'used', 'unreachable', 'other' or '' (nothing came).
     1.22.2: with no link back to the old one (an installed app's window that opened in the phone's browser, a browser
     that drops it), or nothing from it in waits.lost, it's never a dead end: the copy and paste way (lostScreen), from
     this end, while it still takes the sign-in if the old one sends it after all. */
  async function takeHandOver() {
    if (location.hash !== '#moving') return '';
    history.replaceState(null, '', location.pathname + location.search);
    if (V.desktop || !V.moved || V.moved.old) return '';
    const opener = window.opener;
    if (!opener) return ownSignIn() ? '' : new Promise((resolve) => { lostScreen(() => resolve('')); });
    const origins = V.moved.origins || [];
    const waitScreen = () => screen(V.h('img.moved-icon', { src: 'icons/wefty-192.png', alt: '', width: 72, height: 72 }),
      V.h('h1', { text: 'Moving your sign-in…' }), V.h('p.muted', { text: 'One moment.' }));
    waitScreen();
    return new Promise((resolve) => {
      let busy = false;
      let done = false;
      let lost = false;  // the copy and paste way shows (the old one may still send the sign-in)
      const tell = (origin, data) => { try { opener.postMessage(data, origin); } catch (error) { /* closed */ } };
      const finish = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', listen);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        if (busy || done) return;
        if (ownSignIn()) { finish(''); return; }  // (signed in here already: nothing to wait for)
        lost = true;
        lostScreen(() => finish(''));
      }, moveWaits.lost);
      const listen = async (event) => {
        if (busy || done || event.source !== opener || !origins.includes(event.origin)) return;
        const data = event.data && typeof event.data === 'object' ? event.data : {};
        if (data.type !== MOVE.pass) return;
        busy = true;
        if (lost) waitScreen();
        const pass = checkedPass(data);
        if (!pass) { tell(event.origin, { type: MOVE.failed, why: 'used' }); finish('used'); return; }
        const mine = ownSignIn();
        if (mine) {  // signed in here already: the same person takes only the settings; someone else, nothing
          const same = mine.url === pass.url && mine.email && mine.email.toLowerCase() === pass.email.toLowerCase();
          if (same) keepCarried(data.keep);
          tell(event.origin, same ? { type: MOVE.in } : { type: MOVE.failed, why: 'other' });
          finish(same ? 'here' : 'other');
          return;
        }
        const got = await swapPass(pass);
        // (no sign-in came of it: its key is only kept once it's known to be the cloud's, keyFor)
        const key = got && got.session ? pass.key : await keyFor(pass.url, pass.key);
        try {
          localStorage.setItem('vault-config', JSON.stringify({ url: pass.url, key,
            email: (got && got.email) || pass.email }));
        } catch (error) { /* private browsing */ }
        if (got === 'unreachable' || got === 'used') {
          tell(event.origin, { type: MOVE.failed, why: got });
          finish(got);
          return;
        }
        try { localStorage.setItem('vault-auth', got.session); } catch (error) { /* */ }
        keepCarried(data.keep);
        tell(event.origin, { type: MOVE.in });
        finish('in');
      };
      window.addEventListener('message', listen);
      for (const origin of origins) tell(origin, { type: MOVE.ready });
    });
  }

  /* The copy and paste way, at wefty.org's end of Move to wefty.org: go back to the old one, Copy my sign-in, come back,
     Paste my sign-in (any device and browser here; a box to paste into when the clipboard can't be read). A sign-in
     that works reloads the page signed in; `other()` when they'd rather sign in another way (the first screen). */
  function lostScreen(other) {
    cameMoving = true;
    tabMoving = true;  // (a window Move to wefty.org opened: the sign-in is for this browser, even an iPhone's Safari)
    const problem = V.h('p.error-text', { role: 'alert' });
    const { button, box } = pasteButton('Paste my sign-in', 'primary wide-btn moving-paste', problem,
      (text) => { if (!openPasted(text)) problem.textContent = PASS_WORDS.none; }, () => {}, { box: true, here: tabMoving });
    screen(V.h('img.moved-icon', { src: 'icons/wefty-192.png', alt: '', width: 72, height: 72 }),
      V.h('h1', { text: PASS_WORDS.lostTitle }),
      V.h('p.muted.moving-lost', { text: PASS_WORDS.lost }),
      V.h('ol.steps.moving-steps', {}, PASS_WORDS.lostSteps.map((text) => V.h('li', { text }))),
      button, problem, box.row,
      V.h('button.link-btn.moving-other', { type: 'button', text: PASS_WORDS.lostOther, onclick: () => other() }));
  }

  const UNREACHABLE = 'Wefty can\'t reach the cloud. Check the internet, then try again.';
  const NO_JOINING = 'That cloud doesn\'t take join codes yet. Ask for a new code.';

  // What a friend is told about their own notes (the choose-password and join screens).
  const PRIVATE = 'Your notes are only yours: nobody else using Wefty can see them. Whoever runs the cloud can see what\'s '
    + 'stored in it, so keep secrets in a locked note (it\'s scrambled with your own PIN).';

  /* Someone opened a join QR code's link: they make their own Vault in that cloud with their own name, e-mail and
     password (Vault's helper there checks the code and makes the account: vault/functions/vault-admin). The code and
     the password only ever go to that cloud's helper, never into the address, storage or the console. Resolves
     'joined' (made and signed in: the welcome steps come next, no password to choose) or 'signed-in' (they had an
     account there already and signed in with it). */
  function joinCodeScreen() {
    return new Promise((resolve) => {
      const [nameRow, nameBox] = field('Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
      const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'email' });
      const [passRow, passBox] = field('Pick a password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text', { role: 'alert' });
      const instead = V.button('Sign in instead', { kind: 'wide-btn', onClick: async () => {
        await signInScreen(emailBox.value.trim());
        resolve('signed-in');
      } });
      instead.hidden = true;
      const go = V.button('Make my Wefty', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        instead.hidden = true;
        const name = nameBox.value.replace(/\s+/g, ' ').trim();
        const email = emailBox.value.trim();
        if (!name) { problem.textContent = 'Type your name.'; nameBox.focus(); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problem.textContent = 'Type your e-mail address (like sam@example.com).'; return; }
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        try {
          // (1.22.5, SEC-02) A cloud that isn't Wefty's own runs a helper someone else wrote: it's sent a password
          // made up here, only for making the account, and the one picked goes only to the cloud's sign-in service,
          // once signed in (pickedPassword). Wefty's own cloud's helper is Wefty's: it's sent the one picked, as before.
          const other = !!join.other;
          const helperPassword = other ? madeUpPassword() : passBox.value;
          const made = await askToJoin(name, email, helperPassword);
          if (made.error) {
            problem.textContent = made.error;
            instead.hidden = !made.exists;
            return;
          }
          join = null;  // (used: the code goes out of memory too)
          // A helper since 1.21 hands back a one-time sign-in for the new account (no CAPTCHA, which a cloud open to
          // everyone may ask a password sign-in for); an older one doesn't, and the password signs in as before.
          let signed = false;
          if (made.tokenHash) {
            try {
              const { data, error } = await V.cloud.sb.auth.verifyOtp({ token_hash: made.tokenHash, type: made.type || 'magiclink' });
              signed = !error && !!(data && data.session);
              if (signed) V.data.user = await V.cloud.user();
            } catch (error) { /* the password, then */ }
          }
          if (!signed && other) {
            await pickedPassword({ email: made.email || email, helperPassword, picked: passBox.value });
          } else if (!signed) {
            try {
              await V.cloud.signIn(made.email || email, passBox.value);
            } catch (error) {
              await signInScreen(made.email || email, 'Your Wefty is made. Sign in with the e-mail and password you just picked.');
            }
          } else if (other) {
            await pickedPassword({ email: made.email || email, helperPassword, picked: passBox.value, signed: true });
          }
          resolve('joined');
        } finally {
          go.disabled = false;
        }
      } });
      againBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      const owner = join.name.split(/\s+/)[0];
      screen(V.welcome.dots('password'), V.h('h1', { text: owner ? `Join ${owner}'s Wefty` : 'Join Wefty' }),
        V.h('p.muted', { text: 'Make your own Wefty: your notes are only yours.' }),
        cloudNote(join.url),
        nameRow, emailRow, passRow, againRow, problem, go, instead,
        V.h('p.hint', { text: PRIVATE }),
        V.h('p.hint.choose-stats', { text: V.welcome.STATS_WORDS }));
      requestAnimationFrame(() => nameBox.focus());
    });
  }

  /* The join itself: the cloud's helper, with the cloud's public key only (there's no sign-in yet). { email } when
     the account was made, else { error: words to show, exists: an account with that e-mail is there already }. */
  async function askToJoin(name, email, password) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 30000);
    let response;
    let answer = {};
    try {
      response = await fetch(`${join.url}/functions/v1/vault-admin`, { method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json', apikey: join.key },
        body: JSON.stringify({ action: 'join', token: join.token, name, email, password }) });
      answer = await response.json().catch(() => ({}));
    } catch (error) {
      // Nothing this page may read came back. When the cloud itself answers, it's the helper that's missing (a
      // function that isn't there answers 404 with no CORS); else it's the internet, or a network that blocks it.
      return { error: navigator.onLine && await reachable() ? NO_JOINING : UNREACHABLE };
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const hash = answer && typeof answer.token_hash === 'string' && /^[A-Za-z0-9_.-]{10,300}$/.test(answer.token_hash)
        ? answer.token_hash : '';
      return { email: String((answer && answer.email) || email), tokenHash: hash, type: 'magiclink' };
    }
    const said = answer && typeof answer.message === 'string' && answer.error ? V.weftyWords(answer.message) : '';
    if (response.status === 404 || response.status === 401) return { error: NO_JOINING };  // none there, or one too old
    if (response.status === 540) return { error: 'That cloud is asleep right now. Ask whoever showed you the code to open Wefty (it wakes up in a few minutes), then try again.' };
    return { error: said || (response.status >= 500 ? 'That cloud had trouble just now. Try again in a minute.'
      : `That didn't work (the cloud said ${response.status}). Ask for a new code.`), exists: answer && answer.error === 'exists' };
  }

  /* (1.22.5) A password made up here for another's cloud's helper to make the account with: long and random, never
     shown, kept or sent anywhere else. */
  function madeUpPassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 28) + 'a7A!';
  }

  /* (1.22.5) A join in a cloud that isn't Wefty's own, made with madeUpPassword: signed in (with the helper's one-time
     sign-in, or the made-up password), then the password they picked goes to the cloud's sign-in service, and only
     there. Until it's saved, a page that closes asks for one at its next start (PICK_LATER, mustChoose). */
  const PICK_LATER = 'wefty-pick-password';  // localStorage: the account's id (nothing secret) until its password is picked
  async function pickedPassword({ email, helperPassword, picked, signed = false }) {
    while (!signed) {
      try {
        await V.cloud.signIn(email, helperPassword);
        signed = true;
      } catch (error) {
        await new Promise((resolve) => {
          screen(V.h('h1', { text: 'Almost done' }),
            V.h('p.muted', { text: 'Your Wefty is made, but Wefty couldn\'t sign you in to it just now. Check the internet, '
              + 'then tap Try again.' }),
            V.button('Try again', { kind: 'primary wide-btn', onClick: () => resolve() }));
        });
      }
    }
    const user = V.data.user || await V.cloud.user().catch(() => null);
    try { localStorage.setItem(PICK_LATER, String((user && user.id) || '')); } catch (error) { /* */ }
    try {
      await V.cloud.changePassword(picked, { current: helperPassword });
    } catch (error) {
      await chooseScreen({ joined: true, current: helperPassword });  // (it says what went wrong, and takes another go)
    }
    try { localStorage.removeItem(PICK_LATER); } catch (error) { /* */ }
  }
  const pickLater = (user) => { try { return !!user && !!user.id && localStorage.getItem(PICK_LATER) === user.id; } catch (error) { return false; } };

  /* Whether the join link's cloud answers at all (its sign-in service's health check). */
  async function reachable() {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 10000);
    try {
      await fetch(`${join.url}/auth/v1/health`, { headers: { apikey: join.key }, signal: control.signal });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* A friend's first sign-in (or any later one before they did it): their own password, which ends the code.
     `joined` (1.22.5): an account just made in another's cloud, whose password is still the made-up one. The password
     now (`current`, else the invite's code), when it's known, goes along with the new one (V.cloud.changePassword). */
  function chooseScreen({ name = '', code = '', joined = false, current = '' } = {}) {
    return new Promise((resolve) => {
      const [passRow, passBox] = field('Your new password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text');
      const go = V.button('Save my password', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        if (V.inviteCode(passBox.value) && (!code || V.inviteCode(passBox.value) === code)) {
          problem.textContent = 'Pick your own password, not the invite code.';
          return;
        }
        go.disabled = true;
        try {
          await V.cloud.changePassword(passBox.value, { current: current || code || V.cloud.signedInCode() });
          V.toast(joined ? 'Password saved.' : 'Password saved. Your invite code doesn\'t work any more.');
          resolve();
        } catch (error) {
          problem.textContent = /fetch|network|internet|offline/i.test(error.message || '')
            ? 'Wefty can\'t reach the cloud right now. Check the internet, then try again.' : (error.message || String(error));
        } finally {
          go.disabled = false;
        }
      } });
      againBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      screen(V.welcome.dots('password'), V.h('h1', { text: 'Choose your own password' }),
        V.h('p.muted', { text: `${name ? `Welcome, ${name}! ` : ''}${joined ? 'One last step: pick' : 'Your invite code only works once. Pick'} a password only you know: it's what you'll sign in with on your other devices.` }),
        passRow, againRow, problem, go,
        V.h('p.hint', { text: PRIVATE }),
        V.h('p.hint.choose-stats', { text: V.welcome.STATS_WORDS }),
        V.h('button.link-btn', { type: 'button', text: 'Sign out', onclick: async () => {
          await V.cloud.signOut().catch(() => {});
          location.reload();
        } }));
      hello();
      requestAnimationFrame(() => passBox.focus());
    });
  }

  /* The gate, whenever the signed-in account is still on its invite code. True once they chose a password here. */
  async function mustChoose() {
    const user = V.data.user || {};
    // (1.22.5: a join in another's cloud whose own password wasn't saved before the page closed: picked now)
    const joined = pickLater(user);
    if (!joined && !(await V.cloud.mustChange())) return false;
    await chooseScreen({ name: (invite && invite.name) || user.name || '', code: invite && invite.code, joined });
    if (joined) { try { localStorage.removeItem(PICK_LATER); } catch (error) { /* */ } }
    return true;
  }

  /* A PC whose Vault isn't set up: joining a friend's cloud with the invite link (vault/invites.py's join). A
     phone-connect link works too, with the person's own password. A join QR code's link (pasted) takes the person's
     name, e-mail and a password of their own, and the helper in that cloud makes their account (invites.py's
     join_with_code): a PC part from before join codes can't, and says so. Python signs in and keeps the session.
     `done('joined')` after a join code (no password to choose: the welcome steps are next). */
  function joinScreen(back, done) {
    const [linkRow, linkBox] = field('Invite link', { type: 'url', placeholder: 'https://...#invite=... or #join=...', autocomplete: 'off', spellcheck: 'false' });
    const [passRow, passBox] = field('Your Wefty password', { type: 'password', autocomplete: 'current-password' });
    passRow.hidden = true;
    const [nameRow, nameBox] = field('Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
    const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'email' });
    const [newRow, newBox] = field('Pick a password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
    const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
    const details = [nameRow, emailRow, newRow, againRow];
    const problem = V.h('p.error-text');
    const joinCode = () => /#join=/.test(linkBox.value) && V.pc.can('joinWithCode');
    const showDetails = () => {
      const shown = joinCode();
      for (const row of details) row.hidden = !shown;
      if (shown) passRow.hidden = true;
    };
    showDetails();
    linkBox.addEventListener('input', showDetails);
    const go = V.button('Join', { kind: 'primary wide-btn', onClick: async () => {
      problem.textContent = '';
      const link = linkBox.value.trim();
      if (!/#(invite|connect|join)=/.test(link)) {
        problem.textContent = 'Paste the whole link your friend sent (it has #invite= or #join= in it). The code alone isn\'t enough: the link says which cloud to join.';
        return;
      }
      if (/#join=/.test(link)) {
        if (!V.pc.can('joinWithCode')) {
          problem.textContent = 'This Wefty is too old for join codes. Update it first (open Jarvis and click Update, or run the '
            + 'newest setup-wefty.bat), or ask for an invite link.';
          return;
        }
        showDetails();
        const name = nameBox.value.replace(/\s+/g, ' ').trim();
        const email = emailBox.value.trim();
        if (!name) { problem.textContent = 'Type your name.'; nameBox.focus(); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problem.textContent = 'Type your e-mail address (like sam@example.com).'; return; }
        if (newBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (newBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        try {
          await V.pc.call('joinWithCode', { link, name, email, password: newBox.value });
          done('joined');
        } catch (error) {
          problem.textContent = error.message || String(error);
        } finally {
          go.disabled = false;
        }
        return;
      }
      go.disabled = true;
      try {
        const answer = await V.pc.call('joinInvite', { link, password: passRow.hidden ? '' : passBox.value });
        if (answer.needsPassword) {
          passRow.hidden = false;
          problem.textContent = 'That link is for signing in: type your Wefty password too.';
          passBox.focus();
          return;
        }
        done();
      } catch (error) {
        problem.textContent = error.message || String(error);
      } finally {
        go.disabled = false;
      }
    } });
    for (const box of [linkBox, passBox, againBox]) box.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
    screen(V.h('h1', { text: 'Join with an invite' }),
      V.h('p.muted', { text: 'Paste the invite link a friend sent you (or the link of their join QR code). It gives you your own Wefty in their cloud: other people using it can\'t see your notes.' }),
      linkRow, passRow, details, problem, go,
      V.h('button.link-btn', { type: 'button', text: 'Set up my own cloud instead', onclick: back }));
    requestAnimationFrame(() => linkBox.focus());
  }

  /* ---------------------------------------------------------------- the phone's own bits */

  /* A #connect= link (the PC's QR code, an old address's move, an iPhone's "Copy the sign-in link"): the cloud to use
     and the e-mail to sign in with, never a sign-in. Taken out of the address at once. (1.22.5) It changes nothing of a
     Wefty someone is signed in to here, and signed out, a cloud that's neither the one saved here nor Wefty's own is
     asked about first, and a key that isn't the cloud's never replaces the one known (see "links that name a cloud"
     below). */
  async function takeConnectLink() {
    const match = /#connect=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    let parsed = null;
    try { parsed = readLink(match[1]); } catch (error) { /* said below */ }
    if (!parsed || typeof parsed !== 'object' || !CLOUD.test(String(parsed.u || '')) || !parsed.k) {
      console.warn('Vault: that connect link was damaged');
      return;
    }
    const link = { url: String(parsed.u), key: String(parsed.k), email: typeof parsed.e === 'string' ? parsed.e : '' };
    if (!(await mayUseCloud(link))) return;
    link.key = await keyFor(link.url, link.key);
    localStorage.setItem('vault-config', JSON.stringify(link));
    // (1.22.2: from an old address's move: Paste my sign-in leads on the sign-in screen; h: from a browser tab, so
    // an iPhone's Safari takes it without asking whether it's for the home screen icon)
    cameMoving = parsed.m === 1;
    tabMoving = cameMoving && parsed.h === 1;
  }

  /* ---------------------------------------------------------------- links that name a cloud (1.22.5)

     A link may name the cloud to use: #connect=, #invite=, #join=, or a copied sign-in (pasted links reload with it,
     openPasted). Anyone can make a Supabase project, so an https://<ref>.supabase.co address isn't Wefty's own just by
     its looks: before 1.22.5 a #connect= link, which any web page can send a browser to, switched a signed-in Wefty to
     the cloud it named, and the sign-in went there with it. Now:
     - nothing changes the cloud of a Wefty someone is signed in to here (otherCloudScreen says so, and why), nor its
       key or e-mail;
     - signed out, a cloud that's neither the one saved here nor Wefty's own (js/doors.js's official: this site's
       cloud.json, or on an old address wefty.org's) is asked about first, by its name, with Don't connect as the main
       button (cloudQuestion), and for one of those two the key known for it stays unless the cloud takes the link's
       (keyFor);
     - a kept sign-in only ever goes to the cloud that made it (js/cloud.js's madeBy). */
  const hostOf = (url) => { try { return new URL(String(url)).host; } catch (error) { return String(url || ''); } };
  // Someone is signed in to this browser's Wefty (as the invite and join links have always looked).
  const keptHere = (saved) => { try { return !!saved && !!localStorage.getItem('vault-auth'); } catch (error) { return false; } };
  /* Whether `url` is Wefty's own cloud for this page (never on the PC, which has none). */
  const officialCloud = (url) => (V.doors && V.doors.official ? V.doors.official(url).catch(() => false) : Promise.resolve(false));

  /* Whether the cloud a link names (`link.url`) may be saved here (signed out): the same one as saved, Wefty's own, or
     one the person said yes to. Signed in: never. (The review of 1.22.5: not even the cloud they're signed in to, as a
     link may bring that cloud's address with a key that isn't its own, and another e-mail. Kept, every request was
     turned down, "Invalid API key", and they were signed out, their right password failing at every start.) A link
     for another cloud says nothing was changed; one for theirs just opens Wefty. */
  async function mayUseCloud(link) {
    const saved = stored('vault-config');
    if (keptHere(saved)) {
      if (saved.url !== link.url) await otherCloudScreen(link.url);
      return false;
    }
    if (saved && saved.url === link.url) return true;
    if (await officialCloud(link.url)) return true;
    return cloudQuestion(link.url);
  }

  /* The key kept for the cloud at `url` that a link (or a copied sign-in) brings with `key`, signed out. Anyone can
     make a link for the cloud saved here, or Wefty's own, with a key that isn't that cloud's: so the key known for it
     (the one saved here, else cloud.json's) stays, unless the link's is the same or the cloud itself takes it (a new
     key its owner made). A cloud that's neither keeps the link's own (it was said yes to, cloudQuestion). */
  async function keyFor(url, key) {
    const saved = stored('vault-config');
    let known = saved && saved.url === url && saved.key ? String(saved.key) : '';
    if (!known && V.doors && V.doors.officialCloud) {
      const own = await V.doors.officialCloud().catch(() => null);
      if (own && own.url === String(url).replace(/\/+$/, '')) known = own.key;
    }
    if (!known || known === key) return key;
    return (await keyWorks(url, key)) ? key : known;
  }
  const KEY_CHECK_MS = 8000;
  /* Whether the cloud at `url` takes `key`: its sign-in service's switches, which need no sign-in, read with it. Any
     other answer, or none (offline, too slow), is a no. */
  async function keyWorks(url, key) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), KEY_CHECK_MS);
    try {
      const reply = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key }, cache: 'no-store', credentials: 'omit',
        signal: control.signal });
      return reply.ok;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* A link for another cloud while someone is signed in here: nothing is changed, and that's said. */
  function otherCloudScreen(url) {
    return new Promise((resolve) => {
      const who = (stored('vault-user') || {}).email || (stored('vault-config') || {}).email || '';
      screen(V.h('h1', { text: 'Already signed in' }),
        V.h('p.muted', { text: `That link is for another cloud:` }),
        V.h('p.doors-address.cloud-host', { text: hostOf(url) }),
        V.h('p.muted', { text: `Wefty here is signed in${who ? ` as ${who}` : ''}, so nothing was changed.` }),
        V.h('p.hint', { text: 'If that cloud really is yours, sign out of Wefty first (tap your picture, then Sign out), then '
          + 'open the link again.' }),
        V.button('Open Wefty', { kind: 'primary wide-btn cloud-open', onClick: () => resolve() }));
    });
  }

  /* A cloud that isn't Wefty's own (or, when Wefty's own can't be read, one Wefty can't vouch for), named by a link:
     asked first, by its name. True to go on with it. */
  async function cloudQuestion(url) {
    const own = V.doors && V.doors.officialCloud ? await V.doors.officialCloud().catch(() => null) : null;
    return new Promise((resolve) => {
      const no = V.button('Don\'t connect', { kind: 'primary wide-btn cloud-no', onClick: () => resolve(false) });
      screen(V.h('h1', { text: 'Another cloud?' }),
        V.h('p.muted', { text: own ? 'This link sets Wefty up with a cloud that isn\'t Wefty\'s own:'
          : 'This link sets Wefty up with this cloud, and Wefty can\'t check whose it is:' }),
        V.h('p.doors-address.cloud-host', { text: hostOf(url) }),
        V.h('p.doors-note', { role: 'note', text: 'Whoever runs that cloud can read everything you save in it. Only '
          + 'connect if it\'s your own, or someone you trust set it up for you.' }),
        no,
        V.button('Connect anyway', { kind: 'wide-btn cloud-yes', onClick: () => resolve(true) }));
      requestAnimationFrame(() => no.focus());
    });
  }

  /* (SEC-02) A screen that takes a password names a cloud that isn't Wefty's own, with the way back to Wefty's own.
     Filled in once Wefty's own cloud is known: never a warning when it can't be read. (Never on the PC: its cloud is
     the one set up on it.) */
  function cloudNote(url) {
    const slot = V.h('div.cloud-other-slot');
    if (V.desktop || !url || !V.doors || !V.doors.officialCloud) return slot;
    V.doors.officialCloud().then((own) => {
      if (!own || own.url === String(url).replace(/\/+$/, '') || !slot.isConnected) return;
      V.clear(slot, V.h('p.doors-note.cloud-other', { role: 'note', text: `This is a cloud that isn't Wefty's own: `
        + `${hostOf(url)}. Whoever runs it can read everything you save in it.` }),
      V.h('button.link-btn.cloud-own', { type: 'button', text: 'Use Wefty\'s own cloud instead', onclick: () => {
        try { localStorage.setItem('vault-config', JSON.stringify({ url: own.url, key: own.key })); } catch (error) { /* */ }
        location.reload();
      } }));
    }).catch(() => {});
    return slot;
  }

  /* ---------------------------------------------------------------- dropping files anywhere */

  function dropAnywhere() {
    const hint = document.getElementById('drop-hint');
    let depth = 0;
    const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) || !V.data.user) return;
      depth++;
      hint.hidden = false;
      hint.querySelector('p').textContent = V.files.dropText() || (V.chat && V.chat.dropText()) || `Drop to send to ${V.otherName}`;
    });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
    window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', (event) => {
      depth = 0;
      hint.hidden = true;
      if (!hasFiles(event) || !V.data.user) return;
      event.preventDefault();
      if (V.files.takeDrop(event.dataTransfer.files)) return;  // onto Vault Drive in Share > Files
      if (V.chat && V.chat.takeDrop(event.dataTransfer.files)) return;  // into the message in the Chat tab
      V.go('send');
      V.send.files(event.dataTransfer.files);
    });
  }

  /* ---------------------------------------------------------------- off we go */

  async function main() {
    buildShell();
    const { firstSync } = await V.cloud.start();
    const kept = V.update.resume();  // where the owner was before Vault reloaded into an update
    const asked = location.hash;  // the home screen icon's shortcuts: "New note", "Send to PC" and "Send clipboard"
    // Every device opens on Today, unless an update (or a device change) kept a place, or a shortcut asks for one.
    // (A kept place from 1.15 is one of its six tabs, all still screens here.)
    let first = 'today';
    const route = routeHere();  // (1.22: the screen this page's address names)
    if (route) first = route.view;
    if (kept && typeof kept.tab === 'string' && Object.prototype.hasOwnProperty.call(VIEWS, kept.tab)) first = kept.tab;
    if (asked === '#send') first = 'send';
    if (asked === '#clip') first = 'clips';
    if (asked === '#chat' || asked === '#claude') first = 'claude';  // the Chat tab (#claude: its id, kept working)
    if (asked === '#new' || /^#note=/.test(asked)) first = 'notes';  // (a note opened by a link or a reminder: js/reminders.js)
    // Today's and the Chat tab's scripts (and the others after this one) may still be loading: the first screen
    // waits for them.
    if (document.readyState === 'loading') await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
    if (askedFirst) first = askedFirst;  // (a tab tapped, or a note's link opened, while this device's notes loaded)
    current = '';  // (so the first screen is opened like any other: Settings gets its step in history)
    shown = true;
    const page = kept && typeof kept.page === 'string' ? kept.page : route && route.page ? route.page : '';
    stepping++;  // (the first screen makes no step in history: it's where the page was opened)
    holding = !route;  // (opened at the app's own address: it stays the address of whatever opens first)
    try { V.go(first, first === 'settings' && page ? { page } : {}); } finally { stepping--; holding = false; }
    if (route && route.help && V.help && V.help.open) setTimeout(() => V.help.open(), 0);  // (/help/: Help, over Today)
    // The note that was open goes back too, over whatever screen it was on (a phone opens notes over Today, Share and
    // Chat; a wide screen shows Notes for it), unless a shortcut or a tab tapped meanwhile asked for something else.
    if (kept && kept.note && first !== 'settings' && (first === kept.tab || first === 'notes')
      && !/^#(?:new|send|clip|chat|claude|note=)/.test(asked) && V.data.notes.has(kept.note)) V.notes.open(kept.note);
    if (asked === '#new') V.notes.chooseTemplate({ fresh: true });
    if (['#new', '#send', '#clip', '#chat', '#claude'].includes(asked)) history.replaceState(null, '', location.pathname + location.search);
    // The icon's "Send clipboard" with Vault already open (the usual way on a phone): Chrome only brings it to the
    // front with #clip in the address, which doesn't start the page again. The same, once Vault is in sight.
    const clipAsked = () => {
      if (V.desktop || location.hash !== '#clip' || V.away()) return;
      history.replaceState(null, '', location.pathname + location.search);
      V.go('clips');
      V.clips.sendNow();
    };
    window.addEventListener('hashchange', clipAsked);
    V.on('back', clipAsked);
    dropAnywhere();
    // Safari may clear a site's storage after a week unused (not an installed icon's): asked to keep it.
    if (V.deviceKind.ios && !V.install.installed() && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    firstSync.then(async () => {
      if (V.deviceLog) V.deviceLog.start();  // this device's line in the owner's Stats (js/access.js), now and then
      if (V.cloud.status === 'synced' || V.cloud.status === 'held') {
        // (the classes picked in the welcome, js/welcome.js, are a new account's starter folders; then its test)
        await V.notes.ensureStarterFolders(V.welcome.starterFolders());
        await V.welcome.applyPlan().catch((error) => console.error('Wefty: the welcome\'s classes and test', error));
      }
      V.send.checkIncoming();
      V.send.runQueue();
      if (!V.desktop) V.send.takeShared();
      if (asked === '#clip' && !V.desktop) V.clips.sendNow();
      if (V.push) V.push.start();  // (1.19: this device's notifications kept up, the study nudge's numbers kept)
    });
    V.on('badge', badge);
    V.on('signed-out', async () => {
      const email = (V.data.user || {}).email || (V.config || {}).email || '';
      await signInScreen(email);
      location.reload();
    });
    if (V.desktop) {
      V.on('pc:show', ({ tab }) => { if (tab) V.go(tab); });
      V.on('pc:quick-note', async ({ text }) => {
        const words = String(text || '').trim();
        if (!words) return;
        const home = V.notes.inbox();
        await V.cloud.save('notes', V.notes.blankNote({ folder_id: home ? home.id : null, body: words,
          title: words.split('\n')[0].slice(0, 60) }));
        V.toast('Quick note saved to Inbox');
      });
      V.pc.call('appReady').catch(() => {});  // quick notes typed before now come through at this point
    } else {
      navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.vault === 'shared') V.send.takeShared();
      });
    }
    V.update.started(kept);
    if (V.news) V.news.start();  // updates for everyone (js/news.js): asked now, shown at a calm moment
  }

  /* The first screen's Paste my sign-in (js/doors.js's front): where a move pass or a sign-in link can be pasted, as
     on the connect screen, with its own words. On an iPhone's or iPad's home screen icon it's the main way in (the
     icon starts with nothing of Safari's: the welcome's last step sends people there with a link to paste). */
  function frontPaste() {
    if (!passHere()) return null;
    const icon = iconHere();
    const problem = V.h('p.error-text', { role: 'alert' });
    const { button, box } = pasteButton('Paste my sign-in', icon ? 'primary wide-btn' : 'quiet doors-paste', problem,
      (text) => { if (!openPasted(text)) problem.textContent = PASS_WORDS.none; }, () => {}, { box: true });
    const hint = icon ? [V.h('p.muted', { text: PASS_WORDS.firstScreen }), V.h('p.muted.pass-mover', { text: PASS_WORDS.mover })]
      : V.h('p.muted.pass-mover', { text: PASS_WORDS.mover });
    /* (1.22.2) The first screen while the cloud takes no new accounts (js/doors.js): one of the main ways in, beside
       Sign in, so it's a full button that says where the sign-in comes from. */
    const closed = () => {
      if (icon) return;
      button.className = button.className.replace(/\bquiet\b/, 'wide-btn');
      const label = button.querySelector(':scope > span:not(.icon)');
      if (label) label.textContent = PASS_WORDS.pasteOld;
    };
    return { button, problem, hint, icon, box: box.row, closed, words: PASS_WORDS };
  }

  async function boot() {
    let joined = false;  // made a new account with a join code just now: no password to choose, the welcome steps next
    let passed = '';  // what became of a move pass pasted just before this reload: 'in', 'used' or 'expired'
    let door = null;  // (1.21) an e-mail's link or Google coming back: { note } when it didn't work, { toast } when it did
    let moving = 'stay';  // (an old address: js/moved.js's answer; 'ask' when wefty.org answered)
    let askedAtStart = false;  // (the move screen was shown before the app, and Keep using pressed)
    try {
      // Every script first (they're after this one in index.html): a screen before them would be drawn without what
      // they add, like js/pair.js's "Use a code from another device" on the first and sign-in screens.
      if (document.readyState === 'loading') await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
      if (V.desktop) {
        await V.pc.ready;
        let config = await V.pc.call('config');
        V.theme.system(config.scheme);  // Windows' own light or dark, for Settings > Appearance > System
        V.pc.knows(config);
        if (V.theme.tellPc) V.theme.tellPc();  // (Pure black too, now that its call is known)
        V.pcWindow(config.shown);
        if (await V.update.atBoot(config)) return;
        if (!config.url) {
          joined = (await setupScreen()) === 'joined';
          config = await V.pc.call('config');
        }
        V.config = config;
        V.prefs = config.prefs || {};
        V.cloud.client(config);
        if (!config.signedIn) {
          await signInScreen(config.email || '');
          config = await V.pc.call('config');
        }
        V.data.user = { id: config.userId, email: config.email, invited: !!config.invited, name: config.name || '',
          ...(config.who ? { who: config.who } : {}) };
      } else {
        // An old web address (js/moved.js): a tab with nothing to carry goes to wefty.org; one signed in, and an old
        // installed app, get the move screen first. At wefty.org, a window an old address opened takes its sign-in.
        moving = V.moved ? await V.moved.ready : 'stay';
        if (moving === 'moving') return;
        // ("Keep using this one for now" pressed over the running app, just before this reload: straight in.)
        let keptHere = false;
        try { keptHere = !!sessionStorage.getItem(KEPT_HERE); sessionStorage.removeItem(KEPT_HERE); } catch (error) { /* */ }
        if (moving === 'ask' && !keptHere) { await movedScreen(); askedAtStart = true; }
        // Wefty 1.21: an e-mail's link, or Google coming back, before any other part of the address is read (it's
        // taken out of the address at once).
        if (V.doors) door = await V.doors.arrival().catch((error) => { console.error(error); return null; });
        const arrived = await takeHandOver();
        await takeConnectLink();
        if (await V.update.atBoot()) return;
        takeInviteLink();
        takeJoinLink();
        if ((invite && invite.busy) || (join && join.busy)) await busyScreen();
        else if ((invite || join) && V.deviceKind.inApp) await inAppScreen();
        await takeLinkCloud();
        let saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
        // The open door (1.21): nothing saved here, and the site names its own cloud (cloud.json). Without one, the
        // connect screen as before.
        const site = !saved && V.doors ? await V.doors.defaultCloud() : null;
        if (site) {
          saved = await V.doors.front({ cloud: site, note: (door && door.note) || '', paste: frontPaste(),
            signIn: (back) => signInScreen('', '', false, back), invite: (back) => connectScreen(back) });
        }
        if (!saved) return connectScreen();
        passed = passOutcome();
        if (passed) clearAtNextTap();  // (the pass on the clipboard: see emptyClipboard)
        if (['used', 'unreachable'].includes(arrived)) passed = arrived === 'used' ? 'used' : 'retry';
        else if (['in', 'here'].includes(arrived)) passed = 'arrived';
        // New links and codes (Connect your phone, invites, join codes, calendar links) name this page's own address,
        // or the new one when js/moved.js found it up ('ask': the old installed app). Never the new one before it
        // answers: a link to a site that isn't there yet would be a dead end, while the old address always opens and
        // sends people on once the new one is up.
        V.config = { ...saved, phoneUrl: moving === 'ask' ? V.moved.address(APP) : APP };
        V.cloud.client(saved);
        let user = await V.cloud.user();
        if (!user && join) {  // a join code: their own name, e-mail and password make their account
          joined = (await joinCodeScreen()) === 'joined';
          user = await V.cloud.user();
        }
        let note = '';
        if (!user && invite) {  // signed in by the invite's own code
          try {
            await V.cloud.signIn(invite.email, invite.code);
            user = await V.cloud.user();
          } catch (error) {
            note = error.kind === 'captcha' ? error.message : /fetch|network|load failed|reach the cloud/i.test(error.message || '')
              ? 'Wefty couldn\'t reach the cloud. Check the internet, then open the invite link again.'
              : 'That invite has already been used (or a newer one was made). If you chose your own password, sign in with it; otherwise ask for a new invite.';
          }
        }
        if (!user) {
          // (A move pass the cloud turned down, or that ran out: said here, with its e-mail filled in.)
          await signInScreen((invite && invite.email) || saved.email || '',
            note || (door && door.note) || (['used', 'expired'].includes(passed) ? PASS_WORDS[passed]
              : passed === 'retry' ? 'Wefty couldn\'t reach the cloud to move your sign-in. Go back to the old Wefty and tap '
                + 'Try again, or sign in here with your e-mail and password.' : ''), !note && passed === 'expired');
          user = await V.cloud.user();
        }
        V.data.user = user;
      }
      // (1.21) An account that came by Google agrees to the Terms once (never an e-mail one, an invited friend's or
      // one made with a join code); one made just now (its e-mail confirmed, or that agreement) is new.
      const terms = !V.desktop && V.doors ? await V.doors.needsTerms() : null;
      if (terms) await V.doors.termsGate(terms);
      const fresh = !V.desktop && !!V.doors && !!V.data.user && V.doors.isNew(V.data.user.id);
      // A friend still on their one-time invite code chooses their own password first, then the welcome steps
      // (js/welcome.js: their free AI key, Vault on the home screen), picked up where they were if Vault was closed.
      // One who joined with a join code picked theirs already, and someone who signed up just now: straight to the steps.
      if ((await mustChoose()) || ((joined || fresh) && V.data.user && V.data.user.id)) V.welcome.remember(V.data.user.id);
      if (fresh) V.doors.welcomed();
      let welcomed = false;  // (the welcome steps finished just now: the tour, js/tour.js, starts by itself after them)
      if (V.welcome.pending(V.data.user && V.data.user.id)) {
        hello();  // (a gate screen like the others: this version started, whether or not the steps get finished now)
        await V.welcome.run({ screen, user: V.data.user, name: (invite && invite.name) || V.data.user.name || '' });
        welcomed = true;
      }
      await main();
      hello();
      if (V.tour) V.tour.begin({ welcomed });  // (someone new: the tour; anyone else: offered once, at a calm moment)
      if (passed === 'in' && V.data.user) V.toast(PASS_WORDS.in, { ms: 8000 });  // (in by the old icon's sign-in)
      if (passed === 'safari' && V.data.user) V.toast(PASS_WORDS.inSafari, { ms: 6000 });  // (an iPhone's Safari, 1.22.2)
      if (!V.desktop) startMovePop(moving, askedAtStart);  // (1.22.2: an old address, signed in: the move popup, once a session)
      if (passed === 'arrived' && V.data.user) V.toast(PASS_WORDS.arrived, { ms: 8000 });  // (moved by Move to wefty.org)
      if (door && door.toast && V.data.user) V.toast(door.toast, { ms: 9000 });  // (an e-mail's link, 1.21)
    } catch (error) {
      console.error(error);
      // On the PC, a downloaded version that breaks after it started can be left from here too.
      const builtIn = V.desktop && V.update.state().downloaded
        ? V.button('Use the built-in copy', { onClick: () => V.update.useBuiltIn().catch(V.problem) }) : null;
      screen(V.h('h1', { text: 'Something went wrong' }), V.h('p.error-text', { text: error.message || String(error) }),
        V.button('Try again', { kind: 'primary', onClick: () => location.reload() }), builtIn);
    }
  }

  boot();
})();
