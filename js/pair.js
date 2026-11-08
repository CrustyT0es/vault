/* Wefty 1.21: a code from another device, both sides. Signing in on a new phone or Chromebook (or a PC) without typing
   a password there: it shows a code, and a device where the person is already signed in types it.

   The new device (signInScreen, from js/doors.js's first screen and the sign-in screens: "Use a code from another
   device"): asks Wefty's helper in the cloud for a pair (pair-open, with no sign-in, saying only what kind of device
   this is), shows its code big (K7QX-9MRT), how long it works, and waits, asking the helper every few seconds while
   the page is in sight (pair-wait; at once when it comes back in sight, never while it's hidden). Once the other
   device said yes, the helper's answer carries a one-time sign-in (an e-mail link's hash, made for that moment), which
   this page trades for its own session (supabase-js's verifyOtp, as an e-mail's link would). On the PC, Python does
   the asking and keeps the sign-in (the bridge's pairOpen / pairWait / pairCancel). Back lets the pair go.

   The signed-in device (approve, from Settings > Devices > Sign in another device and the picture's menu): a sheet to
   type the code in (any case, dashes and spaces left out), then what's asking ("Sign in Chromebook? Asked 2 minutes
   ago.") with the warning that matters (only a code shown on a device right next to you: never one someone sent or
   read out, which is how someone else's device would get in), then Sign it in (pair-look, pair-approve, with this
   person's own sign-in: js/access.js's helperCall; on the PC, the bridge's pairLook / pairApprove).

   A cloud whose helper is older than 1.21's (or that has none) can't do this: said in words, with what the person
   running it can do. Nothing here is kept: the pair's secret id lives in this page's memory until it's used or let go.
   Not a way round anything: a network that blocks the cloud is said to block it, with the other ways to sign in. */
'use strict';

V.pair = (() => {
  const SLUG = 'vault-admin';
  const LETTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const LIVE = 10 * 60 * 1000;  // how long a code works (the helper's own limit), when the helper's time can't be used
  const waits = { call: 20000, health: 8000, poll: 2000, tick: 1000 };  // (tests shorten them)
  const LABELS = { pc: 'PC', android: 'Android phone', iphone: 'iPhone', ipad: 'iPad', chromebook: 'Chromebook', browser: 'Browser' };
  const WORDS = {
    offline: 'You\'re offline. Connect to the internet, then try again.',
    unreachable: 'Wefty couldn\'t reach its cloud from this network. Try mobile data, or sign in another way.',
    missing: 'This Wefty cloud can\'t do that yet.',
    owner: 'If this is your own Wefty cloud, update the helper on your PC (Settings > Friends).',
    ownerHere: 'Update the helper on your PC (Settings > Friends).',
    unknown: 'That code isn\'t right, or it ran out. Check it on the other device, or get a new one there.',
    taken: 'That code was used already. If the other device isn\'t signed in yet, get a new code on it.',
    busy: 'Too many tries just now. Wait a few minutes, then try again.',
    asleep: 'The cloud is asleep right now. It wakes up in a few minutes: try again then.',
    signedOut: 'Sign in again on this device first.',
    pcOld: () => (V.pc && V.pc.howToUpdate ? `Wefty on this PC can't do that yet. ${V.pc.howToUpdate()}` : 'Wefty on this PC can\'t do that yet.'),
    failed: 'That didn\'t work. Get a new code and try again.',
    ranOut: 'That code ran out.',
  };

  /* -- the codes */

  const plain = (text) => String(text || '').toUpperCase().replace(/[\s\-–—_.]+/g, '');
  const looksRight = (code) => code.length === 8 && [...code].every((c) => LETTERS.includes(c));
  const shown = (code) => (String(code || '').length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : String(code || ''));

  // This device, as the asking side says it: { kind, label } (the same kinds as the owner's Stats: js/access.js).
  function here() {
    const kind = (V.deviceKind && V.deviceKind.kind) || 'browser';
    return { kind, label: LABELS[kind] || 'Browser' };
  }
  const named = (device) => {
    const kind = device && LABELS[device.kind] ? device.kind : '';
    const label = String((device && device.label) || '').trim().slice(0, 60);
    return label || LABELS[kind] || 'a device';
  };

  /* -- asking the helper */

  const fault = (code, message = '', status = 0) => Object.assign(new Error(message || WORDS[code] || code), { code, status });

  /* Whether the cloud answers at all (its sign-in service's health check): it tells a missing helper (a function that
     isn't there answers 404 with no CORS, so the browser only sees a request that failed) from the internet being
     out or blocked. */
  async function reaches(cloud) {
    if (!cloud || !cloud.url || !navigator.onLine) return false;
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), waits.health);
    try {
      await fetch(`${cloud.url}/auth/v1/health`, { headers: { apikey: cloud.key }, signal: control.signal });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // The helper's answer as an error with its code ('unknown', 'taken'...) and status.
  function refusal(status, answer) {
    const code = answer && typeof answer.error === 'string' ? answer.error : '';
    const words = answer && typeof answer.message === 'string' && answer.message ? answer.message : '';
    return fault(code, words ? (V.weftyWords ? V.weftyWords(words) : words) : `The cloud said ${status}.`, status);
  }

  /* The new device's own asking: no sign-in (the helper routes pair-open, pair-wait and pair-cancel before it checks
     one), only the cloud's public key. */
  async function openCall(cloud, action, args = {}) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), waits.call);
    let response;
    try {
      response = await fetch(`${cloud.url}/functions/v1/${SLUG}`, { method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json', apikey: cloud.key }, body: JSON.stringify({ ...args, action }) });
    } catch (error) {
      if (!navigator.onLine) throw fault('offline');
      throw fault(await reaches(cloud) ? 'missing' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    const answer = await response.json().catch(() => ({}));
    if (response.ok) return answer;
    throw refusal(response.status, answer);
  }

  /* What went wrong, as one of WORDS' names ('' for an error with words of its own). `open`: the new device's side,
     where a helper from before 1.21 asks for a sign-in (401) as it doesn't know these actions. */
  function kindOf(error, open) {
    const code = String((error && (error.code || error.kind)) || '');
    const status = (error && error.status) || 0;
    if (['offline', 'unreachable', 'missing', 'pcOld'].includes(code)) return code;
    if (code === 'old' || code === 'not_set_up' || code === 'not_owner') return 'missing';
    if (code === 'unknown') return status === 400 ? 'missing' : 'unknown';  // (400: an older helper's "unknown action")
    if (code === 'taken' || status === 409) return 'taken';
    if (status === 429 || code === 'busy' || code === 'too_many') return 'busy';
    if (status === 540 || code === 'asleep') return 'asleep';
    if (status === 401 || code === 'signed_out' || code === 'signed-out') return open ? 'missing' : 'signedOut';
    if (status === 404) return 'missing';
    if (code === 'gone' || code === 'expired') return 'unknown';
    if (!navigator.onLine) return 'offline';
    return '';
  }

  /* -- the new device: its code, waiting for the other device */

  /* `cloud`: { url, key } (a saved vault-config, or wefty.org's own cloud). Resolves 'in' once signed in (the caller
     reloads), or 'back'. */
  function signInScreen({ cloud = null } = {}) {
    return new Promise((resolve) => {
      const target = cloud || V.config || {};
      const viaPc = !!V.desktop;
      const device = here();
      const codeBox = V.h('div.pair-code', { role: 'group', 'aria-label': 'Your code' });
      const left = V.h('p.pair-left', { role: 'status' });
      const state = V.h('p.pair-state', { 'aria-live': 'polite' });
      const problem = V.h('div.pair-problem', { role: 'alert' });
      const buttons = V.h('div.pair-buttons');
      let pair = null;     // { id, code, ends (this device's clock), wait }
      let done = false;
      let asking = false;  // a pair-wait under way
      let pollTimer = null;
      let tickTimer = null;

      const finish = (how) => {
        if (done) return;
        done = true;
        clearTimeout(pollTimer);
        clearTimeout(tickTimer);
        document.removeEventListener('visibilitychange', seen);
        resolve(how);
      };
      const call = (action, args) => (viaPc ? V.pc.call(action, args) : openCall(target, action.replace(/^pair([A-Z])/,
        (m, c) => `pair-${c.toLowerCase()}`), args));

      function say(error) {
        const kind = kindOf(error, true);
        const words = kind === 'pcOld' ? WORDS.pcOld() : kind ? WORDS[kind] : (error && error.message) || WORDS.failed;
        V.clear(problem, V.h('p.error-text', { text: words }),
          kind === 'missing' ? V.h('p.hint.pair-owner', { text: WORDS.owner }) : null);
      }

      function draw(how) {
        if (done) return;
        if (how === 'asking') {
          V.clear(codeBox, V.h('div.pair-blank', {}, V.h('div.spinner'), V.h('span', { text: 'Getting a code...' })));
          left.textContent = '';
          state.textContent = '';
          V.clear(buttons);
        } else if (how === 'code') {
          V.clear(codeBox, V.h('span.pair-digits', { text: shown(pair.code), 'aria-label': [...pair.code].join(' ') }));
          state.textContent = 'Waiting for the other device...';
          V.clear(buttons, V.button('Copy the code', { icon: 'copy', onClick: async () => {
            try { await V.copy(shown(pair.code)); V.toast('Code copied.'); } catch (error) { V.problem(error); }
          } }));
        } else if (how === 'over' || how === 'trouble') {
          V.clear(codeBox, V.h('div.pair-blank', {}, V.icon(how === 'over' ? 'clock' : 'alert'),
            V.h('span', { text: how === 'over' ? WORDS.ranOut : 'No code yet' })));
          left.textContent = '';
          state.textContent = '';
          V.clear(buttons, V.button(how === 'over' ? 'Get a new one' : 'Try again', { kind: 'primary', icon: 'restore',
            onClick: () => { V.clear(problem); start(); } }));
        } else if (how === 'signing') {
          state.textContent = 'Signing you in...';
          V.clear(buttons);
        }
      }

      function tick() {
        clearTimeout(tickTimer);
        if (done || !pair) return;
        const ms = pair.ends - Date.now();
        if (ms <= 0) { ranOut(); return; }
        left.textContent = ms >= 60000 ? `Works for ${Math.ceil(ms / 60000)} more minute${Math.ceil(ms / 60000) === 1 ? '' : 's'}`
          : 'Works for less than a minute more';
        tickTimer = setTimeout(tick, Math.min(waits.tick, ms + 20));
      }

      function ranOut() {
        clearTimeout(pollTimer);
        const was = pair;
        pair = null;
        if (was) call('pairCancel', { id: was.id }).catch(() => {});
        draw('over');
      }

      async function start() {
        if (done) return;
        clearTimeout(pollTimer);
        clearTimeout(tickTimer);
        pair = null;
        draw('asking');
        if (viaPc && !V.pc.can('pairOpen')) { say(fault('pcOld')); draw('trouble'); return; }
        try {
          const made = await call('pairOpen', { device });
          if (done) { if (made && made.id) call('pairCancel', { id: made.id }).catch(() => {}); return; }
          const code = plain(made && made.code);
          if (!made || !made.id || !code) throw fault('', WORDS.failed);
          // (the time left counted on this device's clock, from what the helper said: a clock that's off still counts right)
          let life = Number(made.expires) - Date.now();
          if (!(life > 0 && life <= LIVE + 5 * 60000)) life = LIVE;
          pair = { id: String(made.id), code, ends: Date.now() + life, wait: Math.max(500, Number(made.wait) || waits.poll) };
          draw('code');
          tick();
          later();
        } catch (error) {
          if (done) return;
          say(error);
          draw('trouble');
        }
      }

      // The next look, while the page is in sight (a hidden page doesn't ask: `seen` asks once it's back).
      function later() {
        clearTimeout(pollTimer);
        if (done || !pair || document.hidden) return;
        pollTimer = setTimeout(look, Math.min(pair.wait, waits.poll));
      }

      async function look() {
        if (done || !pair || asking || document.hidden) return;
        if (Date.now() >= pair.ends) { ranOut(); return; }
        asking = true;
        const now = pair;
        try {
          const got = await call('pairWait', { id: now.id });
          if (done || pair !== now) return;
          const said = got && got.state;
          if (said === 'in') { draw('signing'); finish('in'); return; }  // (the PC: Python has the sign-in)
          if (said === 'approved') { await signIn(got); return; }
          if (said === 'gone') { pair = null; draw('over'); return; }
        } catch (error) {
          if (done || pair !== now) return;
          const kind = kindOf(error, true);
          if (kind === 'missing' || kind === 'unknown') { pair = null; say(error); draw('trouble'); return; }
          // (offline or out of reach for a moment: the code still shows, and the next look tries again)
          state.textContent = kind === 'offline' ? 'Waiting for the internet...' : 'Waiting for the other device...';
        } finally {
          asking = false;
        }
        later();
      }

      /* The other device said yes: the one-time sign-in becomes this page's own session. */
      async function signIn(got) {
        draw('signing');
        clearTimeout(tickTimer);
        try {
          if (!V.cloud.sb) V.cloud.client(target);
          const { error } = await V.cloud.sb.auth.verifyOtp({ token_hash: String(got.token_hash || ''), type: got.type || 'magiclink' });
          if (error) throw error;
          // (the cloud kept, for the next start: as a sign-in screen's own cloud is)
          try {
            const saved = JSON.parse(localStorage.getItem('vault-config') || 'null');
            if (!saved || saved.url !== target.url) {
              localStorage.setItem('vault-config', JSON.stringify({ url: target.url, key: target.key, email: String(got.email || '') }));
            } else if (got.email && saved.email !== got.email) {
              localStorage.setItem('vault-config', JSON.stringify({ ...saved, email: String(got.email) }));
            }
          } catch (error) { /* a private window: signed in for now */ }
          finish('in');
        } catch (error) {
          pair = null;
          V.clear(problem, V.h('p.error-text', { text: WORDS.failed }));
          draw('over');
        }
      }

      function seen() {
        if (done) return;
        if (document.hidden) { clearTimeout(pollTimer); return; }
        if (pair) { tick(); look(); }
      }
      document.addEventListener('visibilitychange', seen);

      const back = V.h('button.link-btn.pair-back', { type: 'button', text: 'Back', onclick: () => {
        const was = pair;
        pair = null;
        if (was) call('pairCancel', { id: was.id }).catch(() => {});
        finish('back');
      } });
      V.gate.screen(V.h('h1', { text: 'Sign in with a code' }),
        V.h('p.muted.pair-how', { text: 'On a device where you\'re signed in to Wefty: open Settings > Devices > Sign in another '
          + 'device and type this code.' }),
        codeBox,
        V.h('p.pair-device', {}, V.icon(device.kind === 'pc' ? 'pc' : device.kind === 'chromebook' || device.kind === 'browser'
          ? 'laptop' : 'phone'), V.h('span', { text: `It shows this device as: ${device.label}` })),
        left, state, buttons, problem, back);
      start();
    });
  }

  /* -- the signed-in device: typing the other one's code */

  // pair-look / pair-approve, with this person's own sign-in (js/access.js's helperCall), or the PC part's.
  async function askHelper(action, args) {
    if (V.desktop) {
      const name = action === 'pair-look' ? 'pairLook' : 'pairApprove';
      if (!V.pc.can(name)) throw fault('pcOld');
      return V.pc.call(name, args);
    }
    try {
      return await V.invites.helperCall(action, args, waits.call);
    } catch (error) {
      if (error && error.status) throw error;
      if (error && error.kind === 'signed-out') throw fault('signedOut');
      if (!navigator.onLine) throw fault('offline');
      throw fault(await reaches(V.config) ? 'missing' : 'unreachable');
    }
  }

  function agoWords(at) {
    const when = typeof at === 'number' ? at : Date.parse(at || '');
    if (!Number.isFinite(when)) return '';
    const minutes = Math.max(0, Math.round((Date.now() - when) / 60000));
    return minutes < 1 ? 'Asked just now.' : `Asked ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
  }

  let open = null;  // the sheet, while it shows (one at a time)

  function approve() {
    if (open) return open;
    const box = V.h('input.field.pair-box', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
      inputmode: 'text', maxlength: '14', placeholder: 'K7QX-9MRT', 'aria-label': 'The code the other device shows' });
    const body = V.h('div.pair-approve');
    const problem = V.h('div.pair-problem', { role: 'alert' });
    const warn = V.h('p.pair-warn', {}, V.icon('alert'), V.h('span', { text: 'Only type a code shown on a device right next to '
      + 'you. Never one someone sent you or read to you.' }));
    let step = 'code';
    let code = '';
    let asking = false;
    let device = null;

    const say = (error) => {
      const kind = kindOf(error, false);
      const words = kind === 'pcOld' ? WORDS.pcOld() : kind ? WORDS[kind] : (error && error.message) || WORDS.failed;
      V.clear(problem, V.h('p.error-text', { text: words }),
        kind === 'missing' && V.who() === 'owner' ? V.h('p.hint.pair-owner', { text: WORDS.ownerHere }) : null);
    };

    function draw() {
      const [back, go] = buttons();
      if (step === 'code') {
        V.clear(body, V.h('p', { text: 'On the device you want to sign in, tap "Use a code from another device". Type the code it '
          + 'shows here.' }), V.h('label.label', {}, 'Its code', box), warn, problem);
        if (back) back.lastChild.textContent = 'Cancel';
        if (go) { go.lastChild.textContent = 'Next'; go.disabled = asking; }
      } else if (step === 'confirm') {
        V.clear(body, V.h('p.pair-ask', {}, V.h('strong', { text: `Sign in ${named(device)}?` })),
          V.h('p.pair-when', { text: [`Code ${shown(code)}.`, agoWords(device && device.at)].filter(Boolean).join(' ') }),
          warn, problem);
        if (back) back.lastChild.textContent = 'Back';
        if (go) { go.lastChild.textContent = 'Sign it in'; go.disabled = asking; }
      } else {
        V.clear(body, V.h('p.pair-done', {}, V.icon('check'), V.h('span', { text: `Done. ${named(device)} is signing in now.` })));
        if (back) back.hidden = true;
        if (go) { go.lastChild.textContent = 'Done'; go.disabled = false; }
      }
    }
    const buttons = () => (open ? [open.el.querySelector('.sheet-actions .btn:not(.primary)'),
      open.el.querySelector('.sheet-actions .btn.primary')] : []);

    async function next() {
      if (asking) return true;
      V.clear(problem);
      if (step === 'done') return false;
      if (step === 'code') {
        code = plain(box.value);
        if (!looksRight(code)) {
          V.clear(problem, V.h('p.error-text', { text: 'Type the 8 letters and numbers the other device shows.' }));
          box.focus();
          return true;
        }
      }
      asking = true;
      draw();
      try {
        if (step === 'code') {
          const got = await askHelper('pair-look', { code });
          device = { ...(got && got.device), at: got && got.at };
          step = 'confirm';
        } else {
          await askHelper('pair-approve', { code });
          step = 'done';
        }
      } catch (error) {
        say(error);
        if (kindOf(error, false) === 'unknown' || kindOf(error, false) === 'taken') step = 'code';
      } finally {
        asking = false;
      }
      draw();
      if (step === 'code') box.focus();
      return true;
    }

    open = V.sheet({
      title: 'Sign in another device',
      content: body,
      actions: [{ label: 'Cancel', onClick: () => {
        if (step !== 'confirm' || asking) return false;
        step = 'code';  // (Back: the code again)
        V.clear(problem);
        draw();
        box.focus();
        return true;
      } }, { label: 'Next', kind: 'primary', onClick: next }],
      onClose: () => { open = null; },
    });
    draw();
    return open;
  }

  return { signInScreen, approve, reaches, plain, shown, looksRight, here, waits, WORDS };
})();
