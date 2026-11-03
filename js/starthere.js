/* Wefty 1.19: "Start here", the first thing on a new person's Today until they've done the study loop once (the
   owner: "really sell this notes magic thing"; friends must get past day one and come back).

   One calm card, above Quick actions, with the next step and one clear button:
   - "Record your first class" (the note-taker, js/notetaker.js, opened on the test's class folder when there is one);
   - "Snap a page of notes" (Snap a page, js/capture.js's V.capture.snap, only where this Wefty has it: it leads out of
     school hours, or where recording can't work here, like an iPhone's home screen icon);
   - "Make flash cards for your Biology test" once that class has notes and the test no cards yet (js/aicards.js);
   - "Write your first notes" where neither recording nor snapping works here.
   Under it, the loop in three words (Record or snap, AI notes, Flash cards + plan) with the step it's on. Without an
   AI key yet, the loop still works where it can (a recording becomes a transcript note; cards can be typed), and the
   card offers the free Gemini's setup (V.ai.setUp) with the same 18+ and personal-account words as Settings > AI.

   Who sees it: only a new person, someone who came through the welcome (js/welcome.js): the account's mark
   (settings.extra.start.since, every device) or, before that's sent, this device's plan. Never the owner or anyone
   who used Wefty before 1.19. It goes for good, on every device, once the loop is done once (a class recorded with
   words in it, AI notes made, AI flash cards added, a page snapped: the 'study-loop' event, or a note showing it was
   done on another device) or when it's put away with its X (Undo brings it back). Both go in extra.start through
   V.cloud.changeExtra ({ since, done, how } or { since, closed }); until the cloud has them, this device keeps its own
   word in localStorage 'vault-start-here' (it hides at once, offline too) and sends it at the next sync. */
'use strict';

V.startHere = (() => {
  const LOCAL = 'vault-start-here';
  // (a note made from a snapped page: js/capture.js's extra.capture once the AI has read it, read: true; a share kept
  // as it came, from 'share' with read false or none, isn't one. 'scan' and 'snap' as plain marks, should one be used.)
  const DONE_MARKS = ['scan', 'snap'];
  const readPage = (capture) => !!(capture && typeof capture === 'object' && capture.read === true);
  let chain = Promise.resolve();
  let keysAsked = false;
  let foundDone = false;
  let memory = null;  // (this device's word where storage can't be used: this page only)

  const me = () => (V.data && V.data.user && V.data.user.id) || '';
  const startOf = () => {
    const extra = V.data.settings && V.data.settings.extra;
    const start = extra && extra.start;
    return start && typeof start === 'object' ? start : {};
  };
  function readLocal() {
    try {
      const kept = JSON.parse(localStorage.getItem(LOCAL) || 'null');
      return kept && kept.user === me() ? kept : null;
    } catch (error) { return memory && memory.user === me() ? memory : null; }
  }
  function writeLocal(value) {
    memory = value;
    try {
      if (value) localStorage.setItem(LOCAL, JSON.stringify(value));
      else localStorage.removeItem(LOCAL);
    } catch (error) { /* memory, above */ }
  }

  /* A new person: came through the welcome (the account's mark, or this device's plan not sent yet). */
  function isNew() {
    const user = me();
    if (!user) return false;
    return !!startOf().since || !!(V.welcome && V.welcome.planned && V.welcome.planned(user));
  }
  /* Done once, or put away: for good (the account), or on this device until the cloud has it. */
  function over() {
    const start = startOf();
    const here = readLocal();
    if (here && here.reopen) return false;
    if (start.done || start.closed) return true;
    return !!(here && (here.done || here.closed));
  }

  /* The loop done before (on another device, or before this page knew): a note with words the note-taker heard, notes
     it made, a study note of AI flash cards, or a page snapped. */
  function doneInNotes() {
    for (const note of V.data.notes.values()) {
      if (!note || note._purge) continue;
      const extra = note.extra || {};
      const nt = extra.notetaker;
      if (nt && nt.made) return 'notes';
      if (nt && Number(nt.words) > 0) return 'record';
      if (extra.ai_cards) return 'cards';
      if (readPage(extra.capture) || DONE_MARKS.some((key) => extra[key])) return 'snap';
    }
    return '';
  }

  function shown() {
    if (!isNew() || over()) return false;
    const how = doneInNotes();
    if (how) {
      if (!foundDone) { foundDone = true; did(how); }
      return false;
    }
    return true;
  }

  /* -- what's kept */

  /* This device's word (done or put away, or put back) sent to the account, one at a time; kept here until it's there. */
  function send() {
    chain = chain.catch(() => {}).then(async () => {
      const here = readLocal();
      if (!here || !V.cloud || !V.cloud.changeExtra) return;
      try {
        await V.cloud.changeExtra((extra) => {
          const was = { ...(extra.start || {}) };
          const next = { ...was, since: was.since || here.since || new Date().toISOString() };
          if (here.done && !was.done) { next.done = here.done; next.how = here.how || 'done'; }
          if (here.closed) next.closed = here.closed;
          if (here.reopen) delete next.closed;
          return { ...extra, start: next };
        });
        const now = readLocal();
        if (now && now.at === here.at) writeLocal(null);  // (nothing newer was said meanwhile)
      } catch (error) { /* offline or slow: sent at the next sync */ }
    });
    return chain;
  }
  const say = (fields) => {
    writeLocal({ user: me(), since: startOf().since || null, at: Date.now(), ...fields });
    setTimeout(redraw, 0);  // (never a draw inside Today's own: did() can be called while it draws)
    send();
  };

  /* The loop done once (`how`: 'record', 'notes', 'cards' or 'snap', from the event or a note showing it): gone for
     good. */
  function did(how) {
    if (!isNew() || over()) return;
    say({ done: new Date().toISOString(), how: String(how || 'done') });
  }

  /* Put away with its X, with an Undo. */
  function close() {
    say({ closed: new Date().toISOString() });
    V.toast('Start here is hidden. The note-taker is in Quick actions any time.', { ms: 6000, action: 'Undo',
      onAction: () => say({ reopen: true }) });
  }

  const redraw = () => { try { if (V.today && V.today.redraw) V.today.redraw(); } catch (error) { console.error(error); } };

  V.on('study-loop', (how) => did(how));
  V.on('status', (value) => { if ((value === 'synced' || value === 'held') && readLocal()) send(); });
  V.on('ai', () => { if (shown()) redraw(); });

  /* -- the next step */

  const snapHere = () => !!(V.capture && typeof V.capture.snap === 'function');
  function recordHere() {
    if (!V.notetaker || !V.notetaker.engine) return { ok: false, why: '' };
    try {
      const how = V.notetaker.engine();
      return { ok: !!how.kind, why: how.kind ? '' : how.why || '' };
    } catch (error) { return { ok: false, why: '' }; }
  }
  /* School hours (Monday to Friday, 7 to 4): recording leads; out of them, snapping a page does (when it's here). */
  function inSchool(now = new Date()) {
    const day = now.getDay();
    const hour = now.getHours();
    return day >= 1 && day <= 5 && hour >= 7 && hour < 16;
  }
  /* The soonest test coming up (js/review.js's plans) and its first folder. */
  function nextTest() {
    try {
      const plan = V.review.now().plans.find((p) => p.days >= 0) || null;
      if (!plan) return null;
      const id = V.review.coversOf(plan.note).find((c) => !c.startsWith('#'));
      const folder = id ? V.data.folders.get(id) : null;
      return { plan, folder: folder && !folder.deleted ? folder : null };
    } catch (error) { console.error(error); return null; }
  }
  /* Whether what the test covers has notes with words to make cards from (not the test note itself, nor another test). */
  function notesFor(plan) {
    const O = V.organise;
    for (const note of V.data.notes.values()) {
      if (!note || note.deleted || note._purge || note.locked || note.id === plan.note.id) continue;
      if (!plan.folders.has(note.folder_id)) continue;
      if (O && (O.isTemplate(note) || O.isArchived(note))) continue;
      if (note.due && V.review.coversOf(note).length) continue;
      if (String(note.body || '').trim()) return true;
    }
    return false;
  }
  function next() {
    const record = recordHere();
    const snap = snapHere();
    const test = nextTest();
    if (test && !test.plan.count && notesFor(test.plan)) return { kind: 'cards', test, record: record.ok, snap };
    if (snap && (!record.ok || !inSchool())) return { kind: 'snap', test, record: record.ok, snap };
    if (record.ok) return { kind: 'record', test, record: true, snap };
    return { kind: 'write', test, record: false, snap, why: record.why };
  }

  /* -- what a tap does */

  function recordNow(test) {
    V.notetaker.open(null, test && test.folder ? { folderId: test.folder.id } : {});
  }
  function snapNow() {
    // In the tap itself (the camera or the file picker needs it: an iPhone's Safari is strict about that). A page read
    // and saved says so itself (js/capture.js: the 'study-loop' event), as does the note it made, on any device.
    try {
      const made = V.capture.snap();
      if (made && typeof made.catch === 'function') made.catch((error) => V.problem(error));
    } catch (error) { V.problem(error); }
  }
  function writeNow(test) {
    const folder = test && test.folder;
    V.notes.create(V.TEMPLATES[0], folder ? { folder_id: folder.id } : {}, { fresh: true }).catch(V.problem);
  }
  function cardsNow(test) {
    if (V.aiCards) V.aiCards.forTest(test.plan.note.id);
  }
  function openFolder(folder) {
    V.go('notes');
    if (folder && V.notes.setFilter) V.notes.setFilter(folder.id);
  }

  /* -- the card */

  const dayWords = (day) => V.parseDate(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  // (Without a key: the free Gemini's setup, with Settings > AI's own words about whose Google account and Google's age.)
  function aiMissing() {
    if (!V.ai || !V.ai.state) return false;
    const state = V.ai.state();
    if (!state) {
      if (!keysAsked) { keysAsked = true; V.ai.recheck().catch(() => {}); }  // (its answer: the 'ai' event, drawn again)
      return false;
    }
    return !state.failed && V.ai.lacksGemini() && !V.ai.has('claude');
  }
  const AI_NOTE = 'Use your own personal Google account, not a school one. Google says you must be 18 or older to use the Gemini API.';

  /* The next step in a title and one or two short sentences (calm: what to do, and what the AI does with it). */
  function words(step, noKey) {
    const test = step.test;
    const folder = test && test.folder;
    const phone = !V.desktop && V.device === 'phone';
    if (step.kind === 'cards') {
      return { icon: 'cards', title: `Make flash cards for your ${test.plan.name}`,
        line: noKey ? 'Google\'s free Gemini makes them: set it up once. Or type your own, like "cell :: the smallest unit of life".'
          : `AI reads your ${folder ? folder.name + ' ' : ''}notes and makes the cards. Then Wefty spreads them out until `
            + `${dayWords(test.plan.day)}.` };
    }
    if (step.kind === 'snap') {
      return { icon: 'camera', title: folder ? `Snap a page of your ${folder.name} notes` : 'Snap a page of notes',
        line: 'Take a photo of a page from class, and AI turns it into notes.' };
    }
    if (step.kind === 'record') {
      return { icon: 'record', title: folder ? `Record your first ${folder.name} class` : 'Record your first class',
        line: `${phone ? 'Keep your phone near the teacher. ' : ''}Wefty writes down what's said, and AI turns it into notes.` };
    }
    return { icon: 'notes', title: folder ? `Write your first ${folder.name} notes` : 'Write your first notes',
      line: 'Type or paste your notes from class, and AI makes flash cards from them.' };
  }

  function buttons(step, noKey) {
    const test = step.test;
    const recordBtn = (kind) => V.h('button.btn.' + kind, { type: 'button', onclick: () => recordNow(test), dataset: { key: 'start:record' } },
      V.welcome.loopIcon('record'), V.h('span', { text: 'Record a class' }));
    const snapBtn = (kind) => V.button('Snap a page', { kind, icon: 'camera', onClick: snapNow, key: 'start:snap' });
    if (step.kind === 'cards') {
      if (noKey) {
        return [V.button('Set up free AI', { kind: 'primary', icon: 'spark', onClick: () => V.ai.setUp('gemini'), key: 'start:ai' }),
          test.folder ? V.button(`Open ${test.folder.name}`, { icon: 'folder', onClick: () => openFolder(test.folder), key: 'start:folder' }) : null];
      }
      return [V.button('Make flash cards', { kind: 'primary', icon: 'spark', onClick: () => cardsNow(test), key: 'start:cards' }),
        step.record ? recordBtn('quiet') : null];
    }
    if (step.kind === 'snap') return [snapBtn('primary'), step.record ? recordBtn('quiet') : null];
    if (step.kind === 'record') return [recordBtn('primary'), step.snap ? snapBtn('quiet') : null];
    return [V.button('New note', { kind: 'primary', icon: 'plus', onClick: () => writeNow(test), key: 'start:write' })];
  }

  /* The loop in three words, the step it's on lit. */
  function loopRow(step) {
    const at = step.kind === 'cards' ? 2 : 0;
    const names = ['Record or snap', 'AI notes', 'Flash cards + plan'];
    return V.h('ol.start-loop', { 'aria-label': 'How Wefty works' }, names.map((name, i) => V.h('li' + (i === at ? '.now' : ''),
      { 'aria-current': i === at ? 'step' : null }, V.h('span.start-n', { text: String(i + 1), 'aria-hidden': 'true' }),
      V.h('span', { text: name }))));
  }

  function card() {
    if (!shown()) return null;
    const step = next();
    const noKey = aiMissing();
    const said = words(step, noKey);
    const why = step.kind === 'write' && step.why ? V.h('p.hint.start-why', { text: step.why }) : null;
    // (the AI line: not on the cards step without a key, whose own words and button are about it)
    const ai = noKey && !(step.kind === 'cards') ? V.h('div.start-ai', {},
      V.h('p', {}, V.icon('spark'), V.h('span', { text: step.kind === 'write' ? 'AI flash cards use Google\'s free Gemini.'
        : 'AI notes and cards use Google\'s free Gemini. Recording works without it.' })),
      V.button('Set up free AI', { icon: 'spark', onClick: () => V.ai.setUp('gemini'), key: 'start:ai' }),
      V.h('p.hint.start-ai-note', { text: AI_NOTE })) : null;
    const note = noKey && step.kind === 'cards' ? V.h('p.hint.start-ai-note', { text: AI_NOTE }) : null;
    return V.h('section.today-sec.start-here', { 'aria-labelledby': 'start-here-title', dataset: { section: 'start', step: step.kind } },
      V.h('div.today-box.start-box' + (ai ? '.no-key' : ''), {},
        V.h('div.start-top', {},
          V.h('p.start-label', { text: 'Start here' }),
          V.iconButton('x', 'Hide Start here', close, 'start-close', 'start:close')),
        V.h('div.start-next', {},
          V.h('span.tile-ic.start-ic', {}, said.icon === 'record' ? V.welcome.loopIcon('record') : V.icon(said.icon)),
          V.h('div.start-text', {}, V.h('h2', { id: 'start-here-title', text: said.title }), V.h('p', { text: said.line }))),
        why,
        V.h('div.start-acts', {}, buttons(step, noKey)),
        note,
        loopRow(step),
        ai));
  }

  return { card, shown, did, close, isNew, next, send, LOCAL };
})();
