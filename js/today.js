/* Wefty: Today (1.16), the first screen on every device: a greeting, then what's on today from your notes.

   Top to bottom on every device: the greeting and the thread under it (on a Chromebook or the PC, 900 px and up, with
   the day's counts beside it), the days (1.17: a strip that scrolls sideways from this week's Monday to the Friday two
   weeks on, today first in view), then Quick actions across the whole width (1.17, the owner: "I want the notes thing
   to be big across the top": New note and Note-taker big, Dictate and Flash cards, which opens the cards due, smaller
   under them). Wide, two columns under them: tests, flash cards and Jump back in on the left; the days one by one on the
   right (1.17, the owner: "the reminders should show up on the dashboard too, like day by day stuff as well": Today,
   with each to-do of the notes due today or late and a box to tick, then Tomorrow and the days after, each with its
   reminders and times, what's due, tests, a repeating one on every day it comes back, and subscriptions renewing; see
   "the days, one by one" below).

   A phone (1.18, the owner: "on my phone today felt really overwhelming"): one calm column, what matters now first.
   The strip has no "This week" over it (the list's own heading is the one; a label shows only while the strip is on
   another week), Quick actions are one row of four small buttons, then Today's to-dos, Tests coming up and Flash cards
   (both compact, each with its one clear button), then the rest of this week (only the days with something
   on them; a run of empty days is one quiet line, "Nothing due Tue – Thu"; next week only when asked: its button, a
   tap on one of its days, or the strip moved there), then Jump back in. A row's title gets the row's whole width (two
   lines), its time chip goes under it, beside the folder. Every number comes from this device's own copy of the notes
   (it works offline and costs nothing), through the same rules as Upcoming (js/reminders.js) and Review
   (js/review.js), so they always agree.

   Each part is drawn by section(), which catches and logs, so a bad row can't keep the app from opening (js/start.js's
   V.go is the second net: a Today that throws shows your notes instead). Other parts add their own sections with
   V.today.addSection, and their own things on the days with V.today.addDayItems (js/subs.js: Subscriptions).

   V.today() is util.js's date ('2026-11-02'), used all over: the screen hangs off it (V.today.render, .open,
   .addSection, .addMenuItem, .redraw), never in its place. Loaded after the other screens' scripts, and only drawn once
   the page's scripts have all run (js/start.js's main() waits for them). */
'use strict';

(() => {
  if (typeof V.today !== 'function') return;  // (util.js didn't load: nothing works anyway)
  /* Where Today's own sections go, so another part's section can go between them (`order`), and which column it
     takes on a wide screen ('left': tests, flash cards, Jump back in; 'right': the days). `subs`: where Subscriptions
     (js/subs.js) goes: after the flash cards on a phone, in the right column when wide (only on the first-run screen
     since 1.17: elsewhere its renewals are on their days). (`quick` is kept for parts that read it: since 1.17 Quick
     actions sit above the columns, never in one. Wide, the days took the places of `due` and `later`; on a phone since
     1.18 Today's own day is `due` and the rest of the days are where `later` was, after the flash cards.) */
  const ORDER = { quick: 10, days: 20, due: 20, howto: 25, tests: 30, cards: 40, subs: 45, later: 50, devices: 55, jump: 60 };
  const MOST_DUE = 8;      // rows in Today's day before "N more in Upcoming"
  const MOST_PER_NOTE = 5; // a note's to-dos in Today's day before "+N more"
  const MOST_PER_DAY = 5;  // rows in one of the coming days before "+N more"
  const MOST_TESTS = 2;
  const MOST_DECKS = 4;
  const MOST_JUMP = 4;
  const TEST_DAYS = 14;    // tests this close show (the PC's briefing's window: vault/store.py study_today)
  const STRIP_WEEKS = 3;   // the days at the top: this week and the next two (the owner: "to check out the other week too")
  const CHECK = /^(\s*[-*]\s*\[)( |x|X)(\]\s?)(.*)$/;  // (js/notes.js's CHECK, with the parts kept to flip the box)
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  const FLASH_MS = 1800;   // how long a day tapped in the strip stays lit in the list
  const DRAWN = {  // fixed strings only
    listen: '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5"/><path d="M9 14v2M11.25 12v6M13.5 13v4M15.75 14.5v1"/>',
    dictate: '<path d="M6 4.5h4M6 19.5h4M8 4.5v15"/><path d="M14 9.5a3.5 3.5 0 0 1 0 5M17 7a7 7 0 0 1 0 10"/>',
    chev: '<path d="m9.5 6 6 6-6 6"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  };
  const extra = [];   // sections from other parts (js/subs.js): { id, order, column, build }
  const menuItems = [];  // ⋯ on Today's top row: { id, label, icon, onClick }
  const dayParts = [];   // things other parts put on the days (js/subs.js: renewals): { id, items(from, to) }
  let root = null;
  let synced = false;  // the first sync this page life has finished (so a new device doesn't greet a long-time user)
  let stripFocus = '';  // the day the strip's one Tab stop is on (the arrow keys move it), kept across redraws
  let stripMoved = -Infinity;  // when the days were last scrolled or touched (a redraw waits until they rest)
  let listWeeks = 0;   // how many of the strip's weeks the days' list shows (0: as many as today needs); only grows,
                       // until Today is opened afresh (the logo from another screen) or the day turns
  let leftAt = '';     // the day at the strip's start as it was last seen (Today opened again from a tab goes back there)
  let backTo = '';     // (that day, for the draw that opens Today again)
  let daysOn = false;  // the days and their list are on Today (not the first-run screen)
  let lastDays = null;  // the strip's days as last drawn: { today, days } (weeksShown between draws)
  let flashTimer = null;

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
  /* Another part's things on the days (js/subs.js: a renewal, a trial ending). `items(from, to)` (two 'YYYY-MM-DD'
     days) is called at every draw, inside a catch, and gives the ones in between:
       [{ day, key (its own, unique that day), text (what it is: "Higgsfield renews"), line (the words under it),
          lead (an element, or a function making one, for the box's place), action (a button beside it, or a function
          making one), open (what a tap on its words does), openTitle, warn (amber: something to act on), data }]
     They show on their day in the list (never ticked: their own part changes them) and count in the strip. */
  function addDayItems({ id, items } = {}) {
    if (!id || typeof items !== 'function') return;
    const at = dayParts.findIndex((one) => one.id === id);
    const entry = { id: String(id), items };
    if (at >= 0) dayParts[at] = entry; else dayParts.push(entry);
    redraw();
  }
  /* Whether Today is showing the days and their list now (js/subs.js leaves its own card out then). */
  const showsDays = () => daysOn;

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

  /* -- times and days in words, for a screen reader ("reminder at 6 PM, repeats every Tuesday", never "18:00") */

  const pad = (n) => String(n).padStart(2, '0');
  const SHORT_WORDS = Object.fromEntries([...SHORT_DAYS.map((d, i) => [d, WEEKDAYS[i]]), ...MONTHS.map((m) => [m.slice(0, 3), m])]);
  function spokenTime(at) {
    const h = at.getHours();
    const m = at.getMinutes();
    return `${h % 12 || 12}${m ? ':' + pad(m) : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function spokenDay(day, today) {
    const n = daysFrom(today, day);
    const d = V.parseDate(day);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n > 1 && n < 7) return WEEKDAYS[d.getDay()];
    return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  // ("Every Tue and Thu" -> "every Tuesday and Thursday", "Every year on Nov 2" -> "every year on November 2")
  const spokenRule = (rule) => R().repeatText(rule).replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g,
    (word) => SHORT_WORDS[word] || word).replace(/^Every/, 'every');

  /* The chip after a row: "3 days late", a reminder's time with a bell, or nothing. A repeating one has the repeat
     mark too ("6:00 PM" and the mark; "Every Tue" for a repeating due date alone). `spoken`: what a screen reader
     says for it, in words. */
  function chipFor(note, today) {
    const day = R().dayOf(note);
    const late = day ? daysFrom(today, day) : 0;
    if (late < 0) return { text: late === -1 ? '1 day late' : `${-late} days late`, cls: 'late' };
    const at = R().remindAt(note);
    const rule = R().repeatOf ? R().repeatOf(note) : null;
    const said = rule ? R().repeatLine(note) : '';
    const repeats = rule ? `, repeats ${spokenRule(rule)}` : '';
    if (at) {
      const other = note.due && note.due !== V.dateText(at) ? ` ${spokenDay(V.dateText(at), today)}` : '';
      return { text: R().remindLabel(note), cls: at < new Date() ? 'late' : 'soon', bell: true, repeat: !!rule, said,
        spoken: `reminder${other} at ${spokenTime(at)}${repeats}` };
    }
    if (rule) return { text: R().repeatText(rule), cls: 'plain', repeat: true, said, spoken: `repeats ${spokenRule(rule)}` };
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

  /* The next six days' open notes, one row per note (its first open to-do, if it has any). `skip`: notes to leave out.
     (No longer drawn since 1.17, whose days took Later this week's place: the Chat tab's today_summary reads it.) */
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

  /* -- the days, one by one (1.17)

     Under the strip, the same days as a list: Today (what's due today or late, each to-do with its box, as Due today
     had it), then Tomorrow and each day after it with what's on that day: a note due then or reminding then (the bell
     and its time), a test, a repeating note on every day it comes back, and what other parts put there (js/subs.js: a
     subscription renewing, a trial ending). A day with nothing on it is one quiet line ("Nothing due"), so the days
     still read in order. It starts with this week (and next week too from Friday on, so a few days ahead are always
     there) and grows a week at a time, up to the strip's last day, as the strip is moved into a later week, a day
     there is tapped, or "Show next week" at its foot is. The strip's days say what the list says: both come from one
     dayPlan() a draw. (It took the places of Due today and Later this week, so nothing shows twice; Subscriptions'
     own "Coming up" card only shows on the first-run screen, which has no days.)

     On a phone (1.18) Today's own day stands on its own near the top (todaySection), and the list after the flash
     cards holds the days after it: only the ones with something on them, each run of empty days one quiet line
     (gapLine), and only this week (next week too only once nothing is left of this one) until the person asks for
     more (the same three ways; the button says how much is on that week).

     A repeating note's next one is the note itself (its due date and reminder): it's ticked from its day like any
     other note, and a tick moves it on to the one after (js/reminders.js moveOn, with an Undo). Its later ones are
     worked out from its rule (reminders.js nextAfter: days on the wall clock, so 6 PM stays 6 PM across a clock
     change), never kept: they show the repeat mark where the box would be, and a tap opens the note. Ticking one of
     those would move the next one on, so they can't be. */

  const mondayOf = (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  /* The strip's last day: the Friday two weeks after this week's. */
  function lastDay(now = new Date()) {
    const monday = mondayOf(now);
    return V.dateText(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + STRIP_WEEKS * 7 - 3));
  }
  /* The strip's week a day is in: 0 this week, 1 next week, 2 the one after. */
  const weekOf = (now, day) => Math.floor(daysFrom(V.dateText(mondayOf(now)), day) / 7);
  /* How many weeks the list shows: as many as the strip or a tap asked for, else this week, and next week too once
     fewer than four days of this one are left (from Friday). A phone (1.18): this week only, unless nothing of it is
     left after today (a Friday, Saturday or Sunday with nothing on the weekend), then next week too. */
  function weeksShown(now = new Date(), wide = V.wide(), plan = null) {
    let own = weekOf(now, V.addDays(V.dateText(now), 3)) + 1;
    if (!wide) {
      const today = V.dateText(now);
      const days = plan ? plan.days : lastDays && lastDays.today === today ? lastDays.days : stripDays(now, liveNotes());
      own = days.some((d) => d.week === 0 && d.day > today) ? 1 : 2;
    }
    return Math.min(STRIP_WEEKS, Math.max(listWeeks, own));
  }

  const isTest = (note) => !note.locked && (RV().looksLikeTest(note) || !!RV().planFor(note));

  /* A note on one of the coming days (its own: due then, or reminding then): its first open to-do (ticked from here),
     else its title; a test by its name (a tick marks it done). */
  function noteItem(note, day, today) {
    const words = wordsOf(note);
    const test = isTest(note);
    const first = test || words === null ? null : itemsOf(words).find((i) => !i.done) || null;
    const at = R().remindAt(note);
    return { kind: 'note', key: `l:${note.id}`, day, note, item: first, test, at: at && V.dateText(at) === day ? at : null,
      chip: chipFor(note, today), text: test ? (RV().planFor(note) || {}).name || V.noteTitle(note) : first ? first.text : V.noteTitle(note) };
  }

  /* A repeating note's later ones from `from` to `to` (its next one is the note itself, on its own day). */
  function laterOnes(note, from, to) {
    const rule = R().repeatOf ? R().repeatOf(note) : null;
    const here = rule ? R().occurrence(note) : null;
    const listed = R().dayOf(note);
    if (!here || !listed) return [];
    const out = [];
    let d = here.day;
    for (let guard = 0; guard < 400; guard++) {
      d = R().nextAfter(rule, d);
      if (!d) break;
      // (on the day the note itself would be, moved on that far: its due date moves with its reminder)
      const day = V.addDays(listed, Math.round((d - here.day) / 86400000));
      if (day > to) break;
      if (day < from) continue;  // (one gone by and not moved on yet: the note itself is the late one, on Today)
      const at = here.at ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), here.at.getHours(), here.at.getMinutes()) : null;
      out.push({ kind: 'repeat', key: `r:${note.id}:${day}`, day, note, at, rule, text: V.noteTitle(note) });
    }
    return out;
  }

  /* What the notes put on the days after today, up to `to` (and a repeating one's later ones, today's too). */
  function aheadItems(now, list, to) {
    const today = V.dateText(now);
    const out = [];
    for (const row of list) {
      const note = latest(row.id) || row;
      if (!note || note.deleted || !R().pending(note)) continue;
      const day = R().dayOf(note);
      if (day > today && day <= to) out.push(noteItem(note, day, today));
      out.push(...laterOnes(note, today, to));
    }
    return out;
  }

  // A day's things in order: tests, then what has a time (by its time), then the rest, then other parts' (by name).
  const rankOf = (item) => (item.test ? 0 : item.at ? 1 : item.kind === 'extra' ? 3 : 2);
  function inOrder(a, b) {
    return rankOf(a) - rankOf(b) || (a.at && b.at ? a.at - b.at : (b.at ? 1 : 0) - (a.at ? 1 : 0))
      || String(a.text).localeCompare(String(b.text));
  }

  /* Everything on the strip's days from today on, worked out once a draw: { today, end (the strip's last day), due
     (Today's rows: dueRows), byDay (day -> its things, in order), days (the strip's: stripDays) }. Each thing:
     { kind: 'note' | 'repeat' | 'extra', key, day, text, at (its time, or null), test, note, ... }. */
  function dayPlan(now = new Date(), list = liveNotes(), due = null) {
    const today = V.dateText(now);
    const end = lastDay(now);
    const byDay = new Map();
    const put = (item) => { const on = byDay.get(item.day); if (on) on.push(item); else byDay.set(item.day, [item]); };
    for (const item of aheadItems(now, list, end)) put(item);
    for (const part of dayParts) {
      let got = [];
      try { got = part.items(today, end) || []; } catch (error) { console.error(`Wefty: Today's days (${part.id}):`, error); }
      for (const item of Array.isArray(got) ? got : []) {
        if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.day)) || item.day < today || item.day > end || !item.text) continue;
        put({ ...item, kind: 'extra', key: `x:${part.id}:${item.key || item.text}`, text: String(item.text),
          at: item.at instanceof Date && !Number.isNaN(item.at.getTime()) ? item.at : null, test: false });
      }
    }
    for (const items of byDay.values()) items.sort(inOrder);
    const days = stripDays(now, list, new Set(byDay.keys()));
    lastDays = { today, days };
    return { today, end, byDay, due: due || dueRows(now, list), days };
  }

  /* The strip's days (1.17): this week's Monday (the one before, on a Sunday) to the Friday two weeks on. A school
     week is Monday to Friday, so a Saturday or a Sunday is only there when it's today or something is on then (a note
     due, or `busy`: a day dayPlan() has things on). `week`: 0 this week, 1 next week, 2 the one after. */
  function stripDays(now = new Date(), list = liveNotes(), busy = null) {
    const today = V.dateText(now);
    const monday = mondayOf(now);
    const dated = new Set(busy || []);
    for (const note of list) {
      const day = R().dayOf(note);
      if (day) dated.add(day);
    }
    const out = [];
    for (let n = 0; n < STRIP_WEEKS * 7 - 2; n++) {  // (up to that last Friday)
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + n);
      const day = V.dateText(date);
      if ((date.getDay() === 0 || date.getDay() === 6) && day !== today && !dated.has(day)) continue;
      out.push({ day, week: Math.floor(n / 7) });
    }
    return out;
  }

  /* What each of the strip's days says, from the same plan as the list under it: today, how many to-dos are open (and
     late); a day gone by, how many of its notes are left; a day to come, its first thing (a test first) and "+N" for
     the rest of what its group in the list holds. */
  function weekCells(now = new Date(), list = liveNotes(), due = null, plan = null) {
    const today = V.dateText(now);
    const rows = due || dueRows(now, list);
    const p = plan || dayPlan(now, list, rows);
    const byDay = new Map(p.days.map((d) => [d.day, []]));
    for (const note of list) {
      const day = R().dayOf(note);
      if (byDay.has(day)) byDay.get(day).push(note);
    }
    return {
      cells: p.days.map(({ day, week }) => {
        const notes = byDay.get(day);
        const date = V.parseDate(day);
        const label = `${SHORT_DAYS[date.getDay()]} ${date.getDate()}`;
        const items = day >= today ? p.byDay.get(day) || [] : [];
        const first = items[0] || null;
        const what = { count: items.length, more: Math.max(0, items.length - 1), first: first && first.note ? first.note : null,
          test: first && first.test ? first.text : null, text: first && !first.test ? first.text : null };
        if (day === today) {
          const late = openCount(rows.filter((r) => r.late));
          return { day, week, label: `Today · ${label}`, today: true, todo: openCount(rows), late, ...what };
        }
        if (day < today) {
          const left = notes.filter((n) => !n.done).length;
          return { day, week, label, past: true, left, count: notes.length };
        }
        return { day, week, label, ...what };
      }),
    };
  }

  /* A week's name over the strip: "This week", "Next week", then "Week of Nov 16". */
  function weekTitle(week, day) {
    if (week === 0) return 'This week';
    if (week === 1) return 'Next week';
    const date = V.parseDate(day);
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    return `Week of ${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }

  /* Whether Today has nothing to show yet (a new account): no dated notes, no tests, no flash cards, nothing another
     part put on the days (a subscription renewing). */
  function nothingYet(list, at, plan = null) {
    return !list.some((n) => R().dayOf(n)) && !at.list.length && !(plan && [...plan.byDay.values()].some((items) => items.length));
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
        // A repeating reminder isn't done for good: on to its next one, its boxes fresh again.
        const row = latest(noteId);
        const moved = R().upNext && R().upNext(row) ? await R().moveOn(noteId, { from: R().occurrence(row).key, why: 'done' }) : null;
        if (moved) {
          V.toast(`Done. Next one: ${R().dayLabel(moved.next.day)}${moved.next.at ? ' ' + R().clock(moved.next.at) : ''}`,
            { action: 'Undo', onAction: () => undoMove(noteId, moved, flip) });
        } else {
          await R().change(noteId, (row) => { row.done = true; });
          V.toast('Nice, done.', { action: 'Undo', onAction: () => undoDone(noteId, flip) });
        }
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
  async function undoMove(noteId, moved, flip) {
    try {
      if (await R().putBack(noteId, moved)) {
        const words = wordsOf(latest(noteId));
        const back = words === null ? null : flipped(words, flip.index, flip.line);
        if (back) await writeWords(noteId, back.words);
      }
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
    const actions = [V.iconButton('search', 'Search your notes', () => V.notes.search(), 'today-search')];  // (Notes at its top)
    if (menuItems.length) {
      const more = V.iconButton('more', 'More', () => V.menu(more, menuItems.map((item) => ({
        label: item.label, icon: item.icon || null, onClick: item.onClick }))), 'today-more');
      actions.push(more);
    }
    // (the logo is a way back to Today's top, as the rail's is on a wide screen: js/start.js)
    return V.appHead({ logo: true, onLogo: toTop, actions, cls: 'today-head' });
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
  /* A chip: `spoken` (words for a screen reader, in place of what shows) or `said` (the whole line, read after it). */
  function chip(c) {
    if (!c) return null;
    const hide = c.spoken ? 'true' : null;
    return V.h('span.due.today-chip.' + (c.cls || 'plain') + (c.repeat ? '.repeats' : ''), { title: c.said || null },
      c.bell ? R().icon('bell') : null, V.h('span', { text: c.text, 'aria-hidden': hide }),
      c.repeat ? R().icon('repeat', 'repeat-mark-icon') : null,
      c.spoken ? V.h('span.sr-only', { text: c.spoken }) : c.said ? V.h('span.sr-only', { text: ` (${c.said})` }) : null);
  }
  function whereLine(note) {
    const folder = folderOf(note);
    return V.h('button.today-where', { type: 'button', title: 'Open the note', onclick: () => open(note.id), dataset: { key: `o:${note.id}` } },
      emoji(folder), note.locked ? V.icon('lock') : null, V.h('span', { text: V.noteTitle(note) }));
  }

  /* How many flash cards are due today, for the Flash cards tile (0 when none, or when they can't be counted). */
  function cardsDue() {
    try { return RV() && RV().dueCount ? RV().dueCount() || 0 : 0; } catch (error) { console.error(error); return 0; }
  }

  /* Quick actions, across the top (1.17): New note and Note-taker big (the two the owner circled), Dictate and Flash
     cards smaller under them. One grid, so a missing tile (no Note-taker, no speech here) never pulls the next row up. */
  function quick() {
    // (a tile with a count is named with it: the badge is hidden from screen readers; a small tile's line under its
    // name is hidden on screens under 360 px, a big one keeps it)
    const tile = (key, name, label, sub, onClick, { title = null, count = 0, big = false, said = '' } = {}) => V.h('button.today-tile' + (big ? '.big' : ''), {
      type: 'button', onclick: onClick, title, 'aria-label': count ? `${label}, ${said || sub}` : null, dataset: { key: `q:${key}` } },
    V.h('span.tile-ic', {}, icon(name), count ? V.h('b.tile-count', { text: count > 99 ? '99+' : String(count), 'aria-hidden': 'true' }) : null),
    V.h('span.tile-text', {}, V.h('span.tile-label', { text: label }), V.h('small', { text: sub })));
    // Flash cards (1.18): with cards due today it opens them straight away, one at a time (js/review.js); with none due
    // it opens Notes' Flash cards page (the decks, and practice).
    const due = cardsDue();
    return part('quick', 'Quick actions', V.h('div.today-tiles', {},
      tile('new', 'plus', 'New note', 'Start writing', newNote, { title: V.appShortcuts ? 'New note (Ctrl+N)' : null, big: true }),
      V.notetaker ? tile('notetaker', 'listen', 'Note-taker', 'Record a class', () => V.notetaker.open(), { big: true }) : null,
      canDictate() ? tile('dictate', 'dictate', 'Dictate', 'Talk to type', dictate) : null,
      V.review ? tile('cards', 'cards', 'Flash cards', due ? `Study ${due}` : 'All done today',
        () => (cardsDue() ? RV().start('all') : toNotes('review')), { count: due, said: `${due} due today` }) : null));
  }

  /* -- the days' list (see "the days, one by one" above) */

  /* The line under a note's words: its folder (a tap opens the note), or "Locked note". */
  function noteSub(note) {
    const folder = folderOf(note);
    return V.h('span.today-sub', {}, emoji(folder), note.locked ? V.icon('lock') : null,
      V.h('button.today-where', { type: 'button', onclick: () => open(note.id), dataset: { key: `o:${note.id}` } },
        V.h('span', { text: note.locked ? 'Locked note' : folder ? folder.name : 'Open it' })));
  }

  /* A row with a box to tick: a to-do of a note (`row.item`), or a note with none (`row.kind` 'note'), or "+N more"
     of a note's to-dos. Today's rows are dueRows(); a coming day's notes come through noteRow(). The chip (its time,
     "3 days late") is in with the words since 1.18: at the row's end when wide, under the title on a phone, beside the
     folder (styles.css), so a long title is never cut to "Test..." by it. */
  function todoRow(row, test = false) {
    const note = row.note;
    if (row.kind === 'more') {
      return V.h('li.today-more-li', {}, V.h('button.today-more-row', { type: 'button', onclick: () => open(note.id), dataset: { key: row.key } },
        V.h('span', { text: row.text }), icon('chev')));
    }
    const onTick = row.kind === 'item' ? () => tickItem(note.id, row.item.index, row.item.raw) : () => tickNote(note.id);
    return V.h('li.today-row' + (row.done ? '.done' : '') + (row.late ? '.late' : '') + (test ? '.test' : ''), { dataset: { id: note.id } },
      tick(row.done, `${test ? 'Test: ' : ''}${row.text}: ${row.done ? 'not done' : 'done'}`, onTick, `t:${row.key}`),
      V.h('div.today-row-text', {},
        V.h('strong', {}, test ? [V.icon('target', 'dg-test'), V.h('span.sr-only', { text: 'Test: ' })] : null, row.text),
        row.kind === 'item' ? whereLine(note) : noteSub(note),
        chip(row.chip)));
  }

  /* A note on one of the coming days: ticked from here (its first to-do, or the note), like Today's. */
  const noteRow = (item) => todoRow({ key: item.key, kind: item.item ? 'item' : 'note', note: item.note, item: item.item,
    late: false, done: false, chip: item.chip, text: item.text }, item.test);

  /* A repeating note's later one: its repeat mark where the box would be (only its next one is ticked, on its own
     day), and a tap on it opens the note. */
  function repeatRow(item) {
    const note = item.note;
    const folder = folderOf(note);
    const rule = item.rule;
    return V.h('li.today-row.dg-repeat', { dataset: { id: note.id, day: item.day } },
      V.h('span.dg-lead', { 'aria-hidden': 'true' }, R().icon('repeat')),
      V.h('button.today-row-text.dg-open', { type: 'button', title: 'Open the note', onclick: () => open(note.id), dataset: { key: `o:${item.key}` } },
        V.h('strong', { text: item.text }),
        V.h('span.today-sub', {}, emoji(folder), note.locked ? V.icon('lock') : null,
          V.h('span', { text: note.locked ? 'Locked note' : folder ? folder.name : 'Open it' })),
        chip({ text: item.at ? R().clock(item.at) : R().repeatText(rule), cls: item.at ? 'soon' : 'plain', bell: !!item.at, repeat: true,
          said: R().repeatText(rule) + (item.at ? ` · ${R().clock(item.at)}` : ''),
          spoken: `${item.at ? `reminder at ${spokenTime(item.at)}, ` : ''}repeats ${spokenRule(rule)}` })));
  }

  /* Another part's thing (js/subs.js: a renewal): its own lead, words and button; never ticked here. */
  function extraRow(item) {
    const make = (x) => (typeof x === 'function' ? x() : x) || null;
    const opens = typeof item.open === 'function';
    const data = {};
    for (const [key, value] of Object.entries(item.data || {})) data[key] = String(value);
    return V.h('li.today-row.dg-extra' + (item.warn ? '.warn' : ''), { dataset: { ...data, day: item.day } },
      V.h('span.dg-lead', { 'aria-hidden': 'true' }, make(item.lead)),
      V.h(opens ? 'button.today-row-text.dg-open' : 'div.today-row-text', opens
        ? { type: 'button', title: item.openTitle || null, onclick: item.open, dataset: { key: `o:${item.key}` } } : {},
      V.h('strong', { text: item.text }), item.line ? V.h('span.today-sub', {}, V.h('span', { text: String(item.line) })) : null),
      make(item.action));
  }

  const itemRow = (item) => (item.kind === 'repeat' ? repeatRow(item) : item.kind === 'extra' ? extraRow(item) : noteRow(item));

  /* "Today" / "Tomorrow" / "Wednesday", the date beside it, and the whole of it in words for a screen reader. */
  function dayWords(day, today) {
    const d = V.parseDate(day);
    const n = daysFrom(today, day);
    const month = MONTHS[d.getMonth()];
    const name = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : WEEKDAYS[d.getDay()];
    return { name, date: (n <= 1 ? `${SHORT_DAYS[d.getDay()]}, ` : '') + `${month.slice(0, 3)} ${d.getDate()}`,
      said: (n <= 1 ? `${name}, ` : '') + `${WEEKDAYS[d.getDay()]}, ${month} ${d.getDate()}` };
  }

  /* One day of the list: its heading, then a list of what's on it (a list named by the heading), or "Nothing due" on
     the heading's line. Today's holds what's due today or late, as Due today did (`data-section` still 'due'). `top`:
     a phone's Today, on its own near the screen's top (1.18), so its heading is one of the screen's h2s. */
  function dayGroup(day, plan, top = false) {
    const today = plan.today;
    const isToday = day === today;
    const items = plan.byDay.get(day) || [];
    const words = dayWords(day, today);
    const id = `dg-${day}`;
    const rows = [];
    let meta = null;
    let after = null;
    if (isToday) {
      const due = plan.due || [];
      const drawn = due.slice(0, MOST_DUE);
      rows.push(...drawn.map((row) => todoRow(row, row.kind === 'note' && isTest(row.note))), ...items.map(itemRow));
      const todo = openCount(due);
      const late = openCount(due.filter((r) => r.late));
      if (todo) meta = [V.h('span', { text: `${todo} to do` }), late ? [V.h('span.dg-sep', { text: ' · ' }), V.h('span.late-w', { text: `${late} late` })] : null];
      const rest = due.length - drawn.length;
      if (rest > 0) {
        after = V.h('button.today-link.today-after', { type: 'button', onclick: () => toNotes('due'), dataset: { key: 'due-more' } },
          `${rest} more in Upcoming`);
      }
    } else {
      const shown = items.slice(0, items.length > MOST_PER_DAY ? MOST_PER_DAY - 1 : MOST_PER_DAY);
      rows.push(...shown.map(itemRow));
      if (items.length > shown.length) {
        rows.push(V.h('li.today-more-li', {}, V.h('button.today-more-row', { type: 'button', onclick: () => toNotes('due'),
          dataset: { key: `more:${day}` } }, V.h('span', { text: `+${items.length - shown.length} more in Upcoming` }), icon('chev'))));
      }
    }
    const empty = !rows.length;
    // (never the class "empty": that's the empty screens' own, centred with 56 px above and below, which put a big gap
    // round every day with nothing on it in 1.17)
    return V.h('div.day-group' + (isToday ? '.today-sec.is-today' : '') + (empty ? '.dg-empty' : '') + (top ? '.dg-top' : ''),
      { dataset: isToday ? { day, section: 'due' } : { day } },
      V.h('div.dg-head', {},
        V.h((top ? 'h2' : 'h3') + '.dg-title', { id, tabindex: '-1' }, V.h('span.sr-only', { text: words.said }),
          V.h('span.dg-name', { text: words.name, 'aria-hidden': 'true' }), V.h('span.dg-date', { text: words.date, 'aria-hidden': 'true' })),
        empty ? V.h('span.dg-meta.none', { text: 'Nothing due' }) : meta ? V.h('span.dg-meta', {}, meta) : null),
      empty ? null : V.h('ul.today-box.today-todo.dg-list', { 'aria-labelledby': id }, rows),
      after);
  }

  /* A phone's run of days with nothing on them, as one quiet line (1.18): "Nothing due tomorrow", "Nothing due Thu",
     "Nothing due Tue – Thu" (said in full words). A day tapped in the strip that's in it comes here. */
  function gapLine(run, today) {
    const first = run[0];
    const last = run[run.length - 1];
    const name = (day, names) => (daysFrom(today, day) === 1 && run.length === 1 ? 'tomorrow' : names[V.parseDate(day).getDay()]);
    const shown = run.length === 1 ? name(first, SHORT_DAYS) : `${name(first, SHORT_DAYS)} – ${name(last, SHORT_DAYS)}`;
    const said = run.length === 1 ? name(first, WEEKDAYS) : `${name(first, WEEKDAYS)} to ${name(last, WEEKDAYS)}`;
    return V.h('p.day-gap', { id: `dgap-${first}`, tabindex: '-1', dataset: { day: first, to: last } },
      V.h('span', { text: `Nothing due ${shown}`, 'aria-hidden': 'true' }), V.h('span.sr-only', { text: `Nothing due ${said}` }));
  }

  /* How many things are on a week of the strip after today (what "Show next week" says it will show). */
  function weekCount(plan, week) {
    return plan.days.filter((d) => d.week === week && d.day > plan.today).reduce((n, d) => n + (plan.byDay.get(d.day) || []).length, 0);
  }

  /* The days' list: a part per week of the strip ("This week", "Next week", "Week of Nov 16"), each day of the strip
     from today on, as far as weeksShown(); then "Show next week" until the strip's last week is in. On a phone
     (1.18) Today isn't in it (todaySection, near the top), empty days come in runs (gapLine), and the button says how
     much is on the week it shows. */
  function daysSection(plan, now, wide = V.wide()) {
    const shown = weeksShown(now, wide, plan);
    const weeks = [];
    for (const { day, week } of plan.days) {
      if (day < plan.today || week >= shown || (!wide && day === plan.today)) continue;
      const last = weeks[weeks.length - 1];
      if (last && last.week === week) last.days.push(day); else weeks.push({ week, days: [day] });
    }
    // (a phone on a Friday with nothing left this week: next week is in too, under a line saying so)
    if (!wide && !weeks.some((w) => w.week === 0)) weeks.unshift({ week: 0, days: [] });
    const body = (days) => {
      if (wide) return days.map((day) => dayGroup(day, plan));
      if (!days.length) return V.h('p.day-gap.none', { text: 'Nothing else this week' });
      const out = [];
      let run = [];
      const flush = () => { if (run.length) out.push(gapLine(run, plan.today)); run = []; };
      for (const day of days) {
        if ((plan.byDay.get(day) || []).length) { flush(); out.push(dayGroup(day, plan)); } else run.push(day);
      }
      flush();
      return out;
    };
    const next = shown < STRIP_WEEKS ? plan.days.find((d) => d.week === shown) : null;
    const nextTitle = next ? weekTitle(shown, next.day) : '';
    const count = next && !wide ? weekCount(plan, shown) : 0;
    return V.h('div.today-sec.today-daylist', { dataset: { section: 'days' } },
      weeks.map(({ week, days }, i) => V.h('section.days-week', { dataset: { week: String(week) } },
        V.h('div.today-sec-head', {}, V.h('h2', { id: `dw-${week}`, tabindex: '-1', text: weekTitle(week, days[0]) }),
          i === 0 ? V.h('button.today-link', { type: 'button', onclick: () => toNotes('due'), dataset: { key: 'link:days' } }, 'Upcoming') : null),
        body(days))),
      next ? V.h('button.days-more', { type: 'button', onclick: () => showWeek(shown), dataset: { key: 'days-more' } },
        V.h('span', { text: shown === 1 ? 'Show next week' : `Show the ${nextTitle.charAt(0).toLowerCase()}${nextTitle.slice(1)}` }),
        wide ? null : V.h('span.days-more-n', { text: ` · ${count ? plural(count, 'thing') : 'nothing due'}` }),
        V.icon('down')) : null);
  }

  /* A phone's Today (1.18): its own day, near the top, before the tests and flash cards. */
  const todaySection = (plan) => dayGroup(plan.today, plan, true);

  /* The list drawn again on its own (a week more of it), keeping the focus. */
  function refreshDays() {
    if (!showing() || !daysOn) return;
    const old = root.querySelector('.today-sec[data-section=days]');
    if (!old) return;
    const active = old.contains(document.activeElement) ? document.activeElement : null;
    const key = active && active.closest('[data-key]') ? active.closest('[data-key]').dataset.key : null;
    const id = active && !key ? active.id : '';
    const now = new Date();
    const made = section('days', () => daysSection(dayPlan(now, liveNotes()), now));
    if (!made) return;
    old.replaceWith(made);
    const back = key ? [...made.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key) : id ? made.querySelector(`#${CSS.escape(id)}`) : null;
    if (back) back.focus({ preventScroll: true });
  }

  /* "Show next week": that week in the list, and the keyboard taken to its title. */
  function showWeek(week) {
    listWeeks = Math.min(STRIP_WEEKS, Math.max(listWeeks, week + 1));
    refreshDays();
    const title = root && root.querySelector(`#dw-${week}`);
    if (title) title.focus();
  }

  /* A day tapped in the strip: its group in the list, brought into sight and lit up for a moment (a day gone by: Today,
     where what's still left from it is). The keyboard goes there too. */
  function goToDay(day) {
    if (!showing()) return;
    const now = new Date();
    const today = V.dateText(now);
    const want = day < today ? today : day;
    if (weekOf(now, want) >= weeksShown(now)) {
      listWeeks = Math.min(STRIP_WEEKS, weekOf(now, want) + 1);
      refreshDays();
    }
    // (a day, or on a phone the quiet line for a run of empty days it's in: 1.18)
    const spots = [...root.querySelectorAll('.day-group, .day-gap[data-day]')];
    const holds = (el) => el.dataset.day === want || (!!el.dataset.to && el.dataset.day <= want && want <= el.dataset.to);
    const group = spots.find(holds) || spots.find((g) => g.dataset.day > want) || spots[spots.length - 1];
    if (!group) { toNotes('due'); return; }
    const title = group.classList.contains('day-gap') ? group : group.querySelector('.dg-title');
    if (title) title.focus({ preventScroll: true });
    const box = group.getBoundingClientRect();
    const sight = root.getBoundingClientRect();
    if (box.top < sight.top || box.bottom > sight.bottom) {
      group.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    for (const lit of root.querySelectorAll('.day-group.flash, .day-gap.flash')) lit.classList.remove('flash');
    void group.offsetWidth;  // (lit from the start again)
    group.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => group.classList.remove('flash'), FLASH_MS);
  }

  function daysTile(days) {
    if (days <= 0) return V.h('span.today-days.word', {}, V.h('b', { text: 'Today' }));
    if (days === 1) return V.h('span.today-days.word', {}, V.h('b', { text: 'Tomorrow' }));
    return V.h('span.today-days', {}, V.h('b', { text: String(days) }), V.h('span', { text: 'days' }));
  }

  function testCard(card, first) {
    const note = card.note;
    const at = RV().now();
    // (a phone's card is the compact one, 1.18: "Thu, Nov 5", so the date and what it covers fit on one line)
    const when = V.parseDate(card.day).toLocaleDateString(undefined, { weekday: V.wide() ? 'long' : 'short', month: 'short', day: 'numeric' });
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
    // No cards in what it covers yet: AI makes some from those notes (js/aicards.js); the test's name still opens it.
    const go = plan.count
      ? V.button('Study', { kind: first ? 'primary' : 'tonal', icon: 'cards', onClick: () => RV().start('test:' + note.id) })
      : V.aiCards ? V.button('Make cards', { kind: first ? 'primary' : 'tonal', icon: 'spark', onClick: () => V.aiCards.forTest(note.id) })
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

  /* Flash cards (1.18, the owner: "the flashcards are chaotic"): how many to study today and one Study button; the
     folders they're in only when there are two or more (one folder would only say the same number again), and the
     share for a test only when it's a part of them (all of them is no news). */
  function cardsSection(at, primary) {
    if (!at.list.length) return null;
    const total = at.list.filter((c) => RV().isDue(c, at)).length;
    if (!total) {
      return part('cards', 'Flash cards', V.h('div.today-box.today-cards.done', {},
        V.h('strong', { text: 'All done for today' }), V.h('p.hint', { text: RV().nextDue(at) })));
    }
    const plan = at.plans.find((p) => p.days <= 6);
    const forTest = plan ? at.list.filter((c) => RV().isDue(c, at) && plan.covers(c)).length : 0;
    const which = !plan ? '' : plan.days === 0 ? 'today\'s' : plan.days === 1 ? 'tomorrow\'s' : `${WEEKDAYS[V.parseDate(plan.day).getDay()]}'s`;
    const all = RV().dueByFolder(at);
    // (one folder holding every card due: no row repeating the count and Study, its name is in the words, 1.18)
    const one = all.length === 1 && all[0].due === total ? all[0] : null;
    const decks = all.length > 1 ? all : [];
    const shown = decks.slice(0, decks.length > MOST_DECKS ? MOST_DECKS - 1 : MOST_DECKS);
    const rest = decks.length - shown.length;
    return part('cards', 'Flash cards', V.h('div.today-box.today-cards' + (decks.length ? '' : '.one-deck'), {},
      V.h('div.fc-top', {}, V.h('p.fc-n', {}, V.h('b', { text: String(total) }),
        V.h('span', { text: (total === 1 ? 'card to study today' : 'cards to study today') + (one ? ` in ${one.name}` : '') })),
        // (beside a test's Study, the screen's second strong button since 1.18: plain, it didn't look like the way in)
        V.button('Study', { kind: primary ? 'primary' : 'tonal', icon: 'cards', onClick: () => RV().start('all') })),
      forTest && forTest < total ? V.h('p.fc-note', {}, V.icon('target'), V.h('span', { text: `Includes ${forTest} for ${which} test` })) : null,
      decks.length ? V.h('div.today-decks', {}, shown.map((d) => V.h('button.today-deck', { type: 'button', onclick: () => RV().start(d.deck),
        title: `Study ${d.name}`, dataset: { deck: d.deck, key: `d:${d.deck}` } },
      d.folder && d.folder.icon ? V.h('span.emo', { text: d.folder.icon, 'aria-hidden': 'true' }) : V.icon('folder'),
      V.h('span.deck-name', { text: d.name }), V.h('b', { text: String(d.due) }), icon('chev'))),
      rest > 0 ? V.h('button.today-deck.more', { type: 'button', onclick: () => toNotes('review'), dataset: { key: 'd:more' } },
        V.h('span.deck-name', { text: `+${rest} more` }), icon('chev')) : null) : null));
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

  /* -- the days at the top (1.17): a strip that scrolls sideways

     The owner: "an option to scroll through the Today, Tuesday, Wednesday, etc like two finger scroll to check out the
     other week too". The strip is the browser's own sideways scroller, so a trackpad's two-finger swipe, a finger's
     swipe and Shift + the mouse wheel all move it, and it stops on a day (scroll snapping). Turning the mouse wheel up
     and down over it scrolls the page as anywhere else (nothing here turns that into sideways), and at its ends a
     sideways swipe stops there (overscroll-behavior-x), never taking a Chromebook back a page. Small arrows (not on a
     touch screen, which swipes) step a screenful of days at a time. It's one Tab stop: the arrow keys, Home and End
     move along the days. Today is the first day in sight when it's drawn, and a redraw (a sync) keeps the day you
     scrolled to. */

  const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { return true; } };
  const daysIn = (strip) => [...strip.querySelectorAll('.wday')];

  /* Where the days line up: the strip's left edge plus its snapping inset (a phone's strip runs to the screen's edges,
     its days 16 px in). */
  function startLine(strip) {
    const inset = parseFloat(getComputedStyle(strip).scrollPaddingLeft);
    return strip.getBoundingClientRect().left + (Number.isFinite(inset) ? inset : 0);
  }

  /* The day at the strip's start (the nearest to where the days line up). */
  function firstShown(strip) {
    const at = startLine(strip);
    let best = null;
    let far = Infinity;
    for (const cell of daysIn(strip)) {
      const off = Math.abs(cell.getBoundingClientRect().left - at);
      if (off < far) { far = off; best = cell; }
    }
    return best;
  }

  /* The strip scrolled so `day` (or the first one after it) is at its start. */
  function stripTo(strip, day, smooth = false) {
    const cells = daysIn(strip);
    const cell = cells.find((c) => c.dataset.day >= day) || cells[cells.length - 1];
    if (!cell) return;
    const left = Math.max(0, strip.scrollLeft + cell.getBoundingClientRect().left - startLine(strip));
    strip.scrollTo({ left, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  }

  /* The days wholly in sight. */
  function inSight(strip) {
    const at = startLine(strip);
    const end = strip.getBoundingClientRect().right - (at - strip.getBoundingClientRect().left);
    return daysIn(strip).filter((cell) => {
      const box = cell.getBoundingClientRect();
      return box.left >= at - 1 && box.right <= end + 1;
    });
  }

  /* The arrows: a screenful of days earlier or later (Monday to Friday, when wide). */
  function stepStrip(strip, direction) {
    const cells = daysIn(strip);
    const first = firstShown(strip);
    if (!first) return;
    const page = Math.max(1, inSight(strip).length);
    const to = Math.min(cells.length - 1, Math.max(0, cells.indexOf(first) + direction * page));
    stripTo(strip, cells[to].dataset.day, true);
  }

  /* The strip's one Tab stop on `cell`. */
  function rove(strip, cell) {
    for (const one of daysIn(strip)) one.tabIndex = one === cell ? 0 : -1;
    stripFocus = cell.dataset.day;
  }

  function stripKeys(event) {
    const strip = event.currentTarget;
    const cells = daysIn(strip);
    const at = cells.indexOf(event.target.closest('.wday'));
    if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: cells.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const cell = cells[Math.min(cells.length - 1, Math.max(0, to))];
    rove(strip, cell);
    cell.focus();  // (the browser brings it into sight)
  }

  /* After a scroll (or a draw): the arrows at the ends say so, the title names the week most of the days in sight are
     in (and `data-week` says which, so a phone shows the title only off this week: styles.css), and the Tab stop
     moves onto a day in sight (unless the keyboard is in the strip: then it's where the keys put it). `moved`: after
     the strip was scrolled (by a finger, a trackpad, its arrows, its keys), the only time the list grows to a later
     week in sight (never from a draw or the window resizing, nor while the strip has no size to measure). */
  function stripState(nav, moved = false) {
    const strip = nav && nav.querySelector('.today-week-days');
    if (!strip || !strip.isConnected || !strip.clientWidth) return;
    const first = firstShown(strip);
    if (first) leftAt = first.dataset.day;
    const most = strip.scrollWidth - strip.clientWidth;
    const prev = nav.querySelector('.week-step.prev');
    const next = nav.querySelector('.week-step.next');
    if (prev) prev.setAttribute('aria-disabled', String(strip.scrollLeft <= 1));
    if (next) next.setAttribute('aria-disabled', String(strip.scrollLeft >= most - 1));
    const shown = inSight(strip);
    const counts = new Map();
    for (const cell of shown) counts.set(cell.dataset.week, (counts.get(cell.dataset.week) || 0) + 1);
    let week = null;
    for (const [one, n] of counts) if (week === null || n > counts.get(week) || (n === counts.get(week) && Number(one) < Number(week))) week = one;
    const title = nav.querySelector('.today-week-title');
    if (title && week !== null) {
      const words = weekTitle(Number(week), shown.find((c) => c.dataset.week === week).dataset.day);
      if (title.textContent !== words) title.textContent = words;
      if (nav.dataset.week !== week) nav.dataset.week = week;
    }
    if (!strip.contains(document.activeElement) && shown.length) {
      const stop = strip.querySelector('.wday[tabindex="0"]');
      if (!stop || !shown.includes(stop)) rove(strip, shown.find((c) => c.classList.contains('today')) || shown[0]);
    }
    // A later week in sight: its days in the list too (it never shrinks back while Today is open).
    const far = Math.max(-1, ...shown.map((c) => Number(c.dataset.week)));
    if (moved && daysOn && far >= weeksShown()) {
      listWeeks = Math.min(STRIP_WEEKS, far + 1);
      refreshDays();
    }
  }

  function weekStrip(week, now, startDay = '') {
    const today = V.dateText(now);
    const focusDay = week.cells.some((c) => c.day === stripFocus) ? stripFocus : today;
    const days = V.h('div.today-week-days', { onkeydown: stripKeys }, week.cells.map((cell) => {
      let body;
      if (cell.today && (cell.todo || !cell.count)) {
        body = cell.todo ? V.h('span.wd-item', {}, V.h('span', { text: `${cell.todo} to do` }),
          cell.late ? [V.h('span.wd-sep', { text: ' · ' }), V.h('span.late-w', { text: `${cell.late} late` })] : null)
          : V.h('span.wd-item', {}, V.h('span.none', { text: 'Nothing due' }));
      } else if (cell.past) {
        body = V.h('span.wd-item', {}, V.h('span.none', { text: !cell.count ? 'Nothing due' : cell.left ? `${cell.left} left` : 'All done' }));
      } else if (cell.test) {
        body = V.h('span.wd-item.test', {}, V.icon('target'), V.h('span', { text: cell.test }),
          cell.more ? V.h('span.wd-more', { text: `+${cell.more}` }) : null);
      } else if (cell.text) {  // (today's too, with no to-do on it: a renewal)
        body = V.h('span.wd-item', {}, cell.first ? emoji(folderOf(cell.first)) : null, V.h('span', { text: cell.text }),
          cell.more ? V.h('span.wd-more', { text: `+${cell.more}` }) : null);
      } else body = V.h('span.wd-item', {}, V.h('span.none', { text: 'Nothing due' }));
      // (a tap takes the list under it to that day: js/today.js goToDay)
      return V.h('button.wday' + (cell.today ? '.today' : '') + (cell.past ? '.past' : ''), { type: 'button',
        tabindex: cell.day === focusDay ? '0' : '-1', 'aria-current': cell.today ? 'date' : null, onclick: () => goToDay(cell.day),
        dataset: { day: cell.day, week: String(cell.week), key: `w:${cell.day}` } },
      V.h('span.wd-label', { text: cell.label }), body);
    }));
    // (`data-week`: the week in sight, kept by stripState; from the start, so a phone's title doesn't come and go as
    // Today is drawn: it moves, smoothly, only once the strip has been scrolled, `.live`)
    const nav = V.h('nav.today-week', { 'aria-label': 'Days', dataset: { week: String(Math.max(0, weekOf(now, startDay || today))) } },
      V.h('div.today-week-head', {}, V.h('p.today-week-title', { text: weekTitle(0, today) }),
        V.h('div.week-steps', {},
          V.h('button.week-step.prev', { type: 'button', 'aria-label': 'Earlier days', title: 'Earlier days', 'aria-disabled': 'true',
            onclick: () => { if (prevOk()) stepStrip(days, -1); } }, V.icon('back')),
          V.h('button.week-step.next', { type: 'button', 'aria-label': 'Later days', title: 'Later days',
            onclick: () => { if (nextOk()) stepStrip(days, 1); } }, V.icon('chevron')))),
      days);
    const prevOk = () => days.scrollLeft > 1;
    const nextOk = () => days.scrollLeft < days.scrollWidth - days.clientWidth - 1;
    let queued = false;
    days.addEventListener('touchstart', () => { stripMoved = performance.now(); }, { passive: true });
    days.addEventListener('scroll', () => {
      stripMoved = performance.now();
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; nav.classList.add('live'); stripState(nav, true); });
    }, { passive: true });
    days.addEventListener('focusin', (event) => {
      const cell = event.target.closest && event.target.closest('.wday');
      if (cell) rove(days, cell);
    });
    return nav;
  }
  // (a window made wider or narrower: the days in sight change)
  window.addEventListener('resize', V.debounce(() => { if (showing()) stripState(root.querySelector('.today-week')); }, 150));

  /* Today's top again: from the logo (here, or the rail's when wide, js/start.js) or Today's tab tapped on Today, the
     page back at its top and the days back to today; the weeks the list grew to stay. Tapped again once both are
     there, the list goes back to how Today opens too (1.18: a phone shows this week until more is asked for, and with
     each tab keeping its place that was the only way back): never while either is still on its way, as the strip
     sliding back past later weeks would grow the list again. From another screen, it opens Today. */
  function toTop() {
    if (!showing()) { V.go('today', { top: true }); return; }
    if (listWeeks && atStart()) {
      listWeeks = 0;
      refreshDays();
      return;
    }
    const smooth = !reducedMotion();
    root.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    const strip = root.querySelector('.today-week-days');
    if (strip) stripTo(strip, V.dateText(new Date()), true);
  }

  // (the page at its top, and the strip with today at its start, as toTop leaves them)
  function atStart() {
    if (root.scrollTop > 1) return false;
    const strip = root.querySelector('.today-week-days');
    if (!strip || !strip.clientWidth) return true;
    const today = V.dateText(new Date());
    const home = daysIn(strip).find((c) => c.dataset.day >= today);
    return !home || firstShown(strip) === home;
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
    // (the day turned over since the last draw: the list starts again from this week)
    if (drawnDay && drawnDay !== V.dateText(now)) listWeeks = 0;
    // What's on the days, once for the strip and the list under it.
    let plan = null;
    try { plan = dayPlan(now, list, due || []); } catch (error) { console.error('Wefty: Today\'s days:', error); }
    const user = V.data.user || {};
    const welcoming = V.welcome && V.welcome.pending && V.welcome.pending(user.id);
    const status = V.cloud && V.cloud.status;
    if (status === 'synced' || status === 'held') synced = true;
    const known = synced || (status === 'offline' && !list.length);
    const fresh = known && !welcoming && nothingYet(list, at, plan);
    daysOn = !fresh;  // (before the other parts' sections are built: js/subs.js asks)
    const tests = section('tests', () => testCards(at, list)) || [];
    // (Quick actions aren't one of these any more: they go across the top, under the days, 1.17; the days' list took
    // the places of Due today and Later this week. A phone, 1.18: Today's own day first, the rest of the days after
    // the flash cards, where Later this week was.)
    const daysPart = () => (due ? daysSection(plan || dayPlan(now, list, due), now, wide) : null);
    const ownParts = fresh ? [
      { id: 'howto', column: 'left', build: howTo },
      { id: 'devices', column: 'right', build: devicesSection },
      { id: 'jump', column: 'left', build: () => jumpSection(jumpBack(list)) },
    ] : [
      ...(wide ? [{ id: 'days', column: 'right', build: daysPart }] : [
        { id: 'due', column: 'right', build: () => (due ? todaySection(plan || dayPlan(now, list, due)) : null) },
        { id: 'days', order: ORDER.later, column: 'right', build: daysPart },
      ]),
      { id: 'tests', column: 'left', build: () => (Array.isArray(tests) ? testsSection(tests) : tests) },
      { id: 'cards', column: 'left', build: () => cardsSection(at, !(Array.isArray(tests) && tests.length)) },
      { id: 'jump', column: 'left', build: () => jumpSection(jumpBack(list)) },
    ];
    const parts = [...ownParts.map((p) => ({ ...p, order: p.order || ORDER[p.id] })), ...extra].sort((a, b) => a.order - b.order);
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
    // The days at the top, on every device since 1.17 (a phone too), once there's something to show in them.
    // (the day the strip was at, put back after the redraw unless the day has turned over since; the strip's title
    // starts on its week)
    const oldStrip = root.querySelector('.today-week-days');
    // (opened again from a tab, js/start.js: the day it was left at, as the old strip is gone by then)
    const shownDay = oldStrip && oldStrip.clientWidth && drawnDay === V.dateText(now) ? (firstShown(oldStrip) || {}).dataset
      : backTo && drawnDay === V.dateText(now) ? { day: backTo } : null;
    const strip = !fresh ? section('week', () => weekStrip(weekCells(now, list, due || [], plan), now, shownDay && shownDay.day)) : null;
    const quickTop = section('quick', quick);
    const before = !known && !welcoming && !list.length ? V.h('p.today-quiet.today-getting', { text: 'Getting your notes…' }) : null;
    const welcomeText = fresh ? V.h('p.today-welcome', { text: 'Welcome to Wefty. Today fills up from your notes: give one a date, a test or some flash cards, and they show here.' }) : null;

    // (what had the focus and how far Jump back in was scrolled: put back after the redraw)
    const focused = root.contains(document.activeElement) && document.activeElement.closest('[data-key]');
    const focusKey = focused ? focused.dataset.key : null;
    const jump = root.querySelector('.today-jump');
    const scrolled = jump ? jump.scrollLeft : 0;

    V.clear(root, V.h('div.page.today' + (wide ? '.wide' : '') + (fresh ? '.fresh' : ''), {},
      head(), greet, line(), strip, welcomeText, quickTop, before,
      V.h('div.today-cols', {}, V.h('div.today-col.left', {}, wide ? column('left') : column()),
        wide ? V.h('div.today-col.right', {}, column('right')) : null)));

    const again = root.querySelector('.today-jump');
    if (again && scrolled) again.scrollLeft = scrolled;
    const days = root.querySelector('.today-week-days');
    if (days) {
      try {
        stripTo(days, shownDay && shownDay.day ? shownDay.day : V.dateText(now));
        stripState(days.closest('.today-week'));
      } catch (error) { console.error(error); }
    }
    if (focusKey) {
      const back = [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focusKey);
      if (back) back.focus({ preventScroll: true });
    }
    dayTimer(now);
  }

  function redraw() {
    try { draw(); } catch (error) { console.error(error); }
  }
  // Changes come in bursts (a sync, a save): drawn once they settle, never under a note open over Today, never under
  // a finger or a trackpad moving the days (once they've rested a moment), and never while your picture's menu is open
  // from Today's top row (a redraw took the button it hangs from away, and its Escape lost the focus with it: a
  // device's own record, written a few seconds after the first sync, did that now and then).
  const covered = () => !!(V.editor && V.editor.covering && V.editor.covering());
  const menuOpen = () => !!(root && root.querySelector('[aria-expanded="true"]'));
  const redrawSoon = V.debounce(() => {
    if (!showing() || covered()) return;
    if (performance.now() - stripMoved < 700 || menuOpen()) { redrawSoon(); return; }
    redraw();
  }, 300);

  /* The day turning over while Today is open (the PC left on): drawn again just after midnight. */
  let timer = null;
  let drawnDay = '';
  function dayTimer(now) {
    drawnDay = V.dateText(now);
    clearTimeout(timer);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    timer = setTimeout(() => { if (showing()) redraw(); }, Math.min(next - now, 2 ** 31 - 1));
  }

  /* `opts.back`: opened again from a tab (js/start.js puts the page's scroll back): the days where they were left and
     the weeks the list had grown to. Else (the first time, the logo from another screen): from today. */
  function render(container, opts = {}) {
    root = container;
    if (!opts.back) listWeeks = 0;
    backTo = opts.back ? leftAt : '';
    try { draw(); } finally { backTo = ''; }
  }

  // Today's tab tapped while Today shows: its top, the days back to today (as the logo does; the list keeps its weeks).
  function again() {
    if (!showing()) return false;
    toTop();
    return true;
  }

  // (never for the clipboard or what's sent: Today shows neither, and a phone's clipboard in step writes one each time
  // it comes back to the front, so a long screen was drawn again under a finger scrolling it)
  V.on('data', (table) => { if (table !== 'clips' && table !== 'transfers') redrawSoon(); });
  V.on('notetaker', () => redrawSoon());
  V.on('note-left', () => redrawSoon());
  V.on('status', (value) => { if ((value === 'synced' || value === 'held') && !synced) { synced = true; redrawSoon(); } });
  V.on('back', () => { if (showing() && V.today() !== drawnDay) redrawSoon(); });
  V.onWide(() => redraw());

  Object.assign(V.today, { render, again, open, addSection, addMenuItem, addDayItems, showsDays, redraw, section, greeting, ORDER,
    toTop, goToDay, dueRows, laterRows, testCards, jumpBack, stripDays, weekCells, dayPlan, itemsOf, tickItem, tickNote });
})();
