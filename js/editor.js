/* Vault: one note, open for writing. The words are kept as plain text (what Jarvis reads too), with checklist
   lines as "- [ ] milk" / "- [x] milk" and headings as "# Plan"; here they're shown as blocks: free text, headings,
   and tick-box rows where Enter makes the next item. "- " and "1. " lists carry on with Enter, links show as chips
   under their line, and the Read view shows it all formatted (js/format.js). Everything saves by itself a moment after
   typing stops, and Undo steps back through what was written here. Pictures, other files and voice memos go to the
   cloud as soon as they're added (a note's own folder in the vault bucket). A locked note is only ever decrypted in
   memory. */
'use strict';

V.editor = (() => {
  const CHECK = /^(\s*)[-*]\s*\[( |x|X)\]\s?(.*)$/;
  const HEADING = V.format.HEADING;   // "# Plan", "## Monday" (and "### ")
  const FENCE = /^\s*```/;            // a ``` code block starts or ends
  const MAX_SIDE = 1600;
  const MAX_FILE = 50 * 1024 * 1024;  // the cloud's most for one file (vault/schema.sql)
  const MEMO_MOST = 20 * 60;          // a voice memo stops by itself after 20 minutes
  const LET_GO_AFTER = 6000;          // a removed file leaves the cloud once its Undo has gone
  const UNDO_STEPS = 60;              // Undo goes this far back...
  const UNDO_LETTERS = 4000000;       // ...or as far as this much text (a very long note keeps fewer steps)
  let openId = null;
  let note = null;        // the working copy (with the real body even when the note is locked)
  let blocks = [];
  let el = null;          // the editor's root element
  let host = null;        // the pane it's in, or null when it's the full-screen layer
  let layer = null;
  let parts = {};
  let revealed = false;   // a locked note whose words are showing
  let base = null;        // the note as last loaded or saved here: what a change from elsewhere is told apart from
  let saving = 0;         // saves handed to the chain and not stored yet
  let savedWords = '';    // the words as last loaded, shown or saved here (a locked note's too, once open)
  let composingField = null;  // the box a word is still being put together in (phones send each word that way)
  let pending = null;     // a change from elsewhere that came mid-save: put in once the save is stored
  let pendingFrom = null; // what this device had when it came
  let lastField = null;   // the text box last typed in, for the toolbar's buttons
  let lastInput = '';     // the kind of the last change typed in a box (a drag's own taking out, before its drop)
  let adding = 0;         // pictures and files going up to the cloud now
  let reading = false;    // the Read view (the note formatted; a tap goes back to writing there) instead of the boxes
  let readMap = null;     // the Read view's pieces of text -> where they are in the note
  let goalBelow = false;  // the word goal wasn't reached yet while this note was open...
  let cheered = false;    // ...and reaching it has been cheered
  const owner = new WeakMap();     // a text box -> its block
  const chipRows = new WeakMap();  // a text box -> the row of link chips under it
  const extraTools = [];           // buttons other parts of Vault add to the tools (V.editor.addTool)
  const thumbMakers = {};          // attachment kind -> its thumbnail among the pictures (V.editor.addThumb)
  const pictureActions = [];       // more buttons for the picture viewer (V.editor.addPictureAction)

  const metaMakers = [];           // chips other parts of Vault put beside the due date (V.editor.addMeta)
  const typedWatchers = [];        // told when the title or the words are typed in (V.editor.onTyped)
  const openWatchers = [];         // told just before a note is opened (V.editor.onOpen)
  let asking = null;               // { id, node }: a question shown just above the tools (V.editor.ask)

  /* -- the words as blocks */

  /* The lines of a ``` code block stay in their text block, as written ("# a comment" in Python isn't a heading): one
     box holds the whole block, so its copy (shade) and the mark buttons know they're code, as the Read view does. */
  function parse(body) {
    const out = [];
    let text = [];
    let fenced = false;
    const flush = () => { if (text.length) { out.push({ type: 'text', text: text.join('\n') }); text = []; } };
    for (const line of (body || '').split('\n')) {
      const fence = FENCE.test(line);
      if (fence || fenced) {
        if (fence) fenced = !fenced;
        text.push(line);
        continue;
      }
      const box = CHECK.exec(line);
      const head = box ? null : HEADING.exec(line);
      if (box) { flush(); out.push({ type: 'check', done: box[2] !== ' ', text: box[3] }); }
      else if (head) { flush(); out.push({ type: 'heading', level: head[1].length, text: head[2] }); }
      else text.push(line);
    }
    flush();
    return out.length ? out : [{ type: 'text', text: '' }];
  }

  const lineOf = (b) => (b.type === 'check' ? `- [${b.done ? 'x' : ' '}] ${b.text}`
    : b.type === 'heading' ? `${'#'.repeat(b.level)} ${b.text}` : b.text);
  const serialize = () => blocks.map(lineOf).join('\n');
  const oneLine = (b) => b.type !== 'text';  // tick-box items and headings are one line each
  const prefix = (b) => (b.type === 'check' ? 6 : b.type === 'heading' ? b.level + 1 : 0);  // the marks before their words

  /* jsonb comes back from the cloud with its keys in another order: compared with them sorted. */
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  const stable = (v) => JSON.stringify(sorted(v));

  /* -- saving */

  const saveSoon = V.debounce(() => save(), 500);
  let chain = Promise.resolve();
  let queued = '';  // the last state handed to the chain: the same one isn't saved twice

  /* Saving takes a snapshot of the note now (it may be closed a moment later) and saves the snapshots one after
     another, so an older one can never land after a newer one. `quiet`: only the note's flash cards moved on (js/review.js),
     so it doesn't count as an edit (js/cloud.js checks that nothing else changed). */
  function save({ quiet = false } = {}) {
    // A change from elsewhere still waiting goes in first: saving over it would lose it.
    if (pending && !saving) takeRemote();
    const current = note;
    if (!current) return chain;
    const words = serialize();
    const showing = revealed;
    const body = current.locked ? '' : words;
    const fingerprint = JSON.stringify([current.id, current.title, body, current.folder_id, current.pinned,
      current.due, current.done, current.locked, current.attachments, current.locked && showing ? words : '',
      stable(current.extra || {})]);
    if (fingerprint === queued) return chain;
    queued = fingerprint;
    saving++;
    chain = chain.then(() => store(current, body, words, showing, quiet)).catch((error) => {
      queued = '';  // not saved: the next change tries again
      V.problem(error);
    }).finally(() => {
      saving--;
      if (!saving && pending) setTimeout(takeRemote);
    });
    return chain;
  }

  async function store(current, body, words, showing, quiet = false) {
    const row = { ...current, body };
    // A locked note's words are sealed again only while they're showing; otherwise (its pin, folder or title
    // changed from the locked face) its sealed words stay exactly as they were.
    if (current.locked && showing) row.secret = await V.lock.encrypt(JSON.stringify({ body: words }));
    const saved = await V.cloud.save('notes', row, { quiet });
    if (note && note.id === saved.id) {
      base = saved;
      if (!current.locked || showing) savedWords = words;
      remember(words);
      note = { ...note, updated_at: saved.updated_at, secret: saved.secret, _dirty: saved._dirty };
      // The other device's words were put in on the way (js/cloud.js): shown like any change from elsewhere.
      if (!pending && !current.locked && (saved.body !== body || (saved.title || '') !== (current.title || ''))) {
        pending = saved;
        pendingFrom = { base: row, words };
      }
    }
    setStatus();
  }

  /* The words this note recently had here, newest first: a change from elsewhere was made from one of them. */
  let known = [];
  function remember(words) {
    if (typeof words !== 'string') return;
    known = [words, ...known.filter((w) => w !== words)].slice(0, 30);
  }

  const paths = (note) => (note.attachments || []).map((a) => a.path).join('|');  // the cloud reorders their keys
  const sameNote = (a, b) => !!a && !!b && a.title === b.title && a.folder_id === b.folder_id && a.pinned === b.pinned
    && a.due === b.due && a.done === b.done && a.locked === b.locked
    && (a.locked ? a.secret === b.secret : a.body === b.body) && paths(a) === paths(b)
    && stable(a.extra || {}) === stable(b.extra || {});

  /* While a locked note's words show, copying them doesn't go to the shared clipboard: on the PC its app stops
     watching the clipboard, on a phone or a Chromebook "Keep this clipboard in step" only notes what's copied
     (js/clips.js). */
  function quietClipboard(on) {
    if (V.desktop) V.pc.call('quietClipboard', { on }).catch(() => {});
    if (V.clips && V.clips.quiet) V.clips.quiet(on);
  }

  function setStatus() {
    if (!parts.status) return;
    const state = V.cloud.status;
    parts.status.textContent = state === 'offline' ? 'Saved on this device' : state === 'syncing' ? 'Saving...' : 'Saved';
  }

  /* -- drawing */

  /* Text boxes grow with their words. Chrome 123+ does it by itself (styles.css: field-sizing); elsewhere they're
     measured, which shrinks them for a moment, so the scroll position is put back: without that, a phone's keyboard
     committing a word on space threw a long note back to its top. */
  const SIZES_ITSELF = !!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
  function grow(area) {
    shade(area);  // (whenever a box's words change, so do its blanks...
    preview(area);  // ...the words shown formatted while it isn't being written in...
    if (document.activeElement === area) lettersUp(area, false);  // ...and the letters drawn over it while it is)
    if (SIZES_ITSELF) return;
    const scroller = area.closest('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    area.style.height = 'auto';
    area.style.height = area.scrollHeight + 'px';
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  }

  /* A text box can only draw all its words one way, so what it can't draw itself is drawn under it, in a see-through
     copy of its words that wraps just as the box does, every letter right under the box's own (styles.css:
     .blank-shade): **bold** (its letters drawn again with a thin outline, so the box's letters on top look bold),
     ++underline++ and ~~strikethrough~~ (lines under see-through letters), ==highlight== (a colour behind) and {{blanks}}
     (fill-in-the-blank cards: a soft wash and a dotted line). The box's letters stay over it (its own, or, while it's
     being written in, the ones a copy over it draws: see letters), so the caret and a selection are untouched, and the
     words stay plain text. Words without any marks make nothing; otherwise the copy is a line per line of the box, kept
     by its words, and only the lines that changed are made again, once a frame (at once while the copy over it draws
     its letters). */
  const shades = new WeakMap();   // a text box -> { el, lines: [{ key, node, drawn }], words }
  const SHADED = /\*\*|__|~~|\+\+|==|\{\{/;  // (words with none of these have nothing to draw)
  const SHADE_CLASS = { bold: 'shade-b', underline: 'shade-u', strike: 'shade-s', highlight: 'shade-hl' };
  const shading = new Set();      // the boxes whose copy catches up at the next frame
  let shadeFrame = 0;

  function shade(area) {
    const under = shades.get(area);
    if (!under || under.words === area.value) return;
    if (!under.lines.length && !SHADED.test(area.value) && !quickWords(area.value)) { under.words = area.value; return; }  // plain words: nothing
    shading.add(area);
    if (!shadeFrame) shadeFrame = requestAnimationFrame(shadeAll);
  }

  function shadeAll() {
    shadeFrame = 0;
    const boxes = [...shading];
    shading.clear();
    for (const area of boxes) if (area.isConnected) drawShade(area);
  }

  function drawShade(area) {
    const under = shades.get(area);
    const value = area.value;
    if (!under || under.words === value) return;
    under.words = value;
    if (!SHADED.test(value) && !quickWords(value)) {
      if (under.lines.length) { under.lines = []; V.clear(under.el); }
      under.el.hidden = true;
      return;
    }
    under.lines = relines(under.el, under.lines, lineKeys(value), shadeLine);
    under.el.hidden = !under.lines.some((line) => line.drawn);
  }

  /* Each line's key (for the copies of a box's words: shade, preview): its words, and whether it's in a ``` block
     (drawn plain there). */
  function lineKeys(value) {
    const keys = [];
    let fenced = false;
    for (const text of value.split('\n')) {
      const fence = FENCE.test(text);
      keys.push((fenced || fence ? '`' : ' ') + text);
      if (fence) fenced = !fenced;
    }
    return keys;
  }

  /* A copy's lines (`old`: [{ key, node }], in `holder`) made to match `keys`: the lines that stay the same at the
     start and at the end are kept as they are; the ones between are made again (`make(key, line)`, line: its place
     in the box). Returns the new list. */
  function relines(holder, old, keys, make) {
    let a = 0;
    while (a < old.length && a < keys.length && old[a].key === keys[a]) a++;
    let b = 0;
    while (b < old.length - a && b < keys.length - a && old[old.length - 1 - b].key === keys[keys.length - 1 - b]) b++;
    const made = keys.slice(a, keys.length - b).map((key, k) => make(key, a + k));
    for (const line of old.slice(a, old.length - b)) line.node.remove();
    const room = document.createDocumentFragment();
    room.append(...made.map((line) => line.node));
    holder.insertBefore(room, b ? old[old.length - b].node : null);
    return [...old.slice(0, a), ...made, ...old.slice(old.length - b)];
  }

  /* One line of the copy: its words as the box has them, the marked ones in spans (js/format.js: pieces, just as the
     Read view reads them; nothing in `code`, a link's address or a ``` block). */
  function shadeLine(key) {
    const text = key.slice(1);
    let drawn = false;
    const draw = (list, from, to) => {
      const out = [];
      const add = (item) => {
        if (typeof item !== 'string') out.push(item);
        else if (item && typeof out[out.length - 1] === 'string') out[out.length - 1] += item;
        else if (item) out.push(item);
      };
      let at = from;
      for (const piece of list) {
        add(text.slice(at, piece.start));
        const cls = SHADE_CLASS[piece.kind];
        if (piece.kind === 'blank') {
          drawn = true;
          add(V.h('span.blank-mark', {}, text.slice(piece.start, piece.from), draw(piece.kids, piece.from, piece.to),
            text.slice(piece.to, piece.end)));
        } else if (cls || piece.kids.length) {  // (italic isn't drawn here: its marks show it; the Read view slants it)
          if (cls) drawn = true;
          add(text.slice(piece.start, piece.from));
          const inside = draw(piece.kids, piece.from, piece.to);
          if (cls) add(V.h('span.' + cls, {}, inside)); else inside.forEach(add);
          add(text.slice(piece.to, piece.end));
        } else add(text.slice(piece.start, piece.end));
        at = piece.end;
      }
      add(text.slice(at, to));
      return out;
    };
    const kids = key[0] === '`' || !SHADED.test(text) ? [text] : draw(V.format.pieces(text, true), 0, text.length);
    const node = V.h('div', {}, kids);
    // Quick read's soft colour behind the first letters of each word (js/reading.js; the copy over the box draws them
    // heavier, see lettersLine)
    if (V.reading.wrapLine(node, quickRanges(key), 'shade-q')) drawn = true;
    return { key, drawn, node };
  }

  /* -- the letters drawn over the box being written in

     A text box holds every line between two headings or tick-box items (see parse), so one box is often most of a note.
     While it's being written in, only the line with the caret (or the lines with the words picked) shows its marks,
     faintly (on a touch screen not even that line: styles.css); every other line shows its words styled, the marks out
     of sight. A box can only draw all its letters one way, so while it has the caret and its words have marks, it draws
     none of its own (styles.css: .lettered) and a copy over it draws them all (.block-letters), every letter just where
     the box puts it: the marks are there too, see-through but taking their room, so the caret, a tap, the words picked,
     the phone keyboard's word and the spelling lines all stay exactly where the box has them. The copy lies over the
     box, not under it, so nothing the box paints (the words picked, the keyboard's word, a word found with Ctrl+F) can
     cover the letters, and it draws nothing behind them, so the caret and all that still show through; what's drawn
     behind words (highlights, blanks, underlines) is still the copy under the box (see shade). It also draws the line
     under the word the phone's keyboard is writing: the box draws that line in its letters' colour, see-through now.
     Its lines are kept by their words, and the ones that changed are made again the moment the words change, before the
     screen is drawn again, so no letter is ever missing. With Windows' high contrast colours, the box draws its own
     letters as ever. */
  const letters = new WeakMap();  // a text box -> { el, lines: [{ key, node, marks }], words, on, lit, litNodes, ime, imeAt }
  const IME = '\u0001';            // (a line's key with the keyboard's word in it: IME + "start,end" + IME + its key)
  const FORCED = window.matchMedia ? matchMedia('(forced-colors: active)') : null;  // (Windows' high contrast colours)
  const highContrast = () => !!FORCED && FORCED.matches;

  /* The box got the caret (`fresh`), or its words changed while it has it: its letters are drawn over it from now on
     if its words have marks to hide (as they had when it got the caret, or as typed since). */
  function lettersUp(area, fresh) {
    const field = area.parentElement;
    let state = letters.get(area);
    if (!field || highContrast()) return;
    if (!state || !state.on) {
      const value = area.value;
      const quick = quickWords(value);  // (Quick read: every word's first letters are drawn heavier, always by the copy)
      if (!HIDES.test(value) && !quick) return;  // (none of the letters marks are made of)
      const view = previews.get(area);
      // (got the caret: its formatted copy knows whether anything is out of sight there; typing: only real-looking pairs)
      if (!quick && (fresh ? view && view.words === value && !view.el : !SHADED.test(value))) return;
    }
    state = drawLetters(area);
    if (state.on || !state.lines.some((line) => line.marks)) return;
    state.on = true;
    drawShade(area);  // (the copy under it, at the same moment)
    state.el.hidden = false;
    field.classList.add('lettered');
  }

  /* The box lost the caret: it draws its own letters again. */
  function lettersDown(area) {
    const state = letters.get(area);
    if (!state || !state.on) return;
    state.on = false;
    state.ime = null;
    state.el.hidden = true;
    if (area.parentElement) area.parentElement.classList.remove('lettered');
  }

  /* The copy over a box made to match its words (only the lines that changed), the keyboard's word and the caret's
     lines. */
  function drawLetters(area) {
    let state = letters.get(area);
    if (!state) {
      state = { el: V.h('div.block-letters', { 'aria-hidden': 'true', inert: true, hidden: true }), lines: [], words: null,
        on: false, lit: [-1, -1], litNodes: new Set(), ime: null, imeAt: '' };
      letters.set(area, state);
    }
    if (state.el.parentNode !== area.parentElement) area.after(state.el);
    const value = area.value;
    const lit = litLines(area);
    const ime = state.ime ? imeRange(value, state.ime, area.selectionEnd) : null;
    const imeAt = ime ? ime.join(',') : '';
    if (state.words !== value || state.imeAt !== imeAt) {
      state.words = value;
      state.imeAt = imeAt;
      state.lines = relines(state.el, state.lines, lettersKeys(value, ime),
        (key, line) => lettersLine(key, line >= lit[0] && line <= lit[1]));
    }
    relight(state, lit);
    if (state.on) drawShade(area);  // (the copy under it keeps up at the same moment)
    return state;
  }

  /* The lines (the first and the last) with the caret or the words picked; words picked up to the very start of a line
     leave that line out. */
  function litLines(area) {
    const value = area.value;
    const start = Math.min(area.selectionStart, value.length);
    const end = Math.min(area.selectionEnd, value.length);
    const upTo = Math.max(start, end > start && value[end - 1] === '\n' ? end - 1 : end);
    let first = 0;
    let line = 0;
    for (let at = value.indexOf('\n'); at >= 0 && at < upTo; at = value.indexOf('\n', at + 1)) {
      line++;
      if (at < start) first = line;
    }
    return [first, line];
  }

  /* The caret's lines show their marks (faintly), the others don't. Only the lines that change are touched. */
  function relight(state, lit) {
    const want = new Set();
    for (let line = Math.max(0, lit[0]); line <= lit[1] && line < state.lines.length; line++) want.add(state.lines[line].node);
    for (const node of state.litNodes) {
      if (!want.has(node) && node.isConnected && node.classList.contains('lit')) node.classList.remove('lit');
    }
    for (const node of want) if (!node.classList.contains('lit')) node.classList.add('lit');
    state.litNodes = want;
    state.lit = lit;
  }

  /* Each line's key (see lineKeys), the keyboard's word (`ime`: [start, end] in the words) put in the ones it's on. */
  function lettersKeys(value, ime) {
    const keys = lineKeys(value);
    if (!ime) return keys;
    let start = 0;
    keys.forEach((key, line) => {
      const end = start + key.length - 1;
      const a = Math.max(ime[0], start);
      const b = Math.min(ime[1], end);
      if (b > a) keys[line] = IME + (a - start) + ',' + (b - start) + IME + key;
      start = end + 1;
    });
    return keys;
  }

  /* One line of the copy over the box: its words as the box has them, each run in a span saying how it's drawn (b:
     bold, mark: a mark, soft: a link's brackets and address, code's backticks or italic's marks, always faint, ime: the
     keyboard's word, underlined). `lit`: the caret's line. `marks`: something in it looks other than the box's own. */
  function lettersLine(key, lit) {
    const whole = key;
    let ime = null;
    if (key[0] === IME) {
      const end = key.indexOf(IME, 1);
      ime = key.slice(1, end).split(',').map(Number);
      key = key.slice(end + 1);
    }
    const text = key.slice(1);
    const runs = [];  // [from, to, look]
    let marks = false;
    const add = (from, to, look) => { if (to > from) runs.push([from, to, look]); };
    const walk = (list, from, to, look) => {
      let at = from;
      for (const piece of list) {
        add(at, piece.start, look);
        if (piece.kind === 'url') add(piece.start, piece.end, look);
        else if (piece.kind === 'code' || piece.kind === 'link') {
          marks = true;
          add(piece.start, piece.from, look + ' lt-soft');
          if (piece.kind === 'link') walk(piece.kids, piece.from, piece.to, look); else add(piece.from, piece.to, look);
          add(piece.to, piece.end, look + ' lt-soft');
        } else {
          // (italic stays upright, its marks faint: slanted letters are shaped apart from the rest, a hair off the box's)
          const mark = look + (piece.kind === 'italic' ? ' lt-soft' : ' lt-mark');
          marks = true;
          add(piece.start, piece.from, mark);
          walk(piece.kids, piece.from, piece.to, piece.kind === 'bold' ? look + ' lt-b' : look);
          add(piece.to, piece.end, mark);
        }
        at = piece.end;
      }
      add(at, to, look);
    };
    if (key[0] === '`' || !HIDES.test(text)) add(0, text.length, '');
    else walk(V.format.pieces(text, true), 0, text.length, '');
    // The runs as text and spans, the keyboard's word cut out of them; runs drawn alike next to each other are one.
    const node = V.h('div' + (lit ? '.lit' : ''));
    let run = null;  // [words, look]
    const put = () => { if (run) node.append(run[1] ? V.h('span.' + run[1].trim().split(/\s+/).join('.'), {}, run[0]) : run[0]); };
    for (const [from, to, look] of runs) {
      const cuts = ime ? [from, Math.min(Math.max(ime[0], from), to), Math.min(Math.max(ime[1], from), to), to] : [from, to];
      for (let k = 0; k + 1 < cuts.length; k++) {
        if (cuts[k + 1] <= cuts[k]) continue;
        const words = text.slice(cuts[k], cuts[k + 1]);
        const shown = ime && k === 1 ? look + ' lt-ime' : look;
        if (run && run[1] === shown) run[0] += words;
        else { put(); run = [words, shown]; }
      }
    }
    put();
    // Quick read: the first letters of each word drawn heavier (an outline, as bold is: never a wider letter)
    if (V.reading.wrapLine(node, quickRanges(key), 'lt-q')) marks = true;
    return { key: whole, node, marks };
  }

  /* Where the keyboard's word (`word`, as it last said it) is in `value`: where it has the caret (`at`) in it or at
     one end, [start, end]; null when it isn't there. */
  function imeRange(value, word, at) {
    const start = value.lastIndexOf(word, at);
    return start >= 0 && start + word.length >= at ? [start, start + word.length] : null;
  }

  /* The phone keyboard's word as it's written (compositionupdate says it whole each time; null: done). The words change
     next, and the copy with them at once; a word taken up again just as it was changes nothing, so it's drawn at the
     next frame too. */
  function imeWord(area, word) {
    const state = letters.get(area);
    if (!state) return;
    state.ime = word || null;
    if (!state.on) return;
    if (word) lettersSoon(); else drawLetters(area);
  }

  /* The caret moved (or the keyboard's word was taken up): the copy over the box with the caret catches up at the next
     frame. */
  let lettersFrame = 0;
  function lettersSoon() {
    if (lettersFrame) return;
    lettersFrame = requestAnimationFrame(() => {
      lettersFrame = 0;
      const area = document.activeElement;
      const state = area && letters.get(area);
      if (state && state.on) drawLetters(area);
    });
  }

  /* -- the words shown formatted while a box isn't being written in */

  /* A box that isn't being written in shows its words formatted, just as the Read view shows them (js/format.js:
     inline, the very same pieces): bold, italic, underline, struck out, highlighted, `code`, links and {{blanks}}, the
     marks round them out of sight, in a copy that takes the box's place (styles.css: .block-preview). The box itself
     lies over the copy, invisible but still there: a tap lands in it, Tab and the arrows go into it, and screen readers
     read it as ever. The box with the caret shows its words as written, so typing, the phone keyboard's word, picking
     words, Undo and the buttons work there just as before; only the caret's own line shows its marks (faintly), the
     others' are out of sight but keep their room (see letters: a text box holds every line between two headings or
     tick-box items). A tap on the formatted words puts the caret on the same letter in the words as written, and the
     tapped line stays where it was on the screen (presses of every other kind too: see pressed). Words with no marks to
     hide make nothing. The copy is a line per line of the box, kept by its words; the box being written in has its
     copy made again only once it's left. */
  const previews = new WeakMap();  // a text box -> { el (null: nothing to hide), lines: [{ key, node, drawn }], words }
  const places = new WeakMap();    // a piece of text in a copy of a box's words -> { col }: where in its line it starts
  const HIDES = /[*_~+=`[{]/;      // (words with none of these have no marks to hide)
  const LETTERS = /[\p{L}\p{N}]/u;

  /* Quick read (js/reading.js) in the note open's boxes: the first letters of each word drawn heavier on a soft
     colour, in the formatted copy (preview), and in the box being written in by its copies (heavier in the copy over
     it, the colour in the copy under it), never a letter wider. Never in a locked note. */
  const quickNow = () => !!V.reading && V.reading.quickOn() && !!note && !note.locked;
  const quickWords = (value) => quickNow() && LETTERS.test(value);
  const quickLook = () => (quickNow() ? V.reading.look() : '');

  /* Where Quick read's pieces go in one line of a box's words as written (`key`, see lineKeys): the first letters of
     its words, but none in a ``` block, the line's own mark ("- ", "1. "), `code` or a link (its words or address). */
  function quickRanges(key) {
    if (key[0] === '`' || !quickNow()) return [];
    const text = key.slice(1);
    if (!LETTERS.test(text)) return [];
    const lead = V.format.lead(text);
    const skip = lead ? [[0, lead]] : [];
    const look = (list) => {
      for (const piece of list) {
        if (piece.kind === 'url' || piece.kind === 'code' || piece.kind === 'link') skip.push([piece.start, piece.end]);
        else if (piece.kids) look(piece.kids);
      }
    };
    look(V.format.pieces(text, true));
    return V.reading.ranges(text).filter(([a, b]) => !skip.some(([from, to]) => a < to && b > from));
  }
  const previewing = new Set();    // the boxes whose formatted copy catches up at the next frame
  let previewFrame = 0;
  let spare = null;                // while drawBlocks runs: the copies of the boxes going, by their words

  function preview(area) {
    const view = previews.get(area);
    if (view ? view.words === area.value : !HIDES.test(area.value) && !quickWords(area.value)) return;
    if (asWritten(area)) return;  // (made again once it's left)
    previewing.add(area);
    if (!previewFrame) previewFrame = requestAnimationFrame(previewAll);
  }

  function previewAll() {
    previewFrame = 0;
    const boxes = [...previewing];
    previewing.clear();
    for (const area of boxes) if (area.isConnected) setLook(area);
  }

  /* A new box's formatted copy, at once (the note opens, or is drawn again, with its words formatted from the first
     frame): the one a box going had for the very same words, else made now. */
  function firstPreview(area) {
    const kept = spare && spare.get(area.value);
    if (!kept) return drawPreview(area);
    spare.delete(area.value);
    previews.set(area, kept);
    return kept;
  }

  /* The formatted copy of a box's words, made to match them; null (and no copy kept, only the words looked at, so
     they aren't looked at again) when nothing in them would look any different. */
  function drawPreview(area) {
    const value = area.value;
    let view = previews.get(area);
    if (!view) {
      if (!HIDES.test(value) && !quickWords(value)) return null;
      view = { el: null, lines: [], words: null, look: quickLook() };
      previews.set(area, view);
    }
    if (view.words !== value) {
      view.words = value;
      // (not inert, unlike the other copies: the browser's Find looks for words only in what isn't, and the box over it,
      // out of sight, would show nothing it finds there; screen readers read the box, never this)
      if (!view.el) view.el = V.h('div.block-preview', { 'aria-hidden': 'true', hidden: true });
      view.lines = relines(view.el, view.lines, lineKeys(value), previewLine);
      if (!view.lines.some((line) => line.drawn)) {
        view.el.remove();
        view.el = null;
        view.lines = [];
      }
    }
    return view.el ? view : null;
  }

  /* A piece of a copy's text, `col` letters into its line. */
  const placed = (text, col) => {
    const node = document.createTextNode(text);
    places.set(node, { col });
    return node;
  };

  /* One line of the formatted copy: its own mark ("- ", "1. ", "> ") as written, then its words the Read view's way.
     `drawn`: some marks are out of sight in it (a link written out in full hides nothing). */
  function previewLine(key) {
    const text = key.slice(1);
    const quick = quickNow() && LETTERS.test(text);
    if (key[0] === '`' || (!HIDES.test(text) && !quick)) return { key, drawn: false, node: V.h('div', {}, text ? placed(text, 0) : null) };
    const lead = V.format.lead(text);
    const kids = V.format.inline(text.slice(lead), 0, lead, places, true);
    const shown = kids.reduce((sum, kid) => sum + kid.textContent.length, 0);
    // (the line's own mark, "- " or "1. ", never gets Quick read's pieces)
    const mark = lead ? placed(text.slice(0, lead), 0) : null;
    const node = V.h('div', {}, mark && quick ? V.h('span.no-quick', {}, mark) : mark, kids);
    for (const link of node.querySelectorAll('a')) link.tabIndex = -1;  // (Tab goes into the box, never a link of its copy)
    const quicked = quick ? V.reading.quick(node, places) : 0;  // (each piece keeps its place in the line: see places)
    return { key, drawn: shown < text.length - lead || quicked > 0, node };
  }

  /* A box shows its words as written while it has the caret, and while words are dragged over it (so they drop just
     where it shows: see dragIn). */
  let dropInto = null;
  const asWritten = (area) => document.activeElement === area || dropInto === area;
  const isPreviewing = (area) => !!area.parentElement && area.parentElement.classList.contains('previewing');

  /* A box shows its words formatted, or as written while it has the caret (only the caret's lines with their marks
     showing, see letters). */
  function setLook(area) {
    const field = area.parentElement;
    if (!field) return;
    const writing = asWritten(area);
    if (document.activeElement === area) lettersUp(area, true); else lettersDown(area);
    const view = writing ? previews.get(area) : drawPreview(area);
    const copy = view && view.el;
    if (copy && copy.parentNode !== field) field.append(copy);
    const on = !!copy && !writing;
    if (copy && copy.hidden === on) copy.hidden = !on;
    if (field.classList.contains('previewing') === on) return;
    field.classList.toggle('previewing', on);
    if (!on) grow(area);  // (a box measured while it lay over its copy takes its own height again)
  }

  /* The boxes that lost (or got) the caret change their look together once the caret has settled, so a word the
     keyboard finished, which takes the caret away and gives it back at once, changes nothing. What stays where it was
     on the screen meanwhile: the box the caret went to (`to`: what the browser said gets the focus next); with none
     (the phone's keyboard put away, a click on nothing), the words being read: the letter the caret was at when it's
     in sight, else the first block in sight, or, when that's a box changing its look (a long one, its top far above
     the screen), the first of its lines in sight. (A box's top kept in place while the lines above the ones being
     read lose the rows their marks took would move those up the screen.) */
  const looking = new Set();
  let lookTo = null;
  let lookQueued = false;

  function lookSoon(area, to) {
    looking.add(area);
    if (to) lookTo = to;
    if (lookQueued) return;
    lookQueued = true;
    queueMicrotask(() => { lookQueued = false; settle(); });
  }

  /* `keep`: the block (or box) that stays put on the screen. */
  function settle(keep = null) {
    const boxes = [...looking].filter((area) => area.isConnected);
    const to = lookTo;
    looking.clear();
    lookTo = null;
    if (!boxes.length || !el || !parts.blocks || !parts.blocks.isConnected) return;
    const scroller = parts.blocks.closest('.editor-scroll');
    const active = document.activeElement;
    let anchor = keep || (active && el.contains(active) && active.matches('.block-input') ? active
      : to && to.isConnected && scroller && scroller.contains(to) ? to : null);
    if (anchor && anchor.matches('.block-input')) anchor = anchor.parentElement;
    let reading = null;
    if (!anchor && scroller) {
      // (words with no marks look the same either way, unless Quick read draws them)
      const changing = boxes.filter((area) => HIDES.test(area.value) || quickWords(area.value));
      for (const area of changing) if ((reading = readingSpot(area, scroller, true))) break;
      if (!reading) {
        anchor = firstInSight(scroller);
        const inside = anchor && changing.find((area) => anchor.contains(area));
        if (inside && (reading = readingSpot(inside, scroller, false))) anchor = null;
      }
    }
    const top = anchor ? anchor.getBoundingClientRect().top : 0;
    for (const area of boxes) setLook(area);
    let moved = anchor ? anchor.getBoundingClientRect().top - top : 0;
    if (reading) {
      const now = shownTop(reading.area, reading.line, reading.char);
      moved = now === null ? 0 : now - reading.top;
    }
    if (moved && scroller) scroller.scrollTop += moved;
  }

  /* The letter being read in a box that's in sight, as it shows now: { area, line, char, top } (char: a place in the
     line's words as written, -1 on an empty line; top: where it is on the screen), or null. The caret's letter when
     it's in sight; else (unless `caretOnly`) the first line starting in sight, or the letter at the top of the screen
     when one long line fills it. */
  function readingSpot(area, scroller, caretOnly) {
    const sight = scroller.getBoundingClientRect();
    const box = area.parentElement.getBoundingClientRect();
    if (box.bottom <= sight.top || box.top >= sight.bottom) return null;
    const shown = laidOut(area);
    if (!shown) return null;
    const rows = shown.rows;
    const inSight = (top) => top !== null && top >= sight.top && top < sight.bottom;
    const value = area.value;
    const at = Math.min(area.selectionStart || 0, value.length);
    const start = value.lastIndexOf('\n', at - 1) + 1;
    const line = value.slice(0, start).split('\n').length - 1;
    let spot = { line, char: at - start, top: letterTop(rows, line, at - start) };
    if (!inSight(spot.top)) {
      spot = null;
      if (!caretOnly) {
        // The first line whose top is in sight (they're in order down the box, so it's looked for by halves).
        const list = rows.children;
        let low = 0;
        let high = list.length - 1;
        let first = -1;
        while (low <= high) {
          const mid = (low + high) >> 1;
          if (list[mid].getBoundingClientRect().top >= sight.top) { first = mid; high = mid - 1; } else low = mid + 1;
        }
        const top = first < 0 ? null : letterTop(rows, first, 0);
        if (inSight(top)) spot = { line: first, char: 0, top };
        else {
          const found = placeAt(rows, box.left + 1, Math.max(sight.top, box.top) + 1);
          if (found) spot = { line: found.line, char: found.char, top: found.top };
        }
      }
    }
    if (shown.made) rows.remove();
    return spot && { area, ...spot };
  }

  /* A copy of a box's words laid out as the box shows them now, a line per child: its formatted copy while it shows
     that, else a copy of its words as written made now (`made`: whoever asked takes it away). Null when none can be
     laid out. */
  function laidOut(area) {
    const view = previews.get(area);
    if (isPreviewing(area) && view && view.el) return { rows: view.el, made: false };
    const copy = copyOf(area);
    return copy && { rows: copy, made: true };
  }

  /* Where the letter at `char` on line `line` of a box's words is on the screen now (its top), however the box shows
     them. */
  function shownTop(area, line, char) {
    const shown = laidOut(area);
    if (!shown) return null;
    const top = letterTop(shown.rows, line, char);
    if (shown.made) shown.rows.remove();
    return top;
  }

  /* The letter at `spot` (line, char, top: where it was on the screen) put back where it was: the note scrolled by as
     far as it moved when the box changed its look. */
  function keepSpot(area, spot) {
    const scroller = area.closest('.editor-scroll');
    const now = scroller ? shownTop(area, spot.line, spot.char) : null;
    if (now !== null && now !== spot.top) scroller.scrollTop += now - spot.top;
  }

  /* The first block in sight in the note (they're in order down the page, so it's looked for by halves). */
  function firstInSight(scroller) {
    const list = parts.blocks.children;
    const top = scroller.getBoundingClientRect().top;
    let low = 0;
    let high = list.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].getBoundingClientRect().bottom > top) { found = list[mid]; high = mid - 1; } else low = mid + 1;
    }
    return found;
  }

  /* Presses on a box's formatted words. The box lies over its formatted copy, but its words as written sit elsewhere in
     it (the marks push them along), so whatever the browser would do there itself (put the caret, pick a word, open
     its menu at a place) would land on other words than the ones under the finger. So each press is worked out on the
     formatted copy, while it's still showing: where it lands in the words as written (`place`: { line, col, char, top,
     on } from placeAt, `at`: the caret's place, `letter`: the pressed letter's place, null on an empty line, `words`).
     A long press sends no mousedown, only the browser's own picking of a word and then a contextmenu, so where every
     press went down is kept (pointerdown) and worked out the moment the box gets the caret. */
  let pressed = null;   // the last press on a box: { area, x, y, touch, time, formatted, place (null until worked out) }
  let tapped = null;    // the last mouse click worked out (for a double click on the same spot)
  const PRESS_KEPT = 1500;  // ms a press counts for (a long press, a double or triple click)
  const STILL = 4;          // px a click may move and still be a click
  const EDGE = 24;          // px from the note's top or bottom edge where a mouse picking words scrolls it on

  function pressDown(event, area) {
    pressed = { area, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse', time: performance.now(),
      formatted: isPreviewing(area), place: null };
  }

  /* Where a point on a box's formatted copy lands in its words as written (null when there's no copy). */
  function mapPoint(area, x, y) {
    const view = previews.get(area);
    const spot = view && view.el ? placeAt(view.el, x, y) : null;
    if (!spot) return null;
    const value = area.value;
    return { ...spot, at: placeIn(value, spot), letter: spot.char < 0 ? null : placeIn(value, { line: spot.line, col: spot.char }), words: value };
  }

  /* The box gets the caret: a press on its formatted words not worked out yet (a long press: the browser's own) is
     worked out first, and the pressed line stays where it was as the box shows its words as written. Got without a
     press (the arrow keys or Backspace from the box below, Tab), the caret's own letter stays where it was when it's in
     sight: the box grows down from its top as the marks take their room again, which would move the line the caret
     came to (and every line under it) down the screen. */
  function gotCaret(area) {
    const press = pressed;
    const pressing = !!press && press.area === area && press.formatted && performance.now() - press.time < PRESS_KEPT;
    const fresh = pressing && !press.place && isPreviewing(area);
    if (fresh) press.place = mapPoint(area, press.x, press.y);
    const scroller = !pressing && isPreviewing(area) ? area.closest('.editor-scroll') : null;
    const caret = scroller ? readingSpot(area, scroller, true) : null;
    setLook(area);
    if (fresh && press.place) keepSpot(area, press.place);
    if (caret) keepSpot(area, caret);
  }

  /* Code put the caret (or the words picked) somewhere in the box with the caret: its lines show their marks at once,
     not a frame later (when the browser says the caret moved). */
  function relit(area) {
    const state = letters.get(area);
    if (state && state.on && document.activeElement === area) drawLetters(area);
  }

  /* A tap (or a click, left or right) on a box's formatted words: the caret goes on the same letter in its words as
     written, and the tapped line stays where it was on the screen. A mouse held down and moved from there picks words;
     a double click picks the word pressed, a triple click its line (see pickAgain). */
  function tapPreview(event, area) {
    const field = area.parentElement;
    if (!field) return;
    if (event.button === 0 && event.detail > 1 && pickAgain(event, area)) return;
    tapped = null;
    const view = previews.get(area);
    if ((event.button !== 0 && event.button !== 2) || !isPreviewing(area) || !view || !view.el) return;
    const place = mapPoint(area, event.clientX, event.clientY);
    if (!place) return;
    event.preventDefault();
    const touch = !!(event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents);
    const press = { area, x: event.clientX, y: event.clientY, touch, time: performance.now(), formatted: true, place };
    pressed = press;
    area.setSelectionRange(place.at, place.at);  // (first too, so the box shows this line's marks from the start)
    area.focus({ preventScroll: true });
    area.setSelectionRange(place.at, place.at);
    relit(area);
    settle(field);  // the box the caret left shows its words formatted again; this one stays put meanwhile
    keepSpot(area, place);
    if (touch || event.button !== 0) return;  // (a tap, or a right click: its menu comes next, see menuOn)
    tapped = press;
    // Held down and moved, the mouse picks words: from the letter pressed to the one under the pointer in the words as
    // the box shows them now (as written: the pressed line kept where it was), laid out in a copy made when the mouse
    // first moves, so the words picked are the ones it passes over on the screen; and only once it has moved a few
    // pixels, as a click nearly always moves a pixel or two (words picked by it would go with the next key). Held
    // above or below the note, the note scrolls on, the words picked with it.
    const value = area.value;
    const scroller = area.closest('.editor-scroll');
    let rows = null;
    let last = null;
    let rolling = 0;
    const pick = () => {
      if (!last || area.value !== value || document.activeElement !== area) return;
      if (!rows) rows = copyOf(area);
      const to = rows && placeAt(rows, last.clientX, last.clientY);
      if (!to) return;
      const end = placeIn(value, to);
      area.setSelectionRange(Math.min(place.at, end), Math.max(place.at, end), end < place.at ? 'backward' : 'forward');
      relit(area);
    };
    const roll = () => {
      rolling = 0;
      if (!last || !scroller) return;
      const sight = scroller.getBoundingClientRect();
      const by = last.clientY < sight.top + EDGE ? last.clientY - sight.top - EDGE
        : last.clientY > sight.bottom - EDGE ? last.clientY - sight.bottom + EDGE : 0;
      if (!by) return;
      const was = scroller.scrollTop;
      scroller.scrollTop += Math.max(-40, Math.min(40, by / 2));
      if (scroller.scrollTop === was) return;
      pick();
      rolling = requestAnimationFrame(roll);
    };
    const drag = (moved) => {
      if (!(moved.buttons & 1)) { done(); return; }
      if (!last && Math.abs(moved.clientX - event.clientX) <= STILL && Math.abs(moved.clientY - event.clientY) <= STILL) return;
      last = moved;
      pick();
      if (!rolling) rolling = requestAnimationFrame(roll);
    };
    const done = () => {
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', done);
      if (rolling) cancelAnimationFrame(rolling);
      rolling = 0;
      last = null;
      if (rows) rows.remove();
    };
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', done);
  }

  /* The second (or third) press of a click on formatted words: the first one showed the words as written, which moved
     them along under the pointer, so the browser would pick whichever word is there now. Instead the word around the
     letter first clicked is picked (the line on a triple click). False when it isn't such a press. */
  function pickAgain(event, area) {
    const tap = tapped;
    if (!tap || tap.area !== area || document.activeElement !== area || area.value !== tap.place.words) return false;
    if (performance.now() - tap.time > PRESS_KEPT || Math.abs(event.clientX - tap.x) > 2 * STILL
      || Math.abs(event.clientY - tap.y) > 2 * STILL) return false;
    event.preventDefault();
    const { at, letter } = tap.place;
    const [from, to] = letter === null ? [at, at] : event.detail === 2 ? wordAround(area.value, letter) : lineAround(area.value, letter);
    area.setSelectionRange(from, to);
    relit(area);
    return true;
  }

  /* The browser's menu for a box (a right click, or a long press on a phone) opened by a press on its formatted
     words: it acts on the place pressed. A long press picks the word pressed (as a phone does), a right click leaves
     the caret where tapPreview put it (so Paste goes there). */
  function menuOn(event, area) {
    const press = pressed;
    if (!press || press.area !== area || !press.formatted || performance.now() - press.time > PRESS_KEPT) return;
    if (Math.abs(event.clientX - press.x) > 4 * STILL || Math.abs(event.clientY - press.y) > 4 * STILL) return;
    if (document.activeElement !== area) area.focus({ preventScroll: true });  // (gotCaret works the press out)
    const place = press.place;
    if (!place || area.value !== place.words) return;
    if (press.touch && place.letter !== null && place.on) area.setSelectionRange(...wordAround(area.value, place.letter));
    else area.setSelectionRange(place.at, place.at);
    relit(area);
  }

  /* Words dragged over a box showing them formatted: it shows them as written until they're dropped or dragged away,
     so the browser's drop place (worked out on the words as written) is the one it shows; the line under the pointer
     stays where it was. (Files dropped are the note's attachments: nothing changes for them.) */
  function dragIn(event, area) {
    const types = event.dataTransfer ? [...event.dataTransfer.types] : [];
    if (!isPreviewing(area) || types.includes('Files') || !types.includes('text/plain')) return;
    const place = mapPoint(area, event.clientX, event.clientY);
    dropInto = area;
    setLook(area);
    if (place) keepSpot(area, place);
  }

  /* `later`: dropped (the browser puts the words in after the drop event, on the words as written). */
  function dragOut(area, later) {
    if (dropInto !== area) return;
    const back = () => {
      if (dropInto === area) dropInto = null;
      lookSoon(area);
    };
    if (later) setTimeout(back); else back();
  }

  /* The word (or the run of spaces, or the mark) the letter at `at` of `value` is part of, as a double click picks
     one: [start, end]. */
  function wordAround(value, at) {
    const start = value.lastIndexOf('\n', at - 1) + 1;
    const found = value.indexOf('\n', at);
    const line = value.slice(start, found < 0 ? value.length : found);
    const k = Math.min(at - start, Math.max(0, line.length - 1));
    const part = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }).segment(line).containing(k) : null;
    if (part) return [start + part.index, start + part.index + part.segment.length];
    const kind = (c) => (/[\p{L}\p{N}_']/u.test(c) ? 1 : /\s/.test(c) ? 2 : 3);
    const own = kind(line[k] || ' ');
    let a = k;
    let b = Math.min(k + 1, line.length);
    while (a > 0 && kind(line[a - 1]) === own) a--;
    while (b < line.length && kind(line[b]) === own) b++;
    return [start + a, start + b];
  }

  /* The line of `value` the letter at `at` is on: [start, end]. */
  function lineAround(value, at) {
    const found = value.indexOf('\n', at);
    return [value.lastIndexOf('\n', at - 1) + 1, found < 0 ? value.length : found];
  }

  /* A place found by placeAt as a place in the box's words. */
  function placeIn(value, spot) {
    let start = 0;
    for (let i = 0; i < spot.line; i++) start = value.indexOf('\n', start) + 1;
    const found = value.indexOf('\n', start);
    const end = found < 0 ? value.length : found;
    return start + Math.min(spot.col, end - start);
  }

  /* The place nearest (x, y) on the screen in a copy of a box's words (`rows`: a line per child): { line, col, char,
     top, on }: its line, how far into it, and the letter there (-1 on an empty line), whose top is `top`, and whether
     (x, y) is on that very letter. Left of a line's first letter is the line's start and right of its last is its end,
     outside any marks there. */
  function placeAt(rows, x, y) {
    let row = null;
    let line = -1;
    let far = Infinity;
    [...rows.children].forEach((child, i) => {
      const box = child.getBoundingClientRect();
      const off = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (off < far) { far = off; row = child; line = i; }
    });
    if (!row) return null;
    const letters = [];
    const range = document.createRange();
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      const place = places.get(node);
      if (!place) continue;
      for (let k = 0; k < node.length; k++) {
        range.setStart(node, k);
        range.setEnd(node, k + 1);
        const box = [...range.getClientRects()].find((r) => r.width > 0);
        if (box) letters.push({ char: place.col + k, box });
      }
    }
    if (!letters.length) return { line, col: 0, char: -1, top: row.getBoundingClientRect().top, on: false };
    // The row of letters (a line wraps into several) whose middle is nearest the tap, then the letter in it nearest.
    const middle = (box) => Math.abs(y - (box.top + box.bottom) / 2);
    const near = letters.reduce((a, b) => (middle(b.box) < middle(a.box) ? b : a));
    let best = null;
    let side = Infinity;
    for (const letter of letters) {
      const { box } = letter;
      if (box.bottom <= near.box.top || box.top >= near.box.bottom) continue;
      const off = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
      if (off < side) { side = off; best = letter; }
    }
    const { box } = best;
    let col = best.char + (x > (box.left + box.right) / 2 ? 1 : 0);
    if (best === letters[letters.length - 1] && x > box.right) col = Infinity;
    else if (best === letters[0] && x < box.left) col = 0;
    return { line, col, char: best.char, top: box.top, on: side === 0 && far === 0 };
  }

  /* An unseen copy of a box's words as written, laid out just as the box lays them out (like the copy under it, see
     shade: a line per line, but of its own kind, so Windows' high contrast colours, which hide that one, don't hide
     this), to find where its letters are; whoever asked takes it away again. Null when it can't be laid out. */
  function copyOf(area) {
    const copy = V.h('div.block-measure', { 'aria-hidden': 'true', inert: true },
      area.value.split('\n').map((line) => V.h('div', {}, line ? placed(line, 0) : null)));
    area.parentElement.append(copy);
    if (copy.getClientRects().length) return copy;
    copy.remove();
    return null;
  }

  /* The top of the letter at `char` (a place in the line's words as written) on line `line` of a copy of a box's words,
     either one: in the formatted copy, a mark there is out of sight, so it's the first letter shown after it. Past the
     line's end its last letter; the line's own top when it has none. */
  function letterTop(copy, line, char) {
    const row = copy.children[line];
    if (!row) return null;
    let found = null;
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while (char >= 0 && walk.nextNode()) {
      const node = walk.currentNode;
      const place = places.get(node);
      if (!place || !node.length) continue;
      found = [node, Math.min(Math.max(char - place.col, 0), node.length - 1)];
      if (place.col + node.length > char) break;
    }
    if (!found) return row.getBoundingClientRect().top;
    const range = document.createRange();
    range.setStart(found[0], found[1]);
    range.setEnd(found[0], found[1] + 1);
    const rects = [...range.getClientRects()];
    const box = rects.find((r) => r.width > 0) || rects[0];
    return box ? box.top : row.getBoundingClientRect().top;
  }

  function focusBlock(index, where = 'end') {
    const fields = parts.blocks.querySelectorAll('.block-input');
    const field = fields[Math.max(0, Math.min(index, fields.length - 1))];
    if (!field) return;
    const at = Math.max(0, Math.min(where === 'start' ? 0 : where === 'end' ? field.value.length : where, field.value.length));
    // Focused without the browser scrolling to the box's old caret, then the view goes just as far as the new one. (The
    // caret is put there first too, so the box shows that line's marks, and keeps it in place, from the start: see
    // gotCaret.)
    field.setSelectionRange(at, at);
    field.focus({ preventScroll: true });
    field.setSelectionRange(at, at);
    relit(field);
    scrollToCaret(field, at);
  }

  /* Scrolls the note only as far as needed to show the caret at `at` in `field` (worked out from how far through
     the box's words it is). */
  function scrollToCaret(field, at) {
    const scroller = field.closest('.editor-scroll');
    if (!scroller) return;
    const box = field.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const share = field.value.length ? at / field.value.length : 0;
    const y = box.top + share * box.height;
    const line = 28;
    if (y + line > view.bottom) scroller.scrollTop += y + line - view.bottom + 8;
    else if (y - line < view.top) scroller.scrollTop -= view.top - (y - line) + 8;
  }

  /* Where the caret is, as a line and column of the note's text (the same however the note is drawn), or in the
     title; null when it's elsewhere. With words picked, where they end too (endLine, endCol), so Undo picks them
     again. */
  function caretSpot() {
    const active = document.activeElement;
    if (!el || !active || !el.contains(active)) return null;
    if (active === parts.title) return { title: true, at: active.selectionStart, end: active.selectionEnd };
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    const index = fields.indexOf(active);
    if (index < 0) return null;
    let line = 0;
    for (let i = 0; i < index; i++) line += oneLine(blocks[i]) ? 1 : blocks[i].text.split('\n').length;
    const at = (place) => {
      const before = active.value.slice(0, place).split('\n');
      return [line + before.length - 1, before[before.length - 1].length + prefix(blocks[index])];
    };
    const single = oneLine(blocks[index]);
    // A line's words as they are now (for a heading or an item, with its mark).
    const words = (lineAt) => (single ? serialize().split('\n')[line] : active.value.split('\n')[lineAt - line]);
    const [startLine, col] = at(active.selectionStart);
    const spot = { line: startLine, col, text: words(startLine) };
    if (active.selectionEnd > active.selectionStart) {
      [spot.endLine, spot.endCol] = at(active.selectionEnd);
      spot.endText = spot.endLine === startLine ? spot.text : words(spot.endLine);
    }
    return spot;
  }

  /* Puts the caret back at `spot` (and picks the words again up to its end), its line moved by `map` (a line of the
     old words to its line now, -1 if gone: then the end of the nearest line before it that stayed). */
  function placeCaret(spot, map) {
    if (!spot) return;
    if (spot.title) {
      parts.title.focus({ preventScroll: true });
      const at = Math.min(spot.at, parts.title.value.length);
      parts.title.setSelectionRange(at, Math.max(at, Math.min(spot.end ?? at, parts.title.value.length)));
      return;
    }
    const start = spotIn(spot.line, spot.col, spot.text, map);
    // (the end moves with its own line's words too, so the same words stay picked, never more)
    const end = typeof spot.endLine === 'number' ? spotIn(spot.endLine, spot.endCol, spot.endText ?? null, map) : null;
    focusBlock(start[0], start[1]);
    if (end && end[0] === start[0] && end[1] > start[1]) {
      const field = parts.blocks.querySelectorAll('.block-input')[start[0]];
      if (field) { field.setSelectionRange(start[1], Math.min(end[1], field.value.length)); relit(field); }
    }
  }

  /* A line and column of the note's text (the line moved by `map`) as [block, place in its box]. `text`: the line's
     words when the spot was taken (words added or taken away before it since move it along). */
  function spotIn(lineAt, colAt, text, map) {
    let line = map ? map(lineAt) : lineAt;
    let col = colAt;
    if (line < 0) {
      let k = lineAt - 1;
      while (k >= 0 && map(k) < 0) k--;
      line = k >= 0 ? map(k) : 0;
      col = k >= 0 ? Infinity : 0;
    } else if (typeof text === 'string') {
      // The line itself changed: words added or taken away before the caret move it along with its own words.
      const now = serialize().split('\n')[line];
      if (typeof now === 'string' && now !== text) {
        let same = 0;
        while (same < now.length && same < text.length && now[same] === text[same]) same++;
        if (col > same) col += now.length - text.length;
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const lines = oneLine(block) ? [block.text] : block.text.split('\n');
      if (line < lines.length || i === blocks.length - 1) {
        line = Math.min(line, lines.length - 1);
        if (oneLine(block)) return [i, Math.max(0, Math.min(col - prefix(block), block.text.length))];
        let at = 0;
        for (let k = 0; k < line; k++) at += lines[k].length + 1;
        return [i, at + Math.min(col, lines[line].length)];
      }
      line -= lines.length;
    }
    return [0, 0];
  }

  function drawBlocks(focus) {
    const scroller = parts.blocks.closest('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    lastField = null;
    composingField = null;  // a word being written in a box that goes ends without a word from the keyboard
    spare = new Map();  // (the boxes coming with the same words as boxes going take their formatted copies over)
    for (const area of parts.blocks.querySelectorAll('.block-input')) {
      const view = previews.get(area);
      // (only drawn the way they're drawn now: Quick read switched on or off draws them all again)
      if (view && view.el && view.words === area.value && view.look === quickLook()) spare.set(view.words, view);
    }
    V.clear(parts.blocks, blocks.map((block, index) => drawBlock(block, index)));
    spare = null;
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    if (focus) focusBlock(focus[0], focus[1]);  // at once, so the very next key lands in the right row
  }

  function drawBlock(block, index) {
    const area = V.h('textarea.block-input' + (block.type === 'heading' ? '.heading-input' : ''), {
      rows: 1, value: block.text, spellcheck: 'true', autocapitalize: 'sentences',
      placeholder: block.type === 'check' ? 'List item' : block.type === 'heading' ? 'Heading'
        : index === 0 && blocks.length === 1 ? 'Start writing...' : '',
      'aria-label': block.type === 'check' ? 'Checklist item' : block.type === 'heading' ? 'Heading' : 'Note text',
      oninput: (event) => {
        lastInput = event.inputType || '';
        // A new line in a list item or heading (a keyboard that skipped the Enter key below) is tidied once the word
        // is done: changing the words mid-word would break the keyboard's word.
        if (oneLine(block) && !event.isComposing && area.value.includes('\n')) {
          area.value = area.value.replace(/\n/g, ' ');
        }
        block.text = area.value; grow(area); saveSoon(); V.lock.touch();
        typed(block, area, event);
        tell('body', area, event);
      },
      onkeydown: (event) => keys(event, index, area),
      // Phone keyboards often send Enter as a typed new line rather than a key: in a list it still makes the next item.
      onbeforeinput: (event) => beforeInput(event, index, area),
      // Its words as written while it has the caret, else formatted (see preview), and presses on its formatted words
      // landing on the letters pressed (see pressed).
      onfocus: () => gotCaret(area),
      onblur: (event) => lookSoon(area, event.relatedTarget),
      // The caret's line shows its marks (see letters), and the keyboard's word is underlined in the copy over it.
      onkeyup: lettersSoon,
      onpointerup: lettersSoon,
      oncompositionupdate: (event) => imeWord(area, event.data),
      oncompositionend: () => imeWord(area, null),
      onpointerdown: (event) => pressDown(event, area),
      onmousedown: (event) => tapPreview(event, area),
      oncontextmenu: (event) => menuOn(event, area),
      ondragenter: (event) => dragIn(event, area),
      ondragleave: () => dragOut(area, false),
      ondrop: () => dragOut(area, true),
    });
    owner.set(area, block);
    // The box and the copy under it (see shade), together: the copy is placed over exactly the box. Its words shown
    // formatted (see preview) come after it, in its place while it isn't being written in.
    const under = V.h('div.blank-shade', { 'aria-hidden': 'true', inert: true, hidden: true });
    shades.set(area, { el: under, lines: [], words: '' });
    shade(area);
    const view = firstPreview(area);
    if (view) view.el.hidden = false;
    const field = V.h('div.block-field' + (view ? '.previewing' : ''), {}, under, area, view ? view.el : null);
    requestAnimationFrame(() => grow(area));
    const chips = V.h('div.link-chips', { hidden: true });
    chipRows.set(area, chips);
    drawChips(area, block);
    if (block.type === 'text') return V.h('div.block.text-block', {}, field, chips);
    if (block.type === 'heading') return V.h(`div.block.heading-block.h${block.level}`, {}, field, chips);
    const row = V.h('div.block.check-row' + (block.done ? '.done' : ''));
    const tick = V.h('button.tick', {
      type: 'button', 'aria-label': block.done ? 'Not done' : 'Done', 'aria-pressed': String(block.done),
      // Ticked where it is: rebuilding the rows would close the phone's keyboard.
      onclick: () => {
        checkpoint();
        block.done = !block.done;
        row.classList.toggle('done', block.done);
        tick.setAttribute('aria-pressed', String(block.done));
        tick.setAttribute('aria-label', block.done ? 'Not done' : 'Done');
        saveSoon();
        afterChange(true);
      },
    }, V.icon('check'));
    row.append(tick, field, V.h('button.remove-item', { type: 'button', 'aria-label': 'Remove item', tabindex: '-1',
      onclick: () => {
        // The caret stays with the words it was in (the mousedown kept it); none appears if there wasn't one, so
        // no keyboard pops up.
        checkpoint();
        const spot = caretSpot();
        const before = serialize();
        blocks.splice(index, 1);
        if (!blocks.length) blocks.push({ type: 'text', text: '' });
        merge();  // words either side of the item are one block again
        drawBlocks();
        if (spot) placeCaret(spot, V.mergeLines(before, before, serialize()).map);
        saveSoon();
        afterChange(true);
      } },
    V.icon('x')), chips);
    return row;
  }

  /* After the words in a box changed (typed, pasted, or by a button): its link chips, the count, Undo's next step,
     and the "# " / "[] " shortcuts. `event` is the input event (null for a change made here). A paste or a drop is an
     Undo step of its own (what was typed before it became one in beforeInput); its lines tidied into headings and
     items are the same words, so they come and go with it. */
  function typed(block, area, event) {
    const pasted = !!event && /^insertFrom/.test(event.inputType || '');
    // A paste's lines become headings and items before its Undo step is taken: the step is the words as they stay
    // (the raw lines, "* [ ] milk", would never match what's shown, and Undo would get stuck on them).
    const tidied = pasted && !event.isComposing && block.type === 'text' && tidy(blocks.indexOf(block));
    afterChange(!event || pasted);
    if (tidied || (event && event.isComposing)) return;  // (a word still being written: the rest waits for it)
    chipsSoon(area, block, !event || pasted);  // a pasted link shows its chip at once
    if (!event || pasted || block.type !== 'text') return;
    if (event.inputType === 'insertText' && / $/.test(event.data || '')) shortcut(blocks.indexOf(block), area);
  }

  /* `now`: the change was made here (a button, Enter), so it's an Undo step of its own at once; typing becomes one
     when it pauses. */
  function afterChange(now = false) {
    countSoon();
    if (now) checkpoint();
    else checkpointSoon();
    drawUndo();
  }

  /* A box's words changed by a button or Enter, as one small change (so the keyboard keeps its place), and the caret
     put at `start`-`end`. */
  function replaceValue(field, value, start, end = start) {
    const old = field.value;
    let a = 0;
    while (a < old.length && a < value.length && old[a] === value[a]) a++;
    let b = 0;
    while (b < old.length - a && b < value.length - a && old[old.length - 1 - b] === value[value.length - 1 - b]) b++;
    field.setRangeText(value.slice(a, value.length - b), a, old.length - b, 'preserve');
    field.setSelectionRange(start, end);
  }

  /* What follows a change made here to a box's words. */
  function changed(block, field) {
    block.text = field.value;
    grow(field);
    saveSoon();
    V.lock.touch();
    typed(block, field, null);
    scrollToCaret(field, field.selectionEnd);
  }

  /* A word the phone's keyboard is still writing (underlined) is finished before a button changes the words around it:
     changing them under it would break the keyboard's word. The box keeps the caret. */
  function finishWord() {
    if (!wordInProgress()) return;
    const field = composingField;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    composingField = null;
    field.blur();
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
  }

  /* -- Enter, Backspace and the arrows */

  function beforeInput(event, index, area) {
    const kind = event.inputType;
    if (kind === 'historyUndo' || kind === 'historyRedo') {  // the browser's own Undo (a menu, a keyboard's key)
      event.preventDefault();
      if (kind === 'historyUndo') undo(); else redo();
      return;
    }
    typingStarts();
    // What was typed before a paste or a drop is an Undo step of its own (a drag within the words first takes them
    // out, deleteByDrag: the step before that, and the taking out and the drop are one step).
    if (kind === 'deleteByDrag') checkpoint();
    if (/^insertFrom(Paste|Drop)/.test(kind) && !(kind === 'insertFromDrop' && lastInput === 'deleteByDrag')) {
      checkpoint();
      return;
    }
    const block = blocks[index];
    if (kind === 'deleteContentBackward' && area.selectionStart === 0 && area.selectionEnd === 0
      && (block.type === 'heading' || (block.type === 'check' && index > 0))) {
      // Backspace at the start of a heading or an item from a keyboard that didn't say which key it was: the mark
      // goes, the words stay (as keys() does for a real Backspace key).
      event.preventDefault();
      checkpoint();
      blocks[index] = { type: 'text', text: block.text };
      drawBlocks(merge(index));
      saveSoon();
      afterChange(true);
      return;
    }
    if (kind !== 'insertLineBreak' && kind !== 'insertParagraph') return;
    if (block.type === 'check') {
      event.preventDefault();
      nextItem(index, area);
    } else if (block.type === 'heading') {
      event.preventDefault();
      afterHeading(index, area);
    } else if (carryList(block, area)) {
      event.preventDefault();
    }
  }

  /* Enter in a list item: the next item (or, on an empty one, the end of the list). */
  function nextItem(index, area) {
    checkpoint();
    const block = blocks[index];
    if (!block.text.trim()) {
      blocks[index] = { type: 'text', text: '' };
      drawBlocks(merge(index));
    } else {
      const caret = area.selectionStart;
      const after = block.text.slice(area.selectionEnd);
      block.text = block.text.slice(0, caret);
      blocks.splice(index + 1, 0, { type: 'check', done: false, text: after });
      drawBlocks([index + 1, 'start']);
    }
    saveSoon();
    afterChange(true);
  }

  /* Enter in a heading: writing goes on under it (the words after the caret come along). */
  function afterHeading(index, area) {
    checkpoint();
    const block = blocks[index];
    const after = block.text.slice(area.selectionEnd);
    block.text = block.text.slice(0, area.selectionStart);
    blocks.splice(index + 1, 0, { type: 'text', text: after });
    drawBlocks(merge(index + 1));
    saveSoon();
    afterChange(true);
  }

  /* Enter on a "- " or "1. " line: the next item (in the same box: nothing is rebuilt). False when it isn't one. */
  function carryList(block, area) {
    const next = V.format.continueList(area.value, area.selectionStart, area.selectionEnd);
    if (!next) return false;
    checkpoint();
    replaceValue(area, next.value, next.caret);
    changed(block, area);
    return true;
  }

  function keys(event, index, area) {
    if (event.isComposing || event.keyCode === 229) return;  // the keyboard is still writing a word
    const block = blocks[index];
    const caret = area.selectionStart;
    const whole = area.selectionStart === area.selectionEnd;
    const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (block.type === 'check' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      nextItem(index, area);
    } else if (block.type === 'heading' && event.key === 'Enter') {
      event.preventDefault();
      afterHeading(index, area);
    } else if (block.type === 'text' && plainEnter) {
      if (carryList(block, area)) event.preventDefault();
    } else if (event.key === 'Backspace' && whole && caret === 0 && block.type === 'heading') {
      event.preventDefault();  // the heading goes; its words stay as plain text
      checkpoint();
      blocks[index] = { type: 'text', text: block.text };
      drawBlocks(merge(index));
      saveSoon();
      afterChange(true);
    } else if (event.key === 'Backspace' && whole && caret === 0 && index > 0) {
      checkpoint();
      if (block.type === 'check') {  // the tick box goes; the words stay as plain text
        event.preventDefault();
        blocks[index] = { type: 'text', text: block.text };
        drawBlocks(merge(index));
        saveSoon();
      } else if (!block.text) {
        event.preventDefault();
        blocks.splice(index, 1);
        drawBlocks([index - 1, 'end']);
        saveSoon();
      } else {
        event.preventDefault();
        focusBlock(index - 1, 'end');
      }
      afterChange(true);
    } else if (event.key === 'ArrowUp' && whole && !area.value.slice(0, caret).includes('\n') && index > 0) {
      event.preventDefault();
      focusBlock(index - 1, 'end');
    } else if (event.key === 'ArrowDown' && whole && !area.value.slice(caret).includes('\n') && index < blocks.length - 1) {
      event.preventDefault();
      focusBlock(index + 1, 'start');
    }
  }

  /* Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) step through Undo anywhere in the note (the words, the title, its buttons); in
     the words, Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Shift+X and Ctrl+Shift+H make bold, italic, underline, strikethrough and
     highlight (or take them off again), and Ctrl+K a link. */
  const MARK_KEYS = { b: ['bold', false], i: ['italic', false], u: ['underline', false], x: ['strike', true], h: ['highlight', true] };
  function shortcutKeys(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const target = event.target;
    if (!target || !target.matches || !el || !el.contains(target)) return;
    if (target.matches('input:not(.note-title), select, textarea:not(.block-input), [contenteditable]')) return;  // a field of its own
    const key = (event.key || '').toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); return; }
    if (!target.matches('.block-input')) return;
    const mark = MARK_KEYS[key];
    if (mark && mark[1] === event.shiftKey) { event.preventDefault(); wrap(V.format.MARKS[mark[0]]); }
    else if (key === 'k' && !event.shiftKey) { event.preventDefault(); addLink(); }
  }

  /* Next-door text blocks become one; returns where the start of block `watch` ended up, as [block, caret]. */
  function merge(watch = -1) {
    let at = [watch, 0];
    for (let i = blocks.length - 1; i > 0; i--) {
      if (blocks[i].type !== 'text' || blocks[i - 1].type !== 'text') continue;
      const offset = blocks[i - 1].text.length + 1;
      if (at[0] === i) at = [i - 1, offset + at[1]];
      else if (at[0] > i) at = [at[0] - 1, at[1]];
      blocks[i - 1].text += '\n' + blocks[i].text;
      blocks.splice(i, 1);
    }
    return at;
  }

  /* "# " typed at the start of a line makes it a heading ("## " a smaller one), and "[] " a tick-box item: what the
     note would show the next time it opens, at once. */
  function shortcut(index, area) {
    const caret = area.selectionStart;
    if (index < 0 || caret !== area.selectionEnd) return false;
    const start = area.value.lastIndexOf('\n', caret - 1) + 1;
    const lead = area.value.slice(start, caret);
    const head = /^(#{1,3}) $/.exec(lead);
    const box = /^(?:[-*] )?\[([ xX]?)\] $/.exec(lead);
    if (!head && !box) return false;
    // In a ``` code block it's code ("# a comment"): it stays as typed.
    if (area.value.slice(0, start).split('\n').filter((line) => FENCE.test(line)).length % 2) return false;
    const found = area.value.indexOf('\n', caret);
    const end = found < 0 ? area.value.length : found;
    const words = area.value.slice(caret, end);
    const pieces = [];
    if (start > 0) pieces.push({ type: 'text', text: area.value.slice(0, start - 1) });
    pieces.push(head ? { type: 'heading', level: head[1].length, text: words } : { type: 'check', done: /x/i.test(box[1]), text: words });
    if (end < area.value.length) pieces.push({ type: 'text', text: area.value.slice(end + 1) });
    checkpoint();
    blocks.splice(index, 1, ...pieces);
    drawBlocks([index + (start > 0 ? 1 : 0), 'start']);
    saveSoon();
    afterChange(true);
    return true;
  }

  /* Words pasted into a box with headings or tick-box lines in them become those blocks (the caret stays put). */
  function tidy(index) {
    if (index < 0 || blocks[index].type !== 'text') return false;
    const pieces = parse(blocks[index].text);
    if (pieces.length === 1 && pieces[0].type === 'text') return false;
    const spot = caretSpot();
    blocks.splice(index, 1, ...pieces);
    merge();
    drawBlocks();
    placeCaret(spot);
    return true;
  }

  /* -- the toolbar's word tools */

  /* The box the toolbar's buttons act on: the one with the caret (or the last one written in); null in the title. */
  function here() {
    if (!parts.blocks || !parts.blocks.isConnected) return null;
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    const active = fields.includes(document.activeElement) ? document.activeElement
      : document.activeElement === parts.title ? null : lastField;
    const index = fields.indexOf(active);
    return index >= 0 ? { index, field: active, block: blocks[index] } : null;
  }

  /* The line the caret is on in text block `index` taken out as a block of its own (a "- " in front goes); returns
     where its caret goes, as [block, caret]. */
  function lineOut(index, field, made) {
    const block = blocks[index];
    const caret = field.selectionStart;
    const start = block.text.lastIndexOf('\n', caret - 1) + 1;
    const endAt = block.text.indexOf('\n', caret);
    const end = endAt < 0 ? block.text.length : endAt;
    let words = block.text.slice(start, end);
    const mark = V.format.LIST.exec(words);
    const cut = mark ? mark[0].length : 0;
    words = words.slice(cut);
    const pieces = [];
    if (start > 0) pieces.push({ type: 'text', text: block.text.slice(0, start - 1) });
    pieces.push({ ...made, text: words });
    if (end < block.text.length) pieces.push({ type: 'text', text: block.text.slice(end + 1) });
    blocks.splice(index, 1, ...pieces);
    return [index + (start > 0 ? 1 : 0), Math.max(0, caret - start - cut)];
  }

  /* The toolbar's checklist button: the line the caret is on becomes a tick-box item (or a new one at the end). */
  function addChecklist() {
    if (reading) return;
    finishWord();
    checkpoint();
    const at = here();
    if (at && at.block.type === 'text') {
      const [index] = lineOut(at.index, at.field, { type: 'check', done: false });
      drawBlocks([index, 'end']);
    } else if (at && at.block.type === 'check') {
      blocks.splice(at.index + 1, 0, { type: 'check', done: false, text: '' });
      drawBlocks([at.index + 1, 'start']);
    } else if (at) {  // a heading
      const caret = at.field.selectionStart;
      blocks[at.index] = { type: 'check', done: false, text: at.block.text };
      drawBlocks([at.index, caret]);
    } else {
      // With the caret in the title, a new item goes at the end (not on whichever line was written in before).
      const last = blocks[blocks.length - 1];
      if (last.type === 'text' && !last.text.trim()) blocks[blocks.length - 1] = { type: 'check', done: false, text: '' };
      else blocks.push({ type: 'check', done: false, text: '' });
      drawBlocks([blocks.length - 1, 'start']);
    }
    saveSoon();
    afterChange(true);
  }

  /* The heading button: the caret's line becomes a heading; again, a smaller one; again, plain words. */
  function addHeading() {
    if (reading) return;
    finishWord();
    checkpoint();
    const at = here();
    if (at && at.block.type === 'heading') {
      const caret = at.field.selectionStart;
      if (at.block.level === 1) {  // smaller, in place (the keyboard stays up)
        at.block.level = 2;
        const wrapper = at.field.closest('.heading-block');
        if (wrapper) wrapper.classList.replace('h1', 'h2');
        changed(at.block, at.field);
        return;
      }
      blocks[at.index] = { type: 'text', text: at.block.text };
      const spot = merge(at.index);
      drawBlocks([spot[0], spot[1] + caret]);
    } else if (at && at.block.type === 'check') {
      const caret = at.field.selectionStart;
      blocks[at.index] = { type: 'heading', level: 1, text: at.block.text };
      drawBlocks([at.index, caret]);
    } else if (at) {
      drawBlocks(lineOut(at.index, at.field, { type: 'heading', level: 1 }));
    } else {
      const last = blocks[blocks.length - 1];
      if (last.type === 'text' && !last.text.trim()) blocks[blocks.length - 1] = { type: 'heading', level: 1, text: '' };
      else blocks.push({ type: 'heading', level: 1, text: '' });
      drawBlocks([blocks.length - 1, 'start']);
    }
    saveSoon();
    afterChange(true);
  }

  /* The list button: the caret's line (or the chosen lines) get "- "; again, numbers; again, plain words. */
  function toggleList() {
    if (reading) return;
    finishWord();
    checkpoint();
    const at = here();
    if (at && at.block.type === 'text') {
      const field = at.field;
      const next = V.format.cycleList(field.value, field.selectionStart, field.selectionEnd);
      if (document.activeElement !== field) field.focus({ preventScroll: true });
      replaceValue(field, next.value, next.start, next.end);
      changed(at.block, field);
      return;
    }
    if (at) {  // a heading or a tick-box item becomes a "- " line
      const caret = at.field.selectionStart;
      blocks[at.index] = { type: 'text', text: '- ' + at.block.text };
      const spot = merge(at.index);
      drawBlocks([spot[0], spot[1] + caret + 2]);
    } else {
      const last = blocks[blocks.length - 1];
      if (last.type !== 'text') blocks.push({ type: 'text', text: '- ' });
      else last.text = !last.text.trim() ? '- ' : last.text + (last.text.endsWith('\n') ? '' : '\n') + '- ';
      drawBlocks([blocks.length - 1, 'end']);
    }
    saveSoon();
    afterChange(true);
  }

  /* The B, I, U, S and highlighter buttons (and their keys): `mark` (** bold, _ italic, ++ underline, ~~ strikethrough,
     == highlight) round the chosen words or the word the caret is in, or taken off again (js/format.js: toggleMark),
     as one Undo step, in the same box (so the phone's keyboard stays up). A word the keyboard is still writing is
     finished first. */
  function wrap(mark) {
    if (reading) return;
    const writing = wordInProgress();  // (the button is then for the word being written, caret at its end or not)
    finishWord();
    const at = here();
    if (!at) return;
    const field = at.field;
    const next = V.format.toggleMark(field.value, field.selectionStart, field.selectionEnd, mark, { word: writing });
    if (!next) return;
    if (document.activeElement !== field) field.focus({ preventScroll: true });
    if (next.value === field.value) field.setSelectionRange(next.start, next.end);  // only stepped out past the marks
    else {
      checkpoint();
      replaceValue(field, next.value, next.start, next.end);
      changed(at.block, field);
    }
    pressedSoon();
  }

  /* Each mark's button shows pressed while the caret or the chosen words are in that mark (looked at once a frame,
     only the caret's own lines). */
  let pressedFrame = 0;
  const pressedSoon = () => { if (!pressedFrame && parts.marks) pressedFrame = requestAnimationFrame(drawPressed); };

  function drawPressed() {
    pressedFrame = 0;
    if (!parts.marks || !el || !el.isConnected) return;
    const at = !reading && canEdit() ? here() : null;
    const on = at ? V.format.marksAt(at.field.value, at.field.selectionStart, at.field.selectionEnd) : new Set();
    for (const [kind, button] of Object.entries(parts.marks)) {
      const now = on.has(kind);
      if (button.classList.contains('on') === now) continue;
      button.classList.toggle('on', now);
      button.setAttribute('aria-pressed', String(now));
    }
  }
  document.addEventListener('selectionchange', () => {
    if (el && el.contains(document.activeElement)) { pressedSoon(); lettersSoon(); }
  });

  /* The link button: the chosen words become a link ("[words](address)"), or a link goes in where the caret is. */
  async function addLink() {
    if (reading || !note) return;
    finishWord();
    const at = here();
    const field = at ? at.field : null;
    const range = field ? [field.selectionStart, field.selectionEnd] : null;
    const chosen = field && range[0] !== range[1] ? field.value.slice(range[0], range[1]) : '';
    if (chosen.includes('\n')) return V.toast('Pick words on one line to make a link.');
    const already = chosen && V.format.links(chosen);
    if (already && already.length === 1 && already[0].text === chosen.trim()) {
      return V.toast('That\'s a link already: it shows as a chip under its line.');
    }
    const id = note.id;
    const answer = await V.ask(chosen ? 'Link these words' : 'Add a link', {
      placeholder: 'Paste or type a link', type: 'url', ok: 'Add link',
      label: chosen ? `"${chosen.length > 40 ? chosen.slice(0, 40) + '...' : chosen}" will open:` : '',
      hint: chosen ? '' : 'Tip: you can also paste a link straight into the note.',
    });
    if (answer === null || !note || note.id !== id) return;
    const typedLink = answer.trim();
    const found = V.format.links(typedLink);
    if (!found.length || found[0].start !== 0 || found[0].end !== typedLink.length) {
      return V.toast('That doesn\'t look like a link. Try one like www.example.com');
    }
    checkpoint();
    if (field && field.isConnected && owner.get(field) && blocks.includes(owner.get(field))) {
      const block = owner.get(field);
      const [a, b] = range;
      const v = field.value;
      const around = /^(\s*)[\s\S]*?(\s*)$/.exec(chosen);  // spaces round the chosen words stay outside the link
      let text = chosen ? `${around[1]}[${chosen.trim()}](${typedLink})${around[2]}` : typedLink;
      if (!chosen && a > 0 && !/\s/.test(v[a - 1])) text = ' ' + text;
      if (!chosen && b < v.length && !/\s/.test(v[b])) text += ' ';
      if (document.activeElement !== field) field.focus({ preventScroll: true });
      replaceValue(field, v.slice(0, a) + text + v.slice(b), a + text.length);
      changed(block, field);
    } else {  // no caret in the words: the link goes on a line of its own at the end
      const last = blocks[blocks.length - 1];
      if (last.type === 'text') last.text = last.text.trim() ? last.text.replace(/\n*$/, '') + '\n' + typedLink : typedLink;
      else blocks.push({ type: 'text', text: typedLink });
      drawBlocks([blocks.length - 1, 'end']);
      saveSoon();
      afterChange(true);
    }
  }

  /* -- link chips */

  function drawChips(area, block) {
    const row = chipRows.get(area);
    if (!row) return;
    const seen = new Set();
    const found = V.format.links(block.text).filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 20);
    const key = found.map((l) => l.href + ' ' + (l.label || '')).join('\n');
    if (row.dataset.key === key) return;
    row.dataset.key = key;
    V.clear(row, found.map(chip));
    row.hidden = !found.length;
  }

  const chipTimers = new WeakMap();
  function chipsSoon(area, block, now) {
    clearTimeout(chipTimers.get(area));
    if (now) drawChips(area, block);
    else chipTimers.set(area, setTimeout(() => drawChips(area, block), 250));
  }

  /* A word the keyboard finished: its box's chips catch up. */
  function afterWord(area) {
    const block = area && owner.get(area);
    if (block && blocks.includes(block)) chipsSoon(area, block);
  }

  function chip(link) {
    const where = V.format.site(link.href);
    let copied = 0;
    return V.h('button.link-chip.keep-caret', {
      type: 'button', title: link.href,
      'aria-label': `Open ${link.label || where.name}${where.tail ? ' ' + where.tail : ''} (hold to copy the link)`,
      onclick: () => { if (Date.now() - copied > 800) openLink(link.href); },
      // A long press (or a right click on the PC) copies the link instead.
      oncontextmenu: (event) => {
        event.preventDefault();
        copied = Date.now();
        V.copy(link.href).then(() => V.toast('Link copied')).catch(V.problem);
      },
    }, V.icon('link'), V.h('span.chip-site', { text: link.label || where.name }),
    V.h('span.chip-tail', { text: link.label ? where.name : where.tail }));
  }

  function openLink(href) {
    if (V.desktop) V.pc.call('openLink', { url: href }).catch(V.problem);
    else window.open(href, '_blank', 'noopener');
  }

  /* -- pictures and files */

  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp|gif|bmp)/.test(file.type)) return { blob: file, type: file.type || 'application/octet-stream', name: file.name };
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return { blob: file, type: file.type, name: file.name };
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900 * 1024 && file.type === 'image/jpeg') {
      return { blob: file, type: 'image/jpeg', name: file.name, w: bitmap.width, h: bitmap.height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const draw = canvas.getContext('2d');
    draw.fillStyle = '#ffffff';  // a see-through PNG gets white behind it, as JPEG has no see-through
    draw.fillRect(0, 0, canvas.width, canvas.height);
    draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { blob, type: 'image/jpeg', name: file.name.replace(/\.[^.]+$/, '') + '.jpg', w: canvas.width, h: canvas.height };
  }

  // Pictures the browser can show are thumbnails; others (an iPhone's HEIC) are file chips, not broken pictures.
  const SHOWS = /^image\/(jpeg|png|gif|webp|bmp|avif)$/i;
  const isPicture = (a) => SHOWS.test(a.mime || '') || (!a.mime && /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.name || a.path || ''));
  // Files this editor shows as chips; other kinds (a drawing's own parts) are shown by their own code.
  const isFile = (a) => !isPicture(a) && (!a.kind || a.kind === 'voice' || a.kind === 'file');

  /* Any files into the note: pictures (made smaller first) show as pictures, the rest as file chips. */
  async function addFiles(files, extras = []) {
    if (!note) return;
    const list = [...(files || [])];
    if (!list.length) return;
    if (note.locked) return V.toast('Locked notes keep words only, not pictures or files.');
    const big = list.filter((f) => f.size > MAX_FILE);
    if (big.length) V.toast(`${big[0].name} is over 50 MB, the most the free cloud takes.`, { kind: 'err', ms: 6000 });
    const items = list.map((file, i) => ({ file, extra: extras[i] || {} })).filter((item) => item.file.size <= MAX_FILE);
    if (!items.length) return;
    if (!navigator.onLine) return V.toast('Adding pictures and files needs the internet.', { kind: 'err' });
    adding++;
    try {
      await addEach(items, V.data.user, note.id);
    } finally {
      adding--;
    }
  }

  const goingUp = new Set();  // { el, picture, id }: what's on its way to the cloud, shown while it goes

  async function addEach(items, user, id) {
    for (const { file, extra } of items) {
      const picture = SHOWS.test(file.type) && !extra.kind;
      const fill = V.h('i', { style: { width: '0%' } });
      const holder = picture ? V.h('div.thumb.loading', {}, V.h('div.spinner'))
        : V.h('div.file-chip.loading', {}, V.h('span.file-badge', {}, V.h('div.spinner')),
          V.h('span.file-text', {}, V.h('span.file-name', { text: extra.kind === 'voice' ? 'Voice memo' : file.name || 'File' }),
            V.h('span.bar.file-progress', {}, fill)));
      const going = { el: holder, picture, id };
      goingUp.add(going);
      drawPictures();
      try {
        const small = picture ? await shrink(file)
          : { blob: file, type: file.type || V.format.typeOf(file.name) || 'application/octet-stream', name: file.name || 'file' };
        const ending = small.type === 'image/jpeg' ? 'jpg' : (/\.([a-z0-9]{1,10})$/i.exec(small.name) || [])[1];
        const path = `${user.id}/notes/${id}/${V.uuid()}${ending ? '.' + ending.toLowerCase() : ''}`;
        await V.cloud.upload(path, small.blob, { mime: small.type, onProgress: (share) => { fill.style.width = Math.round(share * 100) + '%'; } });
        // Kept on this device too (so it shows offline), unless it's big.
        if (small.blob.size < 6 * 1024 * 1024) await V.db.put('files', { key: path, blob: small.blob, at: Date.now() });
        const item = { path, name: small.name, mime: small.type, size: small.blob.size, ...extra };
        if (picture) { item.w = small.w || 0; item.h = small.h || 0; }
        await attach(id, item);
      } catch (error) {
        const again = note && note.id === id;
        V.toast(error && error.message ? error.message : 'That didn\'t go up to the cloud.', {
          kind: 'err', ms: 6000, action: again ? 'Try again' : undefined,
          onAction: again ? () => addFiles([file], [extra]) : undefined,
        });
      } finally {
        goingUp.delete(going);
        drawPictures();
      }
    }
  }

  /* The file is in the cloud: it goes into the note (still open here, or as it's kept if it was closed meanwhile). */
  async function attach(id, item) {
    if (note && note.id === id) {
      note.attachments = [...(note.attachments || []), item];
      await save();
      return;
    }
    const row = V.data.notes.get(id);  // (a note in the Trash keeps it too: the Trash can be undone)
    if (!row || row._purge) { V.cloud.remove([item.path]).catch(() => {}); return; }
    await V.cloud.save('notes', { ...row, attachments: [...(row.attachments || []), item] });
  }

  const addPictures = (files) => addFiles(files);  // (the share sheet's way in, from before files)

  function drawPictures() {
    if (!parts.pictures) return;
    const list = ((note && note.attachments) || []).filter((a) => isPicture(a) || thumbMakers[a.kind]);
    const going = [...goingUp].filter((g) => g.picture && g.id === openId).map((g) => g.el);
    V.clear(parts.pictures, going, list.map((a) => {
      if (!isPicture(a)) return thumbMakers[a.kind](a, openId);
      const img = V.h('img', { alt: a.name || 'Picture', loading: 'lazy' });
      V.cloud.blob(a.path).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.classList.add('broken'));
      return V.h('button.thumb', { type: 'button', onclick: () => viewPicture(a, img), 'aria-label': 'Open picture' }, img);
    }));
    parts.pictures.hidden = !list.length && !going.length;
    drawFiles();
  }

  function drawFiles() {
    if (!parts.files) return;
    const list = ((note && note.attachments) || []).filter(isFile);
    const going = [...goingUp].filter((g) => !g.picture && g.id === openId).map((g) => g.el);
    V.clear(parts.files, list.map(fileRow), going);
    parts.files.hidden = !list.length && !going.length;
  }

  function fileRow(a) {
    if (/^audio\//.test(a.mime || '')) return audioRow(a);
    const kind = V.format.fileKind(a.mime, a.name);
    return V.h('div.file-chip', { dataset: { path: a.path } },
      V.h('button.file-open', { type: 'button', title: `Open ${a.name || 'the file'}`, onclick: () => openFile(a) },
        V.h('span.file-badge', { text: kind.short.slice(0, 4), 'aria-hidden': 'true' }),
        V.h('span.file-text', {}, V.h('span.file-name', { text: a.name || 'File' }),
          V.h('span.file-meta', { text: `${kind.label} · ${V.size(a.size)}` }))),
      V.iconButton('x', `Remove ${a.name || 'this file'}`, () => removeFile(a), 'file-remove'));
  }

  const savedOnPc = new Map();  // a file's cloud path -> where the PC saved it (opened again from there)

  /* A file opens with what the PC or the phone has for it (the PC saves it into Downloads\Vault first). */
  async function openFile(a) {
    try {
      if (V.desktop) {
        let saved = savedOnPc.get(a.path);
        if (!saved) {
          const url = await V.cloud.link(a.path);
          saved = (await V.pc.call('saveFile', { id: '', url, name: a.name || 'file' })).path;
          savedOnPc.set(a.path, saved);
        }
        await V.pc.call('openFile', { path: saved }).catch((error) => {
          savedOnPc.delete(a.path);
          throw error;
        });
      } else {
        window.open(await V.cloud.link(a.path), '_blank', 'noopener');
      }
    } catch (error) {
      V.problem(error);
    }
  }

  /* Taken out of the note at once (Undo puts it back); it leaves the cloud a few seconds later. */
  async function removeFile(a) {
    if (!note) return;
    const id = note.id;
    stopPlaying(a.path);
    note.attachments = (note.attachments || []).filter((x) => x.path !== a.path);
    drawPictures();
    save();
    let undone = false;
    V.toast(`${a.kind === 'voice' ? 'Voice memo' : a.name || 'The file'} removed`, { action: 'Undo', onAction: () => {
      undone = true;
      if (note && note.id === id) {
        note.attachments = [...(note.attachments || []), a];
        drawPictures();
        save();
      } else {
        const row = V.data.notes.get(id);
        if (row) V.cloud.save('notes', { ...row, attachments: [...(row.attachments || []), a] }).catch(V.problem);
      }
    } });
    setTimeout(() => {
      const used = [...V.data.notes.values(), note].some((n) => n && (n.attachments || []).some((x) => x.path === a.path));
      if (!undone && !used) V.cloud.remove([a.path]).catch(() => {});
    }, LET_GO_AFTER);
  }

  function viewPicture(attachment, img) {
    V.sheet({
      title: attachment.name || 'Picture', wide: true,
      content: V.h('div.viewer', {}, V.h('img', { src: img.src, alt: attachment.name || '' })),
      actions: [
        { label: 'Delete', kind: 'danger-quiet', icon: 'trash', onClick: async () => {
          note.attachments = note.attachments.filter((a) => a.path !== attachment.path);
          await save();
          drawPictures();
          V.cloud.remove([attachment.path]).catch(() => {});
        } },
        { label: 'Save a copy', icon: 'download', onClick: async () => {
          const url = await V.cloud.link(attachment.path, { download: attachment.name || 'picture.jpg' });
          if (V.desktop) await V.pc.call('saveFile', { id: '', url, name: attachment.name || 'picture.jpg' });
          else window.open(url, '_blank');
          return true;
        } },
        ...pictureActions.map((action) => ({ label: action.label, icon: action.icon,
          onClick: () => action.onClick(attachment, img, openId) })),
        { label: 'Done', kind: 'primary' },
      ],
    });
  }

  /* -- voice memos: played here, in a small player of their own */

  let playing = null;  // { path, audio, url, ui }

  function audioRow(a) {
    const voice = a.kind === 'voice';
    const ui = {
      play: V.h('button.play-btn', { type: 'button', 'aria-label': 'Play', title: 'Play' }, V.format.icon('play')),
      time: V.h('span.file-meta.num', { text: audioMeta(a) }),
      fill: V.h('i', { style: { width: '0%' } }),
    };
    ui.play.addEventListener('click', () => togglePlay(a, ui));
    if (playing && playing.path === a.path) { playing.ui = ui; showPlaying(); }
    return V.h('div.file-chip.audio' + (voice ? '.voice' : ''), { dataset: { path: a.path } },
      ui.play,
      V.h('span.file-text', {}, V.h('span.file-name', { text: voice ? 'Voice memo' : a.name || 'Audio' }), ui.time,
        V.h('span.bar.audio-bar', {}, ui.fill)),
      V.iconButton('x', voice ? 'Remove this voice memo' : `Remove ${a.name || 'this file'}`, () => removeFile(a), 'file-remove'));
  }

  function audioMeta(a) {
    const length = a.seconds ? V.format.clock(a.seconds) : '';
    if (a.kind === 'voice') return [length, a.at ? V.ago(a.at) : ''].filter(Boolean).join(' · ');
    return [length, V.size(a.size)].filter(Boolean).join(' · ');
  }

  async function togglePlay(a, ui) {
    if (playing && playing.path === a.path) {
      if (playing.audio.paused) playing.audio.play().catch(() => {});
      else playing.audio.pause();
      return;
    }
    stopPlaying();
    const audio = new Audio();
    // An iPhone only lets a sound start in the tap itself, before anything is waited for: a moment of silence is
    // started now, so the memo can follow on the same player once it's loaded.
    if (V.deviceKind.ios) {
      audio.src = silence();
      audio.play().catch(() => {});
    }
    const now = { path: a.path, audio, url: '', ui, seconds: a.seconds || 0, a };
    playing = now;
    ui.play.classList.add('loading');
    try {
      // A big recording plays as it comes (from its cloud link); a memo from this device's copy (offline too).
      const kept = await V.db.get('files', a.path);
      const stream = !kept && a.size > 6 * 1024 * 1024 ? await V.cloud.link(a.path) : '';
      const blob = stream ? null : kept ? kept.blob : await V.cloud.blob(a.path);
      if (playing !== now) return;
      if (blob) now.url = URL.createObjectURL(blob);
      audio.src = now.url || stream;
      audio.addEventListener('timeupdate', showPlaying);
      audio.addEventListener('play', showPlaying);
      audio.addEventListener('pause', showPlaying);
      audio.addEventListener('ended', () => { if (playing === now) stopPlaying(); });
      await audio.play();
    } catch (error) {
      if (playing === now) {
        stopPlaying();
        // A memo made on another kind of device that this one can't play (an older iPhone and Android's WebM, the
        // PC app and an iPhone's M4A) says so, instead of blaming the internet.
        const type = a.mime || ({ m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' })[String(a.name || '').split('.').pop()] || '';
        V.toast(type && !audio.canPlayType(type) ? 'This device can\'t play that kind of recording. Play it on the device that made it.'
          : 'That didn\'t play. Check your internet and try again.', { kind: 'err' });
      }
    } finally {
      ui.play.classList.remove('loading');
    }
  }

  /* A tenth of a second of silence (a WAV of its own, as the page may only play blob: and its own files). */
  let quiet = '';
  function silence() {
    if (quiet) return quiet;
    const rate = 8000;
    const samples = rate / 10;
    const bytes = new DataView(new ArrayBuffer(44 + samples));
    const text = (at, words) => { for (let i = 0; i < words.length; i++) bytes.setUint8(at + i, words.charCodeAt(i)); };
    text(0, 'RIFF'); bytes.setUint32(4, 36 + samples, true); text(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate, true); bytes.setUint16(32, 1, true); bytes.setUint16(34, 8, true);
    text(36, 'data'); bytes.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) bytes.setUint8(44 + i, 128);
    quiet = URL.createObjectURL(new Blob([bytes.buffer], { type: 'audio/wav' }));
    return quiet;
  }

  function showPlaying() {
    if (!playing) return;
    const { audio, ui } = playing;
    const total = playing.seconds || (Number.isFinite(audio.duration) ? audio.duration : 0);
    const on = !audio.paused;
    ui.play.replaceChildren(V.format.icon(on ? 'pause' : 'play'));
    ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    ui.play.title = on ? 'Pause' : 'Play';
    ui.time.textContent = `${V.format.clock(audio.currentTime)}${total ? ' / ' + V.format.clock(total) : ''}`;
    ui.fill.style.width = total ? Math.min(100, (audio.currentTime / total) * 100) + '%' : '0%';
  }

  /* Stops what's playing (only the memo at `path`, when one's given). */
  function stopPlaying(path) {
    if (!playing || (path && playing.path !== path)) return;
    const { audio, url, ui, a } = playing;
    playing = null;
    audio.pause();
    audio.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    ui.play.replaceChildren(V.format.icon('play'));
    ui.play.setAttribute('aria-label', 'Play');
    ui.play.title = 'Play';
    ui.time.textContent = audioMeta(a);
    ui.fill.style.width = '0%';
  }

  /* -- voice memos: recording */

  let recording = null;  // { recorder, stream, chunks, started, id, keep, timer }

  function micProblem(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return V.desktop ? 'Wefty couldn\'t use the microphone. Check that Windows lets apps use it (Settings, Privacy, Microphone).'
        : 'Wefty isn\'t allowed to use the microphone. Allow it in this site\'s settings (the icon by the address), then try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
    if (name === 'NotReadableError') return 'The microphone is busy in another app.';
    return 'The microphone didn\'t start. Try again.';
  }

  async function startMemo() {
    if (!note || recording) return;
    if (note.locked) return V.toast('Locked notes keep words only, not voice memos.');
    // One microphone user at a time (js/dictation.js says the same): the note-taker may be listening, hidden.
    if (V.notetaker && V.notetaker.listening()) return V.toast('The note-taker is listening. Stop it first, then record.');
    if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return V.toast('This browser can\'t record sound.', { kind: 'err' });
    }
    if (!navigator.onLine) return V.toast('Voice memos need the internet to be saved.', { kind: 'err' });
    const id = note.id;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      return V.toast(micProblem(error), { kind: 'err', ms: 7000 });
    }
    if (!note || note.id !== id || recording || (V.notetaker && V.notetaker.listening())) {  // (it started meanwhile)
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']
      .find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    let recorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      return V.toast('This browser can\'t record sound.', { kind: 'err' });
    }
    stopPlaying();
    const memo = { recorder, stream, chunks: [], started: Date.now(), id, keep: false, type, timer: null };
    recording = memo;
    recorder.addEventListener('dataavailable', (event) => { if (event.data && event.data.size) memo.chunks.push(event.data); });
    recorder.addEventListener('stop', () => finishMemo(memo));
    recorder.start(1000);  // a piece every second: nothing much is lost if something goes wrong
    memo.timer = setInterval(() => {
      const seconds = (Date.now() - memo.started) / 1000;
      if (parts.recTime) parts.recTime.textContent = V.format.clock(Math.floor(seconds));
      if (seconds >= MEMO_MOST) stopMemo(true);
    }, 250);
    showRecorder(true);
  }

  // The note-taker starting (from the new-note sheet, with this note still open beside the list): a memo being
  // recorded is saved into its note first, as dictation lets go of the microphone too.
  V.on('notetaker-listening', () => { if (recording) stopMemo(true); });

  /* Stops recording: `keep` saves the memo into its note, else it's thrown away. */
  function stopMemo(keep) {
    const memo = recording;
    if (!memo) return;
    recording = null;
    memo.keep = keep;
    memo.stopped = Date.now();
    clearInterval(memo.timer);
    showRecorder(false);
    try {
      if (memo.recorder.state !== 'inactive') memo.recorder.stop();
      else finishMemo(memo);
    } catch (error) {
      finishMemo(memo);
    }
  }

  async function finishMemo(memo) {
    if (memo.finished) return;
    memo.finished = true;
    memo.stream.getTracks().forEach((t) => t.stop());
    if (!memo.keep) return;
    const mime = ((memo.recorder.mimeType || memo.type || 'audio/webm').split(';')[0]) || 'audio/webm';
    const blob = new Blob(memo.chunks, { type: mime });
    if (!blob.size) return V.toast('The memo didn\'t get any sound. Try again.', { kind: 'err' });
    const seconds = Math.max(1, Math.round(((memo.stopped || Date.now()) - memo.started) / 1000));
    const at = new Date();
    const ending = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
    const name = `Voice memo ${V.dateText(at)} ${String(at.getHours()).padStart(2, '0')}-${String(at.getMinutes()).padStart(2, '0')}.${ending}`;
    const file = new File([blob], name, { type: mime });
    const extra = { kind: 'voice', seconds, at: at.toISOString() };
    adding++;
    try {
      await addEach([{ file, extra }], V.data.user, memo.id);
    } finally {
      adding--;
    }
    if (!note || note.id !== memo.id) V.toast('Voice memo saved');
  }

  function showRecorder(on) {
    if (!parts.tools) return;
    parts.tools.classList.toggle('recording', on);
    parts.recorder.hidden = !on;
    if (!on) parts.strip.scrollLeft = 0;  // the tools come back from their start
    if (on && recording) parts.recTime.textContent = V.format.clock(Math.floor((Date.now() - recording.started) / 1000));
  }

  /* -- Undo */

  /* Undo keeps snapshots of the title and the words (taken when typing pauses and before each button's change), and
     steps back and forth through them. A change from the other device starts it afresh, and a locked note's words
     are never kept in it once hidden. */
  const undoLog = { past: [], future: [], last: null };
  const canEdit = () => !!note && !!el && (!note.locked || revealed);
  const snap = () => ({ title: note.title || '', words: serialize(), spot: caretSpot() });

  function resetHistory() {
    checkpointSoon.cancel();
    undoLog.past = [];
    undoLog.future = [];
    undoLog.last = canEdit() ? snap() : null;
    drawUndo();
  }

  /* What's written now becomes a step of its own (when it differs from the last one). */
  function checkpoint() {
    checkpointSoon.cancel();
    if (!canEdit()) return;
    const now = snap();
    if (!undoLog.last) { undoLog.last = now; drawUndo(); return; }
    if (now.title === undoLog.last.title && now.words === undoLog.last.words) {
      if (now.spot) undoLog.last.spot = now.spot;
      drawUndo();  // (a pause that changed nothing: no step waits any more, and Redo still has its steps)
      return;
    }
    undoLog.past.push(undoLog.last);
    let letters = undoLog.past.reduce((sum, s) => sum + s.words.length, 0);
    while (undoLog.past.length > UNDO_STEPS || (letters > UNDO_LETTERS && undoLog.past.length > 1)) {
      letters -= undoLog.past.shift().words.length;
    }
    undoLog.future.length = 0;
    undoLog.last = now;
    drawUndo();
  }
  const checkpointSoon = V.debounce(checkpoint, 900);

  /* The first change of a run of typing (no step waiting yet): where the caret was, and what was picked, go with the
     step before it, so Undo puts the caret back there (and picks the words typed over again). */
  function typingStarts() {
    if (!checkpointSoon.pending() && undoLog.last) checkpoint();
  }

  const undo = () => step('past', 'future');
  const redo = () => step('future', 'past');

  function step(back, forth) {
    if (!canEdit()) return;
    finishWord();
    checkpoint();
    const from = undoLog[back];
    const to = undoLog[forth];
    if (!from.length || !undoLog.last) return;
    const state = from.pop();
    to.push(undoLog.last);
    undoLog.last = state;
    note.title = state.title;
    if (parts.title.value !== state.title) parts.title.value = state.title;
    const writing = keepsCaret();  // with no caret (the phone's keyboard down), none appears
    const spot = state.spot || caretSpot();
    fill(state.words);
    state.words = serialize();  // (words the boxes write another way, "* [ ] milk", are kept as they show)
    if (!reading && writing) placeCaret(spot);
    saveSoon();
    countSoon();
    drawUndo();
  }

  function drawUndo() {
    if (!parts.undo) return;
    const waiting = checkpointSoon.pending();
    parts.undo.setAttribute('aria-disabled', String(!undoLog.past.length && !waiting));
    parts.redo.setAttribute('aria-disabled', String(!undoLog.future.length || waiting));
  }

  /* `words` shown: in the boxes that are there when the note keeps its shape (nothing rebuilt, so the phone's
     keyboard stays up), else drawn again. */
  function fill(words) {
    const next = parse(words);
    if (reading) { blocks = next; drawRead(); return; }
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    if (sameShape(next, fields)) putIn(next, fields);
    else { blocks = next; drawBlocks(); }
  }

  const sameShape = (next, fields) => next.length === blocks.length && fields.length === next.length
    && next.every((b, i) => b.type === blocks[i].type && b.level === blocks[i].level);

  /* The rows' own objects are changed, not swapped: each box's handlers hold on to its row. */
  function putIn(next, fields) {
    next.forEach((b, i) => { blocks[i].text = b.text; blocks[i].done = b.done; });
    fields.forEach((field, i) => {
      if (field.value !== next[i].text) field.value = next[i].text;
      grow(field);
      drawChips(field, blocks[i]);
      const row = field.closest('.check-row');
      if (row) {
        row.classList.toggle('done', next[i].done);
        const tick = row.querySelector('.tick');
        tick.setAttribute('aria-pressed', String(next[i].done));
        tick.setAttribute('aria-label', next[i].done ? 'Not done' : 'Done');
      }
    });
  }

  /* -- the Read view */

  function setReading(on, spot) {
    if (!note || reading === on || (note.locked && !revealed)) return;
    if (on) { finishWord(); checkpoint(); }
    reading = on;
    drawBody();
    if (!on) placeCaret(spot || { line: Infinity, col: Infinity });
  }

  function drawRead() {
    const shown = V.format.render(serialize(), { tick: tickLine, blanks: true });
    readMap = shown.map;
    // Quick read's pieces (never a locked note's), each keeping its place in the note for a tap (js/reading.js), and the
    // reading ruler (shown while dyslexia-friendly text has it on)
    if (!note.locked) V.reading.area(shown.el, readMap);
    parts.read = V.h('div.read-view', { onclick: readTap }, shown.el);
    V.reading.ruler(parts.read);
    V.clear(parts.body, parts.read, parts.pictures, parts.files);
  }

  /* A tick in the Read view: the item on that line of the note. Says whether it's done now. */
  function tickLine(line) {
    let at = 0;
    for (const block of blocks) {
      const size = oneLine(block) ? 1 : block.text.split('\n').length;
      if (line < at + size) {
        if (block.type !== 'check') return null;
        checkpoint();
        block.done = !block.done;
        saveSoon();
        afterChange(true);
        return block.done;
      }
      at += size;
    }
    return null;
  }

  /* A tap on the words: back to writing, with the caret where the tap was. Links open and ticks tick instead, and
     words picked to copy stay picked. */
  function readTap(event) {
    if (event.target.closest('a, button')) return;
    const picked = window.getSelection && window.getSelection();
    if (picked && !picked.isCollapsed && parts.read.contains(picked.anchorNode)) return;
    setReading(false, readSpot(event.clientX, event.clientY));
  }

  function readSpot(x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const found = document.caretPositionFromPoint(x, y);
      if (found) { node = found.offsetNode; offset = found.offset; }
    } else if (document.caretRangeFromPoint) {
      const found = document.caretRangeFromPoint(x, y);
      if (found) { node = found.startContainer; offset = found.startOffset; }
    }
    const at = node && readMap && readMap.get(node);
    if (at) return { line: at.line, col: at.col + offset };
    // Beside the words: the nearest line, at its start or end.
    let best = null;
    let far = Infinity;
    for (const item of parts.read.querySelectorAll('[data-line]')) {
      const box = item.getBoundingClientRect();
      const distance = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (distance < far) { far = distance; best = item; }
    }
    if (!best) return null;
    const box = best.getBoundingClientRect();
    return { line: Number(best.dataset.line), col: y < box.top || (y <= box.bottom && x < box.left) ? 0 : Infinity };
  }

  function drawReadButton() {
    if (!parts.readBtn) return;
    const label = reading ? 'Back to writing' : 'Read view';
    parts.readBtn.replaceChildren(V.format.icon(reading ? 'pencil' : 'book'), V.h('span.tool-label', { text: reading ? 'Write' : 'Read' }));
    parts.readBtn.title = label;
    parts.readBtn.setAttribute('aria-label', label);
    parts.readBtn.setAttribute('aria-pressed', String(reading));
    parts.readBtn.classList.toggle('on', reading);
  }

  /* -- counting words, and a goal */

  const goalOf = () => {
    const goal = Math.round(Number(((note && note.extra) || {}).goal_words));
    return goal > 0 ? goal : 0;
  };
  const number = (n) => n.toLocaleString();
  const countSoon = V.debounce(() => { drawCount(); refreshTools(); }, 250);

  function drawCount() {
    if (!parts.count || !note || (note.locked && !revealed)) return;
    const stats = V.format.stats(serialize());
    const goal = goalOf();
    parts.countWords.textContent = goal ? `${number(stats.words)} / ${number(goal)} words`
      : `${number(stats.words)} ${stats.words === 1 ? 'word' : 'words'}`;
    parts.countTime.textContent = stats.words ? ` · ${stats.minutes} min read` : '';
    parts.goal.hidden = !goal;
    if (!goal) return;
    const share = Math.min(1, stats.words / goal);
    parts.goalFill.style.width = (share * 100).toFixed(1) + '%';
    parts.goal.classList.toggle('met', share >= 1);
    if (share < 1) goalBelow = true;
    else if (goalBelow && !cheered) {
      cheered = true;
      V.toast(`Word goal reached: ${number(goal)} words. Nice work!`);
    }
  }

  function countSheet() {
    if (!note) return;
    const stats = V.format.stats(serialize());
    const goal = goalOf();
    const item = (label, value) => V.h('div.count-item', {}, V.h('strong.num', { text: value }), V.h('span', { text: label }));
    V.sheet({
      title: 'Word count',
      content: [
        V.h('div.count-grid', {},
          item('Words', number(stats.words)),
          item('Characters', number(stats.chars)),
          item('To read', stats.words ? `${stats.minutes} min` : '-')),
        goal ? V.h('p.count-goal', {}, `Goal: ${number(goal)} words. `,
          V.h('span', { text: stats.words >= goal ? 'Reached!' : `${number(goal - stats.words)} to go.` }))
          : V.h('p.hint', { text: 'A word goal shows a thin bar that fills up as you write. Handy for essays.' }),
      ],
      actions: [
        goal ? { label: 'Remove goal', kind: 'danger-quiet', onClick: () => setGoal(0) } : null,
        { label: goal ? 'Change goal' : 'Set a word goal', kind: 'primary', onClick: askGoal },
      ].filter(Boolean),
    });
  }

  async function askGoal() {
    const id = note && note.id;
    const answer = await V.ask('Word goal', { type: 'number', value: goalOf() ? String(goalOf()) : '', placeholder: 'For example 500',
      label: 'How many words are you aiming for?', ok: 'Set goal' });
    if (answer === null || !note || note.id !== id) return;
    const words = Math.round(Number(String(answer).replace(/[^\d.]/g, '')));
    if (!(words > 0)) return V.toast('Type how many words, like 500.');
    setGoal(Math.min(words, 1000000));
  }

  function setGoal(words) {
    if (!note) return;
    const extra = { ...(note.extra || {}) };
    if (words) extra.goal_words = words;
    else delete extra.goal_words;
    note.extra = extra;
    goalBelow = false;
    cheered = false;
    save();
    drawCount();
    if (words) V.toast(`Goal set: ${number(words)} words`);
  }

  /* -- the bar on top */

  function folderPicker() {
    const NEW = 'new-folder';
    const now = () => (note.folder_id && V.data.folders.has(note.folder_id) ? note.folder_id : '');
    const select = V.h('select.folder-pick', {
      'aria-label': 'Folder',
      onchange: async () => {
        if (select.value !== NEW) { note.folder_id = select.value || null; save(); return; }
        // "New folder...": made (name and emoji), then the note goes in it.
        select.value = now();
        const id = note.id;
        const folder = await V.organise.newFolder();
        if (!folder) return;
        if (note && note.id === id) { note.folder_id = folder.id; save(); drawBar(); }
        else await V.organise.move([id], folder.id);
      },
    }, V.h('option', { value: '', text: 'No folder' }), V.organise.tree().map(({ folder: f, depth }) => V.h('option', {
      value: f.id, text: ' '.repeat(depth) + (f.icon ? f.icon + ' ' : '') + f.name,  // folders inside folders indented
    })), V.h('option', { value: NEW, text: 'New folder...' }));
    select.value = now();
    return select;
  }

  function dueButton() {
    const due = V.due(note.due, note.done);
    return V.h('div.due-group', {},
      V.h('button.chip.due-chip' + (due ? '.' + (due.cls || 'later') : ''), {
        type: 'button', onclick: pickDue, title: 'Due date',
      }, V.icon('calendar'), due ? due.label : 'Due date'),
      note.due ? V.h('button.chip.done-chip.keep-caret' + (note.done ? '.on' : ''), {
        type: 'button', title: note.done ? 'Mark as not done' : 'Mark as done', 'aria-pressed': String(!!note.done),
        onclick: () => {
          // A repeating one (js/reminders.js) moves on to its next one instead of being done for good.
          if (!note.done && V.reminders && V.reminders.upNext && V.reminders.upNext(note)) { V.reminders.toggleDone(note.id); return; }
          note.done = !note.done; save(); drawBar(); if (note.done) V.toast('Nice, done.');
        },
      }, V.icon('check'), note.done ? 'Done' : 'Mark done') : null);
  }

  function pickDue() {
    const today = V.today();
    const day = new Date().getDay();
    const choose = (value) => { note.due = value; if (!value) note.done = false; save(); drawBar(); sheet.close(); };
    const input = V.h('input.field', { type: 'date', value: note.due || V.addDays(today, 1) });
    const sheet = V.sheet({
      title: 'Due date',
      content: [
        V.h('div.quick-dates', {},
          V.button('Today', { onClick: () => choose(today) }),
          V.button('Tomorrow', { onClick: () => choose(V.addDays(today, 1)) }),
          V.button('Friday', { onClick: () => choose(V.addDays(today, ((5 - day + 7) % 7) || 7)) }),
          V.button('Next week', { onClick: () => choose(V.addDays(today, ((1 - day + 7) % 7) || 7)) })),
        V.h('label.label', { text: 'Or pick a day' }), input,
      ],
      actions: [
        note.due ? { label: 'No due date', kind: 'danger-quiet', onClick: () => choose(null) } : null,
        { label: 'Set', kind: 'primary', onClick: () => { if (input.value) choose(input.value); } },
      ].filter(Boolean),
    });
  }

  function drawBar() {
    V.clear(parts.meta, dueButton(), metaMakers.map((make) => {
      try { return make(note); } catch (error) { console.warn('Vault:', error); return null; }
    }));
    V.clear(parts.bar,
      host ? null : V.iconButton('back', 'Back to notes', close, 'back'),
      folderPicker(),
      V.h('div.bar-spacer'),
      V.iconButton(note.pinned ? 'pin-on' : 'pin', note.pinned ? 'Unpin' : 'Pin to the top', () => { note.pinned = !note.pinned; save(); drawBar(); },
        (note.pinned ? 'on ' : '') + 'keep-caret'),
      V.iconButton(note.locked ? 'lock' : 'unlock', note.locked ? 'Locked' : 'Lock this note', toggleLock, note.locked ? 'on' : ''),
      V.iconButton('more', 'More', (event) => moreMenu(event.currentTarget)));
  }

  function moreMenu(anchor) {
    const archived = V.organise.isArchived(note);
    const template = V.organise.isTemplate(note);
    // Archived, or made a template again, here: saved at once (these live in `extra`, which the autosave doesn't
    // watch), with the note's words as they are.
    const organise = async (values) => {
      note = V.organise.stamped(note, values);
      queued = '';
      await save();
    };
    V.menu(anchor, [
      { label: 'Move to...', icon: 'folder-move', onClick: async () => {
        const id = note.id;
        const folder = await V.organise.chooseFolder({ current: note.folder_id });
        if (!folder || (note && note.id === id && note.folder_id === folder.id)) return;
        if (note && note.id === id) { note.folder_id = folder.id; save(); drawBar(); V.toast(`Moved to ${folder.name}`); }
        else await V.organise.move([id], folder.id);
      } },
      !note.locked || revealed ? { label: `Send to ${V.otherName}`, icon: 'send', onClick: sendNote } : null,
      // Export and Copy as text (js/export.js): the words as they are in the editor now (a locked note's only while
      // they show, with a line saying the file isn't locked).
      (!note.locked || revealed) && V.exporter ? { label: 'Export', icon: 'download',
        onClick: () => V.exporter.note(exportable()) } : null,
      (!note.locked || revealed) && V.exporter ? { label: 'Copy as text', icon: 'copy',
        onClick: () => V.exporter.copyText(exportable()).catch(V.problem) } : null,
      (!note.locked || revealed) && V.chat ? { label: V.chat.ASK_LABEL, icon: 'spark', onClick: () => V.chat.askAbout() } : null,
      // (js/aicards.js: never a locked note, even one unlocked now, nor a template)
      !note.locked && !template && V.aiCards ? { label: 'Make flash cards', icon: 'cards', onClick: () => V.aiCards.forNote(note.id) } : null,
      !note.locked && !template ? { label: 'Save as template', icon: 'notes', onClick: () => V.organise.saveTemplate({
        title: note.title, body: serialize(), folder_id: note.folder_id }).catch(V.problem) } : null,
      template ? { label: 'Make it a normal note', icon: 'notes', onClick: async () => {
        await organise({ is_template: false, template_name: null });
        V.toast('It\'s a normal note now, in your lists.');
      } } : null,
      template ? null : { label: archived ? 'Unarchive' : 'Archive', icon: 'archive', onClick: async () => {
        const id = note.id;
        await organise({ archived: !archived });
        drawBar();
        if (archived) return V.toast('Back from the archive, in your lists again.');
        close();
        V.toast('Archived', { action: 'Undo', onAction: async () => {
          await V.organise.archive([id], false, { quiet: true });
          V.notes.open(id);
        } });
      } },
      note.locked ? { label: 'Remove the lock', icon: 'unlock', onClick: removeLock } : null,
      V.history ? { label: 'History', icon: 'clock', onClick: () => V.history.show(note.id) } : null,
      // The two reading aids (js/reading.js), for every device: the same switches as Settings > Appearance > Reading.
      { label: 'Quick read', icon: 'bolt', checked: V.reading.get().quick, onClick: () => V.reading.toggle('quick') },
      V.reading.get().quick ? { label: 'Quick read colour', icon: 'spark', checked: V.reading.get().quickHighlight,
        onClick: () => V.reading.toggle('quickHighlight') } : null,
      { label: 'Dyslexia-friendly text', icon: 'text', checked: V.reading.get().dyslexia, onClick: () => V.reading.toggle('dyslexia') },
      { label: 'Move to Trash', icon: 'trash', danger: true, onClick: trash },
    ]);
  }

  /* The note as it is in the editor now, for Export and Copy as text: its words as typed (an unlocked locked note's
     sealed words, showing: `shown`). */
  const exportable = () => ({ ...note, body: serialize(), shown: !note.locked || revealed });

  async function sendNote() {
    const text = [note.title, serialize()].filter((t) => t && t.trim()).join('\n\n');
    if (!text.trim()) return V.toast('The note is empty.');
    await V.send.text(text, { name: V.noteTitle({ ...note, body: serialize() }) });
  }

  async function trash() {
    const id = note.id;
    await save();
    const row = V.data.notes.get(id);
    await V.cloud.save('notes', { ...row, deleted: true, deleted_at: new Date().toISOString() });
    close();
    V.toast('Moved to Trash', { action: 'Undo', onAction: async () => {
      const back = V.data.notes.get(id);
      await V.cloud.save('notes', { ...back, deleted: false, deleted_at: null });
      V.notes.open(id);
    } });
  }

  /* -- locking */

  async function unlockWithPin() {
    if (V.lock.unlocked()) return true;
    if (!V.lock.hasPin() && navigator.onLine) await V.cloud.sync();  // a PIN made on the other device counts
    if (!V.lock.hasPin()) {
      const pin = await V.lock.askPin({ title: 'Locked notes', make: true });
      if (!pin) return false;
      await V.cloud.saveSettings(await V.lock.make(pin));
      return true;
    }
    for (let tries = 0; tries < 5; tries++) {
      const pin = await V.lock.askPin({ title: tries ? 'Wrong PIN, try again' : 'Enter your PIN' });
      if (!pin) return false;
      if (await V.lock.unlock(pin)) return true;
    }
    V.toast('Too many tries.', { kind: 'err' });
    return false;
  }

  async function toggleLock() {
    if (note.locked) {
      if (revealed) { hide(); return; }
      return reveal();
    }
    if ((note.attachments || []).length) return V.toast('Remove the pictures and files first: locked notes keep words only.');
    if (recording) return V.toast('Finish the voice memo first.');
    if (!(await unlockWithPin())) return;
    note.locked = true;
    revealed = true;
    quietClipboard(true);
    await save();
    drawBar();
    V.toast('Locked. Only your PIN opens it now.');
  }

  async function reveal() {
    if (!(await unlockWithPin())) return;
    try {
      const stored = V.data.notes.get(note.id) || note;
      const opened = JSON.parse(await V.lock.decrypt(stored.secret));
      blocks = parse(opened.body || '');
      savedWords = serialize();
      remember(savedWords);
      revealed = true;
      queued = '';
      quietClipboard(true);
      drawBody();
      resetHistory();
    } catch (error) {
      V.problem(error);
    }
  }

  function hide() {
    revealed = false;
    blocks = [];
    quietClipboard(false);
    resetHistory();  // (nothing of the words is kept for Undo)
    readMap = null;
    // The boxes, the copies of their words under them (see shade) and shown formatted (see preview) and the Read view
    // let go of the words at once.
    lastField = null;
    composingField = null;
    shading.clear();
    previewing.clear();
    looking.clear();
    pressed = tapped = dropInto = null;
    if (parts.blocks) V.clear(parts.blocks);
    if (parts.read) { V.clear(parts.read); parts.read = null; }
    if (note) drawBody();
  }

  async function removeLock() {
    if (!revealed) await reveal();
    if (!revealed) return;
    note.locked = false;
    note.secret = null;
    revealed = false;
    quietClipboard(false);
    await save();
    drawBar();
    drawBody();
    V.toast('The lock is off.');
  }

  /* -- the whole thing */

  function drawBody() {
    if (note.locked && !revealed) {
      V.clear(parts.body, V.h('div.locked-face', {}, V.icon('lock', 'big'),
        V.h('p', { text: 'This note is locked.' }),
        V.button('Unlock with PIN', { kind: 'primary', onClick: reveal })));
      parts.tools.hidden = true;
      return;
    }
    parts.tools.hidden = false;
    if (el) el.classList.toggle('reading', reading);
    if (reading) drawRead();
    else {
      V.clear(parts.body, parts.blocks, parts.pictures, parts.files);
      drawBlocks();
    }
    drawPictures();
    drawReadButton();
    drawCount();
    drawUndo();
    refreshTools();
    pressedSoon();
  }

  function toolsBar() {
    const tool = (name, label, icon, onClick, keep = true, keys = '') => V.h('button.tool-btn' + (keep ? '.keep-caret' : ''), {
      type: 'button', title: keys ? `${label} (${keys})` : label, 'aria-label': label, dataset: { tool: name },
      'aria-keyshortcuts': keys ? keys.replace(/Ctrl/g, 'Control') : null,
      onclick: (event) => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') onClick(event); },
    }, icon, V.h('span.tool-label', { text: label }));
    const F = V.format;
    // The formatting comes first: the five marks (pressed while the caret is in one), then the lines' own kinds.
    const mark = (kind, label, keys) => {
      const button = tool(kind, label, F.icon(kind), () => wrap(F.MARKS[kind]), true, keys);
      button.setAttribute('aria-pressed', 'false');
      parts.marks[kind] = button;
      return button;
    };
    parts.marks = {};
    parts.undo = tool('undo', 'Undo', F.icon('undo'), undo, true, 'Ctrl+Z');
    parts.redo = tool('redo', 'Redo', F.icon('redo'), redo, true, 'Ctrl+Y');
    parts.strip = V.h('div.tool-strip', { role: 'toolbar', 'aria-label': 'Writing tools' },
      mark('bold', 'Bold', 'Ctrl+B'), mark('italic', 'Italic', 'Ctrl+I'), mark('underline', 'Underline', 'Ctrl+U'),
      mark('strike', 'Strikethrough', 'Ctrl+Shift+X'), mark('highlight', 'Highlight', 'Ctrl+Shift+H'),
      tool('heading', 'Heading', F.icon('heading'), addHeading),
      tool('list', 'List', F.icon('list'), toggleList),
      tool('checklist', 'Checklist', V.icon('checklist'), addChecklist),
      parts.undo, parts.redo, V.h('span.tool-sep'),
      tool('picture', 'Picture', V.icon('camera'), () => parts.file.click(), false),
      tool('link', 'Link', V.icon('link'), addLink),
      tool('file', 'File', F.icon('clip'), () => parts.anyFile.click(), false),
      tool('voice', 'Voice memo', F.icon('mic'), startMemo, false),
      extraTools.map((t) => tool(t.name, t.label, typeof t.icon === 'function' ? t.icon() : V.icon(t.icon), () => t.onClick(),
        t.keepCaret !== false)));
    parts.countWords = V.h('span.count-words.num');
    parts.countTime = V.h('span.count-time');
    parts.count = V.h('button.word-count', { type: 'button', title: 'Word count and goal', onclick: countSheet },
      parts.countWords, parts.countTime);
    parts.readBtn = V.h('button.tool-btn.read-toggle', { type: 'button', onclick: () => setReading(!reading) });
    parts.goalFill = V.h('i');
    parts.goal = V.h('div.goal-line', { hidden: true, 'aria-hidden': 'true' }, parts.goalFill);
    parts.recTime = V.h('span.rec-time.num', { text: '0:00' });
    parts.recorder = V.h('div.recorder', { hidden: true, role: 'status' },
      V.h('span.rec-dot', { 'aria-hidden': 'true' }),
      V.h('span.rec-text', {}, 'Recording ', parts.recTime),
      V.h('div.bar-spacer'),
      V.button('Cancel', { kind: 'quiet', onClick: () => stopMemo(false) }),
      V.button('Save memo', { kind: 'primary', icon: 'check', onClick: () => stopMemo(true) }));
    return V.h('div.editor-tools', {}, parts.goal, parts.strip,
      V.h('span.read-hint', { text: 'Reading. Tap the words to write.' }), parts.recorder,
      V.h('div.tools-end', {}, V.h('div.tools-info', {}, parts.count, parts.status), parts.readBtn),
      parts.file, parts.anyFile);
  }

  /* The tools fade out at the right while more of them are scrolled out of sight (a phone's narrow screen). */
  const stripEdge = (strip) => strip.classList.toggle('more', strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 4);
  const stripWatch = window.ResizeObserver ? new ResizeObserver((seen) => seen.forEach((s) => stripEdge(s.target))) : null;

  function build() {
    const oldStrip = parts.strip;
    parts = {
      bar: V.h('div.editor-bar'),
      meta: V.h('div.note-meta'),
      title: V.h('input.note-title', {
        type: 'text', placeholder: 'Title', value: note.title || '', 'aria-label': 'Title', maxlength: '200',
        oninput: (event) => { note.title = parts.title.value; saveSoon(); checkpointSoon(); drawUndo(); tell('title', parts.title, event); },
        onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); focusBlock(0, 'end'); } },
        // The browser's own Undo here (a menu, a keyboard's key) is the note's: the title and the words are one history.
        onbeforeinput: (event) => {
          if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') { typingStarts(); return; }
          event.preventDefault();
          if (event.inputType === 'historyUndo') undo(); else redo();
        },
      }),
      body: V.h('div.editor-body'),
      blocks: V.h('div.blocks'),
      pictures: V.h('div.pictures'),
      files: V.h('div.files', { hidden: true }),
      status: V.h('span.save-state'),
      ask: V.h('div.editor-ask', { hidden: true }),
      file: V.h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true,
        onchange: () => { addFiles(parts.file.files); parts.file.value = ''; } }),
      anyFile: V.h('input', { type: 'file', multiple: true, hidden: true,
        onchange: () => { addFiles(parts.anyFile.files); parts.anyFile.value = ''; } }),
    };
    parts.tools = toolsBar();
    const strip = parts.strip;
    strip.addEventListener('scroll', () => stripEdge(strip), { passive: true });
    // A mouse's wheel turns the tools sideways when they don't all fit (a PC window half the screen wide).
    strip.addEventListener('wheel', (event) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    }, { passive: false });
    if (stripWatch) {
      if (oldStrip) stripWatch.unobserve(oldStrip);
      stripWatch.observe(strip);
    }
    el = V.h('article.editor', {
      dataset: { place: `note:${note.id}` },  // (js/start.js puts a note's scroll back in Notes' side pane only on that note)
      ondragover: (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.stopPropagation(); el.classList.add('dropping'); } },
      ondragleave: () => el.classList.remove('dropping'),
      ondrop: (event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault(); event.stopPropagation(); el.classList.remove('dropping');
        addFiles(event.dataTransfer.files);
      },
      // Pasted files (a screenshot, a file copied in Explorer, a copied picture) go into the note; pasted words stay
      // words (Word puts a picture of its words on the clipboard too, so words win, unless they're only the picture's
      // own address).
      onpaste: (event) => {
        const data = event.clipboardData;
        const files = [...((data && data.files) || [])];
        const words = ((data && data.getData('text/plain')) || '').trim();
        const onlyItsLink = V.isLink(words) && files.some((f) => f.type.startsWith('image/'));
        if (files.length && (!words || onlyItsLink)) { event.preventDefault(); addFiles(files); }
      },
      // The buttons that act on the words where they are (tick, remove, checklist, pin) leave the caret, and the
      // phone's keyboard, where they were. The ones that open something (a picture, the PIN pad, a menu) don't: what
      // was typed next would go into the note hidden behind it.
      // A tap on the bars' empty parts (beside the buttons, on "Saved") leaves it there too.
      onmousedown: (event) => {
        if (!keepsCaret()) return;
        const target = event.target;
        if (target.closest('.tick, .remove-item, .keep-caret')) event.preventDefault();
        else if (target.closest('.editor-tools, .editor-bar, .note-meta, .pictures, .files, .link-chips, .editor-ask')
          && !target.closest('button, select, input, textarea, a, label')) event.preventDefault();
      },
      onkeydown: shortcutKeys,
      onfocusin: (event) => {
        if (event.target.matches && event.target.matches('.block-input')) lastField = event.target;
        else if (event.target === parts.title) lastField = null;
        pressedSoon();
      },
      oncompositionstart: (event) => { composingField = event.target; },
      oncompositionend: (event) => { composingField = null; afterWord(event.target); },
    }, parts.bar, V.h('div.editor-scroll', {
      // The empty page under the words is part of the note: a tap (or the S Pen) there writes at the end of it. A
      // tap beside the words (the margins, between rows) leaves the caret where it is; a drag that only ends there
      // (selecting text on the PC) is left alone.
      onmousedown: (event) => {
        pressedBlank = blankSpot(event.target);
        if (pressedBlank && (keepsCaret() || belowWords(event))) event.preventDefault();
      },
      onclick: (event) => {
        const wasBlank = pressedBlank;
        pressedBlank = false;
        if (wasBlank && blankSpot(event.target) && belowWords(event)) focusBlock(blocks.length - 1, 'end');
        else if (reading && event.target.matches('.editor-scroll, .editor-body')) setReading(false);
      },
    }, parts.meta, parts.title, parts.body), parts.ask, parts.tools);
    drawBar();
    fillAsk();
    drawBody();
    setStatus();
    if (recording && recording.id === note.id) showRecorder(true);
  }

  let pressedBlank = false;
  const keepsCaret = () => !!el && el.contains(document.activeElement) && document.activeElement.matches('.block-input, .note-title');
  const blankSpot = (target) => !!parts.blocks && parts.blocks.isConnected && blocks.length > 0
    && (target.matches('.editor-scroll, .editor-body, .blocks, .block'));
  const belowWords = (event) => {
    const last = parts.blocks.lastElementChild;
    return !!last && event.clientY > last.getBoundingClientRect().bottom;
  };
  const fingerprint = (n) => JSON.stringify([n.id, n.title, n.locked ? '' : n.body, n.folder_id, n.pinned, n.due, n.done,
    n.locked, n.attachments, '', stable(n.extra || {})]);

  /* Shows `found`. `from` is what it's told apart from later: the same note, or (after putting this device's words
     together with another device's) the other device's version, so the merged words are saved. */
  function load(found, from = found) {
    if (revealed) quietClipboard(false);
    note = { ...found };
    base = from;
    revealed = false;
    composingField = null;
    blocks = note.locked ? [] : parse(note.body);
    savedWords = note.locked ? '' : serialize();
    if (from === found) remember(savedWords);
    queued = from === found ? fingerprint(note) : '';
    const old = el;
    const oldScroll = old && old.querySelector('.editor-scroll');
    const top = oldScroll ? oldScroll.scrollTop : 0;
    build();
    if (old && old.parentNode) {
      old.replaceWith(el);
      if (top) el.querySelector('.editor-scroll').scrollTop = top;  // shown again where it was being read
    }
  }

  function open(id, { pane = null, focusTitle = false } = {}) {
    // The note the note-taker is listening into is its own while it listens (it writes the whole body every few
    // seconds, so an editor's copy would be out of date at once): every way of opening it shows the note-taker instead.
    if (V.notetaker && V.notetaker.listeningTo && id && V.notetaker.listeningTo() === id) {
      V.notetaker.open();
      return;
    }
    if (!(note && openId === id && el)) {
      for (const watch of openWatchers) {
        try { watch(id); } catch (error) { console.warn('Vault:', error); }
      }
    }
    const found = V.data.notes.get(id);
    if (!found) return;
    const before = host;
    if (note && openId === id && el) {
      // Already open (the Notes tab drawn again, its own card tapped): the same editor moves, with its unsaved words,
      // caret and all.
      move(pane);
      return;
    }
    if (note) { saveSoon.flush(); save(); }
    if (revealed) quietClipboard(false);
    leaving();
    openId = id;
    el = null;
    host = pane || null;
    pending = null;
    known = [];
    reading = false;
    goalBelow = false;
    cheered = false;
    // A pane the note was in before (the window was wider) doesn't keep an old copy of it.
    if (before && before !== host) emptyPane(before);
    load(found);
    if (pane) {
      if (layer) { layer.remove(); layer = null; }
      V.clear(pane, el);
    } else {
      if (layer) layer.remove();
      else history.pushState({ vault: 'note' }, '');
      layer = V.h('div.editor-layer', {}, el);
      document.getElementById('layers').append(layer);
      requestAnimationFrame(() => layer.classList.add('shown'));
    }
    resetHistory();
    V.emit('note-opened', id);  // (js/history.js keeps its versions)
    if (note.locked && V.lock.unlocked()) reveal();
    if (focusTitle) {
      // A blank title, or one a template started ("Homework: "), is where the typing goes first.
      if (!note.title || /:\s*$/.test(note.title)) {
        parts.title.focus();
        parts.title.setSelectionRange(parts.title.value.length, parts.title.value.length);
      } else focusBlock(blocks.length - 1, 'end');
    }
  }

  /* The note is being left (closed, or another one opened): a memo being recorded is saved into it, what's playing
     stops, and Undo forgets it. */
  function leaving() {
    asking = null;
    if (openId) V.emit('note-left', openId);
    if (recording) stopMemo(true);
    stopPlaying();
    checkpointSoon.cancel();
    undoLog.past = [];
    undoLog.future = [];
    undoLog.last = null;
    reading = false;
    readMap = null;
  }

  function close() {
    saveSoon.flush();
    save();
    if (revealed) quietClipboard(false);
    leaving();
    revealed = false;
    openId = null;
    note = null;
    composingField = null;
    pending = null;
    if (layer) {
      const leavingLayer = layer;
      layer = null;
      leavingLayer.classList.remove('shown');
      setTimeout(() => leavingLayer.remove(), 200);
      if (history.state && history.state.vault === 'note') history.back();
    } else if (host) {
      placeholder(host);
    }
    V.emit('data', 'notes');
  }

  function placeholder(pane) {
    if (openId && host === pane) return;
    emptyPane(pane);
  }

  function emptyPane(pane) {
    const hint = V.desktop ? 'Ctrl+N for a new note. Ctrl+Alt+N anywhere on the PC for a quick one.'
      : V.appShortcuts ? 'Ctrl+N for a new note.' : '';  // a browser tab never gets Ctrl+N: don't pretend it does
    V.clear(pane, V.h('div.pane-empty', {}, V.mark(44), V.h('p', { text: 'Pick a note, or make a new one.' }),
      hint ? V.h('p.hint', { text: hint }) : null));
  }

  /* The open note goes to `pane` (null: the full-screen layer) as it is: the Notes tab drawn again, its own card
     tapped, or the window crossing the wide/narrow line (a PC window snapped to half the screen, a Chromebook's
     resized). The same editor moves, so its words, the caret and any half-typed word stay; what's typed is saved
     first when it changes place all the same. */
  function move(pane) {
    if (!el || !openId) return;
    const to = pane || null;
    const from = host;
    const nowhere = !document.activeElement || document.activeElement === document.body;
    const active = el.contains(document.activeElement) ? document.activeElement
      : hiddenFocus && el.contains(hiddenFocus) && nowhere ? hiddenFocus : null;
    const spot = active && active.setSelectionRange ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const scroller = el.querySelector('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    if (from !== to) { saveSoon.flush(); save(); }
    host = to;
    if (from && from !== to && from.isConnected) emptyPane(from);  // the pane it was in keeps no old copy
    if (to) {
      if (layer) {
        const leavingLayer = layer;
        layer = null;  // before going back: the popstate that follows mustn't close the note
        leavingLayer.remove();
        if (history.state && history.state.vault === 'note') history.back();
      }
      if (el.parentNode !== to) V.clear(to, el);
    } else if (!layer) {
      history.pushState({ vault: 'note' }, '');
      layer = V.h('div.editor-layer.shown', {}, el);
      document.getElementById('layers').append(layer);
    }
    drawBar();  // the back button belongs to the full-screen note only
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    if (active && active.isConnected && document.activeElement !== active) {
      active.focus({ preventScroll: true });
      if (spot) active.setSelectionRange(spot[0], spot[1], spot[2] || 'none');
    }
  }

  /* A window narrowed past the wide line hides the side pane before the layout's own change is heard, and the browser
     lets go of the box being typed in then: which one it was is kept, so move() gives it back with its caret. */
  let hiddenFocus = null;
  document.addEventListener('focusout', (event) => {
    const box = event.target;
    hiddenFocus = el && el.contains(box) && !event.relatedTarget && !box.getClientRects().length ? box : null;
  }, true);
  document.addEventListener('focusin', () => { hiddenFocus = null; }, true);

  window.addEventListener('popstate', () => {
    // (Back from something shown over the note, a drawing, comes back to the note's own step: it stays open.)
    if (!layer || (history.state && history.state.vault === 'note')) return;
    layer.remove();
    layer = null;
    saveSoon.flush();
    save();
    if (revealed) quietClipboard(false);
    leaving();
    revealed = false;
    openId = null;
    note = null;
    composingField = null;
    pending = null;
    V.emit('data', 'notes');
  });
  V.on('status', () => setStatus());

  /* `target` shown in the boxes that are already there, when it keeps the note's shape (the same rows, the same
     kinds): nothing is rebuilt, so the phone's keyboard stays up. */
  function show(target) {
    if (!el || !el.isConnected || note.locked || target.locked || revealed) return false;
    const next = parse(target.body);
    const put = (field, value) => { if (field.value !== value) field.value = value; };
    if (reading) {  // the Read view is simply drawn again
      note = { ...target };
      blocks = next;
      put(parts.title, note.title || '');
      drawRead();
    } else {
      const fields = [...parts.blocks.querySelectorAll('.block-input')];
      if (!sameShape(next, fields)) return false;
      note = { ...target };
      put(parts.title, note.title || '');
      putIn(next, fields);
    }
    drawBar();
    drawPictures();
    setStatus();
    drawCount();
    return true;
  }

  /* `target` shown however it has to be (in place, else rebuilt), with `words` (a locked note's, open) in its boxes,
     and the caret put back at `spot`, its line moved by `map`. `from` is what later changes are told apart from. */
  function showAll(target, from, spot, map, words = null) {
    if (words === null && show(target)) {
      base = from;
      queued = from === target ? fingerprint(note) : '';
    } else {
      load(target, from);
      if (words !== null) {  // a locked note's words, open
        blocks = parse(words);
        revealed = true;
        quietClipboard(true);
        drawBody();
      }
    }
    savedWords = serialize();
    if (from === target) remember(savedWords);
    placeCaret(spot, map);
    resetHistory();  // Undo starts afresh from what both devices have now
  }

  const wordInProgress = () => !!composingField && composingField.isConnected && document.activeElement === composingField;
  const sameAs = (a, b) => a.title === b.title && a.folder_id === b.folder_id && a.pinned === b.pinned && a.due === b.due
    && a.done === b.done && a.locked === b.locked && paths(a) === paths(b) && stable(a.extra || {}) === stable(b.extra || {});

  /* Each setting kept in `extra` (a word goal, flash cards...) as this device changed it, else as theirs. */
  const mergeExtra = (start, mine, theirs) => V.cloud.mergeExtra(start, mine, theirs);

  /* The open note changed in the cloud (from the other device, or Jarvis). */
  function takeRemote() {
    if (!note) return;
    const fresh = V.data.notes.get(note.id);
    if (!fresh || fresh.deleted || fresh._purge) { close(); return; }
    if (!fresh._dirty) {  // (a dirty one is this device's own save, not sent yet)
      if (sameNote(fresh, base)) { base = fresh; note.updated_at = fresh.updated_at; }  // our own save, back
      else {
        if (!pending) pendingFrom = { base, words: savedWords };
        pending = fresh;
      }
    }
    // Mid-save it waits: the save's end looks again (it can't have been made from words not sent yet).
    if (!pending || saving) return;
    const theirs = pending;
    const from = pendingFrom;
    pending = null;
    pendingFrom = null;
    putTogether(theirs, from).catch(V.problem);
  }

  /* Their version of the note with what's been written here since `from` (unsaved, or saved and not yet theirs):
     both kept, line by line. Where both changed the very same lines, this device's stay, and it's said. */
  async function putTogether(theirs, from) {
    const spot = caretSpot();
    // A word the keyboard is still writing is finished first (changing the words under it would break it); the
    // caret comes back once the words are in.
    if (wordInProgress()) { const field = composingField; composingField = null; field.blur(); }
    const mine = note.locked && !revealed ? null : serialize();
    const changedHere = saveSoon.pending() || base !== from.base || !sameAs(note, base) || (mine !== null && mine !== from.words);
    let theirWords = theirs.locked ? null : theirs.body || '';
    if (theirs.locked && (revealed || changedHere) && V.lock.unlocked()) {
      try { theirWords = JSON.parse(await V.lock.decrypt(theirs.secret)).body || ''; } catch (error) { theirWords = null; }
    }
    if (!note) return;
    if (!changedHere || mine === null) {
      // Nothing new here: their version as it is (opened if it's locked and the words were showing).
      const keepOpen = theirs.locked && revealed && theirWords !== null;
      const map = mine !== null && theirWords !== null ? V.mergeLines(mine, mine, theirWords).map : null;
      showAll(theirs, theirs, theirs.locked && !keepOpen ? null : spot, map, keepOpen ? theirWords : null);
      if (theirs.locked && !keepOpen && !note.locked) V.toast('This note was locked on your other device.');
      return;
    }
    if (theirWords === null) {
      // Locked on the other device and this one can't open it: its lock stays; what was just typed here can't be
      // put into it.
      showAll(theirs, theirs, null, null);
      V.toast('This note was locked on your other device, so what you just typed here wasn\'t kept.', { kind: 'err' });
      return;
    }
    // What their version was made from: the version here it differs least from (usually the last one both had).
    let start = from.words;
    let least = V.changeSize(start, theirWords);
    for (const candidate of known) {
      const size = V.changeSize(candidate, theirWords);
      if (size < least) { start = candidate; least = size; }
    }
    const words = V.mergeLines(start, mine, theirWords);
    let conflict = words.conflict;
    const mineChanged = (key) => (key === 'attachments' ? paths(note) !== paths(from.base) : note[key] !== from.base[key]);
    const pick = (key) => (mineChanged(key) ? note[key] : theirs[key]);
    let title = theirs.title;
    if (mineChanged('title')) {
      const titles = V.mergeLines(from.base.title || '', note.title || '', theirs.title || '');
      title = titles.text.replace(/\n/g, ' ');
      conflict = conflict || titles.conflict;
    }
    const locked = theirs.locked || note.locked;
    const together = { ...theirs, title, folder_id: pick('folder_id'), pinned: pick('pinned'), due: pick('due'),
      done: pick('done'), attachments: pick('attachments'), locked, body: locked ? '' : words.text,
      secret: locked ? theirs.secret || note.secret : null, extra: mergeExtra(from.base.extra, note.extra, theirs.extra) };
    showAll(together, theirs, spot, words.map, locked ? words.text : null);
    queued = '';
    saveSoon.cancel();  // what was waiting to be saved is in this save
    save();
    if (conflict) V.toast('This note was changed on your other device too, in the same place. What you wrote here was kept.');
  }

  V.on('data', (table) => { if (table === 'notes') takeRemote(); });

  /* Quick read switched on or off (here, or on another device): every copy of the boxes' words made again, in place.
     The boxes themselves stay, so a word the phone's keyboard is writing in one (the other device's change can come
     at any moment) goes on as it was: a box made again would lose its keyboard, and the keyboard's word would be
     written in twice. (Its colour, the font and the spacing are styles.css's alone; the Read view's words follow by
     themselves: js/reading.js, area.) */
  V.on('reading', ({ was, now }) => {
    if (!note || !el || !parts.blocks || reading) return;
    if (was.quick === now.quick || note.locked) { remeasure(); return; }
    for (const area of parts.blocks.querySelectorAll('.block-input')) {
      const under = shades.get(area);
      if (under) { under.lines = []; V.clear(under.el); under.el.hidden = true; under.words = null; shade(area); }
      const view = previews.get(area);
      if (view) { if (view.el) view.el.remove(); previews.delete(area); }
      const state = letters.get(area);
      if (state) {
        state.lines = [];
        V.clear(state.el);
        state.words = null;
        state.litNodes = new Set();
        if (state.on) drawLetters(area);
        if (state.on && !state.lines.some((line) => line.marks)) lettersDown(area);  // (nothing left to draw over it)
      }
      setLook(area);  // (its formatted copy made again, or none any more)
    }
    remeasure();
  });

  /* A browser that can't size a box to its words itself (see grow) measures each box again when what it measured
     changes under it: the reading font and its spacing switched on or off, or a font that was still on its way. */
  function remeasure() {
    if (SIZES_ITSELF || !el || !parts.blocks || reading) return;
    for (const area of parts.blocks.querySelectorAll('.block-input')) grow(area);
  }
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => remeasure());

  /* On a phone, putting the keyboard away (Back, or its own arrow) leaves the box focused, and Chrome then brings
     the keyboard back on any tap (a tick, the pin). So when the page grows back by a keyboard's height to its full
     height, the box lets go. The full height is only learnt while no box is being typed in (a rotation with the
     keyboard up, or the keyboard's own strip coming and going, never counts). */
  let full = { width: window.innerWidth, height: window.innerHeight };
  let lastHeight = window.innerHeight;
  window.addEventListener('resize', () => {
    const grew = window.innerHeight - lastHeight;
    lastHeight = window.innerHeight;
    if (!window.matchMedia('(hover: none)').matches) return;
    if (window.innerWidth !== full.width) { full = { width: window.innerWidth, height: window.innerHeight }; return; }
    if (!keepsCaret()) { full.height = Math.max(full.height, window.innerHeight); return; }
    const keyboard = (window.screen && window.screen.height ? window.screen.height : window.innerHeight) * 0.2;
    if (grew > keyboard && window.innerHeight >= full.height - 60) document.activeElement.blur();
  });
  V.on('away', () => {
    saveSoon.flush();
    // Saved (sealed with the key) first, then the words hidden and the key forgotten.
    save().finally(() => {
      if (note && note.locked && revealed) hide();
      V.lock.forget();
    });
  });

  /* Whether the open note can be left right now (Vault reloading into an update): every save done and nothing waiting
     to be saved, no word half-written by the phone's keyboard, no picture or file going up, no memo being recorded. */
  async function settled() {
    saveSoon.flush();
    for (let round = 0; saving && round < 20; round++) await chain;
    return !saving && !saveSoon.pending() && !adding && !recording && !wordInProgress();
  }

  /* Another part of Vault adds a button to the writing tools: { name, label, icon (a util.js icon name, or a
     function making one), onClick, keepCaret (default true: the caret and the phone's keyboard stay), shown (optional:
     (note, words) => whether it shows now), first (optional: before the other added tools, next to Voice memo) }.
     Notes opened from then on show it. */
  function addTool(tool) {
    if (!tool || !tool.name || extraTools.some((t) => t.name === tool.name)) return;
    if (tool.first) extraTools.unshift(tool); else extraTools.push(tool);
  }

  /* An attachment kind another part of Vault shows among the pictures (a drawing): make(attachment, noteId) -> its
     thumbnail. */
  function addThumb(kind, make) {
    if (kind && typeof make === 'function') thumbMakers[kind] = make;
  }

  /* One more button in the picture viewer: { label, icon, onClick(attachment, img, noteId) } (the viewer closes). */
  function addPictureAction(action) {
    if (action && action.label && !pictureActions.some((a) => a.label === action.label)) pictureActions.push(action);
  }

  /* A note's attachments changed by another part of Vault (a drawing put in, redrawn or taken out): `change` gets a
     copy of the list and returns the new one. The open note's working copy (saved and drawn again), else the note as
     it's kept. False when the note is gone. */
  async function changeAttachments(id, change) {
    if (note && note.id === id) {
      note.attachments = change([...(note.attachments || [])]);
      drawPictures();
      await save();
      return true;
    }
    const row = V.data.notes.get(id);  // (a note in the Trash keeps it too: the Trash can be undone)
    if (!row || row._purge) return false;
    await V.cloud.save('notes', { ...row, attachments: change([...(row.attachments || [])]) });
    return true;
  }

  /* -- for other parts of Vault (js/reminders.js, js/study.js) */

  /* A chip beside the due date: `make(note)` gives an element (or null), each time the bar is drawn. */
  function addMeta(make) {
    if (typeof make === 'function' && !metaMakers.includes(make)) metaMakers.push(make);
  }

  /* `watch({ where: 'title' | 'body', field, composing, first })` hears each change typed in the open note: `first`
     says it was the title or the first line of the words. */
  function onTyped(watch) {
    if (typeof watch === 'function') typedWatchers.push(watch);
  }

  function tell(where, field, event) {
    const block = owner.get(field);
    const first = where === 'title' || (!!block && block === blocks[0]
      && field.value.lastIndexOf('\n', Math.max(0, field.selectionStart - 1)) < 0);
    for (const watch of typedWatchers) {
      try { watch({ where, field, composing: !!(event && event.isComposing), first }); } catch (error) { console.warn('Vault:', error); }
    }
  }

  /* `watch(id)` is told just before a note opens (it may change the note's row first: V.data has it at once). */
  function onOpen(watch) {
    if (typeof watch === 'function') openWatchers.push(watch);
  }

  /* The open note's words as they are now (null for a locked note that isn't showing). */
  const words = () => (note && (!note.locked || revealed) ? serialize() : null);

  /* A change to the open note's own values (its due date, its extra), saved like any edit; nothing is rebuilt but
     the bar (`draw`), so the caret and the phone's keyboard stay where they are. `quiet`: only its flash cards moved
     on, which isn't an edit (see save). */
  function update(change, { draw = true, quiet = false } = {}) {
    if (!note) return Promise.resolve();
    change(note);
    const done = save({ quiet });
    if (draw && el) drawBar();
    return done;
  }

  /* New words for the open note (ticks taken off a repeating checklist): in the boxes that are there when the shape
     stays, as one Undo step. */
  function setWords(text) {
    if (!canEdit() || typeof text !== 'string' || text === serialize()) return;
    finishWord();
    checkpoint();
    fill(text);
    saveSoon();
    afterChange(true);
  }

  /* A small question just above the tools (above the phone's keyboard): `node`, or nothing. It belongs to the note
     open now, and never takes the caret. */
  function ask(node) {
    asking = node && openId ? { id: openId, node } : null;
    fillAsk();
  }

  function fillAsk() {
    if (!parts.ask) return;
    const shown = asking && asking.id === openId ? asking.node : null;
    V.clear(parts.ask, shown);
    parts.ask.hidden = !shown;
    // The page under it got shorter: the line being typed stays in sight.
    const active = document.activeElement;
    if (shown && el && el.contains(active) && active.matches('.block-input')) scrollToCaret(active, active.selectionEnd);
  }

  /* Tools with a `shown(note, words)` test show only when it says so (Study only with flash cards in the note). */
  function refreshTools() {
    if (!parts.strip || !note) return;
    const text = words();
    for (const tool of extraTools) {
      if (typeof tool.shown !== 'function') continue;
      const button = parts.strip.querySelector(`[data-tool="${tool.name}"]`);
      let show = false;
      try { show = !!tool.shown(note, text); } catch (error) { console.warn('Vault:', error); }
      if (button && button.hidden === show) button.hidden = !show;
    }
    stripEdge(parts.strip);
  }

  /* An older version's title and words put back into the open note (js/history.js): an edit like any other, so Undo
     takes it back too. False when the note isn't open here with its words showing. */
  function restore(id, title, words) {
    if (!note || openId !== id || !canEdit()) return false;
    finishWord();
    checkpoint();
    note.title = title || '';
    if (parts.title.value !== note.title) parts.title.value = note.title;
    fill(words || '');
    checkpoint();
    queued = '';
    saveSoon.cancel();
    save();
    countSoon();
    drawUndo();
    return true;
  }

  return { open, close, placeholder, move, openId: () => openId, covering: () => !!layer, parse, addPictures, addFiles,
    settled, addTool, addThumb, addPictureAction, changeAttachments, addMeta, onTyped, onOpen, current: () => note, words,
    update, setWords, ask, refreshTools, restore, revealed: () => revealed,
    root: () => el };  // the open note's element (js/dictation.js finds the box with the caret and the tools in it)
})();
