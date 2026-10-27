/* Vault: Claude, for the note-taker (js/notetaker.js). One request turns a transcript into notes: Claude Haiku at low
   effort, the cheapest there is (about a third of a cent for an hour of class).

   The key: the owner's own Claude key, kept in their private file storage at <owner>/private/claude.json, which only
   they can read. The PC puts Jarvis's key there itself (vault/notetaker.py: Python reads .env and uploads it, so it
   never passes through the page there); a phone or Chromebook can paste one instead. A phone or Chromebook fetches it
   when it makes notes and keeps it in memory only, never in this device's storage: a school Chromebook's storage
   isn't only the owner's, and fetching it again costs nothing. The key is never shown, not even partly. On the PC
   the request goes from Python (the makeNotes bridge call), with the key never in the page.

   Everything Vault's AI spends this month is added up in the settings row's extra.ai (shared by every device,
   written as an upsert of extra alone, never the PIN's columns), with a monthly limit (default $1.00, Settings > AI):
   once it's reached, no more requests until next month. */
'use strict';

V.ai = (() => {
  const API = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2026-10-21';
  const MODEL = 'claude-haiku-5-5';
  const MAX_TOKENS = 16000;
  // Dollars a million tokens (jarvis/costs.py PRICES); a prompt over 100K tokens costs more.
  const PRICE = { input: 0.10, output: 0.50 };
  const LONG = { over: 100000, input: 0.50, output: 2.50 };
  const LIMIT = 1.00;
  const KEY_FILE = 'claude.json';
  const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
  const CONSOLE = 'https://console.anthropic.com/settings/keys';

  let key = null;       // a phone's or Chromebook's copy of the key: in memory only
  let known = null;     // { cloud, pc }: where the key is (never the key)
  let looking = null;
  let saving = false;

  class AiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const owner = () => (V.data.user && V.data.user.id) || '';
  const folder = () => `${owner()}/private`;
  const keyPath = () => `${folder()}/${KEY_FILE}`;
  const month = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthName = () => new Date().toLocaleDateString([], { month: 'long' });

  /* -- what it costs */

  function price(usage) {
    const u = usage || {};
    const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const rate = input > LONG.over ? LONG : PRICE;
    return (input * rate.input + (u.output_tokens || 0) * rate.output) / 1e6;
  }

  /* "0.3¢" for less than a cent, else "$0.12". */
  function money(dollars) {
    const d = Math.max(0, Number(dollars) || 0);
    if (d === 0) return '$0.00';
    if (d < 0.01) return `${(d * 100).toFixed(d < 0.001 ? 2 : 1)}¢`;
    return `$${d.toFixed(2)}`;
  }

  /* This month's spending, as every device sees it (plus anything this one couldn't write yet). */
  let owed = 0;
  let owedRead = null;
  const readOwed = () => (owedRead = owedRead || V.db.meta('ai-owed').then((value) => { owed = Number(value) || 0; })
    .catch(() => {}));
  function tally() {
    const ai = ((V.data.settings || {}).extra || {}).ai || {};
    const same = ai.month === month();
    return { month: month(), spent: (same ? Number(ai.spent) || 0 : 0) + owed, calls: same ? Number(ai.calls) || 0 : 0,
      limit: typeof ai.limit === 'number' && ai.limit >= 0 ? ai.limit : LIMIT };
  }

  /* The settings row's extra.ai changed: read the cloud's newest extra first (another device may have spent since),
     then an upsert of extra alone. */
  async function writeAi(change) {
    let extra = (V.data.settings || {}).extra || {};
    try {
      const { data, error } = await V.cloud.sb.from('settings').select('extra').maybeSingle();
      if (error) throw error;
      if (data && data.extra) extra = data.extra;
    } catch (error) { /* this device's copy, then */ }
    const merged = { ...extra, ai: change({ ...(extra.ai || {}) }) };
    const { error } = await V.cloud.sb.from('settings').upsert({ extra: merged });
    if (error) throw error;
    V.data.settings = { ...V.data.settings, extra: merged };
    await V.db.meta('settings', V.data.settings);
    V.emit('data', 'settings');
  }

  async function count(cost) {
    const now = month();
    const add = cost + owed;
    try {
      await writeAi((ai) => (ai.month === now
        ? { ...ai, spent: (Number(ai.spent) || 0) + add, calls: (Number(ai.calls) || 0) + 1 }
        : { ...ai, month: now, spent: add, calls: 1 }));
      owed = 0;
      await V.db.meta('ai-owed', 0);
    } catch (error) {
      owed = add;  // counted here meanwhile, and added next time
      await V.db.meta('ai-owed', owed).catch(() => {});
    }
  }

  async function setLimit(dollars) {
    await writeAi((ai) => ({ ...ai, limit: dollars }));
  }

  /* -- the key */

  /* Where the key is: { cloud: in the owner's storage, pc: Jarvis has one (on the PC) }. */
  async function lookUp() {
    if (V.desktop) {
      if (!V.pc.can('aiKeyState')) return { cloud: false, pc: false, old: true };
      return V.pc.call('aiKeyState');
    }
    const { data, error } = await V.cloud.sb.storage.from('vault').list(folder(), { limit: 100 });
    if (error) throw error;
    return { cloud: (data || []).some((f) => f.name === KEY_FILE && f.id) };
  }

  function check() {
    if (!looking) {
      looking = lookUp().then((found) => { known = found; return found; })
        .catch((error) => { known = { failed: true }; throw error; })
        .finally(() => { looking = null; V.emit('ai', 'key'); });
    }
    return looking;
  }

  async function getKey() {
    if (key) return key;
    const { data, error } = await V.cloud.sb.storage.from('vault').download(keyPath());
    if (error || !data) {
      known = { ...(known || {}), cloud: false };
      throw new AiError('nokey', 'Set up the AI first: Settings > AI.');
    }
    let found = '';
    try { found = String(JSON.parse(await data.text()).key || '').trim(); } catch (e) { /* not a key file */ }
    if (!KEY_SHAPE.test(found)) throw new AiError('nokey', 'The key saved in your cloud isn\'t a Claude key. Set it up again in Settings > AI.');
    key = found;
    return key;
  }

  /* A key pasted on a phone or Chromebook, saved to the same place the PC puts Jarvis's. */
  async function saveKey(pasted) {
    const clean = String(pasted || '').trim();
    if (!KEY_SHAPE.test(clean)) throw new Error('That doesn\'t look like a Claude key: they start with sk-ant- and are long.');
    const record = { format: 1, key: clean, from: V.device, at: new Date().toISOString() };
    await V.cloud.upload(keyPath(), new Blob([JSON.stringify(record)], { type: 'application/json' }), { mime: 'application/json' });
    key = clean;
    known = { ...(known || {}), cloud: true };
  }

  async function shareFromPc() {
    known = await V.pc.call('aiKeyShare');
  }

  async function removeKey() {
    if (V.desktop) known = await V.pc.call('aiKeyRemove');
    else {
      await V.cloud.remove([keyPath()]);
      known = { ...(known || {}), cloud: false };
    }
    key = null;
  }

  /* -- asking Claude */

  const WORDS = {
    key: 'Claude didn\'t accept the key. Set it up again in Settings > AI.',
    busy: 'Claude is busy right now. Your words are saved: try again in a minute.',
    offline: 'Couldn\'t reach Claude from this network. Your words are saved — tap Make notes when you\'re on another network.',
    away: 'You\'re offline. Your words are saved — tap Make notes when you\'re back online.',
    old: 'This PC\'s Vault needs an update to make notes (open Jarvis and click Update). Or make them on your phone.',
  };

  async function direct(system, text) {
    const sending = await getKey();
    let response;
    try {
      response = await fetch(API, {
        method: 'POST',
        headers: { 'x-api-key': sending, 'anthropic-version': API_VERSION, 'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: 'low' }, system,
          messages: [{ role: 'user', content: text }] }),
      });
    } catch (error) {  // no internet, or a network that blocks Claude (a school's)
      throw new AiError('offline', navigator.onLine ? WORDS.offline : WORDS.away);
    }
    if (response.status === 401 || response.status === 403) { key = null; throw new AiError('key', WORDS.key); }
    if (response.status === 429 || response.status === 529 || response.status >= 500) throw new AiError('busy', WORDS.busy);
    let data = null;
    try { data = await response.json(); } catch (error) { /* not JSON */ }
    if (!response.ok || !data) {
      const said = data && data.error && data.error.message;
      throw new AiError('bad', `Claude couldn't make notes from this${said ? ` (${said})` : ''}. Your words are saved.`);
    }
    const words = (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
    return { text: words, stopReason: data.stop_reason || '', usage: data.usage || {} };
  }

  async function viaPc(system, text) {
    if (!V.pc.can('makeNotes')) throw new AiError('old', WORDS.old);
    const answer = await V.pc.call('makeNotes', { system, transcript: text });
    if (!answer.ok) {
      const kind = answer.kind || 'bad';
      throw new AiError(kind, WORDS[kind] || (kind === 'nokey' ? answer.message
        : `Claude couldn't make notes from this (${answer.message || 'no answer'}). Your words are saved.`));
    }
    return { text: answer.text || '', stopReason: answer.stop_reason || '', usage: answer.usage || {} };
  }

  /* One request: { text, stopReason, usage, cost }, or an AiError whose message is ready to show. */
  async function ask({ system, text }) {
    await readOwed();
    const now = tally();
    if (now.limit > 0 && now.spent >= now.limit) {
      throw new AiError('limit', `Vault's AI has used this month's ${money(now.limit)} (${monthName()}). Change the limit in Settings > AI, or wait for next month.`);
    }
    const answer = V.desktop ? await viaPc(system, text) : await direct(system, text);
    const cost = price(answer.usage);
    await count(cost);
    return { ...answer, cost };
  }

  /* -- Settings > AI */

  function keyLine(ui) {
    if (!known) {
      if (!looking) check().catch(() => {});  // Settings is drawn again when it knows ('ai')
      return ui.line('Claude key', 'Checking...', null);
    }
    if (known.failed) {
      return ui.line('Claude key', 'Couldn\'t check just now (are you online?).', V.button('Check again', {
        onClick: () => { known = null; ui.draw(); } }));
    }
    const ready = V.h('span.ai-ready', {}, V.icon('check'), V.h('span', { text: 'Set up' }));
    const remove = V.button('Remove', { kind: 'danger-quiet', onClick: async () => {
      const sure = await V.confirm('Remove the Claude key?', 'Your phone and Chromebook stop making notes until it\'s set up again. Jarvis keeps his own.',
        { ok: 'Remove', danger: true });
      if (!sure) return;
      try { await removeKey(); V.toast('Key removed.'); } catch (error) { V.problem(error); }
      ui.draw();
    } });
    if (known.cloud) {
      return ui.line('Claude key', V.desktop ? 'Jarvis\'s key is in your own cloud: your phone and Chromebook can make notes.'
        : 'In your own cloud, never shown. Notes can be made here.', V.h('div.setting-buttons', {}, ready, remove));
    }
    if (V.desktop) {
      if (known.old) return ui.line('Claude key', 'Open Jarvis and click Update to set this up.', null);
      return V.h('div.ai-key', {},
        ui.line('Claude key', known.pc ? 'Notes are made on this PC with Jarvis\'s key. Your phone and Chromebook need it too.'
          : 'Jarvis has no Claude key yet. Add it in Jarvis\'s Settings first.', null),
        known.pc ? V.h('div.setting-buttons', {}, V.button('Use Jarvis\'s Claude key on my phone and Chromebook', {
          kind: 'primary', icon: 'phone', disabled: saving, onClick: async () => {
            saving = true;
            ui.draw();
            try { await shareFromPc(); V.toast('Done. Your phone and Chromebook can make notes now.'); } catch (error) { V.problem(error); }
            saving = false;
            ui.draw();
          } })) : null);
    }
    const box = V.h('input.field', { type: 'password', placeholder: 'sk-ant-...', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Claude API key' });
    const save = V.button('Save', { kind: 'primary', onClick: async () => {
      try {
        await saveKey(box.value);
        box.value = '';
        V.toast('Key saved. Notes can be made now.');
        ui.draw();
      } catch (error) { V.problem(error); }
    } });
    box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); });
    const open = () => window.open(CONSOLE, '_blank', 'noopener');
    return V.h('div.ai-key', {},
      ui.line('Claude key', 'On your PC: Vault > Settings > AI does it in one tap. Or paste a key from console.anthropic.com here: it\'s kept in your own cloud and never shown.', null),
      V.h('div.ai-key-row', {}, box, save),
      V.h('button.link-btn.ai-console', { type: 'button', text: 'Get a key at console.anthropic.com', onclick: open }));
  }

  function card(ui) {
    if (!owedRead) readOwed().then(() => { if (owed) ui.draw(); });
    const now = tally();
    const limit = V.button('Change limit', { onClick: async () => {
      const answer = await V.ask('Monthly limit', { value: now.limit.toFixed(2), type: 'number', ok: 'Save',
        label: 'Dollars a month', hint: 'Vault\'s AI stops for the month once it has spent this. 0 means no limit.' });
      if (answer === null) return;
      const dollars = Math.round(Number(answer) * 100) / 100;
      if (!Number.isFinite(dollars) || dollars < 0) return V.toast('Type an amount, like 1.00.', { kind: 'err' });
      try { await setLimit(dollars); V.toast(dollars ? `The limit is ${money(dollars)} a month.` : 'No limit.'); } catch (error) { V.problem(error); }
    } });
    const spent = `${money(now.spent)} of ${now.limit ? money(now.limit) : 'no limit'}`
      + (now.calls ? ` · ${now.calls} note${now.calls === 1 ? '' : 's'} made` : '');
    return ui.card('AI note-taker',
      keyLine(ui),
      ui.line(`This month (${monthName()})`, spent, limit),
      V.h('p.hint.ai-privacy', { text: 'Claude (by Anthropic) reads the transcript only when you make notes, and never hears the sound itself.' }));
  }

  V.on('signed-out', () => { key = null; known = null; });

  return { ask, price, money, tally, check, card, getKey, saveKey, removeKey, AiError, state: () => known,
    ready: () => !!(known && (known.cloud || (V.desktop && known.pc))), MODEL, API_VERSION };
})();
