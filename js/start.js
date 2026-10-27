/* Vault: starting up. Works out where it's running (the PC app, or a phone's browser), what's set up, and shows the
   right first screen: the PC's cloud setup, the phone's "connect to your PC", signing in, or the app itself. */
'use strict';

(() => {
  // A page whose js/update.js didn't load still opens, only without updates this time (Vault 1.0.1's worker kept
  // the new page and scripts but never js/update.js: opened offline right after the update came out).
  V.update = V.update || { atBoot: async () => false, resume: () => null, started() {}, whatsNew() {},
    check: async () => ({ state: 'error', message: 'Vault couldn\'t check just now.' }), now: async () => false,
    useBuiltIn: async () => {}, state: () => ({ version: V.VERSION, ready: '', needsShell: '', checked: '',
      canCheck: false, downloaded: false }) };
  const app = document.getElementById('app');
  const TABS = [['notes', 'notes', 'Notes'], ['send', 'send', 'Send'], ['files', 'folder', 'Files'], ['clips', 'clip', 'Clipboard'],
    ['settings', 'settings', 'Settings']];
  let current = 'notes';
  let shell = null;

  /* ---------------------------------------------------------------- the app's frame */

  V.tab = () => current;
  V.go = (tab) => {
    current = tab;
    if (!shell) return;
    for (const button of shell.nav.querySelectorAll('.tab')) button.classList.toggle('on', button.dataset.tab === tab);
    shell.view.dataset.tab = tab;
    const show = { notes: V.notes, send: V.send, files: V.files, clips: V.clips, settings: V.settings }[tab];
    show.render(shell.view);
    shell.view.scrollTop = 0;
    badge();
  };

  function badge() {
    if (!shell) return;
    const count = V.send.unseen();
    const dot = shell.nav.querySelector('[data-tab=send] .badge');
    dot.textContent = count ? String(count) : '';
    dot.hidden = !count;
  }

  /* The sync pill: on each page's title row on a phone, at the foot of the rail when the window is wide. Every pill
     shows the same state (one listener sets them all). */
  const STATE_WORDS = { synced: 'Synced', syncing: 'Syncing', offline: 'Offline', error: 'Can\'t sync', asleep: 'Cloud asleep',
    'signed-out': 'Signed out', idle: '' };
  function showState(pill, state) {
    pill.dataset.state = state;
    pill.querySelector('.status-word').textContent = STATE_WORDS[state] || '';
    pill.title = state === 'offline' ? 'Offline: everything is saved on this device and goes up when you\'re back online'
      : state === 'error' || state === 'asleep' ? 'Vault can\'t reach your cloud: click for what to do' : 'Sync now';
  }
  V.statusPill = (cls = '') => {
    const pill = V.h('button.status' + (cls ? '.' + cls : ''), { type: 'button', onclick: () => {
      if (V.cloud.status === 'asleep' || V.cloud.status === 'error') explainTrouble(); else V.cloud.sync();
    } }, V.h('i.dot'), V.h('span.status-word'));
    showState(pill, V.cloud.status);
    return pill;
  };
  V.on('status', (state) => { for (const pill of document.querySelectorAll('.status')) showState(pill, state); });

  function explainTrouble() {
    const asleep = V.cloud.status === 'asleep';
    V.sheet({
      title: asleep ? 'Your cloud is asleep' : 'Vault can\'t reach your cloud',
      content: [
        V.h('p', { text: asleep
          ? 'Free Supabase clouds go to sleep after a week with no use. Everything is still there.'
          : 'If the internet is working, your free cloud may have gone to sleep after a week with no use. Everything is still there.' }),
        V.h('ol.steps', {}, V.h('li', { text: 'Open supabase.com/dashboard and sign in.' }),
          V.h('li', { text: 'Click your vault project, then press Restore.' }),
          V.h('li', { text: 'Wait a few minutes, then press Try again.' })),
        V.h('p.hint', { text: 'Until then, what you write is kept on this device and goes up once it\'s back.' }),
      ],
      actions: [
        { label: 'Open Supabase', icon: 'open', onClick: () => {
          if (V.desktop) V.pc.call('openLink', { url: 'https://supabase.com/dashboard' }).catch(V.problem);
          else window.open('https://supabase.com/dashboard', '_blank', 'noopener');
          return true;
        } },
        { label: 'Try again', kind: 'primary', onClick: () => V.cloud.sync() },
      ],
    });
  }

  function buildShell() {
    const nav = V.h('nav.tabs', { 'aria-label': 'Vault' }, V.mark(30, 'rail-mark'),
      TABS.map(([id, icon, label]) => V.h('button.tab', {
        type: 'button', dataset: { tab: id }, onclick: () => V.go(id),
      }, V.h('span.pill', {}, V.icon(icon), id === 'send' ? V.h('span.badge', { hidden: true }) : null),
      V.h('span.tab-label', { text: label }))),
      V.h('span.rail-spacer'), V.statusPill('rail-status'));
    const view = V.h('main.view');
    shell = { nav, view };
    V.clear(app, nav, view);
    app.className = 'ready ' + (V.desktop ? 'on-pc' : 'on-phone');
  }

  /* ---------------------------------------------------------------- screens before the app */

  /* "This version started", to the PC app: said once the app, or the setup or sign-in screen, is up, so a downloaded
     version that breaks while starting never says it and is taken back (an older PC app doesn't know the call). */
  let saidHello = false;
  function hello() {
    if (!V.desktop || saidHello) return;
    saidHello = true;
    V.pc.call('hello', { version: V.VERSION }).catch(() => {});
  }

  function screen(...kids) {
    app.className = 'ready gate ' + (V.desktop ? 'on-pc' : 'on-phone');
    V.clear(app, V.h('div.gate-box', {}, V.h('div.gate-brand', {}, V.wordmark()), kids));
  }

  function field(label, attrs) {
    const input = V.h('input.field', attrs);
    return [V.h('label.label', {}, label, input), input];
  }

  function signInScreen(email = '') {
    return new Promise((resolve) => {
      const [emailRow, emailBox] = field('E-mail', { type: 'email', value: email, autocomplete: 'username' });
      const [passRow, passBox] = field('Vault password', { type: 'password', autocomplete: 'current-password' });
      const problem = V.h('p.error-text');
      const go = V.button('Sign in', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        go.disabled = true;
        try {
          await V.cloud.signIn(emailBox.value, passBox.value);
          resolve();
        } catch (error) {
          problem.textContent = error.message || String(error);
        } finally {
          go.disabled = false;
        }
      } });
      passBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      screen(V.h('h1', { text: 'Sign in' }),
        V.h('p.muted', { text: V.desktop ? 'Vault on this PC got signed out. Sign in again with your Vault e-mail and password.'
          : 'Use the e-mail and password you picked when you set Vault up on your PC.' }),
        emailRow, passRow, problem, go,
        V.desktop ? null : V.h('p.hint', { text: 'Forgot your password? On your PC, open Vault > Settings > Change password, then sign in here with the new one.' }),
        V.desktop ? null : V.h('button.link-btn', { type: 'button', text: 'Connect to a different PC', onclick: () => {
          localStorage.removeItem('vault-config'); location.reload();
        } }));
      hello();
      requestAnimationFrame(() => (email ? passBox : emailBox).focus());
    });
  }

  function connectScreen() {
    const [urlRow, urlBox] = field('Cloud address', { type: 'url', placeholder: 'https://....supabase.co' });
    const [keyRow, keyBox] = field('Cloud key', { type: 'text', placeholder: 'sb_publishable_...', autocomplete: 'off' });
    const problem = V.h('p.error-text');
    const manual = V.h('details.manual', {}, V.h('summary', { text: 'Type it in instead' }), urlRow, keyRow, problem,
      V.button('Connect', { kind: 'primary', onClick: () => {
        const url = urlBox.value.trim().replace(/\/+$/, '');
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || keyBox.value.trim().length < 20) {
          problem.textContent = 'That doesn\'t look right. Both are on the PC: Vault > Settings > Connect your phone > Copy the link.';
          return;
        }
        localStorage.setItem('vault-config', JSON.stringify({ url, key: keyBox.value.trim() }));
        location.reload();
      } }));
    screen(V.h('h1', { text: 'Connect to your PC' }),
      V.h('ol.steps', {},
        V.h('li', { text: 'On your PC, open Vault and go to Settings > Connect your phone.' }),
        V.h('li', { text: 'Point this phone\'s camera at the QR code and tap the link it shows.' })),
      V.h('p.muted', { text: 'Vault keeps everything in your own free cloud, which your PC set up. This connects the phone to it.' }),
      manual);
  }

  /* The PC's first start: making the owner's own free cloud (vault/cloudsetup.py does the work). */
  function setupScreen() {
    return new Promise((resolve) => {
      const open = (url) => V.pc.call('openLink', { url }).catch(V.problem);
      const [tokenRow, tokenBox] = field('Your access token', { type: 'password', placeholder: 'sbp_...', autocomplete: 'off' });
      const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'username' });
      const [passRow, passBox] = field('Pick a Vault password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text');
      const log = V.h('div.setup-log');
      const go = V.button('Set up my cloud', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        if (!tokenBox.value.trim()) { problem.textContent = 'Paste your access token from step 2 first.'; return; }
        if (!emailBox.value.includes('@')) { problem.textContent = 'Type your e-mail.'; return; }
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        V.clear(log, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text: 'Starting...' })));
        try {
          await V.pc.call('setUp', { token: tokenBox.value.trim(), email: emailBox.value.trim(), password: passBox.value });
          resolve();
        } catch (error) {
          V.clear(log);
          problem.textContent = error.message || String(error);
          go.disabled = false;
        }
      } });
      V.on('pc:setup-progress', ({ text }) => {
        V.clear(log, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text })));
      });
      screen(V.h('h1', { text: 'Set up Vault' }),
        V.h('p.muted', { text: 'Vault keeps your notes, files and clipboard in your own free cloud (Supabase). Setting it up takes about 3 minutes, once.' }),
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '1' }), V.h('div', {},
          V.h('strong', { text: 'Make a free Supabase account' }),
          V.h('p.muted', { text: '"Continue with GitHub" is quickest. If it asks for an organization, any name is fine, on the Free plan.' }),
          V.button('Open supabase.com', { icon: 'open', onClick: () => open('https://supabase.com/dashboard/sign-up') }))),
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '2' }), V.h('div', {},
          V.h('strong', { text: 'Make an access token' }),
          V.h('p.muted', { text: 'On the page that opens, choose "Create legacy token" (a normal token can\'t reach enough), call it Vault, create it, then Copy. Paste it below. Vault uses it once to build your cloud and never keeps it: you can delete it afterwards.' }),
          V.button('Open the tokens page', { icon: 'open', onClick: () => open('https://supabase.com/dashboard/account/tokens') }),
          tokenRow)),
        V.h('div.setup-step', {}, V.h('span.step-number', { text: '3' }), V.h('div', {},
          V.h('strong', { text: 'Your Vault sign-in' }),
          V.h('p.muted', { text: 'What you\'ll type on your phone. Your e-mail isn\'t sent anything.' }),
          emailRow, passRow, againRow)),
        problem, log, go);
      hello();
    });
  }

  /* ---------------------------------------------------------------- the phone's own bits */

  function takeConnectLink() {
    const match = /#connect=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    try {
      const raw = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(decodeURIComponent(escape(atob(raw + '='.repeat((4 - raw.length % 4) % 4)))));
      if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(parsed.u) && parsed.k) {
        localStorage.setItem('vault-config', JSON.stringify({ url: parsed.u, key: parsed.k, email: parsed.e || '' }));
      }
    } catch (error) {
      console.warn('Vault: that connect link was damaged', error);
    }
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------------------------------------------------------------- dropping files anywhere */

  function dropAnywhere() {
    const hint = document.getElementById('drop-hint');
    let depth = 0;
    const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) || !V.data.user) return;
      depth++;
      hint.hidden = false;
      hint.querySelector('p').textContent = V.files.dropText() || `Drop to send to ${V.otherName}`;
    });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
    window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', (event) => {
      depth = 0;
      hint.hidden = true;
      if (!hasFiles(event) || !V.data.user) return;
      event.preventDefault();
      if (V.files.takeDrop(event.dataTransfer.files)) return;  // onto Vault Drive in the Files tab
      V.go('send');
      V.send.files(event.dataTransfer.files);
    });
  }

  /* ---------------------------------------------------------------- off we go */

  async function main() {
    buildShell();
    const { firstSync } = await V.cloud.start();
    const kept = V.update.resume();  // where the owner was before Vault reloaded into an update
    const asked = location.hash;  // the home screen icon's shortcuts: "New note" and "Send to PC"
    if (kept && TABS.some(([id]) => id === kept.tab)) current = kept.tab;
    if (asked === '#send') current = 'send';
    V.go(current);
    if (kept && kept.note && current === 'notes' && V.data.notes.has(kept.note)) V.notes.open(kept.note);
    if (asked === '#new') V.notes.chooseTemplate();
    if (asked === '#new' || asked === '#send') history.replaceState(null, '', location.pathname + location.search);
    dropAnywhere();
    firstSync.then(async () => {
      if (V.cloud.status === 'synced') await V.notes.ensureStarterFolders();
      V.send.checkIncoming();
      V.send.runQueue();
      if (!V.desktop) V.send.takeShared();
    });
    V.on('badge', badge);
    V.on('signed-out', async () => {
      const email = (V.data.user || {}).email || (V.config || {}).email || '';
      await signInScreen(email);
      location.reload();
    });
    if (V.desktop) {
      V.on('pc:show', ({ tab }) => { if (tab) V.go(tab); });
      V.on('pc:quick-note', async ({ text }) => {
        const words = String(text || '').trim();
        if (!words) return;
        const home = V.notes.inbox();
        await V.cloud.save('notes', V.notes.blankNote({ folder_id: home ? home.id : null, body: words,
          title: words.split('\n')[0].slice(0, 60) }));
        V.toast('Quick note saved to Inbox');
      });
      V.pc.call('appReady').catch(() => {});  // quick notes typed before now come through at this point
    } else {
      navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.vault === 'shared') V.send.takeShared();
      });
    }
    V.update.started(kept);
  }

  async function boot() {
    try {
      if (V.desktop) {
        await V.pc.ready;
        let config = await V.pc.call('config');
        V.theme.system(config.scheme);  // Windows' own light or dark, for Settings > Appearance > System
        V.pc.knows(config);
        V.pcWindow(config.shown);
        if (await V.update.atBoot(config)) return;
        if (!config.url) {
          await setupScreen();
          config = await V.pc.call('config');
        }
        V.config = config;
        V.prefs = config.prefs || {};
        V.cloud.client(config);
        if (!config.signedIn) {
          await signInScreen(config.email || '');
          config = await V.pc.call('config');
        }
        V.data.user = { id: config.userId, email: config.email };
      } else {
        takeConnectLink();
        if (await V.update.atBoot()) return;
        const saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
        if (!saved) return connectScreen();
        V.config = { ...saved, phoneUrl: location.origin + location.pathname };
        V.cloud.client(saved);
        let user = await V.cloud.user();
        if (!user) {
          await signInScreen(saved.email || '');
          user = await V.cloud.user();
        }
        V.data.user = user;
      }
      await main();
      hello();
    } catch (error) {
      console.error(error);
      // On the PC, a downloaded version that breaks after it started can be left from here too.
      const builtIn = V.desktop && V.update.state().downloaded
        ? V.button('Use the built-in copy', { onClick: () => V.update.useBuiltIn().catch(V.problem) }) : null;
      screen(V.h('h1', { text: 'Something went wrong' }), V.h('p.error-text', { text: error.message || String(error) }),
        V.button('Try again', { kind: 'primary', onClick: () => location.reload() }), builtIn);
    }
  }

  boot();
})();
