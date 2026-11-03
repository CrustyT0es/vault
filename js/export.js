/* Wefty: notes as files (1.17; the owner: "Export notes to TxT or smth", to send them to the person helping them).

   A note's ⋯ menu has Export (Text or Markdown) and Copy as text; picked notes (Select notes) have Export too, and a
   folder's options Export folder (the folders inside it as well). One note is one file: Text (.txt) is plain words
   anyone can open (the marks of bold, highlight... taken out, a checklist as [ ] and [x], links as "words (address)"),
   Markdown (.md) is the note as written. Several notes are one ZIP (js/history.js's ZIP maker, as Download everything
   uses): a file for each, and their pictures and files in a "<note> files" folder beside it, as far as MOST_FILES
   allows (the rest are named in the note). Locked notes: one that's open and unlocked exports with a warning that the
   file isn't locked; in a ZIP they're left out (their words are sealed), and the person is told.

   How the file reaches the person: a phone (Android, iPhone, iPad) shares it through its share sheet when the browser
   can share that kind of file (Chrome on Android shares .txt, not .md or .zip: those download); a Chromebook or a
   browser downloads it (the Files app's Downloads); the PC app saves it in Downloads\Vault through Python
   (saveExport, so it can say where and offer Show in folder) or, with an older PC part, as the page's own download,
   which the PC app saves in that same folder. */
'use strict';

V.exporter = (() => {
  const MOST_FILES = 80 * 1024 * 1024;  // pictures and files put in one ZIP, all together (a phone holds it all in memory)
  const PC_MOST = 30 * 1024 * 1024;     // the most handed to the PC part in one call; a bigger ZIP goes as a download
  const MOST_NAME = 60;                 // letters in a file's name, before its type...
  const MOST_BYTES = 150;               // ...and bytes (a phone's or Chromebook's drive allows 255 for the whole name)
  // A path inside a ZIP, in the UTF-16 letters Windows counts: its Extract All stops at 260 ("path too long") with
  // the folder it unpacks into in front (Downloads\Vault\<the ZIP's name>\, up to about 90), so the folders, a
  // note's name and its files' names are cut to fit. A note's folders take at most DIR_MOST of it, a folder export's
  // own folder (also the ZIP's name) at most ROOT_MOST, and no name is cut below LEAST letters.
  const MOST_PATH = 150;
  const DIR_MOST = 80;
  const ROOT_MOST = 40;
  const LEAST = 8;
  const TYPES = { txt: 'text/plain;charset=utf-8', md: 'text/markdown;charset=utf-8', zip: 'application/zip' };

  /* -- names every computer takes (Windows, Android, ChromeOS) */

  // Windows' own device names, with any type after them ("NUL.txt" and "con.tar.gz" are the device too).
  const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
  const encoder = new TextEncoder();

  /* A name for a file or a folder from a note's title: no \ / : * ? " < > | or invisible characters (a right-to-left
     mark can make "txt.exe" read as "exe.txt"), no dot or space at either end (a leading dot hides it on a phone or a
     Chromebook), at most MOST_NAME letters and MOST_BYTES bytes (never half an emoji), never a Windows device name. */
  function safeStem(text, fallback = 'Untitled') {
    let name = String(text || '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f​‎‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');
    let letters = Array.from(name).slice(0, MOST_NAME);
    while (letters.length && encoder.encode(letters.join('')).length > MOST_BYTES) letters.pop();
    name = letters.join('').replace(/[\s.]+$/g, '');
    if (!name) name = fallback;
    return RESERVED.test(name.split('.')[0].trim()) ? '_' + name : name;
  }

  const fileName = (text, type, fallback) => `${safeStem(text, fallback)}.${type}`;

  /* A safe stem cut to at most `n` UTF-16 letters (never half an emoji), as safeStem would leave it. */
  function cut(stem, n) {
    if (stem.length <= n) return stem;
    const letters = Array.from(stem);
    while (letters.length > 1 && letters.join('').length > n) letters.pop();
    return safeStem(letters.join(''));
  }

  /* Folder names cut until their path (joined with "/") fits `most`: the longest first, none below LEAST. */
  function fitPath(parts, most) {
    const out = parts.slice();
    for (;;) {
      if (out.join('/').length <= most) return out;
      let at = -1;
      out.forEach((part, i) => { if (part.length > LEAST && (at < 0 || part.length > out[at].length)) at = i; });
      if (at < 0) return out;
      out[at] = cut(out[at], out[at].length - 1);
    }
  }

  const within = (n) => Math.max(LEAST, Math.min(MOST_NAME, n));

  /* `name` again, or "name (2).type" and so on when that's taken in `used` (lower case: Windows doesn't tell them apart). */
  function unique(used, folder, stem, type) {
    let name = `${stem}${type ? '.' + type : ''}`;
    for (let n = 2; used.has(`${folder}/${name}`.toLowerCase()); n++) name = `${stem} (${n})${type ? '.' + type : ''}`;
    used.add(`${folder}/${name}`.toLowerCase());
    return name;
  }

  /* -- the words */

  const CHECK = /^(\s*)[-*+]\s*\[( |x|X)\]\s?(.*)$/;
  const LINK = /\[([^\]\n]{1,300})\]\(([^()\s]+)\)/g;
  const CODE = /`([^`\n]+)`/g;
  const BLANK = /\{\{([^{}\n]*[^{}\s][^{}\n]*)\}\}/g;

  /* A line's words without the marks: links as "words (address)", then no **, __, _, *, ~~, ++ or ==, no backticks
     round code, a flash card's {{blank}} as its word. */
  function words(line) {
    const linked = line.replace(LINK, (all, said, href) => (said.trim() === href ? href : `${said} (${href})`));
    return V.format.unmark(linked).replace(CODE, '$1').replace(BLANK, (all, word) => word.trim());
  }

  /* A note's words as plain text: headings as their words, a checklist as [ ] and [x], "* " and "+ " lists as "- ",
     a ``` block's lines as they are (without the ``` lines), everything else without its marks. */
  function plain(body) {
    const out = [];
    let fenced = false;
    for (const raw of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
      if (fenced) { out.push(raw); continue; }
      const box = CHECK.exec(raw);
      if (box) { out.push(`${box[1]}[${box[2] === ' ' ? ' ' : 'x'}] ${words(box[3])}`.trimEnd()); continue; }
      const head = /^#{1,6}\s+(.*)$/.exec(raw);
      if (head) { out.push(words(head[1]).trim()); continue; }
      const item = /^([ \t]*)[*+•]\s+/.exec(raw);
      out.push(words(item ? `${item[1]}- ${raw.slice(item[0].length)}` : raw).trimEnd());
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* -- a note's files: what they're called, and where they are */

  const isPicture = (a) => /^image\//.test(a.mime || '');
  function shownName(a) {
    if (a.kind === 'ink') return 'Drawing';
    if (a.kind === 'voice') return a.seconds ? `Voice memo (${V.format.clock(a.seconds)})` : 'Voice memo';
    return a.name || String(a.path || 'file').split('/').pop();
  }
  const whatItIs = (a) => (a.kind === 'ink' ? '' : a.kind === 'voice' ? '' : isPicture(a) ? ' (picture)' : '');

  /* The lines naming a note's files. `put`: what a ZIP holds for each ({ name, why }, by its index; none: they stay in
     Wefty), `dir`: the folder they're in, beside the note's file. */
  function fileLines(note, type, put = null, dir = '') {
    const list = (note.attachments || []).filter((a) => a && (a.path || a.preview));
    if (!list.length) return [];
    const lines = [put ? `Files in this note (in the "${dir}" folder beside it):` : 'Files in this note (they stay in Wefty):'];
    list.forEach((a, i) => {
      const got = put && put[i];
      if (got && got.name && type === 'md') {
        const where = [dir, got.name].map(encodeURIComponent).join('/');
        lines.push(`- ${isPicture(a) || a.kind === 'ink' ? '!' : ''}[${got.name}](${where})`);
      } else if (got && got.name) {
        lines.push(`- ${got.name}`);
      } else {
        lines.push(`- ${shownName(a)}${whatItIs(a)}${got && got.why ? ` (${got.why})` : ''}`);
      }
    });
    return lines;
  }

  /* -- one note as a file's words */

  const titleOf = (note) => (note.title || '').trim();

  function text(note, put = null, dir = '') {
    const title = V.format.unmark(titleOf(note), true).trim();
    const files = fileLines(note, 'txt', put, dir);
    const parts = [title, plain(note.body), files.join('\n')].filter((part) => part && part.trim());
    return parts.join('\n\n') + '\n';
  }

  function markdown(note, put = null, dir = '') {
    const title = titleOf(note);
    const files = fileLines(note, 'md', put, dir);
    const body = String(note.body || '').replace(/\r\n?/g, '\n').trim();
    const parts = [title ? `# ${title}` : '', body, files.length ? '---\n\n' + files.join('\n') : ''].filter(Boolean);
    return parts.join('\n\n') + '\n';
  }

  const wordsOf = (note, type, put, dir) => (type === 'md' ? markdown(note, put, dir) : text(note, put, dir));

  /* One note as { name, blob, type }. */
  function single(note, type) {
    return { name: fileName(V.noteTitle(note), type), blob: new Blob([wordsOf(note, type)], { type: TYPES[type] }), type };
  }

  /* -- several notes as one ZIP */

  const today = () => V.dateText(new Date());

  /* The notes `ids` (or a folder, `folderId`, with the folders inside it) as a ZIP: { name, blob, type, notes, locked,
     skipped }. `onFile(n, of)` hears each picture or file fetched. Locked notes, templates and the Trash are left out
     (`locked` counts the locked ones); a folder's archived notes go in an "Archived" folder of its own. */
  async function zipOf({ ids = null, folderId = null, type = 'txt', onFile = null } = {}) {
    let root;
    let notes;
    let dirOf;
    if (folderId) {
      const top = V.data.folders.get(folderId);
      if (!top || top.deleted) throw new Error('That folder isn\'t there any more.');
      root = cut(safeStem(top.name, 'Folder'), ROOT_MOST);
      const ids = new Set([folderId, ...V.organise.inside(folderId)]);
      const depth = V.organise.pathOf(top).length;
      notes = [...V.data.notes.values()].filter((n) => ids.has(n.folder_id) && !n.deleted && !n._purge
        && !V.organise.isTemplate(n));
      dirOf = (note) => {
        const folder = V.data.folders.get(note.folder_id);
        const below = folder ? V.organise.pathOf(folder).slice(depth).map((f) => safeStem(f.name, 'Folder')) : [];
        return fitPath([root, ...(V.organise.isArchived(note) ? ['Archived'] : []), ...below], DIR_MOST).join('/');
      };
    } else {
      root = `Wefty notes ${today()}`;
      notes = (ids || []).map((id) => V.data.notes.get(id)).filter((n) => n && !n._purge);
      dirOf = () => root;
    }
    notes.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || String(a.id).localeCompare(String(b.id)));
    const locked = notes.filter((n) => n.locked).length;
    notes = notes.filter((n) => !n.locked);
    const used = new Set();
    const files = [];
    const skipped = { big: 0, failed: 0 };
    let total = 0;
    const wanted = notes.reduce((n, note) => n + (note.attachments || []).length, 0);
    let fetched = 0;
    for (const note of notes) {
      const dir = dirOf(note);
      const list = (note.attachments || []).filter((a) => a && (a.path || a.preview));
      // What MOST_PATH leaves after "<dir>/": the note's name (" (2)" and its type allowed for), or with files, its
      // name twice over ("<note> (2) files/") and each file's ("<file> (2).<type of up to 10>") sharing it.
      const room = MOST_PATH - dir.length - 1;
      const stem = cut(safeStem(V.noteTitle(note)), list.length ? within(Math.floor((room - 28) / 2)) : within(room - 12));
      const fileMost = within(room - 28 - stem.length);
      const name = unique(used, dir, stem, type);
      const put = [];
      const filesDir = `${name.replace(/\.[^.]+$/, '')} files`;
      for (const a of list) {
        // A drawing is its picture (its lines are only for Wefty's pen); anything else, the file as it was added.
        const path = a.kind === 'ink' ? a.preview : a.path;
        const ending = (/\.([a-z0-9]{1,10})$/i.exec(String(path || '')) || [])[1] || '';
        let own = a.kind === 'ink' ? 'Drawing' : shownName(a).replace(/\.[a-z0-9]{1,10}$/i, '');
        if (a.kind === 'voice' && a.name) own = a.name.replace(/\.[a-z0-9]{1,10}$/i, '');
        const fileEnding = (/\.([a-z0-9]{1,10})$/i.exec(a.kind === 'ink' ? '' : a.name || '') || [])[1] || ending;
        if (!path || (a.size && total + a.size > MOST_FILES)) {
          put.push({ why: path ? 'too big to add here: it stays in Wefty' : '' });
          if (path) skipped.big += 1;
          continue;
        }
        let bytes = null;
        try {
          bytes = new Uint8Array(await (await V.cloud.blob(path)).arrayBuffer());
        } catch (error) {
          console.warn('Wefty export:', error);
        }
        fetched += 1;
        if (onFile) onFile(fetched, wanted);
        if (!bytes) { put.push({ why: 'couldn\'t be fetched: it stays in Wefty' }); skipped.failed += 1; continue; }
        if (total + bytes.length > MOST_FILES) { put.push({ why: 'too big to add here: it stays in Wefty' }); skipped.big += 1; continue; }
        total += bytes.length;
        const saved = unique(used, `${dir}/${filesDir}`, cut(safeStem(own, 'File'), fileMost), fileEnding.toLowerCase());
        files.push({ name: `${dir}/${filesDir}/${saved}`, data: bytes });
        put.push({ name: saved });
      }
      files.push({ name: `${dir}/${name}`, data: wordsOf(note, type, list.length ? put : null, filesDir) });
    }
    return { name: `${root}.zip`, blob: V.backup.zip(files), type: 'zip', notes: notes.length, locked, skipped };
  }

  /* -- getting the file to the person */

  const base64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const phone = () => !V.desktop && !!(V.deviceKind.android || V.deviceKind.ios);
  // Chrome on Android shares a file only by an allowed name ending (.txt yes; .md and .zip no) and an exactly allowed
  // media type ("text/plain" yes; "text/plain;charset=utf-8" no), turning anything else down when it's shared, while
  // its canShare() says yes to any file (Chromium: ShareServiceImpl.java, navigator_share.cc). So a shared file goes
  // with its bare media type, and on Android only these are offered to the share sheet.
  const SHARES_ON_ANDROID = new Set(['txt']);

  /* The file as a File the share sheet takes, or null where it can't be shared (not a phone, an older browser, or a
     kind of file this browser doesn't share: Chrome on Android shares .txt, not .md or .zip). */
  function shareable(made) {
    if (!phone() || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
    if (V.deviceKind.android && !SHARES_ON_ANDROID.has(made.type)) return null;
    try {
      const type = String(made.blob.type || TYPES[made.type]).split(';')[0].trim();
      const file = new File([made.blob], made.name, { type });
      return navigator.canShare({ files: [file] }) ? file : null;
    } catch (error) {
      return null;
    }
  }

  function download(made) {
    const url = URL.createObjectURL(made.blob);
    const link = V.h('a', { href: url, download: made.name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const where = V.desktop ? `Saved ${made.name} in ${(V.prefs && V.prefs.downloads) || 'Downloads'}.`
      : V.deviceKind.chromebook ? `Saved ${made.name} in Downloads. Find it in the Files app.`
        : V.deviceKind.ios ? `${made.name}: find it in the Files app, in Downloads.`
          : V.deviceKind.android ? `${made.name} is in your Downloads.` : `Downloaded ${made.name}.`;
    V.toast(where, { ms: 6000 });
    return 'downloaded';
  }

  /* The share sheet with the file. A share that took too long to get ready has lost the tap that asked for it
     (browsers only open the sheet straight after a tap): a card with Share asks for another one. Turned down with the
     tap still fresh, or from that card's own tap (`again`), it's the file the browser won't share: it downloads,
     never another card. */
  async function share(made, file, again = false) {
    const fresh = !!(navigator.userActivation && navigator.userActivation.isActive);
    try {
      await navigator.share({ files: [file], title: made.name });
      return 'shared';
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';  // (the sheet closed without picking anything)
      if (error && error.name === 'NotAllowedError' && !fresh && !again) return ready(made, file);
      console.warn('Wefty export: sharing didn\'t work, so it downloads instead.', error);
      return download(made);
    }
  }

  function ready(made, file) {
    return new Promise((resolve) => {
      let how = 'cancelled';
      V.sheet({
        title: 'Your file is ready',
        content: [V.h('p.export-ready', {}, V.icon(made.type === 'zip' ? 'folder' : 'file'),
          V.h('span', { text: `${made.name} · ${V.size(made.blob.size)}` }))],
        actions: [
          { label: 'Download', onClick: () => { how = download(made); } },
          { label: 'Share', kind: 'primary', icon: 'share', onClick: async () => { how = await share(made, file, true); } },
        ],
        onClose: () => resolve(how),
      });
    });
  }

  /* On the PC: saved by Python into the received-files folder (Downloads\Vault), with Show in folder. An older PC part
     (or a ZIP too big to hand over in one go): the page's own download, which the PC app saves there too. */
  async function toPc(made) {
    if (!V.pc || !V.pc.can('saveExport') || made.blob.size > PC_MOST) return download(made);
    const answer = await V.pc.call('saveExport', { name: made.name, data: await base64(made.blob) });
    V.toast(`Saved ${answer.name || made.name} in ${answer.where || answer.folder}.`, { ms: 8000, action: 'Show in folder',
      onAction: () => V.pc.call('showFile', { path: answer.path }).catch(V.problem) });
    return 'saved';
  }

  /* `made` handed over: shared (a phone), saved (the PC) or downloaded. Resolves how. */
  function deliver(made) {
    if (V.desktop) return toPc(made);
    const file = shareable(made);
    return file ? share(made, file) : Promise.resolve(download(made));
  }

  /* -- the choice: Text or Markdown */

  /* The sheet: `title`, an optional warning, a line about what's made, and the two kinds. Resolves 'txt', 'md' or
     null. (Called straight from a tap, and the file is made straight from the next one, so a phone's share sheet can
     open.) */
  function choose({ title, warn = '', about = '' }) {
    return new Promise((resolve) => {
      let picked = null;
      const option = (type, icon, name, hint) => V.h('button.template.export-choice', { type: 'button', dataset: { type },
        onclick: () => { picked = type; sheet.close(); } }, V.icon(icon), V.h('span.t-name', { text: name }), V.h('span.t-hint', { text: hint }));
      const sheet = V.sheet({
        title,
        content: [
          warn ? V.h('p.export-warn', {}, V.icon('alert'), V.h('span', { text: warn })) : null,
          V.h('div.export-choices', {},
            option('txt', 'text', 'Text (.txt)', 'Plain words that open anywhere. Checklists show as [ ] and [x].'),
            option('md', 'notes', 'Markdown (.md)', 'As you wrote it, with its marks. For notes apps.')),
          about ? V.h('p.hint.export-about', { text: about }) : null,
        ],
        actions: [{ label: 'Cancel' }],
        onClose: () => resolve(picked),
      });
    });
  }

  const LOCKED_WARN = 'This note is locked in Wefty, but the file won\'t be: anyone who opens it can read it.';
  // A note open in the editor has its newest words saved first (typing not saved yet would be missing from the file).
  const settled = () => (V.editor && V.editor.settled ? V.editor.settled().catch(() => {}) : Promise.resolve());

  /* A note's Export (its ⋯ menu): `note` as it is now (the editor's words, which for an unlocked locked note are its
     sealed words, shown). */
  async function exportNote(note) {
    if (note.locked && !note.shown) return V.toast('Unlock the note first, then export it.');
    const type = await choose({ title: 'Export this note', warn: note.locked ? LOCKED_WARN : '',
      about: (note.attachments || []).length ? 'Its pictures and files stay in Wefty: the file names them.' : '' });
    if (!type) return null;
    return deliver(single(note, type)).catch(V.problem);
  }

  /* Copy as text: the note's plain words on the clipboard. */
  async function copyText(note) {
    if (note.locked && !note.shown) return V.toast('Unlock the note first.');
    await V.copy(text(note));
    V.toast('Copied as text');
  }

  function leftOut(made) {
    const said = [];
    if (made.locked) {
      said.push(made.locked === 1 ? '1 locked note was left out: open it, unlock it and export it from its ⋯ menu.'
        : `${made.locked} locked notes were left out: open each one, unlock it and export it from its ⋯ menu.`);
    }
    const missed = made.skipped.big + made.skipped.failed;
    if (missed) said.push(`${missed} picture${missed === 1 ? ' or file' : 's or files'} stayed in Wefty${made.skipped.failed ? ' (couldn\'t get them right now)' : ' (too big for one ZIP)'}: the notes name them.`);
    if (said.length) V.toast(said.join(' '), { ms: 9000 });
  }

  /* A ZIP made and handed over, with a line while pictures are fetched. */
  async function zipAndDeliver(how) {
    let told = false;
    const made = await zipOf({ ...how, onFile: (n, of) => {
      if (!told && of > 1) { told = true; V.toast(`Getting ${of} pictures and files ready...`, { ms: 4000 }); }
    } });
    if (!made.notes) {
      V.toast(made.locked ? 'Those notes are locked: open each one and export it from its ⋯ menu.' : 'There are no notes there to export.');
      return null;
    }
    const done = await deliver(made);
    leftOut(made);
    return done;
  }

  /* Picked notes' Export (Select notes): one note is its own file, several are one ZIP. */
  async function exportPicked(ids) {
    await settled();
    const rows = ids.map((id) => V.data.notes.get(id)).filter((n) => n && !n._purge);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const [note] = rows;
      if (note.locked) return V.toast('This note is locked: open it, unlock it, then export it from its ⋯ menu.', { ms: 6000 });
      const type = await choose({ title: 'Export this note', about: (note.attachments || []).length
        ? 'Its pictures and files stay in Wefty: the file names them.' : '' });
      if (!type) return null;
      return deliver(single(note, type)).catch(V.problem);
    }
    const locked = rows.filter((n) => n.locked).length;
    const type = await choose({ title: `Export ${rows.length} notes`,
      about: `One ZIP with a file for each note, and their pictures and files.${locked
        ? ` ${locked === rows.length ? 'They\'re' : `${locked} of them ${locked === 1 ? 'is' : 'are'}`} locked: locked notes are left out.` : ''}` });
    if (!type) return null;
    return zipAndDeliver({ ids: rows.map((n) => n.id), type }).catch(V.problem);
  }

  /* A folder's Export folder: its notes and the folders inside it, as one ZIP. */
  async function exportFolder(folderId) {
    await settled();
    const folder = V.data.folders.get(folderId);
    if (!folder) return null;
    const inside = V.organise.inside(folderId);
    const type = await choose({ title: `Export ${folder.name}`,
      about: `One ZIP with a file for each note${inside.size ? `, its folder${inside.size === 1 ? '' : 's'} inside it too` : ''}, `
        + 'and their pictures and files. Locked notes are left out.' });
    if (!type) return null;
    return zipAndDeliver({ folderId, type }).catch(V.problem);
  }

  return { note: exportNote, picked: exportPicked, folder: exportFolder, copyText, text, markdown, plain, single, zipOf,
    deliver, safeStem, fileName, MOST_FILES, LOCKED_WARN };
})();
