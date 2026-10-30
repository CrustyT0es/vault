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
    ['claude', 'spark', 'Chat'], ['settings', 'settings', 'Settings']];  // (the Chat tab's id stays 'claude': older links)
  let current = 'notes';
  let shell = null;

  /* ---------------------------------------------------------------- the app's frame */

  V.tab = () => current;
  V.go = (tab) => {
    if (tab === 'chat') tab = 'claude';  // the Chat tab, by its name since 1.8.3
    current = tab;
    if (!shell) return;
    for (const button of shell.nav.querySelectorAll('.tab')) button.classList.toggle('on', button.dataset.tab === tab);
    shell.view.dataset.tab = tab;
    const show = { notes: V.notes, send: V.send, files: V.files, clips: V.clips, claude: V.chat, settings: V.settings }[tab];
    show.render(shell.view);
    shell.view.scrollTop = 0;
    badge();
    V.emit('tab', tab);
  };

  function badge() {
    if (!shell) return;
    const count = V.send.unseen();
    const dot = shell.nav.querySelector('[data-tab=send] .badge');
    dot.textContent = count ? String(count) : '';
    dot.hidden = !count;
    const waiting = V.chat && V.chat.waiting ? V.chat.waiting() : 0;  // chat messages held until they can be sent
    const cdot = shell.nav.querySelector('[data-tab=claude] .badge');
    if (cdot) { cdot.textContent = waiting ? String(waiting) : ''; cdot.hidden = !waiting; }
  }

  /* The sync pill: on each page's title row on a phone, at the foot of the rail when the window is wide. Every pill
     shows the same state (one listener sets them all). */
  const STATE_WORDS = { synced: 'Synced', syncing: 'Syncing', offline: 'Offline', error: 'Can\'t sync', asleep: 'Cloud asleep',
    'signed-out': 'Signed out', idle: '' };
  // "held": everything synced but for a note or two the cloud wouldn't take (too big). The pill says so instead of
  // pretending all is well, and the tooltip says what to do.
  const heldLine = (n) => `${n === 1 ? '1 note' : `${n} notes`} can\'t go up to the cloud: too big. Make ${n === 1 ? 'it' : 'them'} shorter.`;
  function showState(pill, state) {
    pill.dataset.state = state;
    const held = state === 'held' ? (V.cloud.held || 1) : 0;
    pill.querySelector('.status-word').textContent = held ? `${held} not synced` : (STATE_WORDS[state] || '');
    pill.title = held ? heldLine(held)
      : state === 'offline' ? 'Offline: everything is saved on this device and goes up when you\'re back online'
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
      }, V.h('span.pill', {}, V.icon(icon), id === 'send' || id === 'claude' ? V.h('span.badge', { hidden: true }) : null),
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

  function signInScreen(email = '', note = '') {
    return new Promise((resolve) => {
      const [emailRow, emailBox] = field('E-mail', { type: 'email', value: email, autocomplete: 'username' });
      const [passRow, passBox] = field('Vault password', { type: 'password', autocomplete: 'current-password' });
      const problem = V.h('p.error-text', { text: note });
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
          : 'Use your Vault e-mail and password.' }),
        emailRow, passRow, problem, go,
        V.desktop ? null : V.h('p.hint', { text: 'Forgot your password? Change it in Vault on a device that\'s still signed in (Settings > Change password), then sign in here with the new one.' }),
        V.desktop ? null : V.h('button.link-btn', { type: 'button', text: 'Connect to a different cloud', onclick: () => {
          localStorage.removeItem('vault-config'); location.reload();
        } }));
      hello();
      requestAnimationFrame(() => (email ? passBox : emailBox).focus());
    });
  }

  /* Nothing set up in this browser yet. The link that sets it up (an invite, a join QR code's link, or #connect= from
     the PC's QR code or an iPhone's "Copy the sign-in link") is opened, or pasted here: on an iPhone or iPad, a new
     home screen icon starts with nothing of Safari's, so this is where it lands. */
  function connectScreen() {
    const [linkRow, linkBox] = field('Or paste it here', { type: 'url', placeholder: 'https://...#invite=..., #join=... or #connect=...',
      autocomplete: 'off', spellcheck: 'false' });
    const problem = V.h('p.error-text', { role: 'alert' });
    const use = (text) => {
      const found = /#(invite|join|connect)=([A-Za-z0-9_-]+)/.exec(String(text || ''));
      if (!found) {
        problem.textContent = 'That isn\'t a Vault link. Copy the whole link (an invite, a join code\'s link, or #connect=) and try again.';
        return;
      }
      history.replaceState(null, '', `${location.pathname}${location.search}#${found[1]}=${found[2]}`);
      location.reload();
    };
    const paste = V.button('Paste the link', { kind: 'primary wide-btn', icon: 'clip', onClick: () => {
      problem.textContent = '';
      let reading;  // (read in this very tap: only a tap lets a page read the clipboard)
      try { reading = navigator.clipboard.readText(); } catch (error) { reading = Promise.reject(error); }
      Promise.resolve(reading).then(use, () => {
        problem.textContent = 'Vault couldn\'t read what you copied. Paste the link in the box instead (press and hold, then Paste).';
        linkBox.focus();
      });
    } });
    linkBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') use(linkBox.value); });
    const [urlRow, urlBox] = field('Cloud address', { type: 'url', placeholder: 'https://....supabase.co' });
    const [keyRow, keyBox] = field('Cloud key', { type: 'text', placeholder: 'sb_publishable_...', autocomplete: 'off' });
    const typed = V.h('p.error-text');
    const manual = V.h('details.manual', {}, V.h('summary', { text: 'Type the cloud\'s address and key instead' }), urlRow, keyRow, typed,
      V.button('Connect', { kind: 'primary', onClick: () => {
        const url = urlBox.value.trim().replace(/\/+$/, '');
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || keyBox.value.trim().length < 20) {
          typed.textContent = 'That doesn\'t look right. Both are on the PC: Vault > Settings > Connect your phone > Copy the link.';
          return;
        }
        localStorage.setItem('vault-config', JSON.stringify({ url, key: keyBox.value.trim() }));
        location.reload();
      } }));
    screen(V.h('h1', { text: 'Connect Vault' }),
      V.h('p.muted', { text: 'Open the link you were sent (an invite or a join code\'s link from a friend, or the link from Vault on your PC). Or copy it, then tap Paste the link.' }),
      paste, linkRow, V.button('Connect', { kind: 'wide-btn', onClick: () => use(linkBox.value) }), problem,
      V.h('p.hint', { text: V.deviceKind.ios && V.install.installed()
        // (A scanned code opens in Safari, never in this icon: the link comes from Safari's Vault instead.)
        ? `In Safari's Vault, open Settings > This ${V.deviceKind.model} > Copy the sign-in link, then come back and tap Paste the link. `
          + 'Or on the PC: Vault > Settings > Connect your phone > Copy the link, and send it to this phone.'
        : 'Setting up your own phone? In Vault on your PC, open Settings > Connect your phone and point this phone\'s camera at the code.' }),
      manual);
  }

  /* The PC's first start: making the owner's own free cloud (vault/cloudsetup.py does the work), or joining a
     friend's with the invite link they sent (joinScreen, further down). */
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
        V.pc.can('joinInvite') ? V.h('button.link-btn', { type: 'button', text: 'Got an invite from a friend? Join with it instead',
          onclick: () => joinScreen(() => setupScreen().then(resolve), resolve) }) : null,
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

  /* ---------------------------------------------------------------- invites (vault/invites.py, js/access.js)

     A friend's account is made by the owner, with a one-time code as its first password. The invite link carries
     the owner's cloud (like #connect=) plus the e-mail and the code, so opening it signs them in; until they choose
     their own password (chooseScreen), the account says must_change_password and nothing else opens. The code only
     ever lives in memory here: never saved, and taken out of the address bar at once. */

  // An invite code as the account has it (K7QX9MRT2B), from however it was typed; '' when it isn't one.
  V.inviteCode = (text) => {
    const code = String(text || '').replace(/[\s\-_.]/g, '').toUpperCase();
    return /^[2-9A-HJKMNP-Z]{10}$/.test(code) ? code : '';
  };

  const CLOUD = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
  function readLink(raw) {
    const plain = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(plain + '='.repeat((4 - plain.length % 4) % 4)))));
  }

  let invite = null;
  function takeInviteLink() {
    const match = /#invite=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);  // the code never stays in the address bar
    let found = null;
    try { found = readLink(match[1]); } catch (error) { /* said below */ }
    const email = found && String(found.e || '').trim();
    if (!found || !CLOUD.test(found.u || '') || !found.k || !email || !email.includes('@') || !V.inviteCode(found.c)) {
      console.warn('Vault: that invite link was damaged');
      return;
    }
    invite = { url: found.u, key: String(found.k), email, code: V.inviteCode(found.c), name: String(found.n || '').slice(0, 60),
      // The link itself (code and all), in memory only: inAppScreen's "Copy the invite link" hands it to Chrome or Safari.
      link: `${location.origin}${location.pathname}${location.search}#invite=${match[1]}` };
    // Someone already signed in to Vault in this browser stays signed in: an invite never swaps them out.
    let saved = null;
    let who = null;
    try {
      saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
      who = JSON.parse(localStorage.getItem('vault-user') || 'null');
    } catch (error) { /* nothing usable kept */ }
    if (saved && localStorage.getItem('vault-auth')) {
      const same = saved.url === invite.url && who && String(who.email || '').toLowerCase() === email.toLowerCase();
      if (!same) { invite.busy = (who && who.email) || 'someone else'; return; }
    }
    localStorage.setItem('vault-config', JSON.stringify({ url: invite.url, key: invite.key, email }));
  }

  /* A join QR code's link (js/access.js's joinLinkFor): #join= with the owner's cloud and a join code that anyone may
     use for a while to make their own account there (joinCodeScreen). Like an invite's, the code is taken out of the
     address bar at once and kept in memory only: never saved, logged or put back in the address. */
  const JOIN_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;  // the helper's payload.signature (vault/invites.py's check)
  let join = null;
  function takeJoinLink() {
    const match = /#join=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);  // the code never stays in the address bar
    let found = null;
    try { found = readLink(match[1]); } catch (error) { /* said below */ }
    const token = found && typeof found.t === 'string' ? found.t : '';
    if (!found || !CLOUD.test(found.u || '') || !found.k || token.length > 600 || !JOIN_TOKEN.test(token)) {
      console.warn('Vault: that join link was damaged');
      return;
    }
    join = { url: found.u, key: String(found.k), token, name: String(found.n || '').trim().slice(0, 60),
      // (in memory only: inAppScreen's "Copy the link" hands it to Chrome or Safari)
      link: `${location.origin}${location.pathname}${location.search}#join=${match[1]}` };
    // Someone already signed in to Vault in this browser stays signed in: a join code never swaps them out.
    let saved = null;
    let who = null;
    try {
      saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
      who = JSON.parse(localStorage.getItem('vault-user') || 'null');
    } catch (error) { /* nothing usable kept */ }
    if (saved && localStorage.getItem('vault-auth')) {
      join.busy = (who && who.email) || 'someone else';
      return;
    }
    localStorage.setItem('vault-config', JSON.stringify({ url: join.url, key: join.key }));
  }

  /* The invite (or a join code's link) was opened inside an app's own browser (tapped in Instagram, Snapchat...:
     V.deviceKind.inApp). Vault works there, but only there: that browser keeps its own storage, can't put Vault on
     the home screen, and Google won't sign anyone in inside it (the free AI key). So Chrome (Android) or Safari
     (iPhone) is offered first: the code still works there until a password is chosen (or the join code runs out), so
     the whole thing can start again in the real browser. The link only reaches the clipboard from a tap here, never
     the address bar. Chrome's own button can't carry it (an intent:// link uses the part after # itself), so it's
     copied first and pasted on Chrome's "Connect Vault". */
  function inAppScreen() {
    return new Promise((resolve) => {
      const ios = V.deviceKind.ios;
      const browser = ios ? 'Safari' : 'Chrome';
      const joining = !invite && !!join;
      const copy = joining ? 'Copy the link' : 'Copy the invite link';
      const page = new URL(location.origin + location.pathname);
      const chrome = `intent://${page.host}${page.pathname}#Intent;scheme=https;package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(page.href)};end`;
      screen(V.h('h1', { text: joining ? `Open this link in ${browser}` : `Open your invite in ${browser}` }),
        V.h('p.muted', { text: `This page opened inside an app's own browser. Vault only stays here, can't go on your home `
          + `screen, and Google won't let you sign in here for the free AI. In ${browser} it all works.` }),
        V.h('ol.steps.in-app-how', {},
          V.h('li', { text: `Tap ${copy}.` }),
          V.h('li', { text: ios ? 'Tap ••• (or the compass) and choose Open in Safari (or Open in external browser).'
            : 'Tap Open in Chrome below, or ⋮ at the top and Open in Chrome (or Open in browser).' }),
          V.h('li', { text: `In ${browser}, tap Paste the link (or paste it into the address bar and go).` })),
        V.button(copy, { kind: 'primary wide-btn', icon: 'copy', onClick: async () => {
          await V.copy((joining ? join : invite).link, { cloud: true });  // (never shared to other devices: it holds the code)
          V.toast(`Copied. Now open ${browser} and paste it there.`, { ms: 6000 });
        } }),
        ios ? null : V.h('a.btn.wide-btn.in-app-chrome', { href: chrome, rel: 'noopener' }, V.icon('open'),
          V.h('span', { text: 'Open in Chrome' })),
        V.h('p.hint', { text: 'Carrying on here works, but Vault stays inside this app.' }),
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Continue here anyway', onclick: () => resolve() }));
    });
  }

  /* This browser's Vault is someone else's: the invite (or join code) waits until they've signed out. */
  function busyScreen() {
    return new Promise((resolve) => {
      const open = V.button('Open Vault', { kind: 'primary wide-btn', onClick: () => { invite = null; join = null; resolve(); } });
      if (!invite && join) {
        screen(V.h('h1', { text: 'Already signed in' }),
          V.h('p.muted', { text: `This browser's Vault is signed in as ${join.busy}. Sign out there first, or open the code's `
            + 'link in another browser.' }),
          open);
        return;
      }
      screen(V.h('h1', { text: 'Already signed in' }),
        V.h('p.muted', { text: `This invite is for ${invite.email}, but Vault in this browser is signed in as ${invite.busy}.` }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Open Vault here and go to Settings > Sign out.' }),
          V.h('li', { text: 'Then open the invite link again.' })),
        V.h('p.hint', { text: 'Or open the link in another browser (or a private window) instead.' }),
        open);
    });
  }

  const UNREACHABLE = 'Vault can\'t reach the cloud. Check the internet, then try again.';
  const NO_JOINING = 'That cloud doesn\'t take join codes yet. Ask for a new code.';

  // What a friend is told about their own notes (the choose-password and join screens).
  const PRIVATE = 'Your notes are only yours: nobody else using Vault can see them. Whoever runs the cloud can see what\'s '
    + 'stored in it, so keep secrets in a locked note (it\'s scrambled with your own PIN).';

  /* Someone opened a join QR code's link: they make their own Vault in that cloud with their own name, e-mail and
     password (Vault's helper there checks the code and makes the account: vault/functions/vault-admin). The code and
     the password only ever go to that cloud's helper, never into the address, storage or the console. Resolves
     'joined' (made and signed in: the welcome steps come next, no password to choose) or 'signed-in' (they had an
     account there already and signed in with it). */
  function joinCodeScreen() {
    return new Promise((resolve) => {
      const [nameRow, nameBox] = field('Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
      const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'email' });
      const [passRow, passBox] = field('Pick a password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text', { role: 'alert' });
      const instead = V.button('Sign in instead', { kind: 'wide-btn', onClick: async () => {
        await signInScreen(emailBox.value.trim());
        resolve('signed-in');
      } });
      instead.hidden = true;
      const go = V.button('Make my Vault', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        instead.hidden = true;
        const name = nameBox.value.replace(/\s+/g, ' ').trim();
        const email = emailBox.value.trim();
        if (!name) { problem.textContent = 'Type your name.'; nameBox.focus(); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problem.textContent = 'Type your e-mail address (like sam@example.com).'; return; }
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        try {
          const made = await askToJoin(name, email, passBox.value);
          if (made.error) {
            problem.textContent = made.error;
            instead.hidden = !made.exists;
            return;
          }
          join = null;  // (used: the code goes out of memory too)
          try {
            await V.cloud.signIn(made.email || email, passBox.value);
          } catch (error) {
            await signInScreen(made.email || email, 'Your Vault is made. Sign in with the e-mail and password you just picked.');
          }
          resolve('joined');
        } finally {
          go.disabled = false;
        }
      } });
      againBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      const owner = join.name.split(/\s+/)[0];
      screen(V.welcome.dots('password'), V.h('h1', { text: owner ? `Join ${owner}'s Vault` : 'Join Vault' }),
        V.h('p.muted', { text: 'Make your own Vault: your notes are only yours.' }),
        nameRow, emailRow, passRow, againRow, problem, go, instead,
        V.h('p.hint', { text: PRIVATE }),
        V.h('p.hint.choose-stats', { text: V.welcome.STATS_WORDS }));
      requestAnimationFrame(() => nameBox.focus());
    });
  }

  /* The join itself: the cloud's helper, with the cloud's public key only (there's no sign-in yet). { email } when
     the account was made, else { error: words to show, exists: an account with that e-mail is there already }. */
  async function askToJoin(name, email, password) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 30000);
    let response;
    let answer = {};
    try {
      response = await fetch(`${join.url}/functions/v1/vault-admin`, { method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json', apikey: join.key },
        body: JSON.stringify({ action: 'join', token: join.token, name, email, password }) });
      answer = await response.json().catch(() => ({}));
    } catch (error) {
      // Nothing this page may read came back. When the cloud itself answers, it's the helper that's missing (a
      // function that isn't there answers 404 with no CORS); else it's the internet, or a network that blocks it.
      return { error: navigator.onLine && await reachable() ? NO_JOINING : UNREACHABLE };
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) return { email: String((answer && answer.email) || email) };
    const said = answer && typeof answer.message === 'string' && answer.error ? answer.message : '';
    if (response.status === 404 || response.status === 401) return { error: NO_JOINING };  // none there, or one too old
    if (response.status === 540) return { error: 'That cloud is asleep right now. Ask whoever showed you the code to open Vault (it wakes up in a few minutes), then try again.' };
    return { error: said || (response.status >= 500 ? 'That cloud had trouble just now. Try again in a minute.'
      : `That didn't work (the cloud said ${response.status}). Ask for a new code.`), exists: answer && answer.error === 'exists' };
  }

  /* Whether the join link's cloud answers at all (its sign-in service's health check). */
  async function reachable() {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 10000);
    try {
      await fetch(`${join.url}/auth/v1/health`, { headers: { apikey: join.key }, signal: control.signal });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* A friend's first sign-in (or any later one before they did it): their own password, which ends the code. */
  function chooseScreen({ name = '', code = '' } = {}) {
    return new Promise((resolve) => {
      const [passRow, passBox] = field('Your new password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text');
      const go = V.button('Save my password', { kind: 'primary wide-btn', onClick: async () => {
        problem.textContent = '';
        if (passBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (passBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        if (V.inviteCode(passBox.value) && (!code || V.inviteCode(passBox.value) === code)) {
          problem.textContent = 'Pick your own password, not the invite code.';
          return;
        }
        go.disabled = true;
        try {
          await V.cloud.changePassword(passBox.value);
          V.toast('Password saved. Your invite code doesn\'t work any more.');
          resolve();
        } catch (error) {
          problem.textContent = /fetch|network|internet|offline/i.test(error.message || '')
            ? 'Vault can\'t reach the cloud right now. Check the internet, then try again.' : (error.message || String(error));
        } finally {
          go.disabled = false;
        }
      } });
      againBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      screen(V.welcome.dots('password'), V.h('h1', { text: 'Choose your own password' }),
        V.h('p.muted', { text: `${name ? `Welcome, ${name}! ` : ''}Your invite code only works once. Pick a password only you know: it's what you'll sign in with on your other devices.` }),
        passRow, againRow, problem, go,
        V.h('p.hint', { text: PRIVATE }),
        V.h('p.hint.choose-stats', { text: V.welcome.STATS_WORDS }),
        V.h('button.link-btn', { type: 'button', text: 'Sign out', onclick: async () => {
          await V.cloud.signOut().catch(() => {});
          location.reload();
        } }));
      hello();
      requestAnimationFrame(() => passBox.focus());
    });
  }

  /* The gate, whenever the signed-in account is still on its invite code. True once they chose a password here. */
  async function mustChoose() {
    if (!(await V.cloud.mustChange())) return false;
    const user = V.data.user || {};
    await chooseScreen({ name: (invite && invite.name) || user.name || '', code: invite && invite.code });
    return true;
  }

  /* A PC whose Vault isn't set up: joining a friend's cloud with the invite link (vault/invites.py's join). A
     phone-connect link works too, with the person's own password. A join QR code's link (pasted) takes the person's
     name, e-mail and a password of their own, and the helper in that cloud makes their account (invites.py's
     join_with_code): a PC part from before join codes can't, and says so. Python signs in and keeps the session.
     `done('joined')` after a join code (no password to choose: the welcome steps are next). */
  function joinScreen(back, done) {
    const [linkRow, linkBox] = field('Invite link', { type: 'url', placeholder: 'https://...#invite=... or #join=...', autocomplete: 'off', spellcheck: 'false' });
    const [passRow, passBox] = field('Your Vault password', { type: 'password', autocomplete: 'current-password' });
    passRow.hidden = true;
    const [nameRow, nameBox] = field('Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
    const [emailRow, emailBox] = field('Your e-mail', { type: 'email', autocomplete: 'email' });
    const [newRow, newBox] = field('Pick a password', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
    const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
    const details = [nameRow, emailRow, newRow, againRow];
    const problem = V.h('p.error-text');
    const joinCode = () => /#join=/.test(linkBox.value) && V.pc.can('joinWithCode');
    const showDetails = () => {
      const shown = joinCode();
      for (const row of details) row.hidden = !shown;
      if (shown) passRow.hidden = true;
    };
    showDetails();
    linkBox.addEventListener('input', showDetails);
    const go = V.button('Join', { kind: 'primary wide-btn', onClick: async () => {
      problem.textContent = '';
      const link = linkBox.value.trim();
      if (!/#(invite|connect|join)=/.test(link)) {
        problem.textContent = 'Paste the whole link your friend sent (it has #invite= or #join= in it). The code alone isn\'t enough: the link says which cloud to join.';
        return;
      }
      if (/#join=/.test(link)) {
        if (!V.pc.can('joinWithCode')) {
          problem.textContent = 'This Vault is too old for join codes. Update it first (open Jarvis and click Update, or run the '
            + 'newest setup-vault.bat), or ask for an invite link.';
          return;
        }
        showDetails();
        const name = nameBox.value.replace(/\s+/g, ' ').trim();
        const email = emailBox.value.trim();
        if (!name) { problem.textContent = 'Type your name.'; nameBox.focus(); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problem.textContent = 'Type your e-mail address (like sam@example.com).'; return; }
        if (newBox.value.length < 8) { problem.textContent = 'Pick a password of at least 8 characters.'; return; }
        if (newBox.value !== againBox.value) { problem.textContent = 'The two passwords aren\'t the same.'; return; }
        go.disabled = true;
        try {
          await V.pc.call('joinWithCode', { link, name, email, password: newBox.value });
          done('joined');
        } catch (error) {
          problem.textContent = error.message || String(error);
        } finally {
          go.disabled = false;
        }
        return;
      }
      go.disabled = true;
      try {
        const answer = await V.pc.call('joinInvite', { link, password: passRow.hidden ? '' : passBox.value });
        if (answer.needsPassword) {
          passRow.hidden = false;
          problem.textContent = 'That link is for signing in: type your Vault password too.';
          passBox.focus();
          return;
        }
        done();
      } catch (error) {
        problem.textContent = error.message || String(error);
      } finally {
        go.disabled = false;
      }
    } });
    for (const box of [linkBox, passBox, againBox]) box.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
    screen(V.h('h1', { text: 'Join with an invite' }),
      V.h('p.muted', { text: 'Paste the invite link a friend sent you (or the link of their join QR code). It gives you your own Vault in their cloud: other people using it can\'t see your notes.' }),
      linkRow, passRow, details, problem, go,
      V.h('button.link-btn', { type: 'button', text: 'Set up my own cloud instead', onclick: back }));
    requestAnimationFrame(() => linkBox.focus());
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
      hint.querySelector('p').textContent = V.files.dropText() || (V.chat && V.chat.dropText()) || `Drop to send to ${V.otherName}`;
    });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
    window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', (event) => {
      depth = 0;
      hint.hidden = true;
      if (!hasFiles(event) || !V.data.user) return;
      event.preventDefault();
      if (V.files.takeDrop(event.dataTransfer.files)) return;  // onto Vault Drive in the Files tab
      if (V.chat && V.chat.takeDrop(event.dataTransfer.files)) return;  // into the message in the Chat tab
      V.go('send');
      V.send.files(event.dataTransfer.files);
    });
  }

  /* ---------------------------------------------------------------- off we go */

  async function main() {
    buildShell();
    const { firstSync } = await V.cloud.start();
    const kept = V.update.resume();  // where the owner was before Vault reloaded into an update
    const asked = location.hash;  // the home screen icon's shortcuts: "New note", "Send to PC" and "Send clipboard"
    if (kept && TABS.some(([id]) => id === kept.tab)) current = kept.tab;
    if (asked === '#send') current = 'send';
    if (asked === '#clip') current = 'clips';
    if (asked === '#chat' || asked === '#claude') current = 'claude';  // the Chat tab (#claude: its id, kept working)
    // The Chat tab's script (and the others after this one) may still be loading: a page opened on it waits for them.
    if (document.readyState === 'loading') await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
    V.go(current);
    if (kept && kept.note && current === 'notes' && V.data.notes.has(kept.note)) V.notes.open(kept.note);
    if (asked === '#new') V.notes.chooseTemplate();
    if (['#new', '#send', '#clip', '#chat', '#claude'].includes(asked)) history.replaceState(null, '', location.pathname + location.search);
    // The icon's "Send clipboard" with Vault already open (the usual way on a phone): Chrome only brings it to the
    // front with #clip in the address, which doesn't start the page again. The same, once Vault is in sight.
    const clipAsked = () => {
      if (V.desktop || location.hash !== '#clip' || V.away()) return;
      history.replaceState(null, '', location.pathname + location.search);
      V.go('clips');
      V.clips.sendNow();
    };
    window.addEventListener('hashchange', clipAsked);
    V.on('back', clipAsked);
    dropAnywhere();
    // Safari may clear a site's storage after a week unused (not an installed icon's): asked to keep it.
    if (V.deviceKind.ios && !V.install.installed() && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    firstSync.then(async () => {
      if (V.deviceLog) V.deviceLog.start();  // this device's line in the owner's Stats (js/access.js), now and then
      if (V.cloud.status === 'synced' || V.cloud.status === 'held') await V.notes.ensureStarterFolders();
      V.send.checkIncoming();
      V.send.runQueue();
      if (!V.desktop) V.send.takeShared();
      if (asked === '#clip' && !V.desktop) V.clips.sendNow();
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
    let joined = false;  // made a new account with a join code just now: no password to choose, the welcome steps next
    try {
      if (V.desktop) {
        await V.pc.ready;
        let config = await V.pc.call('config');
        V.theme.system(config.scheme);  // Windows' own light or dark, for Settings > Appearance > System
        V.pc.knows(config);
        V.pcWindow(config.shown);
        if (await V.update.atBoot(config)) return;
        if (!config.url) {
          joined = (await setupScreen()) === 'joined';
          config = await V.pc.call('config');
        }
        V.config = config;
        V.prefs = config.prefs || {};
        V.cloud.client(config);
        if (!config.signedIn) {
          await signInScreen(config.email || '');
          config = await V.pc.call('config');
        }
        V.data.user = { id: config.userId, email: config.email, invited: !!config.invited, name: config.name || '' };
      } else {
        takeConnectLink();
        if (await V.update.atBoot()) return;
        takeInviteLink();
        takeJoinLink();
        if ((invite && invite.busy) || (join && join.busy)) await busyScreen();
        else if ((invite || join) && V.deviceKind.inApp) await inAppScreen();
        const saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
        if (!saved) return connectScreen();
        V.config = { ...saved, phoneUrl: location.origin + location.pathname };
        V.cloud.client(saved);
        let user = await V.cloud.user();
        if (!user && join) {  // a join code: their own name, e-mail and password make their account
          joined = (await joinCodeScreen()) === 'joined';
          user = await V.cloud.user();
        }
        let note = '';
        if (!user && invite) {  // signed in by the invite's own code
          try {
            await V.cloud.signIn(invite.email, invite.code);
            user = await V.cloud.user();
          } catch (error) {
            note = /fetch|network|load failed/i.test(error.message || '')
              ? 'Vault couldn\'t reach the cloud. Check the internet, then open the invite link again.'
              : 'That invite has already been used (or a newer one was made). If you chose your own password, sign in with it; otherwise ask for a new invite.';
          }
        }
        if (!user) {
          await signInScreen((invite && invite.email) || saved.email || '', note);
          user = await V.cloud.user();
        }
        V.data.user = user;
      }
      // A friend still on their one-time invite code chooses their own password first, then the welcome steps
      // (js/welcome.js: their free AI key, Vault on the home screen), picked up where they were if Vault was closed.
      // One who joined with a join code picked theirs already: straight to the steps.
      if ((await mustChoose()) || (joined && V.data.user && V.data.user.id)) V.welcome.remember(V.data.user.id);
      if (V.welcome.pending(V.data.user && V.data.user.id)) {
        hello();  // (a gate screen like the others: this version started, whether or not the steps get finished now)
        await V.welcome.run({ screen, user: V.data.user, name: (invite && invite.name) || V.data.user.name || '' });
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
