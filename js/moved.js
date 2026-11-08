/* Wefty's own address (1.20): https://wefty.org/. It lived at https://crustyt0es.github.io/wefty/ (1.15 to 1.19) and,
   as Vault, at .../vault/ before that. Both old addresses keep the full app (the PC app updates from the /vault/
   repo) and move people on from there.

   A new site, not just a new path: the browser keeps wefty.org's storage apart from crustyt0es.github.io's, so a
   sign-in, the offline copy and this device's settings don't come along by themselves (1.15's move, inside one site,
   took them along). Loaded first, before every other script (index.html's <head>, not async), on an old address only,
   once the new address answers (its version.json; so a move published before wefty.org is up never strands anyone):
   - a browser tab with nothing to carry (no saved cloud, or a cloud and no sign-in): location.replace() to the same
     page at wefty.org, ?search and #hash exactly as they were (invites, join codes, #connect=, #clip, ?view= and
     ?shared= keep working), with a #connect= link (the cloud and the e-mail, never a password) when there's no hash
     of its own, so the sign-in screen there knows the cloud. sessionStorage "wefty-moved" keeps a page that comes
     straight back within a few seconds where it is (never a loop).
   - a tab that's signed in, and the old installed app (display-mode standalone, as the manifest asks for, or an
     iPhone's navigator.standalone; never "fullscreen", which Chrome says for any tab in a full-screen window):
     `ready` says 'ask', and js/start.js shows the move screen first: one tap hands the sign-in over to a wefty.org
     window it opens (js/start.js's "the move to wefty.org"), or an iPhone icon's Copy my sign-in. "Keep using this one
     for now" opens this one as before (asked every time it opens).
   Never on the PC app (vault://app/) or anywhere else. Tests set window.__weftyMove = { from: [old addresses], to }
   (or { off: true }) in an init script to try it on their own addresses. */
'use strict';

(() => {
  const V = (window.V = window.V || {});
  const FLAG = 'wefty-moved';
  const WAIT = 4000;  // how long the new address gets to answer before the old page just opens as it is
  const BACK_SOON = 10000;  // sent on less than this long ago and back here: something sends it back, so stay
  const given = window.__weftyMove || {};
  const to = given.to || 'https://wefty.org/';
  const olds = [].concat(given.from || ['https://crustyt0es.github.io/vault/', 'https://crustyt0es.github.io/wefty/']);
  const toOrigin = (() => { try { return new URL(to).origin; } catch (error) { return ''; } })();
  const origins = [...new Set(olds.map((base) => { try { return new URL(base).origin; } catch (error) { return ''; } }))]
    .filter(Boolean);

  /* The old address `url` is under (its base), or ''. Never the new one, even when it's under an old one. */
  const baseOf = (url) => {
    const text = String(url);
    if (text.startsWith(to) || text === to.replace(/\/$/, '')) return '';
    return olds.find((base) => text === base.replace(/\/$/, '') || text.startsWith(base)) || '';
  };
  /* The new address for an old one (anything else as it is): for links and QR codes made on an old address. */
  const address = (url) => {
    const base = baseOf(url);
    return !base ? url : String(url) === base.replace(/\/$/, '') ? to : to + String(url).slice(base.length);
  };

  const store = (() => { try { return window.sessionStorage; } catch (error) { return null; } })();
  const read = () => { try { return store ? store.getItem(FLAG) : null; } catch (error) { return null; } };
  const write = (value) => {
    try { if (value === null) store.removeItem(FLAG); else store.setItem(FLAG, value); } catch (error) { /* private */ }
  };
  const kept = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; } };
  const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const here = location.origin + location.pathname;
  const from = baseOf(here);
  const old = !window.VAULT_DESKTOP && !given.off && !!from && !!toOrigin;
  let installed = false;
  try {
    installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch (error) { /* an old browser: a tab */ }

  /* Whether this page has a sign-in to carry over (supabase-js keeps the session under 'vault-auth'). */
  const signedIn = () => {
    const session = kept('vault-auth');
    return !!(session && typeof session.refresh_token === 'string' && session.refresh_token);
  };
  /* A #connect= link for the new address: the saved cloud and e-mail (what the sign-in screen needs), or ''. */
  const connect = () => {
    const saved = kept('vault-config');
    if (!saved || !saved.url || !saved.key) return '';
    const email = saved.email || (kept('vault-user') || {}).email || '';
    return '#connect=' + b64url(JSON.stringify({ u: saved.url, k: saved.key, e: email }));
  };

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
    if (sent && Date.now() - sent < BACK_SOON) {
      write(null);  // sent on a moment ago and back already: open here, as before
    } else {
      ready = up().then((answered) => {
        if (!answered) return 'stay';
        if (installed || signedIn()) return 'ask';
        write(String(Date.now()));
        location.replace(address(here) + location.search + (location.hash || connect()));
        return 'moving';
      }).catch(() => 'stay');  // (whatever goes wrong, the page still opens)
    }
  }

  V.moved = {
    from, olds, origins, to, toOrigin, old, installed, address, ready,
    host: (() => { try { return new URL(to).host; } catch (error) { return to; } })(),
    vault: /\/vault\/$/.test(from),  // the oldest address (the app was called Vault there)
    /* The new address of this very page, ?search and #hash kept: "Open Wefty" on the move screen. */
    target: () => address(location.origin + location.pathname) + location.search + location.hash,
    connect,
  };
})();
