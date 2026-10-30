/* Vault: the AI, for the note-taker (js/notetaker.js) and the Chat tab (js/chat.js). Google's free Gemini does it all
   by default (1.9: the owner asked for Gemini first, Claude optional). "Use Claude too" (Settings > AI) is one setting
   for the whole account, kept in the settings row's extra.ai.claude (off unless switched on, existing accounts too):
   only while it's on is Claude offered in Chat, used by the note-taker, and counted against the monthly limit. While
   it's off nothing here ever uses a Claude key, Jarvis's included (`claudeOn`: getKey, the PC's makeNotes and every
   brain choice check it). Even with Claude on, Gemini writes the note-taker's notes (the owner: "by default have
   Gemini do the auto notes summary"), or Claude when there's no Gemini key; "Write notes with Claude" (extra.ai.
   notes_claude, beside the switch, also for every device) hands them to Claude (`brain`). For the note-taker, one
   request turns a transcript into notes: Gemini, or Claude Haiku at low effort, the cheapest there is (about a third
   of a cent for an hour of class). The chat streams its own requests, and shares the keys, the prices and the monthly
   tally kept here.

   The Claude key: the owner's own Claude key, kept in their private file storage at <owner>/private/claude.json, which only
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

  // Gemini (Google), the free brain: Chat's and the note-taker's own unless Claude is switched on (and then still the
  // note-taker's when there's no Claude key). It's called the same way as Claude: straight from this device to Google with
  // that person's own free key (aistudio.google.com/apikey), kept in their own private storage at
  // <owner>/private/gemini.json, in memory only on a phone or Chromebook, exactly like the Claude one and never shown.
  // Google's free tier costs nothing, so Gemini answers are never charged or counted against the monthly limit. It is
  // NOT a way past a school's content filter: like Claude, Google's API is blocked on a school network — use mobile
  // data, or let the note wait and go when you're home.
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  // Google's ListModels (the models this key may use), on the same host: never anywhere else.
  const GEMINI_LIST = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
  // Google retires numbered models (1.7's gemini-2.5-flash was due to be switched off on 16 Oct 2026), so Vault asks
  // for Google's own "latest" names: the newest Flash, then the newest Flash-Lite when Flash isn't offered to this key,
  // its free quota is used up or it's overloaded. Beside them, up to two numbered stable Flash models this key is offered
  // (ListModels, `extras`), as fallbacks; and a chat asks first whichever has been quickest here (`ranked`, 1.9.1).
  const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  const GEMINI_MODEL = GEMINI_MODELS[0];   // the Chat tab's Gemini model
  const GEMINI_KEY_FILE = 'gemini.json';
  // Google says not to rely on a key's format, and changed it in 2026: AI Studio made "AIza..." keys, and since 28 May
  // 2026 only "AQ." auth keys. So only the obvious is checked here (one unbroken run of the characters a credential is
  // made of); Google's own answer is the real check (saveGeminiKey asks it before saving).
  const GEMINI_KEY_LOOKS = /^[A-Za-z0-9._~+/=-]{20,512}$/;
  // How long Gemini may take (ms). A chat (`use` 'chat') asks the first model and, if it hasn't started its answer
  // after its head start, the next one too, side by side (AT_ONCE at most): whichever starts first answers and the
  // other is let go. A chat's head start follows how quickly that model usually starts here (`headFor`: one and a half
  // times its usual time, at least `headMin`, at most `head`; `head` for a model not timed here yet, and for a request
  // with pictures or PDFs, HEAVY_BODY: never a second copy of that going up sooner). Each may take `first` to its first
  // words (thinking included), then `idle` between two pieces. The note-taker ('notes', nobody watching the words come)
  // gives each model longer: `notesHead`, `notesFirst`. A model that lost the race (or was too slow to start) is tried
  // after the others for `slowFor`, for that use only. (1.8.2 tried one model at a time, waiting up to a minute for
  // each: on 5G, "hey" took 1-2 minutes.) `list`: how long ListModels may take before it's left for another time.
  // `check`: how long the check on Save (and Settings' Check Gemini) waits for each model (a network can drop Google
  // without a word). `uplink`: the request has to go up before Google can say a word, so each model's first-words wait
  // also allows its size at this many bytes a ms (about 256 kbit/s, a poor mobile uplink): a chat with big pictures or
  // PDFs isn't taken for a slow model. The head start allows `headUpload` ms of that at most: a chat whose earlier
  // pictures go with every message still has the next model asked within seconds on a good connection.
  // The note-taker's request (`ask`) never waits for ever, whatever hangs on the way (1.8.2 on a PC once showed "Writing
  // your notes..." for minutes): `look` for each check on the way (where the keys are, this month's spending, adding
  // the cost up), each only a check, so it carries on without it; `ask` for the request with no sign of the answer
  // being written, after which it's "taking too long" (busy: the words are kept and the notes made later). An answer
  // still being written is never cut off (it's paid for). A PC's Python watches its own request the same way.
  // `recheck`: while something is held back for the lack of a key, the keys are looked at again this often at most.
  const waits = { head: 7000, headMin: 3000, first: 25000, notesHead: 20000, notesFirst: 60000, idle: 45000,
    check: 15000, uplink: 32, headUpload: 3000, look: 15000, ask: 180000, list: 8000, slowFor: 10 * 60 * 1000,
    recheck: 60000 };
  // A request this big (letters of JSON, about bytes) that Google hadn't even answered in time may be held up by the
  // connection (or the model may be slow: there's no telling which): no other model is asked because of it (it would
  // send it all again on the same network), though one already asked carries on.
  const BIG_BODY = 1000 * 1000;
  // Requests to Gemini going at once for one message, at most: every request Google starts counts against the key's
  // free daily limit (one let go part-way too), and each goes up whole.
  const AT_ONCE = 2;
  // A request this big (letters of JSON, about bytes: pictures or PDFs, about 3 s of a poor uplink) is sent as 1.8.3
  // did: the next model only after the full head start (`head`), never a shorter one learned from quick small chats, so
  // the same upload isn't sent again on a slow connection while the first is still going up.
  const HEAVY_BODY = 100 * 1000;
  // Google's bare answer to a request it can't take, which says nothing of why.
  const GENERIC_400 = /^\s*request contains an invalid argument\.?\s*$/i;
  // How much a model may think before it answers, most wanted first. Google's newest models (Gemini 3 and later, which
  // the "latest" names point to) take a thinkingLevel and think at "high" unless told otherwise, which can hold the
  // first word back a long while; Gemini 2.5 took a thinkingBudget instead (0 = none). A model that turns a setting down
  // (a 400 that mentions thinking) is asked with the next one, and remembered (thinkingStep). A chat wants its first
  // words now: the least thinking there is. The note-taker may think a little.
  const THINKING = {
    chat: [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, { thinkingBudget: 0 }, null],
    notes: [{ thinkingLevel: 'low' }, { thinkingBudget: 1024 }, null],
  };
  // A numbered Gemini 2.x (found by ListModels) takes a thinkingBudget: none for a chat (2.5 Flash and Flash-Lite allow
  // 0), a little for notes. One that can't think at all (2.0, or ListModels saying thinking: false) turns the setting
  // down, and is asked without it (the same step down as above).
  const THINKING_2 = {
    chat: [{ thinkingBudget: 0 }, null],
    notes: [{ thinkingBudget: 1024 }, null],
  };
  const GEMINI_CONSOLE = 'https://aistudio.google.com/apikey';

  let key = null;       // a phone's or Chromebook's copy of the key: in memory only
  let geminiKey = null; // likewise for the Gemini key
  let known = null;     // { cloud, pc, gemini }: where the keys are (never the key itself)
  let looking = null;
  let saving = false;
  let mode = 0;         // counts "Use Claude too" changing: a look at the keys from before a change is let go
  let seenOn = null;    // "Use Claude too" as the last look at the keys found it (null: none yet)

  class AiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  /* `promise`, or `error` (an AiError) once `ms` have gone by without it. What it was waiting for carries on, and is
     simply not waited for. */
  function within(promise, ms, error) {
    let timer = null;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(error), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  const owner = () => (V.data.user && V.data.user.id) || '';
  const folder = () => `${owner()}/private`;
  const keyPath = () => `${folder()}/${KEY_FILE}`;
  // Whether this device's page keeps the AI keys itself: a phone or Chromebook, or Vault on its own on a PC. The PC
  // with Jarvis keeps Jarvis's key in Python instead (aiKeyState/aiKeyShare/aiKeyRemove).
  const ownKeys = () => !V.desktop || !!(V.pc && V.pc.standalone && V.pc.standalone());
  const month = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthName = () => new Date().toLocaleDateString([], { month: 'long' });
  /* "Use Claude too" (Settings > AI), the same on every device: off unless the owner switched it on. A Vault 1.8 on
     another device doesn't know it, and uses Claude as before until it updates; a Vault older than 1.9.1 that sends a
     new PIN may also put it back to what it last saw (V.cloud.changeExtra says how). */
  const claudeOn = () => ((((V.data.settings || {}).extra || {}).ai || {}).claude) === true;
  /* "Write notes with Claude" (Settings > AI, shown under "Use Claude too" while it's on), the same on every device: off
     unless switched on, so the free Gemini writes the note-taker's notes (brain). Meaningless while Claude is off. */
  const notesClaude = () => ((((V.data.settings || {}).extra || {}).ai || {}).notes_claude) === true;
  /* Whether claudeOn() is the cloud's word on it: the settings row read since this page started (js/cloud.js). Before
     that, a new or wiped device has no settings at all, and "nothing" must never be taken for "off" (a waiting Claude
     message sent with Gemini, say), nor an old copy on this device for the cloud's newest. `modeReady(ms)` waits for
     it (false if it didn't come in time: then this device's copy is all there is, as offline). */
  const modeKnown = () => !V.cloud.settingsRead || V.cloud.settingsRead();
  const modeReady = (ms) => (modeKnown() ? Promise.resolve(true) : V.cloud.settingsReady(ms));

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

  /* The settings row's extra.ai changed: merged into the cloud's newest extra (another device may have spent since),
     then an upsert of extra alone (V.cloud.changeExtra). */
  async function writeAi(change) {
    await V.cloud.changeExtra((extra) => ({ ...extra, ai: change({ ...(extra.ai || {}) }) }));
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

  /* "Use Claude too" switched on or off for every device: merged into extra.ai like the tally (this month's spending,
     the limit and everything else in extra stay as the cloud has them). The settings row changing does the rest
     (followMode). */
  async function setClaude(on) {
    await writeAi((ai) => ({ ...ai, claude: !!on }));
  }

  /* "Write notes with Claude" switched on or off for every device, the same way. */
  async function setNotesClaude(on) {
    await writeAi((ai) => ({ ...ai, notes_claude: !!on }));
  }

  /* The settings row changed (here, or synced from another device): when "Use Claude too" is now otherwise than the
     last look at the keys found it, that look is let go (on the PC it differs: Jarvis's key is asked about only while
     Claude is on), a copy of the Claude key in memory is forgotten when it's off, and the pages are told ('ai'). A
     change to "Write notes with Claude" is told too (the note-taker names who writes). */
  let seenNotes = null;
  function followMode() {
    const notes = notesClaude();
    if (seenNotes !== null && seenNotes !== notes) V.emit('ai', 'notes');
    seenNotes = notes;
    const on = claudeOn();
    if (seenOn === on) return;
    const was = seenOn;
    seenOn = on;
    if (!on) key = null;
    if (was === null) return;  // (nothing looked at yet: the first look follows the setting as it is)
    mode += 1;
    known = null;
    looking = null;
    V.emit('ai', 'claude');
    check().catch(() => {});
  }
  V.on('data', (table) => { if (table === 'settings') followMode(); });

  /* -- the key */

  /* Where the keys are: { cloud: Claude's in the owner's storage, pc: Jarvis has one (on the PC), gemini: the free
     Google key in the owner's storage }. While Claude is off, Jarvis isn't asked about his (nothing would use it). */
  let looks = 0;            // counts the looks at the keys (a late answer from an older one says nothing new)
  let lateListing = null;   // the cloud's listing for the Gemini key, still awaited after its look gave up on it
  async function lookUp() {
    seenOn = claudeOn();
    const look = ++looks;
    const asked = mode;
    const listed = async () => {
      const { data, error } = await V.cloud.sb.storage.from('vault').list(folder(), { limit: 100 });
      if (error) throw error;
      return data || [];
    };
    const has = (files, name) => files.some((f) => f.name === name && f.id);
    if (!ownKeys() && seenOn) {
      // The paid Claude key stays with Jarvis; the free Gemini key is used here like on a phone (1.8.2). Both asked at
      // once, and a cloud that doesn't answer about Gemini in time says nothing about it: what was known before, else
      // not known (null: never taken for "no Gemini key", which would hold Gemini's messages back). Its answer is
      // still taken when it comes (the pages are told: a new chat that started on Claude for want of it moves to
      // Gemini when the key is there), unless a newer look has said since.
      const before = known && !known.failed && typeof known.gemini === 'boolean' ? known.gemini : null;
      const found = {};
      let late;
      const listing = listed();
      const gemini = within(listing, waits.look, new AiError('busy', 'No answer from the cloud.'))
        .then((files) => has(files, GEMINI_KEY_FILE), () => {
          const waiting = listing.then((files) => {
            if (look !== looks || asked !== mode) return;
            late = has(files, GEMINI_KEY_FILE);
            if (!('gemini' in found)) return;  // (the look hasn't answered yet: it takes it below)
            found.gemini = late;
            if (known === found) V.emit('ai', 'key');
          }, () => {}).finally(() => { if (lateListing === waiting) lateListing = null; });
          lateListing = waiting;
          return before;
        });
      const pc = V.pc.can('aiKeyState') ? await V.pc.call('aiKeyState') : { cloud: false, pc: false, old: true };
      const said = await gemini;
      return Object.assign(found, pc, { gemini: late === undefined ? said : late });
    }
    const files = await listed();
    return { cloud: has(files, KEY_FILE), gemini: has(files, GEMINI_KEY_FILE) };
  }

  /* Where the keys are (lookUp), asked once at a time; an answer that doesn't come in time counts as "couldn't check"
     (`failed`), never a wait for ever (each ask waits for it). It's only "not known yet": the answer, when it comes
     after all, is still taken (unless something else has said where the keys are since), a failed check is asked
     again by the next request, and a check that fails never forgets what an earlier one found. */
  let triedAt = 0;  // when the last look at the keys started (recheck)
  function check() {
    if (!looking) {
      const asked = mode;  // (a look from before "Use Claude too" changed tells nothing about now)
      triedAt = Date.now();
      const finding = lookUp();
      const failed = { failed: true };
      finding.then((found) => {
        if (asked !== mode || known !== failed) return;
        known = found;
        V.emit('ai', 'key');
      }, () => {});
      const mine = within(finding, waits.look + 1000, new AiError('busy', 'The key check is taking too long.'))
        .then((found) => { if (asked === mode) known = found; return found; })
        .catch((error) => { if (asked === mode && (!known || known.failed)) known = failed; throw error; })
        .finally(() => { if (looking === mine) looking = null; V.emit('ai', 'key'); });
      looking = mine;
    }
    return looking;
  }

  /* Whether the last look at the keys found no Gemini key (an answer, not a look that failed or couldn't tell). */
  const lacksGemini = () => !!known && !known.failed && known.gemini === false;
  /* Whether the last look at the keys could say either way about the Gemini key (on the PC its listing can come too
     late for the look: then it's not known, which is neither "set up" nor "missing"). */
  const geminiKnown = () => has('gemini') || lacksGemini();

  /* The look at the keys under way (and a Gemini listing that came too late for its look) given up to `ms` to answer;
     then what's known, whatever it is. Never rejects. */
  function keysSettled(ms) {
    const pending = [looking, lateListing].filter(Boolean).map((p) => p.catch(() => {}));
    if (!pending.length) return Promise.resolve(known);
    return within(Promise.all(pending), ms, null).then(() => known, () => known);
  }

  /* The keys looked at again when the last look started over `maxAge` ms ago (waits.recheck by default): a key set up
     on another device since is then seen here, without opening anything again. Asked before a message or a note is
     held back for the lack of a key, and when Vault comes back to the front with one missing. Never rejects. */
  function recheck(maxAge = waits.recheck) {
    if (!looking && Date.now() - triedAt < maxAge) return Promise.resolve(known);
    return check().catch(() => known);
  }

  async function getKey() {
    if (!claudeOn()) { key = null; throw new AiError('off', WORDS.off); }  // (never fetched while Claude is off)
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
    V.emit('ai', 'key');
  }

  /* Python's answer about the Claude key ({ cloud, pc }) taken as the page's `known`, keeping what only the page knows:
     whether the free Gemini key is set up (read after the await, so a Gemini Save or Remove meanwhile counts). */
  const fromPc = (pc) => { known = { ...(pc || {}), gemini: known && typeof known.gemini === 'boolean' ? known.gemini : null }; };

  async function shareFromPc() {
    fromPc(await V.pc.call('aiKeyShare'));
    V.emit('ai', 'key');
  }

  async function removeKey() {
    if (!ownKeys()) fromPc(await V.pc.call('aiKeyRemove'));
    else {
      await V.cloud.remove([keyPath()]);
      known = { ...(known || {}), cloud: false };
    }
    key = null;
    V.emit('ai', 'key');
  }

  /* -- the Gemini key (a phone's or Chromebook's, in the same private place, in memory only) */

  const geminiPath = () => `${folder()}/${GEMINI_KEY_FILE}`;
  const forgetGeminiKey = () => { geminiKey = null; };

  // Other services' secrets, so one pasted here by mistake is never sent to Google: OpenAI's, Supabase's, a sign-in
  // token, GitHub's, GitLab's, Slack's, Amazon's.
  const NOT_GOOGLE = /^(?:sk-|sb_|sbp_|eyJ|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA)/;

  /* What's wrong with `text` as a Gemini key, in plain words ('' when it could be one). */
  function geminiKeyProblem(text) {
    if (!text) return 'Paste the key from aistudio.google.com/apikey first.';
    if (/^sk-ant-/i.test(text)) {
      return claudeOn() ? 'That\'s a Claude key: paste it in the Claude key row instead.'  // (shown only while it's on)
        : 'That\'s a Claude key, not a Google one. To use Claude, switch on "Use Claude too" below, then paste it in the '
          + 'Claude key row.';
    }
    if (NOT_GOOGLE.test(text)) return 'That\'s another service\'s key, not a Google one. Copy the key from aistudio.google.com/apikey.';
    if (!GEMINI_KEY_LOOKS.test(text)) {
      return 'That doesn\'t look like a Google key (it\'s one long piece with no spaces). Copy it again from aistudio.google.com/apikey.';
    }
    return '';
  }

  /* A pasted key without the space or quotes copied round it. */
  const tidyKey = (text) => String(text || '').trim().replace(/^(["'`])(.*)\1$/, '$2').trim();

  /* What the last look found about the Gemini key, from fetching it: the pages that wait on it are told ('ai') when
     that's news. */
  function geminiFound(there) {
    const was = known ? known.gemini : undefined;
    if (there && (!known || known.failed)) return;  // (no look yet: the next one says where the other keys are too)
    known = { ...(known || {}), gemini: there };
    if (was !== there) V.emit('ai', 'key');
  }

  /* Storage's own "there's no such file" (a missing object comes back as a 400 saying 404, or a 404): only that is "no
     key". Anything else (no answer, the cloud's own trouble) says nothing about the key. */
  const notThere = (error) => !!error && error.name === 'StorageApiError'
    && (Number(error.status) === 404 || String(error.statusCode) === '404' || /not.?found/i.test(error.message || ''));

  async function getGeminiKey() {
    if (geminiKey) return geminiKey;
    let got;
    try {
      got = await V.cloud.sb.storage.from('vault').download(geminiPath());
    } catch (error) {
      got = { data: null, error };
    }
    const { data, error } = got;
    if (error && !notThere(error)) {  // the cloud didn't answer: the message or the notes wait, never "set up Gemini"
      throw navigator.onLine ? Object.assign(new AiError('offline', WORDS.cloudOut), { cloud: true })
        : new AiError('offline', WORDS.away);
    }
    if (error || !data) {
      geminiFound(false);
      throw new AiError('nokey', WORDS.geminiNokey);
    }
    let found = '';
    try { found = String(JSON.parse(await data.text()).key || '').trim(); } catch (e) { /* not a key file */ }
    if (geminiKeyProblem(found)) throw new AiError('nokey', 'The Gemini key saved in your cloud isn\'t a Google key. Set it up again in Settings > AI.');
    geminiKey = found;
    geminiFound(true);
    return geminiKey;
  }

  /* A key pasted on a phone, a Chromebook or a Vault on its own: first one tiny request to Google with it (free), then
     saved beside the Claude key. Google refusing the key = nothing saved, and its reason in plain words. Saved anyway,
     to be checked when first used: no answer from Google in time (offline, or a network that blocks it),
     Google's own trouble, or Google turning down the check itself rather than the key (its words are passed on: Vault
     can't be sure its check is how Google wants it, and a good key must never be refused for that). A used-up free quota
     means Google took the key. Returns { checked, why, said } (why: 'offline', 'busy' or 'bad' when it couldn't be
     checked; 'slow': no answer in time). */
  async function saveGeminiKey(pasted) {
    const clean = tidyKey(pasted);
    const problem = geminiKeyProblem(clean);
    if (problem) throw new Error(problem);
    let why = '';
    let said = '';
    try {
      await geminiRequest(clean, { contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], maxTokens: 16,
        wait: waits.check });
    } catch (error) {
      if (error.kind === 'key' || !error.kind) throw new Error(error.message);
      if (error.kind !== 'quota') { why = error.slow ? 'slow' : error.kind; said = error.message; }
    }
    const record = { format: 1, key: clean, from: V.device, at: new Date().toISOString() };
    await V.cloud.upload(geminiPath(), new Blob([JSON.stringify(record)], { type: 'application/json' }), { mime: 'application/json' });
    geminiKey = clean;
    known = { ...(known || {}), gemini: true };
    V.emit('ai', 'key');  // (a message held for the lack of it goes, the Chat tab's line goes)
    forgetList();  // (a new key may be offered other models: listed again with it)
    return { checked: !why, why, said };
  }

  async function removeGeminiKey() {
    await V.cloud.remove([geminiPath()]);
    known = { ...(known || {}), gemini: false };
    geminiKey = null;
    V.emit('ai', 'key');
    forgetList();
  }

  /* -- asking Claude */

  const WORDS = {
    off: 'Claude is switched off. To use it, switch on "Use Claude too" in Settings > AI.',
    geminiNokey: 'Set up the free Gemini first (Settings > AI). It only takes a minute.',
    key: 'Claude didn\'t accept the key. Set it up again in Settings > AI.',
    geminiOffline: 'Gemini can\'t be reached from this network. Your words are saved, and the notes will be made by themselves once it can be (or tap Make notes).',
    geminiBusy: 'Gemini is busy right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    geminiSlow: 'Gemini is taking too long right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    geminiQuota: 'Google\'s free Gemini limit is used up for the moment. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    busy: 'Claude is busy right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    slow: 'Claude is taking too long right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    cloudSlow: 'Your cloud is taking too long to answer right now. Your words are saved, and the notes will be made by themselves in a little while (or tap Make notes).',
    cloudOut: 'Your cloud can\'t be reached right now. Your words are saved, and the notes will be made by themselves once it can be (or tap Make notes).',
    offline: 'Claude can\'t be reached from this network. Your words are saved, and the notes will be made by themselves once it can be (or tap Make notes).',
    away: 'You\'re offline. Your words are saved, and the notes will be made by themselves when you\'re back online.',
    old: 'This PC\'s Vault needs an update to make notes (open Jarvis and click Update). Or make them on your phone.',
  };

  const STOPPED = () => new AiError('stopped', 'Stopped.');
  const cloudSlow = () => Object.assign(new AiError('busy', WORDS.cloudSlow), { slow: true, why: 'slow', cloud: true });
  const countWords = (so) => (String(so || '').match(/\S+/g) || []).length;

  /* What a request that didn't come to a finished answer had cost by then (`usage`: Claude bills a given-up, stopped or
     cut-off answer that far) added to this month's tally, so the monthly limit sees every paid try. Never waits long. */
  const charge = (usage) => within(count(price(usage)), waits.look, null).catch(() => {});

  // How often the words written so far go to `progress` (ms), and about how many letters Claude writes a token: what an
  // answer cut short had written, as near as can be told without Claude's own count (it only comes at the end).
  const TELL_EVERY = 250;
  const LETTERS_A_TOKEN = 4;

  /* The note-taker's request straight to Claude (a phone, a Chromebook), streamed like the PC's: `progress(words)` as
     Claude writes (the words of the notes so far; its thinking counts as writing too), and `signal` stops it. An answer
     that didn't come to its end (stopped, cut off, Claude's own trouble part-way) is never returned, and what it had
     cost by then is added to the tally here (`charge`). */
  async function direct(system, text, signal = null, progress = null) {
    const sending = await within(getKey(), waits.look, cloudSlow());
    let response;
    try {
      response = await fetch(API, {
        method: 'POST',
        signal,
        headers: headers(sending),
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, output_config: { effort: 'low' },
          system, messages: [{ role: 'user', content: text }] }),
      });
    } catch (error) {  // no internet, or a network that blocks Claude (a school's)
      if (signal && signal.aborted) throw STOPPED();
      throw new AiError('offline', navigator.onLine ? WORDS.offline : WORDS.away);
    }
    if (response.status === 401 || response.status === 403) { key = null; throw new AiError('key', WORDS.key); }
    if (response.status === 429 || response.status === 529 || response.status >= 500) throw new AiError('busy', WORDS.busy);
    if (!response.ok || !response.body) {
      let data = null;
      try { data = await response.json(); } catch (error) { /* not JSON (or stopped part-way) */ }
      if (signal && signal.aborted) throw STOPPED();
      const said = data && data.error && data.error.message;
      throw new AiError('bad', `Claude couldn't make notes from this${said ? ` (${said})` : ''}. Your words are saved.`);
    }
    // The answer, as Claude streams it: only the text blocks' words are the notes (never its thinking).
    const got = { words: [], blocks: {}, usage: null, letters: 0, stopReason: '', finished: false, error: null };
    let toldAt = 0;
    const take = (event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        got.usage = { ...((event.message || {}).usage || {}) };
      } else if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        got.blocks[event.index] = block.type;
        if (block.type === 'text' && block.text) got.words.push(String(block.text));
      } else if (event.type === 'content_block_delta') {
        const d = event.delta || {};
        const piece = String(d.text || d.thinking || d.partial_json || '');
        got.letters += piece.length;
        if (d.type === 'text_delta' && got.blocks[event.index] === 'text') got.words.push(piece);
        const now = Date.now();
        if (progress && now - toldAt >= TELL_EVERY) {  // (the wait for the answer starts again: Claude is writing)
          toldAt = now;
          progress(countWords(got.words.join('')));
        }
      } else if (event.type === 'message_delta') {
        const d = event.delta || {};
        if (d.stop_reason) got.stopReason = d.stop_reason;
        for (const [k, v] of Object.entries(event.usage || {})) if (v !== null && v !== undefined) got.usage = { ...(got.usage || {}), [k]: v };
      } else if (event.type === 'message_stop') {
        got.finished = true;
      } else if (event.type === 'error') {
        got.error = event.error || { type: 'api_error' };
      }
    };
    // What it had cost by then, when it doesn't finish: its input, and what it wrote (Claude's count, else about).
    const spent = () => (got.usage ? { ...got.usage,
      output_tokens: Math.max(Number(got.usage.output_tokens) || 0, Math.ceil(got.letters / LETTERS_A_TOKEN)) } : null);
    const unfinished = async (error) => {
      const usage = spent();
      if (usage) await charge(usage);
      throw error;
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const read = ssePieces(buffer + decoder.decode(value, { stream: true }));
        buffer = read.buffer;
        read.pieces.forEach(take);
        if (got.error) break;
      }
      if (!got.error) ssePieces(`${buffer}${decoder.decode()}\n\n`).pieces.forEach(take);  // (the last piece, even without its blank line)
    } catch (error) {  // stopped, or the connection dropped part-way
      reader.cancel().catch(() => {});
      return unfinished(signal && signal.aborted ? STOPPED() : Object.assign(new AiError('busy', WORDS.busy), { why: 'busy' }));
    }
    if (signal && signal.aborted) return unfinished(STOPPED());
    if (got.error) {  // Claude's own trouble part-way (overloaded, as a rule): busy, unless it says this request is wrong
      reader.cancel().catch(() => {});
      if (got.error.type === 'invalid_request_error') {
        return unfinished(new AiError('bad', `Claude couldn't make notes from this${got.error.message ? ` (${got.error.message})` : ''}. Your words are saved.`));
      }
      return unfinished(Object.assign(new AiError('busy', WORDS.busy), { why: 'busy' }));
    }
    if (!got.finished) return unfinished(Object.assign(new AiError('busy', WORDS.busy), { why: 'busy' }));  // never half the notes
    return { text: got.words.join(''), stopReason: got.stopReason, usage: got.usage || {} };
  }

  /* -- Gemini's requests */

  /* Google's error answer as { message, reason } (reason: its ErrorInfo's, like API_KEY_INVALID). The message never
     holds the key, even if Google ever echoed it (or another key-shaped piece), and is cut short after that. */
  function googleError(data, sending) {
    const e = (data && data.error) || {};
    const reasons = (Array.isArray(e.details) ? e.details : []).map((d) => d && d.reason).filter(Boolean);
    let message = String(e.message || '');
    if (sending) message = message.split(sending).join('…');
    message = message.replace(/(?<![A-Za-z0-9_])(?:AQ\.|AIza)[A-Za-z0-9_.-]{8,}/g, '…').slice(0, 300);
    return { message, reason: String(reasons[0] || '') };
  }

  // Reasons Google gives for refusing a key itself, for every model: API_KEY_INVALID, API_KEY_..._BLOCKED,
  // SERVICE_DISABLED, CONSUMER_SUSPENDED. (A bare 401 or 403, ACCESS_TOKEN_TYPE_UNSUPPORTED included, has been tied to
  // particular models, so another model may still take the key.)
  const KEY_REASON = /^(?:API_KEY_INVALID|API_KEY_\w*_BLOCKED|SERVICE_DISABLED|CONSUMER_SUSPENDED)$/;

  /* What a failed answer means: 'key' (Google refused the key itself), 'refused' (a 401/403 that may be this model's
     alone), 'missing' (no such model for this key), 'quota' (its free quota is used up: Google took the key), 'busy'
     (Google's own trouble) or 'bad' (this request). */
  function geminiTrouble(status, why) {
    if ([400, 401, 403].includes(status) && (KEY_REASON.test(why.reason) || /api key/i.test(why.message))) return 'key';
    if (status === 401 || status === 403) return 'refused';
    if (status === 404) return 'missing';
    if (status === 429) return 'quota';
    if (status >= 500) return 'busy';
    return 'bad';
  }

  /* Why Google refused a key, and what to do, in plain words. */
  function keyWords(why, sending) {
    const again = 'Make a new key at aistudio.google.com/apikey and paste it in Settings > AI.';
    if (why.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') {
      return 'Google refused this key (ACCESS_TOKEN_TYPE_UNSUPPORTED), a known problem on Google\'s side with some of its '
        + 'new AQ. keys. Make a new key at aistudio.google.com/apikey, in a new project, and paste it in Settings > AI.';
    }
    if (why.reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(why.message)) {
      return `The Gemini API is switched off for that key's Google project. ${again}`;
    }
    if (/^API_KEY_.*_BLOCKED$/.test(why.reason)) {
      return `That key is limited to other websites or apps (its restrictions in Google Cloud). ${again}`;
    }
    if (/^AIza/.test(sending || '')) {
      return 'Google is replacing its older keys (the ones starting AIza) with new ones that start with AQ., and didn\'t take '
        + `this one. ${again}`;
    }
    if (why.reason === 'API_KEY_INVALID' || /not valid/i.test(why.message)) {
      return 'Google says that key isn\'t valid. Copy it again from aistudio.google.com/apikey (all of it) and paste it in Settings > AI.';
    }
    return `Google didn't accept the Gemini key${why.message ? ` (${why.message})` : ''}. ${again}`;
  }

  // Marks kept only while the page is open go by the time that has really gone by (performance.now(), which a clock
  // put right doesn't move), never by the date.
  // A slow mark is for the use it was made in: a chat's head start is learned and short, the note-taker's long, so a
  // model that lost a chat's race (or whose chat answer stopped part-way) still keeps its place for notes, and the
  // other way round.
  const slowUntil = new Map();  // "<model> <use>" -> until when (performance.now()) it's tried last for that use
  const thinkingStep = new Map();  // "<model> <use>" -> how far down its THINKING list that model had to go
  const slowKey = (model, use) => `${model} ${use === 'notes' ? 'notes' : 'chat'}`;
  const markSlow = (model, use) => slowUntil.set(slowKey(model, use), performance.now() + (Number(waits.slowFor) || 0));
  const isSlow = (model, use) => slowUntil.get(slowKey(model, use)) > performance.now();

  /* Whose doing an answer cut short was. One that stops coming because of this device (its connection dropped: the
     phone lost signal or changed networks, or the browser put the page away and cut it off, as Android does with a page
     left in the background) says nothing about the model, so it's never held against it. `unsettledAt` is when this
     device last did any of that (performance.now()); `unsettledSince(began)`: whether it may have, since `began`. */
  let unsettledAt = -Infinity;
  const unsettle = () => { unsettledAt = performance.now(); };
  try {
    document.addEventListener('visibilitychange', () => { if (document.hidden) unsettle(); });
    document.addEventListener('freeze', unsettle);  // (Chrome's page lifecycle: a page put to sleep)
    window.addEventListener('pagehide', unsettle);
    window.addEventListener('offline', unsettle);
    window.addEventListener('online', unsettle);
    // Chrome's Network Information: a change of network. Its 'change' also fires when Chrome's speed estimates move,
    // which isn't this device's doing, so only a new kind of connection counts.
    const net = navigator.connection;
    if (net && net.addEventListener) {
      let was = `${net.type || ''} ${net.effectiveType || ''}`;
      net.addEventListener('change', () => {
        const now = `${net.type || ''} ${net.effectiveType || ''}`;
        if (now !== was) unsettle();
        was = now;
      });
    }
  } catch (error) { /* only the state at the time is looked at, then */ }
  const unsettledSince = (began) => !!document.hidden || !navigator.onLine || unsettledAt >= began;

  /* -- which Gemini model first: how quickly each starts answering on this device (1.9.1)

     The owner's Check Gemini on his PC: Flash no words after 15 s, Flash-Lite 10.6 s, so every chat waited Flash's
     7 s head start before Flash-Lite was even asked. Each device now remembers, per model, how long its recent answers
     took to their first words (from chats, notes and Check Gemini), and its failures, in localStorage
     'vault-gemini-speed' (never the key, never what was said; a device's own network decides this, so it isn't
     synced). A chat asks the quickest first (a model not timed here yet after the ones known to start within the usual
     head start, a model found by ListModels only once it has been timed, a failing one after those, one that lost a race
     a moment ago last, as before), and gives it a head start that fits it (`headFor`). The note-taker keeps Flash first
     (its notes are better) unless Flash keeps failing or kept losing its races here. Storage that can't be used (a
     private window, a locked-down Chromebook) only means the record lasts until the page closes. Two pages of Vault
     open on one device (the installed app and a Chrome tab) share the record: each reads what's kept before using or
     changing it, so neither writes its older copy over what the other learned. Everything kept is dated, and expires
     by its age; one dated later than now (kept while this device's clock was ahead) counts as expired. */
  const SPEED_KEY = 'vault-gemini-speed';
  const SPEED_KEEP = 2 * 24 * 3600 * 1000;  // older timings are forgotten (networks and Google's models change)
  const SPEED_SAMPLES = 6;                  // timings kept per model and use (chat, notes)
  const FAIL_AFTER = 2;                     // failures in a row (each within FAIL_FOR of the one before) that put a
  const FAIL_FOR = 60 * 60 * 1000;          // model after the others, until it answers again or this long goes by
  const CLOCK_SLACK = 60 * 1000;            // a date at most this far ahead is the clock being set right, not wrong
  const MODEL_NAME = /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/;

  /* Whether something dated `at` (Date.now() when it was kept) is less than `keep` old: never when its date is later
     than now (the clock was ahead when it was kept, and has been put right since). */
  const lately = (at, keep) => {
    const age = Date.now() - at;
    return Number.isFinite(age) && age >= -CLOCK_SLACK && age < keep;
  };

  /* What localStorage holds under `name` (null when nothing, or it can't be read). */
  function stored(name) {
    try { return JSON.parse(localStorage.getItem(name) || 'null'); } catch (error) { return null; }
  }
  /* `value` kept under `name` (null: removed). Storage that can't be used is simply not kept. */
  function store(name, value) {
    try {
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, JSON.stringify(value));
    } catch (error) { /* a private window, or storage switched off: in memory only */ }
  }

  let speed = null;       // { models: { <model>: { chat: [[ms, at, ok]], notes: [...], fails, failAt, version } } }
  let speedText;          // the text in storage `speed` was read from or written as (undefined: none read yet)

  /* Timings as kept: [ms to the first words (or, when not ok, how long it had gone without any), when, 1 = it answered]. */
  const samplesOf = (list) => (Array.isArray(list) ? list : [])
    .filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && s[0] >= 0 && Number.isFinite(s[1]))
    .map((s) => [Math.round(s[0]), s[1], s[2] ? 1 : 0]).slice(-SPEED_SAMPLES);

  /* A record from the text kept in storage (anything unreadable in it is left out). */
  function readRecord(text) {
    let raw = null;
    try { raw = JSON.parse(text || 'null'); } catch (error) { /* not a record */ }
    const models = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {};
    const out = { models: {} };
    for (const [model, e] of Object.entries(models)) {
      if (!MODEL_NAME.test(model) || !e || typeof e !== 'object') continue;
      out.models[model] = { chat: samplesOf(e.chat), notes: samplesOf(e.notes),
        fails: Number.isFinite(e.fails) && e.fails > 0 ? Math.min(99, Math.floor(e.fails)) : 0,
        failAt: Number.isFinite(e.failAt) ? e.failAt : 0,
        version: typeof e.version === 'string' && MODEL_NAME.test(e.version) ? e.version : '' };
    }
    return out;
  }

  /* This device's record as kept now (another page of Vault may have changed it since this one last looked); the one
     in memory when storage can't be read. */
  function record() {
    let text;
    try { text = localStorage.getItem(SPEED_KEY); } catch (error) { return speed || (speed = { models: {} }); }
    if (!speed || text !== speedText) {
      speed = readRecord(text);
      speedText = text;
    }
    return speed;
  }
  /* `change(models)` made to the record as kept now, then kept (in memory only when storage can't be used). */
  function changeRecord(change) {
    const now = record();
    change(now.models);
    const text = JSON.stringify({ v: 1, models: now.models });
    try {
      localStorage.setItem(SPEED_KEY, text);
      speedText = text;
    } catch (error) { /* a private window, or storage switched off: in memory only */ }
  }
  const entryIn = (models, model) => {
    if (!models[model]) models[model] = { chat: [], notes: [], fails: 0, failAt: 0, version: '' };
    return models[model];
  };
  /* A model's timings for `use` from the last SPEED_KEEP. */
  const recent = (model, use) => {
    const e = record().models[model];
    return e ? (e[use] || []).filter((s) => lately(s[1], SPEED_KEEP)) : [];
  };
  /* How long `model` usually takes here to its first words (the median of its recent timings; one that didn't answer
     counts as the time it went without), or null when it hasn't been timed here lately. */
  function typical(model, use = 'chat') {
    const times = recent(model, use).map((s) => s[0]).sort((a, b) => a - b);
    if (!times.length) return null;
    const mid = Math.floor(times.length / 2);
    return times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
  }
  /* typical(), once there are two timings to go on (one quick answer could be luck); null before that. */
  const settled = (model) => (recent(model, 'chat').length >= 2 ? typical(model, 'chat') : null);
  /* `model` (for `use`) started its answer after `ms` (`ok`), or went `ms` without starting it (lost a race, too slow). */
  function timed(model, use, ms, ok) {
    if (!MODEL_NAME.test(model) || !Number.isFinite(ms)) return;
    const kind = use === 'notes' ? 'notes' : 'chat';
    changeRecord((models) => {
      const e = entryIn(models, model);
      e[kind] = [...(e[kind] || []).filter((s) => lately(s[1], SPEED_KEEP)),
        [Math.max(0, Math.round(ms)), Date.now(), ok ? 1 : 0]].slice(-SPEED_SAMPLES);
      if (ok) { e.fails = 0; e.failAt = 0; }
    });
  }
  /* `model` failed: busy, its free quota used up, not offered to this key, it refused the key, or its answer stopped
     coming part-way. Failures only add up while each comes within FAIL_FOR of the one before: one long ago and one now
     aren't "in a row". */
  function failedHere(model) {
    if (!MODEL_NAME.test(model)) return;
    changeRecord((models) => {
      const e = entryIn(models, model);
      e.fails = e.fails > 0 && lately(e.failAt, FAIL_FOR) ? Math.min(99, e.fails + 1) : 1;
      e.failAt = Date.now();
    });
  }
  const failing = (model) => {
    const e = record().models[model];
    return !!e && e.fails >= FAIL_AFTER && lately(e.failAt, FAIL_FOR);
  };
  /* The note-taker's own "very slow": its last two notes here both went without starting (lost, or too slow). */
  const verySlow = (model) => {
    const last = recent(model, 'notes').slice(-2);
    return last.length === 2 && last.every((s) => !s[2]);
  };
  /* The numbered model a "latest" name pointed to when it last answered here (Google's modelVersion). */
  const versionOf = (model) => (record().models[model] || {}).version || '';
  function pointsTo(model, version) {
    const v = String(version || '').replace(/^models\//, '');
    if (!GEMINI_MODELS.includes(model) || v === model || !MODEL_NAME.test(v) || versionOf(model) === v) return;
    changeRecord((models) => { entryIn(models, model).version = v; });
  }

  /* -- the other models this key may use (ListModels), kept a day

     Conservative: stable text Flash and Flash-Lite models only (gemini-<n>[.<n>]-flash[-lite], none of the previews,
     experiments, speech, image, live or "-latest" names), that generate text; then at most two of them (`extras`): the
     newest Flash and the newest Flash-Lite that aren't what a "latest" name points to anyway. Kept in localStorage
     'vault-gemini-models' with the owner's id (never the key) for LIST_FOR, and forgotten when they sign out; a listing
     that fails (no answer, one that stops coming, or something that isn't Google's list) leaves the two "latest" names
     as they were, and is tried again after LIST_RETRY. */
  const MODELS_KEY = 'vault-gemini-models';
  const LIST_FOR = 24 * 3600 * 1000;
  const LIST_RETRY = 10 * 60 * 1000;
  const EXTRAS = 2;
  const STABLE_FLASH = /^models\/gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/;
  const NOT_STABLE = /preview|exp|tts|image|live|thinking|native-audio|audio|latest/;
  let listed = null;      // { owner, at, models: [{ id, thinks? }] }: newest first
  let listing = null;     // the ListModels request on its way (in the background)
  let listFailedAt = -Infinity;  // (performance.now(): only while the page is open)
  let listGen = 0;        // counts forgetList: a listing asked for before it (another key, another person) is let go

  /* The stable Flash models in a ListModels answer, newest first (Flash before Flash-Lite of the same number). */
  function stableFlash(found) {
    const out = [];
    for (const m of Array.isArray(found) ? found : []) {
      const name = String((m && m.name) || '');
      const hit = STABLE_FLASH.exec(name);
      if (!hit || NOT_STABLE.test(name)) continue;
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!methods.includes('generateContent') && !methods.includes('streamGenerateContent')) continue;
      const id = name.slice('models/'.length);
      if (out.some((o) => o.id === id)) continue;
      out.push({ id, major: Number(hit[1]), minor: Number(hit[2] || 0), lite: !!hit[3],
        thinks: typeof m.thinking === 'boolean' ? m.thinking : undefined });
    }
    return out.sort((a, b) => b.major - a.major || b.minor - a.minor || Number(a.lite) - Number(b.lite))
      .map(({ id, thinks }) => (thinks === undefined ? { id } : { id, thinks }));
  }

  /* This owner's listing (kept on this device), or null. */
  function listedNow() {
    if (!listed) {
      const raw = stored(MODELS_KEY);
      if (raw && typeof raw === 'object' && typeof raw.owner === 'string' && Number.isFinite(raw.at) && Array.isArray(raw.models)) {
        listed = { owner: raw.owner, at: raw.at, models: raw.models
          .filter((m) => m && typeof m.id === 'string' && STABLE_FLASH.test(`models/${m.id}`))
          .map((m) => (typeof m.thinks === 'boolean' ? { id: m.id, thinks: m.thinks } : { id: m.id })) };
      }
    }
    return listed && listed.owner === owner() ? listed : null;
  }
  function keepList(models) {
    listed = { owner: owner(), at: Date.now(), models: models || [] };
    store(MODELS_KEY, listed);
  }
  function forgetList() {
    listGen += 1;
    listed = null;
    listing = null;
    listFailedAt = -Infinity;
    store(MODELS_KEY, null);
  }

  /* Google's list of the models `sending` may use: { ok, status, ms (to Google's answer: the round trip to Google with
     the key, no model at work), models (stableFlash's), trouble (geminiTrouble's kinds, 'slow': no whole answer in
     time, one that started and stopped coming included, 'offline', or 'garbled': an answer that isn't Google's list,
     like a network filter's page), said }. Only ever to generativelanguage.googleapis.com. */
  async function listModels(sending, limit = waits.list) {
    const out = { ok: false, status: 0, ms: null, models: null, trouble: '', said: '' };
    const own = new AbortController();
    let late = false;
    const timer = setTimeout(() => { late = true; own.abort(); }, Math.max(1, Number(limit) || 1));
    const began = performance.now();
    try {
      const found = [];
      let page = '';
      for (let n = 0; n < 3; n++) {  // (one page as a rule: Google offers fewer than 100 models)
        const response = await fetch(page ? `${GEMINI_LIST}&pageToken=${encodeURIComponent(page)}` : GEMINI_LIST, {
          method: 'GET', signal: own.signal, cache: 'no-store', headers: { 'x-goog-api-key': sending } });
        if (out.ms === null) out.ms = Math.round(performance.now() - began);
        out.status = response.status;
        let data = null;
        let readable = true;
        try {
          data = await response.json();
        } catch (error) {
          // An answer that stopped coming (out of time, or the connection went) is no answer; one that came whole but
          // isn't JSON isn't Google's list (an error's words are only a bonus).
          if (response.ok && !(error instanceof SyntaxError)) throw error;
          readable = false;
        }
        if (!response.ok) {
          const said = googleError(data, sending);
          out.trouble = geminiTrouble(response.status, said);
          out.said = said.message;
          return out;
        }
        if (!readable || !data || typeof data !== 'object' || Array.isArray(data)
          || (data.models !== undefined && !Array.isArray(data.models))) {
          out.trouble = 'garbled';
          return out;
        }
        found.push(...(data.models || []));
        page = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
        if (!page) break;
      }
      out.ok = true;
      out.models = stableFlash(found);
    } catch (error) {
      out.trouble = late ? 'slow' : 'offline';
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  /* This key's other models, asked for in the background when the listing kept here is a day old (or there's none, or
     it's dated later than now): never waited for by a request that has a model to ask. Returns the listing on its way
     (or null). */
  function discover(sending) {
    const have = listedNow();
    if (listing || (have && lately(have.at, LIST_FOR)) || performance.now() - listFailedAt < LIST_RETRY) return listing;
    const gen = listGen;
    const mine = listModels(sending).then((got) => {
      if (gen !== listGen) return;  // (signed out, or the key changed, meanwhile)
      if (got.ok) keepList(got.models);
      else listFailedAt = performance.now();
    }, () => { if (gen === listGen) listFailedAt = performance.now(); }).finally(() => { if (listing === mine) listing = null; });
    listing = mine;
    return listing;
  }

  /* Up to EXTRAS numbered models to ask besides the "latest" names: the newest Flash and the newest Flash-Lite this key
     is offered, leaving out what a "latest" name was seen to point to (the same model again), newest first. */
  function extras() {
    const have = listedNow();
    if (!have) return [];
    const same = new Set(GEMINI_MODELS.map(versionOf).filter(Boolean));
    const free = have.models.map((m) => m.id).filter((id) => !GEMINI_MODELS.includes(id) && !same.has(id));
    const pick = [false, true].map((lite) => free.find((id) => /-lite$/.test(id) === lite)).filter(Boolean);
    for (const id of free) if (pick.length < EXTRAS && !pick.includes(id)) pick.push(id);
    return free.filter((id) => pick.slice(0, EXTRAS).includes(id));
  }

  /* How much `model` may think for `use`, most wanted first: the "latest" names and Gemini 3 and later take THINKING,
     a numbered 2.x THINKING_2, and one ListModels says can't think nothing at all. */
  function levelsFor(model, use) {
    const have = listedNow();
    const found = have && have.models.find((m) => m.id === model);
    if (found && found.thinks === false) return [null];
    const number = /^gemini-(\d+)/.exec(model);
    const table = number && Number(number[1]) < 3 ? THINKING_2 : THINKING;
    return table[use] || table.chat;
  }

  /* The models to ask, in order, for `use` ('chat' or 'notes'; `wait`: the check on Save, the "latest" names only).
     A chat: the quickest here first, then models found by ListModels and not timed here yet, then failing ones, then
     any that lost a race for this use a moment ago (slowUntil), each group in Vault's own order otherwise. "Quickest"
     goes by the usual time once a model has two timings here; until then a model counts as starting within the usual
     head start (waits.head), or as its one timing when that was slower: one slow start moves a model down at once,
     but only a second quick one moves it up. The note-taker: Vault's own order (Flash first), a model that keeps
     failing or kept losing its races here moved after the rest, one that lost a moment ago last. */
  function ranked(use = 'chat', { wait = false } = {}) {
    const base = wait ? [...GEMINI_MODELS] : [...GEMINI_MODELS, ...extras()];
    const unknown = Math.max(0, Number(waits.head) || 0);
    const rank = (model) => {
      if (isSlow(model, use)) return [3, 0];
      if (wait) return [0, 0];
      if (failing(model)) return [2, 0];
      if (use === 'notes') return [verySlow(model) ? 2 : 0, 0];
      const timings = recent(model, 'chat').length;
      if (!timings && !GEMINI_MODELS.includes(model)) return [1, 0];  // (found, not timed: a fallback until it is)
      const usual = settled(model);
      return [0, usual !== null ? usual : timings ? Math.max(typical(model, 'chat'), unknown) : unknown];
    };
    return base.map((model, at) => ({ model, at, rank: rank(model) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.at - b.at).map((m) => m.model);
  }

  /* A chat's head start for `model` (ms): one and a half times its usual time here, at least waits.headMin (a quick
     model gets a moment's grace: a normal slow moment never sends a second copy of the request, which counts against
     the free daily limit like any other) and at most waits.head; waits.head until it has two timings here. */
  function headFor(model) {
    const most = Math.max(0, Number(waits.head) || 0);
    const usual = settled(model);
    if (usual === null) return most;
    const least = Math.min(Math.max(0, Number(waits.headMin) || 0), most);
    return Math.min(most, Math.max(least, Math.round(usual * 1.5)));
  }

  /* Everything learned about the models forgotten (tests; and a fresh start). */
  function forgetSpeed() {
    speed = { models: {} };
    speedText = null;
    store(SPEED_KEY, null);
    slowUntil.clear();
  }

  /* The pieces of a streamed answer (server-sent events, "data: {json}" each) in `buffer`, as parsed objects, and
     what's left over (a piece not complete yet). */
  function ssePieces(buffer) {
    const pieces = [];
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { pieces.push(JSON.parse(data)); } catch (error) { /* not a piece of the answer */ }
    }
    return { pieces, buffer };
  }

  /* One model, streamed (streamGenerateContent, alt=sse): its words go to `onText` as they come. Returns { answer:
     { text, finish, usage, model, version, cut, blocked, here } } (version: the model Google says answered, its
     modelVersion; cut: the answer stopped part-way; blocked: Google turned the prompt itself down, its
     promptFeedback.blockReason; here: it was cut off at this end, see below), { trouble, why, here } when the model
     didn't answer (geminiTrouble's kinds, 'slow': no first words within `first` ms plus the time the request takes to
     go up, or 'uplink' with its size: a big request Google hadn't even answered by then), or throws an AiError
     'stopped' (and no words yet) or 'offline' (no answer at all). `here`: what went wrong may well have been this
     device's doing, not the model's (the connection dropped part-way, or the page was out of sight, offline or
     changed networks while it waited: `unsettledSince`), so it's never held against the model; an error piece from
     Google, an answer Google ended unfinished, an HTTP error, or no words (or no more words) in time with the page in
     sight and online all along are the model's. `use` picks how much it may think (levelsFor; `step`: a setting
     further down that list, tried once without being remembered unless it's taken). `timing`, when given, is filled
     in: ms to Google's answer (`answered`, with its `status`) and to the first words (`words`), the `version` that
     answered, the `thinking` setting sent (null: none) and, when Google says, how many tokens it thought for
     (`thoughts`). */
  async function geminiTry(sending, model, { system, contents, maxTokens, signal, onText, first, use = 'chat', timing = null,
    step = null }) {
    const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const levels = levelsFor(model, use);
    const stepKey = `${model} ${use}`;
    const at = step === null ? Math.min(thinkingStep.get(stepKey) || 0, levels.length - 1) : step;
    const thinking = levels[at];
    if (thinking) body.generationConfig.thinkingConfig = { ...thinking };
    if (timing) timing.thinking = thinking ? { ...thinking } : null;
    const payload = JSON.stringify(body);
    const own = new AbortController();
    const follow = () => own.abort();
    if (signal) { if (signal.aborted) own.abort(); else signal.addEventListener('abort', follow, { once: true }); }
    const began = performance.now();
    const since = () => Math.round(performance.now() - began);
    let why = '';  // 'slow' (no first words in time) or 'idle' (an answer that stopped coming): we stopped it
    const upload = Math.ceil(payload.length / Math.max(1, Number(waits.uplink) || 1));  // (the request going up)
    let timer = setTimeout(() => { why = 'slow'; own.abort(); }, first + upload);
    const keepWaiting = () => { clearTimeout(timer); timer = setTimeout(() => { why = 'idle'; own.abort(); }, waits.idle); };
    let text = '';
    let finish = '';
    let blocked = '';
    let version = '';
    let parsed = 0;  // pieces of an answer read (any shape)
    let usage = {};
    const take = (piece) => {
      parsed += 1;
      if (piece.modelVersion) version = String(piece.modelVersion);
      if (piece.promptFeedback && piece.promptFeedback.blockReason) blocked = String(piece.promptFeedback.blockReason);
      const cand = (piece.candidates || [])[0] || {};
      // (only words count: a thought, or a part with only a thoughtSignature, isn't the answer starting)
      const words = (((cand.content || {}).parts) || []).filter((p) => p && typeof p.text === 'string' && !p.thought)
        .map((p) => p.text).join('');
      if (cand.finishReason) finish = String(cand.finishReason);
      if (piece.usageMetadata) usage = piece.usageMetadata;
      if (text || words) keepWaiting();  // once the words have started, only a stalled answer is given up on
      if (words) {
        if (!text && timing) timing.words = since();
        text += words;
        if (onText) onText(text);
      }
    };
    const stopped = () => signal && signal.aborted;
    const answer = (cut, here = false) => {
      if (timing) {
        timing.version = version;
        const thoughts = Number(usage && usage.thoughtsTokenCount);
        if (Number.isFinite(thoughts) && thoughts >= 0) timing.thoughts = thoughts;
      }
      return { answer: { text, finish: stopped() ? 'STOPPED' : finish, usage, model, version, cut, blocked, here } };
    };
    try {
      let response;
      try {
        response = await fetch(`${GEMINI_API}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST', signal: own.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': sending },
          body: payload,
        });
      } catch (error) {
        if (stopped()) throw new AiError('stopped', 'Stopped.');
        // Out of time before Google even answered: with a big request, it was still going up (the connection's fault).
        if (why === 'slow') {
          return payload.length > BIG_BODY ? { trouble: 'uplink', size: payload.length }
            : { trouble: 'slow', here: unsettledSince(began) };
        }
        throw new AiError('offline', navigator.onLine ? WORDS.geminiOffline : WORDS.away);
      }
      if (timing) { timing.answered = since(); timing.status = response.status; }
      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch (error) { /* not JSON */ }
        const said = googleError(data, sending);
        if (response.status === 400 && thinking) {
          const again = (next) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', follow);
            return geminiTry(sending, model, { system, contents, maxTokens, signal, onText, first, use, timing, step: next });
          };
          // This model turns that thinking setting down: once more with the next one (and from now on).
          if (/thinking/i.test(said.message)) { thinkingStep.set(stepKey, at + 1); return again(null); }
          // Google's bare "invalid argument" says nothing of why: once more asking for less thinking, in case it's the
          // setting this model turns down (remembered only if that one is taken; a second refusal is final).
          if (step === null && GENERIC_400.test(said.message) && at + 1 < levels.length) return again(at + 1);
        }
        return { trouble: geminiTrouble(response.status, said), why: said };
      }
      if (step !== null) thinkingStep.set(stepKey, Math.max(thinkingStep.get(stepKey) || 0, step));  // (it was the setting)
      let buffer = '';
      let pieces = 0;
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const read = ssePieces(buffer + decoder.decode(value, { stream: true }));
          buffer = read.buffer;
          for (const piece of read.pieces) {
            pieces += 1;
            if (piece.error) {  // Google's trouble in the middle of an answer
              if (text) return answer(true);
              const said = googleError(piece, sending);
              return { trouble: geminiTrouble(Number(piece.error.code) || 500, said), why: said };
            }
            take(piece);
          }
        }
        const last = ssePieces(`${buffer}${decoder.decode()}\n\n`);  // (the last piece, even without its blank line)
        buffer = last.pieces.length ? '' : buffer;
        last.pieces.forEach((piece) => { pieces += 1; if (!piece.error) take(piece); });
      } catch (error) {  // stopped, too slow, or the connection went
        if (stopped()) {
          if (text) return answer(false);
          throw new AiError('stopped', 'Stopped.');
        }
        // Our own wait running out (no words, or no more words, in time) with the page in sight and online all along is
        // the model's doing; a read that failed by itself (the connection went), or anything while this device was
        // unsettled, is this end's.
        const here = !why || unsettledSince(began);
        if (text) return answer(true, here);
        if (why === 'slow') return { trouble: 'slow', here };
        return { trouble: 'busy', here };
      }
      if (!pieces && buffer.trim()) {  // a plain JSON answer (a list of pieces) rather than events
        try { [].concat(JSON.parse(buffer)).forEach(take); } catch (error) { /* not JSON */ }
      }
      if (!text && blocked) return answer(false);  // Google won't answer this prompt: final, no other model asked
      if (!text && !finish) return parsed ? answer(false) : { trouble: 'busy' };  // an empty answer, or nothing at all
      return answer(!finish);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', follow);
    }
  }

  /* One request with `sending` as the key, to the models `ranked` puts first (for a chat, the quickest here; one that
     was slow lately, last). The first model is asked at once; if it hasn't started its answer after its head start
     (`headFor` for a chat, waits.head for one with pictures or PDFs (HEAVY_BODY), waits.notesHead for notes, plus a
     little for the request going up), the next one is asked too, and when it fails, the next at once (AT_ONCE at most
     at once). The first to start answering wins and the others are stopped (and one asked before it, tried last for a
     while). One Google doesn't offer this key, whose free quota is used up, that's overloaded or too slow to start, or
     that turns the key down gives way to the next; models ListModels found are asked after the "latest" names (unless
     timed here as quicker), and when none is left to ask while that listing is still on its way, it's waited for
     (waits.list at most). A "latest" name that turns the request down, or answers with nothing (empty, or the prompt
     blocked), says so for itself only while another model may still answer: that one carries on, and nothing new is
     asked because of it (a request Google turns down isn't sent again). A model ListModels found that does so only
     speaks for itself: the others are still asked, and its "no" is only the answer when none of them could (never
     outweighing a busy or used-up Gemini, which waits and goes again by itself, but outweighing any word about the key:
     it took the key). What each model did is remembered on this device (`timed`, `failedHere`; an answer that stopped
     coming part-way on Google's side counts as a failure, never as a quick start; nothing that may have been this
     device's doing, geminiTry's `here`, counts against a model), except for the check on Save.
     `wait` (ms): how long the check on Save waits for each; otherwise `waits` by `use`. Returns geminiTry's answer, or
     throws an AiError: 'stopped', 'bad' (Google turned this request down, or this message's own files are too big to
     go up on this connection), or, when no model answered: 'quota' (Google took the key, its free quota is used up),
     'key' (a model refused the key itself: why, in plain words; never when a found model took it), 'busy' (Google's
     own trouble, or too slow: `why` 'busy', 'slow', or 'uplink': a chat whose earlier pictures and files go with every
     message, slow to go up), 'bad' (a found model's own "no"), 'key' again for a refusal that may have been one
     model's (none took the key), 'offline' (no answer: no internet, a network that blocks Google), else 'bad' (none
     offered). */
  async function geminiRequest(sending, { system, contents, maxTokens = MAX_TOKENS, signal, wait = 0, onText = null,
    use = 'chat' } = {}) {
    if (signal && signal.aborted) throw new AiError('stopped', 'Stopped.');
    const notes = use === 'notes';
    const first = wait || (notes ? waits.notesFirst : waits.first);
    const list = contents || [];
    const size = JSON.stringify(list).length + String(system || '').length;
    // The head start allows a little for the request going up, never much: each model's own first-words wait allows
    // all of it (geminiTry), but a slow model must still give way within seconds on a good connection. A big request
    // (pictures, PDFs) never gets a learned shorter one: a second copy only goes up after the full head start.
    const upload = Math.ceil(size / Math.max(1, Number(waits.uplink) || 1));
    const going = Math.min(Math.max(0, Number(waits.headUpload) || 0), upload);
    const heavy = size > HEAVY_BODY;
    const headOf = (model) => (notes ? waits.notesHead : heavy ? waits.head : headFor(model)) + going;
    const own = JSON.stringify(list[list.length - 1] || '').length;  // this message's part (the rest: the chat so far)
    const learn = !wait;  // (the check on Save never decides which model real requests try first)
    const clock = () => performance.now();  // (the time that has really gone by: a clock being put right doesn't move it)
    const found = (model) => !GEMINI_MODELS.includes(model);  // (one ListModels found)
    if (learn) discover(sending);  // (in the background: this key's other stable Flash models, kept a day)
    const order = [];
    const refill = () => ranked(use, { wait }).forEach((m) => { if (!order.includes(m)) order.push(m); });
    refill();
    const failed = [];
    const runs = [];     // { model, at, ctl, done, seen, lost, wordsAt, result | error }
    let winner = null;   // the first to start its answer
    let held = null;     // the first "no" of its own (turned down, empty, blocked) while another model might still answer
    let aside = null;    // the first "no" of a model ListModels found: the answer only when no other model can give one
    let next = 0;
    let more = true;     // others may still be asked (not after no answer at all: the next is on the same network)
    let wake = null;
    const drop = (run) => { run.lost = true; run.ctl.abort(); };
    const letGo = () => runs.filter((r) => !r.done).forEach(drop);
    const launch = () => {
      const run = { model: order[next++], at: clock(), ctl: new AbortController(), done: false, seen: false, lost: false,
        wordsAt: 0 };
      geminiTry(sending, run.model, { system, contents, maxTokens, signal: run.ctl.signal, first, use, onText: (text) => {
        if (!run.wordsAt) run.wordsAt = clock();
        if (!winner) {
          winner = run;
          runs.filter((r) => r !== run && !r.done).forEach(drop);
        }
        if (winner === run && onText) onText(text);
      }, timing: (run.timing = {}) }).then((result) => { run.result = result; }, (error) => { run.error = error; })
        .finally(() => { run.done = true; if (wake) wake(); });
      runs.push(run);
    };
    // The answer that's used: any model whose big request hadn't even been answered in time, while this one got
    // through, was the slow one (not the connection), so it's tried last for a while. How long this one took to start,
    // and how long the ones asked before it went without starting, are remembered. One whose answer then stopped coming
    // part-way on Google's side isn't a quick model to ask first: it's a failure, and tried last for this use a while
    // (a Retry asks another). One cut off at this end (the connection dropped, the page put away: `here`) did nothing
    // wrong: only how quickly it started is remembered.
    const taken = (run, answer) => {
      letGo();
      if (learn) {
        runs.filter((r) => r !== run && r.result && r.result.trouble === 'uplink')
          .forEach((r) => markSlow(r.model, use));
        if (run.wordsAt) {
          if (answer.cut && answer.finish !== 'STOPPED' && !answer.here) {
            failedHere(run.model);
            markSlow(run.model, use);
          } else if (!(answer.cut && answer.here)) {
            // (an answer this device cut off counts neither way: it neither forgives the model's failures nor adds one)
            timed(run.model, use, run.wordsAt - run.at, true);
          }
          runs.filter((r) => r !== run && r.lost && r.at < run.at).forEach((r) => timed(r.model, use, run.wordsAt - r.at, false));
        }
        if (run.timing && run.timing.version) pointsTo(run.model, run.timing.version);
      }
      return answer;
    };
    const stopAll = () => { runs.forEach((r) => r.ctl.abort()); if (wake) wake(); };
    if (signal) signal.addEventListener('abort', stopAll, { once: true });
    try {
      launch();
      for (;;) {
        for (const run of runs) {  // what came back
          if (!run.done || run.seen) continue;
          run.seen = true;
          if (run.lost) {
            // (asked before the one that won and still silent: slow right now. Not for the check on Save.)
            if (learn && winner && run.at < winner.at) markSlow(run.model, use);
            continue;
          }
          // One that ended before the winner's words came (what it said is beside the point now): the winner answers.
          if (winner && run !== winner) continue;
          if (run.error) {
            if (run.error.kind !== 'offline') { letGo(); throw run.error; }
            failed.push({ trouble: 'offline' });
            more = false;
            continue;
          }
          const tried = run.result;
          const answer = tried.answer;
          if (answer && (answer.text || answer.finish === 'STOPPED')) return taken(run, answer);
          // Turned down, or an answer with nothing in it (empty, or the prompt blocked): this model's own "no". Another
          // one still working on it (asked because this one was slow, so it has had the request all along) carries on,
          // and gives the answer if it has one; nothing new is asked because of it (`held` stops that). A model
          // ListModels found speaks only for itself (Google's numbered models differ in what they take): the rest are
          // still asked, and its "no" is kept aside, the answer only if none of them can do better.
          if (answer || tried.trouble === 'bad') {
            if (found(run.model)) {
              if (learn && !answer) failedHere(run.model);
              aside = aside || tried;
            } else {
              held = held || tried;
            }
            continue;
          }
          if (tried.trouble === 'uplink') {
            // A big request not even answered in time: going up slowly, or a slow model (no telling which). No other
            // model is asked because of it (it would send it all again on the same network); one already asked goes on.
            more = false;
            failed.push(tried);
            continue;
          }
          // (never held against it when it may have been this device's doing: `here`)
          if (learn && tried.trouble === 'slow' && !tried.here) {
            markSlow(run.model, use);
            timed(run.model, use, clock() - run.at, false);
          }
          const failure = ['busy', 'quota', 'missing', 'refused'].includes(tried.trouble);
          if (learn && !tried.here && failure) failedHere(run.model);
          failed.push(tried);
        }
        if (learn && !winner) refill();  // (models ListModels found meanwhile, after the rest)
        const live = runs.filter((r) => !r.done);
        const canStart = !winner && !held && more && next < order.length && live.length < AT_ONCE
          && !(signal && signal.aborted);
        // The next model: at once when none is still trying or the newest one asked has already failed, else once the
        // newest one's head start has run out.
        const newest = runs[runs.length - 1];
        const due = !canStart ? Infinity : !live.length || newest.done ? 0 : newest.at + headOf(newest.model) - clock();
        if (due <= 0) { launch(); continue; }
        // Nothing left to ask and nothing still trying, while this key's other models are being listed: wait for them.
        const listingNow = learn && !winner && !held && more && !live.length && next >= order.length
          && !(signal && signal.aborted) ? listing : null;
        if (!live.length && !listingNow) break;
        let timer = null;
        await new Promise((resolve) => {
          wake = resolve;
          if (Number.isFinite(due)) timer = setTimeout(resolve, due);
          if (listingNow) listingNow.then(resolve, resolve);
        });
        clearTimeout(timer);
        wake = null;
      }
    } finally {
      if (signal) signal.removeEventListener('abort', stopAll);
    }
    if (signal && signal.aborted) throw new AiError('stopped', 'Stopped.');
    const couldNot = (no) => {  // a model's own "no" stands (Google turned it down, or answered with nothing)
      if (no.answer) return no.answer;
      throw new AiError('bad', `Gemini couldn't answer this${no.why && no.why.message ? ` (${no.why.message})` : ''}.`);
    };
    if (held) return couldNot(held);  // (no model answered after all)
    const firstOf = (...troubles) => failed.find((f) => troubles.includes(f.trouble));
    if (firstOf('quota')) throw Object.assign(new AiError('quota', WORDS.geminiQuota), { why: 'quota' });  // (a model took the key)
    // A found model that turned this request down (or answered with nothing) took the key: whatever the others said,
    // the key is never what's wrong then (no "make a new key" for a key that works).
    if (!aside && firstOf('key')) throw new AiError('key', keyWords(firstOf('key').why, sending));
    if (firstOf('busy')) throw Object.assign(new AiError('busy', WORDS.geminiBusy), { why: 'busy' });  // (likewise)
    if (firstOf('slow')) throw Object.assign(new AiError('busy', WORDS.geminiSlow), { slow: true, why: 'slow' });
    if (firstOf('uplink')) throw uplinkError(firstOf('uplink').size, own);
    // (the "latest" names refused the key, weren't offered to it or couldn't be reached: the found model's "no" stands)
    if (aside) return couldNot(aside);
    if (firstOf('refused')) throw new AiError('key', keyWords(firstOf('refused').why, sending));
    if (firstOf('offline')) throw new AiError('offline', navigator.onLine ? WORDS.geminiOffline : WORDS.away);
    const said = failed[0] && failed[0].why && failed[0].why.message;
    throw new AiError('bad', `Google's Gemini models aren't available for this key right now${said ? ` (${said})` : ''}. Try again later.`);
  }

  const megabytes = (size) => Math.max(1, Math.round(size / (1000 * 1000)));

  /* A request too big to go up on this connection in time, in plain words. */
  function tooBig(size) {
    return `This message has ${megabytes(size)} MB of files, too much to send on this connection right now. Try on Wi-Fi, or remove a file.`;
  }

  /* A big request (`size`) no model had even answered in time. When this message's own files (`own`) are the big part,
     the owner can take one off: it comes back to them ('bad'). When it's the chat's earlier pictures and files (they go
     with every message), nothing proves it was the connection rather than a slow model: it waits and goes again by
     itself ('busy', why 'uplink'), saying a new chat would be quicker. */
  function uplinkError(size, own) {
    if (own * 2 >= size) return new AiError('bad', tooBig(own));
    return Object.assign(new AiError('busy', `This chat sends ${megabytes(size - own)} MB of earlier pictures and files with `
      + 'every message, slow to go up on this connection. It goes again by itself in a little while (or start a new chat).'),
    { slow: true, why: 'uplink' });
  }

  /* One request straight to Google's Gemini API with the saved key. `contents` is Gemini's own shape ([{ role:
     'user'|'model', parts:[...] }]): the note-taker sends one user turn (`use` 'notes'), the Chat tab a whole
     conversation (whichever Gemini its chat names, 1.7's "gemini-2.5-flash" too: GEMINI_MODELS decide). Streamed:
     `onText` gets the words so far as they come. Returns { text, stopReason, usage } like `direct` (stopReason also
     'stopped', or 'cut_off' for an answer that stopped coming part-way), with usage.gemini so it's priced as free,
     usage.model the model that answered (and usage.version, the one Google says that is). A used-up free quota is
     'busy' (why: 'quota'), so it waits and goes again later like a busy Claude. */
  async function callGemini({ system, contents, maxTokens = MAX_TOKENS, signal, onText = null, use = 'chat' } = {}) {
    const sending = await getGeminiKey();
    let answer;
    try {
      answer = await geminiRequest(sending, { system, contents, maxTokens, signal, onText, use });
    } catch (error) {
      if (error.kind === 'key') geminiKey = null;  // forgotten, so a key set up again elsewhere is read next time
      if (error.kind === 'quota') throw Object.assign(new AiError('busy', error.message), { why: 'quota' });
      throw error;
    }
    const { text, finish, usage, model, version, cut, blocked } = answer;
    // An answer that stopped part-way: the chat shows what came (`onText`); the note-taker waits and asks again later.
    if (cut && !onText && finish !== 'STOPPED') throw Object.assign(new AiError('busy', WORDS.geminiBusy), { why: 'busy' });
    const stopReason = finish === 'STOPPED' ? 'stopped' : blocked && !text ? 'refusal' : cut ? 'cut_off'
      : finish === 'MAX_TOKENS' ? 'max_tokens'
      : ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII'].includes(finish) ? 'refusal'
      : 'end_turn';
    return { text, stopReason, usage: { gemini: true, model, ...(version ? { version } : {}),
      input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 } };
  }

  /* `promise`, or 'stopped' as soon as `signal` says so (what it was waiting for isn't waited for any more). */
  function untilStopped(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const stop = () => reject(STOPPED());
      if (signal.aborted) { stop(); return; }
      signal.addEventListener('abort', stop, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  // The words Claude has written so far, from a PC that streams the note-taker's answer (vault/notetaker.py, 1.8.3:
  // makeNotes with a `ref`, "notes-progress" {ref, words}), to whoever asked.
  const progressFor = new Map();
  let refs = 0;
  V.on('pc:notes-progress', (data) => {
    const told = progressFor.get((data || {}).ref);
    if (told) told(Number(data.words) || 0);
  });

  /* The note-taker's request from the PC: Python asks Claude with Jarvis's key. A PC that knows makeNotesStop (it
     streams and watches the answer) is given a `ref`, says how far it's got (`onProgress`) and is told to stop when
     `signal` does. What an answer that didn't come to its end had cost (Python says: its `usage`) is added to the
     tally, and so is an answer that comes after it was stopped (on an older PC, which can't be told to stop): both cost
     money, and neither is ever written. */
  async function viaPc(system, text, signal = null, onProgress = null) {
    if (!claudeOn()) throw new AiError('off', WORDS.off);  // (Jarvis's key is never used while Claude is off)
    if (!V.pc.can('makeNotes')) throw new AiError('old', WORDS.old);
    const ref = V.pc.can('makeNotesStop') ? `notes-${Date.now().toString(36)}-${++refs}` : '';
    if (ref && onProgress) progressFor.set(ref, onProgress);
    const call = V.pc.call('makeNotes', ref ? { system, transcript: text, ref } : { system, transcript: text });
    let answer;
    try {
      answer = await untilStopped(call, signal);
    } catch (error) {
      if (signal && signal.aborted) {
        if (ref) V.pc.call('makeNotesStop', { ref }).catch(() => {});
        call.then((late) => { if (late && late.usage) charge(late.usage); }, () => {});
      }
      throw error;
    } finally {
      progressFor.delete(ref);
    }
    if (!answer.ok) {
      if (answer.usage) await charge(answer.usage);  // (given up on, or cut off, part-way: paid for that far)
      const kind = answer.kind || 'bad';
      if (kind === 'stopped') throw STOPPED();
      if (answer.slow) throw answer.cloud ? cloudSlow() : Object.assign(new AiError('busy', WORDS.slow), { slow: true, why: 'slow' });
      throw new AiError(kind, WORDS[kind] || (kind === 'nokey' ? answer.message
        : `Claude couldn't make notes from this (${answer.message || 'no answer'}). Your words are saved.`));
    }
    return { text: answer.text || '', stopReason: answer.stop_reason || '', usage: answer.usage || {} };
  }

  /* The note-taker's request to the free Gemini (its key fetched in time, or it's "your cloud is taking too long").
     `onProgress` gets the words written so far; an answer that stopped coming part-way is 'busy' (made again later). */
  async function geminiNotes(system, text, signal = null, onProgress = null) {
    await within(getGeminiKey(), waits.look, cloudSlow());
    const answer = await callGemini({ system, contents: [{ role: 'user', parts: [{ text }] }], use: 'notes', signal,
      onText: onProgress ? (so) => onProgress(countWords(so)) : null });
    if (answer.stopReason === 'cut_off') throw Object.assign(new AiError('busy', WORDS.geminiBusy), { why: 'busy' });
    return answer;
  }

  /* `run(signal, progress)` (one of the three above) given `ms` (waits.ask) with no sign of the answer being written:
     past that it's stopped and 'busy' (slow: "taking too long"), so the note-taker keeps the words and the notes are
     made later. Each `progress(words)` from `run` (the answer is being written) starts that wait again and goes on to
     `onProgress`: an answer still coming is never cut off (it's paid for). `ms` null: no limit (an older PC, which
     can't be told to stop: giving up there would only leave its request running while the note is asked for again).
     The caller's `signal` stops it too ('stopped'). Either way, an answer that comes anyway is never returned: one
     set of notes only. */
  async function bounded(run, { signal = null, who = 'claude', ms = waits.ask, onProgress = null } = {}) {
    const own = new AbortController();
    const follow = () => own.abort();
    if (signal) { if (signal.aborted) own.abort(); else signal.addEventListener('abort', follow, { once: true }); }
    let late = false;
    let timer = null;
    const wait = () => {
      clearTimeout(timer);
      if (ms !== null && !own.signal.aborted) timer = setTimeout(() => { late = true; own.abort(); }, ms);
    };
    const progress = (words) => {
      if (own.signal.aborted) return;
      wait();
      if (onProgress) onProgress(words);
    };
    const verdict = () => (late ? Object.assign(new AiError('busy', who === 'gemini' ? WORDS.geminiSlow : WORDS.slow),
      { slow: true, why: 'slow' }) : signal && signal.aborted ? STOPPED() : null);
    wait();
    try {
      const answer = await untilStopped(run(own.signal, progress), own.signal);  // (at once, even if `run` is slow to notice)
      const why = verdict();
      if (why) throw why;
      return answer;
    } catch (error) {
      throw verdict() || error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', follow);
    }
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

  /* Settings' "Check Gemini" (free: it's Google's free key, and a few words each), timed, so a slow Gemini can be told
     apart from a slow network. First Google's list of models (the round trip to Google with the key, no model at work:
     `network`, { ok, ms, status, trouble, said }, and the listing kept for a day), then one tiny request to each model
     in turn, the "latest" names first, then the numbered ones ListModels offers (`extras`). For each: { model, version
     (what a "latest" name points to now, as Google says), ok, trouble (geminiTrouble's kinds, 'slow', 'offline'),
     status (the HTTP status), answered (ms to Google's answer), words (ms to the first words), thinking (the setting
     sent, null: none), thoughts (tokens it thought for, when Google says), finish, said (Google's words, never the
     key) }. Each is remembered like a chat's (`timed`), so `first` is the model a chat asks first now, and `usual` how
     long it usually takes here. Only ever to generativelanguage.googleapis.com, like every Gemini request. */
  async function checkGemini() {
    const sending = await getGeminiKey();
    const offered = await listModels(sending, waits.check);
    if (offered.ok) keepList(offered.models);
    const network = { ok: offered.ok, ms: offered.ms, status: offered.status, trouble: offered.trouble, said: offered.said };
    const out = [];
    const one = async (model) => {
      const timing = {};
      const began = performance.now();
      let tried;
      try {
        tried = await geminiTry(sending, model, { contents: [{ role: 'user', parts: [{ text: 'Say hi in two words.' }] }],
          maxTokens: 64, first: waits.check, use: 'chat', timing });
      } catch (error) {
        tried = { trouble: error.kind === 'offline' ? 'offline' : 'bad', why: { message: error.message } };
      }
      const answer = tried.answer || null;
      if (answer && answer.cut && !answer.here) failedHere(model);  // (Google stopped it part-way: as in a chat)
      else if (answer && answer.cut) { /* (cut off at this end: nothing held either way) */ }
      else if (answer && typeof timing.words === 'number') timed(model, 'chat', timing.words, true);
      else if (tried.here) { /* (this device's doing, maybe: nothing held against the model) */ }
      else if (tried.trouble === 'slow') timed(model, 'chat', performance.now() - began, false);
      else if (['busy', 'quota', 'missing', 'refused'].includes(tried.trouble)) failedHere(model);
      if (answer && timing.version) pointsTo(model, timing.version);
      out.push({ model, version: timing.version || (answer && answer.version) || '', ok: !!answer, trouble: tried.trouble || '',
        status: timing.status || 0, answered: timing.answered, words: timing.words,
        thinking: timing.thinking === undefined ? null : timing.thinking,
        ...(typeof timing.thoughts === 'number' ? { thoughts: timing.thoughts } : {}),
        finish: answer ? answer.finish : '', said: (tried.why && tried.why.message) || '' });
    };
    for (const model of GEMINI_MODELS) await one(model);
    for (const model of extras()) await one(model);  // (after the "latest" names: what they point to isn't asked twice)
    const lead = ranked('chat')[0] || GEMINI_MODELS[0];
    return { network, models: out, first: lead, usual: typical(lead, 'chat') };
  }

  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

  /* The thinking setting a check sent, in a few words. */
  function thinkingWords(thinking) {
    if (!thinking) return 'no thinking setting';
    if (thinking.thinkingLevel) return `thinking ${thinking.thinkingLevel}`;
    if (typeof thinking.thinkingBudget === 'number') return `thinking budget ${thinking.thinkingBudget}`;
    return 'thinking setting sent';
  }

  /* The Check Gemini network line, in plain words. */
  function networkLine(n) {
    const took = typeof n.ms === 'number' ? `Google answered in ${secs(n.ms)}` : '';
    if (n.ok) return `Network: ${took} (its list of models: no model at work)`;
    if (n.trouble === 'offline') return 'Network: Google can\'t be reached from this network';
    if (n.trouble === 'slow') return `Network: no answer from Google after ${secs(waits.check)}`;
    // (a 200 that isn't Google's list of models: a network filter's page, say)
    if (n.trouble === 'garbled') return `Network: something answered in ${secs(n.ms || 0)}, but not with Google's list of models`;
    if (n.trouble === 'key' || n.trouble === 'refused') return `Network: ${took}, but refused the key (${n.status})`;
    return `Network: ${took} (${n.status}${n.said ? `: ${n.said}` : ''})`;
  }

  /* One line of the Check Gemini result, in plain words: what happened, then (when it answered) the thinking setting
     sent and how long it thought, when Google says. */
  function timingLine(r) {
    const name = r.version && r.version !== r.model ? `${r.model} (${r.version})` : r.model;
    const http = r.status ? ` (${r.status})` : '';
    const answered = typeof r.answered === 'number' ? `Google answered in ${secs(r.answered)}` : '';
    if (r.ok) {
      const words = typeof r.words === 'number' ? `first words in ${secs(r.words)}` : `no words (${r.finish || 'empty'})`;
      const how = [thinkingWords(r.thinking), typeof r.thoughts === 'number' ? `thought for ${r.thoughts} tokens` : '']
        .filter(Boolean).join(' · ');
      return `${name}: OK — ${[answered, words].filter(Boolean).join(', ')} · ${how}`;
    }
    const what = {
      slow: `no words after ${secs(waits.check)}`,
      busy: `busy${http}`,
      quota: `free limit used up for now${http}`,
      missing: `not offered to this key${http}`,
      key: `refused the key${http}`,
      refused: `refused the key${http}`,
      offline: 'can\'t be reached from this network',
    }[r.trouble] || `turned the check down${http}${r.said ? `: ${r.said}` : ''}`;
    return `${name}: ${what}${answered && r.trouble !== 'slow' ? ` — ${answered}` : ''}`;
  }

  /* Which model a chat asks first now, in plain words (after Check Gemini). */
  function firstLine(found) {
    const usual = typeof found.usual === 'number' ? ` (about ${secs(found.usual)} to its first words here)` : '';
    return `Chat asks ${found.first} first now${usual}.`;
  }

  /* Whether Claude or the free Gemini can be used here: Claude only while it's switched on, from the cloud (a phone, a
     Chromebook, a Vault on its own) or with Jarvis's key (the PC); Gemini with its key in the cloud, on any device. */
  function has(who) {
    if (who === 'gemini') return !!(known && known.gemini);
    return claudeOn() && !!(known && (known.cloud || (V.desktop && known.pc)));
  }

  /* Which brain `ask` uses here for the note-taker, as far as the key check (check()) knows: the free Gemini while
     Claude is off. With Claude on, still Gemini when its key is set up, unless "Write notes with Claude" is on;
     otherwise Claude when it can be used here (Jarvis's key on the PC, else a key in the cloud; a PC's Claude goes
     through Python, Vault on its own too), so an account with only a Claude key still gets its notes. With neither key
     it's Gemini, whose setup is what's offered (Gemini first). Only a check that couldn't tell (none yet, or it failed)
     leaves it to Claude, as 1.8 did: on the PC, Python knows about Jarvis's key without the cloud. A Gemini key the
     check couldn't tell about (the PC's listing came too late) isn't known to be there: Claude for now, and `ask`
     looks for it before it decides (pick). */
  function brain() {
    if (!claudeOn()) return 'gemini';
    if (!notesClaude() && has('gemini')) return 'gemini';
    if (has('claude')) return 'claude';
    return has('gemini') || (known && !known.failed) ? 'gemini' : 'claude';
  }

  /* The brain for one request of the note-taker: brain(), except that with Claude on and the notes left to Gemini (the
     default), a Gemini key the key check couldn't tell about is looked for first (fetched, as its request would: in
     memory only), so a Gemini that's set up is never passed over for the paid Claude because a listing was slow. Not
     found, or the cloud not saying in time: brain(), as it now knows. */
  async function pick() {
    if (!claudeOn() || notesClaude() || geminiKnown()) return brain();
    try {
      await within(getGeminiKey(), waits.look, cloudSlow());
      return 'gemini';
    } catch (error) {
      return brain();
    }
  }

  /* One request: { text, stopReason, usage, cost }, or an AiError whose message is ready to show. The monthly limit
     only stops Claude: the free Gemini is never counted against it. `use` 'gemini' asks Gemini whatever brain() says
     (the note-taker's "Use Gemini instead"); `onBrain('claude'|'gemini')` says which is asked, before it is;
     `onProgress(words)` how many words of the notes have come so far; `signal` stops it ('stopped'). Nothing on the way
     waits for ever: each check has waits.look (and carries on without it), the request waits.ask with no sign of the
     answer being written (then 'busy', slow), except on an older PC that can't be told to stop. A key check that
     couldn't tell where the keys are is asked again; still not known where the page keeps the key itself (a device
     that keeps its own keys, or any device while Claude is off: then it's Gemini's, from the cloud), it's 'busy' (the
     cloud is slow: the notes are made by themselves later), never a guess at the brain or a "no key". While Claude is
     off it's always Gemini, whatever `use` says; whether it is waits (up to waits.look) for the settings row to be read
     from the cloud on a device that hasn't yet (modeReady). With Claude on, Gemini still writes them when its key is
     set up, unless "Write notes with Claude" is on (brain, pick). */
  async function ask({ system, text, signal = null, use = '', onBrain = null, onProgress = null }) {
    await modeReady(waits.look);  // ("Use Claude too" as the cloud has it: a new device reads it with its first sync)
    if (!known || known.failed) { try { await check(); } catch (e) { /* carry on and let the request say what's wrong */ } }
    const off = !claudeOn();
    if (!use && known && known.failed && (ownKeys() || off)) {
      throw navigator.onLine ? cloudSlow() : new AiError('offline', WORDS.away);
    }
    const useGemini = off || (use ? use === 'gemini' : (await pick()) === 'gemini');
    if (onBrain) onBrain(useGemini ? 'gemini' : 'claude');
    if (!useGemini) {
      const over = await within(overLimit(), waits.look, null).catch(() => null);  // (only a check)
      if (over) throw over;
    }
    if (signal && signal.aborted) throw STOPPED();
    const unstoppable = !useGemini && V.desktop && !V.pc.can('makeNotesStop');  // (Jarvis 1.8.2's Python)
    let answer;
    try {
      answer = await bounded((inner, progress) => (useGemini ? geminiNotes(system, text, inner, progress)
        : V.desktop ? viaPc(system, text, inner, progress)
        : direct(system, text, inner, progress)),
      { signal, who: useGemini ? 'gemini' : 'claude', ms: unstoppable ? null : waits.ask, onProgress });
    } catch (error) {
      if (error instanceof AiError && !error.brain) error.brain = useGemini ? 'gemini' : 'claude';  // (whose trouble)
      throw error;
    }
    const cost = price(answer.usage);
    // Added up for every device; the notes never wait on it for long (it keeps the cost owed here if it can't write it).
    await within(count(cost), waits.look, null).catch(() => {});
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

  /* The free Gemini key row, the AI card's first: paste a free Google key, on any device (on the PC with Jarvis too,
     1.8.2: only Claude's paid key stays with Jarvis). Every state has .ai-gemini-row (setUp finds it there). */
  function geminiKeyLine(ui) {
    const row = (el) => { el.classList.add('ai-gemini-row'); return el; };
    if (!known) {
      if (!looking) check().catch(() => {});  // Settings is drawn again when it knows ('ai')
      return row(ui.line('Gemini key (free)', 'Checking...', null));  // (its box would be drawn again under the typing)
    }
    if ((known.failed && !known.gemini) || known.gemini === null) {  // (null: the cloud didn't say in time)
      return row(ui.line('Gemini key (free)', 'Couldn\'t check just now (are you online?).', V.button('Check again', {
        onClick: () => { known = null; ui.draw(); } })));
    }
    // No key, as the last look found: looked at again now and then (a key set up on another device since shows).
    if (!known.gemini) recheck();  // (its answer draws Settings again: the 'ai' event)
    if (known.gemini) {
      const ready = V.h('span.ai-ready', {}, V.icon('check'), V.h('span', { text: 'Set up' }));
      const remove = V.button('Remove', { kind: 'danger-quiet', onClick: async () => {
        const sure = await V.confirm('Remove the Gemini key?', 'Chat and the note-taker stop working on all your devices until '
          + 'it\'s set up again.', { ok: 'Remove', danger: true });
        if (!sure) return;
        try { await removeGeminiKey(); V.toast('Gemini key removed.'); } catch (error) { V.problem(error); }
        ui.draw();
      } });
      return row(ui.line('Gemini key (free)', claudeOn()
        ? (notesClaude()
          ? 'Kept in your own cloud, never shown. New chats start on Gemini; Claude writes your notes.'
          : 'Kept in your own cloud, never shown. New chats start on Gemini, and it writes your notes, for free.')
        : 'Kept in your own cloud, never shown. Chat and the note-taker use it, for free.',
      V.h('div.setting-buttons', {}, ready, remove)));
    }
    const box = V.h('input.field', { type: 'password', placeholder: 'Paste the key from AI Studio', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Gemini API key' });
    const save = V.button('Save', { kind: 'primary', onClick: async () => {
      save.disabled = true;
      save.lastChild.textContent = 'Checking…';  // (with Google: a few seconds at most)
      try {
        const saved = await saveGeminiKey(box.value);
        box.value = '';
        V.toast(saved.checked ? 'Gemini key checked with Google and saved — it\'s free to use.'
          : saved.why === 'bad' ? `Gemini key saved, but Google's check said: ${saved.said}`
          : `Gemini key saved. ${saved.why === 'busy' ? 'Google was too busy to check it just now'
            : saved.why === 'slow' ? 'Google didn\'t answer in time to check it'
            : 'Google couldn\'t be reached from this network to check it'}, so it's checked the first time Vault uses it.`,
        { ms: saved.why === 'bad' ? 9000 : 6000 });
        ui.draw();
      } catch (error) {
        V.toast(error.message || String(error), { kind: 'err', ms: 9000 });  // (long enough to read Google's reason)
      } finally {
        save.disabled = false;
        save.lastChild.textContent = 'Save';
      }
    } });
    box.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); });
    const open = () => window.open(GEMINI_CONSOLE, '_blank', 'noopener');
    return row(V.h('div.ai-key.ai-key-gemini', {},
      ui.line('Gemini key (free)', 'Chat and the note-taker use Google\'s free Gemini. It needs a free key from Google '
        + '(new ones start with AQ.): Vault checks it with Google, then keeps it in your own cloud, never shown.', null),
      V.h('ol.steps.ai-steps', {},
        V.h('li', { text: 'Tap "Get a free key" and sign in with your Google account.' }),
        V.h('li', { text: 'Tap "Create API key", then copy the key.' }),
        V.h('li', { text: 'Paste it here and tap Save.' })),
      V.h('div.ai-key-row', {}, box, save),
      V.h('button.link-btn.ai-console', { type: 'button', text: 'Get a free key at aistudio.google.com', onclick: open }),
      V.h('p.hint.ai-school', { text: 'Like any AI, it won\'t work on school wifi: use mobile data, or let your messages '
        + 'wait and go when you\'re home.' })));
  }

  /* One of the AI card's switches for every device (`name` its label, `cls` its row's class): `set(want)` writes it
     (V.cloud.changeExtra, given a time limit there); while that's under way the switch waits, and if it can't be
     written it goes back and says so. */
  function accountSwitch(ui, { name, hint, cls, on, set, said }) {
    const box = V.h('input.switch', { type: 'checkbox', checked: on, 'aria-label': name, onchange: async () => {
      const want = box.checked;
      box.disabled = true;
      try {
        await set(want);
        V.toast(said(want), { ms: 5000 });
      } catch (error) {
        box.checked = !want;
        V.problem(error);
      } finally {
        box.disabled = false;
      }
      ui.draw();
    } });
    const line = ui.line(name, hint, box);
    line.classList.add(cls);
    return line;
  }

  /* "Use Claude too": the switch (for every device), with what it means. */
  function claudeSwitch(ui) {
    return accountSwitch(ui, { name: 'Use Claude too', cls: 'ai-claude-switch', on: claudeOn(), set: setClaude,
      hint: 'Paid, with your own Claude key. When it\'s off, Gemini does everything.',
      said: (want) => (!want ? 'Claude is off. Gemini does everything now.'
        : notesClaude() ? 'Claude is on: pick it in Chat. It writes your notes too, when its key is set up.'
          : has('gemini') ? 'Claude is on: pick it in Chat. Gemini still writes your notes (free).'
            : 'Claude is on: pick it in Chat. It writes your notes too until the free Gemini is set up.') });
  }

  /* "Write notes with Claude", under "Use Claude too" while it's on (for every device too). */
  function notesSwitch(ui) {
    return accountSwitch(ui, { name: 'Write notes with Claude', cls: 'ai-notes-switch', on: notesClaude(),
      set: setNotesClaude,
      hint: 'The note-taker\'s notes. When it\'s off, Gemini writes them for free (Claude only when there\'s no Gemini key).',
      said: (want) => (want ? 'Claude writes your notes now, when its key is set up.'
        : 'Gemini writes your notes now, for free.') });
  }

  /* "Set up free Gemini" (the Chat tab, the note-taker): Settings > AI, at the Gemini key's row (its box ready for the
     key where there's a keyboard), or (`what` 'claude') at "Use Claude too". */
  function setUp(what = 'gemini') {
    V.go('settings');
    const card = [...document.querySelectorAll('.settings-card')].find((c) => (c.querySelector('h2') || {}).textContent === 'AI');
    if (!card) return;
    const spot = card.querySelector(what === 'claude' ? '.ai-claude-switch' : '.ai-gemini-row') || card;
    spot.scrollIntoView({ block: 'center' });
    const box = what === 'gemini' ? spot.querySelector('input[type=password]') : null;
    if (box && V.device !== 'phone') box.focus({ preventScroll: true });
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
    // "Check Gemini" (with a Gemini key): how quickly each Gemini model answers from here, a line each.
    let geminiRow = null;
    if (has('gemini')) {
      const hint = V.h('span.ai-check.ai-gemini-hint', { role: 'status', text: 'See how fast Gemini answers here (free).' });
      const net = V.h('p.ai-gemini-net', { hidden: true });
      const times = V.h('ul.ai-gemini-times', { hidden: true });
      const lead = V.h('p.ai-gemini-first', { hidden: true });
      const timeBtn = V.button('Check Gemini', { onClick: async () => {
        timeBtn.disabled = true;
        hint.dataset.state = '';
        hint.textContent = 'Checking… (a few seconds)';
        net.hidden = true;
        times.hidden = true;
        lead.hidden = true;
        try {
          const found = await checkGemini();
          const fine = found.models.some((r) => r.ok);
          hint.dataset.state = fine ? 'reachable' : 'blocked';
          hint.textContent = fine ? 'Gemini works ✓' : 'Gemini didn\'t answer from here.';
          net.dataset.ok = found.network.ok ? 'yes' : 'no';
          net.textContent = networkLine(found.network);
          V.clear(times, found.models.map((r) => V.h('li', { dataset: { ok: r.ok ? 'yes' : 'no' }, text: timingLine(r) })));
          lead.textContent = firstLine(found);
          net.hidden = false;
          times.hidden = false;
          lead.hidden = !fine;
        } catch (error) {
          hint.dataset.state = 'blocked';
          hint.textContent = error.message || String(error);
        } finally {
          timeBtn.disabled = false;
        }
      } });
      geminiRow = V.h('div.ai-gemini-check', {},
        V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Gemini speed' }), hint), timeBtn), net, times,
        lead);
    }
    // Gemini first (the main thing), then "Use Claude too"; Claude's key, its check and the month's spending (the
    // monthly limit is Claude's alone) only while it's on.
    const on = claudeOn();
    return ui.card('AI',
      geminiKeyLine(ui),
      geminiRow,
      claudeSwitch(ui),
      on ? notesSwitch(ui) : null,
      on ? keyLine(ui) : null,
      on ? V.h('div.setting', {}, V.h('div.setting-text', {}, V.h('strong', { text: 'Reach Claude' }), check), checkBtn) : null,
      on ? ui.line(`This month (${monthName()})`, spent, limit) : null,
      V.h('p.hint.ai-privacy', { text: on
        ? 'Gemini (by Google) and Claude (by Anthropic) only read what you send them: a transcript when you make notes, and '
          + 'your messages in the Chat tab. Neither hears the sound itself. Gemini is free, so it isn\'t counted here.'
        : 'Gemini (by Google) only reads what you send it: a transcript when you make notes, and your messages in the Chat '
          + 'tab. It never hears the sound itself, and it\'s free.' }));
  }

  // Both keys go with the person: the next one to sign in on this device (a friend, say) never uses them.
  // (and this person's list of Gemini models: the next one's key may be offered others; the timings are this device's)
  // 'signing-out': Settings' Sign out (V.cloud.signOut, then a reload); 'signed-out': the cloud said the sign-in ended.
  const forgetPerson = () => {
    key = null; geminiKey = null; known = null; seenOn = null; seenNotes = null; mode += 1; triedAt = 0; lateListing = null;
    forgetList();
  };
  V.on('signing-out', forgetPerson);
  V.on('signed-out', forgetPerson);

  return { ask, price, rates, money, tally, count, overLimit, headers, forgetKey, check, reachable, card, getKey, saveKey,
    removeKey, callGemini, checkGemini, timingLine, networkLine, getGeminiKey, saveGeminiKey, removeGeminiKey,
    forgetGeminiKey, AiError, WORDS, PRICES, THINKING, THINKING_2,
    // How quickly each Gemini model starts answering here, and the others this key may use (tests, Settings).
    speed: { order: (use = 'chat') => ranked(use), headFor, typical, extras, failing, forget: forgetSpeed,
      record: () => JSON.parse(JSON.stringify(record())), forgetList },
    state: () => known, ready: () => has(brain()),  // (the brain the note-taker would use is set up here)
    has, brain, claudeOn, notesClaude, modeKnown, modeReady, setClaude, setNotesClaude, setUp, recheck, lacksGemini,
    geminiKnown, keysSettled,
    MODEL, API, API_VERSION, GEMINI_MODEL, GEMINI_MODELS, waits };  // (waits: tests shorten them)
})();
