/* Vault: the note-taker. It listens to a class, a lecture or a meeting, shows the words as they're heard, and keeps
   them in a note as they come (under a "# Transcript" heading at its end, saved every few seconds, so nothing is lost
   if the phone dies). When it stops, the AI turns the transcript into tidy notes (js/ai.js): the free Gemini, even with
   "Use Claude too" on, unless "Write notes with Claude" is on too or there's no Gemini key but a Claude one (V.ai.brain;
   every screen names the one actually asked). A title, a short
   summary, key points, terms, a checklist of homework and deadlines, open questions, and flash cards if asked. They go
   above the transcript, which stays at the end so the owner can check it. "Make notes" can also be pressed later (a
   chip by the note's due date), when the network wouldn't let the AI through.

   Hearing: on the phone and the Chromebook, the browser's own speech recognition (Google's service turns the sound
   into words; Android stops it after a silence or when Vault goes to the background, so it starts again by itself
   while the owner hasn't pressed Stop). On the PC, Qt has none: Python listens with Jarvis's own Parakeet, on the PC
   itself (vault/notetaker.py, the listenStart / listenStop bridge calls, its words as "listen-text" events). The
   screen is kept on while it listens.

   PC sound: on the PC it can also hear what's playing there (a video, an online class, a call: vault/pcsound.py),
   alone or with the microphone, when its PC app says it can (pcSoundState); older PC apps never show the choice. With
   both, each paragraph starts "You:" (the microphone) or "Them:" (the PC). While it hears the PC, a bar says so with
   Stop, and so does the tray. A phone or Chromebook can only hear its microphone (the browser gives speech recognition
   nothing else), so there it just says to use the PC for a video or class.

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
  // The writing screen: after `time` ms it shows how long it's taking; after `slow`, that it can be closed (and
  // "Use Gemini instead" when Claude is slow and Gemini is set up). A note whose notes Claude stalled on (a paid try,
  // given up on as too slow) `rest`s that long before Vault tries it again by itself (Make notes still asks at once):
  // a stall is often Claude's own trouble, and each try can cost. (Tests shorten them.)
  const slowness = { time: 10000, slow: 30000, rest: 10 * 60 * 1000 };
  const CARDS = 'vault-notetaker-cards';
  const FOLDER = 'vault-notetaker-folder';
  const SOURCE = 'vault-notetaker-source';      // on the PC: 'mic' or 'pc' (what it listened to last)...
  const WITH_MIC = 'vault-notetaker-with-mic';  // ...and with 'pc', 'on' for the microphone too (a call)
  const CONSENT = 'vault-pcsound-ok';           // the first-time "Before you record" box was ticked away
  const CONSENT_WORDS = 'Only record people who are OK with it. Some classes and meetings need the teacher\'s or host\'s OK first.';
  const WHO = { you: 'You', them: 'Them' };     // with the microphone and the PC's sound, each paragraph says who
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
  // Chrome on Android, kept listening, hands each finished phrase over again with every phrase before it glued on (a
  // known Chrome bug), so there it hears one phrase at a time and starts again after each.
  const ANDROID = /Android/i.test(navigator.userAgent);
  // Everywhere else (a Chromebook, Chrome on a computer) it's kept listening, but one long session hears worse and
  // worse (the owner: "after about 50 words it picks up terribly"), so a session is swapped for a fresh one in a real
  // pause, once it's `age` ms old or has heard `words` words: `quiet` ms after a finished phrase with nothing more
  // heard since (Google sends words every few hundred ms while someone talks). Every word is in by then, so it's let
  // go at once (abort: no wait for Google's last answer), and the next one starts straight away. Only a session that
  // never had such a pause is ended at its next finished phrase once it's `most` ms old (a stop, which still hands
  // over what it heard; words said while the next one starts can be missed there). (Tests shorten them.)
  const rotate = { age: 20000, words: 35, quiet: 1000, most: 60000 };
  const plainWords = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /* What `text` adds after the words already kept, when it starts with them all again (else all of it). Android's
     glued-on phrases only: a phrase that really starts like the one before ("Okay." then "Okay, so...") is left whole
     everywhere else. */
  function newPart(kept, text) {
    const before = plainWords(kept);
    if (!before || !plainWords(text).startsWith(before)) return text;
    const tokens = String(text).trim().split(/\s+/);
    for (let n = 1; n <= tokens.length; n++) {
      const so = plainWords(tokens.slice(0, n).join(' '));
      if (so === before) return tokens.slice(n).join(' ');
      if (so.length > before.length) break;
    }
    return text;
  }

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
    let ends = [];         // when it stopped by itself lately, having heard nothing
    let taken = 0;         // this session's results already kept
    let kept = '';         // and their words, to spot them handed over again
    let last = '';         // the last phrase kept
    let heard = false;     // this session heard something
    let began = 0;         // when this session started
    let count = 0;         // words this session has kept
    let rotating = false;  // this session is being ended for a fresh one (never a stop: it starts again at once)
    let quiet = null;      // the pause being waited out before a fresh session (not on Android)
    let restart = null;
    let finished = null;   // resolves when it has really stopped
    const unquiet = () => { clearTimeout(quiet); quiet = null; };

    /* A session started (each one from nothing: a new one only hears what's said after it starts, so it can't hand
       the last one's words over again). */
    function begin() {
      restart = null;
      unquiet();
      if (!wanted || rec) return;
      if (document.hidden) { on.waiting(true); return; }
      const R = Recognition();
      rec = new R();
      rec.continuous = !ANDROID;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';
      taken = 0;
      kept = '';
      last = '';
      heard = false;
      began = Date.now();
      count = 0;
      rotating = false;
      const mine = rec;
      /* The pause has lasted: everything said is in, so this session goes at once for a fresh one. */
      const swap = () => {
        quiet = null;
        if (rec !== mine || !wanted || rotating || pending.trim() || document.hidden) return;
        rotating = true;
        try { mine.abort(); } catch (error) { /* it ended already: onend starts the next */ }
      };
      rec.onresult = (event) => {
        let interim = '';
        let finals = 0;
        for (let i = Math.min(event.resultIndex, taken); i < event.results.length; i++) {
          const result = event.results[i];
          let words = (result[0] && result[0].transcript) || '';
          if (!result.isFinal) { interim += words; continue; }
          if (i < taken) continue;  // already kept
          taken = i + 1;
          if (ANDROID) {
            // The words so far again, with the new ones after them: only the new ones (and never the same twice).
            words = newPart(kept, words);
            if (plainWords(words) === plainWords(last)) continue;
          }
          if (!plainWords(words)) continue;
          last = words.trim();
          kept = kept ? `${kept} ${last}` : last;
          heard = true;
          count += plainWords(words).split(' ').length;
          finals += 1;
          on.final(words);
        }
        pending = interim;
        on.interim(interim);
        on.trouble(null);
        // A long session (not on Android, which hears a phrase at a time anyway): a fresh one in a pause.
        if (ANDROID || rotating || rec !== mine || !wanted) return;
        const age = Date.now() - began;
        if (finals && age >= rotate.most) {  // never a pause in all this time: at this finished phrase, then
          unquiet();
          rotating = true;
          try { mine.stop(); } catch (error) { /* it ended already: onend starts the next */ }
        } else if (interim.trim()) {
          unquiet();  // still talking: wait for the end of it
        } else if (finals && (age >= rotate.age || count >= rotate.words)) {
          unquiet();
          quiet = setTimeout(swap, rotate.quiet);  // the pause starts now: anything more heard puts it off
        }
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
        }  // 'no-speech' (a quiet stretch, common in a hushed classroom) and 'aborted' aren't shown as errors and
           // never set wanted=false: onend starts a fresh session, so it keeps listening right through the quiet.
      };
      rec.onend = () => {
        rec = null;
        unquiet();
        // Android sometimes ends before the last words are final (but never twice over what was kept); elsewhere a
        // session that was stopped hands its unfinished words over here.
        if (pending.trim() && !(ANDROID && plainWords(kept).endsWith(plainWords(pending)))) {
          heard = true;
          last = pending.trim();
          kept = kept ? `${kept} ${last}` : last;
          on.final(pending);
        }
        pending = '';
        on.interim('');
        if (!wanted) { if (finished) finished(); finished = null; return; }
        if (document.hidden) { on.waiting(true); return; }
        if (rotating) { rotating = false; begin(); return; }  // ended for a fresh session: straight on
        const now = Date.now();
        ends = ends.filter((t) => now - t < 10000).concat(heard ? [] : [now]);
        restart = setTimeout(begin, ends.length > 4 ? 2000 : 150);  // stopping over and over, hearing nothing: a breath first
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
        unquiet();
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

  /* Python listening on the PC: words come as "listen-text" events (to the one listening now; `who` with both). */
  let pcEars = null;
  V.on('pc:listen-text', ({ text, who }) => { if (pcEars && text) pcEars.final(text, who); });
  V.on('pc:listen-state', ({ state, message }) => {
    if (!pcEars) return;
    if (state === 'loading') pcEars.trouble('Getting the PC\'s speech recognition ready...');
    else if (state === 'listening') pcEars.trouble(null);
    else if (state === 'error' && message) pcEars.trouble(message);
  });

  function pcHearing(on, source = 'mic') {
    // Each start and stop takes a number: a stop's answer that comes after a newer start (Pause, then Resume before
    // Python answered the pause) mustn't let go of the words that start is now hearing.
    let turn = 0;
    return {
      async start() {
        const mine = ++turn;
        pcEars = on;
        try {
          // (the microphone alone is asked for as always, so it's the same call an older PC app knows)
          await (source === 'mic' ? V.pc.call('listenStart') : V.pc.call('listenStart', { source }));
          on.trouble(null);
        } catch (error) {
          if (turn !== mine) return;  // (a newer start or stop has it now)
          pcEars = null;
          on.fail(error.message || String(error));
        }
      },
      async stop(done = true) {
        const mine = ++turn;
        try { await V.pc.call('listenStop', { done }); } catch (error) { console.warn('Vault note-taker:', error); }
        if (turn === mine && pcEars === on) pcEars = null;  // (its last words came before the answer)
      },
      back() {},
    };
  }

  /* -- the session: one listening, into one note */

  let session = null;   // { id, title, base, paragraphs, interim, state, ... }
  let ui = null;        // the layer and its parts
  let wake = null;      // the screen kept on
  // Notes whose notes are being written right now (-> { who: 'claude' | 'gemini' }): never two requests for one note.
  const inFlight = new Map();
  const resting = new Map();  // note id -> until when it isn't tried by itself (slowness.rest after a slow try)
  // A try that was paid for and given up on as too slow: Claude itself stalled (not the cloud, not the free Gemini).
  const stalled = (error) => !!(error && error.slow && !error.cloud && error.brain === 'claude');

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

  function heard(words, who) {
    if (!session) return;
    const clean = String(words || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (session.aboveLength + text().length + clean.length + 2 > BODY_MOST
      || text().length + clean.length + 2 > TRANSCRIPT_MOST) carryOn();
    const now = Date.now();
    const last = session.paragraphs.length - 1;
    const speaker = session.source === 'both' && WHO[who] ? who : '';  // "You:" / "Them:" when both are heard
    if (last < 0 || now - session.lastWords > PARAGRAPH_GAP || session.paragraphs[last].length > PARAGRAPH_MOST
      || speaker !== session.lastWho) {
      const start = clean.charAt(0).toUpperCase() + clean.slice(1);
      session.paragraphs.push(speaker ? `${WHO[speaker]}: ${start}` : start);
    } else {
      session.paragraphs[last] += ' ' + clean;
    }
    session.lastWho = speaker;
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
      engine: session.engine, ...(session.source !== 'mic' ? { source: session.source } : {}) };
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
    final: (words, who) => heard(words, who),
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

  async function startListening({ id = null, title = '', folderId = null, source = 'mic' } = {}) {
    const how = engine();
    if (!how.kind) return;
    if (how.kind !== 'pc' || !pcSoundKnown()) source = 'mic';  // only the PC app can hear the PC's own sound
    V.emit('notetaker-listening');  // dictation (js/dictation.js) lets go of the microphone first
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
      trouble: null, waiting: false, wasAway: false, problem: '', source, lastWho: '' };
    session.hearing = how.kind === 'pc' ? pcHearing(handlers(), source) : webHearing(handlers());
    draw();
    session.saver = setInterval(() => { if (session && session.dirty) save().catch(V.problem); }, SAVE_EVERY);
    session.clock = setInterval(drawClock, 1000);
    keepAwake(true);
    await session.hearing.start();
    if (session && session.state === 'starting') setState('listening');
  }

  async function pause() {
    if (!session || session.state !== 'listening') return;
    const was = session;
    setState('paused');
    await was.hearing.stop(false);
    saveSoon.flush();
    if (session === was && was.state === 'paused') keepAwake(false);  // (not when Resume came meanwhile)
  }

  async function resume() {
    if (!session || session.state !== 'paused') return;
    const was = session;
    setState('starting');  // "listening" once the PC (or the browser) really is again
    keepAwake(true);
    await was.hearing.start();
    if (session === was && was.state === 'starting') setState('listening');
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

  /* Who writes the notes here, by name, as far as the key check knows (V.ai.brain): Gemini unless "Write notes with
     Claude" is on or only Claude can be used here. */
  const writer = () => (V.ai.brain() === 'gemini' ? 'Gemini' : 'Claude');

  function instructions(cards, speakers = false) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return [
      'You turn the transcript of a class, lecture or meeting into clear notes for the student who recorded it.',
      speakers
        ? 'The transcript comes from speech recognition: it has misheard words and little punctuation. Paragraphs '
          + 'starting "You:" are the student, ones starting "Them:" are the call, class or video on their PC. '
          + 'Fix obvious mishearings from the context, but never add facts, numbers or names that were not said.'
        : 'The transcript comes from speech recognition: it has misheard words, little punctuation and no speaker names. '
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

  /* The notes written into note `id` (above its transcript). Returns { cost, cut, soonest }. `how` goes to V.ai.ask
     (signal, use, onBrain, onProgress): once its signal says stop, nothing is written, whatever answer comes. */
  async function write(id, cards, how = {}) {
    const row = V.data.notes.get(id);
    if (!row || row._purge) throw new Error('That note isn\'t there any more.');
    if (row.locked) throw new Error('Unlock the note first.');
    const { transcript } = split(row.body);
    if (!transcript.trim()) throw new V.ai.AiError('empty', 'There\'s no transcript in this note to make notes from.');
    const speakers = /^(You|Them): /m.test(transcript);  // (PC sound with the microphone: who said what)
    const answer = await V.ai.ask({ ...how, system: instructions(cards, speakers), text: transcript });
    if (how.signal && how.signal.aborted) throw new V.ai.AiError('stopped', 'Stopped.');  // (one set of notes only)
    const who = answer.usage && answer.usage.gemini ? 'Gemini' : 'Claude';
    if (answer.stopReason === 'refusal') {
      throw new V.ai.AiError('refusal', `${who} didn't make notes from this one. Your transcript is saved in the note.`);
    }
    const made = tidy(answer.text);
    if (!made.notes) throw new V.ai.AiError('bad', `${who}'s answer came back empty. Your words are saved: try again.`);
    const cut = answer.stopReason === 'max_tokens';
    const notes = made.notes + (cut ? `\n\n(Cut short: ${who} ran out of room. The transcript below has everything.)` : '');
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
    const nt = { ...before, made: new Date().toISOString(), notes_hash: hash(notes), notes_length: notes.length,
      cards: !!cards, auto_title: title === made.title ? '' : before.auto_title || '' };
    delete nt.wants_notes; delete nt.wants_device; delete nt.wants_cards;  // the notes are made: any auto-make flag clears
    const extra = { ...(now.extra || {}), notetaker: nt };
    await V.cloud.save('notes', { ...now, title, body, extra });
    return { cost: answer.cost, cut, soonest: deadline(notes) };
  }

  async function makeNotes(id) {
    if (inFlight.has(id)) {  // already being written (the screen was closed meanwhile, or it's made by itself): never twice
      if (ui && !session) { closeLayer(); openNote(id); }
      V.toast(`${brainName(inFlight.get(id).who)} is already writing these notes. They'll show in the note when they're ready.`,
        { ms: 5000 });
      return;
    }
    const claim = { who: V.ai.brain() };
    inFlight.set(id, claim);  // claimed at once, before anything waits, so nothing else can ask for this note meanwhile
    const cards = wantsCards();
    // The owner can close this screen while Claude writes (Vault is never held up by it): then nothing pops back up.
    const showing = () => !!(ui && ui.making && ui.making.id === id);
    const ticking = setInterval(() => { if (showing()) tick(); }, 1000);  // the time it's taking, and what can be done
    try {
      if (V.editor.openId() === id) {  // the note is open: closed while its words change, opened again after
        await V.editor.settled();
        V.editor.close();
      }
      openLayer();
      ui.problem = null;
      const words = wordCount(split((V.data.notes.get(id) || {}).body).transcript);
      let use = '';  // the brain V.ai.ask picks; 'gemini' after "Use Gemini instead"
      let done = null;
      for (let first = true; !done; first = false) {
        // One try; a second only after "Use Gemini instead", which stops the first (whatever it answers is never written).
        const making = { id, words, who: use || claim.who, started: Date.now(), wrote: 0, ctl: new AbortController(),
          switched: !!use, switchTo: '' };
        if (first || showing()) { ui.making = making; draw(); }
        try {
          done = await write(id, cards, { signal: making.ctl.signal, use,
            onBrain: (who) => {
              claim.who = who;
              if (making.who !== who) { making.who = who; if (ui && ui.making === making) draw(); }
            },
            onProgress: (n) => { making.wrote = n; if (ui && ui.making === making) tick(); } });
        } catch (error) {
          if (error.kind === 'stopped' && making.switchTo) { use = making.switchTo; continue; }
          notMade(id, cards, error, showing);
          return;
        }
      }
      resting.delete(id);
      const shown = showing();
      if (shown) {
        ui.making = null;
        closeLayer();
        openNote(id);
      }
      V.toast(`Notes made${done.cut ? ' (cut short)' : ''}.${done.cost ? ` That cost about ${V.ai.money(done.cost)}.` : ' Free.'}`, { ms: 5000 });
      if (done.soonest && shown) setTimeout(() => offerReminder(id, done.soonest), 400);
    } finally {
      clearInterval(ticking);
      inFlight.delete(id);
    }
  }

  /* Making note `id`'s notes didn't work: a network or a busy (or too slow) brain means Vault makes them by itself
     later, with a line saying so (never a screen in the way); anything else is shown, or said if the screen's closed. */
  function notMade(id, cards, error, showing) {
    const words = error.message || String(error);
    if (stalled(error)) resting.set(id, Date.now() + slowness.rest);
    const away = () => {
      if (!showing()) return;
      ui.making = null;
      closeLayer();
      openNote(id);
    };
    if (error.kind === 'stopped') { away(); return; }
    if (['offline', 'busy'].includes(error.kind)) {
      flagWants(id, cards).catch(() => {});  // Vault makes them when home
      away();  // straight back to the note (its words are there), with a line saying what happens
      V.toast(words, { ms: 9000 });
      return;
    }
    if (showing()) {
      showProblem(words, id, { tryAgain: !['empty', 'refusal', 'limit', 'nokey', 'old', 'off'].includes(error.kind),
        settings: ['nokey', 'key', 'limit', 'off'].includes(error.kind), gemini: error.brain === 'gemini' });
    } else {
      V.toast(words, { kind: 'err', ms: 8000 });
    }
  }

  /* "Use Gemini instead" on the writing screen: the wait for Claude ends now (V.ai.ask stops it, and tells a PC's
     Python to stop too), and makeNotes asks Gemini. Whatever Claude answers after this is never written. */
  function useInstead(who) {
    const m = ui && ui.making;
    if (!m || m.switchTo || m.who === who) return;
    m.switchTo = who;
    m.ctl.abort();
  }

  /* -- making the notes by itself once Claude can be reached (a blocked school network at the time of Stop)

     When Stop can't reach Claude, the note is flagged (extra.notetaker.wants_notes) and Vault makes the notes by
     itself later, when the network might be back — the same triggers as the chat. The flag also names the device that
     recorded it (wants_device): only that device auto-makes, so two devices never make the same note's notes at once
     and it's never charged twice. The manual "Make notes" chip stays on every device. */

  function wantsOf(note) {
    const nt = note && note.extra && note.extra.notetaker;
    return nt && nt.wants_notes && nt.wants_device === V.device && !note.deleted && !note._purge && !note.locked ? nt : null;
  }
  const anyWants = () => [...V.data.notes.values()].some(wantsOf);

  /* Flag a note for auto-making (kept in its extra, so it survives a restart), and start the retry timer. */
  async function flagWants(id, cards) {
    const row = V.data.notes.get(id);
    if (!row || row._purge) return;
    const nt = { ...((row.extra || {}).notetaker || {}), wants_notes: true, wants_device: V.device, wants_cards: !!cards };
    await V.cloud.save('notes', { ...row, extra: { ...(row.extra || {}), notetaker: nt } });
    startAutoTimer();
  }

  /* Clear the flag without making notes (a problem trying again won't fix, so it mustn't loop). */
  async function clearWants(id) {
    const row = V.data.notes.get(id);
    if (!row || row._purge) return;
    const nt = { ...((row.extra || {}).notetaker || {}) };
    delete nt.wants_notes; delete nt.wants_device; delete nt.wants_cards;
    await V.cloud.save('notes', { ...row, extra: { ...(row.extra || {}), notetaker: nt } });
  }

  let autoTimer = null;
  function startAutoTimer() { if (!autoTimer && anyWants()) autoTimer = setInterval(() => autoMake().catch(() => {}), 60000); }
  function stopAutoTimer() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  function firstWanted() {
    for (const note of V.data.notes.values()) {
      // (not one being written right now, and nothing to make from an empty transcript)
      if (wantsOf(note) && !inFlight.has(note.id) && !((resting.get(note.id) || 0) > Date.now())
        && split(note.body).transcript.trim()) return note;
    }
    return null;
  }

  // Notes resting because a key was missing: a key check that answers (a key set up, Claude switched on) ends their rest.
  const keyless = new Set();
  V.on('ai', () => {
    for (const id of keyless) resting.delete(id);
    keyless.clear();
  });

  let remaking = false;
  async function autoMake() {
    if (remaking || session) return;  // not while listening, and one at a time
    const note = firstWanted();
    if (!note) { if (!anyWants()) stopAutoTimer(); return; }  // (one still being written keeps the timer going)
    startAutoTimer();
    // Whether Claude is on, as the cloud says (not yet read on a new device), and where the keys are (the cloud didn't
    // say in time): until both are known, leave it flagged and try later, never a guess at the brain (a "no key" from
    // guessing wrong would clear the flag for good).
    if (!V.ai.modeKnown()) return;
    if (!V.ai.state() || V.ai.state().failed) await V.ai.check().catch(() => {});
    if (!V.ai.state() || V.ai.state().failed) return;
    // The brain it would use isn't set up here (no Gemini key while Claude is off, say, as on an account that had only
    // a Claude key when it updated): it stays flagged, and goes by itself once a key is set up or Claude switched on
    // (the keys are looked at again now and then for that: one set up on another device counts too).
    if (!V.ai.ready()) await V.ai.recheck();
    if (!V.ai.ready()) return;
    // Out of this month's budget: leave it flagged, try later. (Only Claude's: the free Gemini is never held back by it.)
    // (only once the Gemini key is known: an unseen one would write these notes for free, and ask() looks for it)
    if (V.ai.brain() === 'claude' && V.ai.geminiKnown() && await V.ai.overLimit()) return;
    if (remaking || session || inFlight.has(note.id)) return;  // something started meanwhile (a manual "Make notes")
    remaking = true;
    let made = false;
    const claim = { who: V.ai.brain() };
    inFlight.set(note.id, claim);
    try {
      if (V.editor.openId() === note.id) await V.editor.settled();  // flush any unsaved typing before writing notes in
      await write(note.id, !!(note.extra.notetaker && note.extra.notetaker.wants_cards),  // clears the flag on success
        { onBrain: (who) => { claim.who = who; } });
      made = true;
      resting.delete(note.id);
    } catch (error) {
      if (stalled(error)) resting.set(note.id, Date.now() + slowness.rest);  // (a stall: not again for a while)
      // A miss that trying again won't fix clears the flag (it mustn't loop). A missing key isn't one: it gets set up
      // later (meanwhile the key check says it isn't there, and the note rests anyway, so nothing is fetched each minute).
      if (['nokey', 'off'].includes(error.kind)) { resting.set(note.id, Date.now() + slowness.rest); keyless.add(note.id); }
      else if (!['offline', 'busy'].includes(error.kind)) await clearWants(note.id).catch(() => {});
    } finally {
      inFlight.delete(note.id);
      remaking = false;
    }
    if (made) {
      if (ui && ui.problem && ui.problem.id === note.id) { closeLayer(); openNote(note.id); }  // was on the "not made yet" screen
      V.toast('Made the notes from your saved transcript.', { ms: 5000 });
    }
    if (!anyWants()) { stopAutoTimer(); return; }
    if (made) setTimeout(() => autoMake().catch(() => {}), 0);  // more to do, and this one's done
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

  const stored = (name) => { try { return localStorage.getItem(name) || ''; } catch (e) { return ''; } };
  const store = (name, value) => { try { localStorage.setItem(name, value); } catch (e) { /* private browsing */ } };

  /* -- this PC's own sound (the PC app, when it's new enough to say whether it can hear it: pcSoundState) */

  const pcSoundKnown = () => !!(V.desktop && V.pc && V.pc.can('pcSoundState') && V.pc.can('listenStart'));

  /* "Before you record", the first time the PC's sound is recorded (until "Don't show this again"). */
  function consentFirst() {
    if (stored(CONSENT) === 'ok') return Promise.resolve(true);
    return new Promise((resolve) => {
      let yes = false;
      const never = V.h('input.nt-never-box', { type: 'checkbox' });
      V.sheet({
        title: 'Before you record',
        content: [V.h('p', { text: CONSENT_WORDS }),
          V.h('label.nt-never', {}, never, V.h('span', { text: 'Don\'t show this again' }))],
        actions: [{ label: 'Cancel' }, { label: 'Start', kind: 'primary', onClick: () => {
          yes = true;
          if (never.checked) store(CONSENT, 'ok');
        } }],
        onClose: () => resolve(yes),
      });
    });
  }

  /* What the start screen's choice says: 'mic', 'pc' or 'both' (the PC's sound only once the PC app said it can). */
  function chosenSource(ready) {
    if (!ready || !ready.pcSound || !ready.pcSound.available || ready.source !== 'pc') return 'mic';
    return ready.withMic ? 'both' : 'pc';
  }

  /* The start screen's "Listen to: Microphone | PC sound", the microphone too for a call, and "Test PC sound". */
  function soundChoice(remember) {
    const ready = ui.ready;
    if (ready.pcSound === undefined) {
      ready.pcSound = null;  // asking
      const answered = (answer) => { if (ui && ui.ready === ready) { ready.pcSound = answer; draw(); } };
      V.pc.call('pcSoundState').then((answer) => answered(answer || {}))
        .catch((error) => answered({ available: false, why: error.message || String(error) }));
    }
    const can = !!(ready.pcSound && ready.pcSound.available);
    const pc = can && ready.source === 'pc';
    const pick = (value) => () => {
      if (value === 'pc' && !can) return;
      remember();
      ready.source = value;
      store(SOURCE, value);
      draw();
    };
    const option = (value, label, picture, disabled) => V.h('button', { type: 'button', role: 'radio',
      'aria-checked': String((value === 'pc') === pc), disabled, dataset: { source: value }, onclick: pick(value) },
    picture, V.h('span', { text: label }));
    const result = V.h('span.nt-test-result', { role: 'status' });
    const test = V.button('Test PC sound', { onClick: async () => {
      test.disabled = true;
      result.textContent = 'Listening for a few seconds...';
      try {
        const answer = await V.pc.call('pcSoundTest');
        result.textContent = answer.message || '';
        result.dataset.state = answer.state || '';
      } catch (error) {
        result.textContent = error.message || String(error);
        result.dataset.state = 'error';
      }
      test.disabled = false;
    } });
    const withMic = V.h('input.switch', { type: 'checkbox', checked: !!ready.withMic, 'aria-label': 'Also my microphone',
      onchange: (event) => { ready.withMic = event.target.checked; store(WITH_MIC, ready.withMic ? 'on' : 'off'); } });
    return V.h('div.nt-source', {},
      V.h('span.label', { text: 'Listen to' }),
      V.h('div.segmented.nt-source-pick', { role: 'radiogroup', 'aria-label': 'Listen to' },
        option('mic', 'Microphone', icon('listen')), option('pc', 'PC sound', V.icon('pc'), !can)),
      !ready.pcSound ? V.h('p.nt-hint', { text: 'Checking whether this PC\'s sound can be heard...' })
        : !can ? V.h('p.nt-hint.nt-pc-why', { text: ready.pcSound.why || 'PC sound can\'t be used on this PC.' })
          : pc ? V.h('p.nt-hint', { text: 'Writes down a video, an online class or a call playing on this PC. '
            + 'Only the words are kept, never the sound.' }) : null,
      pc ? V.h('label.switch-row.nt-with-mic', {}, V.h('span.switch-text', {}, V.h('strong', { text: 'Also my microphone' }),
        V.h('span', { text: 'For a call where you talk too. Headphones work best.' })), withMic) : null,
      pc ? V.h('div.nt-test', {}, test, result) : null);
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
    if (ui && ui.making && !ui.problem) {  // Claude is writing: the screen can go (never held up), the notes still land
      closeLayer();
      V.toast('The notes are still being made. They\'ll show in the note when they\'re ready.', { ms: 5000 });
      return;
    }
    const id = ui && ((ui.problem && ui.problem.id) || (ui.ready && ui.ready.id));  // (its note was closed for it)
    closeLayer();
    if (id) openNote(id);
  }

  function showProblem(words, id, { tryAgain = true, settings = false, gemini = false } = {}) {
    openLayer();
    ui.making = null;
    ui.problem = { words, id, tryAgain, settings, gemini };
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
    ? 'This PC turns the talk into words itself, with its own speech recognition. Nothing is sent anywhere while it listens.'
    : `${V.device === 'phone' ? 'Your phone\'s' : 'The browser\'s'} speech service (Google) turns the talk into words.`);

  function folderChoice(picked) {
    const folders = V.notes.folders();
    let saved = picked || '';
    if (!saved) try { saved = localStorage.getItem(FOLDER) || ''; } catch (e) { /* private browsing */ }
    const school = folders.find((f) => f.name.toLowerCase() === 'school');
    const chosen = folders.some((f) => f.id === saved) ? saved : (school || V.notes.inbox() || {}).id || '';
    return V.h('select.field.nt-folder', { 'aria-label': 'Folder' }, folders.map((f) => V.h('option', {
      value: f.id, selected: f.id === chosen, text: `${f.icon ? f.icon + ' ' : ''}${f.name}` })));
  }

  function drawReady() {
    const { body, foot } = ui.parts;
    const ready = ui.ready;
    // Drawn again (the PC's answer about its sound, or the AI's state, arriving while the owner types): what was
    // typed and picked so far stays.
    if (ready.nameEl) ready.name = ready.nameEl.value;
    if (ready.folderEl) ready.folderId = ready.folderEl.value;
    const note = ready.id ? V.data.notes.get(ready.id) : null;
    const how = engine();
    const hasTranscript = !!note && !!split(note.body).transcript.trim();
    const cards = V.h('input.switch', { type: 'checkbox', checked: wantsCards(), 'aria-label': 'Also make flash cards',
      onchange: (event) => setCards(event.target.checked) });
    const name = note ? null : V.h('input.field.nt-name', { type: 'text', placeholder: 'Biology class, team meeting...',
      autocomplete: 'off', maxlength: '120', 'aria-label': 'What is it?', value: ready.name || '' });
    const folder = note ? null : folderChoice(ready.folderId);
    ready.nameEl = name;
    ready.folderEl = folder;
    const remember = () => { if (name) ready.name = name.value; if (folder) ready.folderId = folder.value; };
    const choice = how.kind === 'pc' && pcSoundKnown() ? soundChoice(remember) : null;
    const pcSound = chosenSource(ready) !== 'mic';
    V.clear(body, V.h('div.nt-ready', {},
      V.h('div.nt-hero', {}, icon('listen', 'nt-hero-icon')),
      V.h('h3', { text: note ? `Listen into "${V.noteTitle(note)}"` : 'Notes, written for you' }),
      V.h('p.nt-lead', { text: `Vault writes down what's said in a class or meeting as it happens. When you stop, ${writer()} turns it into tidy notes: a summary, key points, terms, homework and questions.` }),
      name ? V.h('label.label', {}, 'What is it? (optional)', name) : null,
      folder ? V.h('label.label', {}, 'Folder', folder) : null,
      choice,
      V.h('label.switch-row.nt-cards', {}, V.h('span.switch-text', {}, V.h('strong', { text: 'Also make flash cards' }),
        V.h('span', { text: 'For the Study button: question :: answer.' })), cards),
      how.kind ? null : V.h('p.nt-warn', {}, V.icon('alert'), V.h('span', { text: how.why })),
      V.ai.ready() || !V.ai.state() || V.ai.state().failed ? null : V.ai.brain() === 'gemini'
        ? V.h('div.nt-setup', {}, V.h('p.nt-warn', {}, V.icon('alert'),
          V.h('span', { text: 'To make notes, set up the free Gemini first (it only takes a minute). Listening works without it.' })),
        V.button('Set up free Gemini', { kind: 'primary', icon: 'spark', onClick: () => { closeLayer(); V.ai.setUp(); } }))
        : V.h('p.nt-warn', {}, V.icon('alert'),
          V.h('span', { text: 'To make notes, set up Claude in Settings > AI. Listening works without it.' })),
      V.h('ul.nt-facts', {},
        how.kind ? V.h('li', { text: hearsWith(how.kind) }) : null,
        how.kind === 'web' ? V.h('li', { text: 'Keep Vault open while it listens: the screen stays on by itself.' }) : null,
        how.kind === 'web' ? V.h('li', { text: 'In a quiet room, hold the phone nearer the speaker. The browser sets '
          + 'how sensitive the mic is here; the note-taker on your PC can boost soft voices.' }) : null,
        how.kind === 'web' ? V.h('li', { text: 'To take notes from a video or class, use Vault on your PC.' }) : null,
        V.h('li.nt-consent', { text: pcSound ? CONSENT_WORDS : 'Ask people before you record them.' }))));
    V.clear(foot,
      hasTranscript ? V.button('Make notes now', { icon: 'check', onClick: () => makeNotes(note.id) }) : null,
      V.button(hasTranscript ? 'Listen more' : 'Start listening', { kind: 'primary', icon: 'play', disabled: !how.kind,
        onClick: async () => {
          const source = chosenSource(ui.ready);
          if (source !== 'mic' && !(await consentFirst())) return;
          if (!ui || ui.ready !== ready) return;  // (the screen went meanwhile)
          const folderId = folder ? folder.value : null;
          if (folderId) { try { localStorage.setItem(FOLDER, folderId); } catch (e) { /* private browsing */ } }
          ui.ready = null;
          startListening({ id: note ? note.id : null, title: name ? name.value : '', folderId, source }).catch((error) => {
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

  /* What the PC sound bar says. */
  function barWords(s) {
    if (s.state === 'starting') return 'Getting ready to listen to this PC\'s sound...';
    if (s.state === 'paused') return 'Paused: not listening to this PC\'s sound';
    if (s.state === 'stopping') return 'Stopped listening to this PC\'s sound. Saving the last words...';
    return s.source === 'both' ? 'Listening to this PC\'s sound and your microphone' : 'Listening to this PC\'s sound';
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
    // Hearing the PC's sound: a bar that says so the whole time, with Stop (the tray says so too). It says
    // "listening" only once Python is (the tray's red dot comes then too), never while it's still getting ready.
    const onAir = s.source !== 'mic' ? V.h('div.nt-pcsound', { role: 'status', dataset: { state: s.state } },
      V.icon('pc'), V.h('span.nt-pcsound-words', { text: barWords(s) }),
      V.button('Stop', { disabled: s.state === 'stopping',
        onClick: () => stopListening({ make: false }).catch(V.problem) })) : null;
    V.clear(body, V.h('div.nt-live', {}, onAir, ui.statusEl, ui.troubleEl, ui.wordsEl,
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

  const brainName = (who) => (who === 'gemini' ? 'Gemini' : 'Claude');

  /* The writing screen, naming the brain that's asked (Claude, or the free Gemini). */
  function drawMaking() {
    const { body, foot } = ui.parts;
    const m = ui.making;
    const n = m.words;
    ui.makingParts = {
      time: V.h('p.nt-making-time.num', { hidden: true, 'aria-hidden': 'true' }),
      slow: V.h('p.nt-making-slow', { hidden: true, text: 'Taking longer than usual. You can close this — your words are '
        + 'saved, and the notes will appear in the note when they\'re ready.' }),
    };
    V.clear(body, V.h('div.nt-making', { role: 'status' }, V.h('div.spinner.big'),
      V.h('h3', { text: 'Writing your notes...' }),
      V.h('p.muted.nt-making-lead', { text: `${brainName(m.who)} is reading ${n} word${n === 1 ? '' : 's'}. This takes a few seconds.` }),
      ui.makingParts.time, ui.makingParts.slow));
    V.clear(foot);
    tick();
  }

  /* The writing screen as the wait goes on (every second, and as words come): after `slowness.time`, how long it has
     taken (and the words written so far); after `slowness.slow`, a line saying the screen can be closed, and "Use
     Gemini instead" when it's Claude that's slow and the free Gemini is set up. */
  function tick() {
    if (!ui || !ui.making || ui.problem || !ui.makingParts) return;
    const m = ui.making;
    const ms = Date.now() - m.started;
    const { time, slow } = ui.makingParts;
    time.hidden = ms < slowness.time;
    time.textContent = `${clock(ms)} so far${m.wrote ? ` · ${m.wrote} word${m.wrote === 1 ? '' : 's'} written` : ''}`;
    const late = ms >= slowness.slow;
    slow.hidden = !late;
    const offer = late && m.who === 'claude' && !m.switched && !m.switchTo && V.ai.has('gemini');
    const button = ui.parts.foot.querySelector('.nt-use-gemini');
    if (offer && !button) {
      const add = V.button('Use Gemini instead', { icon: 'spark', onClick: () => useInstead('gemini') });
      add.classList.add('nt-use-gemini');
      ui.parts.foot.append(add);
    } else if (!offer && button) {
      button.remove();
    }
  }

  function drawProblem() {
    const { body, foot } = ui.parts;
    const p = ui.problem;
    V.clear(body, V.h('div.nt-making.nt-problem', { role: 'alert' }, V.h('span.nt-problem-icon', {}, V.icon('alert')),
      V.h('h3', { text: 'The notes aren\'t made yet' }), V.h('p', { text: p.words })));
    V.clear(foot,
      // (the free Gemini's key: straight to its row in Settings > AI)
      p.settings ? V.button(p.gemini ? 'Set up free Gemini' : 'Open Settings', { onClick: () => {
        closeLayer();
        if (p.gemini) V.ai.setUp(); else V.go('settings');
      } }) : null,
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
  // The tray's "Stop listening to PC sound" (vault/desktop.py): stopped here, so what was heard is saved first.
  V.on('pc:pc-sound-stop', () => {
    if (!session || session.source === 'mic' || session.state === 'stopping') return;
    stopListening({ make: false }).then(() => V.toast('Stopped listening to this PC\'s sound. What was heard is in the note.'))
      .catch(V.problem);
  });
  // Signing out, or another update: what's been heard is saved first.
  window.addEventListener('pagehide', () => { if (session && session.dirty) save().catch(() => {}); });

  // A note flagged for auto-making is tried whenever the network might be back (online, the page shown or focused,
  // the app coming to the front) and on the gentle timer.
  window.addEventListener('online', () => autoMake().catch(() => {}));
  window.addEventListener('focus', () => autoMake().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoMake().catch(() => {}); });
  V.on('back', () => autoMake().catch(() => {}));
  V.on('data', (table) => { if (table === 'notes' && anyWants()) startAutoTimer(); });

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
      ui.ready = { id: note ? note.id : null, source: stored(SOURCE) === 'pc' ? 'pc' : 'mic', withMic: stored(WITH_MIC) === 'on' };
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
    return V.h('button.chip.nt-chip', { type: 'button', title: `Make notes from the transcript with ${writer()}`,
      onclick: () => makeNotes(note.id) }, icon('spark'), V.h('span', { text: 'Make notes' }));
  });

  // webHearing is dictation's too (js/dictation.js): the same Android handling (newPart/taken/last), kept in one place.
  return { open, sheetEntry, makeNotes, split, join, tidy, instructions, deadline, engine, listening: () => !!session,
    webHearing, rotate, slowness };  // (rotate, slowness: tests shorten them)
})();
