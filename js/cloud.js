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
   devices typing in one note at once both keep their words. A plain version never goes over one locked on another
   device (1.22.5): the two go together sealed, with the PIN, which is asked for when it isn't unlocked here (the
   change waits here until then). Folders and files: the last device to send wins.

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
  // Vault on its own (config.standalone, vault/standalone): no Jarvis on this PC, so a newer PC part comes as a new
  // Vault ZIP, and AI keys are pasted in Settings > AI as on a phone (js/ai.js).
  let standalone = false;
  return {
    ready,
    call,
    can: (name) => calls.includes(name),
    knows: (config) => {
      if (config && Array.isArray(config.can)) calls = config.can;
      standalone = !!(config && config.standalone);
    },
    standalone: () => standalone,
    howToUpdate: () => (standalone
      ? 'Get the newest Wefty from the person who invited you, unzip it and double-click its setup-wefty.bat.'
      : 'Open Jarvis and click Update: Wefty comes with it.'),
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
  // just before (so a save from a copy older than that keeps them: see carryBase), _sent = a new note as it was sent
  // the first time, while no answer has said whether the cloud took it (see sendNew).
  const NOTE_LOCAL = ['_base', '_base_at', '_theirs', '_merged', '_mine', '_sent'];
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
  const forgotten = new Map();  // note id -> the note as it was when it was forgotten here, deleted for good (see save)
  // The settings row as the cloud has it, read since this page started (each sync reads it first of all). Until then
  // V.data.settings is only this device's copy, or nothing at all on a new or wiped device, so a choice that hangs on
  // it ("Use Claude too", js/ai.js) waits for this (settingsReady) instead of taking "nothing" for "off".
  let settingsRead = false;
  // The last try at reading it failed (offline, the cloud asleep or not answering): a wait for it then ends at once, or
  // with a fresh try (settingsReady), never sits out its whole time for a row that can't come.
  let settingsFailed = false;
  let readingSettings = false;  // a sync that reads it is under way
  const settingsWaiters = new Set();
  const SETTING_FIELDS = ['pin_salt', 'pin_check', 'extra'];
  V.on('signed-out', () => { settingsRead = false; settingsFailed = false; });

  const setStatus = (value) => { if (value !== status) { status = value; V.emit('status', value); } };
  // Rows the cloud set aside (a note too big to go up): the status is honest about them ('held') instead of a plain
  // 'synced', and clears as soon as they're changed, removed or finally accepted.
  const heldCount = () => SYNCED.reduce((n, table) => n + [...V.data[table].values()]
    .filter((row) => row._refused && row._refused === row._dirty && !row._purge).length, 0);
  const offlineError = (error) => !navigator.onLine || /fetch|network|load failed|timed? ?out/i.test(String(error && (error.message || error)));
  const authError = (error) => error && (error.kind === 'signed-out' || error.status === 401 ||
    /JWT|refresh token|not authenticated|signed out/i.test(error.message || ''));

  /* (1.22.5) The sign-in kept here ('vault-auth', supabase-js's session) belongs to the cloud whose sign-in service
     made it, and its access token says which: 'iss', https://<ref>.supabase.co/auth/v1. A client made for any other
     cloud never gets it, so a saved cloud changed under someone signed in (before 1.22.5 a #connect= link could do
     that, from any web page) can't send their sign-in there: that cloud just sees nobody signed in, and the sign-in
     stays kept for its own cloud. A token that names no cloud by its address can't be told apart, and is kept as
     before. Nothing stored changes. */
  function issuerOf(text) {
    try {
      const session = typeof text === 'string' ? JSON.parse(text) : text;
      const part = String((session && session.access_token) || '').split('.')[1] || '';
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4)));
      return claims && typeof claims.iss === 'string' ? claims.iss : '';
    } catch (error) {
      return '';
    }
  }
  const originOf = (url) => { try { return new URL(String(url)).origin; } catch (error) { return ''; } };
  /* Whether a kept session (its text, or the object) may go to the cloud at `url`. */
  function madeBy(session, url) {
    const iss = issuerOf(session);
    if (!/^https?:\/\//i.test(iss)) return true;
    return !!originOf(url) && originOf(iss) === originOf(url);
  }
  /* The kept session's text when it belongs to `url` (or names no cloud), else null. */
  function keptFor(url) {
    let text = null;
    try { text = localStorage.getItem('vault-auth'); } catch (error) { return null; }
    return text && madeBy(text, url) ? text : null;
  }
  /* localStorage as supabase-js sees it for the cloud at `url`: another cloud's session isn't there. */
  const storageFor = (url) => ({
    getItem: (key) => {
      const value = localStorage.getItem(key);
      return key === 'vault-auth' && value && !madeBy(value, url) ? null : value;
    },
    setItem: (key, value) => { localStorage.setItem(key, value); },
    removeItem: (key) => { localStorage.removeItem(key); },
  });

  function client(cfg) {
    // The same cloud asked for again on the web (js/doors.js made its client before the start got here): the one
    // already made, so a session never has two clients renewing it (each renewal uses the last one's token up).
    if (sb && !V.desktop && config && config.url === cfg.url && config.key === cfg.key) {
      config = cfg;
      return sb;
    }
    config = cfg;
    const options = { realtime: { params: { eventsPerSecond: 5 } }, global: { headers: { 'x-vault': V.VERSION } } };
    if (V.desktop) options.accessToken = () => V.pc.token();
    else {
      options.auth = { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'vault-auth',
        storage: storageFor(cfg.url) };
    }
    sb = window.supabase.createClient(cfg.url, cfg.key, options);
    return sb;
  }

  async function accessToken() {
    if (V.desktop) return V.pc.token();
    // (offline: no waiting on a renewal that can't happen; what needed it goes once the internet's back, as ever)
    if (!navigator.onLine && kept()) throw new Error('Failed to fetch (offline)');
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session.access_token;
    // An expired session can't be renewed offline, but it's still kept: only a real sign-out is one.
    if (!navigator.onLine || keptFor(config && config.url)) throw new Error('Failed to fetch (offline)');
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
        // Ours isn't sent yet, so it stays; a newer note from the cloud is kept aside to be put together with it (one
        // deleted for good elsewhere too: whether ours outlives that is decided as it's sent, see mergeIn).
        if (table === 'notes' && newer(row, here) && !(here._theirs && here._theirs.updated_at >= row.updated_at)) {
          const waiting = { ...here, _theirs: row };
          map.set(row.id, waiting);
          await V.db.put(table, waiting);
        }
        continue;
      }
      if (table === 'notes' && isBuried(row)) {  // deleted for good on another device: forgotten here too (DATA-02)
        if (here) await forget(here);
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
      if (!here && forgotten.has(row.id)) {
        // Deleted for good elsewhere, and saved here from a copy something still held (the open note, a flash card's
        // progress): only new words, a new title or new files bring it back, as for a change that hadn't gone up
        // (madeHere); anything else leaves it gone.
        const was = forgotten.get(row.id);
        if (!madeHere(stamped, was)) return stamped;
        stamped._base = was;
        forgotten.delete(row.id);
      }
    }
    // (sent soon even when this device couldn't keep it, its storage full: it's in memory, and would wait for the next
    // look otherwise, DATA-24)
    try { await put(table, stamped); } finally { pushSoon(); }
    return stamped;
  }

  /* -- when a note was last edited

     The lists sort by it and say it ("2 min ago"): this device's own last change (_edited), else the cloud's
     updated_at. The cloud's moves on with any change, a flash card's progress too, so a quiet save also writes the
     time the note had into extra.edited_at, with a print of everything in the note but its flash cards
     (extra.edited_print): the other devices go by that time for as long as the print still matches, and by the
     cloud's again as soon as the note really changes, wherever that was. History (js/history.js) only ever looks at
     the title and the words, so cards moving on never make a copy either. */
  // (checkin: after a test, how it went, js/checkin.js: asked and answered quietly, never an edit)
  // (quiz: Test me's wrong choices made by the AI, js/learn.js: kept quietly, never an edit)
  // (after_test: whether a finished test's cards keep coming or rest, js/review.js: kept quietly, never an edit)
  const QUIET_KEYS = new Set(['cards', 'edited_at', 'edited_print', 'checkin', 'quiz', 'after_test']);
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
     time, so cards studied on both devices at once all keep their progress (and Test me's wrong choices, extra.quiz). */
  function mergeExtra(start, mine, theirs, top = true) {
    const was = start || {};
    const now = mine || {};
    const out = { ...(theirs || {}) };
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (stable(was[key]) === stable(now[key])) continue;
      if (top && (key === 'cards' || key === 'quiz') && isObject(now[key]) && isObject(out[key])) out[key] = mergeExtra(was[key], now[key], out[key], false);
      // (after a test, js/checkin.js: an answer given on the other device beats "asked" from this one)
      else if (top && key === 'checkin' && isObject(out.checkin) && out.checkin.mood && !(isObject(now.checkin) && now.checkin.mood)) continue;
      // (after a test, js/review.js: the answer as this device changed it, the decks kept from a menu deck by deck)
      else if (top && key === 'after_test' && isObject(now[key]) && isObject(out[key]) && now[key].day === out[key].day) {
        const base = isObject(was[key]) && was[key].day === now[key].day ? was[key] : {};
        const merged = mergeExtra({ ...base, woke: null }, { ...now[key], woke: null }, out[key], false);
        const woke = mergeExtra(isObject(base.woke) ? base.woke : {}, isObject(now[key].woke) ? now[key].woke : {},
          isObject(out[key].woke) ? out[key].woke : {}, false);
        if (Object.keys(woke).length) merged.woke = woke; else delete merged.woke;
        out[key] = merged;
      }
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

  /* A note's words as they're kept: a locked note's are its sealed ones. */
  const words = (r) => (r.locked ? 'sealed:' + (r.secret || '') : 'plain:' + (r.body || ''));

  /* (The review of 1.22.5) This device's plain words and a version locked on another device (or written into while
     locked there), both changed since `base` (or nothing known of where they started): they only go together sealed,
     with the PIN (sealTogether). A plain version never goes over a locked one: before, the plain words won, and a note
     locked on the PC was unlocked again, its words in plain, by an edit the phone had made offline. */
  const lockedThere = (base, mine, theirs) => !!theirs.locked && !mine.locked
    && (!base || (words(mine) !== words(base) && words(theirs) !== words(base)));

  /* `mine` and `theirs`, both changed from `base`: each field as the side that changed it has it, the title and words
     put together line by line. `clash`: both changed the very same lines (or a locked note's sealed words, which
     can't be put together), where this device's stay. `sealed` ({ secret, conflict }, sealTogether): the words both
     have, put together and sealed; without it, plain words never win over a locked version (lockedThere): its
     sealed words stay. A locked note never keeps Test me's questions and answers (extra.quiz: words in plain). */
  function combine(base, mine, theirs, sealed = null) {
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
    const mineWords = words(mine) !== words(base);
    const theirWords = words(theirs) !== words(base);
    if (sealed) {
      Object.assign(row, { locked: true, secret: sealed.secret, body: '' });
      clash = clash || sealed.conflict;
      return { row: noQuiz(row), clash };
    }
    const from = mineWords && !lockedThere(base, mine, theirs) ? mine : theirs;
    Object.assign(row, { locked: !!from.locked, secret: from.secret || null, body: from.body || '' });
    if (from === mine && mineWords && theirWords && words(mine) !== words(theirs)) {
      if (!mine.locked && !theirs.locked && !base.locked) {
        const merged = V.mergeLines(base.body || '', mine.body || '', theirs.body || '');
        row.body = merged.text;
        clash = clash || merged.conflict;
      } else {
        clash = true;
      }
    }
    return { row: noQuiz(row), clash };
  }
  function noQuiz(row) {
    if (row.locked && row.extra && 'quiz' in row.extra) {
      const { quiz, ...rest } = row.extra;
      row.extra = rest;
    }
    return row;
  }

  /* `mine` and `theirs` with nothing known about where they started (a new note a Wefty before 1.22.5 sent, whose
     answer was lost): neither wins in silence. This device's version stays in the note, with the other's files too, and
     when their title or words differ the other version is kept whole beside it (`clash`: a conflict copy, which says
     so). `sealed`: this device's words, sealed, as the other version is locked (lockedThere). */
  function bothKept(mine, theirs, sealed = null) {
    const row = { ...mine, extra: mergeExtra({}, mine.extra, theirs.extra),
      attachments: mergeFiles([], mine.attachments, theirs.attachments) };
    if (sealed) Object.assign(row, { locked: true, secret: sealed.secret, body: '' });
    return { row: noQuiz(row), clash: words(mine) !== words(theirs) || (mine.title || '') !== (theirs.title || '') };
  }

  /* This device's plain words and the other version's locked ones (lockedThere) put together and sealed with the PIN,
     while it's unlocked here: { secret, conflict } (conflict: both changed the very same lines, where this device's
     stay, the other version kept whole beside it). Null when it isn't unlocked here, or the other version can't be
     opened with it (sealed with a PIN this device doesn't know): then this device's words wait here (waitForPin). */
  async function sealTogether(base, mine, theirs) {
    if (!V.lock || !V.lock.unlocked()) return null;
    try {
      const open = async (row) => (row.locked ? JSON.parse(await V.lock.decrypt(row.secret)).body || '' : row.body || '');
      const theirText = await open(theirs);
      const mineText = await open(mine);
      const merged = base ? V.mergeLines(await open(base), mineText, theirText) : { text: mineText, conflict: mineText !== theirText };
      return { secret: await V.lock.encrypt(JSON.stringify({ body: merged.text })), conflict: !!merged.conflict };
    } catch (error) {
      return null;
    }
  }

  /* Locked on another device, and the PIN isn't unlocked here: this device's change stays here, unsent (never plain over
     the lock), with the locked version beside it (_theirs), until the PIN is typed (askPin): the next sync then seals
     them together. Counted as held ('held': js/profile.js says so, with Type PIN). */
  const pinAsked = new Set();  // (the notes it was said for on this page: once each)
  async function waitForPin(now, theirs) {
    // (kept here once: each later sync finds it waiting as it was, and leaves it be)
    if (now._pinWait !== now._dirty || !now._theirs || now._theirs.updated_at !== theirs.updated_at) {
      await put('notes', { ...now, _theirs: theirs, _pinWait: now._dirty });
    }
    if (!pinAsked.has(now.id)) {
      pinAsked.add(now.id);
      const name = V.noteTitle ? V.noteTitle(theirs) : (theirs.title || '').trim() || 'A note';
      V.toast(`"${name}" was locked on your other device. Type your PIN so the changes you made here go into it.`,
        { action: 'Type PIN', onAction: () => { askPin().catch(V.problem); }, ms: 12000 });
    }
    return null;
  }
  const pinCount = () => [...V.data.notes.values()]
    .filter((row) => row._pinWait && row._pinWait === row._dirty && !row._purge).length;

  /* The PIN typed here (5 tries, then the wrong-PIN wait, as in the editor): the notes waiting for it go up, sealed. */
  async function askPin() {
    for (let tries = 0; tries < 5; tries++) {
      if (V.lock.waitLeft()) { V.toast(V.lock.waitSaid(), { kind: 'err', ms: 6000 }); return false; }
      const pin = await V.lock.askPin({ title: tries ? 'Wrong PIN, try again' : 'Enter your PIN',
        hint: pinCount() ? 'Your changes to a note locked on your other device go into it, locked.' : '' });
      if (!pin) return false;
      if (await V.lock.unlock(pin)) {
        pinAsked.clear();
        await sync();
        return true;
      }
    }
    V.toast(V.lock.waitSaid() || 'Too many tries.', { kind: 'err', ms: 6000 });
    return false;
  }

  /* This device's version of note `id` put together with the cloud's newer `theirs`, saved here to be sent (based on
     theirs now). Returns it, or null when there's nothing to send any more. Where both started from: what this device
     sent as a new note while no answer said the cloud had it (_sent, DATA-01: the cloud's version came from it), else
     the cloud's version this one was changed from (_base). */
  async function mergeIn(id, theirs) {
    const now = V.data.notes.get(id);
    if (!now || !now._dirty || now._purge) return null;
    if (isBuried(theirs)) {
      // Deleted for good on another device while this one had changes to it that hadn't gone up (DATA-17): new words,
      // a new title or files outlive that, sent whole over the emptied row; anything less leaves it deleted.
      if (!madeHere(now)) { await forget(now); return null; }
      const extra = { ...(now.extra || {}) };
      delete extra.purged;
      const mine = { ...now, extra, updated_at: theirs.updated_at, _base: fieldsOf(theirs), _base_at: theirs.updated_at,
        _dirty: stamp() };
      delete mine._theirs;
      delete mine._sent;
      await put('notes', mine);
      keptAfterDelete(mine);
      return mine;
    }
    const base = now._sent || now._base || null;
    // (the review of 1.22.5) Locked on another device: this device's plain words only go into it sealed, with the PIN.
    let sealed = null;
    if (lockedThere(base, fieldsOf(now), fieldsOf(theirs))) {
      sealed = await sealTogether(base, fieldsOf(now), fieldsOf(theirs));
      if (!sealed) return waitForPin(now, theirs);
      if (V.data.notes.get(id) !== now) return null;  // (changed here meanwhile: the next try puts that together)
    }
    const { row, clash } = base ? combine(base, fieldsOf(now), fieldsOf(theirs), sealed)
      : bothKept(fieldsOf(now), fieldsOf(theirs), sealed);
    const merged = { ...now, ...row, updated_at: theirs.updated_at, _base: fieldsOf(theirs), _base_at: theirs.updated_at,
      _merged: V.uuid(), _mine: now._merged && now._mine ? now._mine : fieldsOf(now), _dirty: stamp() };
    delete merged._theirs;
    delete merged._sent;
    delete merged._pinWait;
    await put('notes', merged);
    if (clash) await conflictCopy(now, theirs);
    if (sealed) {
      const name = V.noteTitle ? V.noteTitle(merged) : (merged.title || '').trim() || 'A note';
      V.toast(`"${name}" was locked on your other device, so it's locked here too, with your changes in it.`, { ms: 8000 });
    }
    return merged;
  }

  /* -- notes deleted for good

     Delete forever empties a note's row in the cloud instead of removing it (bury): its title, words, files and
     settings go, it stays deleted, marked extra.purged. A device that wasn't listening then hears of it with the other
     changes and forgets the note too (keep), so nothing it does later can send it back (DATA-02). A Wefty before 1.22.5
     shows it as an empty note in its Trash and empties it after its 30 days, as it does any; one that had changes to
     it that hadn't gone up puts them together with the emptied row, and what it added then shows in the Trash on every
     device (a row with words or files in it is never taken for an emptied one). An older Wefty removes the row itself:
     a device that wasn't listening learns of that from the cloud's list of notes (checkGone). */
  const buried = (at) => ({ folder_id: null, title: '', body: '', pinned: false, due: null, done: false, locked: false,
    secret: null, attachments: [], template: '', deleted: true, deleted_at: at, extra: { purged: at } });
  const isBuried = (row) => !!row && row.deleted === true && !!(row.extra && row.extra.purged)
    && !String(row.title || '').trim() && !row.body && !row.secret && !(row.attachments || []).length;
  const filesOf = (row) => (row.attachments || []).flatMap((a) => [a && a.path, a && a.preview]).filter(Boolean);

  /* A note deleted for good: gone from this device too, with the pictures it kept of it and its History copies that
     hadn't gone up. */
  async function forget(row) {
    if (!V.data.notes.has(row.id)) return;
    forgotten.set(row.id, fieldsOf(row));
    V.data.notes.delete(row.id);
    await V.db.del('notes', row.id);
    for (const path of filesOf(row)) await V.db.del('files', path).catch(() => {});
    if (V.history) await V.history.forget(row.id, { cloud: false }).catch(() => {});
    V.emit('data', 'notes');
  }

  /* Whether this device changed a note's words, title or files, or put it back from the Trash, since `base` (the
     version it was changed from): what a delete for good on another device mustn't take with it (DATA-17). A flash
     card's progress, a pin or a move isn't. Nothing known of that version: as if so. */
  function madeHere(now, base = now._sent || now._base) {
    if (!base) return true;
    const key = (a) => (a && (a.path || a.id)) || stable(a);
    const had = new Set((base.attachments || []).map(key));
    return words(now) !== words(base) || (now.title || '') !== (base.title || '') || (!!base.deleted && !now.deleted)
      || (now.attachments || []).some((a) => !had.has(key(a)));
  }

  function keptAfterDelete(row) {
    const name = V.noteTitle ? V.noteTitle(row) : (row.title || '').trim() || 'A note';
    V.toast(`"${name}" was deleted on another device, but it had new changes here, so it's kept.`, { ms: 9000 });
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

  /* Every row of `table` changed since the last look, oldest first, a page at a time, paged on (updated_at, id): one
     statement stamps every row it changes with the same time (vault/schema.sql's now()), so a page that ends inside
     such a run goes on with the rest of that time by id before the next time. Paged on the time alone, more than a
     page of rows sharing one were read again and again and nothing after them ever came, while it said "synced"
     (DATA-12). True when it stopped at its most pages: the rest comes with another look straight after. */
  const PAGE = 500;  // (under the cloud's own cap on the rows one answer has: Supabase's is 1000)
  async function pull(table) {
    const sinceKey = 'since:' + table;
    const since = await V.db.meta(sinceKey);
    // (10 s back: a row written in a transaction that began before the newest one seen, and ended after it, is
    // stamped with that earlier time)
    const from = since ? new Date(new Date(since).getTime() - 10000).toISOString() : '1970-01-01T00:00:00Z';
    let newest = since || null;
    let after = null;  // the last time read whole: the next page starts past it
    const take = async (data) => {
      const changed = await keep(table, data);
      if (table === 'transfers') V.emit('transfers-in', changed.filter((t) => !t.deleted));
    };
    const rows = async (asked) => {
      const { data, error, status } = await asked;
      if (error) throw Object.assign(error, { status });
      return data;
    };
    for (let page = 0; page < 80; page++) {
      const ask = sb.from(table).select('*');
      const data = await rows((after ? ask.gt('updated_at', after) : ask.gte('updated_at', from))
        .order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(PAGE));
      await take(data);
      if (!data.length) break;
      const last = data[data.length - 1];
      newest = last.updated_at;
      if (data.length < PAGE) break;
      for (let id = last.id; ;) {  // the rest stamped with the same time as the page's last row, by id
        const tied = await rows(sb.from(table).select('*').eq('updated_at', last.updated_at).gt('id', id)
          .order('id', { ascending: true }).limit(PAGE));
        await take(tied);
        if (tied.length < PAGE) break;
        id = tied[tied.length - 1].id;
      }
      after = last.updated_at;
      if (page === 79) {  // (the most pages for one look: kept, and another look follows)
        await V.db.meta(sinceKey, newest);
        return true;
      }
    }
    if (newest) await V.db.meta(sinceKey, newest);
    return false;
  }

  /* Notes a Wefty before 1.22.5 deleted for good while this device wasn't listening: it removes the row, so nothing
     about it comes in with the changes. So at the first sync after starting, and every 6 hours after, the cloud is
     asked which notes it has (their ids alone), and a note this device had from it, with nothing here waiting to go
     up, that isn't there any more is forgotten here too (DATA-02). Only after the whole list came back: a page that
     can't be had leaves everything as it was. */
  const LIST_EVERY = 6 * 3600000;
  let listedAt = -Infinity;
  async function checkGone() {
    if (performance.now() - listedAt < LIST_EVERY) return;
    const had = [...V.data.notes.values()].filter((row) => row.updated_at && !row._dirty);
    const there = new Set();
    let after = '';
    for (let page = 0; had.length; page++) {
      if (page >= 200) return;  // (200,000 notes: not a whole list)
      let ask = sb.from('notes').select('id').order('id', { ascending: true }).limit(1000);
      if (after) ask = ask.gt('id', after);
      const { data, error, status } = await ask;
      if (error) throw Object.assign(error, { status });
      if (!data.length) break;
      for (const row of data) there.add(row.id);
      after = data[data.length - 1].id;
    }
    listedAt = performance.now();
    // (no notes at all, while this device has some the cloud gave it: rather the wrong cloud than everything deleted)
    if (!there.size) return;
    for (const row of had) if (!there.has(row.id) && V.data.notes.get(row.id) === row) await forget(row);
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

  /* The settings columns changed here and not sent yet: the ones saveSettings was given (`_send`), else (a copy left
     dirty by a Vault before 1.9, when only a PIN ever made it so) the PIN's two. Never extra unless it was given:
     extra is changed straight in the cloud (changeExtra), and this device's copy of it may be old. */
  const unsentSettings = (here) => (Array.isArray(here._send) && here._send.length ? here._send : ['pin_salt', 'pin_check'])
    .filter((f) => SETTING_FIELDS.includes(f) && f in here);

  function settingsArrived() {
    settingsRead = true;
    settingsFailed = false;
    for (const done of [...settingsWaiters]) done(true);
  }

  /* The settings row as the cloud has it, kept here: what's changed here and not sent yet (a new PIN) stays; everything
     else is the cloud's (extra too). */
  async function keepSettings(data) {
    const here = V.data.settings || {};
    const mine = here._dirty ? Object.fromEntries(unsentSettings(here).map((f) => [f, here[f]])) : null;
    V.data.settings = mine ? { ...data, ...mine, _dirty: here._dirty, _send: Object.keys(mine) } : data;
    await V.db.meta('settings', V.data.settings);
    V.emit('data', 'settings');
  }

  async function pullSettings() {
    const { data, error, status } = await sb.from('settings').select('*').maybeSingle();
    if (error) throw Object.assign(error, { status });
    if (data) await keepSettings(data);
    settingsArrived();
  }

  /* One change to the settings row's extra (changeExtra), made only on the version of it just read: written with
     "if the cloud still has updated_at = what was read" (settings_touch moves it on every write), so another device's
     change landing in between (a tally, "Use Claude too") is read again and kept, never written over. A read that
     fails writes nothing: this device's copy may be old, or empty on a new device, and must never replace the
     cloud's. */
  async function writeExtra(change, signal) {
    for (let tries = 0; tries < MOST_TRIES; tries++) {
      if (signal.aborted) throw lateExtra();
      const read = await sb.from('settings').select('extra, updated_at').maybeSingle().abortSignal(signal);
      if (signal.aborted) throw lateExtra();
      if (read.error) throw Object.assign(read.error, { status: read.status });
      const have = read.data;
      // (no row yet: a new account. This device's copy is all there is of it, if anything.)
      const merged = change({ ...((have ? have.extra : (V.data.settings || {}).extra) || {}) });
      const wrote = have
        ? await sb.from('settings').update({ extra: merged }).eq('updated_at', have.updated_at).select().maybeSingle()
          .abortSignal(signal)
        : await sb.from('settings').insert({ extra: merged }).select().maybeSingle().abortSignal(signal);
      if (signal.aborted) throw lateExtra();
      if (wrote.error) {
        if (!have && (wrote.status === 409 || wrote.error.code === '23505')) continue;  // made elsewhere meanwhile
        throw Object.assign(wrote.error, { status: wrote.status });
      }
      if (!wrote.data) continue;  // changed elsewhere since it was read: read again
      heard(wrote.data.updated_at);
      await keepSettings(wrote.data);
      settingsArrived();
      return wrote.data.extra || merged;
    }
    throw new Error('Your settings were being changed on another device at the same moment. Try again.');
  }
  /* -- the locked notes' PIN (1.22.5)

     The PIN's two columns (pin_salt, pin_check: js/lock.js) seal every locked note, so they're only ever written on
     the lock row as the cloud has it right now, and only if it still has the PIN this device started from (`from`:
     the salt it was unlocked with, null for a first PIN). Before 1.22.5 they went up by a plain upsert: a device that
     was offline (or hadn't read the row) made a "new" PIN whose salt replaced the cloud's, and every note locked with
     the old one could never be opened again (SEC-04, DATA-11). A changed PIN keeps the one it replaces in
     extra.pin_old (its salt and check, the newest 5), written in the same request: a note still sealed with it (sent
     late by a device that was offline) still opens with the old PIN (js/lock.js). Older Weftys never read pin_old and
     keep it (they change extra on the newest copy, or not at all). Nothing else about the lock changes. */
  const PIN_OLD = 5;
  const offlinePin = () => Object.assign(new Error('Connect to the internet first: Wefty checks your cloud for a PIN you '
    + 'already have before it sets one.'), { kind: 'offline' });
  async function setPin(values, { from = null } = {}) {
    if (!V.desktop && !navigator.onLine) throw offlinePin();
    for (let tries = 0; tries < MOST_TRIES; tries++) {
      const read = await sb.from('settings').select('*').maybeSingle();
      if (read.error) throw Object.assign(read.error, { status: read.status });
      const have = read.data;
      const salt = (have && have.pin_salt) || null;
      if (salt !== (from || null)) {
        if (have) await tookCloudPin(have);
        throw Object.assign(new Error(from
          ? 'Your PIN was changed on another device first. Unlock with that one, then change it again if you like.'
          : 'You have a PIN already (set on another device). Use that one.'), { kind: 'pin-changed' });
      }
      let wrote;
      if (have) {
        const change = { pin_salt: values.pin_salt, pin_check: values.pin_check };
        if (from) {
          const extra = { ...(have.extra || {}) };
          const kept = (Array.isArray(extra.pin_old) ? extra.pin_old : [])
            .filter((one) => one && one.salt !== from && one.salt !== values.pin_salt);
          extra.pin_old = [...kept, { salt: from, check: have.pin_check, at: new Date().toISOString() }].slice(-PIN_OLD);
          change.extra = extra;
        }
        wrote = await sb.from('settings').update(change).eq('updated_at', have.updated_at).select().maybeSingle();
      } else {
        wrote = await sb.from('settings').insert({ pin_salt: values.pin_salt, pin_check: values.pin_check }).select().maybeSingle();
      }
      if (wrote.error) {
        if (!have && (wrote.status === 409 || wrote.error.code === '23505')) continue;  // made elsewhere meanwhile
        throw Object.assign(wrote.error, { status: wrote.status });
      }
      if (!wrote.data) continue;  // changed elsewhere since it was read: read again
      await tookCloudPin(wrote.data);
      return wrote.data;
    }
    throw new Error('Your settings were being changed on another device at the same moment. Try again.');
  }
  /* The lock row as the cloud has it, kept here (any PIN made here and not sent is the cloud's no more: see
     unsentPin). */
  async function tookCloudPin(row) {
    const here = V.data.settings || {};
    const send = Array.isArray(here._send) ? here._send.filter((f) => f !== 'pin_salt' && f !== 'pin_check') : [];
    const mine = here._dirty && send.length ? Object.fromEntries(send.filter((f) => f in here).map((f) => [f, here[f]])) : null;
    V.data.settings = mine ? { ...row, ...mine, _dirty: here._dirty, _send: send } : row;
    await V.db.meta('settings', V.data.settings);
    settingsArrived();
    V.emit('data', 'settings');
  }
  /* A PIN made here by a Wefty before 1.22.5 and never sent (made offline): sent only if the cloud has none yet. If it
     has one, the cloud's stays, and this one is kept here (meta 'pin-orphans'), so the notes locked with it here still
     open with it (js/lock.js) and are sealed again with the cloud's PIN once they are. The row as the cloud has it. */
  async function unsentPin(salt, check) {
    if (!salt || !check) return null;
    try {
      return await setPin({ pin_salt: salt, pin_check: check });
    } catch (error) {
      if (error.kind !== 'pin-changed') throw error;
      const kept = (await V.db.meta('pin-orphans').catch(() => null)) || [];
      if (!kept.some((one) => one.salt === salt)) await V.db.meta('pin-orphans', [...kept, { salt, check }].slice(-PIN_OLD));
      // ... and in the cloud's pin_old too: the notes it locked here (sent before this) open on every device with it.
      await changeExtra((extra) => ({ ...extra, pin_old: [...(Array.isArray(extra.pin_old) ? extra.pin_old : [])
        .filter((one) => one && one.salt !== salt), { salt, check, at: new Date().toISOString() }].slice(-PIN_OLD) }))
        .catch((failed) => console.warn('Wefty: an earlier PIN kept here only', failed));
      V.toast('You set a PIN on another device too. Wefty keeps that one: the notes you locked here open with the PIN '
        + 'you used here, then they switch to it.', { ms: 10000 });
      return V.data.settings;
    }
  }

  // One at a time on this device too (a tally written while "Use Claude too" is switched): each starts once the one
  // before has finished. supabase-js never gives up on a request by itself, so each change has `waits.extra` ms in all
  // (its reads, writes and tries again): past that its requests are stopped and it fails as any change that couldn't
  // reach the cloud does (the tally keeps the cost owed, a switch goes back and says so), and the next one goes. One
  // hung request on stalled mobile data used to hold every later change (a switch stayed greyed out for minutes).
  let extraChain = Promise.resolve();
  // (renew: how long the start waits for the cloud to renew a sign-in before showing the notes from the kept one)
  const waits = { extra: 20000, renew: 2000 };  // (tests shorten them)
  const lateExtra = () => Object.assign(new Error('The cloud didn\'t answer in time, so that setting wasn\'t changed. '
    + 'Try again in a moment.'), { kind: 'offline', late: true });

  function changeExtra(change) {
    const run = extraChain.catch(() => {}).then(() => timedExtra(change));
    extraChain = run;
    return run;
  }

  /* writeExtra(change), given waits.extra ms: its requests are stopped once they're up (an aborted request that had
     already reached the cloud may still land: a later read of the row shows it), and it rejects with lateExtra. */
  function timedExtra(change) {
    const stop = new AbortController();
    let timer = null;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => { stop.abort(); reject(lateExtra()); }, waits.extra);
    });
    return Promise.race([writeExtra(change, stop.signal), late]).finally(() => clearTimeout(timer));
  }

  async function push() {
    if (pushing) { pushAgain = true; return pushing; }
    pushing = (async () => {
      do {
        pushAgain = false;
        for (const table of ['folders', 'notes', 'transfers']) {
          const dirty = [...V.data[table].values()].filter((row) => row._dirty);
          for (const row of dirty.filter((r) => r._purge)) {
            if (table === 'notes') { await bury(row); continue; }
            const { error } = await sb.from(table).delete().eq('id', row.id);
            if (error) throw error;
            V.data[table].delete(row.id);
            await V.db.del(table, row.id);
            V.emit('data', table);
          }
          const sending = dirty.filter((r) => !r._purge && r._refused !== r._dirty && !resting(table, r));
          // Notes the cloud already has (or a version of which came from it: _theirs) go one by one, each only if it
          // still has their version; new ones go as new rows, never over one it has (sendNew); the rest in bulk.
          const known = table === 'notes' ? sending.filter((r) => r._base_at || r.updated_at || r._theirs) : [];
          const fresh = sending.filter((r) => !known.includes(r));
          if (table === 'notes') {
            known.push(...(await sendNew(fresh)).map((id) => V.data.notes.get(id)).filter(Boolean));
          } else {
            for (let i = 0; i < fresh.length; i += 50) {
              const chunk = fresh.slice(i, i + 50);
              const body = chunk.map((row) => Object.fromEntries(FIELDS[table].map((f) => [f, f in row ? row[f] : BLANK[f]])));
              await settle(table, chunk, await send(table, chunk, body));
            }
          }
          for (let i = 0; i < known.length; i += 6) {  // a few at a time (moving a folder's worth of notes)
            await Promise.all(known.slice(i, i + 6).map((row) => pushNote(row.id)));
          }
        }
        if (V.data.settings._dirty) {
          // Only the columns changed here: the rest of the row (extra's "Use Claude too" and the AI tally, which
          // another device may have changed since this one last looked) stays as the cloud has it.
          const { _dirty } = V.data.settings;
          const sent = Object.fromEntries(unsentSettings(V.data.settings).map((f) => [f, V.data.settings[f]]));
          let data = null;
          // (1.22.5) A PIN made here by an older Wefty and never sent: never over the cloud's (unsentPin).
          if ('pin_salt' in sent || 'pin_check' in sent) {
            data = await unsentPin(sent.pin_salt, sent.pin_check);
            delete sent.pin_salt;
            delete sent.pin_check;
          }
          if (Object.keys(sent).length) {
            const answer = await sb.from('settings').upsert(sent).select().single();
            if (answer.error) throw Object.assign(answer.error, { status: answer.status });
            data = answer.data;
            heard(data && data.updated_at);
          }
          if (V.data.settings._dirty === _dirty) {
            if (data) V.data.settings = data;
            else { const { _dirty: _, _send, ...rest } = V.data.settings; V.data.settings = rest; }
            await V.db.meta('settings', V.data.settings);
            if (data) V.emit('data', 'settings');
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
      heard(sent.updated_at);  // (what the cloud stamped it with: its time now)
      later.delete(table + ':' + sent.id);  // (it went: a later turn-down starts its wait over)
      const before = chunk.find((r) => r.id === sent.id);
      const now = V.data[table].get(sent.id);
      if (!now || !before) continue;
      if (now._dirty !== before._dirty) {
        if (table === 'notes' && !now._purge) {
          const next = { ...now, _base: fieldsOf(sent), _base_at: sent.updated_at, updated_at: sent.updated_at };
          delete next._sent;  // (the cloud has it: its own version is known now)
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
      if (!row || !row._dirty || row._purge || row._refused === row._dirty || resting('notes', row)) return;
      if (row._theirs && newer(row._theirs, row)) {
        row = await mergeIn(id, row._theirs);
        if (!row) return;
      }
      if (!row._base_at && !row.updated_at) {  // (no version of it the cloud has is known here: as a new note)
        if (!(await sendNew([row])).length) return;
        continue;
      }
      const values = fieldsOf(row);
      delete values.id;
      const { data, error, status } = await sb.from('notes').update(values).eq('id', id)
        .eq('updated_at', row._base_at || row.updated_at).select();
      if (error) { await refused('notes', row, Object.assign(error, { status })); return; }
      if (data && data.length) { await settle('notes', [row], data); return; }
      const got = await sb.from('notes').select('*').eq('id', id).maybeSingle();
      if (got.error) throw Object.assign(got.error, { status: got.status });
      if (!got.data) {
        // Gone from the cloud: deleted for good on a Wefty before 1.22.5, which removes the row. New words, a new
        // title or files here put it back, words and all (DATA-17); anything less leaves it deleted.
        if (!madeHere(row)) { await forget(row); return; }
        if (!(await sendNew([row])).length) { keptAfterDelete(row); return; }
        continue;  // (it was back already: put together with that)
      }
      if (!(await mergeIn(id, got.data))) return;
    }
  }

  /* A note deleted for good here: its row emptied in the cloud (see buried), then forgotten here. */
  async function bury(row) {
    const swept = row._purge === 'swept';  // (by the Trash's own 30 days, not asked for)
    const at = new Date(cloudNow() || Date.now()).toISOString();
    // Only the version this device last saw there (DATA-06): one put back or changed on another device since stays.
    const seen = row._base_at || row.updated_at;
    if (seen && await buryIf(row.id, at, seen, swept)) { await afterBurial(row); return; }
    const got = await sb.from('notes').select('*').eq('id', row.id).maybeSingle();
    if (got.error) throw Object.assign(got.error, { status: got.status });
    const there = got.data;
    if (!there || isBuried(there)) { await afterBurial(row); return; }  // (deleted for good elsewhere already)
    // The cloud has what this device has (a change of its own whose answer was lost), or a new note's first send
    // (DATA-01) that's in the Trash there too: still the one being deleted.
    const mine = notePrint(there) === notePrint(row) || (!!row._sent && notePrint(there) === notePrint(row._sent))
      || (!seen && there.deleted);
    if (mine) {
      if (await buryIf(row.id, at, there.updated_at, swept)) await afterBurial(row);
      return;  // (else changed again this very moment: the next look decides)
    }
    // Put back or changed on another device since: kept, as the cloud has it, and said.
    if (V.data.notes.get(row.id) === row) await put('notes', there);
    if (!swept) {
      V.toast(`"${V.noteTitle ? V.noteTitle(there) : (there.title || 'A note')}" was changed on another device, so it `
        + 'wasn\'t deleted.', { ms: 8000 });
    }
  }

  /* The note's row emptied in the cloud (see buried), only if it still has updated_at `seen` (and, swept by the
     Trash's 30 days, is still in the Trash there). True when it was. */
  async function buryIf(id, at, seen, swept) {
    let ask = sb.from('notes').update(buried(at)).eq('id', id).eq('updated_at', seen);
    if (swept) ask = ask.eq('deleted', true);
    const { data, error, status } = await ask.select('id, updated_at');
    if (error) throw Object.assign(error, { status });
    if (!data || !data.length) return false;
    heard(data[0].updated_at);
    return true;
  }

  /* Once its row is emptied: the note's files and History go (only then: a delete that didn't happen takes nothing
     with it, DATA-06), and it's forgotten here. Offline, the next look does it again. */
  async function afterBurial(row) {
    try {
      const files = filesOf(row);
      if (files.length) await remove(files);
      if (V.history) await V.history.forget(row.id);
    } catch (error) {
      if (offlineError(error) || authError(error)) throw error;
      console.warn('Wefty: a deleted note\'s files', error);
    }
    if (V.data.notes.get(row.id) === row) await forget(row);
  }

  /* New notes (DATA-01): each goes up as a new row, never over one the cloud already has. A first send whose answer
     was lost may have reached the cloud all the same, and another device may have written in that note since: so what
     goes is kept here first (_sent), and after a try that got no answer, the cloud is asked before trying again. A
     note it turns out to have is kept beside its version there (_theirs), to be put together from _sent by pushNote.
     Returns the ids of those. */
  async function sendNew(rows) {
    const there = [];
    const unsure = rows.filter((r) => r._sent);
    for (let i = 0; i < unsure.length; i += 50) there.push(...await lookUp(unsure.slice(i, i + 50).map((r) => r.id)));
    const first = rows.filter((r) => !there.includes(r.id));
    for (let i = 0; i < first.length; i += 50) {
      const chunk = await goingNow(first.slice(i, i + 50));
      const taken = await send('notes', chunk, chunk.map(fieldsOf), { fresh: true });
      await settle('notes', chunk, taken);
      const left = chunk.filter((r) => !taken.some((t) => t.id === r.id)).map((r) => V.data.notes.get(r.id))
        .filter((now) => now && now._dirty && !now._purge && now._refused !== now._dirty && !resting('notes', now))
        .map((now) => now.id);
      if (left.length) there.push(...await lookUp(left));  // (not taken: the cloud had it already)
    }
    return there;
  }

  /* The cloud's own version of each of these notes it has, kept beside this device's (_theirs). Returns their ids. */
  async function lookUp(ids) {
    const { data, error, status } = await sb.from('notes').select('*').in('id', ids);
    if (error) throw Object.assign(error, { status });
    await keep('notes', data);
    return data.map((row) => row.id);
  }

  /* New notes about to go: what goes is kept with each first (_sent: see sendNew), so it's there if no answer comes. */
  async function goingNow(rows) {
    const marked = [];
    for (const row of rows) {
      const now = V.data.notes.get(row.id);
      if (!now) continue;
      const next = { ...now, _sent: fieldsOf(row) };
      V.data.notes.set(row.id, next);
      marked.push(next);
    }
    // (a device too full to keep it still sends: the words reach the cloud, and this page remembers what went)
    if (marked.length) await V.db.putMany('notes', marked).catch((error) => console.warn('Wefty: not kept here', error));
    return rows;
  }

  /* (1.22.5) Only a row the cloud truly can't take is set aside: one too big (413), or a 400 from its own checks
     (Postgres 23514, a check like a note's size; 22001, a value too long). Any other turn-down (402, 403, 404, 408,
     409, 429, another 400) is the cloud's trouble for now, not the row's: it stays to go up, tried again after a wait
     that grows (RETRY first 30 s, doubling to 30 min) and starts over once it goes. */
  const RETRY = { first: 30000, most: 30 * 60000 };
  const cantTake = (err) => !!err && (err.status === 413
    || (err.status === 400 && ['23514', '22001'].includes(String(err.code || ''))));
  const later = new Map();  // `${table}:${id}` -> { wait, until }: rows the cloud turned down for now
  let retryTimer = null;
  const resting = (table, row) => { const one = later.get(table + ':' + row.id); return !!one && one.until > Date.now(); };
  const restingCount = () => [...later.keys()].filter((key) => {
    const [table, ...id] = key.split(':');
    const row = V.data[table] && V.data[table].get(id.join(':'));
    return row && row._dirty && !row._purge;
  }).length;
  function tryLater(table, row) {
    const key = table + ':' + row.id;
    const before = later.get(key);
    const wait = before ? Math.min(before.wait * 2, RETRY.most) : RETRY.first;
    later.set(key, { wait, until: Date.now() + wait });
    const soonest = Math.min(...[...later.values()].map((one) => one.until).filter((at) => at > Date.now())) - Date.now();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; sync({ pullFirst: false }).catch(() => {}); }, Math.max(0, soonest) + 50);
  }

  /* A row the cloud won't take (a note over its size check) is set aside until it's changed again (cantTake); any
     other turn-down waits and goes again (tryLater); a network or sign-in problem stops this round instead. */
  async function refused(table, row, err) {
    if (authError(err) || offlineError(err) || !(err.status >= 400 && err.status < 500)) throw err;
    if (!cantTake(err)) {
      tryLater(table, row);
      console.warn('Wefty: the cloud turned a row down for now, trying again later', table, row.id, err.status);
      return;
    }
    later.delete(table + ':' + row.id);
    const now = V.data[table].get(row.id);
    if (now && now._dirty === row._dirty) {
      const aside = { ...now, _refused: now._dirty };
      V.data[table].set(row.id, aside);
      await V.db.put(table, aside);
    }
    console.warn('Vault: the cloud refused a row', table, row.id, err.message);
    V.toast(table === 'notes' ? `"${row.title || 'A note'}" couldn't be saved to the cloud: it's too big. ` +
      'Make it shorter and it goes up.' : 'Something couldn\'t be saved to the cloud.', { kind: 'err', ms: 8000,
      help: table === 'notes' ? 'too-big' : '' });  // (1.22: Help says what to do, js/help.js)
  }

  /* One bulk upsert; if the cloud refuses it (not a network or sign-in problem), each row on its own, so a row it
     won't take (a note over its size limit) is set aside until it's changed again instead of stopping all sync.
     `fresh`: new rows only (notes, sendNew): a row the cloud already has is left as it is there, and not answered. */
  async function send(table, chunk, body, { fresh = false } = {}) {
    const upsert = (rows) => sb.from(table).upsert(rows, fresh ? { ignoreDuplicates: true } : undefined).select();
    const { data, error, status } = await upsert(body);
    if (!error) return data;
    const failed = Object.assign(error, { status });
    if (authError(failed) || offlineError(failed) || !(status >= 400 && status < 500)) throw failed;
    if (chunk.length === 1) { await refused(table, chunk[0], failed); return []; }
    const taken = [];
    for (let i = 0; i < chunk.length; i++) {
      const one = await upsert([body[i]]);
      if (!one.error) { taken.push(...one.data); continue; }
      await refused(table, chunk[i], Object.assign(one.error, { status: one.status }));
    }
    return taken;
  }

  const pushSoon = V.debounce(() => sync({ pullFirst: false }), 700);
  /* Whether anything changed here is still to go up (what a send would send). */
  const waitingHere = () => !!(V.data.settings && V.data.settings._dirty)
    || SYNCED.some((table) => [...V.data[table].values()].some((row) => row._dirty && row._refused !== row._dirty));

  let syncing = null;
  let syncAgain = false;
  let pullAgain = false;  // a look stopped at its most pages: another one straight after
  async function sync({ pullFirst = true } = {}) {
    if (!sb) return;
    if (syncing) { syncAgain = true; return syncing; }
    // Only an answer from the cloud says "synced" (PLAT-16): a send with nothing to send asks nothing, so the state
    // stays as the last answer left it (it said "synced" offline), and with the browser offline nothing is tried (the
    // 'online' event brings the next look).
    if (!pullFirst && !waitingHere()) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    syncing = (async () => {
      setStatus('syncing');
      try {
        let more = false;
        if (pullFirst) {
          readingSettings = !settingsRead;
          await pullSettings();  // first: one small row, which the AI's choices wait for (a first sync can take a while)
          readingSettings = false;
          for (const table of SYNCED) if (await pull(table)) more = true;
          await checkGone().catch((error) => {  // (a look that didn't work is tried again at the next sync)
            if (authError(error) || offlineError(error)) throw error;
            console.warn('Wefty: couldn\'t list the notes', error);
          });
          await pullClips();
        }
        await push();
        await emptyTrash();
        // (never "synced" with rows still to come: the next look goes on at once)
        if (more) pullAgain = true;
        // (1.22.5: rows the cloud turned down for now aren't "synced": they wait for their next go)
        setStatus(more ? 'syncing' : heldCount() || pinCount() ? 'held' : restingCount() ? 'error' : 'synced');
      } catch (error) {
        if (readingSettings) {  // the settings couldn't be read: whatever waits for them goes on with this device's copy
          readingSettings = false;
          settingsFailed = true;
          for (const done of [...settingsWaiters]) done(false);
        }
        // (a kept sign-in the cloud turned down as it was renewed behind the app is gone: signed out, DATA-03)
        if (authError(error) || (!V.desktop && V.data.user && !kept())) { setStatus('signed-out'); V.emit('signed-out'); return; }
        setStatus(await whyNot(error));
        if (!offlineError(error)) console.warn('Vault sync:', error);
      }
    })().finally(() => {
      readingSettings = false;
      syncing = null;
      if (pullAgain) {  // (rows still to come: they're read now, and anything saved meanwhile goes with them)
        pullAgain = false;
        syncAgain = false;
        setTimeout(() => sync(), 0);
      } else if (syncAgain) {  // something was saved while this one ran: send it now, not at the next check
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

  /* -- the cloud's time

     What can't be undone goes by the cloud's clock, never this device's date (a phone set 40 days ahead for a game
     emptied everyone's Trash, DATA-05). Its time comes back with every write (updated_at is the cloud's now()) and
     is moved on by this page's own steady clock (performance.now(), which a changed date doesn't move). null until a
     write has come back since the page opened. */
  let cloudClock = null;  // { at: the cloud's time then (ms), mark: performance.now() then }
  const cloudNow = () => (cloudClock ? cloudClock.at + (performance.now() - cloudClock.mark) : null);
  function heard(time) {
    const at = Date.parse(time || '');
    if (!Number.isFinite(at)) return;
    const now = cloudNow();
    if (now === null || at > now) cloudClock = { at, mark: performance.now() };
  }

  /* Notes in the Trash 30 days by the cloud's time (since the cloud last stamped them: their updated_at) are deleted
     for good, each only if it's still as this device saw it (see bury). Until the cloud's time is known, the Trash
     waits. */
  async function emptyTrash() {
    const now = cloudNow();
    if (now === null) return;
    const cutoff = now - TRASH_DAYS * 86400000;
    for (const note of [...V.data.notes.values()]) {
      if (note.deleted && !note._dirty && note.updated_at && Date.parse(note.updated_at) < cutoff) {
        await purgeNote(note, { swept: true });
      }
    }
  }

  /* Deleted for good: its History copies not sent yet go at once (never sent now); its row is emptied in the cloud,
     then its files and History there go (bury). */
  async function purgeNote(note, { swept = false } = {}) {
    if (V.history) await V.history.forget(note.id, { cloud: false }).catch(() => {});
    await save('notes', { ...note, _purge: swept ? 'swept' : true });
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
      const here = id && V.data[table].get(id);
      if (!here) return;
      if (table === 'notes') {
        // (one with changes here that haven't gone up stays: sending it decides, as when it's found gone, DATA-17)
        if (!here._dirty) await forget(here);
        return;
      }
      V.data[table].delete(id);
      await V.db.del(table, id);
      V.emit('data', table);
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
        if (/maximum allowed size|too large|payload/i.test(message)) message = blob && blob.size > V.FILE_MOST ? V.fileOver('That file') : V.FILE_REFUSED;
        // (1.21: turned down because the person's own room for files is full? js/send.js's V.storage asks the cloud)
        if (V.storage && V.storage.isRefusal(xhr.status, message)) {
          V.storage.refused(new Error(message)).then(reject, () => reject(new Error(message)));
          return;
        }
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
    // (kept here unless big; a full device only goes without that copy, the picture still shows: DATA-10)
    if (got.size < 6 * 1024 * 1024) await V.db.put('files', { key: path, blob: got, at: Date.now() }).catch(() => {});
    return got;
  }

  async function remove(paths) {
    if (!paths.length) return;
    const { error } = await sb.storage.from('vault').remove(paths);
    if (error) throw error;
  }

  /* -- signing in and out */

  /* Who's signed in: { id, email }, plus invited (a friend's account in the owner's cloud: js/access.js) and name. */
  /* Who the account is in this cloud (1.21, V.who): the owner (app_metadata.wefty_owner, which only the cloud's
     admin side can set: the helper's set-up marks the owner's account), invited (an invite or a join QR code), or
     signed up by themselves (the Terms ticked, kept in user_metadata.terms, or an account made by Google). An account
     with none of these is a cloud's own from before 1.21, when nobody could sign up alone: its owner. Never from the
     list of linked sign-ins (the owner may add Google to theirs), only from how the account was made. */
  const whoOf = (meta, app) => {
    if (app.wefty_owner) return 'owner';
    if (meta.invited_by || app.vault_invited_by || app.vault_join) return 'invited';
    if (meta.terms || (app.provider && app.provider !== 'email')) return 'self';
    return 'owner';
  };
  const person = (account) => {
    const meta = (account && account.user_metadata) || {};
    const app = (account && account.app_metadata) || {};
    return { id: account.id, email: account.email, invited: !!(meta.invited_by || app.vault_invited_by),
      name: String(meta.name || '').slice(0, 60), who: whoOf(meta, app) };
  };

  /* The sign-in this device keeps (supabase-js's own copy, 'vault-auth'), as it is, without asking the cloud. Its hour
     may be up, and renewing it needs the cloud: 25 s or more offline (the library tries again and again), for ever on a
     wifi with no internet. null when there's none, and when the one kept is another cloud's (keptFor: never this
     cloud's sign-in). */
  function kept() {
    if (V.desktop) return null;
    try {
      const session = JSON.parse(keptFor(config && config.url) || 'null');
      return session && session.user && session.user.id && session.refresh_token ? session : null;
    } catch (error) { return null; }
  }

  async function user() {
    if (V.desktop) {
      const answer = await V.pc.call('config');
      return answer.signedIn ? { id: answer.userId, email: answer.email, invited: !!answer.invited,
        name: answer.name || '', ...(answer.who ? { who: answer.who } : {}) } : null;
    }
    // The notes show first (DATA-03): who's signed in comes from the kept sign-in, renewed behind the app. Online the
    // cloud is asked first, but never waited for long (waits.renew), so a sign-in it ended still goes straight to the
    // sign-in screen when it answers quickly; later, a sync finds that out (see sync).
    const session = kept();
    if (session) {
      const fresh = !navigator.onLine ? undefined : await Promise.race([
        sb.auth.getSession().then(({ data }) => data.session, () => undefined),
        new Promise((done) => setTimeout(done, waits.renew))]);
      if (fresh === null && !kept()) return null;  // (the cloud ended it: the library let it go)
      const who = person((fresh || session).user);
      try { localStorage.setItem('vault-user', JSON.stringify(who)); } catch (e) { /* private mode */ }
      return who;
    }
    const { data } = await sb.auth.getSession();
    if (data.session) {
      const who = person(data.session.user);
      try { localStorage.setItem('vault-user', JSON.stringify(who)); } catch (e) { /* private mode */ }
      return who;
    }
    // Offline with a session that ran out while the phone was away: still signed in, just can't renew yet. (Only a
    // session this cloud made: another cloud's isn't this one's sign-in.)
    try {
      if (keptFor(config && config.url) && localStorage.getItem('vault-user')) return JSON.parse(localStorage.getItem('vault-user'));
    } catch (e) { /* private mode */ }
    return null;
  }

  /* The password sign-in. On the web, a cloud that asks for a CAPTCHA (js/doors.js) gets a fresh token for each try;
     what went wrong keeps the cloud's own code and status (js/doors.js's words say it). */
  let codeUsed = '';  // (1.22.5) an invite's code this page signed in with (see signedInCode)
  async function signIn(email, password) {
    codeUsed = '';
    let used = password;
    if (V.desktop) {
      await V.pc.call('signIn', { email, password });
      used = V.inviteCode(password) || password;  // (the PC's Python takes it as the account has it)
    } else {
      const check = async () => ({ captchaToken: V.doors && V.doors.captcha ? await V.doors.captcha() : '' });
      let { error } = await sb.auth.signInWithPassword({ email: email.trim(), password, options: await check() });
      // An invite code typed as it's shown (k7qx-9mrt-2b): the account has it as K7QX9MRT2B (vault/invites.py).
      const code = V.inviteCode(password);
      if (error && /invalid login/i.test(error.message) && code && code !== password) {
        ({ error } = await sb.auth.signInWithPassword({ email: email.trim(), password: code, options: await check() }));
        used = code;
      }
      if (error) {
        const words = /invalid login/i.test(error.message) ? 'That e-mail or password isn\'t right.'
          : V.doors && V.doors.words ? V.doors.words(error) : error.message;
        throw Object.assign(new Error(words), { code: error.code || '', status: error.status || 0, name: error.name || 'Error' });
      }
    }
    if (V.inviteCode(password)) codeUsed = used;
    V.data.user = await user();
  }

  async function signOut() {
    V.emit('signing-out');  // (what else this device keeps for this person goes too: js/ai.js's list of Gemini models)
    try {
      if (channel) sb.removeChannel(channel);
      if (V.desktop) await V.pc.call('signOut');
      else await sb.auth.signOut({ scope: 'local' });
    } finally {
      await V.db.wipe();
      try { localStorage.removeItem('vault-auth'); localStorage.removeItem('vault-user'); } catch (e) { /* private mode */ }
    }
  }

  /* What signing out would throw away here (settings.js forgetHere wipes all of it), part by part: rows and the
     settings not sent, files sent but not gone up (outgoing), page photos or shared files waiting (js/capture.js),
     shares not taken in yet, the note-taker's recordings not written down yet (js/notetaker.js), chat messages
     waiting to send and chats not up yet (js/chat.js), a drawing not saved (js/ink.js), and History copies not up
     yet (js/history.js). */
  async function unsentParts() {
    const safe = async (fn) => { try { return Number(await fn()) || 0; } catch (error) { return 0; } };
    let changes = (await V.db.all('outgoing')).length + (V.data.settings._dirty ? 1 : 0);
    for (const table of SYNCED) changes += [...V.data[table].values()].filter((row) => row._dirty).length;
    if (V.capture && V.capture.waitingFiles) changes += await safe(() => V.capture.waitingFiles());
    changes += await safe(async () => (await V.db.all('shared')).length);
    return {
      changes,
      recordings: V.notetaker && V.notetaker.unsent ? await safe(() => V.notetaker.unsent()) : 0,
      chats: V.chat && V.chat.unsent ? await safe(() => V.chat.unsent()) : 0,
      drawing: await safe(async () => ((await V.db.meta('ink-draft')) ? 1 : 0)),
      history: V.history && V.history.unsent ? await safe(() => V.history.unsent()) : 0,
    };
  }
  async function unsent() {
    const parts = await unsentParts();
    return Object.values(parts).reduce((a, b) => a + b, 0);
  }

  /* -- "is it you?" (1.22.5, SEC-07)

     Before something that can't be undone (deleting the account, a new password), the person shows it's them: the
     account's password, checked with a sign-in of its own (a client that keeps it in memory, ended right after), so
     the one in use here is left as it is. An account with no password (made with Google), or one who forgot it, gets
     a code by e-mail instead (web only). On the PC, Python signs in again with it. Throws with words when it isn't. */
  let checking = null;  // the client a code was sent from, until it's typed
  function checkClient() {
    const held = new Map();
    const storage = { getItem: (key) => (held.has(key) ? held.get(key) : null), setItem: (key, value) => { held.set(key, String(value)); },
      removeItem: (key) => { held.delete(key); } };
    return window.supabase.createClient(config.url, config.key, { auth: { storage, storageKey: 'wefty-check',
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  const notYou = () => Object.assign(new Error('That isn\'t your password. Try again.'), { kind: 'not-you' });
  async function proved(temp, data) {
    const who = data && (data.user || (data.session && data.session.user));
    const me = V.data.user && V.data.user.id;
    temp.auth.signOut({ scope: 'local' }).catch(() => {});  // (that sign-in's job is done: ended at once)
    if (!who || !me || who.id !== me) throw notYou();
    return true;
  }
  async function checkPassword(password) {
    const email = String((V.data.user || {}).email || '');
    if (!password) throw notYou();
    if (V.desktop) {
      try { await V.pc.call('signIn', { email, password }); } catch (error) {
        if (/isn't right|invalid/i.test(error.message || '')) throw notYou();
        throw error;
      }
      return true;
    }
    const temp = checkClient();
    const captchaToken = V.doors && V.doors.captcha ? await V.doors.captcha() : '';
    const { data, error } = await temp.auth.signInWithPassword({ email, password, options: captchaToken ? { captchaToken } : {} });
    if (error) {
      if (/invalid login|invalid_credentials/i.test(`${error.code} ${error.message}`)) throw notYou();
      throw Object.assign(new Error(V.doors && V.doors.words ? V.doors.words(error) : error.message), { code: error.code || '' });
    }
    return proved(temp, data);
  }
  async function sendCheckCode() {
    const email = String((V.data.user || {}).email || '');
    checking = checkClient();
    const captchaToken = V.doors && V.doors.captcha ? await V.doors.captcha() : '';
    const { error } = await checking.auth.signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } });
    if (error) throw Object.assign(new Error(V.doors && V.doors.words ? V.doors.words(error) : error.message), { code: error.code || '' });
    return email;
  }
  async function checkCode(code) {
    const email = String((V.data.user || {}).email || '');
    const temp = checking || checkClient();
    const { data, error } = await temp.auth.verifyOtp({ email, token: String(code || '').replace(/\D/g, ''), type: 'email' });
    if (error) {
      throw Object.assign(new Error(V.doors && V.doors.words ? V.doors.words(error) : 'That code isn\'t right, or it ran out.'),
        { kind: 'not-you' });
    }
    checking = null;
    return proved(temp, data);
  }

  /* A new password. It also ends an invite's one-time code: a friend's account says must_change_password until
     they choose their own (js/access.js), and the PC's changePassword clears it the same way (vault/cloud.py).
     (1.22.5) `current`, the password now when it's known (typed to show it's them, an invite's code, a join's), goes
     along: a cloud with Supabase's "Require current password when updating" switched on wants it, and one without it
     ignores it. A Jarvis without changePasswordChecked takes the new one alone, as before. */
  async function changePassword(password, { current = '' } = {}) {
    if (V.desktop) {
      if (current && V.pc.can('changePasswordChecked')) return V.pc.call('changePasswordChecked', { password, current });
      return V.pc.call('changePassword', { password });
    }
    const { error } = await sb.auth.updateUser({ password, ...(current ? { current_password: current } : {}),
      data: { must_change_password: false } });
    if (error) {
      const said = `${error.code} ${error.message}`;
      if (/same_password|different from the old/i.test(said)) throw new Error('That\'s the password you have now: pick a new one.');
      if (/current_password_(invalid|mismatch)/i.test(said)) throw new Error('That isn\'t your password now. Try again.');
      if (/current_password_required/i.test(said)) {
        throw new Error('Your cloud wants the password you have now for that. Forgot it? Sign out, then tap Forgot password.');
      }
      throw new Error(error.message);
    }
  }

  /* Whether the signed-in account is still on its one-time invite code (asked fresh when it seems so: it may have
     been chosen on another device). Offline, what this device last heard. */
  async function mustChange() {
    if (V.desktop) {
      const config = await V.pc.call('config');
      if (!config.mustChange) return false;
      if (!V.pc.can('account')) return true;
      try { return !!(await V.pc.call('account')).mustChange; } catch (error) { return true; }
    }
    // (from the kept sign-in first, as user() does: the start never waits on the cloud for this, DATA-03)
    const session = kept() || (await sb.auth.getSession()).data.session;
    const meta = session && session.user && session.user.user_metadata;
    if (!meta || !meta.must_change_password) return false;
    if (!navigator.onLine) return true;  // (offline: as it was)
    try {
      const fresh = await Promise.race([sb.auth.getUser(), new Promise((done) => setTimeout(() => done(null), 5000))]);
      if (fresh && !fresh.error && fresh.data && fresh.data.user) return !!(fresh.data.user.user_metadata || {}).must_change_password;
    } catch (error) { /* offline: as it was */ }
    return true;
  }

  /* This device's copy belongs to one person. A copy left by someone else who used Vault here (they never signed
     out, and another person signed in after) is wiped first: never shown to the next one, never sent up as theirs. */
  async function ownCopy() {
    const me = V.data.user && V.data.user.id;
    if (!me) return;
    const was = await V.db.meta('owner');
    if (was && was !== me) await V.db.wipe();
    if (was !== me) await V.db.meta('owner', me);
  }

  /* Shows this device's copy at once; the returned promise is the first sync with the cloud. */
  async function start() {
    settingsRead = false;  // (this person's settings: read again from the cloud)
    await ownCopy();
    await loadLocal();
    window.addEventListener('online', () => sync());
    window.addEventListener('offline', () => setStatus('offline'));
    V.on('back', () => sync());
    listen();
    schedule();
    return { firstSync: sync() };
  }

  return {
    client, start, sync, save, keep, push, upload, link, blob, remove, purgeNote, user, signIn, signOut, kept,
    changePassword, accessToken, unsent, unsentParts, RETRY, resting: () => [...later].map(([key, one]) => ({ key, wait: one.wait })), mergeExtra, notePrint, mustChange, madeBy, keptFor, setPin,
    checkPassword, sendCheckCode, checkCode,
    /* (1.22.5) The invite code this page signed in with just now ('' when none): a friend's first password then goes
       with it as the password now (chooseScreen), for a cloud that asks for that. Memory only. */
    signedInCode: () => codeUsed,
    waits,  // (tests shorten them)
    get sb() { return sb; },
    /* The cloud the client was made for ({ url, key }), or null before there's one (js/doors.js). */
    cloudConfig: () => (config ? { url: config.url, key: config.key } : null),
    get status() { return status; },
    get held() { return heldCount(); },
    /* (1.22.5) Notes changed here that wait for the PIN, as another device locked them meanwhile (waitForPin); askPin
       asks for it, then sends them sealed. */
    get waitingPin() { return pinCount(); },
    askPin,
    get live() { return live; },
    /* Settings columns changed on this device (a new PIN): kept here at once, and only these columns go up. */
    async saveSettings(values) {
      const here = V.data.settings || {};
      const send = [...new Set([...(here._dirty ? unsentSettings(here) : []), ...Object.keys(values)])];
      V.data.settings = { ...here, ...values, _dirty: Date.now(), _send: send };
      await V.db.meta('settings', V.data.settings);
      pushSoon();
    },
    /* A change to the settings row's extra for every device (`change(extra)` gives the new extra, and may be run again
       on a newer one): made on the cloud's newest extra, only if nobody changed it in between (writeExtra), one
       change at a time here, each given waits.extra ms at most (timedExtra: a hung request never holds the next one);
       extra alone goes up, never the PIN's columns. Throws when the cloud can't be read or written in time (every
       caller copes: the tally keeps what it owes, a switch goes back and says so).
       A Vault older than 1.9.1 on another device still writes its own copy of the whole extra when it sends a new PIN
       (and a Chromebook's first announce did): that can put "Use Claude too" back to what that device last saw
       (usually off), as 1.9.0 could the tally. It ends once that device updates. */
    changeExtra,
    /* Whether the settings row has been read from the cloud since this page started; settingsReady(ms) waits for that
       (true), or gives up (false: this device's copy is all there is for now, as when offline): after `ms`, at once
       when offline (or the cloud is asleep, or the PC app says it can't be reached), and as soon as a read under way
       fails. After a read that failed, a fresh one is tried (and waited for) when the network seems to be there. */
    settingsRead: () => settingsRead,
    settingsReady(ms) {
      if (settingsRead) return Promise.resolve(true);
      const cut = !navigator.onLine || status === 'asleep' || (V.desktop && settingsFailed && status === 'offline');
      if (settingsFailed && !readingSettings && navigator.onLine) {
        // A fresh try (after a sync that doesn't read the settings, when one is running): its failure ends the wait.
        Promise.resolve(syncing).catch(() => {}).then(() => { if (!settingsRead && !readingSettings) sync(); });
      }
      if (cut) return Promise.resolve(false);
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timer); settingsWaiters.delete(done); resolve(value); };
        const timer = setTimeout(() => done(false), ms);
        settingsWaiters.add(done);
      });
    },
    async insertClip(text) {
      const row = { id: V.uuid(), text, from_device: V.device, created_at: new Date().toISOString() };
      const { data, error, status } = await sb.from('clips').insert({ id: row.id, text, from_device: V.device }).select().single();
      if (error) throw Object.assign(error, { status });
      heard(data && data.created_at);
      if (!V.data.clips.some((c) => c.id === data.id)) V.data.clips = [data, ...V.data.clips].slice(0, 30);
      await V.db.put('clips', data);
      V.emit('data', 'clips');
      return data || row;
    },
  };
})();
