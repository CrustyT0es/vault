/* Vault: the Send tab. Files, links and bits of text between the owner's devices: the PC app, the phone, and any other
   browser ('web': a school Chromebook). See util.js's V.device.

   Picked, dropped or shared files wait in a tray first ("Ready to send": a preview of each, an x to take one out) and
   go when Send is pressed, with any words typed beside them, to the device picked in "Send to". Each file goes to the
   "vault" bucket at <owner>/transfers/<id>/<name>, with a small JPEG preview made here (a picture, or a video's first
   frame: <= 320 px, about 20 KB) next to it at <id>/_thumb.jpg (V.storageName never starts a name with "_", so it
   can't meet a real file), then a transfers row saying who it's for (to_device) with the preview in extra.thumb
   (+ thumb_size, w, h, seconds). Pictures sent together share extra.group (and extra.n, their order) and show as a
   mosaic. Rows without a preview (older ones, a kind this browser can't show) keep their icon. Files sent while
   offline wait in V.db's "outgoing" and go when the internet's back. Each device only takes in, and marks received,
   what was sent to it: on the PC a file is saved into Downloads\Vault by the app itself (V.pc saveFile), then (where
   the PC app can, and its settings say so) put on the clipboard ready to paste and shown on a small card with its
   picture (copyArrival / showArrival), else a tray notice as before; on a Chromebook or another browser js/arrive.js
   copies it, shows it on a card and can save it into a folder of Files; on the phone it waits in the list with Open /
   Save / Share. Android's share sheet hands files to Vault through sw.js ("shared"). */
'use strict';

V.send = (() => {
  const MAX = 50 * 1024 * 1024;
  const FREE_SPACE = 1024 * 1024 * 1024;
  const THUMB_SIDE = 320;          // a preview's longest side, in pixels
  const THUMB_NAME = '_thumb.jpg';
  const THUMB_GUESS = 20000;       // what a preview takes when its row doesn't say
  const MOSAIC = 4;                // pictures a group shows; the last of them says "+N" for the rest
  const progress = new Map();      // outgoing id -> 0..1
  const saving = new Set();        // incoming ids the PC is saving now
  const trouble = new Map();       // outgoing id -> why the last try didn't go
  const expanded = new Set();      // text rows opened with "More"
  const pictures = new Map();      // a preview's cloud path -> its object URL here, made once (redraws don't flicker)
  const local = new Map();         // outgoing id -> its preview's object URL, while it's on its way
  const staged = [];               // in the tray: { id, file, name, size, mime, url, thumb, w, h, seconds, making }
  const preparing = [];            // Send pressed, previews still being made
  let stagedAt = 0;
  let making = Promise.resolve();  // previews are made one at a time (a phone's memory)
  let target = V.other;
  let draft = '';                  // the words in the box, kept while another tab shows
  let root = null;
  let parts = null;
  let queueRunning = false;
  let queueAgain = false;
  let retry = null;

  /* Rows of the Send tab: those addressed to one of the three devices (not Vault Drive's or other parts' own rows), and
     of those only what this device sent or was sent. */
  const sendable = (t) => V.DEVICES.includes(t.to_device);
  const ours = (t) => sendable(t) && (t.from_device === V.device || t.to_device === V.device);
  const live = () => [...V.data.transfers.values()].filter((t) => !t.deleted);
  const newest = (a, b) => (b.created_at || b._edited || '').localeCompare(a.created_at || a._edited || '');
  const mine = () => live().filter(ours).sort(newest);
  const incoming = () => mine().filter((t) => t.to_device === V.device);
  const unseen = () => incoming().filter((t) => !t.received_at).length;
  const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const isPicture = (mime) => /^image\//.test(mime || '');
  const isVideo = (mime) => /^video\//.test(mime || '');
  const kindIcon = (t) => (t.kind === 'link' ? 'link' : t.kind === 'text' ? 'text' : isPicture(t.mime) ? 'image'
    : isVideo(t.mime) ? 'play' : 'file');
  const thumbOf = (t) => (t.kind === 'file' && t.extra && typeof t.extra.thumb === 'string' ? t.extra.thumb : '');
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

  /* -- where things can go: the PC and the phone always, a Chromebook (or other browser) once Vault has seen one */

  function known(device) {
    if (device === V.device) return false;
    if (device !== 'web') return true;
    const extra = (V.data.settings && V.data.settings.extra) || {};
    if (extra.devices && extra.devices.web) return true;
    for (const t of V.data.transfers.values()) if (t.from_device === 'web' || t.to_device === 'web') return true;
    return V.data.clips.some((c) => c.from_device === 'web');
  }
  const targets = () => V.DEVICES.filter(known);
  const where = () => (targets().includes(target) ? target : V.other);
  const hint = (to) => (to === 'pc' ? 'Files you send are saved in Downloads\\Vault on the PC by themselves.'
    : `Files wait in Vault on ${V.deviceName(to)} until you open them there.`);

  /* A Chromebook (or other browser) says so in the settings row's extra, so the PC and the phone can offer it in "Send
     to" before it has sent anything. Only extra is written (never the PIN's columns), straight to the cloud. */
  async function announce() {
    if (V.device !== 'web' || !V.cloud.sb || (V.cloud.status !== 'synced' && V.cloud.status !== 'held') || !V.data.user) return;
    const extra = (V.data.settings && V.data.settings.extra) || {};
    const label = V.deviceLabel('web');
    if (extra.devices && extra.devices.web && extra.devices.web.label === label) return;
    try {  // (merged into the cloud's newest extra: "Use Claude too", say, may have changed since this device looked)
      await V.cloud.changeExtra((now) => ({ ...now,
        devices: { ...(now.devices || {}), web: { label, seen: new Date().toISOString() } } }));
    } catch (error) { /* tried again next time Vault starts */ }
  }

  /* -- previews (made on the device that sends) */

  function canvasFor(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const draw = canvas.getContext('2d');
    draw.fillStyle = '#ffffff';  // a see-through PNG gets white behind it, as JPEG has no see-through
    draw.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, draw };
  }

  async function encode(canvas) {
    for (const quality of [0.72, 0.55, 0.4]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('No preview');
      if (blob.size <= 30000 || quality === 0.4) return blob;
    }
    return null;
  }

  async function pictureThumb(file) {
    // Decoded small straight away where the browser can (a 200 MP photo decoded whole would fill a phone's memory).
    const bitmap = await createImageBitmap(file, { resizeWidth: THUMB_SIDE * 2, resizeQuality: 'medium' })
      .catch(() => createImageBitmap(file));
    try {
      const scale = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
      const { canvas, draw } = canvasFor(bitmap.width * scale, bitmap.height * scale);
      draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { blob: await encode(canvas), w: canvas.width, h: canvas.height, seconds: 0 };
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  /* A video's first frame (a second in, or a tenth of a short one, as many start black). */
  function videoThumb(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      let done = false;
      let nudge = null;
      const finish = (value, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(nudge);
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(null, new Error('The video took too long')), 12000);
      const grab = async () => {
        try {
          const width = video.videoWidth;
          const height = video.videoHeight;
          if (!width || !height) throw new Error('No picture in that video');
          const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
          const { canvas, draw } = canvasFor(width * scale, height * scale);
          draw.drawImage(video, 0, 0, canvas.width, canvas.height);
          const seconds = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
          finish({ blob: await encode(canvas), w: canvas.width, h: canvas.height, seconds });
        } catch (error) {
          finish(null, error);
        }
      };
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      // Some phones only load a frame once asked to play (muted, so it's allowed); it's stopped straight after.
      video.addEventListener('loadedmetadata', () => { nudge = setTimeout(() => video.play().catch(() => {}), 1500); }, { once: true });
      video.addEventListener('loadeddata', () => {
        clearTimeout(nudge);
        const length = video.duration;
        if (Number.isFinite(length) && length > 0.5) {
          video.addEventListener('seeked', grab, { once: true });
          video.currentTime = Math.min(1, length / 10);
        } else grab();
      }, { once: true });
      video.addEventListener('error', () => finish(null, new Error('This browser can\'t play that video')), { once: true });
      video.src = url;
    });
  }

  async function preview(file) {
    try {
      if (isPicture(file.type)) return await pictureThumb(file);
      if (isVideo(file.type)) return await videoThumb(file);
    } catch (error) { /* a kind this browser can't show (HEIC in Chrome): no preview, the icon stays */ }
    return null;
  }

  /* -- the tray: what's picked, waiting for Send */

  function files(list, { to } = {}) {
    if (to && V.DEVICES.includes(to) && to !== V.device) target = to;
    const picked = [...(list || [])];
    const big = picked.filter((f) => f.size > MAX);
    if (big.length) V.toast(`${big[0].name} is over 50 MB, the most the free cloud takes.`, { kind: 'err', ms: 6000 });
    for (const file of picked.filter((f) => f.size <= MAX)) {
      const item = { id: V.uuid(), file, name: file.name || 'file', size: file.size,
        mime: file.type || 'application/octet-stream', url: '', thumb: null, w: 0, h: 0, seconds: 0, making: true };
      staged.push(item);
      making = making.then(async () => {
        if (!staged.includes(item) && !preparing.includes(item)) return;  // taken out before its turn
        const made = await preview(file);
        if (made && made.blob) Object.assign(item, { thumb: made.blob, w: made.w, h: made.h, seconds: made.seconds,
          url: URL.createObjectURL(made.blob) });
      }).catch(() => {}).then(() => { item.making = false; drawTray(); drawQueue(); });
      item.ready = making;
    }
    stagedAt = Date.now();
    drawTray();
    return Promise.resolve();
  }

  function unstage(item) {
    const at = staged.indexOf(item);
    if (at >= 0) staged.splice(at, 1);
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = '';
    drawTray();
  }

  function clearTray() {
    for (const item of [...staged]) unstage(item);
  }

  /* Send: the tray's files and the box's words, to the device picked. */
  async function sendAll() {
    const words = parts ? parts.area.value : draft;
    const to = where();
    if (!staged.length && !words.trim()) {
      V.toast('Pick a file or type something first.');
      return;
    }
    const items = staged.splice(0);
    for (const item of items) item.to = to;
    preparing.push(...items);  // at once: the previews still being made look for them here
    if (parts) parts.area.value = '';
    draft = '';
    drawTray();
    drawQueue();
    try {
      if (words.trim()) await text(words, { to });
    } catch (error) {
      V.problem(error);
      draft = words;  // the words aren't lost
      if (parts && !parts.area.value) parts.area.value = words;
    }
    if (items.length) await queue(items, to).catch(V.problem);
  }

  async function queue(items, to) {
    try {
      await Promise.all(items.map((item) => item.ready));
      const at = new Date().toISOString();
      const group = items.filter((item) => item.thumb).length > 1 ? V.uuid() : '';
      for (const [n, item] of items.entries()) {
        if (item.url) local.set(item.id, item.url);
        await V.db.put('outgoing', {
          id: item.id, name: item.name, size: item.size, mime: item.mime, blob: item.file, to, at, n,
          thumb: item.thumb || null, w: item.w, h: item.h, seconds: item.seconds, group: item.thumb ? group : '',
        });
      }
    } finally {
      for (const item of items) if (preparing.includes(item)) preparing.splice(preparing.indexOf(item), 1);
      draw();
    }
    runQueue();
  }

  /* -- sending */

  const inOrder = (a, b) => (a.at || '').localeCompare(b.at || '') || (a.n || 0) - (b.n || 0);

  async function runQueue() {
    if (queueRunning) { queueAgain = true; return; }
    if (!V.data.user) return;
    queueRunning = true;
    const sent = new Map();  // to -> names, said in one toast each at the end
    try {
      let stopped = false;
      do {
        queueAgain = false;
        for (const item of (await V.db.all('outgoing')).sort(inOrder)) {
          if (!navigator.onLine) { stopped = true; break; }
          if (!(await V.db.get('outgoing', item.id))) continue;  // "Don't send" pressed meanwhile
          try {
            if (await upload(item)) {
              if (!sent.has(item.to)) sent.set(item.to, []);
              sent.get(item.to).push(item.name);
            }
          } catch (error) {
            if (/50 MB/.test(error.message)) {
              await V.db.del('outgoing', item.id);
              V.problem(error);
              continue;
            }
            trouble.set(item.id, navigator.onLine ? 'Didn\'t go through: trying again in 30 seconds' : 'Waiting for the internet');
            // A hiccup (the cloud busy, a weak signal): try again by itself rather than wait for the next send.
            clearTimeout(retry);
            if (navigator.onLine) retry = setTimeout(runQueue, 30000);
            stopped = true;
            break;
          } finally {
            progress.delete(item.id);
          }
        }
      } while (queueAgain && !stopped);
    } finally {
      queueRunning = false;
      for (const [to, names] of sent) {
        V.toast(names.length === 1 ? `Sent ${names[0]} to ${V.deviceName(to)}` : `Sent ${names.length} files to ${V.deviceName(to)}`);
      }
      draw();
    }
  }

  /* One file (and its preview) up, then its row. False if "Don't send" was pressed meanwhile. */
  async function upload(item) {
    const folder = `${V.data.user.id}/transfers/${item.id}/`;
    const path = folder + V.storageName(item.name);
    progress.set(item.id, 0);
    drawQueue();
    await V.cloud.upload(path, item.blob, {
      mime: item.mime, onProgress: (share) => { progress.set(item.id, share); drawQueue(); },
    });
    const extra = {};
    if (item.thumb) {
      const thumb = folder + THUMB_NAME;
      try {
        await V.cloud.upload(thumb, item.thumb, { mime: 'image/jpeg' });
        await V.db.put('files', { key: thumb, blob: item.thumb, at: Date.now() });
        Object.assign(extra, { thumb, thumb_size: item.thumb.size, w: item.w || 0, h: item.h || 0 });
        if (item.seconds) extra.seconds = item.seconds;
        if (item.group) Object.assign(extra, { group: item.group, n: item.n || 0 });
        if (local.has(item.id)) pictures.set(thumb, local.get(item.id));  // the row shows the same picture at once
      } catch (error) { /* the file still goes; its row shows the icon */ }
    }
    if (!(await V.db.get('outgoing', item.id))) {  // "Don't send" pressed while it went up: take it back
      V.cloud.remove([path, extra.thumb].filter(Boolean)).catch(() => {});
      return false;
    }
    await V.cloud.save('transfers', {
      id: item.id, kind: 'file', name: item.name.slice(0, 500), path, size: item.size, mime: item.mime,
      text: '', from_device: V.device, to_device: item.to, received_at: null, deleted: false, extra,
      created_at: item.at,
    });
    await V.db.del('outgoing', item.id);
    local.delete(item.id);
    trouble.delete(item.id);
    return true;
  }

  async function text(words, { to = V.other, name = '' } = {}) {
    const clean = String(words || '').trim();
    if (!clean) return;
    const link = V.isLink(clean);
    await V.cloud.save('transfers', {
      id: V.uuid(), kind: link ? 'link' : 'text', name: (name || clean.split('\n')[0]).slice(0, 120),
      path: null, size: 0, mime: '', text: clean.slice(0, 200000), from_device: V.device, to_device: to,
      received_at: null, deleted: false, extra: {}, created_at: new Date().toISOString(),
    });
    V.toast(`Sent to ${V.deviceName(to)}`);
  }

  async function remove(transfer) {
    const thumb = thumbOf(transfer);
    const paths = [transfer.path, thumb].filter(Boolean);
    if (paths.length) V.cloud.remove(paths).catch(() => {});
    if (thumb) {
      V.db.del('files', thumb).catch(() => {});
      const url = pictures.get(thumb);
      if (typeof url === 'string') URL.revokeObjectURL(url);
      pictures.delete(thumb);
    }
    await V.cloud.save('transfers', { ...transfer, deleted: true });
  }

  /* -- receiving */

  async function received(transfer, extra = {}) {
    if (transfer.received_at && !Object.keys(extra).length) return;
    const now = V.data.transfers.get(transfer.id) || transfer;
    await V.cloud.save('transfers', { ...now, received_at: now.received_at || new Date().toISOString(),
      extra: { ...(now.extra || {}), ...extra } });
  }

  /* What's put on the PC's clipboard by itself: what came while Vault was open, if it was sent in the last half hour
     (by the cloud's time on it, which is when the sending began: a big upload takes a while; a clock a little ahead
     or behind still counts it), and of what came while it was closed only the last couple of minutes'. The rest
     could go over something copied since, so the card offers Copy instead (or the tray only tells of it). */
  const COPY_WITHIN = 30 * 60000;
  const COPY_SOON = 2 * 60000;
  const recent = (at, live) => Date.now() - Date.parse(at || '') < (live ? COPY_WITHIN : COPY_SOON);  // (and the future)
  let caughtUp = false;  // the first look after starting is done: what comes after that came while Vault was open
  const byTime = (a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0) || (b.n || 0) - (a.n || 0);
  let telling = 0;  // a batch being put on the clipboard and shown right now

  /* The PC tells about saved files once for a batch (six photos are one notice, not six). What arrived by itself (not
     a Save pressed here) also goes on the clipboard: the newest first, a picture as the picture and the file, other
     files as files, so Ctrl+V pastes them (the PC app's copyArrival, vault/desktop.py); and a small card shows it with
     its picture (showArrival). Each only where the PC app can and its setting is on; else the tray notice, as before. */
  const savedNews = [];
  const tellSaved = V.debounce(() => {
    const list = savedNews.splice(0);
    if (!list.length) return;
    telling++;
    tellPc(list).catch(() => {}).finally(() => { telling--; });
  }, 1200);

  async function tellPc(list) {
    const from = list.every((s) => s.from === list[0].from) ? V.deviceName(list[0].from) : 'your devices';
    const said = list.length === 1 ? `${list[0].name} is in ${list[0].folder}` : `${list.length} files are in ${list[0].folder}`;
    if (!list.some((s) => s.auto)) return V.pc.notify(`From ${from}`, said);  // saved with a button here: as before
    const prefs = V.prefs || {};
    const order = [...list].sort(byTime);  // newest first
    // Never a program or script (the PC app leaves those off too).
    const files = order.filter((s) => s.auto && s.path && !V.risky(s.path));
    const fresh = files.filter((s) => recent(s.at, s.live));
    const can = !!prefs.copyArrivals && V.pc.can('copyArrival');
    let copied = 0;
    // Not over something newer on the clipboard (a clip that came after it, or a copy made on the PC). Files sent
    // together all carry the time the sending began, so a later batch of the same send isn't "older" than the first.
    const sameSend = !!(fresh.length && lastCopy && lastCopy.at && lastCopy.at === fresh[0].at);
    if (fresh.length && can && !(V.clips && V.clips.older(fresh[0].sent, { same: !sameSend }))) {
      copied = await copyOnPc(fresh);
    }
    const newest = order[0];
    // The card shows the newest (its picture, if it's one: the PC app looks), with Open and Show in folder, and Copy
    // when it wasn't copied by itself.
    const offer = can && !copied && files.length ? { copy: { paths: files.slice(0, 100).map((s) => s.path) } } : {};
    if (await showOnPc({ title: `From ${from}`, text: newest.name || 'A file', path: newest.path,
      count: Math.max(list.length, copied), copied: copied > 0, ...offer })) return;
    return V.pc.notify(copied ? `Copied from ${from}` : `From ${from}`, said);
  }

  /* Files just saved onto the PC's clipboard, newest first (copyArrival: the newest picture among them as the picture
     too, so Ctrl+V pastes it into a chat, and all of them as files for a folder). Files sent together come in batches
     when their uploads finish apart: each later batch is copied with the ones before it (pictures sent together share
     a group, and everything sent at once the time the sending began), so the clipboard has them all, and a photo from
     the first batch is still the picture when the later one has none. Gives how many went on it (0: none, the
     clipboard is left as it was; the PC app leaves off any program, or one moved since). */
  let lastCopy = null;  // { groups, at, paths, when }
  async function copyOnPc(fresh) {
    const paths = fresh.map((s) => s.path);
    const groups = [...new Set(fresh.map((s) => s.group).filter(Boolean))];
    const at = fresh[0].at;
    const before = lastCopy && Date.now() - lastCopy.when < 5 * 60000
      && (groups.some((g) => lastCopy.groups.includes(g)) || (!!at && lastCopy.at === at)) ? lastCopy : null;
    const earlier = before ? before.paths.filter((p) => !paths.includes(p)) : [];
    for (const tried of earlier.length ? [[...paths, ...earlier], paths] : [paths]) {
      try {
        const answer = await V.pc.call('copyArrival', { paths: tried });
        lastCopy = { groups: [...new Set([...groups, ...(tried.length > paths.length ? before.groups : [])])],
          at, paths: tried, when: Date.now() };
        if (V.clips) V.clips.wrote(null, fresh[0].sent);
        return Number(answer && answer.count) || tried.length;
      } catch (error) { /* an earlier one was moved since: the new ones alone (and if they fail too, as it was) */ }
    }
    return 0;
  }

  /* The PC app's card (showArrival), when there is one and it's wanted: whether it showed (else the tray's notice).
     Without the file when the PC app won't show that one (a program, or moved since). */
  async function showOnPc(card) {
    if (!(V.prefs && V.prefs.arrivalPreview && V.pc.can('showArrival'))) return false;
    const { path, ...rest } = card;
    for (const args of path ? [{ ...rest, path }, rest] : [rest]) {
      try {
        return !!(await V.pc.call('showArrival', args)).shown;
      } catch (error) { /* tried without the file next */ }
    }
    return false;
  }

  /* A link or some words sent to the PC: on its clipboard (if they're new: recent()), and said. `live`: they came
     while Vault was open. */
  async function tellText(t, live) {
    const from = V.deviceName(t.from_device);
    const words = (t.text || '').slice(0, 200);
    const prefs = V.prefs || {};
    const can = !!prefs.copyArrivals && V.pc.can('copyArrival') && !!t.text;
    let copied = false;
    if (can && recent(t.created_at, live) && !(V.clips && V.clips.older(V.sentAt(t)))) {
      try {
        await V.pc.call('copyArrival', { text: t.text });
        copied = true;
        if (V.clips) V.clips.wrote(t.text, V.sentAt(t));
      } catch (error) { /* only said, then */ }
    }
    const offer = can && !copied ? { copy: { text: t.text } } : {};
    if (await showOnPc({ title: `From ${from}`, text: words, count: 1, copied, ...offer })) return;
    V.pc.notify(copied ? `Copied from ${from}` : t.kind === 'link' ? `A link from ${from}` : `Text from ${from}`, words);
  }

  /* The PC saves what's sent to it by itself, into Downloads\Vault. Gives where it went. `auto`: arrived() saving it
     as it came (only those are copied and shown on the card; a Save pressed here gets the notice as before). */
  async function saveOnPc(transfer, { auto = false, live = false } = {}) {
    if (saving.has(transfer.id)) return '';
    saving.add(transfer.id);
    draw();
    try {
      const url = await V.cloud.link(transfer.path);
      const answer = await V.pc.call('saveFile', { id: transfer.id, url, name: transfer.name || 'file' });
      await received(transfer, { saved: answer.path });
      savedNews.push({ from: transfer.from_device, name: transfer.name, folder: answer.folder || 'Downloads',
        path: answer.path, mime: transfer.mime || '', at: transfer.created_at || '', sent: V.sentAt(transfer),
        n: (transfer.extra && transfer.extra.n) || 0, group: (transfer.extra && transfer.extra.group) || '', auto, live });
      tellSaved();
      return answer.path;
    } catch (error) {
      V.problem(error);
      return '';
    } finally {
      saving.delete(transfer.id);
      draw();
    }
  }

  const announced = new Set();  // each arrival is told about once, however often the cloud sends it again
  const news = [];
  const tellNews = V.debounce(() => {
    const list = news.splice(0);
    if (!list.length) return;
    const from = list.every((t) => t.from_device === list[0].from_device) ? V.deviceName(list[0].from_device) : 'your other devices';
    const one = list[0];
    const what = list.length === 1 ? (one.kind === 'file' ? one.name : one.kind === 'link' ? 'A link' : 'Some text')
      : list.every((t) => isPicture(t.mime)) ? `${list.length} pictures`
        : list.every((t) => t.kind === 'file') ? `${list.length} files` : `${list.length} things`;
    V.toast(`${what} from ${from}`, { action: 'Show', onAction: () => V.go('send') });
  }, 400);

  // A Chromebook or another browser: js/arrive.js copies what comes, shows it on a card and can save it into Files.
  const onCard = () => V.device === 'web' && !V.desktop && !!V.arrive;

  function arrived(list) {
    const here = list.filter((t) => t.to_device === V.device && !t.received_at && !t.deleted);
    for (const t of here) {
      if (V.desktop && t.kind === 'file') saveOnPc(t, { auto: true, live: caughtUp });
      else if (announced.has(t.id)) continue;
      else if (V.desktop) {
        announced.add(t.id);
        received(t);
        tellText(t, caughtUp).catch(() => {});
      } else if (!onCard() && Date.now() - new Date(t.created_at || 0).getTime() < 10 * 60000) {
        announced.add(t.id);
        news.push(t);
        tellNews();
      }
    }
    if (onCard()) V.arrive.take(here);
    V.emit('badge');
  }

  /* Open, save or share a file on the phone or in a browser (what was sent to this device then counts as received). */
  async function openHere(transfer, how) {
    try {
      if (how === 'share' && navigator.share) {
        const response = await fetch(await V.cloud.link(transfer.path));
        const blob = await response.blob();
        const file = new File([blob], transfer.name || 'file', { type: transfer.mime || blob.type });
        if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('This device can\'t share that kind of file.');
        await navigator.share({ files: [file], title: transfer.name });
      } else {
        const url = await V.cloud.link(transfer.path, how === 'save' ? { download: transfer.name || 'file' } : {});
        if (how === 'save') {
          const a = V.h('a', { href: url, download: transfer.name || 'file', rel: 'noopener' });
          document.body.append(a); a.click(); a.remove();
        } else window.open(url, '_blank', 'noopener');
      }
      if (transfer.to_device === V.device) await received(transfer);
    } catch (error) {
      if (error.name !== 'AbortError') V.problem(error);
    }
  }

  async function saveAll(list) {
    if (V.desktop) {
      for (const t of list) if (!(t.extra && t.extra.saved)) await saveOnPc(t);
      return;
    }
    for (const t of list) await openHere(t, 'save');
  }

  async function shareAll(list) {
    try {
      const all = [];
      for (const t of list) {
        const blob = await (await fetch(await V.cloud.link(t.path))).blob();
        all.push(new File([blob], t.name || 'file', { type: t.mime || blob.type }));
      }
      if (navigator.canShare && !navigator.canShare({ files: all })) throw new Error('This device can\'t share those.');
      await navigator.share({ files: all });
      for (const t of list) if (t.to_device === V.device) await received(t);
    } catch (error) {
      if (error.name !== 'AbortError') V.problem(error);
    }
  }

  /* On the PC: where a file sent to it is (saving it first if it isn't yet). */
  async function savedPath(t) {
    const now = V.data.transfers.get(t.id) || t;
    return (now.extra && now.extra.saved) || saveOnPc(now);
  }

  /* On the PC: a copy of something it sent, into Downloads\Vault. */
  async function saveCopy(t) {
    try {
      const url = await V.cloud.link(t.path, { download: t.name || 'file' });
      const answer = await V.pc.call('saveFile', { id: '', url, name: t.name || 'file' });
      V.toast(`Saved in ${answer.folder || 'Downloads'}`);
    } catch (error) {
      V.problem(error);
    }
  }

  function openLink(url, t) {
    if (!/^https?:\/\//i.test(url)) return;  // web links only
    if (V.desktop) V.pc.call('openLink', { url }).catch(V.problem); else window.open(url, '_blank', 'noopener');
    if (t && t.to_device === V.device) received(t);
  }

  /* -- what Android's share sheet handed over (sw.js keeps it in V.db "shared")

     Words alone (no files) are copied on all the other devices at once: Android lets no app but the keyboard read the
     clipboard in the background, so Share > Vault is the one-tap way to copy something everywhere. Not words that
     look like a password or a code (V.clips.mayShare): for those "Copy on all my devices" stays the owner's choice. */

  async function takeShared() {
    const shared = await V.db.all('shared');
    if (!shared.length) return;
    await V.db.clear('shared');
    const all = shared.flatMap((s) => s.files || []);
    const words = shared.map((s) => [s.title, s.text, s.url].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
    const copied = words && !all.length && V.clips && V.clips.mayShare(words) ? await V.clips.shareShared(words) : '';
    // Where to paste it, never naming the device in hand: the PC has it already; a Chromebook's tab and the phone's
    // Vault need opening first ("Keep this clipboard in step").
    const where = ['Paste it on your PC now',
      V.device !== 'web' ? 'on the Chromebook, click Vault\'s tab first' : '',
      V.device !== 'phone' ? 'on your phone, open Vault first' : ''].filter(Boolean).join('; ') + '.';
    const content = [
      copied === 'sent' ? V.h('p.hint', { text: where }) : null,
      copied === 'later' ? V.h('p.hint', { text: 'Couldn\'t copy it right now: it goes when you\'re back online.' }) : null,
      all.length ? V.h('ul.shared-list', {}, all.map((f) => V.h('li', {}, V.icon(isPicture(f.type) ? 'image' : 'file'),
        V.h('span', { text: f.name }), V.h('span.muted', { text: V.size(f.size) })))) : null,
      words ? V.h('p.shared-text', { text: words.slice(0, 500) }) : null,
    ];
    V.sheet({
      title: copied === 'sent' ? 'Copied on all your devices' : 'Shared with Vault', content,
      actions: [
        { label: 'Save as a note', onClick: async () => {
          V.go('notes');
          await V.notes.create(V.TEMPLATES[0], {
            title: (shared[0].title || '').slice(0, 200), body: [shared[0].text, shared[0].url].filter(Boolean).join('\n'),
          });
          if (all.length) await V.editor.addFiles(all);  // pictures and other files alike (a shared PDF is kept too)
        } },
        ...(words && !all.length && copied !== 'sent'
          ? [{ label: 'Copy on all my devices', icon: 'copy', onClick: () => V.clips.share(words) }] : []),
        { label: 'Send to PC', kind: 'primary', icon: 'send', onClick: () => {
          // Into the tray, with the words in the box: a look first, then Send.
          if (words) draft = draft.trim() ? `${draft}\n${words}` : words;
          target = 'pc';
          V.go('send');
          if (all.length) files(all, { to: 'pc' });
        } },
      ],
    });
  }

  /* -- drawing */

  /* A preview from the cloud (V.cloud.blob keeps it on this device), as an <img>; a missing one shows the icon. */
  function image(t, alt = '') {
    const path = thumbOf(t);
    const img = V.h('img', { alt, decoding: 'async', draggable: 'false' });
    const known = pictures.get(path);
    const broken = () => img.replaceWith(V.icon(kindIcon(t)));
    if (typeof known === 'string') img.src = known;
    else if (known === null) setTimeout(broken);
    else {
      const loading = known || V.cloud.blob(path).then((blob) => {
        const url = URL.createObjectURL(blob);
        pictures.set(path, url);
        return url;
      }, (error) => { pictures.set(path, null); throw error; });
      if (!known) pictures.set(path, loading);
      loading.then((url) => { img.src = url; }, broken);
    }
    return img;
  }

  const badge = (seconds) => V.h('span.media-badge', {}, V.icon('play'), seconds ? clock(seconds) : null);

  const site = (url) => {
    try { return new URL(url).hostname.replace(/^www\./i, '') || url; } catch (error) { return url; }
  };
  const LINKS = /https?:\/\/[^\s<>"']+/gi;
  const linksIn = (words) => [...new Set((String(words).match(LINKS) || []).map((u) => u.replace(/[.,;:!?)\]]+$/, '')))].slice(0, 3);
  const linkChip = (url, t) => V.h('button.link-chip', { type: 'button', title: url, onclick: () => openLink(url, t) },
    V.icon('link'), V.h('span', { text: url.replace(/^https?:\/\/(www\.)?/i, '') }));

  /* A text row's words under its title (its first line, which isn't said twice). */
  const restOf = (t) => {
    const name = t.name || '';
    const all = t.text || '';
    return name && all.startsWith(name + '\n') ? all.slice(name.length + 1).replace(/^\n+/, '') : all === name ? '' : all;
  };

  function words(t) {
    const open = expanded.has(t.id);
    return [
      V.h('div.t-text' + (open ? '.open' : ''), { text: restOf(t).slice(0, open ? 20000 : 3000) }),
      V.h('button.more-btn', { type: 'button', hidden: !open, 'aria-expanded': String(open), text: open ? 'Less' : 'More',
        onclick: () => { if (open) expanded.delete(t.id); else expanded.add(t.id); draw(); } }),
    ];
  }

  function meta({ out, device, size, when, state, done }) {
    return V.h('div.t-meta', {},
      V.h('span.t-dir', {}, V.icon(out ? 'up-right' : 'down-left'), `${out ? 'To' : 'From'} ${V.deviceName(device)}`),
      size ? V.h('span', { text: V.size(size) }) : null,
      V.h('span', { text: V.ago(when) }),
      V.h('span.t-status' + (done ? '.ok' : ''), {}, done ? V.icon('check') : null, state));
  }

  function statusOf(t, out) {
    if (out) {
      const to = V.deviceName(t.to_device);
      if (t._dirty) return 'Sending...';
      if (!t.received_at) return `Waiting for ${to}`;
      if (t.kind !== 'file') return `Seen on ${to}`;
      return t.to_device === 'pc' || (t.extra && t.extra.saved) ? `Saved on ${to}` : `Opened on ${to}`;
    }
    if (saving.has(t.id)) return 'Saving...';
    if (t.extra && t.extra.saved) return V.desktop ? 'In your Downloads' : 'Saved to Files';  // (js/arrive.js)
    return t.received_at ? 'Received' : 'New';
  }

  function fileActions(t, out) {
    const actions = [];
    if (t.kind !== 'file' || out) return actions;
    if (V.desktop) {
      if (t.extra && t.extra.saved) {
        actions.push(V.button('Open', { icon: 'open', onClick: () => V.pc.call('openFile', { path: t.extra.saved }).catch(V.problem) }));
        actions.push(V.button('Show in folder', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: t.extra.saved }).catch(V.problem) }));
      } else actions.push(V.button('Save', { icon: 'download', onClick: () => saveOnPc(t) }));
    } else {
      actions.push(V.button('Open', { icon: 'open', kind: 'primary', onClick: () => openHere(t, 'open') }));
      actions.push(V.button('Save', { icon: 'download', onClick: () => openHere(t, 'save') }));
      if (navigator.share) actions.push(V.button('Share', { icon: 'share', onClick: () => openHere(t, 'share') }));
    }
    return actions;
  }

  function row(t) {
    const out = t.from_device === V.device;
    const thumb = thumbOf(t);
    const arrivedHere = out ? !!t.received_at && !t._dirty : !!t.received_at && !saving.has(t.id);
    const actions = fileActions(t, out);
    if (t.kind !== 'file') {
      actions.push(V.button('Copy', { icon: 'copy', onClick: async () => {
        await V.copy(t.text, { cloud: !out });  // (what came from elsewhere isn't sent back up as a clip)
        V.toast('Copied');
        if (!out) received(t);
      } }));
      if (t.kind === 'link') actions.push(V.button('Open', { icon: 'open', onClick: () => openLink(t.text.trim(), out ? null : t) }));
    }
    actions.push(V.iconButton('trash', 'Delete', () => remove(t), 'quiet'));
    const visual = thumb
      ? V.h('button.t-thumb', { type: 'button', 'aria-label': `Look at ${t.name}`, onclick: () => viewer([t], 0) },
        image(t), isVideo(t.mime) ? badge(t.extra.seconds) : null)
      : V.h('div.t-icon', {}, V.icon(kindIcon(t)));
    const link = t.kind === 'link' ? t.text.trim() : '';
    const name = t.kind === 'file' ? t.name : link ? site(link) : t.name || t.text;
    const longer = t.kind === 'text' && !!restOf(t).trim();
    return V.h('div.transfer' + (out ? '.out' : '.in') + (!out && !t.received_at ? '.fresh' : '') + (thumb ? '.has-thumb' : '')
      + (link ? '.is-link' : ''), { dataset: { id: t.id } },
      visual,
      V.h('div.t-main', {},
        V.h('div.t-name', { text: name, title: name }),
        link ? linkChip(link, out ? null : t) : null,
        longer ? words(t) : null,
        t.kind === 'text' && linksIn(t.text).length
          ? V.h('div.t-links', {}, linksIn(t.text).map((url) => linkChip(url, out ? null : t))) : null,
        meta({ out, device: out ? t.to_device : t.from_device, size: t.size, when: t.created_at || t._edited,
          state: statusOf(t, out), done: arrivedHere })),
      V.h('div.t-actions', {}, actions));
  }

  /* Pictures sent together: one card with a mosaic of up to four, the fourth saying how many more. */
  function groupRow(list) {
    const first = list[0];
    const out = first.from_device === V.device;
    const n = list.length;
    const videos = list.filter((t) => isVideo(t.mime)).length;
    const what = videos === n ? 'videos' : videos ? 'pictures and videos' : 'pictures';
    const got = list.filter((t) => t.received_at).length;
    let state;
    let done;
    const allSaved = list.every((t) => t.extra && t.extra.saved);
    if (out) {
      const to = V.deviceName(first.to_device);
      const word = first.to_device === 'pc' || allSaved ? 'saved' : 'opened';
      done = got === n && !list.some((t) => t._dirty);
      state = list.some((t) => t._dirty) ? 'Sending...' : done ? `${cap(word)} on ${to}` : got ? `${got} of ${n} ${word}` : `Waiting for ${to}`;
    } else {
      const busy = list.some((t) => saving.has(t.id));
      done = got === n && !busy;
      state = busy ? 'Saving...' : allSaved ? (V.desktop ? 'In your Downloads' : 'Saved to Files')
        : got === n ? 'Received' : got ? `${got} of ${n} opened` : 'New';
    }
    const more = n - MOSAIC;
    const mosaic = V.h('div.t-mosaic', { dataset: { n: String(Math.min(n, MOSAIC)) } }, list.slice(0, MOSAIC).map((t, i) =>
      V.h('button.mosaic-tile', { type: 'button', onclick: () => viewer(list, i),
        'aria-label': i === MOSAIC - 1 && more > 0 ? `Look at all ${n}` : `Look at ${t.name}` },
      image(t), isVideo(t.mime) ? badge(t.extra.seconds) : null,
      i === MOSAIC - 1 && more > 0 ? V.h('span.mosaic-more', { text: `+${more}` }) : null)));
    const actions = [];
    if (!out) {
      if (V.desktop) {
        const saved = list.find((t) => t.extra && t.extra.saved);
        if (list.every((t) => t.extra && t.extra.saved)) {
          actions.push(V.button('Show in folder', { icon: 'folder', onClick: () => V.pc.call('showFile', { path: saved.extra.saved }).catch(V.problem) }));
        } else actions.push(V.button('Save all', { icon: 'download', onClick: () => saveAll(list) }));
      } else {
        actions.push(V.button('Save all', { icon: 'download', kind: 'primary', onClick: () => saveAll(list) }));
        if (navigator.share) actions.push(V.button('Share', { icon: 'share', onClick: () => shareAll(list) }));
      }
    }
    actions.push(V.iconButton('trash', 'Delete', async () => {
      const sure = await V.confirm(`Delete these ${n} ${what}?`, 'They go from your cloud. Copies already saved on your devices stay.',
        { ok: 'Delete', danger: true });
      if (sure) for (const t of list) await remove(t);
    }, 'quiet'));
    return V.h('div.transfer.group' + (out ? '.out' : '.in') + (!out && got < n ? '.fresh' : ''), { dataset: { group: first.extra.group } },
      mosaic,
      V.h('div.t-main', {},
        V.h('div.t-name', { text: `${n} ${what}` }),
        meta({ out, device: out ? first.to_device : first.from_device, size: list.reduce((sum, t) => sum + (t.size || 0), 0),
          when: first.created_at || first._edited, state, done })),
      V.h('div.t-actions', {}, actions));
  }

  /* Rows in order, with each group's pictures (2 or more with previews) gathered at the place of its newest. */
  function together(list) {
    const groups = new Map();
    for (const t of list) {
      const key = thumbOf(t) && t.extra.group;
      if (key) groups.set(key, [...(groups.get(key) || []), t]);
    }
    const out = [];
    const done = new Set();
    for (const t of list) {
      const key = thumbOf(t) && t.extra.group;
      const members = key && groups.get(key);
      if (!members || members.length < 2) { out.push([t]); continue; }
      if (done.has(key)) continue;
      done.add(key);
      out.push([...members].sort((a, b) => (a.extra.n || 0) - (b.extra.n || 0)));
    }
    return out;
  }

  /* The big view of a picture or a video (and the others sent with it: arrows, or the keyboard's left and right). */
  function viewer(list, start) {
    let at = start;
    let open = true;
    const stage = V.h('div.send-viewer');
    const count = list.length > 1 ? V.h('p.viewer-count') : null;
    const step = (by) => show(at + by);
    const nav = list.length > 1 ? [
      V.h('button.viewer-nav.prev', { type: 'button', 'aria-label': 'Previous', title: 'Previous', onclick: () => step(-1) }, V.icon('back')),
      V.h('button.viewer-nav.next', { type: 'button', 'aria-label': 'Next', title: 'Next', onclick: () => step(1) }, V.icon('next')),
    ] : null;
    const keys = (event) => {
      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    };
    const current = () => list[at];
    const sheet = V.sheet({
      title: current().name || 'Picture', wide: true, content: [V.h('div.viewer-frame', {}, stage, nav), count],
      actions: viewerActions(current),
      onClose: () => { open = false; document.removeEventListener('keydown', keys); },
    });
    if (list.length > 1) document.addEventListener('keydown', keys);

    function show(i) {
      at = (i + list.length) % list.length;
      const t = list[at];
      const head = sheet.el.querySelector('.sheet-head h2');
      if (head) head.textContent = t.name || 'Picture';
      if (count) count.textContent = `${at + 1} of ${list.length}`;
      if (!V.desktop && t.to_device === V.device && !t.received_at) received(t);  // seen big: it's arrived
      const still = () => open && list[at] === t;
      const poster = pictures.get(thumbOf(t));
      if (isVideo(t.mime)) {
        const video = V.h('video', { controls: true, playsinline: true, preload: 'metadata',
          poster: typeof poster === 'string' ? poster : null });
        V.cloud.link(t.path).then((url) => { if (still()) video.src = url; }).catch(() => {});
        V.clear(stage, video);
        return;
      }
      const img = image(t, t.name || 'Picture');
      if (t.extra.w > 0 && t.extra.h > 0) img.style.aspectRatio = `${t.extra.w} / ${t.extra.h}`;  // no jump when the whole one comes
      V.cloud.link(t.path).then((url) => {  // the whole picture once it's here (the preview meanwhile)
        const whole = new Image();
        whole.onload = () => { if (still()) img.src = url; };
        whole.src = url;
      }).catch(() => {});
      V.clear(stage, img);
    }
    show(at);
  }

  function viewerActions(current) {
    if (V.desktop) {
      if (current().to_device === V.device) {
        return [
          { label: 'Show in folder', icon: 'folder', onClick: async () => {
            const path = await savedPath(current());
            if (path) V.pc.call('showFile', { path }).catch(V.problem);
            return true;
          } },
          { label: 'Open', icon: 'open', kind: 'primary', onClick: async () => {
            const path = await savedPath(current());
            if (path) V.pc.call('openFile', { path }).catch(V.problem);
            return true;
          } },
        ];
      }
      return [{ label: 'Save a copy', icon: 'download', onClick: async () => { await saveCopy(current()); return true; } }];
    }
    return [
      navigator.share ? { label: 'Share', icon: 'share', onClick: async () => { await openHere(current(), 'share'); return true; } } : null,
      { label: 'Save', icon: 'download', onClick: async () => { await openHere(current(), 'save'); return true; } },
      { label: 'Open', icon: 'open', kind: 'primary', onClick: () => { openHere(current(), 'open'); return true; } },
    ].filter(Boolean);
  }

  function stageTile(item) {
    const media = isPicture(item.mime) || isVideo(item.mime);
    return V.h('div.stage' + (item.url ? '.has-picture' : ''), { title: item.name },
      item.url ? V.h('img', { src: item.url, alt: item.name, draggable: 'false' })
        : item.making && media ? V.h('div.spinner')
          : V.h('div.stage-file', {}, V.icon(kindIcon({ kind: 'file', mime: item.mime })),
            V.h('span.stage-name', { text: item.name }), V.h('span.stage-size', { text: V.size(item.size) })),
      item.url && isVideo(item.mime) ? badge(item.seconds) : null,
      V.h('button.stage-x', { type: 'button', 'aria-label': `Don't send ${item.name}`, title: 'Don\'t send this one',
        onclick: () => unstage(item) }, V.icon('x')));
  }

  function drawTray() {
    if (!parts) return;
    parts.tray.hidden = !staged.length;
    if (!staged.length) { V.clear(parts.tray); return; }
    const total = staged.reduce((sum, item) => sum + (item.size || 0), 0);
    V.clear(parts.tray,
      V.h('div.tray-head', {},
        V.h('div.tray-title', {}, V.h('strong', { text: 'Ready to send' }),
          V.h('span', { text: `${plural(staged.length, 'file')} · ${V.size(total)}` })),
        V.button('Clear', { kind: 'quiet', onClick: clearTray })),
      V.h('div.tray-items', {}, staged.map(stageTile)),
      V.h('p.tray-hint', { text: `Check them, then press Send. They go to ${V.deviceName(where())}.` }));
  }

  function queueRow(item, getting) {
    let url = local.get(item.id) || (getting ? item.url : '');
    if (!url && item.thumb instanceof Blob) {
      url = URL.createObjectURL(item.thumb);
      local.set(item.id, url);
    }
    const why = getting ? 'Getting it ready...' : trouble.get(item.id);
    return V.h('div.transfer.out.pending' + (url ? '.has-thumb' : ''), {},
      url ? V.h('div.t-thumb', {}, V.h('img', { src: url, alt: '' })) : V.h('div.t-icon', {}, V.icon(kindIcon({ kind: 'file', mime: item.mime }))),
      V.h('div.t-main', {}, V.h('div.t-name', { text: item.name }),
        V.h('div.bar', {}, V.h('i', { style: { width: Math.round(100 * (progress.get(item.id) || 0)) + '%' } })),
        V.h('div.t-meta', {}, V.h('span', { text: `To ${V.deviceName(item.to)}` }), V.h('span', { text: V.size(item.size) }),
          why ? V.h('span.t-status', { text: why }) : null)),
      getting ? null : V.h('div.t-actions', {}, V.iconButton('x', 'Don\'t send', async () => {
        await V.db.del('outgoing', item.id);
        const own = local.get(item.id);
        if (own) URL.revokeObjectURL(own);
        local.delete(item.id);
        draw();
      }, 'quiet')));
  }

  function drawQueue() {
    if (!parts) return;
    V.db.all('outgoing').then((waiting) => {
      const rows = [...preparing.map((item) => queueRow(item, true)),
        ...waiting.sort(inOrder).map((item) => queueRow(item, false))];
      V.clear(parts.queue, rows.length ? V.h('h2.section', { text: navigator.onLine ? 'Sending' : 'Waiting for the internet' }) : null, rows);
    });
  }

  /* "Send to": a choice of devices when there's more than one, else the one there is, and what happens there. */
  function drawTo() {
    if (!parts) return;
    const to = where();
    const choices = targets();
    const key = [to, ...choices.map((d) => d + V.deviceLabel(d))].join('|');
    parts.title.textContent = `Send to ${V.deviceName(to)}`;
    parts.area.placeholder = `Text or a link for ${V.deviceName(to)}`;
    if (key === parts.key) return;
    parts.key = key;
    if (choices.length < 2) {
      V.clear(parts.to, V.h('div.device-card', {}, V.icon(V.deviceIcon(to)), V.h('div.device-text', {},
        V.h('strong', { text: cap(V.deviceName(to)) }), V.h('span', { text: hint(to) }))));
      return;
    }
    V.clear(parts.to, V.h('div.send-to', {},
      V.h('div.send-to-row', {}, V.h('span.send-to-label', { text: 'Send to' }),
        V.h('div.segmented.send-to-pick', { role: 'radiogroup', 'aria-label': 'Send to' }, choices.map((d) => V.h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(d === to), dataset: { to: d },
          onclick: () => { target = d; drawTo(); drawTray(); },
        }, V.icon(V.deviceIcon(d)), V.h('span', { text: V.deviceLabel(d) }))))),
      V.h('p.send-hint', { text: hint(to) })));
  }

  function draw() {
    if (!parts || !root || !root.isConnected || root.dataset.tab !== 'send') return;
    drawQueue();
    drawTo();
    const entries = together(mine());
    V.clear(parts.list, entries.length ? entries.map((list) => (list.length > 1 ? groupRow(list) : row(list[0])))
      : V.h('div.empty.small', {}, V.mark(36), V.h('p', { text: V.desktop ? 'Nothing sent yet. Drop a file here and it goes to your phone.'
        // (iPhones and iPads have no "share to Vault": Safari's pages can't be share targets there.)
        : V.deviceKind.ios ? 'Nothing sent yet. Pick files or photos above.'
        : V.device === 'phone' ? 'Nothing sent yet. Share a photo to Vault, or pick files above.'
          : 'Nothing sent yet. Pick files above, or drop them anywhere in Vault.' })));
    // "More" only where the words didn't fit in their four lines.
    requestAnimationFrame(() => {
      for (const box of parts.list.querySelectorAll('.t-text:not(.open)')) {
        const button = box.nextElementSibling;
        if (button && button.classList.contains('more-btn')) button.hidden = box.scrollHeight <= box.clientHeight + 1;
      }
    });
    const files = live();
    const used = files.reduce((sum, t) => sum + (t.size || 0) + (thumbOf(t) ? Number(t.extra.thumb_size) || THUMB_GUESS : 0), 0) +
      [...V.data.notes.values()].reduce((sum, n) => sum + (n.attachments || []).reduce((s, a) => s + (a.size || 0), 0), 0) +
      (V.chat ? V.chat.filesSize() : 0);
    V.clear(parts.space, V.h('div.bar.space', {}, V.h('i', { style: { width: Math.min(100, 100 * used / FREE_SPACE) + '%' } })),
      V.h('span', { text: `${V.size(used)} of 1 GB of free space used` }),
      files.some((t) => sendable(t) && t.kind === 'file') ? V.button('Clean up', { kind: 'quiet', onClick: cleanUp }) : null);
  }

  async function cleanUp() {
    const sent = live().filter((t) => sendable(t) && t.kind === 'file');
    const old = sent.filter((t) => Date.now() - new Date(t.created_at).getTime() > 7 * 86400000);
    const choice = await V.confirm('Clean up?', old.length
      ? `Delete the ${old.length} file${old.length > 1 ? 's' : ''} sent over a week ago from the cloud? Copies already saved on your devices stay.`
      : 'Delete every sent file from the cloud? Copies already saved on your devices stay.', { ok: 'Delete', danger: true });
    if (!choice) return;
    for (const t of old.length ? old : sent) await remove(t);
  }

  function render(container) {
    root = container;
    const area = V.h('textarea.field.send-text', { rows: 1, 'aria-label': 'Text to send', value: draft });
    area.addEventListener('input', () => { draft = area.value; });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); sendAll(); }
    });
    const take = (input) => () => { files(input.files); input.value = ''; };
    const picker = V.h('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', take(picker));
    parts = { title: V.h('h1'), to: V.h('div.send-to-wrap'), tray: V.h('div.tray', { hidden: true }), area, key: '',
      queue: V.h('div.queue'), list: V.h('div.transfers'), space: V.h('div.space-row') };
    let choose;
    if (V.desktop) {
      choose = V.h('button.drop-zone', { type: 'button', onclick: () => picker.click() },
        V.icon('upload', 'big'), V.h('strong', { text: 'Choose files' }),
        V.h('span', { text: 'or drop them anywhere in Vault (up to 50 MB each)' }));
    } else {
      // Photos from the gallery, any file, or (on the phone) a photo taken now.
      const photos = V.h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
      const camera = V.device === 'phone' ? V.h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true }) : null;
      photos.addEventListener('change', take(photos));
      if (camera) camera.addEventListener('change', take(camera));
      const tile = (icon, label, small, input) => V.h('button.tile', { type: 'button', onclick: () => input.click() },
        V.icon(icon), V.h('span', {}, V.h('strong', { text: label }), V.h('small', { text: small })));
      choose = [V.h('div.tiles' + (camera ? '' : '.two'), {}, tile('image', 'Photos', camera ? 'Gallery' : 'Pictures and videos', photos),
        tile('file', 'Files', 'Any type', picker), camera ? tile('camera', 'Camera', 'Snap one', camera) : null), photos, camera];
    }
    V.clear(container, V.h('div.page', {},
      V.h('div.page-head', {}, parts.title, V.statusPill()),
      V.h('div.send-card', {},
        picker,
        parts.to,
        choose,
        parts.tray,
        V.h('div.send-row', {}, area, V.button('Send', { kind: 'primary', icon: 'arrow-up', onClick: sendAll }))),
      parts.queue,
      V.h('h2.section', { text: 'Sent and received' }),
      parts.list,
      parts.space));
    drawTray();
    draw();
    // Looking at the list counts as having seen what came in (files wait to be opened).
    for (const t of incoming()) if (!t.received_at && t.kind !== 'file') received(t);
  }

  /* Settings' line saying which device this is (and a way to put a wrong guess right). */
  function deviceSetting() {
    if (V.desktop) return null;
    const phone = V.device === 'phone';
    const model = V.deviceKind.ios ? V.deviceKind.model : 'phone';
    const label = phone ? `This is your ${model}` : V.deviceKind.chromebook ? 'This is your Chromebook' : 'This is a web browser';
    const said = phone ? `What's sent to your ${model} shows up here.`
      : `What's sent to ${V.deviceName('web')} shows up here. What's sent to your phone waits for the phone.`;
    const change = V.button('Change', { onClick: (event) => V.menu(event.currentTarget, [
      { label: 'It\'s my phone', icon: 'phone', onClick: () => V.setDevice('phone') },
      { label: 'It\'s a Chromebook or another browser', icon: 'laptop', onClick: () => V.setDevice('web') },
    ]) });
    return V.h('div.setting.device-setting', {},
      V.h('div.setting-text', {}, V.h('strong', { text: label }), V.h('span', { text: said })), change);
  }

  V.on('data', (table) => {
    if (table === 'transfers') { draw(); V.emit('badge'); }
    if (table === 'settings' || table === 'clips') drawTo();
  });
  V.on('transfers-in', arrived);
  window.addEventListener('online', runQueue);

  return {
    render, files, text, runQueue, takeShared, unseen, deviceSetting,
    targets, preview,
    // For js/arrive.js's card: the preview, the big view, opening and marking what came as arrived.
    image, viewer, received, openHere, openLink, kindIcon,
    checkIncoming: () => {
      if (V.arrive) V.arrive.start();  // (a Chromebook's first look: what it knew already isn't new)
      arrived(incoming());
      caughtUp = true;
      announce();
    },
    // A file going up, the PC saving one (or about to tell of it), what arrived being copied or saved into Files, or
    // files waiting in the tray (for half an hour): not a moment to reload.
    busy: () => queueRunning || saving.size > 0 || preparing.length > 0 || tellSaved.pending() || telling > 0
      || (V.arrive ? V.arrive.busy() : false) || (staged.length > 0 && Date.now() - stagedAt < 30 * 60000),
  };
})();
