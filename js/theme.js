/* Wefty: light or dark, and Pure black (V.theme). Loaded in index.html's <head>, right after js/moved.js and before
   the stylesheet, so html[data-theme], html[data-black] and the status bar's colours are already set before the
   parser even reaches <body>: the first frame is drawn in the right colours, never light (or navy) first. (The
   page's rules allow no inline script, so it's a file of its own; js/util.js, which makes the rest of `V`, comes
   much later, after the vendor scripts.)

   This device's own choice (Settings > Appearance, kept in localStorage 'vault-theme': system, light or dark), else
   the system's. In the PC app "system" means Windows' own app theme, which vault/desktop.py hands over (VAULT_SCHEME
   at the start, then a "scheme" event), as Qt's web view may not pass it on as prefers-color-scheme. Pure black
   (Settings > Appearance, 'vault-black' = 'on', per device, off unless switched on) puts html[data-black] on while
   dark shows: styles.css then makes the canvas black for phones with black (OLED) screens. Says "theme" (V.emit)
   on a change once js/util.js is there. */
'use strict';

(() => {
const V = (window.V = window.V || {});

V.theme = (() => {
  const KEY = 'vault-theme';
  const BLACK = 'vault-black';
  // --bg, for the phone's status bar (the theme-color metas): light, dark, and dark with Pure black. (Android's
  // navigation bar at the bottom of an installed app is another matter: since Chrome 153 it takes the manifest's
  // theme_color, which Chrome copies into the installed app and nothing on the page can change. A manifest has one
  // colour for both themes, so manifest.webmanifest's is the dark tab bar's, --surface #13131f, and its
  // background_color, the launch screen's, the dark --bg: a white bar under a dark app glares, a dark one under a
  // light app doesn't.)
  const BARS = { light: '#f5f6f8', dark: '#0d0d17', black: '#000000' };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let system = /^(light|dark)$/.test(window.VAULT_SCHEME || '') ? window.VAULT_SCHEME : '';
  let shown = '';
  let look = '';
  let unsaved = null;  // Pure black where storage refuses it: until the page closes
  const choice = () => {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch (error) {
      return 'system';
    }
  };
  const black = () => {
    if (unsaved !== null) return unsaved;
    try {
      return localStorage.getItem(BLACK) === 'on';
    } catch (error) {
      return false;
    }
  };
  const resolved = () => (choice() !== 'system' ? choice() : system || (media.matches ? 'dark' : 'light'));
  function apply() {
    const now = resolved();
    const deep = black();
    const root = document.documentElement;
    root.dataset.theme = now;
    if (deep && now === 'dark') root.dataset.black = '';
    else delete root.dataset.black;
    const bar = (theme) => BARS[theme === 'dark' && deep ? 'black' : theme];
    const own = choice() === 'system' && !system;  // each meta keeps its own colour, picked by the system
    for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
      meta.content = bar(own ? (/dark/.test(meta.media) ? 'dark' : 'light') : now);
    }
    shown = now;
    const was = look;
    look = now + (deep && now === 'dark' ? ' black' : '');
    if (look !== was && V.emit) V.emit('theme', now);
  }
  media.addEventListener('change', apply);
  // changed in another tab
  window.addEventListener('storage', (event) => { if (event.key === KEY || event.key === BLACK) apply(); });
  apply();
  return {
    choice,
    current: () => shown,
    black,
    /* Pure black is in effect: switched on and dark showing. */
    isBlack: () => look === 'dark black',
    set(value) {
      try {
        if (value === 'light' || value === 'dark') localStorage.setItem(KEY, value);
        else localStorage.removeItem(KEY);
      } catch (error) { /* private browsing: it lasts until the page closes */ }
      apply();
    },
    setBlack(on) {
      try {
        if (on) localStorage.setItem(BLACK, 'on');
        else localStorage.removeItem(BLACK);
        unsaved = null;
      } catch (error) {
        unsaved = !!on;
      }
      apply();
    },
    system(value) {
      system = value === 'light' || value === 'dark' ? value : '';
      apply();
    },
  };
})();
})();
