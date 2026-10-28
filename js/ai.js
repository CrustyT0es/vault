/* Vault: Claude, for the note-taker (js/notetaker.js) and the Claude tab (js/chat.js). For the note-taker, one request
   turns a transcript into notes: Claude Haiku at low effort, the cheapest there is (about a third of a cent for an hour
   of class). The chat streams its own requests, and shares the key, the prices and the monthly tally kept here.

   The key: the owner's own Claude key, kept in their private file storage at <owner>/private/claude.json, which only
   they can read. The PC puts Jarvis's key there itself (vault/notetaker.py: Python reads .env and uploads it, so it
   never passes through the page there); a phone or Chromebook can paste one instead. A phone or Chromebook fetches it
   when it makes notes and keeps it in memory only, never in this device's storage: a school Chromebook's storage
   isn't only the owner's, and fetching it again costs nothing. The key is never shown, not even partly. On the PC
   the request goes from Python (the makeNotes bridge call), with the key never in the page. Vault on its own
   (V.pc.standalone(): no Jarvis on that PC, so no Jarvis key) keeps its keys the phone's way (`ownKeys`): pasted in
   Settings > AI, and Gemini for the note-taker when there's no Claude key; Claude still goes through Python there.

   Everything Vault's AI spends this month is added up in the settings row's extra.ai (shared by every device,
   written as an upsert of extra alone, never the PIN's columns), with a monthly limit (default $1.00, Settings > AI):
   once it's reached, no more requests until next month. */
'use strict';

V.ai = (() => {
  const API = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2026-10-21';
  const MODEL = 'claude-haiku-5-5';
  const MAX_TOKENS = 16000;
  // Dollars a million tokens, as jarvis/costs.py PRICES has them: input, output, cache write (5 minutes), cache read.
  // Claude Haiku 5.5 costs more once a prompt is over 100K tokens. The last three are the models the API may answer
  // with instead when one declines (a server-side fallback), priced as themselves.
  const PRICES = {
    'claude-haiku-5-5': { input: 0.10, output: 0.50, write: 0.125, read: 0.01,
      long: { over: 100000, input: 0.50, output: 2.50, write: 0.625, read: 0.05 } },
    'claude-sonnet-5-5': { input: 2.00, output: 10.00, write: 2.50, read: 0.20 },
    'claude-opus-5-5': { input: 4.00, output: 20.00, write: 5.00, read: 0.20 },
    'claude-fable-5-1': { input: 10.00, output: 50.00, write: 12.50, read: 0.25 },
    'claude-sonnet-5': { input: 2.00, output: 10.00, write: 2.50, read: 0.20 },
    'claude-opus-5': { input: 5.00, output: 25.00, write: 6.25, read: 0.50 },
    'claude-opus-4-8': { input: 5.00, output: 25.00, write: 6.25, read: 0.50 },
  };
  const SEARCH = 0.01;  // dollars a web search
  const LIMIT = 1.00;
  const KEY_FILE = 'claude.json';
  const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
  const CONSOLE = 'https://console.anthropic.com/settings/keys';

  // Gemini (Google), the free backup brain. The note-taker and the Claude tab fall back to it when there's no Claude
  // key — a friend or classmate with no paid key. It's called the same way: straight from this device to Google with
  // that person's own free key (aistudio.google.com/apikey), kept in their own private storage at
  // <owner>/private/gemini.json, in memory only on a phone or Chromebook, exactly like the Claude one and never shown.
  // Google's free tier costs nothing, so Gemini answers are never charged or counted against the monthly limit. It is
  // NOT a way past a school's content filter: like Claude, Google's API is blocked on a school network — use mobile
  // data, or let the note wait and go when you're home.
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const GEMINI_MODEL = 'gemini-2.5-flash';   // the free default; the Claude tab offers it as a model
  const GEMINI_KEY_FILE = 'gemini.json';
  const GEMINI_KEY_SHAPE = /^AIza[0-9A-Za-z_-]{30,}$/;
  const GEMINI_CONSOLE = 'https://aistudio.google.com/apikey';

  let key = null;       // a phone's or Chromebook's copy of the key: in memory only
  let geminiKey = null; // likewise for the Gemini key
  let known = null;     // { cloud, pc, gemini }: where the keys are (never the key itself)
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
  // Whether this device's page keeps the AI keys itself: a phone or Chromebook, or Vault on its own on a PC. The PC
  // with Jarvis keeps Jarvis's key in Python instead (aiKeyState/aiKeyShare/aiKeyRemove).
  const ownKeys = () => !V.desktop || !!(V.pc && V.pc.standalone && V.pc.standalone());
  const month = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthName = () => new Date().toLocaleDateString([], { month: 'long' });

  /* -- what it costs */

  /* The rates of `model` for a prompt of `prompt` tokens (an unknown model is priced as Fable, the dearest). */
  function rates(model, prompt = 0) {
    const p = PRICES[model] || PRICES['claude-fable-5-1'];
    return p.long && prompt > p.long.over ? p.long : p;
  }

  /* What one response cost, from its `usage`. With a server-side fallback, usage.iterations has each model's own try
     (each priced as that model); web searches are a cent each. */
  function price(usage, model = MODEL) {
    const u = usage || {};
    if (u.gemini) return 0;  // Google's free tier: never charged, never counted against the monthly limit
    const one = (part, who) => {
      const fresh = Number(part.input_tokens) || 0;
      const write = Number(part.cache_creation_input_tokens) || 0;
      const read = Number(part.cache_read_input_tokens) || 0;
      const r = rates(PRICES[who] ? who : model, fresh + write + read);
      return (fresh * r.input + write * r.write + read * r.read + (Number(part.output_tokens) || 0) * r.output) / 1e6;
    };
    const tries = (Array.isArray(u.iterations) ? u.iterations : []).filter((it) => it && typeof it.input_tokens === 'number');
    const tokens = tries.length ? tries.reduce((sum, it) => sum + one(it, it.model || model), 0) : one(u, model);
    const searches = Number((u.server_tool_use || {}).web_search_requests) || 0;
    return tokens + searches * SEARCH;
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

  /* `cost` added to this month's tally (every device's), as one more request. */
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
    if (!ownKeys()) {
      if (!V.pc.can('aiKeyState')) return { cloud: false, pc: false, old: true };
      return V.pc.call('aiKeyState');
    }
    const { data, error } = await V.cloud.sb.storage.from('vault').list(folder(), { limit: 100 });
    if (error) throw error;
    const files = data || [];
    return { cloud: files.some((f) => f.name === KEY_FILE && f.id),
      gemini: files.some((f) => f.name === GEMINI_KEY_FILE && f.id) };
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
    if (!ownKeys()) known = await V.pc.call('aiKeyRemove');
    else {
      await V.cloud.remove([keyPath()]);
      known = { ...(known || {}), cloud: false };
    }
    key = null;
  }

  /* -- the Gemini key (a phone's or Chromebook's, in the same private place, in memory only) */

  const geminiPath = () => `${folder()}/${GEMINI_KEY_FILE}`;
  const forgetGeminiKey = () => { geminiKey = null; };

  async function getGeminiKey() {
    if (geminiKey) return geminiKey;
    const { data, error } = await V.cloud.sb.storage.from('vault').download(geminiPath());
    if (error || !data) {
      known = { ...(known || {}), gemini: false };
      throw new AiError('nokey', 'Add a free Google key first: Settings > AI.');
    }
    let found = '';
    try { found = String(JSON.parse(await data.text()).key || '').trim(); } catch (e) { /* not a key file */ }
    if (!GEMINI_KEY_SHAPE.test(found)) throw new AiError('nokey', 'The Gemini key saved in your cloud isn\'t a Google key. Set it up again in Settings > AI.');
    geminiKey = found;
    return geminiKey;
  }

  async function saveGeminiKey(pasted) {
    const clean = String(pasted || '').trim();
    if (!GEMINI_KEY_SHAPE.test(clean)) throw new Error('That doesn\'t look like a Google key: they start with AIza and are long. Get one free at aistudio.google.com/apikey.');
    const record = { format: 1, key: clean, from: V.device, at: new Date().toISOString() };
    await V.cloud.upload(geminiPath(), new Blob([JSON.stringify(record)], { type: 'application/json' }), { mime: 'application/json' });
    geminiKey = clean;
    known = { ...(known || {}), gemini: true };
  }

  async function removeGeminiKey() {
    await V.cloud.remove([geminiPath()]);
    known = { ...(known || {}), gemini: false };
    geminiKey = null;
  }

  /* -- asking Claude */

  const WORDS = {
    key: 'Claude didn\'t accept the key. Set it up again in Settings > AI.',
    geminiKey: 'Google didn\'t accept the Gemini key. Set it up again in Settings > AI.',
    busy: 'Claude is busy right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    offline: 'Claude can\'t be reached from this network. Your words are saved, and the notes will be made by themselves once it can be (or tap Make notes).',
    away: 'You\'re offline. Your words are saved, and the notes will be made by themselves when you\'re back online.',
    old: 'This PC\'s Vault needs an update to make notes (open Jarvis and click Update). Or make them on your phone.',
  };

  async function direct(system, text) {
    const sending = await getKey();
    let response;
    try {
      response = await fetch(API, {
        method: 'POST',
        headers: headers(sending),
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

  /* One request straight to Google's Gemini API. `contents` is Gemini's own shape ([{ role:'user'|'model', parts:[...] }]);
     the note-taker sends one user turn, the Claude tab a whole conversation. Returns { text, stopReason, usage } like
     `direct`, with usage.gemini so it's priced as free. Never retried. */
  async function callGemini({ system, contents, model = GEMINI_MODEL, maxTokens = MAX_TOKENS, signal } = {}) {
    const sending = await getGeminiKey();
    const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    let response;
    try {
      response = await fetch(`${GEMINI_API}${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': sending },
        body: JSON.stringify(body),
      });
    } catch (error) {  // stopped, no internet, or a network that blocks Google (a school's)
      if (signal && signal.aborted) throw new AiError('stopped', 'Stopped.');
      throw new AiError('offline', navigator.onLine ? WORDS.offline : WORDS.away);
    }
    if (response.status === 401 || response.status === 403 || response.status === 400) {
      // 400 is often a bad key too: forget it so a replaced one is read next time.
      let said = ''; try { said = ((await response.json()).error || {}).message || ''; } catch (e) { /* not JSON */ }
      geminiKey = null;
      throw new AiError('key', said && !/key/i.test(said) ? `Google turned the request down (${said}).` : WORDS.geminiKey);
    }
    if (response.status === 429 || response.status >= 500) throw new AiError('busy', WORDS.busy);
    let data = null;
    try { data = await response.json(); } catch (error) { /* not JSON */ }
    if (!response.ok || !data) {
      const said = data && data.error && data.error.message;
      if (response.status === 404) throw new AiError('bad', `The Gemini model "${model}" isn't available for this key${said ? ` (${said})` : ''}. Try again later.`);
      throw new AiError('bad', `Gemini couldn't answer this${said ? ` (${said})` : ''}.`);
    }
    const cand = (data.candidates || [])[0] || {};
    const finish = String(cand.finishReason || '');
    const text = (((cand.content || {}).parts) || []).filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('');
    const stopReason = finish === 'MAX_TOKENS' ? 'max_tokens'
      : ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII'].includes(finish) ? 'refusal'
      : 'end_turn';
    const m = data.usageMetadata || {};
    return { text, stopReason, usage: { gemini: true, model, input_tokens: m.promptTokenCount || 0, output_tokens: m.candidatesTokenCount || 0 } };
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

  /* An AiError when this month's limit is reached (null while there's money left). */
  async function overLimit() {
    await readOwed();
    const now = tally();
    if (now.limit > 0 && now.spent >= now.limit) {
      return new AiError('limit', `Vault's AI has used this month's ${money(now.limit)} (${monthName()}). Raise the limit in Settings > AI, or wait for next month.`);
    }
    return null;
  }

  /* The headers every request straight to Claude carries (`betas`: the beta features it uses). */
  function headers(sending, betas = []) {
    const out = { 'x-api-key': sending, 'anthropic-version': API_VERSION, 'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true' };
    if (betas.length) out['anthropic-beta'] = betas.join(',');
    return out;
  }

  /* The key was refused: this device forgets its copy, so it's fetched again next time (it may have been replaced). */
  const forgetKey = () => { key = null; };

  /* A quick, cheap check that this network reaches Claude at all (Settings' "Check Claude" button, and the same idea
     the waiting messages lean on). One tiny request straight to api.anthropic.com with a throwaway key and an empty
     body: the server turns it away (401/400) before writing anything, so it costs nothing and isn't tallied. Any HTTP
     answer — even an error status — proves the network got through; only a fetch that throws means the network blocks
     Claude. Returns 'offline' | 'blocked' | 'reachable'. Nothing ever goes anywhere but api.anthropic.com (on the PC
     too: no key enters the page, and the empty request writes nothing). */
  async function reachable() {
    if (!navigator.onLine) return 'offline';
    try {
      await fetch(API, { method: 'POST', headers: headers('x'), body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [] }) });
      return 'reachable';
    } catch (error) {
      return 'blocked';
    }
  }

  /* One request: { text, stopReason, usage, cost }, or an AiError whose message is ready to show. */
  async function ask({ system, text }) {
    const over = await overLimit();
    if (over) throw over;
    // Which brain: the PC uses Jarvis's Claude; elsewhere Claude if its key is set up, otherwise the free Gemini key
    // (Vault on its own on a PC too, its Claude going through Python like the PC with Jarvis).
    if (!known && ownKeys()) { try { await check(); } catch (e) { /* carry on and let the request say what's wrong */ } }
    const useGemini = ownKeys() && !(known && known.cloud) && !!(known && known.gemini);
    const answer = useGemini ? await callGemini({ system, contents: [{ role: 'user', parts: [{ text }] }] })
      : V.desktop ? await viaPc(system, text)
      : await direct(system, text);
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
      const sure = await V.confirm('Remove the Claude key?', V.desktop && ownKeys()
        ? 'This PC, your phone and your Chromebook stop using Claude until it\'s set up again.'
        : 'Your phone and Chromebook stop using Claude until it\'s set up again. Jarvis keeps his own.',
        { ok: 'Remove', danger: true });
      if (!sure) return;
      try { await removeKey(); V.toast('Key removed.'); } catch (error) { V.problem(error); }
      ui.draw();
    } });
    if (known.cloud) {
      return ui.line('Claude key', !ownKeys() ? 'Jarvis\'s key is in your own cloud: your phone and Chromebook can use Claude too.'
        : 'In your own cloud, never shown. Claude can be used here.', V.h('div.setting-buttons', {}, ready, remove));
    }
    if (!ownKeys()) {
      if (known.old) return ui.line('Claude key', 'Open Jarvis and click Update to set this up.', null);
      return V.h('div.ai-key', {},
        ui.line('Claude key', known.pc ? 'Claude is used on this PC with Jarvis\'s key. Your phone and Chromebook need it too.'
          : 'Jarvis has no Claude key yet. Add it in Jarvis\'s Settings first.', null),
        known.pc ? V.h('div.setting-buttons', {}, V.button('Use Jarvis\'s Claude key on my phone and Chromebook', {
          kind: 'primary', icon: 'phone', disabled: saving, onClick: async () => {
            saving = true;
            ui.draw();
            try { await shareFromPc(); V.toast('Done. Your phone and Chromebook can use Claude now.'); } catch (error) { V.problem(error); }
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
        V.toast('Key saved. Claude can be used here now.');
        ui.draw();
      } catch (error) { V.problem(error); }
    } });
    box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); });
    const open = () => window.open(CONSOLE, '_blank', 'noopener');
    return V.h('div.ai-key.ai-key-claude', {},
      ui.line('Claude key', V.desktop ? 'Paste a key from console.anthropic.com here: it\'s kept in your own cloud and never shown, and your phone and Chromebook can use it too.'
        : 'On your PC: Vault > Settings > AI does it in one tap. Or paste a key from console.anthropic.com here: it\'s kept in your own cloud and never shown.', null),
      V.h('div.ai-key-row', {}, box, save),
      V.h('button.link-btn.ai-console', { type: 'button', text: 'Get a key at console.anthropic.com', onclick: open }));
  }

  /* The free Gemini key row: paste a free Google key on a phone or Chromebook (the owner uses Claude on the PC). */
  function geminiKeyLine(ui) {
    if (!ownKeys()) {
      return ui.line('Gemini key (free)', 'A free backup from Google, for when there\'s no Claude key. Add it on your phone or Chromebook (Vault > Settings > AI there).', null);
    }
    if (known && known.gemini) {
      const ready = V.h('span.ai-ready', {}, V.icon('check'), V.h('span', { text: 'Set up' }));
      const remove = V.button('Remove', { kind: 'danger-quiet', onClick: async () => {
        const sure = await V.confirm('Remove the Gemini key?', 'This device stops using Google\'s free Gemini.', { ok: 'Remove', danger: true });
        if (!sure) return;
        try { await removeGeminiKey(); V.toast('Gemini key removed.'); } catch (error) { V.problem(error); }
        ui.draw();
      } });
      return ui.line('Gemini key (free)', V.desktop
        ? 'Google\'s free model: on this PC it makes the note-taker\'s notes when there\'s no Claude key (Gemini chats are on your phone or Chromebook).'
        : 'Google\'s free model, used when there\'s no Claude key.', V.h('div.setting-buttons', {}, ready, remove));
    }
    const box = V.h('input.field', { type: 'password', placeholder: 'AIza...', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Gemini API key' });
    const save = V.button('Save', { kind: 'primary', onClick: async () => {
      try { await saveGeminiKey(box.value); box.value = ''; V.toast('Gemini key saved — it\'s free to use.'); ui.draw(); }
      catch (error) { V.problem(error); }
    } });
    box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); });
    const open = () => window.open(GEMINI_CONSOLE, '_blank', 'noopener');
    return V.h('div.ai-key.ai-key-gemini', {},
      ui.line('Gemini key (free)', 'No Claude key? Google\'s Gemini is free. Get a key at aistudio.google.com/apikey and paste it here: it\'s kept in your own cloud and never shown. (Like Claude, it won\'t work on school wifi — use mobile data.)', null),
      V.h('div.ai-key-row', {}, box, save),
      V.h('button.link-btn.ai-console', { type: 'button', text: 'Get a free key at aistudio.google.com', onclick: open }));
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
      + (now.calls ? ` · ${now.calls} request${now.calls === 1 ? '' : 's'}` : '');
    // "Check Claude": one plain line saying whether this network lets Claude through. The result replaces the hint.
    const check = V.h('span.ai-check', { role: 'status', text: 'See if this network lets Claude through.' });
    const checkBtn = V.button('Check Claude', { onClick: async () => {
      checkBtn.disabled = true;
      check.dataset.state = '';
      check.textContent = 'Checking…';
      try {
        const how = await reachable();
        check.dataset.state = how;
        check.textContent = how === 'reachable' ? 'Claude works ✓'
          : how === 'offline' ? 'You’re offline.'
          : 'This network is blocking Claude — try your phone’s mobile data, or it’ll send automatically when you’re home.';
      } finally {
        checkBtn.disabled = false;
      }
    } });
    return ui.card('AI',
      keyLine(ui),
      geminiKeyLine(ui),
      V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Reach Claude' }), check), checkBtn),
      ui.line(`This month (${monthName()})`, spent, limit),
      V.h('p.hint.ai-privacy', { text: 'Claude (by Anthropic), and Gemini (by Google) when you use it, only read what you send: '
        + 'a transcript when you make notes, and your messages in the Claude tab. Neither hears the sound itself. Gemini is '
        + 'free, so it isn\'t counted here.' }));
  }

  V.on('signed-out', () => { key = null; known = null; });

  return { ask, price, rates, money, tally, count, overLimit, headers, forgetKey, check, reachable, card, getKey, saveKey,
    removeKey, callGemini, getGeminiKey, saveGeminiKey, removeGeminiKey, forgetGeminiKey, AiError, WORDS, PRICES,
    state: () => known, ready: () => !!(known && (known.cloud || (V.desktop && known.pc) || known.gemini)),
    // The Claude tab on a PC answers with Claude only (chat.js), so a PC never "has" Gemini for it.
    has: (who) => (who === 'gemini' ? !V.desktop && !!(known && known.gemini) : !!(known && (known.cloud || (V.desktop && known.pc)))),
    MODEL, API, API_VERSION, GEMINI_MODEL };
})();
