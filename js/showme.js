/* Wefty: Show me (1.22, the launch guide's first layer of help: "one small piece of code that takes a feature name,
   opens the right screen and pulses the right button for three seconds. The tour, Help and the AI all use it, so a
   hint always points at something real"). No AI, no cost.

   V.showMe(id, { from }) goes to where feature `id` lives (its tab, Settings page, Notes' list, Today's section, the
   open note's tools or one of the menus that holds it), brings it into view and puts a ring round it for 3 seconds,
   with "Here: <title>" said to a screen reader. It only shows: nothing is changed, recorded, studied or sent, and the
   only things it opens are screens, a note (the one open, else the latest) and menus, which a tap beside them or Esc
   closes. Taps go through the ring to what's under it. The ring follows what it points at (a screen drawn again with
   its data, a resize, a list scrolling) and goes after 3 s, at any tap or key press, Esc, or another screen. It
   resolves true when the thing was found, else false, with "Couldn't find <title> on this device." and Help.

   V.showMe.list() is every feature this device can show now ({ id, title, where }: "Settings > AI"), only the ones
   whose part is on here (Subscriptions, PC files, notifications off the PC, the owner's Invite...), and then every
   other row of Settings as `setting:<key>` (the keys of js/settingsui.js's SEARCH table: its data-setting, or a class
   for a few). V.showMe.has(id) says whether one of them is there.

   Loaded after js/start.js and js/settingsui.js (and the rest), before js/help.js; asks the other parts only when a
   feature is shown, so any of them can be missing. */
'use strict';

V.showMe = (() => {
  const SHOW_MS = 3000;     // how long the ring stays
  const FIND_TRIES = 25;    // looks for the thing once its screen is open, 80 ms apart (counted: a clock set by hand
  const FIND_EVERY = 80;    // never moves on), then it's not here
  const MENU_TRIES = 8;     // a menu opened to show one of its items: it's there at once, or not at all

  /* -- where things are */

  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden';
  const q = (sel) => { try { return [...document.querySelectorAll(sel)].filter(shown); } catch (error) { return []; } };
  const first = (...sels) => { for (const sel of sels) { const found = q(sel)[0]; if (found) return found; } return null; };
  const view = (tab) => `.view[data-tab=${tab}]`;
  const tile = (key) => first(`${view('today')} .today-tile[data-key="q:${key}"]`);
  const wide = () => !!(V.wide && V.wide());
  const tabNow = () => (V.tab ? V.tab() : '');
  const covering = () => !!(V.editor && V.editor.covering && V.editor.covering());
  const isOwner = () => !!(V.who && V.who() === 'owner');
  const can = (name) => !!(V.settings && V.settings.categories && V.settings.categories().some((cat) => cat.id === name));
  const cardsHere = () => { try { return !!(V.review && V.review.now().list.length); } catch (error) { return false; } };
  const testsHere = () => { try { return !!(V.review && V.review.now().plans.length); } catch (error) { return false; } };
  const canDictate = () => { try { return !!(V.dictation && V.dictation.engine && V.dictation.engine().kind); } catch (error) { return false; } };
  const aiListenHere = () => !V.desktop && !!(V.notetaker && V.notetaker.aiSwitch && V.ai && V.ai.has && V.ai.has('gemini'))
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof window.MediaRecorder === 'function';
  const subsOn = () => { try { return !!(V.subs && V.subs.on && V.subs.on()); } catch (error) { return false; } };
  const filesOn = () => { try { return !!(V.share && V.share.shows && V.share.shows('files')); } catch (error) { return false; } };
  const streakChip = () => { try { return !!(V.streak && V.streak.on() && V.streak.now().count); } catch (error) { return false; } };

  // Something on the screen now that a person can see and reach: not under a note open over everything, the
  // note-taker's screen or a sheet (unless it's in it).
  function reachable(el) {
    if (!shown(el)) return false;
    const over = [...document.querySelectorAll('#layers > .layer:not(.leaving):not(.menu-layer), #layers > .nt-layer.shown, .editor-layer.shown')]
      .filter(shown);
    return over.every((layer) => layer.contains(el));
  }

  /* -- getting there */

  // History steps for a note or Settings go back asynchronously: wait for that before another screen pushes its own.
  function backDone(had) {
    if (!had) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { window.removeEventListener('popstate', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 500);
      window.addEventListener('popstate', done);
    });
  }
  async function closeNote() {
    if (!covering()) return;
    const had = !!(history.state && history.state.vault === 'note');
    V.editor.close();
    await backDone(had);
  }
  function closeMenus() {
    for (const layer of document.querySelectorAll('#layers > .menu-layer')) {
      // (as a press beside it: its own onClose runs, setting its button's aria-expanded back)
      layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  }

  // A screen (a tab's view, or 'settings'): opened unless it's the one showing.
  async function toView(tab) {
    closeMenus();
    await closeNote();
    const now = tabNow();
    if (now === tab && document.querySelector(`${view(tab)}`)) return;
    V.go(tab);
  }
  async function toSettings(page, opts = {}) {
    closeMenus();
    await closeNote();
    if (!V.settings || !V.settings.open) { V.go('settings'); return; }
    V.settings.open(page, opts);
  }
  async function toNotes(filter) {
    await toView('notes');
    if (filter && V.notes && V.notes.setFilter) {
      const on = document.querySelector(`${view('notes')} [data-id="${filter}"].on`);
      if (!on) V.notes.setFilter(filter);
    }
  }
  // Notes with notes in its list (for picking or dragging them): back to All notes when the list shown has none (the
  // Flash cards page, an empty folder).
  async function toNoteList() {
    await toView('notes');
    if (!first(`${view('notes')} .list button.card`) && V.notes && V.notes.setFilter) V.notes.setFilter('all');
  }

  // The note a note's tools are shown in: the one open, else the latest one that has words to show (never a locked
  // one, a template, one in the Trash or the note the note-taker is listening into). Opening it changes nothing.
  async function toNote() {
    closeMenus();
    const open = V.editor && V.editor.openId ? V.editor.openId() : null;
    if (open && V.data.notes.has(open)) {
      if (covering() || (wide() && tabNow() === 'notes')) return true;
      if (V.notes) V.notes.open(open);
      return true;
    }
    const listening = V.notetaker && V.notetaker.listeningTo ? V.notetaker.listeningTo() : null;
    const notes = [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge && !n.locked && !n.template
      && n.id !== listening && !(V.organise && V.organise.isTemplate && V.organise.isTemplate(n))
      && !(V.organise && V.organise.isArchived && V.organise.isArchived(n)))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    if (!notes.length || !V.notes) return false;
    if (tabNow() === 'settings') await toView(wide() ? 'notes' : 'today');
    V.notes.open(notes[0].id);
    return true;
  }
  const inNote = (sel) => () => first(`.editor-layer.shown ${sel}`, `${view('notes')} .pane ${sel}`);

  // A menu opened by its button (the picture's, Today's ⋯, a note's ⋯ or + More), then the item in it.
  async function openMenu(button, menuSel) {
    if (!button) return null;
    let menu = first(menuSel);
    if (!menu) {
      button.click();
      for (let i = 0; i < MENU_TRIES && !menu; i++) {
        await frame();
        menu = first(menuSel);
      }
    }
    return menu;
  }
  const itemIn = (menu, words) => (menu ? [...menu.querySelectorAll('.menu-item, .more-tool')]
    .find((el) => shown(el) && (el.dataset.tool === words || (el.textContent || '').trim().startsWith(words))) || null : null);

  // Your picture: on a phone at the top of most screens (Today's for sure), wide at the foot of the rail.
  async function toPicture() {
    const here = first('.tabs .rail-me', `${view(tabNow())} .head-me`);
    if (here && reachable(here)) return here;
    await toView('today');
    for (let i = 0; i < FIND_TRIES; i++) {
      const found = first('.tabs .rail-me', `${view('today')} .head-me`);
      if (found) return found;
      await wait(FIND_EVERY);
    }
    return null;
  }
  const inPictureMenu = (words) => async () => {
    const button = await toPicture();
    if (!button) return null;
    return itemIn(await openMenu(button, '.menu.profile-menu'), words);
  };
  // (what the ring follows once it's there: only looked for, never opened again)
  const lookIn = (menuSel, words) => () => itemIn(first(menuSel), words);

  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* -- the features. Each: title (what the ring says), where (words, for Help and Chat), shown (here, now), go (opens
     its place), find (the thing, once there: it may open the menu it's in), look (only for those that open something:
     what the ring follows when the screen is drawn again, looked for and never opened again; else `find` is used),
     here (optional: where it may already be showing, so nothing moves). */

  const setting = (key) => () => first(`${view('settings')} .set-page ${key.startsWith('.') ? key : `[data-setting="${key}"]`}`);
  const atSetting = (page, key, more = false) => ({ go: () => toSettings(page, { row: key, more }), find: setting(key) });
  const FEATURES = [
    { id: 'new-note', title: 'New note', where: () => (wide() ? 'Notes > New note' : 'Notes > +'),
      here: () => (tabNow() === 'today' ? tile('new') : null),
      go: () => toView('notes'), find: () => first(`${view('notes')} .fab`, `${view('notes')} .list-head .new-note`) },
    { id: 'notetaker', title: 'Note-taker', where: 'Today > Note-taker', shown: () => !!V.notetaker,
      go: () => toView('today'), find: () => tile('notetaker') },
    { id: 'snap', title: 'Snap a page', where: 'Today > Snap', shown: () => !!V.capture,
      go: () => toView('today'), find: () => tile('snap') },
    { id: 'dictate', title: 'Dictate', where: 'Today > Dictate', shown: canDictate,
      go: () => toView('today'), find: () => tile('dictate') },
    { id: 'flash-cards', title: 'Flash cards', where: 'Notes > Flash cards', shown: () => !!V.review,
      here: () => (tabNow() === 'today' ? tile('cards') : null),
      go: () => toView('notes'), find: () => first(`${view('notes')} .chips [data-id=review]`, `${view('notes')} nav.folders [data-id=review]`) },
    { id: 'study', title: 'Study', where: 'Notes > Flash cards > Study', shown: cardsHere,
      go: () => toNotes('review'), find: () => first(`${view('notes')} .review-go .btn:not(.review-quiz)`) },
    { id: 'test-me', title: 'Test me', where: 'Notes > Flash cards > Test me', shown: () => !!V.learn && cardsHere(),
      here: () => (tabNow() === 'today' ? first(`${view('today')} .today-quiz`) : null),
      go: () => toNotes('review'), find: () => first(`${view('notes')} .review-go .review-quiz`) },
    { id: 'make-cards', title: 'Make cards with AI', where: 'Notes > Flash cards > Make cards with AI', shown: () => !!V.aiCards,
      go: () => toNotes('review'), find: () => first(`${view('notes')} .review-make .btn`) },
    { id: 'tests', title: 'Tests coming up', where: 'Today > Tests coming up', shown: testsHere,
      go: () => toView('today'),
      find: () => first(`${view('today')} .today-sec[data-section=tests]`, `${view('today')} .today-tests`) },
    { id: 'make-test', title: 'Make a test', where: 'A note > Due date, then + More > Test', shown: () => !!V.exams,
      go: toNote, find: inNote('.note-meta .due-chip') },
    { id: 'reminder', title: 'Reminder', where: 'A note > Reminder', shown: () => !!V.reminders,
      go: toNote, find: inNote('.tool-strip [data-tool=remind]') },
    { id: 'repeat', title: 'Repeat a reminder', where: 'A note > Reminder > Repeat', shown: () => !!V.reminders,
      go: toNote, find: inNote('.tool-strip [data-tool=remind]') },
    { id: 'folders', title: 'Folders', where: 'Notes', go: () => toView('notes'),
      find: () => first(`${view('notes')} nav.folders`, `${view('notes')} .chips`) },
    { id: 'new-folder', title: 'New folder', where: 'Notes > New folder', go: () => toView('notes'),
      find: () => first(`${view('notes')} nav.folders .folders-head .icon-btn`, `${view('notes')} .chips .chip.add`) },
    { id: 'search', title: 'Search notes', where: 'Notes > Search', go: () => toView('notes'),
      find: () => first(`${view('notes')} .list-head .search-box`, `${view('notes')} .notes-search`) },
    { id: 'select', title: 'Select notes', where: () => (wide() ? 'Notes > Select' : 'Notes > ⋯ > Select notes'),
      go: toNoteList,
      find: async () => {
        const button = first(`${view('notes')} .select-btn`);
        if (button) return button;
        const more = first(`${view('notes')} .notes-more`);
        if (!more) return null;
        return itemIn(await openMenu(more, '.menu.notes-menu'), 'Select notes') || more;
      },
      look: () => first(`${view('notes')} .select-btn`) || lookIn('.menu.notes-menu', 'Select notes')() || first(`${view('notes')} .notes-more`) },
    { id: 'drag', title: 'Drag a note onto a folder', where: 'Notes', go: toNoteList,
      find: () => first(`${view('notes')} .list button.card`) },
    { id: 'upcoming', title: 'Upcoming', where: 'Notes > Upcoming', go: () => toView('notes'),
      find: () => first(`${view('notes')} .chips [data-id=due]`, `${view('notes')} nav.folders [data-id=due]`) },
    { id: 'trash', title: 'Trash', where: 'Notes > Trash', go: () => toView('notes'),
      find: () => first(`${view('notes')} .chips [data-id=trash]`, `${view('notes')} nav.folders [data-id=trash]`) },
    { id: 'export-note', title: 'Export', where: 'A note > ⋯ > Export', shown: () => !!V.exporter, go: toNote,
      find: async () => itemIn(await openMenu(inNote('.editor-bar .icon-btn[aria-label=More]')(), '.menu:not(.profile-menu)'), 'Export'),
      look: lookIn('.menu:not(.profile-menu)', 'Export') },
    { id: 'lock-note', title: 'Lock this note', where: 'A note > the lock', go: toNote,
      find: inNote('.editor-bar .icon-btn[aria-label="Lock this note"], .editor-bar .icon-btn[aria-label=Locked]') },
    { id: 'pin-note', title: 'Pin to the top', where: 'A note > the pin', go: toNote,
      find: inNote('.editor-bar .icon-btn[aria-label="Pin to the top"], .editor-bar .icon-btn[aria-label=Unpin]') },
    { id: 'voice-memo', title: 'Voice memo', where: 'A note > + More > Voice memo', go: toNote,
      find: async () => itemIn(await openMenu(inNote('.editor-tools .tool-more')(), '.tools-more-menu'), 'voice'),
      look: lookIn('.tools-more-menu', 'voice') },
    { id: 'draw', title: 'Draw', where: 'A note > + More > Draw', shown: () => !!V.ink, go: toNote,
      find: async () => itemIn(await openMenu(inNote('.editor-tools .tool-more')(), '.tools-more-menu'), 'draw'),
      look: lookIn('.tools-more-menu', 'draw') },
    { id: 'today-week', title: 'Your week', where: 'Today', go: () => toView('today'),
      find: () => first(`${view('today')} .today-week`) },
    { id: 'share-send', title: 'Send', where: 'Share > Send', shown: () => !!V.send, go: () => toView('send'),
      find: () => first(`${view('send')} .send-card`) },
    { id: 'storage', title: 'Space for your files', where: 'Share > Send', shown: () => !!V.send, go: () => toView('send'),
      find: () => first(`${view('send')} .space-row`) },
    { id: 'clipboard', title: 'Clipboard', where: 'Share > Clipboard', shown: () => !!V.clips, go: () => toView('clips'),
      find: () => first(`${view('clips')} .clip-offer`, `${view('clips')} .clip-foot > *`, `${view('clips')} .send-row`) },
    { id: 'pc-files', title: 'PC files', where: 'Share > Files', shown: filesOn, go: () => toView('files'),
      find: () => first(`${view('files')} .files-sources`, `${view('files')} .files-layout`) },
    { id: 'chat', title: 'Chat', where: 'Chat', shown: () => !!V.chat, go: () => toView('claude'),
      find: () => first(`${view('claude')} .chat-composer`, `${view('claude')} .chat-side-head .btn`) },
    { id: 'chat-new', title: 'New chat', where: 'Chat > New chat', shown: () => !!V.chat, go: () => toView('claude'),
      find: async () => {
        const button = first(`${view('claude')} .chat-side-head .btn`);
        if (button) return button;
        const back = first(`${view('claude')} .chat-back`);  // (a phone showing one chat: its list has New chat)
        if (back) { back.click(); await frame(); }
        return first(`${view('claude')} .chat-side-head .btn`);
      },
      look: () => first(`${view('claude')} .chat-side-head .btn`) },
    { id: 'profile', title: 'Your picture', where: 'Your picture', go: async () => {}, find: toPicture,
      look: () => first('.tabs .rail-me', `${view(tabNow())} .head-me`) },
    { id: 'settings', title: 'Settings', where: 'Your picture > Settings', go: async () => {},
      find: () => (tabNow() === 'settings' ? first(`${view('settings')} .settings-head h1`) : inPictureMenu('Settings')()),
      look: () => first(`${view('settings')} .settings-head h1`) || lookIn('.menu.profile-menu', 'Settings')() },
    { id: 'help', title: 'Help', where: 'Your picture > Help', shown: () => !!V.help, go: async () => {}, find: inPictureMenu('Help'),
      look: lookIn('.menu.profile-menu', 'Help') },
    { id: 'tour', title: 'Take the tour', where: 'Your picture > Take the tour', shown: () => !!V.tour, go: async () => {},
      find: inPictureMenu('Take the tour'), look: lookIn('.menu.profile-menu', 'Take the tour') },
    { id: 'install', title: 'Install Wefty', where: 'Settings > Devices', shown: () => !V.desktop && can('devices'),
      ...atSetting('devices', 'install') },
    { id: 'add-device', title: 'Add a phone or computer', where: 'Settings > Devices', ...atSetting('devices', 'add-a-phone-or-computer') },
    { id: 'notifications', title: 'Notifications', where: 'Settings > Notifications', shown: () => !V.desktop && !!V.push && can('notifications'),
      ...atSetting('notifications', 'notifications-here') },
    { id: 'gemini-key', title: 'Gemini key', where: 'Settings > AI', shown: () => !!V.ai && can('ai'), ...atSetting('ai', '.ai-gemini-row') },
    { id: 'ai-listening', title: 'AI listening', where: 'Settings > AI', shown: () => aiListenHere() && can('ai'),
      ...atSetting('ai', '.ai-listen-switch') },
    { id: 'test-me-ai', title: 'AI helps with Test me', where: 'Settings > AI', shown: () => !!V.ai && can('ai'),
      ...atSetting('ai', '.ai-testme-switch') },
    { id: 'claude', title: 'Use Claude too', where: 'Settings > AI', shown: () => !!V.ai && can('ai'), ...atSetting('ai', '.ai-claude-switch') },
    { id: 'theme', title: 'Theme', where: 'Settings > Appearance', ...atSetting('appearance', 'theme') },
    { id: 'pure-black', title: 'Pure black', where: 'Settings > Appearance', ...atSetting('appearance', 'pure-black') },
    { id: 'reading', title: 'Reading aids', where: 'Settings > Appearance', shown: () => !!V.reading, ...atSetting('appearance', 'reading') },
    // On, the list lives behind Today's ⋯ (js/subs.js); its switch is setting:subscriptions.
    { id: 'subscriptions', title: 'Subscriptions', where: 'Today > ⋯ > Subscriptions', shown: subsOn, go: () => toView('today'),
      find: async () => itemIn(await openMenu(first(`${view('today')} .today-more`), '.menu:not(.profile-menu)'), 'Subscriptions'),
      look: lookIn('.menu:not(.profile-menu)', 'Subscriptions') },
    { id: 'streak', title: 'Study streak', where: () => (streakChip() ? 'Today' : 'Settings > Appearance'), shown: () => !!V.streak,
      go: () => (streakChip() ? toView('today') : toSettings('appearance', { row: 'study-streak' })),
      find: () => (streakChip() ? first(`${view('today')} .streak-chip`) : setting('study-streak')()) },
    { id: 'sign-in-another-device', title: 'Sign in another device', where: 'Settings > Devices', shown: () => !!V.pair,
      ...atSetting('devices', 'sign-in-another-device') },
    { id: 'export-everything', title: 'Export everything', where: 'Settings > Account', ...atSetting('account', 'export-everything') },
    { id: 'delete-account', title: 'Delete my account', where: 'Settings > Account', ...atSetting('account', 'delete-my-account') },
    { id: 'change-password', title: 'Change password', where: 'Settings > Account', ...atSetting('account', 'change-password') },
    { id: 'sign-out', title: 'Sign out', where: 'Settings > Account', ...atSetting('account', 'sign-out') },
    { id: 'feedback', title: 'Send feedback', where: 'Settings > About & feedback', shown: () => !!V.feedback,
      ...atSetting('about', 'send-feedback') },
    { id: 'update', title: 'Updates', where: 'Settings > About & feedback', ...atSetting('about', 'wefty-version') },
    { id: 'invite', title: 'Invite people', where: 'Settings > Friends', shown: () => isOwner() && can('friends'),
      go: () => toSettings('friends', { row: 'invite-someone' }),
      find: () => setting('invite-someone')() || first(`${view('settings')} .set-page[data-page=friends] > *`) },
  ];
  const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));
  // Settings rows a named feature above already shows (left out of the setting:<key> part of the list).
  const NAMED_ROWS = new Set(['install', 'add-a-phone-or-computer', 'notifications-here', '.ai-gemini-row', '.ai-listen-switch',
    '.ai-testme-switch', '.ai-claude-switch', 'theme', 'pure-black', 'study-streak', 'sign-in-another-device', 'export-everything',
    'delete-my-account', 'change-password', 'sign-out', 'send-feedback', 'wefty-version', 'invite-someone', 'take-the-tour', 'help']);

  const said = (value) => (typeof value === 'function' ? value() : value);
  const on = (feature) => { try { return !feature.shown || !!feature.shown(); } catch (error) { return false; } };

  /* Settings' rows (js/settingsui.js's SEARCH table): the first one with that key that's on this device now. */
  function rowFor(key) {
    const table = (V.settings && V.settings.SEARCH) || [];
    const pages = new Set(V.settings && V.settings.categories ? V.settings.categories().map((cat) => cat.id) : []);
    for (const row of table) {
      if (typeof row.open === 'function') continue;  // (not a row of Settings: a list kept elsewhere, Help itself)
      let k = '';
      try { k = said(row.key); } catch (error) { continue; }
      if (k !== key || !pages.has(row.page)) continue;
      let here = true;
      try { here = !row.shown || !!row.shown(); } catch (error) { here = false; }
      if (here) return row;
    }
    return null;
  }
  // Friends' rows (the owner's) are only there once the invites are on (js/access.js); before that the page is one card.
  const friendsOn = () => { try { const now = V.invites && V.invites.state && V.invites.state(); return !!(now && now.on); } catch (error) { return false; } };
  function settingFeature(key) {
    const row = rowFor(key);
    if (!row) return null;
    if (row.page === 'friends' && key !== 'open-sign-ups' && !friendsOn()) return null;
    const cat = V.settings.categories().find((c) => c.id === row.page);
    let title = '';
    try { title = said(row.name); } catch (error) { title = 'That setting'; }
    return { id: `setting:${key}`, title, where: `Settings > ${cat ? cat.title : 'Settings'}${row.more ? ' > More options' : ''}`,
      go: () => toSettings(row.page, { row: key, more: !!row.more }), find: setting(key) };
  }
  const featureOf = (id) => (typeof id === 'string' && id.startsWith('setting:') ? settingFeature(id.slice(8))
    : BY_ID.has(id) && on(BY_ID.get(id)) ? BY_ID.get(id) : null);

  function list({ settings = true } = {}) {
    const out = FEATURES.filter(on).map((f) => ({ id: f.id, title: f.title, where: said(f.where) }));
    if (!settings || !V.settings || !V.settings.SEARCH) return out;
    const seen = new Set();
    for (const row of V.settings.SEARCH) {
      let key = '';
      try { key = said(row.key); } catch (error) { continue; }
      if (!key || seen.has(key) || NAMED_ROWS.has(key)) continue;
      const feature = settingFeature(key);
      if (!feature) continue;
      seen.add(key);
      out.push({ id: feature.id, title: feature.title, where: feature.where });
    }
    return out;
  }
  const has = (id) => !!featureOf(id);

  /* -- the ring */

  let live = null;  // the "Here: ..." line for a screen reader (there before it's needed, so it's heard)
  function liveLine() {
    if (live && live.isConnected) return live;
    live = V.h('div.sr-only.showme-live', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(live);
    return live;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', liveLine, { once: true });
  else liveLine();
  function say(text) {
    const line = liveLine();
    line.textContent = '';
    requestAnimationFrame(() => { line.textContent = text; });
  }

  let pointing = null;  // { ring, el, id, title, refind, raf, timer, stop }
  let seq = 0;          // the newest Show me (a later one wins over one still on its way)

  function stop() {
    const was = pointing;
    if (!was) return;
    pointing = null;
    cancelAnimationFrame(was.raf);
    clearTimeout(was.timer);
    window.removeEventListener('pointerdown', was.away, true);
    window.removeEventListener('keydown', was.key, true);
    was.ring.classList.add('leaving');
    setTimeout(() => was.ring.remove(), 180);
  }
  V.on('tab', () => stop());
  V.on('signing-out', () => stop());

  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return false; } };

  // In sight: scrolled to unless it's all on the screen already (smoothly, unless motion is turned down).
  function bringIntoView(el) {
    const r = el.getBoundingClientRect();
    const tabs = document.querySelector('#app > nav.tabs');
    const bar = tabs && shown(tabs) ? tabs.getBoundingClientRect() : null;
    const bottom = bar && bar.top > window.innerHeight / 2 ? bar.top : window.innerHeight;
    if (r.top >= 0 && r.bottom <= bottom && r.left >= 0 && r.right <= window.innerWidth) return;
    try {
      el.scrollIntoView({ block: r.height > bottom * 0.7 ? 'start' : 'center', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    } catch (error) { /* (an old browser: where it is) */ }
  }

  function place(state) {
    let el = state.el;
    if (!el || !el.isConnected || !shown(el)) {
      // (drawn again with its data: found afresh)
      let again = null;
      try { again = state.refind && state.refind(); } catch (error) { again = null; }
      el = again && typeof again.then !== 'function' && shown(again) ? again : null;
      state.el = el;
    }
    const ring = state.ring;
    if (!el) { ring.hidden = true; return; }
    ring.hidden = false;
    // (page zoom, a bigger-text setting: the ring's own size against what it measures, so its place is set right)
    const z = ring.offsetWidth ? ring.getBoundingClientRect().width / ring.offsetWidth || 1 : 1;
    const r = el.getBoundingClientRect();
    const pad = 4;
    Object.assign(ring.style, { left: `${(r.left - pad) / z}px`, top: `${(r.top - pad) / z}px`,
      width: `${(r.width + pad * 2) / z}px`, height: `${(r.height + pad * 2) / z}px` });
  }

  function point(el, feature, id) {
    stop();
    let radius = 12;
    try { radius = Math.min(28, (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8) + 4); } catch (error) { /* */ }
    const ring = V.h('div.showme-ring', { 'aria-hidden': 'true', style: { borderRadius: `${radius}px` } });
    document.body.append(ring);
    const state = { ring, el, id, title: feature.title, refind: feature.look || feature.find };
    state.away = () => stop();
    state.key = () => stop();
    pointing = state;
    const follow = () => {
      if (pointing !== state) return;
      place(state);
      state.raf = requestAnimationFrame(follow);
    };
    place(state);
    state.raf = requestAnimationFrame(follow);
    state.timer = setTimeout(() => { if (pointing === state) stop(); }, SHOW_MS);
    // (a tap anywhere or any key: it has been seen. The tap itself still lands where it was aimed.)
    window.addEventListener('pointerdown', state.away, true);
    window.addEventListener('keydown', state.key, true);
    say(`Here: ${feature.title}`);
  }

  // The keyboard there too, when it's a button or a switch (never a box typed in: a phone's keyboard would pop up).
  function focusOn(el) {
    const typed = (node) => node.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]), select, [contenteditable]');
    const target = el.matches('button, a[href], [role=tab], [role=menuitem], input[type=checkbox]') ? el
      : el.querySelector('[role=tab][tabindex="0"], [aria-selected=true], button:not([disabled]), input[type=checkbox], a[href]');
    if (!target || typed(target) || !shown(target)) return;
    if (target.closest('.menu')) return;  // (a menu puts the keyboard on its own first item)
    try { target.focus({ preventScroll: true }); } catch (error) { /* */ }
  }

  async function findIt(feature, ticket) {
    for (let i = 0; i < FIND_TRIES; i++) {
      if (ticket !== seq) return null;
      let el = null;
      try { el = await feature.find(); } catch (error) { el = null; }
      if (ticket !== seq) return null;
      if (el && shown(el)) return el;
      await wait(FIND_EVERY);
    }
    return null;
  }

  function notFound(title) {
    const what = title || 'that';
    V.toast(`Couldn't find ${what} on this device.`, V.help && V.help.open
      ? { action: 'Help', onAction: () => V.help.open({ query: title || '' }), ms: 6000 } : { ms: 5000 });
  }

  /* Points at feature `id`: true once it's found and the ring is round it, else false (and a toast with Help).
     `from`: who asked ('help', 'chat', 'whatsnew'...), for the words only. */
  async function showMe(id, { from = '' } = {}) {
    const ticket = ++seq;
    stop();
    const feature = featureOf(id);
    if (!feature) {
      const known = BY_ID.get(id);
      notFound(known ? known.title : '');
      return false;
    }
    try {
      // Already on the screen: shown where it is, nothing moves.
      if (feature.here) {
        const there = feature.here();
        if (there && reachable(there)) {
          bringIntoView(there);
          point(there, feature, id);
          focusOn(there);
          return true;
        }
      }
      if (feature.go) await feature.go();
      if (ticket !== seq) return false;
      const el = await findIt(feature, ticket);
      if (ticket !== seq) return false;
      if (!el) { notFound(feature.title); return false; }
      bringIntoView(el);
      await frame();
      if (ticket !== seq) return false;
      point(el, feature, id);
      focusOn(el);
      return true;
    } catch (error) {
      console.error('Wefty: Show me', id, from, error);
      if (ticket === seq) notFound(feature.title);
      return false;
    }
  }

  return Object.assign(showMe, {
    list,
    has,
    stop,
    // (tests, and anyone who wants to know what's pointed at now)
    pointing: () => (pointing ? { id: pointing.id, title: pointing.title, el: pointing.el } : null),
    titleOf: (id) => { const f = featureOf(id); return f ? f.title : ''; },
    whereOf: (id) => { const f = featureOf(id); return f ? said(f.where) : ''; },
    FEATURES,
    SHOW_MS,
  });
})();
