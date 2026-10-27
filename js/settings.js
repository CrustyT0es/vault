/* Vault: the Settings tab. The account, connecting the phone (a QR code with the cloud's address and public key,
   never a password), the locked-notes PIN, the PC's own settings (start with Windows, the quick-note keys, the
   clipboard, where received files go) and how much of the free space is used. */
'use strict';

V.settings = (() => {
  let root = null;
  let installPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; draw(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; V.toast('Vault is on your home screen.'); draw(); });

  const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  V.connectLink = () => {
    const c = V.config || {};
    return `${c.phoneUrl}#connect=${b64url(JSON.stringify({ u: c.url, k: c.key, e: (V.data.user || {}).email || '' }))}`;
  };

  /* A QR code as an SVG drawing (dark squares on white, which every phone camera reads). */
  V.qr = (text, size = 220) => {
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
    svg.setAttribute('aria-label', 'QR code for your phone');
    const back = document.createElementNS(svg.namespaceURI, 'rect');
    back.setAttribute('width', all); back.setAttribute('height', all); back.setAttribute('fill', '#ffffff');
    const dots = document.createElementNS(svg.namespaceURI, 'path');
    dots.setAttribute('d', path); dots.setAttribute('fill', '#0a101b');
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
      ? 'Vault on this PC (and Jarvis\'s notes) stops until you sign in again. Your notes stay safe in the cloud.'
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
      return card('This phone',
        installPrompt ? line('Install Vault', 'Puts it on your home screen like any app, and lets you share to it.',
          V.button('Install', { kind: 'primary', icon: 'download', onClick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; draw(); } }))
          : line('On your home screen', window.matchMedia('(display-mode: standalone)').matches ? 'Vault is installed.'
            : 'In Chrome: the ⋮ menu > Add to Home screen > Install.', null),
        line('Connected to', (V.config || {}).url ? new URL(V.config.url).host : '', null));
    }
    const link = V.connectLink();
    return card('Connect your phone',
      V.h('div.connect', {},
        V.qr(link),
        V.h('ol.steps', {},
          V.h('li', { text: 'Point your Android phone\'s camera at the code and tap the link (or open the Google Lens app).' }),
          V.h('li', { text: 'Vault opens in Chrome. Sign in with your e-mail and your Vault password.' }),
          V.h('li', { text: 'Tap Install (or Chrome\'s ⋮ menu > Add to Home screen). Now photos can be shared straight to your PC.' }))),
      V.h('div.setting-buttons', {},
        V.button('Copy the link', { icon: 'copy', onClick: async () => { await V.copy(link); V.toast('Copied. E-mail it to yourself and open it on the phone.'); } })));
  }

  function pcCard() {
    if (!V.desktop || !V.prefs) return null;
    return card('This PC',
      line('Start Vault with Windows', 'Quietly, in the tray, so files and the clipboard always come through.', toggle('autostart')),
      line('Quick note', `Press ${V.prefs.hotkey} anywhere for a little note box.`, V.button('Change', { onClick: hotkey })),
      line('Share what I copy', 'Text only; never passwords, keys or what password managers hide.', toggle('clipboardShare')),
      line('Copy what my phone shares', 'Onto this PC\'s clipboard as it arrives.', toggle('clipboardReceive')),
      line('Files from your phone go to', V.prefs.downloads, V.h('div.setting-buttons', {},
        V.button('Open', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: V.prefs.downloads }).catch(V.problem) }),
        V.button('Change', { onClick: async () => {
          try { const answer = await V.pc.call('pickFolder'); if (answer.path) { V.prefs.downloads = answer.path; draw(); } } catch (error) { V.problem(error); }
        } }))));
  }

  function draw() {
    // The view is shared by every tab: drawing while another tab shows put Settings over it ("it keeps going back to
    // Settings").
    if (!root || !root.isConnected || root.dataset.tab !== 'settings') return;
    const user = V.data.user || {};
    const status = { synced: 'Up to date', syncing: 'Syncing...', offline: 'Offline: changes wait on this device',
      error: 'Having trouble reaching the cloud', asleep: 'Your free cloud is asleep (tap the red dot at the top)',
      'signed-out': 'Signed out', idle: '' }[V.cloud.status] || '';
    V.clear(root, V.h('div.page.settings', {},
      V.h('h1', { text: 'Settings' }),
      card('Your account',
        line(user.email || 'Signed in', 'Your notes, files and clipboard are only in your own cloud.', null),
        V.h('div.setting-buttons', {},
          V.button('Change password', { onClick: changePassword }),
          V.button('Sign out', { kind: 'danger-quiet', onClick: signOut }))),
      phoneCard(),
      card('Locked notes',
        line(V.lock.hasPin() ? 'Your PIN is set' : 'No PIN yet',
          'Locked notes are scrambled on your device with your PIN. If you forget it, they can\'t be opened, by anyone.',
          V.button(V.lock.hasPin() ? 'Change PIN' : 'Set a PIN', { icon: 'lock', onClick: pin }))),
      pcCard(),
      card('Sync',
        line(status, V.cloud.live ? 'Changes arrive the moment they\'re made.' : 'Checking for changes every 20 seconds.',
          V.button('Sync now', { icon: 'restore', onClick: () => V.cloud.sync() }))),
      V.h('p.about', { text: `Vault ${V.VERSION} · made for you by Jarvis` })));
  }

  V.on('status', () => draw());
  V.on('data', (table) => { if (table === 'settings') draw(); });

  return { render: (container) => { root = container; draw(); } };
})();
