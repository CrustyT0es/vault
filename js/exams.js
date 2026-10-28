/* Vault: tests. A note with a due date ("Bio test fri 9am", which js/reminders.js understands) becomes a test once it
   says what it covers: its Test button picks folders and #tags (kept in extra.exam: { covers: [folder ids, '#tags'],
   since: the day the plan began, for: the test day it was made for }), or a line in it does ("Covers: Biology,
   #cells"). Then a countdown shows on the note, on its card (in Upcoming too), on the folders it covers and on the
   Review page: "Bio test in 3 days · 42 cards left · ~14 a day". The cram plan behind it is js/review.js's. */
'use strict';

V.exams = (() => {
  const RV = V.review;
  const R = V.reminders;
  const O = V.organise;

  const plan = (note) => (note ? RV.planFor(note, RV.now().list) : null);

  /* The Test button's sheet: what's on the test, and its day. */
  function picker(id) {
    const note = R.latest(id);
    if (!note) return;
    const exam = (note.extra && note.extra.exam) || {};
    const chosen = new Set((Array.isArray(exam.covers) ? exam.covers : []).filter((c) => typeof c === 'string'));
    const at = RV.now();
    const count = (deck) => at.list.filter(RV.inDeck(deck)).length;
    const box = (deck, label, lead, depth = 0) => {
      const n = count(deck);
      const input = V.h('input.covers-tick', { type: 'checkbox', checked: chosen.has(deck), 'aria-label': label,
        onchange: () => { if (input.checked) chosen.add(deck); else chosen.delete(deck); } });
      return V.h('label.covers-row', { dataset: { depth: String(Math.min(depth, 4)) } }, input, lead,
        V.h('span.covers-name', { text: label }), V.h('span.covers-count', { text: n ? `${n} card${n === 1 ? '' : 's'}` : '' }));
    };
    const folders = O.tree().map(({ folder, depth }) => box(folder.id, folder.name, V.notes.folderBadge(folder, true)
      || V.h('span.dot-box', {}, V.icon('folder')), depth));
    const notes = [...new Set(at.list.map((c) => c.note))].map((n) => V.data.notes.get(n)).filter(Boolean);
    const tags = O.allTags(notes).map((t) => box('#' + t.key, '#' + t.name, V.h('span.dot-box', {}, V.icon('hash'))));
    const day = V.h('input.field', { type: 'date', value: note.due || '', 'aria-label': 'Test day' });
    const error = V.h('p.error-text', { role: 'alert' });
    const fromLine = RV.coversOf({ ...note, extra: {} });  // what a "Covers:" line in the note already says
    V.sheet({
      title: 'What\'s on the test?',
      content: [
        V.h('p.hint.covers-about', { text: 'Pick the folders and tags its flash cards are in. Vault counts down to the test day and spreads the cards you haven\'t gone over across the days left, in Review.' }),
        V.h('label.label', { text: 'Test day' }, day),
        V.h('div.label', { text: 'Folders' }), V.h('div.covers-list', {}, folders),
        tags.length ? [V.h('div.label', { text: 'Tags' }), V.h('div.covers-list', {}, tags)] : null,
        fromLine.length ? V.h('p.hint.covers-line', { text: `The note's own "Covers:" line adds ${fromLine.map((c) => RV.deckName(c)).join(', ')}.` })
          : V.h('p.hint.covers-line', { text: 'You can also write a line like "Covers: Biology, #cells" in the note.' }),
        error,
      ],
      actions: [
        exam.covers ? { label: 'Not a test', kind: 'danger-quiet', onClick: () => {
          R.change(id, (row) => { delete row.extra.exam; }).catch(V.problem);
          V.toast('It\'s not a test any more.');
        } } : null,
        { label: 'Save', kind: 'primary', onClick: () => {
          if (!day.value) { error.textContent = 'Pick the test day.'; return true; }
          if (!chosen.size && !fromLine.length) { error.textContent = 'Pick at least one folder or tag.'; return true; }
          const today = V.today();
          R.change(id, (row) => {
            if (row.due !== day.value) row.done = false;
            row.due = day.value;
            const was = (row.extra.exam || {});
            const same = was.for === day.value && /^\d{4}-\d{2}-\d{2}$/.test(was.since || '');
            row.extra.exam = { covers: [...chosen], since: same ? was.since : today, for: day.value };
          }).then(() => {
            const made = plan(R.latest(id));
            V.toast(made ? RV.countdown(made) : 'Saved.');
          }).catch(V.problem);
          return false;
        } },
      ].filter(Boolean),
    });
  }

  /* -- the countdowns */

  /* On the test note itself: the countdown (a tap changes what it covers); a note that looks like a test but doesn't
     say what it covers yet asks. */
  V.editor.addMeta((note) => {
    const made = plan(note);
    if (made) {
      return V.h('button.chip.exam-chip' + (made.days <= 1 ? '.soon' : ''), { type: 'button', title: 'What\'s on the test',
        onclick: () => picker(note.id) }, V.icon('target'), V.h('span', { text: RV.countdown(made) }));
    }
    if (note.locked || note.done || !note.due || note.due < V.today() || !RV.looksLikeTest(note)) return null;
    return V.h('button.chip.exam-chip.ask', { type: 'button', onclick: () => picker(note.id) },
      V.icon('target'), V.h('span', { text: 'What\'s on the test?' }));
  });

  /* On a note's card in the lists (Upcoming too): "In 3 days · 42 cards left · ~14 a day". */
  function cardChip(note) {
    const made = plan(note);
    if (!made) return null;
    return V.h('span.exam-tag' + (made.days <= 1 ? '.soon' : ''), { title: RV.countdown(made) }, V.icon('target'),
      V.h('span', { text: RV.countdown(made, false) }));
  }

  /* On a folder a test covers (or one inside it): its countdown, with a way to review what it covers. */
  function banners(folder) {
    return RV.now().plans.filter((p) => p.folders.has(folder.id)).map((p) => V.h('div.exam-banner' + (p.days <= 1 ? '.soon' : ''),
      { dataset: { id: p.note.id } },
      V.h('button.exam-banner-main', { type: 'button', title: 'Open the test note', onclick: () => R.openNote(p.note.id) },
        V.icon('target', 'test-icon'), V.h('span', { text: RV.countdown(p) })),
      p.count ? V.button('Review', { kind: 'quiet', icon: 'cards', onClick: () => RV.start('test:' + p.note.id) }) : null));
  }

  V.editor.addTool({ name: 'test', label: 'Test', icon: () => V.icon('target'), keepCaret: false,
    onClick: () => { const id = V.editor.openId(); if (id) picker(id); },
    shown: (note, text) => !note.locked && (!!note.due || !!(note.extra && note.extra.exam)
      || RV.looksLikeTest({ ...note, body: text || '' })) });

  return { picker, cardChip, banners };
})();
