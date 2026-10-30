/* Vault: the Settings tab. The account, connecting the phone (a QR code with the cloud's address and public key,
   never a password), the locked-notes PIN, the PC's own settings (start with Windows, the quick-note keys, the
   clipboard, what arrives and where received files go), a Chromebook's own (js/arrive.js: copying what arrives, a
   folder of Files to save it in), how much of the free space is used, and Vault's own version and updates. */
'use strict';

V.settings = (() => {
  let root = null;

  // Chrome's install offer is kept by util.js (V.install), so the welcome steps can use it too.
  V.on('install', (what) => { if (what === 'done') V.toast('Vault is on your home screen.'); draw(); });

  // On an iPhone or iPad not yet on the home screen, the address carries #connect= while Settings shows (as in the
  // welcome's home screen step), so an icon added from here opens connected; taken out again on leaving Settings.
  let unmark = null;
  V.on('tab', (tab) => { if (tab !== 'settings' && unmark) { unmark(); unmark = null; } });

  const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  V.connectLink = () => {
    const c = V.config || {};
    return `${c.phoneUrl}#connect=${b64url(JSON.stringify({ u: c.url, k: c.key, e: (V.data.user || {}).email || '' }))}`;
  };

  /* A QR code as an SVG drawing (dark squares on white, which every phone camera reads). `label` says what it's for. */
  V.qr = (text, size = 220, label = 'QR code for your phone') => {
    const code = window.qrcode(0, 'M');
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    const quiet = 3;
    const all = count + quiet * 2;
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (code.isDark(r, c)) path += `M${c + quiet},${r + quiet}h1v1h-1z`;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${all} ${all}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const back = document.createElementNS(svg.namespaceURI, 'rect');
    back.setAttribute('width', all); back.setAttribute('height', all); back.setAttribute('fill', '#ffffff');
    const dots = document.createElementNS(svg.namespaceURI, 'path');
    dots.setAttribute('d', path); dots.setAttribute('fill', '#0d0e11');
    svg.append(back, dots);
    return V.h('div.qr', {}, svg);
  };

  const card = (title, ...kids) => V.h('section.card.settings-card', {}, V.h('h2', { text: title }), kids);
  const line = (label, hint, control) => V.h('div.setting', {},
    V.h('div.setting-text', {}, V.h('strong', { text: label }), hint ? V.h('span', { text: hint }) : null), control);

  function toggle(name) {
    return V.h('input.switch', { type: 'checkbox', checked: !!V.prefs[name], 'aria-label': name, onchange: async (event) => {
      V.prefs[name] = event.target.checked;
      try { await V.pc.call('setPref', { name, value: event.target.checked }); } catch (error) { V.problem(error); }
    } });
  }

  async function changePassword() {
    const password = await V.ask('New password', { type: 'password', placeholder: 'At least 8 characters', ok: 'Change it',
      hint: 'Your phone and PC stay signed in. Use the new one next time you sign in.' });
    if (password === null) return;
    if (password.length < 8) return V.toast('At least 8 characters, please.', { kind: 'err' });
    try { await V.cloud.changePassword(password); V.toast('Password changed.'); } catch (error) { V.problem(error); }
  }

  async function signOut() {
    await V.cloud.sync();
    const waiting = await V.cloud.unsent();
    if (waiting) {
      const sure = await V.confirm('Sign out and lose changes?', `${waiting} change${waiting > 1 ? 's' : ''} made here `
        + 'haven\'t reached your cloud yet (are you offline?). Signing out now throws them away. Wait until the dot at '
        + 'the top says Synced to keep them.', { ok: 'Sign out anyway', danger: true });
      if (!sure) return;
      await V.cloud.signOut();
      location.reload();
      return;
    }
    const ok = await V.confirm('Sign out?', V.desktop
      ? `Vault on this PC${V.pc.standalone() ? '' : ' (and Jarvis\'s notes)'} stops until you sign in again. Your notes stay safe in the cloud.`
      : 'Vault on this phone stops until you sign in again. Your notes stay safe in the cloud.', { ok: 'Sign out', danger: true });
    if (!ok) return;
    await V.cloud.signOut();
    location.reload();
  }

  async function pin() {
    if (!V.lock.hasPin()) {
      const made = await V.lock.askPin({ title: 'Locked notes', make: true });
      if (made) { await V.cloud.saveSettings(await V.lock.make(made)); V.toast('PIN set. Lock a note from its lock button.'); draw(); }
      return;
    }
    const old = await V.lock.askPin({ title: 'Your current PIN' });
    if (!old) return;
    const fresh = await V.lock.askPin({ title: 'New PIN', make: true });
    if (!fresh) return;
    const done = await V.lock.rekey(old, fresh, [...V.data.notes.values()]);
    if (!done) return V.toast('That wasn\'t your PIN.', { kind: 'err' });
    for (const note of done.notes) await V.cloud.save('notes', note);
    await V.cloud.saveSettings(done.settings);
    V.toast(`PIN changed${done.notes.length ? ` (${done.notes.length} locked note${done.notes.length > 1 ? 's' : ''} updated)` : ''}.`);
  }

  async function hotkey() {
    const keys = await V.ask('Quick note shortcut', { value: V.prefs.hotkey, placeholder: 'Ctrl+Alt+N', ok: 'Use it',
      hint: 'Ctrl, Alt, Shift or Win, plus a letter, number or F1-F12. It works anywhere on the PC.' });
    if (keys === null || !keys.trim()) return;
    try {
      const answer = await V.pc.call('setPref', { name: 'hotkey', value: keys.trim() });
      V.prefs.hotkey = answer.value || keys.trim();
      V.toast(`Quick note is now ${V.prefs.hotkey}`);
      draw();
    } catch (error) { V.problem(error); }
  }

  function phoneCard() {
    if (!V.desktop) {
      const phone = V.device === 'phone';
      const how = V.welcome.howToInstall();
      let install;
      if (V.install.installed()) {
        install = line(phone ? 'On your home screen' : 'Installed as an app', 'Vault is installed.', null);
      } else if (V.install.ready()) {
        install = line('Install Vault', V.deviceKind.android ? 'Puts it on your home screen like any app, and lets you share to it.'
          : 'Puts it with your other apps, so it opens in its own window.',
        V.button('Install', { kind: 'primary', icon: 'download', onClick: async () => { await V.install.ask(); draw(); } }));
      } else {
        const ios = how.kind === 'ios';
        if (ios && !unmark) unmark = V.welcome.markConnect();
        install = V.h('div.setting.install-how', {}, V.h('div.setting-text', {},
          V.h('strong', { text: phone ? 'Put it on your home screen' : 'Install as an app' }),
          V.h('ol.steps', {}, how.steps.map((step) => V.h('li', { text: step }))),
          how.note ? V.h('span', { text: how.note }) : null,
          // (Its icon starts with nothing of Safari's: the link it connects with, as the welcome's step offers it.)
          ios ? V.welcome.iosIcon((V.data.user || {}).email || 'your e-mail') : null));
      }
      return card(phone ? `This ${V.deviceKind.ios ? V.deviceKind.model : 'phone'}` : V.deviceKind.chromebook ? 'This Chromebook' : 'This browser',
        V.send.deviceSetting(),  // which device this is (js/send.js)
        install,
        line('Connected to', (V.config || {}).url ? new URL(V.config.url).host : '', null));
    }
    const link = V.connectLink();
    return card('Connect your phone',
      V.h('div.connect', {},
        V.qr(link),
        V.h('ol.steps', {},
          V.h('li', { text: 'Point your phone\'s camera at the code and tap the link it shows (on Android, Google Lens reads it too).' }),
          V.h('li', { text: 'Vault opens (in Chrome on Android, Safari on an iPhone). Sign in with your e-mail and your Vault password.' }),
          V.h('li', { text: 'Put it on the home screen: on Android, Install (or Chrome\'s ⋮ menu > Add to Home screen), and then photos can be shared straight to your PC; on an iPhone, in Safari\'s Vault, Settings > This iPhone > Copy the sign-in link, add Vault to the Home Screen, then open the icon, tap Paste the link and sign in once.' }))),
      V.h('div.setting-buttons', {},
        V.button('Copy the link', { icon: 'copy', onClick: async () => { await V.copy(link); V.toast('Copied. E-mail it to yourself and open it on the phone.'); } })));
  }

  /* Light, dark, or as the phone (or Windows) is set: each device keeps its own (V.theme). */
  function appearanceCard() {
    const pick = V.h('div.segmented', { role: 'radiogroup', 'aria-label': 'Theme' },
      [['system', 'System', V.desktop ? 'pc' : 'phone'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([value, label, icon]) =>
        V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(V.theme.choice() === value), dataset: { theme: value },
          onclick: () => { V.theme.set(value); draw(); } }, V.icon(icon), V.h('span', { text: label }))));
    return card('Appearance', line('Theme', V.desktop ? 'System follows Windows. Just for this PC.'
      : 'System follows this phone (or Chromebook). Each device keeps its own.', pick));
  }

  function pcCard() {
    if (!V.desktop || !V.prefs) return null;
    return card('This PC',
      line('Start Vault with Windows', 'Quietly, in the tray, so files and the clipboard always come through.', toggle('autostart')),
      line('Quick note', `Press ${V.prefs.hotkey} anywhere for a little note box.`, V.button('Change', { onClick: hotkey })),
      line('Share what I copy', 'Text only; never passwords, keys or what password managers hide.', toggle('clipboardShare')),
      line('Copy what my phone shares', 'Onto this PC\'s clipboard as it arrives.', toggle('clipboardReceive')),
      // What's sent with Send (js/send.js): on the clipboard, and a card at the corner (a PC app new enough).
      V.pc.can('copyArrival') && 'copyArrivals' in V.prefs ? line('Copy what arrives',
        'Pictures, files, links and words sent to this PC go on its clipboard, ready to paste.', toggle('copyArrivals')) : null,
      V.pc.can('showArrival') && 'arrivalPreview' in V.prefs ? line('Show what arrives',
        'A small card with the picture, at the corner of the screen.', toggle('arrivalPreview')) : null,
      line('Files from your phone go to', V.prefs.downloads, V.h('div.setting-buttons', {},
        V.button('Open', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: V.prefs.downloads }).catch(V.problem) }),
        V.button('Change', { onClick: async () => {
          try { const answer = await V.pc.call('pickFolder'); if (answer.path) { V.prefs.downloads = answer.path; draw(); } } catch (error) { V.problem(error); }
        } }))));
  }

  /* Vault's own version and its updates (js/update.js): Vault is an app of its own, updated apart from Jarvis. */
  let checking = false;
  let lastAnswer = null;

  async function checkNow() {
    checking = true;
    lastAnswer = null;
    draw();
    try {
      lastAnswer = await V.update.check();
    } finally {
      checking = false;
      draw();
    }
  }

  function aboutCard() {
    const now = V.update.state();
    const answer = lastAnswer || {};
    const said = checking ? 'Checking...'
      : answer.state === 'error' ? `Couldn't check: ${answer.message || 'try again later'}`
        : answer.state === 'current' && !now.ready ? 'Vault is up to date.'
          : now.checked ? `Last checked ${V.ago(now.checked)}` : 'Not checked yet';
    return card('About Vault',
      line(`Vault ${now.version}`, said, now.canCheck ? V.button('Check for updates', {
        icon: 'restore', disabled: checking, onClick: checkNow }) : null),
      now.ready ? line(/^\d/.test(now.ready) ? `Vault ${now.ready} is ready` : 'An update is ready',
        'It switches over by itself next time Vault is in the background, or now.',
        V.button('Update now', { kind: 'primary', icon: 'download', onClick: () => V.update.now() })) : null,
      now.needsShell ? line(`Vault ${now.needsShell} needs the PC part updated`,
        V.pc.howToUpdate(), null) : null,
      V.h('div.setting-buttons', {},
        V.button('What\'s new', { onClick: () => V.update.whatsNew() }),
        now.downloaded ? V.button('Use the built-in copy', { kind: 'danger-quiet', onClick: async () => {
          const sure = await V.confirm('Use the built-in copy?', 'Vault goes back to the version installed on this PC '
            + 'and skips this update. A newer update still comes when there is one.', { ok: 'Go back' });
          if (sure) V.update.useBuiltIn().catch(V.problem);
        } }) : null));
  }

  function draw() {
    // The view is shared by every tab: drawing while another tab shows put Settings over it ("it keeps going back to
    // Settings").
    if (!root || !root.isConnected || root.dataset.tab !== 'settings') return;
    const kept = keepTyping();
    const user = V.data.user || {};
    const status = { synced: 'Up to date', syncing: 'Syncing...', offline: 'Offline: changes wait on this device',
      error: 'Having trouble reaching the cloud', asleep: 'Your free cloud is asleep (tap the red dot at the top)',
      'signed-out': 'Signed out', idle: '' }[V.cloud.status] || '';
    V.clear(root, V.h('div.page.settings', {},
      V.h('div.page-head', {}, V.h('h1', { text: 'Settings' }), V.statusPill()),
      card('Your account',
        line(user.email || 'Signed in', user.invited ? 'Your notes, files and clipboard are yours alone: nobody else using Vault can see them.'
          : 'Your notes, files and clipboard are only in your own cloud.', null),
        // (Always here for a friend, so those who joined before the owner's Stats existed are told too.)
        user.invited ? V.h('p.hint.account-stats', { text: `Whoever runs this Vault's cloud can see what's stored in it. ${V.welcome.STATS_WORDS}` }) : null,
        V.h('div.setting-buttons', {},
          V.button('Change password', { onClick: changePassword }),
          V.button('Sign out', { kind: 'danger-quiet', onClick: signOut }))),
      phoneCard(),
      V.arrive ? V.arrive.card({ card, line, toggle, draw }) : null,  // js/arrive.js: a Chromebook's copying and saving
      appearanceCard(),
      card('Locked notes',
        line(V.lock.hasPin() ? 'Your PIN is set' : 'No PIN yet',
          'Locked notes are scrambled on your device with your PIN. If you forget it, they can\'t be opened, by anyone.',
          V.button(V.lock.hasPin() ? 'Change PIN' : 'Set a PIN', { icon: 'lock', onClick: pin }))),
      pcCard(),
      card('Sync',
        line(status, V.cloud.live ? 'Changes arrive the moment they\'re made.' : 'Checking for changes every 20 seconds.',
          V.button('Sync now', { icon: 'restore', onClick: () => V.cloud.sync() }))),
      V.backup ? V.backup.card({ card, line, toggle, draw }) : null,  // js/history.js
      V.attachSearch ? V.attachSearch.card({ card, line, toggle, draw }) : null,  // js/attachsearch.js
      V.ai ? V.ai.card({ card, line, toggle, draw }) : null,  // js/ai.js
      V.invites ? V.invites.card({ card, line, toggle, draw }) : null,  // js/access.js
      V.invites ? V.invites.statsCard({ card, line, toggle, draw }) : null,  // js/access.js: the owner's Stats
      V.feedback ? V.feedback.card({ card, line, toggle, draw }) : null,  // js/access.js
      aboutCard()));
    kept();
  }

  /* Settings is drawn again whenever its data changes (another device's switch, this device noting itself for the
     owner's Stats a few seconds after opening), so what's being typed in a box (a Gemini key, a name) would lose its
     words and its caret: kept and put back, by the box's label. Returns the putting back. */
  function keepTyping() {
    const label = (el) => el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    const boxes = [...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea')]
      .filter((el) => label(el) && el.value).map((el) => ({ name: label(el), value: el.value }));
    const now = document.activeElement;
    const focused = now && root.contains(now) && /^(INPUT|TEXTAREA)$/.test(now.tagName) && label(now)
      ? { name: label(now), start: now.selectionStart, end: now.selectionEnd } : null;
    const scroll = root.scrollTop;
    return () => {
      const find = (name) => [...root.querySelectorAll('input, textarea')].find((el) => label(el) === name);
      for (const box of boxes) {
        const el = find(box.name);
        if (el && !el.value) el.value = box.value;
      }
      root.scrollTop = scroll;
      if (!focused) return;
      const el = find(focused.name);
      if (!el) return;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(focused.start, focused.end); } catch (error) { /* (a box that has no caret) */ }
    };
  }

  V.on('status', () => draw());
  V.on('update', () => draw());
  V.on('ai', () => draw());
  V.on('data', (table) => { if (table === 'settings') draw(); });

  return { render: (container) => { root = container; draw(); } };
})();
