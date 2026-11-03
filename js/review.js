/* Vault: flash cards. The Flash cards page (the Notes tab's "Flash cards", beside Upcoming; "Review" before 1.18):
   how many to study today, one Study button, then the decks by folder and #tag; and the study screen, the cards
   themselves, one at a time (see "studying" below).

   When a card comes back is worked out by FSRS, the schedule Anki uses (vendor/fsrs.js, ts-fsrs 5.4.2, its own
   default parameters, whole days): "Still learning" brings a card back tomorrow (and once more before the go ends), "I
   know it" in a few days, and each time it's known again the wait grows (3 days, then about 2 weeks, then 2 months).
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
   the test are pulled forward, spread over the days left, so they come up to study too; once the test day has passed
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

  /* -- decks: everything ('all'), a folder (with the folders inside it), a folder's own cards ('own:<id>', not the
     folders inside it: Today's rows), a #tag, a note ('note:<id>'), a test ('test:<note id>': what it covers) */

  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const liveFolder = (id) => { const f = id ? V.data.folders.get(id) : null; return f && !f.deleted ? f : null; };
  const tagKey = (text) => String(text || '').replace(/^#/, '').toLowerCase().replace(/[-_.,!?;:]+$/, '');

  function inDeck(deck) {
    if (!deck || deck === 'all') return () => true;
    if (deck === 'none') return (c) => !liveFolder(c.folder);
    if (deck.startsWith('note:')) { const id = deck.slice(5); return (c) => c.note === id; }
    if (deck.startsWith('own:')) { const id = deck.slice(4); return (c) => c.folder === id; }  // its own cards only
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
    const folder = liveFolder(deck.startsWith('own:') ? deck.slice(4) : deck);
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
    // (as words: no "**" of a bold word, nor a heading's "#")
    if (V.format) name = V.format.unmark(name).replace(/^\s{0,3}#{1,6}\s+/, '').trim();
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

  /* The cards due today by the folder each one is in (its own folder, not the one above it), in one pass: Today's
     rows, which add up to the cards due. [{ deck: 'own:<id>' or 'none', folder, name, due }], most due first. */
  function dueByFolder(at = now()) {
    const by = new Map();
    for (const card of at.list) {
      if (!isDue(card, at)) continue;
      const folder = liveFolder(card.folder);
      const deck = folder ? 'own:' + folder.id : 'none';
      if (!by.has(deck)) by.set(deck, { deck, folder, name: folder ? folder.name : 'No folder', due: 0 });
      by.get(deck).due++;
    }
    return [...by.values()].sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));
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

  /* A deck: one button (its cards due today, else all of them as practice). Learn is in the study screen's ⋯. */
  function deckRow(row) {
    const what = `${row.count} card${row.count === 1 ? '' : 's'}${row.due ? '' : ' · all done today'}`;
    return V.h('div.deck-row' + (row.due ? '' : '.idle'), { dataset: { deck: row.deck, depth: String(Math.min(row.depth, 4)) } },
      V.h('button.deck-main', { type: 'button', title: row.due ? `Study ${row.name}` : `Practise ${row.name}`,
        'aria-label': row.due ? `Study ${row.name}: ${row.due} today` : `Practise ${row.name}`, onclick: () => start(row.deck) },
      badge(row), V.h('span.deck-text', {}, V.h('span.deck-name', { text: row.name }), V.h('span.deck-meta', { text: what })),
      row.due ? V.h('span.deck-due', { text: String(row.due), 'aria-hidden': 'true' }) : null,
      V.icon('chevron', 'deck-chev')));
  }

  function testRow(plan) {
    return V.h('div.test-row' + (plan.days <= 1 ? '.soon' : ''), { dataset: { id: plan.note.id } },
      V.h('button.test-main', { type: 'button', title: 'Open the test note', onclick: () => R.openNote(plan.note.id) },
        V.icon('target', 'test-icon'), V.h('span.test-text', { text: countdown(plan) })),
      plan.count ? V.h('button.deck-go', { type: 'button', title: `Study what ${plan.name} covers`,
        onclick: () => start('test:' + plan.note.id) }, V.icon('cards'), V.h('span', { text: 'Study' }))
        // (no cards in what it covers yet: js/aicards.js makes some from those notes)
        : V.aiCards ? V.h('button.deck-go.deck-make', { type: 'button', title: `Make flash cards for ${plan.name} with AI`,
          onclick: () => V.aiCards.forTest(plan.note.id) }, V.icon('spark'), V.h('span', { text: 'Make cards' })) : null);
  }

  /* "Make cards with AI" (js/aicards.js): which folder, then the cards. */
  const makeButton = () => (V.aiCards ? V.button('Make cards with AI', { kind: 'quiet', icon: 'spark',
    onClick: () => V.aiCards.pickFolder() }) : null);

  /* Notes' Flash cards page (1.18: one way in, "Study 26", and the decks under it; Learn and practice live in the study
     screen's ⋯, never beside it). */
  function page() {
    const at = now();
    if (!at.list.length) {
      return V.h('div.empty.review-empty', {}, V.mark(40),
        V.h('p', { text: 'No flash cards yet.' }),
        V.h('p.hint', { text: 'Write a line like "mitosis :: cell division", or "The {{mitochondria}} makes ATP", in any note: it shows up here, ready to study.' }),
        V.h('p.hint', { text: 'Or let AI make them from a folder of your notes.' }),
        V.h('div.review-make', {}, makeButton()));
    }
    const due = at.list.filter((c) => isDue(c, at)).length;
    const tests = at.plans;
    const rows = decks(at);
    const folders = rows.filter((r) => !r.tag);
    const tags = rows.filter((r) => r.tag);
    return [
      V.h('section.review-head', {},
        V.h('p.review-today', {}, V.h('strong', { text: due ? `${due} card${due === 1 ? '' : 's'} to study today` : 'All done for today' })),
        due ? null : V.h('p.hint.review-later', { text: nextDue(at) }),
        V.h('div.review-go', {},
          // ('tonal': the screen's main iris button is the new-note one beside it; in light it looks the same)
          V.button(due ? `Study ${due}` : `Practise all ${at.list.length}`, { kind: 'tonal', icon: 'cards', onClick: () => start('all') })),
        V.h('div.review-make', {}, makeButton())),
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

  /* -- studying (1.18; the owner: "The flashcards are chaotic too... If there could be a next feature too added
     alongside I know or still learning").

     One screen over everything (a phone's whole screen, a dialog from 700 px): the deck's name with ⋯ and Done at the
     top, "4 of 31" and a thin line under it, one card at a time, big and centred (a tap, or Space, flips it), and
     three buttons that stay put whatever the card says: Still learning, Next and I know it. Learn, practising the whole
     deck, Shuffle and how it all works are in its ⋯, never beside the card.

     Still learning is FSRS's Again (back tomorrow) and I know it is Good, as "Not yet" and "I knew it" were. Next
     grades nothing: the card is passed over and its FSRS state isn't touched. Every card goes by once ("4 of 31"); then
     the ones still being learned and the ones passed over come round once more ("Once more · 2 of 5"), in the order
     they were set aside. Next on that second look leaves the card as it was (still due, so it's there next time), so
     Next can never go round for ever. Then "Done for now": how it went and what's next. Done, Esc or Back stop at any
     card: the answers given are kept (saved in batches, as ever). */

  const SHAPES = {  // (line icons on the same 24 grid as util.js's)
    again: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4L4.5 8.8"/><path d="M4.5 4.5v4.3h4.3"/>',
    skip: '<path d="M5 12h13.5"/><path d="m13 6.5 5.5 5.5-5.5 5.5"/>',
  };
  const shape = (name) => { const span = V.icon(''); span.firstChild.innerHTML = SHAPES[name]; return span; };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const fineMouse = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  let shown = null;  // the study screen open now (one at a time)

  /* The study screen, for a mode to draw in (the cards below, or Learn: js/learn.js). Returns { el, setTitle,
     progress(text, part, aside), stage, foot, say, ended(on), use(mode), close, closed }. A mode is { name, keys(event), menu()
     -> V.menu items, leave({ closing }) }: use() hands the screen to the next one (Learn from the cards' ⋯...), so one
     screen (and one step in the phone's history, for Back) serves them all. */
  function screen(title) {
    let pushed = false;
    if (shown) { pushed = shown.pushed; shown.close({ keepStep: true }); }
    const previous = document.activeElement;
    let mode = null;
    let closed = false;
    const ui = {
      title: V.h('h2.study-title', { text: title }),
      progress: V.h('p.study-progress', { 'aria-live': 'polite' }),
      aside: V.h('span.study-aside', { hidden: true }),
      fill: V.h('i'),
      stage: V.h('div.study-stage'),
      foot: V.h('div.study-foot'),
      say: V.h('p.sr-only', { 'aria-live': 'polite' }),
    };
    ui.more = V.iconButton('more', 'More', () => openMenu(), 'study-more');
    ui.more.setAttribute('aria-haspopup', 'menu');
    ui.done = V.h('button.btn.quiet.study-done', { type: 'button', text: 'Done', title: 'Done for now', onclick: () => api.close() });
    ui.panel = V.h('div.study', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      V.h('header.study-head', {}, ui.title, ui.more, ui.done),
      V.h('div.study-where', {}, V.h('div.study-line', {}, ui.progress, ui.aside), V.h('span.bar.study-bar', {}, ui.fill)),
      ui.stage, ui.foot, ui.say);
    // (a .layer too, so what waits for sheets to close waits for it: Ctrl+N, an update's reload, picking's keys)
    ui.layer = V.h('div.layer.study-layer', {}, ui.panel);

    const items = () => (mode && mode.menu ? mode.menu().filter(Boolean) : []);
    function openMenu() {
      const list = items();
      if (!list.length) return;
      ui.more.setAttribute('aria-expanded', 'true');
      V.menu(ui.more, list, { cls: 'study-menu', label: 'More', returnFocus: true,
        onClose: () => ui.more.setAttribute('aria-expanded', 'false') });
    }
    // Something open over it (its ⋯, a sheet, a note): the keys are that one's.
    const covered = () => {
      for (let n = ui.layer.nextElementSibling; n; n = n.nextElementSibling) if (!n.matches('.nt-strip')) return true;
      return false;
    };
    const keys = (event) => {
      if (closed || covered()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); api.close(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (mode && mode.keys) mode.keys(event);
    };
    const api = {
      el: ui.panel,
      get pushed() { return pushed; },
      closed: () => closed,
      setTitle(text) { ui.title.textContent = text; ui.panel.setAttribute('aria-label', text); },
      /* Where you are ("4 of 31", and a word beside it), and the line under it filled to `part` (0 to 1). */
      progress(text, part = 0, aside = '') {
        ui.progress.textContent = text;
        ui.aside.textContent = aside;
        ui.aside.hidden = !aside;
        ui.fill.style.width = `${Math.round(Math.max(0, Math.min(1, part)) * 1000) / 10}%`;
      },
      stage: ui.stage,
      foot: ui.foot,
      /* Words for a screen reader, said once (the flipped card's answer). */
      say(text) { ui.say.textContent = ''; setTimeout(() => { ui.say.textContent = text; }, 30); },
      /* The end of a go (or Learn's stop between sets): its own buttons only, none at the top. */
      ended(on) { ui.panel.classList.toggle('ended', !!on); },
      /* A mode takes the screen over; the one before lets go first. */
      use(next) {
        if (mode && mode.leave) mode.leave({ closing: false });
        mode = next;
        ui.panel.dataset.mode = next.name || '';
        ui.panel.classList.remove('ended');
        V.clear(ui.stage);
        V.clear(ui.foot);
        ui.more.hidden = !items().length;
      },
      /* Done, Esc, Back (`fromHistory`), or another study screen taking its place (`keepStep`: its step in the history
         is the new one's). */
      close({ fromHistory = false, keepStep = false } = {}) {
        if (closed) return;
        closed = true;
        const was = mode;
        mode = null;
        try { if (was && was.leave) was.leave({ closing: true }); } catch (error) { console.error(error); }
        document.removeEventListener('keydown', keys, true);
        if (stilled) stilled.inert = false;  // (before the focus goes back there)
        ui.layer.classList.add('leaving');
        setTimeout(() => ui.layer.remove(), 180);
        if (shown === api) shown = null;
        if (pushed && !fromHistory && !keepStep && history.state && history.state.vault === 'study') history.back();
        if (!keepStep && previous && previous.isConnected && previous.focus) previous.focus({ preventScroll: true });
        flush();
      },
    };
    // On a phone (and a Chromebook's browser) Back closes it, as it does a full-screen note (never on the PC).
    if (!pushed && !V.desktop) {
      try { history.pushState({ vault: 'study' }, ''); pushed = true; } catch (error) { /* (Done still closes it) */ }
    }
    document.addEventListener('keydown', keys, true);
    document.getElementById('layers').append(ui.layer);
    // A modal dialog: the app under it can't be reached while it shows (Tab, a switch, a screen reader's swipe never
    // land on the tabs behind it). Sheets and menus opened over it are in #layers, beside it. Only what this made inert
    // is given back.
    const app = document.getElementById('app');
    const stilled = app && !app.inert ? app : null;
    if (stilled) stilled.inert = true;
    requestAnimationFrame(() => ui.layer.classList.add('shown'));
    shown = api;
    return api;
  }

  window.addEventListener('popstate', () => {
    if (shown && !(history.state && history.state.vault === 'study')) shown.close({ fromHistory: true });
  });

  const titleFor = (deck) => (!deck || deck === 'all' ? 'Flash cards' : deckName(deck));

  /* A deck's cards due today, one at a time; with none due (or `practice`), all of them as practice. `view`: a study
     screen already open, to go on in. */
  function start(deck = 'all', { practice = false, view = null, skip = null } = {}) {
    const at = now();
    const mine = at.list.filter(inDeck(deck));
    if (!mine.length) return V.toast('No flash cards there yet.');
    // (`skip`: the cards of the go just ended, its skipped ones among them: they wait for next time)
    const due = practice ? [] : mine.filter((c) => isDue(c, at) && !(skip && skip.has(c.id)));
    return session({ title: titleFor(deck), list: due.length ? due : mine, practice: !due.length, deck,
      many: new Set(mine.map((c) => c.note)).size > 1, view, skip });
  }

  /* The open note's own cards (its Study button), as they're written now. */
  function study(id, { view = null } = {}) {
    const row = V.data.notes.get(id);
    if (!row) return null;
    const words = V.editor.openId() === id && V.editor.words() !== null ? V.editor.words() : row.body;
    const mine = cardsOf(row, words);
    if (!mine.length) return null;
    const at = now();
    const due = mine.filter((c) => isDue(c, at));
    return session({ title: V.noteTitle({ ...row, body: words || '' }), list: due.length ? due : mine,
      practice: !due.length, deck: 'note:' + id, many: false, view });
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

  /* How big a card's words are drawn: big when they're few and short, smaller when there are a lot of them. */
  function sizeOf(text) {
    const words = String(text || '');
    const longest = Math.max(0, ...words.split(/\s+/).map((w) => w.length));
    return words.length <= 22 && longest <= 12 ? 'big' : words.length > 110 ? 'long' : 'mid';
  }

  /* "How flash cards work" (the ⋯): what each button does, the keys, and how cards are made. */
  function howItWorks() {
    const line = (lead, rest) => V.h('li', {}, V.h('strong', { text: lead }), rest);
    V.sheet({
      title: 'How flash cards work',
      content: [
        V.h('ul.study-how', {},
          line('Tap the card', ' to flip it and see the answer.'),
          line('Still learning:', ' it comes round once more now, and again tomorrow.'),
          line('I know it:', ' it comes back in a few days, and a little later each time you know it.'),
          line('Next:', ' skip it for now. It comes round once more at the end; skip it again and it waits for next time.'),
          line('Done:', ' stop whenever you like. Your answers are kept.'),
          fineMouse() ? line('Keys:', ' Space flips. 1 or ← Still learning, 2 or ↓ Next, 3 or → I know it.') : null),
        V.h('p.hint.study-how-make', { text: 'Make cards in any note: a line like "mitosis :: cell division", or a blank like "The {{mitochondria}} makes ATP".' }),
      ],
      actions: [{ label: 'Got it', kind: 'primary' }],
    });
  }

  /* Cards, one at a time, on the study screen (`view`: one already open, to draw in rather than opening one). */
  function session({ title, list, practice = false, deck = 'all', many = false, view = null, skip: before = null }) {
    const scr = view && !view.closed() ? view : screen(title);
    scr.setTitle(title);
    let shuffled = false;
    let queue = order(list);
    let round = 1;                 // 1: every card once; 2: once more, the ones set aside
    let roundSize = queue.length;
    let aside = [];                // set aside in the first round (Still learning, or Next): they come round once more
    let flipped = false;
    let over = false;
    const first = new Map();       // card id -> its first answer (AGAIN or GOOD)
    const passed = new Set();      // card ids passed over with Next and not answered since
    const fine = fineMouse();
    const card = V.h('button.flash-card', { type: 'button', onclick: () => flip() });
    const button = (cls, icon, label, key, kind) => V.h('button.btn.study-btn.' + cls, {
      type: 'button', dataset: { answer: kind }, 'aria-keyshortcuts': key, onclick: () => answer(kind),
    }, icon, V.h('span.study-btn-label', { text: label }), V.h('kbd.study-key', { text: key, 'aria-hidden': 'true' }));
    const buttons = {
      still: button('still', shape('again'), 'Still learning', '1', 'still'),
      next: button('skip', shape('skip'), 'Next', '2', 'next'),
      know: button('know.primary', V.icon('check'), 'I know it', '3', 'know'),
    };
    const actions = V.h('div.study-actions', { role: 'group', 'aria-label': 'Your answer' }, buttons.still, buttons.next, buttons.know);

    function drawCard(c) {
      const row = V.data.notes.get(c.note);
      const shownWords = flipped ? (c.kind === 'blank' ? c.term.replace(V.study.GAP, c.answer) : c.answer) : c.term;
      card.dataset.size = sizeOf(shownWords);
      card.classList.toggle('flipped', flipped);
      card.classList.toggle('blank-card', c.kind === 'blank');
      card.setAttribute('aria-label', flipped ? `Answer: ${c.answer}. Tap to see the question again`
        : `${c.kind === 'blank' ? c.term.replace(V.study.GAP, 'blank') : c.term}. Tap to see the answer`);
      V.clear(card,
        V.h('span.flash-side', { text: flipped ? 'Answer' : many && row ? V.noteTitle(row) : '' }),
        V.h('span.flash-face', {},
          // (reading text: Quick read's pieces go in when it's on, js/reading.js)
          flipped && c.kind !== 'blank' ? V.reading.area(V.h('span.flash-q', { text: c.term })) : null,
          V.reading.area(V.h('span.flash-words' + (flipped && c.kind === 'blank' ? '.in-context' : ''), {},
            flipped ? answerOf(c) : question(c)))),
        V.h('span.flash-hint', {}, R.icon('flip'), flipped ? 'Tap to see the question' : fine ? 'Click or press Space to flip' : 'Tap to flip'));
    }

    // A new card, or the other side: its words come in softly (the card itself never moves; nothing with reduced motion).
    const turn = () => { card.classList.remove('turned'); void card.offsetWidth; card.classList.add('turned'); };

    function draw() {
      const c = queue[0];
      if (!c) { end(); return; }
      const at = roundSize - queue.length + 1;
      scr.progress(`${round === 2 ? 'Once more · ' : practice ? 'Practice · ' : ''}${at} of ${roundSize}`, (at - 1) / roundSize);
      drawCard(c);
      const comes = preview(current(c));
      buttons.still.title = `Still learning: it comes back ${comes.again}`;
      buttons.know.title = `I know it: it comes back ${comes.good}`;
      buttons.next.title = round === 1 ? 'Next: skip it for now, it comes round again at the end' : 'Next: leave it for next time';
    }

    function flip() {
      if (over || !queue.length) return;
      flipped = !flipped;
      drawCard(queue[0]);
      turn();
      if (flipped) scr.say(`Answer: ${queue[0].answer}`);
    }

    function answer(kind) {
      if (over) return;
      const c = queue.shift();
      if (!c) return;
      if (kind === 'next') {
        if (!first.has(c.id)) passed.add(c.id);
        if (round === 1) aside.push(c);
      } else {
        const rating = kind === 'know' ? GOOD : AGAIN;
        grade(c, rating);
        if (!first.has(c.id)) first.set(c.id, rating);
        passed.delete(c.id);
        if (rating === AGAIN && round === 1) aside.push(c);
      }
      flipped = false;
      if (!queue.length && round === 1 && aside.length) {
        round = 2;
        queue = shuffled ? shuffle(aside) : aside;
        aside = [];
        roundSize = queue.length;
      }
      draw();
      if (!over) {
        turn();
        card.focus({ preventScroll: true });  // (so Space flips the next card, not the button just pressed)
      }
    }

    function toggleShuffle() {
      shuffled = !shuffled;
      // Shuffled on the very first card, the whole deck is; later on, the card showing stays and the rest are.
      const untouched = round === 1 && queue.length === roundSize && !flipped;
      const [top, ...rest] = queue;
      queue = untouched ? (shuffled ? shuffle(queue) : order(queue)) : top ? [top, ...(shuffled ? shuffle(rest) : order(rest))] : queue;
      flipped = false;
      draw();
      V.toast(shuffled ? 'Shuffled' : 'Back in order', { ms: 1600 });
    }

    /* What's next, in a line: the test it's for, else what else is due, else when cards come back. */
    function nextLine(at, more) {
      const test = deck && deck.startsWith('test:') ? planFor(V.data.notes.get(deck.slice(5))) : null;
      if (test) return countdown(test);
      if (more) return `${plural(more, 'more card is', 'more cards are')} due today.`;
      return nextDue(at);
    }

    function end() {
      over = true;
      scr.progress('', 1);
      scr.ended(true);
      const grades = [...first.values()];
      const knew = grades.filter((r) => r === GOOD).length;
      const learning = grades.length - knew;
      const left = passed.size;
      const at = now();
      // (other cards due: never the ones skipped (here, or in the go before that led here), which wait for next time,
      // or any of this go's own)
      const skip = new Set([...(before || []), ...passed, ...list.map((c) => c.id)]);
      const more = at.list.filter((c) => isDue(c, at) && !skip.has(c.id)).length;
      const sum = !grades.length ? 'You skipped every card.'
        : knew === grades.length ? (knew === 1 ? 'You knew it. Nice work!' : `You knew all ${knew}. Nice work!`)
          : `You knew ${knew} of ${grades.length}.`;
      const lines = [];
      if (learning) lines.push(learning === 1 ? 'The one you\'re still learning comes back tomorrow.' : `The ${learning} you're still learning come back tomorrow.`);
      if (left) lines.push(left === 1 ? 'The one you skipped waits for next time.' : `The ${left} you skipped wait for next time.`);
      if (!lines.length) lines.push(nextLine(at, more));
      const go = [];
      if (more) go.push(V.button(`Study ${more} more`, { icon: 'cards', onClick: () => start('all', { view: scr, skip }) }));
      else if (list.length > 1 && V.learn) go.push(V.button('Quiz me on these', { icon: 'learn', onClick: () => V.learn.start({ title, list, deck, view: scr }) }));
      const done = V.button('Done', { kind: 'primary', onClick: () => scr.close() });
      go.push(done);
      V.clear(scr.stage, V.h('div.study-end', { role: 'status' },
        V.h('span.study-end-mark', {}, V.icon('check')),
        V.h('h3', { text: 'Done for now' }),
        V.h('p.study-end-sum', { text: sum }),
        lines.map((text) => V.h('p.study-end-next', { text }))));
      V.clear(scr.foot, V.h('div.study-end-go' + (go.length === 1 ? '.one' : ''), {}, go));
      requestAnimationFrame(() => { if (done.isConnected) done.focus({ preventScroll: true }); });
    }

    const keys = (event) => {
      if (over) return;
      const key = event.key;
      const on = event.target && event.target.closest ? event.target : document.body;
      if (on.closest('input, textarea, select, [contenteditable]')) return;
      if (on === card && (key === ' ' || key === 'Enter')) return;  // (the card's own click flips it)
      if (key === ' ' || key === 'ArrowUp') {
        if (key === ' ' && on.closest('button')) return;  // (a button the keyboard is on: Space presses it)
        event.preventDefault();
        flip();
      } else if (key === '1' || key === 'ArrowLeft') { event.preventDefault(); answer('still'); }
      else if (key === '2' || key === 'ArrowDown') { event.preventDefault(); answer('next'); }
      else if (key === '3' || key === 'ArrowRight') { event.preventDefault(); answer('know'); }
    };

    const menu = () => {
      const whole = now().list.filter(inDeck(deck));
      return [
        V.learn ? { label: 'Learn: quiz me', icon: 'learn', onClick: () => V.learn.start({ title, list, deck, view: scr }) } : null,
        !practice && whole.length > list.length ? { label: `Practise all ${whole.length} cards`, icon: 'cards',
          onClick: () => session({ title, list: whole, practice: true, deck, many: new Set(whole.map((c) => c.note)).size > 1, view: scr }) } : null,
        { node: (done) => V.h('button.menu-item.menu-switch', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(shuffled),
          onclick: () => { done(); toggleShuffle(); } }, R.icon('shuffle'), V.h('span', { text: 'Shuffle' }),
        V.h('span.menu-state', { text: shuffled ? 'On' : 'Off' })) },
        { label: 'How flash cards work', icon: 'info', onClick: () => howItWorks() },
      ];
    };

    scr.use({
      name: 'cards',
      keys,
      menu,
      leave: ({ closing }) => {
        if (closing && !over && first.size && queue.length) V.toast('Saved. The rest wait for next time.');
      },
    });
    scr.stage.append(card);
    scr.foot.append(actions);
    draw();
    requestAnimationFrame(() => { if (card.isConnected) card.focus({ preventScroll: true }); });
    return scr;
  }

  return { AGAIN, GOOD, EASY, timing, memory, next, preview, known, dueOn, all, current, inDeck, deckName, coversOf,
    looksLikeTest, testName, planFor, now, isDue, dueIn, dueCount, grade, flush, decks, todayLine, countdown, page,
    dueByFolder, nextDue,
    start, study, session, screen, question, answerOf, shuffle, cardsOf, pending: () => pending, shown: () => shown };
})();
