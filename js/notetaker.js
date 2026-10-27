/* Vault: the note-taker. It listens to a class, a lecture or a meeting, shows the words as they're heard, and keeps
   them in a note as they come (under a "# Transcript" heading at its end, saved every few seconds, so nothing is lost
   if the phone dies). When it stops, Claude turns the transcript into tidy notes (js/ai.js): a title, a short summary,
   key points, terms, a checklist of homework and deadlines, open questions, and flash cards if asked. They go above
   the transcript, which stays at the end so the owner can check it. "Make notes" can also be pressed later (a chip by
   the note's due date), when the network wouldn't let Claude through.

   Hearing: on the phone and the Chromebook, the browser's own speech recognition (Google's service turns the sound
   into words; Android stops it after a silence or when Vault goes to the background, so it starts again by itself
   while the owner hasn't pressed Stop). On the PC, Qt has none: Python listens with Jarvis's own Parakeet, on the PC
   itself (vault/notetaker.py, the listenStart / listenStop bridge calls, its words as "listen-text" events). The
   screen is kept on while it listens.

   A note's body can't pass 1,000,000 letters (vault/schema.sql), so a lecture longer than about seven hours carries on
   in a "(part 2)" note. Reached from the new-note sheet and as a tool in an open note. */
'use strict';

V.notetaker = (() => {
  const HEADING = /^#\s+Transcript\s*$/i;
  const TRANSCRIPT = '# Transcript';
  const TRANSCRIPT_MOST = 400000;   // letters of transcript in one note (about seven hours of talking)...
  const BODY_MOST = 950000;         // ...and never a body over this (the cloud's check is 1,000,000)
  const SAVE_AFTER = 1500;          // ms after new words, they're saved...
  const SAVE_EVERY = 5000;          // ...and at least this often while they keep coming
  const PARAGRAPH_GAP = 4000;       // a pause this long (ms) starts a new paragraph
  const PARAGRAPH_MOST = 700;       // and so does a paragraph this long
  const CARDS = 'vault-notetaker-cards';
  const FOLDER = 'vault-notetaker-folder';
  const DRAWN = {
    listen: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path d="M2.5 9v4M21.5 9v4"/>',
    spark: '<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15a2 2 0 0 0-1.2-1.2L3.5 12 9 10.2A2 2 0 0 0 10.2 9z"/>',
    pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  };
  function icon(name, cls) {
    if (!Object.prototype.hasOwnProperty.call(DRAWN, name)) return V.icon(name, cls);
    const span = V.icon('', cls);
    span.firstChild.innerHTML = DRAWN[name];  // fixed strings only
    return span;
  }

  /* -- the transcript in a note's words */

  /* { above: everything before the last "# Transcript" heading, transcript: everything after it }. */
  function split(body) {
    const lines = String(body || '').split('\n');
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (HEADING.test(lines[i])) { at = i; break; }
    if (at < 0) return { above: lines.join('\n'), transcript: '' };
    return { above: lines.slice(0, at).join('\n'), transcript: lines.slice(at + 1).join('\n').replace(/^\n+/, '').trimEnd() };
  }

  function join(above, transcript) {
    const top = String(above || '').trimEnd();
    return (top ? top + '\n\n' : '') + TRANSCRIPT + '\n' + String(transcript || '').trim();
  }

  const hash = (text) => {  // FNV-1a: telling the notes made last time from words the owner wrote since
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  };

  const wordCount = (text) => (String(text || '').match(/\S+/g) || []).length;

  /* -- how it hears */

  const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;

  /* 'pc' (Python listens), 'web' (the browser's speech recognition), or null with why not. */
  function engine() {
    if (V.desktop) {
      return V.pc && V.pc.can('listenStart') ? { kind: 'pc' }
        : { kind: null, why: 'Use your phone or Chromebook for the note-taker (this PC\'s Vault needs an update for it: open Jarvis and click Update).' };
    }
    return Recognition() ? { kind: 'web' }
      : { kind: null, why: 'This browser can\'t turn speech into words. Use Chrome on your phone or Chromebook.' };
  }

  /* The browser's speech recognition, started again whenever it stops by itself (after a silence, now and then
     anyway, or when Vault was in the background) until Stop or Pause. */
  function webHearing(on) {
    let rec = null;
    let wanted = false;
    let pending = '';      // words heard but not final yet
    let ends = [];         // when it stopped by itself lately
    let restart = null;
    let finished = null;   // resolves when it has really stopped

    function begin() {
      restart = null;
      if (!wanted || rec) return;
      if (document.hidden) { on.waiting(true); return; }
      const R = Recognition();
      rec = new R();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const words = (result[0] && result[0].transcript) || '';
          if (result.isFinal) on.final(words);
          else interim += words;
        }
        pending = interim;
        on.interim(interim);
        on.trouble(null);
      };
      rec.onaudiostart = () => on.trouble(null);
      rec.onerror = (event) => {
        const what = event.error || '';
        if (what === 'not-allowed' || what === 'service-not-allowed') {
          wanted = false;
          on.fail('Vault can\'t use the microphone. Allow it for Vault in the browser\'s site settings, then try again.');
        } else if (what === 'audio-capture') {
          wanted = false;
          on.fail('No microphone was found.');
        } else if (what === 'network') {
          on.trouble('Waiting for the internet: the speech service needs it.');
        } else if (what === 'language-not-supported') {
          wanted = false;
          on.fail('The speech service doesn\'t know this phone\'s language.');
        }  // 'no-speech' and 'aborted' just end it: it starts again
      };
      rec.onend = () => {
        rec = null;
        if (pending.trim()) on.final(pending);  // Android sometimes ends before the last words are final
        pending = '';
        on.interim('');
        if (!wanted) { if (finished) finished(); finished = null; return; }
        if (document.hidden) { on.waiting(true); return; }
        const now = Date.now();
        ends = ends.filter((t) => now - t < 10000).concat(now);
        restart = setTimeout(begin, ends.length > 4 ? 2000 : 150);  // stopping over and over: a breath first
      };
      try {
        rec.start();
        on.waiting(false);
      } catch (error) {
        rec = null;
        restart = setTimeout(begin, 1000);
      }
    }

    return {
      start() { wanted = true; ends = []; begin(); return Promise.resolve(); },
      stop() {
        wanted = false;
        clearTimeout(restart);
        restart = null;
        if (!rec) return Promise.resolve();
        return new Promise((resolve) => {
          finished = resolve;
          try { rec.stop(); } catch (error) { resolve(); }
          setTimeout(() => {  // it never said it ended: what it heard so far is kept anyway
            if (finished !== resolve) return;
            if (pending.trim()) on.final(pending);
            pending = '';
            rec = null;
            finished = null;
            resolve();
          }, 2500);
        });
      },
      back() { if (wanted && !rec && !restart) begin(); },
    };
  }

  /* Python listening on the PC: words come as "listen-text" events (to the one listening now). */
  let pcEars = null;
  V.on('pc:listen-text', ({ text }) => { if (pcEars && text) pcEars.final(text); });
  V.on('pc:listen-state', ({ state, message }) => {
    if (!pcEars) return;
    if (state === 'loading') pcEars.trouble('Getting the PC\'s speech recognition ready...');
    else if (state === 'listening') pcEars.trouble(null);
    else if (state === 'error' && message) pcEars.trouble(message);
  });

  function pcHearing(on) {
    return {
      async start() {
        pcEars = on;
        try {
          await V.pc.call('listenStart');
          on.trouble(null);
        } catch (error) {
          pcEars = null;
          on.fail(error.message || String(error));
        }
      },
      async stop(done = true) {
        try { await V.pc.call('listenStop', { done }); } catch (error) { console.warn('Vault note-taker:', error); }
        if (pcEars === on) pcEars = null;  // (its last words came before the answer)
      },
      back() {},
    };
  }

  /* -- the session: one listening, into one note */

  let session = null;   // { id, title, base, paragraphs, interim, state, ... }
  let ui = null;        // the layer and its parts
  let wake = null;      // the screen kept on

  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock && !document.hidden) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      } else if (!on && wake) {
        const held = wake;
        wake = null;
        await held.release();
      }
    } catch (error) { /* not allowed here (a battery saver): it listens all the same */ }
  }

  const text = () => [session.base, ...session.paragraphs].filter((p) => p && p.trim()).join('\n\n');

  function heard(words) {
    if (!session) return;
    const clean = String(words || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (session.aboveLength + text().length + clean.length + 2 > BODY_MOST
      || text().length + clean.length + 2 > TRANSCRIPT_MOST) carryOn();
    const now = Date.now();
    const last = session.paragraphs.length - 1;
    if (last < 0 || now - session.lastWords > PARAGRAPH_GAP || session.paragraphs[last].length > PARAGRAPH_MOST) {
      session.paragraphs.push(clean.charAt(0).toUpperCase() + clean.slice(1));
    } else {
      session.paragraphs[last] += ' ' + clean;
    }
    session.lastWords = now;
    session.words += wordCount(clean);
    session.dirty = true;
    saveSoon();
    drawWords();
  }

  const saveSoon = V.debounce(() => save().catch(V.problem), SAVE_AFTER);

  /* The transcript so far into the note (only the transcript changes: the words above it stay as they are). */
  async function save() {
    if (!session || !session.dirty) return;
    session.dirty = false;
    const row = V.data.notes.get(session.id);
    if (!row || row._purge) return;
    const { above } = split(row.body);
    const extra = { ...(row.extra || {}) };
    extra.notetaker = { ...(extra.notetaker || {}), seconds: Math.round(elapsed() / 1000), words: session.words,
      engine: session.engine };
    await V.cloud.save('notes', { ...row, body: join(above, text()), extra });
  }

  /* A very long one: this note is full, so it carries on in "<title> (part 2)" in the same folder. */
  function carryOn() {
    const row = V.data.notes.get(session.id) || {};
    session.dirty = true;
    save().catch(V.problem);
    session.part += 1;
    const title = `${session.title} (part ${session.part})`;
    const next = V.notes.blankNote({ folder_id: row.folder_id || null, title, body: join('', ''),
      extra: { notetaker: { started: new Date().toISOString(), auto_title: title, engine: session.engine, part: session.part } } });
    session.id = next.id;
    session.base = '';
    session.paragraphs = [];
    session.aboveLength = 0;
    V.cloud.save('notes', next).catch(V.problem);
    V.toast(`That's a long one: it carries on in "${title}".`, { ms: 6000 });
  }

  function elapsed() {
    if (!session) return 0;
    return session.counted + (session.runningSince ? Date.now() - session.runningSince : 0);
  }

  function setState(state) {
    if (!session) return;
    const counting = state === 'listening' && !session.waiting;
    if (session.runningSince && !counting) { session.counted += Date.now() - session.runningSince; session.runningSince = 0; }
    if (!session.runningSince && counting) session.runningSince = Date.now();
    session.state = state;
    draw();
  }

  const handlers = () => ({
    final: (words) => heard(words),
    interim: (words) => { if (session) { session.interim = words; drawWords(); } },
    trouble: (words) => { if (session && session.trouble !== words) { session.trouble = words; drawStatus(); } },
    waiting: (yes) => {
      if (!session || session.waiting === yes) return;
      session.waiting = yes;
      if (yes) session.wasAway = true;
      else {  // the note about missed words goes once it has been listening a while again
        const now = session;
        setTimeout(() => { if (session === now && !now.waiting) { now.wasAway = false; drawStatus(); } }, 20000);
      }
      setState(session.state);
    },
    fail: (words) => { if (session) stopListening({ make: false, problem: words }).catch(V.problem); },
  });

  /* A new note for the note-taker, in the folder picked. */
  async function newNote(title, folderId) {
    const auto = `Notes · ${new Date().toLocaleDateString([], { day: 'numeric', month: 'short' })} ${new Date()
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const note = V.notes.blankNote({ folder_id: folderId || null, title: title || auto, body: join('', ''),
      extra: { notetaker: { started: new Date().toISOString(), auto_title: title ? '' : auto } } });
    await V.cloud.save('notes', note);
    return note;
  }

  async function startListening({ id = null, title = '', folderId = null } = {}) {
    const how = engine();
    if (!how.kind) return;
    let note = id ? V.data.notes.get(id) : null;
    if (!note) note = await newNote(title.trim(), folderId);
    const parts = split(note.body);
    if (!note.extra || !note.extra.notetaker) {  // an older note, listened into from its tools
      const extra = { ...(note.extra || {}), notetaker: { started: new Date().toISOString(), auto_title: '' } };
      note = await V.cloud.save('notes', { ...note, extra });
    }
    session = { id: note.id, title: (note.title || '').trim() || 'Notes', base: parts.transcript, paragraphs: [],
      interim: '', state: 'starting', engine: how.kind, words: wordCount(parts.transcript), lastWords: 0,
      aboveLength: parts.above.length, part: (note.extra.notetaker && note.extra.notetaker.part) || 1,
      counted: ((note.extra.notetaker && note.extra.notetaker.seconds) || 0) * 1000, runningSince: 0, dirty: false,
      trouble: null, waiting: false, wasAway: false, problem: '' };
    session.hearing = how.kind === 'pc' ? pcHearing(handlers()) : webHearing(handlers());
    draw();
    session.saver = setInterval(() => { if (session && session.dirty) save().catch(V.problem); }, SAVE_EVERY);
    session.clock = setInterval(drawClock, 1000);
    keepAwake(true);
    await session.hearing.start();
    if (session && session.state === 'starting') setState('listening');
  }

  async function pause() {
    if (!session || session.state !== 'listening') return;
    setState('paused');
    await session.hearing.stop(false);
    saveSoon.flush();
    keepAwake(false);
  }

  async function resume() {
    if (!session || session.state !== 'paused') return;
    setState('listening');
    keepAwake(true);
    await session.hearing.start();
  }

  /* Stop: the last words are kept and saved, then (with `make`) Claude makes the notes. */
  async function stopListening({ make = true, problem = '' } = {}) {
    if (!session || session.state === 'stopping') return;
    const was = session;
    setState('stopping');
    await was.hearing.stop(true);
    clearInterval(was.saver);
    clearInterval(was.clock);
    keepAwake(false);
    was.interim = '';
    saveSoon.cancel();
    was.dirty = true;
    await save();
    const id = was.id;
    const anything = !!text().trim();
    session = null;
    if (problem) {
      showProblem(problem, id, { tryAgain: false });
      return;
    }
    if (!make || !anything) {
      closeLayer();
      if (!anything) V.toast('Nothing was heard, so there\'s nothing to make notes from.');
      openNote(id);
      return;
    }
    await makeNotes(id);
  }

  /* -- Claude: the transcript made into notes */

  function instructions(cards) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return [
      'You turn the transcript of a class, lecture or meeting into clear notes for the student who recorded it.',
      'The transcript comes from speech recognition: it has misheard words, little punctuation and no speaker names. '
        + 'Fix obvious mishearings from the context, but never add facts, numbers or names that were not said.',
      'Write in the language of the transcript. Answer with the notes only, in exactly this plain-text format (no '
        + 'other Markdown, no tables, no code blocks):',
      '',
      'TITLE: <a short title, at most 8 words>',
      '',
      '## Summary',
      '<2 to 4 sentences>',
      '',
      '## Key points',
      '- <one point a line>',
      '',
      '## Terms',
      '- **<term>**: <a short definition, as it was explained>',
      '',
      '## To do',
      '- [ ] <homework, a deadline or a task> (due Oct 31)',
      '',
      '## Questions',
      '- <what was left open, unclear, or worth asking about>',
      ...(cards ? ['', '## Flash cards', '<question> :: <answer>'] : []),
      '',
      'Leave out Terms, To do or Questions when there is nothing for them. Write each date in To do as the month\'s '
        + 'short name and the day, like "due Oct 31" or "due Nov 3 9am", never as a weekday alone. Today is ' + today + '.',
      ...(cards ? ['Make 5 to 12 flash cards from the most important ideas: one a line, the question and its short '
        + 'answer joined by " :: ".'] : []),
    ].join('\n');
  }

  /* Claude's answer as { title, notes } in Vault's own words (js/format.js): "## " headings, "- " lists, "- [ ]"
     checklists. Nothing it writes can pass for the transcript's heading. */
  function tidy(answer) {
    const lines = String(answer || '').replace(/\r/g, '').split('\n').filter((line) => !/^\s*```/.test(line));
    let title = '';
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const m = /^\s*\**\s*title\s*\**\s*:\s*\**\s*(.+?)\s*\**\s*$/i.exec(lines[i]) || (!title && /^#\s+(.+)$/.exec(lines[i]));
      if (m) { title = m[1].replace(/^["'“]+|["'”]+$/g, '').trim(); lines.splice(i, 1); break; }
      if (lines[i].trim()) break;
    }
    const notes = lines.map((line) => (HEADING.test(line) ? '## Transcript notes' : line.replace(/^#\s+(?=\S)/, '## ')))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title: title.slice(0, 120), notes };
  }

  /* The soonest homework or deadline in the notes' checklist, if a date was said: { date, at, words }. */
  function deadline(notes) {
    if (!V.reminders) return null;
    let best = null;
    for (const line of String(notes || '').split('\n')) {
      const m = /^\s*[-*]\s*\[ \]\s+(.+)$/.exec(line);
      if (!m) continue;
      const found = V.reminders.parse(m[1]);
      if (found && !found.past && (!best || found.at < best.at)) best = { ...found, words: m[1].replace(/\s*\(due[^)]*\)\s*$/i, '') };
    }
    return best;
  }

  /* The notes written into note `id` (above its transcript). Returns { cost, cut, soonest }. */
  async function write(id, cards) {
    const row = V.data.notes.get(id);
    if (!row || row._purge) throw new Error('That note isn\'t there any more.');
    if (row.locked) throw new Error('Unlock the note first.');
    const { transcript } = split(row.body);
    if (!transcript.trim()) throw new V.ai.AiError('empty', 'There\'s no transcript in this note to make notes from.');
    const answer = await V.ai.ask({ system: instructions(cards), text: transcript });
    if (answer.stopReason === 'refusal') {
      throw new V.ai.AiError('refusal', 'Claude didn\'t make notes from this one. Your transcript is saved in the note.');
    }
    const made = tidy(answer.text);
    if (!made.notes) throw new V.ai.AiError('bad', 'Claude\'s answer came back empty. Your words are saved: try again.');
    const cut = answer.stopReason === 'max_tokens';
    const notes = made.notes + (cut ? '\n\n(Cut short: Claude ran out of room. The transcript below has everything.)' : '');
    const now = V.data.notes.get(id) || row;  // (it may have changed while Claude wrote)
    const parts = split(now.body);
    const before = (now.extra && now.extra.notetaker) || {};
    let above = parts.above.trimEnd();
    if (before.notes_hash && before.notes_length && above.length >= before.notes_length
      && hash(above.slice(-before.notes_length)) === before.notes_hash) {
      above = above.slice(0, -before.notes_length).trimEnd();  // the notes made last time give way to the new ones
    }
    const body = join(above + (above ? '\n\n' : '') + notes, parts.transcript);
    const title = !(now.title || '').trim() || now.title === before.auto_title ? made.title || now.title : now.title;
    const extra = { ...(now.extra || {}), notetaker: { ...before, made: new Date().toISOString(), notes_hash: hash(notes),
      notes_length: notes.length, cards: !!cards, auto_title: title === made.title ? '' : before.auto_title || '' } };
    await V.cloud.save('notes', { ...now, title, body, extra });
    return { cost: answer.cost, cut, soonest: deadline(notes) };
  }

  async function makeNotes(id) {
    const cards = wantsCards();
    if (V.editor.openId() === id) {  // the note is open: closed while its words change, opened again after
      await V.editor.settled();
      V.editor.close();
    }
    openLayer();
    ui.making = { id, words: wordCount(split((V.data.notes.get(id) || {}).body).transcript) };
    ui.problem = null;
    draw();
    let done;
    try {
      done = await write(id, cards);
    } catch (error) {
      showProblem(error.message || String(error), id, { tryAgain: !['empty', 'refusal', 'limit', 'nokey', 'old'].includes(error.kind),
        settings: ['nokey', 'key', 'limit'].includes(error.kind) });
      return;
    }
    ui.making = null;
    closeLayer();
    openNote(id);
    V.toast(`Notes made${done.cut ? ' (cut short)' : ''}. That cost about ${V.ai.money(done.cost)}.`, { ms: 5000 });
    if (done.soonest) setTimeout(() => offerReminder(id, done.soonest), 400);
  }

  /* "Lab report · Oct 31 · Set a reminder?" above the tools, as js/reminders.js asks about a typed date. */
  function offerReminder(id, found) {
    if (V.editor.openId() !== id) return;
    const when = V.reminders.label(found);
    const done = () => V.editor.ask(null);
    const button = (words, kind, onClick) => V.h('button.ask-btn.keep-caret' + (kind ? '.' + kind : ''), { type: 'button',
      onclick: () => { done(); onClick(); } }, words);
    const due = (then) => V.reminders.change(id, (note) => { note.due = found.date; note.done = false; }).then(then).catch(V.problem);
    V.editor.ask(V.h('div.ask-card', { role: 'group', 'aria-label': `${found.words}: ${when}. Set a reminder?` },
      V.h('div.ask-top', {}, V.reminders.icon('bell', 'ask-icon'),
        V.h('span.ask-text', {}, V.h('strong', { text: `${found.words} · ${when}` }), V.h('span', { text: ' · Set a reminder?' })),
        V.h('button.ask-close.keep-caret', { type: 'button', title: 'Not now', 'aria-label': 'Not now', onclick: done }, V.icon('x'))),
      V.h('div.ask-actions', {},
        button('Remind me', 'primary', () => due(() => V.reminders.edit(id, { remind: true }))),
        button('Just a due date', '', () => due(() => V.toast(`Due ${V.reminders.dayLabel(found.date)}`))),
        button('No', '', () => {}))));
  }

  function openNote(id) {
    if (!V.data.notes.has(id)) return;
    if (V.tab() !== 'notes') V.go('notes');
    V.notes.open(id);
  }

  const wantsCards = () => { try { return localStorage.getItem(CARDS) === 'on'; } catch (e) { return false; } };
  const setCards = (on) => { try { localStorage.setItem(CARDS, on ? 'on' : 'off'); } catch (e) { /* private browsing */ } };

  /* -- the screen */

  function openLayer() {
    if (ui) return;
    const parts = {
      title: V.h('h2.nt-title', { text: 'Note-taker' }),
      time: V.h('span.nt-time.num', { hidden: true }),
      close: V.iconButton('x', 'Close', () => closePressed(), 'quiet'),
      body: V.h('div.nt-body'),
      foot: V.h('div.nt-foot'),
    };
    const panel = V.h('div.nt', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Note-taker' },
      V.h('div.nt-bar', {}, parts.close, parts.title, V.h('span.bar-spacer'), parts.time), parts.body, parts.foot);
    const layer = V.h('div.nt-layer', {}, panel);
    document.getElementById('layers').append(layer);
    requestAnimationFrame(() => layer.classList.add('shown'));
    ui = { layer, parts, ready: null, making: null, problem: null, wordsEl: null, interimEl: null, shown: 0 };
    document.addEventListener('keydown', escape, true);
  }

  // Esc closes it like any sheet (asking first while it listens), unless a sheet is open over it.
  function escape(event) {
    if (event.key !== 'Escape' || !ui || document.querySelector('#layers > .layer:not(.leaving)')) return;
    event.stopPropagation();
    closePressed();
  }

  function closeLayer() {
    if (!ui) return;
    const { layer } = ui;
    ui = null;
    document.removeEventListener('keydown', escape, true);
    layer.classList.remove('shown');
    setTimeout(() => layer.remove(), 200);
  }

  async function closePressed() {
    if (session && session.state !== 'stopping') {
      const sure = await V.confirm('Stop listening?', 'What was heard is saved in the note. You can make notes from it any time.',
        { ok: 'Stop' });
      if (sure) stopListening({ make: false }).catch(V.problem);
      return;
    }
    if (ui && ui.making && !ui.problem) return;  // Claude is writing: it lands in a moment
    const id = ui && ((ui.problem && ui.problem.id) || (ui.ready && ui.ready.id));  // (its note was closed for it)
    closeLayer();
    if (id) openNote(id);
  }

  function showProblem(words, id, { tryAgain = true, settings = false } = {}) {
    openLayer();
    ui.making = null;
    ui.problem = { words, id, tryAgain, settings };
    draw();
  }

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s % 60).padStart(2, '0');
  };

  function drawClock() {
    if (!ui) return;
    ui.parts.time.hidden = !session;
    if (session) ui.parts.time.textContent = clock(elapsed());
  }

  const hearsWith = (kind) => (kind === 'pc'
    ? 'This PC turns the talk into words itself, with Jarvis\'s speech recognition. Nothing is sent anywhere while it listens.'
    : `${V.device === 'phone' ? 'Your phone\'s' : 'The browser\'s'} speech service (Google) turns the talk into words.`);

  function folderChoice() {
    const folders = V.notes.folders();
    let saved = '';
    try { saved = localStorage.getItem(FOLDER) || ''; } catch (e) { /* private browsing */ }
    const school = folders.find((f) => f.name.toLowerCase() === 'school');
    const chosen = folders.some((f) => f.id === saved) ? saved : (school || V.notes.inbox() || {}).id || '';
    return V.h('select.field.nt-folder', { 'aria-label': 'Folder' }, folders.map((f) => V.h('option', {
      value: f.id, selected: f.id === chosen, text: `${f.icon ? f.icon + ' ' : ''}${f.name}` })));
  }

  function drawReady() {
    const { body, foot } = ui.parts;
    const ready = ui.ready;
    const note = ready.id ? V.data.notes.get(ready.id) : null;
    const how = engine();
    const hasTranscript = !!note && !!split(note.body).transcript.trim();
    const cards = V.h('input.switch', { type: 'checkbox', checked: wantsCards(), 'aria-label': 'Also make flash cards',
      onchange: (event) => setCards(event.target.checked) });
    const name = note ? null : V.h('input.field.nt-name', { type: 'text', placeholder: 'Biology class, team meeting...',
      autocomplete: 'off', maxlength: '120', 'aria-label': 'What is it?' });
    const folder = note ? null : folderChoice();
    V.clear(body, V.h('div.nt-ready', {},
      V.h('div.nt-hero', {}, icon('listen', 'nt-hero-icon')),
      V.h('h3', { text: note ? `Listen into "${V.noteTitle(note)}"` : 'Notes, written for you' }),
      V.h('p.nt-lead', { text: 'Vault writes down what\'s said in a class or meeting as it happens. When you stop, Claude turns it into tidy notes: a summary, key points, terms, homework and questions.' }),
      name ? V.h('label.label', {}, 'What is it? (optional)', name) : null,
      folder ? V.h('label.label', {}, 'Folder', folder) : null,
      V.h('label.switch-row.nt-cards', {}, V.h('span.switch-text', {}, V.h('strong', { text: 'Also make flash cards' }),
        V.h('span', { text: 'For the Study button: question :: answer.' })), cards),
      how.kind ? null : V.h('p.nt-warn', {}, V.icon('alert'), V.h('span', { text: how.why })),
      V.ai.ready() || !V.ai.state() || V.ai.state().failed ? null : V.h('p.nt-warn', {}, V.icon('alert'),
        V.h('span', { text: 'To make notes, set up the AI in Settings > AI. Listening works without it.' })),
      V.h('ul.nt-facts', {},
        how.kind ? V.h('li', { text: hearsWith(how.kind) }) : null,
        how.kind === 'web' ? V.h('li', { text: 'Keep Vault open while it listens: the screen stays on by itself.' }) : null,
        V.h('li', { text: 'Ask people before you record them.' }))));
    V.clear(foot,
      hasTranscript ? V.button('Make notes now', { icon: 'check', onClick: () => makeNotes(note.id) }) : null,
      V.button(hasTranscript ? 'Listen more' : 'Start listening', { kind: 'primary', icon: 'play', disabled: !how.kind,
        onClick: () => {
          const folderId = folder ? folder.value : null;
          if (folderId) { try { localStorage.setItem(FOLDER, folderId); } catch (e) { /* private browsing */ } }
          ui.ready = null;
          startListening({ id: note ? note.id : null, title: name ? name.value : '', folderId }).catch((error) => {
            session = null;
            V.problem(error);
            closeLayer();
          });
        } }));
    if (!V.ai.state()) V.ai.check().then(() => { if (ui && ui.ready) draw(); }).catch(() => {});
  }

  function drawStatus() {
    if (!ui || !ui.statusEl || !session) return;
    const s = session;
    const words = s.state === 'starting' ? 'Starting...' : s.state === 'paused' ? 'Paused' : s.state === 'stopping' ? 'Saving...'
      : s.waiting ? 'Waiting for Vault to be open' : 'Listening';
    ui.statusEl.dataset.state = s.state === 'listening' && !s.waiting && !s.trouble ? 'on' : s.state === 'paused' ? 'paused' : 'wait';
    ui.statusEl.querySelector('.nt-state-word').textContent = words;
    ui.statusEl.querySelector('.nt-count').textContent = s.words ? `${s.words} word${s.words === 1 ? '' : 's'}` : '';
    ui.troubleEl.hidden = !(s.trouble || s.waiting || s.wasAway);
    ui.troubleEl.querySelector('span').textContent = s.trouble
      || (s.waiting ? 'Vault stopped listening in the background. It carries on when Vault is open again: keep it open while it listens.'
        : 'Vault was in the background for a moment and missed what was said then. Keep it open while it listens.');
  }

  function drawWords() {
    if (!ui || !ui.wordsEl || !session) return;
    const box = ui.wordsEl;
    const stuck = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const list = session.paragraphs;
    while (ui.shown < list.length) {
      box.append(V.h('p.nt-para', { text: list[ui.shown] }));
      ui.shown++;
    }
    const paras = box.querySelectorAll('.nt-para');
    if (paras.length) paras[paras.length - 1].textContent = list[list.length - 1];
    if (paras.length > 1) paras[paras.length - 2].textContent = list[list.length - 2];
    ui.interimEl.textContent = session.interim ? session.interim : '';
    if (paras.length) paras[paras.length - 1].append(ui.interimEl);
    else if (session.interim) box.append(ui.interimEl);
    ui.emptyEl.hidden = !!(list.length || session.interim);
    if (stuck) box.scrollTop = box.scrollHeight;
    drawStatus();
  }

  function drawLive() {
    const { body, foot } = ui.parts;
    const s = session;
    ui.statusEl = V.h('div.nt-state', { role: 'status' }, V.h('span.nt-dot', { 'aria-hidden': 'true' }),
      V.h('span.nt-state-word'), V.h('span.nt-count.num'));
    ui.troubleEl = V.h('p.nt-warn.nt-trouble', { hidden: true }, V.icon('alert'), V.h('span'));
    ui.emptyEl = V.h('p.nt-empty', { text: s.base ? 'Carrying on the transcript in this note. New words show here as they\'re heard.'
      : 'Words show here as they\'re heard.' });
    ui.interimEl = V.h('span.nt-interim');
    ui.wordsEl = V.h('div.nt-words', { 'aria-live': 'off' }, ui.emptyEl);
    ui.shown = 0;
    V.clear(body, V.h('div.nt-live', {}, ui.statusEl, ui.troubleEl, ui.wordsEl,
      V.h('p.nt-small', { text: `${hearsWith(s.engine)}${s.engine === 'web' ? ' Keep Vault open while it listens.' : ''}` })));
    const paused = s.state === 'paused';
    V.clear(foot,
      V.button(paused ? 'Resume' : 'Pause', { icon: paused ? 'play' : null, disabled: s.state === 'starting' || s.state === 'stopping',
        onClick: () => (paused ? resume() : pause()).catch(V.problem) }),
      V.button('Stop and make notes', { kind: 'primary', icon: 'check', disabled: s.state === 'stopping',
        onClick: () => stopListening().catch(V.problem) }));
    if (paused) foot.firstChild.prepend(icon('play'));
    else foot.firstChild.prepend(icon('pause'));
    drawWords();
  }

  function drawMaking() {
    const { body, foot } = ui.parts;
    const n = ui.making.words;
    V.clear(body, V.h('div.nt-making', { role: 'status' }, V.h('div.spinner.big'),
      V.h('h3', { text: 'Writing your notes...' }),
      V.h('p.muted', { text: `Claude is reading ${n} word${n === 1 ? '' : 's'}. This takes a few seconds.` })));
    V.clear(foot);
  }

  function drawProblem() {
    const { body, foot } = ui.parts;
    const p = ui.problem;
    V.clear(body, V.h('div.nt-making.nt-problem', { role: 'alert' }, V.h('span.nt-problem-icon', {}, V.icon('alert')),
      V.h('h3', { text: 'The notes aren\'t made yet' }), V.h('p', { text: p.words })));
    V.clear(foot,
      p.settings ? V.button('Open Settings', { onClick: () => { closeLayer(); V.go('settings'); } }) : null,
      p.id ? V.button('Open the note', { onClick: () => { closeLayer(); openNote(p.id); } }) : null,
      p.tryAgain && p.id ? V.button('Try again', { kind: 'primary', icon: 'restore', onClick: () => makeNotes(p.id) }) : null);
  }

  function draw() {
    if (!ui) return;
    ui.layer.classList.toggle('listening', !!session);
    drawClock();
    ui.parts.title.textContent = session ? session.title : 'Note-taker';
    if (ui.problem) drawProblem();
    else if (ui.making) drawMaking();
    else if (session) drawLive();
    else if (ui.ready) drawReady();
  }

  /* -- coming and going */

  document.addEventListener('visibilitychange', () => {
    if (!session) return;
    if (!document.hidden) {
      if (session.state === 'listening') { keepAwake(true); session.hearing.back(); }
      drawStatus();
    }
  });
  // Signing out, or another update: what's been heard is saved first.
  window.addEventListener('pagehide', () => { if (session && session.dirty) save().catch(() => {}); });

  /* The note-taker's first screen: for a new note (from the new-note sheet), or into note `id`. */
  function open(id = null) {
    if (session) { openLayer(); draw(); return; }
    const note = id ? V.data.notes.get(id) : null;
    if (note && note.locked) return V.toast('Unlock the note first.');
    if (id && V.editor.openId() === id) {
      V.editor.settled().then(() => { V.editor.close(); show(); });
      return;
    }
    show();
    function show() {
      openLayer();
      ui.ready = { id: note ? note.id : null };
      ui.problem = null;
      ui.making = null;
      draw();
    }
  }

  /* The new-note sheet's way in (js/notes.js puts it above the templates). */
  function sheetEntry(close) {
    return V.h('button.template.nt-entry', { type: 'button', onclick: () => { close(); open(); } },
      icon('listen'), V.h('span.t-name', { text: 'Note-taker' }),
      V.h('span.t-hint', { text: 'Listens to a class or meeting and makes the notes' }));
  }

  /* In an open note: the tool, and a "Make notes" chip while its transcript has none yet. */
  V.editor.addTool({ name: 'notetaker', label: 'Note-taker', icon: () => icon('listen'), keepCaret: false,
    onClick: () => open(V.editor.openId()), shown: (note) => !note.locked });
  V.editor.addMeta((note) => {
    const nt = note && note.extra && note.extra.notetaker;
    if (!nt || nt.made || note.locked || (session && session.id === note.id) || !split(note.body).transcript.trim()) return null;
    return V.h('button.chip.nt-chip', { type: 'button', title: 'Make notes from the transcript with Claude',
      onclick: () => makeNotes(note.id) }, icon('spark'), V.h('span', { text: 'Make notes' }));
  });

  return { open, sheetEntry, makeNotes, split, join, tidy, instructions, deadline, engine, listening: () => !!session };
})();
