/* Wefty: notifications on a phone or a Chromebook, even while Wefty is closed (1.19, Web Push). The owner: friends
   should get past day one and come back, and a nudge at the right moment is what brings them back.

   What comes (each one switched on or off in Settings > Notifications, for every device of the person at once,
   extra.notify in their settings row):
   - the reminders they set ("Badminton · 6:00 PM"), at their time, repeating ones too;
   - a study nudge once a day at the time they pick (4 PM unless changed), only when cards are left for today or a
     test is close: "12 cards to study today" / "Bio test in 3 days. Tap to start." A tap opens the cards;
   - the evening before a test (7 PM): "Bio test tomorrow · 8 cards left to go over".
   Wefty's own nudges never come in quiet hours (21:30 to 7:00 unless changed); a reminder someone set comes at its time.

   Who sends them: the helper in the owner's cloud (vault/functions/vault-admin, version 4), which a timer there asks
   every 5 minutes. Each device that turned them on is signed up with it ("push-subscribe"), with its own sign-in; the
   helper encrypts each message for that device alone. The page keeps two things in the settings row for it: the time
   zone, and `ahead` (what V.review.ahead works out: the cards to study today and each day after, and the tests
   coming up), written by any Wefty that has the notes (the PC too) whenever they change, so the nudge says the right
   number and never comes once today's cards are done.

   Asking: never on first launch, never by itself. Settings > Notifications says what they're for first ("Get a nudge
   when cards are due and before tests"), and the system's question only comes from a tap on Turn on; after the first
   study session, Today offers it once (Turn on / Not now). An iPhone can only have them in the Wefty app on its Home
   Screen, on iOS 16.4 or newer: the page says so plainly, with the steps. The PC shows nothing new (Qt has no Web Push,
   and Jarvis already says reminders there). A cloud whose helper is older offers nothing: the page says who can update
   it. Signing out signs this device off first, so the next person on it never gets someone else's reminders. */
'use strict';

V.push = (() => {
  const SLUG = 'vault-admin';
  const KEPT = 'vault-push';          // localStorage: this device's sign-up { user, endpoint, key, day }
  const OFFER = 'vault-push-offer';   // localStorage: 'studied' (Today may offer it), 'done' (offered: never again)
  const DEFAULTS = { reminders: true, study: true, tests: true, at: '16:00', quiet: ['21:30', '07:00'] };
  const AHEAD_DAYS = 14;
  const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
  // (tests shorten them) ask: a request to the helper; ahead: after notes change, before the nudge's numbers are
  // written; worker: waiting for the service worker; recheck: how long what the helper said is trusted
  const waits = { ask: 20000, ahead: 15000, worker: 5000, recheck: 10 * 60000 };
  const KIND_NAMES = { android: 'Android phone', iphone: 'iPhone', ipad: 'iPad', chromebook: 'Chromebook', browser: 'Browser',
    pc: 'PC' };

  let helper = null;        // { state: 'ready' | 'old' | 'missing' | 'offline' | 'error', key, timer, message, at }
  let checking = null;
  let devices = null;       // the person's devices with notifications on, as the helper last listed them
  let busy = '';            // 'on' | 'off' | 'test' | 'remove' while that runs
  let trouble = '';         // the page's last problem, said under its buttons
  let wrote = '';           // the numbers this device last wrote (so the same ones aren't written again)
  let aheadTimer = null;
  let started = false;

  const me = () => (V.data && V.data.user && V.data.user.id) || '';
  const isOwner = () => V.who() === 'owner';
  const read = (key) => { try { return localStorage.getItem(key); } catch (error) { return null; } };
  const write = (key, value) => {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (error) { /* private */ }
  };
  const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { return ''; } };
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)),
    (c) => c.charCodeAt(0));
  const offline = (error) => !navigator.onLine || !!(error && error.offline)
    || /fetch|network|internet|offline|load failed|reach/i.test(String((error && error.message) || error));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const here = () => (V.device === 'phone' ? `this ${V.deviceKind.ios ? V.deviceKind.model : 'phone'}`
    : V.deviceKind.chromebook ? 'this Chromebook' : 'this browser');

  /* This device's sign-up as kept here, if it's the signed-in person's. */
  function kept() {
    try {
      const value = JSON.parse(read(KEPT) || 'null');
      return value && typeof value === 'object' && value.user && value.user === me() && typeof value.endpoint === 'string' ? value : null;
    } catch (error) {
      return null;
    }
  }

  /* -- what this device can do */

  /* '' when this device can have notifications, else why not: 'pc', 'in-app', 'ios-tab' (an iPhone or iPad in a
     browser tab: only the Home Screen app can), 'ios-old' (the Home Screen app on an iOS before 16.4), 'none'. */
  function support() {
    if (V.desktop) return 'pc';
    const kind = V.deviceKind || {};
    if (kind.inApp) return 'in-app';
    if (kind.ios && !(V.install && V.install.installed())) return 'ios-tab';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return kind.ios ? 'ios-old' : 'none';
    return '';
  }

  const permission = () => { try { return 'Notification' in window ? Notification.permission : 'default'; } catch (error) { return 'default'; } };

  /* The service worker's registration (js/update.js registers it), or null when there's none in time. */
  async function registration() {
    if (!('serviceWorker' in navigator)) return null;
    const found = await navigator.serviceWorker.getRegistration().catch(() => null);
    if (found && found.pushManager) return found;
    return Promise.race([navigator.serviceWorker.ready.catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), waits.worker))]);
  }

  const keyOf = (subscription) => {
    const key = subscription && subscription.options && subscription.options.applicationServerKey;
    return key ? b64(key) : '';
  };

  /* -- asking the helper (with this person's own sign-in, never a key) */

  async function ask(action, args = {}) {
    const control = new AbortController();
    const stop = setTimeout(() => control.abort(), waits.ask);
    let response;
    try {
      const token = await V.cloud.accessToken();
      response = await fetch(`${V.config.url}/functions/v1/${SLUG}`, { method: 'POST', signal: control.signal,
        headers: { apikey: V.config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, action }) });
    } catch (error) {
      if (error && error.kind === 'signed-out') throw error;
      throw Object.assign(new Error(navigator.onLine ? 'Wefty couldn\'t reach your cloud just now. Try again in a minute.'
        : 'You\'re offline. Try again when you\'re back online.'), { offline: true });
    } finally {
      clearTimeout(stop);
    }
    const said = await response.json().catch(() => ({}));
    if (response.ok) return said && typeof said === 'object' ? said : {};
    const message = said && typeof said.message === 'string' && said.message ? V.weftyWords(said.message)
      : `Your cloud's helper said ${response.status}.`;
    throw Object.assign(new Error(message), { status: response.status, code: (said && said.error) || '' });
  }

  const canAsk = () => !V.desktop && !!me() && !!(V.config && V.config.url && V.cloud && V.cloud.sb);

  /* Whether this cloud's helper sends notifications: asked again after waits.recheck (or when `fresh`). An older
     helper (the owner gets "doesn't know that yet", a friend "only the owner"), or none, is 'old' / 'missing'. */
  function check(fresh = false) {
    if (!canAsk()) return Promise.resolve(helper);
    if (!fresh && helper && helper.state !== 'offline' && Date.now() - helper.at < waits.recheck) return Promise.resolve(helper);
    if (checking) return checking;
    checking = ask('push-key').then((got) => {
      const key = typeof got.key === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(got.key) ? got.key : '';
      helper = { state: got.ready && key ? 'ready' : 'old', key, timer: !!got.timer, at: Date.now() };
    }, (error) => {
      const status = error && error.status;
      helper = { state: status === 404 ? 'missing' : status === 400 || status === 403 ? 'old' : offline(error) ? 'offline' : 'error',
        message: (error && error.message) || '', at: Date.now() };
    }).then(() => helper).finally(() => { checking = null; V.emit('push'); });
    return checking;
  }

  /* -- what the person asked for (extra.notify, every device of theirs) */

  function prefs() {
    const raw = (((V.data.settings || {}).extra || {}).notify) || {};
    const clock = (value, usual) => (typeof value === 'string' && CLOCK.test(value) ? value : usual);
    return { on: !!raw.on, reminders: raw.reminders !== false, study: raw.study !== false, tests: raw.tests !== false,
      at: clock(raw.at, DEFAULTS.at),
      quiet: raw.quiet === false ? false : Array.isArray(raw.quiet) && raw.quiet.length === 2
        ? [clock(raw.quiet[0], DEFAULTS.quiet[0]), clock(raw.quiet[1], DEFAULTS.quiet[1])] : [...DEFAULTS.quiet] };
  }

  /* One change to extra.notify, made on the cloud's newest copy (V.cloud.changeExtra). */
  const changeNotify = (change) => V.cloud.changeExtra((extra) => ({ ...extra,
    notify: change({ ...((extra && extra.notify && typeof extra.notify === 'object') ? extra.notify : {}) }) }));

  /* -- the nudge's numbers (extra.notify.ahead) */

  /* What V.review works out now: { day, cards: [today's left, then each day's], tests: [{ id, day, name, left }] }. */
  function aheadNow() {
    if (!V.review || !V.review.ahead || !V.data || !V.data.notes) return null;
    try { return V.review.ahead(AHEAD_DAYS); } catch (error) { console.error('Wefty: the study nudge\'s numbers:', error); return null; }
  }

  /* Written when notifications are on for this person (on any of their devices) and the numbers changed since they
     were last written; never while the settings row hasn't been read yet this time (the "on" may be old), offline,
     or mid-study (the session's answers come in its own save). */
  async function keepAhead() {
    clearTimeout(aheadTimer);
    aheadTimer = null;
    if (!me() || !navigator.onLine || !V.cloud || !V.cloud.settingsRead() || !prefs().on) return false;
    if (V.review && V.review.shown && V.review.shown()) { aheadSoon(); return false; }
    const now = aheadNow();
    if (!now) return false;
    const text = JSON.stringify(now);
    const stored = (((V.data.settings || {}).extra || {}).notify || {}).ahead;
    if (text === wrote || text === JSON.stringify(stored)) { wrote = text; return false; }
    try {
      await changeNotify((notify) => ({ ...notify, ahead: now, tz: notify.tz || zone() }));
      wrote = text;
      return true;
    } catch (error) {
      aheadSoon();  // (tried again later)
      return false;
    }
  }
  const aheadSoon = () => { clearTimeout(aheadTimer); aheadTimer = setTimeout(keepAhead, waits.ahead); };

  /* -- turning them on and off for this device */

  function device() {
    const record = V.deviceLog && V.deviceLog.record ? V.deviceLog.record() : { kind: V.deviceKind.kind, label: '' };
    return { kind: record.kind, label: record.label || KIND_NAMES[record.kind] || 'Browser',
      install: V.deviceLog && V.deviceLog.installId ? V.deviceLog.installId() : '' };
  }

  /* This device's subscription, signed up with the helper for the signed-in person (and kept here). */
  async function signUp(subscription) {
    const json = subscription.toJSON();
    const got = await ask('push-subscribe', { subscription: { endpoint: json.endpoint, keys: json.keys }, device: device(),
      tz: zone() });
    devices = Array.isArray(got.devices) ? got.devices : devices;
    write(KEPT, JSON.stringify({ user: me(), endpoint: json.endpoint, key: keyOf(subscription) || (helper && helper.key) || '',
      day: V.today() }));
    return got;
  }

  /* A subscription for the helper's key (an older one, for another key, is let go first). */
  async function subscribe(registered, key) {
    let subscription = await registered.pushManager.getSubscription();
    if (subscription && keyOf(subscription) && keyOf(subscription) !== key) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    return subscription || registered.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  }

  /* Turn on (only from a tap: the system's question needs one). True once this device is signed up. */
  async function turnOn() {
    if (busy) return false;
    const why = support();
    if (why) { V.toast(reasonWords(why)); return false; }
    // Asked first, straight from the tap (Safari only asks while the tap is fresh).
    let answered;
    try {
      answered = permission() === 'granted' ? Promise.resolve('granted') : Promise.resolve(Notification.requestPermission());
    } catch (error) {
      answered = Promise.resolve('default');
    }
    busy = 'on';
    trouble = '';
    V.emit('push');
    try {
      const answer = await answered;
      if (answer !== 'granted') {
        if (answer === 'denied') trouble = blockedWords();
        return false;
      }
      const state = await check(true);
      if (!state || state.state !== 'ready') throw new Error(helperWords(state));
      const registered = await registration();
      if (!registered) throw new Error('Wefty isn\'t ready on this device yet. Close it, open it again, and try once more.');
      await signUp(await subscribe(registered, state.key));
      await changeNotify((notify) => ({ ...notify, on: true, tz: zone() })).catch(() => null);
      write(OFFER, 'done');
      V.toast(`Notifications are on for ${here()}.`);
      keepAhead();
      return true;
    } catch (error) {
      trouble = (error && error.message) || String(error);
      return false;
    } finally {
      busy = '';
      V.emit('push');
      if (V.today && V.today.redraw) V.today.redraw();
    }
  }

  /* Turn off for this device (`quietly`: signing out, no words). This device first, as it's quick and needs nobody:
     once the browser lets its subscription go, the push service refuses the address, and the helper forgets it at
     its next send (404/410) even if it's never told. Then the helper, as far as it gets: signing out gives this a few
     seconds at most (beforeSignOut), and a slow network must never leave the device getting someone's reminders. */
  async function turnOff({ quietly = false } = {}) {
    if (busy && !quietly) return false;
    const mine = kept();
    busy = 'off';
    if (!quietly) V.emit('push');
    try {
      const registered = await registration();
      const subscription = registered ? await registered.pushManager.getSubscription().catch(() => null) : null;
      const endpoint = (mine && mine.endpoint) || (subscription && subscription.endpoint) || '';
      if (subscription) await subscription.unsubscribe().catch(() => false);
      write(KEPT, null);
      let told = !endpoint;
      if (endpoint && canAsk()) {
        const got = await ask('push-unsubscribe', { endpoint }).catch(() => null);
        if (got && Array.isArray(got.devices)) { devices = got.devices; told = true; }
      }
      if (!told && devices) devices = devices.filter((one) => !one.here);  // (gone here; the helper forgets it later)
      if (!quietly) {
        if (told && devices && !devices.length) await changeNotify((notify) => ({ ...notify, on: false })).catch(() => null);
        V.toast(`Notifications are off for ${here()}.`);
      }
      return true;
    } catch (error) {
      if (!quietly) trouble = (error && error.message) || String(error);
      return false;
    } finally {
      busy = '';
      if (!quietly) V.emit('push');
    }
  }

  /* Keeps this device's sign-up good when Wefty opens (and once a day): signed up again when the browser made it a new
     address or the helper's key changed, let go when notifications were blocked since, or when it's someone else's. */
  async function keepUp() {
    if (!canAsk() || support()) return;
    let stored = null;
    try { stored = JSON.parse(read(KEPT) || 'null'); } catch (error) { stored = null; }
    if (!stored || !stored.endpoint) return;
    if (stored.user !== me()) {  // (signed in as someone else since, without signing out here)
      write(KEPT, null);
      const registered = await registration();
      const subscription = registered && await registered.pushManager.getSubscription().catch(() => null);
      if (subscription) await subscription.unsubscribe().catch(() => false);
      return;
    }
    if (permission() !== 'granted') {
      await ask('push-unsubscribe', { endpoint: stored.endpoint }).catch(() => null);
      write(KEPT, null);
      V.emit('push');
      return;
    }
    const state = await check();
    if (!state || state.state !== 'ready') return;
    const registered = await registration();
    if (!registered) return;
    const subscription = await registered.pushManager.getSubscription().catch(() => null);
    if (subscription && subscription.endpoint === stored.endpoint && keyOf(subscription) === state.key && stored.day === V.today()) return;
    try {
      await signUp(await subscribe(registered, state.key));  // (allowed already: no question)
    } catch (error) {
      if (!offline(error)) console.warn('Wefty: notifications on this device:', error && error.message);
    }
    V.emit('push');
  }

  /* -- words */

  function reasonWords(why) {
    if (why === 'ios-tab') {
      return `On ${V.deviceKind.model === 'iPad' ? 'an iPad' : 'an iPhone'}, notifications only work in the Wefty app on your `
        + 'Home Screen (iOS 16.4 or newer). Add Wefty to your Home Screen, open it from there, and turn them on in Settings.';
    }
    if (why === 'ios-old') return 'Notifications need iOS 16.4 or newer. Update it in Settings > General > Software Update, then try again.';
    if (why === 'in-app') return 'Open Wefty in your browser (Chrome or Safari) to get notifications. This app\'s own browser can\'t show them.';
    if (why === 'pc') return 'On the PC, Jarvis says your reminders.';
    return 'This browser can\'t show Wefty\'s notifications. Try Chrome.';
  }

  function blockedWords() {
    const kind = V.deviceKind || {};
    if (kind.ios) return 'Notifications are blocked for Wefty. To allow them: Settings > Notifications > Wefty > Allow Notifications.';
    if (kind.chromebook) return 'Notifications are blocked for Wefty. To allow them: click the icon left of the address, then Site settings > Notifications > Allow.';
    if (V.install && V.install.installed() && kind.android) {
      return 'Notifications are blocked for Wefty. To allow them: hold Wefty\'s icon > App info > Notifications, and switch them on.';
    }
    return 'Notifications are blocked for Wefty. To allow them: tap ⋮ > Settings > Site settings > Notifications, then allow this site.';
  }

  function helperWords(state) {
    if (!state || state.state === 'offline') return 'You\'re offline. Try again when you\'re back online.';
    if (state.state === 'error') return state.message || 'Wefty couldn\'t reach your cloud\'s helper just now. Try again in a minute.';
    if (isOwner()) {
      return state.state === 'missing'
        ? 'Notifications need Wefty\'s helper in your cloud. On your PC: your picture > Friends > Set up (with a Supabase access token).'
        : 'Notifications need the newest helper in your cloud. On your PC: your picture > Friends > Update the helper.';
    }
    // (1.21: someone who signed up by themselves has nobody who invited them: Wefty's own team runs their cloud)
    if (V.who() === 'self') return `Notifications aren't ready in Wefty's cloud yet. Wefty's team can switch them on: write to ${V.TEAM_EMAIL}.`;
    return 'Notifications aren\'t set up in this Wefty yet. Ask the person who invited you to update Wefty\'s helper on their PC.';
  }

  /* -- Settings > Notifications */

  const switchFor = (label, on, change, disabled = false) => V.h('input.switch', { type: 'checkbox', checked: !!on, disabled,
    'aria-label': label, onchange: (event) => change(event.target.checked, event.target) });

  /* One account-wide setting changed: written at once (another device sees it at its next sync), put back when it
     couldn't be. */
  async function setPref(apply, control, ui) {
    if (control) control.disabled = true;
    try {
      await changeNotify((notify) => apply({ ...DEFAULTS, ...notify }));
    } catch (error) {
      V.toast(offline(error) ? 'That wasn\'t changed: you\'re offline.' : 'That wasn\'t changed. Try again in a moment.', { kind: 'err' });
    } finally {
      if (control) control.disabled = false;
      if (ui) ui.draw();
    }
  }

  const timeBox = (label, value, onPick) => V.h('input.field.push-time', { type: 'time', value, 'aria-label': label, step: 300,
    onchange: (event) => { if (CLOCK.test(event.target.value)) onPick(event.target.value, event.target); } });

  function page(ui) {
    const why = support();
    const on = !!kept() && permission() === 'granted';
    const p = prefs();
    if (!helper && !why) check();
    if (on && devices === null && canAsk()) listDevices(ui);
    const intro = 'Get a nudge when cards are due and before tests, and your reminders, even when Wefty is closed.';
    const sections = [];
    // This device
    const rows = [];
    if (why) {
      rows.push(ui.line(why === 'ios-tab' ? 'Only in the Home Screen app' : 'Not on this device', reasonWords(why), null, 'notifications-here'));
      if (why === 'ios-tab' && V.welcome && V.welcome.howToInstall) {
        rows.push(V.h('ol.steps.push-steps', {}, V.welcome.howToInstall().steps.map((step) => V.h('li', { text: step }))));
      }
    } else if (helper && helper.state !== 'ready' && helper.state !== 'offline') {
      rows.push(ui.line('Not ready in your cloud yet', helperWords(helper), null, 'notifications-here'));
    } else if (on) {
      rows.push(ui.line(`On for ${here()}`, 'Your reminders, study nudges and tests come here, even when Wefty is closed.',
        V.h('div.setting-buttons', {},
        V.button('Send a test', { icon: 'send', disabled: !!busy, onClick: () => sendTest(ui) }),
        V.button('Turn off', { disabled: !!busy, onClick: () => turnOff().then(() => ui.draw()) })), 'notifications-here'));
      if (helper && helper.state === 'ready' && !helper.timer) {
        rows.push(V.h('p.hint.warn-text.push-timer', { text: isOwner()
          ? 'Your cloud\'s timer hasn\'t run lately, so nothing is being sent. On your PC: your picture > Friends > Update the helper.'
          : V.who() === 'self' ? `Wefty's timer hasn't run lately, so nothing is being sent. Let ${V.TEAM} know.`
            : 'Your Wefty cloud\'s timer hasn\'t run lately, so nothing is being sent. Ask the person who invited you to update Wefty\'s helper.' }));
      }
    } else if (permission() === 'denied') {
      rows.push(ui.line('Blocked on this device', blockedWords(), null, 'notifications-here'));
    } else {
      rows.push(ui.line(`Notifications on ${here()}`, intro, V.button(busy === 'on' ? 'Turning on…' : 'Turn on', { kind: 'primary',
        icon: 'bell', disabled: !!busy || (helper && helper.state !== 'ready' && helper.state !== 'offline'),
        onClick: () => turnOn().then(() => ui.draw()) }), 'notifications-here'));
    }
    if (trouble) rows.push(V.h('p.error-text.push-trouble', { role: 'alert', text: trouble }));
    sections.push(ui.card(`On ${here()}`, rows));
    // What to send (every device of theirs)
    if (choices()) {
      sections.push(ui.card('What to send',
        ui.line('Reminders', 'The reminders you set, at their time.', switchFor('Reminders', p.reminders,
          (value, el) => setPref((n) => ({ ...n, reminders: value }), el, ui)), 'reminders'),
        ui.line('Study nudge', `Once a day at ${clockWords(p.at)}, when cards are due: “12 cards to study today”.`,
          V.h('div.push-pair', {}, timeBox('Study nudge time', p.at, (value, el) => setPref((n) => ({ ...n, at: value }), el, ui)),
            switchFor('Study nudge', p.study, (value, el) => setPref((n) => ({ ...n, study: value }), el, ui))), 'study-nudge'),
        ui.line('Tests', 'The evening before a test, at 7:00 PM.', switchFor('Tests', p.tests,
          (value, el) => setPref((n) => ({ ...n, tests: value }), el, ui)), 'tests-the-evening-before'),
        ui.line('Quiet hours', p.quiet ? `No nudges from ${clockWords(p.quiet[0])} to ${clockWords(p.quiet[1])}. Reminders you set still come.`
          : 'Off: nudges may come at any time.', switchFor('Quiet hours', !!p.quiet,
          (value, el) => setPref((n) => ({ ...n, quiet: value ? [...DEFAULTS.quiet] : false }), el, ui)), 'quiet-hours'),
        p.quiet ? V.h('div.push-quiet', { role: 'group', 'aria-label': 'Quiet hours' },
          V.h('label.label', {}, 'From', timeBox('Quiet from', p.quiet[0], (value, el) => setPref((n) => ({ ...n, quiet: [value, p.quiet[1]] }), el, ui))),
          V.h('label.label', {}, 'To', timeBox('Quiet until', p.quiet[1], (value, el) => setPref((n) => ({ ...n, quiet: [p.quiet[0], value] }), el, ui))))
          : null,
        quietClash(p) ? V.h('p.hint.warn-text', { text: 'Your study nudge is inside your quiet hours, so it won\'t come. Pick another time.' }) : null));
    }
    // Every device of theirs with notifications on
    if (devices && devices.length && (on || p.on)) {
      sections.push(ui.card('Your devices', devices.map((one) => ui.line(one.label || KIND_NAMES[one.kind] || 'A device',
        one.here ? 'This one' : one.since ? `Since ${new Date(one.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '',
        V.button('Remove', { disabled: !!busy, onClick: () => removeDevice(one, ui) }), `device-${one.id}`))));
    }
    return sections;
  }

  /* Whether the page shows what to send: on this device, or on another of theirs (it's one choice for all of them). */
  const choices = () => !support() && ((!!kept() && permission() === 'granted') || prefs().on);

  function quietClash(p) {
    if (!p.quiet || !p.study) return false;
    const m = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
    const [from, to, at] = [m(p.quiet[0]), m(p.quiet[1]), m(p.at)];
    return from !== to && (from < to ? at >= from && at < to : at >= from || at < to);
  }

  /* "16:00" as this device says times ("4:00 PM"). */
  function clockWords(text) {
    const [h, mi] = text.split(':').map(Number);
    return new Date(2000, 0, 1, h, mi).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  async function listDevices(ui) {
    if (devices === null) devices = [];
    try {
      const stored = kept();
      const got = await ask('push-devices', stored ? { endpoint: stored.endpoint } : {});
      devices = Array.isArray(got.devices) ? got.devices : [];
    } catch (error) {
      devices = [];
    }
    if (ui) ui.draw();
  }

  async function removeDevice(one, ui) {
    if (one.here) { await turnOff(); ui.draw(); return; }
    busy = 'remove';
    try {
      const got = await ask('push-unsubscribe', { id: one.id });
      devices = Array.isArray(got.devices) ? got.devices : devices;
      V.toast(`${one.label || 'That device'} won't get notifications any more.`);
    } catch (error) {
      V.toast(error.message || String(error), { kind: 'err' });
    } finally {
      busy = '';
      ui.draw();
    }
  }

  async function sendTest(ui) {
    const stored = kept();
    if (!stored || busy) return;
    busy = 'test';
    ui.draw();
    try {
      const got = await ask('push-test', { endpoint: stored.endpoint });
      if (got.sent === 'sent') V.toast('Sent. It should show in a few seconds.');
      else if (got.sent === 'gone' || got.sent === 'old-key') {
        write(KEPT, null);
        V.toast('This device needs turning on again: tap Turn on.', { kind: 'err' });
      } else V.toast('The test didn\'t go through. Try again in a minute.', { kind: 'err' });
    } catch (error) {
      V.toast(error.message || String(error), { kind: 'err' });
    } finally {
      busy = '';
      ui.draw();
    }
  }

  /* The Settings home's line: { parts, marked }. */
  function summary() {
    const why = support();
    if (why === 'ios-tab') return { parts: ['Needs the Home Screen app'] };
    if (why) return { parts: ['Not on this device'] };
    if (kept() && permission() === 'granted') {
      const p = prefs();
      return { parts: [`On for ${here()}`, p.study ? `study nudge ${clockWords(p.at)}` : 'reminders'] };
    }
    if (permission() === 'denied') return { parts: ['Blocked on this device'] };
    return { parts: ['Off', 'nudges for cards and tests'] };
  }

  /* -- Today's offer, once, after the first study session */

  function offerShown() {
    if (read(OFFER) !== 'studied' || kept() || permission() !== 'default') return false;
    const why = support();
    if (why && why !== 'ios-tab') return false;
    return !!helper && helper.state === 'ready';  // (an iPhone in a tab too: worth adding to the Home Screen only then)
  }

  function offerCard() {
    if (!offerShown()) return null;
    const ios = support() === 'ios-tab';
    const later = () => { write(OFFER, 'done'); V.today.redraw(); };
    return V.h('section.today-sec.push-offer', { dataset: { section: 'push' }, 'aria-labelledby': 'push-offer-title' },
      V.h('div.today-box.push-offer-box', {},
        V.h('div.push-offer-top', {}, V.icon('bell', 'push-offer-icon'),
          V.h('div.push-offer-words', {},
            V.h('h2', { id: 'push-offer-title', text: 'Get a nudge to study' }),
            V.h('p', { text: ios
              ? 'Wefty can tell you when cards are due and the evening before a test. On an iPhone, add Wefty to your Home Screen first.'
              : 'Wefty can tell you when cards are due and the evening before a test, even when it\'s closed.' }))),
        V.h('div.push-offer-go', {},
          V.button('Not now', { kind: 'quiet', onClick: later, key: 'push:later' }),
          ios ? V.button('Show me how', { kind: 'tonal', onClick: () => { write(OFFER, 'done'); V.settings.open('notifications'); }, key: 'push:how' })
            : V.button('Turn on', { kind: 'tonal', icon: 'bell', onClick: async () => { if (await turnOn()) later(); }, key: 'push:on' }))));
  }

  /* -- notifications already on the screen: taken away once what they're about is done (a reminder's note ticked done
     or deleted, here or on another device; today's cards all studied) */

  async function tidyShown() {
    if (V.desktop || !kept() || !V.data || !V.data.notes) return;
    const registered = await registration();
    if (!registered || !registered.getNotifications) return;
    const shown = await registered.getNotifications().catch(() => []);
    for (const one of shown) {
      const found = /^vault-([0-9a-f-]{36})$/.exec(one.tag || '');
      const note = found ? V.data.notes.get(found[1]) : null;
      if (note && (note.done || note.deleted)) one.close();
      if (one.tag === 'wefty-study' && V.review && V.review.dueCount && V.review.dueCount() === 0) one.close();
    }
  }
  const tidySoon = V.debounce(() => { tidyShown().catch(() => {}); }, 800);

  /* -- a notification tapped: the place it's about (#study, #test=<id>; a note's is js/reminders.js's #note=) */

  function openPlace(open, id) {
    if (open === 'study') {
      if (!V.review.now().list.length) { V.go('today'); return; }
      V.review.start('all');
    } else if (open === 'test' && id && V.data.notes.has(id)) {
      const note = V.data.notes.get(id);
      if (V.review.planFor(note)) V.review.start('test:' + id); else V.go('today');
    } else if (open === 'today') {
      V.go('today');
    }
  }

  let hashTries = 0;
  function fromHash() {
    const found = /^#(study|test=([0-9a-f-]{36}))$/i.exec(location.hash);
    if (!found) return;
    const app = document.getElementById('app');
    const ready = app && app.classList.contains('ready') && !app.classList.contains('gate') && V.cloud
      && ['synced', 'held', 'offline'].includes(V.cloud.status) && V.data.notes.size > 0;
    if (!ready && ++hashTries < 480) { setTimeout(fromHash, 250); return; }
    history.replaceState(history.state, '', location.pathname + location.search);
    hashTries = 0;
    if (ready) openPlace(found[1] === 'study' ? 'study' : 'test', found[2] ? found[2].toLowerCase() : '');
  }

  /* -- starting */

  function start() {
    if (started || V.desktop) return;
    started = true;
    keepUp();
    if (read(OFFER) === 'studied' && !kept()) check().then(() => { if (V.today && V.today.redraw) V.today.redraw(); });
    keepAhead();
  }

  V.on('study-done', () => {
    if (!read(OFFER)) write(OFFER, 'studied');
    if (!V.desktop && read(OFFER) === 'studied' && !kept()) check().then(() => { if (V.today && V.today.redraw) V.today.redraw(); });
    aheadSoon();
    tidySoon();
  });
  V.on('data', (table) => {
    if (table === 'notes' || table === 'folders') aheadSoon();
    if (table === 'notes') tidySoon();
  });
  V.on('back', () => { if (started) { keepUp(); aheadSoon(); } });
  /* Signing out (Settings): this device's notifications off first, while the sign-in still works to tell the helper,
     for a few seconds at most (offline, the push service forgets the device once it's unsubscribed here). */
  const beforeSignOut = () => (V.desktop || !kept() ? Promise.resolve(false)
    : Promise.race([turnOff({ quietly: true }), new Promise((resolve) => setTimeout(() => resolve(false), 4000))]));
  V.on('signing-out', () => {
    wrote = '';
    if (!V.desktop && kept()) turnOff({ quietly: true });  // (any other way out: as far as it gets)
  });
  /* The sign-in ended by itself (a password changed, the session ended elsewhere: js/cloud.js): the helper can't be told
     without a sign-in, so this device lets its subscription go (the helper forgets it at its next send). What's kept
     stays, so the same person signing in again is signed up again by keepUp (no question: allowed already), and
     anyone else gets nothing of theirs. */
  V.on('signed-out', () => {
    helper = null;
    devices = null;
    if (V.desktop) return;
    registration().then((registered) => registered && registered.pushManager.getSubscription())
      .then((subscription) => subscription && subscription.unsubscribe()).catch(() => false);
  });
  V.on('push', () => { if (V.settings && V.settings.draw && V.tab && V.tab() === 'settings') V.settings.draw(); });
  if (!V.desktop) {
    window.addEventListener('hashchange', () => { hashTries = 0; fromHash(); });
    setTimeout(fromHash, 0);
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const said = event.data || {};
        if (said.vault === 'open' && typeof said.open === 'string') openPlace(said.open, typeof said.id === 'string' ? said.id : '');
        if (said.vault === 'push-renewed' && started) keepUp();
      });
    }
  }
  // (Wefty's first sync done: whether this device is still signed up, and the nudge's numbers; js/start.js's main has
  // run by then, as this file loads after it)
  if (V.today && V.today.addSection) V.today.addSection({ id: 'push', order: 42, column: 'left', build: offerCard });

  return { support, permission, check, prefs, page, summary, turnOn, turnOff, keepUp, keepAhead, offerCard, openPlace, start,
    beforeSignOut, choices, waits, state: () => helper, devices: () => devices, kept };
})();
