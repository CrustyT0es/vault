/* Wefty: the tour (1.19.6). The owner: "a walkthrough on how to use everything that every new user has to do... have it
   work for anyone on the app rn too. Also mention the toggles in the settings."

   A spotlight over the real app: each step dims the screen, lights up the real thing (opening the tab or the Settings
   page it's on), and a small card says what it's for in a sentence or two, "Step N of M", Back / Next and Skip tour.
   Esc skips, the arrow keys go back and on, Tab stays in the card, a screen reader hears each step (aria-live), and the
   keyboard goes back where it was at the end. It only shows: nothing is tapped, changed or saved by it, except the
   one word of whether this person has had it (below). A step whose thing isn't here (switched off, not on this
   device, nothing of it yet) is left out. When it ends (or is skipped) the screen it started on comes back.

   Who sees it (`begin`, from js/start.js once the app is up):
   - someone new, right after the welcome (js/welcome.js) finishes: it starts by itself on Today, at a calm moment;
   - everyone else, once: "New: a 2-minute tour of Wefty · Take the tour / Not now", a calm card on Today only (on a
     phone it sits low, where Notes' + button and Chat's message box are), never over their work (not while the
     note-taker records, a note is typed in, a sheet, menu or announcement is open, or a toast shows); unanswered, or
     Today left, it goes by itself (after a minute), still in the menu.
   While it runs (and while it puts the screen back) Settings opened and left by it leaves history and where Settings
   was opened from alone (js/start.js, js/settingsui.js ask `holds`): Back afterwards goes where it went before.
   Whether it was offered, taken or put away is kept for the person in settings.extra.tour (through
   V.cloud.changeExtra, so another device never offers it again) and in this device's localStorage 'wefty-tour' (per
   person: { s, sent }; a write that didn't reach the cloud is sent again next time). Always there to take again: "Take
   the tour" in your picture's menu (js/profile.js) and in Settings > About & feedback (and Settings' search). */
'use strict';

V.tour = (() => {
  const LOCAL = 'wefty-tour';
  const LOOK_EVERY = 1500;           // ms between looks for a calm moment
  const LOOK_FOR = 10 * 60 * 1000;   // ...for this long after Wefty opens; else it's offered next time
  const FIND_FOR = 1200;             // ms a step waits for its thing to be drawn, then it's left out
  const RANK = { offered: 1, started: 2, dismissed: 3, skipped: 3, done: 4 };
  let memory = {};                   // what's kept, when storage can't be used
  let run = null;                    // the tour showing
  let puttingBack = false;           // the screen it started on being put back
  let offer = null;                  // the offer card showing
  let offerTimer = 0;
  const OFFER_SHOWS = 60000;         // ms the offer stays when it isn't answered
  let looking = null;                // the look for a calm moment going on
  let chain = Promise.resolve();

  const me = () => ((V.data && V.data.user) || {}).id || '';

  /* -- what's kept */

  function readLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL) || '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
    } catch (error) { /* (memory, below) */ }
    return { ...memory };
  }
  function writeLocal(all) {
    memory = { ...all };
    try { localStorage.setItem(LOCAL, JSON.stringify(all)); } catch (error) { /* lasts until the page closes */ }
  }
  // This device's word for the person ('*': this device has had it, whoever signs in).
  function localState(user) {
    const all = readLocal();
    if (all['*']) return 'done';
    const mine = all[user];
    return mine && typeof mine.s === 'string' ? mine.s : '';
  }
  // The account's word, from the settings row (every device of theirs).
  function accountState() {
    const tour = ((V.data && V.data.settings && V.data.settings.extra) || {}).tour;
    return tour && typeof tour.state === 'string' ? tour.state : '';
  }

  /* `state`: 'offered', 'started', 'dismissed', 'skipped' or 'done'; never back to a lesser one. */
  function remember(state) {
    const user = me();
    if (!user || !RANK[state]) return;
    const all = readLocal();
    const was = all[user] && all[user].s;
    if (was && RANK[was] > RANK[state]) return;
    all[user] = { s: state, sent: false };
    writeLocal(all);
    send(user);
  }
  function send(user) {
    chain = chain.catch(() => {}).then(async () => {
      const here = readLocal()[user];
      if (!here || here.sent || me() !== user || !V.cloud || !V.cloud.changeExtra) return;
      try {
        await V.cloud.changeExtra((extra) => {
          const was = (extra && extra.tour) || {};
          if ((RANK[was.state] || 0) > (RANK[here.s] || 0)) return extra;
          return { ...extra, tour: { state: here.s, at: new Date().toISOString() } };
        });
        const now = readLocal();
        if (now[user] && now[user].s === here.s) { now[user] = { ...now[user], sent: true }; writeLocal(now); }
      } catch (error) { /* offline or slow: sent again next time Wefty opens */ }
    });
    return chain;
  }

  /* -- a calm moment (as js/coach.js and js/news.js wait for one) */

  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  function calm() {
    const app = document.getElementById('app');
    if (!app || !app.classList.contains('ready') || app.classList.contains('gate')) return false;
    if (V.away && V.away()) return false;
    if (V.welcome && V.welcome.pending && V.welcome.pending(me())) return false;
    // (a sheet, a menu, an announcement, the "Two things moved" tip, the note-taker's screen; its bar is fine)
    if (document.querySelector('#layers > :not(.nt-strip):not(.tour-offer)')) return false;
    if (V.editor && V.editor.covering && V.editor.covering()) return false;
    if (V.notetaker && V.notetaker.listeningTo && V.notetaker.listeningTo()) return false;  // recording: never
    if (document.querySelector('#toasts > .toast:not(.leaving), #toasts > .notice')) return false;
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(String(el.type))))) return false;
    return true;
  }

  /* -- who sees it */

  /* Wefty is up (js/start.js): `welcomed` = the welcome steps just finished on this device. */
  async function begin({ welcomed = false } = {}) {
    try {
      const user = me();
      if (!user || V.tour.off) return;
      if (localState(user)) { send(user); return; }  // (had it here: told to the account, if it wasn't yet)
      const read = V.cloud && V.cloud.settingsReady ? await V.cloud.settingsReady(welcomed ? 8000 : 20000).catch(() => false) : false;
      if (me() !== user) return;
      if (!read && !welcomed) return;  // can't tell whether another device had it: asked again next time
      const known = accountState();
      if (known) { remember(known); return; }
      wait(welcomed ? 'start' : 'offer');
    } catch (error) {
      console.error('Wefty: the tour', error);  // (never anything else's trouble)
    }
  }

  function wait(how) {
    if (looking) clearTimeout(looking.timer);
    looking = { how, left: Math.ceil(LOOK_FOR / LOOK_EVERY), user: me(), timer: 0 };
    const look = () => {
      const now = looking;
      if (!now) return;
      try {
        if (me() !== now.user || run || offer || localState(now.user) || accountState()) { looking = null; return; }
        // Someone new on Today: off it goes. Gone on from Today already: only offered, once back on Today (the offer
        // never sits over another screen's controls at the bottom).
        const today = V.tab && V.tab() === 'today';
        if (now.how === 'start' && !today) now.how = 'offer';
        if (today && calm()) {
          looking = null;
          if (now.how === 'start') start({ why: 'new' });
          else showOffer();
          return;
        }
      } catch (error) {
        console.error('Wefty: the tour', error);
        looking = null;
        return;
      }
      if (--now.left > 0) now.timer = setTimeout(look, LOOK_EVERY);
      else looking = null;
    };
    looking.timer = setTimeout(look, how === 'start' ? 900 : 2500);
  }

  function showOffer() {
    hideOffer();
    const close = (state) => { hideOffer(); remember(state); };
    const el = V.h('div.tour-offer', { role: 'region', 'aria-label': 'Wefty tour' },
      V.h('span.tour-offer-ic', { 'aria-hidden': 'true' }, V.icon('spark')),
      V.h('p', {}, V.h('strong', { text: 'New: ' }), 'a 2-minute tour of Wefty'),
      V.h('div.tour-offer-buttons', {},
        V.button('Not now', { onClick: () => {
          close('dismissed');
          V.toast('Any time: tap your picture, then Take the tour.', { ms: 5000 });
        } }),
        V.button('Take the tour', { kind: 'primary', onClick: () => { close('started'); start({ why: 'offer' }); } })));
    document.getElementById('layers').append(el);
    offer = el;
    remember('offered');  // (offered once: never again here or on another device)
    // Not answered: it goes quietly after a while (an announcement or the tip waits while it shows), still in the menu.
    offerTimer = setTimeout(hideOffer, OFFER_SHOWS);
  }
  function hideOffer() {
    clearTimeout(offerTimer);
    if (!offer) return;
    offer.remove();
    offer = null;
  }

  /* -- the steps */

  const q = (sel) => [...document.querySelectorAll(sel)].filter(shown);
  const first = (...sels) => { for (const sel of sels) { const found = q(sel); if (found.length) return [found[0]]; } return []; };
  const tile = (key) => q(`.view[data-tab=today] .today-tile[data-key="q:${key}"]`)[0] || null;
  const row = (key) => q(`.view[data-tab=settings] .set-page [data-setting="${key}"]`)[0] || null;
  const canInvite = () => !!(V.settings && V.settings.categories && V.settings.categories().some((cat) => cat.id === 'friends'));
  const both = (a, b) => (a && b ? `${a} and ${b}` : a || b);
  const finger = () => { try { return matchMedia('(pointer: coarse)').matches; } catch (error) { return false; } };

  const STEPS = [
    { id: 'week', view: 'today', title: 'Your week',
      text: 'Tap a day to see what\'s on it in the panel below. Tick things off, move them or change the time right there.',
      find: () => first('.view[data-tab=today] .today-week') },
    { id: 'quick', view: 'today', title: 'Quick actions',
      text: () => {
        const parts = ['New note starts a note'];
        if (tile('dictate')) parts.push('Dictate types what you say');
        if (tile('cards')) parts.push('Flash cards shows what to study today');
        return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.` : `${parts[0]}.`;
      },
      find: () => first('.view[data-tab=today] .today-sec[data-section=quick] .today-tiles') },
    { id: 'ai-tiles', view: 'today', title: 'Let AI do the work',
      text: () => [tile('notetaker') ? 'Note-taker records your class, and AI writes the notes when you stop.' : '',
        tile('snap') ? 'Snap: take a photo of a page and it becomes a note.' : ''].filter(Boolean).join(' '),
      find: () => [tile('notetaker'), tile('snap')].filter(Boolean) },
    { id: 'tests', view: 'today', title: 'Tests coming up',
      text: () => (q('.view[data-tab=today] .today-quiz').length
        ? 'Each test counts down here. Tap Test me for a quick quiz on what it covers.'
        : 'Each test counts down here, with what to study each day until it.'),
      find: () => first('.view[data-tab=today] .today-tests > :first-child') },
    { id: 'notes', view: 'notes', title: 'Notes and folders',
      text: () => {
        const how = finger() ? 'press and hold' : 'right-click';
        return V.wide() ? `Your folders are here, and search is at the top. Drag a note onto a folder to move it, and ${how} anything for more options.`
          : `Your folders, search and the ⋯ menu are up here. Drag a note onto a folder to move it, and ${how} anything for more options.`;
      },
      find: () => (V.wide() ? first('.view[data-tab=notes] nav.folders')
        : [...first('.view[data-tab=notes] .list-tools'), ...first('.view[data-tab=notes] .chips')]) },
    { id: 'note', view: 'notes', title: 'Inside a note',
      text: 'Tap a note to write in it. Its tool bar has bold, lists, checklists and Reminder; + More has Make flash cards, Repeat, Test me and more.',
      find: () => first('.view[data-tab=notes] button.card', '.view[data-tab=notes] .fab') },
    { id: 'share', view: 'share', title: 'Share',
      text: () => `Send notes, photos and files to your other devices. Clipboard lets you copy on one and paste on another${
        V.share && V.share.shows && V.share.shows('files') ? ', and Files opens your PC\'s folders' : ''}.`,
      find: () => first('.view .share-switch'), when: () => !!V.share },
    { id: 'chat', view: 'claude', title: 'Chat',
      text: 'Ask anything, or ask it to do things in Wefty: make folders, notes, reminders and flash cards. It always asks before deleting anything.',
      find: () => first('.view[data-tab=claude] .chat-composer', '.view[data-tab=claude] .chat-side-head .btn', '.tabs .tab[data-tab=claude]'),
      when: () => !!V.chat },
    { id: 'me', view: () => (V.wide() ? '' : 'today'), title: 'Your picture',
      text: () => `Tap it for ${both(canInvite() ? 'Settings, Invite people' : 'Settings', 'Feedback')}. Signing out is there too.`,
      find: () => first(V.wide() ? '.tabs .rail-me' : '.view .head-me', 'button.me') },
    { id: 'ai', view: 'settings:ai', title: 'Settings: AI',
      text: () => (V.ai && V.ai.has && V.ai.has('gemini')
        ? 'Your free Gemini key lives here: it lets AI write your notes, make flash cards and chat.'
        : 'Add a free Gemini key here (it takes a minute), and AI can write your notes, make flash cards and chat.'),
      find: () => first('.view[data-tab=settings] .set-page .ai-gemini-row'), when: () => !!V.ai },
    { id: 'ai-switches', view: 'settings:ai', title: 'AI switches',
      text: (lit) => [lit.some((el) => el.matches('.ai-listen-switch')) ? 'AI listening helps the note-taker hear a noisy class.' : '',
        lit.some((el) => el.matches('.ai-testme-switch')) ? 'AI helps with Test me makes quizzes trickier and checks typed answers.' : '',
        lit.some((el) => el.matches('.ai-claude-switch')) ? 'Use Claude too adds paid Claude, if you ever want it.' : ''].filter(Boolean).slice(0, 2).join(' '),
      find: () => ['.ai-listen-switch', '.ai-testme-switch', '.ai-claude-switch']
        .map((cls) => q(`.view[data-tab=settings] .set-page ${cls}`)[0]).filter(Boolean),
      when: () => !!V.ai },
    { id: 'notify', view: 'settings:notifications', title: 'Notifications',
      text: 'Turn them on for your reminders, a daily study nudge and a heads-up the evening before a test, even when Wefty is closed.',
      find: () => [row('notifications-here')].filter(Boolean), when: () => !V.desktop && !!V.push },
    { id: 'look', view: 'settings:appearance', title: 'Appearance',
      text: 'Light or dark, and Pure black for dark mode. Reading aids, like dyslexia-friendly text, are just below.',
      find: () => [row('theme'), row('pure-black')].filter(Boolean) },
    { id: 'extras', view: 'settings:notes', title: 'Notes & files',
      text: 'Switch on Subscriptions to see what renews and when free trials end. Download everything and your locked notes\' PIN are here too.',
      find: () => [row('subscriptions')].filter(Boolean), when: () => !!(V.subs && V.subs.settingsRow) },
    { id: 'devices', view: 'settings:devices', title: 'Devices',
      text: (lit) => [lit.includes(row('pc-files')) ? 'PC files adds your computer\'s folders to Share.' : '',
        lit.includes(row('clipboard-step')) ? 'Keep the clipboard in step to copy on one device and paste on another.' : '',
        lit.includes(row('add-a-phone-or-computer')) ? 'Add a phone or computer to use Wefty there too.' : ''].filter(Boolean).join(' '),
      find: () => [row('pc-files'), row('clipboard-step')].filter(Boolean).length
        ? [row('pc-files'), row('clipboard-step')].filter(Boolean) : [row('add-a-phone-or-computer')].filter(Boolean) },
    { id: 'again', view: 'settings:about', title: 'That\'s the tour!',
      text: 'Take it again any time: tap your picture, then Take the tour, or come back here to About & feedback.',
      find: () => [row('take-the-tour')].filter(Boolean) },
  ];

  const said = (value, ...args) => (typeof value === 'function' ? value(...args) : value);

  /* -- the tour */

  /* Starts it (`why`: 'new', 'offer', 'menu', 'settings'). Never twice at once, never over a note open full screen. */
  function start({ why = 'menu' } = {}) {
    if (run) return false;
    hideOffer();
    if (looking) { clearTimeout(looking.timer); looking = null; }
    if (V.editor && V.editor.covering && V.editor.covering()) {
      V.toast('Close the note first, then take the tour.');
      return false;
    }
    const steps = STEPS.filter((step) => { try { return !step.when || step.when(); } catch (error) { return false; } });
    if (!steps.length) return false;
    let storedPage = null;
    try { storedPage = localStorage.getItem('vault-settings-page'); } catch (error) { /* (nothing to put back) */ }
    const app = document.getElementById('app');
    run = { why, steps, at: -1, seq: 0, from: { view: V.tab(), page: V.tab() === 'settings' && V.settings.page ? V.settings.page() : '',
      storedPage, focus: document.activeElement, inert: app ? app.inert : false }, els: [] };
    build();
    remember('started');
    go(0, 1);
    return true;
  }

  function build() {
    const title = V.h('h2.tour-title', { id: 'tour-title' });
    const text = V.h('p.tour-text', { id: 'tour-text' });
    const count = V.h('p.tour-count');
    const back = V.button('Back', { onClick: () => turn(-1) });
    back.classList.add('tour-back');
    const next = V.button('Next', { kind: 'primary', onClick: () => turn(1) });
    next.classList.add('tour-next');
    const skip = V.h('button.link-btn.tour-skip', { type: 'button', text: 'Skip tour', onclick: () => end('skipped') });
    const card = V.h('div.tour-card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title',
      'aria-describedby': 'tour-text', tabindex: '-1', hidden: true }, count, title, text,
    V.h('div.tour-foot', {}, skip, V.h('span.tour-gap'), back, next));
    const live = V.h('div.sr-only.tour-live', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    const hole = V.h('div.tour-hole', { 'aria-hidden': 'true', hidden: true });  // (both shown with the first step)
    const veil = V.h('div.tour-veil', { 'aria-hidden': 'true' });  // (the app under it can't be tapped: the tour only shows)
    const safe = V.h('div.tour-safe', { 'aria-hidden': 'true' });
    const root = V.h('div.tour', { dataset: { step: '' } }, safe, veil, hole, card, live);
    document.getElementById('layers').append(root);
    const app = document.getElementById('app');
    if (app && 'inert' in app) app.inert = true;  // (Tab and a screen reader stay in the card)
    Object.assign(run, { root, card, title, text, count, back, next, skip, live, hole, safe });
    window.addEventListener('keydown', keys, true);
    window.addEventListener('resize', soon);
    document.addEventListener('scroll', soon, { capture: true, passive: true });
    // The thing drawn again (Today and Settings redraw with their data) or moved (a list filling in): followed.
    run.watch = setInterval(() => {
      if (!run || run.busy || run.at < 0) return;
      if (run.els.some((el) => !el.isConnected)) { refind(); return; }
      const r = run.els[0] && run.els[0].getBoundingClientRect();
      const was = run.placedAt;
      if (r && (!was || Math.abs(r.top - was.top) > 0.5 || Math.abs(r.left - was.left) > 0.5
        || Math.abs(r.width - was.width) > 0.5 || Math.abs(r.height - was.height) > 0.5)) place();
    }, 250);
  }

  /* Back (-1) or on (1): one press at a time (a press while the next step's thing is looked for waits for it). */
  function turn(dir) {
    if (!run || run.busy) return;
    if (dir < 0 && run.at <= 0) return;
    go(run.at + dir, dir);
  }

  /* To step `i` (`dir` 1 on, -1 back): its screen opened, its thing found (else left out, and on to the next). */
  async function go(i, dir) {
    if (!run) return;
    const seq = ++run.seq;
    run.busy = true;
    run.card.setAttribute('aria-busy', 'true');
    let at = i;
    while (run && at >= 0 && at < run.steps.length) {
      const step = run.steps[at];
      let els = [];
      try {
        open(step);
        els = await find(step, seq);
      } catch (error) {
        console.error('Wefty: the tour', error);
      }
      if (!run || run.seq !== seq) return;
      if (els.length) { show(at, els); return; }
      run.steps.splice(at, 1);  // (not here: left out, so the count says what's really to come)
      if (dir < 0) at -= 1;
    }
    if (!run || run.seq !== seq) return;
    if (at < 0 && run.steps.length) { go(0, 1); return; }
    end(dir < 0 ? 'skipped' : 'done');
  }

  function open(step) {
    const where = said(step.view);
    if (!where) return;
    if (where.startsWith('settings:')) {
      const page = where.slice(9);
      if (V.tab() !== 'settings') V.go('settings', { page });
      else if (!V.settings.page || V.settings.page() !== page) V.settings.open(page);
      return;
    }
    // (Share only shown: `peek` keeps what came in unseen, as the person only saw it dimmed behind the card)
    if (V.tab() !== where && !(where === 'share' && V.navTab && V.navTab() === 'share')) V.go(where, where === 'share' ? { peek: true } : {});
  }

  function find(step, seq) {
    return new Promise((resolve) => {
      let tries = Math.ceil(FIND_FOR / 80);  // (counted, not timed: a clock set by hand never moves on)
      const look = () => {
        if (!run || run.seq !== seq) { resolve([]); return; }
        let els = [];
        try { els = (step.find() || []).filter(shown); } catch (error) { els = []; }
        if (els.length || --tries <= 0) { resolve(els); return; }
        setTimeout(look, 80);
      };
      requestAnimationFrame(look);
    });
  }

  /* The things lit together: the first, and the next ones while all of them fit in half the screen's height and each
     is next to those before it (never a block of other rows lit between two switches far apart). */
  const NEXT_TO = 40;  // px between one thing and the next, at most, to light them together
  function together(els) {
    const lit = [];
    let top = Infinity, bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const t = Math.min(top, r.top), b = Math.max(bottom, r.bottom);
      if (lit.length && (b - t > window.innerHeight * 0.5 || Math.max(r.top - bottom, top - r.bottom) > NEXT_TO)) break;
      lit.push(el);
      top = t;
      bottom = b;
    }
    return lit;
  }

  function show(at, all) {
    const step = run.steps[at];
    run.busy = false;
    run.card.removeAttribute('aria-busy');
    const els = together(all);
    run.at = at;
    run.els = els;
    run.root.dataset.step = step.id;
    const last = at === run.steps.length - 1;
    const words = said(step.text, els);
    run.card.hidden = false;
    run.hole.hidden = false;
    run.title.textContent = step.title;
    run.text.textContent = words;
    run.count.textContent = `Step ${at + 1} of ${run.steps.length}`;
    run.back.hidden = at === 0;
    run.next.querySelector('span').textContent = last ? 'Done' : 'Next';
    run.live.textContent = `Step ${at + 1} of ${run.steps.length}. ${step.title}. ${words}`;
    const target = els[0];
    const r = target.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
      try { target.scrollIntoView({ block: r.height > window.innerHeight / 2 ? 'start' : 'center', inline: 'nearest' }); } catch (error) { /* */ }
    }
    place();
    requestAnimationFrame(place);
    const focus = run.next;
    if (document.activeElement !== focus) focus.focus({ preventScroll: true });
  }

  // The thing was drawn again (Today and Settings redraw with their data): found afresh, the same step.
  function refind() {
    const step = run && run.steps[run.at];
    if (!step) return;
    let els = [];
    try { els = (step.find() || []).filter(shown); } catch (error) { els = []; }
    if (els.length) { run.els = together(els); place(); }
  }

  let placing = 0;
  function soon() {
    if (!run || placing) return;
    placing = requestAnimationFrame(() => { placing = 0; place(); });
  }

  /* The light round the thing (several: together, while they fit), and the card where it fits without covering it:
     under it, else above, else beside it, else (a thing taller than the screen) the light cut to what's left. */
  function place() {
    if (!run || run.at < 0) return;
    const els = run.els.filter(shown);
    if (!els.length) { refind(); return; }
    run.placedAt = els[0].getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const safeBox = run.safe.getBoundingClientRect();
    const T = Math.max(0, safeBox.top) + 8;
    const B = Math.min(vh, safeBox.bottom || vh) - 8;
    const L = Math.max(0, safeBox.left) + 8;
    const R = Math.min(vw, safeBox.right || vw) - 8;
    // (page zoom, a bigger-text setting: the card's own size against what it measures, so positions are set right)
    const z = run.card.offsetWidth ? run.card.getBoundingClientRect().width / run.card.offsetWidth || 1 : 1;
    run.card.style.width = `${Math.max(200, Math.min(360, R - L)) / z}px`;  // (CSS's 100vw doesn't know the page's zoom)
    let box = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const next = box ? { top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom),
        left: Math.min(box.left, r.left), right: Math.max(box.right, r.right) } : { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      if (box && next.bottom - next.top > vh * 0.5) break;  // (the others too far off to light together)
      box = next;
    }
    const pad = 6;
    let hole = { top: Math.max(T, box.top - pad), bottom: Math.min(B, box.bottom + pad),
      left: Math.max(L - 4, box.left - pad), right: Math.min(R + 4, box.right + pad) };
    if (hole.bottom <= hole.top) hole = { ...hole, bottom: hole.top + 1 };
    const card = run.card;
    const w = card.getBoundingClientRect().width;
    const h = card.getBoundingClientRect().height;
    const gap = 12;
    const middle = (hole.left + hole.right) / 2;
    let x = Math.max(L, Math.min(R - w, middle - w / 2));
    let y;
    if (B - (hole.bottom + gap) >= h) y = hole.bottom + gap;
    else if ((hole.top - gap) - T >= h) y = hole.top - gap - h;
    else if (R - (hole.right + gap) >= w) { x = hole.right + gap; y = Math.max(T, Math.min(B - h, hole.top)); } else if ((hole.left - gap) - L >= w) {
      x = hole.left - gap - w; y = Math.max(T, Math.min(B - h, hole.top));
    } else if (hole.bottom - hole.top + h + gap <= B - T && run.nudged !== run.at && nudge(els[0], z,
      // Small enough, in the wrong place (a big card on a small screen): its list scrolled so it's above or below the card.
      Math.abs(hole.top - (T + h + gap)) <= Math.abs(hole.bottom - (B - h - gap)) ? hole.top - (T + h + gap) : hole.bottom - (B - h - gap))) {
      return;
    } else {
      // Taller than what's left: the card at the foot, the light on the part above it (or the other way round).
      const below = { top: Math.max(hole.top, T + h + gap), bottom: hole.bottom };
      const above = { top: hole.top, bottom: Math.min(hole.bottom, B - h - gap) };
      if (above.bottom - above.top >= below.bottom - below.top) { y = B - h; hole = { ...hole, ...above }; } else {
        y = T;
        hole = { ...hole, ...below };
      }
    }
    Object.assign(run.hole.style, { top: `${hole.top / z}px`, left: `${hole.left / z}px`,
      width: `${(hole.right - hole.left) / z}px`, height: `${(hole.bottom - hole.top) / z}px` });
    Object.assign(card.style, { left: `${x / z}px`, top: `${y / z}px` });
  }

  /* Scrolls the box `el` is in by `by` px (as measured), once a step; true when it moved, and the light is placed again. */
  function nudge(el, z, by) {
    run.nudged = run.at;
    let box = el.parentElement;
    while (box && box !== document.body) {
      const style = getComputedStyle(box);
      if (/(auto|scroll)/.test(style.overflowY) && box.scrollHeight > box.clientHeight) break;
      box = box.parentElement;
    }
    const scroller = box && box !== document.body ? box : document.scrollingElement;
    if (!scroller) return false;
    const was = scroller.scrollTop;
    scroller.scrollTop = was + by / z;
    if (Math.abs(scroller.scrollTop - was) < 1) return false;
    requestAnimationFrame(place);
    return true;
  }

  function keys(event) {
    if (!run) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end('skipped'); return; }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      turn(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.key === 'Tab') {
      const list = [run.skip, run.back, run.next].filter((el) => !el.hidden);
      const at = list.indexOf(document.activeElement);
      event.preventDefault();
      event.stopPropagation();
      const next = at < 0 ? list[0] : list[(at + (event.shiftKey ? -1 : 1) + list.length) % list.length];
      next.focus();
      return;
    }
    if (!run.card.contains(event.target)) { event.stopPropagation(); }  // (nothing under it acts on a key meanwhile)
  }

  /* Ended (`how`: 'done' or 'skipped'): taken away, the screen it started on back, the keyboard back where it was. */
  function end(how) {
    if (!run) return;
    const was = run;
    run = null;
    clearInterval(was.watch);
    window.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', soon);
    document.removeEventListener('scroll', soon, { capture: true });
    was.root.remove();
    const app = document.getElementById('app');
    if (app && 'inert' in app) app.inert = was.from.inert;
    puttingBack = true;
    try { putBack(was.from); } catch (error) { console.error('Wefty: the tour', error); } finally { puttingBack = false; }
    remember(how === 'done' ? 'done' : 'skipped');
    if (how !== 'done' && was.why === 'new') V.toast('Take the tour any time: tap your picture.', { ms: 5000 });
    const focus = was.from.focus;
    if (focus && focus.isConnected && shown(focus) && focus !== document.body) focus.focus({ preventScroll: true });
  }

  function putBack(from) {
    const view = from.view || 'today';
    if (view === 'settings') {
      if (from.page) {
        if (V.tab() !== 'settings') V.go('settings', { page: from.page });
        else if (V.settings.page() !== from.page) V.settings.open(from.page);
      } else if (V.tab() !== 'settings') {
        V.go('settings');
      } else if (!V.wide() && V.settings.page()) {
        const arrow = document.querySelector('.view[data-tab=settings] .settings-sub .app-head .head-back');
        if (arrow) arrow.click();  // (back to Settings' home, the way it was opened)
      }
    } else if (V.tab() !== view) {
      V.go(view);
    }
    try {
      if (from.storedPage === null) localStorage.removeItem('vault-settings-page');
      else localStorage.setItem('vault-settings-page', from.storedPage);
    } catch (error) { /* (a private window) */ }
  }

  /* Settings > About & feedback's card (js/settings.js). */
  function card(ui) {
    return ui.card('Tour', ui.line('Take the tour', 'Two minutes: where everything is in Wefty, and what the switches do.',
      V.button('Start', { icon: 'play', onClick: () => start({ why: 'settings' }) }), 'take-the-tour'));
  }

  const stop = () => {
    hideOffer();
    if (looking) { clearTimeout(looking.timer); looking = null; }
    if (run) end('skipped');
  };
  V.on('signing-out', stop);
  V.on('tab', (tab) => { if (tab !== 'today') hideOffer(); });
  V.on('signed-out', stop);

  return { begin, start, end: () => end('skipped'), card, showing: () => !!run, offering: () => !!offer,
    step: () => (run && run.at >= 0 ? run.steps[run.at].id : ''), steps: () => (run ? run.steps.map((s) => s.id) : []),
    lit: () => (run ? [...run.els] : []), busy: () => !!(run && run.busy), holds: () => !!run || puttingBack,
    STEPS, KEY: LOCAL };
})();
