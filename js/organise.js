/* Vault: keeping notes in order. Folders (made with a name and an emoji, renamed, put in order, put inside each other
   up to DEPTH levels, deleted), moving notes (one at a time, or several picked at once), the Archive, your own
   templates, #tags read from the words, and what the search box understands (in:School, #tag, has:checklist, due:week,
   is:pinned...). notes.js draws the Notes tab with these, and the editor's folder picker and More menu use them too.

   Nothing new is stored but in a note's `extra`: archived, is_template and template_name, with organised_at saying
   when one of those was last changed (see keepOrganised); and in a folder's, its parent (extra.parent). Tags aren't
   stored at all: they're read from the words each time, so Jarvis and the other device see the same ones. */
'use strict';

V.organise = (() => {
  /* -- a few more line icons (drawn like util.js's, on a 24 grid; fixed strings only) */

  const FOLDER = '<path d="M3.5 7.5v10A2.5 2.5 0 0 0 6 20h12a2.5 2.5 0 0 0 2.5-2.5V10A2.5 2.5 0 0 0 18 7.5h-6.2L9.6 5H6a2.5 2.5 0 0 0-2.5 2.5z"/>';
  const MORE_ICONS = {
    archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1.5"/><path d="M5 8.5v9A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-9M10 12.5h4"/>',
    hash: '<path d="M5 9h15M4 15h15M10.5 4l-2 16M15.5 4l-2 16"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    rows: '<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/>',
    sort: '<path d="M7.5 4.5v15M4 16l3.5 3.5L11 16M14 6.5h6.5M14 12h4.5M14 17.5h2.5"/>',
    'folder-move': FOLDER + '<path d="M9 13.75h6M12.75 11.5 15 13.75 12.75 16"/>',
    'folder-plus': FOLDER + '<path d="M12 11v5.5M9.25 13.75h5.5"/>',
    select: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
    up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
    edit: '<path d="M4.5 19.5h4l10.2-10.2a2.83 2.83 0 0 0-4-4L4.5 15.5z"/><path d="m13.5 6.5 4 4"/>',
    smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2a4 4 0 0 0 6.8 0"/><circle cx="9.3" cy="10" r=".7" fill="currentColor" stroke="none"/><circle cx="14.7" cy="10" r=".7" fill="currentColor" stroke="none"/>',
    blank: '',
  };
  const plainIcon = V.icon;
  V.icon = function icon(name, cls) {
    if (!Object.prototype.hasOwnProperty.call(MORE_ICONS, name)) return plainIcon(name, cls);
    const span = plainIcon('', cls);
    span.firstChild.innerHTML = MORE_ICONS[name];
    return span;
  };

  /* -- what's kept in a note's extra */

  const KEPT = ['archived', 'is_template', 'template_name'];
  const STAMP = 'organised_at';
  const isArchived = (note) => !!(note && note.extra && note.extra.archived);
  const isTemplate = (note) => !!(note && note.extra && note.extra.is_template);

  /* `row` with these organise values changed (false or null takes one away), stamped as newer than anything this
     device has seen for the note (so a clock running slow on this device can't make a change look older). */
  function stamped(row, values) {
    const extra = { ...(row.extra || {}) };
    for (const [key, value] of Object.entries(values)) {
      if (value === false || value === null || value === undefined || value === '') delete extra[key];
      else extra[key] = value;
    }
    const here = V.data.notes.get(row.id);
    const before = [here && here.extra && here.extra[STAMP], row.extra && row.extra[STAMP]]
      .map((value) => Date.parse(value || '')).filter(Number.isFinite);
    const now = Math.max(Date.now(), ...before.map((time) => time + 1));
    extra[STAMP] = new Date(now).toISOString();
    return { ...row, extra };
  }

  /* The editor saves its own copy of the open note, whole. If the note was archived (or made a template) since it
     was opened, here or on the other device, that copy still says it wasn't: so when a row comes to be saved with
     organise values older than the ones this device already has, the newer ones are kept. */
  function keepOrganised(row) {
    const here = V.data.notes.get(row.id);
    const theirs = here && here.extra && here.extra[STAMP];
    if (!theirs || here === row) return row;
    const mine = row.extra && row.extra[STAMP];
    if (mine && mine >= theirs) return row;
    const extra = { ...(row.extra || {}) };
    for (const key of [...KEPT, STAMP]) {
      if (key in here.extra) extra[key] = here.extra[key];
      else delete extra[key];
    }
    return { ...row, extra };
  }
  const plainSave = V.cloud.save;
  V.cloud.save = (table, row, options) => plainSave(table, table === 'notes' && row && row.id ? keepOrganised(row) : row, options);

  /* -- #tags */

  // A # that starts a word (not "C#", a link's #part or "##"), then letters, numbers, - and _, with a letter in it
  // somewhere ("#2" is a number, not a tag).
  const TAG = /(?<![\p{L}\p{M}\p{N}_&#/\\.:=?@'"-])#(?=\p{N}*\p{L})([\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*)/gu;
  const tagCache = new WeakMap();

  /* A note's tags as [{key: 'bio', name: 'Bio'}], in the order they first appear. A locked note's come only from its
     title (its words are sealed). */
  function tagsOf(note) {
    let found = tagCache.get(note);
    if (found) return found;
    const text = (note.title || '') + '\n' + (note.locked ? '' : note.body || '');
    const seen = new Map();
    for (const match of text.matchAll(TAG)) {
      const name = match[1].slice(0, 60).replace(/[-_]+$/, '');
      const key = name.toLowerCase();
      if (key && !seen.has(key)) seen.set(key, name);
    }
    found = [...seen].map(([key, name]) => ({ key, name }));
    tagCache.set(note, found);
    return found;
  }

  /* Every tag in `notes`, A to Z, with how many notes have it. */
  function allTags(notes) {
    const all = new Map();
    for (const note of notes) {
      for (const tag of tagsOf(note)) {
        const had = all.get(tag.key);
        if (had) had.count++;
        else all.set(tag.key, { ...tag, count: 1 });
      }
    }
    return [...all.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  /* -- what the search box understands */

  const HAS = { checklist: 'checklist', checklists: 'checklist', list: 'checklist', todo: 'checklist', tick: 'checklist',
    picture: 'picture', pictures: 'picture', photo: 'picture', photos: 'picture', image: 'picture', images: 'picture',
    pic: 'picture', link: 'link', links: 'link', url: 'link', file: 'file', files: 'file', due: 'due', tag: 'tag', tags: 'tag' };
  const DUE = { today: 'today', tomorrow: 'tomorrow', week: 'week', 'this-week': 'week', soon: 'week', late: 'late',
    overdue: 'late', any: 'any' };
  const IS = { pinned: 'pinned', pin: 'pinned', archived: 'archived', archive: 'archived', done: 'done', locked: 'locked' };
  const CHECKLIST = /^\s*[-*]\s*\[( |x|X)\]/m;
  const dueDays = (note) => (note.due ? V.due(note.due).days : null);
  const HAS_TEST = {
    checklist: (n) => !n.locked && CHECKLIST.test(n.body || ''),
    picture: (n) => (n.attachments || []).some((a) => !a.mime || /^image\//.test(a.mime)),
    file: (n) => (n.attachments || []).some((a) => a.mime && !/^image\//.test(a.mime)),
    link: (n) => /\bhttps?:\/\/\S|\bwww\.\S/i.test((n.title || '') + ' ' + (n.locked ? '' : n.body || '')),
    due: (n) => !!n.due,
    tag: (n) => tagsOf(n).length > 0,
  };
  const DUE_TEST = {
    today: (n) => !n.done && dueDays(n) === 0,
    tomorrow: (n) => !n.done && dueDays(n) === 1,
    week: (n) => !n.done && !!n.due && dueDays(n) >= 0 && dueDays(n) <= 7,
    late: (n) => !n.done && !!n.due && dueDays(n) < 0,
    any: (n) => !!n.due,
  };
  const IS_TEST = { pinned: (n) => !!n.pinned, archived: isArchived, done: (n) => !!n.done, locked: (n) => !!n.locked };

  /* What was typed, as words to find and filters: "maths #exam in:School has:checklist due:week". A filter Vault
     doesn't know ("has:cats") is just words; one still being typed ("in:") is left out until it has a value. */
  function parseQuery(text) {
    const q = { words: [], tags: [], folders: [], has: [], due: [], is: [] };
    for (const token of String(text || '').match(/[^\s"]*"[^"]*"?|\S+/g) || []) {
      const filter = /^(in|has|due|is):(.*)$/i.exec(token);
      if (filter) {
        const kind = filter[1].toLowerCase();
        const value = filter[2].replace(/"/g, '').trim().toLowerCase();
        if (!value) continue;
        if (kind === 'in') { q.folders.push(value); continue; }
        const known = { has: HAS, due: DUE, is: IS }[kind][value.replace(/\s+/g, '-')];
        if (known) { q[kind].push(known); continue; }
      }
      if (token.startsWith('#')) {
        const tag = token.slice(1).toLowerCase().replace(/[-_.,!?;:]+$/, '');
        if (tag) q.tags.push(tag);
        continue;
      }
      const word = token.replace(/"/g, '').trim().toLowerCase();
      if (word) q.words.push(word);
    }
    q.empty = !(q.words.length || q.tags.length || q.folders.length || q.has.length || q.due.length || q.is.length);
    return q;
  }

  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /* The folders the query's in: filters can mean (by name, or the start of one: in:sci for Science), with the folders
     inside them, and the first name no folder has. */
  function foldersFor(q) {
    if (!q.folders.length) return { ids: null, missing: null };
    const all = V.notes.folders();
    const ids = new Set();
    let missing = null;
    for (const name of q.folders) {
      const want = squash(name);
      const exact = all.filter((f) => squash(f.name) === want);
      const found = exact.length ? exact : want ? all.filter((f) => squash(f.name).startsWith(want)) : [];
      if (!found.length && !missing) missing = name;
      for (const folder of found) {
        ids.add(folder.id);
        for (const id of inside(folder.id)) ids.add(id);  // and the folders inside it
      }
    }
    return { ids, missing };
  }

  /* A test for notes against the query (archived or not is the list's business: is:archived only says which list). */
  function matcher(q) {
    const { ids } = foldersFor(q);
    return (note) => {
      const title = (note.title || '').toLowerCase();
      const body = note.locked ? '' : (note.body || '').toLowerCase();
      // A word can also be inside an attachment the PC has read (js/attachsearch.js); never a locked note.
      if (!q.words.every((w) => title.includes(w) || body.includes(w)
          || (V.attachSearch && V.attachSearch.hasWord(note, w)))) return false;
      if (q.tags.length) {
        const mine = tagsOf(note).map((t) => t.key);
        if (!q.tags.every((t) => mine.some((key) => key.startsWith(t)))) return false;
      }
      if (ids && !ids.has(note.folder_id)) return false;
      return q.has.every((h) => HAS_TEST[h](note)) && q.due.every((d) => DUE_TEST[d](note))
        && q.is.every((i) => IS_TEST[i](note));
    };
  }

  /* The bits of words to light up in the cards: the words, and the tags as typed (#bio). */
  const terms = (q) => [...q.words, ...q.tags.map((t) => '#' + t)];
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = (list) => {
    const words = [...new Set(list.filter(Boolean))].sort((a, b) => b.length - a.length);
    return words.length ? new RegExp(words.map(escape).join('|'), 'giu') : null;
  };

  /* `text` as text pieces and <mark> elements round each match (never as HTML). */
  function marked(text, list) {
    const find = pattern(list);
    if (!find || !text) return [text || ''];
    const out = [];
    let at = 0;
    for (const match of text.matchAll(find)) {
      if (!match[0]) continue;
      if (match.index > at) out.push(text.slice(at, match.index));
      out.push(V.h('mark.hit', { text: match[0] }));
      at = match.index + match[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }

  /* Up to `size` letters of `text`, starting a little before the first match (so the match shows on the card). */
  function snippet(text, list, size = 160) {
    const find = pattern(list);
    const match = find ? find.exec(text) : null;
    if (!match || match.index < 50) return text.slice(0, size);
    let from = text.lastIndexOf(' ', match.index - 30);
    from = from < 0 ? match.index - 30 : from + 1;
    return '…' + text.slice(from, from + size);
  }

  /* -- sort and view, kept per device */

  const SORTS = [['edited', 'Last edited'], ['created', 'Date created'], ['title', 'Title (A to Z)'], ['due', 'Due date']];
  function pref(key, allowed, fallback) {
    try {
      const value = localStorage.getItem(key);
      return allowed.includes(value) ? value : fallback;
    } catch (error) {
      return fallback;
    }
  }
  function setPref(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* private browsing: it lasts until the page closes */ }
    memory[key] = value;
  }
  const memory = {};
  const sort = () => memory['vault-sort'] || pref('vault-sort', SORTS.map((s) => s[0]), 'edited');
  const view = () => memory['vault-view'] || pref('vault-view', ['list', 'grid'], 'list');

  const edited = (n) => V.editedAt(n);  // (a flash card's progress isn't an edit: js/cloud.js)
  const created = (n) => n.created_at || '~';  // made here and not sent yet: the newest
  const dueRank = (n) => (n.due ? (n.done ? 1 : 0) : 2);
  function comparator(by) {
    const newest = (a, b) => edited(b).localeCompare(edited(a));
    if (by === 'created') return (a, b) => created(b).localeCompare(created(a)) || newest(a, b);
    if (by === 'title') {
      return (a, b) => V.noteTitle(a).localeCompare(V.noteTitle(b), undefined, { numeric: true, sensitivity: 'base' }) || newest(a, b);
    }
    if (by === 'due') return (a, b) => (dueRank(a) - dueRank(b)) || (a.due || '').localeCompare(b.due || '') || newest(a, b);
    return newest;
  }

  /* -- folders */

  const EMOJI = ['📁', '📚', '🧪', '🧮', '🌍', '📜', '🎨', '🎵', '⚽', '💪', '🎮', '🕹️', '💻', '💼', '🏠', '🛒', '🍕', '✈️',
    '💡', '⭐', '❤️', '🔥', '📷', '🎬', '🐶', '📝'];
  const segmenter = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = (text) => (segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : [...text]);
  const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;
  const isInbox = (folder) => !!folder && (folder.name || '').trim().toLowerCase() === 'inbox';

  /* -- folders inside folders

     A folder's parent is kept in its own extra (extra.parent = the parent's id; none = the top level), as the cloud's
     tables can't change any more; a Vault from before shows them all at the top level. A parent that's gone (deleted,
     or not on this device yet) or that would make a loop (two devices moving folders into each other at once) counts
     as none, so every folder always shows somewhere. Inbox is always at the top. */

  const DEPTH = 5;  // levels at most: a folder in a folder in a folder in a folder in a folder
  const TOP = { id: null, top: true };  // "the top level", as chooseFolder answers it
  const liveFolder = (id) => { const f = id ? V.data.folders.get(id) : null; return f && !f.deleted ? f : null; };
  const rawParent = (f) => (f && !isInbox(f) && f.extra && typeof f.extra.parent === 'string' ? f.extra.parent : null);

  /* The id of the folder `folder` is drawn in, or null at the top level. Only a folder on a loop loses its parent (a
     loop further up is broken there), so the folders below one stay where they were put. */
  function parentId(folder) {
    const first = liveFolder(rawParent(folder));
    const seen = new Set();
    for (let up = first; up && !seen.has(up.id); up = liveFolder(rawParent(up))) {
      if (up.id === folder.id) return null;
      seen.add(up.id);
    }
    return first ? first.id : null;
  }

  const children = (id) => V.notes.folders().filter((f) => parentId(f) === id);

  /* The folders `folder` is in, the top one first. */
  function ancestors(folder) {
    const out = [];
    for (let up = liveFolder(parentId(folder)); up && out.length < 50; up = liveFolder(parentId(up))) out.unshift(up);
    return out;
  }
  const depthOf = (folder) => ancestors(folder).length + 1;
  const pathOf = (folder) => [...ancestors(folder), folder];

  /* The ids of every folder inside folder `id`, at any depth. */
  function inside(id) {
    const found = new Set();
    const all = V.notes.folders();
    for (let more = [id]; more.length;) {
      const next = all.filter((f) => !found.has(f.id) && more.includes(parentId(f)));
      for (const f of next) found.add(f.id);
      more = next.map((f) => f.id);
    }
    return found;
  }

  /* How many levels `folder` and the folders inside it take (1 when it has none). */
  const height = (folder) => 1 + Math.max(0, ...[...inside(folder.id)].map((id) =>
    ancestors(V.data.folders.get(id)).length - ancestors(folder).length));

  /* Every folder in order, each followed by the ones inside it: [{folder, depth (0 = the top), kids}]. */
  function tree() {
    const all = V.notes.folders();
    const under = new Map();
    for (const f of all) {
      const p = parentId(f);
      if (!under.has(p)) under.set(p, []);
      under.get(p).push(f);
    }
    const out = [];
    const walk = (id, depth) => {
      for (const folder of under.get(id) || []) {
        out.push({ folder, depth, kids: (under.get(folder.id) || []).length });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /* `folder` saved with some fields changed and some of its extra (null takes one away), from the copy this device has
     now, so nothing else kept in its extra is lost. Last device to send wins, as for every folder change. */
  function saveFolder(folder, fields = {}, extras = {}) {
    const now = V.data.folders.get(folder.id) || folder;
    const extra = { ...(now.extra || {}) };
    for (const [key, value] of Object.entries(extras)) {
      if (value === null || value === undefined) delete extra[key];
      else extra[key] = value;
    }
    return V.cloud.save('folders', { ...now, ...fields, extra });
  }

  /* What's wrong with a folder called `name` in `parent` (null = the top level), or '': two folders side by side never
     share a name. */
  function nameTaken(name, parent, except = null) {
    const same = children(parent ? parent.id : null).find((f) => f.id !== except && f.name.trim().toLowerCase() === name.toLowerCase());
    if (!same) return '';
    return parent ? `${parent.name} already has a folder called ${same.name}.` : `You already have a folder called ${same.name}.`;
  }

  /* Why `folder` can't go into `parent` (null = the top level), or ''. */
  function cantMove(folder, parent) {
    if (isInbox(folder)) return 'Inbox stays at the top.';
    if (!parent) return '';
    if (parent.id === folder.id) return 'A folder can\'t go inside itself.';
    if (inside(folder.id).has(parent.id)) return `A folder can't go inside itself: ${parent.name} is inside ${folder.name}.`;
    if (depthOf(parent) + height(folder) > DEPTH) return `Folders go ${DEPTH} levels deep at most: ${folder.name} won't fit in ${parent.name}.`;
    return '';
  }
  const canHoldMore = (folder) => depthOf(folder) < DEPTH;

  /* The sheet for a folder's name and emoji (or one of them), and where a new one goes. Resolves {name, icon, parent},
     or null if it was closed. */
  function folderSheet({ title, ok, folder = null, askName = true, askIcon = true, askParent = false, parent = null }) {
    return new Promise((resolve) => {
      let result = null;
      let icon = folder ? folder.icon || '' : '📁';
      let touched = false;
      const name = askName ? V.h('input.field.folder-name', {
        type: 'text', value: folder ? folder.name : '', placeholder: 'Like Science, Minecraft or Gym', maxlength: '60',
        autocomplete: 'off', autocapitalize: 'words', 'aria-label': 'Folder name',
        oninput: () => { error.textContent = ''; },
      }) : null;
      // Inside: the top level or any folder with room for one more level, indented as a tree.
      const within = askParent ? V.h('select.field.folder-parent', {
        'aria-label': 'Inside', onchange: () => { error.textContent = ''; },
      }, V.h('option', { value: '', text: 'Nothing (the top level)' }), tree().map(({ folder: f, depth }) => V.h('option', {
        value: f.id, disabled: !canHoldMore(f), text: ' '.repeat(depth) + (f.icon ? f.icon + ' ' : '') + f.name,
      }))) : null;
      if (within) within.value = parent && canHoldMore(parent) ? parent.id : '';
      const error = V.h('p.error-text', { role: 'alert' });
      const cells = [];
      const own = V.h('input.field.emoji-own', {
        type: 'text', placeholder: 'Type or paste an emoji', autocomplete: 'off', 'aria-label': 'Your own emoji',
        // Only read, never rewritten while it's typed in (the phone's keyboard would lose its word).
        oninput: () => {
          const first = graphemes(own.value.trim())[0] || '';
          if (first && first.length <= 40) { icon = first; touched = true; mark(); }
        },
      });
      const pick = (value, label, content) => {
        const cell = V.h('button.emoji-pick', {
          type: 'button', title: label, 'aria-label': label, dataset: { icon: value },
          onclick: () => { icon = value; touched = true; own.hidden = true; mark(); },
        }, content);
        cells.push(cell);
        return cell;
      };
      const other = V.h('button.emoji-pick.other', {
        type: 'button', title: 'Type your own', 'aria-label': 'Type your own',
        onclick: () => { own.hidden = false; own.focus(); },
      }, V.icon('edit'));
      function mark() {
        let found = false;
        for (const cell of cells) {
          const on = cell.dataset.icon === icon;
          found = found || on;
          cell.setAttribute('aria-pressed', String(on));
        }
        other.setAttribute('aria-pressed', String(!found));
      }
      own.hidden = !icon || EMOJI.includes(icon);
      if (!own.hidden) own.value = icon;
      const grid = askIcon ? V.h('div.emoji-grid', { role: 'group', 'aria-label': 'Emoji' },
        pick('', 'No emoji', V.h('i.dot.slate')), EMOJI.map((e) => pick(e, e, V.h('span.emoji', { text: e }))), other) : null;
      mark();

      function check() {
        let words = askName ? name.value.replace(/\s+/g, ' ').trim() : folder.name;
        let chosen = askIcon ? icon : folder.icon || '';
        if (askName && askIcon && !touched) {
          // "🧪 Science": the emoji becomes the folder's own.
          const first = graphemes(words)[0] || '';
          const rest = words.slice(first.length).trim();
          if (STARTS_WITH_EMOJI.test(first) && rest && first.length <= 40) { chosen = first; words = rest; }
        }
        if (!words) { error.textContent = 'Give the folder a name.'; return null; }
        words = words.slice(0, 60);
        const home = within ? liveFolder(within.value) : folder ? liveFolder(parentId(folder)) : null;
        const taken = nameTaken(words, home, folder && folder.id);
        if (taken) { error.textContent = taken; return null; }
        return { name: words, icon: chosen, parent: home };
      }
      V.sheet({
        title,
        content: [
          askName ? V.h('label.label', { text: 'Name' }, name) : null,
          within ? V.h('label.label', { text: 'Inside' }, within) : null,
          askIcon ? V.h('div.label', { text: 'Emoji' }) : null, grid, askIcon ? own : null, error,
        ],
        actions: [{ label: 'Cancel' }, { label: ok, kind: 'primary', onClick: () => {
          const done = check();
          if (!done) return true;  // stays open, saying what's wrong
          result = done;
          return false;
        } }],
        onClose: () => resolve(result),
      });
    });
  }

  /* A new folder, at the end of the list (or of `parent`'s). Resolves the folder, or null. */
  async function newFolder({ parent = null } = {}) {
    const made = await folderSheet({ title: parent ? `New folder in ${parent.name}` : 'New folder', ok: 'Make folder',
      askParent: true, parent });
    if (!made) return null;
    const sort = Math.max(-1, ...V.notes.folders().map((f) => Number(f.sort) || 0)) + 1;
    const folder = await V.cloud.save('folders', { id: V.uuid(), name: made.name, icon: made.icon, sort, deleted: false,
      extra: made.parent ? { parent: made.parent.id } : {} });
    V.toast(made.parent ? `Made the folder ${folder.name} in ${made.parent.name}` : `Made the folder ${folder.name}`);
    return folder;
  }

  /* `folder` put in folder `toId` (null = the top level), unless that would make a loop, go too deep or give two folders
     side by side the same name (then a toast says why). Resolves true when it moved. */
  async function moveFolder(folder, toId) {
    const now = V.data.folders.get(folder.id) || folder;
    const parent = liveFolder(toId);
    if (toId && !parent) return false;
    const was = parentId(now);
    if (was === (parent ? parent.id : null)) {
      V.toast(parent ? `${now.name} is already in ${parent.name}` : `${now.name} is already at the top`);
      return false;
    }
    const why = cantMove(now, parent) || nameTaken(now.name, parent, now.id);
    if (why) { V.toast(why, { kind: 'err', ms: 5000 }); return false; }
    await saveFolder(now, {}, { parent: parent ? parent.id : null });
    V.toast(parent ? `Moved ${now.name} into ${parent.name}` : `Moved ${now.name} to the top`, { action: 'Undo',
      onAction: () => { const back = liveFolder(was); saveFolder(now, {}, { parent: back ? back.id : null }).catch(V.problem); } });
    return true;
  }

  /* The ⋯ menu of a folder. Inbox keeps its name and its place (quick notes and Jarvis's notes go there) and can't be
     deleted. */
  function folderMenu(folder, anchor, { onGone, onMade } = {}) {
    const list = children(parentId(folder));  // up and down go among the folders beside it
    const at = list.findIndex((f) => f.id === folder.id);
    const home = isInbox(folder);
    V.menu(anchor, [
      home ? null : { label: 'Rename', icon: 'edit', onClick: async () => {
        const changed = await folderSheet({ title: 'Rename folder', ok: 'Rename', folder, askIcon: false });
        if (changed) await saveFolder(folder, { name: changed.name });
      } },
      { label: 'Change its emoji', icon: 'smile', onClick: async () => {
        const changed = await folderSheet({ title: `Emoji for ${folder.name}`, ok: 'Use it', folder, askName: false });
        if (changed) await saveFolder(folder, { icon: changed.icon });
      } },
      canHoldMore(folder) ? { label: 'New folder inside', icon: 'folder-plus', onClick: async () => {
        const made = await newFolder({ parent: V.data.folders.get(folder.id) || folder });
        if (made && onMade) onMade(made);
      } } : null,
      home ? null : { label: 'Move folder to...', icon: 'folder-move', onClick: async () => {
        const to = await chooseFolder({ title: `Move ${folder.name} to`, moving: folder });
        if (to) await moveFolder(folder, to.id);
      } },
      at > 0 ? { label: 'Move up', icon: 'up', onClick: () => reorder(folder, -1) } : null,
      at >= 0 && at < list.length - 1 ? { label: 'Move down', icon: 'down', onClick: () => reorder(folder, 1) } : null,
      home ? null : { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => deleteFolder(folder, onGone) },
    ]);
  }

  async function reorder(folder, step) {
    const list = children(parentId(folder));
    const at = list.findIndex((f) => f.id === folder.id);
    const to = at + step;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];
    for (let i = 0; i < list.length; i++) {
      if (Number(list[i].sort) !== i) await saveFolder(list[i], { sort: i });
    }
  }

  /* A folder deleted: its own notes go to Inbox (as always), and the folders inside it move up to where it was. */
  async function deleteFolder(folder, onGone) {
    const home = V.notes.inbox();
    const to = home && home.id !== folder.id ? home : null;
    const own = [...V.data.notes.values()].filter((n) => n.folder_id === folder.id && !n._purge);
    const count = own.filter((n) => !n.deleted && !isTemplate(n)).length;
    const where = to ? 'Inbox' : 'All notes';
    const up = liveFolder(parentId(folder));
    const kids = children(folder.id);
    const above = up ? up.name : 'the top level';
    const said = [count ? `Its ${count} note${count === 1 ? ' goes' : 's go'} to ${where}.` : kids.length ? 'It has no notes of its own.' : '',
      kids.length === 1 ? `The folder inside it, ${kids[0].name}, moves up to ${above}.`
        : kids.length ? `The ${kids.length} folders inside it move up to ${above}.` : ''].filter(Boolean);
    const ok = await V.confirm(`Delete ${folder.name}?`, said.length
      ? `${said.join(' ')} Only the folder is deleted, not ${kids.length ? 'what was in it' : 'the notes'}.`
      : 'It\'s empty, so only the folder goes.', { ok: 'Delete folder', danger: true });
    if (!ok) return;
    for (const kid of kids) await saveFolder(kid, {}, { parent: up ? up.id : null });
    await change(own.map((n) => n.id), (row) => ({ ...row, folder_id: to ? to.id : null }));
    await saveFolder(folder, { deleted: true });
    if (onGone) onGone();
    const moved = kids.length ? ` ${kids.length === 1 ? kids[0].name + ' is' : 'Its folders are'} in ${above}.` : '';
    V.toast(count ? `Deleted ${folder.name}. Its notes are in ${where}.${moved}` : moved ? `Deleted ${folder.name}.${moved}` : `Deleted ${folder.name}`);
  }

  /* A sheet listing the folders as a tree (and "New folder..."). Resolves the folder picked, or null. Moving a folder
     (`moving`), "The top level" comes first, and the folder itself, the ones inside it and any too deep can't be
     picked; it resolves TOP for the top level. */
  function chooseFolder({ title = 'Move to', current = null, moving = null } = {}) {
    return new Promise((resolve) => {
      let picked = null;
      let making = false;
      const here = moving ? parentId(V.data.folders.get(moving.id) || moving) : current;
      const row = (folder, depth) => {
        const why = moving ? cantMove(moving, folder) : '';
        return V.h('button.folder-choice' + (folder.id === here ? '.on' : ''), {
          type: 'button', 'aria-current': folder.id === here ? 'true' : null, dataset: { id: folder.id, depth: String(Math.min(depth, 4)) },
          disabled: !!why, title: why || null,
          onclick: () => { picked = folder; sheet.close(); },
        }, V.h('span.fc-badge', {}, V.notes.folderBadge(folder) || V.icon('folder')), V.h('span.fc-name', { text: folder.name }),
        folder.id === here ? V.icon('check', 'fc-check') : null);
      };
      const sheet = V.sheet({
        title,
        content: V.h('div.folder-choices', {},
          moving ? V.h('button.folder-choice.top' + (here ? '' : '.on'), {
            type: 'button', 'aria-current': here ? null : 'true', onclick: () => { picked = TOP; sheet.close(); },
          }, V.h('span.fc-badge', {}, V.icon('stack')), V.h('span.fc-name', { text: 'The top level' }),
          here ? null : V.icon('check', 'fc-check')) : null,
          tree().map(({ folder, depth }) => row(folder, depth)),
          moving ? null : V.h('button.folder-choice.new', { type: 'button', onclick: () => { making = true; sheet.close(); } },
            V.h('span.fc-badge', {}, V.icon('folder-plus')), V.h('span.fc-name', { text: 'New folder...' }))),
        onClose: () => {
          if (making) newFolder().then(resolve, (error) => { V.problem(error); resolve(null); });
          else resolve(picked);
        },
      });
    });
  }

  /* -- changing several notes at once */

  /* The notes `ids` changed by `edit` (the row as it is now in, the changed row out). The note open beside the list
     is closed first (what's typed in it saved), as the editor would otherwise save its own copy back over the change,
     and opened again after if it's still to be seen. Returns the rows as they were, for Undo. */
  async function change(ids, edit, { reopen = true } = {}) {
    const open = V.editor.openId();
    const closing = !!open && ids.includes(open);
    if (closing) {
      V.editor.close();
      await V.editor.settled();
    }
    const before = [];
    for (const id of ids) {
      const row = V.data.notes.get(id);
      if (!row || row._purge) continue;
      before.push(row);
      await V.cloud.save('notes', edit(row));
    }
    const now = closing && V.data.notes.get(open);
    if (now && reopen && V.wide() && !now.deleted && (reopen === true || reopen(now))) V.notes.open(open);
    return before;
  }

  const some = (count) => (count === 1 ? '' : `${count} notes `);
  const putBack = (before, fields) => () => change(before.map((r) => r.id), (row) => {
    const old = before.find((b) => b.id === row.id) || row;
    const next = { ...row };
    for (const field of fields) next[field] = old[field];
    return next;
  }).catch(V.problem);

  async function move(ids, folderId) {
    const folder = V.data.folders.get(folderId);
    const moving = ids.filter((id) => { const n = V.data.notes.get(id); return n && n.folder_id !== folderId; });
    if (!moving.length) return V.toast(folder ? `Already in ${folder.name}` : 'Already there');
    const before = await change(moving, (row) => ({ ...row, folder_id: folderId }));
    V.toast(`Moved ${some(before.length)}to ${folder ? folder.name : 'no folder'}`,
      { action: 'Undo', onAction: putBack(before, ['folder_id']) });
  }

  async function pin(ids, on) {
    const before = await change(ids, (row) => ({ ...row, pinned: on }));
    const what = some(before.length).trim();
    V.toast(on ? `Pinned ${what ? what + ' ' : ''}to the top` : `Unpinned${what ? ' ' + what : ''}`,
      { action: 'Undo', onAction: putBack(before, ['pinned']) });
  }

  async function archive(ids, on, { quiet = false } = {}) {
    const before = await change(ids, (row) => stamped(row, { archived: on }), { reopen: () => !on });
    if (quiet) return;
    const undo = () => change(before.map((r) => r.id), (row) => stamped(row, {
      archived: isArchived(before.find((b) => b.id === row.id)) })).catch(V.problem);
    const what = some(before.length).trim();
    V.toast(on ? `Archived${what ? ' ' + what : ''}` : `${what ? what + ' ' : ''}back from the archive`.replace(/^b/, 'B'),
      { action: 'Undo', onAction: undo });
  }

  async function trash(ids) {
    const when = new Date().toISOString();
    const before = await change(ids, (row) => ({ ...row, deleted: true, deleted_at: when }), { reopen: false });
    if (!before.length) return;
    V.toast(before.length === 1 ? 'Moved to Trash' : `${before.length} notes moved to the Trash`,
      { action: 'Undo', onAction: putBack(before, ['deleted', 'deleted_at']) });
  }

  /* Notes in the Trash put back where they were. */
  async function restore(ids) {
    const before = await change(ids, (row) => ({ ...row, deleted: false, deleted_at: null }), { reopen: false });
    if (!before.length) return;
    V.toast(before.length === 1 ? 'Put back' : `Put back ${before.length} notes`,
      { action: 'Undo', onAction: putBack(before, ['deleted', 'deleted_at']) });
  }

  /* -- your own templates */

  const templateName = (row) => ((row.extra && row.extra.template_name) || V.noteTitle(row) || 'My template').trim();
  const ownTemplates = () => [...V.data.notes.values()].filter((n) => isTemplate(n) && !n.deleted && !n._purge)
    .sort((a, b) => templateName(a).localeCompare(templateName(b), undefined, { numeric: true, sensitivity: 'base' }));

  /* A copy of a note's title and words (not its pictures) kept as a template. */
  async function saveTemplate({ title = '', body = '', folder_id = null }) {
    const suggested = (title || '').replace(/[:\s]+$/, '').trim() || 'My template';
    const name = await V.ask('Save as a template', {
      value: suggested, label: 'Template name', ok: 'Save template',
      hint: 'It shows up when you make a new note. Write {date} anywhere for today\'s date. Pictures aren\'t kept.',
    });
    if (name === null) return null;
    const blank = V.notes.blankNote({ folder_id, title, body });
    const row = await V.cloud.save('notes', stamped(blank, { is_template: true, template_name: (name.trim() || suggested).slice(0, 60) }));
    V.toast('Saved as a template. It\'s in the list when you make a new note.');
    return row;
  }

  /* The "Your templates" part of the new-note sheet: `use(template)` makes a note from one, `close()` closes the
     sheet (to edit one). */
  function templateSection(use, close) {
    const mine = ownTemplates();
    if (!mine.length) {
      return V.h('p.hint.t-tip', {}, V.icon('notes'), V.h('span', { text: 'Make your own templates: open a note, then More > Save as template.' }));
    }
    return [V.h('h3.t-section', { text: 'Your templates' }), V.h('div.templates.own-templates', {}, mine.map((row) => {
      const folder = V.data.folders.get(row.folder_id);
      const item = V.h('div.own-template', {},
        V.h('button.template', { type: 'button', dataset: { id: row.id },
          onclick: () => use({ id: 'own', own: true, title: row.title, body: row.body, folderId: row.folder_id }) },
        V.icon('notes'), V.h('span.t-name', { text: templateName(row) }),
        V.h('span.t-hint', { text: folder && !folder.deleted ? folder.name : 'Yours' })),
        V.iconButton('more', `${templateName(row)}: options`, (event) => V.menu(event.currentTarget, [
          { label: 'Edit the template', icon: 'edit', onClick: () => { close(); V.notes.open(row.id, { focusTitle: false }); } },
          { label: 'Rename', icon: 'text', onClick: async () => {
            const name = await V.ask('Rename template', { value: templateName(row), ok: 'Rename' });
            if (!name || !name.trim()) return;
            const now = V.data.notes.get(row.id) || row;
            await V.cloud.save('notes', stamped(now, { template_name: name.trim().slice(0, 60) }));
            item.querySelector('.t-name').textContent = name.trim().slice(0, 60);
          } },
          { label: 'Delete template', icon: 'trash', danger: true, onClick: async () => {
            if (!(await V.confirm(`Delete the template ${templateName(row)}?`, 'Notes you made from it stay as they are.',
              { ok: 'Delete', danger: true }))) return;
            const now = V.data.notes.get(row.id) || row;
            await V.cloud.save('notes', { ...now, deleted: true, deleted_at: new Date().toISOString() });
            item.remove();
            V.toast('Template deleted', { action: 'Undo', onAction: async () => {
              const back = V.data.notes.get(row.id);
              if (back) await V.cloud.save('notes', { ...back, deleted: false, deleted_at: null });
            } });
          } },
        ]), 'tiny t-more'));
      return item;
    }))];
  }

  return {
    isArchived, isTemplate, stamped, tagsOf, allTags, parseQuery, foldersFor, matcher, terms, marked, snippet,
    SORTS, sort, view, setSort: (value) => setPref('vault-sort', value), setView: (value) => setPref('vault-view', value),
    comparator, newFolder, folderSheet, folderMenu, chooseFolder, isInbox, move, pin, archive, trash, restore, change,
    DEPTH, TOP, parentId, children, ancestors, pathOf, depthOf, inside, tree, saveFolder, moveFolder, cantMove,
    saveTemplate, ownTemplates, templateName, templateSection,
  };
})();
