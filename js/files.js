/* Vault: Share > Files. "Almost like a cloud" between the PC and the phone, with nothing new in the cloud's tables:

   - Your PC (on the phone or a Chromebook): browse the folders the owner shares from the PC, read only. Each request
     is a transfers row named 'vault-files' with deleted=true (so every Vault leaves it out of its lists); the PC app
     answers in the same row (vault/pcfiles.py). The PC says it's there in a 'vault-files-host' row: on or off, its
     folders, and the cloud's own "last seen". A file comes up to <owner>/pcfiles/<request>/ first.
   - Your phone (on the PC): the same the other way, for a folder the phone shares while Vault is open on it (only
     where its browser can: 'showDirectoryPicker'). Elsewhere, Windows 11's own "Show mobile device in File Explorer".
   - Vault Drive: a folder in the owner's cloud both devices see even when the other is off: transfers rows of kind
     'file' (folders: kind 'text', extra.drive.dir) with to_device 'drive' and extra.drive.folder ('School/Bio').
   - Share this PC (on the PC): the switch and the folders; the PC app asks the owner itself before sharing more.

   The PC app's page is only the doorbell for requests (Realtime, or a check every 8 seconds when that's down); Python
   does the file work. Rows: tap opens, long-press (finger or S Pen) or right-click opens the file's menu. */
'use strict';

V.files = (() => {
  const PROTOCOL = 'vault-files';
  const HOST_ROW = 'vault-files-host';
  const MAX = V.FILE_MOST;   // (js/util.js: the one number for the biggest file)
  const FREE_SPACE = 1024 * 1024 * 1024;
  const FRESH = 7 * 60 * 1000;            // a host seen longer ago than this is off, asleep, or Vault isn't running
  const STALE = 90 * 1000;                // a request older than this is refused, never run late
  const PAGE = 200;
  /* Wefty Drive (1.22.3): what's held in memory at once, as one ZIP or one share (a Chromebook has little; more goes
     one by one), a picture read whole for its preview, and a video read for its first frame (only those bits come
     down, so the cap is for the rare file that can't be read in pieces). */
  const MB = 1024 * 1024;
  const HOLD_MOST = 250 * MB;
  const LAZY_PICTURE_MOST = 10 * MB;
  const LAZY_VIDEO_MOST = 150 * MB;
  const tune = { timeout: 12000, poll: 8000, marks: [500, 1000, 2000, 3000, 5000, 8000, 12000], hold: 500,
    holdMost: HOLD_MOST, gap: 1200, letGo: 4000, lazyPicture: LAZY_PICTURE_MOST, lazyVideo: LAZY_VIDEO_MOST };
  const PLACE = 'vault-files-place';      // localStorage: where this device last looked (a convenience only)
  const SHARE = 'files-share';            // V.db meta: this phone's shared folder { handle, name }
  const HERE_ID = 'files-host-id';        // V.db meta: this device's host id
  const PICTURE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i;
  const THUMBABLE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;
  const SHOWN_PICTURE = /\.(jpe?g|jfif|png|gif|webp|bmp|avif)$/i;  // what a browser shows (Safari HEIC too: APPLE_PICTURE)
  const APPLE_PICTURE = /\.(heic|heif)$/i;
  const VIDEO = /\.(mp4|m4v|mov|webm|ogv|3gp)$/i;
  const DRIVE_VIEW = 'wefty-drive-view';  // localStorage: Wefty Drive as a 'list' or a 'grid', this device's
  // Chrome on Android shares only these kinds of file, by name and exact media type (Chromium's ShareServiceImpl;
  // anything else is turned down when it's shared, while canShare() says yes to every file: js/export.js says so too).
  const SHARE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', tif: 'image/tiff',
    tiff: 'image/tiff', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mpeg: 'video/mpeg', mpg: 'video/mpeg',
    ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/x-m4a', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NO_PC = 'Your PC didn\'t answer. Is it awake, with Wefty by the clock?';
  const NO_PHONE = 'Your phone didn\'t answer. Is Wefty open on it?';
  const OFFLINE = 'No internet just now. Try again when you\'re back online.';
  const FULL = 'Your free cloud is full (1 GB). Delete things from Wefty Drive or Send first.';
  const canShareHere = !V.desktop && 'showDirectoryPicker' in window;

  let root = null;
  let parts = null;
  let started = false;
  let channel = null;
  let live = false;
  let pollTimer = null;
  const pending = new Map();   // requests this device is waiting on: id -> { row, wake }
  const rung = new Set();      // requests handed to the PC app already
  const serving = new Set();   // requests this phone is answering now
  let hosts = null;            // presence rows, once read
  let hostsAt = 0;
  let hostsLoading = null;
  let hostsTrouble = '';
  let source = null;
  const browse = { host: null, root: null, path: [], listing: null, loading: false, more: false, problem: null,
    filter: '', ticket: 0, anyway: false };
  const thumbs = new Map();    // host/root/path/name/mtime -> data: link
  const fetched = new Map();   // a remote file brought up to the cloud: key -> { file, until }
  const uploads = new Map();   // Drive uploads going now: id -> { name, size, share, folder }
  let busyCount = 0;
  let drive = '';              // the Drive folder showing ('' = the top)
  let here = null;             // this phone's shared folder: { handle, name, id, state: 'on' | 'ask', looked }
  let shareState = null;       // PC: what filesSettings said
  // Wefty Drive's rows picked (1.22.3): picking on (`held`: by the Select button, so it stays on with none picked),
  // the ids, where a Shift+click or Shift+arrow range starts (`anchor`) and what was picked before it (`base`), and
  // the save, share, delete or move going now (`job`).
  const pick = { on: false, held: false, ids: new Set(), anchor: null, base: null, job: null };
  const faces = new Map();     // a preview's cloud path -> its object URL here (a promise while it loads, null: none)
  const madeHere = new Map();  // a Drive row's id -> the preview made here for a file that had none
  const lazy = { queue: [], running: false, failed: new Set(), observer: null };

  const files = (row) => (row && row.extra && typeof row.extra.files === 'object' && row.extra.files) || {};
  const refusal = (text) => Object.assign(new Error(text), { refused: true });
  const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* private */ } };
  const recall = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; } };
  const deviceLabel = () => (V.deviceKind.chromebook ? 'Chromebook' : V.deviceKind.ios ? V.deviceKind.model
    : V.deviceKind.android ? 'Phone' : 'Browser');
  const hereLabel = () => (V.deviceKind.ios ? `This ${V.deviceKind.model}` : V.deviceKind.android
    || (V.device === 'phone' && !V.deviceKind.chromebook) ? 'This phone' : 'This device');

  /* ---------------------------------------------------------------- asking another device */

  function listen() {
    const sb = V.cloud.sb;
    if (channel || !sb) return;
    try {
      channel = sb.channel('vault-files-' + V.device + '-' + Math.random().toString(36).slice(2, 8));
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'transfers', filter: 'name=eq.' + PROTOCOL },
        heard);
      channel.subscribe((state) => { live = state === 'SUBSCRIBED'; });
    } catch (error) {
      console.warn('Vault files: no live channel', error);
    }
  }

  function heard(change) {
    const row = change.new || {};
    if (!row.id) return;
    const waiter = pending.get(row.id);
    if (waiter) { waiter.row = row; if (waiter.wake) waiter.wake(); }
    if (change.eventType === 'INSERT' && !row.received_at) doorbell(row);
  }

  /* A request for this device: the PC app answers it in Python; a phone sharing a folder answers it here. */
  function doorbell(row) {
    if (row.to_device !== V.device || row.received_at) return;
    if (V.desktop) {
      if (rung.has(row.id) || !V.pc.can('filesRequest')) return;
      rung.add(row.id);
      if (rung.size > 300) rung.delete(rung.values().next().value);
      V.pc.call('filesRequest', { id: row.id }).catch((error) => console.warn('Vault files:', error));
    } else if (here && here.state === 'on' && files(row).host === here.id && !V.away()) {
      serve(row);
    }
  }

  const listening = () => (V.desktop ? !!(V.pc.can('filesRequest') && V.prefs && V.prefs.pcFiles)
    : !!(here && here.state === 'on' && !V.away()));

  /* Without Realtime (a school network, the test cloud) requests are looked for every few seconds instead. */
  async function checkRequests(force) {
    const sb = V.cloud.sb;
    if (!sb || (!force && (live || !listening()))) return 0;
    const { data, error } = await sb.from('transfers').select('id,to_device,extra,created_at,received_at')
      .eq('name', PROTOCOL).eq('to_device', V.device).is('received_at', null).limit(20);
    if (error) throw error;
    for (const row of data || []) doorbell(row);
    return (data || []).length;
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try { await checkRequests(); } catch (error) { /* offline: next time */ }
      // Sharing a folder from here: "seen just now" for the PC, every few minutes while Vault is in front.
      if (here && here.state === 'on' && !V.away() && Date.now() - hereSaid > 3 * 60000) announceHere(true);
      poll();
    }, tune.poll);
  }

  async function readRow(id) {
    try {
      const { data, error } = await V.cloud.sb.from('transfers').select('id,received_at,extra').eq('id', id).maybeSingle();
      return error ? null : data;
    } catch (error) {
      return null;
    }
  }

  const withdraw = (id) => V.cloud.sb.from('transfers').delete().eq('id', id).then(() => {}, () => {});
  const stretch = (size) => Math.min(10 * 60000, 30000 + ((size || 0) / 100000) * 1000);  // a big file: ~100 KB/s

  /* One request to another device, answered in its own row: resolves with the answer's result, or throws its reason
     (or "didn't answer" after a while, when the request is withdrawn so it's never run late). */
  async function ask(op, args, target) {
    const sb = V.cloud.sb;
    if (!sb) throw new Error('Wefty isn\'t connected yet.');
    if (!navigator.onLine) throw Object.assign(new Error(OFFLINE), { code: 'offline' });
    const id = V.uuid();
    const request = { v: 1, host: target.host, op, ...args };
    const { error } = await sb.from('transfers').insert({ id, kind: 'text', name: PROTOCOL, deleted: true,
      from_device: V.device, to_device: target.to, text: '', extra: { files: request } });
    if (error) throw (/fetch|network/i.test(error.message || '') ? Object.assign(new Error(OFFLINE), { code: 'offline' }) : error);
    listen();
    const waiter = { row: null, wake: null };
    pending.set(id, waiter);
    const start = Date.now();
    let deadline = start + tune.timeout;
    let mark = 0;
    try {
      for (;;) {
        const working = files(waiter.row).state === 'working';
        let wait = !working && mark < tune.marks.length ? start + tune.marks[mark++] - Date.now() : 2000;
        wait = Math.max(0, Math.min(wait, deadline - Date.now()));
        await new Promise((resolve) => { waiter.wake = resolve; setTimeout(resolve, wait); });
        waiter.wake = null;
        let row = waiter.row && waiter.row.received_at ? waiter.row : await readRow(id);
        if (row) waiter.row = row;
        row = waiter.row;
        const said = files(row);
        if (row && row.received_at) {
          // Read: gone. A file's row stays until the PC's hourly sweep, which takes the file's copy with it.
          if (op !== 'get' || said.state !== 'done') withdraw(id);
          if (said.state === 'done') return said.result || {};
          throw Object.assign(new Error(said.error || 'Something went wrong over there. Try again.'), { code: said.state });
        }
        if (said.state === 'working') deadline = Math.max(deadline, Date.now() + stretch(said.size));
        if (Date.now() >= deadline) {
          withdraw(id);
          if (!navigator.onLine) throw Object.assign(new Error(OFFLINE), { code: 'offline' });
          throw Object.assign(new Error(target.to === 'pc' ? NO_PC : NO_PHONE), { code: 'no-answer' });
        }
      }
    } finally {
      pending.delete(id);
    }
  }

  /* ---------------------------------------------------------------- who's there */

  async function loadHosts(force) {
    if (!V.cloud.sb) return [];
    if (hosts && !force && Date.now() - hostsAt < 30000) return hosts;
    if (hostsLoading) return hostsLoading;
    hostsLoading = (async () => {
      try {
        const { data, error } = await V.cloud.sb.from('transfers').select('id,from_device,extra,updated_at').eq('name', HOST_ROW);
        if (error) throw error;
        hosts = (data || []).map((row) => ({ ...(row.extra && row.extra.files_host) || {}, id: row.id,
          device: row.from_device, seen: row.updated_at })).filter((h) => h.v >= 1);
        hostsAt = Date.now();
        hostsTrouble = '';
      } catch (error) {
        hostsTrouble = navigator.onLine ? 'Wefty couldn\'t look for your devices just now.' : OFFLINE;
        if (!hosts) hosts = [];  // shown as "can't look" (with Try again), never asked again in a loop
        hostsAt = Date.now();
      } finally {
        hostsLoading = null;
      }
      return hosts || [];
    })();
    return hostsLoading;
  }

  const newest = (list) => list.sort((a, b) => String(b.seen || '').localeCompare(String(a.seen || '')));
  const hostsFor = (kind) => newest((hosts || []).filter((h) => (kind === 'pc' ? h.device === 'pc'
    : h.device !== 'pc' && (!here || h.id !== here.id))));
  const fresh = (host) => host && Date.now() - Date.parse(host.seen || 0) < FRESH;

  function seenText(iso) {
    const minutes = Math.floor((Date.now() - Date.parse(iso || 0)) / 60000);
    if (!iso || Number.isNaN(minutes)) return 'never seen';
    if (minutes < 1) return 'seen just now';
    if (minutes < 60) return `seen ${minutes} min ago`;
    if (minutes < 48 * 60) return `seen ${Math.floor(minutes / 60)} h ago`;
    return `seen ${Math.floor(minutes / 1440)} days ago`;
  }

  /* ---------------------------------------------------------------- a folder shared from this phone */

  async function hereId() {
    let id = await V.db.meta(HERE_ID);
    if (!id) { id = V.uuid(); await V.db.meta(HERE_ID, id); }
    return id;
  }

  let hereToken = '';
  let hereSaid = 0;
  function hereRow(on) {
    return { id: here.id, kind: 'text', name: HOST_ROW, deleted: true, from_device: V.device, to_device: V.device, text: '',
      extra: { files_host: { v: 1, on, label: deviceLabel(), device: V.device, app: V.VERSION,
        roots: here.name ? [{ id: 'shared', label: here.name }] : [] } } };
  }

  async function announceHere(on) {
    if (!here || !V.cloud.sb) return;
    try {
      hereSaid = Date.now();
      hereToken = await V.cloud.accessToken();
      await V.cloud.sb.from('transfers').upsert(hereRow(on));
    } catch (error) { /* offline: said again when Vault comes back to the front */ }
  }

  /* Out of sight: the PC is told at once (the page may be frozen any moment, so the request outlives it). */
  function hereAway() {
    if (!here || here.state !== 'on' || !hereToken || !V.config) return;
    try {
      fetch(`${V.config.url}/rest/v1/transfers?id=eq.${here.id}`, { method: 'PATCH', keepalive: true,
        headers: { apikey: V.config.key, Authorization: 'Bearer ' + hereToken, 'Content-Type': 'application/json',
          Prefer: 'return=minimal' },
        body: JSON.stringify({ extra: hereRow(false).extra }) }).catch(() => {});
    } catch (error) { /* gone already */ }
  }

  async function permitted(handle, ask) {
    try {
      if (!handle.queryPermission) return true;
      if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
      return ask ? (await handle.requestPermission({ mode: 'read' })) === 'granted' : false;
    } catch (error) {
      return false;
    }
  }

  async function restoreHere() {
    if (V.desktop) return;
    const kept = await V.db.meta(SHARE).catch(() => null);
    if (!kept || !kept.handle) return;
    here = { handle: kept.handle, name: kept.name || kept.handle.name, id: await hereId(), state: 'ask', looked: 0 };
    if (await permitted(here.handle, false)) {
      here.state = 'on';
      await announceHere(true);
      listen();
    } else {
      await announceHere(false);  // the PC says "not sharing right now" until it's allowed again
    }
    draw();
  }

  async function use(handle) {
    here = { handle, name: handle.name, id: await hereId(), state: 'on', looked: 0 };
    try { await V.db.meta(SHARE, { handle, name: handle.name }); } catch (error) { /* kept until Vault closes */ }
    await announceHere(true);
    listen();
    hostsAt = 0;
    draw();
  }

  async function pickHere() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'vault-share', mode: 'read' });
    } catch (error) {
      if (error.name !== 'AbortError') V.problem(new Error('That folder can\'t be shared. Pick another one (Android doesn\'t allow the whole storage or Download itself).'));
      return;
    }
    await use(handle);
    V.toast(`Your PC can see ${handle.name} while Wefty is open here`);
  }

  async function allowAgain() {
    if (!here) return;
    if (await permitted(here.handle, true)) {
      here.state = 'on';
      await announceHere(true);
      listen();
    } else V.toast('Wefty wasn\'t allowed to see that folder.', { kind: 'err' });
    draw();
  }

  async function stopHere() {
    if (!here) return;
    await announceHere(false);
    here = null;
    await V.db.meta(SHARE, null).catch(() => {});
    draw();
  }

  async function walkHere(parts) {
    if (!Array.isArray(parts) || parts.length > 40) throw refusal('That folder is too deep to open from here.');
    let dir = here.handle;
    for (const part of parts) dir = await dir.getDirectoryHandle(checked(part));
    return dir;
  }

  function checked(name) {
    if (typeof name !== 'string' || !name || name.startsWith('.') || /[\\/]/.test(name) || name.length > 255) {
      throw refusal('That isn\'t there any more.');
    }
    return name;
  }

  async function listHere(parts, page) {
    const dir = await walkHere(parts);
    const all = [];
    for await (const [name, handle] of dir.entries()) {
      if (!name || name.startsWith('.')) continue;
      all.push({ n: name, d: handle.kind === 'directory' ? 1 : 0, h: handle });
      if (all.length >= 10000) break;
    }
    all.sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n, undefined, { sensitivity: 'base' }));
    const start = Math.max(0, Number(page) | 0) * PAGE;
    const entries = [];
    for (const item of all.slice(start, start + PAGE)) {
      const out = { n: item.n, d: item.d, s: 0, m: 0 };
      if (!item.d) {
        try {
          const file = await item.h.getFile();
          out.s = file.size;
          out.m = Math.floor(file.lastModified / 1000);
        } catch (error) { continue; }
      }
      entries.push(out);
    }
    return { root: 'shared', path: parts, entries, total: all.length, page: start / PAGE, more: start + PAGE < all.length };
  }

  async function smallPicture(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
    const canvas = V.h('canvas', { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) });
    const pen = canvas.getContext('2d');
    pen.fillStyle = '#ffffff';
    pen.fillRect(0, 0, canvas.width, canvas.height);
    pen.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.62);
  }

  async function thumbsHere(parts, names) {
    const dir = await walkHere(parts);
    const out = {};
    for (const name of (Array.isArray(names) ? names : []).slice(0, 24)) {
      try {
        const file = await (await dir.getFileHandle(checked(name))).getFile();
        if (THUMBABLE.test(name) && file.size < 15 * 1024 * 1024) out[name] = await smallPicture(file);
      } catch (error) { /* not a picture this browser can read: its icon shows */ }
    }
    return { thumbs: out };
  }

  /* Answers one request from the PC, from the shared folder (read only, like the PC's own answers). */
  async function serve(row) {
    const request = files(row);
    if (serving.has(row.id)) return;
    serving.add(row.id);
    busyCount++;
    let reply;
    let stored = '';
    try {
      if (Date.now() - Date.parse(row.created_at || 0) > STALE) throw refusal('That request waited too long. Try again.');
      if (request.root !== 'shared') throw refusal('That folder isn\'t shared from the phone any more.');
      const path = Array.isArray(request.path) ? request.path : [];
      if (request.op === 'list') reply = { state: 'done', result: await listHere(path, request.page || 0) };
      else if (request.op === 'thumbs') reply = { state: 'done', result: await thumbsHere(path, request.names) };
      else if (request.op === 'get') {
        if (!path.length) throw refusal('That\'s a folder: open it instead.');
        const dir = await walkHere(path.slice(0, -1));
        const file = await (await dir.getFileHandle(checked(path[path.length - 1]))).getFile();
        if (file.size > MAX) throw refusal(`${file.name} is ${Math.round(file.size / 1048576)} MB, over the ${V.FILE_MOST_WORDS} Wefty takes.`);
        await V.cloud.sb.from('transfers').update({ extra: { ...(row.extra || {}), files: { ...request, state: 'working', size: file.size } } })
          .eq('id', row.id).is('received_at', null);
        stored = `${V.data.user.id}/phonefiles/${row.id}/${V.storageName(file.name)}`;
        await V.cloud.upload(stored, file, { mime: file.type || 'application/octet-stream' });
        reply = { state: 'done', result: { file: { path: stored, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' } } };
      } else throw refusal('Wefty on the phone doesn\'t know that yet: it updates by itself soon.');
      if (here) here.looked = Date.now();
    } catch (error) {
      reply = error.refused || error.full ? { state: 'refused', error: error.message }
        : { state: 'error', error: error.name === 'NotFoundError' || error.name === 'TypeError' ? 'That isn\'t there any more.'
          : error.name === 'NotAllowedError' ? 'Wefty on the phone needs its permission again: open Files there.'
            : 'The phone couldn\'t read that.' };
    }
    try {
      const { data } = await V.cloud.sb.from('transfers').update({ extra: { ...(row.extra || {}), files: { ...request, ...reply } },
        received_at: new Date().toISOString() }).eq('id', row.id).is('received_at', null).select('id');
      if (stored && !(data && data.length)) V.cloud.remove([stored]).catch(() => {});  // the PC gave up meanwhile
    } catch (error) {
      console.warn('Vault files: answer not sent', error);
    } finally {
      busyCount--;
      setTimeout(() => serving.delete(row.id), 60000);
    }
    if (source === 'here') draw();
  }

  /* ---------------------------------------------------------------- Vault Drive */

  const driveInfo = (t) => (t.extra && typeof t.extra.drive === 'object' && t.extra.drive) || {};
  const driveRows = () => [...V.data.transfers.values()].filter((t) => !t.deleted && t.to_device === 'drive' && !t._purge);
  const inFolder = (folder) => driveRows().filter((t) => String(driveInfo(t).folder || '') === folder);
  const isDir = (t) => !!driveInfo(t).dir;
  const joined = (folder, name) => (folder ? folder + '/' + name : name);
  const pathOf = (t) => joined(String(driveInfo(t).folder || ''), t.name);  // a folder's own place ('School/Bio')
  const thumbOfRow = (t) => (t && t.extra && typeof t.extra.thumb === 'string' ? t.extra.thumb : '');
  const THUMB_NAME = () => (V.send && V.send.THUMB_NAME) || '_thumb.jpg';  // (js/send.js's: a preview beside its file)
  const ending = (name) => ((/\.([a-z0-9]{1,10})$/i.exec(String(name || '')) || [])[1] || '').toLowerCase();

  /* What a browser can show big: 'picture', 'video' or '' (an icon). HEIC only on an iPhone or iPad (Safari shows it). */
  function mediaKind(t) {
    if (!t || isDir(t) || !t.path) return '';
    const mime = String(t.mime || '').toLowerCase();
    const name = t.name || '';
    if (/^video\//.test(mime) || VIDEO.test(name)) return 'video';
    if (SHOWN_PICTURE.test(name) || /^image\/(jpeg|png|gif|webp|bmp|avif)$/.test(mime)) return 'picture';
    if (V.deviceKind.ios && (APPLE_PICTURE.test(name) || /^image\/hei[cf]/.test(mime))) return 'picture';
    return '';
  }

  /* A file's media type for a share or a File: the exact one Chrome on Android wants where the name says, else its own. */
  const typeOf = (t) => SHARE_TYPES[ending(t.name)] || (t.mime && t.mime !== 'application/octet-stream' ? t.mime : '')
    || 'application/octet-stream';

  /* Everything kept in the cloud (Send, Drive and pictures in notes) against the free plan's 1 GB. */
  function used() {
    const sent = [...V.data.transfers.values()].filter((t) => !t.deleted && t.path)
      .reduce((sum, t) => sum + (t.size || 0) + (t.to_device === 'drive' && thumbOfRow(t) ? Number(t.extra.thumb_size) || 0 : 0), 0);
    const pictures = [...V.data.notes.values()].reduce((sum, n) => sum + (n.attachments || []).reduce((s, a) => s + (a.size || 0), 0), 0);
    const chats = V.chat ? V.chat.filesSize() : 0;  // files sent to Claude in chats
    return sent + pictures + chats + [...uploads.values()].reduce((sum, u) => sum + u.size, 0);
  }

  function cleanName(text, folder, ignore) {
    const name = String(text || '').trim().replace(/\s+/g, ' ');
    if (!name || name === '.' || name === '..') throw new Error('Type a name first.');
    if (/[\\/]/.test(name)) throw new Error('A name can\'t have / or \\ in it.');
    if (name.length > 120) throw new Error('That name is too long (120 letters at most).');
    if (inFolder(folder).some((t) => t.id !== ignore && (t.name || '').toLowerCase() === name.toLowerCase())) {
      throw new Error(`There's already something called ${name} here.`);
    }
    return name;
  }

  function freeName(folder, name) {
    const taken = new Set(inFolder(folder).map((t) => (t.name || '').toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ending = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${ending}`.toLowerCase())) return `${stem} (${n})${ending}`;
  }

  const driveRow = (id, fields) => ({ id, kind: 'file', name: '', path: null, size: 0, mime: '', text: '',
    from_device: V.device, to_device: 'drive', received_at: null, deleted: false, created_at: new Date().toISOString(), ...fields });

  async function newFolder() {
    const folder = drive;
    const name = await V.ask('New folder', { placeholder: 'Folder name', ok: 'Make it',
      hint: folder ? `In ${folder.split('/').pop()}` : 'In Wefty Drive' });
    if (name === null) return;
    try {
      const clean = cleanName(name, folder);
      await V.cloud.save('transfers', driveRow(V.uuid(), { kind: 'text', name: clean, extra: { drive: { folder, dir: true } } }));
    } catch (error) { V.problem(error); }
  }

  async function addToDrive(list, folder = drive) {
    const picked = [...(list || [])];
    if (!picked.length) return;
    if (!navigator.onLine) return V.toast(OFFLINE, { kind: 'err' });
    for (const file of picked) {
      if (file.size > MAX) { V.toast(V.fileOver(file.name), { kind: 'err', ms: 6000 }); continue; }
      // (1.21: the person's own room as the cloud counts it, V.storage; a cloud that doesn't count: the plan's 1 GB)
      const full = V.storage.before();
      if (full) { V.problem(full); break; }
      if (!V.storage.now() && used() + file.size > FREE_SPACE) { V.toast(FULL, { kind: 'err', ms: 8000 }); break; }
      const id = V.uuid();
      const dir = `${V.data.user.id}/drive/${id}/`;
      const path = dir + V.storageName(file.name || 'file');
      uploads.set(id, { name: file.name || 'file', size: file.size, share: 0, folder });
      drawUploads();
      // (1.22.3) A picture's or a video's small preview, made here as js/send.js makes Send's, while the file goes up.
      const made = V.send && V.send.preview ? V.send.preview(file).catch(() => null) : Promise.resolve(null);
      try {
        await V.cloud.upload(path, file, { mime: file.type, onProgress: (share) => {
          const going = uploads.get(id);
          if (going) { going.share = share; drawUploads(); }
        } });
        const extra = { drive: { folder } };
        const shot = await made;
        if (shot && shot.blob) {
          try {
            await V.cloud.upload(dir + THUMB_NAME(), shot.blob, { mime: 'image/jpeg' });
            Object.assign(extra, previewExtra(dir + THUMB_NAME(), shot));
            keepFace(dir + THUMB_NAME(), shot.blob);
          } catch (error) { /* the file still goes: its row shows the icon (and a preview is made later) */ }
        }
        await V.cloud.save('transfers', driveRow(id, { name: freeName(folder, (file.name || 'file').slice(0, 300)), path,
          size: file.size, mime: file.type || 'application/octet-stream', extra }));
      } catch (error) {
        V.problem(error);
      } finally {
        uploads.delete(id);
        drawUploads();
      }
    }
  }

  async function renameDrive(t) {
    const folder = String(driveInfo(t).folder || '');
    const name = await V.ask(isDir(t) ? 'Rename folder' : 'Rename file', { value: t.name, ok: 'Rename' });
    if (name === null || name.trim() === t.name) return;
    try {
      const clean = cleanName(name, folder, t.id);
      if (isDir(t)) {
        const before = joined(folder, t.name);
        const after = joined(folder, clean);
        for (const inside of driveRows()) {
          const where = String(driveInfo(inside).folder || '');
          if (where === before || where.startsWith(before + '/')) {
            await V.cloud.save('transfers', { ...inside, extra: { ...inside.extra, drive: { ...driveInfo(inside), folder: after + where.slice(before.length) } } });
          }
        }
        if (drive === before || drive.startsWith(before + '/')) drive = after + drive.slice(before.length);
      }
      await V.cloud.save('transfers', { ...V.data.transfers.get(t.id), name: clean });
    } catch (error) { V.problem(error); }
  }

  /* What's inside a folder of Wefty Drive, all the way down (its folders too). */
  function insideOf(t) {
    const inside = pathOf(t);
    return driveRows().filter((r) => { const w = String(driveInfo(r).folder || ''); return w === inside || w.startsWith(inside + '/'); });
  }

  async function deleteDrive(t) {
    if (isDir(t)) {
      const count = insideOf(t).filter((r) => !isDir(r)).length;
      const sure = await V.confirm(`Delete ${t.name}?`, count ? `The ${count} file${count > 1 ? 's' : ''} in it go too, from both devices.`
        : 'It\'s empty.', { ok: 'Delete', danger: true });
      if (!sure) return;
    } else {
      const sure = await V.confirm(`Delete ${t.name}?`, 'It goes from Wefty Drive on both devices. Copies already saved stay.',
        { ok: 'Delete', danger: true });
      if (!sure) return;
    }
    await removeDrive([t]);
  }

  /* Rows of Wefty Drive gone for good (a folder with everything in it), with their files and previews. Asked first. */
  async function removeDrive(list) {
    const rows = [];
    const seen = new Set();
    for (const t of list) {
      for (const r of [t, ...(isDir(t) ? insideOf(t) : [])]) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      if (isDir(t) && (drive === pathOf(t) || drive.startsWith(pathOf(t) + '/'))) drive = String(driveInfo(t).folder || '');
    }
    const paths = rows.flatMap((r) => [r.path, thumbOfRow(r)]).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) V.cloud.remove(paths.slice(i, i + 100)).catch(() => {});
    for (const r of rows) await V.cloud.save('transfers', { ...(V.data.transfers.get(r.id) || r), deleted: true });
    return rows;
  }

  /* A file the other device brought up (pcfiles/ or phonefiles/), kept in Vault Drive's top folder. */
  async function copyToDrive(file) {
    const full = V.storage.before();
    if (full) throw full;
    if (!V.storage.now() && used() + (file.size || 0) > FREE_SPACE) throw new Error(FULL);
    const id = V.uuid();
    const path = `${V.data.user.id}/drive/${id}/${V.storageName(file.name)}`;
    const { error } = await V.cloud.sb.storage.from('vault').copy(file.path, path);
    if (error) throw error;
    await V.cloud.save('transfers', driveRow(id, { name: freeName('', file.name), path, size: file.size || 0,
      mime: file.mime || 'application/octet-stream', extra: { drive: { folder: '' } } }));
  }

  /* ---------------------------------------------------------------- opening, saving, sharing */

  function target(host) {
    return { to: host.device, host: host.id };
  }

  function placeKey(host, rootId, path, entry) {
    return [host.id, rootId, ...path, entry.n, entry.m, entry.s].join('\u0001');
  }

  async function bringUp(where, entry) {
    const key = placeKey(where.host, where.root, where.path, entry);
    const known = fetched.get(key);
    if (known && known.until > Date.now()) return known.file;
    const result = await ask('get', { root: where.root, path: [...where.path, entry.n] }, target(where.host));
    if (!result.file) throw new Error('Nothing came back. Try again.');
    fetched.set(key, { file: result.file, until: Date.now() + 50 * 60000 });
    return result.file;
  }

  function saveLink(url, name) {
    const a = V.h('a', { href: url, download: name || 'file', rel: 'noopener' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  /* The sheet for one file: what it is, and what can be done with it. `get()` brings the file to the cloud (from
     the other device, or Drive's own copy); after a long wait the phone may need one more tap to open or share
     it (a browser only opens things straight after a tap). */
  function fileSheet(options) {
    const sheet = V.sheet({ title: options.name, wide: !!options.media, content: [] });
    fillSheet(sheet, options);
    return sheet;
  }

  /* `sheet` filled for one file (again for the next one, when the big view steps on: 1.22.3). `media`: the big view of
     a picture or a video (Wefty Drive's), in place of the small one. */
  function fillSheet(sheet, { name, size, mtime, thumb, cloudOnly, from, get, extra = [], start, media = null }) {
    const status = V.h('div.files-status', { role: 'status' });
    const ready = new Map();  // action -> the file, when it's ready but needs another tap
    let busy = false;
    const say = (text, kind) => V.clear(status, text ? [kind === 'busy' ? V.h('div.spinner') : null,
      V.h('span' + (kind === 'err' ? '.error-text' : ''), { text })] : []);
    const big = size > MAX;
    const buttons = [];
    const act = (label, icon, job, kind, plain) => {
      const button = V.button(label, { icon, kind, disabled: big && !plain, onClick: async () => {
        if (busy) return;
        busy = true;
        for (const b of buttons) b.disabled = true;
        try {
          let file = ready.get(job);
          if (!file && !plain) {
            say(from ? `Getting ${name} from ${from}...` : `Getting ${name}...`, 'busy');
            file = await get();
          }
          ready.delete(job);
          say('');
          const again = await job(file);
          if (again) { ready.set(job, file); say(again); button.querySelector('span:last-child').textContent = label + ' now'; }
        } catch (error) {
          if (error.name !== 'AbortError') say(error.message || String(error), 'err');
        } finally {
          busy = false;
          for (const b of buttons) b.disabled = big && !b.dataset.plain;
        }
      } });
      if (plain) button.dataset.plain = '1';
      button.dataset.action = label;
      buttons.push(button);
      return button;
    };
    const actions = [];
    if (V.desktop) {
      actions.push(act('Save to Downloads', 'download', async (file) => {
        const url = await V.cloud.link(file.path);
        const answer = await V.pc.call('saveFile', { url, name: file.name || name });
        V.clear(status, V.h('span', { text: answer.folder === 'Vault' || !answer.folder ? 'Saved in Downloads\\Vault' : `Saved in ${answer.folder}` }),
          V.button('Open', { kind: 'quiet', icon: 'open', onClick: () => V.pc.call('openFile', { path: answer.path }).catch(V.problem) }),
          V.button('Show in folder', { kind: 'quiet', icon: 'folder', onClick: () => V.pc.call('showFile', { path: answer.path }).catch(V.problem) }));
      }, 'primary'));
    } else {
      actions.push(act('Open', 'open', async (file) => {
        const url = await V.cloud.link(file.path);
        const opened = window.open(url, '_blank');
        if (!opened) return 'It\'s ready: tap Open now.';
        opened.opener = null;
      }, 'primary'));
      actions.push(act('Save to phone', 'download', async (file) => {
        saveLink(await V.cloud.link(file.path, { download: file.name || name }), file.name || name);
        V.toast(`Saving ${file.name || name} to Downloads`);
      }));
      if (navigator.share && navigator.canShare) {
        actions.push(act('Share', 'share', async (file) => {
          const response = await fetch(await V.cloud.link(file.path));
          const blob = await response.blob();
          const shared = new File([blob], file.name || name, { type: file.mime || blob.type });
          if (!navigator.canShare({ files: [shared] })) throw new Error('This phone can\'t share that kind of file.');
          try {
            await navigator.share({ files: [shared], title: file.name || name });
          } catch (error) {
            if (error.name === 'NotAllowedError') return 'It\'s ready: tap Share now.';
            throw error;
          }
        }));
      }
    }
    for (const [label, icon, job, kind, plain] of extra) actions.push(act(label, icon, job, kind, plain));
    const meta = [size || size === 0 ? V.size(size) : '', mtime ? when(mtime) : '', from ? `On ${from}` : 'In Wefty Drive']
      .filter(Boolean).join(' · ');
    const title = sheet.el.querySelector('.sheet-head h2');
    if (title) title.textContent = name;
    sheet.el.setAttribute('aria-label', name);
    V.clear(sheet.el.querySelector('.sheet-body'),
      media ? [media, V.h('div.files-sheet-name.files-view-name', {}, name.length > 32 ? V.h('strong', { text: name }) : null,
        V.h('span', { text: meta }))]
        : V.h('div.files-sheet-head', {},
          thumb ? V.h('span.files-thumb.big', {}, V.h('img', { src: thumb, alt: '' })) : V.h('span.files-icon.big', {}, V.icon(PICTURE.test(name) ? 'image' : 'file')),
          V.h('div.files-sheet-name', {}, name.length > 32 ? V.h('strong', { text: name }) : null, V.h('span', { text: meta }))),
      big ? V.h('p.hint', { text: `Over ${V.FILE_MOST_WORDS}: too big for Wefty to send. Copy it with a USB cable or Phone Link instead.` }) : null,
      cloudOnly ? V.h('p.hint', {}, V.icon('cloud'), ' Only in OneDrive online: your PC downloads it first, so it takes a little longer.') : null,
      status,
      V.h('div.files-actions', {}, actions));
    const first = start && buttons.find((b) => b.dataset.action === start);
    if (first) requestAnimationFrame(() => first.click());  // picked from the row's menu: it goes straight away
  }

  function remoteSheet(entry, start) {
    const host = currentHost();
    if (!host) return;
    const where = { host, root: browse.root, path: [...browse.path] };
    const who = host.device === 'pc' ? 'your PC' : 'your phone';
    fileSheet({
      name: entry.n, size: entry.s, mtime: entry.m, cloudOnly: !!entry.c, from: who,
      thumb: thumbs.get(placeKey(host, where.root, where.path, entry)),
      get: () => bringUp(where, entry),
      start,
      extra: [['Copy to Wefty Drive', 'cloud', async (file) => {
        await copyToDrive(file);
        V.toast('Copied to Wefty Drive', { action: 'Show', onAction: () => { drive = ''; show('drive'); } });
      }]],
    });
  }

  function driveOptions(t, sheet) {
    return {
      name: t.name, size: t.size, mtime: Date.parse(t.created_at || t._edited || 0) / 1000, thumb: knownFace(t),
      get: async () => ({ path: t.path, name: t.name, size: t.size, mime: t.mime }),  // (up before its row was made)
      extra: [
        ['Rename', 'text', async () => { sheet.close(); await renameDrive(t); }, '', true],
        ['Delete', 'trash', async () => { sheet.close(); await deleteDrive(t); }, 'danger-quiet', true],
      ],
    };
  }

  /* A Wefty Drive file's sheet. A picture or a video (1.22.3) shows big there, with its buttons under it, and the
     folder's other pictures and videos a swipe, an arrow key or the < > buttons away. */
  function driveSheet(t, start) {
    let sheet = null;
    const ref = { close: () => sheet && sheet.close() };
    if (!mediaKind(t)) {
      sheet = fileSheet({ ...driveOptions(t, ref), start });
      return sheet;
    }
    let list = driveItems().filter(mediaKind);
    if (!list.some((each) => each.id === t.id)) list = [t];
    let at = list.findIndex((each) => each.id === t.id);
    const keys = (event) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target.closest && event.target.closest('input, textarea, select, video, [contenteditable]')) return;
      if (document.querySelector('#layers > .menu-layer')) return;
      event.preventDefault();
      show(at + (event.key === 'ArrowRight' ? 1 : -1));
    };
    sheet = V.sheet({ title: t.name, wide: true, content: [], onClose: () => document.removeEventListener('keydown', keys) });
    sheet.el.classList.add('files-view-sheet');
    if (list.length > 1) document.addEventListener('keydown', keys);
    function show(i, first = false) {
      at = (i + list.length) % list.length;
      const item = V.data.transfers.get(list[at].id) || list[at];
      fillSheet(sheet, { ...driveOptions(item, ref), media: viewFrame(item, list.length > 1 ? { at, of: list.length, show } : null),
        start: first ? start : null });
    }
    show(at, true);
    return sheet;
  }

  /* The big view: a picture at full width (its preview first, the whole one once it's here), or a video that plays
     right there. A browser that can't show it says so, and the buttons under it still save it. `steps`: the others in
     the folder ({ at, of, show }). */
  function viewFrame(t, steps) {
    const kind = mediaKind(t);
    const box = V.h('div.send-viewer.files-viewer', { dataset: { kind } });
    const poster = knownFace(t);
    const ratio = t.extra && t.extra.w > 0 && t.extra.h > 0 ? `${t.extra.w} / ${t.extra.h}` : '';
    const none = (words) => {
      if (!box.isConnected) return;
      box.classList.add('none');
      V.clear(box, V.h('span.files-icon.big', {}, V.icon(kind === 'video' ? 'play' : 'image')), V.h('p.hint', { text: words }));
    };
    if (kind === 'video') {
      const video = V.h('video', { controls: true, playsinline: true, preload: 'metadata', poster: poster || null,
        'aria-label': t.name });
      if (ratio) video.style.aspectRatio = ratio;
      video.addEventListener('error', () => none('This browser can\'t play it here. Save it to watch it.'));
      box.append(video);
      V.cloud.link(t.path).then((url) => { if (box.isConnected) video.src = url; }, () => none(OFFLINE));
    } else {
      const img = V.h('img', { alt: t.name || 'Picture', decoding: 'async', draggable: 'false' });
      if (ratio) img.style.aspectRatio = ratio;
      if (poster) img.src = poster;
      else box.append(V.h('div.spinner'));
      box.append(img);
      V.cloud.link(t.path).then((url) => {
        const whole = new Image();
        whole.onload = () => {
          if (!box.isConnected) return;
          img.src = url;
          const spinner = box.querySelector('.spinner');
          if (spinner) spinner.remove();
        };
        whole.onerror = () => { if (!poster) none('This browser can\'t show it here. Save it to look at it.'); };
        whole.src = url;
      }, () => { if (!poster) none(OFFLINE); });
    }
    if (!steps) return box;
    // A finger's swipe across it (not along a video's own controls at its foot) goes to the next or the one before.
    let from = null;
    box.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const edge = box.getBoundingClientRect().bottom - 64;
      from = kind === 'video' && event.clientY > edge ? null : { x: event.clientX, y: event.clientY, at: Date.now() };
    });
    box.addEventListener('pointercancel', () => { from = null; });
    box.addEventListener('pointerup', (event) => {
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      const quick = Date.now() - from.at < 900;
      from = null;
      if (quick && Math.abs(dx) > 48 && Math.abs(dy) < Math.abs(dx) * 0.7) steps.show(steps.at + (dx < 0 ? 1 : -1));
    });
    const go = (by, cls) => V.h('button.viewer-nav.' + cls, { type: 'button', 'aria-label': by > 0 ? 'Next' : 'Previous',
      title: by > 0 ? 'Next (→)' : 'Previous (←)', onclick: () => {
        steps.show(steps.at + by);
        const again = document.querySelector('.files-view-sheet .viewer-nav.' + cls);  // (the keyboard stays on it)
        if (again) again.focus({ preventScroll: true });
      } }, V.icon(by > 0 ? 'next' : 'back'));
    return V.h('div.files-view', {},
      V.h('div.viewer-frame', {}, box, go(-1, 'prev'), go(1, 'next')),
      V.h('p.viewer-count', { text: `${steps.at + 1} of ${steps.of}` }));
  }

  /* What a file's menu (⋮, a long-press or a right-click) offers: the sheet's own actions, started at once. */
  function actionsFor() {
    if (V.desktop) return [['Save to Downloads', 'download']];
    return [['Open', 'open'], ['Save to phone', 'download'], navigator.share && navigator.canShare ? ['Share', 'share'] : null]
      .filter(Boolean);
  }

  /* ---------------------------------------------------------------- touch: hold for the menu */

  /* A finger or the S Pen held still on a row opens its menu (so does a right-click); the tap that ends the hold
     doesn't also open the file. */
  function hold(el, open) {
    let timer = null;
    let from = null;
    let fired = 0;
    const stop = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || event.button > 0) return;
      from = [event.clientX, event.clientY];
      stop();
      timer = setTimeout(() => {
        timer = null;
        fired = Date.now();
        if (navigator.vibrate) navigator.vibrate(12);
        afterTheHold();
        open();
      }, tune.hold);
    });
    el.addEventListener('pointermove', (event) => {
      if (timer && from && Math.hypot(event.clientX - from[0], event.clientY - from[1]) > 10) stop();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, stop);
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      // (a finger's: the browser's long press, never a second source; the hold's timer opens it. 1.19.8. The S Pen's
      // side button is a right-click: at once, as before)
      if (event.pointerType !== 'pen' && (event.pointerType === 'touch'
        || (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents))) return;
      if (Date.now() - fired < 900) return;  // the hold already opened it
      fired = Date.now();
      stop();
      open();
    });
    el.addEventListener('click', (event) => {
      if (Date.now() - fired < 900) { event.preventDefault(); event.stopImmediatePropagation(); fired = 0; }
    }, true);
  }

  /* The finger is still down when the menu opens: when it lifts, the browser may add a mouse press and a tap of its
     own right there (on the menu's backdrop, which would close it at once). Those, and its own long-press menu, are
     swallowed until just after the lift. */
  function afterTheHold() {
    let until = Infinity;
    const block = (event) => { if (Date.now() < until) { event.preventDefault(); event.stopPropagation(); } };
    const kinds = ['mousedown', 'mouseup', 'click', 'contextmenu'];
    const lifted = () => { until = Math.min(until, Date.now() + 450); setTimeout(done, 500); };
    const done = () => {
      for (const kind of kinds) document.removeEventListener(kind, block, true);
      for (const kind of ['pointerup', 'pointercancel', 'touchend']) document.removeEventListener(kind, lifted, true);
    };
    for (const kind of kinds) document.addEventListener(kind, block, true);
    for (const kind of ['pointerup', 'pointercancel', 'touchend']) document.addEventListener(kind, lifted, true);
    setTimeout(done, 15000);  // never left behind
  }

  /* ---------------------------------------------------------------- Wefty Drive: several at once (1.22.3)

     As Notes' Select: the Select button (or Select in a row's menu) turns picking on, and then a tap or a click picks
     or unpicks a row; with a mouse, Ctrl+click picks one more and Shift+click everything from the last one clicked;
     with the keyboard, Space picks the row it's on, Shift+arrows pick on from there, Ctrl+A picks the whole folder,
     Delete deletes (asking first) and Esc stops. A plain click opens, as ever, while nothing is being picked; a finger
     held on a row opens its menu, as ever. The bar at the foot says how many and how big, and saves them (the PC part:
     each into Downloads\Vault; a Chromebook or a browser: one ZIP, or one by one past tune.holdMost; an Android phone:
     a ZIP, and Share in one share sheet; an iPhone or iPad: the share sheet, which has Save to Files and Save Images),
     moves them or deletes them (asking once). A picked folder brings everything in it, its folders kept as folders. */

  const driveItems = () => inFolder(drive).sort((a, b) => (isDir(b) - isDir(a))
    || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const pickedRows = () => driveItems().filter((t) => pick.ids.has(t.id));
  const onPhone = () => !V.desktop && !V.deviceKind.chromebook && !!(V.deviceKind.android || V.deviceKind.ios);
  const saveLabel = () => (V.desktop ? 'Save to Downloads' : !onPhone() ? 'Download'
    : V.deviceKind.ios && V.deviceKind.model === 'iPad' ? 'Save to iPad' : 'Save to phone');
  const sharesFiles = () => !V.desktop && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const what = (files, folders) => [files ? plural(files, 'file') : '', folders ? plural(folders, 'folder') : '']
    .filter(Boolean).join(' and ') || 'nothing';
  const named = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
  const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
  let lastPressed = null;  // the row clicked or tapped last (where a Shift+click's range starts when nothing is picked)

  /* `hold`: the Select button's way (and a row menu's Select), which stays on with nothing picked. On a phone, Back
     stops picking, as in Notes. (Only on a phone: a step back taken just after a download link is followed cancels
     that download, so a Chromebook, with Esc and the X, has no step to take.) */
  function startPicking(hold = false) {
    if (hold) pick.held = true;
    if (pick.on) return;
    pick.on = true;
    pick.anchor = null;
    pick.base = null;
    if (onPhone()) { try { history.pushState({ vault: 'files-select' }, ''); } catch (error) { /* (no Back step) */ } }
  }

  /* Says whether it took picking's step off a phone's history (it's gone a moment later: see `leavePicking`). */
  function stopPicking({ fromHistory = false } = {}) {
    if (pick.job) pick.job.stop();
    if (!pick.on) return false;
    pick.on = false;
    pick.held = false;
    pick.ids.clear();
    pick.anchor = null;
    pick.base = null;
    const back = !fromHistory && onPhone() && !!history.state && history.state.vault === 'files-select';
    if (back) history.back();
    showPicked();
    return back;
  }

  /* Picking stopped, and its step back on a phone taken, before a download link is followed (the step would cancel it). */
  function leavePicking() {
    if (!stopPicking()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); window.removeEventListener('popstate', done); setTimeout(resolve, 0); };
      const timer = setTimeout(done, 600);
      window.addEventListener('popstate', done);
    });
  }

  function toggle(id) {
    startPicking();
    if (pick.ids.has(id)) pick.ids.delete(id);
    else pick.ids.add(id);
    pick.anchor = id;
    pick.base = new Set(pick.ids);
    if (!pick.ids.size && !pick.held) stopPicking();
    else showPicked();
  }

  /* Everything from where the range starts (the last one picked or unpicked, else `from`: the row the keyboard was on,
     or the one clicked last) to `id`, as the list shows them, with what was picked before that range began: so a
     Shift+arrow back the other way unpicks again, as in Explorer. */
  function pickRange(id, from) {
    startPicking();
    const order = driveItems().map((t) => t.id);
    if (!order.includes(id)) return;
    if (!pick.anchor || !order.includes(pick.anchor)) {
      pick.anchor = [from, lastPressed].find((each) => each && order.includes(each)) || id;
      pick.base = new Set(pick.ids);
    }
    const [a, b] = [order.indexOf(pick.anchor), order.indexOf(id)].sort((x, y) => x - y);
    pick.ids = new Set([...(pick.base || []), ...order.slice(a, b + 1)]);
    showPicked();
  }

  function pickAll() {
    startPicking();
    pick.ids = new Set(driveItems().map((t) => t.id));
    pick.anchor = null;
    pick.base = null;
    showPicked();
  }

  function pickNone() {
    pick.ids.clear();
    pick.anchor = null;
    pick.base = null;
    pick.held = true;
    showPicked();
  }

  /* A row's menu's Select (a phone's way in, beside the Select button): picking on, with that row picked. */
  function selectWith(id) {
    startPicking(true);
    pick.ids.add(id);
    pick.anchor = id;
    pick.base = new Set(pick.ids);
    showPicked();
  }

  function selectPressed() {
    if (pick.on) { stopPicking(); return; }
    startPicking(true);
    showPicked();
  }

  /* A tap or a click on a row: picks while picking (or with Ctrl, or a range with Shift), else opens it. */
  function press(event, t) {
    if (event.shiftKey && driveItems().length) { pickRange(t.id, lastPressed); lastPressed = t.id; return; }
    lastPressed = t.id;
    if (pick.on || event.ctrlKey || event.metaKey) { toggle(t.id); return; }
    if (isDir(t)) goDrive(joined(drive, t.name));
    else driveSheet(t);
  }

  /* The rows marked where they are (nothing redrawn, so a finger on one stays on it), the Select button, the bar, and
     the line a screen reader says ("3 picked"). */
  function showPicked() {
    if (!parts || !parts.list || !parts.list.isConnected || source !== 'drive' || !parts.pickBar) return;
    parts.main.classList.toggle('picking', pick.on);
    parts.list.classList.toggle('picking', pick.on);
    for (const row of parts.list.querySelectorAll('.files-row[data-id]')) {
      const on = pick.ids.has(row.dataset.id);
      row.classList.toggle('picked', on);
      const button = row.querySelector('.files-open');
      if (pick.on) button.setAttribute('aria-pressed', String(on));
      else button.removeAttribute('aria-pressed');
    }
    drawSelect();
    drawPickBar();
    const words = !pick.on ? '' : pick.ids.size ? `${pick.ids.size} picked` : 'Picking files: nothing picked yet';
    if (parts.said.textContent !== words) parts.said.textContent = words;
  }

  function drawSelect() {
    const button = parts && parts.select;
    if (!button) return;
    button.setAttribute('aria-pressed', String(pick.on));
    button.setAttribute('aria-label', pick.on ? 'Cancel picking' : 'Select files');
    button.title = pick.on ? 'Stop picking (Esc)' : 'Pick files to save, move or delete together';
    V.clear(button, V.icon(pick.on ? 'x' : 'select'), V.h('span', { text: pick.on ? 'Cancel' : 'Select' }));
  }

  /* The bar at the foot: "3 picked · 12 MB", Pick all or Pick none, an X, what's going on now (with Stop), and the
     actions. Drawn again as picks change; the keyboard stays on the button it was on. */
  function drawPickBar() {
    const bar = parts && parts.pickBar;
    if (!bar) return;
    if (!pick.on) { bar.hidden = true; V.clear(bar); return; }
    const had = bar.contains(document.activeElement) ? document.activeElement.dataset.key : '';
    const rows = pickedRows();
    const { files } = gather(rows);
    const size = files.reduce((sum, f) => sum + (f.t.size || 0), 0);
    const all = driveItems();
    const everything = all.length > 0 && all.every((t) => pick.ids.has(t.id));
    const busy = !!pick.job;
    const act = (icon, label, run, cls = '') => V.h('button.pick-action' + (cls ? '.' + cls : ''), {
      type: 'button', disabled: !rows.length || busy, dataset: { action: label, key: 'act-' + icon },
      onclick: () => { Promise.resolve(run(pickedRows())).catch(V.problem); } }, V.icon(icon), V.h('span', { text: label }));
    bar.hidden = false;
    V.clear(bar,
      V.h('div.pick-top', {},
        V.h('button.icon-btn.quiet', { type: 'button', title: 'Stop picking (Esc)', 'aria-label': 'Stop picking',
          dataset: { key: 'x' }, onclick: () => stopPicking() }, V.icon('x')),
        V.h('span.pick-count', {}, V.h('span', { text: rows.length ? `${rows.length} picked` : 'Pick files' }),
          rows.length ? V.h('span.pick-size', { text: ` · ${V.size(size)}` }) : null),
        all.length ? V.h('button.link-btn.pick-all', { type: 'button', disabled: busy, dataset: { key: 'all' },
          onclick: everything ? pickNone : pickAll, text: everything ? 'Pick none' : 'Pick all' }) : null),
      parts.pickStatus,
      V.h('div.pick-actions', {},
        act('download', saveLabel(), (list) => saveAll(list)),
        onPhone() && V.deviceKind.android && sharesFiles() ? act('share', 'Share', (list) => saveAll(list, { share: true })) : null,
        act('folder-move', 'Move to', movePicked),
        act('trash', 'Delete', deletePicked, 'danger')));
    const again = had && bar.querySelector(`[data-key="${had}"]`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }

  /* What's picked, as files with their places ('Bio/Labs/cells.jpg' for one in a picked folder), and the folders. */
  function gather(rows) {
    const files = [];
    const dirs = [];
    const below = (where) => (drive ? where.slice(drive.length + 1) : where);
    for (const t of rows) {
      if (!isDir(t)) { files.push({ t, rel: t.name || 'file' }); continue; }
      dirs.push(t.name || 'folder');
      for (const r of insideOf(t)) {
        const rel = joined(below(String(driveInfo(r).folder || '')), r.name || 'file');
        if (isDir(r)) dirs.push(rel);
        else files.push({ t: r, rel });
      }
    }
    return { files, dirs };
  }

  // A name every computer takes, for each part of a ZIP's paths (its ending kept when it's cut short).
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  function safePart(name) {
    let clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    if (clean.length > 120) {
      const end = ending(clean);
      clean = clean.slice(0, 120 - (end ? end.length + 1 : 0)).trim() + (end ? '.' + end : '');
    }
    if (!clean) clean = 'file';
    return RESERVED.test(clean) ? '_' + clean : clean;
  }
  /* Each path in a ZIP once (two names that only differ in letters a computer can't take get " (2)"). */
  function zipNamer() {
    const used = new Set();
    return (rel, folder = false) => {
      const parts = rel.split('/').map(safePart);
      let path = parts.join('/');
      if (!folder) {
        for (let n = 2; used.has(path.toLowerCase()); n++) {
          const last = parts[parts.length - 1];
          const dot = last.lastIndexOf('.');
          path = [...parts.slice(0, -1), dot > 0 ? `${last.slice(0, dot)} (${n})${last.slice(dot)}` : `${last} (${n})`].join('/');
        }
      }
      used.add(path.toLowerCase());
      return path;
    };
  }
  const flat = (rel) => rel.split('/').join(' - ');  // a picked folder's file saved on its own: "Bio - Labs - cells.jpg"

  /* -- what's going on now: "Getting 3 of 7...", with a Stop that stops it (a fetch is cut off; a file the PC part is
     saving finishes first). */
  function newJob() {
    const job = { stopped: false, controller: null, waiting: null,
      stop() {
        job.stopped = true;
        if (job.controller) job.controller.abort();
        if (job.waiting) job.waiting(null);
      } };
    job.text = V.h('span');
    job.stopButton = V.button('Stop', { kind: 'quiet', icon: 'stop', onClick: () => job.stop() });
    job.view = V.h('div.files-pick-line', {}, V.h('div.spinner'), job.text, job.stopButton);
    job.note = V.h('p.hint.files-pick-note', { hidden: true });
    pick.job = job;
    drawPickBar();
    return job;
  }

  function progress(job, text, note = '') {
    if (pick.job !== job || !parts || !parts.pickStatus) return;
    job.text.textContent = text;
    job.note.textContent = note;
    job.note.hidden = !note;
    if (!parts.pickStatus.contains(job.view)) V.clear(parts.pickStatus, job.view, job.note);
  }

  /* Ready, waiting for a tap (a browser opens its share sheet only straight after one): `run` goes from the tap itself.
     Resolves with what `run` gave, or null when stopped. */
  function tapFor(job, text, label, run) {
    return new Promise((resolve) => {
      job.waiting = (value) => { job.waiting = null; resolve(value); };
      const button = V.button(label, { kind: 'primary', icon: 'share', onClick: () => {
        if (!job.waiting) return;
        const going = run();
        job.waiting(going);
        if (parts && parts.pickStatus) V.clear(parts.pickStatus, job.view, job.note);
      } });
      button.dataset.ready = '1';
      V.clear(parts.pickStatus, V.h('div.files-pick-line.ready', {}, V.h('span', { text }), button, job.stopButton));
      requestAnimationFrame(() => { if (button.isConnected) button.focus({ preventScroll: true }); });
    });
  }

  const rest = (job, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { job.waiting = null; resolve(); }, ms);
    job.waiting = () => { clearTimeout(timer); job.waiting = null; resolve(); };
  });

  function endJob(job) {
    if (pick.job === job) pick.job = null;
    if (parts && parts.pickStatus) V.clear(parts.pickStatus);
    drawPickBar();
  }

  /* How it went, in one line. Something saved (and not stopped): picking stops, as after Notes' actions. */
  function told(lines, { went = false, kind = '', action = '', onAction = null } = {}) {
    if (went) stopPicking();
    V.toast(lines.filter(Boolean).join(' '), { kind, ms: 8000, action: action || undefined, onAction: onAction || undefined });
  }

  async function bytesOf(t, job) {
    const url = await V.cloud.link(t.path);
    if (job.stopped) throw new Error('Stopped');
    job.controller = new AbortController();
    try {
      const response = await fetch(url, { signal: job.controller.signal });
      if (!response.ok) throw new Error(`The cloud said ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } finally {
      job.controller = null;
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    saveLink(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  const inDownloads = (name) => (V.deviceKind.chromebook ? `Saved ${name} in Downloads: find it in the Files app.`
    : V.deviceKind.ios ? `${name}: find it in the Files app, in Downloads.`
      : V.deviceKind.android ? `${name} is in your Downloads.` : `Downloaded ${name}.`);

  /* The bar's save (or, on an Android phone, Share): each device its own way. */
  async function saveAll(rows, { share = false } = {}) {
    if (pick.job || !rows.length) return;
    const { files, dirs } = gather(rows);
    const big = files.filter((f) => (f.t.size || 0) > MAX || !f.t.path);
    const list = files.filter((f) => !big.includes(f));
    const bigWords = big.length ? `${big.length === 1 ? `${big[0].t.name} is` : `${plural(big.length, 'file')} are`} over `
      + `${V.FILE_MOST_WORDS}, too big for Wefty to send: ${big.length === 1 ? 'it stays' : 'they stay'} in Wefty Drive.` : '';
    if (!list.length) return V.toast(bigWords || 'Nothing to save: the folders are empty.', { kind: big.length ? 'err' : '', ms: 7000 });
    if (V.desktop) return toPc(list, bigWords);
    if (share) return shareAll(list, bigWords, 'Share');
    if (list.length === 1) return saveOne(list[0], bigWords);  // (one file alone downloads as it always has)
    const total = list.reduce((sum, f) => sum + (f.t.size || 0), 0);
    const download = () => (total <= tune.holdMost ? zipDown(list, dirs, bigWords) : oneByOne(list, bigWords));
    if (V.deviceKind.ios && sharesFiles()) return shareAll(list, bigWords, saveLabel(), download);
    return download();
  }

  async function saveOne(f, bigWords) {
    const name = f.t.name || 'file';
    let url;
    try {
      url = await V.cloud.link(f.t.path, { download: name });
    } catch (error) {
      V.problem(error);
      return;
    }
    await leavePicking();
    saveLink(url, name);
    told([`Saving ${name} to Downloads.`, bigWords]);
  }

  /* The PC: each file saved by the PC part into Downloads\Vault (a picked folder's files with its name in front). */
  async function toPc(list, bigWords) {
    const job = newJob();
    const failed = [];
    let saved = 0;
    let last = null;
    try {
      for (let i = 0; i < list.length && !job.stopped; i++) {
        progress(job, `Saving ${i + 1} of ${list.length}…`);
        const f = list[i];
        try {
          const url = await V.cloud.link(f.t.path);
          if (job.stopped) break;
          last = await V.pc.call('saveFile', { url, name: flat(f.rel) });
          saved += 1;
        } catch (error) {
          console.warn('Wefty Drive: not saved', error);
          failed.push(f.t.name);
        }
      }
    } finally {
      endJob(job);
    }
    const folder = last && last.folder && last.folder !== 'Vault' ? last.folder : 'Downloads\\Vault';
    const show = last && last.path ? { action: 'Show in folder', onAction: () => V.pc.call('showFile', { path: last.path }).catch(V.problem) } : {};
    if (job.stopped) return told([`Stopped. Saved ${saved} of ${list.length} in ${folder}.`], show);
    if (!saved) return told([`Couldn't save ${list.length === 1 ? 'it' : 'them'}. Check the internet and try again.`, bigWords], { kind: 'err' });
    told([list.length === 1 ? `Saved ${list[0].t.name} in ${folder}.` : `Saved ${plural(saved, 'file')} in ${folder}.`,
      failed.length ? `Couldn't save ${named(failed)}.` : '', bigWords], { went: true, ...show });
  }

  /* A Chromebook, a browser, an Android phone: one ZIP ("Wefty Drive 2026-11-09.zip", folders kept as folders). */
  async function zipDown(list, dirs, bigWords) {
    const job = newJob();
    const failed = [];
    const entries = [];
    const name = `Wefty Drive ${V.dateText(new Date())}.zip`;
    const place = zipNamer();
    let made = false;
    try {
      for (const dir of dirs) entries.push({ name: place(dir, true) + '/', data: new Uint8Array(0) });
      for (let i = 0; i < list.length && !job.stopped; i++) {
        progress(job, `Getting ${i + 1} of ${list.length}…`);
        try {
          const data = await bytesOf(list[i].t, job);
          entries.push({ name: place(list[i].rel), data });
        } catch (error) {
          if (!job.stopped) { console.warn('Wefty Drive: not fetched', error); failed.push(list[i].t.name); }
        }
      }
      if (!job.stopped && failed.length < list.length) {
        progress(job, 'Making the ZIP…');
        await new Promise((resolve) => setTimeout(resolve, 30));  // (the line shows before the work)
        downloadBlob(V.backup.zip(entries), name);
        made = true;
      }
    } finally {
      endJob(job);
    }
    if (job.stopped) return told(['Stopped. Nothing was downloaded.']);
    if (!made) return told([`Couldn't get ${list.length === 1 ? 'it' : 'them'}. Check the internet and try again.`, bigWords], { kind: 'err' });
    told([inDownloads(name), failed.length ? `Couldn't get ${named(failed)}: ${failed.length === 1 ? 'it isn\'t' : 'they aren\'t'} in it.` : '',
      bigWords], { went: true });
  }

  /* Too much for one ZIP: each file downloads by itself, held here only while it's handed over (never more than
     tune.holdMost at once). One bigger than that goes straight from the cloud by its own link, first: a link followed
     just before picking's step back on a phone would be cancelled by it. */
  async function oneByOne(list, bigWords) {
    const job = newJob();
    const failed = [];
    let done = 0;
    let held = 0;
    const note = `That's over ${mb(tune.holdMost)}, too much for one ZIP, so they download one at a time. If your browser `
      + 'asks to allow several downloads, tap Allow.';
    const order = [...list].sort((a, b) => ((b.t.size || 0) > tune.holdMost) - ((a.t.size || 0) > tune.holdMost));
    try {
      for (let i = 0; i < order.length && !job.stopped; i++) {
        progress(job, `Downloading ${i + 1} of ${order.length}…`, note);
        const f = order[i];
        const size = f.t.size || 0;
        try {
          if (size > tune.holdMost) {
            const url = await V.cloud.link(f.t.path, { download: flat(f.rel) });
            if (job.stopped) break;
            saveLink(url, flat(f.rel));
          } else {
            while (held && held + size > tune.holdMost && !job.stopped) await rest(job, 250);  // (the last ones let go first)
            const data = await bytesOf(f.t, job);
            if (job.stopped) break;
            const url = URL.createObjectURL(new Blob([data], { type: typeOf(f.t) }));
            saveLink(url, flat(f.rel));
            held += size;
            setTimeout(() => { URL.revokeObjectURL(url); held -= size; }, tune.letGo);
          }
          done += 1;
        } catch (error) {
          if (!job.stopped) failed.push(f.t.name);
        }
        if (i < order.length - 1 && !job.stopped) await rest(job, tune.gap);
      }
      // (A link just followed: a moment for its download to start before picking's step back on a phone.)
      if (!job.stopped && order.length && (order[order.length - 1].t.size || 0) > tune.holdMost && onPhone()) await rest(job, 4000);
    } finally {
      endJob(job);
    }
    const where = V.deviceKind.chromebook ? ': find them in the Files app, in Downloads' : ' to Downloads';
    if (job.stopped) return told([`Stopped after ${done} of ${list.length}.`]);
    told([`Downloaded ${plural(done, 'file')}${where}.`, failed.length ? `Couldn't get ${named(failed)}.` : '', bigWords],
      { went: done > 0, kind: done ? '' : 'err' });
  }

  /* The phone's share sheet with the files themselves (an iPhone's "Save to phone" too: it has Save to Files, and Save
     Images for photos). Android shares only the kinds Chrome takes, and one share at most; an iPhone shares in goes of
     up to tune.holdMost, a tap each. */
  async function shareAll(list, bigWords, label, otherwise = null) {
    const android = !!V.deviceKind.android;
    const can = list.filter((f) => (!android || SHARE_TYPES[ending(f.t.name)]) && (f.t.size || 0) <= tune.holdMost);
    const left = list.filter((f) => !can.includes(f));
    const leftWords = left.length ? `${named(left.map((f) => f.t.name))} can't be ${android ? 'shared from a phone\'s browser'
      : 'shared from here'}: tap ${left.length === 1 ? 'it' : 'each one'} and use ${saveLabel()}.` : '';
    if (!can.length) return V.toast(leftWords || 'Nothing to share.', { kind: 'err', ms: 8000 });
    const goes = [];
    let go = [];
    let size = 0;
    for (const f of can) {
      if (go.length && size + (f.t.size || 0) > tune.holdMost) { goes.push(go); go = []; size = 0; }
      go.push(f);
      size += f.t.size || 0;
    }
    goes.push(go);
    if (android && goes.length > 1) {
      return V.toast(`That's over ${mb(tune.holdMost)}, too much to share at once. Pick fewer, or use ${saveLabel()}.`, { kind: 'err', ms: 8000 });
    }
    const job = newJob();
    const failed = [];
    let shared = 0;
    let fetched = 0;
    let ended = '';
    const ios = !android && V.deviceKind.ios;
    try {
      for (let g = 0; g < goes.length && !job.stopped && !ended; g++) {
        const ready = [];
        for (const f of goes[g]) {
          if (job.stopped) break;
          progress(job, `Getting ${++fetched} of ${can.length}…`);
          try {
            ready.push(new File([await bytesOf(f.t, job)], f.t.name || 'file', { type: typeOf(f.t) }));
          } catch (error) {
            if (!job.stopped) failed.push(f.t.name);
          }
        }
        if (job.stopped || !ready.length) break;
        let fits = false;
        try { fits = navigator.canShare({ files: ready }); } catch (error) { fits = false; }
        if (!fits) { ended = 'cant'; break; }
        const open = () => navigator.share({ files: ready, title: ready.length === 1 ? ready[0].name : `${ready.length} files from Wefty Drive` })
          .then(() => 'shared', (error) => (error && error.name === 'AbortError' ? 'cancelled' : error && error.name === 'NotAllowedError' ? 'again' : 'failed'));
        // The first one may still be in time for the tap that asked; then (and for each next go) a tap of its own.
        let how = g === 0 ? await open() : 'again';
        if (how === 'again') {
          const words = (goes.length > 1 ? `Ready: ${g + 1} of ${goes.length}. Tap ${label}.` : `Ready: tap ${label}.`)
            + (ios && label !== 'Share' ? ' Then pick Save to Files, or Save Images for photos.' : '');
          const going = await tapFor(job, words, label, open);
          how = going === null ? 'stopped' : await going;
        }
        if (how === 'shared') shared += ready.length;
        else if (how === 'cancelled' || how === 'stopped') ended = how;
        else { ended = 'failed'; break; }
      }
    } finally {
      endJob(job);
    }
    if (job.stopped || ended === 'stopped') return told([shared ? `Stopped after ${plural(shared, 'file')}.` : 'Stopped.']);
    if (ended === 'cant' && otherwise && !shared) return otherwise();  // (an iPhone's share sheet that won't take them: they download)
    if (ended === 'cant') return told([`This ${android ? 'phone' : 'browser'} can't share these. Use ${saveLabel()} instead.`], { kind: 'err' });
    if (ended === 'failed') return told(['The share sheet didn\'t open. Try again.'], { kind: 'err' });
    const extra = [failed.length ? `Couldn't get ${named(failed)}.` : '', leftWords, bigWords].filter(Boolean);
    if (extra.length) told(extra, { went: shared > 0, kind: shared ? '' : 'err' });
    else if (shared) stopPicking();
  }

  /* -- deleting and moving what's picked */

  async function deletePicked(rows) {
    if (pick.job || !rows.length) return;
    const folders = rows.filter(isDir);
    const files = rows.length - folders.length;
    const inside = folders.reduce((n, t) => n + insideOf(t).filter((r) => !isDir(r)).length, 0);
    const text = (inside ? `The ${plural(inside, 'file')} in ${folders.length > 1 ? 'those folders' : 'that folder'} go too. ` : '')
      + `${rows.length === 1 && !inside ? 'It goes' : 'They go'} from Wefty Drive on both devices. Copies already saved stay.`;
    if (!(await V.confirm(`Delete ${what(files, folders.length)}?`, text, { ok: 'Delete', danger: true }))) return;
    stopPicking();
    await removeDrive(rows);
    V.toast(`Deleted ${what(files, folders.length)}`);
  }

  function freeIn(taken, name) {
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const end = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) if (!taken.has(`${stem} (${n})${end}`.toLowerCase())) return `${stem} (${n})${end}`;
  }

  /* Into another folder of Wefty Drive (or its top): a folder takes everything in it along. A name already there gets
     " (2)", as an upload does. */
  async function movePicked(rows) {
    if (pick.job || !rows.length) return;
    const to = await chooseFolder(rows);
    if (to === null) return;
    stopPicking();
    const taken = new Set(inFolder(to).map((t) => (t.name || '').toLowerCase()));
    let files = 0;
    let folders = 0;
    for (const t of rows) {
      const now = V.data.transfers.get(t.id);
      if (!now || now.deleted || String(driveInfo(now).folder || '') === to) continue;
      const name = freeIn(taken, now.name || 'file');
      taken.add(name.toLowerCase());
      if (isDir(now)) {
        const before = pathOf(now);
        const after = joined(to, name);
        for (const inside of insideOf(now)) {
          const where = String(driveInfo(inside).folder || '');
          await V.cloud.save('transfers', { ...inside, extra: { ...inside.extra, drive: { ...driveInfo(inside), folder: after + where.slice(before.length) } } });
        }
        folders += 1;
      } else files += 1;
      await V.cloud.save('transfers', { ...now, name, extra: { ...now.extra, drive: { ...driveInfo(now), folder: to } } });
    }
    const place = to ? to.split('/').pop() : 'Wefty Drive';
    if (files || folders) V.toast(`Moved ${what(files, folders)} to ${place}`, { action: 'Open', onAction: () => goDrive(to) });
  }

  /* Where to: every folder of Wefty Drive but this one and the picked ones (and what's in them). Resolves with its
     place ('' for the top), or null. */
  function chooseFolder(rows) {
    return new Promise((resolve) => {
      const away = rows.filter(isDir).map(pathOf);
      const inPicked = (place) => away.some((p) => place === p || place.startsWith(p + '/'));
      const places = ['', ...driveRows().filter(isDir).map(pathOf).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))]
        .filter((place) => place !== drive && !inPicked(place));
      if (!places.length) {
        V.toast('Make a folder first (New folder), then move things into it.', { ms: 5000 });
        resolve(null);
        return;
      }
      let answer = null;
      let sheet = null;
      const folders = rows.filter(isDir).length;
      sheet = V.sheet({
        title: `Move ${what(rows.length - folders, folders)} to`,
        content: [V.h('div.files-move-list', {}, places.map((place) => V.h('button.files-move-to', { type: 'button',
          dataset: { place }, onclick: () => { answer = place; sheet.close(); } },
        V.h('span.files-icon.dir', {}, V.icon(place ? 'folder' : 'cloud')),
        V.h('span.files-move-text', {}, V.h('span.files-move-name', { text: place ? place.split('/').pop() : 'Wefty Drive' }),
          place.includes('/') ? V.h('span.files-move-where', { text: place.split('/').slice(0, -1).join(' › ') }) : null))))],
        actions: [{ label: 'Cancel' }],
        onClose: () => resolve(answer),
      });
    });
  }

  /* -- the keyboard in the list: arrows go along the rows (Shift: picking on from there), Space picks */

  function columns() {
    const grid = getComputedStyle(parts.list).gridTemplateColumns || '';
    return Math.max(1, grid.split(' ').filter(Boolean).length);
  }

  function listKeys(event) {
    const button = event.target && event.target.closest ? event.target.closest('.files-open') : null;
    const row = button && button.closest('.files-row[data-id]');
    if (!row || !parts.list.contains(row) || event.altKey) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const across = parts.list.classList.contains('grid') ? columns() : 1;
    const moves = { ArrowDown: across, ArrowUp: -across, Home: -Infinity, End: Infinity };
    if (across > 1) Object.assign(moves, { ArrowRight: 1, ArrowLeft: -1 });
    if (event.key in moves && !ctrl) {
      event.preventDefault();
      const all = [...parts.list.querySelectorAll('.files-row[data-id] .files-open')];
      const next = all[Math.max(0, Math.min(all.length - 1, all.indexOf(button) + moves[event.key]))];
      if (!next) return;
      next.focus();
      if (event.shiftKey) pickRange(next.closest('.files-row').dataset.id, row.dataset.id);
      return;
    }
    if (event.key === ' ' && !ctrl) {
      event.preventDefault();  // (Space picks; Enter opens, or picks while picking)
      lastPressed = row.dataset.id;
      toggle(row.dataset.id);
    }
  }

  /* -- previews: a picture's or a video's small picture on its row (1.22.3)

     Made where the file is uploaded (js/send.js's own way, as Send's), kept beside it in the cloud at
     <id>/_thumb.jpg with extra.thumb (+ thumb_size, w, h, seconds), so every device shows it. A file put in Wefty Drive
     before (or by an older Wefty) gets one made here once its row is on the screen, if it isn't big (tune.lazyPicture,
     tune.lazyVideo): a picture read whole, a video only as far as its first frame. That one is shared too, the same way;
     if it can't be, it's kept here until Wefty closes. Anything that can't be shown keeps its icon. */

  function previewExtra(path, shot) {
    return { thumb: path, thumb_size: shot.blob.size, w: shot.w || 0, h: shot.h || 0, ...(shot.seconds ? { seconds: shot.seconds } : {}) };
  }

  function keepFace(path, blob) {
    if (typeof faces.get(path) !== 'string') faces.set(path, URL.createObjectURL(blob));
    V.db.put('files', { key: path, blob, at: Date.now() }).catch(() => {});
  }

  /* A row's preview's address, if it's here already (never waits). */
  function knownFace(t) {
    if (madeHere.has(t.id)) return madeHere.get(t.id);
    const known = faces.get(thumbOfRow(t));
    return typeof known === 'string' ? known : null;
  }

  /* Its address, a promise of it, or null. */
  function faceOf(t) {
    const now = knownFace(t);
    if (now) return now;
    const path = thumbOfRow(t);
    if (!path) return null;
    if (!faces.has(path)) {
      faces.set(path, V.cloud.blob(path).then((blob) => {
        const url = URL.createObjectURL(blob);
        faces.set(path, url);
        return url;
      }, () => {
        faces.set(path, null);
        setTimeout(() => { if (faces.get(path) === null) faces.delete(path); }, 60000);  // (offline: tried again later)
        return null;
      }));
    }
    return faces.get(path);
  }

  function driveFace(t) {
    const dir = isDir(t);
    const kind = dir ? '' : mediaKind(t);
    const video = kind === 'video' || /^video\//.test(t.mime || '');
    const icon = () => V.h('span.files-icon' + (dir ? '.dir' : ''), { dataset: { face: t.id } },
      V.icon(dir ? 'folder' : video ? 'play' : kind || PICTURE.test(t.name || '') ? 'image' : 'file'));
    if (dir) return icon();
    const picture = (url) => {
      const box = V.h('span.files-thumb' + (video ? '.video' : ''), { dataset: { face: t.id } });
      box.append(V.h('img', { src: url, alt: '', decoding: 'async', draggable: 'false',
        onerror: () => { if (box.isConnected) box.replaceWith(icon()); } }));
      if (video) box.append(V.h('span.files-play', { 'aria-hidden': 'true' }, V.icon('play')));
      return box;
    };
    const got = faceOf(t);
    if (typeof got === 'string') return picture(got);
    const el = icon();
    if (got && got.then) got.then((url) => { if (url && el.isConnected) el.replaceWith(picture(url)); });
    else if (lazyWanted(t, kind)) watchFace(el);
    return el;
  }

  function lazyWanted(t, kind) {
    if (!kind || !t.path || thumbOfRow(t) || madeHere.has(t.id) || lazy.failed.has(t.id + ':' + t.size)) return false;
    if (navigator.connection && navigator.connection.saveData) return false;  // (Data Saver: icons only)
    return (t.size || 0) <= Math.min(MAX, kind === 'video' ? tune.lazyVideo : tune.lazyPicture);
  }

  function watchFace(el) {
    if (typeof IntersectionObserver !== 'function') return;
    if (!lazy.observer) {
      lazy.observer = new IntersectionObserver((seen) => {
        for (const entry of seen) {
          if (!entry.isIntersecting) continue;
          lazy.observer.unobserve(entry.target);
          const id = entry.target.dataset.face;
          if (id && !lazy.queue.includes(id)) lazy.queue.push(id);
        }
        pump();
      }, { rootMargin: '160px 0px' });
    }
    lazy.observer.observe(el);
  }

  const faceEl = (id) => (parts && parts.list ? parts.list.querySelector(`[data-face="${CSS.escape(id)}"]`) : null);

  /* One at a time (a phone's memory), each only while its row is still on the screen (or near it). */
  async function pump() {
    if (lazy.running) return;
    lazy.running = true;
    try {
      while (lazy.queue.length) {
        const id = lazy.queue.shift();
        const el = faceEl(id);
        if (!el || !el.isConnected) continue;
        const box = el.getBoundingClientRect();
        if (box.bottom < -320 || box.top > innerHeight + 320) { lazy.observer.observe(el); continue; }
        await makeLater(id);
      }
    } finally {
      lazy.running = false;
    }
  }

  const pictureType = (t) => (/^image\//.test(t.mime || '') ? t.mime : 'image/' + ({ jpg: 'jpeg', jfif: 'jpeg' }[ending(t.name)] || ending(t.name)));

  async function makeLater(id) {
    const t = V.data.transfers.get(id);
    if (!t || t.deleted || !navigator.onLine) return;
    const kind = mediaKind(t);
    if (!lazyWanted(t, kind) || !V.send || !V.send.preview) return;
    let shot = null;
    try {
      const url = await V.cloud.link(t.path);
      if (kind === 'video') shot = V.send.videoPreview ? await V.send.videoPreview(url) : null;
      else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`The cloud said ${response.status}`);
        shot = await V.send.preview(new File([await response.blob()], t.name || 'picture', { type: pictureType(t) }));
      }
    } catch (error) {
      shot = null;
    }
    if (!shot || !shot.blob) { lazy.failed.add(t.id + ':' + t.size); return; }
    madeHere.set(id, URL.createObjectURL(shot.blob));
    const el = faceEl(id);
    if (el && el.isConnected) el.replaceWith(driveFace(V.data.transfers.get(id) || t));
    shareFace(t, shot);
  }

  /* The preview made here put beside its file in the cloud, so the other devices show it too. Never over one another
     device put there meanwhile, never for a file deleted meanwhile. */
  async function shareFace(t, shot) {
    const dir = (t.path || '').slice(0, (t.path || '').lastIndexOf('/') + 1);
    if (!navigator.onLine || !V.data.user || !dir.startsWith(`${V.data.user.id}/drive/`)) return;
    const path = dir + THUMB_NAME();
    try {
      await V.cloud.upload(path, shot.blob, { mime: 'image/jpeg' });
      faces.set(path, madeHere.get(t.id));
      V.db.put('files', { key: path, blob: shot.blob, at: Date.now() }).catch(() => {});
      const now = V.data.transfers.get(t.id);
      if (!now || now.deleted || now._purge) { V.cloud.remove([path]).catch(() => {}); return; }
      if (thumbOfRow(now)) return;
      await V.cloud.save('transfers', { ...now, extra: { ...(now.extra || {}), ...previewExtra(path, shot) } });
    } catch (error) {
      console.warn('Wefty Drive: the preview stays on this device', error);
    }
  }

  /* -- List or grid (this device's) */

  let gridHere = (() => { try { return localStorage.getItem(DRIVE_VIEW) === 'grid'; } catch (error) { return false; } })();
  function toggleGrid() {
    gridHere = !gridHere;
    try { localStorage.setItem(DRIVE_VIEW, gridHere ? 'grid' : 'list'); } catch (error) { /* this time only */ }
    drawViewButton();
    drawDriveList();
  }
  function drawViewButton() {
    const button = parts && parts.viewButton;
    if (!button) return;
    const label = gridHere ? 'Show as a list' : 'Show as a grid';
    button.title = label;
    button.setAttribute('aria-label', label);
    V.clear(button, V.icon(gridHere ? 'rows' : 'grid'));
  }

  function goDrive(path) {
    stopPicking();
    drive = path;
    draw();
  }

  /* ---------------------------------------------------------------- drawing */

  function when(seconds) {
    if (!seconds) return '';
    const d = new Date(seconds * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${d.getDate()} ${MONTHS[d.getMonth()]}` + (d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '');
  }

  const clock = (seconds) => { const all = Math.round(seconds); return `${Math.floor(all / 60)}:${String(all % 60).padStart(2, '0')}`; };

  /* One row: a folder or a file. Wefty Drive's (1.22.3) also give `id`, their own `face` (a preview), a video's
     `length` and `pickable` (the round tick shown while picking). */
  function fileRow({ id, name, dir, size, mtime, cloudOnly, thumb, face, length, pickable, open, menu }) {
    const look = face || (thumb ? V.h('span.files-thumb', {}, V.h('img', { src: thumb, alt: '', loading: 'lazy' }))
      : V.h('span.files-icon' + (dir ? '.dir' : ''), {}, V.icon(dir ? 'folder' : PICTURE.test(name) ? 'image' : 'file')));
    const main = V.h('button.files-open', { type: 'button', onclick: open, title: name,
      'aria-label': dir ? `${name}, folder` : length ? `${name}, video, ${clock(length)}` : name }, look,
    pickable ? V.h('span.files-tick', { 'aria-hidden': 'true' }, V.icon('check')) : null,
    V.h('span.files-name', { text: name }),
    V.h('span.files-meta', {},
      length ? V.h('span.files-length', { text: clock(length) }) : null,
      V.h('span.files-size' + (size > MAX ? '.too-big' : ''), { text: dir ? '' : V.size(size), title: size > MAX ? `Over ${V.FILE_MOST_WORDS}: too big to send` : null }),
      V.h('span.files-date', { text: when(mtime) }),
      cloudOnly ? V.h('span.files-cloud', { title: 'Only in OneDrive online' }, V.icon('cloud'), 'Online only') : null));
    const more = menu ? V.iconButton('more', 'More', (event) => menu(event.currentTarget), 'quiet') : V.h('span.files-go', {}, dir ? V.icon('back') : null);
    const row = V.h('div.files-row' + (dir ? '.dir' : ''), { dataset: id ? { name, id } : { name } }, main, more);
    if (menu) hold(main, () => menu(more));
    return row;
  }

  function sources() {
    if (V.desktop) return [['phone', 'phone', 'Your phone'], ['drive', 'cloud', 'Wefty Drive'], ['share', 'pc', 'Share this PC']];
    return [['pc', 'pc', 'Your PC'], ['here', 'phone', hereLabel()], ['drive', 'cloud', 'Wefty Drive']];
  }

  function show(which) {
    if (which === 'share') shareState = null;  // read again: .env may have been changed in Notepad
    if (which !== 'drive') stopPicking();
    if (which !== source) {
      source = which;
      store(PLACE, { ...(recall(PLACE) || {}), source });
      if (which === 'pc' || which === 'phone') {
        browse.host = null; browse.listing = null; browse.problem = null; browse.anyway = false; browse.filter = '';
        restorePlace();
      }
    }
    if (V.tab() !== 'files') V.go('files'); else draw();
  }

  function restorePlace() {
    const kept = recall(PLACE) || {};
    const spot = kept[source] || {};
    browse.host = spot.host || null;
    browse.root = spot.root || null;
    browse.path = Array.isArray(spot.path) ? spot.path.filter((p) => typeof p === 'string') : [];
  }

  function rememberPlace() {
    const kept = recall(PLACE) || {};
    kept[source] = { host: browse.host, root: browse.root, path: browse.path };
    store(PLACE, kept);
  }

  function render(container) {
    root = container;
    shareState = null;
    if (!source) {
      const kept = recall(PLACE) || {};
      source = sources().some(([id]) => id === kept.source) ? kept.source
        : V.desktop ? (V.prefs && V.prefs.pcFiles ? 'drive' : 'share') : 'pc';
      restorePlace();
    }
    draw();
  }

  function draw() {
    if (!root || !root.isConnected || root.dataset.tab !== 'files') return;
    const nav = V.h('div.files-sources', { role: 'tablist', 'aria-label': 'Where' }, sources().map(([id, icon, label]) =>
      V.h('button.files-source' + (id === source ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(id === source),
        dataset: { source: id }, onclick: () => show(id) }, V.icon(icon), V.h('span', { text: label }))));
    const main = V.h('div.files-main');
    parts = { main };
    V.clear(root, V.h('div.page.files-page', {},
      V.share ? V.share.head('files') : V.appHead({ title: 'Share' }),  // (js/share.js: Share's top and switch)
      V.h('div.files-layout', {}, nav, main)));
    if (source === 'drive') drawDrive();
    else if (source === 'share') drawShare();
    else if (source === 'here') drawHere();
    else drawRemote();
  }

  function crumbsAt(crumbs) {
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    return crumbs;
  }

  function empty(icon, title, text, ...more) {
    return V.h('div.files-empty', {}, V.h('span.files-empty-icon', {}, V.icon(icon)), V.h('strong', { text: title }),
      text ? V.h('p', { text }) : null, more);
  }

  /* -- another device's folders (the PC from a phone, the phone from the PC) */

  function currentHost() {
    const list = hostsFor(source === 'phone' ? 'phone' : 'pc');
    return list.find((h) => h.id === browse.host) || list[0] || null;
  }

  function drawRemote() {
    const kind = source === 'phone' ? 'phone' : 'pc';
    const main = parts.main;
    if (!hosts) {
      V.clear(main, V.h('div.files-empty', {}, V.h('div.spinner'), V.h('p', { text: kind === 'pc' ? 'Looking for your PC...' : 'Looking for your phone...' })));
      loadHosts().then(() => { if (source === kind) draw(); });
      return;
    }
    const host = currentHost();
    if (!host) {
      if (hostsTrouble) return V.clear(main, empty('alert', 'Can\'t look just now', hostsTrouble, V.button('Try again', { kind: 'primary', onClick: refreshHosts })));
      return V.clear(main, kind === 'pc' ? empty('pc', 'Update Wefty on your PC',
        'Browsing your PC from here needs the newest Wefty there. On the PC, open Jarvis and click Update, then open Wefty.',
        V.button('Look again', { icon: 'restore', onClick: refreshHosts })) : phoneTip());
    }
    browse.host = host.id;
    const others = hostsFor(kind);
    // ("on now" with a green dot while it answers: the PC running Wefty, or Wefty open on the phone)
    const live = fresh(host) && host.on;
    const where = V.h('div.files-host' + (live ? '.live' : ''), {}, V.icon(kind === 'pc' ? 'pc' : 'phone'),
      V.h('div.files-host-text', {}, V.h('strong', { text: kind === 'pc' ? 'Your PC' : 'Your phone' }),
        V.h('span', {}, live ? V.h('i.files-dot', { 'aria-hidden': 'true' }) : null,
          [host.label, live ? (kind === 'pc' ? 'on now' : 'open now') : seenText(host.seen)].filter(Boolean).join(' · '))),
      others.length > 1 ? V.h('select.files-host-pick', { 'aria-label': 'Which one', onchange: (event) => {
        browse.host = event.target.value; browse.root = null; browse.path = []; browse.listing = null; draw();
      } }, others.map((h) => V.h('option', { value: h.id, text: `${h.label || 'Device'} (${seenText(h.seen)})`, selected: h.id === host.id || null })))
        : null,
      V.iconButton('restore', 'Look again', refreshHosts, 'quiet'));
    if (!host.on) {
      return V.clear(main, where, kind === 'pc'
        ? empty('lock', 'Browsing is off on your PC', 'On the PC, open Wefty > Share > Files > Share this PC, turn it on and tick the folders your phone may see.')
        : empty('lock', 'Your phone isn\'t sharing right now', 'Open Wefty on the phone (Share > Files > This phone): the folder it shares shows here while Wefty is open there.'));
    }
    if (!fresh(host) && !browse.anyway) {
      return V.clear(main, where, empty('clock', `Last ${seenText(host.seen)}`,
        kind === 'pc' ? 'Your PC is off or asleep, or Wefty isn\'t running on it (it lives by the clock).'
          : 'Wefty isn\'t open on your phone right now.',
        V.button('Try anyway', { onClick: () => { browse.anyway = true; draw(); } })));
    }
    const roots = Array.isArray(host.roots) ? host.roots.filter((r) => r && r.id) : [];
    if (!roots.length) {
      return V.clear(main, where, empty('folder', 'No folders are shared yet',
        kind === 'pc' ? 'On the PC: Wefty > Share > Files > Share this PC, then tick the folders your phone may see.' : ''));
    }
    if (!roots.some((r) => r.id === browse.root)) { browse.root = roots[0].id; browse.path = []; browse.listing = null; }
    const rootLabel = (roots.find((r) => r.id === browse.root) || {}).label || 'Folder';
    const chips = roots.length > 1 ? V.h('div.files-roots', {}, roots.map((r) => V.h('button.chip' + (r.id === browse.root ? '.on' : ''), {
      type: 'button', onclick: () => go(r.id, []) }, V.icon('folder'), V.h('span', { text: r.label || r.id })))) : null;
    const crumbs = V.h('nav.files-crumbs', { 'aria-label': 'Folder' },
      [rootLabel, ...browse.path].map((name, i, all) => [i ? V.h('span.files-crumb-gap', { text: '›', 'aria-hidden': 'true' }) : null,
        V.h('button.files-crumb' + (i === all.length - 1 ? '.here' : ''), { type: 'button', text: name,
          onclick: () => go(browse.root, browse.path.slice(0, i)) })]));
    const search = V.h('input.search', { type: 'search', placeholder: 'Search this folder', 'aria-label': 'Search this folder',
      value: browse.filter, oninput: (event) => { browse.filter = event.target.value; drawList(); } });
    parts.list = V.h('div.files-list');
    parts.foot = V.h('div.files-foot');
    V.clear(main, where, chips, V.h('div.files-bar', {}, browse.path.length
      ? V.iconButton('back', 'Up a folder', () => go(browse.root, browse.path.slice(0, -1)), 'quiet') : null, crumbsAt(crumbs)),
      V.h('label.search-box.files-search', {}, V.icon('search'), search), parts.list, parts.foot);
    if (!browse.listing && !browse.loading && !browse.problem) load(0);
    else drawList();
  }

  function phoneTip() {
    const apple = V.phoneModel();  // (the owner's phone, from its own records: 'iPhone', 'iPad' or 'Phone')
    if (apple !== 'Phone') {
      return V.h('div.files-tip', {},
        empty('phone', `See your ${apple}'s files here`, `An ${apple} doesn't let a PC browse its files. Send them from Wefty on `
          + `the ${apple}, or put them in Wefty Drive: both come here.`));
    }
    return V.h('div.files-tip', {},
      empty('phone', 'See your phone\'s files here', 'Windows 11 can show your phone in File Explorer by itself, over Wi-Fi, with nothing open on the phone:'),
      V.h('ol.steps', {},
        V.h('li', { text: 'On this PC: Settings > Bluetooth & devices > Mobile devices.' }),
        V.h('li', { text: 'Turn on "Show mobile device in File Explorer" and pick your phone (it uses Phone Link, which Samsung phones already have).' }),
        V.h('li', { text: 'Your phone shows up in File Explorer, beside This PC.' })),
      V.pc && V.pc.can('openMobileDevices') ? V.button('Open that setting', { icon: 'open', onClick: () => V.pc.call('openMobileDevices').catch(V.problem) }) : null,
      V.h('p.hint', { text: 'If your phone\'s browser can share folders, Wefty there (Share > Files > This phone) can show one here while it\'s open. Wefty Drive works either way.' }));
  }

  async function refreshHosts() {
    hosts = null;
    browse.listing = null;
    browse.problem = null;
    await loadHosts(true);
    draw();
  }

  function go(rootId, path) {
    browse.root = rootId;
    browse.path = path;
    browse.listing = null;
    browse.problem = null;
    browse.filter = '';
    rememberPlace();
    drawRemote();
  }

  async function load(page) {
    const host = currentHost();
    if (!host) return;
    const ticket = ++browse.ticket;
    const spot = { root: browse.root, path: [...browse.path] };
    if (page) browse.more = true; else { browse.loading = true; browse.problem = null; }
    drawList();
    try {
      const result = await ask('list', { root: spot.root, path: spot.path, page }, target(host));
      if (ticket !== browse.ticket) return;
      const before = page && browse.listing ? browse.listing.entries : [];
      browse.listing = { ...result, entries: [...before, ...(result.entries || [])] };
      rememberPlace();
      fetchThumbs(host, spot, ticket);
    } catch (error) {
      if (ticket !== browse.ticket) return;
      if (!page) browse.problem = { text: error.message || String(error), code: error.code || '' };
      else V.problem(error);
      if (/isn't shared/.test(error.message || '')) {
        browse.root = null;
        browse.path = [];
        hostsAt = 0;
        loadHosts(true).then(() => { if (source === 'pc' || source === 'phone') draw(); });
      }
    } finally {
      if (ticket === browse.ticket) { browse.loading = false; browse.more = false; drawList(); }
    }
  }

  async function fetchThumbs(host, spot, ticket) {
    const entries = (browse.listing && browse.listing.entries) || [];
    const wanted = entries.filter((e) => !e.d && !e.c && THUMBABLE.test(e.n) && e.s < 25 * 1024 * 1024
      && !thumbs.has(placeKey(host, spot.root, spot.path, e)));
    for (let i = 0; i < Math.min(wanted.length, 72); i += 24) {
      if (ticket !== browse.ticket) return;
      const batch = wanted.slice(i, i + 24);
      try {
        const result = await ask('thumbs', { root: spot.root, path: spot.path, names: batch.map((e) => e.n) }, target(host));
        for (const entry of batch) {
          const link = (result.thumbs || {})[entry.n];
          if (typeof link === 'string' && link.startsWith('data:image/')) thumbs.set(placeKey(host, spot.root, spot.path, entry), link);
        }
      } catch (error) {
        return;  // icons are fine
      }
      if (ticket === browse.ticket) drawList();
    }
  }

  function drawList() {
    if (!parts || !parts.list || !parts.list.isConnected) return;
    const host = currentHost();
    if (browse.loading) {
      V.clear(parts.list, V.h('div.files-empty', {}, V.h('div.spinner'),
        V.h('p', { text: host && host.device !== 'pc' ? 'Asking your phone...' : 'Asking your PC...' })));
      V.clear(parts.foot);
      return;
    }
    if (browse.problem) {
      const up = browse.path.length && browse.problem.code === 'refused';
      V.clear(parts.list, empty('alert', browse.problem.code === 'no-answer' ? 'No answer' : 'That didn\'t work', browse.problem.text,
        V.h('div.files-empty-actions', {},
          up ? V.button('Back up', { onClick: () => go(browse.root, browse.path.slice(0, -1)) }) : null,
          V.button('Try again', { kind: 'primary', onClick: () => { browse.problem = null; browse.anyway = true; load(0); } }))));
      V.clear(parts.foot);
      return;
    }
    const listing = browse.listing;
    if (!listing || !host) return;
    const words = browse.filter.trim().toLowerCase();
    const shown = listing.entries.filter((e) => !words || e.n.toLowerCase().includes(words));
    const spot = { root: browse.root, path: browse.path };
    V.clear(parts.list, shown.length ? [V.h('div.files-columns', { 'aria-hidden': 'true' }, V.h('span', { text: 'Name' }),
      V.h('span', { text: 'Size' }), V.h('span', { text: 'Modified' })), shown.map((entry) => fileRow({
      name: entry.n, dir: !!entry.d, size: entry.s, mtime: entry.m, cloudOnly: !!entry.c,
      thumb: thumbs.get(placeKey(host, spot.root, spot.path, entry)),
      open: () => (entry.d ? go(browse.root, [...browse.path, entry.n]) : remoteSheet(entry)),
      menu: entry.d ? null : (anchor) => V.menu(anchor, [...actionsFor(), ['Copy to Wefty Drive', 'cloud']].map(([label, icon]) => ({
        label, icon, onClick: () => remoteSheet(entry, label) }))),
    }))] : empty('folder', words ? 'Nothing here by that name' : 'This folder is empty', words ? '' : null));
    const left = Math.max(0, (listing.total || 0) - listing.entries.length);
    V.clear(parts.foot, listing.more ? V.button(browse.more ? 'Loading...' : `Load more (${left} more)`, {
      disabled: browse.more, onClick: () => load((listing.page || 0) + 1) }) : null,
    listing.total ? V.h('span.files-count', { text: `${listing.total} item${listing.total === 1 ? '' : 's'}` }) : null);
  }

  /* -- Vault Drive */

  function drawDrive() {
    const main = parts.main;
    const crumbs = V.h('nav.files-crumbs', { 'aria-label': 'Folder' },
      ['Wefty Drive', ...(drive ? drive.split('/') : [])].map((name, i, all) => [i ? V.h('span.files-crumb-gap', { text: '›', 'aria-hidden': 'true' }) : null,
        V.h('button.files-crumb' + (i === all.length - 1 ? '.here' : ''), { type: 'button', text: name,
          onclick: () => goDrive(all.slice(1, i + 1).join('/')) })]));
    const picker = V.h('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', () => { addToDrive(picker.files); picker.value = ''; });
    parts.uploads = V.h('div.files-uploads');
    parts.list = V.h('div.files-list.drive', { onkeydown: listKeys });
    parts.space = V.h('div.space-row.files-space');
    // (1.22.3) Picking several: the Select button, the bar at the foot and what a screen reader says; List or grid.
    parts.select = V.h('button.btn.select-btn.files-select', { type: 'button', onclick: selectPressed });  // (Notes' look)
    parts.viewButton = V.h('button.icon-btn.quiet.files-view-btn', { type: 'button', onclick: toggleGrid });
    parts.said = V.h('span.sr-only', { role: 'status' });
    parts.pickStatus = V.h('div.files-pick-status', { 'aria-live': 'polite' });
    parts.pickBar = V.h('div.pick-bar.files-pick-bar', { role: 'group', 'aria-label': 'Picked files', hidden: true });
    V.clear(main,
      V.h('div.files-host.files-wraps', {}, V.icon('cloud'), V.h('div.files-host-text', {}, V.h('strong', { text: 'Wefty Drive' }),
        V.h('span', { text: `${V.who() === 'owner' ? 'In your own cloud' : 'In the cloud'}: both devices see it, even with the other one off.` }))),
      drive ? V.h('div.files-bar', {}, V.iconButton('back', 'Up a folder', () => goDrive(drive.split('/').slice(0, -1).join('/')), 'quiet'),
        crumbsAt(crumbs)) : null,
      V.h('div.files-tools', {}, picker,
        V.button('Upload', { kind: 'primary', icon: 'upload', onClick: () => picker.click() }),
        V.button('New folder', { icon: 'folder', onClick: newFolder }),
        V.h('div.files-tools-end', {}, parts.select, parts.viewButton)),
      parts.uploads, parts.list, parts.space, parts.said, parts.pickBar);
    drawViewButton();
    drawUploads();
    drawDriveList();
  }

  function drawDriveList() {
    if (!parts || !parts.list || !parts.list.isConnected || source !== 'drive') return;
    if (drive && !driveRows().some((t) => isDir(t) && joined(String(driveInfo(t).folder || ''), t.name) === drive)) {
      return goDrive('');  // the folder went (deleted on the other device)
    }
    const items = driveItems();
    // Picked rows that went (deleted or moved on the other device) aren't picked any more.
    const here = new Set(items.map((t) => t.id));
    for (const id of [...pick.ids]) if (!here.has(id)) pick.ids.delete(id);
    if (pick.on && !pick.job && (!items.length || (!pick.ids.size && !pick.held))) stopPicking();
    // The keyboard stays on the row (or its ⋯) it was on.
    const had = document.activeElement;
    const kept = had && parts.list.contains(had) && had.closest('.files-row[data-id]')
      ? { id: had.closest('.files-row[data-id]').dataset.id, more: !had.classList.contains('files-open') } : null;
    parts.list.classList.toggle('grid', gridHere);
    V.clear(parts.list, items.length ? [gridHere ? null : V.h('div.files-columns', { 'aria-hidden': 'true' }, V.h('span', { text: 'Name' }),
      V.h('span', { text: 'Size' }), V.h('span', { text: 'Added' })), items.map((t) => {
      const menu = (anchor) => V.menu(anchor, [
        ...(isDir(t) ? [] : actionsFor().map(([label, icon]) => ({ label, icon, onClick: () => driveSheet(t, label) }))),
        pick.on ? null : { label: 'Select', icon: 'select', onClick: () => selectWith(t.id) },
        { label: 'Rename', icon: 'text', onClick: () => renameDrive(t) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDrive(t) },
      ].filter(Boolean));
      const seconds = mediaKind(t) === 'video' && t.extra && t.extra.seconds > 0 ? t.extra.seconds : 0;
      return fileRow({ id: t.id, name: t.name || 'file', dir: isDir(t), size: t.size, face: driveFace(t), length: seconds,
        pickable: true, mtime: Date.parse(t.created_at || t._edited || 0) / 1000, open: (event) => press(event, t), menu });
    })] : empty('cloud', drive ? 'This folder is empty' : 'Wefty Drive is empty',
      V.desktop ? 'Upload files, or drop them here: your phone sees them too, even when this PC is off.'
        : 'Upload files here and your PC sees them too, even when this phone is off.'));
    if (kept) {
      const row = parts.list.querySelector(`.files-row[data-id="${CSS.escape(kept.id)}"]`);
      const again = row && row.querySelector(kept.more ? '.icon-btn' : '.files-open');
      if (again) again.focus({ preventScroll: true });
    }
    showPicked();
    V.clear(parts.space, V.storage.meter(used()));  // (1.21: the person's own room, else the plan's 1 GB)
  }

  function drawUploads() {
    if (!parts || !parts.uploads || !parts.uploads.isConnected) return;
    V.clear(parts.uploads, [...uploads.values()].filter((u) => u.folder === drive).map((u) => V.h('div.files-upload', {},
      V.h('span.files-icon', {}, V.icon('upload')),
      V.h('div.files-upload-text', {}, V.h('span.files-name', { text: u.name }),
        V.h('div.bar', {}, V.h('i', { style: { width: Math.round(100 * u.share) + '%' } }))),
      V.h('span.files-size', { text: V.size(u.size) }))));
  }

  /* -- this phone's own folder */

  function drawHere() {
    const main = parts.main;
    if (!canShareHere && V.deviceKind.ios) {  // (Windows' "Mobile devices" is for Android phones only)
      return V.clear(main, V.h('div.files-tip', {},
        empty('phone', `Your PC can't browse this ${V.deviceKind.model}`, 'iPhones and iPads don\'t let the PC look at their '
          + 'files. Send them, or put them in Wefty Drive.'),
        V.button('Open Wefty Drive', { icon: 'cloud', onClick: () => show('drive') })));
    }
    if (!canShareHere) {
      return V.clear(main, V.h('div.files-tip', {},
        empty('phone', 'Browse this phone from your PC', 'Phone browsers can\'t share folders with Wefty, but Windows 11 can see this phone by itself, over Wi-Fi:'),
        V.h('ol.steps', {},
          V.h('li', { text: 'On the PC: Settings > Bluetooth & devices > Mobile devices.' }),
          V.h('li', { text: 'Turn on "Show mobile device in File Explorer" and pick this phone (it uses Link to Windows, which Samsung phones already have).' }),
          V.h('li', { text: 'This phone shows up in File Explorer on the PC.' })),
        V.h('p.hint', { text: 'To put files from here on your PC, use Send, or upload them to Wefty Drive.' }),
        V.button('Open Wefty Drive', { icon: 'cloud', onClick: () => show('drive') })));
    }
    if (!here) {
      return V.clear(main, V.h('div.files-tip', {},
        empty('folder', 'Let your PC see a folder here', 'Pick a folder (like Camera or Documents). Your PC can look in it and take copies while Wefty is open on this phone.'),
        V.button('Share a folder', { kind: 'primary wide-btn', icon: 'folder', onClick: pickHere }),
        V.h('p.hint', { text: 'Read only: your PC never changes or deletes anything here. Android doesn\'t allow sharing the whole storage or Download itself.' })));
    }
    if (here.state === 'ask') {
      return V.clear(main, V.h('div.files-tip', {},
        empty('lock', `Tap to let your PC see ${here.name} again`, 'This browser asks again after a while.'),
        V.button(`Let your PC see ${here.name}`, { kind: 'primary wide-btn', onClick: allowAgain }),
        V.button('Stop sharing', { kind: 'danger-quiet', onClick: stopHere })));
    }
    V.clear(main, V.h('div.files-tip', {},
      empty('folder', `Sharing ${here.name} with your PC`, 'Your PC can see it while Wefty is open here. Keep Wefty in front while it looks.'),
      here.looked ? V.h('p.hint.center', { text: `Your PC looked ${seenText(new Date(here.looked).toISOString()).replace('seen ', '')}.` }) : null,
      V.h('div.files-empty-actions', {},
        V.button('Change folder', { icon: 'folder', onClick: pickHere }),
        V.button('Stop sharing', { kind: 'danger-quiet', onClick: stopHere }))));
  }

  /* -- the PC: what it shares */

  async function drawShare() {
    const main = parts.main;
    if (!V.pc || !V.pc.can('filesSettings')) {
      return V.clear(main, empty('pc', 'Update Jarvis to share this PC\'s files', 'Open Jarvis and click Update: then your phone can browse the folders you pick here.'));
    }
    if (!shareState) {
      V.clear(main, V.h('div.files-empty', {}, V.h('div.spinner')));
      try { shareState = await V.pc.call('filesSettings'); } catch (error) { return V.clear(main, empty('alert', 'That didn\'t work', error.message)); }
      if (source === 'share') drawShare();
      return;
    }
    const s = shareState;
    const change = async (args) => {
      try {
        const answer = await V.pc.call('filesSettings', args);
        shareState = answer;
        if (V.prefs) V.prefs.pcFiles = !!answer.on;
        if (answer.declined) V.toast('Nothing changed.');
        hostsAt = 0;
      } catch (error) { V.problem(error); }
      if (source === 'share') drawShare();
    };
    const master = V.h('input.switch', { type: 'checkbox', checked: s.on, 'aria-label': 'Let my phone see files on this PC',
      onchange: (event) => change({ on: event.target.checked }) });
    const ticked = (s.folders || []).filter((f) => f.on && !f.blocked).map((f) => f.id);
    const folderLine = (f) => V.h('div.setting', {},
      V.h('span.files-icon.dir', {}, V.icon('folder')),
      V.h('div.setting-text', {}, V.h('strong', { text: f.label }), V.h('span', { text: f.blocked ? 'Can\'t be shared: it holds a program\'s own files.' : f.path })),
      V.h('input.switch', { type: 'checkbox', checked: f.on && !f.blocked, disabled: !s.on || f.blocked, 'aria-label': `Share ${f.label}`,
        onchange: (event) => change({ roots: event.target.checked ? [...ticked, f.id] : ticked.filter((id) => id !== f.id) }) }));
    V.clear(main, V.h('div.settings.files-share', {},
      V.h('section.card.settings-card', {}, V.h('h2', { text: 'Your phone and this PC' }),
        V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Let my phone see files on this PC' }),
          V.h('span', { text: s.on ? `On: your phone sees it as ${s.label || 'your PC'}, while Wefty runs here.` : 'Off: nothing on this PC can be seen from the phone.' })), master)),
      V.h('section.card.settings-card' + (s.on ? '' : '.muted-card'), {}, V.h('h2', { text: 'Folders your phone can see' }),
        (s.folders || []).length ? s.folders.map(folderLine) : V.h('p.hint', { text: 'This PC has none of Windows\' usual folders.' })),
      V.h('section.card.settings-card', {}, V.h('h2', { text: 'What your phone can do' }),
        V.h('ul.files-rules', {},
          V.h('li', { text: `Look in the folders ticked above, and take copies of files (up to ${V.FILE_MOST_WORDS} each).` }),
          V.h('li', { text: 'Never change, move or delete anything on this PC.' }),
          V.h('li', { text: 'Never see hidden files, programs\' own folders or password and key files.' }),
          V.h('li', { text: 'Only while this PC is on with Wefty by the clock. You get a notice when the phone takes a file.' })))));
  }

  /* ---------------------------------------------------------------- starting, and the rest of the app */

  function start() {
    if (started || !V.cloud.sb || !V.data.user) return;
    started = true;
    listen();
    poll();
    restoreHere().catch((error) => console.warn('Vault files:', error));
  }

  V.on('status', (state) => { if (state === 'synced' || state === 'held') start(); });
  // Picking (1.22.3) ends when another screen opens, Back is pressed on a phone, or with Esc; Ctrl+A picks the folder.
  V.on('tab', (tab) => { if (tab !== 'files' && pick.on) stopPicking(); });
  window.addEventListener('popstate', () => {
    if (!onPhone()) return;
    if (pick.on && !(history.state && history.state.vault === 'files-select')) stopPicking({ fromHistory: true });
    else if (!pick.on && history.state && history.state.vault === 'files-select') history.back();  // (a step left from before)
  });
  const typing = (target) => !!target && !!target.matches && (target.matches('input, textarea, select') || target.isContentEditable);
  document.addEventListener('keydown', (event) => {
    if (source !== 'drive' || V.tab() !== 'files' || !parts || !parts.list || !parts.list.isConnected) return;
    if (document.querySelector('#layers > .layer:not(.leaving)') || typing(event.target)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.shiftKey && !event.altKey && (event.key || '').toLowerCase() === 'a') {
      if (!driveItems().length) return;
      event.preventDefault();
      pickAll();
    } else if (event.key === 'Escape' && pick.on) {
      event.preventDefault();
      stopPicking();
    } else if (event.key === 'Delete' && pick.on && pick.ids.size && !pick.job) {
      event.preventDefault();
      deletePicked(pickedRows()).catch(V.problem);
    }
  });
  V.on('data', (table) => { if (table === 'transfers' && source === 'drive') drawDriveList(); });
  V.on('storage', () => { if (source === 'drive') drawDriveList(); });  // (the cloud's count came: V.storage)
  V.on('away', hereAway);
  V.on('back', async () => {
    if (here && here.handle) {
      here.state = (await permitted(here.handle, false)) ? 'on' : 'ask';
      announceHere(here.state === 'on');
      if (source === 'here') draw();
    }
    if (source === 'pc' || source === 'phone') { hostsAt = 0; loadHosts(true).then(() => { if (V.tab() === 'files') drawRemoteHead(); }); }
  });

  /* Back from the background: "seen" times may have changed; only the host line is redrawn (never the search). */
  function drawRemoteHead() {
    if (!parts || !parts.main || !parts.main.isConnected) return;
    const host = currentHost();
    const line = parts.main.querySelector('.files-host-text span');
    if (host && line) line.textContent = [host.label, seenText(host.seen)].filter(Boolean).join(' · ');
  }

  return {
    render,
    show,
    /* start.js's drop: files dropped on the Drive view go into Drive (true), anything else to Send. */
    takeDrop: (list) => {
      if (V.tab() !== 'files' || source !== 'drive') return false;
      addToDrive(list);
      return true;
    },
    dropText: () => (V.tab() === 'files' && source === 'drive' ? 'Drop to add to Wefty Drive' : ''),
    busy: () => uploads.size > 0 || busyCount > 0 || !!pick.job,
    // For tests and the PC app's check: look for requests now, ask directly, share a folder, timings.
    checkRequests,
    poll,
    ask,
    use,
    tune,
    state: () => ({ source, browse: { ...browse }, drive, here: here && { name: here.name, id: here.id, state: here.state }, live,
      picking: { on: pick.on, held: pick.held, ids: [...pick.ids], busy: !!pick.job }, grid: gridHere }),
  };
})();
