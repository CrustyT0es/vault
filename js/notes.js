/* Vault: the Notes tab. Folders (starter ones for school, work, personal and gaming, and your own), smart lists
   (Pinned, Upcoming: the week by day from js/reminders.js, Archive, Trash), #tags, search with filters, and the list of
   notes as a list or a grid. Opening one hands it to V.editor: beside the list on a wide screen, over everything on a
   phone.

   Picking several notes (a long press with a finger or the S Pen, or Ctrl/Shift+click on the PC) shows a bar to move,
   pin, archive or delete them together; on the PC a card can also be dragged onto a folder. What those do, and what
   the search box understands, is in organise.js.

   Folders inside folders: the PC's side list shows them as a tree (each with a chevron to fold it away, remembered on
   this device; a folder can be dragged onto another, or onto "Folders" for the top), the phone's chips only the top
   ones, and an open folder its own folders above its notes, with the folders it's in above its name. A folder's count
   is every note in it, its own folders' too; opening it lists its own notes. */
'use strict';

V.STARTER_FOLDERS = [['Inbox', '📥'], ['School', '📚'], ['Work', '💼'], ['Personal', '🏠'], ['Gaming', '🎮']];

V.TEMPLATES = [
  { id: 'blank', name: 'Blank note', icon: 'notes', title: '', body: '' },
  { id: 'checklist', name: 'Checklist', icon: 'checklist', title: '', body: '- [ ] ' },
  { id: 'homework', name: 'Homework', icon: 'calendar', folder: 'School', due: 1, title: 'Homework: ',
    body: 'Class: \nWhat to do: \n\n- [ ] ', hint: 'with a due date' },
  { id: 'meeting', name: 'Meeting notes', icon: 'user', folder: 'Work', title: 'Meeting: ',
    body: 'Date: {today}\nWho: \n\nNotes:\n\n\nTo do:\n- [ ] ' },
  { id: 'project', name: 'Project plan', icon: 'bolt', folder: 'Work', title: 'Project: ',
    body: 'Goal: \n\nSteps:\n- [ ] \n\nIdeas:\n' },
  { id: 'journal', name: 'Journal', icon: 'text', folder: 'Personal', title: '{longdate}',
    body: 'How was today?\n\n\nBest part:\n\n\nTomorrow I want to:\n' },
  { id: 'game', name: 'Game notes', icon: 'pc', folder: 'Gaming', title: '',
    body: 'Game: \n\nCodes:\n\nBuilds and loadouts:\n\nTo do:\n- [ ] ' },
  { id: 'shopping', name: 'Shopping list', icon: 'checklist', folder: 'Personal', title: 'Shopping', body: '- [ ] ' },
];

V.notes = (() => {
  const CHECK = /^(\s*)[-*]\s*\[( |x|X)\]\s?(.*)$/;
  const O = V.organise;
  const LONG_PRESS = 450;     // ms a finger or the S Pen stays on a card to start picking
  const DRAG = 'application/x-vault-notes';
  const FOLDER_DRAG = 'application/x-vault-folder';
  let filter = 'all';         // all, pinned, due, archive, trash, tag:<key> or a folder's id
  let query = '';
  let root = null;
  let parts = null;
  let picking = false;        // several notes being picked
  const picked = new Set();
  let anchor = null;          // where a Shift+click range starts
  let press = null;           // a finger on a card: {id, x, y, timer, fired}

  const folders = () => [...V.data.folders.values()].filter((f) => !f.deleted)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  // The notes the lists are made of (templates are kept apart, for the new-note sheet).
  const live = () => [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge && !O.isTemplate(n));
  const listed = () => live().filter((n) => !O.isArchived(n));
  const edited = (n) => n._edited || n.updated_at || n.created_at || '';
  const folderOf = (n) => V.data.folders.get(n.folder_id);
  const inbox = () => folders().find((f) => f.name.toLowerCase() === 'inbox');
  const isTag = (value) => typeof value === 'string' && value.startsWith('tag:');
  const tagKey = (value) => value.slice(4);

  function plain(note) {
    return (note.body || '').split('\n').map((line) => {
      const box = CHECK.exec(line);
      return box ? (box[2] === ' ' ? '○ ' : '● ') + box[3] : line;
    }).join(' ').replace(/\s+/g, ' ').trim();
  }

  function progress(note) {
    let all = 0, done = 0;
    for (const line of (note.body || '').split('\n')) {
      const box = CHECK.exec(line);
      if (box && box[3].trim()) { all++; if (box[2] !== ' ') done++; }
    }
    return all ? { all, done } : null;
  }

  V.noteTitle = (note) => (note.title || '').trim() || (!note.locked && plain(note).slice(0, 60)) || 'Untitled';

  function shown() {
    if (filter === 'trash') {
      return [...V.data.notes.values()].filter((n) => n.deleted && !n._purge)
        .sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
    }
    const q = O.parseQuery(query);
    let list;
    if (!q.empty) {
      // Searching looks through every note (not just this folder); the Archive only with is:archived, or from there.
      const archived = q.is.includes('archived') || filter === 'archive';
      list = live().filter((n) => O.isArchived(n) === archived).filter(O.matcher(q));
    } else if (filter === 'archive') {
      list = live().filter(O.isArchived);
    } else {
      list = listed();
      if (filter === 'pinned') list = list.filter((n) => n.pinned);
      else if (filter === 'due') list = list.filter((n) => (V.reminders ? V.reminders.inUpcoming(n) : n.due && !n.done));
      else if (isTag(filter)) list = list.filter((n) => O.tagsOf(n).some((t) => t.key === tagKey(filter)));
      else if (filter !== 'all') list = list.filter((n) => n.folder_id === filter);
    }
    if (filter === 'due' && q.empty) return list.sort((a, b) => (a.due || '').localeCompare(b.due || ''));
    const order = O.comparator(O.sort());
    return list.sort((a, b) => (b.pinned - a.pinned) || order(a, b));
  }

  /* -- making things */

  async function ensureStarterFolders() {
    if (V.data.folders.size || (await V.db.meta('starter-made'))) return;
    await V.db.meta('starter-made', true);
    let sort = 0;
    for (const [name, icon] of V.STARTER_FOLDERS) {
      await V.cloud.save('folders', { id: V.uuid(), name, icon, sort: sort++, deleted: false, extra: {} });
    }
    const home = inbox();
    await V.cloud.save('notes', blankNote({
      folder_id: home && home.id, pinned: true, title: 'Welcome to Vault',
      body: 'Your notes, on your PC and your phone.\n\n- [ ] Open Vault on your phone (Settings > Connect your phone, on the PC)\n'
        + '- [ ] Send a photo from your phone to the PC (Share > Vault)\n- [ ] Press Ctrl+Alt+N on the PC for a quick note\n'
        + '- [ ] Say "Jarvis, make a note that..."\n\nTick these off as you go, then delete this note.',
    }));
  }

  function blankNote(values = {}) {
    return {
      id: V.uuid(), folder_id: null, title: '', body: '', pinned: false, due: null, done: false, locked: false,
      secret: null, attachments: [], template: '', deleted: false, deleted_at: null, extra: {}, ...values,
    };
  }

  /* A template's {date} (or {today}) as today's date, {longdate} as "Tuesday 27 October". */
  function fill(text) {
    const now = new Date();
    return String(text || '').replace(/\{(?:today|date)\}/gi, now.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))
      .replace(/\{longdate\}/gi, now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }));
  }

  async function create(template = V.TEMPLATES[0], extra = {}) {
    let folderId = filter !== 'all' && V.data.folders.has(filter) ? filter : null;
    const own = template.folderId && V.data.folders.get(template.folderId);
    if (!folderId && own && !own.deleted) folderId = own.id;
    if (!folderId && template.folder) {
      const named = folders().find((f) => f.name.toLowerCase() === template.folder.toLowerCase());
      folderId = named ? named.id : null;
    }
    if (!folderId) folderId = (inbox() || {}).id || null;
    const title = fill(template.title || '');
    let body = fill(template.body || '');
    if (isTag(filter)) {  // made while looking at a tag: it gets the tag, so it's in the list it was made from
      const tag = (O.allTags(live()).find((t) => t.key === tagKey(filter)) || { name: tagKey(filter) }).name;
      if (!O.tagsOf({ title, body }).some((t) => t.key === tagKey(filter))) body += (body.trim() ? '\n\n' : '') + '#' + tag;
    }
    const note = await V.cloud.save('notes', blankNote({
      folder_id: folderId, title, body,
      due: template.due !== undefined ? V.addDays(V.today(), template.due) : null,
      pinned: filter === 'pinned', template: template.id === 'blank' || template.own ? '' : template.id, ...extra,
    }));
    open(note.id, { focusTitle: true });
    return note;
  }

  function chooseTemplate() {
    const here = V.data.folders.get(filter);
    const list = [...V.TEMPLATES].sort((a, b) => {
      const fit = (t) => (here && t.folder && t.folder.toLowerCase() === here.name.toLowerCase() ? 0 : 1);
      return (a.id === 'blank' ? -1 : b.id === 'blank' ? 1 : fit(a) - fit(b));
    });
    let chosen = null;
    const sheet = V.sheet({
      title: here ? `New note in ${here.name}` : 'New note',
      content: [
        V.notetaker ? V.notetaker.sheetEntry(() => sheet.close()) : null,  // js/notetaker.js
        V.h('div.templates', {}, list.map((t) => V.h('button.template', {
          type: 'button', onclick: () => { chosen = t; sheet.close(); },
        }, V.icon(t.icon), V.h('span.t-name', { text: t.name }),
        V.h('span.t-hint', { text: t.hint || (t.folder ? t.folder : '') })))),
        O.templateSection((t) => { chosen = t; sheet.close(); }, () => sheet.close()),
      ],
      onClose: () => { if (chosen) create(chosen).catch(V.problem); },
    });
  }

  /* -- folders */

  async function newFolder() {
    const folder = await O.newFolder();
    if (folder) setFilter(folder.id);
  }

  const folderMenu = (folder, anchorEl) => O.folderMenu(folder, anchorEl, {
    onGone: () => { if (filter === folder.id) setFilter('all'); },
    onMade: (made) => setFilter(made.id),
  });

  /* The folders folded away in the side list (their ids), kept on this device only. */
  const SHUT = 'vault-folders-shut';
  let shut = null;
  function shutSet() {
    if (shut) return shut;
    try {
      const saved = JSON.parse(localStorage.getItem(SHUT) || '[]');
      shut = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
    } catch (error) {
      shut = new Set();
    }
    return shut;
  }
  function setShut(id, on) {
    const set = shutSet();
    if (on) set.add(id);
    else set.delete(id);
    try { localStorage.setItem(SHUT, JSON.stringify([...set].filter((each) => V.data.folders.has(each)))); } catch (error) { /* lasts until the page closes */ }
  }

  /* -- picking several notes */

  const cardEls = () => (parts ? [...parts.list.querySelectorAll('button.card[data-id]')] : []);

  function startPicking() {
    if (picking) return;
    picking = true;
    anchor = null;
    // On a phone the Back button stops picking (instead of leaving Vault).
    if (!V.desktop) history.pushState({ vault: 'select' }, '');
  }

  function stopPicking({ fromHistory = false } = {}) {
    if (!picking) return;
    picking = false;
    picked.clear();
    anchor = null;
    if (!fromHistory && history.state && history.state.vault === 'select') {
      // The step back happens a moment later: a note opened before then waits for it, or the step back would close it.
      backing = { open: null };
      history.back();
      setTimeout(backDone, 600);
    }
    showPicked();
  }

  let backing = null;
  function backDone() {
    if (!backing) return;
    const then = backing.open;
    backing = null;
    // After every other popstate listener (the editor's closes a full-screen note on Back).
    if (then) setTimeout(() => open(...then));
  }

  function toggle(id) {
    if (!picking) startPicking();
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    anchor = id;
    if (!picked.size) stopPicking();
    else showPicked();
  }

  /* Shift+click: every card from the last one picked (or the open note) to this one. */
  function pickRange(id) {
    const order = cardEls().map((el) => el.dataset.id);
    const open = V.editor.openId();
    const from = anchor && order.includes(anchor) ? anchor : open && order.includes(open) ? open : id;
    const [a, b] = [order.indexOf(from), order.indexOf(id)].sort((x, y) => x - y);
    startPicking();
    for (const each of order.slice(a, b + 1)) picked.add(each);
    anchor = from;
    showPicked();
  }

  function pickAll() {
    startPicking();
    for (const el of cardEls()) picked.add(el.dataset.id);
    showPicked();
  }

  /* The picked cards marked where they are (nothing redrawn, so a finger still on a card stays on it), and the bar. */
  function showPicked() {
    if (!parts) return;
    parts.layout.classList.toggle('selecting', picking);
    parts.list.classList.toggle('picking', picking);
    parts.fab.hidden = picking;
    for (const el of cardEls()) {
      el.classList.toggle('selected', picked.has(el.dataset.id));
      if (picking) el.setAttribute('aria-pressed', String(picked.has(el.dataset.id)));
      else el.removeAttribute('aria-pressed');
    }
    drawPickBar();
  }

  function drawPickBar() {
    const bar = parts.pickBar;
    if (!picking) { bar.hidden = true; V.clear(bar); return; }
    const ids = [...picked];
    const rows = ids.map((id) => V.data.notes.get(id)).filter(Boolean);
    const allPinned = rows.length > 0 && rows.every((n) => n.pinned);
    const allArchived = rows.length > 0 && rows.every(O.isArchived);
    const everything = cardEls().every((el) => picked.has(el.dataset.id));
    const act = (icon, label, run, cls = '') => V.h('button.pick-action' + (cls ? '.' + cls : ''), {
      type: 'button', onclick: () => run(ids).catch(V.problem),
    }, V.icon(icon), V.h('span', { text: label }));
    const done = (fn) => async (list) => { stopPicking(); await fn(list); };
    bar.hidden = false;
    V.clear(bar,
      V.h('div.pick-top', {},
        V.iconButton('x', 'Stop picking (Esc)', () => stopPicking(), 'quiet'),
        V.h('span.pick-count', { text: `${ids.length} picked` }),
        everything ? null : V.h('button.link-btn.pick-all', { type: 'button', onclick: pickAll, text: 'Pick all' })),
      V.h('div.pick-actions', {},
        act('folder-move', 'Move to', async (list) => {
          const folder = await O.chooseFolder({ title: list.length === 1 ? 'Move to' : `Move ${list.length} notes to` });
          if (folder) await done((l) => O.move(l, folder.id))(list);
        }),
        filter === 'archive' ? null : act(allPinned ? 'pin-on' : 'pin', allPinned ? 'Unpin' : 'Pin', done((l) => O.pin(l, !allPinned))),
        act('archive', allArchived ? 'Unarchive' : 'Archive', done((l) => O.archive(l, !allArchived))),
        act('trash', 'Delete', done((l) => O.trash(l)), 'danger')));
  }

  window.addEventListener('popstate', () => {
    if (picking && !(history.state && history.state.vault === 'select')) stopPicking({ fromHistory: true });
    backDone();
  });

  /* A finger or the S Pen held on a card picks it (the first one starts picking); a mouse uses Ctrl/Shift+click. */
  function pressStart(event, id) {
    press = null;
    if (event.pointerType === 'mouse' || !event.isPrimary || filter === 'trash') return;
    const mine = { id, x: event.clientX, y: event.clientY, fired: false };
    mine.timer = setTimeout(() => {
      if (press !== mine) return;
      mine.fired = true;
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (error) { /* no buzz, no matter */ }
      toggle(id);
    }, LONG_PRESS);
    press = mine;
  }
  function pressMove(event) {
    if (press && !press.fired && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
      clearTimeout(press.timer);
      press = null;  // it's a scroll
    }
  }
  function pressEnd() {
    if (!press) return;
    clearTimeout(press.timer);
    const was = press;
    if (!was.fired) { press = null; return; }
    setTimeout(() => { if (press === was) press = null; }, 400);  // the click right after a long press is its own
  }

  function cardClick(event, note) {
    if (press && press.fired) {
      const was = press.id;
      press = null;
      if (was === note.id) return;
    }
    if (filter === 'trash') return trashMenu(note);
    if (event.shiftKey) return pickRange(note.id);
    if (picking || event.ctrlKey || event.metaKey) return toggle(note.id);
    open(note.id);
  }

  function cardContext(event, note) {
    event.preventDefault();
    if (filter === 'trash') return;
    if (press && press.fired) return;  // the long press has picked it already
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      // The phone's own long press came first: it's the one that picks (the timer doesn't as well).
      if (press) clearTimeout(press.timer);
      press = { id: note.id, fired: true };  // (let go of when the finger lifts: pressEnd)
      toggle(note.id);
      return;
    }
    // A right-click on the PC: what can be done with this note.
    const at = event.clientX || event.clientY  // (the keyboard's menu key: by the card itself)
      ? { getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }) }
      : event.currentTarget;
    const archived = O.isArchived(note);
    V.menu(at, [
      { label: 'Open', icon: 'open', onClick: () => open(note.id) },
      { label: 'Pick', icon: 'select', onClick: () => { if (!picked.has(note.id)) toggle(note.id); } },
      { label: 'Move to...', icon: 'folder-move', onClick: async () => {
        const folder = await O.chooseFolder({ current: note.folder_id });
        if (folder) await O.move([note.id], folder.id);
      } },
      archived ? null : { label: note.pinned ? 'Unpin' : 'Pin to the top', icon: note.pinned ? 'pin-on' : 'pin', onClick: () => O.pin([note.id], !note.pinned) },
      { label: archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => O.archive([note.id], !archived) },
      { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => O.trash([note.id]) },
    ]);
  }

  /* -- dragging cards onto a folder (the PC) */

  let dragSince = 0;  // when the card or folder being dragged was picked up
  const canDrag = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const dragging = (event, type = DRAG) => !!event.dataTransfer && [...event.dataTransfer.types].includes(type);

  function dragStart(event, id) {
    const ids = picking && picked.has(id) ? [...picked] : [id];
    event.dataTransfer.setData(DRAG, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
    document.documentElement.classList.add('dragging-notes');
    dragSince = Date.now();
  }
  function dragEnd() {
    document.documentElement.classList.remove('dragging-notes');
    for (const el of document.querySelectorAll('.drop-on')) el.classList.remove('drop-on');
  }

  /* A folder in the side list dragged (onto another folder, or onto "Folders" for the top level). */
  function folderDragStart(event, id) {
    event.dataTransfer.setData(FOLDER_DRAG, id);
    event.dataTransfer.effectAllowed = 'move';
    document.documentElement.classList.add('dragging-notes');
    dragSince = Date.now();
  }

  /* `el` takes dropped cards: a folder moves them there; Pinned pins, Archive archives and Trash deletes them. A folder
     (or 'top', the top level) takes dropped folders too. */
  function dropTarget(el, target) {
    const folderish = target === 'top' || V.data.folders.has(target);
    if (!['pinned', 'archive', 'trash'].includes(target) && !folderish) return el;
    const takes = (event) => (target !== 'top' && dragging(event)) || (folderish && dragging(event, FOLDER_DRAG));
    el.addEventListener('dragover', (event) => {
      if (!takes(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-on');
    });
    el.addEventListener('dragleave', (event) => { if (!el.contains(event.relatedTarget)) el.classList.remove('drop-on'); });
    el.addEventListener('drop', (event) => {
      if (!takes(event)) return;
      event.preventDefault();
      dragEnd();
      if (dragging(event, FOLDER_DRAG)) {
        const moving = V.data.folders.get(event.dataTransfer.getData(FOLDER_DRAG));
        if (moving && moving.id !== target) O.moveFolder(moving, target === 'top' ? null : target).catch(V.problem);
        else if (moving) V.toast(O.cantMove(moving, moving), { kind: 'err' });
        return;
      }
      let ids = [];
      try { ids = JSON.parse(event.dataTransfer.getData(DRAG)); } catch (error) { return; }
      ids = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && V.data.notes.has(id));
      if (!ids.length) return;
      stopPicking();
      const run = target === 'pinned' ? O.pin(ids, true) : target === 'archive' ? O.archive(ids, true)
        : target === 'trash' ? O.trash(ids) : O.move(ids, target);
      run.catch(V.problem);
    });
    return el;
  }

  /* -- drawing */

  function setFilter(value) {
    stopPicking();
    filter = value;
    const folder = V.data.folders.get(value);
    if (folder) for (const up of O.ancestors(folder)) if (shutSet().has(up.id)) setShut(up.id, false);  // so it shows
    query = '';
    if (parts) parts.search.value = '';
    draw();
  }

  function tagLabel(key) {
    const tag = O.allTags(live()).find((t) => t.key === key);
    return '#' + (tag ? tag.name : key);
  }

  function filterTitle() {
    if (query) return 'Search';
    if (filter === 'all') return 'All notes';
    if (filter === 'pinned') return 'Pinned';
    if (filter === 'due') return 'Upcoming';
    if (filter === 'archive') return 'Archive';
    if (filter === 'trash') return 'Trash';
    if (isTag(filter)) return tagLabel(tagKey(filter));
    const f = V.data.folders.get(filter);
    return f ? f.name : 'All notes';
  }

  /* How many notes each folder has (with its own folders' notes), and in the smart lists. */
  function counts() {
    const all = listed();
    const own = {};
    for (const n of all) own[n.folder_id] = (own[n.folder_id] || 0) + 1;
    const by = {};
    for (const f of folders()) by[f.id] = [f.id, ...O.inside(f.id)].reduce((sum, id) => sum + (own[id] || 0), 0);
    const due = (n) => (V.reminders ? V.reminders.pending(n) : n.due && !n.done);
    return { all: all.length, pinned: all.filter((n) => n.pinned).length, due: all.filter(due).length, by };
  }

  /* A folder shows its emoji; one without gets a colour dot (by its place in the list), unless its name starts with
     an emoji of its own. */
  const DOTS = ['slate', 'sky', 'amber', 'green', 'coral', 'teal', 'rose'];
  const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;
  function folderBadge(folder, boxed) {
    if (folder.icon) return V.h('span.emoji', { text: folder.icon });
    if (STARTS_WITH_EMOJI.test(folder.name)) return null;
    const dot = V.h('i.dot.' + DOTS[Math.max(0, folders().indexOf(folder)) % DOTS.length]);
    return boxed ? V.h('span.dot-box', {}, dot) : dot;
  }

  function navItem(id, icon, label, count) {
    const folder = V.data.folders.get(id);
    const drags = !!folder && !O.isInbox(folder) && canDrag();
    return dropTarget(V.h('button.nav-item' + (filter === id && !query ? '.on' : ''), {
      type: 'button', onclick: () => setFilter(id), dataset: { id },
      oncontextmenu: folder ? (event) => { event.preventDefault(); folderMenu(folder, event.currentTarget); } : null,
      draggable: drags ? 'true' : null,
      ondragstart: drags ? (event) => folderDragStart(event, id) : null,
      ondragend: drags ? dragEnd : null,
    }, folder ? folderBadge(folder, true) : V.icon(icon), V.h('span.nav-label', { text: label }),
    count ? V.h('span.count', { text: String(count) }) : null), id);
  }

  function drawFolders() {
    const c = counts();
    const tags = O.allTags(listed());
    const tree = O.tree();
    const nested = tree.some((r) => r.depth > 0);
    parts.folders.classList.toggle('nested', nested);
    const list = [
      navItem('all', 'stack', 'All notes', c.all),
      navItem('pinned', 'pin', 'Pinned', c.pinned),
      navItem('due', 'clock', 'Upcoming', c.due),
      dropTarget(V.h('div.nav-heading', {}, V.h('span', { text: 'Folders' }), V.iconButton('plus', 'New folder', newFolder, 'tiny')), 'top'),
      tree.filter((r) => !O.ancestors(r.folder).some((up) => shutSet().has(up.id))).map(({ folder: f, depth, kids }) => {
        const unfolded = !shutSet().has(f.id);
        const say = `${unfolded ? 'Hide' : 'Show'} the folders in ${f.name}`;
        return V.h('div.folder-row', { dataset: { depth: String(Math.min(depth, 4)) } },
          nested && kids ? V.h('button.twist', {
            type: 'button', 'aria-expanded': String(unfolded), title: say, 'aria-label': say,
            onclick: () => { setShut(f.id, unfolded); drawFolders(); },
          }, V.icon('next')) : nested ? V.h('span.twist-space') : null,
          navItem(f.id, 'folder', f.name, c.by[f.id]),
          V.iconButton('more', `${f.name} options`, (event) => folderMenu(f, event.currentTarget), 'tiny folder-more'));
      }),
      tags.length ? [V.h('div.nav-heading', {}, V.h('span', { text: 'Tags' })),
        tags.map((t) => navItem('tag:' + t.key, 'hash', t.name, t.count))] : null,
      V.h('div.nav-spacer'),
      navItem('archive', 'archive', 'Archive', 0),
      navItem('trash', 'trash', 'Trash', 0),
    ];
    V.clear(parts.folders, list);
    // The phone's folder chips (and a narrow window's): the same choices in a row, with only the top folders (the one
    // a folder's in is marked when it's open).
    const here = V.data.folders.get(filter);
    const top = here ? (O.ancestors(here)[0] || here).id : filter;
    const chip = (id, label, lead, count) => dropTarget(V.h('button.chip' + (top === id && !query ? '.on' : ''), {
      type: 'button', onclick: () => setFilter(id), dataset: { id },
      oncontextmenu: V.data.folders.has(id) ? (event) => { event.preventDefault(); folderMenu(V.data.folders.get(id), event.currentTarget); } : null,
    }, lead, label, count ? V.h('span.count', { text: String(count) }) : null), id);
    V.clear(parts.chips,
      chip('all', 'All', null, c.all),
      chip('pinned', 'Pinned', V.icon('pin')),
      chip('due', 'Upcoming', V.icon('clock'), c.due),
      tree.filter((r) => !r.depth).map(({ folder: f }) => chip(f.id, f.name, folderBadge(f))),
      V.h('button.chip.add', { type: 'button', onclick: newFolder, title: 'New folder' }, V.icon('plus'), 'New folder'),
      tags.map((t) => chip('tag:' + t.key, '#' + t.name, null)),
      chip('archive', 'Archive', V.icon('archive')),
      chip('trash', 'Trash', V.icon('trash')));
    const on = parts.chips.querySelector('.chip.on');
    if (on && parts.chips.offsetParent) {  // only on the phone, where the chips show
      const left = on.offsetLeft - parts.chips.offsetLeft;
      if (left < parts.chips.scrollLeft || left + on.offsetWidth > parts.chips.scrollLeft + parts.chips.clientWidth) {
        parts.chips.scrollLeft = Math.max(0, left - 14);
      }
    }
  }

  /* "Due today" on a card is just "Today" beside its calendar. */
  const shortDue = (label) => { const words = label.replace(/^Due /, ''); return words[0].toUpperCase() + words.slice(1); };

  function card(note, look) {
    const folder = folderOf(note);
    const due = V.due(note.due, note.done);
    const prog = note.locked ? null : progress(note);
    const pictures = (note.attachments || []).length;
    const showFolder = filter === 'all' || filter === 'pinned' || filter === 'due' || filter === 'archive' || isTag(filter) || query;
    const words = note.locked ? '' : plain(note);
    const titled = !!(note.title || '').trim();
    // Searching: the words round the first match, when they're further in than the start shows.
    const around = look.terms.length ? O.snippet(words, look.terms, look.size) : words.slice(0, look.size);
    const snippet = titled || around.startsWith('…') ? around : '';
    const tags = O.tagsOf(note);
    return V.h('button.card' + (V.editor.openId() === note.id ? '.open' : '') + (note.done ? '.done' : '')
      + (picked.has(note.id) ? '.selected' : ''), {
      type: 'button', dataset: { id: note.id },
      'aria-pressed': picking ? String(picked.has(note.id)) : null,
      draggable: look.drag ? 'true' : null,
      onclick: (event) => cardClick(event, note),
      oncontextmenu: (event) => cardContext(event, note),
      onpointerdown: (event) => pressStart(event, note.id),
      onpointermove: pressMove,
      onpointerup: pressEnd,
      onpointercancel: pressEnd,
      ondragstart: (event) => dragStart(event, note.id),
      ondragend: dragEnd,
    },
    V.h('div.card-top', {},
      V.h('span.pick', { 'aria-hidden': 'true' }, V.icon('check')),
      V.h('span.card-title', {}, O.marked(V.noteTitle(note), look.terms)),
      note.pinned ? V.icon('pin-on', 'pinned') : null),
    note.locked ? V.h('div.card-snippet.locked', {}, V.icon('lock'), V.h('span', { text: 'Locked: open it with your PIN' }))
      : snippet ? V.h('div.card-snippet', {}, O.marked(snippet, look.terms)) : null,
    V.h('div.card-meta', {},
      showFolder && folder ? V.h('span.tag', {}, folderBadge(folder), V.h('span', { text: folder.name })) : null,
      O.isTemplate(note) ? V.h('span.tag', {}, V.icon('notes'), V.h('span', { text: 'Template' })) : null,
      due ? V.h('span.due.' + (due.cls || 'later'), {}, V.icon(due.cls === 'done' ? 'check' : 'calendar'), shortDue(due.label)) : null,
      V.reminders ? V.reminders.cardChip(note) : null,
      prog ? V.h('span.progress', {}, V.h('span.bar', {}, V.h('i', { style: { width: (100 * prog.done / prog.all) + '%' } })),
        V.h('span', { text: `${prog.done}/${prog.all}` })) : null,
      pictures ? V.h('span.tag', {}, V.icon('image'), String(pictures)) : null,
      look.terms.length && V.attachSearch ? V.attachSearch.chip(note, look.terms) : null,  // "in a photo" / "in a PDF"
      tags.length ? V.h('span.note-tags', {}, tags.slice(0, 3).map((t) => V.h('span.note-tag', {}, O.marked('#' + t.name, look.terms))),
        tags.length > 3 ? V.h('span.note-tag.more', { text: `+${tags.length - 3}` }) : null) : null,
      V.h('span.when', { text: filter === 'trash' ? 'Deleted ' + V.ago(note.deleted_at) : V.ago(edited(note)) })));
  }

  function trashMenu(note) {
    V.sheet({
      title: V.noteTitle(note),
      content: V.h('p', { text: 'This note is in the Trash. It\'s deleted for good 30 days after it was put there.' }),
      actions: [
        { label: 'Delete forever', kind: 'danger', onClick: async () => { await V.cloud.purgeNote(note); V.toast('Deleted for good'); } },
        { label: 'Put it back', kind: 'primary', onClick: async () => {
          await V.cloud.save('notes', { ...note, deleted: false, deleted_at: null });
          V.toast('Put back');
        } },
      ],
    });
  }

  /* All notes, not searching: what's pinned, then (newest first) what's due in the coming week, then the rest. */
  function sections(list, make) {
    if (filter !== 'all' || query) return null;
    const pinned = list.filter((n) => n.pinned);
    const soon = O.sort() !== 'edited' ? [] : list.filter((n) => !n.pinned && n.due && !n.done && V.due(n.due).days <= 7)
      .sort((a, b) => a.due.localeCompare(b.due));
    if (!pinned.length && !soon.length) return null;
    const rest = list.filter((n) => !n.pinned && !soon.includes(n));
    const part = (title, notes, fold = false) => (notes.length ? [V.h('h2.list-section', {}, V.h('span', { text: title }),
      V.h('span.count', { text: String(notes.length) })), fold ? folded(notes, make) : notes.map(make)] : null);
    return [part('Pinned', pinned), part('Due soon', soon), part('Other notes', rest, true)];
  }

  /* A long list shows its first few notes, then folds the rest away by age (by "More notes" when sorted another way):
     a tap opens one, and it stays open on this device. Searching shows everything. */
  const FEW = 6;
  const AGES = [['week', 'Past week', 7], ['month', 'Past month', 31], ['older', 'Older', Infinity]];
  const OPEN_KEY = 'vault-list-open';

  function openFolds() {
    try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch (error) { return new Set(); }
  }

  function setFold(key, on) {
    const keys = openFolds();
    if (on) keys.add(key); else keys.delete(key);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...keys])); } catch (error) { /* a private window */ }
  }

  function folded(notes, make) {
    if (query || filter === 'trash' || notes.length <= FEW + 3) return notes.map(make);
    const more = notes.slice(FEW);
    let groups = [['more', 'More notes', more]];
    if (O.sort() === 'edited') {
      const now = Date.now();
      groups = AGES.map(([key, title]) => [key, title, []]);
      for (const n of more) {
        const days = (now - (Date.parse(edited(n)) || 0)) / 86400000;
        groups[AGES.findIndex(([, , most]) => days <= most)][2].push(n);
      }
      groups = groups.filter(([, , list]) => list.length);
    }
    const open = openFolds();
    return [notes.slice(0, FEW).map(make), groups.map(([key, title, list]) => {
      const shown = open.has(key);
      const box = V.h('div.fold-notes', { hidden: !shown, dataset: { fold: key } }, shown ? list.map(make) : null);
      const head = V.h('button.list-fold', {
        type: 'button', 'aria-expanded': String(shown), onclick: () => {
          const now = head.getAttribute('aria-expanded') !== 'true';
          head.setAttribute('aria-expanded', String(now));
          if (now && !box.childElementCount) V.clear(box, list.map(make));  // drawn the first time it opens
          box.hidden = !now;
          setFold(key, now);
          showPicked();
        },
      }, V.icon('next', 'fold-twist'), V.h('span', { text: title }), V.h('span.count', { text: String(list.length) }));
      return [head, box];
    })];
  }

  function drawList() {
    const list = shown();
    const q = O.parseQuery(query);
    const grid = O.view() === 'grid';
    parts.heading.textContent = filterTitle();
    parts.headCount.textContent = list.length ? String(list.length) : '';
    parts.layout.classList.toggle('grid-view', grid);
    parts.list.classList.toggle('grid', grid);
    const folder = V.data.folders.get(filter);
    // In a folder that's in another: a way up, and the folders it's in (each opens), above its name.
    const above = folder && !query ? O.ancestors(folder) : [];
    const up = above[above.length - 1];
    V.clear(parts.crumbs, up ? V.iconButton('back', `Up to ${up.name}`, () => setFilter(up.id), 'quiet folder-up') : null,
      above.map((f, i) => [i ? V.h('span.crumb-gap', { text: '›', 'aria-hidden': 'true' }) : null,
        V.h('button.crumb', { type: 'button', onclick: () => setFilter(f.id) }, folderBadge(f), V.h('span', { text: f.name }))]));
    parts.crumbs.hidden = !above.length;
    V.clear(parts.titleTools,
      folder && !query ? V.iconButton('more', `${folder.name} options`, (event) => folderMenu(folder, event.currentTarget), 'folder-options') : null,
      V.iconButton('sort', 'Sort notes', (event) => sortMenu(event.currentTarget)),
      V.iconButton(grid ? 'rows' : 'grid', grid ? 'Show as a list' : 'Show as a grid', () => {
        O.setView(grid ? 'list' : 'grid');
        draw();
      }));
    const empty = () => {
      const say = (text, ...more) => V.h('div.empty', {}, V.mark(40), V.h('p', { text }), more);
      if (query) {
        const { missing } = O.foldersFor(q);
        return say(missing ? `No folder is called "${missing}".` : `Nothing matches "${query}".`);
      }
      if (filter === 'trash') return say('The Trash is empty.');
      if (filter === 'due') return say('Nothing coming up. Type a day in a note, like "test fri 9am", or give it a due date.');
      if (filter === 'pinned') return say('Pin a note to keep it at the top.');
      if (filter === 'archive') return say('Nothing archived. Archive notes you\'re done with: they leave your lists but stay here, and in search with is:archived.');
      if (isTag(filter)) return say(`No notes have ${tagLabel(tagKey(filter))} any more.`);
      return say('No notes here yet.', V.button('New note', { kind: 'primary', icon: 'plus', onClick: chooseTemplate }));
    };
    const trashBar = filter === 'trash' && list.length ? V.h('div.list-bar', {}, V.button('Empty the Trash', {
      kind: 'danger-quiet', icon: 'trash', onClick: async () => {
        if (!(await V.confirm('Empty the Trash?', `${list.length} note${list.length > 1 ? 's' : ''} will be deleted for good.`, { ok: 'Delete them', danger: true }))) return;
        for (const note of list) await V.cloud.purgeNote(note);
      },
    })) : null;
    const look = { terms: O.terms(q), size: grid ? 280 : 160, drag: canDrag() && filter !== 'trash' };
    const make = (note) => card(note, look);
    if (V.study && filter !== 'trash') V.study.resetDue(list);  // repeating checklists whose day has turned over
    // Upcoming: by day (Overdue, Today, Tomorrow, the weekdays, Later), each with a tick and its day to move it.
    const byDay = filter === 'due' && q.empty && V.reminders ? V.reminders.upcoming(list, make) : null;
    parts.list.classList.toggle('upcoming', !!byDay);
    // An open folder's own folders come first, as rows that open them (and take dropped notes and folders).
    const subs = folder && !query ? O.children(folder.id) : [];
    const c = subs.length ? counts() : null;
    const subRows = subs.length ? [
      V.h('h2.list-section', {}, V.h('span', { text: 'Folders' }), V.h('span.count', { text: String(subs.length) })),
      V.h('div.subfolders', {}, subs.map((f) => {
        const notes = c.by[f.id] || 0;
        const kids = O.children(f.id).length;
        const what = [notes ? `${notes} note${notes === 1 ? '' : 's'}` : '', kids ? `${kids} folder${kids === 1 ? '' : 's'}` : '']
          .filter(Boolean).join(' · ') || 'Empty';
        return dropTarget(V.h('button.subfolder', {
          type: 'button', dataset: { id: f.id }, onclick: () => setFilter(f.id),
          oncontextmenu: (event) => { event.preventDefault(); folderMenu(f, event.currentTarget); },
        }, V.h('span.fc-badge', {}, folderBadge(f) || V.icon('folder')), V.h('span.sf-name', { text: f.name }),
        V.h('span.sf-meta', { text: what }), V.icon('next', 'sf-go')), f.id);
      })),
      list.length ? V.h('h2.list-section', {}, V.h('span', { text: 'Notes' }), V.h('span.count', { text: String(list.length) })) : null,
    ] : null;
    const none = list.length ? null : empty();
    if (none && subRows) none.classList.add('small');  // under its folders, a quieter "nothing here"
    V.clear(parts.list, trashBar, subRows, list.length ? byDay || sections(list, make) || folded(list, make) : none);
    // Picked notes that have gone (deleted on the other device, or no longer in this list) aren't picked any more.
    const here = new Set(list.map((n) => n.id));
    for (const id of picked) if (!here.has(id)) picked.delete(id);
    if (picking && !picked.size) stopPicking();
    else showPicked();
  }

  function sortMenu(anchorEl) {
    const now = O.sort();
    const grid = O.view() === 'grid';
    V.menu(anchorEl, [
      ...O.SORTS.map(([id, label]) => ({ label, icon: now === id ? 'check' : 'blank', onClick: () => { O.setSort(id); draw(); } })),
      { label: grid ? 'Show as a list' : 'Show as a grid', icon: grid ? 'rows' : 'grid', onClick: () => { O.setView(grid ? 'list' : 'grid'); draw(); } },
    ]);
  }

  /* The filters the search box knows, as buttons that type them in (the keyboard stays up). */
  function drawHelp() {
    const folder = V.data.folders.get(filter);
    const inName = folder ? (/\s/.test(folder.name) ? `in:"${folder.name}"` : `in:${folder.name}`) : 'in:';
    const pill = (label, token) => V.h('button.filter-pill', {
      type: 'button', title: `Add ${label} to the search`,
      onmousedown: (event) => event.preventDefault(),
      onclick: () => addFilter(token),
    }, label);
    V.clear(parts.help, V.h('span.help-word', { text: 'Filters' }),
      pill('#tag', '#'), pill(folder ? inName : 'in:folder', inName), pill('has:checklist', 'has:checklist'),
      pill('has:picture', 'has:picture'), pill('due:week', 'due:week'), pill('due:late', 'due:late'),
      pill('is:pinned', 'is:pinned'), pill('is:archived', 'is:archived'));
  }

  function addFilter(token) {
    const search = parts.search;
    const before = search.value.replace(/\s+$/, '');
    if (before.split(/\s+/).includes(token)) return;
    search.value = (before ? before + ' ' : '') + token + (/[:#]$/.test(token) ? '' : ' ');
    search.focus({ preventScroll: true });
    search.setSelectionRange(search.value.length, search.value.length);
    query = search.value.trim();
    stopPicking();
    draw();
    showHelp();
  }

  /* The filters show while the search box is being used (and are only there then). */
  let helpTimer = null;
  function showHelp() {
    clearTimeout(helpTimer);
    if (!parts) return;
    const on = document.activeElement === parts.search || !!parts.search.value.trim();
    parts.help.hidden = !on;
    if (on) drawHelp();
    else V.clear(parts.help);
  }

  const SMART = ['all', 'pinned', 'due', 'archive', 'trash'];
  function draw() {
    if (!parts) return;
    const folder = V.data.folders.get(filter);
    if (!SMART.includes(filter) && !isTag(filter) && (!folder || folder.deleted)) filter = 'all';  // deleted elsewhere
    drawFolders();
    if (!parts.help.hidden) drawHelp();
    drawList();
  }

  function open(id, opts = {}) {
    if (backing) { backing.open = [id, opts]; return; }
    if (V.wide()) V.editor.open(id, { pane: parts.pane, ...opts });
    else V.editor.open(id, opts);
    for (const el of parts.list.querySelectorAll('.card')) el.classList.toggle('open', el.dataset.id === id);
  }

  function render(container) {
    stopPicking();
    root = container;
    const search = V.h('input.search', {
      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', value: query, enterkeyhint: 'search',
      oninput: V.debounce(() => { query = search.value.trim(); draw(); showHelp(); }, 120),
      onkeydown: (event) => { if (event.key === 'Escape') { search.value = ''; query = ''; draw(); showHelp(); } },
      onfocus: showHelp,
      // Hidden a moment later, so a tap on a card that blurs the box lands before the list moves up.
      onblur: () => { clearTimeout(helpTimer); helpTimer = setTimeout(showHelp, 300); },
    });
    parts = {
      search,
      folders: V.h('nav.folders', { 'aria-label': 'Folders' }),
      chips: V.h('div.chips', { role: 'tablist' }),
      help: V.h('div.search-help', { hidden: true }),
      heading: V.h('h1'),
      crumbs: V.h('nav.crumbs', { 'aria-label': 'The folders this one is in', hidden: true }),
      headCount: V.h('span.head-count'),
      titleTools: V.h('div.list-tools'),
      list: V.h('div.list'),
      pane: V.h('section.pane'),
      pickBar: V.h('div.pick-bar', { role: 'toolbar', 'aria-label': 'Picked notes', hidden: true }),
      fab: V.h('button.fab', { type: 'button', onclick: chooseTemplate, 'aria-label': 'New note' }, V.icon('plus')),
    };
    const listColumn = V.h('section.list-column', {},
      V.h('div.list-head', {},
        V.h('div.search-box', {}, V.icon('search'), search, V.h('kbd.search-hint', { text: 'Ctrl F' })),
        V.button('New note', { kind: 'primary new-note', icon: 'plus', onClick: chooseTemplate, title: V.appShortcuts ? 'New note (Ctrl+N)' : 'New note' })),
      parts.help,
      parts.chips,
      parts.crumbs,
      V.h('div.list-title', {}, parts.heading, parts.headCount, parts.titleTools, V.statusPill()),
      parts.list);
    parts.layout = V.h('div.notes-layout', {}, parts.folders, listColumn, parts.pane, parts.pickBar);
    V.clear(container, parts.layout, parts.fab);
    draw();
    showHelp();
    V.editor.placeholder(parts.pane);
    const opened = V.editor.openId();
    if (opened && V.wide()) V.editor.open(opened, { pane: parts.pane });
  }

  /* The window crossed the wide/narrow line (a PC window snapped to half the screen, a Chromebook's resized): an open
     note goes between the side pane and the full-screen layer as it is (words, caret and all), and the list is drawn
     again for the other layout. */
  V.onWide((wide) => {
    if (!showing()) return;
    if (V.editor.openId()) V.editor.move(wide ? parts.pane : null);
    else if (wide) V.editor.placeholder(parts.pane);
    draw();
  });

  const showing = () => !!root && root.isConnected && root.dataset.tab === 'notes' && !!parts && root.contains(parts.list);
  // Behind the phone's full-screen note there's nothing to redraw (it's redrawn as the note closes); while a card or a
  // folder is being dragged, not until it's dropped (a sync landing then would take it from under the mouse).
  const redraw = V.debounce(() => {
    if (document.documentElement.classList.contains('dragging-notes') && Date.now() - dragSince < 20000) return redraw();
    if (showing() && !V.editor.covering()) draw();
  }, 60);
  V.on('data', (table) => { if (table === 'notes' || table === 'folders') redraw(); });
  V.on('attach-index', redraw);  // the attachment search index arrived (js/attachsearch.js): matches may change
  const typing = (target) => !!target && (target.matches('input, textarea, select') || target.isContentEditable);
  document.addEventListener('keydown', (event) => {
    if (!showing()) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (picking && !V.editor.covering() && !document.querySelector('#layers > .layer:not(.leaving)')) {
      if (event.key === 'Escape') { event.preventDefault(); stopPicking(); return; }
      if (ctrl && event.key.toLowerCase() === 'a' && !typing(event.target)) { event.preventDefault(); pickAll(); return; }
      if (event.key === 'Delete' && !typing(event.target)) {
        event.preventDefault();
        const ids = [...picked];
        stopPicking();
        O.trash(ids).catch(V.problem);
        return;
      }
    }
    if (ctrl && event.key.toLowerCase() === 'n' && !event.shiftKey) {
      event.preventDefault();
      stopPicking();
      chooseTemplate();
    }
    if (ctrl && event.key.toLowerCase() === 'f' && parts) {
      event.preventDefault();
      parts.search.focus();
    }
  });

  return { render, create, chooseTemplate, ensureStarterFolders, blankNote, open, folders, inbox, setFilter, plain,
    folderBadge, picking: () => picking };
})();
