/* Wefty 1.22: Wefty on the home screen (V.homeScreen). The guide: "a stranger goes from wefty.org to a saved first
   note, on the home screen, in under two minutes without help".

   One card, one purpose, made for the device it's on:
   - Chrome or Edge with the browser's own install offer (Android, a Chromebook, a computer: V.install): one big Add
     Wefty, which asks the browser's own question;
   - the same browsers without the offer, and the others (Samsung Internet, Firefox, Safari on a Mac): the steps for
     that browser's menu;
   - an iPhone or iPad in Safari: a short card that lights Share, then Add to Home Screen, then Add in turn (still
     under reduced motion), "keep Open as Web App on", and an arrow where Safari's Share button is (bottom middle on an
     iPhone, top right on an iPad); other iPhone browsers: their own words;
   - inside an app's own browser (Instagram, TikTok, Snapchat: V.deviceKind.inApp, which can't install anything):
     open Wefty in Chrome or Safari first, with Copy the link;
   - a Chromebook or a computer: beside its own install, a QR code, "Open Wefty on your phone" (many people start on a
     computer, and a phone is where Wefty does most);
   - the PC app: only the QR code; already installed: says so.
   One line says what they get: it opens like an app, works offline, and (on an iPhone, where Wefty's notifications
   only work from the Home Screen icon) sends notifications.

   By itself: once, after this device's first saved note with words in it (never a note Wefty made itself, extra.starter),
   at a calm moment: nothing over the app (a sheet, a menu, the tour or its offer, an announcement, the tip, the
   note-taker, the study screen), no toast, nothing being typed, no note open full screen, never during the welcome or
   a gate screen, and only once the tour has had its moment. Never when Wefty is installed here, never in the PC app,
   never on the day the welcome's own home screen step asked (js/welcome.js marks it), never twice a day. "Not now"
   (or closing it) brings it back after LATER_DAYS days, at most MOST times in all, then never by itself; Settings >
   Devices' Install Wefty row (js/settings.js) opens it any time, as do the first week's checklist (js/starthere.js)
   and Help. Installed (Chrome's 'appinstalled', V.install's 'done', or "I've added it"): never again by itself.
   Kept per device in localStorage 'wefty-homescreen' ({ wrote, shown, last, next, asked, done }); where storage can't
   be used, it never shows by itself (it couldn't keep a Not now). */
'use strict';

V.homeScreen = (() => {
  const KEY = 'wefty-homescreen';
  const LATER_DAYS = 3;          // "Not now": back after this many days
  const MOST = 3;                // shown by itself at most this many times
  const LOOK_EVERY = 1500;       // ms between looks for a calm moment
  const LOOK_FOR = 10 * 60 * 1000;
  const TOUR_FIRST = 11 * 60 * 1000;  // ms the tour (js/tour.js looks for 10 minutes) has to go first
  const DAY = 86400000;
  const opened = performance.now();
  let showing = null;            // { sheet, how, auto }
  let looking = null;

  /* Fixed drawings (only these strings ever go through innerHTML): Safari's Share, Add to Home Screen's plus in a
     square, the Open as Web App switch, and the arrow. */
  const DRAWN = {
    share: '<path d="M8.5 9.5H7A1.5 1.5 0 0 0 5.5 11v8A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17 9.5h-1.5"/><path d="M12 3.5v11M8.8 6.7 12 3.5l3.2 3.2"/>',
    add: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    toggle: '<rect x="2.5" y="7" width="19" height="10" rx="5"/><circle cx="16.5" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
    arrow: '<path d="M12 4v15M6 13l6 6 6-6"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  };
  function drawn(name, cls = '') {
    const span = V.icon('', cls);
    span.firstChild.innerHTML = DRAWN[name];
    return span;
  }

  /* -- what's kept on this device */

  // null: storage can't be used here (a private window, blocked site data): then nothing shows by itself.
  function read() {
    try {
      const kept = JSON.parse(localStorage.getItem(KEY) || '{}');
      return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    } catch (error) { return null; }
  }
  function write(change) {
    const was = read();
    if (!was) return false;
    try { localStorage.setItem(KEY, JSON.stringify({ ...was, ...change })); return true; } catch (error) { return false; }
  }

  /* -- which card */

  const agent = navigator.userAgent || '';
  function browser() {
    if (/SamsungBrowser\//.test(agent)) return 'samsung';
    if (/\bEdg(A|iOS)?\//.test(agent)) return 'edge';
    if (/\bFirefox\/|\bFxiOS\//.test(agent)) return 'firefox';
    if (/\bOPR\/|\bOPT\//.test(agent)) return 'opera';
    if (/\bChrome\/|\bCriOS\//.test(agent)) return 'chrome';
    if (/\bSafari\//.test(agent)) return 'safari';
    return 'other';
  }
  // A Chromebook or a computer: where a phone would be better, so the QR code is offered beside its own install.
  const computer = () => !V.desktop && ['chromebook', 'browser'].includes(V.deviceKind.kind) && !V.deviceKind.ios;
  /* 'pc', 'installed', 'in-app', 'ios' (Safari), 'ios-other', 'offer' (the browser's own install) or 'menu'. */
  function kind() {
    const k = V.deviceKind;
    if (V.desktop) return 'pc';
    if (V.install.installed()) return 'installed';
    if (k.inApp) return 'in-app';
    if (k.ios) return k.iosBrowser && k.iosBrowser !== 'safari' ? 'ios-other' : 'ios';
    return V.install.ready() ? 'offer' : 'menu';
  }

  /* The steps for this browser's own menu, where it won't offer to install (or isn't Chrome). */
  function menuSteps() {
    const k = V.deviceKind;
    const which = browser();
    if (k.chromebook) {
      return { steps: ['Click ⋮ at the top right of Chrome.', 'Choose Cast, save and share > Install page as app.'],
        note: 'If your school doesn\'t allow it, keep Wefty as a bookmark instead.' };
    }
    if (k.android || V.device === 'phone') {
      if (which === 'samsung') return { steps: ['Tap ≡ at the bottom right.', 'Tap Add page to, then Home screen.'], note: '' };
      if (which === 'edge') return { steps: ['Tap ⋯ at the bottom of Edge.', 'Tap Add to phone, then Install.'], note: '' };
      if (which === 'firefox') return { steps: ['Tap ⋮ at the top right of Firefox.', 'Tap Add to Home screen, then Add.'], note: '' };
      if (which === 'chrome') return { steps: ['Tap ⋮ at the top right of Chrome.', 'Tap Add to Home screen, then Install.'], note: '' };
      return { steps: ['Open your browser\'s menu.', 'Tap Add to Home screen (or Install).'], note: 'Not there? Open Wefty in Chrome and add it from there.' };
    }
    if (which === 'edge') return { steps: ['Click … at the top right of Edge.', 'Choose Apps > Install this site as an app.'], note: '' };
    if (which === 'firefox') {
      return { steps: ['Firefox can\'t install sites as apps: open Wefty in Chrome or Edge to install it.'],
        note: 'Or keep it as a bookmark here.' };
    }
    if (which === 'safari') return { steps: ['In Safari\'s menu bar, choose File > Add to Dock.'], note: '' };
    return { steps: ['Click ⋮ at the top right of Chrome.', 'Choose Cast, save and share > Install page as app.'],
      note: 'In Edge: the … menu > Apps > Install this site as an app.' };
  }

  // The app whose own browser this is, by what it says it is (only for the words).
  function appName() {
    if (/Instagram/.test(agent)) return 'Instagram';
    if (/FBAN|FBAV|FB_IAB/.test(agent)) return 'Facebook';
    if (/Snapchat/.test(agent)) return 'Snapchat';
    if (/TikTok|musical_ly|BytedanceWebview/.test(agent)) return 'TikTok';
    if (/\bLine\//.test(agent)) return 'LINE';
    return '';
  }

  /* What they get, in one line. */
  function gets(how) {
    if (how === 'ios' || how === 'ios-other') return 'It opens like an app, works offline, and can send you notifications (on an '
      + `${V.deviceKind.model || 'iPhone'}, only from the Home Screen).`;
    if (computer()) return 'It opens like an app, in its own window, and works offline.';
    return 'It opens like an app, full screen, and works offline.';
  }

  // The link to open Wefty elsewhere: this page's address with the cloud and the e-mail (never a password), so the
  // other browser or phone starts at Sign in with both filled in.
  function link() {
    try { if (V.connectLink && V.config && V.config.url) return V.connectLink(); } catch (error) { /* (the plain address) */ }
    return location.origin + location.pathname;
  }

  /* -- the card's parts */

  function stepsList(list, cls = '') {
    return V.h('ol.steps.hs-steps-plain' + (cls ? '.' + cls : ''), {}, list.map((step) => V.h('li', { text: step })));
  }

  // Safari on an iPhone or iPad: three steps lit in turn, Share, Add to Home Screen, Add.
  function safariSteps() {
    const ipad = V.deviceKind.ipad;
    const where = ipad ? 'At the top right, next to the address.' : 'At the bottom of the screen. Don\'t see it? Tap ••• first.';
    const step = (i, pic, title, line) => V.h('li.hs-step', { style: { '--i': String(i) } },
      V.h('span.hs-pic', { 'aria-hidden': 'true' }, pic),
      V.h('span.hs-words', {}, V.h('strong', { text: title }), V.h('span', { text: line })));
    return V.h('ol.hs-steps.hs-play', { 'aria-label': 'Three steps' },
      step(0, drawn('share'), 'Tap Share', where),
      step(1, drawn('add'), 'Tap Add to Home Screen', 'Scroll down the list if it isn\'t in sight.'),
      step(2, V.h('span.hs-addpic', {}, drawn('toggle'), V.h('span.hs-add', { text: 'Add' })),
        'Keep Open as Web App on, then tap Add', 'Then open Wefty from its new icon.'));
  }

  /* The phone's side of a computer's card: the QR code that opens Wefty there. */
  function phoneSide() {
    return V.h('div.hs-phone', {},
      V.h('h3', {}, drawn('phone'), V.h('span', { text: 'Open Wefty on your phone' })),
      V.qr ? V.qr(link(), 168, 'QR code to open Wefty on your phone') : null,
      V.h('p.hint', { text: 'Point your phone\'s camera at it, open the link, then add Wefty to its home screen there.' }));
  }

  /* -- the card */

  function build(how, finish) {
    const k = V.deviceKind;
    const parts = [];
    let title;
    let go = null;
    const notNow = V.h('button.link-btn.hs-later', { type: 'button', text: 'Not now', onclick: () => finish('later') });
    const added = () => V.button('I\'ve added it', { kind: 'primary wide-btn', onClick: () => finish('added') });

    if (how === 'pc') {
      title = 'Wefty on your phone';
      parts.push(V.h('p.hs-gets', { text: 'Your notes and flash cards, with you everywhere. It opens like an app there.' }), phoneSide());
      go = V.button('Done', { kind: 'primary wide-btn', onClick: () => finish('closed') });
    } else if (how === 'installed') {
      title = 'Wefty is installed';
      parts.push(V.h('p.hs-gets', { text: k.ios ? 'You\'re using Wefty from its Home Screen icon. Notifications work from here.'
        : 'Wefty is already on this device, as an app.' }));
      go = V.button('OK', { kind: 'primary wide-btn', onClick: () => finish('closed') });
    } else if (how === 'in-app') {
      const other = k.ios ? 'Safari' : 'Chrome';
      const app = appName();
      title = `Open Wefty in ${other} first`;
      parts.push(V.h('p.hs-gets', { text: `${app ? `${app}'s` : 'This app\'s'} own browser can't add apps to your home screen. ${other} can.` }),
        stepsList([`Tap ⋯ (or ⋮) at the top right and choose Open in ${other} (or Open in browser).`,
          `No such button? Copy the link, open ${other} and paste it into the address bar.`,
          'There, add Wefty to your home screen.']));
      go = V.button('Copy the link', { kind: 'primary wide-btn', icon: 'copy', onClick: async () => {
        await V.copy(link());
        V.toast(`Copied. Now open ${other} and paste it into the address bar.`, { ms: 6000 });
      } });
    } else if (how === 'ios') {
      title = `Add Wefty to your Home Screen`;
      parts.push(V.h('p.hs-gets', { text: gets(how) }), safariSteps());
      go = added();
    } else if (how === 'ios-other') {
      title = 'Add Wefty to your Home Screen';
      parts.push(V.h('p.hs-gets', { text: gets(how) }),
        stepsList(['Tap the Share button (a square with an arrow up). It\'s in the address bar, or in the ⋯ or ≡ menu.',
          'Tap Add to Home Screen, then Add.']),
        V.h('p.hint', { text: 'Not there? Open this page in Safari and add it from there.' }));
      go = added();
    } else {
      // Chrome, Edge and the rest (a phone, a Chromebook, a computer).
      const offer = how === 'offer';
      title = computer() ? 'Install Wefty' : 'Add Wefty to your home screen';
      const menu = offer ? null : menuSteps();
      const install = offer
        ? V.button('Add Wefty', { kind: 'primary wide-btn hs-add-btn', icon: 'download', onClick: async () => {
          const answer = await V.install.ask();
          if (answer === 'accepted') finish('installed');
          else if (answer === 'dismissed') finish('later');
          else redraw();  // (the offer went away meanwhile: the menu's steps instead)
        } })
        : null;
      const here = V.h('div.hs-here', {},
        computer() ? V.h('h3', {}, V.icon(k.chromebook ? 'laptop' : 'pc'), V.h('span', { text: k.chromebook ? 'On this Chromebook' : 'On this computer' })) : null,
        V.h('p.hs-gets', { text: gets(how) }),
        install || stepsList(menu.steps),
        menu && menu.note ? V.h('p.hint', { text: menu.note }) : null);
      // (with the browser's own install the big button is in the card; else the steps, then "I've added it")
      go = offer ? null : added();
      if (computer()) {
        // (side by side: this computer's install, its button and Not now on the left; the phone's code on the right)
        here.append(...[go, notNow].filter(Boolean));
        parts.push(V.h('div.hs-two', {}, here, phoneSide()));
        return { title, body: V.h('div.hs.hs-wide', { dataset: { how } }, parts) };
      }
      parts.push(here);
    }
    const body = V.h('div.hs', { dataset: { how } }, parts, go, how === 'installed' || how === 'pc' ? null : notNow);
    return { title, body };
  }

  /* -- showing it */

  function redraw() {
    if (!showing) return;
    const was = showing;
    was.keep = true;
    was.sheet.close();
    showing = null;
    show({ auto: was.auto, from: was.from, again: true });
  }

  /* `auto`: shown by itself (counted); else from Settings, the checklist or Help. Returns the sheet, or null. */
  function show({ auto = false, from = '', again = false } = {}) {
    if (showing) return showing.sheet;
    if (auto && !again) {
      const kept = read();
      // (counted before it shows: where that can't be kept, it never shows by itself)
      if (!kept || !write({ shown: (Number(kept.shown) || 0) + 1, last: V.today(), next: 0 })) return null;
    }
    const how = kind();
    let answered = '';
    let sheet = null;
    const finish = (what) => { answered = what; if (sheet) sheet.close(); };
    const { title, body } = build(how, finish);
    // An iPhone's icon starts with nothing of Safari's: while this shows, the address carries #connect= (the cloud and
    // the e-mail, never a password), as the welcome's step and Settings do, so the icon opens ready to sign in.
    // (Settings > Devices marks it too while it shows: then it's left as it is)
    const marked = /^#connect=/.test(location.hash);
    const unmark = !marked && (how === 'ios' || how === 'ios-other') && V.welcome && V.welcome.markConnect
      ? V.welcome.markConnect() : () => {};
    const state = { auto, from, how, keep: false, sheet: null };
    sheet = V.sheet({
      title, content: body, wide: computer() && !['in-app', 'installed'].includes(how),
      onClose: () => {
        unmark();
        if (showing === state) showing = null;
        if (state.keep) return;  // (drawn again in place)
        done(answered || 'closed', state);
      },
    });
    state.sheet = sheet;
    showing = state;
    const wrap = sheet.el.parentElement;
    if (wrap) wrap.classList.add('hs-layer', `hs-${how}`);
    sheet.el.classList.add('hs-sheet');
    // The arrow where Safari's Share button is: bottom middle on an iPhone, top right on an iPad.
    if (how === 'ios' && wrap) {
      wrap.classList.add(V.deviceKind.ipad ? 'hs-up' : 'hs-down');
      wrap.append(V.h('div.hs-arrow', { 'aria-hidden': 'true' }, drawn('arrow'), V.h('span', { text: 'Share' })));
    }
    // (a dialog: the keyboard and a screen reader start in it, on its main button)
    requestAnimationFrame(() => {
      const first = sheet.el.querySelector('.hs .btn.primary') || sheet.el.querySelector('.hs .btn, .hs-later');
      if (first && sheet.el.isConnected && !sheet.el.contains(document.activeElement)) first.focus({ preventScroll: true });
    });
    return sheet;
  }

  function done(what, state) {
    if (what === 'installed' || what === 'added') {
      write({ done: what });
      if (V.emit) V.emit('home-screen', what);  // (js/starthere.js's first week ticks its item)
      if (what === 'added') V.toast(V.deviceKind.ios ? 'Now open Wefty from its new icon, and sign in there once.' : 'Wefty is on your home screen.', { ms: 6000 });
      return;
    }
    // Not now, or closed: back after LATER_DAYS days (opened by hand: never sooner than that either).
    const kept = read();
    if (!kept) return;
    const next = Date.now() + LATER_DAYS * DAY;
    if (state.auto || !(Number(kept.next) > next)) write({ next });
  }

  /* -- by itself */

  /* Words in a note this device saved, its title or its body (not one Wefty made: the welcome note, extra.starter). */
  function wroteHere() {
    for (const note of V.data.notes.values()) {
      if (!note || !note._dirty || note.deleted || note._purge || note.locked) continue;
      if (note.extra && note.extra.starter) continue;
      if (/[\p{L}\p{N}]/u.test(`${note.title || ''} ${note.body || ''}`)) return true;
    }
    return false;
  }
  function noticeWriting() {
    if (V.desktop) return;
    const kept = read();
    if (!kept || kept.wrote || kept.done) return;
    if (!wroteHere()) return;
    write({ wrote: new Date().toISOString() });
    soon(2500);
  }

  function due(now = Date.now()) {
    if (V.desktop || V.install.installed()) return false;
    const kept = read();
    if (!kept || !kept.wrote || kept.done) return false;
    if ((Number(kept.shown) || 0) >= MOST) return false;
    if (Number(kept.next) && now < Number(kept.next)) return false;
    const today = V.today();
    if (kept.asked === today || kept.last === today) return false;  // (the welcome asked today; or shown today)
    return !!(V.data.user && V.data.user.id);
  }

  // The tour (js/tour.js) gets its moment first: until this person has had it (here or on another device), or it
  // stopped looking for one.
  function tourFirst() {
    if (performance.now() - opened > TOUR_FIRST) return false;
    const user = V.data.user && V.data.user.id;
    const account = ((V.data.settings && V.data.settings.extra) || {}).tour;
    if (account && account.state) return false;
    try {
      const kept = JSON.parse(localStorage.getItem('wefty-tour') || '{}') || {};
      if (kept['*'] || (kept[user] && kept[user].s)) return false;
    } catch (error) { return false; }
    return !!V.tour;
  }

  const NOT_TYPED = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'];
  function quiet() {
    const app = document.getElementById('app');
    if (!app || !app.classList.contains('ready') || app.classList.contains('gate')) return false;
    if (V.away && V.away()) return false;
    const user = V.data.user && V.data.user.id;
    if (!user || (V.welcome && V.welcome.pending && V.welcome.pending(user))) return false;
    // (a sheet, a menu, the tour or its offer, an announcement, the tip, the note-taker's screen, the study screen)
    if (document.querySelector('#layers > :not(.nt-strip)')) return false;
    if (document.querySelector('#toasts > .toast:not(.leaving), #toasts > .notice')) return false;
    if (V.editor && V.editor.covering && V.editor.covering()) return false;
    if (V.notetaker && V.notetaker.listeningTo && V.notetaker.listeningTo()) return false;
    if (V.tour && ((V.tour.showing && V.tour.showing()) || (V.tour.offering && V.tour.offering()))) return false;
    if (tourFirst()) return false;
    if (V.drag && V.drag.busy && V.drag.busy()) return false;
    if (V.notes && V.notes.picking && V.notes.picking()) return false;
    const el = document.activeElement;
    if (el && el !== document.body && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
      || (el.tagName === 'INPUT' && !NOT_TYPED.includes(String(el.type).toLowerCase())))) return false;
    return true;
  }
  async function calm() {
    if (!quiet()) return false;
    if (V.editor && V.editor.openId && V.editor.openId() && V.editor.settled && !(await V.editor.settled())) return false;
    return quiet();
  }

  /* Looks for a calm moment for a while (from when it's due: the first note, Wefty back in sight, another screen). */
  function soon(delay = 1200) {
    if (looking || showing || !due()) return;
    let left = Math.ceil(LOOK_FOR / LOOK_EVERY);
    const look = async () => {
      looking = null;
      if (showing || !due()) return;
      let ok = false;
      try { ok = await calm(); } catch (error) { console.error('Wefty: the home screen popup', error); return; }
      if (ok && due() && !showing) { show({ auto: true }); return; }
      if (--left > 0) looking = setTimeout(look, LOOK_EVERY);
    };
    looking = setTimeout(look, delay);
  }

  V.on('data', (table) => { if (table === 'notes') noticeWriting(); });
  V.on('note-left', () => soon());
  V.on('back', () => soon());
  V.on('tab', () => soon());
  V.on('status', (value) => { if (value === 'synced' || value === 'held') soon(); });
  // Installed (Chrome's own, from here, from its menu or the address bar): never again by itself.
  V.on('install', (what) => {
    if (what === 'done') {
      write({ done: 'installed' });
      if (showing) { showing.keep = true; showing.sheet.close(); showing = null; }
      V.emit('home-screen', 'installed');
    } else if (what === 'ready' && showing && showing.how === 'menu') redraw();  // (the offer came: the big button)
  });

  return {
    /* The card, opened by hand (Settings > Devices, the first week's checklist, Help). */
    open: ({ from = 'settings' } = {}) => show({ from }),
    showing: () => !!showing,
    kind,
    due,
    check: () => soon(0),
    /* The welcome's own home screen step showed today (js/welcome.js): not asked again by this the same day. */
    asked(result = '') {
      write({ asked: V.today() });
      if (result === 'installed' || result === 'added') write({ done: result });
    },
    done: () => { const kept = read(); return !!(kept && kept.done); },
    state: () => read(),
    KEY, LATER_DAYS, MOST,
  };
})();
