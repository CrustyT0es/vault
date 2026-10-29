/* Vault: what's sent to this Chromebook, or to any other browser that isn't the phone (util.js's 'web'). js/send.js's
   arrived() hands over what comes; here it's shown on a small card (util.js's V.notice: the picture, who sent it, what
   Vault did with it), the newest is put on the clipboard ready to paste (a picture as PNG, the only kind Chrome
   copies; a link or words as words; other files aren't copied, the card says where they are), and files can be saved
   by themselves into a folder of Files picked once in Settings. The phone has none of this (it keeps its toast).

   Chrome lets a page use the clipboard only while it's in front and has the focus (not the address bar, another
   window or a dialog), so what comes meanwhile waits, and is copied the moment Vault has it again: it gets the focus,
   or is clicked or typed in ("Click in Vault to copy it" on the card meanwhile). Only by itself while it's new: what
   waited more than a couple of minutes (or came a while before Vault opened) could go over something copied since,
   so the card offers Copy instead (the card that said "Click" changes to that then); as it does when Chrome still
   says no after a second try (a tap always may).
   Nothing goes over something newer already on the clipboard, and what Vault copied isn't sent back up as a clip
   (js/clips.js's put: the cloud's time on each). Only what came in the last half hour is shown; older things wait in
   Send as before. This device keeps what it has shown and copied in localStorage 'vault-arrive' ({ who, since, told,
   copied }, the newest 300 of each), so a reload or a second Vault tab never does it again, and `since` (its first
   look, signed in) keeps what was sent before from counting as new.

   Saving into Files: the folder picked in Settings (showDirectoryPicker, read and write), its handle kept in V.db meta
   'arrive-folder' with the time saving was switched on: only files sent after that are saved. Each is fetched from its
   signed link and written under a name of its own ("Beach (2).jpg" when there's a Beach.jpg already), one tab at a
   time (navigator.locks; what was saved is kept in V.db meta 'arrive-saved', which every tab sees at once), then marked
   received with extra.saved = "<folder>/<name>", so the sender sees "Saved on your Chromebook". When Chrome wants the
   OK again (after a restart, unless "Allow on every visit" was picked), the card's "Keep saving to <folder>" gives it:
   a tap is what Chrome needs. Programs and scripts (util.js's V.risky, by the name it's saved under) are never saved
   by themselves (Save in Send still can). Where Chrome has no folder picker, or a school's settings block it,
   nothing new is offered: Save in Send stays. */
'use strict';

V.arrive = (() => {
  const KEY = 'vault-arrive';
  const COPY = 'vault-arrive-copy';      // 'off' when copying is switched off on this device (it's on by default)
  const FOLDER = 'arrive-folder';        // V.db meta: { handle, name, since }
  const SAVED = 'arrive-saved';          // V.db meta: ids of files saved into it (the newest KEEP)
  const KEEP = 300;                      // ids remembered in each list (the newest)
  const FRESH = 30 * 60000;              // shown (and copied, if it's new enough): what came in the last half hour
  const SOON = 2 * 60000;                // copied by itself only this soon after it came (else Copy on the card)
  const SKEW = 2 * 60000;                // this device's clock and the cloud's may be a little apart
  const MOST_PICTURE = 25 * 1024 * 1024; // bigger pictures aren't copied (a Chromebook's memory)
  const MOST_SIDE = 4096;                // a copied picture's longest side, in pixels

  const here = () => V.device === 'web' && !V.desktop;
  const time = (t) => Date.parse((t && t.created_at) || '') || 0;
  const nth = (t) => Number(t.extra && t.extra.n) || 0;
  const newestFirst = (a, b) => time(b) - time(a) || nth(b) - nth(a);
  const fresh = (t) => Date.now() - time(t) < FRESH;  // (a time a little in the future counts too)
  const isPicture = (t) => t.kind === 'file' && /^image\//i.test(t.mime || '') && !/svg/i.test(t.mime || '');
  const isMedia = (t) => t.kind === 'file' && /^(?:image|video)\//i.test(t.mime || '');
  const risky = (t) => V.risky(safeName(t.name));  // (the name it's saved under: "run.bat." is a .bat)
  const named = (device) => (V.DEVICES.includes(device) ? V.deviceName(device) : 'another device');
  const yours = () => (V.deviceKind.chromebook ? 'Your Chromebook' : 'Your browser');
  const inFront = () => !V.away() && document.hasFocus();
  const incoming = () => [...V.data.transfers.values()].filter((t) => t.to_device === V.device
    && t.from_device !== V.device && !t.deleted);

  /* -- what this device has done already (localStorage, shared by its Vault tabs) */

  let memory = null;  // where localStorage can't be used: this page only
  function read() {
    let state = memory;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && typeof saved === 'object') state = saved;
    } catch (error) { /* blocked: what this page knows */ }
    if (!state || typeof state.since !== 'string' || !V.data.user || state.who !== V.data.user.id) return null;
    for (const list of ['told', 'copied']) if (!Array.isArray(state[list])) state[list] = [];
    return state;
  }

  function write(state) {
    memory = state;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { /* this page only */ }
  }

  /* This device's first look (or someone else signed in): what's here already isn't new. */
  function begin() {
    const known = read();
    if (known) return known;
    const ids = incoming().map((t) => t.id).slice(-KEEP);
    const state = { who: V.data.user.id, since: new Date().toISOString(), told: ids, copied: ids };
    write(state);
    return state;
  }

  function remember(list, ids) {
    const state = read();
    if (!state) return;
    const add = ids.filter((id) => !state[list].includes(id));
    if (!add.length) return;
    state[list] = [...state[list], ...add].slice(-KEEP);
    write(state);
  }

  function mark(key, value) {
    if (!V.data.user) return;
    const state = begin();
    state[key] = value;
    write(state);
  }

  /* -- copying: the newest that came, while Vault is in front */

  const canWords = () => !!(navigator.clipboard && navigator.clipboard.writeText);
  const canPictures = () => !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
  let copyChoice = null;  // where localStorage can't be used
  function copyOn() {
    try { return localStorage.getItem(COPY) !== 'off'; } catch (error) { return copyChoice !== false; }
  }
  function setCopy(on) {
    copyChoice = !!on;
    try { localStorage.setItem(COPY, on ? 'on' : 'off'); } catch (error) { /* until Vault closes */ }
  }
  const copyable = (t) => (t.kind === 'file' ? isPicture(t) && (Number(t.size) || 0) <= MOST_PICTURE && canPictures()
    : !!String(t.text || '').trim() && canWords());

  // The one being copied: { t, state: 'waiting' (for Vault to be in front) | 'copying' | 'copied' | 'older' (something
  // newer is on the clipboard) | 'tap' (Copy on the card: it waited too long, or Chrome said no twice) | 'refused' (the
  // browser wouldn't, even with a tap) | 'failed' (not a picture it can read), png, waited (it couldn't be copied at
  // once), refused (Chrome said no once, in front), since (when it came, by this device's clock where it could see) }
  let target = null;
  const settled = (entry) => ['copied', 'older', 'tap', 'refused', 'failed'].includes(entry.state);
  let looked = false;  // this page has looked once: what comes after that came while it was open

  /* Of what hasn't been copied (or passed over) here: the newest that can be, if it came in the last half hour. Every
     other one is done with (older than it, or nothing to copy). */
  function pickCopy(all) {
    const state = read();
    if (!state) return;
    if (target && !settled(target) && !all.some((t) => t.id === target.t.id)) target = null;  // deleted meanwhile
    const left = all.filter((t) => !state.copied.includes(t.id));
    if (!left.length) return;
    const pick = copyOn() ? left.find((t) => fresh(t) && copyable(t)) : null;
    const done = left.filter((t) => t !== pick).map((t) => t.id);
    if (target && !settled(target) && (!pick || target.t.id !== pick.id)) {  // a newer one came (or copying was switched off)
      done.push(target.t.id);
      target = null;
    }
    if (done.length) remember('copied', done);
    if (pick && (!target || target.t.id !== pick.id)) {
      // (What was here before this page first looked came while Vault was closed: by the cloud's time on it.)
      target = { t: pick, state: 'waiting', png: null, waited: false, refused: false,
        since: looked ? Date.now() : time(pick) };
    }
  }

  /* `chance`: Vault just got the focus, or was clicked or typed in (once Chrome has said no, only that tries again). */
  function copyNow(chance = false) {
    const entry = target;
    if (!entry || settled(entry) || entry.state === 'copying' || !V.clips || !V.clips.put) return;
    if (entry.refused && !chance) return;
    const late = Date.now() - entry.since > SOON;
    if (!inFront()) {  // (Chrome wouldn't, and nothing is tried): the moment Vault is in front
      entry.waited = true;
      if (late && shows(entry)) offerCopy(entry);  // (its card no longer says a click copies it)
      else {
        draw();
        tooLate(entry);
      }
      return;
    }
    if (late) {  // something may have been copied since: not over it, Copy on the card
      offerCopy(entry);
      return;
    }
    const t = entry.t;
    entry.state = 'copying';
    draw();
    let job;
    const at = V.sentAt(t);
    if (t.kind === 'file') {
      if (!entry.png) {
        entry.png = pictureOf(t);
        entry.png.catch(() => {});  // (put() says 'failed' for it)
      }
      job = V.clips.put({ png: entry.png, at });
    } else job = V.clips.put({ text: t.text, at });
    Promise.resolve(job).catch(() => 'failed').then((result) => {
      if (target !== entry) return;  // a newer one took its place meanwhile
      if (result === 'away' || (result === 'refused' && !entry.waited)) {
        // Tried again the next time Vault gets the focus, or is clicked or typed in.
        entry.state = 'waiting';
        entry.refused = entry.refused || result === 'refused';
        entry.waited = true;
        draw();
        return;
      }
      if (result === 'refused') {  // tried again, and still no: one tap does it
        entry.refused = true;
        offerCopy(entry);
        return;
      }
      entry.state = ['copied', 'older'].includes(result) ? result : 'failed';
      entry.png = null;  // (its memory)
      remember('copied', [t.id]);
      if (result === 'copied' && t.kind !== 'file') V.send.received(t).catch(() => {});  // words: seen
      // Copied once Vault came back to the front: said again, if the card that came with it has gone.
      if (result === 'copied' && entry.waited && !(card && card.ids.includes(t.id) && cardOpen())) show([t.id]);
      else draw();
    });
  }

  /* Not copied by itself (it waited a while, or Chrome said no twice): the card offers Copy, which a tap may (shown
     again if the one that came with it has gone). Never by itself after that, a reload included. */
  function offerCopy(entry) {
    entry.state = 'tap';
    entry.png = null;  // (its memory: Copy makes it again)
    remember('copied', [entry.t.id]);
    if (shows(entry)) draw();
    else show([entry.t.id]);
  }

  // Its card is up, where it can be seen.
  const shows = (entry) => !V.away() && !!card && card.ids.includes(entry.t.id) && cardOpen();

  /* Waiting for Vault to be in front, its card saying "Click in Vault to copy it": once it's too late to be copied by
     itself, the card (while it's up) offers Copy instead. If it isn't up, Vault coming to the front does that. */
  let lateTimer = null;
  function tooLate(entry) {
    clearTimeout(lateTimer);
    lateTimer = setTimeout(() => {
      if (target === entry && entry.state === 'waiting' && Date.now() - entry.since > SOON && shows(entry)) offerCopy(entry);
    }, Math.max(0, entry.since + SOON - Date.now()) + 250);
  }

  /* Copy, pressed on the card: the write starts inside the tap (a picture's PNG is made meanwhile). */
  async function tapCopy() {
    const entry = target;
    if (!entry || !['tap', 'older'].includes(entry.state)) return true;
    const t = entry.t;
    entry.state = 'copying';
    const job = t.kind === 'file' ? V.clips.tap({ png: pictureOf(t) }) : V.clips.tap({ text: t.text });
    draw();
    const result = await job.catch(() => 'failed');
    if (target !== entry) return true;
    entry.state = ['copied', 'refused'].includes(result) ? result : 'failed';
    if (result === 'copied' && t.kind !== 'file') V.send.received(t).catch(() => {});  // words: seen
    draw();
    return true;  // (the card stays, to say so)
  }

  /* A picture as PNG for the clipboard (Chrome copies no other kind), no bigger than MOST_SIDE on its long side. */
  async function pictureOf(t) {
    const response = await fetch(await V.cloud.link(t.path));
    if (!response.ok) throw new Error('Couldn\'t get the picture.');
    const blob = await response.blob();
    if (blob.size > MOST_PICTURE) throw new Error('Too big to copy.');
    const { width, height } = await sizeOf(blob);
    const scale = Math.min(1, MOST_SIDE / Math.max(width, height, 1));
    if (scale === 1 && blob.type === 'image/png') return blob;
    // Decoded at the size it's copied at (a 50-megapixel photo decoded whole would fill the memory).
    const bitmap = scale < 1
      ? await createImageBitmap(blob, width >= height
        ? { resizeWidth: Math.max(1, Math.round(width * scale)), resizeQuality: 'high' }
        : { resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: 'high' })
      : await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('No picture');
      return png;
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  /* A picture's size without decoding it all (the browser reads its header). */
  function sizeOf(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a picture this browser can show.')); };
      img.src = url;
    });
  }

  /* -- saving into a folder of Files */

  let folder = null;           // { handle, name, since }: where files are saved (null: not switched on)
  let allowed = 'unknown';     // that folder's permission: 'granted', 'prompt' or 'denied' (Chrome's words)
  let trouble = '';            // what went wrong with the folder itself ('gone': moved or deleted)
  let loaded = null;           // the folder read from V.db, once
  let saveRun = null;          // the saving going on now (one run at a time)
  let saveAgain = false;
  const saving = new Set();    // ids being written now
  const outcome = new Map();   // id -> { state: 'saved' | 'risky' | 'failed', name, why }

  const canPick = () => typeof window.showDirectoryPicker === 'function';
  const place = () => (folder ? (V.deviceKind.chromebook ? `Files › ${folder.name}` : folder.name) : '');

  function loadFolder() {
    if (!loaded) {
      loaded = V.db.meta(FOLDER).then((kept) => {
        if (kept && kept.handle && !folder) folder = { handle: kept.handle, name: kept.name || kept.handle.name, since: kept.since };
      }).catch(() => {});
    }
    return loaded;
  }

  async function permission(handle, ask) {
    try {
      if (!handle.queryPermission) return 'granted';
      const now = await handle.queryPermission({ mode: 'readwrite' });
      if (now !== 'prompt' || !ask) return now;
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch (error) {
      return 'denied';
    }
  }

  /* Files sent here since saving was switched on, not saved (or opened) yet, nor programs; the oldest first. */
  function toSave() {
    if (!folder) return [];
    const since = (Date.parse(folder.since) || 0) - SKEW;
    return incoming().filter((t) => t.kind === 'file' && t.path && !t.received_at && !(t.extra && t.extra.saved)
      && time(t) >= since && !saving.has(t.id) && !outcome.has(t.id) && !risky(t)).sort((a, b) => newestFirst(b, a));
  }

  function saveCheck() {
    if (!here() || !folder || !V.data.user) return;
    if (saveRun) { saveAgain = true; return; }
    saveRun = (async () => {
      do {
        saveAgain = false;
        const list = toSave();
        if (!list.length) break;
        allowed = await permission(folder.handle, false);
        if (allowed !== 'granted') break;  // the card (and Settings) ask for the OK: a tap
        for (const t of list) {
          if (!folder || allowed !== 'granted') break;
          await saveOne(t);
        }
      } while (saveAgain && folder);
    })().catch((error) => console.warn('Vault: saving what arrived', error)).finally(() => {
      saveRun = null;
      draw();
      redrawSettings();
    });
  }

  async function saveOne(t) {
    const job = async () => {
      // What this device saved (IndexedDB: every tab sees the same at once, which localStorage doesn't promise).
      const done = await V.db.meta(SAVED).catch(() => null);
      if ((Array.isArray(done) && done.includes(t.id)) || !folder) {  // another Vault tab here has
        outcome.set(t.id, { state: 'saved', name: '' });
        return;
      }
      const into = folder;
      saving.add(t.id);
      draw();
      try {
        const response = await fetch(await V.cloud.link(t.path));
        if (!response.ok) throw new Error(`The cloud didn't send it (${response.status}).`);
        const blob = await response.blob();
        const name = await freeName(into.handle, safeName(t.name));
        // Never a program or script by itself: by the name it's saved under, or a program's first bytes when that
        // name has no type.
        if (V.risky(name) || (!/\.[^.\s]+$/.test(name) && await startsMZ(blob))) {
          outcome.set(t.id, { state: 'risky' });
          return;
        }
        const file = await into.handle.getFileHandle(name, { create: true });
        try {
          const out = await file.createWritable();
          await out.write(blob);
          await out.close();
        } catch (error) {
          await into.handle.removeEntry(name).catch(() => {});  // no empty file left behind
          throw error;
        }
        const known = await V.db.meta(SAVED).catch(() => null);
        await V.db.meta(SAVED, [...(Array.isArray(known) ? known : []), t.id].slice(-KEEP)).catch(() => {});
        outcome.set(t.id, { state: 'saved', name });
        trouble = '';
        await V.send.received(t, { saved: `${into.name}/${name}` });
      } catch (error) {
        if (error && error.name === 'NotAllowedError') {
          allowed = 'prompt';  // asked again with a tap; this one's tried again then
          return;
        }
        if (error && error.name === 'NotFoundError') trouble = 'gone';
        outcome.set(t.id, { state: 'failed', why: (error && error.message) || String(error) });
      } finally {
        saving.delete(t.id);
        draw();
      }
    };
    // One Vault tab at a time writes (each looks again first), so two tabs never save the same file twice.
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('vault-arrive-save', job);
    return job();
  }

  async function startsMZ(blob) {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    return head[0] === 0x4d && head[1] === 0x5a;
  }

  /* A name Files takes: no folder parts or characters it refuses, not too long, never empty. */
  function safeName(name) {
    const last = String(name || '').split(/[\\/]/).pop();
    const clean = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/, '').replace(/^[. ]+/, '');
    const dot = clean.lastIndexOf('.');
    const stem = (dot > 0 ? clean.slice(0, dot) : clean).slice(0, 120).trim();
    const ext = dot > 0 ? clean.slice(dot).slice(0, 20) : '';
    return (stem || 'file') + ext;
  }

  /* The name, or "name (2).ext", "(3)"... when the folder has one already. */
  async function freeName(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if (!(await taken(dir, candidate))) return candidate;
    }
    throw new Error('That folder has too many files with that name.');
  }

  async function taken(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (error) {
      if (error && error.name === 'NotFoundError') return false;
      if (error && error.name === 'TypeMismatchError') return true;  // a folder of that name
      throw error;
    }
  }

  /* The folder picker (a tap: Chrome needs one). `since`: save what came from then on (now, unless said). */
  async function choose({ since } = {}) {
    if (!canPick()) return false;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'vault-arrivals', mode: 'readwrite', startIn: 'downloads' });
    } catch (error) {
      if (error && error.name === 'AbortError') return false;  // closed without picking
      mark('blocked', true);
      V.toast(`${yours()} didn't let Vault use a folder. Files still wait in Send: save them from there.`, { ms: 7000 });
      redrawSettings();
      return false;
    }
    await use(handle, { since });
    return true;
  }

  /* Saving switched on into this folder (the one just picked; a test's stand-in), kept for next time. */
  async function use(handle, { since } = {}) {
    folder = { handle, name: handle.name || 'your folder', since: since || (folder && folder.since) || new Date().toISOString() };
    allowed = 'granted';  // (picked to read and write; asked again if Chrome says otherwise)
    trouble = '';
    outcome.clear();
    mark('blocked', false);
    try { await V.db.meta(FOLDER, folder); } catch (error) { /* kept until Vault closes */ }
    redrawSettings();
    draw();
    saveCheck();
  }

  async function stop() {
    folder = null;
    allowed = 'unknown';
    trouble = '';
    try { await V.db.meta(FOLDER, null); } catch (error) { /* gone when Vault closes */ }
    redrawSettings();
    draw();
  }

  /* Chrome wants the OK again to write there: a tap gives it, then what waited is saved. */
  async function allow() {
    if (!folder) return false;
    allowed = await permission(folder.handle, true);
    if (allowed === 'granted') {
      outcome.clear();
      saveCheck();
    } else V.toast(`Vault wasn't allowed to save to ${folder.name}.`, { kind: 'err' });
    draw();
    redrawSettings();
    return true;
  }

  /* -- the card */

  let card = null;  // { notice, ids (shown on it), offer (it offers to save files here), picture: { id, el } }
  const cardOpen = () => !!(card && card.notice && card.notice.open());

  /* Said once each, while Vault can be seen: what came in the last half hour (older ones wait in Send). */
  function tell(all) {
    const state = read();
    if (!state || V.away()) return;  // (when Vault is back)
    const untold = all.filter((t) => !state.told.includes(t.id));
    if (!untold.length) return;
    remember('told', untold.map((t) => t.id));
    const shown = untold.filter(fresh);
    if (shown.length) show(shown.map((t) => t.id));
  }

  /* On the card: these, with what it shows already (one card at a time: "and 2 more"). */
  function show(ids) {
    if (!cardOpen()) card = { notice: null, ids: [], offer: false, picture: null };
    card.ids = [...new Set([...ids, ...card.ids])];
    draw();
  }

  function rowsOf() {
    return card ? card.ids.map((id) => V.data.transfers.get(id)).filter((t) => t && !t.deleted).sort(newestFirst) : [];
  }

  function draw() {
    if (!card) return;
    const rows = rowsOf();
    if (!rows.length) {
      if (cardOpen()) card.notice.close();
      card = null;
      return;
    }
    const copied = target && rows.find((t) => t.id === target.t.id);
    const main = copied || rows[0];
    const froms = new Set(rows.map((t) => t.from_device));
    const options = {
      title: froms.size === 1 ? `From ${named(main.from_device)}` : 'From your devices',
      text: main.kind === 'file' ? main.name || 'A file' : String(main.text || '').trim().slice(0, 200),
      more: rows.length - 1,
      picture: pictureFor(main),
      icon: V.send.kindIcon(main),
      lines: [copyLine(main), ...saveLines(rows)],
      actions: actionsFor(main, rows),
    };
    if (cardOpen()) card.notice.update(options);
    else {
      const mine = card;
      card.notice = V.notice({ ...options, onClose: () => { if (card === mine) card = null; } });
    }
  }

  /* Its picture: the sender's small preview (kept on this device), else the picture itself; null: the kind's icon.
     The same element each time the card is drawn again (no flicker), unless it has given way to the icon. */
  function pictureFor(t) {
    if (!isMedia(t)) return null;
    const known = card.picture;
    if (known && known.id === t.id && (known.el.isConnected || !card.notice)) return known.el;
    let el = null;
    if (t.extra && typeof t.extra.thumb === 'string') el = V.send.image(t);  // (gives way to the icon by itself)
    else if (isPicture(t)) {
      el = V.h('img', { alt: '', decoding: 'async', draggable: 'false' });
      const icon = () => el.replaceWith(V.icon(V.send.kindIcon(t)));
      el.addEventListener('error', icon, { once: true });
      V.cloud.link(t.path).then((url) => { el.src = url; }, icon);
    }
    card.picture = el ? { id: t.id, el } : null;
    return el;
  }

  function copyLine(main) {
    if (!target || target.t.id !== main.id) {
      if (main.kind === 'file' && !(main.extra && main.extra.saved) && !folderWillSave(main)) return { text: 'Waiting in Send' };
      return null;
    }
    const copying = { text: main.kind === 'file' ? 'Copying the picture…' : 'Copying…' };
    if (target.state === 'copied') return { text: 'Copied — press Ctrl+V to paste', ok: true };
    if (target.state === 'copying') return copying;
    // (Chrome said no once, in front: the next click or key in Vault tries again.)
    if (target.state === 'waiting') return inFront() && !target.refused ? copying : { text: 'Click in Vault to copy it' };
    // ('older': something newer is on the clipboard, or about to be, or what's there was copied in another app meanwhile.)
    if (target.state === 'tap' || target.state === 'older') {
      return { text: target.state === 'tap' && target.refused ? 'Vault couldn\'t copy it by itself'
        : 'Not copied: you may have copied something since' };
    }
    if (target.state === 'refused') return { text: 'Couldn\'t copy it here' };
    return null;
  }

  const folderWillSave = (t) => !!folder && t.kind === 'file' && !risky(t) && time(t) >= (Date.parse(folder.since) || 0) - SKEW;

  /* What saving did with the card's files: saved, waiting for an OK, trouble; and a program left in Send. */
  function saveLines(rows) {
    if (!folder) return [];
    const files = rows.filter((t) => t.kind === 'file' && time(t) >= (Date.parse(folder.since) || 0) - SKEW);
    if (!files.length) return [];
    const state = (t) => (outcome.get(t.id) || {}).state;
    const saved = files.filter((t) => (t.extra && t.extra.saved) || state(t) === 'saved');
    const programs = files.filter((t) => risky(t) || state(t) === 'risky');
    const failed = files.filter((t) => state(t) === 'failed');
    const left = files.length - saved.length - programs.length - failed.length;
    let said = null;
    if (files.some((t) => saving.has(t.id))) said = { text: `Saving to ${place()}…` };
    else if (left > 0 && allowed === 'prompt') said = { text: `Vault needs your OK to keep saving to ${folder.name}` };
    else if (left > 0 && allowed === 'denied') said = { text: `Vault isn't allowed to save to ${folder.name}` };
    else if (failed.length) said = { text: trouble === 'gone' ? `Vault can't find ${folder.name} any more` : `Couldn't save to ${folder.name}` };
    else if (saved.length) said = { text: saved.length === 1 ? `Saved to ${place()}` : `${saved.length} saved to ${place()}`, ok: true };
    return [said, programs.length ? { text: 'Programs aren\'t saved by themselves: save it in Send if you trust it' } : null];
  }

  function actionsFor(main, rows) {
    const list = [];
    // Not copied by itself (or something newer is on the clipboard): Copy puts it there.
    if (target && target.t.id === main.id && ['tap', 'older'].includes(target.state) && copyable(main)) {
      list.push({ label: 'Copy', kind: target.state === 'tap' ? 'primary' : '', icon: 'copy', onClick: tapCopy });
    }
    const askOk = folder && allowed === 'prompt'
      && rows.some((t) => folderWillSave(t) && !t.received_at && !(t.extra && t.extra.saved));
    if (askOk) {
      list.push({ label: `Keep saving to ${folder.name}`, kind: 'primary', icon: 'folder', onClick: allow });
    } else if (offerHere(rows)) {
      list.push({ label: 'Save files here automatically', kind: 'primary', icon: 'folder', onClick: () => fromCard(rows) });
    } else if (main.kind === 'file') {
      list.push({ label: 'Open', icon: 'open', onClick: () => {
        if (isMedia(main)) V.send.viewer([main], 0); else V.send.openHere(main, 'open');
      } });
    } else if (main.kind === 'link') {
      list.push({ label: 'Open', icon: 'open', onClick: () => V.send.openLink(String(main.text || '').trim(), main) });
    }
    list.push({ label: 'Show in Send', onClick: () => { if (V.go) V.go('send'); } });
    return list;
  }

  /* The first file that comes with saving not set up offers it, once (where Chrome has the folder picker). */
  function offerHere(rows) {
    if (!card) return false;
    if (card.offer) return !folder;
    const state = read();
    if (folder || !canPick() || !state || state.offered || state.blocked || !rows.some((t) => t.kind === 'file')) return false;
    card.offer = true;
    mark('offered', true);
    return true;
  }

  /* "Save files here automatically" on the card: the picker, then what the card is about is saved too. */
  async function fromCard(rows) {
    const files = rows.filter((t) => t.kind === 'file');
    const oldest = Math.min(Date.now(), ...files.map(time).filter(Boolean));
    await choose({ since: new Date(oldest).toISOString() });
    return true;  // the card stays, to say it's saved
  }

  /* -- when to look */

  function check({ chance = false } = {}) {
    if (!here() || !V.data.user || !V.data.transfers) return;
    loadFolder().then(() => saveCheck());
    const state = begin();
    const since = (Date.parse(state.since) || 0) - SKEW;
    const all = incoming().filter((t) => time(t) >= since).sort(newestFirst);
    pickCopy(all);
    tell(all);
    copyNow(chance);
    looked = true;
  }

  /* Coming back to Vault: the page shows a moment before it has the focus the clipboard needs, so it looks again a few
     times until it has. */
  let again = null;
  function look() {
    clearTimeout(again);
    let tries = 0;
    const go = () => {
      check({ chance: true });
      if (target && target.state === 'waiting' && !inFront() && ++tries < 6) again = setTimeout(go, 300);
    };
    go();
  }

  if (here()) {
    V.on('back', look);
    window.addEventListener('focus', look);
    // (A page opened in a background tab never says 'back' the first time it's seen.)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) look(); });
    // A click or a key in Vault (the focus back from the address bar, say): what's waiting is copied now, after that
    // key's own copy if it was Ctrl+C (which is newer: js/clips.js).
    const chance = () => { if (target && target.state === 'waiting') setTimeout(() => check({ chance: true }), 0); };
    document.addEventListener('pointerdown', chance, true);
    document.addEventListener('keydown', chance, true);
  }

  /* -- Settings (js/settings.js): copying, and the folder of Files */

  let settingsDraw = null;
  const redrawSettings = () => { if (settingsDraw) settingsDraw(); };

  function settingsCard({ card: box, line, draw: redraw }) {
    if (!here()) return null;
    settingsDraw = redraw;
    loadFolder().then(() => {
      if (!folder || !folder.handle) return;
      permission(folder.handle, false).then((now) => { if (now !== allowed) { allowed = now; redrawSettings(); } });
    });
    const copying = canWords() ? line('Copy what arrives',
      'Pictures, links and words sent here go on the clipboard, ready to paste.',
      V.h('input.switch', { type: 'checkbox', checked: copyOn(), 'aria-label': 'Copy what arrives',
        onchange: (event) => setCopy(event.target.checked) })) : null;
    const folderRow = canPick() ? folderLine(line) : null;
    return copying || folderRow ? box('What arrives here', copying, folderRow) : null;  // (a browser that can do neither)
  }

  function folderLine(line) {
    const label = V.deviceKind.chromebook ? 'Save what arrives to Files' : 'Save what arrives to a folder';
    const state = read() || {};
    if (!folder) {
      return line(label, 'Pick a folder once: files sent here are saved there by themselves.'
        + (state.blocked ? ` ${yours()} didn't allow it last time.` : ''),
      V.button('Choose a folder', { icon: 'folder', onClick: () => choose() }));
    }
    const hint = trouble === 'gone' ? `Vault can't find ${folder.name} any more. Choose a folder again.`
      : allowed === 'prompt' ? `Saving to ${folder.name}. Vault needs your OK again.`
        : allowed === 'denied' ? `Vault isn't allowed to save to ${folder.name}. Choose it again.`
          : `Saving to ${folder.name} · since ${V.ago(folder.since)}`;
    return line(label, hint, V.h('div.setting-buttons', {},
      allowed === 'prompt' ? V.button('Allow', { kind: 'primary', onClick: allow }) : null,
      V.button('Change', { onClick: () => choose() }),
      V.button('Stop', { kind: 'danger-quiet', onClick: stop })));
  }

  return {
    /* send.js's arrived(): what came for this device (from a pull or Realtime). */
    take: (list) => { if (here() && list && list.length) check(); },
    /* After the first sync (send.js's checkIncoming). */
    start: () => { if (here()) loadFolder().then(() => { check(); redrawSettings(); }); },
    check,
    use,
    card: settingsCard,
    // Saving into Files or copying a picture now: not a moment for an update to reload.
    busy: () => !!saveRun || saving.size > 0 || !!(target && target.state === 'copying'),
  };
})();
