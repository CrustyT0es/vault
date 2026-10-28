/* Vault: the Claude tab. Chats with Claude: a list of them (newest first) and one open chat, with the model picked per
   chat (Haiku unless the owner picks another), "Think harder" and "Search the web" switches, notes and files to ask
   about, and answers that can be saved as notes.

   Requests go straight from this device to Claude (api.anthropic.com) with the owner's own key (js/ai.js: the key,
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
  const MODELS = [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', short: 'Haiku 5.5', about: 'Quick and cheap. Good for most questions.',
      search: 'web_search_20250305', fallback: false },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', short: 'Sonnet 5.5', about: 'Smarter, for harder homework and longer writing.',
      search: 'web_search_20260209', fallback: true },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', short: 'Opus 5.5', about: 'The smartest everyday model.',
      search: 'web_search_20260209', fallback: true },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', short: 'Fable 5.1', about: 'The most capable, and expensive: keep it for the hardest things.',
      search: 'web_search_20260209', fallback: true },
  ];
  const DEFAULT_MODEL = MODELS[0].id;
  const SYSTEM = [
    'You are Claude, helping the owner of Vault, their own notes app, which they use for school and for everything else. They are a student.',
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
  const NOT_READABLE = 'Claude can\'t read this kind of file here. Save it as a PDF first, then attach it.';
  const enterSends = V.device !== 'phone';  // a keyboard: Enter sends, Shift+Enter is a new line

  let chats = null;      // id -> chat, this device's copy (V.db meta 'chat:<id>')
  let index = null;      // { prints: id -> the cloud file's fingerprint, waiting: ids not up yet }
  let loading = null;
  let refreshing = null;
  const unsent = new Map();  // id -> a chat started here that has no messages yet
  const drafts = new Map();  // chat id -> { text, notes, files }: what's in the box
  let openId = null;
  let showingChat = false;   // a phone shows the list or one chat
  let auto = false;          // the chat open is a new one opened because there were none
  let busy = null;           // the answer coming now: { chatId, turn, controller, pcId, stopped }
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
  const modelOf = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
  /* "Haiku 5.5"; a model the API answered with instead ("claude-opus-4-8") as "Opus 4.8". */
  const nameOf = (id) => {
    const known = MODELS.find((m) => m.id === id);
    if (known) return known.short;
    const [family, ...version] = String(id || 'Claude').replace(/^claude-/, '').split('-');
    return [family.charAt(0).toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ');
  };
  const now = () => new Date().toISOString();
  const valid = (chat) => !!chat && typeof chat === 'object' && typeof chat.id === 'string' && Array.isArray(chat.turns);

  class ChatError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const WORDS = {
    offline: 'Claude can\'t be reached from this network. Your message is kept: try again, or send it from another network.',
    away: 'You\'re offline. Your message is kept: try again when you\'re back online.',
    key: 'Claude didn\'t accept the key. Set it up again in Settings > AI.',
    nokey: 'Set up Claude first: Settings > AI.',
    credit: 'Your Claude account is out of credit. Add some at console.anthropic.com, then try again.',
    busy: 'Claude is busy right now. Your message is kept: try again in a minute.',
    dropped: 'The connection dropped before the answer finished.',
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
        index = { prints: kept.prints || {}, waiting: new Set(kept.waiting || []) };
        chats = map;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  const keepIndex = () => V.db.meta('chats', { ids: [...chats.keys()], prints: index.prints, waiting: [...index.waiting] });

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
        for (const id of [...index.waiting]) {
          const chat = chats.get(id);
          if (!chat) { index.waiting.delete(id); continue; }
          await upload(chat).catch(() => {});
        }
        await keepIndex();
        if (changed) draw();
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
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
    const chat = { format: 1, id: V.uuid(), title: '', created: now(), updated: now(), model: DEFAULT_MODEL, think: false,
      search: false, system: SYSTEM, turns: [] };
    unsent.set(chat.id, chat);
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
      if (file.size > PDF_MOST) throw new ChatError('file', `${name} is too big for Claude (20 MB at most for a PDF).`);
      const pages = await pagesOf(file);
      if (pages > PAGES_MOST) throw new ChatError('file', `${name} has ${pages} pages: Claude reads ${PAGES_MOST} at most.`);
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
        V.toast('That\'s more files than one message to Claude can carry. Start a new chat for this one.', { kind: 'err', ms: 6000 });
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

  /* One turn answered (a new message, or Retry of the last). */
  async function answer(chat, turn, { first = false } = {}) {
    const job = { chatId: chat.id, turn, controller: new AbortController(), pcId: null, stopped: false };
    busy = job;
    trouble = null;
    turn.state = 'answering';
    turn.replies = [];
    turn.problem = '';
    draw();
    let failed = null;
    try {
      for (let n = 0; n < MOST_REPLIES; n++) {
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
    if (failed) {
      const heard = turn.replies.some((r) => r.content.length);
      if (first && !heard && failed.kind !== 'dropped') {
        // Nothing came back: the message goes back in the box, as if it was never sent.
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
          draw();
          return;
        }
      } else {
        turn.state = 'failed';
        turn.problem = failed.message;
      }
    }
    chat.updated = now();
    await persist(chat);
    draw();
  }

  /* The box's words, notes and files sent as the next message. */
  async function send() {
    const id = openId;
    const chat = chatOf(id);
    if (!chat) return;
    const draft = draftOf(id);
    const text = draft.text.trim();
    if (!text && !draft.notes.length && !draft.files.length) return;
    if (busy) return V.toast('Wait for Claude to finish this answer first (or press Stop).');
    if (draft.files.some((f) => f.state !== 'ready')) return V.toast('Wait for the files to finish going up.');
    if (V.desktop && !V.pc.can('chatSend')) { trouble = { chatId: id, kind: 'old', message: WORDS.old }; return drawBox(); }
    const over = await V.ai.overLimit();
    if (over) { trouble = { chatId: id, kind: 'limit', message: over.message }; return drawBox(); }
    if (chats.has(id)) await quickRefresh();
    const current = chatOf(id) || chat;  // (another device may have added to it meanwhile)
    const turn = { id: V.uuid().slice(0, 8), at: now(), text: draft.text.trim(), model: current.model, think: !!current.think,
      search: !!current.search, notes: draft.notes.map((n) => ({ id: n.id, title: n.title })),
      files: draft.files.map((f) => ({ id: f.id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, path: f.path,
        w: f.w, h: f.h, pages: f.pages, tokens: f.tokens })),
      content: contentFor(draft.text.trim(), draft.notes, !!current.search), replies: [], state: 'answering' };
    turn.tools = JSON.stringify(toolsFor(turn));
    sentNotes.set(turn, draft.notes);
    if (!current.title) current.title = titleFrom(turn);
    current.turns.push(turn);
    chats.set(current.id, current);
    unsent.delete(current.id);
    drafts.set(id, { text: '', notes: [], files: [] });
    trouble = null;
    if (parts && parts.input) parts.input.value = '';
    await answer(current, turn, { first: true });
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
    const over = await V.ai.overLimit();
    if (over) { trouble = { chatId: chat.id, kind: 'limit', message: over.message }; return drawBox(); }
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
    const answering = busy && busy.turn === turn;
    const text = textOf(turn);
    const body = V.h('div.chat-reply-body');
    if (turn.state === 'refused') {
      body.append(V.h('p.chat-note', { text: 'Claude declined to answer this one. Try asking it another way.' }));
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
      V.h('h2', { text: 'Ask Claude anything' }),
      V.h('p', { text: 'Homework, ideas, a quick explanation. Attach a note, a picture or a PDF to ask about it, and save any answer as a note.' }));
  }

  function chatRow(chat) {
    const last = chat.turns[chat.turns.length - 1];
    return V.h('div.chat-row' + (chat.id === openId ? '.on' : ''), { dataset: { id: chat.id } },
      V.h('button.chat-row-main', { type: 'button', onclick: () => open(chat.id) },
        V.h('span.chat-row-title', { text: chat.title || 'New chat' }),
        V.h('span.chat-row-meta', { text: [V.ago(chat.updated), nameOf(last ? last.model : chat.model)].join(' · ') })),
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
    const old = V.desktop && !V.pc.can('chatSend');
    const problem = old ? { kind: 'old', message: WORDS.old } : trouble && trouble.chatId === openId ? trouble : null;
    V.clear(parts.trouble, problem ? [V.icon('alert'), V.h('span', { text: problem.message }),
      ['offline', 'away', 'busy', 'bad', 'dropped'].includes(problem.kind) ? V.button('Try again', { onClick: () => send() }) : null,
      ['limit', 'nokey', 'key'].includes(problem.kind) ? V.button('Open Settings', { onClick: () => V.go('settings') }) : null] : []);
    parts.trouble.hidden = !problem;
    parts.trouble.dataset.kind = problem ? problem.kind : '';
    const pdf = draft.files.find((f) => f.kind === 'pdf');
    V.clear(parts.attached,
      draft.files.map((f) => fileChip(f, () => unattach(f))),
      draft.notes.map((n) => noteChip(n, () => { draft.notes = draft.notes.filter((x) => x !== n); drawBox(); })));
    parts.attached.hidden = !draft.files.length && !draft.notes.length;
    parts.hint.textContent = pdf ? pdfHint(pdf, chat.model) : '';
    parts.hint.hidden = !pdf;
    parts.model.querySelector('.chat-model-name').textContent = nameOf(chat.model);
    parts.think.setAttribute('aria-pressed', String(!!chat.think));
    parts.web.setAttribute('aria-pressed', String(!!chat.search));
    parts.input.disabled = old;
    parts.clip.disabled = old;
    const answering = busy && busy.chatId === openId;
    V.clear(parts.go, answering ? V.icon('stop') : V.icon('arrow-up'));
    parts.go.title = answering ? 'Stop' : 'Send';
    parts.go.setAttribute('aria-label', parts.go.title);
    parts.go.classList.toggle('stop', !!answering);
    parts.go.disabled = old || (!answering && (!!busy || (!draft.text.trim() && !draft.files.length && !draft.notes.length)));
  }

  function grow() {
    if (!parts || !parts.input) return;
    parts.input.style.height = 'auto';
    parts.input.style.height = Math.min(parts.input.scrollHeight + 2, 200) + 'px';
  }

  function buildBox() {
    const input = V.h('textarea.chat-input', { rows: '1', placeholder: 'Ask Claude anything', 'aria-label': 'Message to Claude',
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
    parts.go.disabled = (V.desktop && !V.pc.can('chatSend')) || !!busy || (!draft.text.trim() && !draft.files.length && !draft.notes.length);
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
      V.h('div.page-head.chat-side-head', {}, V.h('h1', { text: 'Claude' }), V.statusPill(),
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
    }).then(() => { choose(); draw(); }).catch(() => {});
    if (!V.desktop) V.ai.check().catch(() => {});
  }

  const blank = () => [...unsent.values()].find((c) => !c.turns.length && !draftOf(c.id).text && !draftOf(c.id).files.length
    && !draftOf(c.id).notes.length);

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
    const sheet = V.sheet({
      title: 'Model',
      content: [V.h('div.model-choices', {}, MODELS.map((m) => {
        const r = V.ai.rates(m.id);
        const typical = (1500 * r.input + 600 * r.output) / 1e6;
        return V.h('button.model-choice' + (m.id === chat.model ? '.on' : ''), { type: 'button', dataset: { model: m.id },
          'aria-current': m.id === chat.model ? 'true' : null, onclick: async () => {
            sheet.close();
            if (chat.model === m.id) return;
            chat.model = m.id;
            drawBox();
            if (chats.has(chat.id)) await persist(chat);
          } },
        V.h('span.mc-text', {}, V.h('span.mc-name', { text: m.name }), V.h('span.mc-about', { text: m.about }),
          V.h('span.mc-cost', { text: `About ${cents(typical)} a short answer · ${per(r)}` })),
        m.id === chat.model ? V.icon('check', 'mc-check') : null);
      })),
      V.h('p.hint', { text: 'Changing it in the middle of a chat is fine: the next answer uses the new one. "Think" makes any of them think longer (slower, and it costs more).' })],
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
        // A locked note only goes from the note itself, unlocked and showing ("Ask Claude about it" in its menu).
        const locked = !!n.locked;
        return V.h('button.chat-note-row' + (on ? '.on' : ''), { type: 'button', disabled: locked,
          title: locked ? 'Locked: open the note, unlock it, then choose "Ask Claude about it" in its menu' : null,
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
      const note = await V.cloud.save('notes', V.notes.blankNote({ folder_id: folder ? folder.id : null, title: chat.title || 'From Claude', body }));
      V.toast(`Saved to ${folder ? folder.name : 'your notes'}`, { action: 'Open', onAction: () => { V.go('notes'); V.notes.open(note.id); } });
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
      if (words === null) return V.toast('Unlock this note first (its lock button), then ask Claude.');
      const sure = await V.confirm('Send a locked note to Claude?', 'Its words go to Claude and are kept in the chat, which isn\'t locked.',
        { ok: 'Send to Claude' });
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

  V.editor.addTool({ name: 'claude', label: 'Ask Claude', icon: () => V.icon('spark'), keepCaret: false, onClick: askAboutOpenNote });

  /* ---------------------------------------------------------------- outside the tab */

  /* A chat as Markdown (for Download everything, and "Save the whole chat as a note"). */
  function markdown(chat, heading = true) {
    const lines = heading ? [`# ${chat.title || 'Chat with Claude'}`, '', `Claude chat, started ${new Date(chat.created).toLocaleString()}`, ''] : [];
    for (const turn of chat.turns) {
      const extras = [...(turn.files || []).map((f) => f.name), ...(turn.notes || []).map((n) => `note: ${n.title}`)];
      lines.push('**You:**', '', turn.text || '', ...(extras.length ? ['', `(Attached: ${extras.join(', ')})`] : []), '');
      const words = turn.state === 'refused' ? '(Claude declined to answer this one.)' : textOf(turn) || '(No answer.)';
      lines.push(`**Claude** (${nameOf(turn.model)}):`, '', words, '', '---', '');
    }
    return lines.join('\n');
  }

  /* Every chat this device has, as Markdown files for the ZIP (js/history.js). */
  function forBackup(root, safeName) {
    const used = new Set();
    return listOf().map((chat) => {
      const stem = safeName(chat.title || 'Chat');
      let name = `${root}/Claude chats/${stem}.md`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${root}/Claude chats/${stem} (${n}).md`;
      used.add(name.toLowerCase());
      return { name, data: markdown(chat) };
    });
  }

  const filesSize = () => listOf().reduce((sum, chat) => sum + chat.turns.reduce((s, t) => s + (t.files || []).reduce((x, f) => x + (f.size || 0), 0), 0), 0);

  V.on('signed-out', () => { chats = null; index = null; unsent.clear(); drafts.clear(); openId = null; });
  window.addEventListener('online', () => { if (chats) refresh().catch(() => {}); });

  return {
    render,
    refresh: () => refresh().catch(() => {}),
    load,
    forBackup,
    filesSize,
    open,
    askAbout: askAboutOpenNote,
    MODELS,
    takeDrop: (list) => {
      if (V.tab() !== 'claude' || !openId || (V.desktop && !V.pc.can('chatSend'))) return false;
      attach(list);
      return true;
    },
    dropText: () => (V.tab() === 'claude' ? 'Drop to attach to your message to Claude' : ''),
    busy: () => !!busy,
  };
})();
