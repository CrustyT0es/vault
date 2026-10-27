/* Vault: safety nets. A note's older versions (History, in its More menu), and all of Vault in one ZIP (Settings >
   Backups: "Download everything"; on the PC also a weekly copy in Documents\Vault backups, written by vault/desktop.py).

   History: a copy of a note's title and words goes to the cloud's file storage, <owner>/history/<note>/<time>.json
   (the time as an ISO time with "-" for ":", so the names sort by time), when the note is closed after a change (or
   the app goes to the background), once before the first change after opening it (the version that was there), and
   every 10 minutes while writing; only when it differs from the last copy kept. The newest 30 of each note stay. A
   locked note's copies are its sealed words (`secret`), shown only once it's unlocked. Restoring puts the old words back as an ordinary edit (the version it
   replaces is kept first, so restoring that undoes it), and a note emptied from the Trash takes its copies with it.
   Copies made offline wait on this device (meta "history-waiting") and go up when it's back online. */
'use strict';

V.history = (() => {
  const KEEP = 30;
  const timing = { every: 10 * 60 * 1000 };  // a copy every 10 minutes of writing
  const AFTER_CLOSING = 1200;     // the close's own save lands first
  let opened = null;              // { id, row, fp, before, at }: the note open in the editor, as it was opened
  let last = null;                // note id -> fingerprint of the newest copy this device kept
  let waiting = null;             // copies not uploaded yet: [{ path, id, payload }]
  let flushing = null;

  const owner = () => (V.data.user && V.data.user.id) || '';
  const folder = (id) => `${owner()}/history/${id}`;
  const content = (row) => (row.locked ? 'sealed:' + (row.secret || '') : 'plain:' + (row.body || ''));
  const fingerprint = (row) => V.backup.crc32(V.backup.utf8(JSON.stringify([row.title || '', content(row)]))).toString(16)
    + ':' + (row.title || '').length + ':' + content(row).length;
  const fileName = (date) => date.toISOString().replace(/:/g, '-') + '.json';
  const timeOf = (name) => {
    const iso = name.replace(/\.json$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at;
  };

  async function lastCopies() {
    if (!last) last = (await V.db.meta('history-last').catch(() => null)) || {};
    return last;
  }

  async function queue() {
    if (!waiting) waiting = (await V.db.meta('history-waiting').catch(() => null)) || [];
    return waiting;
  }

  /* A copy of `row` as it is now (unless the newest copy is the same). */
  async function keep(row, { force = false } = {}) {
    if (!row || !row.id || !owner() || row._purge) return false;
    if (!(row.title || '').trim() && !(row.locked ? row.secret : (row.body || '').trim())) return false;  // nothing in it
    const seen = await lastCopies();
    const fp = fingerprint(row);
    if (!force && seen[row.id] === fp) return false;
    const at = new Date();
    const payload = { format: 1, note: row.id, at: at.toISOString(), device: V.device, title: row.title || '',
      locked: !!row.locked, body: row.locked ? '' : row.body || '', secret: row.locked ? row.secret || null : null };
    const list = await queue();
    list.push({ path: `${folder(row.id)}/${fileName(at)}`, id: row.id, payload });
    seen[row.id] = fp;
    await V.db.meta('history-waiting', list);
    await V.db.meta('history-last', seen);
    flush();
    return true;
  }

  /* The copies waiting here go up, oldest first (later, if the cloud can't be reached now). */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const list = await queue();
      const trimmed = new Set();
      while (list.length && V.cloud.sb && navigator.onLine) {
        const next = list[0];
        try {
          await V.cloud.upload(next.path, new Blob([JSON.stringify(next.payload)], { type: 'application/json' }),
            { mime: 'application/json' });
        } catch (error) {
          console.warn('Vault history: not up yet', error && error.message);
          break;
        }
        list.shift();
        await V.db.meta('history-waiting', list);
        trimmed.add(next.id);
      }
      for (const id of trimmed) await trim(id).catch(() => {});
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function listed(id) {
    const { data, error } = await V.cloud.sb.storage.from('vault').list(folder(id), {
      limit: 1000, sortBy: { column: 'name', order: 'desc' } });
    if (error) throw error;
    return (data || []).filter((f) => f.id !== null && /\.json$/.test(f.name) && timeOf(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /* Only the newest KEEP copies of a note stay. */
  async function trim(id) {
    const all = await listed(id);
    const old = all.slice(KEEP).map((f) => `${folder(id)}/${f.name}`);
    if (old.length) await V.cloud.remove(old);
  }

  /* Every copy of a note gone (it was emptied from the Trash). */
  async function forget(id) {
    const list = await queue();
    const left = list.filter((w) => w.id !== id);
    if (left.length !== list.length) { waiting = left; await V.db.meta('history-waiting', left); }
    const seen = await lastCopies();
    if (id in seen) { delete seen[id]; await V.db.meta('history-last', seen); }
    if (!V.cloud.sb) return;
    const all = await listed(id);
    if (all.length) await V.cloud.remove(all.map((f) => `${folder(id)}/${f.name}`));
  }

  /* -- when copies are made */

  V.on('note-opened', (id) => {
    const row = V.data.notes.get(id);
    opened = row ? { id, row: { ...row }, fp: fingerprint(row), before: false, at: Date.now() } : null;
  });

  V.on('data', (table) => {
    if (table !== 'notes' || !opened) return;
    const row = V.data.notes.get(opened.id);
    if (!row || row.deleted || fingerprint(row) === opened.fp) return;
    if (!opened.before) {  // the first change: the version that was there is kept first
      opened.before = true;
      opened.at = Date.now();
      keep(opened.row).catch(warn);
    } else if (Date.now() - opened.at >= timing.every) {
      opened.at = Date.now();
      keep(row).catch(warn);
    }
  });

  V.on('note-left', (id) => {
    const was = opened && opened.id === id ? opened : null;
    if (was) opened = null;
    setTimeout(() => {
      const row = V.data.notes.get(id);
      if (!row || row.deleted || (was && fingerprint(row) === was.fp)) return;
      keep(row).catch(warn);
    }, AFTER_CLOSING);
  });

  // A phone's app sent to the background is as good as closed (it's rarely closed any other way).
  V.on('away', () => {
    const was = opened;
    if (!was) return;
    setTimeout(() => {
      const row = V.data.notes.get(was.id);
      if (row && !row.deleted && fingerprint(row) !== was.fp) keep(row).catch(warn);
    }, AFTER_CLOSING);
  });

  V.on('status', (state) => { if (state === 'synced' && waiting && waiting.length) flush(); });
  window.addEventListener('online', () => setTimeout(flush, 2000));

  const warn = (error) => console.warn('Vault history:', error);

  /* -- the History sheet */

  async function copies(id) {
    const here = (await queue()).filter((w) => w.id === id).map((w) => ({ name: w.path.split('/').pop(), waiting: w }));
    let there = [];
    let problem = '';
    if (navigator.onLine && V.cloud.sb) {
      try { there = await listed(id); } catch (error) { problem = 'Couldn\'t reach your cloud just now.'; }
    } else problem = 'You\'re offline: only the copies made on this device show.';
    const names = new Set(here.map((h) => h.name));
    const all = [...here, ...there.filter((f) => !names.has(f.name)).map((f) => ({ name: f.name }))]
      .sort((a, b) => b.name.localeCompare(a.name));
    return { all, problem };
  }

  async function load(id, entry) {
    if (entry.waiting) return entry.waiting.payload;
    const { data, error } = await V.cloud.sb.storage.from('vault').download(`${folder(id)}/${entry.name}`);
    if (error) throw error;
    return JSON.parse(await data.text());
  }

  /* A copy's words (opened with the PIN for a locked note's): null when they can't be shown now. */
  async function wordsOf(copy) {
    if (!copy.locked) return copy.body || '';
    if (!V.lock.unlocked()) return null;
    try { return JSON.parse(await V.lock.decrypt(copy.secret)).body || ''; } catch (error) { return undefined; }
  }

  const when = (date) => date.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric',
    minute: '2-digit' });

  function show(id) {
    const note = V.data.notes.get(id);
    if (!note) return;
    const list = V.h('div.history-list', { 'aria-busy': 'true' }, V.h('p.hint', { text: 'Loading older versions...' }));
    const sheet = V.sheet({
      title: 'History',
      content: [V.h('p.hint.history-about', { text: 'A copy is kept when you close the note and every 10 minutes while '
        + 'you write. The newest 30 stay. Restoring is an edit like any other: the version it replaces is kept here too.' }),
      list],
      actions: [{ label: 'Close' }],
    });
    fill(id, list, sheet).catch((error) => {
      list.removeAttribute('aria-busy');
      V.clear(list, V.h('p.hint', { text: 'Couldn\'t load the history: ' + (error.message || error) }));
    });
  }

  async function fill(id, list, sheet) {
    const { all, problem } = await copies(id);
    list.removeAttribute('aria-busy');
    if (!all.length) {
      V.clear(list, V.h('div.history-empty', {}, V.icon('clock', 'big'),
        V.h('p', { text: problem || 'No older versions yet.' }),
        problem ? null : V.h('p.hint', { text: 'Close the note after a change (or keep writing for 10 minutes) and one appears here.' })));
      return;
    }
    V.clear(list, problem ? V.h('p.hint', { text: problem }) : null, all.map((entry) => row(id, entry, sheet)));
  }

  function row(id, entry, sheet) {
    const at = timeOf(entry.name);
    const preview = V.h('p.history-preview', { text: 'Loading...' });
    const restore = V.button('Restore', { icon: 'restore', onClick: () => restoreCopy(id, entry, at, sheet) });
    const head = V.h('button.history-head', { type: 'button', 'aria-expanded': 'false', onclick: () => {
      const open = item.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
    } },
    V.h('strong', { text: when(at) }), V.h('span.history-ago', { text: V.ago(at.toISOString()) + (entry.waiting ? ' · not uploaded yet' : '') }));
    const item = V.h('div.history-item', {}, head, preview, V.h('div.history-actions', {}, restore));
    // Each copy's words are fetched as its row shows (a small JSON file each).
    load(id, entry).then(async (copy) => {
      entry.copy = copy;
      const words = await wordsOf(copy);
      const now = V.data.notes.get(id);
      // The title shows only when it was different then.
      const title = copy.title && (!now || now.title !== copy.title) ? copy.title + '\n' : '';
      if (words === null) {
        preview.classList.add('sealed');
        preview.textContent = 'Locked. Unlock the note with your PIN to see this version.';
      } else if (words === undefined) {
        preview.classList.add('sealed');
        preview.textContent = 'Locked with an older PIN, so it can\'t be opened.';
        restore.disabled = true;
      } else {
        preview.textContent = (title + words).trim() || '(empty)';
      }
    }).catch(() => { preview.textContent = 'Couldn\'t load this version.'; restore.disabled = true; });
    return item;
  }

  async function restoreCopy(id, entry, at, sheet) {
    try {
      const copy = entry.copy || await load(id, entry);
      const words = await wordsOf(copy);
      const open = V.editor.openId() === id;
      if (words === null || (copy.locked && !open)) {
        return V.toast('Open the note and unlock it with your PIN first, then restore.', { kind: 'err' });
      }
      if (words === undefined) return V.toast('That version was locked with an older PIN, so it can\'t be opened.', { kind: 'err' });
      if (open) await V.editor.settled();  // what was just typed is saved, and kept below
      const row = V.data.notes.get(id);
      if (!row) return;
      await keep(row);
      if (open) {
        if (!V.editor.restore(id, copy.title || '', words)) {
          return V.toast('Unlock the note with your PIN first, then restore.', { kind: 'err' });
        }
      } else if (!row.locked) {
        await V.cloud.save('notes', { ...row, title: copy.title || '', body: words });
      } else {
        return V.toast('Open the note and unlock it with your PIN first, then restore.', { kind: 'err' });
      }
      sheet.close();
      V.toast(`Back to the version from ${when(at)}. Changed your mind? The one before is in History too.`, { ms: 6000 });
    } catch (error) {
      V.problem(error);
    }
  }

  return { show, keep, flush, forget, copies, load, trim, KEEP, timing };
})();

/* ---------------------------------------------------------------- everything in one ZIP */

V.backup = (() => {
  const encoder = new TextEncoder();
  const utf8 = (text) => encoder.encode(text);

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* A ZIP of `files` ([{ name, data: string | Uint8Array }]) as they are (stored, not squeezed: notes are small, and
     every unzip tool reads it), names in UTF-8. */
  function zip(files, date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = utf8(file.name);
      const data = typeof file.data === 'string' ? utf8(file.data) : file.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);  // the name is UTF-8
      local.setUint16(8, 0, true);       // stored
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local, name, data);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, time, true);
      entry.setUint16(14, day, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  /* A file or folder name every computer takes. */
  function safeName(name, fallback = 'Untitled') {
    let clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
    clean = clean.slice(0, 80).replace(/[. ]+$/, '');
    if (!clean) clean = fallback;
    return RESERVED.test(clean) ? '_' + clean : clean;
  }

  const clean = (row) => Object.fromEntries(Object.entries(row || {}).filter(([key]) => !key.startsWith('_')));
  const dateText = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  /* One note as Markdown: its title, its words as they are (checklists are already "- [ ] milk"), then what else it
     has. A locked note's words stay sealed (in vault.json only). */
  function markdown(note, folderName) {
    const lines = [`# ${(note.title || '').trim() || V.noteTitle(note)}`, ''];
    if (note.locked) lines.push('_This note is locked. Its words are only in vault.json, sealed: Vault opens them with your PIN._');
    else lines.push(note.body || '');
    const facts = [];
    if (folderName) facts.push(`Folder: ${folderName}`);
    if (note.due) facts.push(`Due: ${note.due}${note.done ? ' (done)' : ''}`);
    if (note.pinned) facts.push('Pinned');
    if (note.extra && note.extra.archived) facts.push('Archived');
    if (note.deleted) facts.push('In the Trash');
    const files = (note.attachments || []).map((a) => `- ${a.name || String(a.path || 'file').split('/').pop()}`
      + (a.kind === 'voice' ? ' (voice memo)' : /^image\//.test(a.mime || '') ? ' (picture)' : ''));
    if (facts.length || files.length) lines.push('', '---', '');
    if (facts.length) lines.push(facts.join(' · '));
    if (files.length) lines.push('', 'Attachments (in Vault, not in this file):', ...files);
    return lines.join('\n').replace(/\n{3,}$/, '\n') + '\n';
  }

  /* Everything this device has (it's kept in step with the cloud) as one ZIP: a folder per Vault folder (one inside
     another as Vault has it) with a Markdown file per note, and vault.json with every row. */
  function build(now = new Date()) {
    const root = `Vault ${dateText(now)}`;
    const folders = [...V.data.folders.values()].filter((f) => !f.deleted);
    const pathOf = (f) => V.organise.pathOf(f);
    const folderName = new Map(folders.map((f) => [f.id, pathOf(f).map((each) => safeName(each.name, 'Folder')).join('/')]));
    const used = new Set();
    const files = [];
    const notes = [...V.data.notes.values()].filter((n) => !n._purge)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id));
    for (const note of notes) {
      const where = folderName.get(note.folder_id) || 'No folder';
      const extra = note.extra || {};
      const dir = note.deleted ? 'Trash' : extra.is_template ? 'Templates' : extra.archived ? `Archive/${where}` : where;
      const stem = safeName(V.noteTitle(note));
      let path = `${root}/${dir}/${stem}.md`;
      for (let n = 2; used.has(path.toLowerCase()); n++) path = `${root}/${dir}/${stem} (${n}).md`;
      used.add(path.toLowerCase());
      const folder = folders.find((f) => f.id === note.folder_id);
      files.push({ name: path, data: markdown(note, folder ? pathOf(folder).map((each) => each.name).join(' / ') : '') });
    }
    const settings = V.data.settings || {};
    const everything = {
      format: 1, app: 'Vault', version: V.VERSION, made: now.toISOString(), device: V.device,
      account: (V.data.user && V.data.user.email) || '',
      about: 'Every note, folder and sent item as your cloud keeps them. Locked notes stay sealed (secret): Vault opens '
        + 'them with your PIN, using pin_salt below.',
      folders: [...V.data.folders.values()].map(clean),
      notes: notes.map(clean),
      transfers: [...V.data.transfers.values()].filter((t) => !t._purge).map(clean),
      clips: (V.data.clips || []).map(clean),
      settings: { pin_salt: settings.pin_salt || null, pin_check: settings.pin_check || null, extra: settings.extra || {} },
    };
    files.push({ name: `${root}/vault.json`, data: JSON.stringify(everything, null, 2) });
    return { blob: zip(files, now), name: `${root}.zip`, notes: notes.filter((n) => !n.deleted).length };
  }

  /* "Download everything": the ZIP saved by the browser (on the PC, into the folder files from the phone go to). */
  function download() {
    const made = build();
    const url = URL.createObjectURL(made.blob);
    const link = V.h('a', { href: url, download: made.name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    V.toast(V.desktop && V.prefs ? `${made.name} is in ${V.prefs.downloads}.` : `Downloading ${made.name}...`, { ms: 5000 });
    return made;
  }

  const base64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  /* -- the PC's own backups (vault/desktop.py writes them, into Documents\Vault backups) */

  let info = null;      // { on, folder, last, count }
  let asking = null;
  let working = false;

  const canBackUp = () => V.desktop && V.pc && V.pc.can('saveBackup');

  async function toPc({ auto = false } = {}) {
    if (!canBackUp() || working) return null;
    if (auto && (!V.data.user || (!V.data.notes.size && !V.data.folders.size))) return null;
    working = true;
    V.emit('backup', 'working');
    try {
      const made = build();
      const answer = await V.pc.call('saveBackup', { data: await base64(made.blob), auto });
      info = null;
      if (!auto) V.toast(`Backed up ${made.notes} note${made.notes === 1 ? '' : 's'} into ${answer.folder || 'Vault backups'}.`);
      return answer;
    } finally {
      working = false;
      V.emit('backup', 'done');
    }
  }

  V.on('pc:backup-due', () => { toPc({ auto: true }).catch((error) => console.warn('Vault backup:', error)); });

  async function refresh() {
    if (!canBackUp()) return null;
    if (!asking) {
      asking = V.pc.call('backupInfo').then((answer) => { info = answer; return answer; })
        .catch(() => null).finally(() => { asking = null; });
    }
    return asking;
  }

  /* Settings' "Backups" card. `ui` is Settings' own { card, line, toggle, draw }. */
  function card(ui) {
    const rows = [ui.line('Download everything', 'Every note as a Markdown file, in its folder, plus all of Vault in vault.json, '
      + 'in one ZIP. Locked notes stay locked.', V.button('Download', { icon: 'download', onClick: () => {
      try { download(); } catch (error) { V.problem(error); }
    } }))];
    if (canBackUp()) {
      if (!info) refresh().then((got) => { if (got) ui.draw(); });
      const where = info && info.folder ? info.folder : 'Documents\\Vault backups';
      rows.push(ui.line('Back up every week', `Into ${where}, by itself. The newest 4 are kept.`, ui.toggle('backup')),
        ui.line(working ? 'Backing up...' : info && info.last ? `Last backup ${V.ago(info.last)}` : 'No backup on this PC yet',
          info && info.count ? `${info.count} kept` : 'Never your password or keys: just your notes.',
          V.h('div.setting-buttons', {},
            V.button('Open', { icon: 'folder', onClick: () => V.pc.call('showBackups').catch(V.problem) }),
            V.button('Back up now', { icon: 'download', disabled: working, onClick: async () => {
              try { await toPc(); } catch (error) { V.problem(error); }
              await refresh();
              ui.draw();
            } }))));
    }
    return ui.card('Backups', ...rows);
  }

  return { zip, crc32, utf8, build, markdown, safeName, download, toPc, card, refresh };
})();
