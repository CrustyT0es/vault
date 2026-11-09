/* Wefty 1.21, the doors: anyone who finds wefty.org can sign up and sign in, on a phone, a Chromebook or a computer's
   browser. (The PC app keeps its own setup and sign-in screens in js/start.js.)

   The site's own cloud is named in cloud.json beside index.html ({format 1, url, key, captcha}), written by the
   owner's PC (vault/doors.py) and never kept in this repo. It's read only when it's needed: a browser with no saved
   cloud ('vault-config'), or one whose saved cloud is that one (for its CAPTCHA). A key that's secret, a JWT that isn't
   the anon one, or an address that isn't https://<ref>.supabase.co (the tests' 127.0.0.1 too, only from a page served
   there) is never used. No cloud.json, or a bad one: everything is as before (js/start.js's connect screen).

   With it, the first screen (front) offers Sign up (when the cloud takes sign-ups: its /auth/v1/settings), Sign in,
   Continue with Google (when the cloud has it), a code from another device (js/pair.js, when it's there), the iPhone
   icon's Paste my sign-in (js/start.js's) and "I have an invite" (js/start.js's connect screen). Signing in there saves
   'vault-config' as an invite or a #connect= link would, so every later start is the usual one.

   E-mails (sign-up, password reset, a code to sign in) carry a 6-digit code and a link back to this very page:
   #auth=<hash>&type=<t>, or the cloud's default #access_token=...; Google comes back with #access_token or #error.
   `arrival` takes them first thing at the start and takes them out of the address at once. A new account (the e-mail
   confirmed, or a Google account that agreed to the Terms) is marked here ('vault-doors-new') until js/start.js has
   started its welcome steps.

   CAPTCHA (Cloudflare Turnstile), only when cloud.json names a site key for the cloud in use: every call the cloud
   checks (sign up, the password sign-in, a code by e-mail, a password reset, sending again) gets a fresh token from
   `captcha()` (each is good once). If its script can't load (a network that blocks it), that's said in words, with
   the other ways (a code from another device needs no check; mobile data; at home). Nothing here ever tries to get
   round a block. */
'use strict';

V.doors = (() => {
  const TERMS = '2026-11-08';  // the Terms' and Privacy policy's date, kept in each new account's user_metadata
  const CLOUD = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
  const LOCAL_CLOUD = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/;  // (the tests' stand-in cloud)
  const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{8,200}$/;
  const JWT = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;
  const SITE_KEY = /^[0-9A-Za-z_-]{8,100}$/;
  const TOKEN_HASH = /^[A-Za-z0-9_.-]{10,300}$/;
  const KINDS = ['signup', 'recovery', 'magiclink', 'email_change', 'invite', 'email'];
  const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const NEW = 'vault-doors-new';  // localStorage: the id of an account made just now, until its welcome starts
  const WAIT = 'wefty-doors-wait';  // sessionStorage: a code screen left open ({ email, kind, url, at }), never a code
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // (tests shorten them)
  const waits = { cloud: 5000, settings: 5000, front: 4000, resend: 60, load: 15000, check: 60000, wait: 3600000 };

  const WORDS = {
    pitch: 'Notes, flash cards and a study plan for school. Free.',
    offline: 'You\'re offline. Connect to the internet, then try again.',
    unreachable: 'Wefty can\'t reach the cloud. Check the internet, then try again.',
    full: 'Wefty is full for now. Ask a friend who uses Wefty for an invite, or try again in a few days.',
    closed: 'Wefty isn\'t taking new accounts right now. Ask a friend who uses Wefty for an invite.',
    // (1.22.2) the first screen while sign-ups are closed, and Google coming back with an account Wefty doesn't have
    signUpsSoon: 'New here? Sign-ups open soon. Ask whoever invited you.',
    noAccountYet: 'There\'s no Wefty for that account, and Wefty isn\'t taking new accounts right now. Invited? Sign in '
      + 'with the e-mail your invite went to.',
    exists: 'There may already be a Wefty with that e-mail. Sign in, or reset your password if you forgot it.',
    notConfirmed: 'Your e-mail isn\'t confirmed yet. Wefty can send you a new code.',
    wrongCode: 'That code isn\'t right, or it ran out. Check it, or send a new one.',
    oldLink: 'That link ran out or was already used. Sign in, or ask for a new e-mail.',
    noAccount: 'There\'s no Wefty with that e-mail yet. Check it, or sign up.',
    codeOff: 'Signing in with a code by e-mail is off for this Wefty. Use your password.',
    wrong: 'That e-mail or password isn\'t right.',
    badEmail: 'Type your e-mail address (like sam@example.com).',
    notAllowed: 'Wefty can\'t send e-mail to that address yet. Ask a friend who uses Wefty for an invite.',
    hourly: 'Wefty has sent a lot of e-mails in the last hour. Try again in a little while.',
    tooMany: 'Too many tries just now. Wait a minute, then try again.',
    stronger: 'Pick a stronger password: mix letters, numbers and symbols.',
    same: 'That\'s the password you have now: pick a new one.',
    checkFailed: 'The sign-in check didn\'t work. Try again.',
    checkBlocked: 'The sign-in check (it shows you\'re a person) didn\'t load on this network. Try mobile data, or try at home.',
    checkPair: 'Or use a code from another device: that needs no check.',
    trouble: 'The cloud had trouble just now. Try again in a minute.',
    google: 'Google didn\'t sign you in. Try again, or use your e-mail.',
    other: 'That didn\'t work. Try again.',
    tick: 'Tick the box to agree to the Terms and the Privacy policy.',
    short: 'Pick a password of at least 8 characters.',
    twice: 'The two passwords aren\'t the same.',
    name: 'Type your name.',
    check: 'One quick check: tick the box to show you\'re a person.',
  };
  const seconds = (n) => `Wefty just sent you an e-mail. You can ask for another in ${n} seconds.`;
  const longer = (n) => `Pick a longer password: at least ${n} characters.`;

  const here = () => location.origin + location.pathname;  // where e-mail links and Google come back to
  const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
  const stored = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; } };

  /* ---------------------------------------------------------------- the site's own cloud (cloud.json) */

  const goodUrl = (url) => CLOUD.test(url)
    || (LOCAL_CLOUD.test(url) && /^(127\.0\.0\.1|localhost)$/.test(location.hostname));
  function publicKey(key) {
    const text = String(key || '');
    if (/^sb_secret_/i.test(text)) return false;
    if (PUBLISHABLE.test(text)) return true;
    if (!JWT.test(text)) return false;
    try {
      const part = text.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)));
      return !!claims && claims.role === 'anon';
    } catch (error) {
      return false;
    }
  }
  /* cloud.json as the page may use it: { url, key, captcha: { provider, site } | null }, or null. */
  function checked(file) {
    if (!file || typeof file !== 'object' || file.format !== 1) return null;
    const url = String(file.url || '').trim().replace(/\/+$/, '');
    if (!goodUrl(url) || !publicKey(file.key)) return null;
    const given = file.captcha && typeof file.captcha === 'object' ? file.captcha : null;
    const captcha = given && given.provider === 'turnstile' && SITE_KEY.test(String(given.site || ''))
      ? { provider: 'turnstile', site: String(given.site) } : null;
    return { url, key: String(file.key), captcha };
  }
  async function readCloudFile() {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), waits.cloud);
    try {
      const reply = await fetch('./cloud.json', { cache: 'no-store', credentials: 'same-origin', signal: control.signal });
      if (!reply.ok) return null;
      return checked(await reply.json());
    } finally {
      clearTimeout(timer);
    }
  }
  let fromSite = null;
  /* The site's own cloud, read once a page load (never on the PC app). */
  function defaultCloud() {
    if (V.desktop) return Promise.resolve(null);
    if (!fromSite) fromSite = readCloudFile().catch(() => null);
    return fromSite;
  }

  /* The cloud in use: the one a door here set up, else the one js/start.js made the client for. */
  let using = null;
  function current() {
    if (using) return using;
    const made = V.cloud && V.cloud.cloudConfig ? V.cloud.cloudConfig() : null;
    return made && made.url ? { url: made.url, key: made.key } : null;
  }
  /* This cloud's client (js/cloud.js keeps one for it: asked again, it's the same). */
  function use(cloud) {
    using = { url: cloud.url, key: cloud.key };
    V.cloud.client({ url: cloud.url, key: cloud.key });
    return V.cloud.sb;
  }

  /* The cloud's own switches (GET /auth/v1/settings, no sign-in): { signup, google, email, autoconfirm }, or null
     when they can't be read (then only what always works is offered). Asked once a page load. */
  const settingsOf = new Map();
  function settings(cloud = current()) {
    if (!cloud || !cloud.url) return Promise.resolve(null);
    if (!settingsOf.has(cloud.url)) settingsOf.set(cloud.url, readSettings(cloud).catch(() => null));
    return settingsOf.get(cloud.url);
  }
  async function readSettings(cloud) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), waits.settings);
    try {
      const reply = await fetch(`${cloud.url}/auth/v1/settings`, { headers: { apikey: cloud.key }, cache: 'no-store',
        signal: control.signal });
      if (!reply.ok) return null;
      const got = await reply.json();
      if (!got || typeof got !== 'object') return null;
      const external = got.external && typeof got.external === 'object' ? got.external : {};
      return { signup: !got.disable_signup, google: !!external.google, email: external.email !== false,
        autoconfirm: !!got.mailer_autoconfirm };
    } finally {
      clearTimeout(timer);
    }
  }
  /* Whether `cloud` is the site's own (the one cloud.json names). */
  const ownCloud = (cloud) => defaultCloud().then((file) => !!file && !!cloud && file.url === String(cloud.url).replace(/\/+$/, ''));
  /* The switches, waited for `ms` at most (null after that: a draw shouldn't sit on a slow cloud). */
  const settingsSoon = (cloud, ms = waits.front) => Promise.race([settings(cloud), sleep(ms).then(() => null)]);

  const termsUrl = () => (V.desktop ? 'https://wefty.org/terms' : 'terms.html');
  const privacyUrl = () => (V.desktop ? 'https://wefty.org/privacy' : 'privacy.html');

  /* ---------------------------------------------------------------- CAPTCHA (Turnstile) */

  const checkError = (reason) => Object.assign(new Error(reason === 'blocked'
    ? `${WORDS.checkBlocked}${V.pair ? ' ' + WORDS.checkPair : ''}` : WORDS.checkFailed), { kind: 'captcha', reason });
  let loading = null;
  function loadTurnstile() {
    if (window.turnstile && typeof window.turnstile.render === 'function') return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timer = null;
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        loading = null;  // (a later try loads it again: the network may have changed)
        reject(checkError('blocked'));
      };
      timer = setTimeout(fail, waits.load);
      script.onload = () => {
        clearTimeout(timer);
        if (window.turnstile && typeof window.turnstile.render === 'function') resolve(window.turnstile);
        else fail();
      };
      script.onerror = fail;
      script.async = true;
      script.src = TURNSTILE;
      document.head.append(script);
    });
    return loading;
  }
  async function siteKey() {
    const cloud = current();
    if (!cloud) return '';
    const file = await defaultCloud();
    return file && file.captcha && file.url === String(cloud.url).replace(/\/+$/, '') ? file.captcha.site : '';
  }
  // One widget for the page, outside #app (each screen replaces #app's insides), shown only when Turnstile asks.
  let box = null;
  let widget = null;
  let made = false;
  let issued = false;
  let pending = null;
  function settle(error, token) {
    const was = pending;
    pending = null;
    if (box) box.classList.remove('asking');
    if (!was) return;
    clearTimeout(was.timer);
    if (error) was.reject(error);
    else was.resolve(String(token || ''));
  }
  function makeWidget(turnstile, site) {
    box = V.h('div.doors-check', { role: 'group', 'aria-label': 'A quick check' },
      V.h('p.doors-check-words', { text: WORDS.check }), V.h('div.doors-check-widget'));
    document.body.append(box);
    widget = turnstile.render(box.querySelector('.doors-check-widget'), {
      sitekey: site, execution: 'execute', appearance: 'interaction-only',
      callback: (token) => settle(null, token),
      'error-callback': () => { settle(checkError('failed')); return true; },
      'timeout-callback': () => settle(checkError('failed')),
      'unsupported-callback': () => settle(checkError('failed')),
      'expired-callback': () => {},
      'before-interactive-callback': () => { if (box) box.classList.add('asking'); },
      'after-interactive-callback': () => { if (box) box.classList.remove('asking'); },
    });
  }
  async function oneToken() {
    if (V.desktop) return '';
    const site = await siteKey();
    if (!site) return '';
    const turnstile = await loadTurnstile();
    if (!made) {
      try {
        makeWidget(turnstile, site);
        made = true;
      } catch (error) {
        if (box) box.remove();
        box = null;
        throw checkError('failed');
      }
    } else if (issued) { try { turnstile.reset(widget); } catch (error) { /* (a fresh one comes anyway) */ } }
    issued = true;
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => settle(checkError('failed')), waits.check) };
      try { turnstile.execute(widget); } catch (error) { settle(checkError('failed')); }
    });
  }
  let chain = Promise.resolve();
  /* A fresh token for one call the cloud checks ('' when this cloud asks for none), one at a time. */
  function captcha() {
    const run = chain.catch(() => {}).then(oneToken);
    chain = run;
    return run;
  }

  /* ---------------------------------------------------------------- what went wrong, in words */

  /* GoTrue's errors (and this page's own) as one plain sentence. `link`: it came from an e-mail's link. */
  function words(error, { link = false, fallback = '' } = {}) {
    if (!error) return '';
    if (error.kind === 'captcha') return error.message;
    const code = String(error.code || error.error_code || '');
    const text = String(error.message || error.msg || error.error_description || (typeof error === 'string' ? error : ''));
    const status = Number(error.status) || 0;
    if (/database error saving new user/i.test(text)) return WORDS.full;
    if (code === 'over_email_send_rate_limit' || /email rate limit|only request this after/i.test(text)) {
      const wait = /after (\d+) seconds?/i.exec(text);
      return wait ? seconds(wait[1]) : WORDS.hourly;
    }
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(text)) return WORDS.wrong;
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(text)) return WORDS.notConfirmed;
    if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered/i.test(text)) return WORDS.exists;
    if (code === 'same_password' || /different from the old/i.test(text)) return WORDS.same;
    if (code === 'weak_password' || /password should (be at least|contain)/i.test(text)) {
      const least = /at least (\d+)/i.exec(text);
      return least ? longer(least[1]) : WORDS.stronger;
    }
    if (code === 'otp_expired' || /token has expired|link is invalid|has expired/i.test(text)) return link ? WORDS.oldLink : WORDS.wrongCode;
    if (code === 'otp_disabled' || /not allowed for otp/i.test(text)) return /signups? not allowed/i.test(text) ? WORDS.noAccount : WORDS.codeOff;
    if (code === 'signup_disabled' || /signups? not allowed/i.test(text)) return WORDS.closed;
    if (code === 'captcha_failed' || /captcha/i.test(text)) return WORDS.checkFailed;
    if (code === 'email_address_not_authorized') return WORDS.notAllowed;
    if (code === 'email_address_invalid' || code === 'validation_failed' && /email/i.test(text)) return WORDS.badEmail;
    if (code === 'over_request_rate_limit' || status === 429) return WORDS.tooMany;
    if (!navigator.onLine) return WORDS.offline;
    if (error.name === 'AuthRetryableFetchError' && status >= 500) return WORDS.trouble;
    if (error.name === 'AuthRetryableFetchError' || error.name === 'TypeError' || status === 0
      || /failed to fetch|networkerror|load failed|network request failed/i.test(text)) return WORDS.unreachable;
    if (status >= 500) return WORDS.trouble;
    return fallback || (text ? V.weftyWords(text) : WORDS.other);
  }

  /* An error said in `problem`, with the way round it in `more` when there's one (the sign-in check blocked on this
     network: a code from another device). */
  function say(problem, more, error, opts) {
    problem.textContent = words(error, opts);
    if (more) V.clear(more, error && error.kind === 'captcha' && error.reason === 'blocked' ? pairButton(opts && opts.pair) : null);
  }

  /* ---------------------------------------------------------------- after signing in */

  /* The account signed in here now: 'vault-config' saved with its cloud and e-mail (as an invite or #connect= would),
     so every later start is the usual one. Returns it. */
  async function keep(cloud = current()) {
    let email = '';
    try {
      const { data } = await V.cloud.sb.auth.getSession();
      email = (data && data.session && data.session.user && data.session.user.email) || '';
    } catch (error) { /* (the e-mail just isn't filled in later) */ }
    const saved = { url: cloud.url, key: cloud.key, email };
    try { localStorage.setItem('vault-config', JSON.stringify(saved)); } catch (error) { /* private window: this time only */ }
    try { sessionStorage.removeItem(WAIT); } catch (error) { /* */ }
    return saved;
  }

  // A new account made just now: its welcome steps come next (js/start.js asks isNew, then welcomed).
  const markNew = (id) => { try { if (id) localStorage.setItem(NEW, id); } catch (error) { /* this page only */ } };
  const isNew = (id) => { try { return !!id && localStorage.getItem(NEW) === id; } catch (error) { return false; } };
  const welcomed = () => { try { localStorage.removeItem(NEW); } catch (error) { /* */ } };
  async function markSignedIn() {
    try {
      const { data } = await V.cloud.sb.auth.getSession();
      markNew(data && data.session && data.session.user && data.session.user.id);
    } catch (error) { /* */ }
  }

  /* Whether the account signed in here still has to agree to the Terms: one that came by Google (or another sign-in
     Wefty hasn't seen agree), never an e-mail one, an invited friend's or one made with a join code. The account
     (supabase-js's user), or null. */
  async function needsTerms() {
    if (V.desktop || !V.cloud || !V.cloud.sb) return null;
    let user = null;
    try {
      const { data } = await V.cloud.sb.auth.getSession();
      user = data && data.session && data.session.user;
    } catch (error) { return null; }
    if (!user) return null;
    const app = user.app_metadata || {};
    const meta = user.user_metadata || {};
    if (String(app.provider || 'email') === 'email' || meta.terms || meta.invited_by || app.vault_invited_by
      || app.vault_join) return null;
    return user;
  }

  /* ---------------------------------------------------------------- pieces of the screens */

  const screen = (...kids) => V.gate.screen(...kids);
  const field = (label, attrs) => V.gate.field(label, attrs);

  function link(text, href) {
    const a = V.h('a', { href, target: '_blank', rel: 'noopener', text });
    if (V.desktop) {
      a.addEventListener('click', (event) => {
        event.preventDefault();
        V.pc.call('openLink', { url: href }).catch(V.problem);
      });
    }
    return a;
  }
  // "I agree to the Terms and the Privacy policy", both linked.
  function termsTick() {
    const box = V.h('input', { type: 'checkbox', name: 'terms' });
    const row = V.h('label.doors-tick', {}, box, V.h('span', {}, 'I agree to the ', link('Terms', termsUrl()), ' and the ',
      link('Privacy policy', privacyUrl())));
    return [row, box];
  }
  // A password box with Show / Hide beside its words.
  function passwordField(label, attrs) {
    const [row, input] = field(label, { type: 'password', ...attrs });
    const show = V.h('button.doors-show', { type: 'button', text: 'Show', 'aria-label': 'Show password', 'aria-pressed': 'false' });
    show.addEventListener('click', () => {
      const shown = input.type === 'password';
      input.type = shown ? 'text' : 'password';
      show.textContent = shown ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(shown));
      show.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
      input.focus();
    });
    return [V.h('div.doors-pass', {}, row, show), input];
  }
  const legal = () => V.h('p.doors-legal', {}, link('Terms', termsUrl()), V.h('span', { 'aria-hidden': 'true', text: ' · ' }),
    link('Privacy', privacyUrl()));
  const or = () => V.h('div.doors-or', { role: 'separator' }, V.h('span', { text: 'or' }));
  const busyWhile = async (button, work) => {
    button.disabled = true;
    try { return await work(); } finally { button.disabled = false; }
  };
  const tidyEmail = (text) => String(text || '').trim();
  const cleanName = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  /* "Use a code from another device" (js/pair.js), when it's there: 'in' signs in here (`pair.done`), 'back' draws
     the screen it came from again. */
  function pairButton(pair) {
    if (!V.pair || !pair) return null;
    return V.button('Use a code from another device', { kind: 'wide-btn doors-pair', icon: 'devices', onClick: async () => {
      let got = 'back';
      try { got = await V.pair.signInScreen({ cloud: pair.cloud || current() }); } catch (error) { console.error(error); }
      if (got === 'in') pair.done();
      else pair.back();
    } });
  }

  /* ---------------------------------------------------------------- the first screen */

  /* Wefty's front door, for a browser with nothing saved and a good cloud.json. Resolves with the saved cloud once
     someone is signed in here. js/start.js hands over what it owns: `signIn(back)` (its sign-in screen, resolving once
     signed in), `invite(back)` (its connect screen), `paste` ({ button, hint, problem, icon } or null: Paste my sign-in,
     for a move pass or a sign-in link; on an iPhone's or iPad's home screen icon (`icon`) it's the main way in, as an
     icon starts with nothing of Safari's, so it comes first there) and a `note` to show (an e-mail link that didn't
     work). */
  async function front({ cloud, note = '', signIn, invite, paste = null }) {
    use(cloud);
    // Signed in here just before a reload (the save of the cloud didn't happen): in.
    try {
      const { data } = await V.cloud.sb.auth.getSession();
      if (data && data.session) {
        const got = await V.cloud.sb.auth.getUser();
        if (!got.error && got.data && got.data.user) return keep(cloud);
      }
    } catch (error) { /* offline or nobody: the screen */ }
    const known = await settingsSoon(cloud);
    return new Promise((resolve) => {
      const done = async () => resolve(await keep(cloud));
      const draw = (said = '') => {
        const problem = V.h('p.error-text', { role: 'alert', text: said });
        const open = !!(known && known.signup);
        const icon = !!(paste && paste.icon);
        const signUp = open ? V.button('Sign up', { kind: `${icon ? '' : 'primary '}wide-btn doors-signup`,
          onClick: () => signUpScreen({ cloud, back: draw, done }) }) : null;
        const signInButton = V.button('Sign in', { kind: `${open || icon ? '' : 'primary '}wide-btn doors-signin`, onClick: async () => {
          await signIn(() => draw());
          done();
        } });
        // (While the cloud takes no new accounts, Google only signs in an account that's already there, the same
        // e-mail: the cloud turns a new one down. So it says sign in.)
        const google = known && known.google ? V.button(open ? 'Continue with Google' : 'Sign in with Google', {
          kind: 'wide-btn doors-google', onClick: () => googleStart({ problem, back: () => draw() }) }) : null;
        const pair = pairButton({ cloud, done, back: () => draw() });
        const invited = V.h('button.link-btn.doors-invite', { type: 'button', text: 'I have an invite', onclick: () => invite(() => draw()) });
        // (1.22.2) Sign-ups closed (most people here were invited, many moving from the old address): no Sign up, and
        // the ways in for someone who has a Wefty lead: Sign in, Paste my sign-in from the old Wefty, a code from
        // another device. Can't tell (the cloud's switches unread): the same, without the line about sign-ups.
        const closedLine = known && !known.signup ? V.h('p.doors-new.doors-closed', { text: WORDS.signUpsSoon }) : null;
        if (!open && !icon) {
          if (paste && paste.closed) paste.closed();
          screen(V.h('h1.doors-pitch', { text: WORDS.pitch }),
            note && !said ? V.h('p.doors-note', { role: 'note', text: note }) : null,
            V.h('div.doors-stack', {}, signInButton, paste ? paste.button : null, pair, google),
            paste ? [paste.problem, paste.box || null, paste.hint] : null,
            problem, invited, closedLine, legal());
          return;
        }
        screen(V.h('h1.doors-pitch', { text: WORDS.pitch }),
          note && !said ? V.h('p.doors-note', { role: 'note', text: note }) : null,
          icon ? [paste.hint, paste.button, paste.problem, paste.box || null] : null,
          V.h('div.doors-stack', {}, signUp, signInButton, google, pair),
          paste && !icon ? [paste.hint, paste.button, paste.problem, paste.box || null] : null,
          problem, invited, closedLine, legal());
      };
      const wait = waiting(cloud);
      if (wait) codeScreen({ ...wait, cloud, back: () => draw(), done });
      else draw();
    });
  }

  /* ---------------------------------------------------------------- sign up */

  function signUpScreen({ cloud = current(), back, done, email = '' }) {
    const [nameRow, nameBox] = field('Your name', { type: 'text', autocomplete: 'name', maxlength: '60' });
    const [emailRow, emailBox] = field('E-mail', { type: 'email', autocomplete: 'email', value: email });
    const [passRow, passBox] = passwordField('Pick a password', { placeholder: 'At least 8 characters', autocomplete: 'new-password' });
    const [tickRow, tick] = termsTick();
    const problem = V.h('p.error-text', { role: 'alert' });
    const more = V.h('div.doors-more');
    const go = V.button('Make my Wefty', { kind: 'primary wide-btn doors-make', onClick: () => busyWhile(go, async () => {
      problem.textContent = '';
      V.clear(more);
      const name = cleanName(nameBox.value);
      const typed = tidyEmail(emailBox.value);
      if (!name) { problem.textContent = WORDS.name; nameBox.focus(); return; }
      if (!EMAIL.test(typed)) { problem.textContent = WORDS.badEmail; emailBox.focus(); return; }
      if (passBox.value.length < 8) { problem.textContent = WORDS.short; passBox.focus(); return; }
      if (!tick.checked) { problem.textContent = WORDS.tick; tick.focus(); return; }
      try {
        const captchaToken = await captcha();
        const { data, error } = await V.cloud.sb.auth.signUp({ email: typed, password: passBox.value, options: {
          emailRedirectTo: here(), data: { name, terms: TERMS }, captchaToken } });
        if (error) throw error;
        if (data && data.session) {  // (a cloud that takes new accounts without an e-mail)
          await markSignedIn();
          done();
          return;
        }
        if (data && data.user && Array.isArray(data.user.identities) && !data.user.identities.length) {
          existsScreen({ cloud, email: typed, back: () => signUpScreen({ cloud, back, done, email: typed }), done });
          return;
        }
        codeScreen({ cloud, email: typed, kind: 'signup', sent: true, back: () => signUpScreen({ cloud, back, done, email: typed }), done });
      } catch (error) {
        if (error && error.code === 'user_already_exists') {
          existsScreen({ cloud, email: typed, back: () => signUpScreen({ cloud, back, done, email: typed }), done });
          return;
        }
        say(problem, more, error, { pair: { cloud, done, back: () => signUpScreen({ cloud, back, done, email: typed }) } });
      }
    }) });
    tick.addEventListener('change', () => { if (tick.checked && problem.textContent === WORDS.tick) problem.textContent = ''; });
    screen(V.welcome.dots('password'), V.h('h1', { text: 'Make your Wefty' }),
      V.h('p.muted', { text: 'Free. Your notes are only yours.' }),
      nameRow, emailRow, passRow, tickRow, problem, more, go,
      V.h('button.link-btn', { type: 'button', text: 'Back', onclick: () => back() }));
    requestAnimationFrame(() => (email ? passBox : nameBox).focus());
  }

  /* GoTrue never says who has an account: an address that has one gets the same answer as a new one, with no e-mail. */
  function existsScreen({ cloud, email, back, done }) {
    screen(V.h('h1', { text: 'Already on Wefty?' }),
      V.h('p.muted.doors-sent', { text: WORDS.exists }),
      V.h('p.doors-address', { text: email }),
      V.button('Sign in', { kind: 'primary wide-btn', onClick: () => signInHere({ cloud, email, back, done }) }),
      V.button('Forgot password?', { kind: 'wide-btn', onClick: () => forgotScreen({ cloud, email, back, done }) }),
      V.h('button.link-btn', { type: 'button', text: 'Use a different e-mail', onclick: () => back() }));
  }

  /* The sign-in screen (js/start.js's, with these doors on it) from one of these screens. */
  let signInHere = ({ back }) => back();
  function signInFrom(fn) { signInHere = fn; }

  /* ---------------------------------------------------------------- check your e-mail (a code, or the link) */

  /* kind: 'signup' (a new account's e-mail), 'email' (a code to sign in) or 'recovery' (a password reset). `sent`:
     the e-mail went just now (the countdown starts full). */
  function codeScreen({ cloud = current(), email, kind, back, done, sent = false, note = '' }) {
    try { sessionStorage.setItem(WAIT, JSON.stringify({ email, kind, url: cloud.url, at: Date.now() })); } catch (error) { /* */ }
    const [codeRow, codeBox] = field('Code from the e-mail', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      maxlength: '10', pattern: '[0-9]*', class: 'doors-code', spellcheck: 'false' });
    const problem = V.h('p.error-text', { role: 'alert', text: note });
    const status = V.h('p.doors-status', { role: 'status' });
    const more = V.h('div.doors-more');
    let left = sent ? waits.resend : 0;
    let ticking = null;
    const again = V.button('Send it again', { kind: 'wide-btn doors-again', onClick: () => resend() });
    const count = () => {
      again.disabled = left > 0;
      again.querySelector('span').textContent = left > 0 ? `Send it again in ${left} s` : 'Send it again';
    };
    const countFrom = (from) => {
      left = Math.max(0, Math.ceil(from));
      clearInterval(ticking);
      count();
      ticking = setInterval(() => {
        if (!again.isConnected) { clearInterval(ticking); return; }
        left = Math.max(0, left - 1);
        count();
        if (!left) clearInterval(ticking);
      }, 1000);
    };
    const leave = () => {
      clearInterval(ticking);
      window.removeEventListener('storage', elsewhere);
      try { sessionStorage.removeItem(WAIT); } catch (error) { /* */ }
    };
    // Signed in in another tab of this browser (the e-mail's link opened there): this one follows.
    const elsewhere = (event) => { if (event.key === 'vault-config' && event.newValue) { leave(); location.reload(); } };
    window.addEventListener('storage', elsewhere);
    async function resend() {
      problem.textContent = '';
      status.textContent = '';
      V.clear(more);
      again.disabled = true;
      try {
        const captchaToken = await captcha();
        const { error } = kind === 'recovery'
          ? await V.cloud.sb.auth.resetPasswordForEmail(email, { redirectTo: here(), captchaToken })
          : kind === 'email'
            ? await V.cloud.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: here(), captchaToken } })
            : await V.cloud.sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: here(), captchaToken } });
        if (error) throw error;
        status.textContent = 'Sent. Check your e-mail again.';
        countFrom(waits.resend);
      } catch (error) {
        say(problem, more, error, { pair: { cloud, done: finish, back: draw } });
        const wait = /after (\d+) seconds?/i.exec(String(error && error.message));
        countFrom(wait ? Number(wait[1]) : 0);
      }
    }
    const verify = V.button('Continue', { kind: 'primary wide-btn doors-verify', onClick: () => busyWhile(verify, async () => {
      problem.textContent = '';
      status.textContent = '';
      const token = codeBox.value.replace(/\D/g, '');
      if (token.length < 6) { problem.textContent = 'Type the code from the e-mail (6 numbers).'; codeBox.focus(); return; }
      try {
        const { data, error } = await V.cloud.sb.auth.verifyOtp({ email, token, type: kind });
        if (error) throw error;
        if (!data || !data.session) throw new Error(WORDS.wrongCode);
        leave();
        if (kind === 'signup') await markSignedIn();
        if (kind === 'recovery') await newPasswordScreen({ email });
        finish();
      } catch (error) {
        say(problem, more, error);
        // (A new account whose e-mail's link was opened already, on another device: its password signs in now.)
        if (kind === 'signup' && String((error && error.code) || '') === 'otp_expired') {
          more.append(V.button('Opened the link already? Sign in', { kind: 'wide-btn doors-signin-instead',
            onClick: () => { leave(); signInHere({ cloud, email, back: draw, done }); } }));
        }
        codeBox.select();
      }
    }) });
    codeBox.addEventListener('input', () => {
      const digits = codeBox.value.replace(/\D/g, '');
      if (digits !== codeBox.value) codeBox.value = digits;
      if (digits.length === 6 && !verify.disabled) verify.click();
    });
    codeBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') verify.click(); });
    function finish() { leave(); done(); }
    function draw() {
      const recovery = kind === 'recovery';
      screen(V.h('h1', { text: 'Check your e-mail' }),
        V.h('p.muted.doors-sent', { text: recovery ? 'If there\'s a Wefty with this e-mail, we sent it a code:' : 'We sent a code to:' }),
        V.h('p.doors-address', { text: email }),
        codeRow, problem, more, verify,
        V.h('p.hint.doors-center.doors-link-hint', { text: 'Or tap the link in the e-mail.' }),
        V.h('p.hint.doors-center', { text: 'Can\'t find it? Look in your spam or junk folder.' }),
        again, status,
        V.h('button.link-btn', { type: 'button', text: 'Wrong e-mail? Go back', onclick: () => { leave(); back(); } }),
        V.h('p.hint.doors-center.doors-fallback', { text: kind === 'signup'
          ? 'Nothing came? Check the e-mail is right, or ask a friend who uses Wefty for an invite.'
          : 'Nothing came? On a device where you\'re still signed in, change your password there (Settings > Account > '
            + 'Change password), then sign in here with the new one.' }));
      count();
      requestAnimationFrame(() => codeBox.focus());
    }
    draw();
    if (left) countFrom(left);
  }

  /* A code screen left open before this page reloaded (a phone that put Wefty away while the e-mail was read): opened
     again (js/start.js's sign-in screen asks). True when it was. */
  function resume({ back, done }) {
    const cloud = current();
    const wait = cloud ? waiting(cloud) : null;
    if (!wait) return false;
    codeScreen({ ...wait, cloud, back, done });
    return true;
  }

  /* The code screen kept for a reload: { email, kind } when it's this cloud's and under an hour old. */
  function waiting(cloud) {
    let wait = null;
    try { wait = JSON.parse(sessionStorage.getItem(WAIT) || 'null'); } catch (error) { return null; }
    if (!wait || wait.url !== cloud.url || !EMAIL.test(String(wait.email || '')) || !['signup', 'email', 'recovery'].includes(wait.kind)
      || !(Date.now() - Number(wait.at) < waits.wait)) return null;
    return { email: wait.email, kind: wait.kind };
  }

  /* ---------------------------------------------------------------- the sign-in screen's other ways */

  /* What js/start.js's web sign-in screen shows beside the password: { forgot, ways, create } elements. `email()` is
     what's typed in its e-mail box; `back` draws that screen again, `done` is signed in. */
  function signInWays({ email, back, done, offline = false }) {
    const cloud = current();
    const problem = V.h('p.error-text', { role: 'alert' });
    const more = V.h('div.doors-more');
    const forgot = V.h('button.link-btn.doors-forgot', { type: 'button', text: 'Forgot password?',
      onclick: () => forgotScreen({ cloud, email: email(), back, done }) });
    const code = V.button('E-mail me a code instead', { kind: 'wide-btn doors-code-instead', icon: 'send', onClick: () => busyWhile(code, async () => {
      problem.textContent = '';
      V.clear(more);
      const typed = email();
      if (!EMAIL.test(typed)) { problem.textContent = 'Type your e-mail above first.'; return; }
      try {
        const captchaToken = await captcha();
        const { error } = await V.cloud.sb.auth.signInWithOtp({ email: typed, options: { shouldCreateUser: false,
          emailRedirectTo: here(), captchaToken } });
        if (error) throw error;
        codeScreen({ cloud, email: typed, kind: 'email', sent: true, back, done });
      } catch (error) {
        say(problem, more, error, { pair: { cloud, done, back } });
      }
    }) });
    const google = V.h('div.doors-slot');
    const create = V.h('div.doors-slot');
    // (Only the site's own cloud, cloud.json's, is asked: one set up from a PC before 1.21 takes no sign-ups and has
    // no Google, and is left alone.)
    if (!offline && cloud) {
      ownCloud(cloud).then((own) => (own ? settings(cloud) : null)).then((known) => {
        if (!known || !google.isConnected) return;
        if (known.google) V.clear(google, V.button('Continue with Google', { kind: 'wide-btn doors-google', onClick: () => googleStart({ problem, back }) }));
        if (known.signup) {
          V.clear(create, V.h('p.doors-new', {}, V.h('span', { text: 'New to Wefty? ' }),
            V.h('button.link-btn.doors-create', { type: 'button', text: 'Create an account',
              onclick: () => signUpScreen({ cloud, back, done, email: email() }) })));
        }
      });
    }
    return { forgot, ways: [or(), V.h('div.doors-stack', {}, code, google, pairButton({ cloud, done, back })), problem, more], create };
  }

  /* A password sign-in that didn't work, said on js/start.js's sign-in screen; an e-mail not confirmed yet gets a
     button that sends its code again (and the code screen). */
  function signInTrouble(error, { email, problem, more, back, done }) {
    say(problem, more, error, { pair: { cloud: current(), done, back } });
    const code = String((error && error.code) || '');
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(String(error && error.message))) {
      const cloud = current();
      const send = V.button('Send the code again', { kind: 'wide-btn doors-confirm', onClick: () => busyWhile(send, async () => {
        try {
          const captchaToken = await captcha();
          const { error: failed } = await V.cloud.sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: here(), captchaToken } });
          if (failed) throw failed;
          codeScreen({ cloud, email, kind: 'signup', sent: true, back, done });
        } catch (sending) {
          say(problem, null, sending);
        }
      }) });
      more.append(send);
    }
  }

  /* ---------------------------------------------------------------- forgot password */

  function forgotScreen({ cloud = current(), email = '', back, done }) {
    const [emailRow, emailBox] = field('E-mail', { type: 'email', autocomplete: 'email', value: email });
    const problem = V.h('p.error-text', { role: 'alert' });
    const more = V.h('div.doors-more');
    const go = V.button('Send me a code', { kind: 'primary wide-btn doors-reset', onClick: () => busyWhile(go, async () => {
      problem.textContent = '';
      V.clear(more);
      const typed = tidyEmail(emailBox.value);
      if (!EMAIL.test(typed)) { problem.textContent = WORDS.badEmail; emailBox.focus(); return; }
      try {
        const captchaToken = await captcha();
        const { error } = await V.cloud.sb.auth.resetPasswordForEmail(typed, { redirectTo: here(), captchaToken });
        if (error) throw error;
        codeScreen({ cloud, email: typed, kind: 'recovery', sent: true, back: () => forgotScreen({ cloud, email: typed, back, done }), done });
      } catch (error) {
        say(problem, more, error, { pair: { cloud, done, back } });
      }
    }) });
    emailBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
    screen(V.h('h1', { text: 'Forgot your password?' }),
      V.h('p.muted', { text: 'Wefty will e-mail you a code. Then you pick a new password.' }),
      emailRow, problem, more, go,
      V.h('button.link-btn', { type: 'button', text: 'Back', onclick: () => back() }));
    requestAnimationFrame(() => emailBox.focus());
  }

  /* After a reset's code or link: a new password, then in. Resolves once it's saved (or skipped: still signed in). */
  function newPasswordScreen({ email = '' } = {}) {
    return new Promise((resolve) => {
      const [passRow, passBox] = passwordField('New password', { placeholder: 'At least 8 characters', autocomplete: 'new-password' });
      const [againRow, againBox] = field('Type it again', { type: 'password', autocomplete: 'new-password' });
      const problem = V.h('p.error-text', { role: 'alert' });
      const go = V.button('Save my password', { kind: 'primary wide-btn doors-save', onClick: () => busyWhile(go, async () => {
        problem.textContent = '';
        if (passBox.value.length < 8) { problem.textContent = WORDS.short; passBox.focus(); return; }
        if (passBox.value !== againBox.value) { problem.textContent = WORDS.twice; againBox.focus(); return; }
        try {
          const { error } = await V.cloud.sb.auth.updateUser({ password: passBox.value });
          if (error) throw error;
          V.toast('Password saved. Use it to sign in on your other devices.', { ms: 6000 });
          resolve();
        } catch (error) {
          problem.textContent = words(error);
        }
      }) });
      againBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') go.click(); });
      screen(V.h('h1', { text: 'Pick a new password' }),
        email ? V.h('p.muted.doors-sent', { text: `For ${email}.` }) : null,
        passRow, againRow, problem, go);
      requestAnimationFrame(() => passBox.focus());
    });
  }

  /* ---------------------------------------------------------------- Google */

  /* Off to Google (it comes back to this page with #access_token, or #error). An app's own browser (Instagram,
     Snapchat...) can't: Google refuses to sign anyone in there, so Chrome or Safari is offered first. */
  async function googleStart({ problem, back }) {
    if (V.deviceKind.inApp) { inAppGoogle(back); return; }
    if (problem) problem.textContent = '';
    try {
      const { error } = await V.cloud.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here() } });
      if (error) throw error;
    } catch (error) {
      if (problem) problem.textContent = words(error);
    }
  }

  function inAppGoogle(back) {
    const ios = V.deviceKind.ios;
    const browser = ios ? 'Safari' : 'Chrome';
    const page = new URL(here());
    const chrome = `intent://${page.host}${page.pathname}#Intent;scheme=https;package=com.android.chrome;`
      + `S.browser_fallback_url=${encodeURIComponent(page.href)};end`;
    screen(V.h('h1', { text: `Open Wefty in ${browser} to use Google` }),
      V.h('p.muted', { text: `Google doesn't let anyone sign in inside another app's browser. In ${browser} it works.` }),
      V.h('ol.steps.doors-in-app', {},
        V.h('li', { text: 'Tap Copy the link.' }),
        V.h('li', { text: ios ? 'Tap ••• (or the compass) and choose Open in Safari, or paste the link into Safari.'
          : 'Tap Open in Chrome below, or paste the link into Chrome.' }),
        V.h('li', { text: 'Tap Continue with Google there.' })),
      V.button('Copy the link', { kind: 'primary wide-btn doors-copy-link', icon: 'copy', onClick: async () => {
        await V.copy(page.href);
        V.toast(`Copied. Now open ${browser} and paste it there.`, { ms: 6000 });
      } }),
      ios ? null : V.h('a.btn.wide-btn.in-app-chrome', { href: chrome, rel: 'noopener' }, V.icon('open'), V.h('span', { text: 'Open in Chrome' })),
      V.h('p.hint', { text: 'Or carry on here with your e-mail instead.' }),
      V.h('button.link-btn', { type: 'button', text: 'Back', onclick: () => back() }));
  }

  /* An account that came by Google, the first time: it agrees to the Terms once (never asked again, on any device).
     Resolves once agreed (the account is new: its welcome steps come next). */
  function termsGate(user) {
    return new Promise((resolve) => {
      const [tickRow, tick] = termsTick();
      const problem = V.h('p.error-text', { role: 'alert' });
      const go = V.button('Continue', { kind: 'primary wide-btn doors-agree', onClick: () => busyWhile(go, async () => {
        problem.textContent = '';
        if (!tick.checked) { problem.textContent = WORDS.tick; tick.focus(); return; }
        try {
          const { error } = await V.cloud.sb.auth.updateUser({ data: { terms: TERMS } });
          if (error) throw error;
          markNew(user.id);
          resolve();
        } catch (error) {
          problem.textContent = words(error);
        }
      }) });
      tick.addEventListener('change', () => { if (tick.checked && problem.textContent === WORDS.tick) problem.textContent = ''; });
      screen(V.h('h1', { text: 'Welcome to Wefty' }),
        V.h('p.muted', { text: 'Signed in with Google as:' }),
        V.h('p.doors-address', { text: user.email || '' }),
        V.h('p.muted', { text: 'One last thing before your notes:' }),
        tickRow, problem, go,
        V.h('button.link-btn', { type: 'button', text: 'Not you? Sign out', onclick: async () => {
          await V.cloud.signOut().catch(() => {});
          location.reload();
        } }),
        legal());
    });
  }

  /* ---------------------------------------------------------------- arriving from an e-mail or Google */

  /* Supabase's client with its session in memory only (a sign-in checked before it replaces anyone's here). */
  let temps = 0;
  function memoryClient(cloud) {
    const kept = new Map();
    const storage = { getItem: (key) => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => { kept.set(key, String(value)); },
      removeItem: (key) => { kept.delete(key); } };
    return window.supabase.createClient(cloud.url, cloud.key, { auth: { storage, storageKey: `wefty-door-${++temps}`,
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  // Who's signed in to this browser's Wefty now (its e-mail, lower case), or ''.
  function signedInHere() {
    const session = stored('vault-auth');
    if (!session || typeof session.refresh_token !== 'string' || !session.refresh_token) return '';
    const email = (session.user && session.user.email) || (stored('vault-user') || {}).email || '';
    return String(email).toLowerCase();
  }

  /* First thing at the start (web only): an e-mail's link (#auth=<hash>&type=<t>, or the cloud's own
     #access_token=...&type=<t>) or Google coming back (#access_token=..., #error=...). The address is tidied at once,
     so a reload or Back never sees it. Returns null (nothing of the kind), or { note } (it didn't work: said on the
     first or the sign-in screen) or { toast } (signed in; a line to say once Wefty is open). A password reset's
     "Pick a new password" is shown here, before anything else. */
  async function arrival() {
    if (V.desktop) return null;
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    // (An error can come in the address's ?query too, from some of the cloud's versions: taken out the same way, the
    // rest of the query kept.)
    const query = new URLSearchParams(location.search);
    const queried = query.has('error') && (query.has('error_code') || query.has('error_description'));
    if (queried) {
      for (const name of ['error', 'error_code', 'error_description']) {
        if (query.has(name) && !params.has(name)) params.set(name, query.get(name));
        query.delete(name);
      }
    }
    if (!params.has('auth') && !params.has('access_token') && !params.has('error_code')
      && !(params.has('error') && params.has('error_description'))) return null;
    const search = queried ? (query.toString() ? '?' + query.toString() : '') : location.search;
    try { history.replaceState(history.state, '', location.pathname + search); } catch (error) { /* */ }
    const type = KINDS.includes(params.get('type') || '') ? params.get('type') : '';
    if (params.has('error') || params.has('error_code')) {
      const given = { code: params.get('error_code') || '', message: params.get('error_description') || params.get('error') || '' };
      // (1.22.2) Google (or a link) for an account Wefty doesn't have, while it takes no new ones: often a friend whose
      // Google account isn't the e-mail they were invited with.
      if (given.code === 'signup_disabled' || /signups? not allowed/i.test(given.message)) return { note: WORDS.noAccountYet };
      return { note: words(given, { link: true, fallback: WORDS.google }) };
    }
    const saved = stored('vault-config');
    const cloud = saved && goodUrl(String(saved.url || '')) && saved.key ? { url: saved.url, key: saved.key } : await defaultCloud();
    if (!cloud) return null;
    const tokenHash = params.get('auth') || '';
    const access = params.get('access_token') || '';
    const refresh = params.get('refresh_token') || '';
    if (tokenHash ? !TOKEN_HASH.test(tokenHash) || !type : !access || !refresh) return { note: WORDS.oldLink };
    const mine = saved && saved.url === cloud.url ? signedInHere() : '';
    let session = null;
    try {
      // Nobody signed in here: straight into this browser's sign-in. Someone is: checked first, never swapped out.
      const sb = mine ? memoryClient(cloud) : use(cloud);
      const { data, error } = tokenHash
        ? await sb.auth.verifyOtp({ token_hash: tokenHash, type })
        : await sb.auth.setSession({ access_token: access, refresh_token: refresh });
      if (error) throw error;
      session = data && data.session;
      if (!session) throw new Error(WORDS.oldLink);
    } catch (error) {
      return { note: words(error, { link: true }) };
    }
    const email = String((session.user && session.user.email) || '');
    if (mine && mine !== email.toLowerCase()) {
      return { toast: `That e-mail link was for ${email}, but Wefty here is signed in as ${mine}. To use ${email} here, `
        + 'sign out first (tap your picture, then Sign out), then sign in.' };
    }
    if (mine) {  // the same person: the new sign-in takes the old one's place
      try { await use(cloud).auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token }); } catch (error) { /* */ }
    }
    await keep(cloud);
    if (type === 'signup') markNew(session.user && session.user.id);
    if (type === 'recovery') await newPasswordScreen({ email });
    return { toast: type === 'email_change' ? 'Your new e-mail address is confirmed.' : '' };
  }

  return { TERMS, defaultCloud, settings, captcha, termsUrl, privacyUrl, words, arrival, front, use, signInWays,
    signInTrouble, signInFrom, resume, signUpScreen, forgotScreen, codeScreen, newPasswordScreen, termsGate, needsTerms, isNew,
    welcomed, waits, WORDS };
})();
