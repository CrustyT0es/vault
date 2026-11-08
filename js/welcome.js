/* Vault: the welcome steps after a friend joins with an invite. js/start.js runs them once the friend has chosen their
   own password (its chooseScreen is the first step, or joinCodeScreen for someone who scanned a join QR code and
   picked their password there): their free Gemini key, then Vault on their home screen, then "You're all set". One
   screen each, big buttons, dots for how far along they are, and every step can be skipped: Vault works fully
   without them. Where they've got to is kept in localStorage 'vault-welcome' ({user, step, done}), so closing Vault
   half-way picks up there next time, for that person only.

   The Gemini key: "Open Google AI Studio" opens aistudio.google.com/apikey in a new tab; back in Vault, one tap on
   "Paste my key" reads the clipboard in that very tap (iPhones and Chrome only let a page read it during a tap; an
   iPhone then shows its own little Paste button) and goes through js/ai.js's saveGeminiKey, which asks Google first.
   A box to paste into by hand comes up whenever reading didn't work. Google's own rule is said plainly, in js/ai.js's
   words (V.ai.googleTerms, 1.21): the person making the key is 18 or older, so a parent or guardian can make it with
   them, with Google's terms linked and "I've read Google's terms" ticked before Google's page opens (never an age).

   The home screen: Chrome's own Install where it offers it (V.install), else the steps for this device. An iPhone or
   iPad has no such offer (Safari's Share > Add to Home Screen), and its new icon starts with nothing of Safari's
   (iOS keeps each one's storage apart), so: while this step shows, the address carries #connect= (the cloud and the
   e-mail, never a password), which an icon added from here opens with; and "Copy the sign-in link" puts the same on
   the clipboard for the icon's "Paste my sign-in". Either way the friend signs in there once with their new password.
   Never on the PC app; Vault on its own on a PC (V.pc.standalone) gets the Gemini step only. Settings > Devices
   offers the same link (`markConnect`, `iosIcon`), for an icon added later.

   Inside an app's own browser (V.deviceKind.inApp: an invite tapped in Instagram or Snapchat), js/start.js first
   offers Chrome or Safari; whoever carries on there anyway is told the home screen and Google's sign-in need them.

   The study loop first (1.19; the owner: "really sell this notes magic thing"): right after the password, one screen
   says what Wefty does in three steps (record a class or snap a page, AI writes your notes, AI makes flash cards and
   plans your study until the test), then "What classes are you taking?" (chips for common subjects, or typed) and
   "Any test coming up?" (a class and a day). Each can be skipped ("Skip setup" skips all three). The answers are kept
   in localStorage 'vault-start-plan' ({user, since, classes: [{name, icon}], test: {name, icon, day}}) and sent to the
   account as they're given (settings.extra.start.plan: an iPhone's home screen icon, signed in half-way, has none of
   Safari's storage), and made only after a first sync, by whichever of the person's devices gets there first
   (applyPlan, from js/start.js; start.made says which): the starter folders become Inbox, the classes and Personal
   (starterFolders), and the test is a note "<Class> test" due that day in its class's folder, covering it
   (extra.exam, as js/exams.js's Test button writes it), so Today has a real countdown on day one. The account is
   marked new for every device (settings.extra.start.since, through V.cloud.changeExtra), which js/starthere.js's
   "Start here" card on Today goes by. Nothing here ever blocks: an answer that can't be made is left out.

   New since 1.22 (the guide's "first run"): someone who came through this welcome on 1.22 or later is marked so for
   the account (settings.extra.start.week: { since }, sent with the plan, and in the plan made: `guided`), never the
   owner or anyone from before. For them the device that makes the plan also makes one note in Inbox that explains
   itself, "Start here: how Wefty works" (introBody: a heading, a short checklist to tick, one "question :: answer"
   line and one {{blank}} line that really are flash cards, and where Help is), pinned, with a stable id from the
   account's (introId) and start.intro marked in the same claim as start.made, so it's made once across devices and
   never again once deleted; the old "Welcome to Wefty" note (js/notes.js) isn't made for them. js/starthere.js's
   first-week checklist goes by the same mark. */
'use strict';

V.welcome = (() => {
  const KEY = 'vault-welcome';
  const PLAN = 'vault-start-plan';
  const GEMINI_PAGE = 'https://aistudio.google.com/apikey';
  const NAMES = { password: 'Your password', loop: 'How it works', classes: 'Your classes', test: 'A test', ai: 'Free AI',
    install: 'Home screen' };
  const STUDY_STEPS = ['loop', 'classes', 'test'];
  const MOST_CLASSES = 12;
  const NAME_MOST = 40;
  const TEST_AHEAD = 366;  // days: a test day further off than this is a typo
  // Common classes (a Canadian high school's, and most others'), each with its folder's emoji.
  const SUBJECTS = [['Math', '📐'], ['English', '📖'], ['Science', '🔬'], ['Biology', '🧬'], ['Chemistry', '🧪'],
    ['Physics', '⚛️'], ['History', '🏛️'], ['Geography', '🌍'], ['French', '🗣️'], ['Spanish', '💬'],
    ['Computer Science', '💻'], ['Art', '🎨'], ['Music', '🎵'], ['Gym', '🏃']];
  // A typed class's emoji, from its words (first match), else a plain book.
  const GUESS = [[/\bgym\b|phys(ical)?\.? ?ed|\bp\.?e\.?\b|sport|health|fitness/, '🏃'],
    [/math|algebra|calcul|geometr|function|statist|trig/, '📐'], [/english|literat|writing|reading|poet/, '📖'],
    [/bio|anatom/, '🧬'], [/chem/, '🧪'], [/physic/, '⚛️'], [/scien|earth|environment/, '🔬'],
    [/hist|civic|govern|law|politic/, '🏛️'], [/geo/, '🌍'],
    [/french|spanish|german|italian|latin|chinese|mandarin|japanese|korean|arabic|languag|portug/, '💬'],
    [/comput|coding|program|tech|robot/, '💻'], [/\bart\b|design|draw|paint|photo/, '🎨'],
    [/music|band|choir|orchestra|piano|guitar/, '🎵'], [/econ|business|account|financ|market/, '📈'],
    [/psych|sociol|philos/, '🧠'], [/drama|theat/, '🎭'], [/religio|ethic|world issues/, '🕊️'], [/cook|food|nutrit/, '🍳']];
  let listening = null;  // the install step's ear for V.install ('ready', 'done')
  V.on('install', (what) => { if (listening) listening(what); });

  // A friend's account lives in the cloud of the person who invited them (cloud.js's user.invited): what's kept there
  // (their free AI key too) is in that person's reach, and the AI step says so before anything is saved.
  // (1.21: someone who signed up by themselves is in Wefty's own cloud, someone else's too: V.who 'self')
  const invited = () => !!(V.data.user && (V.data.user.invited || (V.who && V.who() === 'self')));
  // What the owner's Stats show about each friend (js/access.js, vault/stats.py): said on the choose-password screen
  // and, for good, under "Your account" in a friend's Settings (friends who joined before the Stats were made too).
  const STATS_WORDS = 'Their Stats show a few numbers about you: how many notes and files you have, how much space they '
    + 'take, which devices and Wefty versions you use, and when you last used it. Never what\'s in them.';

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (error) { return null; } };
  const write = (value) => {
    try {
      if (value) localStorage.setItem(KEY, JSON.stringify(value));
      else localStorage.removeItem(KEY);
    } catch (error) { /* a private window: the steps just aren't picked up again */ }
  };

  /* This device's steps: always the password, then the study loop (what Wefty does, your classes, a test); the free
     AI key where this page keeps keys itself (a phone, a Chromebook, Vault on its own on a PC: js/ai.js's ownKeys);
     the home screen where Vault isn't installed yet. */
  function steps() {
    const list = ['password', ...STUDY_STEPS];
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
      return { kind: 'in-app', browser, steps: [`Wefty can't go on your home screen from inside this app. Open Wefty in ${browser} to add it.`],
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
        note: 'If your school doesn\'t allow it, keep Wefty as a bookmark instead.' };
    }
    if (kind.android || (V.device === 'phone' && !/Windows|Macintosh/.test(navigator.userAgent))) {
      return { kind: 'android', steps: ['Tap ⋮ at the top right of Chrome.', 'Tap Add to Home screen, then Install.'], note: '' };
    }
    return { kind: 'browser', steps: ['In Chrome: the ⋮ menu > Cast, save and share > Install page as app.',
      'In Edge: the … menu > Apps > Install this site as an app.'], note: '' };
  }

  /* -- the plan: the classes and the test picked here, made once the first sync is in (applyPlan) */

  function readPlan(user) {
    try {
      const plan = JSON.parse(localStorage.getItem(PLAN) || 'null');
      return plan && typeof plan === 'object' && plan.user && (!user || plan.user === user) ? plan : null;
    } catch (error) { return null; }
  }
  function writePlan(plan) {
    try {
      if (plan) localStorage.setItem(PLAN, JSON.stringify(plan));
      else localStorage.removeItem(PLAN);
    } catch (error) { /* a private window: made on this page only, as far as it gets */ }
  }
  function changePlan(user, change) {
    const plan = readPlan(user) || { user, since: new Date().toISOString() };
    const next = change({ ...plan }) || plan;
    writePlan(next);
    return next;
  }
  /* Whether this person came through the welcome and its plan hasn't been made yet, here or in the account (js/starthere.js
     shows "Start here" from the start, before the account's own mark is written). */
  const planned = (user) => !!(user && (readPlan(user) || cloudPlan()));

  /* New since 1.22: came through this welcome on 1.22 or later (the account's start.week, or this device's plan before
     it's sent). The welcome note and js/starthere.js's first week go by it; never the owner or anyone from before. */
  function guided(user = V.data.user && V.data.user.id) {
    if (!user) return false;
    const extra = (V.data && V.data.settings && V.data.settings.extra) || {};
    const start = extra.start && typeof extra.start === 'object' ? extra.start : {};
    if (start.week && typeof start.week === 'object') return true;
    const plan = readPlan(user);
    return !!(plan && plan.guide);
  }

  /* The plan as it's also kept in the account (settings.extra.start.plan), sent as each answer is given: an iPhone's
     home screen icon starts with none of Safari's storage, and a friend who adds it half-way through the welcome and
     signs in there never goes back to the Safari tab. Whichever device syncs first makes it (makePlan). Also marks
     the account new (start.since, and the clipboard's offer: js/clips.js's clip_step) for every device at once. */
  let sending = Promise.resolve();
  function sendPlan(user) {
    const plan = user ? readPlan(user) : null;
    if (!plan || plan.made || !V.cloud || !V.cloud.changeExtra) return sending;
    const classes = Array.isArray(plan.classes) ? plan.classes.map((c) => ({ name: c.name, icon: c.icon || '' })) : [];
    const test = plan.test && plan.test.name && plan.test.day ? { name: plan.test.name, icon: plan.test.icon || '', day: plan.test.day } : null;
    sending = sending.then(() => V.cloud.changeExtra((extra) => {
      const start = extra.start && typeof extra.start === 'object' ? extra.start : {};
      if (start.made) return extra;
      const since = start.since || plan.since || new Date().toISOString();
      // (1.22: new since then, for the welcome note and the first week, js/starthere.js)
      const week = start.week || (plan.guide ? { since } : null);
      return { ...extra, clip_step: extra.clip_step || 'offer',
        start: { ...start, since, plan: { classes, test }, ...(week ? { week } : {}) } };
    })).catch(() => { /* offline or slow: this device still makes it after its first sync */ });
    return sending;
  }
  /* The plan another device of this person's sent (its welcome), while nothing has made it yet: { since, classes,
     test }, or null. Read loosely: only names, emoji and a day. */
  function cloudPlan() {
    const extra = (V.data && V.data.settings && V.data.settings.extra) || {};
    const start = extra.start && typeof extra.start === 'object' ? extra.start : null;
    const plan = start && start.plan && typeof start.plan === 'object' ? start.plan : null;
    if (!plan || start.made) return null;
    const icon = (value) => (typeof value === 'string' ? value.slice(0, 16) : '');
    const classes = (Array.isArray(plan.classes) ? plan.classes : [])
      .filter((c) => c && typeof c.name === 'string' && squash(c.name)).slice(0, MOST_CLASSES)
      .map((c) => ({ name: tidyName(c.name), icon: icon(c.icon) }));
    const t = plan.test;
    const test = t && typeof t.name === 'string' && squash(t.name) && typeof t.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.day)
      ? { name: tidyName(t.name), icon: icon(t.icon), day: t.day } : null;
    return { since: typeof start.since === 'string' ? start.since : '', classes, test };
  }

  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const tidyName = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MOST);
  /* A class's folder emoji: a common subject's own, else a guess from its words, else a book. */
  function emojiFor(name) {
    const known = SUBJECTS.find(([n]) => squash(n) === squash(name));
    if (known) return known[1];
    const words = String(name || '').toLowerCase();
    const found = GUESS.find(([test]) => test.test(words));
    return found ? found[1] : '📘';
  }

  /* The starter folders for a new account (js/notes.js ensureStarterFolders): Inbox, the classes picked and Personal,
     when classes were picked here; else the usual ones (School, Work, Personal, Gaming). */
  function starterFolders(user = V.data.user && V.data.user.id) {
    const plan = user ? readPlan(user) || cloudPlan() : null;
    const classes = plan && Array.isArray(plan.classes) ? plan.classes : [];
    if (!classes.length || plan.made) return V.STARTER_FOLDERS;
    const own = classes.map((c) => [c.name, c.icon || emojiFor(c.name)]);
    const has = (name) => own.some(([n]) => squash(n) === squash(name));
    return [['Inbox', '📥'], ...own.filter(([n]) => squash(n) !== 'inbox'), ...(has('Personal') ? [] : [['Personal', '🏠']])];
  }

  /* A live folder by its name (any depth, a top one first), or one made at the top, after the others. */
  async function folderFor(name, icon) {
    const want = squash(name);
    const found = V.notes.folders().filter((f) => squash(f.name) === want)
      .sort((a, b) => ((V.organise && V.organise.ancestors) ? V.organise.ancestors(a).length - V.organise.ancestors(b).length : 0));
    if (found.length) return found[0];
    const sort = Math.max(-1, ...[...V.data.folders.values()].filter((f) => !f.deleted).map((f) => Number(f.sort) || 0)) + 1;
    return V.cloud.save('folders', { id: V.uuid(), name, icon, sort, deleted: false, extra: {} });
  }

  /* The plan made, once the first sync is in (js/start.js, and a later sync if that one couldn't): the starter folders
     (with the classes), the classes' folders, the test note. This device's own plan, or the one in the account (sent
     from another device's welcome). One device makes it: the first to mark the account's plan made with its own id
     (start.made, which also marks the account new for every device); the same device may finish after a reload
     part-way, as each part looks for what's there first. */
  let applying = null;
  function applyPlan() {
    if (!applying) applying = (async () => { try { await makePlan(); } finally { applying = null; } })();
    return applying;
  }
  async function makePlan() {
    const user = V.data.user && V.data.user.id;
    if (!user) return;
    if (!(V.cloud.status === 'synced' || V.cloud.status === 'held')) return;  // (this device's copy may be old)
    const local = readPlan(user);
    const plan = local || cloudPlan();
    if (!plan) return;
    if (!plan.made) {
      // The account's mark ("Start here" on Today, on every device), kept with any other device's start, and whose
      // plan this is to make.
      const mine = (V.deviceLog && V.deviceLog.installId && V.deviceLog.installId()) || 'this-device';
      const intro = introId(user);
      let start;
      try {
        await sending;
        const extra = await V.cloud.changeExtra((now) => {
          const was = now.start && typeof now.start === 'object' ? now.start : {};
          if (was.made) return now;
          const since = was.since || plan.since || new Date().toISOString();
          // (1.22: new since then: the first week's mark, and the welcome note, claimed with the plan, so one device
          // makes it, once)
          const week = was.week || (plan.guide ? { since } : null);
          return { ...now, start: { ...was, since, made: mine, ...(week ? { week, intro: was.intro || intro } : {}) } };
        });
        start = (extra && extra.start) || {};
      } catch (error) { return; }  // (tried again at the next sync)
      if (start.made !== mine) { if (local) writePlan(null); return; }  // (made on another device of theirs)
      await V.notes.ensureStarterFolders(starterFolders(user));
      for (const one of Array.isArray(plan.classes) ? plan.classes : []) {
        try { await folderFor(one.name, one.icon || emojiFor(one.name)); } catch (error) { console.error(error); }
      }
      const test = plan.test;
      if (test && test.name && /^\d{4}-\d{2}-\d{2}$/.test(test.day || '') && test.day >= V.today()) {
        try { await makeTest(test); } catch (error) { console.error(error); }
      }
      if (start.intro === intro) {
        try { await makeIntro(intro); } catch (error) { console.error('Wefty: the welcome note', error); }
      }
    }
    if (local) writePlan(null);
  }

  /* -- the welcome note (1.22)

     One note that explains itself, in Wefty's own marks: a heading, a checklist to tick, one "question :: answer" line
     and one {{blank}} line that are real flash cards (so a first study round can be done on day one), and where Help
     is. Explanations never use two colons or curly brackets, so only those two lines become cards. */
  const INTRO_TITLE = 'Start here: how Wefty works';
  function introBody() {
    const help = V.help && typeof V.help.open === 'function' ? 'Tap your picture, then Help. It answers questions like "How do I make flash cards?"'
      : 'Tap your picture, then Feedback, and tell us what\'s hard.';
    return [
      'Wefty turns your notes into **flash cards** and a study plan. Try each part of this note, then delete it whenever you like.',
      '',
      '# Try it',
      '- [ ] Tap this box to tick it',
      '- [ ] Make a folder for a class: in Notes, tap New folder',
      '- [ ] Record a class or snap a page of notes: Today, then Quick actions',
      '',
      '# Flash cards from your notes',
      'A line with a question, two colons, then the answer becomes a flash card. So does a word in double curly brackets. These two are real:',
      'What does Wefty make from a line like this? :: A flash card',
      'Wefty plans a little study each day until your {{test}}.',
      'Study them from Today: tap Flash cards.',
      '',
      '# Stuck?',
      help,
    ].join('\n');
  }
  /* The note's id: the same on every device for this account (a UUID made from the account's id), so two devices can
     never both make it. */
  function introId(user) {
    let hex = '';
    for (let seed = 0; seed < 4; seed++) {
      let h = 0x811c9dc5;
      for (const ch of `wefty-intro:${seed}:${user}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
      hex += h.toString(16).padStart(8, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  async function makeIntro(id) {
    if (V.data.notes.has(id)) return;  // (made already, or deleted since: never again)
    const home = V.notes.inbox();
    await V.cloud.save('notes', V.notes.blankNote({ id, folder_id: home ? home.id : null, pinned: true, title: INTRO_TITLE,
      body: introBody(), extra: { starter: 'intro' } }));
  }

  /* "<Class> test" on its day, in its class's folder, covering that folder: the countdown js/exams.js's Test button
     would make. Never a second one for the same class and day. */
  async function makeTest(test) {
    const folder = await folderFor(test.name, test.icon || emojiFor(test.name));
    const title = `${test.name} test`;
    const there = [...V.data.notes.values()].some((n) => !n.deleted && !n._purge && n.due === test.day
      && squash(n.title) === squash(title));
    if (there) return;
    await V.cloud.save('notes', V.notes.blankNote({ folder_id: folder.id, title, due: test.day,
      // (`starter`: made by Wefty, not written: the first week and js/homescreen.js don't count it as a note written)
      extra: { exam: { covers: [folder.id], since: V.today(), for: test.day }, starter: 'test' } }));
  }
  V.on('status', (value) => { if ((value === 'synced' || value === 'held') && planned(V.data.user && V.data.user.id)) applyPlan().catch(() => {}); });

  /* -- the steps */

  /* The study loop's three steps, as the welcome and Today's "Start here" (js/starthere.js) draw them. */
  const RECORD_ICON = '<path d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V20.5M9 20.5h6"/>';
  function loopIcon(name) {
    if (name !== 'record') return V.icon(name);
    const span = V.icon('');
    span.firstChild.innerHTML = RECORD_ICON;  // (a fixed string)
    return span;
  }
  function loopSteps() {
    const listens = V.desktop ? 'Wefty listens to a class' : 'Your phone listens in class';
    return [
      { icon: 'record', title: 'Record a class or snap a page', line: `${listens}, or takes a photo of your notes.` },
      { icon: 'spark', title: 'AI writes your notes', line: 'A clear summary, the key points and the words to know.' },
      { icon: 'cards', title: 'Flash cards and a study plan', line: 'AI makes the cards, and Wefty plans a little each day until your test.' },
    ];
  }

  function loopStep(screen) {
    return new Promise((resolve) => {
      screen(dots('loop'), V.h('h1', { text: 'Study smarter with Wefty' }),
        V.h('p.muted', { text: 'Three steps, and the AI does most of the work.' }),
        V.h('ol.welcome-loop', {}, loopSteps().map((step) => V.h('li', {},
          V.h('span.loop-ic', {}, loopIcon(step.icon)),
          V.h('span.loop-text', {}, V.h('strong', { text: step.title }), V.h('span', { text: step.line }))))),
        V.button('Set it up', { kind: 'primary wide-btn', onClick: () => resolve('seen') }),
        V.h('p.hint.welcome-setup-hint', { text: 'Two quick questions: your classes, and your next test.' }),
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Skip setup', onclick: () => resolve('skip-study') }));
    });
  }

  /* The chips drawn again (`fill` puts them in `box`), the keyboard kept on the chip it was on (the same class's):
     a pick by keyboard or a screen reader never drops the focus to the page. */
  function keepingFocus(box, fill) {
    const on = box.contains(document.activeElement) ? document.activeElement.dataset.name : null;
    fill();
    if (on === null || on === undefined) return;
    const back = [...box.querySelectorAll('.subject-chip')].find((chip) => chip.dataset.name === on);
    if (back) back.focus({ preventScroll: true });
  }

  /* A class's chip: its emoji and name, pressed or not (`radio`: one of a group, for the test's class). */
  function subjectChip(name, icon, on, onClick, radio = false) {
    return V.h('button.chip.subject-chip' + (on ? '.on' : ''), { type: 'button', role: radio ? 'radio' : null,
      'aria-pressed': radio ? null : String(on), 'aria-checked': radio ? String(on) : null, onclick: onClick,
      dataset: { name } }, V.h('span.emo', { text: icon, 'aria-hidden': 'true' }), V.h('span', { text: name }));
  }

  function classesStep(screen, user) {
    return new Promise((resolve) => {
      const kept = readPlan(user) || {};
      const picked = new Map((Array.isArray(kept.classes) ? kept.classes : []).map((c) => [squash(c.name), c]));
      const own = [...picked.values()].filter((c) => !SUBJECTS.some(([n]) => squash(n) === squash(c.name)));
      const problem = V.h('p.error-text', { role: 'alert' });
      const chips = V.h('div.welcome-subjects', { role: 'group', 'aria-label': 'Your classes' });
      const box = V.h('input.field', { type: 'text', placeholder: 'Another class', autocomplete: 'off', maxlength: String(NAME_MOST),
        'aria-label': 'Another class', enterkeyhint: 'done' });
      const go = V.button('Next', { kind: 'primary wide-btn', onClick: () => finish() });
      const draw = () => {
        keepingFocus(chips, () => V.clear(chips, [...SUBJECTS.map(([name, icon]) => ({ name, icon })), ...own].map(({ name, icon }) =>
          subjectChip(name, icon, picked.has(squash(name)), () => toggle(name, icon)))));
        go.lastChild.textContent = picked.size ? `Make ${picked.size} folder${picked.size === 1 ? '' : 's'}` : 'Next';
      };
      const toggle = (name, icon) => {
        problem.textContent = '';
        const key = squash(name);
        if (picked.has(key)) picked.delete(key);
        else if (picked.size >= MOST_CLASSES) { problem.textContent = `That's ${MOST_CLASSES} already: add more folders later in Notes.`; return; }
        else picked.set(key, { name, icon });
        draw();
      };
      const add = () => {
        const name = tidyName(box.value);
        if (!name) return;
        if (!squash(name)) { problem.textContent = 'Type the class\'s name with some letters in it.'; return; }
        const key = squash(name);
        const common = SUBJECTS.find(([n]) => squash(n) === key);
        if (!common && !own.some((c) => squash(c.name) === key)) own.push({ name, icon: emojiFor(name) });
        box.value = '';
        if (!picked.has(key)) toggle(common ? common[0] : name, common ? common[1] : emojiFor(name));
        else draw();
        box.focus();
      };
      const finish = () => {
        if (tidyName(box.value)) add();
        // (in the chips' order: the common classes, then the typed ones)
        const order = [...SUBJECTS.map(([name]) => squash(name)), ...own.map((c) => squash(c.name))];
        const classes = [...picked.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
          .map(([, c]) => ({ name: c.name, icon: c.icon }));
        changePlan(user, (p) => ({ ...p, classes }));
        resolve(classes.length ? 'picked' : 'skipped');
      };
      box.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
      draw();
      screen(dots('classes'), V.h('h1', { text: 'What classes are you taking?' }),
        V.h('p.muted', { text: 'Pick yours, and Wefty makes a folder for each, so your notes and flash cards stay sorted.' }),
        chips,
        V.h('div.welcome-own', {}, box, V.button('Add', { onClick: add, icon: 'plus' })),
        problem, go,
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'Skip', onclick: () => {
          changePlan(user, (p) => ({ ...p, classes: [] }));
          resolve('skipped');
        } }));
    });
  }

  function testStep(screen, user) {
    return new Promise((resolve) => {
      const plan = readPlan(user) || {};
      const classes = Array.isArray(plan.classes) && plan.classes.length ? plan.classes
        : SUBJECTS.slice(0, 8).map(([name, icon]) => ({ name, icon }));
      let chosen = plan.test && plan.test.name ? plan.test.name : '';
      const problem = V.h('p.error-text', { role: 'alert' });
      const chips = V.h('div.welcome-subjects', { role: 'radiogroup', 'aria-label': 'Which class' });
      const other = V.h('input.field', { type: 'text', placeholder: 'Another class', autocomplete: 'off', maxlength: String(NAME_MOST),
        'aria-label': 'Another class', value: chosen && !classes.some((c) => squash(c.name) === squash(chosen)) ? chosen : '' });
      const today = V.today();
      const day = V.h('input.field.welcome-day', { type: 'date', min: today, max: V.addDays(today, TEST_AHEAD),
        value: plan.test && plan.test.day >= today ? plan.test.day : '', 'aria-label': 'Test day' });
      const draw = () => keepingFocus(chips, () => V.clear(chips, classes.map((c) => subjectChip(c.name, c.icon || emojiFor(c.name),
        !other.value.trim() && squash(chosen) === squash(c.name), () => { chosen = c.name; other.value = ''; problem.textContent = ''; draw(); }, true))));
      other.addEventListener('input', () => { chosen = tidyName(other.value); draw(); });
      const add = () => {
        problem.textContent = '';
        const name = tidyName(other.value) || chosen;
        if (!name || !squash(name)) { problem.textContent = 'Pick the class the test is in.'; return; }
        if (!day.value) { problem.textContent = 'Pick the day of the test.'; return; }
        if (day.value < V.today()) { problem.textContent = 'That day has passed. Pick the day of your next test.'; return; }
        if (day.value > V.addDays(V.today(), TEST_AHEAD)) { problem.textContent = 'That\'s more than a year away. Check the day.'; return; }
        const known = classes.find((c) => squash(c.name) === squash(name));
        const test = { name: known ? known.name : name, icon: known ? known.icon || emojiFor(known.name) : emojiFor(name), day: day.value };
        changePlan(user, (p) => ({ ...p, test }));
        resolve('added');
      };
      day.addEventListener('keydown', (event) => { if (event.key === 'Enter') add(); });
      draw();
      screen(dots('test'), V.h('h1', { text: 'Any test coming up?' }),
        V.h('p.muted', { text: 'Wefty counts down to it and plans a little flash card study each day until then.' }),
        V.h('div.label', { text: 'Which class?' }), chips, other,
        V.h('label.label', { text: 'When is it?' }, day),
        problem,
        V.button('Add the test', { kind: 'primary wide-btn', icon: 'target', onClick: add }),
        V.h('button.link-btn.welcome-skip', { type: 'button', text: 'No test coming up', onclick: () => {
          changePlan(user, (p) => ({ ...p, test: null }));
          resolve('skipped');
        } }));
    });
  }

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
          V.toast(saved.checked ? (invited() ? `Your free AI key works. It's ${V.ai.kept()}.`
            : 'Your free AI key works. It\'s kept in your own cloud, never shown.')
            : 'Key saved. Google couldn\'t check it just now, so Wefty checks it the first time it\'s used.', { ms: 8000 });
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
          problem.textContent = 'Wefty couldn\'t read what you copied. Paste the key in the box instead (press and hold, then Paste).';
          box.focus();
        });
      } });
      const saveTyped = V.button('Save my key', { kind: 'primary', onClick: () => save(box.value) });
      const manual = V.h('div.welcome-manual', { hidden: true }, box, saveTyped);
      const buttons = [paste, saveTyped];
      box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(box.value); });
      const studio = V.button('Open Google AI Studio', { kind: 'wide-btn', icon: 'open', onClick: () => {
        if (V.desktop && V.pc) V.pc.call('openLink', { url: GEMINI_PAGE }).catch(V.problem);
        else window.open(GEMINI_PAGE, '_blank', 'noopener');
      } });
      // (Google's age rule, its terms and the tick before its page opens: js/ai.js's, the same as Settings > AI's)
      const terms = V.ai && V.ai.googleTerms ? V.ai.googleTerms(studio) : null;
      if (terms) terms.classList.add('welcome-terms');
      screen(dots('ai'), V.h('h1', { text: 'Free AI for your notes' }),
        V.h('p.muted', { text: 'Wefty\'s AI writes your notes and makes your flash cards (and chats with you), using Google\'s '
          + 'Gemini. It\'s free with your own key, and getting one takes about a minute.' }),
        terms,
        V.h('ol.steps', {},
          V.h('li', { text: 'Tick I\'ve read Google\'s terms, tap Open Google AI Studio and sign in with your own Google account (not your school one).' }),
          V.h('li', { text: 'Tap Create API key (any name is fine), then Copy.' }),
          V.h('li', { text: 'Come back here and tap Paste my key.' })),
        studio,
        paste, manual, status, problem,
        // (School Google accounts: their school usually switches Google AI Studio off for them, so the key is made with the
        // person's own account, on their own phone or computer: never a way round the school's settings for its accounts.)
        V.h('p.welcome-age.welcome-school', {}, V.icon('alert'), V.h('span', { text: 'School Google accounts usually can\'t '
          + 'make keys: schools switch this off for them. Use your own personal Google account instead. On a school Chromebook, '
          + 'it\'s easiest to make the key on your phone: once it\'s saved, Wefty uses it on all your devices.' })),
        V.deviceKind.inApp ? V.h('p.welcome-age.welcome-in-app', {}, V.icon('alert'), V.h('span', { text: 'Google won\'t let you '
          + `sign in inside Instagram, Snapchat and other apps' own browsers. Open Wefty in ${V.deviceKind.ios ? 'Safari' : 'Chrome'} `
          + 'for this step, or skip it for now.' })) : null,
        invited() ? V.h('p.welcome-kept', {}, V.icon('lock'), V.h('span', { text: V.who && V.who() === 'self'
          ? 'Your key is stored in Wefty\'s cloud. Whoever runs it could read it. You can delete it any time in Settings > AI, '
            + 'or remove the key in Google AI Studio.'
          : 'Your key is stored in the cloud of the person who invited you. They could read it. You can delete it any time in '
            + 'Settings > AI, or remove the key in Google AI Studio.' })) : null,
        V.h('p.hint', { text: 'Wefty works fully without it: notes, files, sending and everything else. You can add a key any time in Settings > AI.' }),
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
        if (V.homeScreen && V.homeScreen.asked) V.homeScreen.asked(result);
        resolve(result);
      };
      const computer = how.kind === 'chromebook' || how.kind === 'browser';
      const inApp = how.kind === 'in-app';
      // (the home screen popup, js/homescreen.js, doesn't ask again the same day)
      if (V.homeScreen && V.homeScreen.asked) V.homeScreen.asked();
      function draw() {
        const offer = !inApp && V.install.ready() ? V.button(computer ? 'Install Wefty' : 'Add to home screen', {
          kind: 'primary wide-btn', icon: 'download',
          onClick: async () => { if ((await V.install.ask()) === 'accepted') finish('installed'); else draw(); } }) : null;
        const email = user.email || (V.config && V.config.email) || 'your e-mail';
        screen(dots('install'), V.h('h1', { text: computer ? 'Install Wefty as an app' : 'Add Wefty to your home screen' }),
          V.h('p.muted', { text: computer ? 'Then it opens like an app, in its own window, even with no internet.'
            : 'Then it opens like an app, full screen, even with no internet.' }),
          offer,
          offer ? null : V.h('ol.steps.welcome-how', { dataset: { kind: how.kind } }, how.steps.map((step) => V.h('li', { text: step }))),
          how.note && !offer ? V.h('p.hint', { text: how.note }) : null,
          how.kind === 'ios' ? iosIcon(email, 'the password you just picked') : null,
          inApp ? V.h('div.welcome-ios', {},
            V.h('p', { text: `Tap Copy the sign-in link, open ${how.browser}, paste it into the address bar and go. Then sign in `
              + `once with ${email} and the password you just picked, and add Wefty to the home screen from there.` }),
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

  function doneStep(screen, results, name, user) {
    return new Promise((resolve) => {
      const first = String(name || '').trim().split(/\s+/)[0];
      const has = steps();
      const plan = readPlan(user) || {};
      const line = (ok, text) => V.h('li', { dataset: { ok: ok ? 'yes' : 'no' } }, V.icon(ok ? 'check' : 'clock'), V.h('span', { text }));
      const classes = Array.isArray(plan.classes) ? plan.classes.map((c) => c.name) : [];
      const test = plan.test && plan.test.name && plan.test.day ? plan.test : null;
      screen(dots('done'), V.h('h1', { text: first ? `You're all set, ${first}!` : 'You\'re all set!' }),
        V.h('ul.welcome-summary', {},
          line(true, 'Your own password'),
          classes.length ? line(true, `Folders for ${listed(classes)}`) : null,
          test ? line(true, `Your ${test.name} test: ${dayWords(test.day)}`) : null,
          has.includes('ai') ? line(results.ai === 'saved', results.ai === 'saved' ? 'Free AI is ready'
            : 'Free AI: add a key any time in Settings > AI') : null,
          has.includes('install') ? installLine(line, results.install) : null),
        V.deviceKind.ios && ['installed', 'added'].includes(results.install)
          ? V.h('p.muted', { text: 'From now on, open Wefty from its icon (sign in there once).' }) : null,
        V.h('p.hint.welcome-next', { text: 'Today shows what to do first.' }),
        V.button('Open Wefty', { kind: 'primary wide-btn', onClick: () => resolve() }));
    });
  }

  /* "Math, Biology and English", or "Math, Biology, English and 3 more". */
  function listed(names) {
    const shown = names.length > 4 ? names.slice(0, 3) : names;
    const rest = names.length - shown.length;
    if (rest) return `${shown.join(', ')} and ${rest} more`;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] || '';
  }
  /* "Thursday, Nov 5" */
  const dayWords = (day) => V.parseDate(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  /* The home screen's line in "You're all set": "on your home screen" only when that's known (Chrome's own Install
     said so, or this is the icon); a tapped "I've added it" can't be checked from here. */
  function installLine(line, result) {
    if (result === 'installed' || V.install.installed()) return line(true, 'Wefty is on your home screen');
    if (result === 'added') return line(true, 'Home screen: added? Open Wefty from its icon');
    return line(false, 'Home screen: Settings shows how, any time');
  }

  /* -- an iPhone's home screen icon (here and in Settings > Devices)

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
  function iosIcon(email, password = 'your Wefty password') {
    return V.h('div.welcome-ios', {},
      V.h('p', { text: `The new icon is Wefty on its own: open it and sign in there once, with ${email} and ${password}. If it asks `
        + 'to connect, copy the link here, then tap Paste my sign-in there.' }),
      V.button('Copy the sign-in link', { icon: 'copy', onClick: async () => {
        await V.copy(V.connectLink());
        V.toast('Copied. If the icon asks to connect, tap Paste my sign-in.', { ms: 6000 });
      } }));
  }

  /* -- where they've got to */

  /* Just chose their password (js/start.js): the rest of the steps are to come, and this person is new (the plan,
     with the time they joined, until applyPlan has marked the account). Its extras start off too (1.19: the shared
     clipboard is offered in Share > Clipboard, never switched on by itself: js/clips.js). */
  function remember(user) {
    try { if (V.clips && V.clips.markNew) V.clips.markNew(user); } catch (error) { console.warn('Wefty:', error); }
    const list = steps();
    if (!user) return;
    if (list.length > 1) write({ user, step: list[1], done: {} });
    changePlan(user, (p) => ({ ...p, guide: 1 }));  // (1.22: new since then: the welcome note and the first week)
    sendPlan(user);
  }

  const pending = (user) => { const kept = read(); return !!(user && kept && kept.user === user); };

  /* The steps left, one screen at a time (`screen` is js/start.js's: the gate's box with the wordmark). */
  async function run({ screen, user = V.data.user || {}, name = '' }) {
    if (document.readyState === 'loading') {  // (js/ai.js comes after this file)
      await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
    }
    const kept = read();
    if (!kept || kept.user !== user.id) return;
    if (!readPlan(user.id)) changePlan(user.id, (p) => p);  // (half-way through a welcome from before 1.19: new too)
    const list = steps();
    const results = { ...(kept.done || {}) };
    // (A step this device doesn't have, like the home screen in Vault already installed: on to "all set".)
    const at = list.indexOf(kept.step);
    const from = at >= 1 ? at : at === 0 ? 1 : list.length;
    for (const step of list.slice(from)) {
      if (results[step] === 'skipped') continue;  // ("Skip setup": the study steps after it too)
      write({ user: user.id, step, done: results });
      results[step] = step === 'loop' ? await loopStep(screen)
        : step === 'classes' ? await classesStep(screen, user.id)
          : step === 'test' ? await testStep(screen, user.id)
            : step === 'ai' ? await aiStep(screen) : await installStep(screen, user);
      if (results[step] === 'skip-study') {
        for (const one of STUDY_STEPS) if (!results[one]) results[one] = 'skipped';
        results[step] = 'skipped';
      }
      if (STUDY_STEPS.includes(step)) sendPlan(user.id);  // (the account has each answer as it's given)
    }
    write({ user: user.id, step: 'done', done: results });
    await doneStep(screen, results, name || user.name || '', user.id);
    write(null);
  }

  return { steps, dots, howToInstall, remember, pending, run, markConnect, iosIcon, GEMINI_PAGE, STATS_WORDS,
    applyPlan, starterFolders, planned, readPlan, emojiFor, loopSteps, loopIcon, SUBJECTS,
    guided, introId, introBody, INTRO_TITLE };
})();
