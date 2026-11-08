/* Wefty: Settings' frame (1.16, package D1). The home: "Search settings" and one line per category, each saying how
   it's set (js/settings.js's summaries), with an amber dot when something needs you now. On a phone a line opens
   its page, a step of its own (its back arrow, Android's Back and an iPhone's swipe go back to the home); from 900 px
   the categories stay in a column on the left and the page shows on the right (the marked one, else the one used
   last). Each page ends with More options (closed) for the rare things; a row there that needs you now is lifted onto
   the page. Search finds every setting by its name, hint and the words people use for it (one table, SEARCH, below),
   only this device's, and opens its page with the row lit up for a moment.
   Loaded after js/settings.js (whose pages it draws) and before js/start.js. */
'use strict';

(() => {
  const S = V.settings;
  if (!S || !S.CATEGORIES) return;  // (js/settings.js didn't load: start.js's fallback shows your notes)
  const LAST = 'vault-settings-page';  // the page shown last on a wide screen, this device's own
  const stored = () => { try { return localStorage.getItem(LAST) || ''; } catch (error) { return ''; } };
  const store = (id) => { try { localStorage.setItem(LAST, id); } catch (error) { /* a private window */ } };

  let root = null;
  let page = '';            // the page showing ('' = the home, on a phone)
  let pageStep = false;     // a phone's page has a step in history: Back goes to the home
  let query = '';
  const open = new Set();   // pages whose More options are open
  let lit = null;           // { key, at }: a row to light up once drawn (a search result, a link to a row)
  let aiAsked = false;      // the home's AI line asked js/ai.js where the keys are, once a visit
  const typed = new Map();  // half-typed boxes by label: { value, page } (kept across redraws and page switches)

  const isPc = () => V.desktop;
  const isPhone = () => !V.desktop && V.device === 'phone';
  const isWeb = () => !V.desktop && V.device === 'web';
  const isOwner = () => V.who() === 'owner';
  const has = (pref) => () => V.desktop && !!V.prefs && pref in V.prefs;
  const step = () => (V.desktop ? 'PC' : V.device === 'phone' ? (V.deviceKind.ios ? V.deviceKind.model : 'phone')
    : V.deviceKind.chromebook ? 'Chromebook' : 'browser');

  /* -- every setting, for search: its page, the row's key (its data-setting, or a CSS selector starting with "."),
     the words shown, the words people may use for it, whether it's under More options, and on which devices. */
  const SEARCH = [
    { page: 'account', key: 'your-email', name: 'Your e-mail', hint: () => (isOwner() ? 'Your notes, files and clipboard are only in your own cloud.'
      : 'Your notes, files and clipboard are yours alone.'), words: ['account', 'email', 'e-mail', 'signed in', 'privacy', 'who'] },
    { page: 'account', key: 'change-password', name: 'Change password', hint: 'For signing in on a new device. It isn\'t your locked-notes PIN.',
      words: ['password', 'forgot', 'sign in'] },
    { page: 'account', key: 'sign-out', name: 'Sign out', hint: 'Your notes stay safe in the cloud.', words: ['sign out', 'log out', 'logout', 'leave'] },
    // (1.21: the data's own two, beside the account)
    { page: 'account', key: 'export-everything', name: 'Export everything', hint: 'Every note, folder and chat in one ZIP, to keep or take elsewhere.',
      words: ['export', 'download my', 'my data', 'take out', 'takeout', 'zip', 'save everything', 'copy of'] },
    { page: 'account', key: 'delete-my-account', name: 'Delete my account', hint: () => (isOwner()
      ? 'You run this Wefty cloud, so your account can\'t be deleted here.' : 'Every note, file, chat and setting, on every device, for good.'),
    words: ['delete', 'account', 'remove', 'erase', 'close my', 'my data', 'leave', 'quit', 'gdpr'] },
    { page: 'account', key: 'sync', name: 'Sync', hint: 'Up to date, or what holds it up, and Sync now.', more: true,
      words: ['sync', 'synced', 'offline', 'not synced', 'refresh'] },
    { page: 'account', key: 'connected-to', name: 'Connected to', hint: 'The address of your free cloud.', more: true,
      words: ['cloud', 'supabase', 'server', 'address'] },
    { page: 'appearance', key: 'theme', name: 'Theme', hint: 'System, Light or Dark. Each device keeps its own.',
      words: ['dark', 'light', 'night', 'theme', 'mode', 'colour', 'color', 'look'] },
    { page: 'appearance', key: 'pure-black', name: 'Pure black', hint: 'A black page in dark mode, for OLED screens.',
      words: ['black', 'oled', 'amoled', 'battery'] },
    { page: 'appearance', key: 'dyslexia-friendly-text', name: 'Dyslexia-friendly text',
      hint: 'An easier font, more room between letters and lines, a soft page colour and a reading ruler.',
      words: ['dyslexia', 'font', 'lexend', 'opendyslexic', 'spacing', 'page colour', 'tint', 'ruler', 'reading', 'text size'] },
    { page: 'appearance', key: 'quick-read', name: 'Quick read', hint: 'The first part of every word drawn bolder on a soft colour.',
      words: ['bold', 'bionic', 'reading', 'highlight', 'focus'] },
    { page: 'appearance', key: 'study-streak', name: 'Study streak', hint: 'Days in a row you studied, on Today and after studying.',
      words: ['streak', 'fire', 'flame', 'days in a row', 'study', 'motivation', 'hide'], shown: () => !!V.streak },
    { page: 'ai', key: '.ai-gemini-row', name: 'Gemini key', hint: 'Free AI for Chat and the note-taker, with a key from Google.',
      words: ['gemini', 'google', 'key', 'ai', 'free', 'api', 'chat', 'set up', 'ai studio'] },
    { page: 'ai', key: '.ai-claude-switch', name: 'Use Claude too', hint: 'Paid Claude in Chat, with a monthly limit.',
      words: ['claude', 'anthropic', 'paid', 'money', 'limit', 'spend', 'cost', 'dollars'] },
    { page: 'ai', key: 'this-month', name: 'This month', hint: 'What Claude has cost this month, and its monthly limit.',
      words: ['limit', 'money', 'spend', 'spent', 'cost', 'dollars', 'month', 'budget'], shown: () => !!(V.ai && V.ai.claudeOn()) },
    { page: 'ai', key: 'notes-written-by', name: 'Notes written by', hint: 'Gemini Fast or Smart, or Claude, makes the note-taker\'s notes.',
      words: ['notes', 'summary', 'note-taker', 'smart', 'fast', 'who writes'] },
    { page: 'ai', key: 'check-gemini', name: 'Check Gemini', hint: 'How quickly each Gemini answers from here.', more: true,
      words: ['speed', 'slow', 'check', 'test', 'network', 'wifi'], shown: () => !!(V.ai && V.ai.has('gemini')) },
    { page: 'ai', key: 'check-claude', name: 'Check Claude', hint: 'Whether this network lets Claude through.', more: true,
      words: ['check', 'test', 'network', 'wifi', 'blocked', 'school'], shown: () => !!(V.ai && V.ai.claudeOn()) },
    { page: 'ai', key: 'remove-gemini-key', name: 'Remove the Gemini key', hint: 'Chat and the note-taker stop until it\'s set up again.', more: true,
      words: ['remove', 'delete', 'key', 'gemini'], shown: () => isOwner() && !!(V.ai && V.ai.has('gemini')) },
    { page: 'devices', key: 'add-a-phone-or-computer', name: 'Add a phone or computer',
      hint: () => (isPhone() ? 'Send yourself a link that opens Wefty there, ready to sign in.' : 'Show a code to scan with its camera, or copy the link.'),
      words: ['qr', 'code', 'connect', 'phone', 'computer', 'link', 'new device', 'iphone', 'android', 'chromebook', 'laptop'] },
    { page: 'devices', key: 'sign-in-another-device', name: 'Sign in another device', hint: 'Type the code a device that isn\'t signed in shows.',
      words: ['code', 'pair', 'new phone', 'new device', 'another device', 'sign in', 'log in', 'login', 'phone', 'chromebook', 'iphone'],
      shown: () => !!V.pair },
    { page: 'devices', key: 'copy-what-arrives', name: 'Copy what arrives', hint: 'What\'s sent to this PC goes on its clipboard.',
      words: ['clipboard', 'paste', 'arrivals', 'received'], shown: has('copyArrivals') },
    { page: 'devices', key: 'show-what-arrives', name: 'Show what arrives', hint: 'A small card with the picture, at the corner of the screen.',
      words: ['preview', 'card', 'corner', 'notification', 'popup'], shown: has('arrivalPreview') },
    { page: 'devices', key: 'files-from-your-phone-go-to', name: 'Files from your phone go to', hint: 'Where files sent to this PC are saved.',
      words: ['downloads', 'folder', 'save', 'received', 'files'], shown: isPc },
    { page: 'devices', key: 'clipboard-step', name: 'Keep this PC\'s clipboard in step',
      hint: 'Copy on one device, paste on the others. Never passwords, keys or what password managers hide.',
      words: ['clipboard', 'copy', 'paste', 'share'], shown: isPc },
    { page: 'devices', key: 'start-wefty-with-windows', name: 'Start Wefty with Windows', hint: 'Quietly, in the tray.', more: true,
      words: ['startup', 'windows', 'tray', 'autostart', 'boot', 'start'], shown: isPc },
    { page: 'devices', key: 'quick-note', name: 'Quick note shortcut', hint: 'A key for a little note box, anywhere on the PC.', more: true,
      words: ['hot key', 'hotkey', 'shortcut', 'ctrl', 'keyboard'], shown: isPc },
    { page: 'devices', key: 'share-what-i-copy', name: 'Share what I copy', hint: 'One way: what\'s copied on this PC goes to your other devices.',
      more: true, words: ['clipboard', 'copy', 'one way'], shown: isPc },
    { page: 'devices', key: 'copy-what-my-phone-and-chromebook-share', name: 'Copy what my phone and Chromebook share',
      hint: 'One way: their clips go on this PC\'s clipboard.', more: true, words: ['clipboard', 'paste', 'one way'], shown: isPc },
    { page: 'devices', key: 'folders-your-phone-can-see', name: 'Folders your phone can see', hint: 'Pick them in Share > Files.', more: true,
      words: ['files', 'folders', 'browse'], shown: () => isPc() && !!(V.share && V.share.shows && V.share.shows('files')) },
    { page: 'devices', key: 'pc-files', name: 'PC files', hint: 'Adds Files to Share: your PC\'s folders and Wefty Drive.',
      words: ['files', 'folders', 'drive', 'pc', 'computer', 'browse', 'documents'], shown: () => !!(V.share && V.share.filesRow) },
    { page: 'devices', key: 'clipboard-step', name: () => `Keep this ${step()}'s clipboard in step`,
      hint: 'Copy on one device, paste on the others. Never passwords, PINs or codes.', words: ['clipboard', 'copy', 'paste', 'share'],
      shown: () => !V.desktop },
    { page: 'devices', key: 'install', name: () => (isPhone() ? 'Put it on your home screen' : 'Install as an app'),
      hint: 'Wefty opens like any app, with its own icon.', words: ['install', 'home screen', 'app', 'icon', 'add to home'], shown: () => !V.desktop },
    { page: 'devices', key: 'this-device', name: () => `This is your ${step()}`, hint: 'Change what this device is: it decides what\'s sent here.',
      more: true, words: ['device', 'phone', 'chromebook', 'change', 'wrong'], shown: () => !V.desktop },
    { page: 'devices', key: 'copy-what-arrives', name: 'Copy what arrives', hint: 'Pictures, links and words sent here go on the clipboard.',
      words: ['clipboard', 'paste', 'arrivals', 'received'], shown: isWeb },
    { page: 'devices', key: () => (V.deviceKind.chromebook ? 'save-what-arrives-to-files' : 'save-what-arrives-to-a-folder'),
      name: () => (V.deviceKind.chromebook ? 'Save what arrives to Files' : 'Save what arrives to a folder'),
      hint: 'Pick a folder once: files sent here are saved there by themselves.',
      words: ['save', 'files', 'folder', 'downloads', 'arrivals'], shown: () => isWeb() && typeof window.showDirectoryPicker === 'function' },
    { page: 'notifications', key: 'notifications-here', name: () => `Notifications on this ${step()}`,
      hint: 'A nudge when cards are due and before tests, and your reminders, even when Wefty is closed.',
      words: ['notification', 'notifications', 'push', 'alert', 'nudge', 'remind', 'reminder', 'buzz'] },
    // (these three show once notifications are on for this person: V.push.choices)
    { page: 'notifications', key: 'study-nudge', name: 'Study nudge', hint: 'Once a day, when flash cards are due.',
      words: ['study', 'flash cards', 'cards', 'nudge', 'time', 'daily'], shown: () => !!(V.push && V.push.choices()) },
    { page: 'notifications', key: 'tests-the-evening-before', name: 'Tests', hint: 'The evening before a test.',
      words: ['test', 'exam', 'quiz', 'evening'], shown: () => !!(V.push && V.push.choices()) },
    { page: 'notifications', key: 'quiet-hours', name: 'Quiet hours', hint: 'No nudges at night.',
      words: ['quiet', 'night', 'sleep', 'do not disturb', 'silent', 'mute'], shown: () => !!(V.push && V.push.choices()) },
    { page: 'notes', key: 'locked-notes-pin', name: 'Locked notes PIN', hint: () => (V.lock.hasPin() ? 'Your PIN is set.' : 'No PIN yet.'),
      words: ['pin', 'lock', 'locked', 'secret', 'private', 'scramble'] },
    // The switch (1.19: off unless switched on), found by its name so it can be turned on from a search.
    { page: 'notes', key: 'subscriptions', name: 'Subscriptions', hint: 'Show what renews when on Today, and free trials to cancel.',
      words: ['subscription', 'renew', 'trial', 'extras'], shown: () => !!(V.subs && V.subs.settingsRow) },
    // Not a setting: its list lives on Today (js/subs.js), and a result opens it there. Only while they're on.
    { page: 'today', where: 'Today', key: 'subscriptions-list', name: 'Your subscriptions', hint: 'What renews when, free trials to cancel, and the monthly total.',
      words: ['subscription', 'renew', 'trial', 'netflix', 'spotify', 'bill', 'payment', 'cost', 'money'],
      shown: () => !!(V.subs && V.subs.open && V.subs.on && V.subs.on()), open: () => V.subs.open() },
    { page: 'notes', key: 'download-everything', name: 'Download everything', hint: 'One ZIP of every note. Locked notes stay locked: they need your PIN.',
      words: ['backup', 'back up', 'export', 'zip', 'markdown', 'download', 'save'] },
    { page: 'notes', key: 'back-up-every-week', name: 'Back up every week', hint: 'Into Documents on this PC, by itself, with your pictures and files.',
      words: ['backup', 'back up', 'weekly', 'zip', 'documents'], shown: isPc },
    { page: 'notes', key: 'restore-from-a-backup', name: 'Restore from a backup', hint: 'Put notes back from a backup on this PC.',
      more: true, words: ['restore', 'backup', 'back up', 'get back', 'lost'], shown: isPc },
    { page: 'notes', key: 'backups-folder', name: 'Your backups folder', hint: 'Open the folder on this PC where the weekly backups go.',
      more: true, words: ['backup', 'back up', 'folder', 'documents', 'open'], shown: isPc },
    { page: 'notes', key: 'index-now', name: 'Read attachments now', hint: 'The PC looks for new photos, PDFs and recordings to read now.',
      more: true, words: ['index', 'search', 'pdf', 'photo', 'ocr'], shown: has('attachIndex') },
    { page: 'notes', key: 'search-inside-photos-pdfs-and-recordings', name: 'Search inside photos, PDFs and recordings',
      hint: 'Your PC reads them, so search finds words inside them.', words: ['search', 'pdf', 'photo', 'ocr', 'attachments', 'index'], shown: isPc },
    { page: 'notes', key: 'hear-quiet-voices', name: 'Hear quiet voices', hint: 'The PC\'s note-taker listens harder in a quiet room.', more: true,
      words: ['quiet', 'soft', 'voice', 'microphone', 'note-taker', 'sensitivity', 'hearing', 'listen'], shown: has('notetakerSensitivity') },
    { page: 'friends', key: 'invite-someone', name: 'Invite someone', hint: 'Give a friend their own Wefty with a link that signs them in once.',
      words: ['invite', 'invite people', 'friends', 'people', 'classmates', 'code', 'link'] },
    { page: 'friends', key: 'join-with-a-qr-code', name: 'Join with a QR code', hint: 'Anyone who scans it in the next 30 minutes gets their own Wefty.',
      words: ['qr', 'join', 'scan', 'invite', 'friends'] },
    { page: 'friends', key: 'open-sign-ups', name: 'Open sign-ups', hint: 'Let anyone who finds wefty.org make their own Wefty here.',
      words: ['sign up', 'signups', 'sign-ups', 'open', 'everyone', 'public', 'strangers', 'cap', 'smtp', 'e-mail sender', 'captcha',
        'turnstile', 'google sign-in', 'waitlist'], shown: () => isPc() && isOwner() && !!(V.pc && V.pc.can('doorsState')) },
    { page: 'friends', key: 'new-announcement', name: 'New announcement', hint: 'Post an update, a poll or a note for everyone.',
      words: ['announcement', 'announcements', 'poll', 'news', 'post'] },
    { page: 'friends', key: 'stats', name: 'Stats', hint: 'How many are active today, this week and this month.', words: ['stats', 'numbers', 'active'] },
    { page: 'friends', key: 'stats-devices', name: 'Devices in use', hint: 'Which devices and Wefty versions everyone uses.', more: true,
      words: ['stats', 'devices', 'versions'] },
    { page: 'friends', key: 'feedback-from-everyone', name: 'Feedback from everyone', hint: 'Your PC collects it into your Feedback folder.',
      more: true, words: ['feedback', 'bug', 'collect'], shown: () => V.desktop && !!(V.pc && V.pc.can('feedbackCollect')) },
    { page: 'friends', key: 'turn-off-invites', name: 'Turn off invites', hint: 'Everyone you invited keeps their Wefty.', more: true,
      words: ['invite', 'turn off', 'stop', 'off'] },
    { page: 'about', key: 'wefty-version', name: 'Updates', hint: 'Wefty updates itself. Check now, or see what\'s new.',
      words: ['update', 'version', 'what\'s new', 'new', 'check'] },
    { page: 'about', key: 'take-the-tour', name: 'Take the tour', hint: 'Two minutes: where everything is in Wefty, and what the switches do.',
      words: ['tour', 'tutorial', 'walkthrough', 'walk through', 'guide', 'help', 'how to', 'learn', 'start', 'new'], shown: () => !!V.tour },
    { page: 'about', key: 'send-feedback', name: 'Send feedback', hint: 'Found a bug, or have an idea?', words: ['feedback', 'bug', 'idea', 'problem', 'report', 'help'] },
    { page: 'about', key: 'announcements', name: 'Announcements', hint: 'Read the updates you were sent again.', words: ['announcement', 'poll', 'news'],
      shown: () => !isOwner() },
    { page: 'about', key: 'use-the-built-in-copy', name: 'Use the built-in copy', hint: 'Go back to the version installed on this PC.', more: true,
      words: ['built-in', 'rollback', 'older version', 'go back'], shown: () => V.desktop && V.update.state().downloaded },
  ];

  const said = (value) => (typeof value === 'function' ? value() : value);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* What `text` finds: { hits (by name or the words people use), mentions (only in a hint), tip }. Words match at a
     word's start ("pin" finds "PINs", never "spinning"). */
  function search(text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return { hits: [], mentions: [], tip: '' };
    const at = new RegExp(`(^|[^a-z0-9])${escape(q)}`, 'i');
    const pages = new Set(S.categories().map((cat) => cat.id));
    const hits = [];
    const mentions = [];
    for (const row of SEARCH) {
      let shown = pages.has(row.page) || typeof row.open === 'function';
      try { shown = shown && (!row.shown || row.shown()); } catch (error) { shown = false; }
      if (!shown) continue;
      const entry = { ...row, name: said(row.name), hint: said(row.hint), key: said(row.key) };
      if (at.test(entry.name) || entry.words.some((w) => at.test(w))) hits.push(entry);
      else if (at.test(entry.hint)) mentions.push(entry);
    }
    const tip = q.length >= 2 && ('pinned'.startsWith(q) || /^pin/.test(q))
      ? 'Looking for pinned notes? Pin a note from its ⋯ menu in Notes. Pinned notes stay at the top.' : '';
    return { hits, mentions, tip };
  }

  /* -- the pieces pages are made of, given to every module's card as `ui` */

  const slug = S.slug;
  let pageTitle = '';
  // Sections that are their page's own (named for screen readers only, like the page's name).
  const SAME = { Account: ['Your account'], 'About & feedback': ['About Wefty'] };
  const ui = {
    /* A section of a page, with its title (an h2; hidden when it's the page's own name). */
    card: (title, ...kids) => V.h('section.card.settings-card', { dataset: { setting: slug(title) } },
      title ? V.h('h2' + (title === pageTitle || (SAME[pageTitle] || []).includes(title) ? '.page-same' : ''), { text: title }) : null, kids),
    line: (label, hint, control, key) => V.h('div.setting', { dataset: { setting: key || slug(label) } },
      V.h('div.setting-text', {}, V.h('strong', { text: label }), hint ? V.h('span', { text: hint }) : null), control),
    toggle: (name) => V.h('input.switch', { type: 'checkbox', checked: !!V.prefs[name], 'aria-label': name, onchange: async (event) => {
      V.prefs[name] = event.target.checked;
      try { await V.pc.call('setPref', { name, value: event.target.checked }); } catch (error) { V.problem(error); }
    } }),
    /* A row that needs the person now: drawn on the page even when it's one of More options' rows. */
    lift: (row) => { if (row) row.dataset.lift = '1'; return row; },
    /* More options at a page's foot: closed, with a line saying what's in it; its lifted rows go above it. */
    more: (summary, rows) => {
      const list = rows.filter(Boolean);
      if (!list.length) return null;
      const up = list.filter((row) => row.dataset && row.dataset.lift);
      const rest = list.filter((row) => !up.includes(row));
      const id = page || 'all';
      const shown = open.has(id);
      const region = V.h('div.set-more-rows', { id: `more-${id}`, role: 'region', 'aria-label': 'More options', hidden: !shown }, rest);
      const head = V.h('button.set-more-head', { type: 'button', 'aria-expanded': String(shown), 'aria-controls': `more-${id}`,
        onclick: () => {
          if (open.has(id)) open.delete(id); else open.add(id);
          const now = open.has(id);
          head.setAttribute('aria-expanded', String(now));
          region.hidden = !now;
        } },
      V.h('span.setting-text', {}, V.h('strong', { text: 'More options' }), V.h('span', { text: summary })), V.icon('down', 'set-more-chev'));
      return [up.length ? V.h('section.card.settings-card.set-lifted', {}, up) : null,
        rest.length ? V.h('section.card.set-more', {}, head, region) : null];
    },
    draw: () => draw(),
  };

  /* -- drawing */

  const cats = () => S.categories();
  const catOf = (id) => cats().find((cat) => cat.id === id);
  const summaryOf = (cat) => {
    const s = cat.summary() || {};
    return { parts: (s.parts || []).filter(Boolean), marked: !!s.marked };
  };

  /* Wide, the page shown first: the one asked for, else one that needs you, else the one used last, else Account. */
  function firstWide() {
    const marked = cats().find((cat) => summaryOf(cat).marked);
    if (marked) return marked.id;
    const last = stored();
    return catOf(last) ? last : 'account';
  }

  function categoryRow(cat, wide) {
    const s = summaryOf(cat);
    const user = V.data.user || {};
    const letter = (Array.from(String(user.name || user.email || '').trim())[0] || '?').toUpperCase();
    const icon = cat.id === 'account' ? V.h('span.av.set-ic-av', { text: letter }) : V.icon(cat.icon);
    const words = [];
    s.parts.forEach((part, i) => { if (i) words.push(' · '); words.push(V.h('span.set-part', { text: part })); });
    return V.h('button.set-cat', { type: 'button', dataset: { cat: cat.id, marked: s.marked ? '1' : null },
      'aria-current': wide && cat.id === page ? 'page' : null, onclick: () => openPage(cat.id) },
    V.h('span.set-ic', {}, icon, s.marked ? V.h('span.set-dot', { 'aria-hidden': 'true' }) : null),
    V.h('span.setting-text', {}, V.h('strong', { text: cat.title }),
      s.parts.length ? V.h('span.set-sum' + (s.marked ? '.warn' : ''), {}, words) : null,
      s.marked ? V.h('span.sr-only', { text: ' (needs you)' }) : null),
    wide ? null : V.icon('chevron', 'set-chev'));
  }

  function homeList(wide) {
    const list = cats();
    const group = (n) => list.filter((cat) => cat.group === n);
    return V.h('nav.set-home', { 'aria-label': 'Settings' },
      [1, 2].map((n) => (group(n).length ? V.h('div.set-group' + (wide ? '' : '.card'), {}, group(n).map((cat) => categoryRow(cat, wide))) : null)));
  }

  function marked(text, q) {
    const out = [];
    const at = new RegExp(`(^|[^a-z0-9])(${escape(q)})`, 'ig');
    let from = 0;
    let found;
    while ((found = at.exec(text))) {
      const start = found.index + found[1].length;
      out.push(text.slice(from, start), V.h('mark', { text: text.slice(start, start + found[2].length) }));
      from = start + found[2].length;
      if (at.lastIndex === found.index) at.lastIndex += 1;
    }
    out.push(text.slice(from));
    return out.filter((piece) => piece !== '');
  }

  function results() {
    const q = query.trim().toLowerCase();
    const { hits, mentions, tip } = search(q);
    const row = (entry, hit) => V.h('button.set-hit' + (hit ? '' : '.mention'), { type: 'button', dataset: { page: entry.page, key: entry.key },
      onclick: () => {
        query = '';
        if (entry.open) { draw(); entry.open(); } else openPage(entry.page, { more: entry.more, row: entry.key });
      } },
    V.h('span.setting-text', {},
      V.h('span.set-where', { text: entry.where || (catOf(entry.page) || {}).title || '' }),
      V.h('strong', {}, hit ? marked(entry.name, q) : entry.name),
      entry.hint ? V.h('span', {}, marked(entry.hint, q)) : null),
    V.wide() ? null : V.icon('chevron', 'set-chev'));
    return V.h('div.set-results', { role: 'region', 'aria-label': 'Search results', 'aria-live': 'polite' },
      V.h('p.set-count', { text: hits.length ? `${hits.length} setting${hits.length === 1 ? '' : 's'}` : 'No setting is called that' }),
      hits.length ? V.h('div.card.set-group', {}, hits.map((entry) => row(entry, true))) : null,
      tip ? V.h('p.set-tip', {}, V.icon('pin'), V.h('span', {}, V.h('strong', { text: 'Looking for pinned notes? ' }),
        'Pin a note from its ⋯ menu in Notes. Pinned notes stay at the top.')) : null,
      mentions.length ? [V.h('p.set-count', { text: `Also mentions “${query.trim()}”` }),
        V.h('div.card.set-group', {}, mentions.map((entry) => row(entry, false)))] : null);
  }

  let listBox = null;
  function searchBox() {
    const input = V.h('input.field.set-search-box', { type: 'search', value: query, placeholder: 'Search settings',
      'aria-label': 'Search settings', autocomplete: 'off', enterkeyhint: 'search',
      oninput: (event) => { query = event.target.value; clear.hidden = !query; redrawList(); },
      onkeydown: (event) => {
        if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); input.value = ''; query = ''; clear.hidden = true; redrawList(); }
      } });
    const clear = V.iconButton('x', 'Clear the search', () => { input.value = ''; query = ''; clear.hidden = true; redrawList(); input.focus(); }, 'set-search-clear');
    clear.hidden = !query;
    return V.h('div.set-search', { role: 'search' }, V.icon('search', 'set-search-ic'), input, clear);
  }

  function redrawList() {
    if (!listBox) return;
    V.clear(listBox, query.trim() ? results() : homeList(V.wide()));
  }

  function pageBody(cat) {
    pageTitle = cat.title;
    let parts;
    try { parts = cat.page(ui); } catch (error) {
      console.error(error);
      parts = [V.h('p.hint', { text: 'Wefty couldn\'t show this part of Settings just now.' })];
    }
    pageTitle = '';
    return V.h('div.set-page', { dataset: { page: cat.id } }, parts);
  }

  function draw() {
    // The view is shared by every screen: drawing while another shows put Settings over it.
    if (!root || !root.isConnected || root.dataset.tab !== 'settings') return;
    const kept = keepTyping();
    const wide = V.wide();
    if (page && !catOf(page)) page = '';
    if (wide && !page) page = firstWide();
    if (page !== 'devices') S.dropMark();
    const cat = page ? catOf(page) : null;
    listBox = V.h('div.set-list', {}, query.trim() ? results() : homeList(wide));
    let body;
    if (wide) {
      body = V.h('div.page.settings.settings-wide', {},
        V.h('div.set-side', {}, V.appHead({ title: 'Settings', me: false, cls: 'settings-head' }), searchBox(), listBox),
        V.h('div.set-main', { dataset: { page: cat.id } }, V.h('h1.set-title', { text: cat.title }), pageBody(cat)));
    } else if (cat) {
      body = V.h('div.page.settings.settings-sub', { dataset: { page: cat.id } },
        V.appHead({ title: cat.title, back: back, backLabel: 'Back to Settings', me: false, cls: 'settings-head' }), pageBody(cat));
    } else {
      body = V.h('div.page.settings.settings-home', {},
        V.appHead({ title: 'Settings', back: () => V.leaveSettings(), backLabel: 'Back', me: false, cls: 'settings-head' }),
        searchBox(), listBox);
    }
    if ((wide || !cat) && !aiAsked && V.ai && !V.ai.state()) {  // (the AI line says what the keys are once it's known)
      aiAsked = true;
      try { V.ai.check(); } catch (error) { /* (said on the AI page) */ }
    }
    V.clear(root, body);
    kept();
    light();
  }

  /* A row asked for (a search result, a link to Settings > AI's Gemini key): in view, lit up for 1.5 s. */
  function light() {
    if (!lit) return;
    const { key } = lit;
    lit = null;
    let el = null;
    try {
      el = key.startsWith('.') ? root.querySelector(`.set-page ${key}`)
        : root.querySelector(`.set-page [data-setting="${CSS.escape(key)}"]`);
    } catch (error) { el = null; }
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('lit');
    setTimeout(() => el.classList.remove('lit'), 1500);
  }

  /* -- getting around */

  function openPage(id, { more = false, row = '' } = {}) {
    if (!catOf(id)) return;
    if (more) open.add(id);
    if (row) lit = { key: row };
    const was = page;
    page = id;
    if (V.wide()) {
      store(id);
    } else if (!was && !pageStep && !(V.tour && V.tour.holds && V.tour.holds())) {  // (the tour adds no step: js/tour.js)
      try {
        history.pushState({ vault: 'settings-page', boot: V.pageLife }, '');
        pageStep = true;
      } catch (error) { /* (its arrow still goes back) */ }
    }
    draw();
    if (!row) {
      root.scrollTop = 0;
      const main = root.querySelector('.set-main');
      if (main) main.scrollTop = 0;
    }
  }

  // A phone's page: back to the home (through its step in history, so Back and the arrow agree).
  function back() {
    if (pageStep && history.state && history.state.vault === 'settings-page' && history.state.boot === V.pageLife) {
      history.back();  // (popstate below draws the home)
      return;
    }
    pageStep = false;
    page = '';
    draw();
  }

  window.addEventListener('popstate', () => {
    if (V.tab() !== 'settings' || !page || V.wide()) return;
    const state = history.state;
    if (state && state.vault === 'settings-page' && state.boot === V.pageLife) return;  // (still on the page: a note closed over it)
    pageStep = false;
    page = '';
    draw();
  });

  V.on('tab', (tab) => {
    if (tab === 'settings') return;
    query = '';
    pageStep = false;
    aiAsked = false;
    typed.clear();
    page = '';  // (opened again: a phone's home; wide, the page that needs you, else the one used last)
  });
  V.onWide(() => { pageStep = false; draw(); });

  /* Settings is drawn again whenever its data changes (another device's switch, this device noting itself for the
     owner's Stats a few seconds after opening), so what's being typed in a box (a Gemini key, a name) would lose its
     words and its caret: kept and put back, by the box's label, also across a page switch. Returns the putting back. */
  function keepTyping() {
    const label = (el) => el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    const boxes = () => [...root.querySelectorAll('.set-page input:not([type=checkbox]):not([type=radio]), .set-page textarea')]
      .filter((el) => label(el));
    const shownPage = () => { const el = root.querySelector('.set-page'); return el ? el.dataset.page : ''; };
    const here = shownPage();  // (the page drawn now: `page` may already say the next one)
    for (const el of boxes()) {
      if (el.value) typed.set(label(el), { value: el.value, page: here });
      else typed.delete(label(el));
    }
    const now = document.activeElement;
    const focused = now && root.contains(now) && /^(INPUT|TEXTAREA)$/.test(now.tagName) && label(now)
      ? { name: label(now), start: now.selectionStart, end: now.selectionEnd } : null;
    const scroll = root.scrollTop;
    const side = root.querySelector('.set-side');
    const sideScroll = side ? side.scrollTop : 0;
    const main = root.querySelector('.set-main');
    const mainScroll = main ? main.scrollTop : 0;
    return () => {
      const present = new Map(boxes().map((el) => [label(el), el]));
      for (const [name, box] of [...typed]) {
        const el = present.get(name);
        if (el && !el.value) el.value = box.value;
        else if (!el && box.page === shownPage()) typed.delete(name);  // (gone from its own page: saved, or not wanted now)
      }
      if (here === shownPage()) root.scrollTop = scroll;
      const sideNow = root.querySelector('.set-side');
      if (sideNow) sideNow.scrollTop = sideScroll;
      const mainNow = root.querySelector('.set-main');
      if (mainNow && here === shownPage()) mainNow.scrollTop = mainScroll;
      if (!focused) return;
      const el = focused.name === 'Search settings' ? root.querySelector('.set-search-box')
        : [...root.querySelectorAll('input, textarea')].find((box) => label(box) === focused.name);
      if (!el) return;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(focused.start, focused.end); } catch (error) { /* (a box that has no caret) */ }
    };
  }

  /* render(container, { page, row, more }): Settings opened (from your picture, a link to one of its rows, a place
     kept across an update). On a phone without a page asked for, the home. */
  function render(container, opts = {}) {
    root = container;
    const asked = opts && typeof opts.page === 'string' && catOf(opts.page) ? opts.page : '';
    // (Settings drawn again over one of its own pages, a phone's: that page's step is still there, never a second)
    const state = history.state;
    pageStep = !!state && state.vault === 'settings-page' && state.boot === V.pageLife;
    query = '';
    if (asked) {
      page = '';
      openPage(asked, { more: !!opts.more, row: typeof opts.row === 'string' ? opts.row : '' });
      return;
    }
    // (drawn again where it is: a phone's page whose step is still there stays, wide the page shown stays)
    page = V.wide() ? (page && catOf(page) ? page : firstWide()) : pageStep && catOf(page) ? page : '';
    draw();
  }

  Object.assign(S, {
    render,
    draw,
    open: (id, opts = {}) => {
      if (V.tab() === 'settings' && root && root.isConnected) { openPage(id, opts); return; }
      V.go('settings', { ...opts, page: id });
    },
    page: () => page,
    search,
    SEARCH,
  });
})();
