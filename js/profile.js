/* Wefty: your picture (1.16). A circle with your first letter at the right of every screen's top row on a phone, and
   at the foot of the rail on a wide screen. It took over the sync pill's job: its mark says how syncing goes (a thin
   turning ring while a sync takes a while, a small iris dot while changes made here are still going up, amber while
   they wait here offline, red when the cloud can't be reached; no green, which reads as "online now"), and its menu's
   first line says it in words, with what to do. An iPhone's old Vault icon is told to wait until that dot is gone
   before it's removed (js/start.js), and so is signing out (js/settings.js): no dot means nothing waits here. The menu also
   holds what moved behind it: Settings, Invite people (the owner's), Feedback and Sign out.

   Loaded before js/start.js (whose frame asks it for the picture at once); if it fails, util.js's V.profileButton
   draws a plain letter that opens Settings, so the way there never goes. */
'use strict';

V.profile = (() => {
  const RING_AFTER = 1000;  // a sync shorter than this never shows the ring (one runs every 20 s without Realtime)
  const TABLES = ['notes', 'folders', 'transfers'];
  let state = null;         // the last status heard (V.cloud.status until then)
  let ringing = false;
  let ringTimer = null;
  let open = null;          // the menu, while it shows
  let pressedShut = null;   // { anchor, at }: the menu closed by a press beside it (on its picture, maybe)
  let outgoing = 0;         // files waiting in V.db's "outgoing" (counted again whenever something may have changed)

  const status = () => state || (V.cloud && V.cloud.status) || 'idle';
  const isOwner = () => V.who() === 'owner';
  // Rows this device is sending up now (a change made here, not one set aside as too big): the ring shows at once.
  const sending = () => TABLES.some((table) => [...V.data[table].values()].some((row) => row._dirty && row._refused !== row._dirty))
    || !!(V.data.settings && V.data.settings._dirty);
  // Changes made here that haven't reached the cloud, as js/cloud.js's unsent() counts them (rows set aside as too big
  // aren't: the 'held' status says those): the picture shows a dot until they've gone, even while a push waits its turn.
  function unsent() {
    let count = outgoing + (V.data.settings && V.data.settings._dirty ? 1 : 0);
    for (const table of TABLES) {
      for (const row of V.data[table].values()) if (row._dirty && row._refused !== row._dirty) count += 1;
    }
    return count;
  }
  function countOutgoing() {
    if (!V.db || !V.db.all) return;
    V.db.all('outgoing').then((rows) => {
      if (rows.length !== outgoing) { outgoing = rows.length; paintAll(); }
    }, () => { /* (no store yet: nothing waits) */ });
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // This device in a few words: "phone", "iPhone", "PC", "Chromebook" or "computer".
  const here = () => (V.device === 'pc' ? 'PC' : V.device === 'phone' ? (V.deviceKind.ios ? V.deviceKind.model : 'phone')
    : V.deviceKind.chromebook ? 'Chromebook' : 'computer');

  /* What the picture's mark says: '' (nothing to say), 'ring' (a sync that's taking a while, or sending from here),
     'warn' (offline, or a note too big to go up: amber) or 'bad' (the cloud can't be reached, or signed out: red). */
  function markOf(value, ring = ringing) {
    if (value === 'syncing') return ring ? 'ring' : '';
    if (value === 'offline' || value === 'held') return 'warn';
    if (value === 'error' || value === 'asleep' || value === 'signed-out') return 'bad';
    return '';
  }

  function labelOf(value, waiting = 0) {
    if (waiting && !['held', 'offline', 'error', 'asleep', 'signed-out'].includes(value)) {
      return `You: sending ${plural(waiting, 'change')}`;
    }
    if (value === 'held') return `You: ${plural(V.cloud.held || 1, 'note')} not synced`;
    if (value === 'offline') return 'You: offline, changes wait here';
    if (value === 'error' || value === 'asleep') return 'You: Wefty can\'t reach your cloud';
    if (value === 'signed-out') return 'You: signed out';
    if (value === 'syncing' && ringing) return 'You: syncing';
    return 'You';
  }

  function letter() {
    const user = V.data.user || {};
    return (Array.from(String(user.name || user.email || '').trim())[0] || '?').toUpperCase();
  }

  function paint(el) {
    const value = status();
    const mark = markOf(value);
    let waiting = 0;
    try { waiting = unsent(); } catch (error) { /* (no data yet) */ }
    el.dataset.state = value;
    el.dataset.mark = mark;
    if (waiting) el.dataset.unsent = String(waiting);
    else delete el.dataset.unsent;
    const label = labelOf(value, waiting);
    el.setAttribute('aria-label', label);
    el.title = label.replace(/^You: /, '').replace(/^You$/, 'You');
    const shown = el.querySelector('.av-letter');
    if (shown) shown.textContent = letter();
  }
  function paintAll() {
    for (const el of document.querySelectorAll('button.me:not(.plain)')) {
      try { paint(el); } catch (error) { console.error(error); }
    }
  }

  /* The picture itself. `cls`: 'head-me' (a screen's top row) or 'rail-me' (the rail's foot). */
  function button(cls = '') {
    const el = V.h('button.me' + (cls ? '.' + cls : ''), { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: () => {
        // (A tap on the picture while its menu shows closes the menu on the way down: not opened again by the click.)
        if (pressedShut && pressedShut.anchor === el && Date.now() - pressedShut.at < 600) { pressedShut = null; return; }
        menu(el);
      } },
    V.h('span.av', {}, V.h('span.av-letter', { text: letter() }), V.h('i.dot', { 'aria-hidden': 'true' })));
    paint(el);
    return el;
  }

  /* The device kinds in the account, from each device's own record (js/access.js, the owner's Stats read the same):
     "Phone, PC and Chromebook", or "This phone" when this device is the only one seen in the last 30 days. */
  function devicesLine() {
    const since = Date.now() - 30 * 86400000;
    const records = Object.values(((V.data.settings || {}).extra || {}).devices || {})
      .filter((r) => r && typeof r === 'object' && typeof r.kind === 'string' && Date.parse(r.seen) >= since);
    const kinds = new Set(records.map((r) => r.kind));
    kinds.add(V.deviceKind.kind);
    const phones = ['android', 'iphone', 'ipad'].filter((k) => kinds.has(k));
    const words = [];
    if (phones.length) words.push(phones.length === 1 && phones[0] === 'iphone' ? 'iPhone' : phones.length === 1 && phones[0] === 'ipad' ? 'iPad' : 'Phone');
    if (kinds.has('pc')) words.push('PC');
    if (kinds.has('chromebook')) words.push('Chromebook');
    if (kinds.has('browser')) words.push('Browser');
    if (words.length <= 1) return `This ${here()}`;
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }

  /* The menu's first line, only when syncing isn't fine (or changes made here are still going up): what's going on,
     in words, with what to do. */
  function statusLine(close) {
    const value = status();
    let kind = 'warn';
    let title;
    let words;
    let action;
    let waiting = 0;
    try { waiting = unsent(); } catch (error) { /* (no data yet) */ }
    if (waiting && !['held', 'offline', 'error', 'asleep', 'signed-out'].includes(value)) {
      kind = 'send';
      title = `Sending ${plural(waiting, 'change')}...`;
      words = 'Keep Wefty open until this goes.';
      action = ['Send now', () => { close(); V.cloud.sync(); }];
    } else if (value === 'held') {
      const n = V.cloud.held || 1;
      title = `${plural(n, 'note')} too big to sync`;
      words = `${n === 1 ? 'It\'s' : 'They\'re'} safe on this ${here()}.`;
      action = ['Show', () => { close(); heldNotes(); }];
    } else if (value === 'offline') {
      title = 'Offline';
      words = `Changes wait on this ${here()}.`;
      action = ['Try again', () => { close(); V.cloud.sync(); }];
    } else if (value === 'error' || value === 'asleep') {
      kind = 'bad';
      title = value === 'asleep' ? 'Your cloud is asleep' : 'Wefty can\'t reach your cloud';
      words = `Changes wait on this ${here()}.`;
      action = ['What to do', () => { close(); trouble(); }];
    } else if (value === 'signed-out') {
      kind = 'bad';
      title = 'Signed out';
      words = 'Sign in again to sync.';
      action = ['Sign in', () => { close(); location.reload(); }];
    } else {
      return null;
    }
    return V.h('div.m-status.' + kind, { role: 'group', 'aria-label': title },
      V.h('span.ms-ic', {}, V.icon(kind === 'send' ? 'upload' : 'alert')),
      V.h('span.ms-text', {}, V.h('strong', { text: title }), V.h('span', { text: words })),
      V.h('button.ms-link', { type: 'button', text: action[0], onclick: action[1] }));
  }

  function head() {
    const user = V.data.user || {};
    let waiting = 0;
    try { waiting = unsent(); } catch (error) { /* (no data yet) */ }
    const pic = V.h('span.av.big', { dataset: waiting ? { mark: markOf(status()), unsent: String(waiting) } : { mark: markOf(status()) } }, V.h('span.av-letter', { text: letter() }),
      V.h('i.dot', { 'aria-hidden': 'true' }));
    return V.h('div.menu-head', { role: 'group', 'aria-label': `Signed in as ${user.email || 'you'}` }, pic,
      V.h('div.mh-text', {}, V.h('strong', { text: user.email || user.name || 'Signed in' }), V.h('span', { text: devicesLine() })));
  }

  // Invite people: the owner's, where invites work (a PC part from before 1.8 has none: js/access.js's card says so).
  const canInvite = () => isOwner() && !!(V.data.user || {}).id
    && (!V.desktop || (V.pc && (V.pc.can('adminCall') || V.pc.can('invitesState'))));

  function items() {
    return [
      { node: (close) => statusLine(close) },
      { node: head() },
      { sep: true },
      { label: 'Settings', icon: 'settings', onClick: () => V.go('settings') },
      canInvite() ? { label: 'Invite people', icon: 'user-plus', onClick: () => V.go('settings', { page: 'friends' }) } : null,
      V.feedback ? { label: 'Feedback', icon: 'feedback', onClick: () => V.feedback.sheet() } : null,
      // (1.19.6, js/tour.js: the walk through Wefty, any time; after the menu has gone, so the keyboard comes back here)
      V.tour ? { label: 'Take the tour', icon: 'spark', onClick: () => setTimeout(() => V.tour.start({ why: 'menu' }), 0) } : null,
      // (1.21, js/pair.js: the code another device shows, typed here to sign it in)
      V.pair && (V.data.user || {}).id ? { label: 'Sign in another device', icon: 'devices', onClick: () => V.pair.approve() } : null,
      { sep: true },
      { label: 'Sign out', icon: 'sign-out', danger: true, onClick: () => V.settings.signOut().catch(V.problem) },
    ];  // (no first line while all is well: statusLine gives none, and the menu leaves it out)
  }

  /* The picture's menu, under it on a phone and above it at the foot of the rail. A second tap closes it. */
  function menu(anchor) {
    if (open) { open.close(); return; }
    anchor.setAttribute('aria-expanded', 'true');
    open = V.menu(anchor, items(), { align: anchor.classList.contains('rail-me') ? 'up' : '', cls: 'profile-menu',
      label: 'Your menu', returnFocus: true,
      onClose: (how) => {
        anchor.setAttribute('aria-expanded', 'false');
        open = null;
        pressedShut = how === 'outside' ? { anchor, at: Date.now() } : null;
      } });
  }

  /* The notes the cloud set aside as too big (js/cloud.js's heldCount): kept on this device until they're shorter. */
  function heldNotes() {
    const held = [...V.data.notes.values()].filter((row) => row._refused && row._refused === row._dirty && !row._purge);
    let sheet = null;
    sheet = V.sheet({
      title: held.length === 1 ? '1 note too big to sync' : `${held.length} notes too big to sync`,
      content: [
        V.h('p', { text: `They're kept on this ${here()} and go up by themselves once they're smaller: make the words shorter, `
          + 'or move big pictures into a file.' }),
        held.length ? V.h('div.held-list', {}, held.map((note) => V.h('button.held-note', { type: 'button', dataset: { id: note.id },
          onclick: () => { sheet.close(); V.notes.open(note.id); } }, V.icon(note.locked ? 'lock' : 'notes'),
        V.h('span', { text: V.noteTitle ? V.noteTitle(note) : (note.title || 'Untitled') }), V.icon('next'))))
          : V.h('p.hint', { text: 'Nothing is set aside now.' }),
      ],
      actions: [{ label: 'Close' }],
    });
    return sheet;
  }

  /* The free cloud asleep (a week unused) or out of reach: what to do. */
  function trouble() {
    const asleep = V.cloud.status === 'asleep' || status() === 'asleep';
    if (!isOwner()) {  // (a friend's or a sign-up's cloud is someone else's: only they can wake it)
      const self = V.who() === 'self';
      return V.sheet({
        title: asleep ? 'Wefty\'s cloud is asleep' : 'Wefty can\'t reach your cloud',
        content: [
          V.h('p', { text: asleep ? 'The cloud your Wefty is in is asleep. Everything is still there.'
            : 'If the internet is working, the cloud your Wefty is in may be asleep or busy. Everything is still there.' }),
          V.h('p', { text: self ? `If it lasts more than a day, write to ${V.TEAM}.`
            : 'Ask the person who invited you to open Wefty: that wakes it up in a few minutes.' }),
          V.h('p.hint', { text: 'Until then, what you write is kept on this device and goes up once it\'s back.' }),
        ],
        actions: [{ label: 'Close' }, { label: 'Try again', kind: 'primary', onClick: () => V.cloud.sync() }],
      });
    }
    return V.sheet({
      title: asleep ? 'Your cloud is asleep' : 'Wefty can\'t reach your cloud',
      content: [
        V.h('p', { text: asleep
          ? 'Free Supabase clouds go to sleep after a week with no use. Everything is still there.'
          : 'If the internet is working, your free cloud may have gone to sleep after a week with no use. Everything is still there.' }),
        V.h('ol.steps', {}, V.h('li', { text: 'Open supabase.com/dashboard and sign in.' }),
          V.h('li', { text: 'Click your project (it\'s called vault), then press Restore.' }),
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

  V.on('status', (value) => {
    state = value;
    clearTimeout(ringTimer);
    ringing = false;
    if (value === 'syncing') {
      let now = false;
      try { now = sending(); } catch (error) { /* (the ring waits its second) */ }
      if (now) ringing = true;
      else ringTimer = setTimeout(() => { if (status() === 'syncing') { ringing = true; paintAll(); } }, RING_AFTER);
    }
    paintAll();
    countOutgoing();
  });
  // The held count, what's still to go up and the account's devices come with the data; the letter with the person.
  V.on('data', (table) => { if (table === 'settings' || TABLES.includes(table)) paintAll(); });
  V.on('outgoing', countOutgoing);  // (js/send.js: a file queued, sent or taken back)

  return { button, menu, trouble, heldNotes, isOwner, markOf, devicesLine, unsent, RING_AFTER };
})();
