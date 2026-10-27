/* Vault: keeping itself up to date, by itself and never while it's being used.

   On the phone a new version comes from GitHub Pages through sw.js, which installs a whole, checked version and then
   waits. On the PC the Vault app downloads it (vault/webupdate.py) and says 'update-ready'. Either way it's only
   switched to at a safe moment: right at the start (before anything is drawn), or while Vault is out of sight (V.away)
   with every save done, no word half-typed, nothing being sent and no dialog open; never on the setup or sign-in
   screens. Where the owner was (the tab, the open note) is kept across the reload, and a toast says it's updated.

   Checks: when the app comes back to the front (at most every 15 minutes), when the internet comes back, every 2 hours
   while it's open, and from Settings. The PC app checks by itself (a minute after it starts, then every 6 hours). */
'use strict';

V.update = (() => {
  const FRONT_GAP = 15 * 60 * 1000;
  const EVERY = 2 * 60 * 60 * 1000;
  const RETRY = 30 * 1000;               // out of sight but not settled yet (a save, a send): looked at again
  const KEPT = 'vault-update-resume';     // sessionStorage: where the owner was, for after the reload
  const CHECKED = 'vault-update-checked'; // localStorage: when this phone last checked (Settings shows it)
  let registration = null;
  let next = null;           // the phone's new service worker, installed and waiting
  let registering = null;
  let ready = null;          // a version waiting to be switched to: { version }
  let behind = false;        // another tab switched already: this page runs the old code
  let needsShell = '';       // PC: a version that needs the PC part updated (a Jarvis update) first
  let applying = false;
  let switchedTo = null;     // what to do when the new service worker takes over
  let started = false;       // the app itself is showing
  let controlled = false;    // the page had a service worker from the start (so a new one taking over is an update)
  let checking = null;
  let again = null;
  let lastCheck = 0;
  let toldLater = false;
  let pc = {};               // PC: what the app said about its copies (config.update)

  /* A file picker or the camera is open (Android puts Vault in the background for them), or words typed in Send or
     Clipboard aren't sent yet: a reload now would lose them. */
  let picking = 0;
  const isPicker = (target) => target instanceof HTMLInputElement && target.type === 'file';
  document.addEventListener('click', (event) => { if (isPicker(event.target)) picking = Date.now(); }, true);
  for (const type of ['change', 'cancel']) {
    document.addEventListener(type, (event) => { if (isPicker(event.target)) picking = 0; }, true);
  }
  const inUse = () => (picking && Date.now() - picking < 10 * 60 * 1000)
    || [...document.querySelectorAll('#app .send-row textarea')].some((box) => box.value.trim() !== '');

  const storage = (kind) => { try { return window[kind]; } catch (error) { return null; } };
  const read = (kind, key) => {
    try { return JSON.parse(storage(kind).getItem(key) || 'null'); } catch (error) { return null; }
  };
  const write = (kind, key, value) => {
    try {
      if (value === null) storage(kind).removeItem(key); else storage(kind).setItem(key, JSON.stringify(value));
    } catch (error) { /* private browsing: it just isn't remembered */ }
  };

  function noteChecked(at) {
    const when = at || new Date().toISOString();
    lastCheck = Date.parse(when) || Date.now();
    if (!V.desktop) write('localStorage', CHECKED, when);
    else pc.checked = when;
    V.emit('update');
  }

  const workers = () => !V.desktop && 'serviceWorker' in navigator && (location.protocol === 'https:'
    || (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname)));

  /* -- the phone's service worker */

  /* A waiting worker's version: it says its build (version-hash) when asked. */
  function versionOf(worker) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(''), 3000);
      channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(String((event.data || {}).build || '').split('-')[0]); };
      try { worker.postMessage({ vault: 'build' }, [channel.port2]); } catch (error) { clearTimeout(timer); resolve(''); }
    });
  }

  /* (The worker itself when it has just said "installed": the registration's own fields can lag behind.) */
  async function lookForWaiting(worker) {
    const waiting = worker && worker.state === 'installed' ? worker : registration && registration.waiting;
    if (!waiting || !navigator.serviceWorker.controller) return false;
    next = waiting;
    found(await versionOf(waiting));
    return true;
  }

  function register() {
    return navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((made) => {
      registration = made;
      made.addEventListener('updatefound', () => {
        const coming = made.installing;
        if (coming) coming.addEventListener('statechange', () => { if (coming.state === 'installed') lookForWaiting(coming); });
      });
      lookForWaiting();
      return made;
    }).catch((error) => { console.warn('Vault: no offline copy', error); return null; });
  }

  /* The worker a check started installing, if any. update() can finish before the registration says so, so a
     moment is given for that. */
  function installingAfter(update) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        registration.removeEventListener('updatefound', finish);
        resolve(registration.installing);
      };
      registration.addEventListener('updatefound', finish);
      update.then(() => {
        if (registration.installing || registration.waiting !== next) finish();
        else setTimeout(finish, 1500);
      }, (error) => { done = true; registration.removeEventListener('updatefound', finish); reject(error); });
    });
  }

  function takenOver() {
    if (!controlled) { controlled = true; return; }  // the very first service worker: not an update
    if (switchedTo) { const go = switchedTo; switchedTo = null; go(); return; }
    // Another tab switched: this page now runs the old version's code, so it reloads too, at the next safe moment.
    behind = true;
    found(ready ? ready.version : '');
  }

  /* -- switching */

  function keep() {
    const old = read('sessionStorage', KEPT) || {};
    write('sessionStorage', KEPT, {
      tab: V.tab ? V.tab() : old.tab || 'notes',
      note: (V.editor && V.editor.openId()) || (started ? null : old.note || null),
      from: old.from || V.VERSION,
    });
  }

  /* Reloads into the waiting version. Resolves true while that happens, false if it didn't (the owner stays put).
     `asked`: the owner pressed "Update now", so it goes even with Vault in front. */
  function apply(asked) {
    if (applying) return Promise.resolve(true);
    applying = true;
    keep();
    const failed = () => {
      applying = false;
      switchedTo = null;
      const kept = read('sessionStorage', KEPT);
      if (kept && started) write('sessionStorage', KEPT, null);
      return false;
    };
    if (V.desktop) {
      return V.pc.call('applyUpdate').then(() => true, (error) => { console.warn('Vault: update', error); return failed(); });
    }
    const worker = (next && next.state === 'installed' ? next : null) || (registration && registration.waiting);
    if (!worker) {
      if (!behind) return Promise.resolve(failed());
      location.reload();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const giveUp = setTimeout(() => resolve(failed()), 10000);
      switchedTo = () => {
        clearTimeout(giveUp);
        resolve(true);
        if (asked || !started || V.away()) { location.reload(); return; }
        // The phone froze Vault in the background mid-switch and it's back in front now: the reload waits for the
        // next time it's out of sight (this page's code keeps working meanwhile).
        applying = false;
        behind = true;
        found(ready ? ready.version : '');
      };
      worker.postMessage({ vault: 'update-now' });
    });
  }

  const app = () => document.getElementById('app');
  const onGate = () => !app().classList.contains('ready') || app().classList.contains('gate');  // setup, sign-in
  const dialogOpen = () => !!document.querySelector('#layers > .layer, #layers > .nt-layer');  // (the note-taker too)

  /* Only out of sight, with the note saved and settled, nothing being sent, no dialog: then nothing can be lost. */
  async function whenSafe() {
    if (!ready || applying || !started || !V.away() || onGate() || dialogOpen() || inUse()) return false;
    const settled = await V.editor.settled();
    if (!settled || V.send.busy() || (V.files && V.files.busy()) || applying || !V.away() || onGate() || dialogOpen()
      || inUse()) return false;
    return apply();
  }

  const tryNow = () => whenSafe().catch((error) => console.warn('Vault: update', error));

  function found(version) {
    ready = { version: version || (ready && ready.version) || '' };
    V.emit('update');
    tryNow();
  }

  /* -- checking */

  /* One check at a time; asked during one, another goes once it's done (the first may have started before the
     newest version was out). */
  function check() {
    if (checking) {
      if (!again) again = checking.catch(() => {}).then(() => { again = null; return check(); });
      return again;
    }
    checking = checkNow().finally(() => { checking = null; V.emit('update'); });
    return checking;
  }

  async function checkNow() {
    if (V.desktop) {
      if (!V.pc.can('checkUpdates')) return { state: 'error', message: 'This Vault app checks with Jarvis updates.' };
      let answer;
      try { answer = await V.pc.call('checkUpdates'); } catch (error) { return { state: 'error', message: error.message }; }
      noteChecked(answer.checked);
      if (answer.state === 'installed') found(answer.version);
      if (answer.state === 'needs_shell') needsShell = answer.version || '';
      return answer;
    }
    if (!registration) registration = await (registering || (registering = register()));
    if (!registration) return { state: 'error', message: 'Updates come when Vault is opened from its web address.' };
    noteChecked();
    let coming;
    try {
      coming = await installingAfter(registration.update());
    } catch (error) {
      return { state: 'error', message: navigator.onLine ? 'Vault\'s home page couldn\'t be reached just now.' : 'No internet just now.' };
    }
    if (coming) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60000);
        const look = () => {
          if (['installed', 'activated', 'redundant'].includes(coming.state)) { clearTimeout(timer); resolve(); }
        };
        coming.addEventListener('statechange', look);
        look();
      });
    }
    if (await lookForWaiting(coming)) return { state: 'installed', version: ready.version };
    return { state: 'current', version: V.VERSION };
  }

  /* -- what's new */

  async function notes() {
    try {
      const listing = await (await fetch('version.json', { cache: 'no-cache' })).json();
      return Array.isArray(listing.notes) ? listing.notes.map(String) : [];
    } catch (error) {
      return [];
    }
  }

  async function whatsNew() {
    const lines = await notes();
    V.sheet({
      title: `What's new in Vault ${V.VERSION}`,
      content: lines.length ? V.h('ul.news', {}, lines.map((line) => V.h('li', { text: line })))
        : V.h('p.muted', { text: 'Nothing to tell about this version.' }),
      actions: [{ label: 'OK', kind: 'primary' }],
    });
  }

  function tell() {
    V.toast(`Updated to Vault ${V.VERSION}`, { action: 'What\'s new', onAction: whatsNew, ms: 9000 });
  }

  /* -- starting up (start.js) */

  return {
    /* Before anything is drawn. True when the page is reloading into a waiting version (start.js stops there). */
    async atBoot(config) {
      if (V.desktop) {
        pc = (config && config.update) || {};
        needsShell = pc.needsShell || '';
        V.on('pc:update-ready', (said) => { noteChecked(said.checked); found(said.version); });
        if (pc.ready && V.pc.can('applyUpdate')) {
          ready = { version: pc.ready };
          if (await apply()) return true;
        }
        return false;
      }
      if (!workers()) return false;
      controlled = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', takenOver);
      const existing = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (existing && existing.waiting && controlled) {
        registration = existing;
        ready = { version: '' };
        if (await apply()) return true;
      }
      registering = register();
      return false;
    },

    /* Where the owner was before the update's reload ({ tab, note, from }), once. */
    resume() {
      const kept = read('sessionStorage', KEPT);
      write('sessionStorage', KEPT, null);
      return kept;
    },

    /* The app is showing: from now on updates wait for a safe moment. */
    started(kept) {
      started = true;
      lastCheck = Date.parse(V.desktop ? pc.checked || '' : read('localStorage', CHECKED) || '') || 0;
      if (kept && kept.from && kept.from !== V.VERSION) {
        if (V.away()) toldLater = true; else tell();
      }
      V.on('away', tryNow);
      V.on('back', () => {
        if (toldLater) { toldLater = false; tell(); }
        if (!V.desktop && Date.now() - lastCheck > FRONT_GAP) check();
      });
      setInterval(() => { if (ready && V.away()) tryNow(); }, RETRY);
      if (!V.desktop) {
        setInterval(() => { if (!V.away()) check(); }, EVERY);
        window.addEventListener('online', () => check());
        if (Date.now() - lastCheck > FRONT_GAP) check();
      }
      tryNow();
    },

    check,
    whatsNew,
    /* Settings' "Update now": the owner asked, so it goes now, once nothing would be lost. */
    async now() {
      if (!(await V.editor.settled()) || V.send.busy() || V.files.busy()) {
        V.toast('Vault updates as soon as what\'s being saved or sent is done.');
        return false;
      }
      return apply(true);
    },
    /* PC: back to the copy that came with Jarvis (Settings, when a downloaded one misbehaves). */
    async useBuiltIn() {
      keep();
      await V.pc.call('useBundled');
    },
    state: () => ({
      version: V.VERSION,
      ready: ready ? ready.version || 'A new version' : '',
      needsShell,
      checked: V.desktop ? pc.checked || '' : read('localStorage', CHECKED) || '',
      canCheck: V.desktop ? V.pc.can('checkUpdates') : workers(),
      downloaded: V.desktop && pc.builtIn === false,
    }),
  };
})();
