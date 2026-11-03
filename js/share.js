/* Wefty: the Share tab (1.16). Send, Files and Clipboard under one tab, with a switch between them at the top; each
   part is still its own module (js/send.js, js/files.js, js/clips.js) and its own screen id ('send', 'files', 'clips'),
   so everything that opened one still does. Which part you used last is kept on this device; while something sent
   here hasn't been seen yet, the tab opens on Send (its number shows on the tab and on Send's part).

   Files is an extra (1.19; the owner: "toggle off but have available, to keep things clean"): Share shows Send and
   Clipboard until "PC files" is switched on in Settings > Devices, for every device (extra.share_files, through
   V.cloud.changeExtra). An account that never chose but already uses it (files in Wefty Drive, a PC sharing its
   folders, or Files the part this device used last) counts as on; switching off deletes nothing. The PC's own sharing
   (Share > Files > Share this PC, VAULT_PC_FILES) is its own switch, as before.

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

  /* -- Files: on or off (1.19). Switched on or off in Settings (`share_files`); never chosen = on where it's used. */
  function filesOn() {
    const extra = (V.data && V.data.settings && V.data.settings.extra) || {};
    if (typeof extra.share_files === 'boolean') return extra.share_files;
    try {
      if ([...V.data.transfers.values()].some((t) => !t.deleted && !t._purge && t.to_device === 'drive')) return true;
    } catch (error) { /* (no data yet) */ }
    if (V.desktop && V.prefs && V.prefs.pcFiles) return true;
    return stored() === 'files';
  }
  const parts = () => PARTS.filter(([id]) => id !== 'files' || filesOn());
  const shows = (part) => parts().some(([id]) => id === part);

  /* The switch (Settings > Devices): Files in Share on every device. Throws when the cloud couldn't be reached. */
  async function setFiles(on) {
    await V.cloud.changeExtra((extra) => ({ ...extra, share_files: !!on }));
    if (!on && V.tab() === 'files') V.go('send');
  }

  let switching = false;
  /* Settings > Devices' row: the switch, with what it does in one line. */
  function filesRow(ui) {
    const toggle = V.h('input.switch', { type: 'checkbox', checked: filesOn(), disabled: switching, 'aria-label': 'PC files',
      onchange: async (event) => {
        const want = event.target.checked;
        switching = true;
        ui.draw();
        try {
          await setFiles(want);
          if (want) V.toast('Files is in Share now.', { action: 'Open', onAction: () => { remember('files'); V.go('files'); } });
        } catch (error) {
          console.warn('Wefty: Files:', error);
          V.toast('That setting wasn\'t changed: Wefty couldn\'t reach your cloud. Try again in a moment.', { kind: 'err', ms: 5000 });
        } finally {
          switching = false;
          ui.draw();
        }
      } });
    return ui.line('PC files', V.desktop ? 'Adds Files to Share: your phone can open folders you pick on this PC, and Wefty Drive keeps files for every device.'
      : 'Adds Files to Share: open folders on your PC from here, and keep files in Wefty Drive.', toggle, 'pc-files');
  }

  /* The part the Share tab opens on. */
  function last() {
    let unseen = 0;
    try { unseen = V.send && V.send.unseen ? V.send.unseen() : 0; } catch (error) { /* (as kept) */ }
    const kept = stored();
    return unseen > 0 ? 'send' : kept && shows(kept) ? kept : 'send';
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
    const list = parts();
    const keys = (event) => {
      const at = list.findIndex(([id]) => id === part);
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      const next = list[(to + list.length) % list.length][0];
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
    return V.h('div.segmented.share-switch', { role: 'tablist', 'aria-label': 'Share', onkeydown: keys }, list.map(([id, icon, label]) =>
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

  // Switched on or off (here, or on another device): Files comes or goes on the switch showing, which is drawn again
  // in its place (the part's own page stays as it is), and Files isn't left showing once it's off.
  /* An account that never chose but already uses Files (a Wefty Drive file, the PC sharing its folders, Files used
     last on this device) says so for every device once, so its PC and phone agree (and the PC's own words, "Share >
     Files > Share this PC", are true there). Nothing is ever switched on that wasn't already showing. */
  let kept = false;
  function keepUsed() {
    if (kept || !V.cloud || !V.cloud.settingsRead || !V.cloud.settingsRead() || !V.data.user) return;
    const extra = (V.data.settings && V.data.settings.extra) || {};
    if (typeof extra.share_files === 'boolean') { kept = true; return; }
    if (!filesOn()) return;
    kept = true;
    V.cloud.changeExtra((now) => (typeof now.share_files === 'boolean' ? now : { ...now, share_files: true }))
      .catch((error) => { kept = false; console.warn('Wefty: Files:', error); });
  }

  V.on('data', (table) => {
    if (table === 'transfers') keepUsed();
    if (table !== 'settings') return;
    keepUsed();
    if (!shows('files') && V.tab() === 'files') { V.go('send'); return; }
    for (const old of document.querySelectorAll('.view .share-switch')) {
      const part = old.closest('.view').dataset.tab;
      if (old.querySelectorAll('[role=tab]').length !== parts().length && known(part)) old.replaceWith(switcher(part));
    }
  });

  return { PARTS, last, remember, head, subtitle, filesOn, setFiles, filesRow, shows };
})();
