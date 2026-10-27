/* Vault: one note, open for writing. The words are kept as plain text (what Jarvis reads too), with checklist
   lines as "- [ ] milk" / "- [x] milk"; here they're shown as blocks: free text, and tick-box rows where Enter
   makes the next item. Everything saves by itself a moment after typing stops. Pictures go to the cloud as soon as
   they're added (a note's own folder in the vault bucket). A locked note is only ever decrypted in memory. */
'use strict';

V.editor = (() => {
  const CHECK = /^(\s*)[-*]\s*\[( |x|X)\]\s?(.*)$/;
  const MAX_SIDE = 1600;
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

  /* -- the words as blocks */

  function parse(body) {
    const out = [];
    let text = [];
    const flush = () => { if (text.length) { out.push({ type: 'text', text: text.join('\n') }); text = []; } };
    for (const line of (body || '').split('\n')) {
      const box = CHECK.exec(line);
      if (box) { flush(); out.push({ type: 'check', done: box[2] !== ' ', text: box[3] }); }
      else text.push(line);
    }
    flush();
    return out.length ? out : [{ type: 'text', text: '' }];
  }

  const serialize = () => blocks.map((b) => (b.type === 'check' ? `- [${b.done ? 'x' : ' '}] ${b.text}` : b.text)).join('\n');

  /* -- saving */

  const saveSoon = V.debounce(() => save(), 500);
  let chain = Promise.resolve();
  let queued = '';  // the last state handed to the chain: the same one isn't saved twice

  /* Saving takes a snapshot of the note now (it may be closed a moment later) and saves the snapshots one after
     another, so an older one can never land after a newer one. */
  function save() {
    // A change from elsewhere still waiting goes in first: saving over it would lose it.
    if (pending && !saving) takeRemote();
    const current = note;
    if (!current) return chain;
    const words = serialize();
    const showing = revealed;
    const body = current.locked ? '' : words;
    const fingerprint = JSON.stringify([current.id, current.title, body, current.folder_id, current.pinned,
      current.due, current.done, current.locked, current.attachments, current.locked && showing ? words : '']);
    if (fingerprint === queued) return chain;
    queued = fingerprint;
    saving++;
    chain = chain.then(() => store(current, body, words, showing)).catch((error) => {
      queued = '';  // not saved: the next change tries again
      V.problem(error);
    }).finally(() => {
      saving--;
      if (!saving && pending) setTimeout(takeRemote);
    });
    return chain;
  }

  async function store(current, body, words, showing) {
    const row = { ...current, body };
    // A locked note's words are sealed again only while they're showing; otherwise (its pin, folder or title
    // changed from the locked face) its sealed words stay exactly as they were.
    if (current.locked && showing) row.secret = await V.lock.encrypt(JSON.stringify({ body: words }));
    const saved = await V.cloud.save('notes', row);
    if (note && note.id === saved.id) {
      base = saved;
      if (!current.locked || showing) savedWords = words;
      remember(words);
      note = { ...note, updated_at: saved.updated_at, secret: saved.secret, _dirty: saved._dirty };
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
    && (a.locked ? a.secret === b.secret : a.body === b.body) && paths(a) === paths(b);

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
    if (SIZES_ITSELF) return;
    const scroller = area.closest('.editor-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    area.style.height = 'auto';
    area.style.height = area.scrollHeight + 'px';
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
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
    for (let i = 0; i < index; i++) line += blocks[i].type === 'check' ? 1 : blocks[i].text.split('\n').length;
    const before = active.value.slice(0, active.selectionStart).split('\n');
    const check = blocks[index].type === 'check';
    const text = check ? serialize().split('\n')[line] : active.value.split('\n')[before.length - 1];
    return { line: line + before.length - 1, col: before[before.length - 1].length + (check ? 6 : 0), text };
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
      const lines = block.type === 'check' ? [block.text] : block.text.split('\n');
      if (line < lines.length || i === blocks.length - 1) {
        line = Math.min(line, lines.length - 1);
        if (block.type === 'check') return focusBlock(i, Math.max(0, Math.min(col - 6, block.text.length)));
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
    V.clear(parts.blocks, blocks.map((block, index) => {
      const area = V.h('textarea.block-input', {
        rows: 1, value: block.text, spellcheck: 'true', autocapitalize: 'sentences',
        placeholder: block.type === 'check' ? 'List item' : index === 0 && blocks.length === 1 ? 'Start writing...' : '',
        'aria-label': block.type === 'check' ? 'Checklist item' : 'Note text',
        oninput: (event) => {
          // A new line in a list item (a keyboard that skipped the Enter key below) is tidied once the word is done:
          // changing the words mid-word would break the keyboard's word.
          if (block.type === 'check' && !event.isComposing && area.value.includes('\n')) {
            area.value = area.value.replace(/\n/g, ' ');
          }
          block.text = area.value; grow(area); saveSoon(); V.lock.touch();
        },
        onkeydown: (event) => keys(event, index, area),
        // Phone keyboards often send Enter as a typed new line rather than a key: in a list it still makes the next item.
        onbeforeinput: (event) => {
          if (block.type === 'check' && (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')) {
            event.preventDefault();
            nextItem(index, area);
          }
        },
      });
      requestAnimationFrame(() => grow(area));
      if (block.type === 'text') return V.h('div.block.text-block', {}, area);
      const row = V.h('div.block.check-row' + (block.done ? '.done' : ''));
      const tick = V.h('button.tick', {
        type: 'button', 'aria-label': block.done ? 'Not done' : 'Done', 'aria-pressed': String(block.done),
        // Ticked where it is: rebuilding the rows would close the phone's keyboard.
        onclick: () => {
          block.done = !block.done;
          row.classList.toggle('done', block.done);
          tick.setAttribute('aria-pressed', String(block.done));
          tick.setAttribute('aria-label', block.done ? 'Not done' : 'Done');
          saveSoon();
        },
      }, V.icon('check'));
      row.append(tick, area, V.h('button.remove-item', { type: 'button', 'aria-label': 'Remove item', tabindex: '-1',
        onclick: () => {
          // The caret stays with the words it was in (the mousedown kept it); none appears if there wasn't one, so
          // no keyboard pops up.
          const spot = caretSpot();
          const before = serialize();
          blocks.splice(index, 1);
          if (!blocks.length) blocks.push({ type: 'text', text: '' });
          merge();  // words either side of the item are one block again
          drawBlocks();
          if (spot) placeCaret(spot, V.mergeLines(before, before, serialize()).map);
          saveSoon();
        } },
      V.icon('x')));
      return row;
    }));
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    if (focus) focusBlock(focus[0], focus[1]);  // at once, so the very next key lands in the right row
  }

  /* Enter in a list item: the next item (or, on an empty one, the end of the list). */
  function nextItem(index, area) {
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
  }

  function keys(event, index, area) {
    if (event.isComposing || event.keyCode === 229) return;  // the keyboard is still writing a word
    const block = blocks[index];
    const caret = area.selectionStart;
    const whole = area.selectionStart === area.selectionEnd;
    if (block.type === 'check' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      nextItem(index, area);
    } else if (event.key === 'Backspace' && whole && caret === 0 && index > 0) {
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
    } else if (event.key === 'ArrowUp' && whole && !area.value.slice(0, caret).includes('\n') && index > 0) {
      event.preventDefault();
      focusBlock(index - 1, 'end');
    } else if (event.key === 'ArrowDown' && whole && !area.value.slice(caret).includes('\n') && index < blocks.length - 1) {
      event.preventDefault();
      focusBlock(index + 1, 'start');
    }
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

  /* The toolbar's checklist button: the line the caret is on becomes a tick-box item (or a new one at the end). */
  function addChecklist() {
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    // With the caret in the title, a new item goes at the end (not on whichever line was written in before).
    const active = fields.includes(document.activeElement) ? document.activeElement
      : document.activeElement === parts.title ? null : lastField;
    const index = fields.indexOf(active);
    if (index >= 0 && blocks[index].type === 'text') {
      const block = blocks[index];
      const caret = active.selectionStart;
      const start = block.text.lastIndexOf('\n', caret - 1) + 1;
      const endAt = block.text.indexOf('\n', caret);
      const end = endAt < 0 ? block.text.length : endAt;
      const pieces = [];
      if (start > 0) pieces.push({ type: 'text', text: block.text.slice(0, start - 1) });
      pieces.push({ type: 'check', done: false, text: block.text.slice(start, end) });
      if (end < block.text.length) pieces.push({ type: 'text', text: block.text.slice(end + 1) });
      blocks.splice(index, 1, ...pieces);
      drawBlocks([index + (start > 0 ? 1 : 0), 'end']);
    } else if (index >= 0 && blocks[index].type === 'check') {
      blocks.splice(index + 1, 0, { type: 'check', done: false, text: '' });
      drawBlocks([index + 1, 'start']);
    } else {
      const last = blocks[blocks.length - 1];
      if (last.type === 'text' && !last.text.trim()) blocks[blocks.length - 1] = { type: 'check', done: false, text: '' };
      else blocks.push({ type: 'check', done: false, text: '' });
      drawBlocks([blocks.length - 1, 'start']);
    }
    saveSoon();
  }

  /* -- pictures */

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

  async function addPictures(files) {
    if (!note) return;
    if (note.locked) return V.toast('Locked notes keep words only, not pictures.');
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return V.toast('Only pictures can go in a note. Send other files from the Send tab.');
    if (!navigator.onLine) return V.toast('Adding pictures needs the internet.', { kind: 'err' });
    const user = V.data.user;
    for (const file of images) {
      const holder = V.h('div.thumb.loading', {}, V.h('div.spinner'));
      parts.pictures.prepend(holder);
      try {
        const small = await shrink(file);
        const path = `${user.id}/notes/${note.id}/${V.uuid()}.${small.type === 'image/jpeg' ? 'jpg' : V.storageName(small.name).split('.').pop()}`;
        await V.cloud.upload(path, small.blob, { mime: small.type });
        await V.db.put('files', { key: path, blob: small.blob, at: Date.now() });
        note.attachments = [...(note.attachments || []), { path, name: small.name, mime: small.type, size: small.blob.size, w: small.w || 0, h: small.h || 0 }];
        await save();
      } catch (error) {
        V.problem(error);
      } finally {
        holder.remove();
        drawPictures();
      }
    }
  }

  function drawPictures() {
    const list = (note && note.attachments) || [];
    V.clear(parts.pictures, list.map((a) => {
      const img = V.h('img', { alt: a.name || 'Picture', loading: 'lazy' });
      V.cloud.blob(a.path).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.classList.add('broken'));
      return V.h('button.thumb', { type: 'button', onclick: () => viewPicture(a, img), 'aria-label': 'Open picture' }, img);
    }));
    parts.pictures.hidden = !list.length;
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
        { label: 'Done', kind: 'primary' },
      ],
    });
  }

  /* -- the bar on top */

  function folderPicker() {
    const select = V.h('select.folder-pick', {
      'aria-label': 'Folder',
      onchange: () => { note.folder_id = select.value || null; save(); },
    }, V.h('option', { value: '', text: 'No folder' }), V.notes.folders().map((f) => V.h('option', {
      value: f.id, text: (f.icon ? f.icon + ' ' : '') + f.name,
    })));
    select.value = note.folder_id && V.data.folders.has(note.folder_id) ? note.folder_id : '';
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
    V.clear(parts.meta, dueButton());
    V.clear(parts.bar,
      host ? null : V.iconButton('back', 'Back to notes', close, 'back'),
      folderPicker(),
      V.h('div.bar-spacer'),
      V.iconButton('pin', note.pinned ? 'Unpin' : 'Pin to the top', () => { note.pinned = !note.pinned; save(); drawBar(); },
        (note.pinned ? 'on ' : '') + 'keep-caret'),
      V.iconButton(note.locked ? 'lock' : 'unlock', note.locked ? 'Locked' : 'Lock this note', toggleLock, note.locked ? 'on' : ''),
      V.iconButton('more', 'More', (event) => moreMenu(event.currentTarget)));
  }

  function moreMenu(anchor) {
    V.menu(anchor, [
      !note.locked || revealed ? { label: `Send to ${V.otherName}`, icon: 'send', onClick: sendNote } : null,
      !note.locked || revealed ? { label: 'Copy the text', icon: 'copy', onClick: async () => {
        await V.copy([note.title, serialize()].filter(Boolean).join('\n\n'));
        V.toast('Copied');
      } } : null,
      note.locked ? { label: 'Remove the lock', icon: 'unlock', onClick: removeLock } : null,
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
    if ((note.attachments || []).length) return V.toast('Remove the pictures first: locked notes keep words only.');
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
    } catch (error) {
      V.problem(error);
    }
  }

  function hide() {
    revealed = false;
    blocks = [];
    quietClipboard(false);
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
    V.clear(parts.body, parts.blocks, parts.pictures);
    parts.tools.hidden = false;
    drawBlocks();
    drawPictures();
  }

  function build() {
    parts = {
      bar: V.h('div.editor-bar'),
      meta: V.h('div.note-meta'),
      title: V.h('input.note-title', {
        type: 'text', placeholder: 'Title', value: note.title || '', 'aria-label': 'Title', maxlength: '200',
        oninput: () => { note.title = parts.title.value; saveSoon(); },
        onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); focusBlock(0, 'end'); } },
      }),
      body: V.h('div.editor-body'),
      blocks: V.h('div.blocks'),
      pictures: V.h('div.pictures'),
      status: V.h('span.save-state'),
      file: V.h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true,
        onchange: () => { addPictures(parts.file.files); parts.file.value = ''; } }),
    };
    parts.tools = V.h('div.editor-tools', {},
      V.button('Checklist', { icon: 'checklist', onClick: addChecklist, kind: 'quiet keep-caret' }),
      V.button('Picture', { icon: 'camera', onClick: () => parts.file.click(), kind: 'quiet' }),
      V.h('div.bar-spacer'), parts.status, parts.file);
    el = V.h('article.editor', {
      ondragover: (event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.stopPropagation(); el.classList.add('dropping'); } },
      ondragleave: () => el.classList.remove('dropping'),
      ondrop: (event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault(); event.stopPropagation(); el.classList.remove('dropping');
        addPictures(event.dataTransfer.files);
      },
      onpaste: (event) => {
        const files = [...(event.clipboardData || {}).files || []].filter((f) => f.type.startsWith('image/'));
        if (files.length) { event.preventDefault(); addPictures(files); }
      },
      // The buttons that act on the words where they are (tick, remove, checklist, pin) leave the caret, and the
      // phone's keyboard, where they were. The ones that open something (a picture, the PIN pad, a menu) don't: what
      // was typed next would go into the note hidden behind it.
      // A tap on the bars' empty parts (beside the buttons, on "Saved") leaves it there too.
      onmousedown: (event) => {
        if (!keepsCaret()) return;
        const target = event.target;
        if (target.closest('.tick, .remove-item, .keep-caret')) event.preventDefault();
        else if (target.closest('.editor-tools, .editor-bar, .note-meta, .pictures')
          && !target.closest('button, select, input, textarea, a, label')) event.preventDefault();
      },
      onfocusin: (event) => {
        if (event.target.matches && event.target.matches('.block-input')) lastField = event.target;
        else if (event.target === parts.title) lastField = null;
      },
      oncompositionstart: (event) => { composingField = event.target; },
      oncompositionend: () => { composingField = null; },
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
      },
    }, parts.meta, parts.title, parts.body), parts.tools);
    drawBar();
    drawBody();
    setStatus();
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
    n.locked, n.attachments, '']);

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
    const found = V.data.notes.get(id);
    if (!found) return;
    const before = host;
    if (note && openId === id && el) {
      // Already open (the Notes tab drawn again, its own card tapped): the same editor moves, with its unsaved words,
      // caret and all.
      host = pane || null;
      if (before && before !== host) emptyPane(before);
      if (pane) {
        if (layer) { layer.remove(); layer = null; if (history.state && history.state.vault === 'note') history.back(); }
        if (el.parentNode !== pane) V.clear(pane, el);
      } else if (!layer) {
        history.pushState({ vault: 'note' }, '');
        layer = V.h('div.editor-layer.shown', {}, el);
        document.getElementById('layers').append(layer);
      }
      drawBar();
      return;
    }
    if (note) { saveSoon.flush(); save(); }
    if (revealed) quietClipboard(false);
    openId = id;
    el = null;
    host = pane || null;
    pending = null;
    known = [];
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
    if (note.locked && V.lock.unlocked()) reveal();
    if (focusTitle) {
      // A blank title, or one a template started ("Homework: "), is where the typing goes first.
      if (!note.title || /:\s*$/.test(note.title)) {
        parts.title.focus();
        parts.title.setSelectionRange(parts.title.value.length, parts.title.value.length);
      } else focusBlock(blocks.length - 1, 'end');
    }
  }

  function close() {
    saveSoon.flush();
    save();
    if (revealed) quietClipboard(false);
    revealed = false;
    openId = null;
    note = null;
    composingField = null;
    pending = null;
    if (layer) {
      const leaving = layer;
      layer = null;
      leaving.classList.remove('shown');
      setTimeout(() => leaving.remove(), 200);
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
    V.clear(pane, V.h('div.pane-empty', {}, V.h('div.orb.big'), V.h('p', { text: 'Pick a note, or make a new one.' }),
      V.h('p.hint', { text: 'Ctrl+N for a new note. Ctrl+Alt+N anywhere on the PC for a quick one.' })));
  }

  window.addEventListener('popstate', () => {
    if (!layer) return;
    layer.remove();
    layer = null;
    saveSoon.flush();
    save();
    if (revealed) quietClipboard(false);
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
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
    if (next.length !== blocks.length || fields.length !== next.length || next.some((b, i) => b.type !== blocks[i].type)) return false;
    const put = (field, value) => { if (field.value !== value) field.value = value; };
    note = { ...target };
    // The rows' own objects are changed, not swapped: each box's handlers hold on to its row.
    next.forEach((b, i) => { blocks[i].text = b.text; blocks[i].done = b.done; });
    put(parts.title, note.title || '');
    fields.forEach((field, i) => {
      put(field, next[i].text);
      grow(field);
      const row = field.closest('.check-row');
      if (row) {
        row.classList.toggle('done', next[i].done);
        const tick = row.querySelector('.tick');
        tick.setAttribute('aria-pressed', String(next[i].done));
        tick.setAttribute('aria-label', next[i].done ? 'Not done' : 'Done');
      }
    });
    drawBar();
    drawPictures();
    setStatus();
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
  }

  const wordInProgress = () => !!composingField && composingField.isConnected && document.activeElement === composingField;
  const sameAs = (a, b) => a.title === b.title && a.folder_id === b.folder_id && a.pinned === b.pinned && a.due === b.due
    && a.done === b.done && a.locked === b.locked && paths(a) === paths(b);

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
      secret: locked ? theirs.secret || note.secret : null };
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    saveSoon.flush();
    // Saved (sealed with the key) first, then the words hidden and the key forgotten.
    save().finally(() => {
      if (note && note.locked && revealed) hide();
      V.lock.forget();
    });
  });

  return { open, close, placeholder, openId: () => openId, covering: () => !!layer, parse, addPictures };
})();
