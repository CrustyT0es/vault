/* Vault: the Notes tab. Folders (starter ones for school, work, personal and gaming), smart lists (Pinned, Due
   soon, Trash), search, and the list of notes. Opening one hands it to V.editor: beside the list on a wide
   screen, over everything on a phone. */
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
  let filter = 'all';
  let query = '';
  let root = null;
  let parts = null;

  const folders = () => [...V.data.folders.values()].filter((f) => !f.deleted)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  const live = () => [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge);
  const edited = (n) => n._edited || n.updated_at || n.created_at || '';
  const folderOf = (n) => V.data.folders.get(n.folder_id);
  const inbox = () => folders().find((f) => f.name.toLowerCase() === 'inbox');

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

  function matches(note, words) {
    const title = (note.title || '').toLowerCase();
    const body = note.locked ? '' : (note.body || '').toLowerCase();
    return words.every((w) => title.includes(w) || body.includes(w));
  }

  function shown() {
    if (filter === 'trash') {
      return [...V.data.notes.values()].filter((n) => n.deleted && !n._purge)
        .sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
    }
    let list = live();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) list = list.filter((n) => matches(n, words));
    else if (filter === 'pinned') list = list.filter((n) => n.pinned);
    else if (filter === 'due') list = list.filter((n) => n.due && !n.done);
    else if (filter !== 'all') list = list.filter((n) => n.folder_id === filter);
    if (filter === 'due' && !words.length) return list.sort((a, b) => a.due.localeCompare(b.due));
    return list.sort((a, b) => (b.pinned - a.pinned) || edited(b).localeCompare(edited(a)));
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

  function fill(text) {
    const now = new Date();
    return text.replace('{today}', now.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }))
      .replace('{longdate}', now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }));
  }

  async function create(template = V.TEMPLATES[0], extra = {}) {
    let folderId = filter !== 'all' && V.data.folders.has(filter) ? filter : null;
    if (!folderId && template.folder) {
      const named = folders().find((f) => f.name.toLowerCase() === template.folder.toLowerCase());
      folderId = named ? named.id : null;
    }
    if (!folderId) folderId = (inbox() || {}).id || null;
    const note = await V.cloud.save('notes', blankNote({
      folder_id: folderId, title: fill(template.title || ''), body: fill(template.body || ''),
      due: template.due !== undefined ? V.addDays(V.today(), template.due) : null,
      pinned: filter === 'pinned', template: template.id === 'blank' ? '' : template.id, ...extra,
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
    let picked = null;
    const sheet = V.sheet({
      title: here ? `New note in ${here.name}` : 'New note',
      content: V.h('div.templates', {}, list.map((t) => V.h('button.template', {
        type: 'button', onclick: () => { picked = t; sheet.close(); },
      }, V.icon(t.icon), V.h('span.t-name', { text: t.name }),
      V.h('span.t-hint', { text: t.hint || (t.folder ? t.folder : '') })))),
      onClose: () => { if (picked) create(picked); },
    });
  }

  /* -- folders */

  async function newFolder() {
    const name = await V.ask('New folder', { placeholder: 'Name, like Science or Minecraft', ok: 'Make it' });
    if (!name || !name.trim()) return;
    const icon = /^\p{Extended_Pictographic}/u.test(name.trim()) ? '' : '📁';
    const folder = await V.cloud.save('folders', {
      id: V.uuid(), name: name.trim().slice(0, 60), icon, sort: folders().length, deleted: false, extra: {},
    });
    setFilter(folder.id);
  }

  async function folderMenu(folder, anchor) {
    V.menu(anchor, [
      { label: 'Rename', icon: 'text', onClick: async () => {
        const name = await V.ask('Rename folder', { value: folder.name, ok: 'Rename' });
        if (name && name.trim()) await V.cloud.save('folders', { ...folder, name: name.trim().slice(0, 60) });
      } },
      { label: 'Change its emoji', icon: 'image', onClick: async () => {
        const icon = await V.ask('Folder emoji', { value: folder.icon, placeholder: 'Type or paste one emoji', ok: 'Use it' });
        if (icon !== null) await V.cloud.save('folders', { ...folder, icon: [...icon.trim()].slice(0, 2).join('') });
      } },
      { label: 'Delete folder', icon: 'trash', danger: true, onClick: async () => {
        const inside = live().filter((n) => n.folder_id === folder.id);
        const home = inbox();
        const ok = await V.confirm(`Delete ${folder.name}?`, inside.length
          ? `Its ${inside.length} note${inside.length > 1 ? 's go' : ' goes'} to ${home && home.id !== folder.id ? 'Inbox' : 'All notes'}.`
          : 'It\'s empty.', { ok: 'Delete', danger: true });
        if (!ok) return;
        for (const note of inside) {
          await V.cloud.save('notes', { ...note, folder_id: home && home.id !== folder.id ? home.id : null });
        }
        await V.cloud.save('folders', { ...folder, deleted: true });
        if (filter === folder.id) setFilter('all');
      } },
    ]);
  }

  /* -- drawing */

  function setFilter(value) {
    filter = value;
    query = '';
    if (parts) parts.search.value = '';
    draw();
  }

  function filterTitle() {
    if (query) return 'Search';
    if (filter === 'all') return 'All notes';
    if (filter === 'pinned') return 'Pinned';
    if (filter === 'due') return 'Due soon';
    if (filter === 'trash') return 'Trash';
    const f = V.data.folders.get(filter);
    return f ? f.name : 'All notes';
  }

  function counts() {
    const all = live();
    const by = {};
    for (const n of all) by[n.folder_id] = (by[n.folder_id] || 0) + 1;
    return { all: all.length, pinned: all.filter((n) => n.pinned).length, due: all.filter((n) => n.due && !n.done).length, by };
  }

  function navItem(id, icon, label, count, emoji) {
    return V.h('button.nav-item' + (filter === id && !query ? '.on' : ''), {
      type: 'button', onclick: () => setFilter(id), dataset: { id },
      oncontextmenu: V.data.folders.has(id) ? (event) => { event.preventDefault(); folderMenu(V.data.folders.get(id), event.currentTarget); } : null,
    }, emoji ? V.h('span.emoji', { text: emoji }) : V.icon(icon), V.h('span.nav-label', { text: label }),
    count ? V.h('span.count', { text: String(count) }) : null);
  }

  function drawFolders() {
    const c = counts();
    const list = [
      navItem('all', 'notes', 'All notes', c.all),
      navItem('pinned', 'pin', 'Pinned', c.pinned),
      navItem('due', 'calendar', 'Due soon', c.due),
      V.h('div.nav-heading', {}, V.h('span', { text: 'Folders' }), V.iconButton('plus', 'New folder', newFolder, 'tiny')),
      folders().map((f) => V.h('div.folder-row', {},
        navItem(f.id, 'folder', f.name, c.by[f.id], f.icon),
        V.iconButton('more', `${f.name} options`, (event) => folderMenu(f, event.currentTarget), 'tiny folder-more'))),
      V.h('div.nav-spacer'),
      navItem('trash', 'trash', 'Trash', 0),
    ];
    V.clear(parts.folders, list);
    // The phone's folder chips: the same choices in a row.
    const chips = [
      ['all', 'All', null], ['pinned', 'Pinned', '📌'], ['due', `Due${c.due ? ' · ' + c.due : ''}`, '⏰'],
      ...folders().map((f) => [f.id, f.name, f.icon || '📁']), ['trash', 'Trash', '🗑️'],
    ];
    V.clear(parts.chips, chips.map(([id, label, emoji]) => V.h('button.chip' + (filter === id && !query ? '.on' : ''), {
      type: 'button', onclick: () => setFilter(id),
      oncontextmenu: V.data.folders.has(id) ? (event) => { event.preventDefault(); folderMenu(V.data.folders.get(id), event.currentTarget); } : null,
    }, emoji ? V.h('span.emoji', { text: emoji }) : null, label)),
    V.h('button.chip.add', { type: 'button', onclick: newFolder, 'aria-label': 'New folder' }, V.icon('plus')));
    const on = parts.chips.querySelector('.chip.on');
    if (on && parts.chips.offsetParent) {  // only on the phone, where the chips show
      const left = on.offsetLeft - parts.chips.offsetLeft;
      if (left < parts.chips.scrollLeft || left + on.offsetWidth > parts.chips.scrollLeft + parts.chips.clientWidth) {
        parts.chips.scrollLeft = Math.max(0, left - 14);
      }
    }
  }

  function card(note) {
    const folder = folderOf(note);
    const due = V.due(note.due, note.done);
    const prog = note.locked ? null : progress(note);
    const pictures = (note.attachments || []).length;
    const showFolder = filter === 'all' || filter === 'pinned' || filter === 'due' || query;
    return V.h('button.card' + (V.editor.openId() === note.id ? '.open' : '') + (note.done ? '.done' : ''), {
      type: 'button', onclick: () => (filter === 'trash' ? trashMenu(note) : open(note.id)), dataset: { id: note.id },
    },
    V.h('div.card-top', {},
      V.h('span.card-title', { text: V.noteTitle(note) }),
      note.pinned ? V.icon('pin', 'pinned') : null,
      note.locked ? V.icon('lock', 'locked') : null),
    note.locked ? V.h('div.card-snippet.muted', { text: 'Locked: open it with your PIN' })
      : plain(note) && (note.title || '').trim() ? V.h('div.card-snippet', { text: plain(note).slice(0, 160) }) : null,
    prog ? V.h('div.progress', {}, V.h('div.bar', {}, V.h('i', { style: { width: (100 * prog.done / prog.all) + '%' } })),
      V.h('span', { text: `${prog.done}/${prog.all}` })) : null,
    V.h('div.card-meta', {},
      showFolder && folder ? V.h('span.tag', {}, folder.icon ? folder.icon + ' ' : '', folder.name) : null,
      due ? V.h('span.due.' + (due.cls || 'later'), { text: due.label }) : null,
      pictures ? V.h('span.tag', {}, V.icon('image'), String(pictures)) : null,
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

  function drawList() {
    const list = shown();
    parts.heading.textContent = filterTitle();
    parts.headCount.textContent = list.length ? String(list.length) : '';
    const empty = () => {
      if (query) return V.h('div.empty', {}, V.h('p', { text: `Nothing matches "${query}".` }));
      if (filter === 'trash') return V.h('div.empty', {}, V.h('p', { text: 'The Trash is empty.' }));
      if (filter === 'due') return V.h('div.empty', {}, V.h('div.empty-art', { text: '🎉' }), V.h('p', { text: 'Nothing due. Homework notes get a due date.' }));
      if (filter === 'pinned') return V.h('div.empty', {}, V.h('p', { text: 'Pin a note to keep it at the top.' }));
      return V.h('div.empty', {}, V.h('div.orb'), V.h('p', { text: 'No notes here yet.' }),
        V.button('New note', { kind: 'primary', icon: 'plus', onClick: chooseTemplate }));
    };
    const trashBar = filter === 'trash' && list.length ? V.h('div.list-bar', {}, V.button('Empty the Trash', {
      kind: 'danger-quiet', icon: 'trash', onClick: async () => {
        if (!(await V.confirm('Empty the Trash?', `${list.length} note${list.length > 1 ? 's' : ''} will be deleted for good.`, { ok: 'Delete them', danger: true }))) return;
        for (const note of list) await V.cloud.purgeNote(note);
      },
    })) : null;
    V.clear(parts.list, trashBar, list.length ? list.map(card) : empty());
  }

  function draw() {
    if (!parts) return;
    drawFolders();
    drawList();
  }

  function open(id, opts = {}) {
    if (V.wide()) V.editor.open(id, { pane: parts.pane, ...opts });
    else V.editor.open(id, opts);
    for (const el of parts.list.querySelectorAll('.card')) el.classList.toggle('open', el.dataset.id === id);
  }

  function render(container) {
    root = container;
    const search = V.h('input.search', {
      type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', value: query,
      oninput: V.debounce(() => { query = search.value.trim(); draw(); }, 120),
      onkeydown: (event) => { if (event.key === 'Escape') { search.value = ''; query = ''; draw(); } },
    });
    parts = {
      search,
      folders: V.h('nav.folders', { 'aria-label': 'Folders' }),
      chips: V.h('div.chips', { role: 'tablist' }),
      heading: V.h('h1'),
      headCount: V.h('span.head-count'),
      list: V.h('div.list'),
      pane: V.h('section.pane'),
    };
    const listColumn = V.h('section.list-column', {},
      V.h('div.list-head', {},
        V.h('div.search-box', {}, V.icon('search'), search),
        V.button('New', { kind: 'primary new-note', icon: 'plus', onClick: chooseTemplate, title: 'New note (Ctrl+N)' })),
      parts.chips,
      V.h('div.list-title', {}, parts.heading, parts.headCount),
      parts.list);
    V.clear(container, V.h('div.notes-layout', {}, parts.folders, listColumn, parts.pane),
      V.h('button.fab', { type: 'button', onclick: chooseTemplate, 'aria-label': 'New note' }, V.icon('plus')));
    draw();
    V.editor.placeholder(parts.pane);
    const opened = V.editor.openId();
    if (opened && V.wide()) V.editor.open(opened, { pane: parts.pane });
  }

  const showing = () => !!root && root.isConnected && root.dataset.tab === 'notes';
  // Behind the phone's full-screen note there's nothing to redraw (it's redrawn as the note closes).
  const redraw = V.debounce(() => { if (showing() && !V.editor.covering()) draw(); }, 60);
  V.on('data', (table) => { if (table === 'notes' || table === 'folders') redraw(); });
  document.addEventListener('keydown', (event) => {
    if (!showing()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !event.shiftKey) {
      event.preventDefault();
      chooseTemplate();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && parts) {
      event.preventDefault();
      parts.search.focus();
    }
  });

  return { render, create, chooseTemplate, ensureStarterFolders, blankNote, open, folders, inbox, setFilter, plain };
})();
