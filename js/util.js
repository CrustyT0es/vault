/* Vault: small helpers every other file uses (the V namespace, building elements, icons, dialogs, toasts, dates).
   Every script is a plain script sharing `V`, so the same files run on the phone (GitHub Pages), in the PC app
   (vault://app/ inside Qt) and in the tests, with nothing to build. User text only ever goes in as textContent. */
'use strict';

const V = (window.V = window.V || {});
V.VERSION = '1.21.0';
V.desktop = !!window.VAULT_DESKTOP;  // set by the PC app (vault/desktop.py) before any script runs
/* Sentences from the cloud's helper (vault/functions/vault-admin), which may have been put in before Vault became
   Wefty and still say "Vault ..." (its VERSION didn't change for words alone, so nothing asks the owner to update it):
   shown in the new name. Only "Vault" as a word before a space or an apostrophe, never inside an e-mail address. The
   same as vault/helper.py's in_our_words. */
V.weftyWords = (text) => String(text == null ? '' : text).replace(/(^|[^\w@.+'\\-])Vault(?=[\s'’])/g, '$1Wefty');
// Ctrl+N (new note) only reaches the page in the PC app or an installed PWA; in a browser tab Chrome keeps it for a
// new window, so the hints mention it only where it actually works.
V.appShortcuts = V.desktop || (() => { try { return window.matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; } })();

/* Which device this is: 'pc' (the PC app), 'phone' (a phone: Android, or an iPhone or iPad, with Vault installed or in
   a browser tab) or 'web' (any other browser: a school Chromebook, a laptop). Each device only takes in what was sent
   to it, so a Chromebook never marks the phone's files as received. A wrong guess (Chrome on the phone set to ask for
   desktop sites leaves "Android" out) is put right in Settings, which keeps the answer in localStorage 'vault-device'.

   An iPad asks for desktop sites by itself, so it says it's a Mac: a "Mac" with a touch screen is taken for an iPad
   (no Mac has one). Every browser on an iPhone runs Safari's engine, but some things only work in Safari itself
   (`iosBrowser`). `kind` is what each Vault records about itself for the owner's Stats (js/access.js): what the
   hardware says where it can tell (a Chromebook, a Windows PC or a Mac set to "It's my phone" stays what it is).

   `inApp`: an app's own built-in browser (Instagram, Snapchat, Facebook, TikTok, LINE, or any Android WebView), as
   when an invite is tapped in a chat there. Its storage is its own, it can't put Vault on the home screen, and Google
   won't sign anyone in there: js/start.js offers Chrome or Safari first. On an iPhone, a page without "Safari/" in
   what it says it is is one too, unless it's Vault's own home screen icon (which leaves "Safari/" out as well). */
V.DEVICES = ['pc', 'phone', 'web'];
V.deviceKind = (() => {
  const agent = navigator.userAgent || '';
  const hints = navigator.userAgentData || {};
  const chromebook = /\bCrOS\b/.test(agent) || /^chrome ?os$/i.test(hints.platform || '');
  const iphone = /\biP(hone|od)\b/.test(agent);
  const ipad = /\biPad\b/.test(agent) || (/\bMacintosh\b/.test(agent) && navigator.maxTouchPoints > 1);
  const ios = !V.desktop && (iphone || ipad);
  const android = !V.desktop && (/Android/i.test(agent) || hints.platform === 'Android');
  let standalone = false;
  try { standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { /* old */ }
  const iosBrowser = !ios ? '' : /\bCriOS\//.test(agent) ? 'chrome' : /\bEdgiOS\//.test(agent) ? 'edge'
    : /\bFxiOS\//.test(agent) ? 'firefox' : /\bOPiOS\/|\bOPT\//.test(agent) ? 'opera' : 'safari';
  const model = ios ? (ipad ? 'iPad' : 'iPhone') : '';
  const inApp = !V.desktop && (/\b(Instagram|FBAN|FBAV|FB_IAB|Snapchat|Line\/|TikTok|musical_ly|BytedanceWebview)\b/.test(agent)
    || (android && /; wv\)/.test(agent)) || (ios && !/Safari\//.test(agent) && navigator.standalone !== true && !standalone));
  const about = { ios, iphone: ios && !ipad, ipad: ios && ipad, android, iosBrowser, standalone, model, inApp };
  if (V.desktop) return { ...about, id: 'pc', chromebook: false, kind: 'pc', standalone: false };
  let chosen = '';
  try { chosen = localStorage.getItem('vault-device') || ''; } catch (error) { /* private browsing */ }
  // Installed, on a touch screen that isn't a Chromebook, Windows or a Mac: the phone, even asking for desktop sites.
  const installed = standalone && navigator.maxTouchPoints > 0 && !/Windows|Macintosh/.test(agent);
  const id = chosen === 'phone' || chosen === 'web' ? chosen : !chromebook && (android || ios || installed) ? 'phone' : 'web';
  // (An Android phone asking for desktop sites says Linux, not Android: set to "phone", it's still one.)
  const kind = chromebook ? 'chromebook' : ios ? (ipad ? 'ipad' : 'iphone')
    : android || (id === 'phone' && !/Windows|Macintosh/.test(agent)) ? 'android' : 'browser';
  return { ...about, id, chromebook, kind };
})();
V.device = V.deviceKind.id;
V.other = V.device === 'pc' ? 'phone' : 'pc';
V.otherName = V.device === 'pc' ? 'your phone' : 'your PC';
/* What the owner's phone is, by the phones among the devices' own records (js/access.js) seen in the last 30 days:
   'iPhone' or 'iPad' when that's the only kind there, else 'Phone' (an Android phone, several kinds, or none). Never
   just the newest record: with an Android phone and an iPad, the label would follow whichever wrote last, not the
   device something came from or goes to. On the phone itself, what it is. */
V.phoneModel = () => {
  if (V.device === 'phone') return V.deviceKind.ios ? V.deviceKind.model : 'Phone';
  const since = Date.now() - 30 * 86400000;
  const own = V.deviceLog && V.deviceLog.installId ? V.deviceLog.installId() : '';
  // Only the devices that took the phone slot (an iPad told it's a browser is 'web': never the phone's name), and
  // never this device's own record.
  const kinds = new Set(Object.entries((V.data && V.data.settings && V.data.settings.extra && V.data.settings.extra.devices) || {})
    .filter(([key, r]) => key !== own && r && typeof r === 'object' && ['android', 'iphone', 'ipad'].includes(r.kind)
      && (r.device || 'phone') === 'phone' && Date.parse(r.seen) >= since)
    .map(([, r]) => r.kind));
  return kinds.size === 1 && !kinds.has('android') ? { iphone: 'iPhone', ipad: 'iPad' }[[...kinds][0]] : 'Phone';
};
/* 'PC', 'Phone' ('iPhone' or 'iPad' for one), and for 'web' what that browser said it is ('Chromebook' or 'Browser',
   kept in the settings row's extra.devices by js/send.js). */
V.deviceLabel = (id) => {
  if (id === 'pc') return 'PC';
  if (id === 'phone') return V.phoneModel();
  if (id !== 'web') return 'Another device';
  if (V.device === 'web') return V.deviceKind.chromebook ? 'Chromebook' : 'Browser';
  const seen = V.data && V.data.settings && V.data.settings.extra && V.data.settings.extra.devices;
  return seen && seen.web && seen.web.label === 'Browser' ? 'Browser' : 'Chromebook';
};
V.deviceName = (id) => ({ PC: 'your PC', Phone: 'your phone', iPhone: 'your iPhone', iPad: 'your iPad',
  Chromebook: 'your Chromebook', Browser: 'your web browser' })[V.deviceLabel(id)] || 'another device';
V.deviceIcon = (id) => (id === 'pc' ? 'pc' : id === 'phone' ? 'phone' : 'laptop');
V.setDevice = (id) => {
  if (V.desktop || id === V.device || !['phone', 'web'].includes(id)) return;
  // (it reloads the page, which would end the note-taker part-way through a class)
  if (V.notetaker && V.notetaker.listening()) { V.toast('The note-taker is listening. Stop it first, then change this.'); return; }
  try { localStorage.setItem('vault-device', id); } catch (error) { /* private browsing: until it closes */ }
  // Back to Settings' Devices after the reload, not to the first screen (js/start.js reads it like an update's).
  try { sessionStorage.setItem('vault-update-resume', JSON.stringify({ tab: 'settings', page: 'devices' })); } catch (error) { /* (Today, then) */ }
  location.reload();
};

/* ---------------------------------------------------------------- light or dark

   V.theme is js/theme.js's: it runs in <head>, before anything is drawn. */

/* ---------------------------------------------------------------- events */

V.bus = new EventTarget();
V.on = (type, fn) => V.bus.addEventListener(type, (event) => fn(event.detail));
V.emit = (type, detail) => V.bus.dispatchEvent(new CustomEvent(type, { detail }));

/* Who the signed-in person is in this cloud (1.21: anyone can sign up at wefty.org): 'owner' (runs the cloud: its own
   account, made when it was set up), 'invited' (an invite or a join QR code: js/cloud.js's user.invited) or 'self'
   (signed up by themselves: e-mail and password with the Terms ticked, which keeps user_metadata.terms, or Google).
   From what V.data.user says when it says (`self`), else from the session this page keeps (supabase-js, under
   'vault-auth'), never asked of the cloud. The PC's own sign-in carries no session here: a PC is its owner's unless
   it says otherwise. Here, not in js/profile.js, so Settings and the rest still know when that one doesn't load. */
V.who = () => {
  const user = (V.data && V.data.user) || {};
  if (['owner', 'invited', 'self'].includes(user.who)) return user.who;  // (js/cloud.js's person(), the PC's config)
  if (user.invited) return 'invited';
  if (typeof user.self === 'boolean') return user.self ? 'self' : 'owner';
  if (user.terms) return 'self';
  if (V.desktop) return 'owner';
  try {
    const kept = JSON.parse(localStorage.getItem('vault-auth') || 'null');
    const account = (kept && (kept.user || (kept.currentSession && kept.currentSession.user))) || null;
    if (account && (!user.id || account.id === user.id)) {
      const meta = account.user_metadata || {};
      const app = account.app_metadata || {};
      if (app.wefty_owner) return 'owner';
      if (meta.invited_by || app.vault_invited_by || app.vault_join) return 'invited';
      if (meta.terms) return 'self';
      // (made by Google: nobody made it for them. Only how it was made, never what was linked to it later: the owner
      // may add Google to their own account)
      if (app.provider && app.provider !== 'email') return 'self';
    }
  } catch (error) { /* a private window: as below */ }
  return 'owner';
};
// Where people who signed up by themselves (and anyone else with nobody to ask) turn for help.
V.TEAM_EMAIL = 'wefty.info@gmail.com';
V.TEAM = `Wefty's team (${V.TEAM_EMAIL})`;

/* Putting Vault on the home screen. Chrome (Android, a Chromebook, a computer) offers it once with an event that has
   to be caught early, so it's kept here for Settings and the welcome steps (js/welcome.js): 'install' goes out with
   'ready' when it can be asked, and 'done' once it's installed. iPhones and iPads never offer it: Safari's Share >
   Add to Home Screen is the way there (V.welcome.howToInstall says so). */
V.install = (() => {
  let offer = null;
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); offer = event; V.emit('install', 'ready'); });
  window.addEventListener('appinstalled', () => { offer = null; V.emit('install', 'done'); });
  return {
    ready: () => !!offer,
    installed: () => {
      try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; }
    },
    /* Chrome's own "Install Vault?" (only from a tap): 'accepted', 'dismissed' or 'none' when it can't be asked. */
    async ask() {
      if (!offer) return 'none';
      const asking = offer;
      offer = null;
      try {
        await asking.prompt();
        const choice = await asking.userChoice;
        return (choice && choice.outcome) || 'dismissed';
      } catch (error) {
        return 'none';
      }
    },
  };
})();

/* Out of sight: the phone's app in the background, or the PC's window hidden in the tray or minimised. The PC app
   keeps its page "visible" even then (a hidden page stops its timers and Realtime), so it says so itself (pc:window).
   'away' and 'back' go out when that changes, with <html class="away"> stopping the animations meanwhile. */
V.pcShown = true;
V.away = () => document.hidden || (V.desktop && !V.pcShown);
let wasAway = !!document.hidden;  // (a page opened out of sight says 'back' once it's shown)
document.documentElement.classList.toggle('away', wasAway);
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
  cards: '<rect x="3.5" y="7" width="13" height="13.5" rx="2.5"/><path d="M7.5 7v-.5A2.5 2.5 0 0 1 10 4h8a2.5 2.5 0 0 1 2.5 2.5V16a2.5 2.5 0 0 1-2.5 2.5h-1.5"/>',
  learn: '<path d="M9.5 18.5h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  // 1.16's frame: Today (a sun coming up), Share (two arrows passing), and the picture's menu
  today: '<path d="M12 3.5V6M5.4 6.9l1.7 1.7M18.6 6.9l-1.7 1.7M3 16.5h18M7 16.5a5 5 0 0 1 10 0M8 20h8"/>',
  share: '<path d="M4.5 8h14M15 4.5 18.5 8 15 11.5"/><path d="M19.5 16h-14M9 12.5 5.5 16 9 19.5"/>',
  'user-plus': '<circle cx="10" cy="8" r="4"/><path d="M2.5 20a7.5 7.5 0 0 1 15 0"/><path d="M19 8.5v6M16 11.5h6"/>',
  feedback: '<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H9.5L5 21v-3.5h-.5A2.5 2.5 0 0 1 2 15V6.5A2.5 2.5 0 0 1 4.5 4H18a2.5 2.5 0 0 1 2.5 2.5z"/><path d="M7 9h9.5M7 12.5h6"/>',
  'sign-out': '<path d="M9.5 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h2.5"/><path d="M15 8l4 4-4 4M19 12H9.5"/>',
  // Settings' categories (1.16, js/settings.js)
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  devices: '<rect x="2.5" y="5" width="13" height="9.5" rx="1.5"/><path d="M1.5 18h11"/><rect x="16" y="9" width="6" height="11" rx="1.5"/><path d="M18.5 17.5h1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4"/><path d="M10.5 12.5 20 3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  // Notifications (1.19): js/reminders.js's bell
  bell: '<path d="M6 10a6 6 0 0 1 12 0c0 4.4 1.5 6.1 2.5 7h-17c1-.9 2.5-2.6 2.5-7z"/><path d="M10 20.2a2.3 2.3 0 0 0 4 0"/>',
};

V.icon = function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  return span;
};

/* Wefty's mark: a rounded iris tile with a white W, and a light thread woven through it (over the two outside strokes
   of the W, under the two middle ones: where it goes over, the W is cut along it with a small gap each side).
   Two looks: `colour` (the brand: iris gradient, white W, lavender thread) for the rail and the start screens, and
   one colour (the default; currentColor, .mark makes it --brand and empty states --faint): the tile with the W and
   the thread cut out of it, the weave kept by the gaps (the W is cut where the thread goes over, the thread where it
   goes under). Each mark gets its own ids, as two marks on a page would otherwise share one gradient and mask. */
const MARK = {
  tile: 'M18 0H46C56 0 64 8 64 18V46C64 56 56 64 46 64H18C8 64 0 56 0 46V18C0 8 8 0 18 0Z',
  w: 'M14 20L23 46L32 26L41 46L50 20',
  outer: 'M14 20L23 46M41 46L50 20',
  mid: 'M23 46L32 26L41 46',
  thread: 'M8 35.5Q20 30.5 32 35.5T56 35.5',
};
const SVG = 'http://www.w3.org/2000/svg';
let marks = 0;
const markParts = (id, colour) => {
  const { tile, w, outer, mid, thread } = MARK;
  const line = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
  if (colour) {
    return '<defs><linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d50f0"/>'
      + '<stop offset="1" stop-color="#493cdd"/></linearGradient>'
      + '<mask id="' + id + 'm" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>'
      + '<path d="' + thread + '" fill="none" stroke="#000" stroke-width="7" stroke-linecap="round"/></mask></defs>'
      + '<path d="' + tile + '" fill="url(#' + id + 'g)"/>'
      + '<path d="' + thread + '" fill="none" stroke="#e6e3ff" stroke-width="4.4" stroke-linecap="round"/>'
      + '<path d="' + w + '" mask="url(#' + id + 'm)" ' + line + ' stroke="#fff" stroke-width="6"/>'
      + '<path d="' + mid + '" ' + line + ' stroke="#fff" stroke-width="6"/>';
  }
  return '<defs><mask id="' + id + 'u" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>'
    + '<path d="' + mid + '" ' + line + ' stroke="#000" stroke-width="8.6"/><path d="' + mid + 'Z" fill="#000"/></mask>'
    + '<mask id="' + id + 'k" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>'
    + '<path d="' + outer + '" ' + line + ' stroke="#000" stroke-width="6"/>'
    + '<path d="' + thread + '" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'
    + '<path d="' + thread + '" mask="url(#' + id + 'u)" fill="none" stroke="#000" stroke-width="4.4" stroke-linecap="round"/>'
    + '<path d="' + mid + '" ' + line + ' stroke="#000" stroke-width="6"/></mask></defs>'
    + '<path d="' + tile + '" fill="currentColor" mask="url(#' + id + 'k)"/>';
};
V.mark = (size = 40, cls = '', { colour = false } = {}) => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'mark' + (colour ? ' colour' : '') + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = markParts('mark' + ++marks, colour);
  return svg;
};

/* The mark with "wefty" beside it, for the start and the screens before the app: the one drawn in index.html's boot
   screen (outlined letters, so no font is needed), copied before the app replaces that screen. Each copy's ids are
   made its own (its gradient and mask), so copies never lean on one that has gone. */
const WORDMARK = document.querySelector('#boot .wordmark');
V.wordmark = () => {
  if (!WORDMARK) return V.mark(40, '', { colour: true });
  const copy = WORDMARK.cloneNode(true);
  const tag = '-' + ++marks;
  for (const el of copy.querySelectorAll('[id]')) el.id += tag;
  for (const el of copy.querySelectorAll('[fill^="url(#"], [mask^="url(#"]')) {
    for (const name of ['fill', 'mask']) {
      const value = el.getAttribute(name);
      if (value && value.startsWith('url(#')) el.setAttribute(name, value.slice(0, -1) + tag + ')');
    }
  }
  return copy;
};

// (`key`: data-key, by which a page drawn again gives the keyboard back to the same button: js/today.js)
V.button = (label, opts = {}) => V.h('button.btn' + (opts.kind ? '.' + opts.kind : ''), {
  type: 'button', onclick: opts.onClick, title: opts.title, disabled: opts.disabled, 'aria-label': opts.aria || (label ? null : opts.title),
  dataset: opts.key ? { key: opts.key } : null,
}, opts.icon ? V.icon(opts.icon) : null, label ? V.h('span', { text: label }) : null);

V.iconButton = (icon, title, onClick, cls, key) => V.h('button.icon-btn' + (cls ? '.' + cls : ''), {
  type: 'button', title, 'aria-label': title, onclick: onClick, dataset: key ? { key } : null,
}, V.icon(icon));

/* ---------------------------------------------------------------- the frame's pieces (1.16)

   The logo's thread as a small wave: under the tab you're on, and in Today's line under the greeting. One period of
   the logo's own thread at the same proportions (a swing of 2.5 over a half-period of 12). */
V.weave = (cls = '') => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 6');
  svg.setAttribute('class', 'weave' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M1.5 3.5Q6.75 1.1 12 3.5T22.5 3.5');
  svg.append(path);
  return svg;
};

/* The empty folder's drawing (1.16): a small loom with nothing woven on it yet but three rows, the thread rising to a
   needle. The fourth and last place the logo's thread shows (with the logo, the tab you're on and Today's line). Warp
   lines in --line-strong, the thread in --accent, the needle in --text-2 (styles.css, .loom); `width` in px, the
   height follows (160 x 120). Built from paths, never from markup text. */
V.loom = (width = 176) => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 160 120');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(Math.round(width * 0.75)));
  svg.setAttribute('class', 'loom');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag, cls, attrs) => {
    const el = document.createElementNS(SVG, tag);
    el.setAttribute('class', cls);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
    svg.append(el);
  };
  const warps = [36, 52, 68, 84, 100, 116];
  for (const x of warps) {
    add('path', 'warp', { d: `M${x} 34V104` });
    add('circle', 'peg', { cx: x, cy: 31, r: 2 });
  }
  // Three rows, back and forth, then up and away through the needle's eye.
  add('path', 'weft', { d: 'M28 100 L124 100 A4 4 0 0 0 124 92 L28 92 A4 4 0 0 1 28 84 L118 84 C127 84 131 79 132 68 '
    + 'C133 55 136 40 143.2 31.6' });
  // Where a warp line goes over the thread, it's drawn again over a gap the page's colour (every other one, row by row).
  const over = [[96, [52, 84, 116]], [88, [36, 68, 100]], [80, [52, 84, 116]]];
  for (const [y, xs] of over) {
    for (const x of xs) {
      add('path', 'gap', { d: `M${x} ${y}V${y + 8}` });
      add('path', 'warp', { d: `M${x} ${y - 0.6}V${y + 8.6}` });
    }
  }
  add('path', 'needle', { d: 'M135 80 L142.4 24.4 A2 2 0 0 1 146.4 24.9 Z' });
  add('ellipse', 'eye', { cx: 143.2, cy: 31.6, rx: 0.9, ry: 3, transform: 'rotate(7.6 143.2 31.6)' });
  add('path', 'weft', { d: 'M143.2 31.6 C147.6 30.4 152 33.4 152 40.4' });
  return svg;
};

/* Your picture (js/profile.js): a circle with your first letter, its mark saying how syncing goes, and a tap opens
   your menu (Settings, Invite people, Feedback, Sign out). If js/profile.js didn't load, or its picture can't be made,
   a plain letter that opens Settings: the way there never goes. */
V.profileButton = (cls = '') => {
  try {
    if (V.profile && V.profile.button) return V.profile.button(cls);
  } catch (error) {
    console.error(error);
  }
  const user = (V.data && V.data.user) || {};
  const letter = (Array.from(String(user.name || user.email || '').trim())[0] || '?').toUpperCase();
  return V.h('button.me.plain' + (cls ? '.' + cls : ''), { type: 'button', title: 'Settings', 'aria-label': 'You: Settings',
    onclick: () => { if (V.go) V.go('settings'); } }, V.h('span.av', { text: letter }));
};

/* Each screen's one row at the top: its title (or the logo, on Today), its own buttons, and your picture. A back
   arrow first where the screen has one (`back`: what it does). It pads for the notch and the note-taker's bar
   (--safe-top), and for a phone's rounded sides in landscape. `.page-head` too, so what looked for a screen's title
   there still finds it. On a wide screen the picture lives at the foot of the rail instead. `onLogo`: the logo is a
   button to Today (1.17, the owner: "click the logo at the top there and have it go to Today"). */
V.appHead = ({ title = '', sub = '', back = null, backLabel = 'Back', actions = [], me = true, logo = false, onLogo = null, cls = '' } = {}) =>
  V.h('header.app-head.page-head' + (cls ? '.' + cls : ''), {},
    back ? V.iconButton('back', backLabel, back, 'head-back') : null,
    logo && onLogo ? V.h('button.head-home', { type: 'button', 'aria-label': 'Today', title: 'Today', onclick: onLogo },
      V.mark(30, 'head-mark', { colour: true }))
      : logo ? V.mark(30, 'head-mark', { colour: true }) : null,
    title || sub ? V.h('div.head-title', {}, title ? V.h('h1', { text: title }) : null, sub ? V.h('p.head-sub', { text: sub }) : null)
      : V.h('span.head-grow'),
    actions,
    me ? V.profileButton('head-me') : null);

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
  // Enter in a box typed into presses the sheet's main button; never on a tick box or a choice (Make flash cards'
  // ticks: Enter there would add every ticked card before they've all been looked at).
  const keys = (event) => {
    if (event.key === 'Escape' && dismissable) { event.stopPropagation(); close(); }
    if (event.key === 'Enter' && !event.shiftKey && event.target.tagName === 'INPUT'
      && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(event.target.type)) {
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

/* A menu of `items` ({ label, icon, onClick, danger }) under `anchor`. An item with `checked` (true or false) is a
   switch: it says whether it's on, with a tick when it is. `{ sep: true }` is a line between groups, and `{ node }`
   a piece of its own (an element, or a function given the menu's close that makes one: the picture's status line).
   `icon` is an icon's name, or an element (copied: js/send.js's rows lend their buttons' own).
   Options: `align: 'up'` opens it above the anchor, from its left edge (the picture at the foot of the rail);
   `at: { x, y, touch }` opens it at a point instead (V.contextMenu: where the pointer was; a finger's: above it, so
   the finger doesn't hide it); `cls` adds a class; `label` names it; `onClose(how)` hears it close ('item', 'outside'
   (a press beside it), 'escape' or 'scroll'); `returnFocus` puts the keyboard back on the anchor; `scrollCloses`: the
   wheel or a finger moving beside it closes it (as the system's own menus do); `pointer`: opened by a pointer, so no
   item is lit until the arrow keys move to one (the keyboard's menus light the first).
   The arrow keys, Home and End go along its items. Returns { close, el }. */
V.menu = function menu(anchor, items, { align = '', at = null, cls = '', label = '', onClose = null, returnFocus = false,
  scrollCloses = false, pointer = false } = {}) {
  const rect = anchor.getBoundingClientRect();
  let closed = false;
  const done = (how = 'item') => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', esc, true);
    if (returnFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    if (onClose) onClose(how);
  };
  const row = (item) => {
    if (item.sep) return V.h('div.menu-sep', { role: 'separator' });
    if (item.node) return typeof item.node === 'function' ? item.node(done) : item.node;
    const switches = typeof item.checked === 'boolean';
    const icon = !item.icon ? null : typeof item.icon === 'string' ? V.icon(item.icon) : item.icon.cloneNode(true);
    return V.h('button.menu-item' + (item.danger ? '.danger' : '') + (switches ? '.menu-switch' : ''), {
      type: 'button', role: switches ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': switches ? String(item.checked) : null,
      disabled: item.disabled ? true : null,
      onclick: () => { done(); item.onClick(); },
    }, icon, V.h('span', { text: item.label }),
    switches ? V.h('span.menu-state', { text: item.checked ? 'On' : 'Off' }) : null);
  };
  // (a line never first, last or twice in a row: lists made from parts, some of them missing)
  const shown = [];
  for (const item of items.filter(Boolean)) if (!item.sep || (shown.length && !shown[shown.length - 1].sep)) shown.push(item);
  while (shown.length && shown[shown.length - 1].sep) shown.pop();
  const list = V.h('div.menu' + (cls ? '.' + cls : ''), { role: 'menu', 'aria-label': label || null }, shown.map(row));
  // Up and Down go along the items (Home, End to the ends), round from the last to the first. A piece of its own that
  // moves its own way first (the editor's tiles) keeps the keys.
  list.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const all = [...list.querySelectorAll('[role=menuitem], [role=menuitemcheckbox]')].filter((b) => !b.disabled && b.getClientRects().length);
    if (!all.length) return;
    event.preventDefault();
    const now = all.indexOf(document.activeElement);
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1
      : now < 0 ? (event.key === 'ArrowDown' ? 0 : all.length - 1)
        : (now + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[to].focus();
  });
  // (the browser's own menu never comes up over this one, or beside it)
  list.addEventListener('contextmenu', (event) => event.preventDefault());
  const wrap = V.h('div.layer.menu-layer', {
    onmousedown: (event) => { if (event.target === wrap) done('outside'); },
    oncontextmenu: (event) => { if (event.target === wrap) event.preventDefault(); },
  }, list);
  if (scrollCloses) {
    // The wheel or a finger dragged beside the menu: the person wants to scroll, so it goes (the menu's own scrolling,
    // a long one on a short screen, is left alone).
    const away = (event) => { if (!list.contains(event.target)) done('scroll'); };
    wrap.addEventListener('wheel', away, { passive: true });
    wrap.addEventListener('touchmove', away, { passive: true });
  }
  const esc = (event) => { if (event.key === 'Escape') { event.stopPropagation(); done('escape'); } };
  document.addEventListener('keydown', esc, true);
  document.getElementById('layers').append(wrap);
  // Worked out in the page's own px: with the page zoomed (bigger text) the pointer's and the anchor's places are the
  // screen's, `zoom` times the page's.
  const zoom = (list.offsetWidth && list.getBoundingClientRect().width / list.offsetWidth) || 1;
  const screenW = window.innerWidth / zoom, screenH = window.innerHeight / zoom;
  list.style.maxHeight = (screenH - 16) + 'px';
  const width = list.offsetWidth, height = list.offsetHeight;
  const box = { left: rect.left / zoom, right: rect.right / zoom, top: rect.top / zoom, bottom: rect.bottom / zoom };
  if (at) {
    // At a point: from there down and right, else turned to fit (left of it, above it). A finger's: above the finger.
    const x = at.x / zoom, y = at.y / zoom;
    const fitsRight = x + width + 8 <= screenW;
    list.style.left = (at.touch ? Math.max(8, Math.min(screenW - width - 8, x - width / 2))
      : Math.max(8, fitsRight ? x : Math.min(screenW - width - 8, x - width))) + 'px';
    let top = y + height + 8 <= screenH ? y : y - height;
    if (at.touch) {
      // Above the finger when it fits, else below it; a menu too long for either side scrolls on the bigger one, so
      // the finger never covers it.
      const above = y - 16 - 8;
      const below = screenH - (y + 28) - 8;
      if (height > above && height > below && Math.max(above, below) >= 160) {
        list.style.maxHeight = Math.max(above, below) + 'px';
        top = above >= below ? y - 16 - Math.min(height, above) : y + 28;
      } else top = height <= above ? y - height - 16 : y + 28;
    }
    list.style.top = Math.max(8, top) + 'px';
  } else if (align === 'up') {
    list.style.left = Math.max(8, Math.min(screenW - width - 8, box.left)) + 'px';
    list.style.top = Math.max(8, box.top - height - 8) + 'px';
  } else {
    list.style.left = Math.max(8, Math.min(screenW - width - 8, box.right - width)) + 'px';
    list.style.top = (box.bottom + height + 8 > screenH ? Math.max(8, box.top - height - 4) : box.bottom + 4) + 'px';
  }
  // (Never past the bottom edge: on a short screen the menu, which scrolls past its max-height, sits higher instead.)
  list.style.top = Math.max(8, Math.min(parseFloat(list.style.top), screenH - list.offsetHeight - 8)) + 'px';
  const first = list.querySelector('.menu-item:not([disabled])') || list.querySelector('button');
  if (pointer) {
    // (opened by a pointer: the menu itself has the keyboard, nothing lit, so Esc and the arrow keys work at once)
    list.tabIndex = -1;
    list.focus({ preventScroll: true });
  } else if (first) first.focus();
  return { close: done, el: list };
};

/* "More options" for something that can be acted on (1.19.1; the owner: "Double-clicking on stuff like right click or
   two finger touchpad doesn't really work for everything like I want it to for more options"). `el` gets a menu of
   `items` (V.menu's; or a function given the event that makes them as it opens, so they say what's true then; none:
   the browser's own menu), opened
   - by a right-click, which a Chromebook's or a Mac's two-finger tap on the touchpad also is, at the pointer;
   - by a finger or the S Pen held still for LONG ms (a long press; moving first is a scroll, left to the browser),
     above the finger. One rule for a finger (1.19.8; the owner: "sometimes it selects text, or sometimes vice versa"):
     on a thing (a card, a row, a chip, a button) the hold's own timer is the only thing that opens the menu, on every
     phone, iPhone and touchscreen alike; the browser's long press (Chrome's contextmenu from a finger, at the phone's
     own touch-and-hold time, which iOS never sends) is always cancelled there and opens nothing, so the two can't both
     fire or race, and the phone never picks a thing's words (styles.css: nothing is selectable on a touch screen but
     WORDS). In WORDS (the text people read or write: a note's words and its Read view, Chat's messages, the
     note-taker's transcript, an announcement) a finger's long press is always the browser's: picking words, Copy; the
     menu there is a right-click (or a visible ⋯: `attach.openFrom`);
   - by the keyboard's menu key or Shift+F10, at the thing itself;
   and closed by Esc, a press beside it or scrolling, the keyboard going back to where it was.
   In a box typed into (a text box, the editor's words) and over words picked (selected) in `el`, the browser's own
   menu stays (copy, paste, spelling). Something inside `el` with a menu of its own has it, not `el`'s. Options:
     touch: false     a long press there is someone else's (js/drag.js: it picks a note, or lifts a folder)
     open             what a double click with a mouse does (the desktop habit: opening the thing)
     skip(target)     true where `el`'s menu isn't wanted (the browser's own then): the editor's words
     label            the menu's name for a screen reader
   Returns el. */
/* A finger's long press: how long it's held still (js/drag.js's hold uses the same), and the words people read or write,
   where a finger's long press is always the browser's own (1.19.8: styles.css keeps exactly these selectable on a touch
   screen; everything else there, the things, never picks words). */
V.LONG_PRESS = 450;
V.WORDS = '.ctx-words, .blocks, .note-title, .read-view, .chat-reply-body, .chat-you-text, .chat-note, .nt-words, .news-text, .news-note-body, .ai-check, .ai-gemini-net, .ai-gemini-times, .ai-gemini-first';

V.contextMenu = (() => {
  const LONG = V.LONG_PRESS;  // ms a finger stays still for a long press
  const SLOP = 10;    // px it may wander meanwhile (more is a scroll)
  const TEXT = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type=checkbox]):not([type=radio])'
    + ':not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]):not([type=image])';
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  // The words people read or write, where a finger's long press is the browser's (styles.css keeps them selectable on
  // a touch screen, the one list: test_wefty_1198_longpress checks the two agree). Buttons inside them are things.
  const WORDS = V.WORDS;
  const THING_IN_WORDS = 'button, [role=button], [role=menuitem], label, summary, input[type=checkbox], input[type=radio]';
  let held = null;      // a finger down on something with a menu: { el, id, x, y, target, timer }
  let open = null;      // the menu open now: { el, menu }
  let rightDown = null; // the last right press: { el, at, picked } (words picked before it: a Mac picks the word pressed)
  const menus = new WeakMap();  // el -> { make, opts }: for attach.openFrom

  const element = (node) => (node && node.nodeType === 1 ? node : node && node.parentElement) || null;
  const typing = (node) => { const el = element(node); return !!(el && el.closest(TEXT)); };
  const inWords = (node) => { const el = element(node); return !!(el && el.closest(WORDS) && !el.closest(THING_IN_WORDS)); };
  const touchy = (event) => event.pointerType === 'touch' || event.pointerType === 'pen'
    || !!(event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents);
  function wordsPicked(el) {
    const sel = window.getSelection ? window.getSelection() : null;
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && String(sel).trim() !== '' && sel.containsNode(el, true);
  }
  const buzz = () => { try { if (navigator.vibrate) navigator.vibrate(12); } catch (error) { /* no buzz, no matter */ } };

  /* No line first, last or twice in a row. */
  function tidy(items) {
    const out = [];
    for (const item of (items || []).filter(Boolean)) {
      if (item.sep && (!out.length || out[out.length - 1].sep)) continue;
      out.push(item);
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }

  /* Where the keyboard goes back to: what had it in `el`, else what was pressed (a card, a row's button), else `el`. */
  function returnTo(el, target) {
    const active = document.activeElement;
    if (active && active !== document.body && el.contains(active)) return active;
    const hit = element(target) && element(target).closest(FOCUSABLE);
    if (hit && el.contains(hit)) return hit;
    if (el.matches(FOCUSABLE)) return el;
    return active && active !== document.body ? active : null;
  }

  function show(el, make, opts, how, x, y, target, event, anchor = null) {
    let items;
    try { items = tidy(typeof make === 'function' ? make(event) : make); } catch (error) { console.error(error); items = []; }
    if (!items.some((item) => !item.sep)) return false;
    if (open) open.menu.close('again');
    const back = returnTo(el, target);
    let at = { x, y, touch: how === 'touch' };
    if (how === 'key') {
      const box = el.getBoundingClientRect();
      const top = Math.max(8, Math.min(box.top, window.innerHeight - 8));
      at = { x: box.left + Math.min(24, box.width / 2), y: Math.min(top + Math.min(box.height, 40), window.innerHeight - 8) };
    }
    if (how === 'button') at = null;  // (under the ⋯ pressed)
    if (how === 'touch') unpick();
    el.classList.add('ctx-open');
    if (anchor) anchor.setAttribute('aria-expanded', 'true');  // (a ⋯: its popup open, for a screen reader and its look)
    const menu = V.menu(anchor || el, items, { at, cls: 'ctx-menu', label: opts.label || '', scrollCloses: true, pointer: how !== 'key',
      onClose: () => {
        el.classList.remove('ctx-open');
        if (anchor) anchor.setAttribute('aria-expanded', 'false');
        if (open && open.menu === menu) open = null;
        if (back && back.isConnected) back.focus({ preventScroll: true });
      } });
    open = { el, menu };
    return true;
  }

  /* Words a phone picked under the finger anyway (one that ignores user-select): gone as a finger's menu opens. A
     box being typed in keeps its own. */
  function unpick() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || typing(document.activeElement)) return;
    try { sel.removeAllRanges(); } catch (error) { /* nothing picked, no matter */ }
  }

  /* While a finger is held on a thing, nothing starts picking its words (a belt to styles.css's braces). */
  document.addEventListener('selectstart', (event) => {
    if (held && !inWords(event.target) && !typing(event.target)) event.preventDefault();
  }, true);

  function stopHold() {
    if (!held) return;
    clearTimeout(held.timer);
    held = null;
    window.removeEventListener('pointermove', moved, true);
    window.removeEventListener('pointerup', stopHold, true);
    window.removeEventListener('pointercancel', stopHold, true);
    window.removeEventListener('scroll', stopHold, true);
  }

  function moved(event) {
    if (held && event.pointerId === held.id && Math.hypot(event.clientX - held.x, event.clientY - held.y) > SLOP) stopHold();
  }

  /* The finger lifted after a long press: the tap the browser may make of it (an iPhone's) lands on nothing, never on
     the menu that came up under it. */
  function swallowLift(id) {
    const lifted = (event) => {
      if (event.pointerId !== id) return;
      window.removeEventListener('pointerup', lifted, true);
      window.removeEventListener('pointercancel', lifted, true);
      const until = Date.now() + 450;
      const types = ['mousedown', 'mouseup', 'click'];
      const stop = (e) => {
        if (Date.now() > until) { off(); return; }
        if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) > 30) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === 'click') off();
      };
      const off = () => types.forEach((t) => window.removeEventListener(t, stop, true));
      types.forEach((t) => window.addEventListener(t, stop, true));
      setTimeout(off, 500);
    };
    window.addEventListener('pointerup', lifted, true);
    window.addEventListener('pointercancel', lifted, true);
    setTimeout(() => {  // (lifted already, before the menu came: nothing to wait for)
      window.removeEventListener('pointerup', lifted, true);
      window.removeEventListener('pointercancel', lifted, true);
    }, 4000);
  }

  function longPress(el, make, opts) {
    const h = held;
    stopHold();
    if (!h || !h.el.isConnected) return;
    if (show(el, make, opts, 'touch', h.x, h.y, h.target, { type: 'longpress', target: h.target, clientX: h.x, clientY: h.y })) {
      buzz();
      swallowLift(h.id);
    }
  }

  function attach(el, make, opts = {}) {
    if (!el || el.dataset.ctx === 'on') return el;
    el.dataset.ctx = 'on';
    if (opts.touch !== false) el.classList.add('ctx');
    menus.set(el, { make, opts });
    const mine = (event) => !event.defaultPrevented && !typing(event.target) && !(opts.skip && opts.skip(element(event.target)))
      && !(touchy(event) && inWords(event.target));  // (a finger on words: the browser's own picking)
    el.addEventListener('pointerdown', (event) => {
      if (!touchy(event)) {
        if (event.button === 2) rightDown = { el, at: Date.now(), picked: wordsPicked(el) };
        return;
      }
      // (a long press that's someone else's, js/drag.js's: theirs alone)
      if (!event.isPrimary || opts.touch === false || !mine(event) || held) return;
      if (event.target.closest('[data-ctx="on"]') !== el) return;  // (something inside with a menu of its own)
      held = { el, id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target,
        timer: setTimeout(() => longPress(el, make, opts), LONG) };
      window.addEventListener('pointermove', moved, true);
      window.addEventListener('pointerup', stopHold, true);
      window.addEventListener('pointercancel', stopHold, true);
      window.addEventListener('scroll', stopHold, true);
    });
    el.addEventListener('contextmenu', (event) => {
      if (event.defaultPrevented) return;  // (something inside had its own)
      if (touchy(event)) {
        // A finger: in words, the browser's own (picking them, Copy); on a thing, never the browser's (its menu, its
        // word picking) and never a menu by itself: the hold's timer opens ours (see above), whether this came
        // before it (a phone set to a short touch-and-hold), after it, or with no hold at all.
        if (event.defaultPrevented || typing(event.target) || inWords(event.target)) return;
        if (opts.skip && opts.skip(element(event.target))) return;
        event.preventDefault();
        // The S Pen's side button (js/ink.js) or a Chromebook stylus's: a right-click, so its menu at once, as before
        // 1.19.8 (a tap with it is shorter than a hold, so no timer would). A hold running is this one; one open stays.
        if (event.pointerType === 'pen' && opts.touch !== false && !(open && open.el === el)) {
          const h = held;
          stopHold();
          if (show(el, make, opts, 'touch', event.clientX, event.clientY, event.target, event)) {
            buzz();
            if (h) swallowLift(h.id);
          }
        }
        return;
      }
      if (open && open.el === el) { event.preventDefault(); return; }
      if (!mine(event)) return;  // the browser's own: copy, paste, spelling
      const recent = rightDown && rightDown.el === el && Date.now() - rightDown.at < 1500 ? rightDown : null;
      if (recent ? recent.picked : wordsPicked(el)) return;  // words picked: the browser's Copy
      const keyed = !event.clientX && !event.clientY;  // (a menu key the browser turned into a contextmenu)
      if (show(el, make, opts, keyed ? 'key' : 'mouse', event.clientX, event.clientY, event.target, event)) event.preventDefault();
    });
    el.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
      if (!mine(event)) return;
      if (show(el, make, opts, 'key', 0, 0, event.target, event)) event.preventDefault();
    });
    if (opts.open) {
      let lastTouch = 0;
      el.addEventListener('pointerdown', (event) => { if (touchy(event)) lastTouch = Date.now(); });
      el.addEventListener('dblclick', (event) => {
        if (event.defaultPrevented || Date.now() - lastTouch < 800 || !mine(event)) return;
        if (element(event.target).closest('[data-ctx="on"]') !== el) return;
        // (two clicks on a button inside it, its tick, are that button's, twice)
        const inner = element(event.target).closest('button, a[href], input, label, select, summary');
        if (inner && inner !== el && el.contains(inner)) return;
        event.preventDefault();
        opts.open(event);
      });
    }
    return el;
  }

  /* `el`'s menu under `button` (a visible ⋯ where a finger's long press picks words instead: a Chat message). */
  attach.openFrom = (el, button, event = null) => {
    const known = menus.get(el);
    if (!known) return false;
    return show(el, known.make, known.opts, 'button', 0, 0, button, event || { type: 'button', target: button }, button);
  };
  attach.WORDS = WORDS;
  attach.close = () => { if (open) open.menu.close('escape'); };
  /* Whether the menu was opened by a finger (or the S Pen): `make`'s event. */
  attach.byTouch = (event) => !!event && (event.type === 'longpress' || touchy(event));
  attach.isOpen = () => !!open;
  /* Menu items made from the buttons in `box` (a row's own Open, Save, Copy...): what they say (or are named), their
     icon, and what they do (pressing the button itself). */
  attach.fromButtons = (box) => [...(box ? box.querySelectorAll('button') : [])]
    .filter((b) => !b.disabled && !b.hidden && b.getClientRects().length)
    .map((b) => {
      const label = (b.textContent || '').trim() || b.getAttribute('aria-label') || b.title || '';
      const icon = b.querySelector('.icon');
      return label ? { label, icon: icon || null, danger: /danger/.test(b.className) || /^(delete|remove)\b/i.test(label),
        onClick: () => b.click() } : null;
    });
  return attach;
})();

V.toast = function toast(text, { kind = '', action, onAction, ms = 3200 } = {}) {
  const box = document.getElementById('toasts');
  const item = V.h('div.toast' + (kind ? '.' + kind : ''), { role: 'status' },
    kind === 'err' ? V.icon('alert') : null, V.h('span', { text }),
    action ? V.h('button.toast-action', { type: 'button', text: action, onclick: () => { onAction(); gone(); } }) : null);
  const gone = () => { item.classList.add('leaving'); setTimeout(() => item.remove(), 200); };
  box.append(item);
  const all = box.querySelectorAll(':scope > .toast');  // (a card from V.notice above them stays)
  for (let i = 0; i < all.length - 3; i++) all[i].remove();
  setTimeout(gone, action ? Math.max(ms, 5000) : ms);
};

/* A small card that comes up for a moment over the corner, for something that just happened (js/arrive.js: what was
   sent here; js/clips.js: a clip it couldn't copy by itself): a picture, a title, the name or the words, a line or two
   saying what Vault did, up to two buttons and an x. One at a time: showing another takes its place. Not a dialog: it
   never takes the focus or stops anything behind it, and it stays while the pointer or the keyboard is on it (else it
   goes after `ms`). Returns { el, update(changes), close(), open() }; update() changes only what differs (and waits
   `ms` again): the same buttons stay, so one that has the keyboard keeps it, and #toasts (a polite live region) only
   reads out the line that changed. The card itself is a labelled group, not a second live region. */
V.notice = (() => {
  let current = null;
  return function notice(options) {
    if (current) current.close(true);
    const state = { ms: 8000, ...options };
    const el = V.h('div.notice', { role: 'group' });
    const parts = {
      picture: V.h('div.notice-picture'),
      title: V.h('strong.notice-title'),
      text: V.h('p.notice-text'),
      more: V.h('p.notice-more'),
      lines: V.h('div.notice-lines'),
      actions: V.h('div.notice-actions'),
    };
    const drawn = { picture: undefined, icon: '', lines: '', actions: '' };
    let timer = null;
    let held = false;
    let closed = false;
    const wait = () => {
      clearTimeout(timer);
      if (!held && !closed) timer = setTimeout(() => close(), state.ms);
    };
    function close(quick) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (current === handle) current = null;
      if (quick) el.remove();
      else { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); }
      if (state.onClose) state.onClose();
    }
    const setText = (node, text) => {
      node.hidden = !text;
      if (node.textContent !== (text || '')) node.textContent = text || '';
    };
    function draw() {
      if (state.picture !== drawn.picture || (!state.picture && (state.icon || 'file') !== drawn.icon)) {
        drawn.picture = state.picture;
        drawn.icon = state.icon || 'file';
        parts.picture.classList.toggle('notice-icon', !state.picture);
        V.clear(parts.picture, state.picture || V.icon(drawn.icon));
      }
      setText(parts.title, state.title || '');
      el.setAttribute('aria-label', state.title || 'Wefty');
      setText(parts.text, state.text || '');
      setText(parts.more, state.more > 0 ? `and ${state.more} more` : '');
      const lines = (state.lines || []).filter(Boolean);
      const lineKey = JSON.stringify(lines.map((line) => [line.text, !!line.ok]));
      if (lineKey !== drawn.lines) {
        drawn.lines = lineKey;
        V.clear(parts.lines, lines.map((line) => V.h('p.notice-line' + (line.ok ? '.ok' : ''), {},
          line.ok ? V.icon('check') : null, V.h('span', { text: line.text }))));
      }
      // The buttons are made again only when they change (each press runs what `actions` says now).
      const actions = (state.actions || []).filter(Boolean).slice(0, 2);
      const actionKey = JSON.stringify(actions.map((action) => [action.label, action.kind || '', action.icon || '']));
      if (actionKey !== drawn.actions) {
        const had = [...parts.actions.children].indexOf(document.activeElement);
        drawn.actions = actionKey;
        V.clear(parts.actions, actions.map((action, i) => V.button(action.label, {
          kind: action.kind || '', icon: action.icon,
          onClick: async () => {
            const now = (state.actions || []).filter(Boolean)[i];
            if (!now) return;
            let keep = false;
            try { keep = await now.onClick(); } catch (error) { V.problem(error); }
            if (keep !== true) close();
          },
        })));
        if (had >= 0) (parts.actions.children[Math.min(had, parts.actions.children.length - 1)] || closer).focus();
      }
      parts.actions.hidden = !actions.length;
    }
    const closer = V.iconButton('x', 'Close', () => close(), 'quiet');
    el.append(parts.picture,
      V.h('div.notice-main', {}, parts.title, parts.text, parts.more, parts.lines, parts.actions),
      closer);
    el.addEventListener('mouseenter', () => { held = true; clearTimeout(timer); });
    el.addEventListener('mouseleave', () => { held = el.contains(document.activeElement); wait(); });
    el.addEventListener('focusin', () => { held = true; clearTimeout(timer); });
    el.addEventListener('focusout', (event) => {
      if (el.contains(event.relatedTarget)) return;
      held = el.matches(':hover');
      wait();
    });
    const handle = {
      el,
      update(changes) {
        if (closed) return;
        Object.assign(state, changes);
        draw();
        // (Still held only while the pointer or the keyboard is on it.)
        held = el.matches(':hover') || el.contains(document.activeElement);
        wait();
      },
      close: (quick) => close(quick),  // (quick: gone at once, as when another card takes its place)
      open: () => !closed,
    };
    current = handle;
    draw();
    document.getElementById('toasts').prepend(el);
    wait();
    return handle;
  };
})();

V.problem = (error) => {
  // (an upload turned down for want of room: its words with a button to where files are managed, js/send.js)
  if (error && error.full && V.storage && V.storage.say) { V.storage.say(error); return; }
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

/* When something was sent (a transfers row), for "the newest wins" against clips, whose times are the cloud's own:
   its created_at is the sender's clock (when the sending began), which may run ahead, so never later than the cloud's
   updated_at on it (when it went up, or changed since). */
V.sentAt = (t) => {
  const made = Date.parse((t && t.created_at) || '');
  const up = Date.parse((t && t.updated_at) || '');
  return Number.isFinite(made) && Number.isFinite(up) && up < made ? t.updated_at : (t && t.created_at) || '';
};

/* Programs and scripts: never saved into a folder (js/arrive.js) or put on the clipboard (js/send.js) by themselves.
   vault/local.py's RISKY_TYPES (tests/test_vault_arrive.py keeps the two the same), and what installs or runs on a
   Chromebook (Android and Linux apps, Chrome extensions). By the name as it's saved: Windows and ChromeOS drop dots
   and spaces at its end, so "run.bat." is a .bat. */
V.RISKY_TYPES = ['exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle',
  'appinstaller', 'application', 'appref-ms', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vbs', 'vbe', 'js',
  'jse', 'wsf', 'wsh', 'ws', 'hta', 'lnk', 'url', 'scf', 'inf', 'reg', 'dll', 'sys', 'ocx', 'jar', 'msc', 'gadget',
  'settingcontent-ms', 'library-ms', 'search-ms', 'iso', 'img', 'vhd', 'vhdx', 'chm', 'py', 'pyw', 'sh', 'xll', 'xlam',
  'ppam', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'ppsm', 'sldm'];
V.CHROMEBOOK_RISKY = ['apk', 'crx', 'deb', 'rpm', 'appimage'];
V.risky = (name) => {
  const clean = String(name || '').split(/[\\/]/).pop().replace(/[. ]+$/, '');
  const dot = clean.lastIndexOf('.');
  const type = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  return !!type && (V.RISKY_TYPES.includes(type) || V.CHROMEBOOK_RISKY.includes(type));
};

/* Copied with a button in Vault: the newest thing on this clipboard, so nothing that came before it (a clip, something
   sent here, a picture still being made for it) goes over it (js/clips.js). `cloud`: a clip or something sent here,
   copied again, which "Keep this clipboard in step" then knows isn't new (so it isn't sent back up); anything else
   Vault copies goes to the other devices (with "in step" on: at once). What Vault knows is on the clipboard changes
   only once the words are there: a write that failed leaves it as it was. */
V.copy = async (text, { cloud = false } = {}) => {
  const clips = V.clips && V.clips.copying ? V.clips : null;
  if (clips) clips.copying();  // (first: what's waiting to be copied sees it)
  if (V.desktop && V.pc) {
    const answer = await V.pc.setClipboard(text);
    if (clips) clips.copied(text, { cloud });
    return answer;
  }
  let done = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // (Marked: js/clips.js doesn't take this copy for one made in a note.)
    const area = V.h('textarea', { style: { position: 'fixed', opacity: '0' }, dataset: { vaultCopy: '' } }, text);
    document.body.append(area);
    area.select();
    try { done = document.execCommand('copy'); } catch (failed) { done = false; }
    area.remove();
  }
  if (done && clips) clips.copied(text, { cloud });
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

/* The PC app is told which theme shows (its window, the quick note box), and follows Windows' own. A PC app new
   enough to know Pure black (bridge call pureBlack) hears that too, first, so its window's background matches. */
if (V.desktop) {
  V.on('pc:scheme', ({ scheme }) => V.theme.system(scheme));
  const tell = () => {
    if (!V.pc) return;
    if (V.pc.can('pureBlack')) V.pc.call('pureBlack', { on: V.theme.isBlack() }).catch(() => {});
    V.pc.call('theme', { dark: V.theme.current() === 'dark' }).catch(() => {});
  };
  V.on('theme', tell);
  window.addEventListener('DOMContentLoaded', tell);  // once cloud.js has made V.pc
  V.theme.tellPc = tell;  // again once start.js knows which calls the PC app has (config's `can`)
}
