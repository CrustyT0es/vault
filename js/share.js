/* Wefty: the Share tab (1.16). Send, Files and Clipboard under one tab, with a switch between them at the top; each
   part is still its own module (js/send.js, js/files.js, js/clips.js) and its own screen id ('send', 'files', 'clips'),
   so everything that opened one still does. Which part you used last is kept on this device; while something sent
   here hasn't been seen yet, the tab opens on Send (its number shows on the tab and on Send's part).

   Loaded before js/start.js. If it fails, the three parts still open (from Share, which falls back to Send) with a
   plain header. */
'use strict';

V.share = (() => {
  const PARTS = [['send', 'send', 'Send'], ['files', 'folder', 'Files'], ['clips', 'clip', 'Clipboard']];
  const KEPT = 'vault-share-part';  // localStorage: the part used last on this device
  const known = (part) => PARTS.some(([id]) => id === part);

  function stored() {
    try { const part = localStorage.getItem(KEPT); return known(part) ? part : ''; } catch (error) { return ''; }
  }
  function remember(part) {
    if (!known(part)) return;
    try { localStorage.setItem(KEPT, part); } catch (error) { /* (a private window: Send next time) */ }
  }

  /* The part the Share tab opens on. */
  function last() {
    let unseen = 0;
    try { unseen = V.send && V.send.unseen ? V.send.unseen() : 0; } catch (error) { /* (as kept) */ }
    return unseen > 0 ? 'send' : stored() || 'send';
  }

  /* "Between your phone, PC and Chromebook.": the devices in the account (js/profile.js reads the same records). */
  function subtitle() {
    let line = '';
    try { line = V.profile && V.profile.devicesLine ? V.profile.devicesLine() : ''; } catch (error) { /* (said plainly) */ }
    if (!line || /^This /.test(line)) return 'Between your devices.';
    return `Between your ${line.replace(/\bPhone\b/, 'phone').replace(/\bBrowser\b/, 'browser')}.`;
  }

  function unseenNow() {
    try { return V.send && V.send.unseen ? V.send.unseen() : 0; } catch (error) { return 0; }
  }

  /* The switch: Send · Files · Clipboard. Each button opens its part (and is remembered). */
  function switcher(part) {
    const count = unseenNow();
    const pick = (id) => { remember(id); if (V.tab() !== id) V.go(id); };
    // (a tab list: the picked part is the one Tab stops on, and the arrow keys, Home and End move between them)
    const keys = (event) => {
      const at = PARTS.findIndex(([id]) => id === part);
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: PARTS.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      const next = PARTS[(to + PARTS.length) % PARTS.length][0];
      pick(next);
      const button = document.querySelector(`.view[data-tab=${next}] .share-switch [data-part=${next}]`);
      if (button) button.focus();
    };
    // A part drawn again while the keyboard was on the switch (Files redraws its whole page once it has looked for
    // your PC): the keyboard stays on the switch, not thrown back to the top of the page.
    const had = document.activeElement;
    if (had && had.closest && had.closest('.share-switch')) {
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        const button = document.querySelector(`.view[data-tab=${part}] .share-switch [data-part=${part}]`);
        if (button) button.focus({ preventScroll: true });
      });
    }
    return V.h('div.segmented.share-switch', { role: 'tablist', 'aria-label': 'Share', onkeydown: keys }, PARTS.map(([id, icon, label]) =>
      V.h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === part), tabindex: id === part ? '0' : '-1',
        'aria-label': id === 'send' && count ? `${label}, ${count} new` : null, dataset: { part: id }, onclick: () => pick(id) },
      V.icon(icon), V.h('span.share-label', { text: label }),
      id === 'send' ? V.h('span.badge.share-badge', { text: count ? String(count) : '', hidden: !count, 'aria-hidden': 'true' }) : null)));
  }

  /* The top of each part: "Share", the line under it, your picture, then the switch. */
  function head(part) {
    remember(part);
    return [V.appHead({ title: 'Share', sub: subtitle(), cls: 'share-head' }), switcher(part)];
  }

  // Send's number on its part follows the tab's (something arrived, or was seen).
  V.on('badge', () => {
    const count = unseenNow();
    for (const dot of document.querySelectorAll('.share-switch .share-badge')) {
      dot.textContent = count ? String(count) : '';
      dot.hidden = !count;
      const button = dot.closest('button');
      if (button) {
        if (count) button.setAttribute('aria-label', `Send, ${count} new`);
        else button.removeAttribute('aria-label');
      }
    }
  });

  return { PARTS, last, remember, head, subtitle };
})();
