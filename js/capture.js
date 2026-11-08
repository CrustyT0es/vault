/* Wefty 1.19: capture with no effort (the owner: "5 is what I was more after"). Two ways in, one result: a tidy note.

   Snap a page (V.capture.snap): Today's Snap tile, the new-note sheet, Chat's attach menu (and Task B's welcome, which
   asks `V.capture && V.capture.snap` first). A phone opens its camera straight away; a Chromebook or the PC a file
   picker (several pages at once). Each photo is made a JPEG of at most EDGE px on its long side, then the AI that
   writes the note-taker's notes reads them (V.ai.ask with the pictures: the free Gemini unless Claude is the one picked
   for notes, as Make flash cards does) into a title, headings, points and equations as plain text, transcribed as
   written: what can't be read for sure is marked [?]. The note shows first, in a sheet: its title and words (both can
   be changed), where it goes (the folder used last on this device), "Also make flash cards", Save note. Nothing is
   kept before Save note; Cancel stops the AI. More pages can be added there (the photos are read again together).
   Saved, the note has its photos (their `page` number marks them) and opens; "Also make flash cards" then opens Make
   flash cards for it (js/aicards.js: its own sheet, nothing added before Add).

   No key: the free Gemini's setup is offered (or the photo kept for later). Offline: the photo can be kept as a note
   now; its photos wait on this device (V.db meta `capture-files:<note>`, `capture-waiting`) and go up as soon as it's
   back online, and the page is then read by itself (`capture-wanted`): a toast says it's ready to look at, and still
   nothing is written into the note before Save note. A note kept that way (or a screenshot saved from a share) has a
   "Read this page" chip, which does the same at any time. There's no reading on the PC without the internet: Jarvis's
   own OCR (vault/attach_index.py) only runs inside the attachment search, with no call the page can make.

   Share to Wefty (V.capture.share): what another app shares (Android's share sheet: sw.js keeps it, js/send.js hands
   it over) or what was copied and then pasted here (V.capture.paste: the iPhone's way, as Safari gives web apps no
   place in the Share menu). One sheet shows it tidied (a link as its title and site, the words, the files), where it
   goes (the folder used last) and "Save to Wefty". Saved: a note made at once, then what's next: Open, Read it (a
   screenshot or a PDF, read like Snap), Remind me, Make flash cards. Words shared alone are still copied on every
   device at once (1.11), and Send to PC is still there. */
'use strict';

V.capture = (() => {
  const EDGE = 2048;                     // a page photo's longest side (JPEG): small print and handwriting stay readable
  const QUALITY = 0.85;
  const MOST_PAGES = 10;                 // photos one Snap reads together
  const PDF_MOST = 20 * 1024 * 1024;     // a PDF Read it sends (what Gemini and Claude both take in one request)
  const FILE_MOST = 50 * 1024 * 1024;    // the cloud's most for one file (vault/schema.sql)
  const TITLE_MOST = 120;
  const FOLDER_KEY = 'vault-capture-folder';  // the folder a capture went into last, on this device
  const CARDS_KEY = 'vault-capture-cards';    // "Also make flash cards" as it was left, on this device
  const WAITING = 'capture-waiting';          // V.db meta: the notes with files waiting here to go up
  const WANTED = 'capture-wanted';            // V.db meta: the notes to read once this device is back online
  const filesKey = (id) => `capture-files:${id}`;
  const PICTURE = /^image\/(?:jpeg|jpg|png|webp|gif|bmp|heic|heif|avif)$/i;
  const LINK = /\bhttps?:\/\/[^\s<>"']+/i;
  const UNCLEAR = /\[\?\]/g;

  const SYSTEM = [
    'You turn photos of a student\'s pages into a clean note for Wefty, their notes app.',
    'The photos may be a printed handout, a textbook page, a whiteboard or a handwritten notebook page. Several photos '
      + 'are the pages of one thing, in order.',
    'Answer in exactly this form and nothing else:',
    'Title: <a short title for the note>',
    '<the note>',
    'In the note, write out what the pages say, faithfully and in their order. Keep their headings as lines starting '
      + 'with "# " (or "## " under them), lists as lines starting with "- " (or "1. " when numbered), and tick boxes as "- [ ] ".',
    'Write equations and formulas as plain text, each on its own line, like: x^2 + 3x - 4 = 0, (a + b)/2, sqrt(x), H2O, '
      + 'CO2. Write a table as one "- " line a row, with " | " between its cells.',
    'Leave out page numbers, running headers and footers, and anything that isn\'t part of what the page teaches.',
    'Never add facts, explanations or answers that aren\'t on the pages, and never correct what they say. Keep the '
      + 'language of the pages.',
    'Handwriting and whiteboards: transcribe them as they are. Where a word, number or symbol can\'t be read for sure '
      + '(messy writing, glare, blur, cut off), write your best guess followed by [?], or just [?] when you can\'t guess.',
    'A drawing or diagram becomes one line in square brackets, like: [Diagram: the water cycle, from the sea to the clouds and back].',
    'If the photos have nothing to read, answer with just: NOTHING',
  ].join('\n');

  const O = () => V.organise;
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const nameOf = (who) => (who === 'claude' ? 'Claude' : 'Gemini');
  const isPicture = (f) => PICTURE.test((f && f.type) || '') || (!(f && f.type) && /\.(?:jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test((f && f.name) || ''));
  const isPdf = (f) => (f && f.type) === 'application/pdf' || /\.pdf$/i.test((f && f.name) || '');
  const liveFolder = (id) => { const f = id ? V.data.folders.get(id) : null; return f && !f.deleted ? f : null; };
  const stem = (name) => String(name || '').replace(/\.[a-z0-9]{1,10}$/i, '');
  const store = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (error) { /* this page only */ } };
  const stored = (key) => { try { return localStorage.getItem(key); } catch (error) { return null; } };

  /* Words cut to `most` letters at a space, with "…". */
  function cut(text, most) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= most) return s;
    const at = s.lastIndexOf(' ', most - 1);
    return `${s.slice(0, at > most / 2 ? at : most - 1).replace(/[\s,;:.-]+$/, '')}…`;
  }

  /* -- where it goes: the folder used last on this device (while it's still there), else the Inbox */

  function lastFolder() {
    const kept = liveFolder(stored(FOLDER_KEY));
    if (kept) return kept.id;
    return (V.notes.inbox() || {}).id || '';
  }
  function folderChoice(current) {
    const select = V.h('select.field.cap-folder', { 'aria-label': 'Save in' },
      O().tree().map(({ folder, depth }) => V.h('option', { value: folder.id,
        text: `${' '.repeat(Math.min(depth, 4))}${folder.icon ? folder.icon + ' ' : ''}${folder.name}` })));
    if (current) select.value = current;
    return V.h('label.cap-where', {}, V.h('span.cap-where-label', { text: 'Save in' }), select);
  }
  const folderName = (id) => (liveFolder(id) || {}).name || 'Inbox';

  /* -- the photos */

  /* A file made ready to read and keep: a picture as a JPEG of at most EDGE px (turned upright, on white), a PDF as it
     is. { blob, type, name, w, h }; throws with words to show. */
  async function prepare(file) {
    const name = String((file && file.name) || 'page');
    if (isPdf(file)) {
      if (file.size > PDF_MOST) throw new Error(`${name} is too big to read (20 MB at most).`);
      return { blob: file, type: 'application/pdf', name };
    }
    const picture = await decoded(file);
    if (!picture) throw new Error(`${name} couldn't be opened. Try a JPEG or PNG photo.`);
    const scale = Math.min(1, EDGE / Math.max(picture.width, picture.height, 1));
    const w = Math.max(1, Math.round(picture.width * scale));
    const h = Math.max(1, Math.round(picture.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(picture.source, 0, 0, w, h);
    picture.done();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error(`${name} couldn't be opened. Try a JPEG or PNG photo.`);
    return { blob, type: 'image/jpeg', name: `${stem(name) || 'page'}.jpg`, w, h };
  }

  /* A picture ready to draw, turned upright: { source, width, height, done() }, or null. createImageBitmap first (an
     older Safari knows no 'from-image' and throws: then without it), else an <img>, which every browser shows upright
     and which reads whatever it can show (an iPhone's own photos too). */
  async function decoded(file) {
    for (const options of [{ imageOrientation: 'from-image' }, undefined]) {
      try {
        const bitmap = await createImageBitmap(file, options);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => { if (bitmap.close) bitmap.close(); } };
      } catch (error) { /* the next way */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) throw new Error('empty');
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch (error) {
      URL.revokeObjectURL(url);
      return null;
    }
  }

  const base64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  /* One hidden file box, clicked in the tap that asked (a browser only opens a picker for a tap). A phone: the camera
     (`camera`), else the photos; elsewhere the file picker, several at once. */
  let picker = null;
  function pick({ camera = V.device === 'phone' && !V.desktop, pdf = false } = {}) {
    if (picker) picker.remove();
    const input = V.h('input.cap-input', { type: 'file', accept: pdf ? 'image/*,application/pdf' : 'image/*', hidden: true });
    if (camera) input.setAttribute('capture', 'environment');
    else input.multiple = true;
    picker = input;
    document.body.append(input);
    return new Promise((resolve) => {
      input.addEventListener('change', () => { resolve([...(input.files || [])]); input.remove(); }, { once: true });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
      input.click();
    });
  }

  /* -- reading */

  /* The AI's answer as { title, body, unclear }; null when it found nothing to read. */
  function parse(text) {
    let s = String(text || '').replace(/\r/g, '').trim();
    const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(s);
    if (fenced) s = fenced[1].trim();
    if (!s || /^NOTHING\.?$/i.test(s)) return null;
    const lines = s.split('\n');
    let title = '';
    const named = /^\s*title\s*[:\-–]\s*(.+)$/i.exec((lines[0] || '').replace(/\*\*|__/g, ''));
    if (named) { title = named[1]; lines.shift(); } else if (/^#\s+\S/.test(lines[0] || '')) title = lines.shift().replace(/^#\s+/, '');
    const body = lines.join('\n').replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    title = cut(V.format.unmark(title).replace(/^["“]|["”]$/g, ''), TITLE_MOST);
    if (!title && !body.trim()) return null;
    return { title, body, unclear: (body.match(UNCLEAR) || []).length + (title.match(UNCLEAR) || []).length };
  }

  /* `pages` ({ blob, type }) read by the AI: { title, body, unclear, who }, or null when there was nothing to read. An
     AiError says why it couldn't. */
  async function read(pages, { signal = null, onBrain = null } = {}) {
    const images = [];
    for (const p of pages) images.push({ mime: p.type, data: await base64(p.blob) });
    const n = pages.length;
    const answer = await V.ai.ask({ system: SYSTEM, images, signal, tallyFree: false, onBrain,
      text: n === 1 ? 'Read this page into a note.' : `Read these ${n} pages into one note, in their order.` });
    if (signal && signal.aborted) throw new V.ai.AiError('stopped', 'Stopped.');
    if (answer.stopReason === 'refusal') throw new V.ai.AiError('refusal', 'Refused.');
    const got = parse(answer.text);
    return got && { ...got, who: answer.usage && answer.usage.gemini ? 'gemini' : 'claude' };
  }

  /* An AiError in plain words, and what can be done: { title, words, setUp, again, keep }. */
  function trouble(error, who) {
    const name = nameOf(who);
    switch (error && error.kind) {
      case 'nokey':
        return who === 'claude' ? { title: 'Claude isn\'t set up here', words: error.message, settings: true, keep: true }
          : { title: 'Set up the free Gemini', words: 'Reading a page uses the free Gemini. It needs a free key from your own Google account: set it up once and it works on all your devices.', setUp: true, keep: true };
      case 'off': case 'key': return { title: 'Can\'t read it yet', words: error.message, settings: true, keep: true };
      case 'offline':
        return !navigator.onLine ? { title: 'You\'re offline', offline: true, keep: true,
          words: 'Keep the photo as a note now: Wefty reads it by itself when you\'re back online.' }
          : { title: 'Can\'t reach it', again: true, keep: true, words: error.cloud ? 'Your cloud can\'t be reached just now. Check your connection and try again, or keep the photo for later.'
            : `${name} can't be reached from this network. Try again on another one, or keep the photo for later.` };
      case 'busy':
        return { title: `${name} is busy`, again: true, keep: true, words: error.why === 'quota'
          ? 'Google\'s free Gemini limit is used up for now. Try again in a little while, or keep the photo for later.'
          : `${name} is ${error.slow ? 'taking too long' : 'busy'} right now. Try again in a minute, or keep the photo for later.` };
      case 'limit': case 'old': return { title: 'Can\'t read it here', words: error.message, keep: true };
      case 'refusal': return { title: 'Not read', words: `${name} didn't read this photo.`, keep: true };
      default: return { title: 'Not read', words: (error && error.message) || 'Something went wrong. Try again.', again: true, keep: true };
    }
  }

  /* -- files that wait here until they're in the cloud

     A note's photos (and a share's files) go up now, or when this device is next online: kept in V.db meta until then
     (blobs, never anywhere but this device), each put into the note as it goes up. */

  const waitingHere = new Set();  // notes with files waiting on this device (the chip says so)
  let loaded = null;
  function loadWaiting() {
    if (!loaded) {
      loaded = (async () => {
        for (const id of (await V.db.meta(WAITING)) || []) waitingHere.add(id);
      })().catch(() => {});
    }
    return loaded;
  }
  const saveWaiting = () => V.db.meta(WAITING, [...waitingHere]);

  async function keep(noteId, files) {
    if (!files.length) return;
    await loadWaiting();
    const had = (await V.db.meta(filesKey(noteId))) || [];
    await V.db.meta(filesKey(noteId), [...had, ...files]);
    waitingHere.add(noteId);
    await saveWaiting();
    flush();
  }

  /* How many files wait on this device to go up (signing out would throw them away: js/cloud.js's unsent counts
     them). */
  async function waitingFiles() {
    await loadWaiting();
    let count = 0;
    for (const id of waitingHere) count += ((await V.db.meta(filesKey(id))) || []).filter((f) => !f.item).length;
    return count;
  }

  let flushing = Promise.resolve();
  function flush() {
    flushing = flushing.then(() => sendWaiting().catch((error) => console.warn('Wefty: files waiting to go up', error)));
    return flushing;
  }

  async function sendWaiting() {
    await loadWaiting();
    const user = V.data.user;
    if (!navigator.onLine || !user || !user.id) return;
    for (const id of [...waitingHere]) {
      const row = V.data.notes.get(id);
      if (!row || row._purge) {  // (the note was deleted for good meanwhile: its files go too)
        await V.db.meta(filesKey(id), null);
        waitingHere.delete(id);
        await saveWaiting();
        continue;
      }
      if (row.locked) continue;  // (a locked note keeps words only: they wait here until it's unlocked)
      const files = (await V.db.meta(filesKey(id))) || [];
      const items = [];
      let stuck = false;
      for (const f of files) {
        if (f.item) { items.push(f.item); continue; }
        const ending = f.type === 'image/jpeg' ? 'jpg' : ((/\.([a-z0-9]{1,10})$/i.exec(f.name || '') || [])[1] || '').toLowerCase();
        const path = `${user.id}/notes/${id}/${V.uuid()}${ending ? '.' + ending : ''}`;
        try {
          await V.cloud.upload(path, f.blob, { mime: f.type });
        } catch (error) {
          stuck = true;  // (offline again, or the cloud said no: tried again later)
          if (error && error.full) V.problem(error);  // (out of room: said, with a button: js/send.js's V.storage)
          break;
        }
        if (f.blob.size < 6 * 1024 * 1024) await V.db.put('files', { key: path, blob: f.blob, at: Date.now() }).catch(() => {});
        f.item = { path, name: f.name, mime: f.type, size: f.blob.size, ...(f.w ? { w: f.w, h: f.h } : {}), ...(f.page ? { page: f.page } : {}) };
        items.push(f.item);
        await V.db.meta(filesKey(id), files);  // (what's up already is never sent twice)
      }
      if (items.length) {
        const ok = await V.editor.changeAttachments(id, (list) => [...list,
          ...items.filter((item) => !list.some((a) => a.path === item.path))]);
        if (!ok) { V.cloud.remove(items.map((i) => i.path)).catch(() => {}); stuck = false; }
      }
      if (!stuck) {
        await V.db.meta(filesKey(id), null);
        waitingHere.delete(id);
        await saveWaiting();
      }
      if (items.length && V.editor.openId() === id) V.editor.update(() => {}, { draw: true });  // (the chip says they're in)
    }
    readWanted();
  }

  /* -- reading later: the notes this device was asked to read once it's back online */

  const ready = new Map();  // note id -> what was read for it (shown when the toast's Look or the chip is tapped)
  let readingLater = false;
  // A read by itself that the AI couldn't finish (busy, too slow, cut off: Claude still charges what it had read and
  // written) waits longer each time, and after AUTO_TRIES on this device it's left to the note's "Read this page" chip.
  const AUTO_TRIES = 3;
  const AUTO_WAIT = 2 * 60000;   // the first wait, doubled each time
  const autoTried = new Map();   // note id -> { n, next } (this visit)
  async function wanted() { return new Set((await V.db.meta(WANTED)) || []); }
  async function want(id, on) {
    const set = await wanted();
    if (on) set.add(id); else set.delete(id);
    await V.db.meta(WANTED, [...set]);
  }

  async function readWanted() {
    if (readingLater || !navigator.onLine || V.away()) return;
    readingLater = true;
    try {
      for (const id of await wanted()) {
        if (waitingHere.has(id)) continue;  // (its photos go up first)
        const tried = autoTried.get(id);
        if (tried && Date.now() < tried.next) continue;
        const row = V.data.notes.get(id);
        if (!row || row._purge || row.deleted || row.locked || !needsReading(row)) { await want(id, false); continue; }
        const pages = await pagesOf(id).catch(() => []);
        if (!pages.length) { await want(id, false); continue; }
        try {
          const got = await read(pages);
          await want(id, false);
          autoTried.delete(id);
          if (!got) continue;
          ready.set(id, got);
          V.toast(`Your page "${cut(got.title || V.noteTitle(row), 40)}" is read. Have a look before it goes in.`, {
            ms: 10000, action: 'Look', onAction: () => readNote(id) });
        } catch (error) {
          // No internet: tried again next time. Busy: later, then left to the chip. Anything else (no key): the chip in
          // the note says what to do.
          if (error && error.kind === 'busy') {
            const n = ((autoTried.get(id) || {}).n || 0) + 1;
            if (n >= AUTO_TRIES) {
              autoTried.delete(id);
              await want(id, false);
              V.toast(`Your page "${cut(V.noteTitle(row), 40)}" couldn't be read just now. Tap Read this page in the note to try again.`,
                { ms: 8000, action: 'Open', onAction: () => V.notes.open(id) });
            } else autoTried.set(id, { n, next: Date.now() + AUTO_WAIT * 2 ** (n - 1) });
          } else if (!(error && error.kind === 'offline')) await want(id, false);
          break;
        }
      }
    } finally {
      readingLater = false;
    }
  }

  const needsReading = (row) => !!(row && row.extra && row.extra.capture && row.extra.capture.read === false);

  /* The pages of a note to read: those still waiting here (gone up or not), else its photos and PDFs marked as pages
     (in order). */
  async function pagesOf(id) {
    const here = ((await V.db.meta(filesKey(id))) || []).filter((f) => f.page);
    if (here.length) return here.sort((a, b) => a.page - b.page).map((f) => ({ blob: f.blob, type: f.type, name: f.name }));
    const row = (V.editor.openId() === id && V.editor.current()) || V.data.notes.get(id);
    const marked = ((row && row.attachments) || []).filter((a) => a.page).sort((a, b) => a.page - b.page);
    const out = [];
    for (const a of marked) {
      const blob = a.size < 6 * 1024 * 1024 ? await V.cloud.blob(a.path) : await (await fetch(await V.cloud.link(a.path))).blob();
      out.push({ blob, type: a.mime || blob.type, name: a.name });
    }
    return out;
  }

  /* "Read this page": the note's photos read and shown, to go into it with Save note. Offline: read once it's back. */
  async function readNote(id) {
    const row = V.data.notes.get(id);
    if (!row || row.deleted) return V.toast('That note isn\'t there any more.');
    if (row.locked) return V.toast('Wefty never reads a locked note\'s pictures.');
    if (ready.has(id)) return review({ noteId: id, result: ready.get(id), pages: await pagesOf(id).catch(() => []) });
    if (!navigator.onLine) {
      await want(id, true);
      return V.toast('You\'re offline: Wefty reads it by itself when you\'re back online.', { ms: 6000 });
    }
    let pages;
    try {
      pages = await pagesOf(id);
    } catch (error) {
      return V.toast('The photo couldn\'t be fetched from your cloud just now. Try again in a moment.', { kind: 'err' });
    }
    if (!pages.length) return V.toast('There\'s no page photo in this note to read.');
    review({ noteId: id, pages });
  }

  /* -- Snap a page */

  /* Takes photos (the camera on a phone, files elsewhere), then the sheet. In the tap that asked. `onSaved(note)`:
     where it was asked from wants the note (Chat puts it in the message) instead of having it opened. */
  function snap({ onSaved = null, camera } = {}) {
    if (sheetOpen) { sheetOpen.focus(); return Promise.resolve(null); }
    return pick({ camera: camera === undefined ? V.device === 'phone' && !V.desktop : camera }).then(async (files) => {
      if (!files.length) return null;
      return review({ files, onSaved });
    });
  }

  let sheetOpen = null;

  /* The sheet: the photos along the top, then reading, the note to check, or what went wrong. `files` (new photos: a
     new note), or `noteId` with its `pages` or a `result` already read (into that note). */
  function review({ files = [], pages = [], noteId = null, result = null, onSaved = null }) {
    if (sheetOpen) { sheetOpen.focus(); return null; }
    const into = noteId ? V.data.notes.get(noteId) : null;
    const state = { pages: pages.map((p) => ({ ...p, url: p.type === 'application/pdf' ? '' : URL.createObjectURL(p.blob) })),
      result, ctl: null, who: V.ai.brain(), editing: false, busy: false, closed: false };
    const body = V.h('div.cap');
    const strip = V.h('div.cap-pages', { role: 'list', 'aria-label': 'Pages' });
    const area = V.h('div.cap-area');
    const bar = V.h('div.sheet-actions.cap-bar');
    body.append(strip, area);
    const sheet = V.sheet({ title: into ? 'Read this page' : 'Snap a page', content: body, onClose: () => {
      state.closed = true;
      sheetOpen = null;
      if (state.ctl) state.ctl.abort();
      for (const p of state.pages) if (p.url) URL.revokeObjectURL(p.url);
    } });
    sheet.el.classList.add('cap-sheet');
    sheet.el.append(bar);
    const head = sheet.el.querySelector('.sheet-head h2');
    sheetOpen = { focus: () => { const b = bar.querySelector('.btn.primary') || bar.querySelector('.btn'); if (b) b.focus(); } };
    const button = (label, kind, onClick, icon) => V.button(label, { kind, icon, onClick });
    const pagesWord = () => (state.pages.length === 1 ? 'your page' : `your ${state.pages.length} pages`);

    const drawStrip = () => {
      V.clear(strip, state.pages.map((p, i) => V.h('div.cap-page', { role: 'listitem' },
        p.url ? V.h('img', { src: p.url, alt: `Page ${i + 1}` }) : V.h('span.cap-pdf', {}, V.icon('file'), V.h('span', { text: 'PDF' })),
        V.h('span.cap-page-n', { text: String(i + 1), 'aria-hidden': 'true' }),
        !into && state.pages.length > 1 && !state.busy ? V.iconButton('x', `Take out page ${i + 1}`, async () => {
          if (!(await readAgainOk())) return;
          const at = state.pages.indexOf(p);
          if (at < 0 || state.closed) return;
          if (p.url) URL.revokeObjectURL(p.url);
          state.pages.splice(at, 1);
          go();
        }, 'cap-page-out') : null)),
      !into && state.pages.length < MOST_PAGES ? V.h('button.cap-add', { type: 'button', onclick: () => addPages() },
        V.icon('camera'), V.h('span', { text: 'Add a page' })) : null);
    };

    const addPages = async (camera) => {
      const more = await pick(camera === undefined ? {} : { camera });  // (in the tap: a picker only opens for one)
      if (!more.length || state.closed || !(await readAgainOk())) return;
      await take(more);
      go();
    };
    // The pages are read again together when one is added or taken out: changes made to the note shown are asked
    // about first, never thrown away without a word (and a paid read isn't made by a slip).
    let edited = () => false;  // (set by drawPreview while its boxes show)
    const readAgainOk = async () => !edited() || V.confirm('Read the pages again?',
      'Your changes to the title and words are replaced by the new reading.', { ok: 'Read again' });
    const take = async (list) => {
      for (const file of list.slice(0, MOST_PAGES - state.pages.length)) {
        try {
          const p = await prepare(file);
          state.pages.push({ ...p, url: p.type === 'application/pdf' ? '' : URL.createObjectURL(p.blob) });
        } catch (error) {
          V.toast(error.message, { kind: 'err', ms: 6000 });
        }
      }
      if (list.length > MOST_PAGES) V.toast(`${MOST_PAGES} pages at most in one go: the first ${MOST_PAGES} are here.`, { ms: 6000 });
    };

    const drawReading = () => {
      head.textContent = into ? 'Read this page' : 'Snap a page';
      V.clear(area, V.h('div.aic-state.cap-state', { role: 'status' }, V.h('div.spinner.big'),
        V.h('h3', { text: state.pages.length === 1 ? 'Reading your page…' : `Reading ${state.pages.length} pages…` }),
        V.h('p', { text: `${nameOf(state.who)} is turning ${pagesWord()} into a note. This takes a few seconds.` })));
      V.clear(bar, button('Cancel', '', () => sheet.close()));
    };

    /* `setUp` ('gemini' or 'claude'): the photo kept first, then the AI's setup (never a photo lost to it). */
    const keepForLater = async (setUp = '') => {
      if (state.busy) return;
      state.busy = true;
      try {
        if (into) {
          await want(into.id, true);
          sheet.close();
          V.toast('Wefty reads it by itself when it can.', { ms: 5000 });
          return;
        }
        const note = await saveNew({ title: `Page photo, ${new Date().toLocaleDateString([], { day: 'numeric', month: 'short' })}`,
          body: '', folderId: picked(), read: false });
        if (!navigator.onLine) await want(note.id, true);
        sheet.close();
        if (setUp) {
          if (onSaved) onSaved(note);
          V.toast(`Your photo is kept in ${folderName(note.folder_id)}. Once ${nameOf(setUp)} is set up, tap Read this page in the note.`,
            { ms: 8000, action: 'Open', onAction: () => V.notes.open(note.id) });
          V.ai.setUp(setUp);
          return;
        }
        V.toast(navigator.onLine ? `Kept in ${folderName(note.folder_id)}. Tap Read this page in the note when you're ready.`
          : `Kept in ${folderName(note.folder_id)}. Wefty reads it by itself when you're back online.`, { ms: 7000 });
        if (onSaved) onSaved(note); else V.notes.open(note.id);
      } catch (error) {
        state.busy = false;
        V.problem(error);
      }
    };

    const drawProblem = (t) => {
      head.textContent = into ? 'Read this page' : 'Snap a page';
      V.clear(area, V.h('div.aic-state.cap-state.cap-problem', { role: 'alert' },
        V.h('span.aic-problem-icon', {}, V.icon(t.offline ? 'cloud' : 'alert')), V.h('h3', { text: t.title }),
        V.h('p', { text: t.words })));
      const close = button(into ? 'Close' : 'Cancel', '', () => sheet.close());
      const later = button(into ? 'Read it later' : t.offline ? 'Keep the photo' : 'Keep the photo for later', '', () => keepForLater());
      // (a new photo is kept first: the setup takes a minute in another tab, and the photo mustn't be lost to it)
      const setUp = (what) => (into ? () => { sheet.close(); V.ai.setUp(what); } : () => keepForLater(what));
      const fix = t.setUp ? button('Set up Gemini', 'primary', setUp('gemini'))
        : t.settings ? button('Open Settings', 'primary', setUp(state.who === 'claude' ? 'claude' : 'gemini'))
          : t.again ? button('Try again', 'primary', () => go(), 'restore') : null;
      if (t.offline) {
        later.classList.add('primary');
        V.clear(bar, close, later);
      } else if (fix) {
        V.clear(bar, into ? close : later, fix);
      } else if (into) {
        close.classList.add('primary');
        V.clear(bar, close);
      } else {
        later.classList.add('primary');
        V.clear(bar, close, later);
      }
    };

    const drawNothing = () => {
      head.textContent = 'No words found';
      V.clear(area, V.h('div.aic-state.cap-state', { role: 'status' }, V.mark(40), V.h('h3', { text: 'No words found' }),
        V.h('p', { text: `${nameOf(state.who)} couldn't find anything to read. Try again closer, flat and with more light.` })));
      V.clear(bar, into ? button('Close', 'primary', () => sheet.close())
        : [button('Keep the photo', '', () => keepForLater()), button('Take it again', 'primary', async () => {
          const again = await pick();
          if (!again.length || state.closed) return;
          for (const p of state.pages) if (p.url) URL.revokeObjectURL(p.url);
          state.pages = [];
          await take(again);
          go();
        }, 'camera')]);
    };

    let titleBox = null;
    let wordsBox = null;
    let where = null;
    let cardsTick = null;
    const picked = () => (where ? where.querySelector('select').value : lastFolder());
    const drawPreview = () => {
      const got = state.result;
      const asRead = { title: got.title || '', body: got.body };  // (what the AI gave: anything else is the person's)
      head.textContent = into ? 'Your page, read' : 'Your note';
      titleBox = V.h('input.field.cap-title', { type: 'text', value: got.title || '', placeholder: 'Title', 'aria-label': 'Title',
        maxlength: String(TITLE_MOST) });
      const shown = V.h('div.cap-preview', { tabindex: '0', 'aria-label': 'The note\'s words' }, V.format.render(got.body).el);
      wordsBox = V.h('textarea.field.cap-words', { rows: 8, value: got.body, 'aria-label': 'The note\'s words', hidden: true });
      const edit = V.h('button.link-btn.cap-edit', { type: 'button', text: 'Change the words', onclick: () => {
        state.editing = !state.editing;
        if (!state.editing) { got.body = wordsBox.value; V.clear(shown, V.format.render(got.body).el); }
        shown.hidden = state.editing;
        wordsBox.hidden = !state.editing;
        edit.textContent = state.editing ? 'Done changing' : 'Change the words';
        if (state.editing) wordsBox.focus();
      } });
      where = into ? null : folderChoice(lastFolder());
      cardsTick = V.h('input.covers-tick.cap-cards-tick', { type: 'checkbox', checked: stored(CARDS_KEY) === 'on' });
      const unclear = got.unclear ? V.h('p.hint.cap-unclear', {}, V.icon('alert'),
        V.h('span', { text: `${got.unclear === 1 ? 'One bit was' : `${got.unclear} bits were`} hard to read: ${got.unclear === 1 ? 'it\'s' : 'they\'re'} marked [?]. Check against the photo.` })) : null;
      V.clear(area, V.h('div.cap-check', {},
        V.h('label.label', { text: 'Title' }), titleBox,
        V.h('div.cap-words-head', {}, V.h('span.label', { text: 'Words' }), edit),
        shown, wordsBox, unclear,
        V.h('div.cap-options', {}, where,
          V.h('label.cap-cards', {}, cardsTick, V.h('span', { text: 'Also make flash cards' })))));
      V.clear(bar, button('Cancel', '', () => sheet.close()),
        button('Save note', 'primary', () => saveIt(), 'check'));
      const box = titleBox;
      const words = wordsBox;
      edited = () => box.value !== asRead.title || words.value !== asRead.body;
    };

    const saveIt = async () => {
      if (state.busy) return;
      state.busy = true;
      const got = state.result;
      const words = state.editing ? wordsBox.value : got.body;
      const title = cut(titleBox.value, TITLE_MOST) || got.title || 'Page photo';
      const cards = cardsTick.checked;
      store(CARDS_KEY, cards ? 'on' : null);
      try {
        let note;
        if (into) {
          note = await intoNote(into.id, title, words);
          ready.delete(into.id);
        } else {
          note = await saveNew({ title, body: words, folderId: picked(), read: true, brain: got.who });
        }
        sheet.close();
        V.emit('study-loop', 'snap');  // (a page read into a note: the study loop done once, js/starthere.js)
        if (onSaved) {
          onSaved(note);
          V.toast(`Saved in ${folderName(note.folder_id)}.`);
        } else {
          if (V.editor.openId() !== note.id) V.notes.open(note.id);
          V.toast(into ? 'The page\'s words are in the note.' : `Saved in ${folderName(note.folder_id)}.`);
        }
        if (cards && V.aiCards) setTimeout(() => V.aiCards.forNote(note.id), 250);  // (after the note opens)
      } catch (error) {
        state.busy = false;
        V.problem(error);
      }
    };

    /* A new note with the photos (they go up now, or when this device is next online). */
    const saveNew = async ({ title, body: words, folderId, read: done, brain }) => {
      const at = new Date().toISOString();
      const note = await V.cloud.save('notes', V.notes.blankNote({ folder_id: folderId || null, title, body: words,
        extra: { capture: { from: 'snap', pages: state.pages.length, read: done, at, ...(brain ? { by: brain } : {}) } } }));
      if (folderId) store(FOLDER_KEY, folderId);
      await keep(note.id, state.pages.map((p, i) => ({ blob: p.blob, type: p.type, name: p.name, w: p.w || 0, h: p.h || 0, page: i + 1 })));
      return note;
    };

    const go = async () => {
      if (state.closed) return;
      if (state.ctl) state.ctl.abort();
      if (!state.pages.length) { sheet.close(); return; }
      state.busy = false;
      state.editing = false;
      edited = () => false;
      drawStrip();
      if (!navigator.onLine) { drawProblem(trouble(new V.ai.AiError('offline', ''), state.who)); return; }
      drawReading();
      const ctl = new AbortController();
      state.ctl = ctl;
      try {
        const got = await read(state.pages, { signal: ctl.signal, onBrain: (who) => { state.who = who; if (!state.closed && state.ctl === ctl) drawReading(); } });
        if (state.closed || state.ctl !== ctl) return;
        if (!got) { drawNothing(); return; }
        state.result = got;
        drawPreview();
      } catch (error) {
        if (state.closed || state.ctl !== ctl || (error && error.kind === 'stopped')) return;
        if (!(error instanceof V.ai.AiError)) console.warn('Wefty: reading a page', error);
        drawProblem(trouble(error, (error && error.brain) || state.who));
      }
    };

    (async () => {
      if (files.length) {
        V.clear(area, V.h('div.aic-state.cap-state', { role: 'status' }, V.h('div.spinner.big'),
          V.h('h3', { text: files.length === 1 ? 'Getting your photo ready…' : 'Getting your photos ready…' })));
        V.clear(bar, button('Cancel', '', () => sheet.close()));
        await take(files);
      }
      if (state.closed) return;
      if (state.result) { drawStrip(); drawPreview(); return; }
      go();
    })();
    return sheet;
  }

  /* The words read from a note's photos put into it: under what's there (a share's link or words), and its title
     when it only had the one it was given ("Page photo, ..."). Through the editor when it's the open note. */
  async function intoNote(id, title, words) {
    const row = V.data.notes.get(id);
    if (!row || row.deleted) throw new Error('That note isn\'t there any more.');
    if (row.locked) throw new Error('That note is locked now.');
    const open = V.editor.openId() === id && V.editor.current();
    const had = open ? (V.editor.words() || '') : String(row.body || '');
    const text = had.trim() ? `${had.replace(/\s+$/, '')}\n\n${words}` : words;
    const kept = (open || row).title;
    const capture = (row.extra && row.extra.capture) || {};
    const newTitle = !kept || capture.named === false || /^Page photo, /.test(kept) ? title : kept;
    const extra = { ...(row.extra || {}), capture: { ...capture, read: true, readAt: new Date().toISOString() } };
    await want(id, false);
    if (open && V.editor.restore(id, newTitle, text)) {
      await V.editor.update((note) => { note.extra = { ...(note.extra || {}), capture: extra.capture }; });
      await V.editor.settled();
      return V.editor.current();
    }
    return V.cloud.save('notes', { ...row, title: newTitle, body: text, extra });
  }

  /* -- Share to Wefty */

  /* What was shared, tidied: { title, body, url, text, pictures, pdfs, others, named }. A link: its page's title (or
     its site) and the link on its own line; words: their first line as the title when nothing else names them. */
  function tidy(list) {
    const files = list.flatMap((s) => s.files || []).filter(Boolean);
    let url = String(list.map((s) => s.url).find(Boolean) || '').trim();
    let text = list.map((s) => String(s.text || '').trim()).filter(Boolean).join('\n\n');
    if (!url) {
      const found = LINK.exec(text);
      if (found) url = found[0].replace(/[.,;:!?)\]]+$/, '');
    }
    if (url) text = text.split(url).join('').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let title = cut(String((list[0] || {}).title || ''), TITLE_MOST);
    if (title && (title === url || LINK.test(title))) title = '';
    if (title && text === title) text = '';
    const pictures = files.filter(isPicture);
    const pdfs = files.filter((f) => !isPicture(f) && isPdf(f));
    const others = files.filter((f) => !isPicture(f) && !isPdf(f));
    const named = !!title;
    if (!title) {
      const first = text.split('\n')[0].trim();
      if (first) {
        title = cut(first.replace(/^#+\s*/, ''), 80);
        if (text === first && first.length <= 80) text = '';
      } else if (url) title = V.format.site(url).name || 'Link';
      else if (pictures.length) title = pictures.length === 1 ? 'Shared picture' : `${pictures.length} shared pictures`;
      else if (pdfs.length) title = stem(pdfs[0].name) || 'Shared PDF';
      else if (others.length) title = stem(others[0].name) || 'Shared file';
      else title = 'Shared note';
    }
    return { title, body: [text, url].filter(Boolean).join('\n\n'), url, text, pictures, pdfs, others, files, named };
  }

  /* The share sheet: what came, tidied, where it goes, and Save to Wefty. `copied` ('sent', 'later' or ''): words
     shared alone were copied on every device already (js/send.js), `where` says where to paste them. */
  function share(list, { copied = '', where = '' } = {}) {
    const t = tidy(list);
    const words = list.map((s) => [s.title, s.text, s.url].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
    const choice = folderChoice(lastFolder());
    const site = t.url ? V.format.site(t.url) : null;
    const content = V.h('div.cap-share', {},
      copied === 'sent' ? V.h('p.hint', { text: where }) : null,
      copied === 'later' ? V.h('p.hint', { text: 'Couldn\'t copy it right now: it goes when you\'re back online.' }) : null,
      V.h('div.cap-card', {},
        V.h('strong.cap-card-title', { text: t.title }),
        site ? V.h('span.cap-link', {}, V.icon('link'), V.h('span', { text: `${site.name}${site.tail ? ' · ' + site.tail : ''}` })) : null,
        t.text ? V.h('p.shared-text', { text: t.text.slice(0, 500) + (t.text.length > 500 ? '…' : '') }) : null,
        t.files.length ? V.h('ul.shared-list', {}, t.files.map((f) => V.h('li', {}, V.icon(isPicture(f) ? 'image' : 'file'),
          V.h('span', { text: f.name }), V.h('span.muted', { text: V.size(f.size) })))) : null),
      choice);
    const select = choice.querySelector('select');
    V.sheet({
      title: copied === 'sent' ? 'Copied on all your devices' : 'Shared with Wefty', content,
      actions: [
        ...(words && !t.files.length && copied !== 'sent' && V.clips
          ? [{ label: 'Copy on all my devices', icon: 'copy', onClick: () => V.clips.share(words) }] : []),
        V.send && V.send.stage && !V.desktop ? { label: 'Send to PC', icon: 'send', onClick: () => V.send.stage(words, t.files) } : null,
        { label: 'Save to Wefty', kind: 'primary', icon: 'check', onClick: () => { saveShared(t, select.value).catch(V.problem); } },
      ].filter(Boolean),
    });
  }

  /* The shared things as a note now (its files go up now or when online), then what's next. */
  async function saveShared(t, folderId) {
    const at = new Date().toISOString();
    const big = t.files.filter((f) => f.size > FILE_MOST);
    if (big.length) V.toast(`${big[0].name} is over 50 MB, the most the free cloud takes, so it's left out.`, { kind: 'err', ms: 7000 });
    // A picture as a page photo (a screenshot can be read), a PDF as it is (read too, up to PDF_MOST), others as they are.
    const files = [];
    let page = 0;
    for (const f of t.files) {
      if (f.size > FILE_MOST) continue;
      let made = null;
      if (isPicture(f)) made = await prepare(f).catch(() => null);
      if (!made) made = { blob: f, type: f.type || V.format.typeOf(f.name) || 'application/octet-stream', name: f.name || 'file' };
      const reads = isPicture(f) || (isPdf(f) && f.size <= PDF_MOST);
      files.push({ ...made, w: made.w || 0, h: made.h || 0, ...(reads ? { page: ++page } : {}) });
    }
    const note = await V.cloud.save('notes', V.notes.blankNote({ folder_id: folderId || (V.notes.inbox() || {}).id || null,
      title: t.title, body: t.body, extra: { capture: { from: 'share', at, ...(page ? { pages: page, read: false, named: t.named } : {}) } } }));
    if (folderId) store(FOLDER_KEY, folderId);
    await keep(note.id, files);
    next(note, t, page);
    return note;
  }

  /* After Save to Wefty: Open, Read it (a picture or a PDF), Remind me, Make flash cards (words enough for some). */
  function next(note, t, readable) {
    const id = note.id;
    let after = null;
    const row = (key, icon, label, hint, run) => V.h('button.cap-next', { type: 'button', dataset: { next: key },
      onclick: () => { after = run; sheet.close(); } }, V.h('span.cap-next-ic', {}, V.icon(icon)),
    V.h('span.cap-next-text', {}, V.h('strong', { text: label }), V.h('small', { text: hint })));
    const enough = (String(t.text || '').match(/\S+/g) || []).length >= 12;
    const sheet = V.sheet({
      title: `Saved in ${folderName(note.folder_id)}`,
      content: V.h('div.cap-nexts', {},
        V.h('p.cap-saved', {}, V.icon('check'), V.h('span', { text: t.title })),
        readable ? row('read', 'spark', 'Read it', readable === 1 && t.pictures.length ? 'Turn the picture\'s words into the note'
          : 'Turn its words into the note', () => readNote(id)) : null,
        row('remind', 'clock', 'Remind me', 'Pick a day and a time', () => V.reminders && V.reminders.edit(id, { remind: true })),
        enough && V.aiCards ? row('cards', 'cards', 'Make flash cards', 'From its words', () => V.aiCards.forNote(id)) : null,
        row('open', 'notes', 'Open the note', 'See it, or add to it', () => V.notes.open(id))),
      actions: [{ label: 'Done', kind: 'primary' }],
      onClose: () => { if (after) setTimeout(() => after(), 200); },
    });
  }

  /* -- paste: the iPhone's way in (Safari gives web apps no place in the Share menu): copy it in the other app, then
     open Wefty and tap Paste. In the tap, so the browser lets Wefty read the clipboard (an iPhone shows its Paste). */
  async function paste() {
    let text = '';
    const files = [];
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          const pic = item.types.find((type) => /^image\//.test(type));
          if (pic) {
            const blob = await item.getType(pic);
            const ending = pic.split('/')[1] === 'jpeg' ? 'jpg' : pic.split('/')[1];
            files.push(new File([blob], `Pasted picture.${ending}`, { type: pic }));
          } else if (item.types.includes('text/plain')) {
            text += (text ? '\n' : '') + await (await item.getType('text/plain')).text();
          }
        }
      } else {
        text = await navigator.clipboard.readText();
      }
    } catch (error) {
      try {
        text = await navigator.clipboard.readText();
      } catch (again) {
        V.toast('Wefty couldn\'t read the clipboard. Tap Paste again, and allow it if your phone asks.', { ms: 7000 });
        return;
      }
    }
    if (!String(text || '').trim() && !files.length) {
      V.toast('Nothing to paste yet: copy a link, words or a picture in another app first.', { ms: 6000 });
      return;
    }
    share([{ title: '', text: String(text || ''), url: '', files }]);
  }

  const IPHONE_WAY = 'On an iPhone, Wefty can\'t be in the Share menu. Copy it in the other app, then come back and tap Paste into Wefty.';

  /* The new-note sheet's ways in: Snap a page, and Paste from another app (an iPhone, a Chromebook or a browser). */
  function sheetEntries(close) {
    const snapEntry = V.h('button.template.cap-entry', { type: 'button', dataset: { capture: 'snap' },
      onclick: () => { close(); snap(); } },
    V.icon('camera'), V.h('span.t-name', { text: 'Snap a page' }),
    V.h('span.t-hint', { text: 'A photo of a handout, a whiteboard or your notebook, made into a note' }));
    const pasting = !V.desktop && (V.deviceKind.ios || V.device === 'web');
    const pasteEntry = pasting ? V.h('button.template.cap-entry', { type: 'button', dataset: { capture: 'paste' },
      onclick: () => { close(); paste(); } },
    V.icon('copy'), V.h('span.t-name', { text: 'Paste into Wefty' }),
    V.h('span.t-hint', { text: V.deviceKind.ios ? 'A link, words or a picture you copied in another app (iPhone has no Share to Wefty)'
      : 'A link, words or a picture you copied, as a tidy note' })) : null;
    return [snapEntry, pasteEntry];
  }

  /* Share > Clipboard on an iPhone: the plain words, and the button. */
  function pasteRow() {
    if (V.desktop || !V.deviceKind.ios) return null;
    return V.h('div.cap-paste-row', {}, V.h('p.hint', { text: IPHONE_WAY }),
      V.button('Paste into Wefty', { icon: 'copy', onClick: () => paste() }));
  }

  /* -- in an open note: "Read this page" while its photos haven't been read */

  V.editor.addMeta((note) => {
    if (!note || note.locked || !needsReading(note)) return null;
    const n = note.extra.capture.pages || 1;
    const waiting = waitingHere.has(note.id);
    return V.h('span.cap-meta', {},
      V.h('button.chip.cap-chip', { type: 'button', title: 'Turn the photo\'s words into this note', onclick: () => readNote(note.id) },
        V.icon('spark'), V.h('span', { text: n === 1 ? 'Read this page' : `Read these ${n} pages` })),
      waiting ? V.h('span.cap-waiting', { text: navigator.onLine ? 'Photos going up…' : 'Photos go up when you\'re online' }) : null);
  });

  // Back online, back in sight, or the first sync: what waits here goes up, and what was wanted is read.
  window.addEventListener('online', () => flush());
  V.on('back', () => { if (waitingHere.size) flush(); else readWanted(); });
  V.on('status', (status) => { if (status === 'synced' || status === 'held') flush(); });
  V.on('signed-out', () => { waitingHere.clear(); ready.clear(); loaded = null; });

  return { snap, share, paste, read, parse, tidy, sheetEntries, pasteRow, readNote, flush, prepare, waitingFiles,
    IPHONE_WAY, SYSTEM, waits: { EDGE, MOST_PAGES }, showing: () => !!sheetOpen };
})();
