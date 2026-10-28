/* Vault: dictation. The "Dictate" tool in an open note: talk, and the words are typed where the caret is (at the end
   of the note when no text box has it), as if typed there: the editor saves them, Undo takes them back, and the caret
   ends after them. Words not final yet only show in a small pill by the tools, never in the note. Said punctuation
   ("comma", "period" or "full stop", "question mark", "exclamation mark" or "point", "colon") becomes the mark, "new
   line" and "new paragraph" press Enter once or twice (so a checklist or a "- " list carries on as it does when
   typing), a sentence's first word gets its capital, and the spaces come out right.

   Hearing: on the phone and the Chromebook, the browser's speech recognition with the note-taker's own handling of it
   (js/notetaker.js webHearing: Chrome on Android hears one phrase at a time, and a phrase handed over again is kept
   once). The PC app has none, so Python listens there with Jarvis's Parakeet (vault/notetaker.py `dictation`, bridge
   dictateStart / dictateStop, its words as "dictate-text" events, never the note-taker's "listen-text"); its speech
   model stays loaded while the note stays open, so dictating again starts at once. The note-taker and dictation never
   listen at once: dictation won't start while the note-taker listens, and the note-taker starting stops it.

   It stops when tapped again (or the pill's x), when the note closes or another opens, when Vault goes to the
   background, and when a locked note's words are hidden. */
'use strict';

V.dictation = (() => {
  const MARKS = new Map([['comma', ','], ['period', '.'], ['full stop', '.'], ['fullstop', '.'], ['question mark', '?'],
    ['exclamation mark', '!'], ['exclamation point', '!'], ['colon', ':']]);
  const BREAKS = new Map([['new line', 1], ['newline', 1], ['new paragraph', 2]]);
  const PUNCTUATION = /^[,.;:!?…]+$/;
  const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
  const LINE_MARK = /^\s*(?:[-*+•]\s*\[[ xX]?\]\s*|[-*+•]\s+|\d{1,3}[.)]\s+|#{1,3}\s+)/;  // a list's or heading's mark
  // Android's recogniser hears a phrase at a time and gives each one a capital: these small words lose it again in
  // the middle of a sentence (never anything that could be a name).
  const SMALL = new Set(('a an and are as at be because been but by can could did do does for from had has have he her '
    + 'his how if in is it its just my no not of on or our she should so than that the their them then there these '
    + 'they this those to was we were what when where which who why with would you your').split(' '));
  const DRAWN = '<rect x="4.5" y="3" width="6" height="10.5" rx="3"/><path d="M2.5 11a5 5 0 0 0 10 0M7.5 16v4"/>'
    + '<path d="M15 8h6M15 12.5h6M15 17h4"/>';  // a microphone, and the lines it writes

  /* -- what was said, as the words that go in */

  const bare = (word) => word.toLowerCase().replace(/[^\p{L}]+/gu, '');

  /* A phrase as steps: { run: [{ word } | { mark }] } for words, { enter: true } for each Enter. */
  function plan(phrase) {
    const words = String(phrase || '').trim().split(/\s+/).filter(Boolean);
    const steps = [];
    let run = [];
    const flush = () => { if (run.length) steps.push({ run }); run = []; };
    for (let i = 0; i < words.length; i++) {
      const one = bare(words[i]);
      const two = i + 1 < words.length ? `${one} ${bare(words[i + 1])}` : '';
      const said = two && (MARKS.has(two) || BREAKS.has(two)) ? two : one && (MARKS.has(one) || BREAKS.has(one)) ? one : '';
      if (said === two && two) i++;
      if (said && MARKS.has(said)) run.push({ mark: MARKS.get(said) });
      else if (said) { flush(); for (let n = 0; n < BREAKS.get(said); n++) steps.push({ enter: true }); }
      else if (PUNCTUATION.test(words[i])) run.push({ mark: words[i] });
      else run.push({ word: words[i] });
    }
    flush();
    return steps;
  }

  /* Whether a word after `before` starts a sentence: the start of a line (or of a list item or a heading), or after
     a full stop, a question mark or an exclamation mark. */
  function startsSentence(before) {
    const line = before.slice(before.lastIndexOf('\n') + 1).replace(LINE_MARK, '').trim();
    return !line || SENTENCE_END.test(line);
  }

  function fit(word, start) {
    if (start && /\p{Lu}/u.test(word.slice(1))) return word;  // "iPhone" stays as it is
    if (start) return word.replace(/^([("“‘'¿¡]*)(\p{Ll})/u, (all, open, letter) => open + letter.toUpperCase());
    if (/^\p{Lu}\p{Ll}+$/u.test(word) && SMALL.has(word.toLowerCase())) return word.toLowerCase();
    return word;
  }

  /* One run of words and marks as it goes in after `before`: { text, trim }, `trim` being the spaces just before the
     caret that go (a mark never has a space before it). */
  function compose(before, run) {
    let text = '';
    let trim = 0;
    for (const t of run) {
      if (t.mark) {
        if (text) text = text.replace(/[ \t]+$/, '');
        else trim = (/[ \t]+$/.exec(before) || [''])[0].length;
        text += t.mark;
        continue;
      }
      const so = before.slice(0, before.length - trim) + text;
      const spaced = !!so && !/[\s(\[{"“‘]$/.test(so);
      text += (spaced ? ' ' : '') + fit(t.word, startsSentence(so));
    }
    return { text, trim };
  }

  /* Enter at the end of a note's words, as the editor does it: a checklist or a "- " / "1. " list carries on (an
     empty item ends it), anything else gets a new line. */
  function enterAtEnd(text) {
    const start = text.lastIndexOf('\n') + 1;
    const line = text.slice(start);
    const box = /^(\s*)[-*]\s*\[( |x|X)\]\s?(.*)$/.exec(line);
    if (box) return box[3].trim() ? `${text}\n${box[1]}- [ ] ` : text.slice(0, start);
    if (!/^#{1,3}\s/.test(line)) {
      const list = V.format.continueList(text, text.length, text.length);
      if (list) return list.value;
    }
    return text + '\n';
  }

  /* `phrase` (or its steps) put after all of `words`. */
  function append(words, phrase) {
    let text = String(words || '');
    for (const step of Array.isArray(phrase) ? phrase : plan(phrase)) {
      if (step.enter) { text = enterAtEnd(text); continue; }
      const piece = compose(text, step.run);
      text = text.slice(0, text.length - piece.trim) + piece.text;
    }
    return text;
  }

  /* -- typing it into the open note */

  let composing = null;  // the box the phone's keyboard is still writing a word in
  document.addEventListener('compositionstart', (event) => { composing = event.target; }, true);
  document.addEventListener('compositionend', () => { composing = null; }, true);

  /* A word the keyboard is still writing is finished first: changing the words under it would break it. */
  function finishWord(field) {
    if (composing !== field || document.activeElement !== field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    composing = null;
    field.blur();
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
  }

  /* The text box with the caret in the open note, or null (then the words go at the end). */
  function target() {
    const root = V.editor.root();
    const active = document.activeElement;
    return root && root.isConnected && active && root.contains(active) && active.matches('.block-input') ? active : null;
  }

  /* The words typed in at the caret, the box's own way: the editor hears an input as from the keyboard. */
  function typeInto(field, { text, trim }, inputType = 'insertText') {
    if (!text) return;
    finishWord(field);
    const start = Math.max(0, field.selectionStart - (trim || 0));
    field.setRangeText(text, start, field.selectionEnd, 'end');
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text }));
    showCaret(field);
  }

  /* Enter at the caret: the editor's own handling first (the next tick-box item, a list carried on, out of a
     heading), else a new line in the box. */
  function pressEnter(field) {
    finishWord(field);
    const asked = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak' });
    if (!field.dispatchEvent(asked)) return;
    typeInto(field, { text: '\n', trim: 0 }, 'insertLineBreak');
  }

  /* The note scrolled just as far as the caret (as the editor does when typing). */
  function showCaret(field) {
    const scroller = field.closest('.editor-scroll');
    if (!scroller) return;
    const box = field.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const y = box.top + (field.value.length ? field.selectionEnd / field.value.length : 0) * box.height;
    if (y + 28 > view.bottom) scroller.scrollTop += y + 28 - view.bottom + 8;
    else if (y - 28 < view.top) scroller.scrollTop -= view.top - (y - 28) + 8;
  }

  function showEnd() {
    const root = V.editor.root();
    const scroller = root && root.querySelector('.editor-scroll');
    if (!scroller) return;
    const fields = root.querySelectorAll('.blocks .block-input');
    const last = fields[fields.length - 1];
    if (!last) { scroller.scrollTop = scroller.scrollHeight; return; }
    const below = last.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
    if (below > 0) scroller.scrollTop += below + 24;
  }

  const canPut = (id) => V.editor.openId() === id && V.editor.words() !== null;

  /* A finished phrase into note `id`, if it's still the open note and its words show. */
  function put(id, phrase) {
    if (!canPut(id) || !String(phrase || '').trim()) return;
    const steps = plan(phrase);
    let i = 0;
    for (; i < steps.length; i++) {
      const field = target();
      if (!field) break;
      if (steps[i].enter) pressEnter(field);
      else typeInto(field, compose(field.value.slice(0, field.selectionStart), steps[i].run));
    }
    if (i >= steps.length) return;
    // No box has the caret: at the end of the note (one Undo step), without bringing a phone's keyboard up.
    const now = V.editor.words();
    const next = append(now, steps.slice(i));
    if (now === null || next === now) return;
    V.editor.setWords(next);
    showEnd();
  }

  /* -- how it hears */

  const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;

  /* 'pc' (Python listens), 'web' (the browser's speech recognition), or null with where it works instead. */
  function engine() {
    if (V.desktop) {
      return V.pc && V.pc.can('dictateStart') ? { kind: 'pc' }
        : { kind: null, why: 'Update Jarvis to dictate on this PC: open Jarvis and click Update. You can dictate on your phone or Chromebook now.' };
    }
    return Recognition() ? { kind: 'web' }
      : { kind: null, why: 'This browser can\'t turn speech into words. Dictate in Chrome on your phone or Chromebook, or in Vault on your PC.' };
  }

  /* Python listening on the PC: its words come as "dictate-text" events (the note-taker's are "listen-text"). */
  let pcEars = null;   // dictation's handlers while the PC listens for it
  let pcWarm = false;  // the PC kept its speech model loaded after the last stop: let go when the note is left
  V.on('pc:dictate-text', ({ text }) => { if (pcEars && text) pcEars.final(text); });
  V.on('pc:dictate-state', ({ state, message }) => {
    if (!pcEars) return;
    if (state === 'loading') pcEars.trouble('Getting the PC\'s speech recognition ready...');
    else if (state === 'listening') { pcEars.trouble(null); pcEars.interim(''); }
    else if (state === 'writing') pcEars.interim('Typing what you said...');
    else if (state === 'error' && message) pcEars.trouble(message);
    else if (state === 'stopped') pcEars.ended();
  });

  function pcHearing(on) {
    return {
      async start() {
        pcEars = on;
        try {
          await V.pc.call('dictateStart');
          pcWarm = true;
        } catch (error) {
          if (pcEars === on) pcEars = null;
          on.fail(error.message || String(error));
        }
      },
      async stop(done = true) {
        try { await V.pc.call('dictateStop', { done }); } catch (error) { console.warn('Vault dictation:', error); }
        if (done) pcWarm = false;
        if (pcEars === on) pcEars = null;  // (its last words came before the answer)
      },
      back() {},
    };
  }

  function release() {
    if (!pcWarm || !V.desktop) return;
    pcWarm = false;
    V.pc.call('dictateStop', { done: true }).catch(() => {});
  }

  /* -- one dictation, into one note */

  let session = null;   // { id, engine, hearing, interim, trouble, state: starting | on | stopping }
  let watching = null;

  function handlers(was) {
    return {
      final: (words) => put(was.id, words),  // (also while it stops: the last words still go in)
      interim: (words) => { if (session === was) { was.interim = words || ''; paint(); } },
      trouble: (words) => { if (session === was && was.trouble !== words) { was.trouble = words; paint(); } },
      waiting: () => {},  // (it stops when Vault goes to the background)
      fail: (words) => {
        if (session !== was) return;
        stop({ done: true });
        V.toast(words, { kind: 'err', ms: 6000 });
      },
      ended: () => { if (session === was && was.state !== 'stopping') stop({ done: false }); },  // the PC stopped it
    };
  }

  async function start() {
    const id = V.editor.openId();
    if (!id || session) return;
    if (V.editor.words() === null) { V.toast('Unlock the note first.'); return; }
    if (V.notetaker && V.notetaker.listening()) { V.toast('The note-taker is listening. Stop it first, then dictate.'); return; }
    const root = V.editor.root();
    if (root && root.querySelector('.editor-tools.recording')) { V.toast('Finish the voice memo first.'); return; }
    const how = engine();
    if (!how.kind) { V.toast(how.why, { ms: 7000 }); return; }
    const was = { id, engine: how.kind, interim: '', trouble: null, state: 'starting' };
    session = was;
    was.hearing = how.kind === 'pc' ? pcHearing(handlers(was)) : V.notetaker.webHearing(handlers(was));
    watching = setInterval(check, 500);
    paint();
    await was.hearing.start();
    if (session === was && was.state === 'starting') { was.state = 'on'; paint(); }
  }

  /* `done`: the PC lets go of its speech model too (the note was left), not only the microphone. */
  async function stop({ done = true } = {}) {
    const was = session;
    if (!was || was.state === 'stopping') return;
    was.state = 'stopping';
    was.interim = '';
    paint();
    try { await was.hearing.stop(done); } catch (error) { console.warn('Vault dictation:', error); }
    if (session === was) session = null;
    if (!session) { clearInterval(watching); watching = null; }
    paint();
  }

  const toggle = () => (session && session.state !== 'stopping' ? stop({ done: false }) : start());

  /* Still the note it's typing into, its words showing, and Vault in front: else it stops. */
  function check() {
    const was = session;
    if (!was) return;
    if (was.state !== 'stopping' && (V.editor.openId() !== was.id || V.editor.words() === null || V.away())) {
      stop({ done: true });
      return;
    }
    paint();
  }

  /* -- on screen: the tool pressed, and the pill with the words not final yet */

  let pill = null;
  const tail = (text) => (text.length > 64 ? '…' + text.slice(-63).trimStart() : text);

  function paint() {
    const root = V.editor.root();
    const on = !!session && session.state !== 'stopping' && session.id === V.editor.openId();
    const button = root && root.querySelector('.tool-btn[data-tool="dictate"]');
    if (button) {
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (!on || !root) {
      if (pill) { pill.remove(); pill = null; }
      return;
    }
    if (!pill) {
      pill = V.h('div.dictate-pill', {},
        V.h('span.dictate-dot', { 'aria-hidden': 'true' }), V.h('span.dictate-words'),
        V.h('button.dictate-stop.keep-caret', { type: 'button', title: 'Stop dictating', 'aria-label': 'Stop dictating',
          onclick: () => stop({ done: false }) }, V.icon('x')));
    }
    const tools = root.querySelector('.editor-tools');
    if (tools && pill.parentNode !== tools) tools.append(pill);
    const s = session;
    pill.dataset.state = s.trouble || s.state === 'starting' ? 'wait' : 'on';
    pill.classList.toggle('heard', !s.trouble && !!s.interim);
    pill.querySelector('.dictate-words').textContent = s.trouble
      || (s.interim ? tail(s.interim) : s.state === 'starting' ? 'Starting...' : 'Listening... talk and it types');
  }

  function icon() {
    const span = V.icon('');
    span.firstChild.innerHTML = DRAWN;  // a fixed string only
    return span;
  }

  V.editor.addTool({ name: 'dictate', label: 'Dictate', icon, first: true, onClick: toggle,
    // (also told each time the tools are drawn again: the pressed look and the pill go back on)
    shown: (note) => { Promise.resolve().then(paint); return !note.locked || V.editor.revealed(); } });

  V.on('note-left', (id) => { if (session && session.id === id) stop({ done: true }); else if (!session) release(); });
  V.on('away', () => { if (session) stop({ done: true }); else release(); });
  V.on('notetaker-listening', () => { if (session) stop({ done: true }); });
  // A voice memo needs the microphone too.
  document.addEventListener('click', (event) => {
    if (session && event.target.closest && event.target.closest('.tool-btn[data-tool="voice"]')) stop({ done: false });
  }, true);
  window.addEventListener('pagehide', () => { if (session) stop({ done: true }); });

  return { start, stop, toggle, engine, plan, append, compose, listening: () => !!session && session.state !== 'stopping' };
})();
