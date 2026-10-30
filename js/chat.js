/* Vault: the Chat tab (called the Claude tab until 1.8.3; its id stays 'claude', so old links and kept places still
   work). Chats with Google's free Gemini, and with Claude too once it's switched on (Settings > AI, "Use Claude too",
   js/ai.js): a list of them (newest first) and one open chat, with the model picked per chat (Gemini Fast unless the
   owner picks Gemini Smart or another), "Think harder" and "Search the web" switches (Claude's), notes and files to
   ask about, and answers that can be saved as notes. While Claude is off only Gemini is offered, and a chat that was
   on a Claude model goes on with Gemini (useNow, modelFor): its earlier answers stay as they came, nothing is ever
   sent to Claude, and its own model is kept for when Claude is switched on again.

   Gemini's requests go straight from this device to Google (js/ai.js callGemini). Claude's go straight from this
   device to Claude (api.anthropic.com) with the owner's own key (js/ai.js: the key,
   the prices and the monthly tally and limit are shared with the note-taker). On the PC the page builds the same
   request and Python sends it (vault/claudechat.py, the chatSend bridge call), so the key never enters the page there;
   the reply streams back as events either way and shows as it comes. Nothing goes any other way: a network that
   blocks Claude gets a plain line saying so, with the message kept.

   The history is append-only, as Claude needs it: every answer's content blocks (its thinking included, with their
   signatures) are kept exactly as they came and sent back unchanged, earlier turns are never edited, and Retry only
   redoes the last answer. A chat's system prompt is frozen when it starts. A turn that was stopped, refused or broke
   is shown but never sent again (so nothing after it depends on it).

   Each chat is kept in the owner's private file storage, <owner>/chats/<id>.json (read when the tab opens, saved
   after each answer), with this device's copy in V.db so the list shows at once and offline. Files attached to a
   message go to <owner>/chats/<id>/files/, and the chat keeps only where they are: they're fetched again when a later
   message sends the history. */
'use strict';

V.chat = (() => {
  // The Gemini choice's id in a chat, kept from 1.7 so an older Vault on another device still reads such a chat as
  // Gemini (to it, anything else is Claude). It names no model any more: ai.js picks Google's newest itself. Since 1.11
  // it's "Gemini Fast" (the quickest model here), and GEMINI_SMART "Gemini Smart" (Flash first). A Vault 1.8.0 reads
  // any id but 'gemini-2.5-flash' as Claude; every page updates itself at start, and 1.8.1 and later treat any
  // 'gemini...' id as their Gemini, so a Smart chat opened on an older page just answers with that page's Gemini.
  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_SMART = 'gemini-smart';
  const MODELS = [
    { id: 'claude-haiku-5-5', provider: 'claude', name: 'Claude Haiku 5.5', short: 'Haiku 5.5', about: 'Quick and cheap. Good for most questions.',
      search: 'web_search_20250305', fallback: false },
    { id: 'claude-sonnet-5-5', provider: 'claude', name: 'Claude Sonnet 5.5', short: 'Sonnet 5.5', about: 'Smarter, for harder homework and longer writing.',
      search: 'web_search_20260209', fallback: true },
    { id: 'claude-opus-5-5', provider: 'claude', name: 'Claude Opus 5.5', short: 'Opus 5.5', about: 'The smartest everyday model.',
      search: 'web_search_20260209', fallback: true },
    { id: 'claude-fable-5-1', provider: 'claude', name: 'Claude Fable 5.1', short: 'Fable 5.1', about: 'The most capable, and expensive: keep it for the hardest things.',
      search: 'web_search_20260209', fallback: true },
    // Gemini (Google), free: Chat's own models (the only ones while Claude is off). Add a free key in Settings > AI.
    // Text and pictures; no "Think" or web search here. Like Claude, it needs a network that isn't a school's filter
    // (use mobile data). `tier` goes to js/ai.js, which picks the model. (any other "gemini..." id is Gemini Fast too)
    { id: GEMINI_MODEL, provider: 'gemini', tier: 'fast', name: 'Gemini Fast (free)', short: 'Gemini Fast', free: true,
      about: 'The quickest Gemini right now (usually Flash-Lite: about a second to start). Free.' },
    { id: GEMINI_SMART, provider: 'gemini', tier: 'smart', name: 'Gemini Smart (free)', short: 'Gemini Smart', free: true,
      about: 'Google\'s bigger Flash: better for hard homework and long writing, but slower to start and busy more often. Free.' },
  ];
  const CLAUDE_MODEL = MODELS[0].id;  // (MODELS[0] stays Claude's: an id nobody knows is read as a Claude model)
  const geminiId = (id) => /^gemini/.test(String(id || ''));
  const isGemini = (id) => modelOf(id).provider === 'gemini';
  /* The model that answers for `model` now: itself, or Gemini while Claude is switched off. Claude being off never
     rewrites a chat's or a message's own model: the chat goes back to the Claude model picked for it once Claude is on
     again, and a message waiting for Claude takes Gemini's name only once Gemini has answered it (answer). */
  const useNow = (model) => (isGemini(model) || V.ai.claudeOn() ? model : GEMINI_MODEL);
  /* The model a chat uses now (a chat started on a Claude model goes on with Gemini while Claude is off). */
  const modelFor = (chat) => useNow((chat && chat.model) || GEMINI_MODEL);
  /* A PC whose Jarvis is too old for Claude chats (no chatSend): a Gemini chat still works there, from the page. */
  const tooOld = (chat) => V.desktop && !V.pc.can('chatSend') && !isGemini(modelFor(chat));
  /* A new chat starts on Gemini; with Claude switched on and its key there, only when the Gemini key is known to be set
     up: one the key check couldn't tell about (the PC's cloud listing came too late) may not be, and a first message
     to a Gemini with no key only bounces ("set up Gemini"), so that's Claude until the answer comes (retarget). */
  const defaultModel = () => (V.ai.claudeOn() && V.ai.has('claude') && !V.ai.has('gemini')
    && (!V.desktop || V.pc.can('chatSend')) ? CLAUDE_MODEL : GEMINI_MODEL);  // (an older Jarvis can't chat with Claude)
  /* Whether the default still hangs on a Gemini key the key check couldn't tell about. */
  const defaultUnsure = () => V.ai.claudeOn() && V.ai.has('claude') && !V.ai.geminiKnown();
  /* A message that Gemini would answer (always, while Claude is off) when Gemini isn't set up here, as the key check
     knows: it waits for the free key rather than failing for the lack of it. That answer is looked at again before a
     message is held for it (V.ai.recheck): a key set up on another device since lets it go. */
  const needsGemini = (turn) => isGemini(useNow(turn.model)) && V.ai.lacksGemini();
  /* A message that would go to Gemini only because Claude seems to be off, before this device has read the settings
     from the cloud: a new device knows nothing yet, so it isn't sent by itself until it does. */
  const unsure = (turn) => !isGemini(turn.model) && !V.ai.claudeOn() && !V.ai.modeKnown();
  const SETTLE_MS = 5000;  // a send (or Retry) waits this long at most for a new device to read "Use Claude too"
  const SYSTEM = [
    'You are a helpful AI assistant built into Vault, the owner\'s own notes app, which they use for school and for everything else. They are a student.',
    'Keep answers clear, friendly and no longer than they need to be. Use Markdown: short paragraphs, lists, **bold** for the key words, headings for long answers, and code blocks for code.',
    'They can save any answer as a note, so make answers worth keeping.',
    'When they share a note it comes inside <note> tags, and a text file inside <file> tags: help with what is in it.',
  ].join('\n\n');
  const MAX_TOKENS = 16000;            // room for the thinking and the answer...
  const MAX_TOKENS_THINKING = 32000;   // ...and more with "Think harder"
  const MOST_REPLIES = 4;              // a turn paused by web search is carried on 3 times at most
  const SEARCHES = 5;                  // web searches an answer may make (a cent each)
  const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
  const SENT = new Set(['done', 'cut']);  // turns sent again as the history
  const WAIT_KINDS = new Set(['offline', 'away', 'busy']);  // a blocked or flaky network: the turn waits and goes later
  const CLAIM_MS = 120000;   // a turn another device marked 'answering' is left to it this long, then taken as abandoned
  const PUMP_EVERY = 60000;  // while a message is waiting to send, try it again at least this often
  // A Gemini message held because Gemini was busy, slow or over its free per-minute limit (Google answered: the
  // network works) goes again sooner than the minute: after `busy` ms (`quota` for the limit, `big` for a chat whose
  // earlier pictures were slow to go up: it sends them all again), doubling each time it still can't, up to `most`.
  // Gemini is free, so trying again costs nothing. (Tests shorten them.)
  const retryWaits = { busy: 8000, quota: 30000, big: 30000, most: 60000 };
  // Files: pictures scaled down to Claude's own size (1568 px on the long side: more only costs more), PDFs up to
  // what one request takes (32 MB, 600 pages), text read as text.
  const IMAGE_EDGE = 1568;
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const PDF_MOST = 20 * 1000 * 1000;
  const PAGES_MOST = 600;
  const PAGE_TOKENS = 3000;            // about what a PDF page costs (its words and its picture)
  const TEXT_MOST = 1000 * 1000;
  const FILES_MOST = 22 * 1000 * 1000; // the files one chat sends with each message (base64 makes them a third bigger)
  const TEXT_ENDINGS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'py', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'html', 'htm',
    'css', 'xml', 'yaml', 'yml', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql',
    'ini', 'toml', 'log', 'tex', 'r', 'swift', 'kt', 'lua', 'srt'];
  const ACCEPT = [...IMAGE_TYPES, 'application/pdf', '.pdf', 'text/*', ...TEXT_ENDINGS.map((e) => '.' + e)].join(',');
  const NOT_READABLE = 'This kind of file can\'t be read here. Save it as a PDF first, then attach it.';
  const enterSends = V.device !== 'phone';  // a keyboard: Enter sends, Shift+Enter is a new line
  const ASK_LABEL = 'Ask Chat about it';     // a note's menu item that brings it here (js/editor.js shows it)

  let chats = null;      // id -> chat, this device's copy (V.db meta 'chat:<id>')
  let index = null;      // { prints: id -> the cloud file's fingerprint, waiting: ids not up yet }
  let loading = null;
  let refreshing = null;
  const unsent = new Map();  // id -> a chat started here that has no messages yet
  const picked = new Set();  // chats whose model was picked by hand (never moved to Gemini by retarget)
  const defaulted = new Set();  // chats started here on the default model (newChat): only these follow the default
  const drafts = new Map();  // chat id -> { text, notes, files }: what's in the box
  let openId = null;
  let showingChat = false;   // a phone shows the list or one chat
  let auto = false;          // the chat open is a new one opened because there were none
  let busy = null;           // the answer coming now: { chatId, turn, controller, pcId, stopped }
  let sendingId = null;      // the chat whose message send() is getting ready to go (before its answer starts)
  const sendingTurns = new Set();  // waiting turns being sent now (sendWaiting): each goes once, however it was asked
  let pumpTimer = null;      // the gentle retry while a message is waiting to send
  let pumping = false;
  let trouble = null;        // { chatId, kind, message }: the line above the box
  let root = null;
  let parts = null;
  const pictures = new Map(); // path -> object URL of a picture shown
  const listeners = new Map(); // the PC's answers: request id -> its events
  const sentNotes = new WeakMap(); // a message being sent -> its notes with their words (back in the box if it can't go)
  let shown = '';              // the chat drawn last, and how far it had got (a new answer scrolls to the end)

  const owner = () => (V.data.user && V.data.user.id) || '';
  const dir = () => `${owner()}/chats`;
  const fileOf = (id) => `${dir()}/${id}.json`;
  const filesDir = (id) => `${dir()}/${id}/files`;
  const modelOf = (id) => MODELS.find((m) => m.id === id)
    || (geminiId(id) ? MODELS.find((m) => m.id === GEMINI_MODEL) : null) || MODELS[0];
  /* "Haiku 5.5"; a model the API answered with instead ("claude-opus-4-8") as "Opus 4.8"; "Gemini Smart", and any
     other Gemini as "Gemini Fast". */
  const nameOf = (id) => {
    const known = MODELS.find((m) => m.id === id);
    if (known) return known.short;
    if (geminiId(id)) return modelOf(id).short;
    const [family, ...version] = String(id || 'Claude').replace(/^claude-/, '').split('-');
    return [family.charAt(0).toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ');
  };
  const now = () => new Date().toISOString();
  const valid = (chat) => !!chat && typeof chat === 'object' && typeof chat.id === 'string' && Array.isArray(chat.turns);

  class ChatError extends Error {
    constructor(kind, message, why = '') {
      super(message);
      this.kind = kind;
      this.why = why || kind;  // what held it up, for the waiting line: offline, away, busy, slow or quota
    }
  }

  const WORDS = {
    setup: 'Chat uses Google\'s free Gemini. Add a free key once: it only takes a minute.',
    needsGemini: 'Set up the free Gemini first (Settings > AI). Your message waits till then.',
    offline: 'Claude can\'t be reached from this network. Your message is kept: try again, or send it from another network.',
    away: 'You\'re offline. Your message is kept: try again when you\'re back online.',
    key: 'Claude didn\'t accept the key. Set it up again in Settings > AI.',
    nokey: 'Set up Claude first: Settings > AI.',
    credit: 'Your Claude account is out of credit. Add some at console.anthropic.com, then try again.',
    busy: 'Claude is busy right now. Your message is kept: try again in a minute.',
    dropped: 'The connection dropped before the answer finished.',
    cutOff: 'The answer stopped coming part-way. Tap Try again to ask again.',
    old: 'Update Jarvis to chat on this PC (open Jarvis and click Update). Your chats are on your phone and Chromebook too.',
  };

  /* ---------------------------------------------------------------- this device's copy, and the cloud's */

  function load() {
    if (chats) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const kept = (await V.db.meta('chats').catch(() => null)) || {};
        const map = new Map();
        for (const id of kept.ids || []) {
          const chat = await V.db.meta('chat:' + id).catch(() => null);
          if (valid(chat)) map.set(id, chat);
        }
        index = { prints: kept.prints || {}, waiting: new Set(kept.waiting || []), gone: new Set(kept.gone || []) };
        chats = map;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  const keepIndex = () => V.db.meta('chats', { ids: [...chats.keys()], prints: index.prints, waiting: [...index.waiting],
    gone: [...index.gone] });

  async function listed(search) {
    const { data, error } = await V.cloud.sb.storage.from('vault').list(dir(), { limit: 1000, search,
      sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    return (data || []).filter((f) => f.id && /\.json$/.test(f.name));
  }
  const printOf = (f) => [f.updated_at || '', (f.metadata || {}).size || '', (f.metadata || {}).eTag || ''].join('|');

  async function download(id) {
    const { data, error } = await V.cloud.sb.storage.from('vault').download(fileOf(id));
    if (error || !data) return null;
    try {
      const chat = JSON.parse(await data.text());
      return valid(chat) && chat.id === id ? chat : null;
    } catch (e) {
      return null;
    }
  }

  async function upload(chat) {
    await V.cloud.upload(fileOf(chat.id), new Blob([JSON.stringify(chat)], { type: 'application/json' }), { mime: 'application/json' });
    index.waiting.delete(chat.id);
    const mine = (await listed(chat.id).catch(() => [])).find((f) => f.name === chat.id + '.json');
    index.prints[chat.id] = mine ? printOf(mine) : '';
    await keepIndex();
  }

  /* A chat saved here, then up to the cloud (later, at the next look, when it can't go now). */
  async function persist(chat) {
    chats.set(chat.id, chat);
    unsent.delete(chat.id);
    defaulted.delete(chat.id);  // (in the cloud now, where another device may choose its model)
    index.gone.delete(chat.id);  // (sent again after its only message was cancelled: it's back)
    index.waiting.add(chat.id);
    await V.db.meta('chat:' + chat.id, chat);
    await keepIndex();
    try { await upload(chat); } catch (error) { /* it waits here and goes up next time */ }
  }

  /* The cloud's chats brought in: new and changed ones fetched, ones deleted elsewhere let go, and this device's
     waiting ones sent up. */
  async function refresh() {
    await load();
    if (!V.cloud.sb || !owner()) return;
    if (!refreshing) {
      refreshing = (async () => {
        const files = await listed();
        const seen = new Set();
        let changed = false;
        for (const f of files) {
          const id = f.name.slice(0, -5);
          seen.add(id);
          const print = printOf(f);
          if (index.gone.has(id)) {
            // Its only message was cancelled here: taken out of the cloud below, unless another device has changed it
            // since this one last saw it (answered the message, say): then theirs is kept, and fetched like any other.
            if (print === index.prints[id]) continue;
            index.gone.delete(id);
            unsent.delete(id);
          }
          if ((index.prints[id] === print && chats.has(id)) || index.waiting.has(id) || (busy && busy.chatId === id)) continue;
          const theirs = await download(id);
          if (!theirs) continue;
          const mine = chats.get(id);
          if (!mine || (theirs.updated || '') >= (mine.updated || '')) {
            chats.set(id, theirs);
            await V.db.meta('chat:' + id, theirs);
            changed = true;
          }
          index.prints[id] = print;
        }
        for (const id of [...chats.keys()]) {
          if (seen.has(id) || index.waiting.has(id) || !index.prints[id] || (busy && busy.chatId === id)) continue;
          chats.delete(id);  // deleted on another device
          delete index.prints[id];
          await V.db.meta('chat:' + id, null);
          changed = true;
        }
        await keepIndex();
        for (const id of [...index.gone]) {
          if (!seen.has(id)) { index.gone.delete(id); continue; }
          await takeOut(id).catch(() => {});
        }
        for (const id of [...index.waiting]) {
          const chat = chats.get(id);
          if (!chat) { index.waiting.delete(id); continue; }
          await upload(chat).catch(() => {});
        }
        await keepIndex();
        if (changed) draw();
        reflect();  // a waiting turn may have arrived from (or gone on) another device
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  /* A chat whose only message was cancelled here (it's back in the box, never sent): taken out of the cloud, so no
     device (this one's next look included) brings the waiting message back or sends it. Its files stay: the box has
     them again. Until it's out (offline), `index.gone` remembers it and the next look tries again. Only the version
     this device last saw is taken out: one another device has changed since (it answered the message, maybe paid for)
     is left, and the next look brings it here instead. */
  async function takeOut(id) {
    const there = (await listed(id)).find((f) => f.name === id + '.json');
    if (there && printOf(there) !== index.prints[id]) {
      if (index.gone.delete(id)) await keepIndex();
      return;
    }
    if (there) await V.cloud.remove([fileOf(id)]);
    if (!index.gone.has(id)) return;  // (sent again meanwhile)
    index.gone.delete(id);
    delete index.prints[id];
    await keepIndex();
  }

  /* A refresh, but never waiting long for it (a slow network shouldn't hold a message up). */
  const quickRefresh = () => Promise.race([refresh().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);

  async function removeChat(id) {
    if (busy && busy.chatId === id) stop();
    const inside = await V.cloud.sb.storage.from('vault').list(filesDir(id), { limit: 1000 });
    const paths = [fileOf(id), ...((inside.data || []).filter((f) => f.id).map((f) => `${filesDir(id)}/${f.name}`))];
    await V.cloud.remove(paths);
    chats.delete(id);
    unsent.delete(id);
    drafts.delete(id);
    delete index.prints[id];
    index.waiting.delete(id);
    await V.db.meta('chat:' + id, null);
    await keepIndex();
  }

  const listOf = () => [...(chats || new Map()).values()].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

  function newChat() {
    const chat = { format: 1, id: V.uuid(), title: '', created: now(), updated: now(), model: defaultModel(), think: false,
      search: false, system: SYSTEM, turns: [] };
    unsent.set(chat.id, chat);
    defaulted.add(chat.id);
    return chat;
  }
  const chatOf = (id) => (chats && chats.get(id)) || unsent.get(id) || null;
  const draftOf = (id) => {
    if (!drafts.has(id)) drafts.set(id, { text: '', notes: [], files: [] });
    return drafts.get(id);
  };

  /* ---------------------------------------------------------------- files */

  const ending = (name) => ((/\.([a-z0-9]{1,10})$/i.exec(name || '') || [])[1] || '').toLowerCase();

  function kindOf(file) {
    const type = (file.type || '').toLowerCase();
    if (IMAGE_TYPES.includes(type) || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ending(file.name))) return 'image';
    if (type === 'application/pdf' || ending(file.name) === 'pdf') return 'pdf';
    if ((type.startsWith('text/') && type !== 'text/rtf') || type === 'application/json' || TEXT_ENDINGS.includes(ending(file.name))) return 'text';
    return null;
  }

  /* A picture at Claude's own size (and never bigger than it came): JPEG, or PNG for a small PNG (a screenshot's words
     stay sharp). { blob, mime, w, h }. */
  async function shrink(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      throw new ChatError('file', `${file.name || 'That picture'} couldn't be opened.`);
    }
    const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const keepPng = file.type === 'image/png' && file.size < 2 * 1000 * 1000;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!keepPng) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }  // a see-through picture on white
    g.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    const mime = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.86));
    if (!blob) throw new ChatError('file', `${file.name || 'That picture'} couldn't be opened.`);
    return { blob, mime, w, h };
  }

  /* A PDF's page count, from the "/Type /Page" objects in it (a rough count: 0 when they're packed away). */
  async function pagesOf(blob) {
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
    return (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  }

  /* A file picked, dropped or pasted, ready to go up: { kind, name, mime, blob, w, h, pages, tokens }. */
  async function prepare(file) {
    const name = String(file.name || 'file').slice(0, 120);
    const kind = kindOf(file);
    if (!kind) throw new ChatError('file', `${name}: ${NOT_READABLE}`);
    if (kind === 'image') {
      const small = await shrink(file);
      const base = name.replace(/\.[a-z0-9]{1,10}$/i, '');
      return { kind, name: `${base}.${small.mime === 'image/png' ? 'png' : 'jpg'}`, mime: small.mime, blob: small.blob,
        w: small.w, h: small.h, tokens: Math.ceil(small.w / 28) * Math.ceil(small.h / 28) };
    }
    if (kind === 'pdf') {
      if (file.size > PDF_MOST) throw new ChatError('file', `${name} is too big to send (20 MB at most for a PDF).`);
      const pages = await pagesOf(file);
      if (pages > PAGES_MOST) throw new ChatError('file', `${name} has ${pages} pages: ${PAGES_MOST} is the most that can be read.`);
      return { kind, name, mime: 'application/pdf', blob: file, pages, tokens: Math.max(1, pages || Math.ceil(file.size / 100000)) * PAGE_TOKENS };
    }
    if (file.size > TEXT_MOST) throw new ChatError('file', `${name} is too long to send as text (1 MB at most).`);
    const text = await file.text();
    if (text.includes('\u0000')) throw new ChatError('file', `${name}: ${NOT_READABLE}`);
    return { kind, name, mime: 'text/plain', blob: new Blob([text], { type: 'text/plain' }), tokens: Math.ceil(text.length / 3.5) };
  }

  /* The files a message to this chat would send again (every sent turn's), in bytes. */
  const filesSent = (chat) => (chat ? chat.turns : []).filter((t) => SENT.has(t.state))
    .reduce((sum, t) => sum + (t.files || []).reduce((s, f) => s + (f.size || 0), 0), 0);

  /* Files into the box of the chat open now: each made ready and sent up to the cloud straight away. */
  async function attach(list) {
    const id = openId;
    const chat = chatOf(id);
    if (!id || !chat) return;
    const draft = draftOf(id);
    for (const file of [...list]) {
      let ready;
      try {
        ready = await prepare(file);
      } catch (error) {
        V.toast(error.message, { kind: 'err', ms: 6000 });
        continue;
      }
      const waiting = draft.files.reduce((s, f) => s + (f.size || 0), 0);
      if (filesSent(chat) + waiting + ready.blob.size > FILES_MOST) {
        V.toast('That\'s more files than one message can carry. Start a new chat for this one.', { kind: 'err', ms: 6000 });
        continue;
      }
      const item = { id: V.uuid().slice(0, 8), kind: ready.kind, name: ready.name, mime: ready.mime, size: ready.blob.size,
        w: ready.w, h: ready.h, pages: ready.pages, tokens: ready.tokens, state: 'up' };
      item.path = `${filesDir(id)}/${item.id}-${V.storageName(item.name)}`;
      if (ready.kind === 'image') { item.url = URL.createObjectURL(ready.blob); pictures.set(item.path, item.url); }
      draft.files.push(item);
      drawBox();
      try {
        await V.cloud.upload(item.path, ready.blob, { mime: ready.mime });
        if (ready.blob.size < 6 * 1024 * 1024) await V.db.put('files', { key: item.path, blob: ready.blob, at: Date.now() });
        item.state = 'ready';
      } catch (error) {
        draft.files = draft.files.filter((f) => f !== item);
        V.toast(`${item.name} didn't go up: ${error.message || 'no internet'}`, { kind: 'err', ms: 6000 });
      }
      if (openId === id) drawBox();
    }
  }

  function unattach(item) {
    const draft = draftOf(openId);
    draft.files = draft.files.filter((f) => f !== item);
    if (item.state === 'ready') V.cloud.remove([item.path]).catch(() => {});
    drawBox();
  }

  async function blobOf(f) {
    try {
      if (f.size < 6 * 1024 * 1024) return await V.cloud.blob(f.path);
      const response = await fetch(await V.cloud.link(f.path));
      if (!response.ok) throw new Error(String(response.status));
      return await response.blob();
    } catch (error) {
      throw new ChatError('files', `${f.name} couldn't be fetched from your cloud (are you online?).`);
    }
  }

  const base64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  /* A file as Claude takes it. On the PC pictures and PDFs are named by path, and Python puts them in. */
  async function fileBlock(f, pc) {
    if (f.kind === 'text') return { type: 'text', text: `<file name="${f.name}">\n${await (await blobOf(f)).text()}\n</file>` };
    const source = pc ? { type: 'vault_file', path: f.path, media_type: f.mime }
      : { type: 'base64', media_type: f.mime, data: await base64(await blobOf(f)) };
    return f.kind === 'pdf' ? { type: 'document', source, title: f.name } : { type: 'image', source };
  }

  /* What a PDF costs a message, roughly, on `model` (it's sent again with every message). */
  function pdfHint(f, model) {
    if (isGemini(model)) return `A ${f.pages ? `${f.pages}-page ` : ''}PDF is free on Gemini.`;
    const cost = (f.tokens || 0) * V.ai.rates(model, f.tokens || 0).input / 1e6;
    return `A ${f.pages ? `${f.pages}-page ` : ''}PDF is about ${V.ai.money(cost)} a message on ${nameOf(model)} (less while it's cached).`;
  }

  /* ---------------------------------------------------------------- asking Claude */

  /* An answer coming in, built from its events as the API sends them. */
  const fresh = (model) => ({ content: [], usage: {}, model, stop_reason: null, stop_details: null, error: null });

  function take(reply, event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'message_start') {
      const m = event.message || {};
      reply.model = m.model || reply.model;
      reply.usage = { ...(m.usage || {}) };
      reply.content = Array.isArray(m.content) ? JSON.parse(JSON.stringify(m.content)) : [];
    } else if (event.type === 'content_block_start') {
      const block = JSON.parse(JSON.stringify(event.content_block || {}));
      if (block.type === 'tool_use' || block.type === 'server_tool_use') block._json = '';
      reply.content[event.index] = block;
    } else if (event.type === 'content_block_delta') {
      const block = reply.content[event.index];
      const d = event.delta || {};
      if (!block) return;
      if (d.type === 'text_delta') block.text = (block.text || '') + (d.text || '');
      else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + (d.thinking || '');
      else if (d.type === 'signature_delta') block.signature = d.signature;
      else if (d.type === 'input_json_delta') block._json = (block._json || '') + (d.partial_json || '');
      else if (d.type === 'citations_delta') block.citations = [...(block.citations || []), d.citation];
    } else if (event.type === 'content_block_stop') {
      const block = reply.content[event.index];
      if (block && '_json' in block) {
        try { if (block._json) block.input = JSON.parse(block._json); } catch (error) { /* left as it started */ }
        delete block._json;
      }
    } else if (event.type === 'message_delta') {
      const d = event.delta || {};
      if (d.stop_reason !== undefined) reply.stop_reason = d.stop_reason;
      if (d.stop_details !== undefined) reply.stop_details = d.stop_details;
      for (const [k, v] of Object.entries(event.usage || {})) if (v !== null && v !== undefined) reply.usage[k] = v;
    } else if (event.type === 'error') {
      reply.error = event.error || { type: 'api_error' };
    }
  }

  /* An answer as it's kept: every block as it came (none missing, nothing half-read). */
  const tidy = (content) => content.filter(Boolean).map((block) => {
    const copy = { ...block };
    delete copy._json;
    return copy;
  });

  /* An answer's blocks as they go back in the history. After a server-side fallback, what the declined model wrote
     before the last switch point goes back as its words only (the API's rule for echoing fallback turns). */
  function forHistory(content) {
    let last = -1;
    content.forEach((b, i) => { if (b.type === 'fallback') last = i; });
    if (last < 0) return content;
    const results = new Set(content.filter((b) => /_tool_result$/.test(b.type || '')).map((b) => b.tool_use_id));
    return content.filter((b, i) => i >= last || b.type === 'text' || /_tool_result$/.test(b.type || '')
      || (b.type === 'server_tool_use' && results.has(b.id)));
  }

  const repliesOf = (turn) => (turn.replies || []).map((r) => forHistory(r.content || [])).flat();

  /* A message's own words: the notes it asks about, today's date when it searches, and what was typed. */
  function contentFor(text, notes, search) {
    const content = notes.map((n) => ({ type: 'text', text: `<note title="${String(n.title).replace(/"/g, '\'')}">\n${n.text}\n</note>` }));
    if (search) content.push({ type: 'text', text: `(Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.)` });
    if (text.trim()) content.push({ type: 'text', text });
    return content;
  }

  async function userContent(turn, pc) {
    const files = await Promise.all((turn.files || []).map((f) => fileBlock(f, pc)));
    return [...files, ...turn.content];
  }

  /* ---- the same message, as Gemini's API wants it (text and pictures; no tools) ---- */

  /* One turn's parts for Gemini: its pictures and PDFs inline, text files and the typed words as text. */
  async function geminiParts(turn) {
    const parts = [];
    for (const f of turn.files || []) {
      if (f.kind === 'image' || f.kind === 'pdf') parts.push({ inlineData: { mimeType: f.mime, data: await base64(await blobOf(f)) } });
      else if (f.kind === 'text') parts.push({ text: `<file name="${f.name}">\n${await (await blobOf(f)).text()}\n</file>` });
    }
    for (const b of turn.content || []) if (b && b.type === 'text' && b.text) parts.push({ text: b.text });
    return parts.length ? parts : [{ text: '' }];
  }

  /* The chat so far as Gemini contents: each sent turn (its answer as one text part), then this one. */
  async function geminiContents(chat, turn) {
    const contents = [];
    for (const t of chat.turns) {
      if (t === turn) break;
      const answer = repliesOf(t);
      if (!SENT.has(t.state) || !answer.length) continue;
      contents.push({ role: 'user', parts: await geminiParts(t) });
      const words = answer.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
      contents.push({ role: 'model', parts: [{ text: words || '' }] });
    }
    contents.push({ role: 'user', parts: await geminiParts(turn) });
    return contents;
  }

  /* One Gemini turn by `model` (Gemini Fast or Smart), streamed (`onText` gets the words so far). AiError kinds are
     turned into ChatError kinds so a blocked network waits and sends later, exactly like Claude. */
  async function geminiTurn(chat, turn, job, onText, model) {
    const contents = await geminiContents(chat, turn);
    const maxTokens = turn.think ? MAX_TOKENS_THINKING : MAX_TOKENS;
    try {
      return await V.ai.callGemini({ system: chat.system, contents, maxTokens, signal: job.controller.signal, onText,
        tier: modelOf(model).tier || 'fast' });
    } catch (error) {
      if (job.stopped) return { text: '', stopReason: 'stopped', usage: {} };
      const kind = (error && error.kind) || 'bad';
      const known = { offline: 'offline', away: 'away', busy: 'busy', key: 'key', nokey: 'nokey', bad: 'bad' };
      const why = kind === 'offline' && !navigator.onLine ? 'away' : error && error.why;  // (no internet at all)
      throw new ChatError(known[kind] || 'bad', (error && error.message) || WORDS.dropped, why);
    }
  }

  const toolsFor = (turn) => (turn.search ? [{ type: modelOf(turn.model).search, name: 'web_search', max_uses: SEARCHES }] : []);

  /* The request for `turn`: the chat's sent turns before it, exactly as they were, then this one (and its paused
     answer, when web search paused it). */
  async function requestFor(chat, turn) {
    const pc = V.desktop;
    const m = modelOf(turn.model);
    const tools = toolsFor(turn);
    const toolKey = JSON.stringify(tools);
    const messages = [];
    let drop = false;
    for (const t of chat.turns) {
      if (t === turn) break;
      const answer = repliesOf(t);
      if (!SENT.has(t.state) || !answer.length) continue;
      messages.push({ role: 'user', content: await userContent(t, pc) });
      messages.push({ role: 'assistant', content: answer });
      // A turn made with other tools: its thinking no longer fits, so the API is asked to drop it (not refuse).
      if ((t.tools || '[]') !== toolKey && answer.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) drop = true;
    }
    // The last answer gets a cache mark too, so a long reply (web search's many blocks) never pushes the previous
    // request's cached part out of reach. Only the copy sent is marked.
    const lastAnswer = messages.length ? messages[messages.length - 1].content : null;
    if (lastAnswer && lastAnswer.length && lastAnswer[lastAnswer.length - 1].type === 'text') {
      lastAnswer[lastAnswer.length - 1] = { ...lastAnswer[lastAnswer.length - 1], cache_control: { type: 'ephemeral' } };
      messages[messages.length - 1] = { role: 'assistant', content: lastAnswer };
    }
    messages.push({ role: 'user', content: await userContent(turn, pc) });
    const paused = repliesOf(turn);
    if (paused.length) messages.push({ role: 'assistant', content: paused });
    let maxTokens = turn.think ? MAX_TOKENS_THINKING : MAX_TOKENS;
    const tally = V.ai.tally();
    if (tally.limit > 0) {  // never an answer that could cost much more than what's left this month
      const left = Math.max(0, tally.limit - tally.spent);
      maxTokens = Math.max(1024, Math.min(maxTokens, Math.floor(left / V.ai.rates(m.id).output * 1e6)));
    }
    const body = { model: m.id, max_tokens: maxTokens, stream: true, cache_control: { type: 'ephemeral' }, system: chat.system,
      thinking: drop ? { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } : { type: 'adaptive' },
      output_config: { effort: turn.think ? 'high' : 'low' }, messages };
    if (tools.length) body.tools = tools;
    if (m.fallback) body.fallbacks = 'default';
    const betas = [];
    if (m.fallback) betas.push(FALLBACK_BETA);
    if (drop) betas.push(BINDING_BETA);
    return { body, betas };
  }

  /* Server-sent events, one JSON at a time, from a streamed response. */
  async function readEvents(response, run, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (chunk) => {
      const data = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data) return;
      try { onEvent(JSON.parse(data)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    };
    for (;;) {
      let piece;
      try {
        piece = await reader.read();
      } catch (error) {
        if (run.stopped) return { stopped: true };
        throw new ChatError('dropped', WORDS.dropped);
      }
      if (piece.done) break;
      buffer += decoder.decode(piece.value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop();
      chunks.forEach(handle);
    }
    if (buffer.trim()) handle(buffer);
    return { stopped: run.stopped };
  }

  async function direct(body, betas, run, onEvent) {
    let sending;
    try {
      sending = await V.ai.getKey();
    } catch (error) {
      throw new ChatError('nokey', error.message || WORDS.nokey);
    }
    let response;
    try {
      response = await fetch(V.ai.API, { method: 'POST', headers: V.ai.headers(sending, betas), body: JSON.stringify(body),
        signal: run.controller.signal });
    } catch (error) {  // no internet, or a network that blocks Claude (a school's)
      if (run.stopped) return { stopped: true };
      throw new ChatError(navigator.onLine ? 'offline' : 'away', navigator.onLine ? WORDS.offline : WORDS.away);
    }
    if (!response.ok) {
      let said = '';
      try { said = ((await response.json()).error || {}).message || ''; } catch (error) { /* not JSON */ }
      if (response.status === 401 || response.status === 403) { V.ai.forgetKey(); throw new ChatError('key', WORDS.key); }
      if (response.status === 402) throw new ChatError('credit', WORDS.credit);
      if (response.status === 429 || response.status >= 500) throw new ChatError('busy', WORDS.busy);
      throw new ChatError('bad', `Claude couldn't take that${said ? ` (${said})` : ''}. Your message is kept.`);
    }
    return readEvents(response, run, onEvent);
  }

  V.on('pc:chat-event', ({ id, event }) => { const fn = listeners.get(id); if (fn) fn(event); });

  async function viaPc(body, betas, run, onEvent) {
    if (!V.ai.claudeOn()) throw new ChatError('nokey', V.ai.WORDS.off);  // (Jarvis's key: never while Claude is off)
    if (!V.pc.can('chatSend')) throw new ChatError('old', WORDS.old);
    const id = V.uuid();
    run.pcId = id;
    listeners.set(id, onEvent);
    let answer;
    try {
      answer = await V.pc.call('chatSend', { id, body, betas });
    } catch (error) {
      throw new ChatError('bad', `Claude couldn't take that (${error.message || 'no answer'}). Your message is kept.`);
    } finally {
      listeners.delete(id);
    }
    if (answer.stopped || run.stopped) return { stopped: true };
    if (!answer.ok) {
      const kind = answer.kind || 'bad';
      throw new ChatError(kind, WORDS[kind] || `Claude couldn't take that (${answer.message || 'no answer'}). Your message is kept.`);
    }
    return { stopped: false };
  }

  /* What an answer cost. One that was stopped has no final count of what it wrote: that's guessed from its length. */
  function costOf(reply, requested, cut) {
    const usage = { ...reply.usage };
    if (cut) {
      const written = reply.content.filter(Boolean).reduce((n, b) => n + (b.text || '').length + (b.thinking || '').length, 0);
      usage.output_tokens = Math.max(Number(usage.output_tokens) || 0, Math.ceil(written / 3.5));
    }
    const served = V.ai.PRICES[reply.model] ? reply.model : requested;
    return V.ai.price(usage, served);
  }

  /* One turn answered (a new message, Retry of the last, or a waiting turn going out once Claude can be reached).
     `claim`: push the 'answering' mark to the cloud before the request, so another device leaves this turn to us. */
  async function answer(chat, turn, { first = false, claim = false } = {}) {
    let model = useNow(turn.model);  // (Claude switched off: it goes with Gemini)
    // A Gemini message goes with the chat's Gemini choice as it is now (a Retry after picking Gemini Smart, or a
    // message waiting since before, asks Smart); one waiting for Gemini while the chat moved to Claude stays Gemini's.
    const chosen = modelFor(chat);
    if (isGemini(model) && isGemini(chosen)) model = chosen;
    const job = { chatId: chat.id, turn, controller: new AbortController(), pcId: null, stopped: false };
    busy = job;
    trouble = null;
    turn.state = 'answering';
    turn.answeringAt = now();
    turn.replies = [];
    turn.problem = '';
    draw();
    if (claim) { chat.updated = now(); await persist(chat).catch(() => {}); }  // tell other devices before we ask
    let failed = null;
    try {
      for (let n = 0; n < MOST_REPLIES; n++) {
        if (isGemini(model)) {  // Gemini: one call, streamed (no tools or server fallback: ai.js picks the model)
          const reply = fresh(model);
          turn.replies.push(reply);
          const out = await geminiTurn(chat, turn, job, (words) => { reply.content = [{ type: 'text', text: words }]; showLive(); },
            model);
          reply.content = tidy([{ type: 'text', text: out.text || '' }]);
          reply.usage = out.usage || {};
          reply.model = model;  // (the Gemini choice, Fast or Smart; the model Google answered with is in usage.model)
          // Gemini took it (it answered, or said no): the message is Gemini's from now on, so Retry asks Gemini again.
          // Until then a message meant for Claude keeps Claude's name, and goes to Claude once it's switched on.
          if (out.text || out.stopReason === 'refusal') turn.model = model;
          reply.cost = 0;  // free
          reply.stop_reason = out.stopReason;
          if (job.stopped) { turn.state = 'stopped'; break; }
          if (!out.text && out.stopReason !== 'refusal') throw new ChatError('dropped', WORDS.dropped);
          if (out.stopReason === 'cut_off') {  // the words stopped coming part-way: what came stays, with Retry
            turn.state = 'failed';
            turn.problem = WORDS.cutOff;
            showLive();
            break;
          }
          turn.state = out.stopReason === 'refusal' ? 'refused' : out.stopReason === 'max_tokens' ? 'cut' : 'done';
          showLive();
          break;
        }
        const { body, betas } = await requestFor(chat, turn);
        const reply = fresh(body.model);
        turn.replies.push(reply);
        let finished = { stopped: false };
        try {
          finished = await (V.desktop ? viaPc : direct)(body, betas, job, (event) => { take(reply, event); showLive(); });
        } finally {
          reply.content = tidy(reply.content);
          reply.cost = (reply.usage.input_tokens || reply.content.length) ? costOf(reply, body.model, finished.stopped || !reply.stop_reason) : 0;
          if (reply.cost) await V.ai.count(reply.cost);
        }
        if (reply.error) throw new ChatError('dropped', reply.error.type === 'overloaded_error' ? WORDS.busy
          : `Claude stopped with a problem (${reply.error.message || reply.error.type}).`);
        if (finished.stopped || job.stopped) { turn.state = 'stopped'; break; }
        if (!reply.stop_reason) throw new ChatError('dropped', WORDS.dropped);
        if (reply.stop_reason === 'pause_turn') continue;
        turn.state = reply.stop_reason === 'refusal' ? 'refused' : reply.stop_reason === 'max_tokens' ? 'cut' : 'done';
        break;
      }
      if (turn.state === 'answering') turn.state = 'cut';
      if (SENT.has(turn.state) && !repliesOf(turn).length) turn.state = 'failed';  // nothing came back to keep
    } catch (error) {
      failed = error instanceof ChatError ? error : new ChatError('bad', error.message || String(error));
    } finally {
      busy = null;
    }
    delete turn.answeringAt;
    if (failed) {
      const heard = turn.replies.some((r) => r.content.length);
      if (!heard && (WAIT_KINDS.has(failed.kind) || (claim && failed.kind === 'nokey' && isGemini(model)))) {
        // A blocked or flaky network: the turn stays in the chat and goes out when Claude can be reached. Nothing is
        // charged, nothing is kept, and there's no scary banner — just a quiet "Waiting to send". So does a message
        // that was already waiting when Gemini, which would answer it now, turns out not to be set up: it goes once
        // the free key is (the box offers it), never lost for the lack of it.
        turn.state = 'waiting';
        turn.waitWhy = failed.kind === 'nokey' ? 'setup' : failed.why;  // (the waiting line says why, naming the model)
        turn.problem = '';
        turn.replies = [];
      } else if (first && !heard && failed.kind !== 'dropped') {
        // The owner's to fix (no key, a bad key, no credit, an old PC app): the message goes back in the box.
        chat.turns = chat.turns.filter((t) => t !== turn);
        const draft = draftOf(chat.id);
        draft.text = turn.text;
        draft.notes = sentNotes.get(turn) || [];
        draft.files = (turn.files || []).map((f) => ({ ...f, state: 'ready', url: pictures.get(f.path) }));
        trouble = { chatId: chat.id, kind: failed.kind, message: failed.message };
        if (!chat.turns.length) {
          chats.delete(chat.id);
          unsent.set(chat.id, chat);
          await keepIndex();
          reflect();
          draw();
          return;
        }
      } else {
        turn.state = 'failed';
        turn.problem = failed.message;
      }
    }
    if (turn.state === 'waiting') {
      if (isGemini(model) && GEMINI_SOON.has(turn.waitWhy)) retrySoon(chat, turn);
    } else {
      forgetSoon(turn.id);
      delete turn.waitWhy;
    }
    chat.updated = now();
    await persist(chat);
    reflect();
    draw();
  }

  /* ---------------------------------------------------------------- a message held until it can be sent

     A send that fails on the network (a school that blocks Claude, or no internet) leaves the turn in the chat as
     'waiting'. It goes out by itself when the network might be back (an online/visible/focus event, the app opening,
     or a gentle timer). The chat JSON syncs, so a waiting turn shows on every device; to stop two of them answering
     it at once, the one sending marks it 'answering' and pushes that before the request, and the others leave a turn
     marked 'answering' less than two minutes ago to whoever claimed it. */

  const isStale = (t) => t.state === 'answering' && (!t.answeringAt || Date.now() - Date.parse(t.answeringAt) > CLAIM_MS);
  const needsSend = (t) => t.state === 'waiting' || isStale(t);  // waiting here, or claimed by a device that went away
  const anyPending = () => [...(chats || new Map()).values()]
    .some((c) => (c.turns || []).some((t) => t.state === 'waiting' || t.state === 'answering'));
  const waitingCount = () => [...(chats || new Map()).values()]
    .reduce((n, c) => n + (c.turns || []).filter((t) => t.state === 'waiting').length, 0);

  /* The Chat-tab badge and the retry timer kept in step with what's waiting. */
  function reflect() {
    if (anyPending()) startPump(); else stopPump();
    V.emit('badge');
  }

  function startPump() { if (!pumpTimer) pumpTimer = setInterval(() => pump().catch(() => {}), PUMP_EVERY); }
  function stopPump() { if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; } }

  /* A waiting message that can't go by itself yet: Gemini would answer it and isn't set up, or this device hasn't yet
     read whether Claude is on (unsure). It stays waiting, and the others behind it still go. */
  const held = (turn) => needsGemini(turn) || unsure(turn);

  const anyHeldForGemini = () => [...(chats || new Map()).values()]
    .some((c) => (c.turns || []).some((t) => needsSend(t) && needsGemini(t)));

  /* The oldest message waiting to send, across every chat. */
  function oldestPending() {
    let best = null;
    for (const chat of (chats || new Map()).values()) {
      for (const turn of chat.turns || []) {
        if (needsSend(turn) && !held(turn) && (!best || (turn.at || '') < (best.turn.at || ''))) best = { chat, turn, id: chat.id, turnId: turn.id };
      }
    }
    return best;
  }

  /* Try to send one waiting message. One at a time; if it still can't go it stays waiting, quietly. */
  async function pump() {
    if (pumping || busy || !chats) return;
    if (anyHeldForGemini()) await V.ai.recheck();  // (a key set up elsewhere since: what waited for it goes now)
    if (pumping || busy || !chats) return;
    const next = oldestPending();
    if (!next) { if (!anyPending()) stopPump(); return; }  // keep the timer while a fresh claim may yet go stale
    pumping = true;
    try { await sendWaiting(next.chat, next.turn); } finally { pumping = false; }
    if (!anyPending()) { stopPump(); return; }
    startPump();
    const chat = chatOf(next.id);
    const turn = chat && (chat.turns || []).find((t) => t.id === next.turnId);
    if (!turn || !needsSend(turn)) setTimeout(() => pump().catch(() => {}), 0);  // it moved on: try the next now
  }

  /* Send a waiting turn. First a quick look at the cloud: skip if another device already answered it, or has it in
     hand (marked 'answering' under two minutes ago). "Send now" (manual) goes ahead whatever another device is doing.
     One at a time: a turn already on its way here (the automatic retry, say) isn't sent again by "Send now", and
     nothing starts while another answer is coming (checked again after the waits, right before it goes). */
  async function sendWaiting(chat, turn, { manual = false } = {}) {
    if (busy || sendingTurns.has(turn.id)) return;
    sendingTurns.add(turn.id);
    try {
      const id = chat.id;
      if (chats.has(id)) await quickRefresh();
      const current = chatOf(id);
      if (!current) return;
      const now2 = current.turns.find((t) => t.id === turn.id);
      if (!now2 || !(now2.state === 'waiting' || now2.state === 'answering') || repliesOf(now2).length) { reflect(); draw(); return; }
      if (!manual && now2.state === 'answering' && !isStale(now2)) return;  // another device is on it
      if (manual && unsure(now2)) await V.ai.modeReady(SETTLE_MS);  // (is Claude on? a new device asks the cloud first)
      if (needsGemini(now2)) await V.ai.recheck(manual ? 0 : undefined);  // (set up on another device since?)
      if (needsGemini(now2)) {  // Gemini would answer it, and isn't set up: it waits for the free key
        if (manual) V.toast(WORDS.needsGemini, { ms: 6000 });
        return;
      }
      if (!manual && unsure(now2)) return;  // (sent by itself only once this device knows whether Claude is on)
      // (waiting for Claude, which is switched off now: it goes with Gemini; the free Gemini isn't held back by Claude's limit)
      const over = isGemini(useNow(now2.model)) ? null : await V.ai.overLimit();
      if (over) {
        now2.state = 'failed';
        now2.problem = over.message;
        current.updated = now();
        await persist(current);
        reflect();
        draw();
        return;
      }
      if (busy) return;  // another answer started meanwhile: this one goes after it (the pump, or its own retry)
      await answer(current, now2, { claim: true });  // (sets busy at once)
    } finally {
      sendingTurns.delete(turn.id);
    }
  }

  /* A Gemini message held because Gemini was busy (Google answered, so the network works), slow, or slow to take this
     chat's earlier pictures: sent again soon, by itself, sooner each time than the minute the pump waits
     (retryWaits). */
  const GEMINI_SOON = new Set(['busy', 'slow', 'quota', 'uplink']);
  const soon = new Map();  // turn id -> { timer, tries }
  function forgetSoon(id) {
    const was = soon.get(id);
    if (was) clearTimeout(was.timer);
    soon.delete(id);
  }
  function retrySoon(chat, turn) {
    const was = soon.get(turn.id) || { tries: 0 };
    clearTimeout(was.timer);
    const base = turn.waitWhy === 'quota' ? retryWaits.quota : turn.waitWhy === 'uplink' ? retryWaits.big : retryWaits.busy;
    const delay = Math.min(retryWaits.most, base * 2 ** was.tries);
    const entry = { tries: was.tries + 1, timer: null };
    const go = async () => {
      if (soon.get(turn.id) !== entry) return;
      if (busy || pumping) { entry.timer = setTimeout(go, 2000); return; }  // (after the answer coming now)
      const c = chatOf(chat.id);
      const t = c && (c.turns || []).find((x) => x.id === turn.id);
      if (!t || !needsSend(t)) { forgetSoon(turn.id); return; }
      pumping = true;
      try { await sendWaiting(c, t); } finally { pumping = false; }
    };
    entry.timer = setTimeout(go, delay);
    soon.set(turn.id, entry);
  }

  /* What a waiting message's line says: why it's held, naming the model this chat uses (never Claude for Gemini). */
  function waitingWords(turn) {
    const who = isGemini(useNow(turn.model)) ? 'Gemini' : 'Claude';  // (Claude off: Gemini sends it)
    const why = turn.waitWhy || 'offline';
    if (who === 'Gemini' && (needsGemini(turn) || (why === 'setup' && !V.ai.has('gemini')))) {
      return 'Waiting to send — it\'ll go once the free Gemini is set up';
    }
    if (why === 'away') return 'Waiting to send — it\'ll go when you\'re back online';
    if (who === 'Gemini') {
      if (why === 'busy') return 'Gemini is busy right now — trying again in a moment…';
      if (why === 'slow') return 'Gemini is slow right now — trying again in a moment…';
      if (why === 'quota') return 'Google\'s free Gemini limit is used up for now — trying again in a minute…';
      if (why === 'uplink') return 'Slow to send — this chat\'s pictures go with every message. Trying again soon (a new chat is quicker)…';
    } else if (why === 'busy') {
      return 'Claude is busy right now — it\'ll go again in a minute';
    }
    return `Waiting to send — it'll go when ${who} can be reached`;
  }

  /* "Cancel" on a waiting message: drop the turn and put its words, notes and files back in the box. First a quick
     look at the cloud: a message another device has answered (or is sending) since this one last looked stays as it
     is, answer and all. */
  async function cancelWaiting(shown, shownTurn) {
    if (chats.has(shown.id)) await quickRefresh();
    const chat = chatOf(shown.id);
    const turn = chat && (chat.turns || []).find((t) => t.id === shownTurn.id);
    if (!turn || repliesOf(turn).length || !needsSend(turn) || (busy && busy.turn === turn)) {
      V.toast(turn && repliesOf(turn).length ? 'That message was already answered on another device.'
        : turn && turn.state === 'answering' ? 'That message is being sent right now.'
        : 'That message isn\'t waiting to send any more.', { ms: 5000 });
      reflect();
      draw();
      return;
    }
    forgetSoon(turn.id);
    chat.turns = chat.turns.filter((t) => t !== turn);
    const draft = draftOf(chat.id);
    draft.text = turn.text || '';
    draft.notes = sentNotes.get(turn) || (turn.notes || []).map((n) => {
      const live = V.data.notes.get(n.id);
      return { id: n.id, title: n.title, text: live ? (live.body || '') : '' };
    });
    draft.files = (turn.files || []).map((f) => ({ ...f, state: 'ready', url: pictures.get(f.path) }));
    if (!chat.turns.length) {  // its only message: the chat is back to one never sent, here and in the cloud
      chats.delete(chat.id);
      unsent.set(chat.id, chat);
      index.waiting.delete(chat.id);
      index.gone.add(chat.id);
      await V.db.meta('chat:' + chat.id, null);
      await keepIndex();
      takeOut(chat.id).catch(() => {});  // (offline: the next look at the cloud does it)
    } else {
      chat.updated = now();
      await persist(chat);
    }
    reflect();
    draw();
  }

  /* The box's words, notes and files sent as the next message. One at a time: what's in the box is taken out at once
     (a second tap or Enter has nothing to send, and the Send button waits), and put back if it can't go. */
  async function send() {
    const id = openId;
    const chat = chatOf(id);
    if (!chat || sendingId) return;
    const draft = draftOf(id);
    const text = draft.text.trim();
    if (!text && !draft.notes.length && !draft.files.length) return;
    if (busy) return V.toast('Wait for this answer to finish first (or press Stop).');
    if (draft.files.some((f) => f.state !== 'ready')) return V.toast('Wait for the files to finish going up.');
    const taken = { text: draft.text, notes: draft.notes, files: draft.files };
    drafts.set(id, { text: '', notes: [], files: [] });
    sendingId = id;
    drawBox();
    let started = false;
    try {
      // A new device that hasn't read "Use Claude too" from the cloud yet: for a chat on Claude (or a new one, whose
      // default hangs on it), that's read first, as "nothing yet" isn't "off".
      if (!V.ai.modeKnown() && (!isGemini(chat.model) || blankDefault(chat))) await V.ai.modeReady(SETTLE_MS);
      if (blankDefault(chat)) {  // sent before the key check answered: which model is still open
        if (!V.ai.state()) await V.ai.check().catch(() => {});
        // (the Gemini key not known about yet: the look under way given a moment, then what's known decides)
        else if (defaultUnsure()) await V.ai.keysSettled(SETTLE_MS);
        retarget();
      }
      if (tooOld(chat)) { trouble = { chatId: id, kind: 'old', message: WORDS.old }; return; }
      if (chats.has(id)) await quickRefresh();
      const current = chatOf(id) || chat;  // (another device may have added to it meanwhile)
      // The model that answers: the chat's own, or Gemini while Claude is off (the chat keeps its own for later).
      const model = modelFor(current);
      // The monthly limit is Claude's: the free Gemini is never held back by it.
      const over = isGemini(model) ? null : await V.ai.overLimit();
      if (over) { trouble = { chatId: id, kind: 'limit', message: over.message }; return; }
      if (busy) { V.toast('Wait for this answer to finish first (or press Stop).'); return; }  // (one started meanwhile)
      const turn = { id: V.uuid().slice(0, 8), at: now(), text: taken.text.trim(), model, think: !!current.think,
        search: !!current.search, notes: taken.notes.map((n) => ({ id: n.id, title: n.title })),
        files: taken.files.map((f) => ({ id: f.id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, path: f.path,
          w: f.w, h: f.h, pages: f.pages, tokens: f.tokens })),
        content: contentFor(taken.text.trim(), taken.notes, !!current.search), replies: [], state: 'answering' };
      turn.tools = JSON.stringify(toolsFor(turn));
      sentNotes.set(turn, taken.notes);
      if (!current.title) current.title = titleFrom(turn);
      current.turns.push(turn);
      chats.set(current.id, current);
      unsent.delete(current.id);
      trouble = null;
      started = true;
      const going = answer(current, turn, { first: true });  // (sets busy at once)
      sendingId = null;
      await going;
    } finally {
      sendingId = null;
      if (!started) {  // it didn't go: back in the box (before anything typed meanwhile)
        const now2 = draftOf(id);
        drafts.set(id, { text: [taken.text, now2.text].filter((t) => t.trim()).join('\n'),
          notes: [...taken.notes, ...now2.notes.filter((n) => !taken.notes.some((t) => t.id === n.id))],
          files: [...taken.files, ...now2.files] });
        drawBox();
      }
    }
  }

  function titleFrom(turn) {
    const line = (turn.text || '').split('\n').find((l) => l.trim()) || '';
    const words = line.trim() || (turn.files[0] && turn.files[0].name) || (turn.notes[0] && `About ${turn.notes[0].title}`) || 'New chat';
    return words.length > 60 ? words.slice(0, 57).trimEnd() + '...' : words;
  }

  function stop() {
    if (!busy) return;
    busy.stopped = true;
    busy.controller.abort();
    if (busy.pcId) V.pc.call('chatStop', { id: busy.pcId }).catch(() => {});
  }

  async function retry(chat, turn) {
    if (busy || chat.turns[chat.turns.length - 1] !== turn) return;
    if (unsure(turn)) await V.ai.modeReady(SETTLE_MS);  // (is Claude on? a new device asks the cloud first)
    // Asked again of the model the message went to, or of Gemini while Claude is off (an answer from Claude is then
    // replaced by Gemini's, and the message is Gemini's once Gemini answers). Gemini not set up: nothing is lost, the
    // box says how to set it up.
    if (needsGemini(turn)) await V.ai.recheck(0);  // (set up on another device since?)
    if (busy) return;
    if (needsGemini(turn)) { trouble = { chatId: chat.id, kind: 'nokey', message: V.ai.WORDS.geminiNokey }; return drawBox(); }
    const over = isGemini(useNow(turn.model)) ? null : await V.ai.overLimit();
    if (over) { trouble = { chatId: chat.id, kind: 'limit', message: over.message }; return drawBox(); }
    if (busy) return;  // (another answer started meanwhile)
    await answer(chat, turn);
  }

  /* ---------------------------------------------------------------- the words of an answer */

  const textOf = (turn) => (turn.replies || []).flatMap((r) => r.content || []).filter((b) => b && b.type === 'text')
    .map((b) => b.text || '').join('');

  function sourcesOf(turn) {
    const seen = new Map();
    for (const block of (turn.replies || []).flatMap((r) => r.content || [])) {
      if (!block || block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const hit of block.content) if (hit && hit.url && !seen.has(hit.url)) seen.set(hit.url, hit.title || hit.url);
    }
    return [...seen].slice(0, 6);
  }

  /* An answer's words as page elements (js/format.js's Read view), with a Copy button on each code block and tick
     boxes that are only to look at. */
  function rendered(text) {
    const { el } = V.format.render(text);
    el.classList.add('chat-md');
    for (const tick of el.querySelectorAll('.read-tick')) tick.disabled = true;
    for (const pre of el.querySelectorAll('pre.read-pre')) {
      const code = pre.textContent;
      const copy = V.h('button.chat-copy-code', { type: 'button', onclick: async () => {
        await V.copy(code);
        V.toast('Code copied');
      } }, V.icon('copy'), V.h('span', { text: 'Copy' }));
      const box = V.h('div.chat-code');
      pre.replaceWith(box);
      box.append(pre, copy);
    }
    return el;
  }

  function status(turn) {
    const blocks = (turn.replies || []).flatMap((r) => r.content || []).filter(Boolean);
    const searching = [...blocks].reverse().find((b) => b.type === 'server_tool_use');
    const lastIsSearch = blocks.length && blocks[blocks.length - 1] === searching;
    const words = lastIsSearch && searching.input && searching.input.query ? `Searching the web for "${searching.input.query}"...` : 'Thinking...';
    return V.h('div.chat-thinking', {}, V.h('div.spinner'), V.h('span', { text: words }));
  }

  /* ---------------------------------------------------------------- drawing */

  function pictureEl(f) {
    const img = V.h('img.chat-pic', { alt: f.name, loading: 'lazy' });
    const known = f.url || pictures.get(f.path);
    if (known) img.src = known;
    else {
      blobOf(f).then((blob) => {
        const url = URL.createObjectURL(blob);
        pictures.set(f.path, url);
        img.src = url;
      }).catch(() => img.classList.add('missing'));
    }
    return img;
  }

  const fileChip = (f, onRemove) => V.h('span.chat-chip' + (f.state === 'up' ? '.going' : ''), { title: f.name },
    f.kind === 'image' ? pictureEl(f) : V.h('span.chat-chip-kind', { text: f.kind === 'pdf' ? 'PDF' : ending(f.name).toUpperCase() || 'TXT' }),
    V.h('span.chat-chip-name', { text: f.kind === 'image' ? '' : f.name }),
    f.state === 'up' ? V.h('div.spinner') : null,
    onRemove ? V.h('button.chat-chip-x', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: onRemove }, V.icon('x')) : null);

  const noteChip = (n, onRemove) => V.h('span.chat-chip.note', { title: n.title },
    V.icon(n.locked ? 'lock' : 'notes'), V.h('span.chat-chip-name', { text: n.title }),
    onRemove ? V.h('button.chat-chip-x', { type: 'button', 'aria-label': `Remove ${n.title}`, onclick: onRemove }, V.icon('x')) : null);

  function turnEl(chat, turn, last) {
    const you = V.h('div.chat-you', {},
      (turn.files || []).length || (turn.notes || []).length ? V.h('div.chat-attached', {},
        (turn.files || []).filter((f) => f.kind === 'image').map((f) => V.h('div.chat-sent-pic', {}, pictureEl(f))),
        (turn.files || []).filter((f) => f.kind !== 'image').map((f) => fileChip(f)),
        (turn.notes || []).map((n) => noteChip(n))) : null,
      turn.text ? V.h('div.chat-you-text', { text: turn.text }) : null);
    if (turn.state === 'waiting') {
      return V.h('div.chat-turn', { dataset: { turn: turn.id, state: turn.state } }, you,
        V.h('div.chat-claude', {}, V.h('div.chat-waiting', {},
          V.h('span.chat-waiting-text', {}, V.icon('clock'),
            V.h('span', { text: waitingWords(turn) })),
          V.h('div.chat-waiting-actions', {},
            V.button('Send now', { kind: 'quiet', icon: 'send', onClick: () => sendWaiting(chat, turn, { manual: true }) }),
            V.button('Cancel', { kind: 'quiet', icon: 'x', onClick: () => cancelWaiting(chat, turn) })))));
    }
    const answering = turn.state === 'answering';  // ours now, or another device's (a claimed turn shows "Thinking...")
    const text = textOf(turn);
    const body = V.h('div.chat-reply-body');
    if (turn.state === 'refused') {
      body.append(V.h('p.chat-note', { text: `${isGemini(turn.model) ? 'Gemini' : 'Claude'} declined to answer this one. Try asking it another way.` }));
    } else {
      if (text) body.append(rendered(text));
      if (answering && (!text || turn.replies.some((r) => (r.content || []).filter(Boolean).slice(-1).some((b) => b.type === 'server_tool_use')))) {
        body.append(status(turn));
      }
    }
    const sources = turn.state === 'refused' ? [] : sourcesOf(turn);
    const notes = [];
    if (turn.state === 'stopped') notes.push('Stopped.');
    if (turn.state === 'cut') notes.push('Cut off: the answer got too long.');
    if (turn.state === 'failed') notes.push(turn.problem || WORDS.dropped);
    const fallback = (turn.replies || []).flatMap((r) => r.content || []).filter((b) => b && b.type === 'fallback').pop();
    const served = (turn.replies || []).map((r) => r.model).filter(Boolean).pop() || turn.model;
    const cost = (turn.replies || []).reduce((sum, r) => sum + (r.cost || 0), 0);
    const meta = [nameOf(served) + (fallback ? ' (the first model declined)' : ''), cost ? V.ai.money(cost) : '']
      .filter(Boolean).join(' · ');
    const actions = answering ? null : V.h('div.chat-actions', {},
      text && turn.state !== 'refused' ? V.button('Copy', { kind: 'quiet', icon: 'copy', onClick: async () => { await V.copy(text); V.toast('Copied'); } }) : null,
      text && turn.state !== 'refused' ? V.button('Save as note', { kind: 'quiet', icon: 'notes', onClick: (event) => saveMenu(event.currentTarget, chat, turn) }) : null,
      text && turn.state !== 'refused' && V.send && V.send.targets().length
        ? V.button('Send to…', { kind: 'quiet', icon: 'send', onClick: (event) => sendMenu(event.currentTarget, chat, turn) }) : null,
      last && !busy ? V.button(turn.state === 'done' || turn.state === 'cut' ? 'Retry' : 'Try again', { kind: 'quiet', icon: 'restore',
        onClick: () => retry(chat, turn) }) : null,
      V.h('span.chat-meta', { text: meta }));
    return V.h('div.chat-turn', { dataset: { turn: turn.id, state: turn.state } }, you,
      V.h('div.chat-claude', {}, body,
        notes.length ? V.h('p.chat-note', { text: notes.join(' ') }) : null,
        sources.length ? V.h('div.chat-sources', {}, V.h('span.chat-sources-label', { text: 'Sources' }),
          sources.map(([url, title]) => V.h('a.chat-source', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url,
            text: V.format.site(url).name || title }))) : null,
        actions));
  }

  /* While an answer comes in, only it is drawn again (once a frame at most), the list staying where it's scrolled
     unless it was at the bottom. */
  let liveFrame = 0;
  function showLive() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0;
      if (!busy || !parts || !parts.thread || openId !== busy.chatId) return;
      const old = parts.thread.querySelector(`.chat-turn[data-turn="${busy.turn.id}"]`);
      if (!old) return;
      const scroller = parts.scroll;
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      const chat = chatOf(busy.chatId);
      old.replaceWith(turnEl(chat, busy.turn, true));
      if (atEnd) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function emptyChat() {
    return V.h('div.chat-empty', {}, V.h('span.chat-empty-mark', {}, V.icon('spark', 'big')),
      V.h('h2', { text: 'Ask anything' }),
      V.h('p', { text: 'Homework, ideas, a quick explanation. Attach a note, a picture or a PDF to ask about it, and save any answer as a note.' }));
  }

  function chatRow(chat) {
    const last = chat.turns[chat.turns.length - 1];
    const waiting = (chat.turns || []).some((t) => t.state === 'waiting');
    return V.h('div.chat-row' + (chat.id === openId ? '.on' : ''), { dataset: { id: chat.id } },
      V.h('button.chat-row-main', { type: 'button', onclick: () => open(chat.id) },
        V.h('span.chat-row-title', { text: chat.title || 'New chat' }),
        waiting ? V.h('span.chat-row-waiting', {}, V.icon('clock'), V.h('span', { text: 'Waiting to send' }))
          : V.h('span.chat-row-meta', { text: [V.ago(chat.updated), nameOf(last ? last.model : chat.model)].join(' · ') })),
      V.iconButton('more', 'More', (event) => rowMenu(event.currentTarget, chat), 'tiny'));
  }

  function drawList() {
    if (!parts) return;
    const list = listOf();
    V.clear(parts.list, list.length ? list.map(chatRow)
      : V.h('div.empty.small', {}, V.h('p', { text: chats ? 'No chats yet.' : 'Loading...' })));
  }

  function drawChat() {
    if (!parts) return;
    const chat = chatOf(openId);
    if (!chat) { V.clear(parts.thread); V.clear(parts.head); return; }
    V.clear(parts.head,
      V.iconButton('back', 'Back to chats', () => { showingChat = false; draw(); }, 'chat-back'),
      V.h('button.chat-title', { type: 'button', title: 'Rename', onclick: () => rename(chat), text: chat.title || 'New chat' }),
      V.iconButton('more', 'More', (event) => chatMenu(event.currentTarget, chat)));
    const last = chat.turns[chat.turns.length - 1];
    const where = `${chat.id}:${chat.turns.length}:${last ? last.state : ''}`;
    const top = parts.scroll.scrollTop;
    V.clear(parts.thread, chat.turns.length ? chat.turns.map((t, i) => turnEl(chat, t, i === chat.turns.length - 1)) : emptyChat());
    if (where !== shown) requestAnimationFrame(() => { if (parts) parts.scroll.scrollTop = parts.scroll.scrollHeight; });
    else parts.scroll.scrollTop = top;  // the same chat drawn again (a sync): it stays where it was read
    shown = where;
    drawBox();
  }

  /* The box: what's attached, a line when something's wrong, the words, and the buttons. */
  function drawBox() {
    if (!parts || !parts.box) return;
    const chat = chatOf(openId);
    if (!chat) return;
    const draft = draftOf(openId);
    if (parts.input.value !== draft.text) parts.input.value = draft.text;
    grow();
    const old = tooOld(chat);
    const model = modelFor(chat);  // (Gemini while Claude is switched off)
    const gem = isGemini(model);  // Gemini has no "Think" or web search here
    // No Gemini key yet (the key check says so): a line with the one tap that sets it up, before anything is sent.
    const unset = gem && V.ai.lacksGemini();
    const problem = old ? { kind: 'old', message: WORDS.old } : trouble && trouble.chatId === openId ? trouble
      : unset ? { kind: 'setup', message: WORDS.setup } : null;
    const setUp = gem && ['setup', 'nokey', 'key'].includes(problem && problem.kind);  // (the free Gemini's own key)
    V.clear(parts.trouble, problem ? [V.icon(problem.kind === 'setup' ? 'spark' : 'alert'), V.h('span', { text: problem.message }),
      ['offline', 'away', 'busy', 'bad', 'dropped'].includes(problem.kind) ? V.button('Try again', { onClick: () => send() }) : null,
      setUp ? V.button(problem.kind === 'key' ? 'Open Settings' : 'Set up free Gemini', { kind: problem.kind === 'key' ? '' : 'primary',
        onClick: () => V.ai.setUp() })
        : ['limit', 'nokey', 'key'].includes(problem.kind) ? V.button('Open Settings', { onClick: () => V.go('settings') }) : null] : []);
    parts.trouble.hidden = !problem;
    parts.trouble.dataset.kind = problem ? problem.kind : '';
    const pdf = draft.files.find((f) => f.kind === 'pdf');
    V.clear(parts.attached,
      draft.files.map((f) => fileChip(f, () => unattach(f))),
      draft.notes.map((n) => noteChip(n, () => { draft.notes = draft.notes.filter((x) => x !== n); drawBox(); })));
    parts.attached.hidden = !draft.files.length && !draft.notes.length;
    parts.hint.textContent = pdf ? pdfHint(pdf, model) : '';
    parts.hint.hidden = !pdf;
    parts.model.querySelector('.chat-model-name').textContent = nameOf(model);
    parts.think.hidden = gem;
    parts.web.hidden = gem;
    parts.input.placeholder = gem ? 'Ask Gemini anything' : 'Ask Claude anything';
    parts.think.setAttribute('aria-pressed', String(!!chat.think));
    parts.web.setAttribute('aria-pressed', String(!!chat.search));
    parts.input.disabled = old;
    parts.clip.disabled = old;
    const answering = busy && busy.chatId === openId;
    V.clear(parts.go, answering ? V.icon('stop') : V.icon('arrow-up'));
    parts.go.title = answering ? 'Stop' : 'Send';
    parts.go.setAttribute('aria-label', parts.go.title);
    parts.go.classList.toggle('stop', !!answering);
    parts.go.disabled = old || (!answering && (!!busy || !!sendingId || (!draft.text.trim() && !draft.files.length && !draft.notes.length)));
  }

  function grow() {
    if (!parts || !parts.input) return;
    parts.input.style.height = 'auto';
    parts.input.style.height = Math.min(parts.input.scrollHeight + 2, 200) + 'px';
  }

  function buildBox() {
    const input = V.h('textarea.chat-input', { rows: '1', placeholder: 'Ask anything', 'aria-label': 'Your message',
      enterkeyhint: enterSends ? 'send' : 'enter' });
    input.addEventListener('input', () => { draftOf(openId).text = input.value; grow(); drawSendButton(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && enterSends && !event.isComposing) { event.preventDefault(); send(); }
    });
    input.addEventListener('paste', (event) => {
      const files = [...((event.clipboardData && event.clipboardData.files) || [])];
      if (!files.length) return;
      event.preventDefault();
      attach(files);
    });
    const pick = V.h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true,
      onchange: () => { attach(pick.files); pick.value = ''; } });
    const photo = V.h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
      onchange: () => { attach(photo.files); photo.value = ''; } });
    const clip = V.iconButton('paperclip', 'Attach', (event) => V.menu(event.currentTarget, [
      { label: 'A picture or file', icon: 'file', onClick: () => pick.click() },
      V.device === 'phone' ? { label: 'Take a photo', icon: 'camera', onClick: () => photo.click() } : null,
      { label: 'From Vault', icon: 'stack', onClick: fromVault },
      { label: 'A note', icon: 'notes', onClick: pickNotes },
    ]), 'chat-clip');
    const model = V.h('button.chat-pill.chat-model', { type: 'button', title: 'Choose the model', onclick: chooseModel },
      V.icon('spark'), V.h('span.chat-model-name'), V.icon('down', 'chat-pill-down'));
    const think = V.h('button.chat-pill.chat-toggle', { type: 'button', title: 'Think harder: slower and costs more',
      onclick: () => setting('think') }, V.icon('bolt'), V.h('span', { text: 'Think' }));
    const web = V.h('button.chat-pill.chat-toggle', { type: 'button', title: 'Search the web: a cent a search',
      onclick: () => setting('search') }, V.icon('globe'), V.h('span', { text: 'Web' }));
    const go = V.h('button.chat-go', { type: 'button', onclick: () => (busy && busy.chatId === openId ? stop() : send()) });
    const troubleLine = V.h('div.chat-trouble', { role: 'status', hidden: true });
    const attached = V.h('div.chat-attached.in-box', { hidden: true });
    const hint = V.h('p.chat-hint', { hidden: true });
    const box = V.h('div.chat-box', {}, attached, hint, input,
      V.h('div.chat-tools', {}, clip, model, think, web, V.h('span.chat-tools-gap'), go));
    Object.assign(parts, { input, clip, model, think, web, go, trouble: troubleLine, attached, hint, box });
    return V.h('div.chat-composer', {}, troubleLine, box, pick, photo);
  }

  function drawSendButton() {
    if (!parts || !parts.go || (busy && busy.chatId === openId)) return;
    const draft = draftOf(openId);
    parts.go.disabled = tooOld(chatOf(openId)) || !!busy || !!sendingId || (!draft.text.trim() && !draft.files.length && !draft.notes.length);
  }

  function draw() {
    if (!root || !root.isConnected || root.dataset.tab !== 'claude' || !parts) return;
    parts.app.classList.toggle('showing-chat', showingChat);
    drawList();
    drawChat();
  }

  function render(container) {
    root = container;
    const scroll = V.h('div.chat-scroll');
    const thread = V.h('div.chat-thread');
    scroll.append(thread);
    const list = V.h('div.chat-list');
    const head = V.h('div.chat-head');
    parts = { list, head, scroll, thread };
    const pane = V.h('section.chat-pane', {}, head, scroll, buildBox());
    const side = V.h('aside.chat-side', {},
      V.h('div.page-head.chat-side-head', {}, V.h('h1', { text: 'Chat' }), V.statusPill(),
        V.button('New chat', { kind: 'primary', icon: 'plus', onClick: () => open(null) })),
      list);
    parts.app = V.h('div.chat-app', {}, side, pane);
    V.clear(container, parts.app);
    if (chats) choose();
    draw();
    load().then(() => {
      choose();
      draw();
      return refresh();
    }).then(() => { choose(); draw(); reflect(); pump().catch(() => {}); }).catch(() => {});
    V.ai.check().then(retarget).catch(() => {});  // (on the PC too: Python says about Claude, the cloud about Gemini)
  }

  /* A chat that has never been sent, started here on the default model, which nobody picked. Never one that has been in
     the cloud (a waiting message cancelled puts it back in the box): its model may have been chosen on another device,
     which `picked` (this device's memory only) can't tell. */
  const blankDefault = (c) => !!c && !c.turns.length && unsent.has(c.id) && defaulted.has(c.id) && !picked.has(c.id)
    && [GEMINI_MODEL, CLAUDE_MODEL].includes(c.model);

  /* The default as the key check (and "Use Claude too") have it now, for every chat still on it: one opened before the
     check knew starts on Gemini, and moves to Claude when Claude is on and only its key is known to be set up (so the
     first message doesn't dead-end), and to Gemini once its key is known to be there. Run when the check answers (here,
     or Settings' or the note-taker's, or the PC's late listing: the 'ai' event) and before a send that went ahead of
     it. */
  function retarget() {
    const want = defaultModel();
    let changed = false;
    for (const c of unsent.values()) {
      if (!blankDefault(c) || c.model === want) continue;
      c.model = want;
      changed = true;
    }
    if (changed) drawBox();
  }

  const blank = () => [...unsent.values()].find((c) => c.id !== sendingId && !c.turns.length && !draftOf(c.id).text
    && !draftOf(c.id).files.length && !draftOf(c.id).notes.length);

  /* The chat to show when none is open: the newest (a new one when there's none, shown straight away). */
  function choose() {
    const newest = listOf()[0];
    const open = openId && chatOf(openId);
    if (open && !(auto && newest && open === blank())) return;
    openId = newest ? newest.id : (blank() || newChat()).id;
    showingChat = !newest;
    auto = !newest;  // chats from the cloud arriving later take its place
  }

  function open(id) {
    if (id === null) id = (blank() || newChat()).id;
    auto = false;
    openId = id;
    showingChat = true;
    trouble = trouble && trouble.chatId === id ? trouble : null;
    draw();
    if (parts && parts.input && V.device !== 'phone') parts.input.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- choosing */

  async function setting(name) {
    const chat = chatOf(openId);
    if (!chat) return;
    chat[name] = !chat[name];
    drawBox();
    if (chats.has(chat.id)) await persist(chat);
  }

  function chooseModel() {
    const chat = chatOf(openId);
    if (!chat) return;
    const per = (r) => `$${r.input.toFixed(2)} in · $${r.output.toFixed(2)} out a million tokens`;
    const cents = (d) => `${(d * 100).toFixed(d < 0.001 ? 2 : 1)}¢`;
    const current = modelOf(modelFor(chat)).id;  // (Gemini Smart, or any other "gemini..." id as Gemini Fast)
    // Gemini first; Claude's only while it's switched on (Settings > AI: "Use Claude too").
    const on = V.ai.claudeOn();
    const offered = [...MODELS.filter((m) => m.provider === 'gemini'), ...(on ? MODELS.filter((m) => m.provider !== 'gemini') : [])];
    const sheet = V.sheet({
      title: 'Model',
      content: [V.h('div.model-choices', {}, offered.map((m) => {
        const r = V.ai.rates(m.id);
        const typical = (1500 * r.input + 600 * r.output) / 1e6;
        const costLine = m.free ? 'Free — needs a free Google key (Settings > AI)' : `About ${cents(typical)} a short answer · ${per(r)}`;
        return V.h('button.model-choice' + (m.id === current ? '.on' : ''), { type: 'button', dataset: { model: m.id },
          'aria-current': m.id === current ? 'true' : null, onclick: async () => {
            sheet.close();
            picked.add(chat.id);
            if (current === m.id) return;
            chat.model = m.id;
            drawBox();
            if (chats.has(chat.id)) await persist(chat);
          } },
        V.h('span.mc-text', {}, V.h('span.mc-name', { text: m.name }), V.h('span.mc-about', { text: m.about }),
          V.h('span.mc-cost', { text: costLine })),
        m.id === current ? V.icon('check', 'mc-check') : null);
      })),
      on ? V.h('p.hint', { text: 'Changing it in the middle of a chat is fine: the next answer uses the new one. "Think" (Claude only) makes it think longer: slower, and it costs more.' })
        : V.h('p.hint.chat-claude-off', {}, V.h('span', { text: 'Gemini is free. Claude (paid, with your own key) is switched off. ' }),
          V.h('button.link-btn', { type: 'button', text: 'Use Claude too', onclick: () => { sheet.close(); V.ai.setUp('claude'); } }))],
    });
  }

  function pickNotes() {
    const id = openId;
    const draft = draftOf(id);
    const picked = new Map(draft.notes.map((n) => [n.id, n]));
    const all = [...V.data.notes.values()].filter((n) => !n.deleted && !n._purge && !(n.extra && n.extra.is_template))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const search = V.h('input.field.chat-note-search', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' });
    const list = V.h('div.chat-note-list');
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const shown = all.filter((n) => !q || V.noteTitle(n).toLowerCase().includes(q) || (!n.locked && (n.body || '').toLowerCase().includes(q)))
        .slice(0, 60);
      V.clear(list, shown.length ? shown.map((n) => {
        const on = picked.has(n.id);
        // A locked note only goes from the note itself, unlocked and showing (ASK_LABEL in its menu).
        const locked = !!n.locked;
        return V.h('button.chat-note-row' + (on ? '.on' : ''), { type: 'button', disabled: locked,
          title: locked ? `Locked: open the note, unlock it, then choose "${ASK_LABEL}" in its menu` : null,
          'aria-pressed': String(on), onclick: () => {
            if (picked.has(n.id)) picked.delete(n.id);
            else picked.set(n.id, { id: n.id, title: V.noteTitle(n), text: n.body || '' });
            fill();
          } },
        V.h('span.tick', {}, V.icon('check')), V.icon(n.locked ? 'lock' : 'notes'),
        V.h('span.chat-note-name', { text: V.noteTitle(n) }),
        V.h('span.chat-note-when', { text: locked ? 'Locked' : V.ago(n.updated_at) }));
      }) : V.h('p.hint', { text: 'No notes found.' }));
    };
    search.addEventListener('input', fill);
    fill();
    V.sheet({
      title: 'Ask about a note',
      content: [search, list, V.h('p.hint', { text: 'The note\'s words go with your message, and stay in this chat.' })],
      actions: [{ label: 'Cancel' }, { label: 'Attach', kind: 'primary', onClick: () => {
        draft.notes = [...picked.values()].map((n) => ({ ...n, text: String(n.text).slice(0, 200000) }));
        if (openId === id) drawBox();
      } }],
    });
  }

  /* A picture or file already in Vault (in a note, sent, or in Vault Drive), fetched and attached like a new one. */
  function fromVault() {
    const items = [];
    for (const note of V.data.notes.values()) {
      if (note.deleted || note._purge || note.locked) continue;
      for (const a of note.attachments || []) {
        if (a.path && a.kind !== 'ink' && a.kind !== 'voice') items.push({ path: a.path, name: a.name || 'file', mime: a.mime || '', size: a.size || 0, where: V.noteTitle(note), at: note.updated_at || '' });
      }
    }
    for (const t of V.data.transfers.values()) {
      if (t.deleted || t._purge || !t.path || t.kind !== 'file') continue;
      items.push({ path: t.path, name: t.name || 'file', mime: t.mime || '', size: t.size || 0, at: t.created_at || '',
        where: t.to_device === 'drive' ? 'Vault Drive' : t.from_device === V.device ? 'Sent' : 'Received' });
    }
    items.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const sheet = V.sheet({
      title: 'From Vault',
      content: items.length ? V.h('div.chat-note-list', {}, items.slice(0, 80).map((item) => V.h('button.chat-note-row', {
        type: 'button', onclick: async () => {
          sheet.close();
          try {
            const blob = item.size && item.size < 6 * 1024 * 1024 ? await V.cloud.blob(item.path)
              : await (await fetch(await V.cloud.link(item.path))).blob();
            attach([new File([blob], item.name, { type: item.mime || blob.type || V.format.typeOf(item.name) || '' })]);
          } catch (error) {
            V.toast(`${item.name} couldn't be fetched (are you online?).`, { kind: 'err' });
          }
        } }, V.icon(/^image\//.test(item.mime) ? 'image' : 'file'), V.h('span.chat-note-name', { text: item.name }),
      V.h('span.chat-note-when', { text: item.where })))) : V.h('p.hint', { text: 'No pictures or files in Vault yet.' }),
    });
  }

  function saveMenu(anchor, chat, turn) {
    V.menu(anchor, [
      { label: 'Save to Inbox', icon: 'notes', onClick: () => saveNote(chat, turn, V.notes.inbox()) },
      { label: 'Choose a folder...', icon: 'folder', onClick: async () => {
        const folder = await V.organise.chooseFolder({ title: 'Save to' });
        if (folder) saveNote(chat, turn, folder);
      } },
    ]);
  }

  async function saveNote(chat, turn, folder, body = textOf(turn)) {
    try {
      const note = await V.cloud.save('notes', V.notes.blankNote({ folder_id: folder ? folder.id : null, title: chat.title || 'From Chat', body }));
      V.toast(`Saved to ${folder ? folder.name : 'your notes'}`, { action: 'Open', onAction: () => { V.go('notes'); V.notes.open(note.id); } });
    } catch (error) {
      V.problem(error);
    }
  }

  /* "Send to…": the answer saved as a note in the Inbox, like "Save to Inbox", marked for one of the owner's other
     devices (js/send.js knows which there are), where js/arrivals.js says it came. It's an ordinary note that syncs
     like any other: nothing is sent on another device's behalf. */
  function sendMenu(anchor, chat, turn) {
    const named = (to) => V.deviceName(to).charAt(0).toUpperCase() + V.deviceName(to).slice(1);  // "Your phone"
    V.menu(anchor, V.send.targets().map((to) => ({ label: named(to), icon: V.deviceIcon(to),
      onClick: () => sendTo(chat, turn, to) })));
  }

  async function sendTo(chat, turn, to) {
    try {
      const inbox = V.notes.inbox();
      await V.cloud.save('notes', V.notes.blankNote({ folder_id: inbox ? inbox.id : null, title: chat.title || 'From Chat',
        body: textOf(turn), extra: { sent: { to, from: V.device, at: new Date().toISOString() } } }));
      V.toast(V.cloud.status === 'offline'
        ? `Saved here. It goes to ${V.deviceName(to)} when you're back online.`
        : `Sent to ${V.deviceName(to)} — it's at the top of your notes there.`);
    } catch (error) {
      V.problem(error);
    }
  }

  async function rename(chat) {
    const name = await V.ask('Rename chat', { value: chat.title || '', ok: 'Rename', label: 'Name' });
    if (name === null || !name.trim()) return;
    chat.title = name.trim().slice(0, 100);
    chat.updated = now();
    if (chats.has(chat.id)) await persist(chat);
    draw();
  }

  async function remove(chat) {
    const sure = await V.confirm('Delete this chat?', `"${chat.title || 'New chat'}" and its files go from all your devices. Notes saved from it stay.`,
      { ok: 'Delete', danger: true });
    if (!sure) return;
    try {
      if (chats.has(chat.id)) await removeChat(chat.id);
      else { unsent.delete(chat.id); drafts.delete(chat.id); }
      if (openId === chat.id) { openId = null; showingChat = false; choose(); }
      V.toast('Chat deleted');
      draw();
    } catch (error) {
      V.toast('The chat couldn\'t be deleted (are you online?).', { kind: 'err' });
    }
  }

  const rowMenu = (anchor, chat) => V.menu(anchor, [
    { label: 'Rename', icon: 'text', onClick: () => rename(chat) },
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(chat) },
  ]);

  const chatMenu = (anchor, chat) => V.menu(anchor, [
    { label: 'Rename', icon: 'text', onClick: () => rename(chat) },
    chat.turns.length ? { label: 'Save the whole chat as a note', icon: 'notes', onClick: () => saveNote(chat, null, V.notes.inbox(), markdown(chat, false)) } : null,
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(chat) },
  ]);

  /* ---------------------------------------------------------------- a note asked about from the note itself */

  async function askAboutOpenNote() {
    const note = V.editor.current();
    if (!note) return;
    const words = V.editor.words();
    if (note.locked) {
      if (words === null) return V.toast('Unlock this note first (its lock button), then ask about it.');
      const sure = await V.confirm('Send a locked note to Chat?', 'Its words go to the AI and are kept in the chat, which isn\'t locked.',
        { ok: 'Send to Chat' });
      if (!sure) return;
    }
    const item = { id: note.id, title: V.noteTitle({ ...note, body: words || '' }), text: String(words || '').slice(0, 200000), locked: !!note.locked };
    await load();
    const chat = newChat();
    draftOf(chat.id).notes = [item];
    openId = chat.id;
    showingChat = true;
    if (V.editor.covering()) V.editor.close();
    V.go('claude');
  }

  V.editor.addTool({ name: 'claude', label: 'Ask in Chat', icon: () => V.icon('spark'), keepCaret: false, onClick: askAboutOpenNote });

  /* ---------------------------------------------------------------- outside the tab */

  /* A chat as Markdown (for Download everything, and "Save the whole chat as a note"). */
  function markdown(chat, heading = true) {
    const lines = heading ? [`# ${chat.title || 'Chat'}`, '', `Chat, started ${new Date(chat.created).toLocaleString()}`, ''] : [];
    for (const turn of chat.turns) {
      const extras = [...(turn.files || []).map((f) => f.name), ...(turn.notes || []).map((n) => `note: ${n.title}`)];
      lines.push('**You:**', '', turn.text || '', ...(extras.length ? ['', `(Attached: ${extras.join(', ')})`] : []), '');
      const who = isGemini(turn.model) ? 'Gemini' : 'Claude';
      const words = turn.state === 'refused' ? `(${who} declined to answer this one.)` : textOf(turn) || '(No answer.)';
      lines.push(`**${who}** (${nameOf(turn.model)}):`, '', words, '', '---', '');
    }
    return lines.join('\n');
  }

  /* Every chat this device has, as Markdown files for the ZIP (js/history.js). `used`: the ZIP's names so far
     (lowercase, as Windows sees them), shared with the notes, so a note in a folder called "Chats" never has the same
     name as a chat. */
  function forBackup(root, safeName, used = new Set()) {
    return listOf().map((chat) => {
      const stem = safeName(chat.title || 'Chat');
      let name = `${root}/Chats/${stem}.md`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${root}/Chats/${stem} (${n}).md`;
      used.add(name.toLowerCase());
      return { name, data: markdown(chat) };
    });
  }

  const filesSize = () => listOf().reduce((sum, chat) => sum + chat.turns.reduce((s, t) => s + (t.files || []).reduce((x, f) => x + (f.size || 0), 0), 0), 0);

  V.on('signed-out', () => {
    chats = null; index = null; unsent.clear(); drafts.clear(); picked.clear(); defaulted.clear(); openId = null; stopPump();
    [...soon.keys()].forEach(forgetSoon);
  });
  // The key check answered (wherever it was asked for), or "Use Claude too" changed: the box says which model now.
  V.on('ai', () => {
    retarget();
    // The free Gemini set up meanwhile (here, or seen from another device): "set it up first" is old news.
    if (trouble && trouble.kind === 'nokey' && V.ai.has('gemini') && isGemini(modelFor(chatOf(trouble.chatId)))) trouble = null;
    if (root && root.isConnected && root.dataset.tab === 'claude') drawBox();
  });
  // A waiting message is tried again whenever the network might be back: online, the page shown or focused, the app
  // coming to the front, and the gentle timer. The cloud is pulled first, so a turn another device answered or
  // claimed is seen before this one acts on it.
  async function wake() {
    if (!chats) return;
    await refresh().catch(() => {});
    if (V.ai.lacksGemini()) await V.ai.recheck();  // (the free key set up on another device meanwhile?)
    await pump().catch(() => {});
  }
  window.addEventListener('online', () => wake());
  window.addEventListener('focus', () => wake());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  V.on('back', () => wake());

  return {
    render,
    refresh: () => refresh().catch(() => {}),
    load,
    forBackup,
    filesSize,
    ASK_LABEL,
    open,
    askAbout: askAboutOpenNote,
    MODELS,
    takeDrop: (list) => {
      if (V.tab() !== 'claude' || !openId || tooOld(chatOf(openId))) return false;
      attach(list);
      return true;
    },
    dropText: () => (V.tab() === 'claude' ? 'Drop to attach to your message' : ''),
    busy: () => !!busy || !!sendingId || sendingTurns.size > 0,  // (an answer coming, or a message getting ready to go)
    waiting: waitingCount,
    retryWaits,  // (tests shorten them)
  };
})();
