/* Vault: the welcome steps after a friend joins with an invite. js/start.js runs them once the friend has chosen their
   own password (its chooseScreen is the first step, or joinCodeScreen for someone who scanned a join QR code and
   picked their password there): their free Gemini key, then Vault on their home screen, then "You're all set". One
   screen each, big buttons, dots for how far along they are, and every step can be skipped: Vault works fully
   without them. Where they've got to is kept in localStorage 'vault-welcome' ({user, step, done}), so closing Vault
   half-way picks up there next time, for that person only.

   The Gemini key: "Open Google AI Studio" opens aistudio.google.com/apikey in a new tab; back in Vault, one tap on
   "Paste my key" reads the clipboard in that very tap (iPhones and Chrome only let a page read it during a tap; an
   iPhone then shows its own little Paste button) and goes through js/ai.js's saveGeminiKey, which asks Google first.
   A box to paste into by hand comes up whenever reading didn't work. Google's own rule is said plainly: 18 or older.

   The home screen: Chrome's own Install where it offers it (V.install), else the steps for this device. An iPhone or
   iPad has no such offer (Safari's Share > Add to Home Screen), and its new icon starts with nothing of Safari's
   (iOS keeps each one's storage apart), so: while this step shows, the address carries #connect= (the cloud and the
   e-mail, never a password), which an icon added from here opens with; and "Copy the sign-in link" puts the same on
   the clipboard for the icon's "Paste the link". Either way the friend signs in there once with their new password.
   Never on the PC app; Vault on its own on a PC (V.pc.standalone) gets the Gemini step only. Settings > This iPhone
   offers the same link (`markConnect`, `iosIcon`), for an icon added later.

   Inside an app's own browser (V.deviceKind.inApp: an invite tapped in Instagram or Snapchat), js/start.js first
   offers Chrome or Safari; whoever carries on there anyway is told the home screen and Google's sign-in need them. */
'use strict';

V.welcome = (() => {
  const KEY = 'vault-welcome';
  const GEMINI_PAGE = 'https://aistudio.google.com/apikey';
  const NAMES = { password: 'Your password', ai: 'Free AI', install: 'Home screen' };
  let listening = null;  // the install step's ear for V.install ('ready', 'done')
  V.on('install', (what) => { if (listening) listening(what); });

  // A friend's account lives in the cloud of the person who invited them (cloud.js's user.invited): what's kept there
  // (their free AI key too) is in that person's reach, and the AI step says so before anything is saved.
  const invited = () => !!(V.data.user && V.data.user.invited);
  // What the owner's Stats show about each friend (js/access.js, vault/stats.py): said on the choose-password screen
  // and, for good, under "Your account" in a friend's Settings (friends who joined before the Stats were made too).
  const STATS_WORDS = 'Their Stats show a few numbers about you: how many notes and files you have, how much space they '
    + 'take, which devices and Vault versions you use, and when you last used it. Never what\'s in them.';

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (error) { return null; } };
  const write = (value) => {
    try {
      if (value) localStorage.setItem(KEY, JSON.stringify(value));
      else localStorage.removeItem(KEY);
    } catch (error) { /* a private window: the steps just aren't picked up again */ }
  };

  /* This device's steps: always the password; the free AI key where this page keeps keys itself (a phone, a
     Chromebook, Vault on its own on a PC: js/ai.js's ownKeys); the home screen where Vault isn't installed yet. */
  function steps() {
    const list = ['password'];
    if (!V.desktop || (V.pc && V.pc.standalone && V.pc.standalone())) list.push('ai');
    if (!V.desktop && !V.install.installed()) list.push('install');
    return list;
  }

  /* One dot a step: the ones done, the one now, the ones to come. Nothing when there's only the one step. */
  function dots(at) {
    const list = steps();
    if (list.length < 2) return null;
    const index = at === 'done' ? list.length : Math.max(0, list.indexOf(at));
    return V.h('div.welcome-dots', { role: 'img', 'aria-label': at === 'done' ? 'All steps done'
      : `Step ${index + 1} of ${list.length}: ${NAMES[list[index]]}` },
    list.map((step, i) => V.h('span', { title: NAMES[step], dataset: { state: i < index ? 'done' : i === index ? 'now' : 'next' } })));
  }

  /* How to put Vault on this device's home screen (Settings shows it too). */
  function howToInstall() {
    const kind = V.deviceKind;
    if (kind.inApp) {
      const browser = kind.ios ? 'Safari' : 'Chrome';
      return { kind: 'in-app', browser, steps: [`Vault can't go on your home screen from inside this app. Open Vault in ${browser} to add it.`],
        note: '' };
    }
    if (kind.ios) {
      if (kind.iosBrowser && kind.iosBrowser !== 'safari') {
        return { kind: 'ios', steps: ['Tap the Share button (a square with an arrow up) in the address bar.',
          'Tap Add to Home Screen, then Add.'], note: 'Not there? Open this page in Safari and add it from there.' };
      }
      const where = kind.ipad ? 'at the top, next to the address' : 'at the bottom of the screen';
      return { kind: 'ios', steps: [`Tap the Share button (a square with an arrow up) ${where}. Don't see it? Tap ••• first.`,
        'Scroll down and tap Add to Home Screen.', 'Keep "Open as Web App" on, then tap Add.'], note: '' };
    }
    if (kind.chromebook) {  // (before Android's: a Chromebook set to "It's my phone" has no Add to Home screen)
      return { kind: 'chromebook', steps: ['Click ⋮ at the top right of Chrome.', 'Choose Cast, save and share > Install page as app.'],
        note: 'If your school doesn\'t allow it, keep Vault as a bookmark instead.' };
    }
    if (kind.android || (V.device === 'phone' && !/Windows|Macintosh/.test(navigator.userAgent))) {
      return { kind: 'android', steps: ['Tap ⋮ at the top right of Chrome.', 'Tap Add to Home screen, then Install.'], note: '' };
    }
    return { kind: 'browser', steps: ['In Chrome: the ⋮ menu > Cast, save and share > Install page as app.',
      'In Edge: the … menu > Apps > Install this site as an app.'], note: '' };
  }

  /* -- the steps */

  function aiStep(screen) {
    return new Promise((resolve) => {
      const problem = V.h('p.error-text', { role: 'alert' });
      const status = V.h('p.welcome-status', { role: 'status' });
      const box = V.h('input.field', { type: 'password', placeholder: 'Paste your key here', autocomplete: 'off',
        spellcheck: 'false', 'aria-label': 'Your Gemini key' });
      let busy = false;
      async function save(text) {
        if (busy) return;
        busy = true;
        problem.textContent = '';
        status.textContent = 'Checking your key with Google…';
        for (const button of buttons) button.disabled = true;
        try {
          const saved = await V.ai.saveGeminiKey(text);
          V.toast(saved.checked ? (invited() ? 'Your free AI key works. It\'s kept in your private storage in the Vault cloud '
            + 'of the person who invited you (they could read it), and it\'s never shown here.'
            : 'Your free AI key works. It\'s kept in your own cloud, never shown.')
            : 'Key saved. Google couldn\'t check it just now, so Vault checks it the first time it\'s used.', { ms: 8000 });
          resolve('saved');
        } catch (error) {
          status.textContent = '';
          problem.textContent = error.message || String(error);
          manual.hidden = false;
        } finally {
          busy = false;
          for (const button of buttons) button.disabled = false;
        }
      }
      const paste = V.button('Paste my key', { kind: 'primary wide-btn', icon: 'clip', onClick: () => {
        if (busy) return;
        // Read in this very tap (before anything is waited for): only a tap lets a page read the clipboard.
        let reading;
        try { reading = navigator.clipboard.readText(); } catch (error) { reading = Promise.reject(error); }
        Promise.resolve(reading).then((text) => {
          if (String(text || '').trim()) { save(text); return; }
          manual.hidden = false;
          problem.textContent = 'Nothing is copied yet. In AI Studio, tap Copy next to your key, then come back and tap Paste my key.';
        }, () => {
          manual.hidden = false;
          problem.textContent = 'Vault couldn\'t read what you copied. Paste the key in the box instead (press and hold, then Paste).';
          box.focus();
        });
      } });
      const saveTyped = V.button('Save my key', { kind: 'primary', onClick: () => save(box.value) });
      const manual = V.h('div.welcome-manual', { hidden: true }, box, saveTyped);
      const buttons = [paste, saveTyped];
      box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(box.value); });
      screen(dots('ai'), V.h('h1', { text: 'Free AI for your notes' }),
        V.h('p.muted', { text: 'Vault can turn what you hear in class into notes, and chat with you, using Google\'s Gemini. '
          + 'It\'s free with your own key, and getting one takes about a minute.' }),
        V.h('ol.steps', {},
          V.h('li', { text: 'Tap Open Google AI Studio and sign in with your Google account.' }),
          V.h('li', { text: 'Tap Create API key (any name is fine), then Copy.' }),
          V.h('li', { text: 'Come back here and tap Paste my key.' })),
        V.button('Open Google AI Studio', { kind: 'wide-btn', icon: 'open', onClick: () => window.open(GEMINI_PAGE, '_blank', 'noopener') }),
        paste, manual, status, problem,
        V.h('p.welcome-age', {}, V.icon('alert'), V.h('span', { text: 'Google says you must be 18 or older to use the Gemini API.' })),
        V.deviceKind.inApp ? V.h('p.welcome-age.welcome-in-app', {}, V.icon('alert'), V.h('span', { text: 'Google won\'t let you '
          + `sign in inside Instagram, Snapchat and other apps' own browsers. Open Vault in ${V.deviceKind.ios ? 'Safari' : 'Chrome'} `
          + 'for this step, or skip it for now.' })) : null,
        invited() ? V.h('p.welcome-kept', {}, V.icon('lock'), V.h('span', { text: 'Your key is stored in the cloud of '
          + 'the person who invited you. They could read it. You can delete it any time in Settings > AI, or remove the key in '
          + 'Google AI Studio.' })) : null,
        V.h('p.hint', { text: 'Vault works fully without it: notes, files, sending and everything else. You can add a key any time in Settings > AI.' }),
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Skip for now', onclick: () => { if (!busy) resolve('skipped'); } }));
    });
  }

  function installStep(screen, user) {
    return new Promise((resolve) => {
      const how = howToInstall();
      const unmark = how.kind === 'ios' ? markConnect() : () => {};
      const finish = (result) => {
        listening = null;
        unmark();
        resolve(result);
      };
      const computer = how.kind === 'chromebook' || how.kind === 'browser';
      const inApp = how.kind === 'in-app';
      function draw() {
        const offer = !inApp && V.install.ready() ? V.button(computer ? 'Install Vault' : 'Add to home screen', {
          kind: 'primary wide-btn', icon: 'download',
          onClick: async () => { if ((await V.install.ask()) === 'accepted') finish('installed'); else draw(); } }) : null;
        const email = user.email || (V.config && V.config.email) || 'your e-mail';
        screen(dots('install'), V.h('h1', { text: computer ? 'Install Vault as an app' : 'Add Vault to your home screen' }),
          V.h('p.muted', { text: computer ? 'Then it opens like an app, in its own window, even with no internet.'
            : 'Then it opens like an app, full screen, even with no internet.' }),
          offer,
          offer ? null : V.h('ol.steps.welcome-how', { dataset: { kind: how.kind } }, how.steps.map((step) => V.h('li', { text: step }))),
          how.note && !offer ? V.h('p.hint', { text: how.note }) : null,
          how.kind === 'ios' ? iosIcon(email, 'the password you just picked') : null,
          inApp ? V.h('div.welcome-ios', {},
            V.h('p', { text: `Tap Copy the sign-in link, open ${how.browser}, paste it into the address bar and go. Then sign in `
              + `once with ${email} and the password you just picked, and add Vault to the home screen from there.` }),
            V.button('Copy the sign-in link', { icon: 'copy', onClick: async () => {
              await V.copy(V.connectLink());
              V.toast(`Copied. Now open ${how.browser} and paste it into the address bar.`, { ms: 6000 });
            } })) : null,
          // (Self-reported: only Chrome's own Install, or the page running from the icon, counts as installed.)
          offer || inApp ? null : V.button('I\'ve added it', { kind: 'primary wide-btn', onClick: () => finish('added') }),
          V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Later', onclick: () => finish('later') }));
      }
      listening = (what) => { if (what === 'done') finish('installed'); else draw(); };
      draw();
    });
  }

  function doneStep(screen, results, name) {
    return new Promise((resolve) => {
      const first = String(name || '').trim().split(/\s+/)[0];
      const has = steps();
      const line = (ok, text) => V.h('li', { dataset: { ok: ok ? 'yes' : 'no' } }, V.icon(ok ? 'check' : 'clock'), V.h('span', { text }));
      screen(dots('done'), V.h('h1', { text: first ? `You're all set, ${first}!` : 'You\'re all set!' }),
        V.h('ul.welcome-summary', {},
          line(true, 'Your own password'),
          has.includes('ai') ? line(results.ai === 'saved', results.ai === 'saved' ? 'Free AI is ready'
            : 'Free AI: add a key any time in Settings > AI') : null,
          has.includes('install') ? installLine(line, results.install) : null),
        V.deviceKind.ios && ['installed', 'added'].includes(results.install)
          ? V.h('p.muted', { text: 'From now on, open Vault from its icon (sign in there once).' }) : null,
        V.button('Open Vault', { kind: 'primary wide-btn', onClick: () => resolve() }));
    });
  }

  /* The home screen's line in "You're all set": "on your home screen" only when that's known (Chrome's own Install
     said so, or this is the icon); a tapped "I've added it" can't be checked from here. */
  function installLine(line, result) {
    if (result === 'installed' || V.install.installed()) return line(true, 'Vault is on your home screen');
    if (result === 'added') return line(true, 'Home screen: added? Open Vault from its icon');
    return line(false, 'Home screen: Settings shows how, any time');
  }

  /* -- an iPhone's home screen icon (here and in Settings > This iPhone)

     The address carries #connect= (the cloud and the e-mail, never a password) while the steps show, so an icon added
     from Safari's Share > Add to Home Screen opens with it. Returns the way to take it out again. */
  function markConnect() {
    if (!(V.config && V.config.url && V.connectLink)) return () => {};
    try {
      history.replaceState(history.state, '', location.pathname + location.search + '#' + V.connectLink().split('#')[1]);
    } catch (error) {
      return () => {};  // (the copy button still works)
    }
    return () => {
      if (/^#connect=/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
    };
  }

  /* The icon starts with nothing of Safari's: what to do there, and the link to paste into it. */
  function iosIcon(email, password = 'your Vault password') {
    return V.h('div.welcome-ios', {},
      V.h('p', { text: `The new icon is Vault on its own: open it and sign in there once, with ${email} and ${password}. If it asks `
        + 'to connect, copy the link here, then tap Paste the link there.' }),
      V.button('Copy the sign-in link', { icon: 'copy', onClick: async () => {
        await V.copy(V.connectLink());
        V.toast('Copied. If the icon asks to connect, tap Paste the link.', { ms: 6000 });
      } }));
  }

  /* -- where they've got to */

  /* Just chose their password (js/start.js): the rest of the steps are to come. */
  function remember(user) {
    const list = steps();
    if (user && list.length > 1) write({ user, step: list[1], done: {} });
  }

  const pending = (user) => { const kept = read(); return !!(user && kept && kept.user === user); };

  /* The steps left, one screen at a time (`screen` is js/start.js's: the gate's box with the wordmark). */
  async function run({ screen, user = V.data.user || {}, name = '' }) {
    if (document.readyState === 'loading') {  // (js/ai.js comes after this file)
      await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
    }
    const kept = read();
    if (!kept || kept.user !== user.id) return;
    const list = steps();
    const results = { ...(kept.done || {}) };
    // (A step this device doesn't have, like the home screen in Vault already installed: on to "all set".)
    const at = list.indexOf(kept.step);
    const from = at >= 1 ? at : at === 0 ? 1 : list.length;
    for (const step of list.slice(from)) {
      write({ user: user.id, step, done: results });
      results[step] = step === 'ai' ? await aiStep(screen) : await installStep(screen, user);
    }
    write({ user: user.id, step: 'done', done: results });
    await doneStep(screen, results, name || user.name || '');
    write(null);
  }

  return { steps, dots, howToInstall, remember, pending, run, markConnect, iosIcon, GEMINI_PAGE, STATS_WORDS };
})();
