/* Wefty (it used to be called Vault) moved from https://crustyt0es.github.io/vault/ to .../wefty/. Same site (the
   same origin), so this browser's sign-in, offline copy and settings come along: nobody signs in again (but an
   iPhone's home screen icon, which iOS keeps apart).

   Loaded first, before every other script (index.html's <head>, not async), on the old address only:
   - a browser tab: once the new address answers (so a move published before the new repo is up never strands
     anyone), location.replace() to the same page under the new address with ?search and #hash exactly as they were
     (invites, join codes, #connect=, #clip, ?view=, ?shared= all keep working). sessionStorage "wefty-moved" goes
     along so the new page says so once, and a page sent on that comes straight back here within a few seconds stays
     (never a loop). js/start.js's boot waits for `ready` and does nothing while the page is going.
   - the old installed app (display-mode standalone, as the manifest asks for, or an iPhone's navigator.standalone;
     the way V.install.installed() tells): an installed app can't move itself, so `ready` says 'ask' and js/start.js
     shows "Vault is now Wefty" first, with "Keep using this one for now" (asked every time it opens). Never
     "fullscreen": Chrome says that for an ordinary tab in a full-screen window too (F11, a Chromebook's full-screen
     key), and that tab moves like any other.
   Never on the PC app (vault://app/) or anywhere else. Tests set window.__weftyMove = { from, to } (or { off: true })
   in an init script to try it on their own address. */
'use strict';

(() => {
  const V = (window.V = window.V || {});
  const FLAG = 'wefty-moved';
  const WAIT = 4000;  // how long the new address gets to answer before the old page just opens as it is
  const BACK_SOON = 10000;  // sent on less than this long ago and back here: something sends it back, so stay
  const given = window.__weftyMove || {};
  const from = given.from || 'https://crustyt0es.github.io/vault/';
  const to = given.to || 'https://crustyt0es.github.io/wefty/';
  const bare = from.replace(/\/$/, '');

  /* The new address for an old one (anything else as it is): for links and QR codes made on the old address. */
  const address = (url) => (url === bare ? to : String(url).startsWith(from) ? to + String(url).slice(from.length) : url);

  const store = (() => { try { return window.sessionStorage; } catch (error) { return null; } })();
  const read = () => { try { return store ? store.getItem(FLAG) : null; } catch (error) { return null; } };
  const write = (value) => {
    try { if (value === null) store.removeItem(FLAG); else store.setItem(FLAG, value); } catch (error) { /* private */ }
  };

  const here = location.origin + location.pathname;
  const old = !window.VAULT_DESKTOP && !given.off && from !== to && (here === bare || here.startsWith(from))
    && !(to.startsWith(from) && here.startsWith(to));  // (the new address is never taken for the old one)
  let installed = false;
  try {
    installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch (error) { /* an old browser: a tab */ }

  // Arrived on the new address from the old one: said once (js/start.js), then forgotten.
  let arrived = false;
  if (!old && read()) {
    arrived = true;
    write(null);
  }

  /* Whether the new address is up: its version.json answers. Never waits more than WAIT. */
  function up() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), WAIT);
      try {
        fetch(to + 'version.json', { cache: 'no-store' })
          .then((reply) => { clearTimeout(timer); resolve(reply.ok); })
          .catch(() => { clearTimeout(timer); resolve(false); });
      } catch (error) {  // (no fetch at all: an old browser stays where it is)
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  let ready = Promise.resolve('stay');
  if (old) {
    const sent = Number(read()) || 0;
    if (!installed && sent && Date.now() - sent < BACK_SOON) {
      write(null);  // sent on a moment ago and back already: open here, as before
    } else {
      ready = up().then((answered) => {
        if (!answered) return 'stay';
        if (installed) return 'ask';
        write(String(Date.now()));
        location.replace(address(here) + location.search + location.hash);
        return 'moving';
      }).catch(() => 'stay');  // (whatever goes wrong, the page still opens)
    }
  }

  V.moved = {
    from, to, old, installed, address, ready,
    get arrived() { return arrived; },
    /* The new address of this very page, ?search and #hash kept: "Open Wefty" on the old app's screen. */
    target: () => address(location.origin + location.pathname) + location.search + location.hash,
    said() { arrived = false; },
  };
})();
