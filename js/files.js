/* Vault: the Files tab. "Almost like a cloud" between the PC and the phone, with nothing new in the cloud's tables:

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
  const MAX = 50 * 1024 * 1024;
  const FREE_SPACE = 1024 * 1024 * 1024;
  const FRESH = 7 * 60 * 1000;            // a host seen longer ago than this is off, asleep, or Vault isn't running
  const STALE = 90 * 1000;                // a request older than this is refused, never run late
  const PAGE = 200;
  const tune = { timeout: 12000, poll: 8000, marks: [500, 1000, 2000, 3000, 5000, 8000, 12000], hold: 500 };
  const PLACE = 'vault-files-place';      // localStorage: where this device last looked (a convenience only)
  const SHARE = 'files-share';            // V.db meta: this phone's shared folder { handle, name }
  const HERE_ID = 'files-host-id';        // V.db meta: this device's host id
  const PICTURE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i;
  const THUMBABLE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NO_PC = 'Your PC didn\'t answer. Is it awake, with Vault by the clock?';
  const NO_PHONE = 'Your phone didn\'t answer. Is Vault open on it?';
  const OFFLINE = 'No internet just now. Try again when you\'re back online.';
  const FULL = 'Your free cloud is full (1 GB). Delete things from Vault Drive or Send first.';
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

  const files = (row) => (row && row.extra && typeof row.extra.files === 'object' && row.extra.files) || {};
  const refusal = (text) => Object.assign(new Error(text), { refused: true });
  const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* private */ } };
  const recall = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { return null; } };
  const deviceLabel = () => (/CrOS/.test(navigator.userAgent) ? 'Chromebook' : /Android|iPhone|iPad/.test(navigator.userAgent)
    ? 'Phone' : 'Browser');
  const hereLabel = () => (/Android|iPhone|iPad/.test(navigator.userAgent) || V.device === 'phone' && !/CrOS/.test(navigator.userAgent)
    ? 'This phone' : 'This device');

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
    if (!sb) throw new Error('Vault isn\'t connected yet.');
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
        hostsTrouble = navigator.onLine ? 'Vault couldn\'t look for your devices just now.' : OFFLINE;
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
    V.toast(`Your PC can see ${handle.name} while Vault is open here`);
  }

  async function allowAgain() {
    if (!here) return;
    if (await permitted(here.handle, true)) {
      here.state = 'on';
      await announceHere(true);
      listen();
    } else V.toast('Vault wasn\'t allowed to see that folder.', { kind: 'err' });
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
        if (file.size > MAX) throw refusal(`${file.name} is ${Math.round(file.size / 1048576)} MB, over the 50 MB the free cloud takes.`);
        await V.cloud.sb.from('transfers').update({ extra: { ...(row.extra || {}), files: { ...request, state: 'working', size: file.size } } })
          .eq('id', row.id).is('received_at', null);
        stored = `${V.data.user.id}/phonefiles/${row.id}/${V.storageName(file.name)}`;
        await V.cloud.upload(stored, file, { mime: file.type || 'application/octet-stream' });
        reply = { state: 'done', result: { file: { path: stored, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' } } };
      } else throw refusal('Vault on the phone doesn\'t know that yet: it updates by itself soon.');
      if (here) here.looked = Date.now();
    } catch (error) {
      reply = error.refused ? { state: 'refused', error: error.message }
        : { state: 'error', error: error.name === 'NotFoundError' || error.name === 'TypeError' ? 'That isn\'t there any more.'
          : error.name === 'NotAllowedError' ? 'Vault on the phone needs its permission again: open Files there.'
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

  /* Everything kept in the cloud (Send, Drive and pictures in notes) against the free plan's 1 GB. */
  function used() {
    const sent = [...V.data.transfers.values()].filter((t) => !t.deleted && t.path).reduce((sum, t) => sum + (t.size || 0), 0);
    const pictures = [...V.data.notes.values()].reduce((sum, n) => sum + (n.attachments || []).reduce((s, a) => s + (a.size || 0), 0), 0);
    return sent + pictures + [...uploads.values()].reduce((sum, u) => sum + u.size, 0);
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
      hint: folder ? `In ${folder.split('/').pop()}` : 'In Vault Drive' });
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
      if (file.size > MAX) { V.toast(`${file.name} is over 50 MB, the most the free cloud takes.`, { kind: 'err', ms: 6000 }); continue; }
      if (used() + file.size > FREE_SPACE) { V.toast(FULL, { kind: 'err', ms: 8000 }); break; }
      const id = V.uuid();
      const path = `${V.data.user.id}/drive/${id}/${V.storageName(file.name || 'file')}`;
      uploads.set(id, { name: file.name || 'file', size: file.size, share: 0, folder });
      drawUploads();
      try {
        await V.cloud.upload(path, file, { mime: file.type, onProgress: (share) => {
          const going = uploads.get(id);
          if (going) { going.share = share; drawUploads(); }
        } });
        await V.cloud.save('transfers', driveRow(id, { name: freeName(folder, (file.name || 'file').slice(0, 300)), path,
          size: file.size, mime: file.type || 'application/octet-stream', extra: { drive: { folder } } }));
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

  async function deleteDrive(t) {
    if (isDir(t)) {
      const inside = joined(String(driveInfo(t).folder || ''), t.name);
      const all = driveRows().filter((r) => { const w = String(driveInfo(r).folder || ''); return w === inside || w.startsWith(inside + '/'); });
      const count = all.filter((r) => !isDir(r)).length;
      const sure = await V.confirm(`Delete ${t.name}?`, count ? `The ${count} file${count > 1 ? 's' : ''} in it go too, from both devices.`
        : 'It\'s empty.', { ok: 'Delete', danger: true });
      if (!sure) return;
      const paths = all.map((r) => r.path).filter(Boolean);
      if (paths.length) V.cloud.remove(paths).catch(() => {});
      for (const r of all) await V.cloud.save('transfers', { ...r, deleted: true });
      if (drive === inside || drive.startsWith(inside + '/')) drive = String(driveInfo(t).folder || '');
    } else {
      const sure = await V.confirm(`Delete ${t.name}?`, 'It goes from Vault Drive on both devices. Copies already saved stay.',
        { ok: 'Delete', danger: true });
      if (!sure) return;
      if (t.path) V.cloud.remove([t.path]).catch(() => {});
    }
    await V.cloud.save('transfers', { ...t, deleted: true });
  }

  /* A file the other device brought up (pcfiles/ or phonefiles/), kept in Vault Drive's top folder. */
  async function copyToDrive(file) {
    if (used() + (file.size || 0) > FREE_SPACE) throw new Error(FULL);
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
  function fileSheet({ name, size, mtime, thumb, cloudOnly, from, get, extra = [], start }) {
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
    const meta = [size || size === 0 ? V.size(size) : '', mtime ? when(mtime) : '', from ? `On ${from}` : 'In Vault Drive']
      .filter(Boolean).join(' · ');
    const sheet = V.sheet({
      title: name,
      content: [
        V.h('div.files-sheet-head', {},
          thumb ? V.h('span.files-thumb.big', {}, V.h('img', { src: thumb, alt: '' })) : V.h('span.files-icon.big', {}, V.icon(PICTURE.test(name) ? 'image' : 'file')),
          V.h('div.files-sheet-name', {}, name.length > 32 ? V.h('strong', { text: name }) : null, V.h('span', { text: meta }))),
        big ? V.h('p.hint', { text: 'Over 50 MB: too big to go through your free cloud. Copy it with a USB cable or Phone Link instead.' }) : null,
        cloudOnly ? V.h('p.hint', {}, V.icon('cloud'), ' Only in OneDrive online: your PC downloads it first, so it takes a little longer.') : null,
        status,
        V.h('div.files-actions', {}, actions),
      ],
    });
    const first = start && buttons.find((b) => b.dataset.action === start);
    if (first) requestAnimationFrame(() => first.click());  // picked from the row's menu: it goes straight away
    return sheet;
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
      extra: [['Copy to Vault Drive', 'cloud', async (file) => {
        await copyToDrive(file);
        V.toast('Copied to Vault Drive', { action: 'Show', onAction: () => { drive = ''; show('drive'); } });
      }]],
    });
  }

  function driveSheet(t, start) {
    const sheet = fileSheet({
      name: t.name, size: t.size, mtime: Date.parse(t.created_at || t._edited || 0) / 1000,
      get: async () => ({ path: t.path, name: t.name, size: t.size, mime: t.mime }),  // (up before its row was made)
      start,
      extra: [
        ['Rename', 'text', async () => { sheet.close(); await renameDrive(t); }, '', true],
        ['Delete', 'trash', async () => { sheet.close(); await deleteDrive(t); }, 'danger-quiet', true],
      ],
    });
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

  /* ---------------------------------------------------------------- drawing */

  function when(seconds) {
    if (!seconds) return '';
    const d = new Date(seconds * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${d.getDate()} ${MONTHS[d.getMonth()]}` + (d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '');
  }

  function fileRow({ name, dir, size, mtime, cloudOnly, thumb, open, menu }) {
    const face = thumb ? V.h('span.files-thumb', {}, V.h('img', { src: thumb, alt: '', loading: 'lazy' }))
      : V.h('span.files-icon' + (dir ? '.dir' : ''), {}, V.icon(dir ? 'folder' : PICTURE.test(name) ? 'image' : 'file'));
    const main = V.h('button.files-open', { type: 'button', onclick: open, title: name, 'aria-label': dir ? `${name}, folder` : name }, face,
      V.h('span.files-name', { text: name }),
      V.h('span.files-meta', {},
        V.h('span.files-size' + (size > MAX ? '.too-big' : ''), { text: dir ? '' : V.size(size), title: size > MAX ? 'Over 50 MB: too big to send' : null }),
        V.h('span.files-date', { text: when(mtime) }),
        cloudOnly ? V.h('span.files-cloud', { title: 'Only in OneDrive online' }, V.icon('cloud'), 'Online only') : null));
    const more = menu ? V.iconButton('more', 'More', (event) => menu(event.currentTarget), 'quiet') : V.h('span.files-go', {}, dir ? V.icon('back') : null);
    const row = V.h('div.files-row' + (dir ? '.dir' : ''), { dataset: { name } }, main, more);
    if (menu) hold(main, () => menu(more));
    return row;
  }

  function sources() {
    if (V.desktop) return [['phone', 'phone', 'Your phone'], ['drive', 'cloud', 'Vault Drive'], ['share', 'pc', 'Share this PC']];
    return [['pc', 'pc', 'Your PC'], ['here', 'phone', hereLabel()], ['drive', 'cloud', 'Vault Drive']];
  }

  function show(which) {
    if (which === 'share') shareState = null;  // read again: .env may have been changed in Notepad
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
      V.h('div.page-head', {}, V.h('h1', { text: 'Files' }), V.statusPill()),
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
      return V.clear(main, kind === 'pc' ? empty('pc', 'Update Vault on your PC',
        'Browsing your PC from here needs the newest Vault there. On the PC, open Jarvis and click Update, then open Vault.',
        V.button('Look again', { icon: 'restore', onClick: refreshHosts })) : phoneTip());
    }
    browse.host = host.id;
    const others = hostsFor(kind);
    const where = V.h('div.files-host', {}, V.icon(kind === 'pc' ? 'pc' : 'phone'),
      V.h('div.files-host-text', {}, V.h('strong', { text: kind === 'pc' ? 'Your PC' : 'Your phone' }),
        V.h('span', { text: [host.label, seenText(host.seen)].filter(Boolean).join(' · ') })),
      others.length > 1 ? V.h('select.files-host-pick', { 'aria-label': 'Which one', onchange: (event) => {
        browse.host = event.target.value; browse.root = null; browse.path = []; browse.listing = null; draw();
      } }, others.map((h) => V.h('option', { value: h.id, text: `${h.label || 'Device'} (${seenText(h.seen)})`, selected: h.id === host.id || null })))
        : null,
      V.iconButton('restore', 'Look again', refreshHosts, 'quiet'));
    if (!host.on) {
      return V.clear(main, where, kind === 'pc'
        ? empty('lock', 'Browsing is off on your PC', 'On the PC, open Vault > Files > Share this PC, turn it on and tick the folders your phone may see.')
        : empty('lock', 'Your phone isn\'t sharing right now', 'Open Vault on the phone (Files > This phone): the folder it shares shows here while Vault is open there.'));
    }
    if (!fresh(host) && !browse.anyway) {
      return V.clear(main, where, empty('clock', `Last ${seenText(host.seen)}`,
        kind === 'pc' ? 'Your PC is off or asleep, or Vault isn\'t running on it (it lives by the clock).'
          : 'Vault isn\'t open on your phone right now.',
        V.button('Try anyway', { onClick: () => { browse.anyway = true; draw(); } })));
    }
    const roots = Array.isArray(host.roots) ? host.roots.filter((r) => r && r.id) : [];
    if (!roots.length) {
      return V.clear(main, where, empty('folder', 'No folders are shared yet',
        kind === 'pc' ? 'On the PC: Vault > Files > Share this PC, then tick the folders your phone may see.' : ''));
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
    return V.h('div.files-tip', {},
      empty('phone', 'See your phone\'s files here', 'Windows 11 can show your phone in File Explorer by itself, over Wi-Fi, with nothing open on the phone:'),
      V.h('ol.steps', {},
        V.h('li', { text: 'On this PC: Settings > Bluetooth & devices > Mobile devices.' }),
        V.h('li', { text: 'Turn on "Show mobile device in File Explorer" and pick your phone (it uses Phone Link, which Samsung phones already have).' }),
        V.h('li', { text: 'Your phone shows up in File Explorer, beside This PC.' })),
      V.pc && V.pc.can('openMobileDevices') ? V.button('Open that setting', { icon: 'open', onClick: () => V.pc.call('openMobileDevices').catch(V.problem) }) : null,
      V.h('p.hint', { text: 'If your phone\'s browser can share folders, Vault there (Files > This phone) can show one here while it\'s open. Vault Drive works either way.' }));
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
      menu: entry.d ? null : (anchor) => V.menu(anchor, [...actionsFor(), ['Copy to Vault Drive', 'cloud']].map(([label, icon]) => ({
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
      ['Vault Drive', ...(drive ? drive.split('/') : [])].map((name, i, all) => [i ? V.h('span.files-crumb-gap', { text: '›', 'aria-hidden': 'true' }) : null,
        V.h('button.files-crumb' + (i === all.length - 1 ? '.here' : ''), { type: 'button', text: name,
          onclick: () => { drive = all.slice(1, i + 1).join('/'); draw(); } })]));
    const picker = V.h('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', () => { addToDrive(picker.files); picker.value = ''; });
    parts.uploads = V.h('div.files-uploads');
    parts.list = V.h('div.files-list');
    parts.space = V.h('div.space-row.files-space');
    V.clear(main,
      V.h('div.files-host.files-wraps', {}, V.icon('cloud'), V.h('div.files-host-text', {}, V.h('strong', { text: 'Vault Drive' }),
        V.h('span', { text: 'In your own cloud: both devices see it, even with the other one off.' }))),
      drive ? V.h('div.files-bar', {}, V.iconButton('back', 'Up a folder', () => { drive = drive.split('/').slice(0, -1).join('/'); draw(); }, 'quiet'),
        crumbsAt(crumbs)) : null,
      V.h('div.files-tools', {}, picker,
        V.button('Upload', { kind: 'primary', icon: 'upload', onClick: () => picker.click() }),
        V.button('New folder', { icon: 'folder', onClick: newFolder })),
      parts.uploads, parts.list, parts.space);
    drawUploads();
    drawDriveList();
  }

  function drawDriveList() {
    if (!parts || !parts.list || !parts.list.isConnected || source !== 'drive') return;
    if (drive && !driveRows().some((t) => isDir(t) && joined(String(driveInfo(t).folder || ''), t.name) === drive)) {
      drive = '';  // the folder went (deleted on the other device)
      return draw();
    }
    const items = inFolder(drive).sort((a, b) => (isDir(b) - isDir(a)) || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    V.clear(parts.list, items.length ? [V.h('div.files-columns', { 'aria-hidden': 'true' }, V.h('span', { text: 'Name' }),
      V.h('span', { text: 'Size' }), V.h('span', { text: 'Added' })), items.map((t) => {
      const menu = (anchor) => V.menu(anchor, [
        ...(isDir(t) ? [] : actionsFor().map(([label, icon]) => ({ label, icon, onClick: () => driveSheet(t, label) }))),
        { label: 'Rename', icon: 'text', onClick: () => renameDrive(t) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteDrive(t) },
      ]);
      return fileRow({ name: t.name || 'file', dir: isDir(t), size: t.size,
        mtime: Date.parse(t.created_at || t._edited || 0) / 1000,
        open: () => { if (isDir(t)) { drive = joined(drive, t.name); draw(); } else driveSheet(t); }, menu });
    })] : empty('cloud', drive ? 'This folder is empty' : 'Vault Drive is empty',
      V.desktop ? 'Upload files, or drop them here: your phone sees them too, even when this PC is off.'
        : 'Upload files here and your PC sees them too, even when this phone is off.'));
    const total = used();
    V.clear(parts.space, V.h('div.bar.space', {}, V.h('i', { style: { width: Math.min(100, (100 * total) / FREE_SPACE) + '%' } })),
      V.h('span', { text: `${V.size(total)} of 1 GB of free space used` }));
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
    if (!canShareHere) {
      return V.clear(main, V.h('div.files-tip', {},
        empty('phone', 'Browse this phone from your PC', 'Phone browsers can\'t share folders with Vault, but Windows 11 can see this phone by itself, over Wi-Fi:'),
        V.h('ol.steps', {},
          V.h('li', { text: 'On the PC: Settings > Bluetooth & devices > Mobile devices.' }),
          V.h('li', { text: 'Turn on "Show mobile device in File Explorer" and pick this phone (it uses Link to Windows, which Samsung phones already have).' }),
          V.h('li', { text: 'This phone shows up in File Explorer on the PC.' })),
        V.h('p.hint', { text: 'To put files from here on your PC, use Send, or upload them to Vault Drive.' }),
        V.button('Open Vault Drive', { icon: 'cloud', onClick: () => show('drive') })));
    }
    if (!here) {
      return V.clear(main, V.h('div.files-tip', {},
        empty('folder', 'Let your PC see a folder here', 'Pick a folder (like Camera or Documents). Your PC can look in it and take copies while Vault is open on this phone.'),
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
      empty('folder', `Sharing ${here.name} with your PC`, 'Your PC can see it while Vault is open here. Keep Vault in front while it looks.'),
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
          V.h('span', { text: s.on ? `On: your phone sees it as ${s.label || 'your PC'}, while Vault runs here.` : 'Off: nothing on this PC can be seen from the phone.' })), master)),
      V.h('section.card.settings-card' + (s.on ? '' : '.muted-card'), {}, V.h('h2', { text: 'Folders your phone can see' }),
        (s.folders || []).length ? s.folders.map(folderLine) : V.h('p.hint', { text: 'This PC has none of Windows\' usual folders.' })),
      V.h('section.card.settings-card', {}, V.h('h2', { text: 'What your phone can do' }),
        V.h('ul.files-rules', {},
          V.h('li', { text: 'Look in the folders ticked above, and take copies of files (up to 50 MB each).' }),
          V.h('li', { text: 'Never change, move or delete anything on this PC.' }),
          V.h('li', { text: 'Never see hidden files, programs\' folders (like Jarvis) or password and key files.' }),
          V.h('li', { text: 'Only while this PC is on with Vault by the clock. You get a notice when the phone takes a file.' })))));
  }

  /* ---------------------------------------------------------------- starting, and the rest of the app */

  function start() {
    if (started || !V.cloud.sb || !V.data.user) return;
    started = true;
    listen();
    poll();
    restoreHere().catch((error) => console.warn('Vault files:', error));
  }

  V.on('status', (state) => { if (state === 'synced') start(); });
  V.on('data', (table) => { if (table === 'transfers' && source === 'drive') drawDriveList(); });
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
    dropText: () => (V.tab() === 'files' && source === 'drive' ? 'Drop to add to Vault Drive' : ''),
    busy: () => uploads.size > 0 || busyCount > 0,
    // For tests and the PC app's check: look for requests now, ask directly, share a folder, timings.
    checkRequests,
    poll,
    ask,
    use,
    tune,
    state: () => ({ source, browse: { ...browse }, drive, here: here && { name: here.name, id: here.id, state: here.state }, live }),
  };
})();
