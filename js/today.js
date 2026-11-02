/* Wefty: Today (1.16), the first screen on every device: a greeting, then what's on today from your notes.

   On a phone, top to bottom: the greeting and the thread under it, Quick actions (New note, Note-taker, Dictate),
   Due today (each to-do of the notes due today or late, with a box to tick), Tests coming up (a countdown and how the
   flash cards for it are going), Flash cards due today (by the folder each card is in), Later this week, and Jump back
   in (pinned notes, then the ones edited last). On a Chromebook or the PC (900 px and up), full width: the greeting
   with the day's counts, the week from Monday to Friday, then two columns (tests, flash cards and Jump back in on the
   left; quick actions, due today and later on the right). Every number comes from this device's own copy of the notes
   (it works offline and costs nothing), through the same rules as Upcoming (js/reminders.js) and Review
   (js/review.js), so they always agree.

   Each part is drawn by section(), which catches and logs, so a bad row can't keep the app from opening (js/start.js's
   V.go is the second net: a Today that throws shows your notes instead). Other parts add their own sections with
   V.today.addSection (js/subs.js: Subscriptions).

   V.today() is util.js's date ('2026-11-02'), used all over: the screen hangs off it (V.today.render, .open,
   .addSection, .addMenuItem, .redraw), never in its place. Loaded after the other screens' scripts, and only drawn once
   the page's scripts have all run (js/start.js's main() waits for them). */
'use strict';

(() => {
  if (typeof V.today !== 'function') return;  // (util.js didn't load: nothing works anyway)
  /* Where Today's own sections go, so another part's section can go between them (`order`), and which column it
     takes on a wide screen ('left': tests, flash cards, Jump back in; 'right': quick actions, due today, later).
     `subs`: where Subscriptions (js/subs.js) goes: after the flash cards on a phone, in the right column when wide. */
  const ORDER = { quick: 10, due: 20, howto: 25, tests: 30, cards: 40, subs: 45, later: 50, devices: 55, jump: 60 };
  const MOST_DUE = 8;      // rows in Due today before "N more in Upcoming"
  const MOST_PER_NOTE = 5; // a note's to-dos in Due today before "+N more"
  const MOST_LATER = 5;
  const MOST_TESTS = 2;
  const MOST_DECKS = 4;
  const MOST_JUMP = 4;
  const TEST_DAYS = 14;    // tests this close show (the PC's briefing's window: vault/store.py study_today)
  const CHECK = /^(\s*[-*]\s*\[)( |x|X)(\]\s?)(.*)$/;  // (js/notes.js's CHECK, with the parts kept to flip the box)
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DRAWN = {  // fixed strings only
    listen: '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5"/><path d="M9 14v2M11.25 12v6M13.5 13v4M15.75 14.5v1"/>',
    dictate: '<path d="M6 4.5h4M6 19.5h4M8 4.5v15"/><path d="M14 9.5a3.5 3.5 0 0 1 0 5M17 7a7 7 0 0 1 0 10"/>',
    chev: '<path d="m9.5 6 6 6-6 6"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  };
  const extra = [];   // sections from other parts (js/subs.js): { id, order, column, build }
  const menuItems = [];  // ⋯ on Today's top row: { id, label, icon, onClick }
  let root = null;
  let synced = false;  // the first sync this page life has finished (so a new device doesn't greet a long-time user)

  const showing = () => !!root && root.isConnected && root.dataset.tab === 'today';
  const R = () => V.reminders;
  const RV = () => V.review;
  const O = () => V.organise;

  function icon(name, cls) {
    if (!Object.prototype.hasOwnProperty.call(DRAWN, name)) return V.icon(name, cls);
    const span = V.icon('', cls);
    span.firstChild.innerHTML = DRAWN[name];
    return span;
  }
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const daysFrom = (from, to) => Math.round((V.parseDate(to) - V.parseDate(from)) / 86400000);
  const emoji = (folder) => (folder && folder.icon ? V.h('span.emo', { text: folder.icon, 'aria-hidden': 'true' }) : null);
  const folderOf = (note) => (note && note.folder_id ? V.data.folders.get(note.folder_id) : null);

  /* A part of Today: drawn by `build()` (an element, or null for nothing), inside a catch. One that throws is one
     quiet line, never a broken screen. */
  function section(name, build) {
    try {
      const made = build();
      return made || null;
    } catch (error) {
      console.error(`Wefty: Today's ${name}:`, error);
      return V.h('p.today-trouble.hint', { dataset: { section: name }, text: 'Couldn\'t show this part.' });
    }
  }

  /* Another part's section on Today. `build` is called at every draw; `column` is where it goes when wide. */
  function addSection({ id, order = 100, column = 'right', build } = {}) {
    if (!id || typeof build !== 'function') return;
    const at = extra.findIndex((one) => one.id === id);
    const entry = { id: String(id), order: Number(order) || 100, column: column === 'left' ? 'left' : 'right', build };
    if (at >= 0) extra[at] = entry; else extra.push(entry);
    redraw();
  }
  function addMenuItem({ id, label, icon: name = '', onClick } = {}) {
    if (!id || !label || typeof onClick !== 'function') return;
    const at = menuItems.findIndex((one) => one.id === id);
    const entry = { id: String(id), label: String(label), icon: name, onClick };
    if (at >= 0) menuItems[at] = entry; else menuItems.push(entry);
    redraw();
  }

  function greeting(now = new Date()) {
    const hour = now.getHours();
    return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  }

  /* -- the notes Today reads */

  /* Live notes: not deleted, archived or a template (the lists' rules, js/notes.js listed()). */
  function liveNotes() {
    const o = O();
    return [...V.data.notes.values()].filter((n) => n && !n.deleted && !n._purge && !o.isTemplate(n) && !o.isArchived(n));
  }

  /* A note as it is now: the open copy (with what was just typed) or its row. */
  const latest = (id) => (R().latest ? R().latest(id) : V.data.notes.get(id));

  /* Its words as they are now, or null for a locked note (never read: its words are in `secret`). The open note's
     come from the editor, which may be ahead of its row while a save waits. */
  function wordsOf(note) {
    // (Locked first: an unlocked note open in the editor shows its words there, never here; and one locked just now.)
    if (!note || note.locked) return null;
    if (V.editor && V.editor.openId() === note.id && V.editor.current()) {
      return V.editor.current().locked ? null : V.editor.words();
    }
    const reset = V.study && V.study.resetFor ? V.study.resetFor(note) : null;  // (a repeating list's new day: unticked)
    return reset ? reset.body : String(note.body || '');
  }

  /* A note's to-dos: [{ index (its line), text, done }] (the ones with words), fenced code skipped. */
  function itemsOf(words) {
    const out = [];
    let fenced = false;
    String(words || '').split('\n').forEach((line, index) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return; }
      if (fenced) return;
      const box = CHECK.exec(line);
      if (box && box[4].trim()) out.push({ index, text: (V.format ? V.format.unmark(box[4]) : box[4]).trim(), raw: line, done: box[2] !== ' ' });
    });
    return out;
  }
  const repeating = (note) => !!(note && note.extra && (note.extra.reset === 'daily' || note.extra.reset === 'weekly'));

  /* The chip after a row: "3 days late", a reminder's time with a bell, or nothing. */
  function chipFor(note, today) {
    const day = R().dayOf(note);
    const late = day ? daysFrom(today, day) : 0;
    if (late < 0) return { text: late === -1 ? '1 day late' : `${-late} days late`, cls: 'late' };
    const at = R().remindAt(note);
    if (at) return { text: R().remindLabel(note), cls: at < new Date() ? 'late' : 'soon', bell: true };
    return null;
  }

  /* Due today: the rows of every pending note due today or late. A late note shows only what's still open; one due
     today shows all its to-dos, ticked ones last. A note with no to-dos (or a locked one, or one whose boxes are all
     ticked) is one row of its own, which ticks the note done. */
  function dueRows(now = new Date(), list = liveNotes()) {
    const today = V.dateText(now);
    const pending = list.filter((n) => R().pending(n));
    const groups = R().group(pending, now);
    const rows = [];
    for (const part of groups) {
      if (part.key !== 'overdue' && part.key !== 'today') continue;
      for (const row of part.notes) {
        const note = latest(row.id) || row;
        const late = part.key === 'overdue';
        const chip = chipFor(note, today);
        const words = wordsOf(note);
        const items = words === null ? [] : itemsOf(words);
        const open = items.filter((i) => !i.done);
        const shown = late ? open : [...open, ...items.filter((i) => i.done)];
        if (!shown.length || !open.length) {
          rows.push({ key: `n:${note.id}`, kind: 'note', note, late, chip, done: false, text: V.noteTitle(note) });
          continue;
        }
        for (const item of shown.slice(0, MOST_PER_NOTE)) {
          rows.push({ key: `i:${note.id}:${item.index}`, kind: 'item', note, item, late, chip: late || item === shown[0] ? chip : null,
            done: item.done, text: item.text });
        }
        if (shown.length > MOST_PER_NOTE) {
          rows.push({ key: `m:${note.id}`, kind: 'more', note, late, done: false, text: `+${shown.length - MOST_PER_NOTE} more`,
            open: Math.max(0, open.length - MOST_PER_NOTE) });  // (the open to-dos it stands for: counted in "N to do")
        }
      }
    }
    // Ticked rows last (so what's left is at the top), otherwise as Upcoming orders them.
    return [...rows.filter((r) => !r.done), ...rows.filter((r) => r.done)];
  }

  /* How many to-dos are still open in these rows, the ones under "+N more" too. */
  const openCount = (rows) => rows.reduce((n, r) => n + (r.kind === 'more' ? (r.open || 0) : (r.done ? 0 : 1)), 0);

  /* Later this week: the next six days' open notes, one row per note (its first open to-do, if it has any). `skip`:
     notes already shown above (a test in Tests coming up). */
  function laterRows(now = new Date(), list = liveNotes(), skip = new Set()) {
    const pending = list.filter((n) => R().pending(n) && !skip.has(n.id));
    const out = [];
    for (const part of R().group(pending, now)) {
      if (part.key !== 'tomorrow' && !/^day[2-6]$/.test(part.key)) continue;
      for (const row of part.notes) {
        const note = latest(row.id) || row;
        const words = wordsOf(note);
        const first = words === null ? null : itemsOf(words).find((i) => !i.done) || null;
        const day = R().dayOf(note);
        out.push({ key: `l:${note.id}`, note, item: first, day, text: first ? first.text : V.noteTitle(note) });
      }
    }
    return out;
  }

  /* Tests coming up (soonest first): each test with a plan (js/review.js), and a test-looking note with nothing picked
     for it yet ({ note, ask: true }). */
  function testCards(at = RV().now(), list = liveNotes()) {
    const plans = at.plans.filter((p) => p.days <= TEST_DAYS).map((plan) => ({ plan, note: plan.note, day: plan.day }));
    const planned = new Set(plans.map((p) => p.note.id));
    const asks = list.filter((n) => !n.done && !n.locked && n.due && n.due >= at.today && daysFrom(at.today, n.due) <= TEST_DAYS
      && !planned.has(n.id) && RV().looksLikeTest(n) && !RV().planFor(n, at.list, at.today))
      .map((note) => ({ note, ask: true, day: note.due }));
    return [...plans, ...asks].sort((a, b) => a.day.localeCompare(b.day) || V.noteTitle(a.note).localeCompare(V.noteTitle(b.note)));
  }

  /* Jump back in: pinned notes first (newest edit first), then the ones edited last; four at most. */
  function jumpBack(list = liveNotes()) {
    const by = (a, b) => (V.editedAt(b) || '').localeCompare(V.editedAt(a) || '');
    const pinned = list.filter((n) => n.pinned).sort(by);
    const rest = list.filter((n) => !n.pinned).sort(by);
    return [...pinned, ...rest].slice(0, MOST_JUMP);
  }

  /* The week strip's five days: Monday to Friday of this week, or of next week on a Saturday or Sunday. */
  function weekDays(now = new Date()) {
    const weekday = now.getDay();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (weekday === 6 ? 2 : weekday === 0 ? 1 : 1 - weekday));
    return { next: weekday === 6 || weekday === 0, days: [0, 1, 2, 3, 4].map((n) => V.dateText(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n))) };
  }

  function weekCells(now = new Date(), list = liveNotes(), due = null) {
    const today = V.dateText(now);
    const { next, days } = weekDays(now);
    const byDay = new Map(days.map((d) => [d, []]));
    for (const note of list) {
      const day = R().dayOf(note);
      if (byDay.has(day)) byDay.get(day).push(note);
    }
    const isTest = (note) => !note.locked && (RV().looksLikeTest(note) || !!RV().planFor(note));
    return {
      next,
      cells: days.map((day) => {
        const notes = byDay.get(day);
        const date = V.parseDate(day);
        const label = `${SHORT_DAYS[date.getDay()]} ${date.getDate()}`;
        if (day === today) {
          const rows = due || dueRows(now, list);
          const late = openCount(rows.filter((r) => r.late));
          return { day, label: `Today · ${label}`, today: true, todo: openCount(rows), late };
        }
        if (day < today) {
          const left = notes.filter((n) => !n.done).length;
          return { day, label, past: true, left, count: notes.length };
        }
        const open = notes.filter((n) => !n.done).sort((a, b) => V.noteTitle(a).localeCompare(V.noteTitle(b)));
        const test = open.find(isTest);
        const first = test || open[0] || null;
        let text = null;
        if (first && !test) {
          const words = wordsOf(first);
          const item = words === null ? null : itemsOf(words).find((i) => !i.done);
          text = item ? item.text : V.noteTitle(first);
        }
        return { day, label, test: test ? (RV().planFor(test) || {}).name || V.noteTitle(test) : null, first, text, more: Math.max(0, open.length - 1) };
      }),
    };
  }

  /* Whether Today has nothing to show yet (a new account): no dated notes, no tests, no flash cards. */
  function nothingYet(list, at) {
    return !list.some((n) => R().dayOf(n)) && !at.list.length;
  }

  /* -- what a tap does */

  /* A note, opened from Today: over Today on a phone, in Notes' side pane when wide (V.notes.open shows Notes first). */
  const open = (id) => V.notes.open(id);

  function toNotes(filter) {
    V.go('notes');
    if (filter && V.notes.setFilter) V.notes.setFilter(filter);
  }

  /* The note's words with one line's box flipped, or null when that line isn't what was drawn any more. */
  function flipped(words, index, raw) {
    const lines = String(words).split('\n');
    let at = lines[index] === raw ? index : -1;
    if (at < 0) {  // (moved since Today was drawn: the same line elsewhere, if it's there once)
      const found = lines.map((l, i) => (l === raw ? i : -1)).filter((i) => i >= 0);
      at = found.length === 1 ? found[0] : -1;
    }
    if (at < 0) return null;
    const box = CHECK.exec(lines[at]);
    if (!box) return null;
    lines[at] = box[1] + (box[2] === ' ' ? 'x' : ' ') + box[3] + box[4];
    return { words: lines.join('\n'), line: lines[at], index: at };
  }

  /* Words into a note: through the editor when it's the open one (its copy is the one that saves, even in a pane
     that isn't on screen), else straight to its row. */
  function writeWords(id, words) {
    if (V.editor && V.editor.openId() === id && V.editor.current()) {
      V.editor.setWords(words);
      return Promise.resolve();
    }
    const row = V.data.notes.get(id);
    if (!row || row.locked) return Promise.resolve();
    // A repeating list whose day or week turned over was read unticked (wordsOf): its new period is saved with the
    // words, or the next look would untick them all again, the one just ticked too.
    const reset = V.study && V.study.resetFor ? V.study.resetFor(row) : null;
    return V.cloud.save('notes', { ...row, body: words, extra: reset ? { ...(row.extra || {}), reset_at: reset.key } : row.extra });
  }

  /* A to-do ticked (or unticked) on Today. The last open one of a note (not a repeating one, whose ticks come off by
     themselves) marks the note done too, with an Undo that puts both back. */
  async function tickItem(noteId, lineIndex, raw) {
    try {
      const note = latest(noteId);
      const words = wordsOf(note);
      if (words === null) return;
      const flip = flipped(words, lineIndex, raw);
      if (!flip) { V.toast('That list changed: open the note.', { action: 'Open', onAction: () => open(noteId) }); return; }
      await writeWords(noteId, flip.words);
      const nowDone = itemsOf(flip.words).every((i) => i.done);
      if (nowDone && !repeating(note) && !note.done && CHECK.exec(flip.line)[2] !== ' ') {
        await R().change(noteId, (row) => { row.done = true; });
        V.toast('Nice, done.', { action: 'Undo', onAction: () => undoDone(noteId, flip) });
      }
    } catch (error) {
      V.problem(error);
    }
    redraw();
  }
  async function undoDone(noteId, flip) {
    try {
      await R().change(noteId, (row) => { row.done = false; });
      const words = wordsOf(latest(noteId));
      const back = words === null ? null : flipped(words, flip.index, flip.line);
      if (back) await writeWords(noteId, back.words);
    } catch (error) {
      V.problem(error);
    }
    redraw();
  }
  function tickNote(id) {
    R().toggleDone(id);
    redrawSoon();
  }

  function newNote() {
    if (V.wide()) V.go('notes');
    V.notes.chooseTemplate({ fresh: true });
  }
  async function dictate() {
    try {
      const note = await V.notes.create(V.TEMPLATES[0], {}, { fresh: true });
      if (!note || V.editor.openId() !== note.id) return;
      await V.dictation.start();
    } catch (error) {
      console.error(error);
      V.toast('Tap Dictate in the note\'s tools.');
    }
  }
  const canDictate = () => {
    try { return !!(V.dictation && V.dictation.engine && V.dictation.engine().kind); } catch (error) { return false; }
  };

  /* -- drawing */

  function head() {
    const actions = [V.iconButton('search', 'Search your notes', () => { V.go('notes'); V.notes.search(); }, 'today-search')];
    if (menuItems.length) {
      const more = V.iconButton('more', 'More', () => V.menu(more, menuItems.map((item) => ({
        label: item.label, icon: item.icon || null, onClick: item.onClick }))), 'today-more');
      actions.push(more);
    }
    return V.appHead({ logo: true, actions, cls: 'today-head' });
  }

  /* A section: its title (with a link on the right), then what's in it. */
  function part(id, title, body, link = null) {
    return V.h('section.today-sec', { dataset: { section: id } },
      V.h('div.today-sec-head', {}, V.h('h2', { text: title }),
        link ? V.h('button.today-link', { type: 'button', onclick: link.onClick, dataset: { key: `link:${id}` } }, link.label) : null),
      body);
  }

  function tick(done, label, onClick, key) {
    return V.h('button.today-tick', { type: 'button', 'aria-pressed': String(!!done), 'aria-label': label, onclick: onClick,
      dataset: { key } }, V.icon('check'));
  }
  function chip(c) {
    if (!c) return null;
    return V.h('span.due.today-chip.' + (c.cls || 'plain'), {}, c.bell ? R().icon('bell') : null, V.h('span', { text: c.text }));
  }
  function whereLine(note) {
    const folder = folderOf(note);
    return V.h('button.today-where', { type: 'button', title: 'Open the note', onclick: () => open(note.id), dataset: { key: `o:${note.id}` } },
      emoji(folder), note.locked ? V.icon('lock') : null, V.h('span', { text: V.noteTitle(note) }));
  }

  function quick() {
    const tile = (key, name, label, sub, onClick, title) => V.h('button.today-tile', { type: 'button', onclick: onClick,
      title: title || null, dataset: { key: `q:${key}` } },
    V.h('span.tile-ic', {}, icon(name)), V.h('span.tile-text', {}, V.h('span.tile-label', { text: label }), V.h('small', { text: sub })));
    return part('quick', 'Quick actions', V.h('div.today-tiles', {},
      tile('new', 'plus', 'New note', 'Start writing', newNote, V.appShortcuts ? 'New note (Ctrl+N)' : null),
      V.notetaker ? tile('notetaker', 'listen', 'Note-taker', 'Record a class', () => V.notetaker.open()) : null,
      canDictate() ? tile('dictate', 'dictate', 'Dictate', 'Talk to type', dictate) : null));
  }

  function dueSection(rows) {
    if (!rows.length) {
      return part('due', 'Due today', V.h('p.today-quiet', { text: 'Nothing due today.' }));
    }
    const drawn = rows.slice(0, MOST_DUE);
    const box = V.h('div.today-box.today-todo', {}, drawn.map((row) => {
      const note = row.note;
      if (row.kind === 'more') {
        return V.h('button.today-more-row', { type: 'button', onclick: () => open(note.id), dataset: { key: row.key } },
          V.h('span', { text: row.text }), icon('chev'));
      }
      const onTick = row.kind === 'item' ? () => tickItem(note.id, row.item.index, row.item.raw) : () => tickNote(note.id);
      return V.h('div.today-row' + (row.done ? '.done' : '') + (row.late ? '.late' : ''), { dataset: { id: note.id } },
        tick(row.done, `${row.text}: ${row.done ? 'not done' : 'done'}`, onTick, `t:${row.key}`),
        V.h('div.today-row-text', {}, V.h('strong', { text: row.text }), row.kind === 'item' ? whereLine(note)
          : V.h('span.today-sub', {}, emoji(folderOf(note)), note.locked ? V.icon('lock') : null,
            V.h('button.today-where', { type: 'button', onclick: () => open(note.id), dataset: { key: `o:${note.id}` } },
              V.h('span', { text: note.locked ? 'Locked note' : folderOf(note) ? folderOf(note).name : 'Open it' })))),
        chip(row.chip));
    }));
    const rest = rows.length - drawn.length;
    return part('due', 'Due today', [box,
      rest > 0 ? V.h('button.today-link.today-after', { type: 'button', onclick: () => toNotes('due'), dataset: { key: 'due-more' } },
        `${rest} more in Upcoming`) : null]);
  }

  function daysTile(days) {
    if (days <= 0) return V.h('span.today-days.word', {}, V.h('b', { text: 'Today' }));
    if (days === 1) return V.h('span.today-days.word', {}, V.h('b', { text: 'Tomorrow' }));
    return V.h('span.today-days', {}, V.h('b', { text: String(days) }), V.h('span', { text: 'days' }));
  }

  function testCard(card, first) {
    const note = card.note;
    const at = RV().now();
    const when = V.parseDate(card.day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const days = daysFrom(at.today, card.day);
    if (card.ask) {
      return V.h('div.today-box.today-test.ask', { dataset: { id: note.id } },
        V.h('div.test-top', {}, daysTile(days), V.h('div.test-text', {}, V.h('strong', { text: RV().testName(note) }), V.h('span', { text: when }))),
        V.h('div.test-go', {}, V.button('What\'s on the test?', { kind: first ? 'primary' : 'tonal', icon: 'target',
          onClick: () => V.exams.picker(note.id) })));
    }
    const plan = card.plan;
    const covers = RV().coversOf(note).map((d) => RV().deckName(d)).join(', ');
    const known = plan.count - plan.left;
    const pace = !plan.count ? 'No flash cards in it yet' : !plan.left ? 'All gone over' : plan.days <= 1 ? 'all today' : `about ${plan.perDay} a day`;
    const go = plan.count
      ? V.button('Study', { kind: first ? 'primary' : 'tonal', icon: 'learn', onClick: () => RV().start('test:' + note.id) })
      : V.button('Open', { onClick: () => open(note.id) });
    return V.h('div.today-box.today-test', { dataset: { id: note.id } },
      V.h('div.test-top', {}, daysTile(days),
        V.h('button.test-text', { type: 'button', title: 'Open the test note', onclick: () => open(note.id), dataset: { key: `o:${note.id}` } },
          V.h('strong', { text: plan.name }), V.h('span', { text: covers ? `${when} · ${covers}` : when }))),
      plan.count ? V.h('span.bar.today-bar', { role: 'img', 'aria-label': `${known} of ${plan.count} known` },
        V.h('i', { style: { width: `${Math.round((known / plan.count) * 100)}%` } })) : null,
      V.h('p.test-nums', {}, plan.count ? [V.h('span', {}, V.h('b', { text: `${known} of ${plan.count}` }), ' known'),
        V.h('span.pace', { text: pace })] : V.h('span.pace', { text: pace })),
      V.h('div.test-go', {}, go));
  }

  function testsSection(cards) {
    if (!cards.length) return null;
    const shown = cards.slice(0, MOST_TESTS);
    const rest = cards.length - shown.length;
    return part('tests', 'Tests coming up', V.h('div.today-tests', {}, shown.map((c, i) => testCard(c, i === 0))),
      rest > 0 ? { label: `${rest} more`, onClick: () => toNotes('review') } : null);
  }

  function cardsSection(at, primary) {
    if (!at.list.length) return null;
    const total = at.list.filter((c) => RV().isDue(c, at)).length;
    if (!total) {
      return part('cards', 'Flash cards due today', V.h('div.today-box.today-cards.done', {},
        V.h('strong', { text: 'All done for today' }), V.h('p.hint', { text: RV().nextDue(at) })));
    }
    const plan = at.plans.find((p) => p.days <= 6);
    const forTest = plan ? at.list.filter((c) => RV().isDue(c, at) && plan.covers(c)).length : 0;
    const which = !plan ? '' : plan.days === 0 ? 'today\'s' : plan.days === 1 ? 'tomorrow\'s' : `${WEEKDAYS[V.parseDate(plan.day).getDay()]}'s`;
    const decks = RV().dueByFolder(at);
    const shown = decks.slice(0, decks.length > MOST_DECKS ? MOST_DECKS - 1 : MOST_DECKS);
    const rest = decks.length - shown.length;
    return part('cards', 'Flash cards due today', V.h('div.today-box.today-cards', {},
      V.h('div.fc-top', {}, V.h('p.fc-n', {}, V.h('b', { text: String(total) }), V.h('span', { text: total === 1 ? 'card to review' : 'cards to review' })),
        V.button('Review', { kind: primary ? 'primary' : '', icon: 'cards', onClick: () => RV().start('all') })),
      forTest ? V.h('p.fc-note', {}, V.icon('target'), V.h('span', { text: `Includes ${forTest} for ${which} test` })) : null,
      V.h('div.today-decks', {}, shown.map((d) => V.h('button.today-deck', { type: 'button', onclick: () => RV().start(d.deck),
        title: `Review ${d.name}`, dataset: { deck: d.deck, key: `d:${d.deck}` } },
      d.folder && d.folder.icon ? V.h('span.emo', { text: d.folder.icon, 'aria-hidden': 'true' }) : V.icon('folder'),
      V.h('span.deck-name', { text: d.name }), V.h('b', { text: String(d.due) }), icon('chev'))),
      rest > 0 ? V.h('button.today-deck.more', { type: 'button', onclick: () => toNotes('review'), dataset: { key: 'd:more' } },
        V.h('span.deck-name', { text: `+${rest} more` }), icon('chev')) : null)));
  }

  function laterSection(rows, now) {
    if (!rows.length) return null;
    const today = V.dateText(now);
    return part('later', 'Later this week', V.h('div.today-box.today-todo', {}, rows.slice(0, MOST_LATER).map((row) => {
      const note = row.note;
      const d = V.parseDate(row.day);
      const days = daysFrom(today, row.day);
      const label = days === 1 ? 'Tomorrow' : SHORT_DAYS[d.getDay()];
      const onTick = row.item ? () => tickItem(note.id, row.item.index, row.item.raw) : () => tickNote(note.id);
      return V.h('div.today-row', { dataset: { id: note.id } },
        tick(false, `${row.text}: done`, onTick, `t:${row.key}`),
        V.h('div.today-row-text', {}, V.h('strong', { text: row.text }), whereLine(note)),
        chip({ text: label, cls: days <= 3 ? 'soon' : 'plain' }));
    })), { label: 'Upcoming', onClick: () => toNotes('due') });
  }

  function editedLabel(note) {
    const at = V.editedAt(note);
    if (!at) return '';
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return '';
    if (V.dateText(when) === V.today()) return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return R().dayLabel(V.dateText(when));
  }

  function jumpSection(notes) {
    if (!notes.length) return null;
    return part('jump', 'Jump back in', V.h('div.today-jump', {}, notes.map((note) => {
      const folder = folderOf(note);
      const snippet = note.locked ? 'Locked' : V.notes.plain(note, false);
      return V.h('button.today-note', { type: 'button', onclick: () => open(note.id), dataset: { id: note.id, key: `j:${note.id}` } },
        V.h('span.tn-title', {}, note.pinned ? V.icon('pin-on', 'tn-pin') : null, note.locked ? V.icon('lock') : null,
          V.h('span', { text: V.noteTitle(note) })),
        V.h('span.tn-snip', { text: snippet || ' ' }),
        V.h('span.tn-foot', {}, folder ? [emoji(folder), V.h('span.tn-folder', { text: folder.name })] : V.h('span.tn-folder'),
          V.h('span.tn-when', { text: editedLabel(note) })));
    })), { label: 'All notes', onClick: () => toNotes('all') });
  }

  function weekStrip(week) {
    return V.h('nav.today-week', { 'aria-label': week.next ? 'Next week' : 'This week' },
      week.next ? V.h('p.today-week-title', { text: 'Next week' }) : null,
      V.h('div.today-week-days', {}, week.cells.map((cell) => {
        let body;
        if (cell.today) {
          body = cell.todo ? V.h('span.wd-item', {}, V.h('span', { text: `${cell.todo} to do` }),
            cell.late ? [V.h('span.wd-sep', { text: ' · ' }), V.h('span.late-w', { text: `${cell.late} late` })] : null)
            : V.h('span.wd-item', {}, V.h('span.none', { text: 'Nothing due' }));
        } else if (cell.past) {
          body = V.h('span.wd-item', {}, V.h('span.none', { text: !cell.count ? 'Nothing due' : cell.left ? `${cell.left} left` : 'All done' }));
        } else if (cell.test) {
          body = V.h('span.wd-item.test', {}, V.icon('target'), V.h('span', { text: cell.test }));
        } else if (cell.first) {
          body = V.h('span.wd-item', {}, emoji(folderOf(cell.first)), V.h('span', { text: cell.text }),
            cell.more ? V.h('span.wd-more', { text: `+${cell.more}` }) : null);
        } else body = V.h('span.wd-item', {}, V.h('span.none', { text: 'Nothing due' }));
        return V.h('button.wday' + (cell.today ? '.today' : '') + (cell.past ? '.past' : ''), { type: 'button',
          'aria-current': cell.today ? 'date' : null, onclick: () => toNotes('due'), dataset: { day: cell.day, key: `w:${cell.day}` } },
        V.h('span.wd-label', { text: cell.label }), body);
      })));
  }

  function line() {
    return V.h('div.today-line', { 'aria-hidden': 'true' });
  }

  /* The first-run state: what makes Today fill up, with something to try for each. */
  function howTo() {
    const one = (name, title, words, example) => V.h('div.today-box.today-howto', {},
      V.h('span.tile-ic', {}, V.icon(name)),
      V.h('div.ht-text', {}, V.h('strong', { text: title }), V.h('span', { text: words }),
        V.h('span.ht-eg', {}, 'Try: ', V.h('code', { text: example }))));
    return part('howto', 'Make Today yours', V.h('div.today-howtos', {},
      one('calendar', 'Give a note a due date', 'It shows up here on the day, with a box to tick.', 'due fri'),
      one('target', 'Mark a note as a test', 'You get a countdown and a plan for your flash cards.', 'Bio test thu'),
      one('cards', 'Write question :: answer', 'Each line like this becomes a flash card.', 'la cocina :: the kitchen')));
  }

  function showCode() {
    if (V.settings && V.settings.addDevice) { V.settings.addDevice(); return; }
    const link = V.connectLink ? V.connectLink() : '';
    V.sheet({
      title: 'Wefty on your phone',
      content: [
        V.qr ? V.qr(link) : null,
        V.h('ol.steps', {},
          V.h('li', { text: 'Point your phone\'s camera at the code and tap the link it shows.' }),
          V.h('li', { text: 'Sign in with your e-mail and your Wefty password.' }),
          V.h('li', { text: 'Put Wefty on your home screen, so it opens like an app.' })),
      ],
      actions: [{ label: 'Copy the link', icon: 'copy', onClick: async () => { await V.copy(link); V.toast('Copied. Open it on your phone.'); return true; } }],
    });
  }
  async function shareLink() {
    const url = (V.config && V.config.phoneUrl) || location.origin + location.pathname;
    try {
      if (navigator.share) { await navigator.share({ title: 'Wefty', url }); return; }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
    await V.copy(url);
    V.toast('Link copied. Open it on your computer.');
  }

  function devicesSection() {
    const line = V.profile && V.profile.devicesLine ? V.profile.devicesLine() : 'This ';
    if (!line.startsWith('This ')) return null;  // (another device was seen in the last 30 days)
    const phone = !V.desktop && V.device === 'phone';
    return part('devices', 'Your other devices', V.h('div.today-box.today-howto', {},
      V.h('span.tile-ic', {}, phone ? V.icon('laptop') : icon('phone')),
      V.h('div.ht-text', {}, V.h('strong', { text: phone ? 'Wefty on your computer' : 'Wefty on your phone' }),
        V.h('span', { text: phone ? 'Open the link on a Chromebook or computer and sign in there too. Your notes show up on both.'
          : 'Scan a code with your phone to sign in there too. Your notes show up on both.' }),
        V.h('span.ht-act', {}, phone ? V.button('Share link', { icon: 'share', onClick: shareLink })
          : V.button('Show the code', { icon: 'qr', onClick: showCode })))));
  }

  function draw() {
    if (!showing()) return;
    const now = new Date();
    const wide = V.wide();
    const list = liveNotes();
    // A repeating checklist whose day has turned over gets its ticks off (saved; the rows here already show it so).
    try {
      if (V.study && V.study.resetDue) V.study.resetDue(list.filter((n) => R().pending(n) && repeating(n) && R().dayOf(n) <= V.dateText(now)), now);
    } catch (error) { console.error(error); }
    let at = null;
    try { at = RV().now(); } catch (error) { console.error('Wefty: Today\'s flash cards:', error); at = { today: V.today(), list: [], plans: [], pulled: new Set() }; }
    let due = [];
    try { due = dueRows(now, list); } catch (error) { console.error(error); due = null; }
    const user = V.data.user || {};
    const welcoming = V.welcome && V.welcome.pending && V.welcome.pending(user.id);
    const status = V.cloud && V.cloud.status;
    if (status === 'synced' || status === 'held') synced = true;
    const known = synced || (status === 'offline' && !list.length);
    const fresh = known && !welcoming && nothingYet(list, at);
    const tests = section('tests', () => testCards(at, list)) || [];
    const ownParts = fresh ? [
      { id: 'howto', column: 'left', build: howTo },
      { id: 'quick', column: 'right', build: quick },
      { id: 'devices', column: 'right', build: devicesSection },
      { id: 'jump', column: 'left', build: () => jumpSection(jumpBack(list)) },
    ] : [
      { id: 'quick', column: 'right', build: quick },
      { id: 'due', column: 'right', build: () => (due ? dueSection(due) : null) },
      { id: 'tests', column: 'left', build: () => (Array.isArray(tests) ? testsSection(tests) : tests) },
      { id: 'cards', column: 'left', build: () => cardsSection(at, !(Array.isArray(tests) && tests.length)) },
      { id: 'later', column: 'right', build: () => laterSection(laterRows(now, list, new Set((Array.isArray(tests) ? tests : []).slice(0, MOST_TESTS).map((t) => t.note.id))), now) },
      { id: 'jump', column: 'left', build: () => jumpSection(jumpBack(list)) },
    ];
    const parts = [...ownParts.map((p) => ({ ...p, order: ORDER[p.id] })), ...extra].sort((a, b) => a.order - b.order);
    const built = parts.map((one) => ({ one, el: section(one.id, one.build) })).filter((x) => x.el);
    if (due === null) built.unshift({ one: { column: 'right', order: 0 }, el: V.h('p.today-trouble.hint', { text: 'Couldn\'t show this part.' }) });
    const column = (side) => built.filter((x) => !wide || x.one.column === side).map((x) => x.el);

    const date = now.toLocaleDateString(undefined, { weekday: 'long', month: wide ? 'short' : 'long', day: 'numeric' });
    const counts = [];
    if (wide && !fresh) {
      try {
        const offset = (now.getDay() + 6) % 7;
        const week = at.plans.filter((p) => p.days <= 6 - offset).length;
        const cards = at.list.filter((c) => RV().isDue(c, at)).length;
        const todo = openCount(due || []);
        if (week) counts.push(['target', `${plural(week, 'test')} this week`]);
        if (cards) counts.push(['cards', plural(cards, 'card')]);
        if (todo) counts.push(['checklist', `${todo} to do today`]);
      } catch (error) { console.error(error); }
    }
    const greet = V.h('div.today-greet', {},
      V.h('div.today-hello', {}, V.h('h1', { text: greeting(now) }), V.h('p.today-date', { text: date })),
      counts.length ? V.h('p.today-counts', {}, counts.map(([name, text]) => V.h('span', {}, name === 'cards' ? R().icon('cards') : V.icon(name), text))) : null);
    const strip = wide && !fresh ? section('week', () => weekStrip(weekCells(now, list, due || []))) : null;
    const before = !known && !welcoming && !list.length ? V.h('p.today-quiet.today-getting', { text: 'Getting your notes…' }) : null;
    const welcomeText = fresh ? V.h('p.today-welcome', { text: 'Welcome to Wefty. Today fills up from your notes: give one a date, a test or some flash cards, and they show here.' }) : null;

    // (what had the focus, and how far Jump back in was scrolled: put back after the redraw)
    const focused = root.contains(document.activeElement) && document.activeElement.closest('[data-key]');
    const focusKey = focused ? focused.dataset.key : null;
    const jump = root.querySelector('.today-jump');
    const scrolled = jump ? jump.scrollLeft : 0;

    V.clear(root, V.h('div.page.today' + (wide ? '.wide' : '') + (fresh ? '.fresh' : ''), {},
      head(), greet, line(), strip, before, welcomeText,
      V.h('div.today-cols', {}, V.h('div.today-col.left', {}, wide ? column('left') : column()),
        wide ? V.h('div.today-col.right', {}, column('right')) : null)));

    const again = root.querySelector('.today-jump');
    if (again && scrolled) again.scrollLeft = scrolled;
    if (focusKey) {
      const back = [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focusKey);
      if (back) back.focus({ preventScroll: true });
    }
    dayTimer(now);
  }

  function redraw() {
    try { draw(); } catch (error) { console.error(error); }
  }
  // Changes come in bursts (a sync, a save): drawn once they settle, and never under a note open over Today.
  const covered = () => !!(V.editor && V.editor.covering && V.editor.covering());
  const redrawSoon = V.debounce(() => { if (showing() && !covered()) redraw(); }, 300);

  /* The day turning over while Today is open (the PC left on): drawn again just after midnight. */
  let timer = null;
  let drawnDay = '';
  function dayTimer(now) {
    drawnDay = V.dateText(now);
    clearTimeout(timer);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    timer = setTimeout(() => { if (showing()) redraw(); }, Math.min(next - now, 2 ** 31 - 1));
  }

  function render(container) {
    root = container;
    draw();
  }

  V.on('data', () => redrawSoon());
  V.on('notetaker', () => redrawSoon());
  V.on('note-left', () => redrawSoon());
  V.on('status', (value) => { if ((value === 'synced' || value === 'held') && !synced) { synced = true; redrawSoon(); } });
  V.on('back', () => { if (showing() && V.today() !== drawnDay) redrawSoon(); });
  V.onWide(() => redraw());

  Object.assign(V.today, { render, open, addSection, addMenuItem, redraw, section, greeting, ORDER,
    dueRows, laterRows, testCards, jumpBack, weekCells, itemsOf, tickItem, tickNote });
})();
