/* Vault: notes sent to this device. "Send to…" under a Claude answer (js/chat.js) saves it as an ordinary note in the
   Inbox with extra.sent = { to, from, at } (a device of util.js's V.DEVICES, an ISO time): it syncs like any note,
   nothing goes through anyone else. When one for this device arrives, made on another, a toast says "New from your
   phone: <title>" with Open.

   Each device keeps what it has already said (or the owner opened) in localStorage 'vault-arrivals' ({ since, seen }),
   so a reload never says it again, and `since` (when this device first watched, signed in) keeps a device signing in
   for the first time from announcing notes sent long before. While Vault is out of sight it waits, and says them when
   it's back. */
'use strict';

V.arrivals = (() => {
  const KEY = 'vault-arrivals';
  const KEEP = 300;  // note ids remembered (the newest)
  let kept = null;   // { since, seen: [ids] }

  function load() {
    if (kept) return kept;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (error) { saved = null; }
    if (saved && typeof saved.since === 'string' && Array.isArray(saved.seen)) kept = saved;
    else {
      kept = { since: new Date().toISOString(), seen: [] };
      save();
    }
    return kept;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(kept)); } catch (error) { /* private browsing: only until it closes */ }
  }

  function remember(ids) {
    const state = load();
    const fresh = ids.filter((id) => !state.seen.includes(id));
    if (!fresh.length) return;
    state.seen = [...state.seen, ...fresh].slice(-KEEP);
    save();
  }

  const sentOf = (note) => {
    const sent = note && note.extra && note.extra.sent;
    return sent && typeof sent === 'object' && !Array.isArray(sent) ? sent : null;
  };

  /* Notes for this device, from another, not said yet here and sent since this device started watching. */
  function waiting() {
    const state = load();
    const since = Date.parse(state.since) || 0;
    const seen = new Set(state.seen);
    return [...V.data.notes.values()].filter((note) => {
      const sent = sentOf(note);
      if (!sent || sent.to !== V.device || !sent.from || sent.from === V.device) return false;
      if (note.deleted || note._purge || seen.has(note.id)) return false;
      const at = Date.parse(sent.at);
      return Number.isFinite(at) && at >= since;
    }).sort((a, b) => String(sentOf(a).at).localeCompare(String(sentOf(b).at)));
  }

  function open(id) {
    if (!V.data.notes.has(id)) return;
    if (V.tab() !== 'notes') V.go('notes');
    V.notes.open(id);
  }

  function check() {
    if (!V.data.user || !V.data.notes) return;
    load();  // (the first time: from now on)
    if (V.away() || !V.go) return;  // said when Vault is back in front
    const list = waiting();
    if (!list.length) return;
    remember(list.map((note) => note.id));
    if (list.length === 1) {
      const note = list[0];
      V.toast(`New from ${V.deviceName(sentOf(note).from)}: ${V.noteTitle(note)}`,
        { action: 'Open', onAction: () => open(note.id), ms: 8000 });
      return;
    }
    const froms = new Set(list.map((note) => sentOf(note).from));
    const who = froms.size === 1 ? V.deviceName([...froms][0]) : 'your other devices';
    V.toast(`${list.length} new notes from ${who}`, { action: 'Show', onAction: () => { if (V.tab() !== 'notes') V.go('notes'); },
      ms: 8000 });
  }

  V.on('data', (table) => { if (table === 'notes') check(); });
  V.on('back', () => check());
  // Opened here before it was said (from the list): nothing more to say about it.
  V.on('note-opened', (id) => {
    const sent = sentOf(V.data.notes.get(id));
    if (sent && sent.to === V.device) remember([id]);
  });

  return { check, waiting };
})();
