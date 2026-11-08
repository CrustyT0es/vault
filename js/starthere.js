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
   word in localStorage 'vault-start-here' (it hides at once, offline too) and sends it at the next sync.

   The first week (1.22, the guide: "a first-week checklist on Today: make a folder, add a note, finish a study round,
   add Wefty to the home screen"), for someone new since 1.22 only (js/welcome.js's start.week mark; never the owner or
   an account from before): a small checklist that ticks itself, each item with its one button:
     Make a folder (one of their own: not Inbox, the starter folders or their classes'),
     Write a note (words in a note that isn't the welcome note: extra.starter),
     Finish a study round (js/review.js's 'study-done', or a card's progress anywhere),
     Add Wefty to your home screen (left out in the PC app, and where Wefty runs installed, which ticks it; the item's
       button opens js/homescreen.js's card),
     Try Help (only when js/help.js is here: V.help).
   While the study loop's step shows, it's in the same card (calm: one card on a phone, where it's one chip in the
   card's top row that opens its list; beside the step when wide); once the loop is done, it's a card of its own in
   the same place, until every item
   is ticked, its X (with an Undo), or WEEK_DAYS days. Start here's own X puts both away. Ticks and the rest go in
   extra.start.week ({ since, ticks, done, closed }) through V.cloud.changeExtra; this device's word waits in
   localStorage 'wefty-first-week' until the cloud has it. */
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
  // (Google's age rule in js/ai.js's own words, the same sentence everywhere a key is made: V.ai.AGE_WORDS)
  const AI_NOTE = `Use your own personal Google account, not a school one. ${(V.ai && V.ai.AGE_WORDS) || 'Google requires the '
    + 'person making the key to be 18 or older, so a parent or guardian can make it with you.'}`;

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
    const loop = shown();
    const week = weekShown();
    if (!loop) return week ? weekCard() : null;
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
    // (1.22: on a phone, the first week is one chip in this row, opening its list: the card stays as tall as it was)
    const top = V.h('div.start-top', {},
      V.h('p.start-label', { text: 'Start here' }),
      week && !V.wide() ? weekChip() : null,
      V.iconButton('x', 'Hide Start here', close, 'start-close', 'start:close'));
    const main = [
      V.h('div.start-next', {},
        V.h('span.tile-ic.start-ic', {}, said.icon === 'record' ? V.welcome.loopIcon('record') : V.icon(said.icon)),
        V.h('div.start-text', {}, V.h('h2', { id: 'start-here-title', text: said.title }), V.h('p', { text: said.line }))),
      why,
      V.h('div.start-acts', {}, buttons(step, noKey)),
      note,
      loopRow(step),
      ai];
    // (1.22: the first week beside the step when wide)
    const side = week && V.wide();
    return V.h('section.today-sec.start-here', { 'aria-labelledby': 'start-here-title', dataset: { section: 'start', step: step.kind } },
      V.h('div.today-box.start-box' + (ai ? '.no-key' : '') + (side ? '.with-week' : ''), {}, top,
        side ? V.h('div.start-cols', {}, V.h('div.start-main', {}, main), weekSide()) : main));
  }

  /* -- the first week (1.22) */

  const WEEK_LOCAL = 'wefty-first-week';
  const WEEK_DAYS = 14;  // it goes by itself this long after the account was made, done or not
  const STARTER = ['inbox', 'school', 'work', 'personal', 'gaming'];
  let weekMemory = null;   // (this device's word where storage can't be used)
  let weekChain = Promise.resolve();
  let finished = false;    // "all done" said on this page

  const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const weekOf = () => { const w = startOf().week; return w && typeof w === 'object' ? w : null; };
  /* New since 1.22: the account's mark, or this device's welcome plan before it's sent (js/welcome.js). */
  function guided() {
    const user = me();
    if (!user) return false;
    return !!weekOf() || !!(V.welcome && V.welcome.guided && V.welcome.guided(user));
  }
  function readWeek() {
    try {
      const kept = JSON.parse(localStorage.getItem(WEEK_LOCAL) || 'null');
      return kept && kept.user === me() ? kept : null;
    } catch (error) { return weekMemory && weekMemory.user === me() ? weekMemory : null; }
  }
  function writeWeek(change) {
    const was = readWeek() || { user: me(), ticks: {} };
    // (`at` tells this word from a newer one: never the clock alone, which two changes in one moment would share)
    const next = { ...was, ...change, user: me(), at: `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
      ticks: { ...(was.ticks || {}), ...((change && change.ticks) || {}) } };
    if (change && change.reopen) { delete next.closed; }
    if (change && change.closed) { delete next.reopen; }
    weekMemory = next;
    try { localStorage.setItem(WEEK_LOCAL, JSON.stringify(next)); } catch (error) { /* memory, above */ }
    return next;
  }

  /* This device's word (ticks, done, put away or put back) sent to the account, one at a time. */
  function sendWeek() {
    weekChain = weekChain.catch(() => {}).then(async () => {
      const here = readWeek();
      if (!here || !V.cloud || !V.cloud.changeExtra) return;
      try {
        await V.cloud.changeExtra((extra) => {
          const start = { ...(extra.start || {}) };
          const was = start.week && typeof start.week === 'object' ? start.week : { since: start.since || new Date().toISOString() };
          const week = { ...was, ticks: { ...(was.ticks || {}) } };
          for (const [id, at] of Object.entries(here.ticks || {})) if (!week.ticks[id]) week.ticks[id] = at;
          if (here.done && !week.done) week.done = here.done;
          if (here.closed) week.closed = here.closed;
          if (here.reopen) delete week.closed;
          return { ...extra, start: { ...start, week } };
        });
        const now = readWeek();
        if (now && now.at === here.at) {
          weekMemory = null;
          try { localStorage.removeItem(WEEK_LOCAL); } catch (error) { /* (memory) */ }
        }
      } catch (error) { /* offline or slow: sent at the next sync */ }
    });
    return weekChain;
  }

  /* -- what it ticks by */

  // The folders Wefty made for them (the starter ones, their classes', their test's class): not "a folder of their own".
  function madeForThem() {
    const plan = startOf().plan && typeof startOf().plan === 'object' ? startOf().plan : {};
    const names = new Set(STARTER);
    for (const c of Array.isArray(plan.classes) ? plan.classes : []) if (c && c.name) names.add(squash(c.name));
    if (plan.test && plan.test.name) names.add(squash(plan.test.name));
    const own = V.welcome && V.welcome.readPlan ? V.welcome.readPlan(me()) : null;  // (this device's, before it's sent)
    for (const c of own && Array.isArray(own.classes) ? own.classes : []) if (c && c.name) names.add(squash(c.name));
    if (own && own.test && own.test.name) names.add(squash(own.test.name));
    return names;
  }
  const introOf = () => startOf().intro || (V.welcome && V.welcome.introId ? V.welcome.introId(me()) : '');
  function detected() {
    const found = [];
    const names = madeForThem();
    if ([...V.data.folders.values()].some((f) => f && !f.deleted && !names.has(squash(f.name)))) found.push('folder');
    const intro = introOf();
    let studied = false;
    let wrote = false;
    for (const note of V.data.notes.values()) {
      if (!note || note._purge) continue;
      const extra = note.extra || {};
      if (!studied && extra.cards && typeof extra.cards === 'object'
        && Object.values(extra.cards).some((s) => Array.isArray(s) || (s && typeof s === 'object' && s.last))) studied = true;
      if (!wrote && !note.deleted && note.id !== intro && !extra.starter
        && /[\p{L}\p{N}]/u.test(`${note.title || ''} ${note.body || ''}`)) wrote = true;
    }
    if (wrote) found.push('note');
    if (studied) found.push('study');
    if (!V.desktop && V.install.installed()) found.push('home');
    return found;
  }

  /* The items on this device, in order. */
  function weekItems() {
    const list = ['folder', 'note', 'study'];
    if (!V.desktop && !V.install.installed()) list.push('home');
    if (V.help && typeof V.help.open === 'function') list.push('help');
    return list;
  }

  /* Every tick: the account's, this device's, and what it finds now (sent once, later: never inside Today's draw). */
  let tickQueued = false;
  function ticks() {
    const out = { ...((weekOf() || {}).ticks || {}), ...((readWeek() || {}).ticks || {}) };
    const fresh = detected().filter((id) => !out[id]);
    const at = new Date().toISOString();
    for (const id of fresh) out[id] = at;
    if (fresh.length && !tickQueued) {
      tickQueued = true;
      setTimeout(() => { tickQueued = false; tick(...detected()); }, 0);
    }
    return out;
  }
  /* Items done (`ids`), kept here and sent; the card drawn again. */
  function tick(...ids) {
    if (!guided()) return;
    const had = { ...((weekOf() || {}).ticks || {}), ...((readWeek() || {}).ticks || {}) };
    const fresh = ids.filter((id) => id && !had[id]);
    if (!fresh.length) return;
    const at = new Date().toISOString();
    writeWeek({ ticks: Object.fromEntries(fresh.map((id) => [id, at])) });
    sendWeek();
    setTimeout(redraw, 0);
  }

  /* All done, put away with its own X (until an Undo), or with Start here's (which puts both away). */
  function weekClosed() {
    const w = weekOf() || {};
    const here = readWeek() || {};
    if (w.done || here.done) return true;
    const start = readLocal();
    const startShut = start && start.reopen ? false : !!(startOf().closed || (start && start.closed));
    if (startShut) return true;
    return here.closed ? true : here.reopen ? false : !!w.closed;
  }
  // (the first week is two weeks long at most: an account older than that never sees it again)
  function tooOld() {
    const since = Date.parse(((weekOf() || {}).since) || startOf().since || '');
    return Number.isFinite(since) && Date.now() - since > WEEK_DAYS * 86400000;
  }

  function weekShown() {
    if (!guided() || weekClosed() || tooOld()) return false;
    const all = weekItems();
    const done = ticks();
    if (all.every((id) => done[id])) {
      allDone();
      return false;
    }
    return true;
  }

  /* Every item ticked: gone for good, on every device (an item this device hasn't, the home screen in the PC app or
     Help without js/help.js, never keeps it on another). */
  function allDone() {
    if (finished) return;
    finished = true;
    writeWeek({ done: new Date().toISOString() });
    sendWeek();
    setTimeout(() => {
      V.toast('Your first week in Wefty: all done. Nice work!', { ms: 5000 });
      redraw();
    }, 0);
  }

  function closeWeek() {
    writeWeek({ closed: new Date().toISOString() });
    sendWeek();
    setTimeout(redraw, 0);
    V.toast('Your first week list is hidden.', { ms: 6000, action: 'Undo', onAction: () => {
      writeWeek({ reopen: true });
      sendWeek();
      setTimeout(redraw, 0);
    } });
  }

  /* -- what each item's button does */

  async function folderNow() {
    try {
      const made = V.organise && V.organise.newFolder ? await V.organise.newFolder() : null;
      if (made) { V.go('notes'); if (V.notes.setFilter) V.notes.setFilter(made.id); }
    } catch (error) { V.problem(error); }
  }
  function noteNow() {
    V.notes.create(V.TEMPLATES[0], {}, { fresh: true }).catch(V.problem);
  }
  function cardsDue() {
    try { return V.review ? V.review.dueCount() : 0; } catch (error) { return 0; }
  }
  function cardsAny() {
    try { return V.review ? V.review.now().list.length : 0; } catch (error) { return 0; }
  }
  function studyNow() {
    if (cardsAny()) { V.review.start('all'); return; }
    V.go('notes');
    if (V.notes.setFilter) V.notes.setFilter('review');
  }
  const homeWords = () => (['chromebook', 'browser'].includes(V.deviceKind.kind) && !V.deviceKind.ios
    ? 'Install Wefty as an app' : V.deviceKind.ios ? 'Add Wefty to your Home Screen' : 'Add Wefty to your home screen');
  function homeNow() {
    if (V.homeScreen && V.homeScreen.open) V.homeScreen.open({ from: 'week' });
    else if (V.go) V.go('settings', { page: 'devices' });
  }
  function helpNow() {
    if (V.help && V.help.open) V.help.open();
  }
  function itemOf(id) {
    if (id === 'folder') return { text: 'Make a folder', act: 'New folder', icon: 'folder', go: folderNow };
    if (id === 'note') return { text: 'Write a note', act: 'New note', icon: 'plus', go: noteNow };
    if (id === 'study') {
      const due = cardsDue();
      return { text: 'Finish a study round', act: due ? `Study ${due}` : cardsAny() ? 'Study' : 'Show me how', icon: 'cards',
        said: due ? `Study ${due} flash card${due === 1 ? '' : 's'}` : '', go: studyNow };
    }
    if (id === 'home') return { text: homeWords(), act: 'Show me how', icon: 'download', said: `${homeWords()}: show me how`, go: homeNow };
    return { text: 'Try Help', act: 'Open Help', icon: 'info', go: helpNow };
  }

  /* -- the list */

  /* The items, ticked or not, each unticked one with its button. `lead`: its first button is the screen's main one. */
  function weekList(done, lead, before = null) {
    let first = lead;
    return V.h('ul.fw-list', { 'aria-label': 'Your first week' }, weekItems().map((id) => {
      const item = itemOf(id);
      const ticked = !!done[id];
      let kind = 'quiet';
      if (!ticked && first) { kind = 'primary'; first = false; }
      return V.h('li.fw-item' + (ticked ? '.done' : ''), { dataset: { item: id, done: ticked ? 'yes' : 'no' } },
        V.h('span.fw-mark', { 'aria-hidden': 'true' }, ticked ? V.icon('check') : null),
        V.h('span.fw-text', {}, V.h('span.sr-only', { text: ticked ? 'Done: ' : 'To do: ' }), item.text),
        ticked ? null : V.h('button.btn.fw-go.' + kind, { type: 'button', dataset: { key: `fw:${id}` },
          'aria-label': item.said || `${item.text}: ${item.act}`, onclick: () => {
            if (before) before();
            try { item.go(); } catch (error) { V.problem(error); }
          } },
        V.icon(item.icon), V.h('span', { text: item.act })));
    }));
  }
  const countWords = (done) => {
    const all = weekItems();
    return `${all.filter((id) => done[id]).length} of ${all.length} done`;
  };
  function progress(done) {
    const all = weekItems();
    const share = all.length ? all.filter((id) => done[id]).length / all.length : 0;
    return V.h('div.bar.fw-bar', { 'aria-hidden': 'true' }, V.h('i', { style: { width: `${Math.round(share * 100)}%` } }));
  }

  /* Inside Start here, beside the step when wide. */
  function weekSide() {
    const done = ticks();
    return V.h('div.fw.fw-side', {},
      V.h('h3.fw-title', {}, V.h('span', { text: 'Your first week' }), V.h('span.fw-count', { text: countWords(done) })),
      progress(done), weekList(done, false));
  }

  /* Inside Start here on a phone: one chip in its top row ("First week 1/4"), opening the list in a sheet, so the
     card stays one calm card, no taller than before (Quick actions stay on the first screen). */
  function weekChip() {
    const done = ticks();
    const all = weekItems();
    const n = all.filter((id) => done[id]).length;
    return V.h('button.fw-chip', { type: 'button', 'aria-haspopup': 'dialog', dataset: { key: 'fw:chip' },
      'aria-label': `Your first week: ${n} of ${all.length} done. Show the list`, onclick: weekSheet },
    V.h('span.fw-chip-ring', { 'aria-hidden': 'true', style: { '--done': String(all.length ? n / all.length : 0) } }),
    V.h('span', { text: 'First week' }), V.h('span.fw-chip-n', { text: `${n}/${all.length}`, 'aria-hidden': 'true' }),
    V.icon('chevron', 'fw-chev'));
  }
  function weekSheet() {
    const done = ticks();
    let sheet = null;
    sheet = V.sheet({
      title: 'Your first week',
      content: V.h('div.fw.fw-in-sheet', {}, V.h('p.fw-count', { text: countWords(done) }), progress(done),
        weekList(done, true, () => { if (sheet) sheet.close(); })),
    });
  }

  /* On its own, once the study loop is done: the same place, one card. */
  function weekCard() {
    const done = ticks();
    return V.h('section.today-sec.first-week', { 'aria-labelledby': 'first-week-title', dataset: { section: 'week1' } },
      V.h('div.today-box.fw-box', {},
        V.h('div.start-top', {},
          V.h('p.start-label', { text: 'Your first week' }),
          V.iconButton('x', 'Hide your first week', closeWeek, 'start-close', 'fw:close')),
        V.h('h2.fw-head', { id: 'first-week-title', text: countWords(done) }),
        progress(done),
        weekList(done, true)));
  }

  V.on('study-done', () => tick('study'));
  V.on('home-screen', (what) => { if (what === 'installed' || what === 'added') tick('home'); });
  V.on('install', (what) => { if (what === 'done') tick('home'); });
  V.on('help', () => tick('help'));
  V.on('status', (value) => { if ((value === 'synced' || value === 'held') && readWeek()) sendWeek(); });
  // Help opened (js/help.js, however it was opened: its own entry points, #help, a card): ticked. Wrapped once every
  // script has run, as help.js may load after this file.
  const helpHash = () => { if (/^#help\b/.test(location.hash)) tick('help'); };
  window.addEventListener('hashchange', helpHash);
  document.addEventListener('DOMContentLoaded', () => {
    helpHash();
    const help = V.help;
    if (!help || typeof help.open !== 'function' || help.open.weekTicks) return;
    const real = help.open;
    const open = function open(...args) { tick('help'); return real.apply(this, args); };
    open.weekTicks = true;
    help.open = open;
  });

  return { card, shown, did, close, isNew, next, send, LOCAL,
    guided, weekShown, weekItems, ticks, tick, closeWeek, WEEK_LOCAL, WEEK_DAYS };
})();
