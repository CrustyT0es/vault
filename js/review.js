/* Vault: the Review page (the Notes tab's "Review", beside Upcoming): every flash card due today from all the notes,
   by folder and #tag ("Today: 34 cards · Biology 12 · Spanish 22"), and the cards themselves, one at a time.

   When a card comes back is worked out by FSRS, the schedule Anki uses (vendor/fsrs.js, ts-fsrs 5.4.2, its own
   default parameters, whole days): "Not yet" brings a card back tomorrow (and once more before the session ends), "I
   knew it" in a few days, and each time it's known again the wait grows (3 days, then about 2 weeks, then 2 months).
   A card is moved on once a day: going over it again the same day is practice, though missing it still brings it
   back tomorrow. Its progress is kept in its note's extra.cards (the card's code -> { due, s (stability), d
   (difficulty), last, n (times reviewed), l (times forgotten) }). Cards studied before FSRS still have their Leitner
   box there ([box, due]): it's read as the wait that box had earned, and turned into FSRS's own on the card's next
   review, so nothing learned is lost.

   Answers are saved in batches: each note's cards once at the end of a session, when Vault goes to the background,
   or every 20 seconds, never after every card. Those saves are `quiet` (js/cloud.js): a card's progress isn't an
   edit, so the note keeps its place in "Last edited" and History makes no copy of it.

   Tests: a note with a due date that says what it covers (folders and #tags, picked with its Test button, js/exams.js,
   or a line like "Covers: Biology, #cells") gets a cram plan. The covered cards that FSRS would only bring back after
   the test are pulled forward, spread over the days left, so Review shows them too; once the test day has passed
   they go back to their own days (their FSRS state was never changed for it). */
'use strict';

V.review = (() => {
  const O = V.organise;
  const R = V.reminders;

  /* -- FSRS */

  const F = window.FSRS;
  // ts-fsrs gives every Date four helpers of its own (scheduler, diff, format, dueFormat); nothing uses them.
  for (const name of ['scheduler', 'diff', 'format', 'dueFormat']) delete Date.prototype[name];
  const fsrs = F.fsrs(F.generatorParameters({ enable_fuzz: false, enable_short_term: false }));
  const AGAIN = F.Rating.Again;
  const GOOD = F.Rating.Good;
  const EASY = F.Rating.Easy;
  const OLD_DAYS = [0, 0, 1, 3, 7, 14];  // the days the old Leitner boxes 1 to 5 waited

  const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  // Days go to FSRS as noon UTC, so its whole-day sums come out the same in every time zone.
  const noon = (day) => new Date(`${day}T12:00:00Z`);
  const dayOf = (date) => date.toISOString().slice(0, 10);
  const daysBetween = (from, to) => Math.round((noon(to) - noon(from)) / 86400000);
  const order2 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /* A card's kept progress as FSRS sees it ({ due, s, d, last, n, l }), or null for one never studied. */
  function memory(value) {
    if (Array.isArray(value)) {  // a Leitner box from before: the wait it had earned
      const box = Math.max(1, Math.min(5, Math.round(Number(value[0])) || 1));
      const due = isDay(value[1]) ? value[1] : V.today();
      return { due, s: box === 1 ? fsrs.parameters.w[0] : OLD_DAYS[box], d: fsrs.init_difficulty(box === 1 ? AGAIN : GOOD),
        last: V.addDays(due, -OLD_DAYS[box]), n: box === 1 ? 1 : box - 1, l: 0 };
    }
    if (value && typeof value === 'object' && isDay(value.due) && isDay(value.last) && typeof value.s === 'number'
      && typeof value.d === 'number' && value.s >= 0.01 && value.s <= 36500 && value.d >= 1 && value.d <= 10) return value;
    return null;  // (damaged progress too: the card starts again rather than stopping the review)
  }

  /* The progress a card has after being answered on `today` (AGAIN, GOOD or EASY). Answered already today: the same
     (practice), unless it's missed and wasn't coming back by tomorrow anyway. A miss always comes back tomorrow (like
     Anki's one-day relearning step): FSRS's own wait after a slip on a well-known card (about 10 days) starts from the
     next right answer. */
  function next(value, rating, today = V.today()) {
    const was = memory(value);
    const tomorrow = V.addDays(today, 1);
    if (was && was.last >= today && !(rating === AGAIN && was.due > tomorrow)) return value;
    const card = was ? { due: noon(was.due), stability: was.s, difficulty: was.d, elapsed_days: 0, scheduled_days: 0,
      reps: was.n || 0, lapses: was.l || 0, learning_steps: 0, state: F.State.Review, last_review: noon(was.last) }
      : F.createEmptyCard(noon(today));
    const after = fsrs.next(card, noon(today), rating).card;
    const due = dayOf(after.due);
    return { due: rating === AGAIN && due > tomorrow ? tomorrow : due, s: after.stability, d: after.difficulty, last: today,
      n: after.reps, l: after.lapses };
  }

  const dueOn = (value) => { const m = memory(value); return m ? m.due : null; };
  const inDays = (days) => (days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
  /* When a card comes back after each answer: { again, good } as words ("tomorrow", "in 3 days"). */
  function preview(value, today = V.today()) {
    const when = (rating) => { const after = next(value, rating, today); return inDays(daysBetween(today, dueOn(after) || today)); };
    return { again: when(AGAIN), good: when(GOOD) };
  }
  /* Known: not due again until after tomorrow. */
  const known = (value, today = V.today()) => { const due = dueOn(value); return !!due && due > V.addDays(today, 1); };

  /* -- every card */

  const parsed = new WeakMap();  // a note's row -> its cards (a changed note is a new row)
  const studied = (row) => !!row && !row.deleted && !row._purge && !row.locked && !O.isArchived(row) && !O.isTemplate(row);

  function cardsOf(row, text = row.body) {
    let list = text === row.body ? parsed.get(row) : null;
    if (!list) {
      list = V.study.cards(text);
      if (text === row.body) parsed.set(row, list);
    }
    const kept = (row.extra && isObject(row.extra.cards)) ? row.extra.cards : {};
    const waiting = pending.get(row.id) || {};
    return list.map((c) => ({ ...c, id: row.id + '|' + c.key, note: row.id, folder: row.folder_id || null,
      state: c.key in waiting ? waiting[c.key] : keptFor(kept, c) }));
  }
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  /* A card's progress in its note's extra.cards: by its code, or by the one it had while its marks counted as its
     words (js/study.js: cards, `was`; it moves to the new code at the note's next save). */
  const keptFor = (kept, card) => (!kept[card.key] && card.was && kept[card.was]) || kept[card.key];

  /* Every flash card in Vault but those in locked, archived, template and deleted notes. */
  function all() {
    const out = [];
    for (const row of V.data.notes.values()) if (studied(row)) out.push(...cardsOf(row));
    return out;
  }

  /* A card's progress as it is now (answered in this session and not saved yet, or as its note keeps it). */
  function current(card) {
    const waiting = pending.get(card.note);
    if (waiting && card.key in waiting) return waiting[card.key];
    const row = V.data.notes.get(card.note);
    return row && row.extra && isObject(row.extra.cards) ? keptFor(row.extra.cards, card) : undefined;
  }

  /* -- decks: everything ('all'), a folder (with the folders inside it), a #tag, a note ('note:<id>'), a test
     ('test:<note id>': what it covers) */

  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const liveFolder = (id) => { const f = id ? V.data.folders.get(id) : null; return f && !f.deleted ? f : null; };
  const tagKey = (text) => String(text || '').replace(/^#/, '').toLowerCase().replace(/[-_.,!?;:]+$/, '');

  function inDeck(deck) {
    if (!deck || deck === 'all') return () => true;
    if (deck === 'none') return (c) => !liveFolder(c.folder);
    if (deck.startsWith('note:')) { const id = deck.slice(5); return (c) => c.note === id; }
    if (deck.startsWith('test:')) {
      const plan = planFor(V.data.notes.get(deck.slice(5)));
      return plan ? plan.covers : () => false;
    }
    if (deck.startsWith('#')) {
      const key = tagKey(deck);
      return (c) => O.tagsOf(V.data.notes.get(c.note) || {}).some((t) => t.key === key);
    }
    const ids = new Set([deck, ...O.inside(deck)]);
    return (c) => ids.has(c.folder);
  }

  function deckName(deck) {
    if (!deck || deck === 'all') return 'everything';
    if (deck.startsWith('note:') || deck.startsWith('test:')) return V.noteTitle(V.data.notes.get(deck.slice(5)) || {});
    if (deck.startsWith('#')) return '#' + tagKey(deck);
    const folder = liveFolder(deck);
    return folder ? folder.name : 'No folder';
  }

  /* -- tests and their cram plans */

  const TEST_WORDS = /\b(?:tests?|exams?|quiz(?:zes)?|finals?|midterms?|mocks?)\b/i;
  const COVERS_LINE = /^[ \t]*(?:[-*][ \t]+)?covers?[ \t]*:[ \t]*(.+)$/im;

  /* The folder a name means ("biology" for Biology), a top folder before one inside another. */
  function folderNamed(name) {
    const want = squash(name);
    const found = V.notes.folders().filter((f) => squash(f.name) === want);
    return found.sort((a, b) => O.ancestors(a).length - O.ancestors(b).length)[0] || null;
  }

  /* What a test note covers, as deck names (folder ids and '#tags'): the ones picked for it (extra.exam.covers) and
     those on a "Covers: Biology, #cells" line. */
  function coversOf(note) {
    const out = new Set();
    const picked = note.extra && note.extra.exam && Array.isArray(note.extra.exam.covers) ? note.extra.exam.covers : [];
    for (const item of picked) {
      if (typeof item !== 'string') continue;
      if (item.startsWith('#')) { if (tagKey(item)) out.add('#' + tagKey(item)); } else if (liveFolder(item)) out.add(item);
    }
    const line = COVERS_LINE.exec(note.locked ? '' : note.body || '');
    for (const item of line ? line[1].split(/\s*(?:[,;&+]|\band\b)\s*/i) : []) {
      const word = item.trim();
      if (word.startsWith('#')) { if (tagKey(word)) out.add('#' + tagKey(word)); } else if (word) {
        const folder = folderNamed(word);
        if (folder) out.add(folder.id);
      }
    }
    return [...out];
  }

  const looksLikeTest = (note) => TEST_WORDS.test(`${note.title || ''}\n${(note.locked ? '' : note.body || '').split('\n')[0]}`);

  /* "Bio test" from "Bio test fri 9am": the title without the words that said when. */
  function testName(note) {
    let name = (note.title || '').trim() || (!note.locked && (note.body || '').split('\n')[0].trim()) || '';
    const found = R.parse(name);
    if (found && found.words) {
      for (const word of found.words.split(/\s+/)) {
        name = name.replace(new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$|[,.;:!?)])`, 'i'), '$1');
      }
    }
    name = name.replace(/\s+/g, ' ').replace(/[\s,;:(-]+$/, '').trim();
    return name || 'Test';
  }

  /* The day a test's plan began: when its Test button was first used for this day, else when the note was made. */
  function planStart(note, today) {
    const exam = (note.extra && note.extra.exam) || {};
    let since = isDay(exam.since) && (!exam.for || exam.for === note.due) ? exam.since : '';
    if (!since && note.created_at) since = V.dateText(new Date(note.created_at));
    return since && since <= today ? since : today;
  }

  /* A test note's plan on `today` (null when it isn't a test, or the test day has passed): which cards it covers
     (`covers`, a test on a card), how many still need a look before the test day (`left`: new ones, ones due before it,
     and ones FSRS would bring back after it that haven't been gone over since the plan began), about how many a day
     that is (`perDay`), and the ones pulled forward for today (`today`, card ids): a share that keeps the day's
     covered reviews at about left / days. */
  function planFor(note, list = null, today = V.today()) {
    if (!note || !note.due || note.done || !studied(note) || note.due < today) return null;
    const covers = coversOf(note);
    if (!covers.length) return null;
    const folders = new Set();
    const tags = new Set();
    for (const item of covers) {
      if (item.startsWith('#')) tags.add(item.slice(1));
      else for (const id of [item, ...O.inside(item)]) folders.add(id);
    }
    const tagged = new Map();  // note id -> whether it has one of the tags
    const covered = (c) => folders.has(c.folder) || (tags.size > 0 && (tagged.has(c.note) ? tagged.get(c.note)
      : tagged.set(c.note, O.tagsOf(V.data.notes.get(c.note) || {}).some((t) => tags.has(t.key))).get(c.note)));
    const cards = (list || all()).filter(covered);
    const day = note.due;
    const days = daysBetween(today, day);
    const since = planStart(note, today);
    let left = 0;
    let done = 0;
    let dueNow = 0;
    const pulled = [];
    for (const card of cards) {
      const m = memory(card.state);
      if (m && m.last === today) done++;
      if (!m || m.due < day) {  // new, or due before the test day anyway
        left++;
        if (!m || m.due <= today) dueNow++;
      } else if (m.last < since) {  // FSRS would bring it back after the test, and it hasn't been gone over since
        left++;
        pulled.push({ id: card.id, due: m.due });
      }
    }
    const share = days > 0 ? Math.max(0, Math.ceil((left + done) / days) - done - dueNow) : 0;
    pulled.sort((a, b) => order2(a.due, b.due) || order2(a.id, b.id));  // (as vault/store.py sorts them)
    return { note, name: testName(note), day, days, covers: covered, folders, tags: [...tags], count: cards.length, left,
      perDay: days > 0 ? Math.ceil(left / days) : left, today: new Set(pulled.slice(0, share).map((p) => p.id)) };
  }

  /* -- what's due, worked out once per change */

  let version = 0;
  let cache = null;
  V.on('data', (table) => { if (table === 'notes' || table === 'folders') version++; });

  /* Every card, the tests coming up (soonest first) and the cards pulled forward for them today. */
  function now(today = V.today()) {
    const key = `${today}|${version}`;
    if (cache && cache.key === key) return cache;
    const list = all();
    const plans = [...V.data.notes.values()].map((note) => planFor(note, list, today)).filter(Boolean)
      .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
    const pulled = new Set();
    for (const plan of plans) for (const id of plan.today) pulled.add(id);
    cache = { key, today, list, plans, pulled };
    return cache;
  }

  const isDue = (card, at = now()) => { const due = dueOn(card.state); return !due || due <= at.today || at.pulled.has(card.id); };
  const dueIn = (deck = 'all') => { const at = now(); const test = inDeck(deck); return at.list.filter((c) => test(c) && isDue(c, at)); };
  const dueCount = () => { const at = now(); return at.list.filter((c) => isDue(c, at)).length; };

  /* -- answers, saved in batches */

  const timing = { every: 20000 };   // ms: answers wait at most this long to be saved
  const pending = new Map();         // note id -> { card code: progress } answered and not saved yet
  let timer = null;
  let flushing = Promise.resolve();

  /* A card answered (AGAIN, GOOD or EASY): its new progress, kept to be saved with the rest. */
  function grade(card, rating, today = V.today()) {
    const before = current(card);
    const after = next(before, rating, today);
    if (after === before) return before;
    if (!pending.has(card.note)) pending.set(card.note, {});
    pending.get(card.note)[card.key] = after;
    version++;
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, timing.every);
    return after;
  }

  /* Everything answered goes into its note: one save per note. */
  function flush() {
    clearTimeout(timer);
    timer = null;
    flushing = flushing.then(async () => {
      for (const [id, states] of [...pending]) {
        const sent = { ...states };
        try { await saveCards(id, sent); } catch (error) { V.problem(error); }
        const still = pending.get(id);
        if (!still) continue;
        for (const [key, value] of Object.entries(sent)) if (still[key] === value) delete still[key];
        if (!Object.keys(still).length) pending.delete(id);
      }
      version++;  // (a note that couldn't take them, locked meanwhile, shows what it really keeps)
    });
    return flushing;
  }

  /* The cards' progress into the note: through the editor when it's open (so its copy, saved whole, has it too),
     else straight into its row; quietly either way. Cards no longer in the note let theirs go (as Study always did).
     Locked or deleted notes are never touched. */
  function saveCards(id, states) {
    const put = (row, text) => {
      const kept = isObject((row.extra || {}).cards) ? row.extra.cards : {};
      row.extra = { ...(row.extra || {}), cards: V.study.prune({ ...kept, ...states }, V.study.cards(text)) };
    };
    if (V.editor.openId() === id && V.editor.current()) {
      if (V.editor.current().locked || V.editor.words() === null) return Promise.resolve();
      return V.editor.update((row) => put(row, V.editor.words()), { quiet: true });
    }
    const row = V.data.notes.get(id);
    if (!row || row._purge || row.deleted || row.locked) return Promise.resolve();
    const copy = { ...row };
    put(copy, copy.body);
    return V.cloud.save('notes', copy, { quiet: true });
  }

  V.on('away', () => { if (pending.size) flush(); });

  /* -- the Review page (drawn in the Notes tab's list by js/notes.js) */

  /* What each deck has: [{ deck, folder, depth, name, count, due }], folders as a tree (a folder's numbers include
     the folders inside it), then the notes with no folder, then #tags. */
  function decks(at = now()) {
    const out = [];
    const count = (test) => {
      const mine = at.list.filter(test);
      return { count: mine.length, due: mine.filter((c) => isDue(c, at)).length };
    };
    for (const { folder, depth } of O.tree()) {
      const numbers = count(inDeck(folder.id));
      if (numbers.count) out.push({ deck: folder.id, folder, depth, name: folder.name, ...numbers });
    }
    const loose = count(inDeck('none'));
    if (loose.count) out.push({ deck: 'none', folder: null, depth: 0, name: 'No folder', ...loose });
    const notes = [...new Set(at.list.map((c) => c.note))].map((id) => V.data.notes.get(id)).filter(Boolean);
    for (const tag of O.allTags(notes)) {
      const numbers = count(inDeck('#' + tag.key));
      if (numbers.count) out.push({ deck: '#' + tag.key, tag, depth: 0, name: '#' + tag.name, ...numbers });
    }
    return out;
  }

  /* "Today: 34 cards · Biology 12 · Spanish 22": the cards due, and the folders they're in. */
  function todayLine(at = now()) {
    const due = at.list.filter((c) => isDue(c, at));
    if (!due.length) return null;
    const by = new Map();
    for (const card of due) {
      const folder = liveFolder(card.folder);
      const name = folder ? folder.name : 'No folder';
      by.set(name, (by.get(name) || 0) + 1);
    }
    const parts = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = parts.slice(0, parts.length > 4 ? 3 : 4).map(([name, n]) => `${name} ${n}`);
    if (parts.length > shown.length) shown.push(`${parts.length - shown.length} more`);
    return { count: due.length, parts: shown };
  }

  /* "Bio test in 3 days · 42 cards left · ~14 a day" (`named`: false leaves the test's name out). */
  function countdown(plan, named = true) {
    const when = inDays(plan.days);
    const head = named ? `${plan.name} ${when}` : when[0].toUpperCase() + when.slice(1);
    if (plan.days === 0) return `${head} · good luck!`;
    if (!plan.count) return `${head} · no flash cards in it yet`;
    if (!plan.left) return `${head} · all ${plan.count} cards gone over`;
    return `${head} · ${plan.left} card${plan.left === 1 ? '' : 's'} left · ${plan.days === 1 ? 'all today' : `~${plan.perDay} a day`}`;
  }

  function badge(row) {
    if (row.folder) return V.notes.folderBadge(row.folder, true) || V.h('span.dot-box', {}, V.icon('folder'));
    if (row.tag) return V.h('span.dot-box', {}, V.icon('hash'));
    return V.h('span.dot-box', {}, V.icon('notes'));
  }

  function deckRow(row) {
    const what = `${row.count} card${row.count === 1 ? '' : 's'}${row.due ? '' : ' · none due today'}`;
    return V.h('div.deck-row' + (row.due ? '' : '.idle'), { dataset: { deck: row.deck, depth: String(Math.min(row.depth, 4)) } },
      V.h('button.deck-main', { type: 'button', title: row.due ? `Review ${row.name}` : `Practise ${row.name}`,
        onclick: () => start(row.deck) },
      badge(row), V.h('span.deck-text', {}, V.h('span.deck-name', { text: row.name }), V.h('span.deck-meta', { text: what })),
      row.due ? V.h('span.deck-due', { text: String(row.due) }) : null),
      V.h('button.deck-learn', { type: 'button', title: `Learn ${row.name}`, 'aria-label': `Learn ${row.name}`,
        onclick: () => V.learn.forDeck(row.deck) }, V.icon('learn'), V.h('span', { text: 'Learn' })));
  }

  function testRow(plan) {
    return V.h('div.test-row' + (plan.days <= 1 ? '.soon' : ''), { dataset: { id: plan.note.id } },
      V.h('button.test-main', { type: 'button', title: 'Open the test note', onclick: () => R.openNote(plan.note.id) },
        V.icon('target', 'test-icon'), V.h('span.test-text', { text: countdown(plan) })),
      plan.count ? V.h('button.deck-learn', { type: 'button', title: `Review what ${plan.name} covers`,
        onclick: () => start('test:' + plan.note.id) }, V.icon('cards'), V.h('span', { text: 'Review' })) : null);
  }

  function page() {
    const at = now();
    if (!at.list.length) {
      return V.h('div.empty.review-empty', {}, V.mark(40),
        V.h('p', { text: 'No flash cards yet.' }),
        V.h('p.hint', { text: 'Write a line like "mitosis :: cell division", or "The {{mitochondria}} makes ATP", in any note: it shows up here, ready to review.' }));
    }
    const line = todayLine(at);
    const tests = at.plans;
    const rows = decks(at);
    const folders = rows.filter((r) => !r.tag);
    const tags = rows.filter((r) => r.tag);
    return [
      V.h('section.review-head', {},
        V.h('p.review-today', {}, line
          ? [V.h('strong', { text: `Today: ${line.count} card${line.count === 1 ? '' : 's'}` }),
            line.parts.map((p) => [V.h('span.sep', { text: ' · ' }), V.h('span.part', { text: p })])]
          : V.h('strong', { text: 'All done for today' })),
        line ? null : V.h('p.hint.review-later', { text: nextDue(at) }),
        V.h('div.review-go', {},
          V.button(line ? `Review ${line.count}` : 'Practise', { kind: 'primary', icon: 'cards', onClick: () => start('all') }),
          V.button('Learn', { icon: 'learn', onClick: () => V.learn.forDeck('all') }))),
      tests.length ? [V.h('h2.list-section', {}, V.h('span', { text: 'Tests coming up' }), V.h('span.count', { text: String(tests.length) })),
        tests.map(testRow)] : null,
      folders.length ? [V.h('h2.list-section', {}, V.h('span', { text: 'Folders' })), folders.map(deckRow)] : null,
      tags.length ? [V.h('h2.list-section', {}, V.h('span', { text: 'Tags' })), tags.map(deckRow)] : null,
    ];
  }

  /* When the next cards come back ("5 cards come back tomorrow"), for a day with none left. */
  function nextDue(at) {
    const days = at.list.map((c) => dueOn(c.state)).filter((d) => d && d > at.today).sort();
    if (!days.length) return 'Every card is known for now.';
    const n = days.filter((d) => d === days[0]).length;
    const label = R.dayLabel(days[0]);
    return `${n} card${n === 1 ? ' comes' : 's come'} back ${label === 'Tomorrow' ? 'tomorrow' : 'on ' + label}.`;
  }

  /* -- reviewing */

  /* A deck's cards due today, one at a time; with none due (or `practice`), all of them as a practice round. */
  function start(deck = 'all', { practice = false } = {}) {
    const at = now();
    const mine = at.list.filter(inDeck(deck));
    if (!mine.length) return V.toast('No flash cards there yet.');
    const due = practice ? [] : mine.filter((c) => isDue(c, at));
    return session({ title: deck === 'all' ? 'Review' : `Review: ${deckName(deck)}`, list: due.length ? due : mine,
      practice: !due.length, deck, many: new Set(mine.map((c) => c.note)).size > 1 });
  }

  /* The open note's own cards (its Study button), as they're written now. */
  function study(id) {
    const row = V.data.notes.get(id);
    if (!row) return null;
    const words = V.editor.openId() === id && V.editor.words() !== null ? V.editor.words() : row.body;
    const mine = cardsOf(row, words);
    if (!mine.length) return null;
    const at = now();
    const due = mine.filter((c) => isDue(c, at));
    return session({ title: V.noteTitle({ ...row, body: words || '' }) + ': study', list: due.length ? due : mine,
      practice: !due.length, deck: 'note:' + id, many: false });
  }

  /* The cards to go through first: the longest waiting, then new ones in the order they're written. */
  function order(list) {
    const due = (c) => dueOn(current(c)) || '9999';
    return [...list].sort((a, b) => due(a).localeCompare(due(b)) || (a.note === b.note ? a.line - b.line : a.note.localeCompare(b.note)));
  }

  function shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /* A card's question as page elements: a blank's gap drawn as a line. */
  function question(card) {
    if (card.kind !== 'blank') return card.term;
    return [card.before, V.h('span.blank-gap', { text: V.study.GAP, 'aria-label': 'blank' }), card.after];
  }
  /* ...and its answer: a blank's word in its sentence. */
  function answerOf(card) {
    if (card.kind !== 'blank') return card.answer;
    return [card.before, V.h('mark.blank-fill', { text: card.answer }), card.after];
  }

  function session({ title, list, practice = false, deck = 'all', many = false }) {
    let queue = order(list);
    let flipped = false;
    let shuffled = false;
    let knew = 0;
    let missed = 0;
    let total = queue.length;
    const missedIds = new Set();
    const ui = {
      progress: V.h('p.study-progress', { 'aria-live': 'polite' }),
      fill: V.h('i'),
      card: V.h('button.flash-card', { type: 'button', onclick: () => flip() }),
      actions: V.h('div.study-actions'),
      shuffle: V.h('button.chip.study-shuffle', { type: 'button', 'aria-pressed': 'false', onclick: () => toggleShuffle() },
        R.icon('shuffle'), 'Shuffle'),
    };
    const knownNow = () => list.filter((c) => known(current(c))).length;
    // What's on top of a card: the note it's from (when there are several), and whether it's new.
    const from = (card) => {
      const row = V.data.notes.get(card.note);
      const kind = !memory(current(card)) ? 'New card' : isDue({ ...card, state: current(card) }) ? 'Review' : 'Practice';
      return many && row ? `${V.noteTitle(row)}${kind === 'New card' ? ' · New' : ''}` : kind;
    };
    const when = (label, words) => [V.h('span', { text: label }), V.h('small.btn-when', { text: words })];

    function draw() {
      const card = queue[0];
      const done = total - queue.length;
      ui.fill.style.width = total ? `${(100 * done) / total}%` : '0%';
      if (!card) {
        ui.progress.textContent = `${knownNow()} of ${list.length} cards known`;
        V.clear(ui.card, V.h('span.flash-side', { text: 'All done' }),
          V.h('span.flash-words.end', { text: missed ? `You knew ${knew} of ${knew + missed}. The ones you missed come back tomorrow.`
            : `You knew all ${knew}. Nice work!` }));
        ui.card.disabled = true;
        V.clear(ui.actions,
          V.button('Learn these', { icon: 'learn', onClick: () => { sheet.close(); V.learn.start({ title: `Learn: ${deckName(deck)}`, list, deck }); } }),
          V.button('Close', { kind: 'primary', onClick: () => sheet.close() }));
        return;
      }
      ui.card.disabled = false;
      ui.progress.textContent = `Card ${Math.min(done + 1, total)} of ${total} · ${knownNow()} of ${list.length} known`
        + (practice ? ' · practice round' : '');
      ui.card.classList.toggle('flipped', flipped);
      ui.card.classList.toggle('blank-card', card.kind === 'blank');
      ui.card.setAttribute('aria-label', flipped ? `Answer: ${card.answer}. Tap to see the question again`
        : `${card.kind === 'blank' ? card.term.replace(V.study.GAP, 'blank') : card.term}. Tap to see the answer`);
      V.clear(ui.card,
        V.h('span.flash-side', { text: flipped ? 'Answer' : from(card) }),
        V.h('span.flash-words' + (flipped && card.kind === 'blank' ? '.in-context' : ''), {}, flipped ? answerOf(card) : question(card)),
        V.h('span.flash-hint', {}, R.icon('flip'), flipped ? 'Tap to see the question' : 'Tap to see the answer'));
      const comes = preview(current(card));
      V.clear(ui.actions, flipped
        ? [V.h('button.btn.not-yet.two-line', { type: 'button', onclick: () => mark(false) }, when('Not yet', comes.again)),
          V.h('button.btn.primary.two-line', { type: 'button', onclick: () => mark(true) }, when('I knew it', comes.good))]
        : [V.button('Show answer', { kind: 'primary wide-btn', onClick: () => flip() })]);
    }

    function flip() {
      if (!queue.length) return;
      flipped = !flipped;
      draw();
    }

    function mark(itKnew) {
      const card = queue.shift();
      if (!card) return;
      grade(card, itKnew ? GOOD : AGAIN);
      if (itKnew) knew++;
      else if (!missedIds.has(card.id)) {
        missed++;
        missedIds.add(card.id);
        queue.push(card);  // once more before the end
        total++;
      }
      flipped = false;
      draw();
    }

    function toggleShuffle() {
      shuffled = !shuffled;
      ui.shuffle.setAttribute('aria-pressed', String(shuffled));
      ui.shuffle.classList.toggle('on', shuffled);
      queue = shuffled ? shuffle(queue) : order(queue);
      flipped = false;
      draw();
    }

    const keys = (event) => {
      if (!ui.card.isConnected || event.target.closest('input, textarea, select')) return;
      if (event.key === ' ' && event.target === ui.card) return;  // the card's own click flips it
      if ((event.key === ' ' || event.key === 'Enter') && !event.target.closest('button')) { event.preventDefault(); flip(); }
      else if (flipped && (event.key === 'ArrowRight' || event.key === 'k')) { event.preventDefault(); mark(true); }
      else if (flipped && (event.key === 'ArrowLeft' || event.key === 'n')) { event.preventDefault(); mark(false); }
    };
    document.addEventListener('keydown', keys);
    const sheet = V.sheet({
      title,
      wide: true,
      content: [
        V.h('div.study-top', {}, ui.progress, ui.shuffle),
        V.h('span.bar.study-bar', {}, ui.fill),
        ui.card,
        ui.actions,
        V.h('p.hint.study-hint', { text: 'Cards come from lines like "photosynthesis :: how plants make food" and blanks like "The {{mitochondria}} makes ATP". Each one comes back just before you\'d forget it.' }),
      ],
      onClose: () => { document.removeEventListener('keydown', keys); flush(); },
    });
    draw();
    requestAnimationFrame(() => ui.card.focus({ preventScroll: true }));
    return sheet;
  }

  return { AGAIN, GOOD, EASY, timing, memory, next, preview, known, dueOn, all, current, inDeck, deckName, coversOf,
    looksLikeTest, testName, planFor, now, isDue, dueIn, dueCount, grade, flush, decks, todayLine, countdown, page,
    start, study, session, question, answerOf, shuffle, cardsOf, pending: () => pending };
})();
