/* Wefty: Settings' pages and what each one's line on the home says (1.16). Seven categories: Account, Appearance, AI,
   Devices, Notes & files, Friends (the owner's) and About & feedback. Each page is built from rows (settings' own:
   the account, connecting a phone or computer, the theme and reading aids, the locked-notes PIN, the PC's own
   settings, the version) and the other modules' rows, placed in its sections and its More options (1.16, D2: js/ai.js
   and js/access.js give a page's { parts, more, says }; js/news.js, js/history.js, js/attachsearch.js and
   js/arrive.js give rows). js/settingsui.js draws them: the home with its search, a page at a time on a
   phone, both side by side from 900 px, and More options. Without js/settingsui.js (it didn't load), every page is
   drawn one after the other, as 1.15's one list of cards was. */
'use strict';

V.settings = (() => {
  let root = null;

  // Chrome's install offer is kept by util.js (V.install), so the welcome steps can use it too.
  V.on('install', (what) => { if (what === 'done') V.toast('Wefty is on your home screen.'); draw(); });

  // On an iPhone or iPad not yet on the home screen, the address carries #connect= while Devices shows (as in the
  // welcome's home screen step), so an icon added from here opens connected; taken out again on leaving it.
  let unmark = null;
  const dropMark = () => { if (unmark) { unmark(); unmark = null; } };
  V.on('tab', (tab) => { if (tab !== 'settings') dropMark(); });

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

  /* -- the pieces every page is made of (js/settingsui.js gives the real ones; these are its plain stand-ins) */

  const slug = (text) => String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const plainUi = {
    card: (title, ...kids) => V.h('section.card.settings-card', { dataset: { setting: slug(title) } }, title ? V.h('h2', { text: title }) : null, kids),
    line: (label, hint, control, key) => V.h('div.setting', { dataset: { setting: key || slug(label) } },
      V.h('div.setting-text', {}, V.h('strong', { text: label }), hint ? V.h('span', { text: hint }) : null), control),
    toggle: (name) => toggle(name),
    more: (summary, rows) => rows,
    lift: (row) => row,
    draw: () => draw(),
  };
  const draw = () => V.settings.draw();
  /* A module's page part ({ parts, more, says }: js/ai.js, js/access.js) as sections, with its More options. */
  const built = (ui, part) => (part ? [part.parts, part.more && part.more.length ? ui.more(part.says, part.more) : null] : null);
  const word = () => (V.desktop ? 'PC' : V.device === 'phone' ? (V.deviceKind.ios ? V.deviceKind.model : 'phone')
    : V.deviceKind.chromebook ? 'Chromebook' : 'browser');
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

  function toggle(name, after) {
    return V.h('input.switch', { type: 'checkbox', checked: !!V.prefs[name], 'aria-label': name, onchange: async (event) => {
      V.prefs[name] = event.target.checked;
      try { await V.pc.call('setPref', { name, value: event.target.checked }); } catch (error) { V.problem(error); }
      if (after) after();
    } });
  }

  /* -- Account */

  /* (1.22.5, SEC-07) "Is it you?": the box (or, asked for, the e-mailed code) a sheet adds before something that can't
     be undone. { el, filled(), prove() }: prove() resolves true once the cloud says it's them, else says why in
     `problem` and resolves false. */
  function itsYou(problem, { label = 'Your Wefty password', changed = () => {} } = {}) {
    const box = V.h('input.field.itsyou-password', { type: 'password', autocomplete: 'current-password', 'aria-label': label });
    const code = V.h('input.field.itsyou-code', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '10', 'aria-label': 'Code from the e-mail' });
    const codeRow = V.h('label.label.itsyou-code-row', { hidden: true }, 'Code from the e-mail', code);
    let byCode = false;
    const ask = V.desktop ? null : V.h('button.link-btn.itsyou-email', { type: 'button',
      text: 'No password (signed up with Google), or forgot it? E-mail me a code', onclick: async () => {
        problem.textContent = '';
        ask.disabled = true;
        try {
          const email = await V.cloud.sendCheckCode();
          byCode = true;
          passRow.hidden = true;
          codeRow.hidden = false;
          ask.hidden = true;
          problem.textContent = '';
          V.toast(`Sent a code to ${email}.`);
          requestAnimationFrame(() => code.focus());
        } catch (error) {
          problem.textContent = error.message || String(error);
        } finally {
          ask.disabled = false;
          changed();
        }
      } });
    const passRow = V.h('label.label.itsyou-password-row', {}, label, box);
    for (const input of [box, code]) input.addEventListener('input', () => { problem.textContent = ''; changed(); });
    return {
      el: V.h('div.itsyou', {}, passRow, codeRow, ask),
      filled: () => (byCode ? code.value.replace(/\D/g, '').length >= 6 : box.value.length > 0),
      // (the password typed, for a change of password: a cloud that asks for the one now gets it; '' by code)
      password: () => (byCode ? '' : box.value),
      focus: () => (byCode ? code : box).focus(),
      async prove() {
        if (!navigator.onLine) { problem.textContent = 'You\'re offline. Connect to the internet, then try again.'; return false; }
        try {
          return byCode ? await V.cloud.checkCode(code.value) : await V.cloud.checkPassword(box.value);
        } catch (error) {
          problem.textContent = error.message || String(error);
          (byCode ? code : box).select();
          return false;
        }
      },
    };
  }

  /* A new password: the one there now first (or a code by e-mail), then the new one twice (1.22.5). */
  function changePassword() {
    const problem = V.h('p.error-text.password-problem', { role: 'alert' });
    const fresh = V.h('input.field.password-new', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters',
      'aria-label': 'New password' });
    const again = V.h('input.field.password-again', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Type the new one again' });
    const now = itsYou(problem, { label: 'Your password now' });
    let busy = false;
    V.sheet({
      title: 'Change password',
      content: V.h('div.change-password', {}, now.el,
        V.h('label.label', {}, 'New password', fresh), V.h('label.label', {}, 'Type the new one again', again),
        V.h('p.hint', { text: 'Use the new one next time you sign in.' }), problem),
      actions: [{ label: 'Cancel' }, { label: 'Change it', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        // (Only the cloud can change it: offline, that's said first, with its Help card, as before 1.22.5.)
        if (!navigator.onLine) {
          V.problem(Object.assign(new Error('You\'re offline. Connect to the internet, then change your password.'),
            { kind: 'offline' }));
          return true;
        }
        if (!now.filled()) { problem.textContent = 'Type the password you have now first.'; now.focus(); return true; }
        if (fresh.value.length < 8) { problem.textContent = 'Pick a new password of at least 8 characters.'; fresh.focus(); return true; }
        if (fresh.value !== again.value) { problem.textContent = 'The two new passwords aren\'t the same.'; again.focus(); return true; }
        busy = true;
        try {
          if (!(await now.prove())) return true;
          await V.cloud.changePassword(fresh.value, { current: now.password() });
          V.toast('Password changed.');
          return false;
        } catch (error) {
          problem.textContent = error.message || String(error);
          return true;
        } finally {
          busy = false;
        }
      } }],
    });
  }

  async function signOut() {
    // The note-taker listening (its screen hidden, say): stopped first, so what it heard is saved and goes up too.
    let asked = false;
    if (V.notetaker && V.notetaker.listening()) {
      const stop = await V.confirm('Stop listening and sign out?', 'The note-taker is listening. What it heard is saved '
        + 'in its note first.', { ok: 'Stop and sign out', danger: true });
      if (!stop) return;
      asked = true;
      await V.notetaker.stopQuietly();
    }
    await V.cloud.sync();
    const parts = await V.cloud.unsentParts();
    if (Object.values(parts).some(Boolean)) {
      // (the review of 1.22.5: everything only this device has is named, as forgetHere wipes it all)
      const sure = await V.confirm('Sign out and lose changes?', lossWords(parts),
        { ok: 'Sign out anyway', danger: true });
      if (!sure) return;
      if (V.push) await V.push.beforeSignOut();  // (this device's notifications off first: never the next person's)
      await V.cloud.signOut();
      await forgetHere();  // (1.22.5, SEC-17: nothing of theirs stays for the next person here)
      location.reload();
      return;
    }
    const ok = asked || await V.confirm('Sign out?', V.desktop
      ? `Wefty on this PC${V.pc.standalone() ? '' : ' (and Jarvis\'s notes)'} stops until you sign in again. Your notes stay safe in the cloud.`
      : 'Wefty on this phone stops until you sign in again. Your notes stay safe in the cloud.', { ok: 'Sign out', danger: true });
    if (!ok) return;
    if (V.push) await V.push.beforeSignOut();
    await V.cloud.signOut();
    // (1.22.5, SEC-17) Everything Wefty kept here for them goes, as when an account is deleted: their recordings
    // waiting to be written down, their classes, what they'd seen... Only the cloud and the device's own look stay.
    await forgetHere();
    location.reload();
  }

  /* What signing out now would throw away, in words (V.cloud.unsentParts): changes not in the cloud yet, the
     note-taker's recordings, chat messages waiting to send, a drawing not saved and History copies, all only here. */
  function lossWords(parts) {
    const { changes = 0, recordings = 0, chats = 0, drawing = 0, history = 0 } = parts || {};
    const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const lost = changes > 0 ? `${s(changes, 'change', 'changes')} made here haven't reached your cloud yet (are you `
      + 'offline?).' : '';
    const only = [];
    if (recordings) only.push(recordings === 1 ? 'a recording from the note-taker' : `${recordings} recordings from the note-taker`);
    if (chats) only.push(chats === 1 ? 'a chat message waiting to send' : `${chats} chat messages waiting to send`);
    if (drawing) only.push('a drawing you haven\'t saved');
    if (history) only.push(history === 1 ? 'a History copy of a note' : `${history} History copies of notes`);
    if (!only.length) return `${lost} Signing out now throws them away. Wait until your picture at the top has no dot to keep them.`;
    const list = only.length === 1 ? only[0] : `${only.slice(0, -1).join(', ')} and ${only[only.length - 1]}`;
    const whole = list.charAt(0).toUpperCase() + list.slice(1);
    const many = only.length > 1 || /^\d/.test(list);
    return [lost, `${whole} ${many ? 'are' : 'is'} still only on this device${lost ? ' too' : ''}.`,
      `Signing out now throws ${many || lost ? 'them' : 'it'} away.`,
      `Keep Wefty open and online until ${lost ? 'your picture at the top has no dot and ' : ''}`
        + `${recordings ? (recordings === 1 ? 'the recording is in its note' : 'the recordings are in their notes') : 'they\'ve gone up'}`
        + `${drawing ? ', and save the drawing' : ''}.`].filter(Boolean).join(' ');
  }

  // How syncing goes, in words: { said, urgent (it needs the person: lifted out of More options), short (the home) }.
  function syncing() {
    const held = V.cloud.held || 0;
    const pinned = V.cloud.waitingPin || 0;  // (1.22.5: locked on another device meanwhile: they wait for the PIN here)
    const state = V.cloud.status;
    const said = { synced: 'Up to date', syncing: 'Syncing...', offline: 'Offline: changes wait on this device',
      held: pinned ? `${plural(pinned, 'note')} locked on your other device: your changes go up once you type your PIN `
        + '(tap your picture)' : `${plural(held || 1, 'note')} too big to sync: they're safe here until they're shorter`,
      error: 'Having trouble reaching the cloud', asleep: 'Your free cloud is asleep (tap your picture for what to do)',
      'signed-out': 'Signed out', idle: 'Up to date' }[state] || '';
    const short = { synced: 'Synced', idle: 'Synced', syncing: 'Syncing...', offline: 'Offline: changes wait here',
      held: `${plural((held + pinned) || 1, 'note')} not synced`, error: 'Can\'t reach your cloud', asleep: 'Your cloud is asleep',
      'signed-out': 'Signed out' }[state] || '';
    return { said, short, urgent: ['held', 'error', 'asleep', 'signed-out'].includes(state), warn: state === 'offline' };
  }

  async function syncNow() {
    if (V.cloud.status === 'signed-out') { V.toast('Sign in again to sync.'); return; }
    try {
      await V.cloud.sync();
      V.toast(syncing().said || 'Synced');
    } catch (error) {
      V.problem(error);
    }
  }

  /* -- Your data (1.21): Export everything (the same ZIP as Notes & files' Download everything) and Delete my account. */

  async function exportEverything() {
    if (V.chat) await V.chat.refresh().catch(() => {});  // the chats from the other devices too
    try { V.backup.download(); } catch (error) { V.problem(error); }
  }

  const NOT_DELETED = {
    offline: 'You\'re offline, so nothing was deleted. Try again when you\'re back online.',
    unreachable: 'Wefty couldn\'t reach your cloud, so nothing was deleted. Try again in a minute.',
    owner: 'You run this Wefty cloud, so your account can\'t be deleted here.',
    // (V.TEAM_EMAIL is js/profile.js's, loaded after this: asked for when it's said)
    get helper() { return `This Wefty cloud can't delete accounts by itself yet. Ask whoever runs your Wefty cloud to delete it (${V.TEAM_EMAIL}).`; },
    confirm: 'That isn\'t the e-mail you sign in with. Type it as it shows above.',
    signedOut: 'Wefty here got signed out, so nothing was deleted. Sign in again, then try again.',
  };

  /* Which of NOT_DELETED an error from delete-me is ('' for one with words of its own). A helper older than 1.21's
     doesn't know delete-me: it answers 400 "unknown" to the owner, 403 "not_owner" to anyone else, and a cloud with
     no helper at all answers 404 (which a browser sees as a request that failed: told apart by the cloud's own health
     check, V.pair.reaches). */
  async function whyNotDeleted(error) {
    const code = String((error && (error.code || error.kind)) || '');
    const status = (error && error.status) || 0;
    if (code === 'offline' || !navigator.onLine) return 'offline';
    if (code === 'signed-out' || code === 'signed_out' || status === 401) return 'signedOut';
    if (code === 'owner') return 'owner';
    if (code === 'confirm') return 'confirm';
    if (code === 'not_owner' || code === 'unknown' || code === 'missing' || code === 'old' || code === 'not_set_up'
      || status === 404) return 'helper';
    if (!status && !V.desktop) return (V.pair && await V.pair.reaches(V.config)) ? 'helper' : 'unreachable';
    return '';
  }

  /* The person's account, everything in it and this device's copy, gone: the helper (with their own sign-in) or the
     PC part does it, then this device forgets them and says goodbye. The owner never gets here (their row says why). */
  function deleteSheet() {
    const email = String((V.data.user || {}).email || '');
    const problem = V.h('p.error-text.delete-problem', { role: 'alert' });
    // (1.22.5, SEC-07) The account's password again (or a code by e-mail), never just the e-mail the sheet shows: anyone
    // holding an unlocked phone could type that.
    let go = null;
    let busy = false;
    const proof = itsYou(problem, { label: 'Type your Wefty password to confirm', changed: () => {
      if (go && !busy) go.disabled = !proof.filled();
    } });
    const sheet = V.sheet({
      title: 'Delete my account',
      content: V.h('div.delete-account', {},
        V.h('p.delete-what', { text: 'This deletes every note, folder, file, chat and setting, and this account, on every device, '
          + 'for good. Nobody can bring them back.' }),
        V.h('div.setting-buttons', {}, V.button('Export everything first', { icon: 'download', onClick: exportEverything })),
        V.h('p.delete-who', { text: `Signed in as ${email}.` }),
        proof.el,
        problem),
      actions: [{ label: 'Cancel' }, { label: 'Delete my account forever', kind: 'danger', icon: 'trash', onClick: async () => {
        if (busy || !proof.filled() || !email) return true;
        problem.textContent = '';
        if (!navigator.onLine) { problem.textContent = NOT_DELETED.offline; return true; }
        busy = true;
        go.disabled = true;
        go.lastChild.textContent = 'Checking...';
        const again = () => {
          busy = false;
          go.disabled = !proof.filled();
          go.lastChild.textContent = 'Delete my account forever';
        };
        if (!(await proof.prove())) { again(); return true; }
        go.lastChild.textContent = 'Deleting...';
        try {
          if (V.desktop) {
            if (!V.pc.can('deleteMe')) throw Object.assign(new Error(V.pc.howToUpdate()), { kind: 'pc' });
            await V.pc.call('deleteMe', { confirm: email });
          } else {
            await V.invites.helperCall('delete-me', { confirm: email });
          }
        } catch (error) {
          const why = await whyNotDeleted(error);
          problem.textContent = why ? NOT_DELETED[why] : (error && error.message) || String(error);
          again();
          return true;
        }
        sheet.close();
        await forgetHere();
        goodbye();
        return false;
      } }],
    });
    go = sheet.el.querySelector('.sheet-actions .btn.danger');
    go.disabled = true;
    return sheet;
  }

  // What stays on this device after an account is deleted: the cloud it's connected to (so the first screen shows
  // again) and the device's own choices (its id, look and kind). Everything else of Wefty's here goes.
  // (1.22.5: and the wrong-PIN wait, js/lock.js: signing out and in again never starts it over; and how quickly each
  // free AI model answers on this device's network, js/ai.js's timings, which say nothing of the person)
  const KEEP_HERE = ['vault-config', 'vault-install', 'vault-theme', 'vault-black', 'vault-device', 'wefty-pin-tries',
    'vault-gemini-speed'];

  /* This device forgets the person: their copy (V.db), their sign-in and everything Wefty kept for them. Nothing may
     sign them in again or bring the sign-in screen up over the goodbye (V.emit: the cloud's sync finding no sign-in). */
  async function forgetHere() {
    const emit = V.emit;
    V.emit = (type, detail) => (type === 'signed-out' ? undefined : emit(type, detail));
    try { V.emit('signing-out'); } catch (error) { /* (each part forgets what it can) */ }
    for (const table of ['notes', 'folders', 'transfers']) V.data[table] = new Map();
    V.data.clips = [];
    V.data.settings = {};
    try {
      if (V.cloud.sb && !V.desktop) {
        if (V.cloud.sb.removeAllChannels) V.cloud.sb.removeAllChannels();
        if (V.cloud.sb.auth.stopAutoRefresh) V.cloud.sb.auth.stopAutoRefresh();
      }
    } catch (error) { /* (only background work) */ }
    try { await V.db.wipe(); } catch (error) { console.warn('Wefty:', error); }
    try { indexedDB.deleteDatabase('wefty-listening'); } catch (error) { /* (the note-taker's pieces, if any) */ }
    try {
      for (const key of Object.keys(localStorage)) {
        if (/^(vault|wefty|sb)-/.test(key) && !KEEP_HERE.includes(key)) localStorage.removeItem(key);
      }
      sessionStorage.clear();
    } catch (error) { /* a private window: nothing kept anyway */ }
  }

  function goodbye() {
    V.gate.screen(V.h('h1', { text: 'Your account is deleted' }),
      V.h('p.muted.goodbye-what', { text: 'Your notes, files, chats and settings are gone from Wefty\'s cloud and from this device. '
        + 'Other devices sign out the next time they open Wefty.' }),
      V.h('p.muted', { text: 'Thanks for trying Wefty.' }),
      V.button('Back to the start', { kind: 'primary wide-btn', onClick: () => location.reload() }));
  }

  function dataCard(ui) {
    const owner = V.who() === 'owner';
    return ui.card('Your data',
      ui.line('Export everything', 'Every note, folder and chat in one ZIP, to keep or to take somewhere else. Locked notes stay locked.',
        V.button('Export', { icon: 'download', onClick: exportEverything }), 'export-everything'),
      owner ? ui.line('Delete my account', NOT_DELETED.owner, null, 'delete-my-account')
        : ui.line('Delete my account', 'Every note, file, chat and setting, on every device, for good.',
          V.button('Delete', { kind: 'danger-quiet', icon: 'trash', onClick: deleteSheet }), 'delete-my-account'));
  }

  function accountPage(ui) {
    const user = V.data.user || {};
    const letter = (Array.from(String(user.name || user.email || '').trim())[0] || '?').toUpperCase();
    const sync = syncing();
    const host = (V.config || {}).url ? new URL(V.config.url).host : '';
    const whose = V.who();  // (1.21: someone who signed up at wefty.org is in Wefty's cloud, like a friend in the owner's)
    const who = ui.card('Your account',
      V.h('div.setting.account-who', { dataset: { setting: 'your-email' } },
        V.h('span.av.who-av', { text: letter, 'aria-hidden': 'true' }),
        V.h('div.setting-text', {}, V.h('strong', { text: user.email || 'Signed in' }),
          V.h('span', { text: whose !== 'owner' ? 'Your notes, files and clipboard are yours alone: nobody else using Wefty can see them.'
            : 'Your notes, files and clipboard are only in your own cloud.' }),
          // (a tap syncs now, as the Sync line's button does: 1.19.11)
          sync.short ? V.h('button.sync-chip', { type: 'button', dataset: { state: V.cloud.status }, text: sync.short,
            title: 'Sync now', 'aria-label': `${sync.short}. Sync now`, onclick: () => syncNow() }) : null)),
      // (Always here for a friend, so those who joined before the owner's Stats existed are told too.)
      whose !== 'owner' ? V.h('p.hint.account-stats', { text: `Whoever runs this Wefty's cloud can see what's stored in it. ${V.welcome.STATS_WORDS}` }) : null,
      ui.line('Change password', 'For signing in on a new device. It isn\'t your locked-notes PIN (that\'s in Notes & files).',
        V.button('Change', { icon: 'key', onClick: changePassword })),
      ui.line('Sign out', 'Your notes stay safe in the cloud.', V.button('Sign out', { kind: 'danger-quiet', icon: 'sign-out', onClick: signOut })));
    const syncLine = ui.line('Sync', `${sync.said}. ${V.cloud.live ? 'Changes arrive the moment they\'re made.' : 'Checking for changes every 20 seconds.'}`,
      V.button('Sync now', { icon: 'restore', onClick: () => V.cloud.sync() }));
    return [who, dataCard(ui), ui.more('Sync · the cloud you\'re connected to', [
      sync.urgent ? ui.lift(syncLine) : syncLine,
      ui.line('Connected to', host ? `${host}, ${whose === 'invited' ? 'the cloud you were invited to'
        : whose === 'self' ? 'Wefty\'s cloud' : 'your own free cloud'}.` : '', null),
    ])];
  }

  /* -- Appearance */

  /* Light, dark, or as the phone (or Windows) is set: each device keeps its own (V.theme). Pure black, also this
     device's own, is always there; while light shows it waits, switched off and greyed (it changes nothing in light). */
  let drawnDark = null;
  function appearanceCard(ui) {
    drawnDark = V.theme.current() === 'dark';
    const pick = V.h('div.segmented', { role: 'radiogroup', 'aria-label': 'Theme' },
      [['system', 'System', V.desktop ? 'pc' : 'phone'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([value, label, icon]) =>
        V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(V.theme.choice() === value), dataset: { theme: value },
          onclick: () => { V.theme.set(value); draw(); } }, V.icon(icon), V.h('span', { text: label }))));
    const black = V.h('input.switch', { type: 'checkbox', checked: drawnDark && V.theme.black(), disabled: !drawnDark,
      'aria-label': 'Pure black', onchange: (event) => { V.theme.setBlack(event.target.checked); draw(); } });
    const just = V.desktop ? ' Just for this PC.' : '';
    return ui.card('Appearance', ui.line('Theme', V.desktop ? 'System follows Windows. Just for this PC.'
      : `System follows this ${word()}. Each device keeps its own.`, pick),
    ui.line('Pure black', drawnDark ? `For ${V.device === 'phone' ? 'phones with ' : ''}black (OLED) screens: `
      + `the background goes fully black in dark mode.${just}` : `Works when Wefty is dark.${just}`, black));
  }

  /* The two reading aids (js/reading.js), for every device the person uses: dyslexia-friendly text (its font, page
     colour and reading ruler shown under it while it's on) and Quick read (with its colour, which can be switched off). Each change goes to the
     cloud first; while it's on its way its control waits, and one that can't be made goes back and says so. */
  let readingBusy = false;
  async function changeReading(changes) {
    if (readingBusy) return;
    readingBusy = true;
    draw();
    try {
      await V.reading.set(changes);
    } catch (error) {
      console.warn('Vault:', error);
      V.toast(V.reading.NOT_CHANGED, { kind: 'err', ms: 5000 });
    } finally {
      readingBusy = false;
      draw();
    }
  }

  function readingCard(ui) {
    const now = V.reading.get();
    const swatch = (group, name, list, value, label, dot) => V.h('div.swatches', { role: 'radiogroup', 'aria-label': group },
      list.map((option) => V.h('button.swatch', { type: 'button', role: 'radio', 'aria-checked': String(value === option),
        disabled: readingBusy, dataset: { [name]: option }, onclick: () => { if (value !== option) changeReading({ [name]: option }); } },
      V.h('span.swatch-dot', { dataset: { dot: dot(option) } }), V.h('span', { text: label(option) }))));
    const switchFor = (name, label) => V.h('input.switch', { type: 'checkbox', checked: now[name], 'aria-label': label,
      disabled: readingBusy, onchange: (event) => changeReading({ [name]: event.target.checked }) });
    const named = (w) => w[0].toUpperCase() + w.slice(1);
    const fonts = V.h('div.segmented', { role: 'radiogroup', 'aria-label': 'Font' },
      [['lexend', 'Lexend'], ['opendyslexic', 'OpenDyslexic']].map(([value, label]) => V.h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(now.font === value), disabled: readingBusy, dataset: { font: value },
        onclick: () => { if (now.font !== value) changeReading({ font: value }); } }, V.h('span', { text: label }))));
    // A few words drawn the way notes are drawn now, so each choice shows what it does.
    const sample = V.reading.area(V.h('p.reading-sample', { text: 'Reading is quicker when your eyes can see where each word starts.' }));
    return ui.card('Reading',
      ui.line('Dyslexia-friendly text', 'An easier font, more room between letters, words and lines, and a soft page '
        + 'colour. On every device you use.', switchFor('dyslexia', 'Dyslexia-friendly text')),
      now.dyslexia ? [
        ui.line('Font', 'Lexend is calm and clear; OpenDyslexic gives each letter a heavier bottom.', fonts),
        V.h('div.setting.setting-stack', { dataset: { setting: 'page-colour' } }, V.h('div.setting-text', {}, V.h('strong', { text: 'Page colour' }),
          V.h('span', { text: 'A soft colour behind your notes, cards and answers.' })),
        swatch('Page colour', 'tint', V.reading.TINTS, now.tint, (t) => (t === 'none' ? 'None' : named(t)), (t) => 'tint-' + t)),
        ui.line('Reading ruler', 'In the Read view, a soft band on the line you\'re reading.', switchFor('ruler', 'Reading ruler')),
      ] : null,
      ui.line('Quick read', 'The first part of every word drawn bolder on a soft colour, so your eyes can jump from '
        + 'word to word.', switchFor('quick', 'Quick read')),
      now.quick ? ui.line('Colour behind the bold part', 'Off: just the bolder letters, with no colour.',
        switchFor('quickHighlight', 'Colour behind the bold part')) : null,
      now.quick && now.quickHighlight ? V.h('div.setting.setting-stack', { dataset: { setting: 'quick-read-colour' } }, V.h('div.setting-text', {},
        V.h('strong', { text: 'Quick read colour' })),
      swatch('Quick read colour', 'quickColour', V.reading.COLOURS, now.quickColour, named, (c) => 'quick-' + c)) : null,
      now.dyslexia || now.quick ? V.h('div.setting.reading-try', {}, sample) : null);
  }

  /* -- Devices */

  /* "Add a phone or computer", on every device: the QR code and its steps in a sheet (a PC or a Chromebook, whose
     screen a phone's camera can read), or the link shared from a phone (to e-mail or message to yourself). */
  function connectSheet() {
    const link = V.connectLink();
    V.sheet({
      title: 'Add a phone or computer',
      content: V.h('div.connect', {},
        V.qr(link),
        V.h('ol.steps', {},
          V.h('li', { text: 'Point the phone\'s camera at the code and tap the link it shows (on Android, Google Lens reads it too). On a computer, open the link you copied.' }),
          V.h('li', { text: 'Wefty opens (in Chrome on Android, Safari on an iPhone). Sign in with your e-mail and your Wefty password.' }),
          V.h('li', { text: 'Put it on the home screen: on Android, Install (or Chrome\'s ⋮ menu > Add to Home screen), and then photos can be shared straight to your PC; on an iPhone, in Safari\'s Wefty, Settings > Devices > Copy the sign-in link, add Wefty to the Home Screen, then open the icon, tap Paste my sign-in and sign in once.' }))),
      actions: [{ label: 'Copy the link', icon: 'copy', onClick: async () => {
        await V.copy(link);
        V.toast('Copied. E-mail it to yourself and open it on the other device.');
        return true;
      } }, { label: 'Done', kind: 'primary' }],
    });
  }

  async function shareLink() {
    const link = V.connectLink();
    if (navigator.share) {
      try { await navigator.share({ title: 'Wefty', text: 'Open Wefty and sign in:', url: link }); return; } catch (error) {
        if (error && error.name === 'AbortError') return;  // (closed the share sheet)
      }
    }
    await V.copy(link);
    V.toast('Link copied. Send it to yourself and open it on the other device.');
  }

  function addLine(ui) {
    const phone = V.device === 'phone';
    return ui.card('', ui.line('Add a phone or computer', phone ? 'Send yourself a link that opens Wefty there, ready to sign in.'
      : 'Show a code to scan with its camera, or copy the link.',
    phone ? V.button('Share link', { icon: 'link', onClick: () => shareLink().catch(V.problem) })
      : V.button('Show code', { icon: 'qr', onClick: connectSheet }), 'add-a-phone-or-computer'));
  }

  /* "Sign in another device" (1.21, js/pair.js), on every device: the code a device that isn't signed in shows, typed
     here to sign it in (no password there). */
  const pairLine = (ui) => (V.pair ? ui.line('Sign in another device', 'Type the code it shows on its Sign in screen, and '
    + 'it signs in to your Wefty. Only for a device right next to you.',
  V.button('Type its code', { icon: 'key', onClick: () => V.pair.approve() }), 'sign-in-another-device') : null);
  // (with Add a phone or computer, on one card: both are about bringing in another device)
  const addCard = (ui) => {
    const card = addLine(ui);
    const pair = pairLine(ui);
    if (card && pair) card.append(pair);
    return card;
  };

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

  /* "Keep this PC's clipboard in step": one switch for the PC's two directions (sharing what's copied here, and
     copying what the phone and Chromebook share). On = both, off = both; just one of them on shows as on, with a hint
     pointing at More options, where each has its own switch. A second write that fails puts the first back. */
  let stepBusy = false;
  async function setPcStep(on) {
    if (stepBusy) return;
    stepBusy = true;
    const was = { clipboardShare: !!V.prefs.clipboardShare, clipboardReceive: !!V.prefs.clipboardReceive };
    const done = [];
    try {
      for (const name of ['clipboardShare', 'clipboardReceive']) {
        if (!!V.prefs[name] === on) continue;
        await V.pc.call('setPref', { name, value: on });
        V.prefs[name] = on;
        done.push(name);
      }
    } catch (error) {
      for (const name of done) {
        try { await V.pc.call('setPref', { name, value: was[name] }); V.prefs[name] = was[name]; } catch (again) { /* (said below) */ }
      }
      V.toast('The clipboard setting wasn\'t changed. Try again in a moment.', { kind: 'err', ms: 5000 });
      console.warn('Vault:', error);
    } finally {
      stepBusy = false;
      draw();
    }
  }

  // Share's rows name themselves; here they're always 'clipboard-step', the row the search table points at.
  const keyed = (ui) => Object.assign({}, ui, { line: (label, hint, control) => ui.line(label, hint, control, 'clipboard-step') });

  function pcStepLine(ui) {
    if (V.clips && V.clips.pcStepRow) return V.clips.pcStepRow(keyed(ui));  // (js/clips.js's: the same row as Share > Clipboard's)
    const share = !!V.prefs.clipboardShare;
    const take = !!V.prefs.clipboardReceive;
    return ui.line('Keep this PC\'s clipboard in step', share === take
      ? 'Copy here, paste on your phone and Chromebook, and the other way. Never passwords, keys or what password managers hide.'
      : 'Only one way: see More options.',
    V.h('input.switch', { type: 'checkbox', checked: share || take, disabled: stepBusy, 'aria-label': 'Keep this PC\'s clipboard in step',
      onchange: (event) => setPcStep(event.target.checked) }), 'clipboard-step');
  }

  function stepLine(ui) {
    if (!V.clips || !V.clips.canStep || !V.clips.canStep()) {
      return V.deviceKind.ios ? ui.line('Clipboard', `On an ${V.deviceKind.model}, Share > Clipboard's buttons send and copy: `
        + 'Safari only lets Wefty read the clipboard when you tap.', null, 'clipboard-step') : null;
    }
    if (V.clips.stepRow) return V.clips.stepRow(keyed(ui));  // (js/clips.js's: the same row as Share > Clipboard's)
    return ui.line(`Keep this ${word()}'s clipboard in step`, 'Copy on one device, paste on the others. Never passwords, PINs or codes.',
      V.h('input.switch', { type: 'checkbox', checked: V.clips.stepping(), 'aria-label': `Keep this ${word()}'s clipboard in step`,
        onchange: async (event) => {
          try { await V.clips.setStepping(event.target.checked); } catch (error) { V.problem(error); }
          draw();
        } }), 'clipboard-step');
  }

  /* "Install Wefty" (1.22): opens the home screen card for this device (js/homescreen.js: the browser's own install
     where it offers one, else the steps, Safari's animated ones on an iPhone, the QR code for a phone on a computer).
     The steps stay here in short too, for a glance. */
  function installLine(ui) {
    const phone = V.device === 'phone';
    const how = V.welcome.howToInstall();
    if (V.install.installed()) {
      return ui.line(phone ? 'On your home screen' : 'Installed as an app', 'Wefty is installed.', null, 'install');
    }
    const card = V.homeScreen && V.homeScreen.open;
    const opener = (kind) => V.button('Install Wefty', { kind, icon: 'download',
      onClick: () => (card ? V.homeScreen.open({ from: 'settings' }) : V.install.ask().then(draw)) });
    if (V.install.ready()) {
      return ui.line('Install Wefty', V.deviceKind.android ? 'Puts it on your home screen like any app, and lets you share to it.'
        : 'Puts it with your other apps, so it opens in its own window.', opener('primary'), 'install');
    }
    const ios = how.kind === 'ios';
    if (ios && !unmark) unmark = V.welcome.markConnect();
    return V.h('div.setting.install-how', { dataset: { setting: 'install' } }, V.h('div.setting-text', {},
      V.h('strong', { text: 'Install Wefty' }),
      V.h('span', { text: phone ? 'Put it on your home screen: it opens like an app and works offline.'
        : 'Install it as an app: it opens in its own window and works offline.' }),
      V.h('ol.steps', {}, how.steps.map((step) => V.h('li', { text: step }))),
      how.note ? V.h('span', { text: how.note }) : null,
      // (Its icon starts with nothing of Safari's: the link it connects with, as the welcome's step offers it.)
      ios ? V.welcome.iosIcon((V.data.user || {}).email || 'your e-mail') : null,
      card ? V.h('div.setting-buttons.install-open', {}, opener('')) : null));
  }

  // "PC files" (1.19, js/share.js): Files in Share, off unless switched on. One card of its own.
  const filesShown = () => !V.share || !V.share.shows || V.share.shows('files');
  const filesCard = (ui) => (V.share && V.share.filesRow ? ui.card('', V.share.filesRow(ui)) : null);

  function devicesPage(ui) {
    if (!V.desktop) {
      const phone = V.device === 'phone';
      const which = V.send.deviceSetting();  // which device this is (js/send.js)
      if (which) which.dataset.setting = 'this-device';
      return [
        // (1.22.2: an old address, signed in: "Sign in on wefty.org", Copy my sign-in. js/start.js)
        V.move && V.move.card ? V.move.card(ui) : null,
        ui.card(phone ? `This ${V.deviceKind.ios ? V.deviceKind.model : 'phone'}` : V.deviceKind.chromebook ? 'This Chromebook' : 'This browser',
          V.arrive && V.arrive.rows ? V.arrive.rows(ui) : null,  // js/arrive.js: a Chromebook's copying and saving
          stepLine(ui), installLine(ui)),
        addCard(ui),
        filesCard(ui),
        ui.more(`This is your ${word()} · change what this device is`, [which]),
      ];
    }
    if (!V.prefs) return [addCard(ui), filesCard(ui)];
    return [
      addCard(ui),
      ui.card('This PC',
        // What's sent with Send (js/send.js): on the clipboard, and a card at the corner (a PC app new enough).
        V.pc.can('copyArrival') && 'copyArrivals' in V.prefs ? ui.line('Copy what arrives',
          'Pictures, files, links and words sent to this PC go on its clipboard, ready to paste.', toggle('copyArrivals', draw)) : null,
        V.pc.can('showArrival') && 'arrivalPreview' in V.prefs ? ui.line('Show what arrives',
          'A small card with the picture, at the corner of the screen.', toggle('arrivalPreview', draw)) : null,
        ui.line('Files from your phone go to', V.prefs.downloads, V.h('div.setting-buttons', {},
          V.button('Open', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: V.prefs.downloads }).catch(V.problem) }),
          V.button('Change', { onClick: async () => {
            try { const answer = await V.pc.call('pickFolder'); if (answer.path) { V.prefs.downloads = answer.path; draw(); } } catch (error) { V.problem(error); }
          } }))),
        pcStepLine(ui)),
      filesCard(ui),
      ui.more(`Start with Windows · the quick note shortcut · each clipboard direction${filesShown() ? ' · folders your phone can see' : ''}`, [
        ui.line('Start Wefty with Windows', 'Quietly, in the tray, so files and the clipboard always come through.', toggle('autostart')),
        ui.line('Quick note', `Press ${V.prefs.hotkey} anywhere for a little note box.`, V.button('Change', { onClick: hotkey })),
        ui.line('Share what I copy', 'Text only; never passwords, keys or what password managers hide.', toggle('clipboardShare', draw)),
        ui.line('Copy what my phone and Chromebook share', 'Onto this PC\'s clipboard as it arrives.', toggle('clipboardReceive', draw)),
        filesShown() ? ui.line('Folders your phone can see', 'Pick them in Share > Files.', V.button('Open Files', { icon: 'folder', onClick: () => V.go('files') })) : null,
      ]),
    ];
  }

  /* -- Notes & files */

  /* (1.22.5) A PIN is set or changed only on the cloud's lock row as it is right now (V.cloud.setPin), and used only
     once the cloud took it: a device that hasn't read the row (offline) never makes one of its own, and a change made
     on another device first is never written over (SEC-04, DATA-11). A change keeps the old PIN's salt (extra.pin_old),
     so a note still sealed with it opens with the old PIN. */
  const OFFLINE_PIN = 'Connect to the internet first: Wefty checks your cloud for a PIN you already have before it sets one.';
  async function pin() {
    if (!V.lock.hasPin() && navigator.onLine) await V.cloud.sync();  // a PIN made on another device counts
    if (!V.lock.hasPin()) {
      if (!navigator.onLine || !V.cloud.settingsRead()) return V.toast(OFFLINE_PIN, { kind: 'err', ms: 7000 });
      const made = await V.lock.askPin({ title: 'Locked notes', make: true });
      if (!made) return;
      const prepared = await V.lock.prepare(made);
      try {
        await V.cloud.setPin(prepared.values);
      } catch (error) {
        V.toast(error.message || String(error), { kind: 'err', ms: 8000 });
        draw();
        return;
      }
      V.lock.adopt(prepared);
      V.toast('PIN set. Lock a note from its lock button.');
      draw();
      return;
    }
    if (!navigator.onLine) return V.toast('Connect to the internet to change your PIN.', { kind: 'err' });
    await V.cloud.sync();  // (the lock row as the cloud has it now)
    if (V.lock.waitLeft()) return V.toast(V.lock.waitSaid(), { kind: 'err', ms: 6000 });
    const old = await V.lock.askPin({ title: 'Your current PIN' });
    if (!old) return;
    const fresh = await V.lock.askPin({ title: 'New PIN', make: true });
    if (!fresh) return;
    const done = await V.lock.rekey(old, fresh, [...V.data.notes.values()]);
    if (!done) return V.toast(V.lock.waitSaid() || 'That wasn\'t your PIN.', { kind: 'err', ms: 6000 });
    try {
      await V.cloud.setPin(done.values, { from: done.from });
    } catch (error) {
      V.toast(error.message || String(error), { kind: 'err', ms: 8000 });
      draw();
      return;
    }
    V.lock.adopt(done);
    for (const note of done.notes) await V.cloud.save('notes', note);
    V.toast(`PIN changed${done.notes.length ? ` (${done.notes.length} locked note${done.notes.length > 1 ? 's' : ''} updated)` : ''}.`);
    draw();
  }

  /* "Hear quiet voices" (the PC's note-taker, VAULT_NOTETAKER_SENSITIVITY): on = 'high', off = 'normal'. Another value
     put in .env by hand (a number) shows as on, saying so; the PC part stores whatever it's given and reads it
     fail-soft (vault/notetaker.py), so this works with every PC part that knows the setting. */
  let quietBusy = false;
  function quietLine(ui) {
    if (!V.desktop || !V.prefs || !('notetakerSensitivity' in V.prefs)) return null;
    const value = String(V.prefs.notetakerSensitivity == null ? 'normal' : V.prefs.notetakerSensitivity).trim().toLowerCase();
    const own = !['', 'normal', 'high'].includes(value);
    return ui.line('Hear quiet voices', own ? `Set to ${value} in .env.`
      : 'The PC\'s note-taker turns soft voices up and listens harder in a quiet room. Louder rooms may pick up more noise.',
    V.h('input.switch', { type: 'checkbox', checked: value !== '' && value !== 'normal', disabled: quietBusy, 'aria-label': 'Hear quiet voices',
      onchange: async (event) => {
        const next = event.target.checked ? 'high' : 'normal';
        quietBusy = true;
        try {
          await V.pc.call('setPref', { name: 'notetakerSensitivity', value: next });
          V.prefs.notetakerSensitivity = next;
        } catch (error) { V.problem(error); } finally { quietBusy = false; draw(); }
      } }));
  }

  function notesPage(ui) {
    const quiet = quietLine(ui);
    const empty = { rows: [], more: [], says: [], foot: '' };
    const backups = V.backup && V.backup.rows ? V.backup.rows(ui) : empty;        // js/history.js
    const search = V.attachSearch && V.attachSearch.rows ? V.attachSearch.rows(ui) : empty;  // js/attachsearch.js
    const more = [...backups.more, ...search.more, quiet].filter(Boolean);
    const says = [...backups.says, ...search.says, quiet ? 'hear quiet voices' : ''].filter(Boolean).join(' · ');
    return [
      ui.card('Locked notes', ui.line('Locked notes PIN', `${V.lock.hasPin() ? 'Your PIN is set.' : 'No PIN yet.'} Locked notes are `
        + 'scrambled on your device with it. If you forget it, they can\'t be opened, by anyone.',
      V.button(V.lock.hasPin() ? 'Change PIN' : 'Set a PIN', { icon: 'lock', onClick: pin }))),
      ui.card('Backups', backups.rows),
      search.rows.length ? ui.card('Search', search.rows) : null,
      // (1.19: extras that are off unless switched on, to keep Wefty calm: js/subs.js)
      V.subs && V.subs.settingsRow ? ui.card('Extras', V.subs.settingsRow(ui)) : null,
      backups.foot ? V.h('p.hint.set-foot', { text: backups.foot }) : null,
      more.length ? ui.more(says.replace(/^./, (c) => c.toUpperCase()), more) : null,
    ];
  }

  /* -- About & feedback: Wefty's own version and its updates (js/update.js), feedback, and a friend's announcements */

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

  function aboutPage(ui) {
    const now = V.update.state();
    const answer = lastAnswer || {};
    const said = checking ? 'Checking...'
      : answer.state === 'error' ? `Couldn't check: ${answer.message || 'try again later'}`
        : answer.state === 'current' && !now.ready ? 'Wefty is up to date.'
          : now.checked ? `Last checked ${V.ago(now.checked)}` : 'Not checked yet';
    return [
      ui.card('About Wefty',
        ui.line(`Wefty ${now.version}`, said, now.canCheck && !now.ready ? V.button('Check for updates', {
          icon: 'restore', disabled: checking, onClick: checkNow }) : null, 'wefty-version'),
        now.ready ? ui.line(/^\d/.test(now.ready) ? `Wefty ${now.ready} is ready` : 'An update is ready',
          'It switches over by itself next time Wefty is in the background, or now.',
          V.button('Update now', { kind: 'primary', icon: 'download', onClick: () => V.update.now() }), 'update-now') : null,
        now.needsShell ? ui.line(`Wefty ${now.needsShell} needs the PC part updated`,
          V.pc.howToUpdate(), null, 'pc-part') : null,
        V.h('div.setting-buttons', {}, V.button('What\'s new', { onClick: () => V.update.whatsNew() }))),
      V.help ? V.help.card(ui) : null,  // js/help.js: Help (1.22)
      V.feedback ? V.feedback.card(ui) : null,  // js/access.js
      V.tour ? V.tour.card(ui) : null,  // js/tour.js: Take the tour (1.19.6)
      V.news && !owner() ? V.news.card(ui) : null,  // js/news.js: a friend's announcements (the owner's are in Friends)
      now.downloaded ? ui.more('Use the built-in copy', [ui.line('Use the built-in copy', 'Go back to the version installed '
        + 'on this PC and skip this update.', V.button('Go back', { kind: 'danger-quiet', onClick: async () => {
        const sure = await V.confirm('Use the built-in copy?', 'Wefty goes back to the version installed on this PC '
          + 'and skips this update. A newer update still comes when there is one.', { ok: 'Go back' });
        if (sure) V.update.useBuiltIn().catch(V.problem);
      } }))]) : null,
    ];
  }

  /* -- Friends (the owner's): invites, announcements and stats, as their cards (js/access.js, js/news.js) */

  const owner = () => V.who() === 'owner';
  const canInvite = () => owner() && !!V.invites
    && (!V.desktop || !!(V.pc && (V.pc.can('adminCall') || V.pc.can('invitesState'))));

  function friendsPage(ui) {
    return built(ui, V.invites.page(ui));  // js/access.js (with js/news.js's announcements)
  }

  /* -- what each category's line on the home says. `marked`: something needs the person now (an update waiting, a
     helper out of date, notes not syncing, the Claude limit reached); never for something optional (no Gemini key). */

  const lead = (parts) => parts.filter(Boolean);
  const SUMMARIES = {
    account() {
      const user = V.data.user || {};
      const sync = syncing();
      if (['offline', 'held', 'error', 'asleep', 'signed-out'].includes(V.cloud.status)) {
        return { parts: lead([V.cloud.status === 'offline' ? '' : user.email, sync.short]), marked: sync.urgent };
      }
      return { parts: lead([user.email, sync.short]) };
    },
    appearance() {
      const choice = V.theme.choice();
      const dark = V.theme.current() === 'dark';
      const reading = V.reading ? V.reading.get() : {};
      return { parts: lead([choice === 'system' ? `System (${dark ? 'dark' : 'light'} now)` : choice === 'dark' ? 'Dark' : 'Light',
        dark && V.theme.black() ? 'Pure black' : '', reading.dyslexia ? 'Dyslexia-friendly text' : '',
        reading.quick ? 'Quick read on' : '']) };
    },
    ai() {
      if (!V.ai) return { parts: ['Free Gemini'] };
      const known = V.ai.state();
      const gemini = V.ai.has('gemini');
      const parts = [gemini ? 'Gemini ready' : known && !known.failed ? 'Not set up · free' : 'Free Gemini'];
      let marked = false;
      if (V.ai.claudeOn()) {
        const t = V.ai.tally();
        if (t.limit > 0 && t.spent >= t.limit) { parts.push('Claude limit reached'); marked = true; } else {
          parts.push(`Claude ${V.ai.money(t.spent)}${t.limit > 0 ? ` of ${V.ai.money(t.limit).replace(/\.00$/, '')}` : ''}`);
        }
      }
      return { parts: parts.join(' · ').split(' · '), marked };
    },
    devices() {
      if (V.desktop) {
        const p = V.prefs || {};
        return { parts: lead([p.copyArrivals ? 'Copies what arrives' : '', p.clipboardShare || p.clipboardReceive ? 'clipboard in step' : '',
          !p.copyArrivals && !(p.clipboardShare || p.clipboardReceive) ? 'Add a phone or computer' : '']) };
      }
      const phone = V.device === 'phone';
      const installed = V.install.installed();
      const step = V.clips && V.clips.stepping && V.clips.stepping();
      const arrive = !phone && V.arrive && V.arrive.copyOn ? V.arrive : null;  // (a Chromebook's: js/arrive.js)
      const copies = !!(arrive && arrive.copyOn());
      const folder = arrive ? arrive.folderName() : '';
      if (copies || folder) {
        return { parts: lead([copies && folder ? 'Copies and saves what arrives' : copies ? 'Copies what arrives'
          : `Saves to ${V.deviceKind.chromebook ? 'Files › ' : ''}${folder}`, step ? 'clipboard in step' : '']) };
      }
      return { parts: lead([installed ? (phone ? 'On your home screen' : 'Installed') : (phone ? 'Not on your home screen yet' : 'In a browser tab'),
        step ? 'clipboard in step' : '']) };
    },
    notifications() {
      return V.push ? V.push.summary() : { parts: [] };
    },
    notes() {
      const backup = V.backup && V.backup.info ? V.backup.info() : null;  // (the PC's: js/history.js)
      const day = (iso) => new Date(iso).toLocaleDateString([], Date.now() - Date.parse(iso) < 6 * 86400000 ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' });
      const backed = backup && backup.on ? (backup.last && Number.isFinite(Date.parse(backup.last)) ? `backed up ${day(backup.last)}` : 'weekly backups')
        : V.desktop && V.prefs && V.prefs.backup ? 'weekly backups' : '';
      return { parts: lead([V.lock.hasPin() ? 'PIN set' : 'No PIN yet', backed]) };
    },
    friends() {
      const s = V.invites && V.invites.state ? V.invites.state() : null;
      if (s && s.how === 'pc' && s.helper && s.current && Number(s.helper.version) < s.current) return { parts: ['Update the helper'], marked: true };
      if (s && !s.failed && !s.on) return { parts: ['Invites are off'] };
      const n = s && s.on && V.invites.counts ? V.invites.counts() : null;  // (js/access.js: once the people are in)
      if (n) return { parts: n.joined || n.waiting ? lead([`${n.joined} joined`, n.waiting ? `${n.waiting} waiting` : '']) : ['Nobody invited yet'] };
      return { parts: ['Invites', 'announcements', 'stats'] };
    },
    about() {
      const now = V.update.state();
      if (now.ready) return { parts: [/^\d/.test(now.ready) ? `Update ready: Wefty ${now.ready}` : 'An update is ready'], marked: true };
      if (now.needsShell) return { parts: [`Wefty ${now.needsShell} needs the PC part updated`], marked: true };
      const unseen = !owner() && V.news && V.news.unseenCount ? V.news.unseenCount() : 0;
      return { parts: lead([`Wefty ${now.version}`, lastAnswer && lastAnswer.state === 'current' ? 'up to date' : '',
        unseen ? `${unseen} new announcement${unseen === 1 ? '' : 's'}` : '']) };
    },
  };

  /* The categories, in the home's order (two groups). `page(ui)` builds a page as a list of sections. */
  const CATEGORIES = [
    { id: 'account', title: 'Account', icon: 'user', group: 1, page: accountPage },
    { id: 'appearance', title: 'Appearance', icon: 'contrast', group: 1, page: (ui) => [appearanceCard(ui), readingCard(ui),
      V.streak ? V.streak.settingsCard(ui) : null] },  // (Studying: the streak, js/streak.js)
    { id: 'ai', title: 'AI', icon: 'spark', group: 1, page: (ui) => (V.ai ? built(ui, V.ai.page(ui)) : []) },
    { id: 'devices', title: 'Devices', icon: 'devices', group: 1, page: devicesPage },
    // (1.19, js/push.js: phones and Chromebooks only; the PC has Jarvis for its reminders)
    { id: 'notifications', title: 'Notifications', icon: 'bell', group: 1, shown: () => !V.desktop && !!V.push,
      page: (ui) => V.push.page(ui) },
    { id: 'notes', title: 'Notes & files', icon: 'folder', group: 1, page: notesPage },
    { id: 'friends', title: 'Friends', icon: 'users', group: 2, shown: canInvite, page: friendsPage },
    { id: 'about', title: 'About & feedback', icon: 'info', group: 2, page: aboutPage },
  ];
  for (const cat of CATEGORIES) {
    cat.summary = () => {
      try { return SUMMARIES[cat.id](); } catch (error) { console.error(error); return { parts: [] }; }
    };
  }
  const categories = () => CATEGORIES.filter((cat) => !cat.shown || cat.shown());

  /* Every page one after the other: only while js/settingsui.js isn't there (it replaces render and draw). */
  function plainDraw() {
    if (!root || !root.isConnected || root.dataset.tab !== 'settings') return;
    V.clear(root, V.h('div.page.settings', {},
      V.appHead({ title: 'Settings', back: () => V.leaveSettings(), backLabel: 'Back', me: false, cls: 'settings-head' }),
      categories().map((cat) => {
        try { return cat.page(plainUi); } catch (error) { console.error(error); return null; }
      })));
  }

  V.on('status', () => draw());
  V.on('update', () => draw());
  V.on('ai', () => draw());
  V.on('reading', () => draw());
  V.on('backup', () => draw());
  V.on('clip-stepping', () => draw());  // (Share > Clipboard's switch, or this page's, changed: its hint follows)
  V.on('theme', (now) => { if ((now === 'dark') !== drawnDark) draw(); });  // (the system turning dark wakes Pure black)
  V.on('data', (table) => { if (table === 'settings') draw(); });

  let page = '';
  return {
    CATEGORIES, categories, slug, signOut, dropMark, connectSheet, shareLink, exportEverything, deleteSheet, forgetHere, goodbye,
    render(container, opts = {}) {
      root = container;
      page = opts && typeof opts.page === 'string' ? opts.page : '';
      plainDraw();
    },
    draw: plainDraw,
    open: (id, opts = {}) => V.go('settings', { ...opts, page: id }),
    page: () => page,
  };
})();
