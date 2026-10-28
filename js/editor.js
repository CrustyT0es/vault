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

  function parse(body) {
    const out = [];
    let text = [];
    const flush = () => { if (text.length) { out.push({ type: 'text', text: text.join('\n') }); text = []; } };
    for (const line of (body || '').split('\n')) {
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

  /* While a locked note's words show on the PC, copying them doesn't go to the shared clipboard. */
  function quietClipboard(on) {
    if (V.desktop) V.pc.call('quietClipboard', { on }).catch(() => {});
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
    shade(area);  // (whenever a box's words change, so do its blanks)
    if (SIZES_ITSELF) return;
    const scroller = area.closest('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    area.style.height = 'auto';
    area.style.height = area.scrollHeight + 'px';
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  }

  /* {{blanks}} in a text box (fill-in-the-blank flash cards) get a soft wash and a dotted line under them. A text box
     can't style part of its words, so a copy of them sits under it, see-through but for those marks, wrapping just
     as the box does (styles.css: .blank-shade). The words themselves stay plain text. */
  const shades = new WeakMap();      // a text box -> the layer under it
  const shadeWords = new WeakMap();  // ...and the words it was last drawn for
  function shade(area) {
    const under = shades.get(area);
    if (!under) return;
    const value = area.value.includes('{{') ? area.value : '';
    if (shadeWords.get(area) === value) return;
    shadeWords.set(area, value);
    const found = value ? V.format.blanks(value) : [];
    under.hidden = !found.length;
    if (!found.length) { V.clear(under); return; }
    const pieces = [];
    let at = 0;
    for (const blank of found) {
      pieces.push(value.slice(at, blank.start), V.h('span.blank-mark', { text: value.slice(blank.start, blank.end) }));
      at = blank.end;
    }
    pieces.push(value.slice(at));
    V.clear(under, pieces);
  }

  function focusBlock(index, where = 'end') {
    const fields = parts.blocks.querySelectorAll('.block-input');
    const field = fields[Math.max(0, Math.min(index, fields.length - 1))];
    if (!field) return;
    const at = Math.max(0, Math.min(where === 'start' ? 0 : where === 'end' ? field.value.length : where, field.value.length));
    // Focused without the browser scrolling to the box's old caret, then the view goes just as far as the new one.
    field.focus({ preventScroll: true });
    field.setSelectionRange(at, at);
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
     title; null when it's elsewhere. */
  function caretSpot() {
    const active = document.activeElement;
    if (!el || !active || !el.contains(active)) return null;
    if (active === parts.title) return { title: true, at: active.selectionStart };
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    const index = fields.indexOf(active);
    if (index < 0) return null;
    let line = 0;
    for (let i = 0; i < index; i++) line += oneLine(blocks[i]) ? 1 : blocks[i].text.split('\n').length;
    const before = active.value.slice(0, active.selectionStart).split('\n');
    const single = oneLine(blocks[index]);
    const text = single ? serialize().split('\n')[line] : active.value.split('\n')[before.length - 1];
    return { line: line + before.length - 1, col: before[before.length - 1].length + prefix(blocks[index]), text };
  }

  /* Puts the caret back at `spot`, its line moved by `map` (a line of the old words to its line now, -1 if gone: then
     the end of the nearest line before it that stayed). */
  function placeCaret(spot, map) {
    if (!spot) return;
    if (spot.title) {
      parts.title.focus({ preventScroll: true });
      const at = Math.min(spot.at, parts.title.value.length);
      parts.title.setSelectionRange(at, at);
      return;
    }
    let line = map ? map(spot.line) : spot.line;
    let col = spot.col;
    if (line < 0) {
      let k = spot.line - 1;
      while (k >= 0 && map(k) < 0) k--;
      line = k >= 0 ? map(k) : 0;
      col = k >= 0 ? Infinity : 0;
    } else if (typeof spot.text === 'string') {
      // The line itself changed: words added or taken away before the caret move it along with its own words.
      const now = serialize().split('\n')[line];
      if (typeof now === 'string' && now !== spot.text) {
        let same = 0;
        while (same < now.length && same < spot.text.length && now[same] === spot.text[same]) same++;
        if (col > same) col += now.length - spot.text.length;
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const lines = oneLine(block) ? [block.text] : block.text.split('\n');
      if (line < lines.length || i === blocks.length - 1) {
        line = Math.min(line, lines.length - 1);
        if (oneLine(block)) return focusBlock(i, Math.max(0, Math.min(col - prefix(block), block.text.length)));
        let at = 0;
        for (let k = 0; k < line; k++) at += lines[k].length + 1;
        return focusBlock(i, at + Math.min(col, lines[line].length));
      }
      line -= lines.length;
    }
  }

  function drawBlocks(focus) {
    const scroller = parts.blocks.closest('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    lastField = null;
    composingField = null;  // a word being written in a box that goes ends without a word from the keyboard
    V.clear(parts.blocks, blocks.map((block, index) => drawBlock(block, index)));
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
    });
    owner.set(area, block);
    const under = block.type === 'text' ? V.h('div.blank-shade', { 'aria-hidden': 'true', hidden: true }) : null;
    if (under) { shades.set(area, under); shade(area); }
    requestAnimationFrame(() => grow(area));
    const chips = V.h('div.link-chips', { hidden: true });
    chipRows.set(area, chips);
    drawChips(area, block);
    if (block.type === 'text') return V.h('div.block.text-block', {}, under, area, chips);
    if (block.type === 'heading') return V.h(`div.block.heading-block.h${block.level}`, {}, area, chips);
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
    row.append(tick, area, V.h('button.remove-item', { type: 'button', 'aria-label': 'Remove item', tabindex: '-1',
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
     and the "# " / "[] " shortcuts. `event` is the input event (null for a change made here). */
  function typed(block, area, event) {
    afterChange(!event);
    if (event && event.isComposing) return;  // a word still being written: the rest waits for it
    const pasted = !!event && /^insertFrom/.test(event.inputType || '');
    chipsSoon(area, block, !event || pasted);  // a pasted link shows its chip at once
    if (!event || block.type !== 'text') return;
    const index = blocks.indexOf(block);
    if (pasted) tidy(index);
    else if (event.inputType === 'insertText' && / $/.test(event.data || '')) shortcut(index, area);
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

  /* Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) step through Undo; Ctrl+B, Ctrl+I and Ctrl+K make bold, italic and a link. */
  function shortcutKeys(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const target = event.target;
    if (!target || !target.matches || !target.matches('.block-input, .note-title')) return;
    const key = (event.key || '').toLowerCase();
    const inWords = target.matches('.block-input');
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); redo(); }
    else if (inWords && key === 'b') { event.preventDefault(); wrap('**'); }
    else if (inWords && key === 'i') { event.preventDefault(); wrap('_'); }
    else if (inWords && key === 'k') { event.preventDefault(); addLink(); }
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

  /* The chosen words wrapped in `mark` (** for bold, _ for italic), or unwrapped when they already are. */
  function wrap(mark) {
    const at = here();
    if (!at) return;
    finishWord();
    checkpoint();
    const field = at.field;
    const a = field.selectionStart;
    const b = field.selectionEnd;
    const v = field.value;
    const n = mark.length;
    if (v.slice(a - n, a) === mark && v.slice(b, b + n) === mark) replaceValue(field, v.slice(0, a - n) + v.slice(a, b) + v.slice(b + n), a - n, b - n);
    else replaceValue(field, v.slice(0, a) + mark + v.slice(a, b) + mark + v.slice(b), a + n, b + n);
    changed(at.block, field);
  }

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
        V.toast('That didn\'t play. Check your internet and try again.', { kind: 'err' });
      }
    } finally {
      ui.play.classList.remove('loading');
    }
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
      return V.desktop ? 'Vault couldn\'t use the microphone. Check that Windows lets apps use it (Settings, Privacy, Microphone).'
        : 'Vault isn\'t allowed to use the microphone. Allow it in this site\'s settings (the icon by the address), then try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
    if (name === 'NotReadableError') return 'The microphone is busy in another app.';
    return 'The microphone didn\'t start. Try again.';
  }

  async function startMemo() {
    if (!note || recording) return;
    if (note.locked) return V.toast('Locked notes keep words only, not voice memos.');
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
    if (!note || note.id !== id || recording) { stream.getTracks().forEach((t) => t.stop()); return; }
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
    parts.read = V.h('div.read-view', { onclick: readTap }, shown.el);
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
        onclick: () => { note.done = !note.done; save(); drawBar(); if (note.done) V.toast('Nice, done.'); },
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
      !note.locked || revealed ? { label: 'Copy the text', icon: 'copy', onClick: async () => {
        await V.copy([note.title, serialize()].filter(Boolean).join('\n\n'));
        V.toast('Copied');
      } } : null,
      (!note.locked || revealed) && V.chat ? { label: 'Ask Claude about it', icon: 'spark', onClick: () => V.chat.askAbout() } : null,
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
      { label: 'Move to Trash', icon: 'trash', danger: true, onClick: trash },
    ]);
  }

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
  }

  function toolsBar() {
    const tool = (name, label, icon, onClick, keep = true) => V.h('button.tool-btn' + (keep ? '.keep-caret' : ''), {
      type: 'button', title: label, 'aria-label': label, dataset: { tool: name },
      onclick: (event) => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') onClick(event); },
    }, icon, V.h('span.tool-label', { text: label }));
    const F = V.format;
    parts.undo = tool('undo', 'Undo', F.icon('undo'), undo);
    parts.redo = tool('redo', 'Redo', F.icon('redo'), redo);
    parts.strip = V.h('div.tool-strip', { role: 'toolbar', 'aria-label': 'Writing tools' },
      parts.undo, parts.redo, V.h('span.tool-sep'),
      tool('checklist', 'Checklist', V.icon('checklist'), addChecklist),
      tool('list', 'List', F.icon('list'), toggleList),
      tool('heading', 'Heading', F.icon('heading'), addHeading),
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
     (note, words) => whether it shows now) }. Notes opened from then on show it. */
  function addTool(tool) {
    if (tool && tool.name && !extraTools.some((t) => t.name === tool.name)) extraTools.push(tool);
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
    update, setWords, ask, refreshTools, restore, revealed: () => revealed };
})();
