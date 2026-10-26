/* Vault: keeping this device and the cloud in step.

   Everything shows from this device's copy first (V.data, saved in V.db), so the app opens at once and works
   offline. A change made here is saved here with _dirty set, then sent (push). Changes from elsewhere come in by
   Supabase Realtime as they happen, and by asking for "everything since" (pull) on start, every so often, and when
   the app comes back to the front: rows carry the cloud's own updated_at, so nothing is missed. A row changed here
   and not sent yet always wins over the cloud's copy until it's sent (the last device to send wins).

   On the phone the supabase client signs in itself (its session in localStorage). In the PC app the Python side
   owns the sign-in (vault/cloud.py, shared with Jarvis), and the page asks it for each access token (V.pc). */
'use strict';

V.data = { notes: new Map(), folders: new Map(), transfers: new Map(), clips: [], settings: {}, user: null };

/* ---------------------------------------------------------------- the PC app's side (vault/desktop.py) */

V.pc = V.desktop ? (() => {
  let bridge = null;
  let next = 1;
  const waiting = new Map();
  const ready = new Promise((resolve) => {
    const connect = () => new window.QWebChannel(window.qt.webChannelTransport, (channel) => {
      bridge = channel.objects.vault;
      bridge.reply.connect((id, json) => {
        const done = waiting.get(id);
        if (!done) return;
        waiting.delete(id);
        const answer = JSON.parse(json || '{}');
        if (answer.error) done.reject(Object.assign(new Error(answer.error), { kind: answer.kind || '' }));
        else done.resolve(answer);
      });
      bridge.event.connect((name, json) => V.emit('pc:' + name, JSON.parse(json || '{}')));
      resolve();
    });
    if (window.QWebChannel && window.qt) connect();
    else window.addEventListener('DOMContentLoaded', connect);
  });
  const call = async (name, args = {}) => {
    await ready;
    const id = next++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      bridge.call(id, name, JSON.stringify(args));
    });
  };
  return {
    ready,
    call,
    token: () => call('token').then((answer) => answer.token),
    setClipboard: (text) => call('setClipboard', { text }),
    notify: (title, text) => call('notify', { title, text }).catch(() => {}),
  };
})() : null;

/* ---------------------------------------------------------------- the cloud */

V.cloud = (() => {
  const FIELDS = {
    notes: ['id', 'folder_id', 'title', 'body', 'pinned', 'due', 'done', 'locked', 'secret', 'attachments', 'template',
      'deleted', 'deleted_at', 'extra'],
    folders: ['id', 'name', 'icon', 'sort', 'deleted', 'extra'],
    transfers: ['id', 'kind', 'name', 'path', 'size', 'mime', 'text', 'from_device', 'to_device', 'received_at',
      'deleted', 'extra'],
  };
  // What a column holds when a row made here doesn't say (every row sent has every column, as one bulk upsert has
  // to: a column missing from it would be set to null).
  const BLANK = {
    folder_id: null, title: '', body: '', pinned: false, due: null, done: false, locked: false, secret: null,
    attachments: [], template: '', deleted: false, deleted_at: null, extra: {}, name: '', icon: '', sort: 0,
    kind: 'file', path: null, size: 0, mime: '', text: '', from_device: '', to_device: '', received_at: null,
  };
  const SYNCED = ['folders', 'notes', 'transfers'];
  const POLL_LIVE = 120000;   // with Realtime working, a safety check every 2 minutes
  const POLL_OFFLINE = 20000; // without it, every 20 seconds
  const TRASH_DAYS = 30;
  let sb = null;
  let config = null;
  let channel = null;
  let live = false;
  let timer = null;
  let pushing = null;
  let pushAgain = false;
  let status = 'idle';
  const links = new Map();

  const setStatus = (value) => { if (value !== status) { status = value; V.emit('status', value); } };
  const offlineError = (error) => !navigator.onLine || /fetch|network|load failed|timed? ?out/i.test(String(error && (error.message || error)));
  const authError = (error) => error && (error.kind === 'signed-out' || error.status === 401 ||
    /JWT|refresh token|not authenticated|signed out/i.test(error.message || ''));

  function client(cfg) {
    config = cfg;
    const options = { realtime: { params: { eventsPerSecond: 5 } }, global: { headers: { 'x-vault': V.VERSION } } };
    if (V.desktop) options.accessToken = () => V.pc.token();
    else options.auth = { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'vault-auth' };
    sb = window.supabase.createClient(cfg.url, cfg.key, options);
    return sb;
  }

  async function accessToken() {
    if (V.desktop) return V.pc.token();
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session.access_token;
    // An expired session can't be renewed offline, but it's still kept: only a real sign-out is one.
    if (!navigator.onLine || localStorage.getItem('vault-auth')) throw new Error('Failed to fetch (offline)');
    throw Object.assign(new Error('Signed out'), { kind: 'signed-out' });
  }

  /* -- this device's copy */

  async function loadLocal() {
    for (const table of SYNCED) {
      V.data[table] = new Map((await V.db.all(table)).map((row) => [row.id, row]));
    }
    V.data.clips = (await V.db.all('clips')).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    V.data.settings = (await V.db.meta('settings')) || {};
    for (const table of SYNCED) V.emit('data', table);
  }

  async function keep(table, rows, { fromCloud = true } = {}) {
    const map = V.data[table];
    const changed = [];
    for (const row of rows) {
      const here = map.get(row.id);
      if (fromCloud && here && here._dirty) continue;  // ours isn't sent yet: it wins
      if (row.deleted && table !== 'notes') {
        if (here) { map.delete(row.id); await V.db.del(table, row.id); changed.push(row); }
        continue;
      }
      if (fromCloud && here && here.updated_at && row.updated_at && here.updated_at >= row.updated_at) continue;
      map.set(row.id, row);
      changed.push(row);
    }
    if (changed.length) {
      await V.db.putMany(table, changed.filter((row) => map.has(row.id)));
      V.emit('data', table);
    }
    return changed;
  }

  /* A change made on this device: shown and saved at once, sent soon after. */
  async function save(table, row) {
    const stamped = { ...row, _dirty: Date.now() + Math.random(), _edited: new Date().toISOString() };
    V.data[table].set(stamped.id, stamped);
    await V.db.put(table, stamped);
    V.emit('data', table);
    pushSoon();
    return stamped;
  }

  /* -- asking the cloud */

  async function pull(table) {
    const sinceKey = 'since:' + table;
    const since = await V.db.meta(sinceKey);
    let from = since ? new Date(new Date(since).getTime() - 10000).toISOString() : '1970-01-01T00:00:00Z';
    let newest = since || null;
    for (let page = 0; page < 40; page++) {
      const { data, error, status } = await sb.from(table).select('*').gte('updated_at', from)
        .order('updated_at', { ascending: true }).limit(500);
      if (error) throw Object.assign(error, { status });
      const changed = await keep(table, data);
      if (table === 'transfers') V.emit('transfers-in', changed.filter((t) => !t.deleted));
      if (data.length) newest = data[data.length - 1].updated_at;
      if (data.length < 500) break;
      from = newest;
    }
    if (newest) await V.db.meta(sinceKey, newest);
  }

  let clipsChecked = false;  // the first check after starting only catches up: nothing is copied for old ones
  async function pullClips() {
    const { data, error, status } = await sb.from('clips').select('*').order('created_at', { ascending: false }).limit(30);
    if (error) throw Object.assign(error, { status });
    const known = new Set(V.data.clips.map((c) => c.id));
    V.data.clips = data;
    await V.db.clear('clips');
    await V.db.putMany('clips', data);
    V.emit('data', 'clips');
    const fresh = data.filter((c) => !known.has(c.id));
    if (clipsChecked && fresh.length) V.emit('clip-in', fresh[0]);
    clipsChecked = true;
  }

  async function pullSettings() {
    const { data, error, status } = await sb.from('settings').select('*').maybeSingle();
    if (error) throw Object.assign(error, { status });
    if (data && !V.data.settings._dirty) {
      V.data.settings = data;
      await V.db.meta('settings', data);
      V.emit('data', 'settings');
    }
  }

  async function push() {
    if (pushing) { pushAgain = true; return pushing; }
    pushing = (async () => {
      do {
        pushAgain = false;
        for (const table of ['folders', 'notes', 'transfers']) {
          const dirty = [...V.data[table].values()].filter((row) => row._dirty);
          for (const row of dirty.filter((r) => r._purge)) {
            const { error } = await sb.from(table).delete().eq('id', row.id);
            if (error) throw error;
            V.data[table].delete(row.id);
            await V.db.del(table, row.id);
            V.emit('data', table);
          }
          const sending = dirty.filter((r) => !r._purge && r._refused !== r._dirty);
          for (let i = 0; i < sending.length; i += 50) {
            const chunk = sending.slice(i, i + 50);
            const body = chunk.map((row) => Object.fromEntries(FIELDS[table].map((f) => [f, f in row ? row[f] : BLANK[f]])));
            const data = await send(table, chunk, body);
            const settled = [];
            for (const sent of data) {
              const before = chunk.find((r) => r.id === sent.id);
              const now = V.data[table].get(sent.id);
              if (!now || now._dirty !== before._dirty) continue;  // changed again meanwhile: send that next
              settled.push({ ...sent, _edited: now._edited });
            }
            await keep(table, settled, { fromCloud: false });
          }
        }
        if (V.data.settings._dirty) {
          const { _dirty, ...values } = V.data.settings;
          const sent = Object.fromEntries(['pin_salt', 'pin_check', 'extra'].filter((f) => f in values).map((f) => [f, values[f]]));
          const { data, error, status } = await sb.from('settings').upsert(sent).select().single();
          if (error) throw Object.assign(error, { status });
          if (V.data.settings._dirty === _dirty) {
            V.data.settings = data;
            await V.db.meta('settings', data);
          }
        }
      } while (pushAgain);
    })().finally(() => { pushing = null; });
    return pushing;
  }

  /* One bulk upsert; if the cloud refuses it (not a network or sign-in problem), each row on its own, so a row it
     won't take (a note over its size limit) is set aside until it's changed again instead of stopping all sync. */
  async function send(table, chunk, body) {
    const { data, error, status } = await sb.from(table).upsert(body).select();
    if (!error) return data;
    const failed = Object.assign(error, { status });
    if (chunk.length === 1 || authError(failed) || offlineError(failed) || !(status >= 400 && status < 500)) throw failed;
    const taken = [];
    for (let i = 0; i < chunk.length; i++) {
      const one = await sb.from(table).upsert([body[i]]).select();
      if (!one.error) { taken.push(...one.data); continue; }
      const err = Object.assign(one.error, { status: one.status });
      if (authError(err) || offlineError(err) || !(one.status >= 400 && one.status < 500)) throw err;
      const row = V.data[table].get(chunk[i].id);
      if (row && row._dirty === chunk[i]._dirty) {
        row._refused = row._dirty;
        await V.db.put(table, row);
      }
      console.warn('Vault: the cloud refused a row', table, chunk[i].id, err.message);
      V.toast(table === 'notes' ? `"${chunk[i].title || 'A note'}" couldn't be saved to the cloud: it's too big. ` +
        'Make it shorter and it goes up.' : 'Something couldn\'t be saved to the cloud.', { kind: 'err', ms: 8000 });
    }
    return taken;
  }

  const pushSoon = V.debounce(() => sync({ pullFirst: false }), 700);

  let syncing = null;
  let syncAgain = false;
  async function sync({ pullFirst = true } = {}) {
    if (!sb) return;
    if (syncing) { syncAgain = true; return syncing; }
    syncing = (async () => {
      setStatus('syncing');
      try {
        if (pullFirst) {
          for (const table of SYNCED) await pull(table);
          await pullClips();
          await pullSettings();
        }
        await push();
        await emptyTrash();
        setStatus('synced');
      } catch (error) {
        if (authError(error)) { setStatus('signed-out'); V.emit('signed-out'); return; }
        setStatus(await whyNot(error));
        if (!offlineError(error)) console.warn('Vault sync:', error);
      }
    })().finally(() => {
      syncing = null;
      if (syncAgain) {  // something was saved while this one ran: send it now, not at the next check
        syncAgain = false;
        setTimeout(() => sync({ pullFirst: false }), 0);
      }
    });
    return syncing;
  }

  /* Offline, the free cloud asleep (a week unused), or something else. A sleeping project's error page has no
     CORS headers, so the page only sees "Failed to fetch": the PC app asks from Python, which can tell. */
  async function whyNot(error) {
    if (/paused|\b540\b/i.test(String(error && (error.message || error))) || (error && error.status === 540)) return 'asleep';
    if (!navigator.onLine) return 'offline';
    if (V.desktop) {
      const health = await V.pc.call('health').catch(() => ({}));
      if (health.state === 'asleep' || health.state === 'offline') return health.state;
    }
    return offlineError(error) ? 'offline' : 'error';
  }

  async function emptyTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    for (const note of V.data.notes.values()) {
      if (note.deleted && !note._dirty && note.deleted_at && new Date(note.deleted_at).getTime() < cutoff) {
        await purgeNote(note);
      }
    }
  }

  async function purgeNote(note) {
    const files = (note.attachments || []).map((a) => a.path).filter(Boolean);
    if (files.length) await remove(files).catch(() => {});
    await save('notes', { ...note, _purge: true });
  }

  function listen() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('vault-' + V.device + '-' + Math.random().toString(36).slice(2, 8));
    for (const table of ['notes', 'folders', 'transfers', 'clips']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (change) => arrived(table, change));
    }
    channel.subscribe((state) => {
      live = state === 'SUBSCRIBED';
      if (live) sync();
      schedule();
    });
  }

  async function arrived(table, change) {
    if (table === 'clips') {
      if (change.eventType !== 'INSERT') return;
      const clip = change.new;
      if (V.data.clips.some((c) => c.id === clip.id)) return;
      V.data.clips = [clip, ...V.data.clips].slice(0, 30);
      await V.db.put('clips', clip);
      V.emit('data', 'clips');
      V.emit('clip-in', clip);
      return;
    }
    if (change.eventType === 'DELETE') {
      const id = change.old && change.old.id;
      if (id && V.data[table].has(id)) {
        V.data[table].delete(id);
        await V.db.del(table, id);
        V.emit('data', table);
      }
      return;
    }
    // Realtime leaves out big values (a row over about 1 MB): fetch those the usual way instead.
    if ((change.errors && change.errors.length) || (table === 'notes' && !('body' in (change.new || {})))) {
      sync();
      return;
    }
    const changed = await keep(table, [change.new]);
    if (table === 'transfers') V.emit('transfers-in', changed.filter((t) => !t.deleted));
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { sync(); schedule(); }, live ? POLL_LIVE : POLL_OFFLINE);
  }

  /* -- files */

  async function upload(path, blob, { mime, onProgress } = {}) {
    const token = await accessToken();
    const address = `${config.url}/storage/v1/object/vault/${path.split('/').map(encodeURIComponent).join('/')}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', address);
      xhr.setRequestHeader('apikey', config.key);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.setRequestHeader('Content-Type', mime || blob.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => { if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = 'The upload didn\'t work (' + xhr.status + ').';
        try { message = JSON.parse(xhr.responseText).message || message; } catch (e) { /* not JSON */ }
        if (/maximum allowed size|too large|payload/i.test(message)) message = 'That file is over 50 MB, the most the free cloud takes.';
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('No internet: it\'ll go when you\'re back online.'));
      xhr.send(blob);
    });
  }

  async function link(path, { download } = {}) {
    const known = links.get(path + '|' + (download || ''));
    if (known && known.until > Date.now()) return known.url;
    const { data, error } = await sb.storage.from('vault').createSignedUrl(path, 3600, download ? { download } : undefined);
    if (error) throw error;
    links.set(path + '|' + (download || ''), { url: data.signedUrl, until: Date.now() + 3000000 });
    return data.signedUrl;
  }

  /* A small file (a note's picture), from this device's copy when it has one. */
  async function blob(path) {
    const kept = await V.db.get('files', path);
    if (kept) return kept.blob;
    const response = await fetch(await link(path));
    if (!response.ok) throw new Error('Couldn\'t load that picture.');
    const got = await response.blob();
    if (got.size < 6 * 1024 * 1024) await V.db.put('files', { key: path, blob: got, at: Date.now() });
    return got;
  }

  async function remove(paths) {
    if (!paths.length) return;
    const { error } = await sb.storage.from('vault').remove(paths);
    if (error) throw error;
  }

  /* -- signing in and out */

  async function user() {
    if (V.desktop) {
      const answer = await V.pc.call('config');
      return answer.signedIn ? { id: answer.userId, email: answer.email } : null;
    }
    const { data } = await sb.auth.getSession();
    if (data.session) {
      const who = { id: data.session.user.id, email: data.session.user.email };
      try { localStorage.setItem('vault-user', JSON.stringify(who)); } catch (e) { /* private mode */ }
      return who;
    }
    // Offline with a session that ran out while the phone was away: still signed in, just can't renew yet.
    try {
      if (localStorage.getItem('vault-auth') && localStorage.getItem('vault-user')) return JSON.parse(localStorage.getItem('vault-user'));
    } catch (e) { /* private mode */ }
    return null;
  }

  async function signIn(email, password) {
    if (V.desktop) {
      await V.pc.call('signIn', { email, password });
    } else {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        throw new Error(/invalid login/i.test(error.message) ? 'That e-mail or password isn\'t right.' : error.message);
      }
    }
    V.data.user = await user();
  }

  async function signOut() {
    try {
      if (channel) sb.removeChannel(channel);
      if (V.desktop) await V.pc.call('signOut');
      else await sb.auth.signOut({ scope: 'local' });
    } finally {
      await V.db.wipe();
      try { localStorage.removeItem('vault-auth'); localStorage.removeItem('vault-user'); } catch (e) { /* private mode */ }
    }
  }

  /* How many changes made here haven't reached the cloud yet (signing out would throw them away). */
  async function unsent() {
    let count = (await V.db.all('outgoing')).length + (V.data.settings._dirty ? 1 : 0);
    for (const table of SYNCED) count += [...V.data[table].values()].filter((row) => row._dirty).length;
    return count;
  }

  async function changePassword(password) {
    if (V.desktop) return V.pc.call('changePassword', { password });
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
  }

  /* Shows this device's copy at once; the returned promise is the first sync with the cloud. */
  async function start() {
    await loadLocal();
    window.addEventListener('online', () => sync());
    window.addEventListener('offline', () => setStatus('offline'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    listen();
    schedule();
    return { firstSync: sync() };
  }

  return {
    client, start, sync, save, keep, push, upload, link, blob, remove, purgeNote, user, signIn, signOut,
    changePassword, accessToken, unsent,
    get sb() { return sb; },
    get status() { return status; },
    get live() { return live; },
    async saveSettings(values) {
      V.data.settings = { ...V.data.settings, ...values, _dirty: Date.now() };
      await V.db.meta('settings', V.data.settings);
      pushSoon();
    },
    async insertClip(text) {
      const row = { id: V.uuid(), text, from_device: V.device, created_at: new Date().toISOString() };
      const { data, error, status } = await sb.from('clips').insert({ id: row.id, text, from_device: V.device }).select().single();
      if (error) throw Object.assign(error, { status });
      if (!V.data.clips.some((c) => c.id === data.id)) V.data.clips = [data, ...V.data.clips].slice(0, 30);
      await V.db.put('clips', data);
      V.emit('data', 'clips');
      return data || row;
    },
  };
})();
