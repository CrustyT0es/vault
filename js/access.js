/* Vault: early access for friends, and the owner's view of it. Three Settings cards, and a line each device keeps:

   "Invite people" (the owner, on any of their devices): each friend gets their own private Vault in the owner's free
   cloud. Making their account takes the project's secret key, which never reaches a page, a phone or a Chromebook.
   On the PC, Python does it (vault/invites.py, with the key kept in .env: vault/admin.py). Everywhere else, once the
   owner has set it up from the PC (Invite people > Set up, with a Supabase access token used once: vault/helper.py),
   Vault's helper in their cloud does it (vault/functions/vault-admin): asked with the owner's own sign-in, it answers
   only the owner. The owner's devices know it's there from the note its setup leaves in their private storage
   (<owner>/private/helper.json, which nobody else can read). A new account's first password is a one-time code; the
   invite link (or its QR code) signs the friend in with it, and then they choose their own password (js/start.js's
   chooseScreen), which ends it.

   Join QR codes (the helper's version 2): instead of typing in each friend, the owner shows one QR code ("Show QR
   code") that anyone may scan for the next 30 minutes to make their own Vault in the owner's cloud, typing their own
   name, e-mail and password on their own phone (js/start.js's joinCodeScreen). Only the helper makes the codes (and
   the accounts made with them: it checks the code itself, as whoever scans it has no sign-in yet), so the PC asks it
   too, even with the secret key here. "Stop this code" stops it (and every code shown before it) at once.

   "Stats" (the owner, wherever invites work): people joined and waiting, who was active lately, devices and Vault
   versions in use, notes, files and space, feedback waiting (vault/stats.py says how). Counts, sizes and times only,
   never what anyone wrote. Downloads aren't counted: nothing counts them, and Vault has no trackers.

   "Send feedback" (anyone): a bug, an idea or anything else, saved into the sender's OWN file storage as
   <their id>/feedback/<time>-<id>.json (the cloud's locks already allow that; nothing is queued when offline). The
   owner's PC collects everyone's into a Feedback folder of their own (vault/feedback.py), now and then by itself or
   with "Check feedback now".

   V.deviceLog: once a day at most, each device writes a line about itself into its own person's settings row
   (extra.devices[<this install's id>] = {kind, label, version, seen}), only while Vault is in front: what the owner's
   Stats count as devices, and part of how they tell who used Vault lately. */
'use strict';

V.invites = (() => {
  const SLUG = 'vault-admin';
  const PHONE_URL = 'https://crustyt0es.github.io/vault/';  // vault/__init__.py's, for a device that doesn't say
  const JOIN_SINCE = 2;  // the helper's first version that makes join codes (vault/helper.py's JOIN_SINCE)
  const JOINED_SLACK = 5000;  // the cloud's sign-in service and its helper may not quite agree on the time
  const waits = { tick: 30000, poll: 15000 };  // the join sheet's countdown, and asking who joined (tests shorten them)
  const TOKENS_PAGE = 'https://supabase.com/dashboard/account/tokens';
  const GONE = 'Vault\'s helper isn\'t in your cloud any more. Set it up again in Vault on your PC: Settings > Invite people > Set up.';
  const KIND_NAMES = { pc: 'PC', android: 'Android phone', iphone: 'iPhone', ipad: 'iPad', chromebook: 'Chromebook', browser: 'Browser' };
  // { how: 'pc' | 'old' | 'helper', on, helper (its note), local (the key on this PC), current, version (the helper's
  // own, as it said hello: phones and Chromebooks) }
  let state = null;
  let people = null;    // the people the owner invited, once asked
  let asking = null;
  let trouble = '';
  let stats = null;     // the Stats card's numbers, once asked
  let statsAsking = null;
  let statsTrouble = '';
  let progress = null;  // the setup sheet's progress line, while it shows

  const owner = () => { const user = V.data.user || {}; return !!user.id && !user.invited; };
  // The PC part: one new enough asks Python for everything (helper or key); an older one has 1.8's own calls.
  const newPc = () => !!(V.desktop && V.pc && V.pc.can('adminCall'));
  const oldPc = () => !!(V.desktop && V.pc && !newPc() && V.pc.can('invitesState'));
  const offline = (error) => !navigator.onLine || /fetch|network|internet|reach|offline/i.test(String((error && error.message) || error));
  const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const reset = () => { state = null; people = null; trouble = ''; stats = null; statsTrouble = ''; };

  if (V.desktop) {
    V.on('pc:helper-progress', ({ text }) => {
      if (progress) V.clear(progress, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text })));
    });
  }

  /* -- asking */

  /* The helper in the owner's cloud, straight from this device with the owner's own sign-in (never a key). */
  async function helperCall(action, args = {}, wait = 30000) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), wait);
    let response;
    try {
      const token = await V.cloud.accessToken();
      response = await fetch(`${V.config.url}/functions/v1/${SLUG}`, { method: 'POST', signal: control.signal,
        headers: { apikey: V.config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, action }) });
    } catch (error) {
      if (error && error.kind === 'signed-out') throw error;
      throw new Error(navigator.onLine ? 'Vault couldn\'t reach your cloud\'s helper just now. Try again in a minute.' : 'You\'re offline.');
    } finally {
      clearTimeout(timer);
    }
    const answer = await response.json().catch(() => ({}));
    if (response.ok) return answer;
    const message = response.status === 404 ? GONE
      : answer && typeof answer.message === 'string' && answer.message ? answer.message : `Your cloud's helper said ${response.status}.`;
    throw Object.assign(new Error(message), { status: response.status, code: (answer && answer.error) || '' });
  }

  /* hello / people / invite / remove / stats / join-open / join-stop, wherever this device does them (join codes
     always through the helper: on the PC, Python sees to that). */
  async function call(action, args = {}) {
    if (newPc()) return V.pc.call('adminCall', { action, args });
    if (oldPc()) {
      if (action === 'people') return V.pc.call('invitesList');
      if (action === 'invite') return V.pc.call('invitesMake', { name: args.name || '', email: args.email || '' });
      if (action === 'remove') return V.pc.call('invitesRemove', { id: args.id });
      throw new Error('Open Jarvis and click Update to see this here.');
    }
    return helperCall(action, args, action === 'stats' ? 90000 : 30000);
  }

  /* The note the helper's setup left in the owner's private storage, or null when it isn't set up. */
  async function findHelper() {
    const { data, error } = await V.cloud.sb.storage.from('vault').download(`${V.data.user.id}/private/helper.json`);
    if (error || !data) {
      const said = `${(error && error.name) || ''} ${(error && error.message) || ''}`;
      if (!navigator.onLine || /fetch|network|load failed|unknown/i.test(said)) throw new Error('You\'re offline.');
      return null;
    }
    try {
      const note = JSON.parse(await data.text());
      return note && note.slug === SLUG ? note : null;
    } catch (failed) {
      return null;
    }
  }

  function refresh(ui) {
    if (asking || !owner()) return;
    asking = (async () => {
      trouble = '';
      let now;
      if (newPc()) {
        const found = await V.pc.call('helperState');
        now = { how: 'pc', on: !!(found.helper || found.local), helper: found.helper || null, local: !!found.local,
          current: Number(found.current) || 0 };
      } else if (oldPc()) {
        const found = await V.pc.call('invitesState');
        now = { how: 'old', on: !!found.on && !found.invited, local: !!found.on };
      } else {
        const note = await findHelper();
        const said = note ? await helperCall('hello') : null;  // there, and answering this owner
        now = { how: 'helper', on: !!note, helper: note,
          version: Number(said && said.version) || Number(note && note.version) || 0 };
      }
      state = now;
      people = state.on ? ((await call('people')).people || []) : null;
    })().catch((error) => {
      trouble = error.message || String(error);
      if (!state) state = { how: null, on: false, failed: true };
    }).finally(() => { asking = null; if (ui) ui.draw(); });
  }

  /* -- setting it up (the PC) */

  const tokensButton = () => V.button('Open the tokens page', { icon: 'open',
    onClick: () => V.pc.call('openLink', { url: TOKENS_PAGE }).catch(V.problem) });
  const tokenBox = () => V.h('input.field', { type: 'password', placeholder: 'sbp_...', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Supabase access token' });

  /* Set up (or update) the helper with an access token, used once and never kept. The secret key itself works too:
     invites on this PC only, as Vault 1.8 did. */
  function setUpSheet(ui, update = false) {
    const box = tokenBox();
    const problem = V.h('p.error-text');
    const log = V.h('div.setup-log');
    let busy = false;
    V.sheet({
      title: update ? 'Update the helper' : 'Set up invites',
      content: [
        V.h('p', { text: 'Vault puts a small helper in your own free cloud, so you can invite friends and see stats from your '
          + 'phone, Chromebook or this PC. Your cloud\'s secret key stays in the cloud and on this PC: never on a phone.' }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Open the tokens page (sign in to Supabase if it asks).' }),
          V.h('li', { text: 'Choose "Create legacy token", call it Vault, create it, then Copy.' }),
          V.h('li', { text: `Paste it here and press ${update ? 'Update' : 'Set up'}. Vault uses it once and never keeps it: you can delete it afterwards.` })),
        V.h('div.setting-buttons', {}, tokensButton()),
        box, log, problem,
        update ? null : V.h('p.hint', { text: 'Got your cloud\'s secret key (sb_secret_...) instead? Paste it to turn invites on for this PC only.' })],
      actions: [{ label: 'Cancel' }, { label: update ? 'Update' : 'Set up', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        const text = box.value.trim();
        if (!text) { problem.textContent = 'Paste the access token first.'; return true; }
        busy = true;
        progress = log;
        V.clear(log, V.h('div.log-line', {}, V.h('div.spinner'), V.h('span', { text: 'Starting...' })));
        try {
          const done = await V.pc.call('helperSetUp', { token: text });
          box.value = '';
          V.toast(done.helper ? 'Invites are on for all your devices.' : 'Invites are on for this PC.');
          reset();
          ui.draw();
          return false;
        } catch (error) {
          V.clear(log);
          problem.textContent = error.message || String(error);
          return true;
        } finally {
          busy = false;
          progress = null;
        }
      } }],
    });
  }

  /* 1.8's way, for a PC part that doesn't know the helper yet: the secret key, pasted once. */
  function turnOnSheet(ui) {
    const box = V.h('input.field', { type: 'password', placeholder: 'sb_secret_...', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Secret key' });
    const problem = V.h('p.error-text');
    const ref = (/^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec((V.config || {}).url || '') || [])[1];
    const page = ref ? `https://supabase.com/dashboard/project/${ref}/settings/api-keys` : 'https://supabase.com/dashboard';
    let busy = false;
    V.sheet({
      title: 'Turn on invites',
      content: [
        V.h('p', { text: 'To make accounts for friends, Vault needs your cloud\'s secret key once. It stays on this PC, in '
          + 'Jarvis\'s settings file, and is never shown again.' }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Open your vault project\'s API keys page in Supabase.' }),
          V.h('li', { text: 'Under Secret keys, copy the key (it starts with sb_secret_). On an older project it\'s the service_role key.' }),
          V.h('li', { text: 'Paste it here.' })),
        V.h('div.setting-buttons', {}, V.button('Open Supabase', { icon: 'open',
          onClick: () => V.pc.call('openLink', { url: page }).catch(V.problem) })),
        box,
        V.h('p.hint', { text: 'An access token (sbp_...) works too: Vault fetches the key with it once and doesn\'t keep the '
          + 'token. Never give the secret key to anyone: it opens everything in your cloud.' }),
        problem],
      actions: [{ label: 'Cancel' }, { label: 'Turn on', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        if (!box.value.trim()) { problem.textContent = 'Paste the secret key first.'; return true; }
        busy = true;
        try {
          await V.pc.call('invitesTurnOn', { key: box.value.trim() });
          box.value = '';
          V.toast('Invites are on.');
          reset();
          ui.draw();
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

  /* Off everywhere: the helper out of the cloud (that takes an access token again) and the key off this PC. */
  function turnOffSheet(ui) {
    const box = tokenBox();
    const problem = V.h('p.error-text');
    let busy = false;
    V.sheet({
      title: 'Turn off invites',
      content: [
        V.h('p', { text: 'Vault takes its helper out of your cloud and this PC forgets the secret key. Everyone you invited '
          + 'keeps their Vault; you just can\'t invite or remove anyone, see stats or collect feedback until you set it up again.' }),
        V.h('p.hint', { text: 'Supabase wants an access token for this, like setting it up: make one on the tokens page and paste it '
          + 'here. Vault uses it once and never keeps it.' }),
        V.h('div.setting-buttons', {}, tokensButton()),
        box, problem],
      actions: [{ label: 'Cancel' }, { label: 'Turn off', kind: 'danger', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        if (!box.value.trim()) { problem.textContent = 'Paste the access token first.'; return true; }
        busy = true;
        try {
          await V.pc.call('helperRemove', { token: box.value.trim() });
          box.value = '';
          V.toast('Invites are off on all your devices.');
          reset();
          ui.draw();
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

  async function turnOff(ui) {
    if (state && state.how === 'pc' && state.helper) { turnOffSheet(ui); return; }
    const sure = await V.confirm('Turn off invites?', 'This PC forgets your cloud\'s secret key. Everyone you invited keeps '
      + 'their Vault; you just can\'t invite or remove anyone, or collect feedback, until you turn it on again.', { ok: 'Turn off' });
    if (!sure) return;
    try { await V.pc.call('invitesTurnOff'); } catch (error) { V.problem(error); }
    reset();
    ui.draw();
  }

  /* -- inviting */

  function inviteSheet(ui) {
    const name = V.h('input.field', { type: 'text', placeholder: 'Sam', autocomplete: 'off', maxlength: '60' });
    const email = V.h('input.field', { type: 'email', placeholder: 'sam@example.com', autocomplete: 'off' });
    const problem = V.h('p.error-text');
    let busy = false;
    V.sheet({
      title: 'Invite someone',
      content: [V.h('label.label', {}, 'Their name', name), V.h('label.label', {}, 'Their e-mail', email),
        V.h('p.hint', { text: 'Nothing is e-mailed to them: you send them the invite yourself.' }), problem],
      actions: [{ label: 'Cancel' }, { label: 'Make invite', kind: 'primary', onClick: async () => {
        if (busy) return true;
        problem.textContent = '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { problem.textContent = 'Type their e-mail address.'; return true; }
        busy = true;
        try {
          show(await call('invite', { name: name.value.trim(), email: email.value.trim() }));
          refresh(ui);
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

  /* The invite link: the PC's Python makes it; the helper only makes the account, so the page makes it from this
     cloud's address and public key, as Python would. */
  function linkFor(made) {
    if (made.link) return made.link;
    const c = V.config || {};
    return `${c.phoneUrl || ''}#invite=${b64url(JSON.stringify({ u: c.url, k: c.key, e: made.email,
      c: V.inviteCode(made.code), n: made.name }))}`;
  }

  /* A join QR code's link (vault/invites.py's join_link makes the same): this cloud's address and public key, the
     helper's join code, and the owner's first name for "Join Reese's Vault". */
  function joinLinkFor(token, name = '') {
    const c = V.config || {};
    return `${c.phoneUrl || PHONE_URL}#join=${b64url(JSON.stringify({ u: c.url, k: c.key, t: token, n: name }))}`;
  }

  /* The invite to hand over: the link (and its QR code), and the code itself. */
  function show(made) {
    const first = String(made.name || '').split(' ')[0] || 'them';
    const link = linkFor(made);
    V.sheet({
      title: made.renewed ? `New code for ${made.name}` : `Invite for ${made.name}`,
      wide: true,
      content: [
        V.h('p.invite-what', { text: `Send ${first} this link in a message or an e-mail (or let them scan the code). It opens `
          + 'Vault and signs them in once with the code below; then they choose their own password and the code stops working.' }),
        V.h('div.connect', {}, V.qr(link), V.h('div.invite-code-box', {},
          V.h('span.label', { text: 'One-time code' }),
          V.h('div.invite-code', { text: made.code }),
          V.h('p.hint', { text: `For ${made.email}. On a PC, they paste the link into Vault's first screen: "Join with an invite".` }))),
        V.h('div.setting-buttons', {},
          !V.desktop && navigator.share ? V.button('Share', { kind: 'primary', icon: 'share', onClick: () => {
            navigator.share({ title: 'Your Vault invite', text: `${first}, here's your invite to Vault:`, url: link }).catch(() => {});
          } }) : null,
          V.button('Copy link', { icon: 'copy', onClick: async () => { await V.copy(link); V.toast('Link copied.'); } }),
          V.button('Copy code', { icon: 'copy', onClick: async () => { await V.copy(made.code); V.toast('Code copied.'); } }))],
      actions: [{ label: 'Done', kind: 'primary' }],
    });
  }

  /* -- join QR codes (the helper's version 2) */

  const leftWords = (ms) => (ms >= 60000 ? `Works for ${plural(Math.floor(ms / 60000), 'more minute')}`
    : 'Works for less than a minute more');

  /* "Scan to join": a new join code's QR code, how long it still works and who has joined with it so far (asked
     every waits.poll while it shows). The time left is counted on this device from the minutes the helper gave, so a
     phone whose clock is off still counts right; who joined since the code was made goes by the cloud's own clock.
     Closing it leaves the code working until it runs out. */
  function joinSheet(ui) {
    const first = String((V.data.user || {}).name || '').trim().split(/\s+/)[0] || '';
    const qrBox = V.h('div.join-qr-box');
    const left = V.h('p.join-left', { role: 'status' });
    const joined = V.h('p.join-joined');
    const buttons = V.h('div.setting-buttons.join-buttons');
    const problem = V.h('p.error-text', { role: 'alert' });
    let code = null;  // { token, link, ends (this device's clock), since (the cloud's), stopped, over }
    let names = [];
    let closed = false;
    let busy = false;
    let polling = false;
    let ticker = null;
    let poller = null;

    const blank = (icon, text) => V.h('div.join-blank', {}, icon ? V.icon(icon) : V.h('div.spinner'), V.h('span', { text }));
    const showJoined = () => {
      joined.textContent = names.length ? `Joined so far: ${names.join(', ')}` : 'Nobody has joined with it yet.';
    };

    /* The code's QR and its buttons, drawn again only when the code changes (a new one, run out or stopped). */
    function drawCode() {
      if (code.over) {
        V.clear(qrBox, blank(code.stopped ? 'x' : 'clock', code.stopped ? 'Stopped' : 'Run out'));
        V.clear(buttons, V.button('New code', { kind: 'primary', icon: 'restore', onClick: make }));
        return;
      }
      const link = code.link;
      V.clear(qrBox, V.qr(link, 300, 'QR code to join your Vault'));
      V.clear(buttons,
        !V.desktop && navigator.share ? V.button('Share', { icon: 'share', onClick: () => {
          navigator.share({ title: 'Join my Vault', text: 'Make your own Vault with this link (it only works for a little while):',
            url: link }).catch(() => {});
        } }) : null,
        V.button('Copy link', { icon: 'copy', onClick: async () => { await V.copy(link); V.toast('Link copied.'); } }),
        V.button('Stop this code', { kind: 'danger-quiet', onClick: stop }));
    }

    /* How long it still works (every waits.tick, and right when it runs out). */
    function tick() {
      clearTimeout(ticker);
      if (closed || !code) return;
      const ms = code.ends - Date.now();
      const over = code.stopped || ms <= 0;
      if (over !== code.over) {
        code.over = over;
        drawCode();
      }
      left.textContent = code.stopped ? 'This code was stopped.' : over ? 'This code has run out.' : leftWords(ms);
      if (!over) ticker = setTimeout(tick, Math.max(20, Math.min(waits.tick, ms + 20)));
    }

    async function make() {
      if (busy || closed) return;
      busy = true;
      problem.textContent = '';
      left.textContent = '';
      V.clear(qrBox, blank('', 'Making a code...'));
      V.clear(buttons);
      try {
        const made = await call('join-open');
        if (closed) return;
        const minutes = Number(made.minutes) || 30;
        const ends = Date.parse(made.expires || '');
        const since = Number.isFinite(ends) ? ends - minutes * 60000 : Date.now();
        code = { token: made.token, link: joinLinkFor(made.token, first), ends: Date.now() + minutes * 60000,
          since: since - JOINED_SLACK, stopped: false, over: false };
        names = [];
        showJoined();
        drawCode();
        tick();
      } catch (error) {
        if (closed) return;
        code = null;
        problem.textContent = offline(error) ? 'You\'re offline. Try again once you\'re back online.' : (error.message || String(error));
        V.clear(qrBox, blank('alert', 'No code yet'));
        V.clear(buttons, V.button('Try again', { icon: 'restore', onClick: make }));
      } finally {
        busy = false;
      }
    }

    async function stop() {
      if (busy || !code || code.over) return;
      const sure = await V.confirm('Stop this code?', 'Nobody can join with it any more (nor with a code you showed before '
        + 'it). Everyone who already joined keeps their Vault.', { ok: 'Stop it', danger: true });
      if (!sure || busy || !code) return;
      busy = true;
      try {
        await call('join-stop');
        code.stopped = true;
        V.toast('That code doesn\'t work any more.');
        tick();
      } catch (error) {
        V.problem(error);
      } finally {
        busy = false;
      }
    }

    /* Who has joined with this code (people the helper made with a join code since it was made). Offline, or with
       the helper busy, the last list stays. */
    async function poll() {
      if (closed || polling || !code) return;
      polling = true;
      try {
        const answer = await call('people');
        if (closed || !code) return;
        names = ((answer && answer.people) || []).filter((person) => person.via === 'qr'
          && Date.parse(person.invitedAt || '') >= code.since).map((person) => person.name || person.email);
        showJoined();
      } catch (error) {
        /* as it was */
      } finally {
        polling = false;
      }
    }

    V.sheet({
      title: 'Scan to join',
      wide: true,
      content: [
        V.h('div.connect.join-connect', {}, qrBox, V.h('div.join-about', {},
          V.h('p.join-how', { text: 'Point your phone\'s camera at this code.' }), left, joined)),
        buttons, problem,
        V.h('p.hint.join-hint', { text: 'Closing this keeps the code working until it runs out. Only show it to people you '
          + 'want in your Vault cloud.' })],
      actions: [{ label: 'Done', kind: 'primary' }],
      onClose: () => {
        closed = true;
        clearTimeout(ticker);
        clearInterval(poller);
        refresh(ui);  // (whoever joined shows in the card)
      },
    });
    poller = setInterval(poll, waits.poll);
    make();
  }

  /* The card's "Join with a QR code" row: it takes the helper, at version 2 or newer. */
  function joinRow(ui) {
    const title = 'Join with a QR code';
    const about = 'Anyone who scans it in the next 30 minutes gets their own Vault here: they type their name, e-mail and a password.';
    const showButton = (disabled) => V.button('Show QR code', { kind: 'primary', icon: 'qr', disabled,
      onClick: () => joinSheet(ui) });
    if (state.how === 'helper') {
      return state.version >= JOIN_SINCE ? ui.line(title, about, showButton(false))
        : ui.line(title, 'Update the helper in Vault on your PC first (Settings > Invite people > Update). No Update there? '
          + 'Open Jarvis and click Update first.', null);
    }
    if (state.how !== 'pc') return null;  // (1.8's PC part: a Jarvis update brings the helper first)
    if (!(Number(state.current) >= JOIN_SINCE)) {
      // This page is newer than the PC's own Vault part, which can't make join codes or put in a helper that can.
      return ui.line(title, V.pc && V.pc.standalone && V.pc.standalone()
        ? 'Install the newest Vault on this PC (its setup-vault.bat) first: this Vault can\'t make join codes yet.'
        : 'Update Jarvis first (open Jarvis and click Update): this Vault can\'t make join codes yet.', showButton(true));
    }
    if (!state.helper) {
      return ui.line(title, 'Join codes need Vault\'s helper in your cloud: press Set up below (once, with a Supabase access '
        + 'token).', null);
    }
    if (Number(state.helper.version) < JOIN_SINCE) {
      return ui.line(title, 'Update the helper below first: join codes need its newest version.', showButton(true));
    }
    return ui.line(title, about, showButton(false));
  }

  async function remove(ui, person) {
    const who = person.name || person.email;
    const sure = await V.confirm(`Remove ${who}?`, `${who}'s account is deleted with everything in it: their notes, files and `
      + 'clipboard. They can\'t sign in any more, and this can\'t be undone.', { ok: 'Remove', danger: true });
    if (!sure) return;
    try {
      await call('remove', { id: person.id });
      V.toast(`${who} was removed. Their notes are deleted.`);
      stats = null;
    } catch (error) {
      V.problem(error);
    }
    refresh(ui);
  }

  function personLine(ui, person) {
    const waiting = person.state === 'waiting';
    const since = person.signedIn ? ` · last signed in ${V.ago(person.signedIn)}` : '';
    const said = person.via === 'qr' ? `Joined with the QR code${since}`  // (their own password from the start)
      : waiting ? (person.signedIn ? 'Signed in, hasn\'t chosen a password yet' : `Waiting · invited ${V.ago(person.invitedAt)}`)
        : `Joined${since}`;
    const row = ui.line(person.name || person.email, `${person.email} · ${said}`, V.h('div.setting-buttons', {},
      waiting ? V.button('New code', { onClick: async () => {
        try { show(await call('invite', { name: person.name, email: person.email })); } catch (error) { V.problem(error); }
      } }) : null,
      V.button('Remove', { kind: 'danger-quiet', onClick: () => remove(ui, person) })));
    row.classList.add('invite-person');
    row.dataset.state = person.state;
    return row;
  }

  const tryAgain = (ui) => V.button('Try again', { icon: 'restore', onClick: () => { reset(); ui.draw(); } });
  // An older PC part (1.8's invites, no helper): what brings the rest.
  const updateLine = (ui) => ui.line('Invite from your phone too', V.pc && V.pc.standalone && V.pc.standalone()
    ? 'Install the newest Vault on this PC (its setup-vault.bat) to invite people from your phone or Chromebook and see stats.'
    : 'Open Jarvis and click Update to invite people from your phone or Chromebook and see stats.', null);

  function offCard(ui) {
    if (state.how === 'pc') {
      return ui.card('Invite people', ui.line('Give friends their own Vault', 'Each friend gets a private Vault in your free '
        + 'cloud: nobody sees anyone else\'s notes. Set it up once here, then invite people from your phone, Chromebook or this PC.',
      V.button('Set up', { kind: 'primary', onClick: () => setUpSheet(ui) })));
    }
    if (state.how === 'old') {
      return ui.card('Invite people', ui.line('Give friends their own Vault', 'Each friend gets a private Vault in your free '
        + 'cloud: nobody sees anyone else\'s notes in the app. Turn this on once with your cloud\'s secret key.',
      V.button('Turn on', { onClick: () => turnOnSheet(ui) })), updateLine(ui));
    }
    // (The phone can't tell how new the PC part is: one from before the helper only offers 1.8's Turn on.)
    return ui.card('Invite people', ui.line('Give friends their own Vault', 'Set up invites once in Vault on your PC '
      + '(Settings > Invite people > Set up). Don\'t see Set up there? Update it first: open Jarvis and click Update. After '
      + 'that you can invite people from here too, and see stats.', null));
  }

  /* Settings' "Invite people" card. `ui` is Settings' own { card, line, toggle, draw }. */
  function card(ui) {
    if (!owner()) return null;  // a friend's Vault: invites are the owner's
    if (V.desktop && !newPc() && !oldPc()) return null;  // an older PC part: a Jarvis update brings it
    if (!state) {
      refresh(ui);
      return ui.card('Invite people', ui.line('Checking...', '', null));
    }
    if (state.failed) {
      return ui.card('Invite people', ui.line('Couldn\'t check your invites', offline(trouble) ? 'You\'re offline.' : trouble,
        tryAgain(ui)));
    }
    if (!state.on) return offCard(ui);
    const rows = [ui.line('Invite someone', 'They get a link that signs them in once; then they choose their own password.',
      V.button('Invite', { kind: 'primary', icon: 'plus', onClick: () => inviteSheet(ui) })), joinRow(ui)];
    if (trouble) {
      rows.push(ui.line('Couldn\'t load the people you invited', offline(trouble) ? 'You\'re offline.' : trouble, tryAgain(ui)));
    }
    for (const person of people || []) rows.push(personLine(ui, person));
    if (people && !people.length) rows.push(ui.line('Nobody yet', 'The people you invite show here.', null));
    if (state.how === 'pc' && !state.helper) {
      rows.push(ui.line('Invite from your phone too', 'Set up Vault\'s helper once (with a Supabase access token), and your '
        + 'phone and Chromebook can invite people and see stats too.', V.button('Set up', { onClick: () => setUpSheet(ui) })));
    } else if (state.how === 'pc' && Number(state.helper.version) < state.current) {
      rows.push(ui.line('Update the helper', 'This Vault has a newer helper for your cloud. Paste an access token to put it in.',
        V.button('Update', { onClick: () => setUpSheet(ui, true) })));
    }
    if (state.how === 'old') rows.push(updateLine(ui));
    if (state.how === 'helper') rows.push(V.h('p.hint', { text: 'To turn invites off, use Vault on your PC.' }));
    else rows.push(V.h('div.setting-buttons', {}, V.button('Turn off invites', { kind: 'danger-quiet', onClick: () => turnOff(ui) })));
    return ui.card('Invite people', ...rows);
  }

  /* -- the owner's Stats */

  function loadStats(ui) {
    if (statsAsking) return;
    statsAsking = call('stats').then((answer) => { stats = answer; statsTrouble = ''; },
      (error) => { statsTrouble = error.message || String(error); })
      .finally(() => { statsAsking = null; ui.draw(); });
  }

  const listed = (table, names = {}) => Object.entries(table || {}).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, n]) => `${names[key] || key} ${n}`).join(' · ');

  function personStats(person) {
    const bits = [person.state === 'waiting' ? 'waiting for their invite'
      : person.active ? `last active ${V.ago(person.active)}` : 'not active yet',
    plural(person.notes || 0, 'note'),
    person.bytes !== null && person.bytes !== undefined ? V.size(person.bytes) : '',
    person.devices ? plural(person.devices, 'device') : ''];
    return V.h('li', { dataset: { state: person.state } },
      V.h('strong', { text: person.state === 'owner' ? 'You' : person.name || person.email }),
      V.h('span', { text: bits.filter(Boolean).join(' · ') }));
  }

  /* Settings' "Stats" card (the owner, wherever invites work: not on a PC part from before 1.10). */
  function statsCard(ui) {
    if (!owner() || !state || !state.on || state.how === 'old') return null;
    if (!stats && !statsAsking && !statsTrouble) loadStats(ui);
    const again = V.button(statsAsking ? 'Counting...' : 'Refresh', { icon: 'restore', disabled: !!statsAsking,
      onClick: () => { statsTrouble = ''; loadStats(ui); ui.draw(); } });
    if (!stats) {
      return ui.card('Stats', ui.line(statsTrouble ? 'Couldn\'t count just now' : 'Counting...',
        statsTrouble ? (offline(statsTrouble) ? 'You\'re offline.' : statsTrouble) : '', statsTrouble ? again : null));
    }
    const s = stats;
    const people = s.people || {};
    const active = s.active || {};
    return ui.card('Stats',
      ui.line('People', `${people.joined || 0} joined · ${people.waiting || 0} waiting for their invite`, null),
      ui.line('Active', `${active.day || 0} in the last day · ${active.week || 0} this week · ${active.month || 0} this month `
        + '(you and the people you invited)', null),
      ui.line('Devices in use', listed(s.devices, KIND_NAMES) || 'None yet: each Vault checks in once a day.', null),
      ui.line('Vault versions', listed(s.versions, { other: 'Other' }) || 'None yet.', null),
      ui.line('Notes and files', plural(s.notes || 0, 'note') + (s.storage
        ? ` · ${plural(s.storage.files || 0, 'file')} · ${V.size(s.storage.bytes || 0)}`
        : ' (files aren\'t counted in this cloud yet: set the helper up again on your PC to add the counter)'), null),
      s.feedback !== null && s.feedback !== undefined ? ui.line('Feedback waiting', s.feedback
        ? `${plural(s.feedback, 'piece')}: your PC collects it into your Feedback folder.` : 'None.', null) : null,
      ui.line('Downloads', 'Not counted: the app\'s page and the PC download keep no counts, and Vault has no trackers. '
        + 'The people who joined are the count that\'s real.', null),
      (s.list || []).length ? V.h('ul.stats-people', {}, s.list.map(personStats)) : null,
      V.h('p.hint.stats-privacy', { text: 'Only counts, sizes and times: never what\'s in anyone\'s notes or files.' }),
      V.h('div.setting-buttons.stats-foot', {}, V.h('span.hint', { text: `Counted ${V.ago(s.at)}` }), again));
  }

  return { card, statsCard, state: () => state, refresh, call, linkFor, joinLinkFor, waits };
})();

/* Each device's line in its person's settings row: { kind, label, version, seen }, under an id of its own (each
   browser, each home screen icon and the PC app keep theirs in localStorage 'vault-install'). Written a few seconds
   after Vault starts (and again later on, in case the first try met a slow start), when it comes back to the front
   and every few hours, at most once a day (or when Vault was updated), and only while it's in front: a PC starting
   Vault hidden in the tray isn't anyone using it (V.away). Most opens of a phone's home screen icon are short fresh
   starts, hence the first try so soon. The newest row is read first and only extra is written (as js/ai.js does), with
   records older than half a year let go.

   An iPhone or iPad keeps Safari's storage and its home screen icon's apart, so one used both ways has two ids (and
   two records): the owner's Stats count each person's devices once per kind (vault/stats.py, the helper's twin). */
V.deviceLog = (() => {
  const KEY = 'vault-install';
  const FIRST = [5 * 1000, 90 * 1000];
  const EVERY = 6 * 60 * 60 * 1000;
  const KEEP_DAYS = 180;
  const MOST = 12;
  const KINDS = ['pc', 'android', 'iphone', 'ipad', 'chromebook', 'browser'];
  const LABELS = { pc: 'PC', android: 'Android phone', iphone: 'iPhone', ipad: 'iPad', chromebook: 'Chromebook', browser: 'Browser' };
  let busy = false;
  let started = false;

  function installId() {
    try {
      let id = localStorage.getItem(KEY) || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        id = V.uuid();
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (error) {
      return '';  // a private window: nothing to tell one visit from the next
    }
  }

  // (`device`: the slot this device took, 'phone' or 'web': an iPad told it's a browser is still an iPad for Stats,
  // but must never give the phone slot its name: V.phoneModel)
  const record = () => ({ kind: V.deviceKind.kind, label: LABELS[V.deviceKind.kind] || 'Browser', device: V.device,
    version: V.VERSION, seen: new Date().toISOString() });
  const isRecord = (value) => !!value && typeof value === 'object' && KINDS.includes(value.kind);

  /* The devices with this one's line in, others older than KEEP_DAYS let go, MOST at most (anything else kept as is). */
  function tidy(devices, id) {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const keep = new Set(Object.entries(devices).filter(([key, value]) => isRecord(value)
      && (key === id || Date.parse(value.seen || '') >= cutoff))
      .sort(([a, x], [b, y]) => (a === id ? -1 : b === id ? 1 : String(y.seen).localeCompare(String(x.seen))))
      .slice(0, MOST).map(([key]) => key));
    return Object.fromEntries(Object.entries(devices).filter(([key, value]) => !isRecord(value) || keep.has(key)));
  }

  async function note() {
    if (busy || !V.cloud.sb || !(V.data.user && V.data.user.id) || !navigator.onLine) return false;
    const id = installId();
    if (!id) return false;
    const mine = record();
    const settings = V.data.settings || {};
    const known = ((settings.extra || {}).devices || {})[id];
    if (known && known.kind === mine.kind && known.device === mine.device && known.version === mine.version
      && String(known.seen || '').slice(0, 10) === mine.seen.slice(0, 10)) return false;  // said so today already
    if (settings._dirty) return false;  // this device's own settings are on their way: next time
    busy = true;
    try {
      // (merged into the cloud's newest extra, one change at a time, never over a newer one: V.cloud.changeExtra)
      await V.cloud.changeExtra((extra) => ({ ...extra, devices: tidy({ ...(extra.devices || {}), [id]: mine }, id) }));
      return true;
    } catch (error) {
      return false;  // tried again next time
    } finally {
      busy = false;
    }
  }

  const inFront = () => (V.away() ? Promise.resolve(false) : note());

  function start() {
    if (started) return;
    started = true;
    for (const wait of FIRST) setTimeout(inFront, wait);  // (a page started out of sight: 'back' brings it)
    setInterval(inFront, EVERY);
    V.on('back', inFront);
  }

  return { start, note, installId, record, tidy };
})();

V.feedback = (() => {
  const KINDS = [['bug', 'Bug'], ['idea', 'Idea'], ['other', 'Other']];
  const MOST = 4000;
  const OFFLINE = 'Couldn\'t send — try again when online.';
  let draft = { kind: 'bug', text: '', device: true };  // kept while the sheet is closed and opened again
  let checking = false;

  const offline = (error) => !navigator.onLine || /fetch|network|internet|offline|load failed/i.test(String((error && error.message) || error));

  /* One piece of feedback into this person's own storage. Never anything of their notes: only what they wrote, and
     (if they let it) Vault's version, which kind of device, and the browser's own name. */
  async function send({ kind, text, device }) {
    const user = V.data.user || {};
    if (!user.id) throw new Error('Sign in first.');
    const words = String(text || '').trim().slice(0, MOST);
    if (!words) throw new Error('Write something first.');
    if (!navigator.onLine) throw new Error(OFFLINE);
    const id = V.uuid();
    const at = new Date().toISOString();
    const item = { format: 1, id, kind: KINDS.some(([k]) => k === kind) ? kind : 'other', text: words, at };
    if (device) item.device = { version: V.VERSION, kind: V.deviceLabel(V.device), agent: String(navigator.userAgent || '').slice(0, 300) };
    const path = `${user.id}/feedback/${at.replace(/[:.]/g, '-')}-${id.slice(0, 8)}.json`;
    await V.cloud.upload(path, new Blob([JSON.stringify(item)], { type: 'application/json' }), { mime: 'application/json' });
    return path;
  }

  function sheet() {
    const kinds = V.h('div.segmented.feedback-kinds', { role: 'radiogroup', 'aria-label': 'What kind' },
      KINDS.map(([value, label]) => V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(draft.kind === value),
        dataset: { kind: value }, onclick: () => {
          draft.kind = value;
          for (const button of kinds.children) button.setAttribute('aria-checked', String(button.dataset.kind === value));
        } }, V.h('span', { text: label }))));
    const count = V.h('span.feedback-count');
    const box = V.h('textarea.field.feedback-text', { rows: '6', maxlength: String(MOST), 'aria-label': 'Your feedback',
      placeholder: 'What went wrong, or what would make Vault better?', oninput: () => { draft.text = box.value; counted(); } });
    box.value = draft.text;
    const counted = () => { count.textContent = box.value.length > MOST - 500 ? `${box.value.length} / ${MOST}` : ''; };
    counted();
    const device = V.h('input.switch', { type: 'checkbox', checked: draft.device, 'aria-label': 'Include device info',
      onchange: (event) => { draft.device = event.target.checked; } });
    const owner = !(V.data.user || {}).invited;
    let busy = false;
    V.sheet({
      title: 'Send feedback',
      content: [kinds, box, count,
        V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Include device info' }),
          V.h('span', { text: 'Vault\'s version, which kind of device, and the browser\'s name. Never your notes.' })), device),
        V.h('p.hint', { text: owner ? 'It lands in your Feedback folder.' : 'It goes to the person who runs your Vault cloud.' })],
      actions: [{ label: 'Cancel' }, { label: 'Send', kind: 'primary', onClick: async () => {
        if (busy) return true;
        if (!box.value.trim()) { V.toast('Write something first.', { kind: 'err' }); return true; }
        busy = true;
        try {
          await send({ kind: draft.kind, text: box.value, device: draft.device });
          draft = { ...draft, text: '' };
          V.toast('Thanks! Your feedback was sent.');
          return false;
        } catch (error) {
          V.toast(offline(error) ? OFFLINE : `Couldn't send: ${error.message || error}`, { kind: 'err', ms: 5000 });
          return true;
        } finally {
          busy = false;
        }
      } }],
    });
  }

  async function checkNow(ui) {
    checking = true;
    ui.draw();
    try {
      const done = await V.pc.call('feedbackCollect');
      V.toast(done.added ? `${done.added} new in your Feedback folder.` : 'No new feedback.');
      if (done.added) V.cloud.sync();
    } catch (error) {
      V.problem(error);
    } finally {
      checking = false;
      ui.draw();
    }
  }

  /* Settings' "Send feedback" card; on the owner's PC also where everyone's feedback is collected. */
  function card(ui) {
    const rows = [ui.line('Found a bug, or have an idea?', 'Say it here: it only takes a moment.',
      V.button('Write', { icon: 'send', onClick: sheet }))];
    if (V.desktop && !(V.data.user || {}).invited && V.pc && V.pc.can('feedbackCollect')) {
      const invites = V.invites.state();
      if (invites && invites.on && invites.local) {  // (collected with the secret key on this PC)
        rows.push(ui.line('Feedback from everyone', 'Your PC collects it into your Feedback folder by itself, every half hour.',
          V.button(checking ? 'Checking...' : 'Check feedback now', { icon: 'restore', disabled: checking, onClick: () => checkNow(ui) })));
      } else if (invites && invites.how) {
        rows.push(ui.line('Feedback from everyone', 'Feedback from the people you invite arrives in a Feedback folder once '
          + 'invites are turned on (Invite people, above).', null));
      }
    }
    return ui.card('Send feedback', ...rows);
  }

  if (V.desktop) V.on('pc:feedback-in', () => V.cloud.sync());  // the PC just wrote new feedback notes

  return { card, send, sheet };
})();
