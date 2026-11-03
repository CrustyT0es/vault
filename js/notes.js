/* Vault: the Notes tab. Folders (starter ones for school, work, personal and gaming, and your own), smart lists
   (Pinned, Upcoming: the week by day from js/reminders.js, Review: the flash cards due today from js/review.js,
   Archive, Trash), #tags, search with filters, and the list of notes as a list or a grid. Opening one hands it to
   V.editor: beside the list on a wide screen, over everything on a phone.

   A phone's top row (1.16) is the list's name, a magnifier (which turns the row into the search box, with "Try"
   buttons under it), a ⋯ (Select notes, Sort, View and an open folder's options) and your picture; wide, the search
   box, New note, sort, grid and Select stay in sight.

   Picking several notes (the Select button by the list's name on the PC, Select notes in the ⋯ on a phone; a long press
   with a finger or the S Pen; Ctrl/Shift+click on the PC) shows a round tick on every card and a bar to move, pin,
   archive or delete them together (in the Trash: put back or delete for good). A card can also be dragged onto a
   folder (1.17, js/drag.js: a mouse at once, a finger after the long press that picks it). The Select button starts
   with nothing picked and stays on until the X, Esc, Back or an action; picking started any other way stops when the
   last one is unpicked, as before. "Pick all" takes every note in the
   list, the ones folded away under "Past week" or "Older" too (their fold says how many). What those do, and what
   the search box understands, is in organise.js.

   Folders inside folders: the PC's side list shows them as a tree (each with a chevron to fold it away, remembered on
   this device), the phone's chips only the top ones (⋯ > Arrange folders has them all), and an open folder its own
   folders above its notes, with the folders it's in above its name. A folder's count is every note in it, its own
   folders' too; opening it lists its own notes. Folders are dragged (1.17) between two to put them in order, onto
   another to go inside it, or onto "Folders" or All for the top level, wherever they're drawn. */
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
  let filter = 'all';         // all, pinned, due, review, archive, trash, tag:<key> or a folder's id
  let query = '';
  let searchOpen = false;     // a phone's search row in place of the title row (the magnifier; Ctrl+F)
  let root = null;
  let parts = null;
  let picking = false;        // several notes being picked
  let held = false;           // ...started with the Select button: it stays on with nothing picked
  const picked = new Set();
  let listIds = [];           // every note in the list shown, in order (the ones folded away too)
  let anchor = null;          // where a Shift+click range starts
  let moveTo = null;          // an empty folder's "Move notes here": the folder the pick bar's Move goes straight to

  const folders = () => [...V.data.folders.values()].filter((f) => !f.deleted)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  // The notes the lists are made of (templates are kept apart, for the new-note sheet).
  const live = () => [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge && !O.isTemplate(n));
  const listed = () => live().filter((n) => !O.isArchived(n));
  const trashed = () => [...V.data.notes.values()].filter((n) => n.deleted && !n._purge);
  const edited = (n) => V.editedAt(n);  // (a flash card's progress isn't an edit: js/cloud.js)
  const folderOf = (n) => V.data.folders.get(n.folder_id);
  const inbox = () => folders().find((f) => f.name.toLowerCase() === 'inbox');
  const isTag = (value) => typeof value === 'string' && value.startsWith('tag:');
  const tagKey = (value) => value.slice(4);

  /* A note's words for its card (and an untitled note's title), as words, never as the way they're written: one line,
     without the marks of bold, italic, underline, strikethrough or highlight (js/format.js: unmark), without a
     heading's #, a list's - or *, a quote's >, `code` ticks, the ``` lines, --- rules or a {{blank}}'s braces; a flash
     card's "q :: a" as "q → a"; lines run together with " · " where one doesn't end a sentence ("Summary · Plants make
     their own food..."). Tick boxes are ○ and ● here (a card draws them as boxes: boxed()); a title has none. Kept with
     each note's row (the lists are drawn again often, and a long note's marks needn't be read each time): a changed note
     is a new row, so its old words go with the old one, and a locked note's are never kept. */
  const plainKept = new WeakMap();
  const ENDS = /[.!?:;,…]$/;  // a line ending like this runs on with a space; any other gets " · "
  function pieces(body) {
    const out = [];
    let fenced = false;
    for (const raw of (V.format ? V.format.unmark(body) : body).split('\n')) {
      if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
      let line = raw;
      let box = null;
      let head = false;
      if (!fenced) {
        const check = CHECK.exec(line);
        if (check) { box = check[2] === ' ' ? 'open' : 'done'; line = check[3]; }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;  // a --- rule
        head = !box && /^\s{0,3}#{1,6}\s+/.test(line);
        line = line.replace(/^\s{0,3}#{1,6}\s+/, '')  // a heading's #s (a #tag has no space after it, so it stays)
          .replace(/^\s*>\s?/, '')                   // a quote
          .replace(/^\s*[-*+•]\s+/, '')              // a list's dash or star (a numbered list keeps its numbers)
          .replace(/\{\{([^{}]*)\}\}/g, '$1')        // a {{blank}}
          .replace(/`([^`\n]+)`/g, '$1')             // `code`
          .replace(/\s+::\s+/g, ' → ');              // a flash card
      }
      line = line.replace(/\s+/g, ' ').trim();
      if (line) out.push({ text: line, box, head });
    }
    return out;
  }
  /* A card's order (1.16): in each run of tick boxes, the ticked ones after the ones still to do (a list's done
     items go to the end, as Today shows them). The title keeps the note's own order. */
  function ticksLast(list) {
    const out = [];
    let run = [];
    const flush = () => {
      out.push(...run.filter((p) => p.box === 'open'), ...run.filter((p) => p.box === 'done'));
      run = [];
    };
    for (const piece of list) {
      if (piece.box) run.push(piece);
      else { flush(); out.push(piece); }
    }
    flush();
    return out;
  }
  // A card's words also say where a heading's words and a ticked item's words end (HEAD ... END, ● ... END: private
  // letters no note has, read and dropped by boxed()), so a card draws headings a little darker and ticked items struck.
  const HEAD = '\uE000', END = '\uE001';
  const MARKS = /[\uE000\uE001]/g;
  function joined(list, boxes, card = false) {
    let words = '';
    for (const piece of list) {
      const glyph = boxes && piece.box ? (piece.box === 'open' ? '○ ' : '● ') : '';
      if (words) words += (glyph || ENDS.test(words.replace(MARKS, '').replace(/["'”’)\]]+$/, ''))) ? ' ' : ' · ';
      const spanned = card && (piece.head || piece.box === 'done');
      words += glyph + (card && piece.head ? HEAD : '') + piece.text + (spanned ? END : '');
    }
    return words;
  }
  function made(note) {
    const body = note.body || '';
    const kept = plainKept.get(note);
    if (kept && kept.body === body) return kept;
    const list = pieces(body);
    const out = { body, words: joined(list, true), title: joined(list, false), card: joined(ticksLast(list), true, true) };
    if (V.format && !note.locked) plainKept.set(note, out);
    return out;
  }
  function plain(note, boxes = true) {
    return boxes ? made(note).words : made(note).title;
  }

  /* A card's words (made(note).card) with its tick boxes (○ / ●) drawn as small boxes, the ticked ones with a tick and
     their words grey and struck (span.snip-done), and a heading's words a little darker (span.snip-head). `parts` are
     strings and search's <mark>s (js/organise.js marked()); a mark inside a struck item stays inside it. */
  function boxed(parts) {
    const out = [];
    let into = null;  // the span being filled (a heading's or a ticked item's words), or null
    const put = (node) => (into || out).push(node);
    const close = () => {
      if (into && into.length) out.push(V.h('span.' + into.cls, {}, into));
      into = null;
    };
    const open = (cls) => { close(); into = []; into.cls = cls; };
    for (const part of parts) {
      if (typeof part !== 'string') { put(part); continue; }
      for (const bit of part.split(/([○●] ?|\uE000|\uE001)/)) {
        if (!bit) continue;
        if (bit === HEAD) open('snip-head');
        else if (bit === END) close();
        else if (bit[0] === '○' || bit[0] === '●') {
          close();
          const done = bit[0] === '●';
          out.push(V.h('span.snip-box' + (done ? '.done' : ''), { role: 'img', 'aria-label': done ? 'done' : 'to do' },
            done ? V.icon('check') : null));
          if (done) open('snip-done');
        } else put(bit);
      }
    }
    close();
    return out;
  }

  function progress(note) {
    let all = 0, done = 0;
    for (const line of (note.body || '').split('\n')) {
      const box = CHECK.exec(line);
      if (box && box[3].trim()) { all++; if (box[2] !== ' ') done++; }
    }
    return all ? { all, done } : null;
  }

  /* A note's name wherever it's shown (cards, Today, Upcoming, Review, reminders, the note-taker's bar...): its title
     as words, without the marks of bold, highlight... (a title typed or made with them showed "**Bio** test"), else its
     first words. */
  const titleWords = (title) => (V.format ? V.format.unmark(title, true) : title).trim();  // ("__init__.py" keeps its __)
  V.noteTitle = (note) => titleWords(note.title || '') || (!note.locked && plain(note, false).slice(0, 60)) || 'Untitled';

  function shown() {
    if (filter === 'trash') {
      return trashed().sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
    }
    const q = O.parseQuery(query);
    let list;
    if (!q.empty) {
      // Searching looks through every note (not just this folder); the Archive only with is:archived, or from there.
      const archived = q.is.includes('archived') || filter === 'archive';
      list = live().filter((n) => O.isArchived(n) === archived).filter(O.matcher(q));
    } else if (filter === 'archive') {
      list = live().filter(O.isArchived);
    } else if (filter === 'review') {
      list = [];  // (the Review page is drawn by js/review.js)
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

  /* An empty list's one line about the study loop (1.19): record a class (into `folder`, when there is one) or snap a
     page, and AI makes the notes and flash cards. Its link opens the note-taker where it can hear here (not an
     iPhone's home screen icon, say: js/notetaker.js's engine), else Snap a page (js/capture.js, when this Wefty has
     it); each is said only where it works. */
  function loopLine(folder) {
    const snap = !!(V.capture && typeof V.capture.snap === 'function');
    let record = false;
    try { record = !!(V.notetaker && V.notetaker.engine && V.notetaker.engine().kind); } catch (error) { record = false; }
    if (!record && !snap) return null;
    const what = record && snap ? 'Record a class or snap a page' : record ? 'Record a class' : 'Snap a page of notes';
    return V.h('p.hint.loop-line', {},
      V.h('span', { text: `${what}${folder ? ` for ${folder.name}` : ''}, and AI turns it into notes and flash cards.` }), ' ',
      record ? V.h('button.link-btn.loop-go', { type: 'button', text: 'Record a class',
        onclick: () => V.notetaker.open(null, folder ? { folderId: folder.id } : {}) }) : null,
      snap && !record ? V.h('button.link-btn.loop-go', { type: 'button', text: 'Snap a page', onclick: () => V.capture.snap() }) : null);
  }

  /* -- making things */

  /* `list`: [name, emoji] pairs (a new friend's classes, js/welcome.js starterFolders), Inbox first. One at a time: a
     second ask while the first is making them waits for it (the first sync and the welcome's plan can both ask). */
  let starting = null;
  function ensureStarterFolders(list = V.STARTER_FOLDERS) {
    if (!starting) starting = makeStarterFolders(list).finally(() => { starting = null; });
    return starting;
  }
  async function makeStarterFolders(list) {
    if (V.data.folders.size || (await V.db.meta('starter-made'))) return;
    await V.db.meta('starter-made', true);
    let sort = 0;
    for (const [name, icon] of Array.isArray(list) && list.length ? list : V.STARTER_FOLDERS) {
      await V.cloud.save('folders', { id: V.uuid(), name, icon, sort: sort++, deleted: false, extra: {} });
    }
    const home = inbox();
    await V.cloud.save('notes', blankNote({
      folder_id: home && home.id, pinned: true, title: 'Welcome to Wefty',
      body: 'Your notes, on your PC and your phone.\n\n- [ ] Open Wefty on your phone (Settings > Devices, on the PC)\n'
        // (An iPhone can't share into a web app: there it's Share > Send.)
        + `- [ ] Send a photo from your phone to the PC (${V.deviceKind.ios ? 'Share > Send' : 'Share > Wefty'})\n`
        + '- [ ] Press Ctrl+Alt+N on the PC for a quick note\n'
        // Only the PC with Jarvis knows he's there (a phone, or Vault on its own, has no Jarvis to ask).
        + (V.desktop && !V.pc.standalone() ? '- [ ] Say "Jarvis, make a note that..."\n' : '')
        + '\nTick these off as you go, then delete this note.',
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

  /* `fresh`: made from outside Notes (Today, the icon's New note, Ctrl+N on another screen): whatever Notes was left
     showing (Pinned, a #tag, a folder) has nothing to do with it, so it goes to its template's folder, else the Inbox. */
  async function create(template = V.TEMPLATES[0], extra = {}, { fresh = false } = {}) {
    const from = fresh ? 'all' : filter;
    let folderId = from !== 'all' && V.data.folders.has(from) ? from : null;
    const own = template.folderId && V.data.folders.get(template.folderId);
    if (!folderId && own && !own.deleted) folderId = own.id;
    if (!folderId && template.folder) {
      const named = folders().find((f) => f.name.toLowerCase() === template.folder.toLowerCase());
      folderId = named ? named.id : null;
    }
    if (!folderId) folderId = (inbox() || {}).id || null;
    const title = fill(template.title || '');
    let body = fill(template.body || '');
    if (isTag(from)) {  // made while looking at a tag: it gets the tag, so it's in the list it was made from
      const tag = (O.allTags(live()).find((t) => t.key === tagKey(from)) || { name: tagKey(from) }).name;
      if (!O.tagsOf({ title, body }).some((t) => t.key === tagKey(from))) body += (body.trim() ? '\n\n' : '') + '#' + tag;
    }
    const note = await V.cloud.save('notes', blankNote({
      folder_id: folderId, title, body,
      due: template.due !== undefined ? V.addDays(V.today(), template.due) : null,
      pinned: from === 'pinned', template: template.id === 'blank' || template.own ? '' : template.id, ...extra,
    }));
    open(note.id, { focusTitle: true });
    return note;
  }

  function chooseTemplate({ fresh = false } = {}) {
    stopPicking();  // (as Ctrl+N does: a new note, or the note-taker, isn't picked behind)
    const here = fresh ? null : V.data.folders.get(filter);
    const list = [...V.TEMPLATES].sort((a, b) => {
      const fit = (t) => (here && t.folder && t.folder.toLowerCase() === here.name.toLowerCase() ? 0 : 1);
      return (a.id === 'blank' ? -1 : b.id === 'blank' ? 1 : fit(a) - fit(b));
    });
    let chosen = null;
    const sheet = V.sheet({
      title: here ? `New note in ${here.name}` : 'New note',
      content: [
        V.notetaker ? V.notetaker.sheetEntry(() => sheet.close()) : null,  // js/notetaker.js
        V.capture ? V.capture.sheetEntries(() => sheet.close()) : null,  // js/capture.js: Snap a page, Paste into Wefty
        V.h('div.templates', {}, list.map((t) => V.h('button.template', {
          type: 'button', onclick: () => { chosen = t; sheet.close(); },
        }, V.icon(t.icon), V.h('span.t-name', { text: t.name }),
        V.h('span.t-hint', { text: t.hint || (t.folder ? t.folder : '') })))),
        O.templateSection((t) => { chosen = t; sheet.close(); }, () => sheet.close()),
      ],
      onClose: () => { if (chosen) create(chosen, {}, { fresh }).catch(V.problem); },
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

  /* `hold`: the Select button's way, which stays on with nothing picked. */
  function startPicking({ hold = false } = {}) {
    if (hold) held = true;
    if (picking) return;
    picking = true;
    anchor = null;
    // On a phone the Back button stops picking (instead of leaving Vault).
    if (!V.desktop) history.pushState({ vault: 'select' }, '');
  }

  function stopPicking({ fromHistory = false } = {}) {
    if (!picking) return;
    picking = false;
    held = false;
    moveTo = null;
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
    if (!picked.size && !held) stopPicking();
    else showPicked();
  }

  /* An empty folder's "Move notes here": every note, picking on, and the pick bar's Move going straight to that
     folder. (Leaving Notes, or stopping, puts it back as it was.) */
  function moveHere(folder) {
    setFilter('all');
    moveTo = folder.id;
    startPicking({ hold: true });
    showPicked();
    V.toast(`Pick the notes, then Move to ${folder.name}`);
  }

  /* The Select button: picking on (nothing picked yet), or off again. */
  function selectPressed() {
    if (picking) { stopPicking(); return; }
    startPicking({ hold: true });
    showPicked();
  }

  /* The list's notes in the order they're shown, the ones folded away in their fold's place (opened or not, ever):
     so a Shift+click picks the same notes whichever folds were opened before. */
  function listOrder() {
    if (!parts) return [];
    const order = [];
    for (const el of parts.list.querySelectorAll('button.card[data-id], .list-fold')) {
      if (el.classList.contains('list-fold')) order.push(...(foldIds.get(el) || []));
      else if (!el.closest('.fold-notes')) order.push(el.dataset.id);
    }
    return order;
  }

  /* Shift+click: every note from the last one picked (or the open note) to this one, as the list shows them (the
     ones folded away between them too: their fold says how many it has picked). */
  function pickRange(id) {
    const order = listOrder();
    const open = V.editor.openId();
    const from = anchor && order.includes(anchor) ? anchor : open && order.includes(open) ? open : id;
    const [a, b] = [order.indexOf(from), order.indexOf(id)].sort((x, y) => x - y);
    startPicking();
    for (const each of order.slice(a, b + 1)) picked.add(each);
    anchor = from;
    showPicked();
  }

  /* Every note in the list, the ones folded away too (they show picked when their fold is opened). */
  function pickAll() {
    startPicking();
    for (const id of listIds) picked.add(id);
    showPicked();
  }

  /* Nothing picked, still picking (as the Select button does). */
  function pickNone() {
    picked.clear();
    anchor = null;
    held = true;
    showPicked();
  }

  /* The Select button's look: "Select", or "Cancel" while picking. */
  function drawSelect() {
    const button = parts && parts.select;
    if (!button) return;
    button.setAttribute('aria-pressed', String(picking));
    button.setAttribute('aria-label', picking ? 'Cancel picking' : 'Select notes');
    button.title = picking ? 'Stop picking (Esc)' : `Pick notes to ${filter === 'trash' ? 'put back or delete' : 'move or delete'} together`;
    V.clear(button, V.icon(picking ? 'x' : 'select'), V.h('span.select-label', { text: picking ? 'Cancel' : 'Select' }));
  }

  /* While picking on a phone, the ⋯ says so (its menu's first line stops it). */
  function drawMore() {
    const more = parts && parts.titleTools.querySelector('.notes-more');
    if (more) more.classList.toggle('on', picking);
  }

  /* The picked cards marked where they are (nothing redrawn, so a finger still on a card stays on it), the folds'
     counts of what's picked inside them, the Select button and the bar. */
  const foldIds = new WeakMap();  // a fold's head: the ids of the notes under it
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
    for (const head of parts.list.querySelectorAll('.list-fold')) {
      const count = picking ? (foldIds.get(head) || []).filter((id) => picked.has(id)).length : 0;
      const label = head.querySelector('.fold-picked');
      if (label) {
        label.textContent = count ? `${count} picked` : '';
        label.hidden = !count;
      }
    }
    drawSelect();
    drawMore();
    drawPickBar();
  }

  function drawPickBar() {
    const bar = parts.pickBar;
    if (!picking) { bar.hidden = true; V.clear(bar); return; }
    const ids = [...picked];
    const rows = ids.map((id) => V.data.notes.get(id)).filter(Boolean);
    const allPinned = rows.length > 0 && rows.every((n) => n.pinned);
    const allArchived = rows.length > 0 && rows.every(O.isArchived);
    const everything = listIds.length > 0 && listIds.every((id) => picked.has(id));
    // With nothing picked yet (the Select button), the bar says what to do and its buttons wait.
    const act = (icon, label, run, cls = '') => V.h('button.pick-action' + (cls ? '.' + cls : ''), {
      type: 'button', disabled: !ids.length, onclick: () => run(ids).catch(V.problem),
    }, V.icon(icon), V.h('span', { text: label }));
    const done = (fn) => async (list) => { stopPicking(); await fn(list); };
    const target = moveTo && V.data.folders.get(moveTo);
    const actions = filter === 'trash' ? [
      act('restore', 'Put back', done((l) => O.restore(l))),
      act('trash', 'Delete forever', deleteForever, 'danger'),
    ] : [
      target ? act('folder-move', `Move to ${target.name}`, done((l) => O.move(l, target.id)), 'move-to')
        : act('folder-move', 'Move to', async (list) => {
          const folder = await O.chooseFolder({ title: list.length === 1 ? 'Move to' : `Move ${list.length} notes to` });
          if (folder) await done((l) => O.move(l, folder.id))(list);
        }),
      filter === 'archive' ? null : act(allPinned ? 'pin-on' : 'pin', allPinned ? 'Unpin' : 'Pin', done((l) => O.pin(l, !allPinned))),
      act('archive', allArchived ? 'Unarchive' : 'Archive', done((l) => O.archive(l, !allArchived))),
      // One note picked (a finger's long press picks one): everything else it can do, as a right-click shows (1.19.1).
      ids.length === 1 ? V.h('button.pick-action.pick-more', { type: 'button', 'aria-haspopup': 'menu',
        'aria-label': `More for ${V.noteTitle(rows[0] || {})}`, onclick: (event) => {
          const id = ids[0];
          const items = noteItems(id).map((item) => (item && item.onClick ? { ...item, onClick: () => { stopPicking(); item.onClick(); } } : item));
          V.menu(event.currentTarget, items.filter(Boolean), { label: 'More', returnFocus: true });
        } }, V.icon('more'), V.h('span', { text: 'More' })) : null,
      act('trash', 'Delete', done((l) => O.trash(l)), 'danger'),
    ];
    // Export (js/export.js), in the bar's top row: one note is its own file, several one ZIP. (Not in the Trash.)
    const exporting = filter === 'trash' || !V.exporter ? null : V.h('button.link-btn.pick-export', { type: 'button',
      disabled: !ids.length, title: ids.length === 1 ? 'Export this note as a file' : 'Export these notes as files',
      onclick: () => { const list = [...ids]; stopPicking(); V.exporter.picked(list).catch(V.problem); } },
    V.icon('download'), V.h('span', { text: 'Export' }));
    bar.hidden = false;
    V.clear(bar,
      V.h('div.pick-top', {},
        V.iconButton('x', 'Stop picking (Esc)', () => stopPicking(), 'quiet'),
        V.h('span.pick-count', { text: ids.length ? `${ids.length} picked` : 'Pick notes' }),
        exporting,
        !listIds.length ? null : everything
          ? V.h('button.link-btn.pick-all', { type: 'button', onclick: pickNone, text: 'Pick none' })
          : V.h('button.link-btn.pick-all', { type: 'button', onclick: pickAll, text: 'Pick all' })),
      V.h('div.pick-actions', {}, actions));
  }

  /* Notes in the Trash deleted for good, after asking (they can't come back from that). */
  async function deleteForever(ids) {
    const notes = ids.map((id) => V.data.notes.get(id)).filter((n) => n && n.deleted && !n._purge);
    if (!notes.length) return;
    const many = notes.length > 1;
    const sure = await V.confirm(many ? `Delete ${notes.length} notes for good?` : 'Delete this note for good?',
      many ? 'They can\'t be put back after this.' : 'It can\'t be put back after this.', { ok: 'Delete for good', danger: true });
    if (!sure) return;
    stopPicking();
    saidGone(notes.length, await purgeTrashed(notes.map((n) => n.id)));
  }

  /* Deleted for good, each only if it's still in the Trash now: one put back while Vault asked (by the Undo on an
     earlier toast, which sits above the question, or on the other device) is left alone. Returns how many were put
     back like that. */
  async function purgeTrashed(ids) {
    let back = 0;
    for (const id of ids) {
      const note = V.data.notes.get(id);
      if (!note || note._purge) continue;          // gone already (the other device)
      if (!note.deleted) { back += 1; continue; }  // put back meanwhile: kept
      await V.cloud.purgeNote(note);
    }
    return back;
  }

  function saidGone(asked, back) {
    const gone = asked - back;
    if (!gone) return V.toast(`Not deleted: ${back > 1 ? 'they\'re' : 'it\'s'} out of the Trash now`);
    const words = gone > 1 ? `Deleted ${gone} notes for good` : asked > 1 ? 'Deleted 1 note for good' : 'Deleted for good';
    V.toast(back ? `${words} · ${back} put back, so kept` : words);
  }

  window.addEventListener('popstate', () => {
    if (picking && !(history.state && history.state.vault === 'select')) stopPicking({ fromHistory: true });
    // A picking step left under Settings (picking stopped as Settings opened over it): stepped over, not a dead press.
    else if (!picking && !backing && !V.desktop && history.state && history.state.vault === 'select') history.back();
    backDone();
  });

  /* A finger or the S Pen held on a card picks it (the first one starts picking); a mouse uses Ctrl/Shift+click. The
     hold is js/drag.js's: moving on after it drags the picked notes. */
  function holdCard(id) {
    if (picking && picked.has(id)) return;  // (already picked: held to drag the ones picked)
    toggle(id);
  }

  function cardClick(event, note) {
    if (event.shiftKey) return pickRange(note.id);
    if (picking || event.ctrlKey || event.metaKey) return toggle(note.id);
    if (filter === 'trash') return trashMenu(note);
    open(note.id);
  }

  /* -- "more options" (1.19.1): a note's menu wherever it shows

     The same items for a note on every screen it shows on (Notes' cards in a list, a grid, the search, Upcoming and
     the Trash; Today's rows and Jump back in; a test's card), each one of the note's usual actions: a right-click (or
     a touchpad's two-finger tap), the keyboard's menu key or Shift+F10 (V.contextMenu), the pick bar's ⋯ with one
     note picked, and a long press where a long press doesn't pick (on Notes' cards it picks, as ever). `lead`: items
     of the place's own, put right after Open (Today's Tick it off, a test's Study); `opener`: how that place opens it. */
  function noteItems(id, { lead = [], opener = null, pick = false } = {}) {
    const note = V.data.notes.get(id);
    if (!note || note._purge) return [];
    if (note.deleted) {
      return [
        { label: 'Put back', icon: 'restore', onClick: () => O.restore([id]).catch(V.problem) },
        { label: 'Delete forever', icon: 'trash', danger: true, onClick: () => deleteForever([id]).catch(V.problem) },
      ];
    }
    const R = V.reminders;
    const archived = O.isArchived(note);
    const template = O.isTemplate(note);
    const words = !note.locked && !!String(note.body || '').trim();
    const at = R ? R.remindAt(note) : null;
    const repeats = !!(R && R.repeatOf(note));
    const dated = !!(note.due || at || repeats);
    const cards = !note.locked && V.review ? V.review.cardsOf(note).length : 0;
    const later = R && R.snooze && at && !repeats && !note.done;
    return [
      { label: 'Open', icon: 'open', onClick: () => (opener ? opener() : open(id)) },
      ...lead,
      { sep: true },
      archived || template ? null : { label: note.pinned ? 'Unpin' : 'Pin to the top', icon: note.pinned ? 'pin-on' : 'pin',
        onClick: () => O.pin([id], !note.pinned).catch(V.problem) },
      { label: 'Move to...', icon: 'folder-move', onClick: async () => {
        const folder = await O.chooseFolder({ current: note.folder_id });
        if (folder) await O.move([id], folder.id);
      } },
      R && !template ? { label: at || repeats ? 'Change reminder...' : 'Remind me...', icon: 'bell',
        onClick: () => R.edit(id, at || repeats ? {} : { remind: true }) } : null,
      later ? { label: 'Remind me in an hour', icon: 'clock', onClick: () => R.snooze(id, 'hour').catch(V.problem) } : null,
      later ? { label: 'Remind me tomorrow', icon: 'calendar', onClick: () => R.snooze(id, 'tomorrow').catch(V.problem) } : null,
      R && dated && !template ? { label: note.done ? 'Not done' : 'Mark done', icon: 'check', onClick: () => R.toggleDone(id) } : null,
      { sep: true },
      cards ? { label: 'Study its flash cards', icon: 'cards', onClick: () => V.review.study(id) } : null,
      V.aiCards && words && !template ? { label: cards ? 'Make more flash cards' : 'Make flash cards', icon: 'spark',
        onClick: () => V.aiCards.forNote(id) } : null,
      V.exporter && !note.locked ? { label: 'Export...', icon: 'download', onClick: () => V.exporter.picked([id]).catch(V.problem) } : null,
      V.exporter && words ? { label: 'Copy as text', icon: 'copy', onClick: async () => {
        await V.editor.settled().catch(() => {});
        const row = V.data.notes.get(id) || note;
        await V.exporter.copyText({ ...row, shown: true }).catch(V.problem);
      } } : null,
      V.send && words ? { label: `Send to ${V.otherName}`, icon: 'send', onClick: async () => {
        await V.editor.settled().catch(() => {});
        const row = V.data.notes.get(id) || note;
        const text = [row.title, row.body].filter((t) => t && t.trim()).join('\n\n');
        await V.send.text(text, { name: V.noteTitle(row) }).catch(V.problem);
      } } : null,
      { sep: true },
      pick ? { label: 'Pick', icon: 'select', onClick: () => { if (!picked.has(id)) toggle(id); } } : null,
      template ? null : { label: archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: () => O.archive([id], !archived).catch(V.problem) },
      { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => O.trash([id]).catch(V.problem) },
    ];
  }

  /* Several notes picked, one of them right-clicked: the pick bar's actions for all of them. */
  function pickedItems() {
    const ids = [...picked];
    const rows = ids.map((id) => V.data.notes.get(id)).filter(Boolean);
    const n = rows.length;
    const done = (fn) => async () => { stopPicking(); await fn(ids); };
    if (filter === 'trash') {
      return [
        { label: `Put back ${n} notes`, icon: 'restore', onClick: done((l) => O.restore(l)) },
        { label: `Delete ${n} notes forever`, icon: 'trash', danger: true, onClick: () => deleteForever(ids).catch(V.problem) },
      ];
    }
    const allPinned = rows.every((r) => r.pinned);
    const allArchived = rows.every(O.isArchived);
    return [
      { label: `Move ${n} notes to...`, icon: 'folder-move', onClick: async () => {
        const folder = await O.chooseFolder({ title: `Move ${n} notes to` });
        if (folder) await done((l) => O.move(l, folder.id))();
      } },
      filter === 'archive' ? null : { label: allPinned ? `Unpin ${n} notes` : `Pin ${n} notes`, icon: allPinned ? 'pin-on' : 'pin',
        onClick: done((l) => O.pin(l, !allPinned)) },
      V.exporter ? { label: `Export ${n} notes...`, icon: 'download', onClick: done((l) => V.exporter.picked(l)) } : null,
      { label: allArchived ? `Unarchive ${n} notes` : `Archive ${n} notes`, icon: 'archive', onClick: done((l) => O.archive(l, !allArchived)) },
      { sep: true },
      { label: 'Stop picking', icon: 'x', onClick: () => stopPicking() },
      { label: `Delete ${n} notes`, icon: 'trash', danger: true, onClick: done((l) => O.trash(l)) },
    ];
  }

  /* A card's menu: the picked notes' when it's one of several picked, else its own note's. */
  function cardMenu(el, note) {
    return V.contextMenu(el, () => (picking && picked.has(note.id) && picked.size > 1 ? pickedItems() : noteItems(note.id, { pick: true })), {
      label: `${V.noteTitle(note)}: options`,
      // (a finger held on a card picks it, js/drag.js: one held there before it saw the press begin picks too)
      touch: () => { if (!picked.has(note.id)) toggle(note.id); },
      // A double click opens it while picking, where a click picks (else the click itself opened it).
      open: () => { if (!picking) return; stopPicking(); open(note.id); },
    });
  }

  /* Everything in the Trash deleted for good, after asking (the Trash's own button, and its menu in the side list). */
  async function emptyTrash() {
    const list = trashed();
    if (!list.length) return V.toast('The Trash is empty.');
    if (!(await V.confirm('Empty the Trash?', `${list.length} note${list.length > 1 ? 's' : ''} will be deleted for good.`, { ok: 'Delete them', danger: true }))) return;
    await purgeTrashed(list.map((n) => n.id));  // (not one put back while it asked)
  }

  /* The lists in the side list and the chips that aren't folders: a menu only where there's more to do than open it
     (All notes: a new note; Flash cards: study, make some; the Trash: empty it). Elsewhere the browser's own. */
  function listContext(el, id) {
    return V.contextMenu(el, () => {
      const openIt = { label: 'Open', icon: 'open', onClick: () => setFilter(id) };
      if (id === 'all') return [openIt, { label: 'New note', icon: 'plus', onClick: () => chooseTemplate({ fresh: true }) }];
      if (id === 'trash') return trashed().length ? [openIt, { sep: true }, { label: 'Empty the Trash', icon: 'trash', danger: true, onClick: () => emptyTrash().catch(V.problem) }] : [];
      if (id === 'review' && V.review) {
        let due = 0;
        try { due = V.review.dueCount(); } catch (error) { console.error(error); }
        return [openIt, due ? { label: `Study ${due} now`, icon: 'cards', onClick: () => V.review.start('all') } : null,
          V.aiCards ? { label: 'Make cards with AI', icon: 'spark', onClick: () => V.aiCards.pickFolder() } : null];
      }
      return [];
    }, { label: 'Options', touch: false });
  }

  /* A folder's menu where it shows (the side list, the chips, an open folder's own folders): Open, then its ⋯'s
     items. (A finger held on one lifts it to drag, and let go opens its options: js/drag.js.) */
  function folderContext(el, id) {
    return V.contextMenu(el, () => {
      const folder = V.data.folders.get(id);
      if (!folder || folder.deleted) return [];
      return [{ label: 'Open', icon: 'open', onClick: () => setFilter(id) }, { sep: true },
        ...O.folderItems(folder, { onGone: () => { if (filter === id) setFilter('all'); }, onMade: (made) => setFilter(made.id) })];
    }, { label: `${(V.data.folders.get(id) || {}).name || 'Folder'}: options`, touch: false });
  }

  /* -- dragging (js/drag.js): notes onto a folder (or Pinned, Archive, Trash), folders into order or into each other

     A mouse drags at once; a finger or the S Pen holds first (which picks a note, or, let go, opens a folder's
     options). Notes go onto the side list's folders, the chips, an open folder's own folders and the folders above
     its name; a folder goes between two (a line shows where), onto another (lit) to go inside it, or onto "Folders" or
     All for the top level. On a phone the chips stay in sight at the top while dragging, and the lists scroll near
     their edges. Every drop has its Undo. Pinned notes have no order of their own (the list's sort decides), so
     dragging only pins them. */

  /* The lists that scroll by themselves near their edges while dragging. */
  function scrollers() {
    if (!parts) return [];
    const column = parts.listColumn;
    // (on a phone the chips stick to the list's top while dragging: its edge is under them)
    const top = () => {
      const edge = column.getBoundingClientRect().top;
      return parts.chips.offsetParent ? Math.max(edge, parts.chips.getBoundingClientRect().bottom) : edge;
    };
    return [{ el: column, axis: 'y', top, pastTop: 0 }, { el: parts.folders, axis: 'y' }, { el: parts.chips, axis: 'x' }];
  }

  /* What the notes being dragged look like: the title, or how many. */
  function notesLabel(ids) {
    const first = V.data.notes.get(ids[0]);
    return { kind: 'notes', ids, count: ids.length, label: ids.length === 1 ? V.noteTitle(first || {}) : `${ids.length} notes`,
      icon: V.icon('notes') };
  }

  /* Where notes can be dropped: a folder (any of the ways it's drawn), Pinned, Archive or the Trash. */
  const DROPS = '.folders .folder-row, .folders .nav-item[data-id], .chips .chip[data-id], .subfolder[data-id], .crumb[data-id]';
  function noteDrop(under, x, y, data) {
    if (!parts || !parts.layout.contains(under)) return null;
    let el = under.closest(DROPS);
    if (!el) return null;
    if (el.classList.contains('folder-row')) el = el.querySelector('.nav-item');
    const id = el.dataset.id;
    const ids = data.ids.filter((each) => V.data.notes.has(each));
    if (!ids.length) return null;
    const done = (run) => ({ ok: true, el, into: true, run: () => { stopPicking(); return run(); } });
    if (id === 'pinned') return done(() => O.pin(ids, true));
    if (id === 'archive') return done(() => O.archive(ids, true));
    if (id === 'trash') return done(() => O.trash(ids));
    const folder = V.data.folders.get(id);
    if (!folder || folder.deleted) return null;
    if (ids.every((each) => V.data.notes.get(each).folder_id === id)) return null;  // there already
    return done(() => O.move(ids, id));
  }

  /* Where a folder can be dropped: between two (before or after one), into one, or the top level. */
  function folderDrop(under, x, y, data) {
    if (!parts || !parts.layout.contains(under)) return null;
    const moving = V.data.folders.get(data.id);
    if (!moving || moving.deleted) return null;
    const row = under.closest('.folders .folder-row');
    if (row) {
      const item = row.querySelector('.nav-item');
      return O.folderRowTarget(moving, row, x, y, { tree: true, lit: item, from: item.getBoundingClientRect().left, step: 14 });
    }
    const top = under.closest('.folders .folders-head, .folders .nav-item[data-id="all"], .chips .chip[data-id="all"]');
    if (top) return O.topTarget(moving, top);
    const chip = under.closest('.chips .chip[data-id]');
    const chipFolder = chip && V.data.folders.get(chip.dataset.id);
    if (chipFolder) {
      return O.folderTarget(moving, chipFolder, V.drag.zone(chip, x, y, 'x'),
        { el: chip, line: (zone) => V.drag.lineBy(chip, zone, 'x') });
    }
    const sub = under.closest('.subfolder[data-id]');
    if (sub) return O.folderRowTarget(moving, sub, x, y, { from: sub.getBoundingClientRect().left });
    const crumb = under.closest('.crumb[data-id]');
    const crumbFolder = crumb && V.data.folders.get(crumb.dataset.id);
    if (crumbFolder) return O.folderTarget(moving, crumbFolder, 'into', { el: crumb });
    return null;
  }

  /* `el` (a card) dragged: the picked notes when it's one of them, else just it. Never from the Trash. */
  function noteSource(el, note) {
    return V.drag.source(el, {
      onHold: () => holdCard(note.id),
      data: () => {
        if (filter === 'trash' || !V.data.notes.has(note.id)) return null;
        return notesLabel(picking && picked.has(note.id) ? [...picked] : [note.id]);
      },
      resolve: noteDrop,
      scroll: scrollers,
    });
  }

  /* `el` (a folder in the side list, a chip, an open folder's row) dragged; held and let go, its options. Inbox
     stays where it is. */
  function folderSource(el, folder) {
    if (O.isInbox(folder)) return el;
    return V.drag.source(el, {
      onHoldUp: () => {
        const now = V.data.folders.get(folder.id);
        if (now && !now.deleted && el.isConnected) folderMenu(now, el);
      },
      data: () => { const now = V.data.folders.get(folder.id); return now && !now.deleted ? O.dragLabel(now) : null; },
      resolve: folderDrop,
      scroll: scrollers,
    });
  }

  /* -- drawing */

  function setFilter(value) {
    stopPicking();
    filter = value;
    const folder = V.data.folders.get(value);
    if (folder) for (const up of O.ancestors(folder)) if (shutSet().has(up.id)) setShut(up.id, false);  // so it shows
    query = '';
    searchOpen = false;
    if (parts) parts.search.value = '';
    draw();
    if (parts) showHelp();
  }

  function tagLabel(key) {
    const tag = O.allTags(live()).find((t) => t.key === key);
    return '#' + (tag ? tag.name : key);
  }

  function filterTitle() {
    if (query) return 'Search';
    if (filter === 'all') return 'Notes';
    if (filter === 'pinned') return 'Pinned';
    if (filter === 'due') return 'Upcoming';
    if (filter === 'review') return 'Flash cards';
    if (filter === 'archive') return 'Archive';
    if (filter === 'trash') return 'Trash';
    if (isTag(filter)) return tagLabel(tagKey(filter));
    const f = V.data.folders.get(filter);
    return f ? f.name : 'Notes';
  }

  /* How many notes each folder has (with its own folders' notes), and in the smart lists. */
  function counts() {
    const all = listed();
    const own = {};
    for (const n of all) own[n.folder_id] = (own[n.folder_id] || 0) + 1;
    const by = {};
    for (const f of folders()) by[f.id] = [f.id, ...O.inside(f.id)].reduce((sum, id) => sum + (own[id] || 0), 0);
    const due = (n) => (V.reminders ? V.reminders.pending(n) : n.due && !n.done);
    return { all: all.length, pinned: all.filter((n) => n.pinned).length, due: all.filter(due).length, by,
      review: V.review ? V.review.dueCount() : 0 };
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
    const item = V.h('button.nav-item' + (filter === id && !query ? '.on' : ''), {
      type: 'button', onclick: () => setFilter(id), dataset: { id },
    }, folder ? folderBadge(folder, true) : V.icon(icon), V.h('span.nav-label', { text: label }),
    count ? V.h('span.count', { text: String(count) }) : null);
    return folder ? folderContext(folderSource(item, folder), id) : listContext(item, id);
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
      navItem('review', 'cards', 'Flash cards', c.review),
      V.h('div.nav-heading.folders-head', {}, V.h('span', { text: 'Folders' }), V.iconButton('plus', 'New folder', newFolder, 'tiny')),
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
    const chip = (id, label, lead, count) => {
      const folder = V.data.folders.get(id);
      const el = V.h('button.chip' + (top === id && !query ? '.on' : ''), {
        type: 'button', onclick: () => setFilter(id), dataset: { id },
      }, lead, label, count ? V.h('span.count', { text: String(count) }) : null);
      return folder ? folderContext(folderSource(el, folder), id) : listContext(el, id);
    };
    V.clear(parts.chips,
      chip('all', 'All', null, c.all),
      chip('pinned', 'Pinned', V.icon('pin')),
      chip('due', 'Upcoming', V.icon('clock'), c.due),
      chip('review', 'Flash cards', V.icon('cards'), c.review),
      tree.filter((r) => !r.depth).map(({ folder: f }) => chip(f.id, f.name, folderBadge(f))),
      V.h('button.chip.add', { type: 'button', onclick: newFolder, title: 'New folder' }, V.icon('plus'), 'New folder'),
      tags.map((t) => chip('tag:' + t.key, '#' + t.name, null)),
      chip('archive', 'Archive', V.icon('archive')),
      chip('trash', 'Trash', V.icon('trash')));
    // The chip of the list shown is scrolled into sight when another list is opened (only on the phone, where the
    // chips show), not each time they're drawn: a chip just dragged into place far along the row stays in sight.
    const on = parts.chips.querySelector('.chip.on');
    if (on && parts.chips.offsetParent && chipsFor !== top) {
      chipsFor = top;
      const left = on.offsetLeft - parts.chips.offsetLeft;
      if (left < parts.chips.scrollLeft || left + on.offsetWidth > parts.chips.scrollLeft + parts.chips.clientWidth) {
        parts.chips.scrollLeft = Math.max(0, left - 14);
      }
    }
  }
  let chipsFor = null;  // the chip last scrolled into sight

  /* "Due today" on a card is just "Today" beside its calendar. */
  const shortDue = (label) => { const words = label.replace(/^Due /, ''); return words[0].toUpperCase() + words.slice(1); };

  function card(note, look) {
    const folder = folderOf(note);
    const due = V.due(note.due, note.done);
    const prog = note.locked ? null : progress(note);
    const pictures = (note.attachments || []).length;
    const showFolder = filter === 'all' || filter === 'pinned' || filter === 'due' || filter === 'archive' || isTag(filter) || query;
    const words = note.locked ? '' : made(note).card;
    const titled = !!(note.title || '').trim();
    // Searching: the words round the first match, when they're further in than the start shows.
    const around = look.terms.length ? O.snippet(words, look.terms, look.size) : words.slice(0, look.size);
    const snippet = titled || around.startsWith('…') ? around : '';
    const tags = O.tagsOf(note);
    return cardMenu(noteSource(V.h('button.card' + (V.editor.openId() === note.id ? '.open' : '') + (note.done ? '.done' : '')
      + (picked.has(note.id) ? '.selected' : ''), {
      type: 'button', dataset: { id: note.id },
      'aria-pressed': picking ? String(picked.has(note.id)) : null,
      onclick: (event) => cardClick(event, note),
    },
    V.h('div.card-top', {},
      V.h('span.pick', { 'aria-hidden': 'true' }, V.icon('check')),
      V.h('span.card-title', {}, O.marked(V.noteTitle(note), look.terms)),
      note.pinned ? V.icon('pin-on', 'pinned') : null),
    note.locked ? V.h('div.card-snippet.locked', {}, V.icon('lock'), V.h('span', { text: 'Locked: open it with your PIN' }))
      : snippet ? V.h('div.card-snippet', {}, boxed(O.marked(snippet, look.terms))) : null,
    V.h('div.card-meta', {},
      // The note-taker is writing into it right now (js/notetaker.js): a tap opens its live screen, not the note.
      V.notetaker && V.notetaker.listeningTo && V.notetaker.listeningTo() === note.id
        ? V.h('span.nt-card-chip', {}, V.h('span.nt-card-dot', { 'aria-hidden': 'true' }), V.h('span', { text: 'Listening' })) : null,
      showFolder && folder ? V.h('span.tag', {}, folderBadge(folder), V.h('span', { text: folder.name })) : null,
      O.isTemplate(note) ? V.h('span.tag', {}, V.icon('notes'), V.h('span', { text: 'Template' })) : null,
      due ? V.h('span.due.' + (due.cls || 'later'), {}, V.icon(due.cls === 'done' ? 'check' : 'calendar'), shortDue(due.label)) : null,
      V.reminders ? V.reminders.cardChip(note) : null,
      V.exams ? V.exams.cardChip(note) : null,  // a test's countdown
      prog ? V.h('span.progress', {}, V.h('span.bar', {}, V.h('i', { style: { width: (100 * prog.done / prog.all) + '%' } })),
        V.h('span', { text: `${prog.done}/${prog.all}` })) : null,
      pictures ? V.h('span.tag', {}, V.icon('image'), String(pictures)) : null,
      look.terms.length && V.attachSearch ? V.attachSearch.chip(note, look.terms) : null,  // "in a photo" / "in a PDF"
      tags.length ? V.h('span.note-tags', {}, tags.slice(0, 3).map((t) => V.h('span.note-tag', {}, O.marked('#' + t.name, look.terms))),
        tags.length > 3 ? V.h('span.note-tag.more', { text: `+${tags.length - 3}` }) : null) : null,
      V.h('span.when', { text: filter === 'trash' ? 'Deleted ' + V.ago(note.deleted_at) : V.ago(edited(note)) }))), note), note);
  }

  function trashMenu(note) {
    V.sheet({
      title: V.noteTitle(note),
      content: V.h('p', { text: 'This note is in the Trash. It\'s deleted for good 30 days after it was put there.' }),
      actions: [
        { label: 'Delete forever', kind: 'danger', onClick: async () => saidGone(1, await purgeTrashed([note.id])) },
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
      }, V.icon('next', 'fold-twist'), V.h('span', { text: title }), V.h('span.count', { text: String(list.length) }),
      V.h('span.fold-picked', { hidden: true }));  // (while picking: how many under it are picked, showPicked)
      foldIds.set(head, list.map((n) => n.id));
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
    const wide = V.wide();
    // In a folder: a way back first (up to the folder it's in; on a phone, from a top folder back to all your notes),
    // and the folders it's in (each opens) in a small line above its name.
    const above = folder && !query ? O.ancestors(folder) : [];
    const up = above[above.length - 1];
    V.clear(parts.back, up ? V.iconButton('back', `Up to ${up.name}`, () => setFilter(up.id), 'quiet folder-up')
      : folder && !query && !wide ? V.iconButton('back', 'Back to all your notes', () => setFilter('all'), 'quiet folder-up to-all') : null);
    V.clear(parts.crumbs, above.map((f) => [
      V.h('button.crumb', { type: 'button', dataset: { id: f.id }, onclick: () => setFilter(f.id) }, folderBadge(f), V.h('span', { text: f.name })),
      V.h('span.crumb-gap', { text: '›', 'aria-hidden': 'true' })]));
    parts.crumbs.hidden = !above.length;
    parts.listColumn.classList.toggle('searching', searchOpen || !!query);
    // Which list this is (its folder or filter, and the search): another one starts at its top, and js/start.js only
    // puts a scroll back on the same list it was left on.
    const which = `${filter}|${query}`;
    if (parts.listColumn.dataset.place !== undefined && parts.listColumn.dataset.place !== which) parts.listColumn.scrollTop = 0;
    parts.listColumn.dataset.place = which;
    parts.found.textContent = query ? (list.length === 1 ? '1 note' : `${list.length} notes`) : '';
    // Flash cards: how many to study today, and the decks (js/review.js), in place of a list of notes.
    const review = filter === 'review' && q.empty && !!V.review;
    parts.list.classList.toggle('review', review);
    if (review) {
      const due = V.review.dueCount();
      parts.headCount.textContent = due ? String(due) : '';
      parts.list.classList.remove('upcoming', 'grid');
      V.clear(parts.titleTools, wide ? null : searchButton());  // (nothing to sort or pick: the cards are review.js's)
      parts.select = null;
      listIds = [];
      V.clear(parts.list, V.review.page());
      if (picking) stopPicking();
      return;
    }
    // Wide: the folder's ⋯, sort, grid and Select in sight, beside the title. A phone's row has room for the
    // magnifier and one ⋯ (Select notes first in it, then Sort, View and the folder's options): moreMenu.
    parts.select = list.length && wide ? V.h('button.btn.select-btn', { type: 'button', onclick: selectPressed }) : null;
    V.clear(parts.titleTools, wide ? [
      folder && !query ? V.iconButton('more', `${folder.name} options`, (event) => folderMenu(folder, event.currentTarget), 'folder-options') : null,
      V.iconButton('sort', 'Sort notes', (event) => sortMenu(event.currentTarget)),
      V.iconButton(grid ? 'rows' : 'grid', grid ? 'Show as a list' : 'Show as a grid', () => {
        O.setView(grid ? 'list' : 'grid');
        draw();
      }),
      parts.select,
    ] : [searchButton(), moreButton()]);
    drawSelect();
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
      // A folder with nothing in it (no notes, no folders): the loom, and the two ways to fill it. Its New note is the
      // screen's main iris button on a phone (the round + steps aside for it); wide, New note above the list is.
      if (folder && !O.children(folder.id).length) {
        return V.h('div.empty.empty-folder', {}, V.loom(176),
          V.h('h2', { text: `Nothing in ${folder.name} yet` }),
          V.h('p', { text: 'Start a note here, or move notes in from other folders.' }),
          V.button(`New note in ${folder.name}`, { kind: wide ? 'tonal' : 'primary', icon: 'plus',
            onClick: () => create(V.TEMPLATES[0], { folder_id: folder.id }).catch(V.problem) }),
          V.h('button.link-btn.move-here', { type: 'button', text: 'Move notes here', onclick: () => moveHere(folder) }),
          loopLine(folder));
      }
      // ('tonal': the round + or the New note above the list is the screen's main iris button; the same in light)
      return say('No notes here yet.', V.button('New note', { kind: 'tonal', icon: 'plus', onClick: chooseTemplate }),
        filter === 'all' || (folder && folder === inbox()) ? loopLine(null) : null);
    };
    const trashBar = filter === 'trash' && list.length ? V.h('div.list-bar', {}, V.button('Empty the Trash', {
      kind: 'danger-quiet', icon: 'trash', onClick: emptyTrash,
    })) : null;
    const look = { terms: O.terms(q), size: grid ? 280 : 160 };
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
        return folderContext(folderSource(V.h('button.subfolder', {
          type: 'button', dataset: { id: f.id }, onclick: () => setFilter(f.id),
        }, V.h('span.fc-badge', {}, folderBadge(f) || V.icon('folder')), V.h('span.sf-name', { text: f.name }),
        V.h('span.sf-meta', { text: what }), V.icon('next', 'sf-go')), f), f.id);
      })),
      list.length ? V.h('h2.list-section', {}, V.h('span', { text: 'Notes' }), V.h('span.count', { text: String(list.length) })) : null,
    ] : null;
    const none = list.length ? null : empty();
    parts.fab.classList.toggle('aside', !!(none && none.classList.contains('empty-folder')));
    if (none && subRows) none.classList.add('small');  // under its folders, a quieter "nothing here"
    const tests = folder && !query && V.exams ? V.exams.banners(folder) : null;  // tests that cover this folder
    V.clear(parts.list, trashBar, tests, subRows, list.length ? byDay || sections(list, make) || folded(list, make) : none);
    // Picked notes that have gone (deleted on the other device, or no longer in this list) aren't picked any more; the
    // Select button's picking stays on with none picked, until the list itself is empty.
    listIds = list.map((n) => n.id);
    const here = new Set(listIds);
    for (const id of picked) if (!here.has(id)) picked.delete(id);
    if (picking && (!list.length || (!picked.size && !held))) stopPicking();
    else showPicked();
  }

  /* The sorts (a tick on the one in use); wide, Show as a grid too (a phone's ⋯ has its own List | Grid). */
  function sortMenu(anchorEl, { view = true, returnFocus = false } = {}) {
    const now = O.sort();
    const grid = O.view() === 'grid';
    V.menu(anchorEl, [
      ...O.SORTS.map(([id, label]) => ({ label, icon: now === id ? 'check' : 'blank', onClick: () => { O.setSort(id); draw(); } })),
      view ? { label: grid ? 'Show as a list' : 'Show as a grid', icon: grid ? 'rows' : 'grid', onClick: () => { O.setView(grid ? 'list' : 'grid'); draw(); } } : null,
    ], { label: 'Sort notes', returnFocus });
  }

  /* -- a phone's top row: the magnifier and the ⋯ beside the title (your picture after them) */

  const searchButton = () => V.iconButton('search', 'Search notes', () => openSearch(), 'notes-search');
  function moreButton() {
    const button = V.iconButton('more', 'More options', () => moreMenu(button), 'notes-more');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    return button;
  }

  /* The ⋯: Select notes (Stop picking while picking) first, as the long press is hidden; then Sort (the one in use
     said, its choices in a second menu), View List | Grid, an open folder's own options, and Flash cards (Review). Only
     what the list shown can use: Upcoming and the Trash keep their own order, and there's nothing to pick in an empty
     list. */
  function moreMenu(anchorEl) {
    const folder = V.data.folders.get(filter);
    const grid = O.view() === 'grid';
    const sorts = filter !== 'due' && filter !== 'trash';
    const sortName = (O.SORTS.find(([id]) => id === O.sort()) || O.SORTS[0])[1];
    const setView = (value, done) => { done(); if (O.view() !== value) { O.setView(value); draw(); } };
    const cards = !!V.review && filter !== 'review';
    const arrange = (!!folder || filter === 'all') && !query && folders().length > 2;
    let cardsDue = 0;
    try { cardsDue = cards ? V.review.dueCount() : 0; } catch (error) { console.error(error); }
    anchorEl.setAttribute('aria-expanded', 'true');
    V.menu(anchorEl, [
      picking ? { label: 'Stop picking', icon: 'x', onClick: () => stopPicking() }
        : listIds.length ? { label: 'Select notes', icon: 'select', onClick: () => selectPressed() } : null,
      sorts ? { node: (done) => V.h('button.menu-item.menu-more', {
        type: 'button', role: 'menuitem', 'aria-haspopup': 'menu',
        onclick: () => { done(); sortMenu(anchorEl, { view: false, returnFocus: true }); },
      }, V.icon('sort'), V.h('span', { text: 'Sort' }), V.h('span.menu-value', { text: sortName }), V.icon('next', 'menu-go')) } : null,
      { node: (done) => V.h('div.menu-row.menu-view', { role: 'group', 'aria-label': 'View' },
        V.icon('grid'), V.h('span', { text: 'View' }),
        V.h('div.segmented', { role: 'radiogroup', 'aria-label': 'View' },
          V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(!grid), text: 'List', onclick: () => setView('list', done) }),
          V.h('button', { type: 'button', role: 'radio', 'aria-checked': String(grid), text: 'Grid', onclick: () => setView('grid', done) }))) },
      (folder && !query) || arrange ? { sep: true } : null,
      folder && !query ? { label: 'Folder options…', icon: 'folder', onClick: () => folderMenu(folder, anchorEl) } : null,
      // (the chips show only the top folders: here they're all, to drag into order and into each other)
      arrange ? { label: 'Arrange folders', icon: 'arrange', onClick: () => O.arrangeFolders() } : null,
      // Flash cards (its chip is far along the row on a phone), with how many are due today.
      cards ? { sep: true } : null,
      cards ? { node: (done) => V.h('button.menu-item.menu-more.menu-cards', {
        type: 'button', role: 'menuitem', onclick: () => { done(); setFilter('review'); },
      }, V.icon('cards'), V.h('span', { text: 'Flash cards' }), cardsDue ? V.h('span.menu-value', { text: `${cardsDue} due` }) : null) } : null,
    ], { cls: 'notes-menu', label: 'More options', returnFocus: true,
      onClose: () => { if (anchorEl.isConnected) anchorEl.setAttribute('aria-expanded', 'false'); } });
  }

  /* A phone's search row, in place of the title's row: shown before the box is focused, both in the same tap (an
     iPhone only brings its keyboard up for a focus() made in the tap itself, on a field that's on show). */
  function openSearch() {
    if (!parts) return;
    if (!searchOpen && !V.wide()) stopPicking();  // (the row takes the title's place, and the pick bar's words)
    searchOpen = true;
    parts.listColumn.classList.add('searching');
    parts.listColumn.scrollTop = 0;  // (the box is at the list's top: in sight, wherever the list had been left)
    parts.search.focus({ preventScroll: true });
    showHelp();
  }

  /* Back to the title's row: the box emptied, the whole list again, the keyboard down. */
  function closeSearch({ refocus = true } = {}) {
    if (!parts) return;
    clearTimeout(helpTimer);
    const was = query;
    searchOpen = false;
    parts.search.value = '';
    query = '';
    parts.listColumn.classList.remove('searching');
    if (document.activeElement === parts.search) parts.search.blur();
    if (was) draw();
    else parts.found.textContent = '';
    showHelp();
    const magnifier = refocus && parts.titleTools.querySelector('.notes-search');
    if (magnifier) magnifier.focus({ preventScroll: true });
  }

  /* The x in the box: the words go (the box keeps the keyboard); an empty box's x closes a phone's search row. */
  function clearSearch() {
    if (!parts.search.value && !V.wide()) { closeSearch(); return; }
    parts.search.value = '';
    query = '';
    draw();
    parts.search.focus({ preventScroll: true });
    showHelp();
  }

  /* The filters the search box knows, as buttons in plain words that type them in (the keyboard stays up): "In
     School" (the folder open, else your first folder), "Pinned", "Has a picture", "Due this week"... */
  function drawHelp() {
    const folder = V.data.folders.get(filter) || folders().find((f) => !O.isInbox(f) && !O.ancestors(f).length);
    const named = folder ? (/\s/.test(folder.name) ? `in:"${folder.name}"` : `in:${folder.name}`) : 'in:';
    const pill = (label, token) => V.h('button.filter-pill', {
      type: 'button', title: `Adds ${token.trim() === '#' ? 'a #tag' : token} to the search`,
      onmousedown: (event) => event.preventDefault(),
      onclick: () => addFilter(token),
    }, label);
    V.clear(parts.help, V.h('span.help-word', { text: 'Try' }),
      pill(folder ? `In ${folder.name}` : 'In a folder', named), pill('Pinned', 'is:pinned'),
      pill('Has a picture', 'has:picture'), pill('Due this week', 'due:week'), pill('Late', 'due:late'),
      pill('Has a checklist', 'has:checklist'), pill('#tag', '#'), pill('Archived', 'is:archived'));
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
    const on = document.activeElement === parts.search || !!parts.search.value.trim() || (searchOpen && !V.wide());
    parts.help.hidden = !on;
    if (on) drawHelp();
    else V.clear(parts.help);
  }

  const SMART = ['all', 'pinned', 'due', 'review', 'archive', 'trash'];
  function draw() {
    if (!parts) return;
    const folder = V.data.folders.get(filter);
    if (!SMART.includes(filter) && !isTag(filter) && (!folder || folder.deleted)) filter = 'all';  // deleted elsewhere
    drawFolders();
    if (!parts.help.hidden) drawHelp();
    drawList();
  }

  /* A note, opened: over everything on a phone, in the side pane when wide. From another screen (Today, Share, an Undo
     toast, the picture's held notes) Notes is shown first when wide: the pane it had is off the page once it's left. */
  function open(id, opts = {}) {
    if (backing) { backing.open = [id, opts]; return; }
    if (V.wide() && !showing() && V.go) V.go('notes');
    if (V.wide() && showing()) V.editor.open(id, { pane: parts.pane, ...opts });
    else V.editor.open(id, opts);
    // (the note the editor really opened: one the note-taker is listening into shows its screen instead)
    const opened = V.editor.openId();
    if (parts) for (const el of parts.list.querySelectorAll('.card')) el.classList.toggle('open', el.dataset.id === opened);
  }

  /* Searching your notes, from anywhere (Ctrl+F; Today's magnifier): Notes' search box (a phone's search row opened),
     focused in the same tap (an iPhone only opens its keyboard for that), with `text` in it if given. */
  function search(text) {
    if (!showing() && V.go) V.go('notes', { top: true });
    if (!parts) return;
    if (typeof text === 'string') {
      parts.search.value = text;
      query = text.trim();
      draw();
    }
    openSearch();
  }

  function render(container) {
    stopPicking();
    root = container;
    chipsFor = null;
    const search = V.h('input.search', {
      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', value: query, enterkeyhint: 'search',
      oninput: V.debounce(() => { query = search.value.trim(); draw(); showHelp(); }, 120),
      onkeydown: (event) => {
        if (event.key !== 'Escape') return;
        if (!V.wide()) { event.preventDefault(); closeSearch(); return; }
        search.value = ''; query = ''; draw(); showHelp();
      },
      onfocus: showHelp,
      // Hidden a moment later, so a tap on a card that blurs the box lands before the list moves up. A phone's search
      // row left empty goes back to the title's row then too.
      onblur: () => {
        clearTimeout(helpTimer);
        helpTimer = setTimeout(() => {
          const away = !parts.listHead.contains(document.activeElement) && !parts.help.contains(document.activeElement);
          if (searchOpen && !V.wide() && !search.value.trim() && away) closeSearch({ refocus: false });
          else showHelp();
        }, 300);
      },
    });
    parts = {
      search,
      folders: V.h('nav.folders', { 'aria-label': 'Folders' }),
      chips: V.h('div.chips', { role: 'tablist' }),
      help: V.h('div.search-help', { hidden: true }),
      found: V.h('p.search-found', { role: 'status' }),
      heading: V.h('h1'),
      back: V.h('span.title-back'),
      crumbs: V.h('nav.crumbs', { 'aria-label': 'The folders this one is in', hidden: true }),
      headCount: V.h('span.head-count'),
      titleTools: V.h('div.list-tools'),
      select: null,
      list: V.h('div.list'),
      pane: V.h('section.pane'),
      pickBar: V.h('div.pick-bar', { role: 'toolbar', 'aria-label': 'Picked notes', hidden: true }),
      fab: V.h('button.fab', { type: 'button', onclick: chooseTemplate, 'aria-label': 'New note' }, V.icon('plus')),
    };
    parts.listHead = V.h('div.list-head', {},
      V.iconButton('back', 'Close the search', () => closeSearch(), 'search-back'),
      V.h('div.search-box', {}, V.icon('search'), search,
        V.h('button.search-clear', { type: 'button', title: 'Clear the search', 'aria-label': 'Clear the search',
          onmousedown: (event) => event.preventDefault(), onclick: () => clearSearch() }, V.icon('x')),
        V.h('kbd.search-hint', { text: 'Ctrl F' })),
      V.button('New note', { kind: 'primary new-note', icon: 'plus', onClick: chooseTemplate, title: V.appShortcuts ? 'New note (Ctrl+N)' : 'New note' }));
    parts.listColumn = V.h('section.list-column', {},
      parts.listHead,
      parts.help,
      parts.chips,
      V.h('div.list-title', {}, parts.back,
        V.h('div.title-stack', {}, parts.crumbs, V.h('div.title-line', {}, parts.heading, parts.headCount)),
        parts.titleTools, V.profileButton('head-me')),
      parts.found,
      parts.list);
    parts.layout = V.h('div.notes-layout', {}, parts.folders, parts.listColumn, parts.pane, parts.pickBar);
    V.clear(container, parts.layout, parts.fab);
    draw();
    showHelp();
    V.editor.placeholder(parts.pane);
    const opened = V.editor.openId();
    if (opened && V.wide()) V.editor.open(opened, { pane: parts.pane });
  }

  /* Notes' tab tapped while Notes shows (js/start.js): picking ends, the list goes to its top, and a list already at
     its top goes back to all your notes (out of a folder, a filter or a search). */
  function again() {
    if (!showing() || V.editor.covering()) return false;
    if (picking) stopPicking();
    const column = parts.listColumn;
    if (column.scrollTop > 1) {
      const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      column.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
      return true;
    }
    if (filter !== 'all' || query || searchOpen) setFilter('all');
    return true;
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
  // folder is being dragged, not until it's dropped (a sync landing then would take it from under the pointer).
  const redraw = V.debounce(() => {
    if (V.drag.busy() && Date.now() - V.drag.since() < 20000) return redraw();
    if (showing() && !V.editor.covering()) draw();
  }, 60);
  V.on('data', (table) => { if (table === 'notes' || table === 'folders') redraw(); });
  V.on('attach-index', redraw);  // the attachment search index arrived (js/attachsearch.js): matches may change
  V.on('notetaker', redraw);  // the note-taker started or stopped listening into a note: its "Listening" chip
  // Picking left on (an empty folder's "Move notes here", the Select button) ends when another screen is opened.
  V.on('tab', (tab) => { if (tab !== 'notes' && picking) stopPicking(); });
  const typing = (target) => !!target && (target.matches('input, textarea, select') || target.isContentEditable);
  document.addEventListener('keydown', (event) => {
    if (!showing()) return;
    const ctrl = event.ctrlKey || event.metaKey;
    // (never through a sheet or the note-taker over the list: Ctrl+A there selects its words, Delete deletes them)
    if (picking && !V.editor.covering() && !document.querySelector('#layers > .layer:not(.leaving), #layers > .nt-layer.shown')) {
      if (event.key === 'Escape') { event.preventDefault(); stopPicking(); return; }
      if (ctrl && event.key.toLowerCase() === 'a' && !typing(event.target)) { event.preventDefault(); pickAll(); return; }
      if (event.key === 'Delete' && !typing(event.target)) {
        event.preventDefault();
        const ids = [...picked];
        if (!ids.length) return;
        if (filter === 'trash') { deleteForever(ids).catch(V.problem); return; }  // (it asks first)
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
      openSearch();
    }
  });

  return { render, again, create, chooseTemplate, ensureStarterFolders, blankNote, open, search, folders, inbox, setFilter, plain,
    folderBadge, noteItems, emptyTrash, picking: () => picking, showing: () => showing() };
})();
