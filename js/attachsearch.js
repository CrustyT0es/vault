/* Vault: finding words inside a note's attachments (photos, PDFs, drawings, voice memos). The PC reads them while
   it's on (vault/attach_index.py) and keeps the words in one small file in the owner's own private cloud storage,
   <owner>/private/search-index.json. Here we load that file and let search match against it, so a note whose photo
   says "zucchini" turns up for "zucchini" with a little "in a photo" label. Off until the owner turns it on, on the
   PC; with no index file (off, or nothing read yet) search behaves exactly as before. Locked notes are never matched
   (their words aren't in the index, and we guard here too).

   The hooks are tiny and additive: organise.js's search asks hasWord(note, word), notes.js's card asks chip(note,
   terms) for the label and redraws on the 'attach-index' event when the index arrives, and settings.js shows card(). */
'use strict';

V.attachSearch = (() => {
  const FRESH = 2 * 60 * 1000;   // the index is re-fetched at most this often
  const LABELS = {
    photo: { icon: 'image', text: 'in a photo' },
    pdf: { icon: 'file', text: 'in a PDF' },
    drawing: { icon: 'image', text: 'in a drawing' },
    voice: { icon: 'file', text: 'in a voice memo' },
    file: { icon: 'file', text: 'in a file' },
  };

  let byNote = new Map();        // note id -> [{ kind, text }] (text already lowercased)
  let at = 0;                    // when the index was last loaded here
  let loading = null;

  const owner = () => (V.data.user && V.data.user.id) || '';
  const path = () => `${owner()}/private/search-index.json`;

  async function fetchIndex() {
    if (!owner() || !V.cloud.sb) return null;
    const { data, error } = await V.cloud.sb.storage.from('vault').download(path());
    if (error || !data) return null;   // none yet (feature off, nothing read), or offline
    try { return JSON.parse(await data.text()); } catch (problem) { return null; }
  }

  function take(payload) {
    const map = new Map();
    for (const entry of (payload && payload.entries) || []) {
      if (!entry || !entry.note_id || !entry.text) continue;
      const list = map.get(entry.note_id) || [];
      list.push({ kind: entry.kind || 'file', text: String(entry.text).toLowerCase() });
      map.set(entry.note_id, list);
    }
    byNote = map;
    at = Date.now();
  }

  /* Load the index (at most every FRESH, unless forced), then redraw the list if there's anything to match on. */
  function prime(force = false) {
    if (loading) return loading;
    if (!force && at && Date.now() - at < FRESH) return Promise.resolve();
    loading = fetchIndex().then((payload) => {
      const before = byNote.size;
      take(payload || { entries: [] });   // null (none/offline) empties it: search just falls back to title and words
      if (byNote.size || before) V.emit('attach-index');
    }).catch(() => {}).finally(() => { loading = null; });
    return loading;
  }

  /* organise.js's search: does any of this note's indexed attachments hold `word`? (Never a locked note.) */
  function hasWord(note, word) {
    if (!note || note.locked || !word) return false;
    prime();
    const list = byNote.get(note.id);
    return !!list && list.some((a) => a.text.includes(word));
  }

  /* notes.js's card: a small chip saying where a searched word was found ("in a photo"), or null. */
  function chip(note, terms) {
    if (!note || note.locked) return null;
    const list = byNote.get(note.id);
    if (!list || !list.length) return null;
    const words = (terms || []).filter((t) => t && !String(t).startsWith('#')).map((t) => String(t).toLowerCase());
    if (!words.length) return null;
    const hit = list.find((a) => words.some((w) => a.text.includes(w)));
    if (!hit) return null;
    const label = LABELS[hit.kind] || LABELS.file;
    return V.h('span.tag.found-in', { title: 'A word you searched is ' + label.text },
      V.icon(label.icon), V.h('span', { text: label.text }));
  }

  /* -- Settings' "Search inside attachments" card (the PC, where the reading happens). `ui` is Settings' own. */

  let status = null;
  let asking = null;

  function refreshStatus(ui) {
    if (asking || !(V.pc && V.pc.can('indexStatus'))) return;
    asking = V.pc.call('indexStatus').then((answer) => { status = answer; }).catch(() => {})
      .finally(() => { asking = null; if (ui) ui.draw(); });
  }

  function card(ui) {
    if (!V.desktop || !V.prefs) return null;  // the switch and the reading are on the PC; the phone just benefits
    if (status === null) refreshStatus(ui);
    const on = !!V.prefs.attachIndex;
    const read = status && status.entries;
    const line = ui.line('Search inside photos, PDFs and recordings',
      'Your PC reads them while it\'s on, so search finds words inside them. The words stay in your own private '
      + 'cloud. Setup adds the readers the first time.', ui.toggle('attachIndex'));
    const rows = [line];
    if (V.pc && V.pc.can('indexStatus')) {
      const said = !on ? 'Off. Turn it on and your PC reads your attachments.'
        : read ? `${read} attachment${read === 1 ? '' : 's'} read so far` : 'Nothing read yet.';
      rows.push(ui.line(said, on ? 'Photos, PDFs, drawings and voice memos.' : '',
        V.button('Index now', { icon: 'restore', disabled: !on, onClick: async () => {
          try { status = await V.pc.call('indexNow'); } catch (error) { V.problem(error); }
          ui.draw();
        } })));
    }
    return ui.card('Search inside attachments', ...rows);
  }

  // Warm the index once the cloud is in step, so the first search is ready (prime() throttles repeat calls).
  V.on('status', (state) => { if (state === 'synced') prime(); });

  return { prime, reload: () => prime(true), hasWord, chip, card, loaded: () => at > 0 };
})();
