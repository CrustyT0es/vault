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
  let saving = false;

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
    const current = note;
    if (!current) return chain;
    const words = serialize();
    const showing = revealed;
    const body = current.locked ? '' : words;
    const fingerprint = JSON.stringify([current.id, current.title, body, current.folder_id, current.pinned,
      current.due, current.done, current.locked, current.attachments, current.locked && showing ? words : '']);
    if (fingerprint === queued) return chain;
    queued = fingerprint;
    chain = chain.then(() => store(current, body, words, showing)).catch((error) => {
      queued = '';  // not saved: the next change tries again
      V.problem(error);
    });
    return chain;
  }

  async function store(current, body, words, showing) {
    const row = { ...current, body };
    saving = true;
    try {
      // A locked note's words are sealed again only while they're showing; otherwise (its pin, folder or title
      // changed from the locked face) its sealed words stay exactly as they were.
      if (current.locked && showing) row.secret = await V.lock.encrypt(JSON.stringify({ body: words }));
      const saved = await V.cloud.save('notes', row);
      if (note && note.id === saved.id) {
        base = saved;
        note = { ...note, updated_at: saved.updated_at, secret: saved.secret, _dirty: saved._dirty };
      }
    } finally {
      saving = false;
    }
    setStatus();
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

  function grow(area) {
    area.style.height = 'auto';
    area.style.height = area.scrollHeight + 'px';
  }

  function focusBlock(index, where = 'end') {
    const fields = parts.blocks.querySelectorAll('.block-input');
    const field = fields[Math.max(0, Math.min(index, fields.length - 1))];
    if (!field) return;
    field.focus();
    const at = where === 'start' ? 0 : where === 'end' ? field.value.length : where;
    field.setSelectionRange(at, at);
  }

  function drawBlocks(focus) {
    V.clear(parts.blocks, blocks.map((block, index) => {
      const area = V.h('textarea.block-input', {
        rows: 1, value: block.text, spellcheck: 'true',
        placeholder: block.type === 'check' ? 'List item' : index === 0 && blocks.length === 1 ? 'Start writing...' : '',
        'aria-label': block.type === 'check' ? 'Checklist item' : 'Note text',
        oninput: () => {
          if (block.type === 'check' && area.value.includes('\n')) area.value = area.value.replace(/\n/g, ' ');
          block.text = area.value; grow(area); saveSoon(); V.lock.touch();
        },
        onkeydown: (event) => keys(event, index, area),
      });
      requestAnimationFrame(() => grow(area));
      if (block.type === 'text') return V.h('div.block.text-block', {}, area);
      return V.h('div.block.check-row' + (block.done ? '.done' : ''), {},
        V.h('button.tick', {
          type: 'button', 'aria-label': block.done ? 'Not done' : 'Done', 'aria-pressed': String(block.done),
          onclick: () => { block.done = !block.done; drawBlocks(); saveSoon(); },
        }, V.icon('check')), area,
        V.h('button.remove-item', { type: 'button', 'aria-label': 'Remove item', tabindex: '-1',
          onclick: () => { blocks.splice(index, 1); if (!blocks.length) blocks.push({ type: 'text', text: '' }); drawBlocks(); saveSoon(); } },
        V.icon('x')));
    }));
    if (focus) focusBlock(focus[0], focus[1]);  // at once, so the very next key lands in the right row
  }

  function keys(event, index, area) {
    const block = blocks[index];
    const caret = area.selectionStart;
    const whole = area.selectionStart === area.selectionEnd;
    if (block.type === 'check' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!block.text.trim()) {  // Enter on an empty item: the list ends here
        blocks[index] = { type: 'text', text: '' };
        drawBlocks(merge(index));
      } else {
        const after = block.text.slice(area.selectionEnd);
        block.text = block.text.slice(0, caret);
        blocks.splice(index + 1, 0, { type: 'check', done: false, text: after });
        drawBlocks([index + 1, 'start']);
      }
      saveSoon();
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
    const active = document.activeElement;
    const fields = [...parts.blocks.querySelectorAll('.block-input')];
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
      note.due ? V.h('button.chip.done-chip' + (note.done ? '.on' : ''), {
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
        note.pinned ? 'on' : ''),
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
      V.button('Checklist', { icon: 'checklist', onClick: addChecklist, kind: 'quiet' }),
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
    }, parts.bar, V.h('div.editor-scroll', {}, parts.meta, parts.title, parts.body), parts.tools);
    drawBar();
    drawBody();
    setStatus();
  }

  function load(found) {
    if (revealed) quietClipboard(false);
    note = { ...found };
    base = found;
    revealed = false;
    blocks = note.locked ? [] : parse(note.body);
    queued = JSON.stringify([note.id, note.title, note.locked ? '' : note.body, note.folder_id, note.pinned, note.due,
      note.done, note.locked, note.attachments, '']);
    const old = el;
    build();
    if (old && old.parentNode) old.replaceWith(el);
  }

  function open(id, { pane = null, focusTitle = false } = {}) {
    const found = V.data.notes.get(id);
    if (!found) return;
    if (note && openId !== id) { saveSoon.flush(); save(); }
    if (revealed) quietClipboard(false);
    openId = id;
    el = null;
    host = pane || null;
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
    V.emit('data', 'notes');
  });
  V.on('status', () => setStatus());
  /* Where the caret is, so a note changed elsewhere can be shown again without moving it. */
  function caret() {
    const active = document.activeElement;
    if (!el || !active || !el.contains(active)) return null;
    if (active === parts.title) return { title: true, at: active.selectionStart };
    const index = [...parts.blocks.querySelectorAll('.block-input')].indexOf(active);
    return index >= 0 ? { index, at: active.selectionStart } : null;
  }

  V.on('data', (table) => {
    if (table !== 'notes' || !note) return;
    const fresh = V.data.notes.get(note.id);
    if (!fresh || fresh.deleted || fresh._purge) { close(); return; }
    // Typed here and not saved yet, or saved here and not sent yet: what's on screen is newer.
    if (fresh._dirty || saving || saveSoon.pending()) return;
    if (sameNote(fresh, base)) { base = fresh; note.updated_at = fresh.updated_at; return; }  // our own save, back
    // Changed on the other device (or by Jarvis) with nothing typed here since: show that version, caret kept.
    const spot = caret();
    const showing = revealed && fresh.locked;
    load(fresh);
    if (showing && V.lock.unlocked()) reveal();
    else if (spot && spot.title) { parts.title.focus(); parts.title.setSelectionRange(spot.at, spot.at); }
    else if (spot) focusBlock(spot.index, spot.at);
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

  return { open, close, placeholder, openId: () => openId, parse, addPictures };
})();
