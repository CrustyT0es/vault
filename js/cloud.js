/* Vault: keeping this device and the cloud in step.

   Everything shows from this device's copy first (V.data, saved in V.db), so the app opens at once and works
   offline. A change made here is saved here with _dirty set, then sent (push). Changes from elsewhere come in by
   Supabase Realtime as they happen, and by asking for "everything since" (pull) on start, every so often, and when
   the app comes back to the front: rows carry the cloud's own updated_at, so nothing is missed. A row changed here
   and not sent yet always wins over the cloud's copy until it's sent.

   Notes are sent only if the cloud still has the version they were changed from (_base_at, its updated_at): when
   another device (or Jarvis) got there first, the two are put together line by line (V.mergeLines, from _base, the
   version both started from) and that is sent instead; where both changed the very same lines (or a locked note's
   sealed words), this device's stay and the other version is kept as a "(conflict copy)" note beside it. So two
   devices typing in one note at once both keep their words. Folders and files: the last device to send wins.

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
  // What every PC app since Vault 1.0 answers. A newer one lists its calls in config's `can` (calls are only ever
  // added, never taken away: tests/test_vault_desktop.py keeps this list), so a page newer than its PC app can ask
  // V.pc.can() before using one.
  const BRIDGE_V1 = ['appReady', 'quietClipboard', 'config', 'token', 'health', 'signIn', 'signOut', 'changePassword',
    'setUp', 'saveFile', 'openFile', 'showFile', 'openLink', 'setClipboard', 'notify', 'setPref', 'pickFolder'];
  let calls = BRIDGE_V1;
  return {
    ready,
    call,
    can: (name) => calls.includes(name),
    knows: (config) => { if (config && Array.isArray(config.can)) calls = config.can; },
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
  // What a note changed here also keeps, for putting it together with another device's change (never sent):
  // _base / _base_at = the cloud's version it was changed from, _theirs = a newer cloud version that came meanwhile,
  // _merged / _mine = a token for the last time another device's words were put in here, and this device's version
  // just before (so a save from a copy older than that keeps them: see carryBase).
  const NOTE_LOCAL = ['_base', '_base_at', '_theirs', '_merged', '_mine'];
  const MOST_TRIES = 4;
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
  // Rows the cloud set aside (a note too big to go up): the status is honest about them ('held') instead of a plain
  // 'synced', and clears as soon as they're changed, removed or finally accepted.
  const heldCount = () => SYNCED.reduce((n, table) => n + [...V.data[table].values()]
    .filter((row) => row._refused && row._refused === row._dirty && !row._purge).length, 0);
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
      if (fromCloud && here && here._dirty) {
        // Ours isn't sent yet, so it stays; a newer note from the cloud is kept aside to be put together with it.
        if (table === 'notes' && newer(row, here) && !(here._theirs && here._theirs.updated_at >= row.updated_at)) {
          const waiting = { ...here, _theirs: row };
          map.set(row.id, waiting);
          await V.db.put(table, waiting);
        }
        continue;
      }
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

  /* A change made on this device: shown and saved at once, sent soon after. `quiet` (a note whose flash cards moved
     on, js/review.js): when nothing else in it changed, it isn't an edit, so it keeps its place in the lists. */
  async function save(table, row, { quiet = false } = {}) {
    let stamped = { ...row, _dirty: stamp(), _edited: new Date().toISOString() };
    if (table === 'notes') {
      const here = V.data.notes.get(row.id);
      if (quiet && here && !here._purge && notePrint(stamped) === notePrint(here)) {
        const was = V.editedAt(here) || stamped._edited;
        stamped._edited = was;
        stamped.extra = { ...(stamped.extra || {}), edited_at: was, edited_print: notePrint(stamped) };
      }
      stamped = carryBase(stamped, here, row);
    }
    await put(table, stamped);
    pushSoon();
    return stamped;
  }

  /* -- when a note was last edited

     The lists sort by it and say it ("2 min ago"): this device's own last change (_edited), else the cloud's
     updated_at. The cloud's moves on with any change, a flash card's progress too, so a quiet save also writes the
     time the note had into extra.edited_at, with a print of everything in the note but its flash cards
     (extra.edited_print): the other devices go by that time for as long as the print still matches, and by the
     cloud's again as soon as the note really changes, wherever that was. History (js/history.js) only ever looks at
     the title and the words, so cards moving on never make a copy either. */
  const QUIET_KEYS = new Set(['cards', 'edited_at', 'edited_print']);
  const prints = new WeakMap();
  function notePrint(row) {
    if (prints.has(row)) return prints.get(row);
    const extra = Object.fromEntries(Object.entries(row.extra || {}).filter(([key]) => !QUIET_KEYS.has(key)));
    const text = stable([row.title || '', row.locked ? row.secret || '' : row.body || '', row.folder_id || null,
      !!row.pinned, row.due || null, !!row.done, !!row.locked, !!row.deleted, row.template || '',
      (row.attachments || []).map((a) => (a && (a.path || a.id)) || ''), extra]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    const print = h.toString(36) + '.' + text.length.toString(36);
    prints.set(row, print);
    return print;
  }
  V.editedAt = (row) => (!row ? '' : row._edited
    || (row.extra && row.extra.edited_at && row.extra.edited_print === notePrint(row) ? row.extra.edited_at : '')
    || row.updated_at || row.created_at || '');

  async function put(table, row) {
    V.data[table].set(row.id, row);
    await V.db.put(table, row);
    V.emit('data', table);
  }

  const stamp = () => Date.now() + Math.random();

  /* -- notes changed on two devices at once */

  /* jsonb comes back from the cloud with its keys in another order: compared with them sorted. */
  const sortedKeys = (v) => (Array.isArray(v) ? v.map(sortedKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v);
  const stable = (v) => JSON.stringify(sortedKeys(v === undefined ? null : v));
  const fieldsOf = (row) => Object.fromEntries(FIELDS.notes.map((f) => [f, f in row ? row[f] : BLANK[f]]));
  const newer = (row, here) => !!row.updated_at && row.updated_at > (here._base_at || here.updated_at || '');

  /* The version a note changed here was changed from: the cloud's, when it wasn't changed here before; else what it
     already had. A save from a copy older than another device's words put in here (the open note, saved before it
     heard of them) keeps those words: the save's changes go in on top. */
  function carryBase(next, here, given) {
    for (const key of NOTE_LOCAL) delete next[key];
    if (!here || here._purge) return next;
    if (!here._dirty) {
      if (here.updated_at) { next._base = fieldsOf(here); next._base_at = here.updated_at; }
      return next;
    }
    for (const key of NOTE_LOCAL) if (key in here) next[key] = here[key];
    if (!here._merged) return next;
    if (given._merged === here._merged) {  // saved from a copy that has them: nothing more to do
      delete next._merged;
      delete next._mine;
      return next;
    }
    if (!here._mine || next._purge) return next;
    const { row } = combine(here._mine, fieldsOf(next), fieldsOf(here));
    return { ...next, ...row, _mine: fieldsOf(next) };
  }

  /* Each setting kept in `extra` as this device changed it, else as theirs. Flash cards (extra.cards) one card at a
     time, so cards studied on both devices at once all keep their progress. */
  function mergeExtra(start, mine, theirs, top = true) {
    const was = start || {};
    const now = mine || {};
    const out = { ...(theirs || {}) };
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (stable(was[key]) === stable(now[key])) continue;
      if (top && key === 'cards' && isObject(now.cards) && isObject(out.cards)) out.cards = mergeExtra(was.cards, now.cards, out.cards, false);
      else if (key in now) out[key] = now[key];
      else delete out[key];
    }
    return out;
  }
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  /* A note's pictures, files, memos and drawings, each kept unless one side removed it, and each side's new ones added
     (this device's first). */
  function mergeFiles(start, mine, theirs) {
    const id = (a) => (a && (a.path || a.id)) || stable(a);
    const was = new Map((start || []).map((a) => [id(a), a]));
    const there = new Map((theirs || []).map((a) => [id(a), a]));
    const here = new Set((mine || []).map(id));
    const out = [];
    for (const a of mine || []) {
      const key = id(a);
      if (was.has(key) && !there.has(key)) continue;  // removed on the other device
      const changedThere = there.has(key) && stable(there.get(key)) !== stable(was.get(key));
      out.push(changedThere && stable(a) === stable(was.get(key)) ? there.get(key) : a);
    }
    for (const a of theirs || []) if (!was.has(id(a)) && !here.has(id(a))) out.push(a);
    return out;
  }

  /* `mine` and `theirs`, both changed from `base`: each field as the side that changed it has it, the title and words
     put together line by line. `clash`: both changed the very same lines (or a locked note's sealed words, which
     can't be put together), where this device's stay. */
  function combine(base, mine, theirs) {
    const changed = (r, f) => stable(r[f]) !== stable(base[f]);
    const row = {};
    for (const f of FIELDS.notes) row[f] = changed(mine, f) ? mine[f] : theirs[f];
    row.id = mine.id;
    row.extra = mergeExtra(base.extra, mine.extra, theirs.extra);
    row.attachments = mergeFiles(base.attachments, mine.attachments, theirs.attachments);
    let clash = false;
    if (changed(mine, 'title') && changed(theirs, 'title') && mine.title !== theirs.title) {
      const titles = V.mergeLines(base.title || '', mine.title || '', theirs.title || '');
      row.title = titles.text.replace(/\n+/g, ' ');
      clash = titles.conflict;
    }
    const words = (r) => (r.locked ? 'sealed:' + (r.secret || '') : 'plain:' + (r.body || ''));
    const mineWords = words(mine) !== words(base);
    const theirWords = words(theirs) !== words(base);
    const from = mineWords ? mine : theirs;
    Object.assign(row, { locked: !!from.locked, secret: from.secret || null, body: from.body || '' });
    if (mineWords && theirWords && words(mine) !== words(theirs)) {
      if (!mine.locked && !theirs.locked && !base.locked) {
        const merged = V.mergeLines(base.body || '', mine.body || '', theirs.body || '');
        row.body = merged.text;
        clash = clash || merged.conflict;
      } else {
        clash = true;
      }
    }
    return { row, clash };
  }

  /* This device's version of note `id` put together with the cloud's newer `theirs`, saved here to be sent (based on
     theirs now). Returns it, or null when there's nothing to send any more. */
  async function mergeIn(id, theirs) {
    const now = V.data.notes.get(id);
    if (!now || !now._dirty || now._purge) return null;
    const base = now._base || fieldsOf(theirs);  // (changed before Vault kept that: this device's version wins)
    const { row, clash } = combine(base, fieldsOf(now), fieldsOf(theirs));
    const merged = { ...now, ...row, updated_at: theirs.updated_at, _base: fieldsOf(theirs), _base_at: theirs.updated_at,
      _merged: V.uuid(), _mine: now._merged && now._mine ? now._mine : fieldsOf(now), _dirty: stamp() };
    delete merged._theirs;
    await put('notes', merged);
    if (clash) await conflictCopy(now, theirs);
    return merged;
  }

  /* The other device's version, kept whole as a note of its own beside this one. */
  async function conflictCopy(mine, theirs) {
    const name = (theirs.title || '').trim() || (V.noteTitle ? V.noteTitle(theirs) : '') || 'Untitled';
    const title = `${name} (conflict copy)`.slice(0, 200);
    const copy = { ...fieldsOf(theirs), id: V.uuid(), title, pinned: false, attachments: [], template: '', deleted: false,
      deleted_at: null, extra: { conflict_of: mine.id, conflict_at: new Date().toISOString() },
      _dirty: stamp(), _edited: new Date().toISOString() };
    await put('notes', copy);
    pushAgain = true;
    V.emit('conflict', { id: mine.id, copy: copy.id });
    V.toast(`"${name}" was changed on two devices at once. Both versions are kept: the other one is in "${title}".`,
      { ms: 9000 });
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
          // Notes the cloud already has go one by one, each only if it still has their version; the rest in bulk.
          const known = table === 'notes' ? sending.filter((r) => r._base_at || r.updated_at) : [];
          const fresh = sending.filter((r) => !known.includes(r));
          for (let i = 0; i < fresh.length; i += 50) {
            const chunk = fresh.slice(i, i + 50);
            const body = chunk.map((row) => Object.fromEntries(FIELDS[table].map((f) => [f, f in row ? row[f] : BLANK[f]])));
            await settle(table, chunk, await send(table, chunk, body));
          }
          for (let i = 0; i < known.length; i += 6) {  // a few at a time (moving a folder's worth of notes)
            await Promise.all(known.slice(i, i + 6).map((row) => pushNote(row.id)));
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

  /* What the cloud took back: kept as sent (unless changed again meanwhile: then that's sent next, made from this). */
  async function settle(table, chunk, data) {
    const settled = [];
    const after = [];
    for (const sent of data) {
      const before = chunk.find((r) => r.id === sent.id);
      const now = V.data[table].get(sent.id);
      if (!now || !before) continue;
      if (now._dirty !== before._dirty) {
        if (table === 'notes' && !now._purge) {
          const next = { ...now, _base: fieldsOf(sent), _base_at: sent.updated_at, updated_at: sent.updated_at };
          if (next._theirs && !newer(next._theirs, next)) delete next._theirs;
          V.data.notes.set(sent.id, next);
          await V.db.put('notes', next);
        }
        continue;
      }
      settled.push({ ...sent, _edited: now._edited });
      if (now._theirs && now._theirs.updated_at > sent.updated_at) after.push(now._theirs);  // came after ours
    }
    await keep(table, settled, { fromCloud: false });
    if (after.length) await keep(table, after);
  }

  /* One note the cloud already has, sent only if the cloud still has the version it was changed from (one request).
     If not, the cloud's version is fetched and put together with this one, and that goes instead. */
  async function pushNote(id) {
    for (let tries = 0; tries < MOST_TRIES; tries++) {
      let row = V.data.notes.get(id);
      if (!row || !row._dirty || row._purge || row._refused === row._dirty) return;
      if (row._theirs && newer(row._theirs, row)) {
        row = await mergeIn(id, row._theirs);
        if (!row) return;
      }
      const values = fieldsOf(row);
      delete values.id;
      const { data, error, status } = await sb.from('notes').update(values).eq('id', id)
        .eq('updated_at', row._base_at || row.updated_at).select();
      if (error) { await refused('notes', row, Object.assign(error, { status })); return; }
      if (data && data.length) { await settle('notes', [row], data); return; }
      const got = await sb.from('notes').select('*').eq('id', id).maybeSingle();
      if (got.error) throw Object.assign(got.error, { status: got.status });
      if (!got.data) {  // gone from the cloud (emptied from the Trash elsewhere): put back, words and all
        await settle('notes', [row], await send('notes', [row], [fieldsOf(row)]));
        return;
      }
      if (!(await mergeIn(id, got.data))) return;
    }
  }

  /* A row the cloud won't take (a note over its size check) is set aside until it's changed again; a network or
     sign-in problem stops this round instead. */
  async function refused(table, row, err) {
    if (authError(err) || offlineError(err) || !(err.status >= 400 && err.status < 500)) throw err;
    const now = V.data[table].get(row.id);
    if (now && now._dirty === row._dirty) {
      const aside = { ...now, _refused: now._dirty };
      V.data[table].set(row.id, aside);
      await V.db.put(table, aside);
    }
    console.warn('Vault: the cloud refused a row', table, row.id, err.message);
    V.toast(table === 'notes' ? `"${row.title || 'A note'}" couldn't be saved to the cloud: it's too big. ` +
      'Make it shorter and it goes up.' : 'Something couldn\'t be saved to the cloud.', { kind: 'err', ms: 8000 });
  }

  /* One bulk upsert; if the cloud refuses it (not a network or sign-in problem), each row on its own, so a row it
     won't take (a note over its size limit) is set aside until it's changed again instead of stopping all sync. */
  async function send(table, chunk, body) {
    const { data, error, status } = await sb.from(table).upsert(body).select();
    if (!error) return data;
    const failed = Object.assign(error, { status });
    if (authError(failed) || offlineError(failed) || !(status >= 400 && status < 500)) throw failed;
    if (chunk.length === 1) { await refused(table, chunk[0], failed); return []; }
    const taken = [];
    for (let i = 0; i < chunk.length; i++) {
      const one = await sb.from(table).upsert([body[i]]).select();
      if (!one.error) { taken.push(...one.data); continue; }
      await refused(table, chunk[i], Object.assign(one.error, { status: one.status }));
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
        setStatus(heldCount() ? 'held' : 'synced');
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
    const files = (note.attachments || []).flatMap((a) => [a.path, a.preview]).filter(Boolean);  // (a drawing has two)
    if (files.length) await remove(files).catch(() => {});
    if (V.history) await V.history.forget(note.id).catch(() => {});  // its older versions go with it
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
    V.on('back', () => sync());
    listen();
    schedule();
    return { firstSync: sync() };
  }

  return {
    client, start, sync, save, keep, push, upload, link, blob, remove, purgeNote, user, signIn, signOut,
    changePassword, accessToken, unsent, mergeExtra, notePrint,
    get sb() { return sb; },
    get status() { return status; },
    get held() { return heldCount(); },
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
