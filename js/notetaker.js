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
   in a "(part 2)" note. Reached from the new-note sheet and as a tool in an open note.

   Browsing while it listens (1.14, the owner: "I don't have to stay on the same tab"): Hide (or Esc) puts the screen
   away without stopping anything (hearing, saving, the screen kept on all carry on), and a bar across the top of Vault
   (`drawStrip`, the "call in progress" bar a phone shows) says it's still listening, with the time and Stop; a tap on
   it brings the screen back with every word heard meanwhile. Only the note-taker writes into the note it listens to
   (its save() writes the whole body), so the editor never opens that note: V.editor.open sends it here instead
   (`listeningTo`). Dictation and voice memos refuse to start while it listens, and signing out stops it first. */
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
  // A note's title as it's shown (its bar, the strip, a toast): words, without the marks of bold, highlight...
  const titleShown = (title) => (V.format ? V.format.unmark(title).trim() : '') || title;

  /* -- how it hears */

  const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  // Chrome on Android, kept listening, hands each finished phrase over again with every phrase before it glued on (a
  // known Chrome bug), so there it hears one phrase at a time and starts again after each. Safari on an iPhone or iPad
  // is no better kept listening (it hangs, or repeats words), so it hears a phrase at a time too. Chrome on an Android
  // tablet (by default) or a phone set to Desktop site leaves "Android" out ("X11; Linux x86_64") but is still
  // Android's Chrome, so what V.deviceKind knows counts too (Settings' "It's my phone" makes such a device 'android'),
  // and so does a touch screen on Linux that isn't a Chromebook (a Linux computer with one just hears a phrase at a
  // time and waits while Wefty is out of sight: the safe side).
  const ANDROID = (() => {
    const kind = V.deviceKind || {};
    const agent = navigator.userAgent || '';
    const linuxTouch = !kind.chromebook && /\bLinux\b/.test(agent) && !/\bCrOS\b/.test(agent) && navigator.maxTouchPoints > 0;
    return !V.desktop && (/Android/i.test(agent) || !!kind.android || !!kind.ios || kind.kind === 'android' || linuxTouch);
  })();
  // Everywhere else (a Chromebook, Chrome on a computer) it's kept listening, but one long session hears worse and
  // worse (the owner: "after about 50 words it picks up terribly"), so a session is swapped for a fresh one in a real
  // pause, once it's `age` ms old or has heard `words` words: `quiet` ms after a finished phrase with nothing more
  // heard since (Google sends words every few hundred ms while someone talks). Every word is in by then, so it's let
  // go at once (abort: no wait for Google's last answer), and the next one starts straight away. Only a session that
  // never had such a pause is ended at its next finished phrase once it's `most` ms old (a stop, which still hands
  // over what it heard; words said while the next one starts can be missed there). (Tests shorten them.)
  const rotate = { age: 20000, words: 35, quiet: 1000, most: 60000 };
  // A session that ended by itself starts again after `again` ms (1.19.5: was 150 ms, and 2 s after a few empty ends:
  // words said in that gap were never heard); only one ending over and over with nothing heard (no internet, say)
  // waits `often` ms, and a start that failed `failed` ms. (Tests read them.)
  const restartGaps = { again: 0, often: 1000, failed: 300, emptyEnds: 6 };
  // Out of sight (1.17; the owner: "even to switch tabs it still listens until stopped"). Chrome on a Chromebook or a
  // computer keeps a page's speech recognition going while its tab is hidden (another tab, another app, the window
  // minimised: only Chrome on Android ends it when hidden, and newer versions there won't start one hidden either:
  // Chromium's SpeechRecognition::PageVisibilityChanged, issue 517429672), so there the note-taker keeps listening,
  // starting fresh sessions in the background too; should a start be refused out of sight, it waits for Wefty to be
  // back, as a phone does. A phone's browser stops hearing when Wefty isn't on the screen (one asking for desktop
  // sites too: ANDROID): it waits, and its screen says so up front. (Other computer browsers, Safari on a Mac, wait
  // as before.)
  const HEARS_HIDDEN = !ANDROID && !V.desktop && /\bChrome\/\d/.test(navigator.userAgent);
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

  /* What Android's unfinished words (`pending`, left when a session ended with no final result: common in a noisy
     room) add after the words kept, or '' when they're only those again (1.19.5: a whole-word check; the old one, a
     plain endsWith on the letters, dropped "no" after "piano" and a new "yes" after a kept "...said yes"). */
  function unfinishedPart(kept, last, pending) {
    const words = newPart(kept, pending);
    if (!plainWords(words)) return '';
    if (endsAgain(kept, words)) return '';
    return sameAgain(last, words) ? '' : words;
  }

  /* Unfinished words that are only the end of what was kept, whole words and three or more of them ("answer is
     twelve" left over after "so the answer is twelve"); a short "yes" after "...said yes" is a new one, and kept. */
  function endsAgain(kept, words) {
    const end = plainWords(kept).split(' ');
    const these = plainWords(words).split(' ');
    return these.length >= 3 && these.length <= end.length && end.slice(-these.length).join(' ') === these.join(' ');
  }

  /* A finished phrase that's only the last one handed over again (Chrome on Android): whole phrases of three words or
     more. A short one said twice ("okay", "no no") is the teacher really saying it again, and is kept. */
  const sameAgain = (last, words) => plainWords(words) === plainWords(last) && plainWords(words).split(' ').length >= 3;

  /* The words of one result: the best alternative that has any (Chrome puts the likeliest first; an empty first one
     with words in the next isn't dropped). */
  function bestWords(result) {
    const n = Math.max(1, Number(result && result.length) || 1);
    for (let i = 0; i < n; i++) {
      const words = result && result[i] && result[i].transcript;
      if (words && words.trim()) return words;
    }
    return '';
  }

  /* 'pc' (Python listens), 'ai' (AI listening: the recording written down by Gemini, 1.19.5; `preview` when the
     browser's speech recognition can run beside it), 'web' (the browser's speech recognition), or null with why not. */
  function engine() {
    if (V.desktop) {
      return V.pc && V.pc.can('listenStart') ? { kind: 'pc' }
        : { kind: null, why: 'Use your phone or Chromebook for the note-taker (this PC\'s Wefty needs an update for it: open Jarvis and click Update).' };
    }
    if (aiWanted()) return { kind: 'ai', preview: aiPreview() };  // (an iPhone's home screen icon too: it records)
    const ios = iosWhyNot();
    if (ios) return { kind: null, why: ios };
    return Recognition() ? { kind: 'web' }
      : { kind: null, why: 'This browser can\'t turn speech into words. Use Chrome on your phone or Chromebook.' };
  }

  /* On an iPhone or iPad, speech turns into words in Safari itself (with Siri or Dictation on). The other browsers
     there say they can but don't, and a home screen icon isn't allowed to: why not here, or '' where it can. */
  function iosWhyNot() {
    const kind = V.deviceKind || {};
    if (!kind.ios) return '';
    if (kind.iosBrowser && kind.iosBrowser !== 'safari') {
      return `On an ${kind.model}, this works in Safari: open Wefty in Safari to use it.`;
    }
    if (!Recognition()) {
      return `On an ${kind.model}, open Wefty in Safari (not from the home screen icon) for this, with Siri or Dictation turned on in Settings.`;
    }
    return '';
  }

  /* The browser's speech recognition, started again whenever it stops by itself (after a silence, now and then
     anyway, or when Vault was in the background) until Stop or Pause. `background`: it goes on while the page is hidden
     (HEARS_HIDDEN, the note-taker's; dictation stops when Wefty goes out of sight anyway). */
  function webHearing(on, { background = false } = {}) {
    let refusedHidden = false;  // a start out of sight was refused here: from then on it waits for the screen
    const mayHear = () => !document.hidden || (background && !refusedHidden);
    /* A start (or its answer) refused while hidden, in the background: it waits for Wefty to be back on the screen. */
    const refused = () => {
      if (!background || !document.hidden) return false;
      refusedHidden = true;
      on.waiting(true);
      return true;
    };
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
      if (!mayHear()) { on.waiting(true); return; }
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
        if (rec !== mine || !wanted || rotating || pending.trim() || !mayHear()) return;
        rotating = true;
        try { mine.abort(); } catch (error) { /* it ended already: onend starts the next */ }
      };
      rec.onresult = (event) => {
        let interim = '';
        let finals = 0;
        for (let i = Math.min(event.resultIndex, taken); i < event.results.length; i++) {
          const result = event.results[i];
          let words = bestWords(result);
          if (!result.isFinal) { interim += words; continue; }  // (bestWords: an empty likeliest one isn't all)
          if (i < taken) continue;  // already kept
          taken = i + 1;
          if (ANDROID) {
            // The words so far again, with the new ones after them: only the new ones (and never the same twice).
            words = newPart(kept, words);
            if (sameAgain(last, words)) continue;
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
        if ((what === 'not-allowed' || what === 'service-not-allowed') && refused()) {
          // (refused because Wefty was out of sight, not the microphone: onend then waits for the screen)
        } else if (what === 'not-allowed' || what === 'service-not-allowed') {
          wanted = false;
          on.fail(V.deviceKind && V.deviceKind.ios
            ? `Wefty can't use speech here. On your ${V.deviceKind.model}: Settings > Apps > Safari > Microphone (Allow), and turn on Siri or Dictation (Settings > General > Keyboard > Enable Dictation). Then try again in Safari.`
            : 'Wefty can\'t use the microphone. Allow it for Wefty in the browser\'s site settings, then try again.');
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
        const unfinished = !pending.trim() ? '' : ANDROID ? unfinishedPart(kept, last, pending) : pending;
        if (unfinished.trim()) {
          heard = true;
          last = unfinished.trim();
          kept = kept ? `${kept} ${last}` : last;
          on.final(unfinished);
        }
        pending = '';
        on.interim('');
        if (!wanted) { if (finished) finished(); finished = null; return; }
        if (!mayHear()) { on.waiting(true); return; }
        if (rotating) { rotating = false; begin(); return; }  // ended for a fresh session: straight on
        const now = Date.now();
        ends = ends.filter((t) => now - t < 10000).concat(heard ? [] : [now]);
        // (straight on; only when it keeps stopping with nothing heard, a breath first)
        restart = setTimeout(begin, ends.length >= restartGaps.emptyEnds ? restartGaps.often : restartGaps.again);
      };
      try {
        rec.start();
        on.waiting(false);
      } catch (error) {
        rec = null;
        if (refused()) return;  // (out of sight: it starts again once Wefty is back)
        restart = setTimeout(begin, restartGaps.failed);
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
            const unfinished = !pending.trim() ? '' : ANDROID ? unfinishedPart(kept, last, pending) : pending;
            if (unfinished.trim()) on.final(unfinished);
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

  /* -- AI listening (1.19.5; the owner, in a real class on a Samsung phone: "it doesn't pick up well in class with
     other groups talking, and it gets many of the words wrong... it's trying to dodge too much"). The browser's speech
     service is made for one person talking into the phone: in a room of groups it drops or garbles most of the
     teacher. With AI listening (on by default once the free Gemini is set up, phones and Chromebooks; the start
     screen's switch and Settings > AI turn it off), the phone records the room itself (getUserMedia, with the
     browser's echo cancellation, noise suppression and gain on, MediaRecorder: opus in webm on Chrome, AAC in mp4 on
     an iPhone) in pieces of `aiChunk.seconds`, each overlapping the one before by `overlap` seconds, and the person's
     own free Gemini writes down what the main speaker says (AI_PROMPT), one piece at a time, in order. The words land
     in the transcript about half a minute behind; where the browser lets its own speech recognition run beside the
     recorder (not Android or an iPhone: one app at a time has the microphone there), its words show meanwhile in grey
     ("hearing..."), never kept. Each piece waits in this device's IndexedDB ("wefty-listening") until it's written
     down, then it's deleted: the sound never goes to the cloud or into the note. Offline, or Gemini busy or out of its
     free quota for now: the pieces wait (longer each time, `aiChunk.retry` up to `most`; a used-up quota `quota` at
     least) and go in order when it can be reached, before the notes are made (autoMake waits for them). Stop waits for
     the last piece ("Finishing the transcript...", with Skip). Never more than one piece's request at a time (`alone`:
     no second model racing it), as each counts against the free daily limit. */
  const AI_PREF = 'vault-notetaker-ai';
  // (tests shorten them)
  const aiChunk = { seconds: 35, overlap: 1.5, least: 0.5, retry: 8000, quota: 30000, most: 60000, bitrate: 32000 };
  const AI_PROMPT = [
    'You write down a recording made in a class, lecture or meeting, for the student who recorded it.',
    'Transcribe faithfully, word for word, everything the main speaker says (usually the teacher: the voice talking to '
      + 'the whole room). Keep everything they say, repeats and asides too, in the language they speak. A student near '
      + 'the phone asking or answering the teacher counts too.',
    'Ignore background chatter: other groups or people talking among themselves, not to the room.',
    'Never invent, guess or fill in words. Where a bit can\'t be made out, write [unclear] in its place.',
    'Add normal punctuation, and start a new paragraph where the topic changes. No summaries, no notes, no title, no '
      + 'timestamps, no speaker names, nothing but the words said.',
    'The recording may start or end in the middle of a sentence: write what is there.',
    'If the main speaker says nothing in it, answer exactly: [silence]',
  ].join('\n');
  const AI_ASK = 'Transcribe this part of the recording.';
  const NOT_WRITTEN = '[a part of the recording couldn\'t be written down]';
  const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac',
    'audio/ogg;codecs=opus'];

  /* AI listening can run here (a phone's or a Chromebook's browser that records sound; the PC listens with Python). */
  const aiCan = () => !V.desktop && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof window.MediaRecorder === 'function';
  const aiPicked = () => stored(AI_PREF) !== 'off';  // (on unless switched off, on this device)
  /* It's used for the next recording: it can run here, it isn't switched off, and the free Gemini is set up. */
  const aiWanted = () => aiCan() && aiPicked() && !!(V.ai && V.ai.has('gemini'));
  function setAiPicked(on) {
    store(AI_PREF, on ? 'on' : 'off');
    V.emit('notetaker-ai', !!on);
  }
  // Where the browser's own speech recognition can run beside the recorder (its words shown in grey meanwhile): not
  // Android's Chrome or an iPhone, where only one thing at a time has the microphone (unverified on real phones: the
  // safe side), so there the recorder runs alone.
  const aiPreview = () => !ANDROID && !(V.deviceKind && V.deviceKind.ios) && !!Recognition();

  function audioType() {
    const R = window.MediaRecorder;
    if (!R || typeof R.isTypeSupported !== 'function') return '';
    return AUDIO_TYPES.find((type) => { try { return R.isTypeSupported(type); } catch (e) { return false; } }) || '';
  }
  const baseType = (type) => String(type || '').split(';')[0].trim().toLowerCase() || 'audio/webm';

  /* The microphone recorded in overlapping pieces, each handed to `on.chunk` ({ blob, mime, at, ends, overlaps })
     once it has stopped. `preview`: the browser's speech recognition runs beside it for the grey words (`on.preview`,
     webHearing's handlers). */
  function recorderHearing(on, { preview = false } = {}) {
    let stream = null;
    let wanted = false;
    let opening = null;
    let pieces = [];    // recordings going now (two during an overlap)
    let timer = null;   // the next piece's start
    let fresh = true;   // the next piece is the first since a start: nothing before it to overlap
    let ears = null;
    let handed = Promise.resolve();  // the piece before this one handed over: pieces go in the order they started

    function piece() {
      const type = audioType();
      let rec;
      try {
        rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: aiChunk.bitrate });
      } catch (error) {
        rec = new MediaRecorder(stream);
      }
      const got = { rec, parts: [], at: Date.now(), overlaps: !fresh };
      fresh = false;
      // (Stop, or a lost microphone, inside an overlap ends two at once: the newer one never goes ahead of the older)
      const before = handed;
      got.done = new Promise((resolve) => {
        rec.ondataavailable = (event) => { if (event.data && event.data.size) got.parts.push(event.data); };
        rec.onstop = () => {
          pieces = pieces.filter((p) => p !== got);
          const mime = baseType(rec.mimeType || type || (got.parts[0] && got.parts[0].type));
          const blob = new Blob(got.parts, { type: mime });
          const ends = Date.now();
          if (!blob.size || ends - got.at < aiChunk.least * 1000) { before.then(resolve); return; }
          before.then(() => on.chunk({ blob, mime, at: got.at, ends, overlaps: got.overlaps }))
            .catch((error) => console.warn('Wefty note-taker:', error)).then(resolve);
        };
      });
      handed = got.done;
      rec.start();
      pieces.push(got);
      return got;
    }

    const end = (got) => {
      if (got.rec.state !== 'inactive') { try { got.rec.stop(); } catch (error) { /* stopped already */ } }
      return got.done;
    };

    /* Half a minute on: the next piece starts, and this one ends `overlap` seconds later (both hear that bit). */
    function roll() {
      timer = null;
      if (!wanted || !stream) return;
      const old = pieces[pieces.length - 1];
      piece();
      timer = setTimeout(roll, aiChunk.seconds * 1000);
      if (old) setTimeout(() => end(old), aiChunk.overlap * 1000);
    }

    function letGo() {
      clearTimeout(timer);
      timer = null;
      const going = Promise.all(pieces.slice().map(end));
      if (stream) {
        stream.getTracks().forEach((track) => {
          track.onended = null;
          track.onmute = null;
          track.onunmute = null;
          try { track.stop(); } catch (e) { /* gone */ }
        });
      }
      stream = null;
      return going;
    }

    /* The microphone went (Android taking it while Wefty was out of sight, or one unplugged): what was recorded is
       kept, and it's opened again once Wefty is on the screen. */
    function lost() {
      if (!wanted || !stream) return;
      letGo();
      if (document.hidden) on.waiting(true);
      else openMic();
    }

    /* Whether the microphone really hears: an audio track that's live and not muted. */
    const hearing = () => !!stream && stream.getAudioTracks().some((track) => track.readyState === 'live' && !track.muted);

    async function openMic() {
      if (!wanted || stream || opening) return opening;
      opening = (async () => {
        let got;
        try {
          got = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true,
            autoGainControl: true, channelCount: 1 } });
        } catch (error) {
          const name = (error && error.name) || '';
          if (!wanted) return;
          if (document.hidden && name !== 'NotFoundError') { on.waiting(true); return; }  // (once Wefty is back)
          wanted = false;
          on.fail(name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Wefty can\'t use the microphone. Allow it for Wefty in the browser\'s site settings, then try again.'
            : name === 'NotFoundError' ? 'No microphone was found.'
              : `The microphone couldn't be opened (${(error && error.message) || name || 'unknown'}).`);
          return;
        }
        if (!wanted) { got.getTracks().forEach((track) => track.stop()); return; }
        stream = got;
        // A track muted (an iPhone sending Wefty to the background, a call taking the microphone) records only
        // silence: the screen says words are missed, and it's opened again once Wefty is back.
        stream.getAudioTracks().forEach((track) => {
          track.onended = lost;
          track.onmute = () => { if (wanted && stream === got) on.waiting(true); };
          track.onunmute = () => { if (wanted && stream === got) on.waiting(false); };
        });
        fresh = true;
        piece();
        timer = setTimeout(roll, aiChunk.seconds * 1000);
        on.waiting(false);
        on.trouble(null);
      })();
      try { await opening; } finally { opening = null; }
      return null;
    }

    return {
      async start() {
        wanted = true;
        await openMic();
        if (wanted && preview && !ears) {
          ears = webHearing(on.preview, { background: HEARS_HIDDEN });
          ears.start().catch(() => {});
        }
      },
      async stop() {
        wanted = false;
        if (opening) await opening.catch(() => {});
        const was = ears;
        ears = null;
        if (was) await was.stop().catch(() => {});
        await letGo();
      },
      back() {
        if (wanted && stream && !hearing()) { letGo(); }  // (muted, or ended unnoticed: a fresh microphone)
        if (wanted && !stream) openMic();
        if (ears) ears.back();
      },
      roll: () => { clearTimeout(timer); roll(); },  // (the next piece now: tests)
    };
  }

  /* The pieces waiting to be written down, in this device's own IndexedDB ("wefty-listening", away from the app's own
     copy of the notes), or in memory where it can't be opened (private browsing). Each: { id, owner, session, note,
     title, seq, at, ends, mime, blob, overlaps, wav, tries }. */
  const chunkStore = (() => {
    const memory = new Map();
    let opening = null;
    let broken = false;
    function open() {
      if (broken || typeof indexedDB === 'undefined') return Promise.resolve(null);
      if (opening) return opening;
      opening = new Promise((resolve) => {
        let request;
        try { request = indexedDB.open('wefty-listening', 1); } catch (error) { broken = true; resolve(null); return; }
        request.onupgradeneeded = () => request.result.createObjectStore('chunks', { keyPath: 'id' });
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => { broken = true; resolve(null); };
      });
      return opening;
    }
    async function run(mode, work) {
      const db = await open();
      if (!db) return work(null);
      return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', mode);
        let result;
        const request = work(tx.objectStore('chunks'));
        if (request) request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('The recording couldn\'t be kept'));
      });
    }
    const order = (a, b) => (a.at - b.at) || (a.seq - b.seq);
    let told = false;
    return {
      // A piece this device's storage turns down (full, or a Safari that can't keep sound there) is kept in memory
      // instead, never lost without a word: it's written down all the same while Wefty stays open.
      put: async (row) => {
        try {
          await run('readwrite', (store) => (store ? store.put(row) : (memory.set(row.id, row), null)));
          if (memory.has(row.id) && (await open())) memory.delete(row.id);  // (kept there now, after a retry)
        } catch (error) {
          memory.set(row.id, row);
          if (!told) {
            told = true;
            V.toast('This device couldn\'t keep the recording in its storage (is it full?). Keep Wefty open until the '
              + 'transcript is written down.', { ms: 9000 });
          }
        }
      },
      remove: async (id) => {
        memory.delete(id);
        await run('readwrite', (store) => (store ? store.delete(id) : null));
      },
      all: async () => {
        const kept = await run('readonly', (store) => (store ? store.getAll() : null)).catch(() => null) || [];
        const rows = [...kept.filter((row) => !memory.has(row.id)), ...memory.values()];
        return rows.sort(order);
      },
    };
  })();

  let pumping = false;
  let pumpTimer = null;
  let pumpWait = 0;            // the wait before the next try now (ms), longer each time
  let aiTrouble = null;        // why the pieces are waiting: { kind: 'offline' | 'busy' | 'nokey', words } or null
  let waitingNotes = new Map();     // note id -> pieces waiting for it
  let waitingSessions = new Map();  // session key -> pieces waiting for it
  let piecesKnown = false;
  const retarget = new Map();  // note id -> the note its words go to instead (it was locked or deleted meanwhile)
  const mine = () => (V.data.user && V.data.user.id) || '';

  /* Counted again (after each change): which notes and recordings still wait, and what shows it. */
  async function recount() {
    const all = await chunkStore.all();
    // (another person's, left from before they signed out here: gone, as this device's copy of their notes is)
    if (mine()) for (const row of all) if (row.owner !== mine()) await chunkStore.remove(row.id).catch(() => {});
    const rows = all.filter((row) => row.owner === mine());
    const notes = new Map();
    const keys = new Map();
    for (const row of rows) {
      const note = retarget.get(row.note) || row.note;
      notes.set(note, (notes.get(note) || 0) + 1);
      keys.set(row.session, (keys.get(row.session) || 0) + 1);
    }
    const done = [...waitingNotes.keys()].filter((id) => !notes.has(id));
    waitingNotes = notes;
    waitingSessions = keys;
    piecesKnown = true;
    if (!rows.length) aiTrouble = null;
    drawStatus();
    finishingMoved();
    if (done.length) setTimeout(() => autoMake().catch(() => {}), 0);  // (notes that waited for their transcript)
    return rows;
  }

  /* A piece recorded: kept on this device, then written down in its turn. */
  async function keepPiece(s, got) {
    s.seq = (s.seq || 0) + 1;
    const row = { id: `${s.key}-${String(s.seq).padStart(6, '0')}`, owner: mine(), session: s.key, note: s.id,
      title: s.title, seq: s.seq, at: got.at, ends: got.ends, mime: got.mime, blob: got.blob, overlaps: !!got.overlaps,
      wav: false, tries: 0 };
    await chunkStore.put(row);
    await recount();
    pump().catch(() => {});
  }

  /* Starts writing down what waits (or carries on), unless it's at it already. */
  function kick() {
    if (!mine()) return;
    if (!piecesKnown) { recount().then((rows) => { if (rows.length) pump().catch(() => {}); }).catch(() => {}); return; }
    if (waitingNotes.size) pump().catch(() => {});
  }

  async function base64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }

  /* A recording as plain 16 kHz WAV, for a Gemini that turns its own format down. */
  async function toWav(blob) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new V.ai.AiError('bad', 'This browser can\'t read its own recording.');
    const ctx = new Context();
    let sound;
    try {
      sound = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (error) {
      throw new V.ai.AiError('bad', 'This recording couldn\'t be read.');
    } finally {
      try { ctx.close(); } catch (e) { /* closed */ }
    }
    const rate = 16000;
    const channels = Math.max(1, sound.numberOfChannels || 1);
    const length = Math.max(1, Math.floor(sound.length * rate / sound.sampleRate));
    const data = new DataView(new ArrayBuffer(44 + length * 2));
    const text = (at, words) => { for (let i = 0; i < words.length; i++) data.setUint8(at + i, words.charCodeAt(i)); };
    text(0, 'RIFF'); data.setUint32(4, 36 + length * 2, true); text(8, 'WAVEfmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true);
    data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, length * 2, true);
    const lines = [];
    for (let c = 0; c < channels; c++) lines.push(sound.getChannelData(c));
    for (let i = 0; i < length; i++) {
      const at = Math.min(sound.length - 1, Math.floor(i * sound.sampleRate / rate));
      let sum = 0;
      for (const line of lines) sum += line[at] || 0;
      const v = Math.max(-1, Math.min(1, sum / channels));
      data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([data.buffer], { type: 'audio/wav' });
  }

  /* One piece written down by the person's free Gemini (Gemini Fast, one request at a time). */
  async function transcribe(row) {
    const blob = row.wav ? await toWav(row.blob) : row.blob;
    const answer = await V.ai.callGemini({ system: AI_PROMPT, use: 'notes', tier: 'fast', alone: true, maxTokens: 4096,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: row.wav ? 'audio/wav' : row.mime, data: await base64(blob) } },
        { text: AI_ASK }] }] });
    // (a stop part-way, RECITATION or SAFETY, after words written down: a teacher reading a poem aloud. What came is
    // kept, the rest marked unclear; only a refusal with no words at all is one)
    if (answer.stopReason === 'refusal') {
      if (!String(answer.text || '').trim()) throw new V.ai.AiError('refusal', 'Gemini didn\'t write this part down.');
      return `${answer.text.trim()} [unclear]`;
    }
    return answer.text || '';
  }

  /* What waits is written down, oldest first, one piece at a time; each piece is deleted once its words are in. */
  async function pump(again = false) {
    if (pumping || !mine() || (pumpTimer && !again)) return;  // (waiting out a busy Gemini: its timer goes on)
    clearTimeout(pumpTimer);
    pumpTimer = null;
    pumping = true;
    try {
      for (;;) {
        const next = (await chunkStore.all()).find((row) => row.owner === mine());
        if (!next) { aiTrouble = null; break; }
        if (!navigator.onLine) { setAiTrouble('offline', 'You\'re offline. The recording is kept on this device and written down when you\'re back online.'); break; }
        let words;
        try {
          words = await transcribe(next);
        } catch (error) {
          const kind = (error && error.kind) || '';
          // ("Gemini's models aren't available ... Try again later": none could be asked, not this piece's sound)
          const unavailable = kind === 'bad' && error.why === 'unavailable';
          if ((kind === 'bad' && !unavailable) || kind === 'refusal' || !(error instanceof V.ai.AiError)) {
            // Its sound turned down (or unreadable here): once more as plain WAV, then once more, then a line in its
            // place (never stuck on one piece).
            next.tries = (next.tries || 0) + 1;
            if (kind && !next.wav && (window.AudioContext || window.webkitAudioContext)) next.wav = true;
            if (next.tries < 3) { await chunkStore.put(next); continue; }
            words = NOT_WRITTEN;
          } else if (['nokey', 'key', 'off'].includes(kind)) {
            setAiTrouble('nokey', 'Set up the free Gemini (Settings > AI) to write the recording down. It\'s kept on this device meanwhile.');
            break;
          } else if (kind === 'stopped') {
            break;
          } else {  // offline, Gemini busy or slow, the free quota used up for now: later, waiting longer each time
            const quota = error && error.why === 'quota';
            pumpWait = Math.min(aiChunk.most, Math.max(quota ? aiChunk.quota : aiChunk.retry, pumpWait * 2));
            setAiTrouble(kind === 'offline' ? 'offline' : 'busy', kind === 'offline'
              ? 'Gemini can\'t be reached right now. The recording is kept on this device and written down when it can be.'
              : `Gemini is busy, so the transcript is a little behind. It carries on by itself.`);
            pumpTimer = setTimeout(() => pump(true).catch(() => {}), pumpWait);
            break;
          }
        }
        pumpWait = 0;
        aiTrouble = null;
        // (its recording saving its last words just now: they go in after them, into the saved note)
        // (or another recording listening into the same note, stopping: its last save first, then these go in)
        while (session && (session.key === next.session || session.id === (retarget.get(next.note) || next.note))
          && session.state === 'stopping') await new Promise((r) => setTimeout(r, 50));
        await deliver(next, words);
        await chunkStore.remove(next.id);  // (the sound is gone once its words are in)
        await recount();
      }
    } finally {
      pumping = false;
      await recount().catch(() => {});
    }
  }

  function setAiTrouble(kind, words) {
    aiTrouble = { kind, words };
    drawStatus();
    finishingMoved();
  }

  const ENDED = /[.!?…:;"”')\]]$/;  // a transcript ending a sentence (else the next words carry it on)
  const plainWord = (word) => plainWords(word).replace(/\s+/g, '');

  /* `after` without what it repeats of the end of `before` (the second or so both pieces heard). At least two words
     the same, from its first few words; a cut-off word at either edge is allowed for. */
  function withoutOverlap(before, after) {
    const tail = String(before || '').split(/\s+/).filter(Boolean).slice(-40).map(plainWord);
    const lines = String(after || '').split('\n');
    const head = lines[0].trim().split(/\s+/).filter(Boolean);
    const plainHead = head.map(plainWord);
    for (let cut = 0; cut <= 2; cut++) {
      const end = tail.length - cut;
      for (let skip = 0; skip <= 3; skip++) {
        for (let k = Math.min(end, plainHead.length - skip, 30); k >= 2; k--) {
          let same = true;
          for (let i = 0; i < k && same; i++) same = !!plainHead[skip + i] && plainHead[skip + i] === tail[end - k + i];
          if (same) return [head.slice(skip + k).join(' '), ...lines.slice(1)].join('\n').trim();
        }
      }
    }
    return String(after || '').trim();
  }

  /* A piece's words into its transcript: the live recording's own (the screen shows them), else straight into the
     note (a recording stopped meanwhile, or one from before Wefty was last closed). */
  async function deliver(row, words) {
    let said = String(words || '').replace(/\r/g, '').trim();
    if (/^\[?\s*silence\s*\]?\.?$/i.test(said)) said = '';
    const live = !!session && session.key === row.session;
    if (live) dropPreview(row.ends);
    if (!said) return;
    if (live) {
      const before = text();
      if (row.overlaps) said = withoutOverlap(before, said);
      // (a piece ending mid-sentence: the next one's first words carry it on, in the same paragraph)
      let carry = !!before.trim() && !ENDED.test(before.trim());
      for (const para of said.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
        heard(para, '', carry ? { join: true, asIs: true } : { fresh: true });
        carry = false;
      }
      return;
    }
    // An earlier recording's late words for the note a new one is listening into now: they go into that recording's
    // transcript, after what it started from (its saves write the whole transcript, so they'd be written over).
    if (session && session.id === (retarget.get(row.note) || row.note)) {
      const before = session.base.trim();
      if (row.overlaps) said = withoutOverlap(before, said);
      if (!said) return;
      session.base = !before ? said : `${before}${ENDED.test(before) ? '\n\n' : ' '}${said}`;
      session.words += wordCount(said);
      session.fromWords += wordCount(said);  // (not this recording's own: the streak counts only those)
      session.dirty = true;
      saveSoon();
      drawWords();
      return;
    }
    await intoNote(row, said);
  }

  /* Words written down after their recording ended, added to the end of its note's transcript. Never into a locked
     note (as plain words): a locked or deleted note's words go to a new note with its title. */
  async function intoNote(row, said) {
    let id = retarget.get(row.note) || row.note;
    let note = V.data.notes.get(id);
    if (!note || note._purge || note.deleted || note.locked) {
      const locked = !!(note && note.locked && !note._purge && !note.deleted);
      const title = locked ? `${row.title} (transcript)` : row.title;
      const next = V.notes.blankNote({ folder_id: (note && note.folder_id) || null, title, body: join('', ''),
        extra: { notetaker: { started: new Date().toISOString(), auto_title: '', engine: 'ai' } } });
      await V.cloud.save('notes', next);
      retarget.set(row.note, next.id);
      if (id !== row.note) retarget.set(id, next.id);
      V.toast(locked ? `"${titleShown(row.title)}" is locked, so the rest of its transcript goes in "${titleShown(title)}".`
        : `"${titleShown(row.title)}" was deleted, so the rest of its transcript goes in a new note.`, { ms: 7000 });
      id = next.id;
      note = V.data.notes.get(id) || next;
    }
    const parts = split(note.body);
    if (row.overlaps) said = withoutOverlap(parts.transcript, said);
    if (!said) return;
    const extra = { ...(note.extra || {}) };
    const nt = { ...(extra.notetaker || {}) };
    nt.words = (Number(nt.words) || 0) + wordCount(said);
    extra.notetaker = nt;
    const before = parts.transcript.trim();
    const body = !before ? said : `${before}${ENDED.test(before) ? '\n\n' : ' '}${said}`;
    await V.cloud.save('notes', { ...note, body: join(parts.above, body), extra });
  }

  /* The grey words the browser's speech recognition heard (beside the recorder), until Gemini's words for that time
     are in. */
  function dropPreview(until) {
    if (!session || !session.heardSoFar) return;
    session.heardSoFar = session.heardSoFar.filter((p) => p.at > until);
    showPreview();
  }
  function showPreview() {
    if (!session) return;
    const so = [...(session.heardSoFar || []).map((p) => p.words), session.previewInterim || ''].join(' ').trim();
    session.interim = so ? `hearing… ${so.length > 240 ? '…' + so.slice(-240) : so}` : '';
    drawWords();
  }

  /* -- Stop waits for the last pieces ("Finishing the transcript...", with Skip) */
  let finishWait = null;  // { id, key, resolve }

  function finishTranscript(id, key) {
    if (!(waitingSessions.get(key) > 0)) return Promise.resolve('done');
    // (what last held it up may be over: the pump says again if not)
    if (aiTrouble && ((aiTrouble.kind === 'offline' && navigator.onLine) || (aiTrouble.kind === 'nokey' && V.ai.has('gemini')))) aiTrouble = null;
    if (aiTrouble && aiTrouble.kind !== 'busy') return Promise.resolve('later');
    return new Promise((resolve) => {
      finishWait = { id, key, resolve };
      openLayer();
      ui.problem = null;
      ui.making = null;
      draw();
      pump(!aiTrouble).catch(() => {});  // (at once, unless Gemini was busy a moment ago: its wait goes on)
    });
  }

  function settleFinish(how) {
    const was = finishWait;
    if (!was) return;
    finishWait = null;
    was.resolve(how);
  }

  /* The pieces waiting changed: the finishing screen counts down, and ends once they're all in (or can't be, now). */
  function finishingMoved() {
    if (!finishWait) return;
    if (!(waitingSessions.get(finishWait.key) > 0)) { settleFinish('done'); return; }
    if (aiTrouble && aiTrouble.kind !== 'busy') { settleFinish('later'); return; }
    if (ui && !ui.problem && !ui.making) draw();
  }

  function drawFinishing() {
    const { body, foot } = ui.parts;
    const left = waitingSessions.get(finishWait.key) || 0;
    V.clear(body, V.h('div.nt-making.nt-finishing', { role: 'status' }, V.h('div.spinner.big'),
      V.h('h3', { text: 'Finishing the transcript…' }),
      V.h('p.muted.nt-finishing-left', { text: `Gemini is writing down the last ${left === 1 ? 'part' : `${left} parts`} of the recording. Then the notes are made.` }),
      aiTrouble && aiTrouble.words ? V.h('p.nt-finishing-trouble', { text: aiTrouble.words }) : null));
    V.clear(foot, V.button('Skip: make notes now', { onClick: () => settleFinish('skip') }));
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

  /* Words heard into the transcript: a new paragraph after a pause (or `fresh`), else on the last one (`join`: always
     there, AI listening's words carrying on a sentence the piece before ended in). `asIs`: its first letter as it is. */
  function heard(words, who, { fresh = false, join: onLast = false, asIs = false } = {}) {
    if (!session) return;
    const clean = String(words || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (session.aboveLength + text().length + clean.length + 2 > BODY_MOST
      || text().length + clean.length + 2 > TRANSCRIPT_MOST) carryOn();
    const now = Date.now();
    const last = session.paragraphs.length - 1;
    const speaker = session.source === 'both' && WHO[who] ? who : '';  // "You:" / "Them:" when both are heard
    if (!(onLast && last >= 0) && (fresh || last < 0 || now - session.lastWords > PARAGRAPH_GAP
      || session.paragraphs[last].length > PARAGRAPH_MOST || speaker !== session.lastWho)) {
      const start = asIs ? clean : clean.charAt(0).toUpperCase() + clean.slice(1);
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
    let row = V.data.notes.get(session.id);
    // Its note went while it listened (put in the Trash or deleted on another device: this one keeps it out of the
    // Trash): nothing heard is lost, it all carries on in a new note.
    if (!row || row._purge || row.deleted) row = rehome(row);
    if (row.locked) {  // locked on another device: its words never go in as plain text, so it stops here
      session.dirty = false;
      stopListening({ make: false, problem: 'The note was locked, so the note-taker stopped. Unlock it to listen into it again.' })
        .catch(V.problem);
      return;
    }
    session.dirty = false;
    const { above } = split(row.body);
    const extra = { ...(row.extra || {}) };
    extra.notetaker = { ...(extra.notetaker || {}), seconds: Math.round(elapsed() / 1000), words: session.words,
      engine: session.engine, ...(session.source !== 'mic' ? { source: session.source } : {}) };
    await V.cloud.save('notes', { ...row, body: join(above, text()), extra });
    // A class recorded (its first words kept): the study loop done once, so Today's "Start here" goes (js/starthere.js).
    if (session && session.words > 0 && !session.looped) { session.looped = true; V.emit('study-loop', 'record'); }
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
    told();
  }

  /* The note it listens into is gone (`old`: its row, if any): a new one with the same title takes the whole transcript
     so far, and the listening carries on there. Returns the new row. */
  function rehome(old) {
    const next = V.notes.blankNote({ folder_id: (old && old.folder_id) || null, title: session.title, body: join('', text()),
      extra: { notetaker: { started: new Date().toISOString(), auto_title: '', engine: session.engine } } });
    session.id = next.id;
    session.aboveLength = 0;
    V.cloud.save('notes', next).catch(V.problem);  // (in V.data.notes at once)
    V.toast(`"${titleShown(session.title)}" was deleted, so the note-taker carries on in a new note.`, { ms: 6000 });
    told();
    return V.data.notes.get(next.id) || next;
  }

  /* The note being listened into changed (a session started or ended, or went on in a "(part 2)"): the notes list
     draws its "Listening" chip again (js/notes.js), and the bar at the top says so. */
  function told() {
    V.emit('notetaker', { listening: session ? session.id : null });
    drawStrip();
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
        // (with its screen put away, that note can't be seen: a line says it instead)
        if (!live()) V.toast('Wefty was off the screen for a moment, so the note-taker missed what was said then.', { ms: 7000 });
        const now = session;
        setTimeout(() => { if (session === now && !now.waiting) { now.wasAway = false; drawStatus(); } }, 20000);
      }
      setState(session.state);
    },
    fail: (words) => { if (session) stopListening({ make: false, problem: words }).catch(V.problem); },
    // AI listening: a piece recorded (kept, then written down by Gemini), and the browser's own words meanwhile, in grey
    // (never kept: a failing preview just stops, the recorder carries on)
    chunk: (got) => (session ? keepPiece(session, got) : Promise.resolve()),
    preview: {
      final: (words) => {
        if (!session) return;
        session.heardSoFar = (session.heardSoFar || []).concat({ at: Date.now(), words: String(words).trim() }).slice(-40);
        session.previewInterim = '';
        showPreview();
      },
      interim: (words) => { if (session) { session.previewInterim = words; showPreview(); } },
      trouble: () => {},
      waiting: () => {},
      fail: () => { if (session) { session.previewInterim = ''; showPreview(); } },
    },
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
    // Only the note-taker writes into its note while it listens: an editor opened on it meanwhile (a reminder's Open,
    // over the start screen) is closed first, its typing saved.
    if (id && V.editor.openId() === id) {
      await V.editor.settled();
      V.editor.close();
    }
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
      trouble: null, waiting: false, wasAway: false, problem: '', source, lastWho: '',
      key: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      seq: 0, preview: !!how.preview, heardSoFar: [], previewInterim: '' };
    session.from = session.counted;     // (what this recording adds: the streak's minutes, js/streak.js)
    session.fromWords = session.words;
    session.hearing = how.kind === 'pc' ? pcHearing(handlers(), source)
      : how.kind === 'ai' ? recorderHearing(handlers(), { preview: how.preview })
        : webHearing(handlers(), { background: HEARS_HIDDEN });
    draw();
    told();
    session.saver = setInterval(() => { if (session && session.dirty) save().catch(V.problem); }, SAVE_EVERY);
    session.clock = setInterval(() => { drawClock(); keepPlaced(); }, 1000);
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

  /* Stop: the last words are kept and saved, then (with `make`) Claude makes the notes. `open` false: the note isn't
     opened after (signing out). Resolves the note's id. With its screen put away (the owner busy elsewhere in Vault),
     a problem is shown without taking them anywhere when it's closed, and never over another note's screen. */
  async function stopListening({ make = true, problem = '', open = true } = {}) {
    if (!session || session.state === 'stopping') return null;
    const was = session;
    const shown = live();
    setState('stopping');
    await was.hearing.stop(true);
    clearInterval(was.saver);
    clearInterval(was.clock);
    keepAwake(false);
    was.interim = '';
    saveSoon.cancel();
    was.dirty = true;
    await save();
    // A recording that heard something is a day studied (js/streak.js), its minutes the week's too.
    if (V.streak && was.words > was.fromWords) {
      V.streak.recorded(Math.round((was.counted + (was.runningSince ? Date.now() - was.runningSince : 0) - was.from) / 1000));
    }
    let id = was.id;
    let anything = !!text().trim();
    session = null;
    told();
    if (was.engine === 'ai') {
      // AI listening: the last pieces are written down first (a screen says so, with Skip); the notes after.
      await recount().catch(() => {});
      kick();
      if (make && !problem && waitingSessions.get(was.key) > 0) {
        const how = await finishTranscript(id, was.key);
        id = retarget.get(id) || id;
        anything = !!split((V.data.notes.get(id) || {}).body).transcript.trim();
        if (how === 'later' || (how === 'skip' && !anything)) {
          // (offline, or no Gemini key: the notes are made by themselves once the transcript is written down)
          await flagWants(id, wantsCards()).catch(() => {});
          if (ui && !ui.making && !ui.problem) closeLayer();
          openNote(id);
          V.toast(aiTrouble && aiTrouble.kind === 'nokey' ? aiTrouble.words
            : 'The rest of the recording is kept on this device and written down when Gemini can be reached. The notes are made by themselves after.',
          { ms: 9000 });
          return id;
        }
        if (how === 'skip') V.toast('The rest of the transcript is added to the note when it\'s written down.', { ms: 6000 });
      } else if (!anything) {
        anything = waitingSessions.get(was.key) > 0;
      }
    }
    if (problem) {
      if (ui && !shown) V.toast(problem, { kind: 'err', ms: 9000, action: 'Open', onAction: () => openNote(id) });
      else showProblem(problem, id, { tryAgain: false, stay: !shown });
      return id;
    }
    if (!make || !anything) {
      if (shown) closeLayer();
      if (!open) return id;
      if (!anything) V.toast('Nothing was heard, so there\'s nothing to make notes from.');
      openNote(id);
      return id;
    }
    await makeNotes(id);
    return id;
  }

  /* Signing out (or the cloud saying the sign-in ended): stopped at once, what was heard saved first, no notes made
     and nothing opened. */
  async function stopQuietly() {
    if (session && session.state !== 'stopping') await stopListening({ make: false, open: false });
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
        + 'answer joined by " :: ".', ...((V.aiCards && V.aiCards.RULES) || [])] : []),
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
    // Its flash cards tidied like Make flash cards' (js/aicards.js, 1.19.1): short answers, no labels, none twice.
    if (cards && V.aiCards && V.aiCards.tidySection) made.notes = V.aiCards.tidySection(made.notes);
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
    V.emit('study-loop', 'notes');  // (the study loop done once: Today's "Start here" goes, js/starthere.js)
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
      // (nor one whose recording is still being written down: AI listening's pieces go in first)
      if (wantsOf(note) && !inFlight.has(note.id) && !((resting.get(note.id) || 0) > Date.now()) && !waitingNotes.has(note.id)
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
      // While it listens: Hide (it carries on, with the bar at the top) instead of the X, and Stop at the other end.
      // (with its word showing: the screen's own small print says "Tap Hide")
      hide: V.button('Hide', { kind: 'quiet', icon: 'down', title: 'Hide: it keeps listening', aria: 'Hide: it keeps listening',
        onClick: () => hide() }),
      stop: V.iconButton('stop', 'Stop listening', () => stopPressed(), 'nt-stop'),
      body: V.h('div.nt-body'),
      foot: V.h('div.nt-foot'),
    };
    parts.hide.classList.add('nt-hide');
    parts.hide.hidden = true;
    parts.stop.hidden = true;
    const panel = V.h('div.nt', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Note-taker' },
      V.h('div.nt-bar', {}, parts.close, parts.hide, parts.title, V.h('span.bar-spacer'), parts.time, parts.stop),
      parts.body, parts.foot);
    const layer = V.h('div.nt-layer', {}, panel);
    document.getElementById('layers').append(layer);
    requestAnimationFrame(() => layer.classList.add('shown'));
    ui = { layer, panel, parts, ready: null, making: null, problem: null, wordsEl: null, interimEl: null, shown: 0 };
    document.addEventListener('keydown', escape, true);
    drawStrip();  // (the bar at the top goes while the screen shows)
  }

  // Esc closes it like any sheet (hides it while it listens), unless a sheet is open over it.
  function escape(event) {
    if (event.key !== 'Escape' || !ui || document.querySelector('#layers > .layer:not(.leaving)')) return;
    event.stopPropagation();
    closePressed();
  }

  function closeLayer() {
    if (!ui) return;
    const { layer } = ui;
    ui = null;
    settleFinish('later');  // (the finishing screen closed: the notes are made by themselves once it's all written down)
    cover(false);
    document.removeEventListener('keydown', escape, true);
    layer.classList.remove('shown');
    setTimeout(() => layer.remove(), 200);
    drawStrip();
  }

  /* Its live screen is showing (not put away, and not the writing or problem screen of another note meanwhile). */
  const live = () => !!(session && ui && !ui.making && !ui.problem && !finishWait);

  /* Hide: the screen goes, the listening doesn't (the bar at the top says so, and brings it back). Not while it's
     stopping: the notes' screen comes next. `focus` false: a tab was tapped, and the keyboard goes where it leads. */
  function hide({ focus = true } = {}) {
    if (!live()) { closePressed(); return; }
    if (session.state === 'stopping') return;
    const was = session;
    closeLayer();
    if (!was.toldHidden) {  // the first time this session: where it went
      was.toldHidden = true;
      V.toast('Still listening. Tap the bar at the top to come back.', { ms: 6000 });
    }
    if (focus && strip && strip.el.isConnected) strip.open.focus({ preventScroll: true });  // (the keyboard comes back there)
  }

  /* -- Wefty's own tabs while it listens (1.17; the owner: "During auto notes allow to browse the app freely as it
     keeps listening, even to switch tabs"). On a phone its screen covered the tab bar, so Hide was the only way out:
     now the live screen leaves the tabs in reach (the bar along the bottom under 900 px, the rail on the left from 900
     px) and a tab tapped there hides the screen (it keeps listening: the bar at the top says so) on the way to that
     tab. Not a modal dialog then (the tabs are part of what can be used). The start, writing and problem screens still
     cover everything. */
  function placeLayer() {
    if (!ui) return;
    const tabs = live() ? document.querySelector('#app.ready:not(.gate) > nav.tabs') : null;
    let box = tabs && tabs.getClientRects().length ? tabs.getBoundingClientRect() : null;
    // (only where the tabs themselves are what's there under the screen: a phone's full-screen note covers them)
    if (box) {
      const under = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        .find((el) => !ui.layer.contains(el));
      if (!under || !tabs.contains(under)) box = null;
    }
    const below = box && box.width > box.height ? Math.max(0, Math.round(innerHeight - box.top)) : 0;  // along the bottom
    const beside = box && box.height > box.width ? Math.max(0, Math.round(box.right)) : 0;            // the rail
    ui.layer.style.bottom = below ? `${below}px` : '';
    ui.layer.style.left = beside ? `${beside}px` : '';
    if (below) ui.layer.dataset.tabs = 'below';
    else if (beside) ui.layer.dataset.tabs = 'beside';
    else delete ui.layer.dataset.tabs;
    ui.panel.setAttribute('aria-modal', below || beside ? 'false' : 'true');
    cover(!!(below || beside));
  }

  /* Not a modal dialog with the tabs in reach, so what the screen covers is made inert (a screen reader's swipe and
     the Tab key go from the screen to the tabs only, never to the hidden page under it): everything of #app but its
     tabs. Given back when the screen closes or covers the tabs again. Only what this made inert is given back. */
  let covered = [];
  function cover(on) {
    const now = on ? [...document.querySelectorAll('#app > *')].filter((el) => !el.matches('nav.tabs')) : [];
    for (const el of covered) if (!now.includes(el)) el.inert = false;
    covered = covered.filter((el) => now.includes(el));
    for (const el of now) if (!el.inert) { el.inert = true; covered.push(el); }
  }
  /* Placed again when the window changes, and each second while it listens (a note closing under it as it opened
     uncovers the tabs a moment later); drawn again when that moves them (its small print says where they are). */
  function keepPlaced() {
    if (!ui) return;
    const was = ui.layer.dataset.tabs || '';
    placeLayer();
    if ((ui.layer.dataset.tabs || '') !== was && live()) draw();
  }
  window.addEventListener('resize', keepPlaced);
  // A tab (or the rail's picture) tapped while the live screen shows: the screen goes first, still listening, then
  // the tab does what it always does.
  document.addEventListener('click', (event) => {
    if (!live() || !ui.layer.dataset.tabs || !event.target || !event.target.closest) return;
    if (event.target.closest('#app > nav.tabs button')) hide({ focus: false });
  }, true);

  /* What the live screen says about using the rest of Wefty meanwhile, as its tabs are placed (and, in Chrome on a
     Chromebook or a computer, other tabs and apps too). */
  function browseWords(engine) {
    const where = ui && ui.layer.dataset.tabs;
    const how = where === 'below' ? 'Tap Hide, or a tab below, to use the rest of Wefty'
      : where === 'beside' ? 'Tap Hide, or a tab on the left, to use the rest of Wefty' : 'Tap Hide to use the rest of Wefty';
    if (!inBrowser(engine) || ANDROID) return `${how}: it keeps listening.`;
    return HEARS_HIDDEN ? `${how}: it keeps listening, in other tabs and apps too (keep this tab open).`
      : `${how}: it keeps listening. It pauses if Wefty leaves the screen and carries on when Wefty is back.`;
  }

  /* A phone's (or an iPhone's) name, for the line saying it can't hear while Wefty is in the background. */
  const phoneName = () => (V.deviceKind && V.deviceKind.ios ? `your ${V.deviceKind.model}` : 'your phone');

  /* Stop without making notes (the bar's Stop, and the one on the bar at the top): asked first, as it ends the
     listening. What was heard stays in the note, with "Make notes" for later. */
  async function stopPressed() {
    if (!session || session.state === 'stopping') return;
    const was = session;
    const sure = await V.confirm('Stop listening?', 'What was heard is saved in the note. You can make notes from it any time.',
      { ok: 'Stop' });
    if (sure && session === was) stopListening({ make: false }).catch(V.problem);
  }

  async function closePressed() {
    if (live()) {  // (Esc while it listens: hidden, never stopped)
      if (session.state !== 'stopping') hide();
      return;
    }
    if (ui && ui.making && !ui.problem) {  // Claude is writing: the screen can go (never held up), the notes still land
      closeLayer();
      V.toast('The notes are still being made. They\'ll show in the note when they\'re ready.', { ms: 5000 });
      return;
    }
    // (its note was closed for it; not when it stopped while the owner was elsewhere: they stay where they are)
    const id = ui && ((ui.problem && !ui.problem.stay && ui.problem.id) || (ui.ready && ui.ready.id));
    closeLayer();
    if (id) openNote(id);
  }

  function showProblem(words, id, { tryAgain = true, settings = false, gemini = false, stay = false } = {}) {
    openLayer();
    ui.making = null;
    ui.problem = { words, id, tryAgain, settings, gemini, stay };
    draw();
  }

  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s % 60).padStart(2, '0');
  };

  function drawClock() {
    drawStrip();
    if (!ui) return;
    ui.parts.time.hidden = !live();
    if (live()) ui.parts.time.textContent = clock(elapsed());
  }

  /* -- the bar at the top while the screen is hidden (the "call in progress" bar): what it's doing, into which note,
     for how long, a tap to come back and Stop. Inside #layers, so it sits over the full-screen note (55) and under
     the note-taker (58), sheets and menus (60); <html> gets "nt-strip-on" while it listens (see drawStrip), and
     styles.css moves the app down for it (under 900 px through --safe-top, from 900 px by padding #app). Never on the
     sign-in or setup screens. */
  let strip = null;
  const setText = (el, words) => { if (el.textContent !== words) el.textContent = words; };

  function stripParts() {
    if (strip) return strip;
    const parts = {
      dot: V.h('span.nt-strip-dot', { 'aria-hidden': 'true' }),
      full: V.h('span.nt-strip-full'),
      brief: V.h('span.nt-strip-brief', { 'aria-hidden': 'true' }),
      title: V.h('span.nt-strip-title'),
      time: V.h('span.nt-strip-time.num'),
    };
    // (its name says it all, the minutes only: the seconds ticking by are never read out)
    parts.open = V.h('button.nt-strip-open', { type: 'button', onclick: () => open() },
      parts.dot, V.h('span.nt-strip-word', {}, parts.full, parts.brief), parts.title, parts.time);
    parts.stop = V.h('button.nt-strip-stop', { type: 'button', title: 'Stop listening', 'aria-label': 'Stop listening',
      onclick: () => stopPressed() }, V.icon('stop'), V.h('span.nt-strip-stop-word', { text: 'Stop' }));
    parts.el = V.h('div.nt-strip', {}, parts.open, parts.stop);
    strip = parts;
    return strip;
  }

  /* What the bar says it's doing: [in full, on a narrow screen, in its spoken name]. Trouble hearing (no internet for
     the speech service, the PC's speech recognition not ready or failing) is said, never "Listening". */
  function stripWords(s) {
    if (s.state === 'starting') return ['Starting...', 'Starting...', 'starting'];
    if (s.state === 'stopping') return ['Saving...', 'Saving...', 'saving'];
    if (s.state === 'paused') return ['Paused', 'Paused', 'paused'];
    if (s.waiting) return ['Waiting', 'Waiting', 'waiting for Wefty to be on the screen'];
    if (s.trouble) return ['Not hearing', 'Not hearing', 'not hearing right now'];  // (why: on its screen, a tap away)
    return s.source === 'mic' ? ['Listening', 'Listening', 'listening']
      : ['Listening to PC sound', 'PC sound', 'listening to PC sound'];
  }

  function drawStrip() {
    const app = document.getElementById('app');
    // The room for the bar stays while it listens, its screen showing too: from 700 px that screen is a dialog with the
    // app in sight behind it, which mustn't jump 36 px each time the screen comes and goes. The bar itself only shows
    // while the screen is put away.
    const on = !!session && !!app && app.classList.contains('ready') && !app.classList.contains('gate');
    const shown = on && !ui;
    document.documentElement.classList.toggle('nt-strip-on', on);
    if (!shown) {
      if (strip && strip.el.isConnected) strip.el.remove();
      return;
    }
    const s = session;
    const parts = stripParts();
    if (!parts.el.isConnected) document.getElementById('layers').append(parts.el);
    const [full, brief, said] = stripWords(s);
    const row = V.data.notes.get(s.id);
    const title = titleShown((row && (row.title || '').trim()) || s.title);
    const ms = elapsed();
    const minutes = Math.floor(ms / 60000);
    parts.el.dataset.state = s.state === 'paused' ? 'paused' : s.state !== 'listening' || s.waiting ? 'wait'
      : s.trouble ? 'trouble' : 'on';
    setText(parts.full, full);
    setText(parts.brief, brief);
    setText(parts.title, title);
    setText(parts.time, clock(ms));
    const name = `Note-taker, ${title}: ${said}, ${minutes ? `${minutes} min` : 'under a minute'}. Open it`;
    if (parts.open.getAttribute('aria-label') !== name) parts.open.setAttribute('aria-label', name);
    parts.stop.disabled = s.state === 'stopping';
  }

  const hearsWith = (kind) => (kind === 'pc'
    ? 'This PC turns the talk into words itself, with its own speech recognition. Nothing is sent anywhere while it listens.'
    : kind === 'ai' ? 'AI listening: the recording goes to Google\'s Gemini (your free key), which writes down what the '
      + 'teacher says, about half a minute behind. The sound is deleted from this device once it\'s written down, and '
      + 'never goes to your cloud.'
      : `${V.device === 'phone' ? 'Your phone\'s' : 'The browser\'s'} speech service (Google) turns the talk into words.`);
  // The phone or Chromebook's browser hears (its speech recognition, or AI listening's recorder), not the PC's Python.
  const inBrowser = (kind) => kind === 'web' || kind === 'ai';

  /* "AI listening" as a switch (the start screen, Settings > AI): this device's choice, on unless switched off. */
  function aiSwitchBox(onChange) {
    const box = V.h('input.switch', { type: 'checkbox', checked: aiPicked(), 'aria-label': 'AI listening',
      onchange: () => { setAiPicked(box.checked); if (onChange) onChange(box.checked); } });
    return box;
  }
  const AI_HINT = 'Better in noisy rooms: sends the recording to Google\'s Gemini, which writes down what the teacher says.';

  /* Settings > AI's row (phones and Chromebooks only: the PC listens with Python), once the free Gemini is set up
     (without it there's nothing to switch: the browser's speech service hears). */
  function aiSwitch(ui) {
    if (!aiCan() || !V.ai.has('gemini')) return null;
    const box = aiSwitchBox((on) => {
      V.toast(on ? 'AI listening is on: Gemini writes down your recordings.'
        : 'AI listening is off: the browser\'s speech service writes down your recordings.', { ms: 5000 });
      if (ui && ui.draw) ui.draw();
    });
    const line = ui.line('AI listening', `${AI_HINT} The sound is deleted once it's written down. Just for this device.`, box);
    line.classList.add('ai-listen-switch');
    return line;
  }

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
    // AI listening (a phone or Chromebook with the free Gemini set up): on unless switched off here.
    const aiRow = aiCan() && V.ai.has('gemini') ? V.h('label.switch-row.nt-ai', {},
      V.h('span.switch-text', {}, V.h('strong', { text: 'AI listening' }), V.h('span', { text: `${AI_HINT} Free.` })),
      aiSwitchBox(() => { remember(); draw(); })) : null;
    const pcSound = chosenSource(ready) !== 'mic';
    V.clear(body, V.h('div.nt-ready', {},
      V.h('div.nt-hero', {}, icon('listen', 'nt-hero-icon')),
      V.h('h3', { text: note ? `Listen into "${V.noteTitle(note)}"` : 'Notes, written for you' }),
      V.h('p.nt-lead', { text: `Wefty writes down what's said in a class or meeting as it happens. When you stop, ${writer()} turns it into tidy notes: a summary, key points, terms, homework and questions.` }),
      name ? V.h('label.label', {}, 'What is it? (optional)', name) : null,
      folder ? V.h('label.label', {}, 'Folder', folder) : null,
      choice,
      aiRow,
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
        inBrowser(how.kind) ? V.h('li', { text: ANDROID
          ? `You can use the rest of Wefty while it listens, but keep Wefty open${navigator.wakeLock ? ' (the screen stays on by itself)'
            : ', with the screen on'}: ${phoneName()} can't hear while Wefty is in the background.`
          : HEARS_HIDDEN ? 'You can use the rest of Wefty, other tabs and other apps while it listens. Keep this tab open.'
            : navigator.wakeLock ? 'You can use the rest of Wefty while it listens. Keep Wefty on the screen (it stays on by itself).'
              : 'You can use the rest of Wefty while it listens. Keep Wefty on the screen, with the screen on.' })
          : how.kind ? V.h('li', { text: 'You can use the rest of Wefty while it listens.' }) : null,
        how.kind === 'web' ? V.h('li', { text: 'In a quiet room, hold the phone nearer the speaker. The browser sets '
          + 'how sensitive the mic is here; the note-taker on your PC can boost soft voices.' }) : null,
        how.kind === 'ai' ? V.h('li', { text: 'Put the phone where it hears the teacher best, nearer the front if you can.' }) : null,
        inBrowser(how.kind) ? V.h('li', { text: 'To take notes from a video or class, use Wefty on your PC.' }) : null,
        V.h('li.nt-consent', { text: pcSound ? CONSENT_WORDS : 'Ask people before you record them.' }))));
    V.clear(foot,
      hasTranscript ? V.button('Make notes now', { icon: 'check', onClick: () => makeNotes(note.id) }) : null,
      V.button(hasTranscript ? 'Listen more' : 'Start listening', { kind: 'primary', icon: 'play', disabled: !how.kind,
        onClick: async () => {
          const source = chosenSource(ui.ready);
          if (source !== 'mic' && !(await consentFirst())) return;
          // (AI listening is on here, and the free Gemini's key not looked for yet: a moment to know, at most 3 s)
          if (aiCan() && aiPicked() && (!V.ai.state() || V.ai.state().failed)) {
            await Promise.race([V.ai.check().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
          }
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
    drawStrip();
    if (!ui || !ui.statusEl || !session) return;
    const s = session;
    const words = s.state === 'starting' ? 'Starting...' : s.state === 'paused' ? 'Paused' : s.state === 'stopping' ? 'Saving...'
      : s.waiting ? 'Waiting for Wefty to be on the screen'
        : s.engine === 'ai' && !s.preview ? 'Listening… words appear every half minute' : 'Listening';
    ui.statusEl.dataset.state = s.state === 'listening' && !s.waiting && !s.trouble ? 'on' : s.state === 'paused' ? 'paused' : 'wait';
    ui.statusEl.querySelector('.nt-state-word').textContent = words;
    ui.statusEl.querySelector('.nt-count').textContent = s.words ? `${s.words} word${s.words === 1 ? '' : 's'}` : '';
    // (AI listening's pieces waiting for Gemini: said, calmly; the recording goes on)
    const behind = s.engine === 'ai' && aiTrouble && waitingSessions.get(s.key) > 0 ? aiTrouble.words : '';
    ui.troubleEl.hidden = !(s.trouble || s.waiting || s.wasAway || behind);
    ui.troubleEl.querySelector('span').textContent = s.trouble || behind
      || (s.waiting ? 'Wefty stopped listening in the background. It carries on when Wefty is back on the screen.'
        : 'Wefty was in the background for a moment and missed what was said then. Keep Wefty on the screen while it listens.');
  }

  /* A paragraph of the transcript shows `words`: changed only where they changed (1.19.1), so words picked to copy
     while it listens stay picked (writing the whole paragraph again, many times a second, dropped them). */
  function wordsInto(para, words) {
    const node = para.firstChild && para.firstChild.nodeType === Node.TEXT_NODE ? para.firstChild : null;
    if (!node) { para.prepend(document.createTextNode(words)); return; }
    if (node.data === words) return;
    if (words.startsWith(node.data)) node.appendData(words.slice(node.data.length));
    else node.data = words;
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
    if (paras.length) wordsInto(paras[paras.length - 1], list[list.length - 1]);
    if (paras.length > 1) wordsInto(paras[paras.length - 2], list[list.length - 2]);
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
    ui.emptyEl = V.h('p.nt-empty', { text: s.engine === 'ai' && !s.preview
      ? 'Listening… the words appear here about every half minute, as Gemini writes them down.'
      : s.base ? 'Carrying on the transcript in this note. New words show here as they\'re heard.'
        : 'Words show here as they\'re heard.' });
    ui.interimEl = V.h(s.engine === 'ai' ? 'span.nt-interim.nt-hearing' : 'span.nt-interim');
    ui.wordsEl = V.h('div.nt-words', { 'aria-live': 'off' }, ui.emptyEl);
    ui.shown = 0;
    // Hearing the PC's sound: a bar that says so the whole time, with Stop (the tray says so too). It says
    // "listening" only once Python is (the tray's red dot comes then too), never while it's still getting ready.
    const onAir = s.source !== 'mic' ? V.h('div.nt-pcsound', { role: 'status', dataset: { state: s.state } },
      V.icon('pc'), V.h('span.nt-pcsound-words', { text: barWords(s) }),
      V.button('Stop', { disabled: s.state === 'stopping',
        onClick: () => stopListening({ make: false }).catch(V.problem) })) : null;
    // Out of sight: a phone can't hear (said where it's seen, not in the small print); Chrome on a Chromebook or a
    // computer carries on (HEARS_HIDDEN); other browsers pause (browseWords).
    V.clear(body, V.h('div.nt-live', {}, onAir, ui.statusEl, ui.troubleEl, ui.wordsEl,
      inBrowser(s.engine) && ANDROID ? V.h('p.nt-bg', {}, V.icon('phone'), V.h('span', {
        text: `Keep Wefty open: ${phoneName()} can't hear while Wefty is in the background (another app, or the screen `
          + 'locked). It carries on when Wefty is back.' })) : null,
      V.h('p.nt-small', { text: `${hearsWith(s.engine)} ${browseWords(s.engine)}` })));
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
        if (p.gemini) V.ai.setUp(); else V.go('settings', { page: 'ai' });
      } }) : null,
      p.id ? V.button('Open the note', { onClick: () => { closeLayer(); openNote(p.id); } }) : null,
      p.tryAgain && p.id ? V.button('Try again', { kind: 'primary', icon: 'restore', onClick: () => makeNotes(p.id) }) : null);
  }

  function draw() {
    drawStrip();
    if (!ui) return;
    // While it listens: Hide and Stop, never the X. (The writing or problem screen of another note, opened while it
    // listens with its screen put away, is that note's: the X, and nothing of the listening.)
    const on = live();
    ui.layer.classList.toggle('listening', on);
    placeLayer();  // (the tabs in reach while it listens)
    drawClock();
    ui.parts.title.textContent = on ? titleShown(session.title) : 'Note-taker';
    const { close, hide: hideButton, stop } = ui.parts;
    close.hidden = on;
    hideButton.hidden = !on;
    stop.hidden = !on;
    hideButton.disabled = stop.disabled = on && session.state === 'stopping';
    if (ui.problem) drawProblem();
    else if (ui.making) drawMaking();
    else if (finishWait) drawFinishing();
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
  // With its screen put away, the owner stays where they are (the line says so, with Open).
  V.on('pc:pc-sound-stop', () => {
    if (!session || session.source === 'mic' || session.state === 'stopping') return;
    const shown = live();
    stopListening({ make: false, open: shown }).then((id) => V.toast('Stopped listening to this PC\'s sound. What was heard is in the note.',
      shown || !id ? {} : { action: 'Open', onAction: () => openNote(id) })).catch(V.problem);
  });
  // Signing out, or another update: what's been heard is saved first.
  window.addEventListener('pagehide', () => { if (session && session.dirty) save().catch(() => {}); });
  // Signing out (Settings stops it itself first, so its words go up before the sign-out) or the cloud ending the
  // sign-in: stopped, its words kept on this device (they go up once signed in again), no notes made, nothing opened.
  V.on('signing-out', () => stopQuietly().catch(() => {}));
  V.on('signed-out', () => stopQuietly().catch(() => {}));

  // A note flagged for auto-making is tried whenever the network might be back (online, the page shown or focused,
  // the app coming to the front) and on the gentle timer.
  window.addEventListener('online', () => autoMake().catch(() => {}));
  // AI listening's pieces waiting (offline, Gemini busy, Wefty closed before they were written down): written down
  // whenever it may work now.
  window.addEventListener('online', () => { if (aiTrouble && aiTrouble.kind === 'offline') { clearTimeout(pumpTimer); pumpTimer = null; } kick(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  V.on('back', () => kick());
  V.on('ai', () => { if (aiTrouble && aiTrouble.kind === 'nokey') aiTrouble = null; kick(); });
  V.on('data', (table) => { if (table === 'notes' && !piecesKnown) kick(); });
  window.addEventListener('focus', () => autoMake().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoMake().catch(() => {}); });
  V.on('back', () => autoMake().catch(() => {}));
  V.on('data', (table) => { if (table === 'notes' && anyWants()) startAutoTimer(); });

  /* The note-taker's first screen: for a new note (from the new-note sheet), or into note `id`. `folderId`: the folder a
     new note goes in, picked already (an empty folder's "Record a class", Today's "Start here"). */
  function open(id = null, { folderId = null } = {}) {
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
      ui.ready = { id: note ? note.id : null, source: stored(SOURCE) === 'pc' ? 'pc' : 'mic', withMic: stored(WITH_MIC) === 'on',
        folderId: !note && folderId && V.data.folders.has(folderId) ? folderId : undefined };
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
  // listeningTo: the note it's writing into now (null when it isn't listening); V.editor.open sends that one here.
  return { open, sheetEntry, makeNotes, split, join, tidy, instructions, deadline, engine, listening: () => !!session,
    listeningTo: () => (session ? session.id : null), stopQuietly,
    webHearing, rotate, slowness, iosWhyNot,  // (rotate, slowness: tests shorten them)
    // AI listening (1.19.5): Settings > AI's switch, and what tests look at (aiChunk, restartGaps: tests shorten them)
    aiSwitch, aiWanted, aiPicked, setAiPicked, aiChunk, restartGaps, AI_PROMPT, withoutOverlap, newPart,
    hearing: () => (session ? session.hearing : null),
    waiting: () => ({ notes: Object.fromEntries(waitingNotes), sessions: Object.fromEntries(waitingSessions), trouble: aiTrouble }) };
})();
