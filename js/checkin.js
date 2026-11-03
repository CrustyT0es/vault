/* Wefty 1.19: after a test, Today asks once how it went. The owner: the study loop (record a class or snap a page,
   AI notes, AI flash cards, a plan until the test) is the star, and a first test that went well should feel like a win.

   The day after a test (a note with a day that's a test: js/review.js's plan, or one that looks like one, "Bio test
   thu"), Today has a small card: "How did the Bio test go?" with 😀 Good, 😐 Okay and 😬 Rough. The answer is kept on
   the test note (extra.checkin: { day, mood, at }), the note is ticked done (the test is behind you; never a
   repeating one), and the card says something kind and specific from what was studied for it ("You studied 31 cards
   over 4 days."), with "Make cards for the next unit" (js/aicards.js) when there's something to make them from: a
   test coming up with no flash cards yet, or new notes in the folders it covered. Done, or leaving Today, closes it.

   Never twice: it asks on the first day it's seen (kept as extra.checkin.asked, so the phone and the PC ask on the
   same day, never one after the other), only within ASK_DAYS of the test, one test at a time, and an X ("Not this
   one") or an answer ends it for good on every device. Locked notes are never asked about. These writes are quiet
   (js/cloud.js's QUIET_KEYS): a check-in isn't an edit, so the note keeps its place in the lists. */
'use strict';

V.checkin = (() => {
  const ASK_DAYS = 4;  // days after the test it may still be asked about (on the first of them it's seen)
  const MOODS = [['good', '😀', 'Good'], ['okay', '😐', 'Okay'], ['rough', '😬', 'Rough']];
  const TEST_END = /\b(?:tests?|exams?|quiz(?:zes)?|finals?|midterms?|mocks?)$/i;
  const RV = () => V.review;
  const O = () => V.organise;
  const R = () => V.reminders;
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

  let after = null;  // the answer just given, shown until Done (or Today is left): { id, mood, words, next }
  const marking = new Set();  // notes whose "asked" is on its way

  const checkinOf = (note) => {
    const c = note && note.extra && note.extra.checkin;
    return c && typeof c === 'object' && c.day === note.due ? c : null;
  };
  /* A test: a note with a day that says what it covers, or looks like one ("Bio test fri"). */
  function isTest(note) {
    const exam = note.extra && note.extra.exam;
    return !!((exam && Array.isArray(exam.covers) && exam.covers.length) || RV().coversOf(note).length || RV().looksLikeTest(note));
  }

  /* The test to ask about today, or null: the newest one whose day was 1 to ASK_DAYS days ago, not answered or let go,
     and not asked about on an earlier day. */
  function due(today = V.today()) {
    const from = V.addDays(today, -ASK_DAYS);
    const notes = [...V.data.notes.values()].filter((n) => n && !n.deleted && !n._purge && !n.locked && isDay(n.due)
      && n.due < today && n.due >= from && !O().isTemplate(n) && !O().isArchived(n) && isTest(n));
    const open = notes.filter((n) => {
      const c = checkinOf(n);
      return !c || (!c.mood && (!c.asked || c.asked === today));
    });
    return open.sort((a, b) => b.due.localeCompare(a.due) || V.noteTitle(a).localeCompare(V.noteTitle(b)))[0] || null;
  }

  /* A test note changed quietly (through the editor when it's open there). */
  function put(id, change) {
    if (V.editor.openId() === id && V.editor.current()) {
      return V.editor.update((row) => { row.extra = { ...(row.extra || {}) }; change(row); }, { quiet: true });
    }
    const row = V.data.notes.get(id);
    if (!row || row._purge || row.deleted) return Promise.resolve();
    const copy = { ...row, extra: { ...(row.extra || {}) } };
    change(copy);
    return V.cloud.save('notes', copy, { quiet: true });
  }

  /* The first day it's shown: kept, so no other day (or device) asks again. */
  function markAsked(note, today) {
    if (marking.has(note.id)) return;
    marking.add(note.id);
    setTimeout(() => {
      put(note.id, (row) => {
        const was = checkinOf(row);
        if (was && (was.mood || was.asked)) return;
        row.extra.checkin = { day: row.due, asked: today };
      }).catch((error) => console.warn('Wefty: the check-in:', error)).finally(() => marking.delete(note.id));
    }, 0);
  }

  /* What was studied for it: { cards (cards it covers gone over since its plan began), days (days studied for it) }. */
  function studiedFor(note) {
    const exam = (note.extra && note.extra.exam) || {};
    let since = isDay(exam.since) ? exam.since : '';
    if (!since && note.created_at) since = V.dateText(new Date(note.created_at));
    if (!isDay(since) || since > note.due) since = V.addDays(note.due, -28);
    let cards = 0;
    const lastDays = new Set();
    try {
      const plan = RV().planFor({ ...note, done: false }, null, note.due);
      if (plan) {
        for (const card of RV().all()) {
          if (!plan.covers(card)) continue;
          const m = RV().memory(card.state);
          if (m && m.last >= since && m.last <= note.due) { cards++; lastDays.add(m.last); }
        }
      }
    } catch (error) { console.error('Wefty: the check-in:', error); }
    const logged = V.streak ? V.streak.daysFor(note.id, since, note.due) : new Set();
    return { cards, days: Math.max(logged.size, cards ? lastDays.size : 0) };
  }

  /* Something kind, and specific when it can be. */
  function kindWords(mood, { cards, days }) {
    const did = cards ? `You studied ${plural(cards, 'card')} ${days > 1 ? `over ${days} days` : 'for it'}.` : '';
    if (mood === 'good') return did ? `Nice work! ${did}` : 'Nice work! Enjoy that feeling.';
    if (mood === 'okay') return did ? `That's okay. ${did} That still counts.` : 'That\'s okay. One test is just one test.';
    return did ? `Tests can be rough. ${did} That work stays with you.`
      : 'Tests can be rough. Next time Wefty can spread your flash cards over the days before it.';
  }

  /* "Make cards for the next unit", when there's something to make them from: a test coming up with no flash cards
     yet, else new notes (written on or after the test day, with no cards of their own) in a folder it covered. */
  function nextUnit(note) {
    if (!V.aiCards) return null;
    try {
      const next = RV().now().plans.find((p) => p.note.id !== note.id && !p.count);
      if (next) return { label: 'Make cards for the next unit', title: `Make flash cards for ${next.name}`, run: () => V.aiCards.forTest(next.note.id) };
      for (const folderId of RV().coversOf(note).filter((c) => !c.startsWith('#'))) {
        const ids = new Set([folderId, ...O().inside(folderId)]);
        const fresh = [...V.data.notes.values()].some((n) => n && n.id !== note.id && ids.has(n.folder_id) && !n.deleted
          && !n._purge && !n.locked && !O().isTemplate(n) && !O().isArchived(n) && !(n.extra && n.extra.ai_cards)
          && String(n.body || '').trim().length >= 40 && !V.study.cards(n.body).length
          && V.dateText(new Date(V.editedAt(n) || 0)) >= note.due);
        if (fresh) return { label: 'Make cards for the next unit', title: 'Make flash cards from the new notes', run: () => V.aiCards.forFolder(folderId) };
      }
    } catch (error) { console.error('Wefty: the check-in:', error); }
    return null;
  }

  async function answer(note, mood) {
    const words = kindWords(mood, studiedFor(note));
    after = { id: note.id, mood, words, next: nextUnit(note), name: RV().testName(note) };
    const repeats = !!(R() && R().repeatOf && R().repeatOf(note));
    try {
      await put(note.id, (row) => {
        row.extra.checkin = { day: row.due, mood, at: new Date().toISOString(), asked: (checkinOf(row) || {}).asked || V.today() };
        if (!repeats) row.done = true;
      });
    } catch (error) {
      V.problem(error);
    }
    if (V.today.redraw) V.today.redraw();
  }

  async function letGo(note) {
    after = null;
    try {
      await put(note.id, (row) => {
        row.extra.checkin = { day: row.due, mood: 'skip', at: new Date().toISOString(), asked: (checkinOf(row) || {}).asked || V.today() };
      });
    } catch (error) {
      V.problem(error);
    }
    if (V.today.redraw) V.today.redraw();
  }

  function moodButton(note, [mood, face, label]) {
    return V.h('button.checkin-mood', { type: 'button', dataset: { mood, key: `ci:${mood}` }, onclick: () => answer(note, mood) },
      V.h('span.checkin-face', { text: face, 'aria-hidden': 'true' }), V.h('span.checkin-word', { text: label }));
  }

  /* Today's card: the question, or what was said after the answer. */
  function card() {
    if (after) {
      const note = V.data.notes.get(after.id);
      if (!note || note.deleted) { after = null; return null; }
      const shown = after;
      const face = (MOODS.find((m) => m[0] === shown.mood) || MOODS[0])[1];
      const done = V.button('Done', { kind: shown.next ? 'quiet' : '', key: 'ci:done', onClick: () => { after = null; if (V.today.redraw) V.today.redraw(); } });
      return V.h('section.today-sec.today-checkin-sec', { dataset: { section: 'checkin' } },
        V.h('div.today-box.today-checkin.answered', { dataset: { id: shown.id, mood: shown.mood }, role: 'status' },
          V.h('div.checkin-top', {}, V.h('span.checkin-big', { text: face, 'aria-hidden': 'true' }),
            V.h('p.checkin-said', { text: shown.words })),
          V.h('div.checkin-go', {}, shown.next ? V.button(shown.next.label, { kind: 'tonal', icon: 'spark', title: shown.next.title, key: 'ci:next',
            onClick: () => { after = null; shown.next.run(); if (V.today.redraw) V.today.redraw(); } }) : null, done)));
    }
    // (after this page's first sync: what another device answered is known by then)
    if (!V.streak || !V.streak.synced()) return null;
    const today = V.today();
    const note = due(today);
    if (!note) return null;
    const asked = checkinOf(note);
    if (!asked || !asked.asked) markAsked(note, today);
    const name = RV().testName(note);
    const when = V.parseDate(note.due).toLocaleDateString([], { weekday: 'long' });
    // "How did the Bio test go?"; a name that doesn't end in what it is ("Study for history on") is quoted instead
    const question = TEST_END.test(name) ? `How did the ${name} go?` : `How did “${name}” go?`;
    return V.h('section.today-sec.today-checkin-sec', { dataset: { section: 'checkin' } },
      V.h('div.today-box.today-checkin', { dataset: { id: note.id } },
        V.h('div.checkin-head', {},
          V.h('div.checkin-text', {}, V.h('h2', { text: question }),
            V.h('p', { text: `It was ${V.addDays(today, -1) === note.due ? 'yesterday' : `on ${when}`}.` })),
          V.iconButton('x', 'Not this one', () => letGo(note), 'checkin-x', 'ci:x')),
        V.h('div.checkin-moods', { role: 'group', 'aria-label': question }, MOODS.map((m) => moodButton(note, m)))));
  }

  V.on('tab', (tab) => { if (tab !== 'today') after = null; });
  if (V.today && V.today.addSection) V.today.addSection({ id: 'checkin', order: 15, column: 'left', build: card });

  return { due, studiedFor, kindWords, nextUnit, answer, letGo, card, isTest, ASK_DAYS };
})();
