/* Vault: the shared clipboard. The newest 30 bits of copied text, from any device (the clips table keeps them).
   On the PC the app watches the clipboard itself (vault/desktop.py: never what password managers mark private, or
   anything that looks like a password or a key) and puts what the others share on it; both can be switched off in
   Settings. A phone or a Chromebook (any browser: 'web' in util.js's V.device) can only touch its clipboard while
   Vault is in front, so with "Keep this clipboard in step" on (as it is on a phone or a Chromebook unless switched
   off), that's when it happens: something new copied here goes to the others, else the newest from elsewhere is put
   on this clipboard, ready to paste (and has the focus: one that can't go on yet is tried again at the next click or
   key in Vault, then a card offers Copy). When both happened since Vault last looked (a clipboard has no times, so
   which is newer can't be told), neither is put over the other on this clipboard and a card offers Copy for the other
   one; on a phone what was copied here still goes (it's the copy made on the device in hand), on a Chromebook only with
   the card's Send mine. Without it there's a button, and a toast when another device shares something. Its clips say
   where they came from. */
'use strict';

V.clips = (() => {
  let root = null;
  let parts = null;

  // The newest from another device (the PC, the phone or a Chromebook): what this one may want to paste.
  const latestElsewhere = () => V.data.clips.find((c) => c.from_device !== V.device);
  const from = (device) => (V.DEVICES.includes(device) ? V.deviceLabel(device) : 'Another device');
  const named = (device) => (V.DEVICES.includes(device) ? V.deviceName(device) : 'another device');

  /* -- what's never shared by itself (vault/local.py's may_share, for the phone and the Chromebook): anything that
     looks like a password, a key, a card number or a code. Sharing it from the box or the button is still allowed. */
  const LINKS = /(?:https?:\/\/|www\.)\S+/gi;
  // Google's keys ("AQ." and the older "AIza"): a key even inside a web address (?key=...). As jarvis/redact.py's.
  const GOOGLE_KEY = /(?<![A-Za-z0-9_])(?:AQ\.[A-Za-z0-9_.-]{20,}|AIza[A-Za-z0-9_-]{30,})/;
  const KEY = /sk-ant-|(?<![A-Za-z0-9_])(?:AQ\.[A-Za-z0-9_.-]{20,}|AIza[A-Za-z0-9_-]{30,})|\b(?=[\w\-+=]*\d)(?=[\w\-+=]*[A-Za-z])[\w\-+=]{24,}/;  // (as jarvis/redact.py)
  const CARD = /\b\d(?:[ .-]{0,2}\d){12,18}\b/g;
  const CUE = /\b(?:pass ?words?|passcodes?|pwd|pin|wi-?fi (?:key|password)|security code|cvv)\s*(?:is|:|=|-)\s*\S/i;

  function luhn(number) {
    const digits = number.replace(/\D/g, '').split('').map(Number).reverse();
    if (digits.length < 13 || digits.length > 19) return false;
    return digits.reduce((sum, d, i) => sum + (i % 2 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0) % 10 === 0;
  }

  /* Each line (and each cell of a row copied from a spreadsheet) is looked at on its own: a login copied from a note,
     "Netflix\nHunter2!pass", is as secret as the password alone. Spaces make a line words, not a password. Both are
     spelled out here and in vault/local.py alike (never \s, which Python reads differently). */
  const PIECES = /[\t\n\v\f\r\u0085\u2028\u2029]/;
  const SPACES = /[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
  const EDGES = /^[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
  // Anything but letters, digits and - _ . / : is a password's kind of symbol ("Hunter2!pass", "Dragon.Fly#2024").
  const SYMBOL = /[^A-Za-z0-9\-_./:]/;
  // All of it a web address without its https://: a name in small letters, a dot, letters, then its path
  // ("amazon.com/dp/B0CX23V2ZK"; never "J0hn.Smith" or "letmein.2024").
  const ADDRESS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::[0-9]{1,5})?\/[A-Za-z0-9\-_./:]*$/;
  // All of it a file's name, ending in a kind of file people send ("notes_v2.pdf", "IMG_2041.JPG").
  const FILE = new RegExp('^[A-Za-z0-9\\-_./]+\\.(?:pdf|docx?|odt|rtf|txt|md|csv|xlsx?|ods|pptx?|odp|jpe?g|png|gif|webp|'
    + 'heic|heif|bmp|svg|tiff?|mp3|m4a|wav|ogg|flac|aac|mp4|mov|m4v|webm|mkv|avi|zip|rar|7z|epub|json|xml|html?|py|'
    + 'ipynb|js|ts|css|java|cpp|blend|psd)$', 'i');
  // All of it an email address ("reese2@example.org"; never "P@ssw0rd").
  const EMAIL = /^[A-Za-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

  function onePassword(piece) {
    if (piece.length < 8 || SPACES.test(piece) || !/[0-9]/.test(piece) || !/[A-Za-z]/.test(piece)
      || !/[^A-Za-z0-9]/.test(piece) || /^(?:https?:\/\/|www\.)/i.test(piece) || EMAIL.test(piece)) return false;
    if (SYMBOL.test(piece)) return true;
    return !(ADDRESS.test(piece) || FILE.test(piece));
  }

  /* A short run of letters, digits and symbols with no spaces is how passwords look ("Hunter2!pass", "Summer-2024",
     "Fido.2018"), on any line of the words: unless all of that line is an email address, a web address or a file's
     name, and no symbol but - _ . / : is in the last two. As vault/local.py's. */
  const looksLikeAPassword = (clean) => clean.split(PIECES).some((piece) => onePassword(piece.replace(EDGES, '')));

  /* Why words aren't sent by themselves: '' (they may be), 'empty', 'secret' (a password, a key, a card number or a
     code) or 'long' (over 20,000 letters: one tap sends up to 100,000). */
  function whyNot(text) {
    const clean = String(text || '').trim();
    if (!clean) return 'empty';
    if (clean.length > 100000) return 'long';
    if (clean.includes('sk-ant-') || GOOGLE_KEY.test(clean)) return 'secret';
    const words = clean.replace(LINKS, ' ');  // a long web address isn't a key
    if (CUE.test(words) || KEY.test(words) || (words.match(CARD) || []).some(luhn)) return 'secret';
    if (looksLikeAPassword(clean)) return 'secret';
    return clean.length > 20000 ? 'long' : '';
  }
  const mayShare = (text) => !whyNot(text);

  /* -- keeping a phone's or a Chromebook's clipboard in step (per device; only a fingerprint of what was on the
     clipboard is kept, never the words) */
  const AUTO = 'vault-clip-auto';
  const SEEN = 'vault-clip-seen';
  // The cloud's time on what Vault last put on this clipboard (a clip, or something sent here: js/arrive.js, or on the
  // PC js/send.js): the newest wins, so nothing older is put over it.
  const WROTE = 'vault-clip-wrote';
  // The cloud's time on the newest clip Vault knew of when it last saw what's on this clipboard (a look on coming
  // back, or a copy made in Vault): a clip from elsewhere newer than that came since, as may what was copied here.
  const LOOKED = 'vault-clip-looked';
  const stored = (key) => { try { return localStorage.getItem(key); } catch (error) { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* a private window */ } };
  // Never on an iPhone or iPad: Safari only lets a page read the clipboard during a tap (and asks with its own Paste
  // button even then), so it could never read it by itself on coming back. There the Clipboard tab's buttons do it.
  const canStep = () => !V.desktop && !V.deviceKind.ios
    && !!(navigator.clipboard && navigator.clipboard.readText && navigator.clipboard.writeText);
  /* On a phone or a Chromebook it's on unless switched off here (AUTO 'off', kept for good): opening Vault after
     copying is then all it takes. Another browser (a Windows or Mac laptop's) only once it's switched on. One that
     never decided (`undecided`) starts at its first look at the clipboard (begin()). */
  const byDefault = () => V.device === 'phone' || ['android', 'chromebook'].includes(V.deviceKind.kind);
  const undecided = () => canStep() && byDefault() && !['on', 'off'].includes(stored(AUTO));
  // (One that never decided, where Chrome has been told to block Vault from the clipboard: as if switched off.)
  const stepping = () => canStep() && (stored(AUTO) === 'on' || (undecided() && readState !== 'denied'));
  const inFront = () => !V.away() && document.hasFocus();

  /* What the browser says about Vault reading the clipboard by itself: 'granted', 'prompt' or 'denied' (blocked in
     Chrome's site settings for Vault, or "Block" pressed on Chrome's question). null where it can't say (no
     permissions API, or one that doesn't know "clipboard-read"): there it's simply tried, as before. Asked before each
     look, and kept up to date when it changes. */
  let readState = null;
  let readWatch = null;
  async function askRead() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return readState;
    try {
      const status = await navigator.permissions.query({ name: 'clipboard-read' });
      const was = readState;
      readState = status.state;
      if ((was === 'denied') !== (readState === 'denied')) redraw();  // (one that never decided shows off then)
      if (!readWatch && status.addEventListener) {
        readWatch = status;  // (kept, so its 'change' keeps coming)
        status.addEventListener('change', () => { readState = status.state; toldBlocked = false; redraw(); });
      }
    } catch (error) { /* this browser can't say */ }
    return readState;
  }

  /* Blocked, on a device switched on: said once (again only after the setting changes), never a "Send" that can't
     work. The Clipboard tab's box still shares what's pasted into it. */
  let toldBlocked = false;
  function blocked({ again = false } = {}) {
    if ((toldBlocked && !again) || !inFront()) return;
    toldBlocked = true;
    V.toast('Chrome is blocking Vault from your clipboard: allow it in Chrome\'s site settings for Vault (tap the icon '
      + 'left of the address, or Settings > Apps > Vault > Permissions).', { ms: 12000 });
  }

  /* While a locked note's words show (js/editor.js, as the PC's own clipboard sharing pauses then), nothing copied
     here goes to the others by itself: what's on the clipboard is only noted. That lasts until the first look after
     the note is hidden again (kept on this device, so a reload doesn't forget it: never the words), as the clipboard
     may still hold them though the copy itself was never seen. */
  const HUSH = 'vault-clip-hush';
  let quiet = false;
  function hush(on) {
    quiet = !!on;
    if (quiet) store(HUSH, '1');
    else if (stepping() && inFront()) step();  // (closed with Vault in front: what's on the clipboard is noted now)
  }
  const hushed = () => quiet || stored(HUSH) === '1';

  function print(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return (hash >>> 0).toString(36) + '.' + text.length;
  }

  /* Older than (or as old as) what Vault last put on this clipboard, by the cloud's own clock. `same: false`: only
     what's older than it (files sent together share one time: js/send.js copies a later batch of them too). */
  function older(at, { same = true } = {}) {
    const was = Date.parse(stored(WROTE) || '');
    const now = Date.parse(at || '');
    return Number.isFinite(was) && Number.isFinite(now) && (same ? now <= was : now < was);
  }

  /* Vault itself just put `text` on the clipboard (nothing for a picture; null: the fingerprint stays as it was): its
     fingerprint, so coming back to Vault doesn't send it up as if it was copied here, and the cloud's time on it
     (`at`), so nothing older goes over it. */
  function wrote(text, at) {
    if (typeof text === 'string') store(SEEN, text.trim() ? print(text.trim()) : '');
    if (at && Number.isFinite(Date.parse(at)) && !older(at)) store(WROTE, String(at));
    if (unwritten && older(unwritten.clip.created_at)) forget(unwritten);  // something newer went on instead
  }

  const newest = (times) => times.filter((at) => Number.isFinite(Date.parse(at || '')))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  // The newest time on a clip or on something sent here that Vault knows of (util.js's V.sentAt: the sender's clock
  // never makes it later than the cloud's own time on it).
  function newestKnown() {
    return newest([...V.data.clips.map((c) => c.created_at),
      ...[...V.data.transfers.values()].filter((t) => t.to_device === V.device).map(V.sentAt)]);
  }

  /* Vault has just seen what's on this clipboard: the clips it knows of now came before what's copied here next. */
  function lookedNow() {
    store(LOOKED, newest(V.data.clips.map((c) => c.created_at)) || new Date(0).toISOString());
  }

  // A clip that came since Vault last saw this clipboard (never seen it, as after an update: it may have).
  function cameSince(clip) {
    const was = Date.parse(stored(LOOKED) || '');
    return !Number.isFinite(was) || Date.parse(clip.created_at || '') > was;
  }

  /* One write at a time (a clip coming in while something sent here is being copied, and the look at the clipboard on
     coming back first): each one checks, just before it writes, that nothing newer went on meanwhile. */
  let writing = Promise.resolve();
  function chain(job) {
    const next = writing.then(job, job);
    writing = next.catch(() => {});
    return next;
  }

  /* -- a clip "in step" that couldn't go on this clipboard yet. Chrome lets a page write the clipboard only while it's
     in front and has the focus: not while the address bar, another window or a dialog has it (and then the write
     fails). So the newest clip from elsewhere waits, and is tried again the next time Vault gets the focus or is
     clicked or typed in (a click or a key is also the OK some browsers want); if it still can't be written, a card
     offers Copy, which a tap always may. Never over something newer: what was copied here meanwhile goes to the
     others instead (step() reads the clipboard first; when it may be the older of the two, a card offers both:
     clash()), and nothing older than what's on it goes on (older()). */
  let unwritten = null;  // { clip, offered (the card offering Copy came up), notice (that card, while it shows) }

  function forget(entry) {
    if (unwritten === entry) unwritten = null;
    if (entry.notice) entry.notice.close();
  }

  /* The newest clip from elsewhere onto this clipboard, unless it's there already (or something newer is). */
  function take(clip) {
    if (!clip || clip.from_device === V.device || print(clip.text.trim()) === stored(SEEN)) return Promise.resolve(false);
    return chain(() => takeNow(clip));
  }

  async function takeNow(clip) {
    if (unwritten && unwritten.clip.id !== clip.id) forget(unwritten);  // a newer one came: only it is wanted
    if (older(clip.created_at) || print(clip.text.trim()) === stored(SEEN)) {  // a picture sent here after it, say
      if (unwritten) forget(unwritten);
      return false;
    }
    const waited = !!unwritten;
    if (!inFront()) {  // (Chrome wouldn't): the next time Vault has the focus
      if (!unwritten) unwritten = { clip, offered: false, notice: null };
      return false;
    }
    try {
      await navigator.clipboard.writeText(clip.text);
    } catch (error) {
      if (!unwritten) unwritten = { clip, offered: false, notice: null };
      if (waited) offerCopy(unwritten);  // tried again and still no: one tap does it
      return false;
    }
    if (unwritten) forget(unwritten);
    wrote(clip.text, clip.created_at);
    V.toast(`Copied from ${named(clip.from_device)}: ${clip.text.trim().slice(0, 40)}`);
    return true;
  }

  /* The card for a clip Vault couldn't copy by itself: Copy (a tap, which Chrome lets write) puts it there. Once. */
  function offerCopy(entry) {
    if (entry.offered || !inFront()) return;
    entry.offered = true;
    const clip = entry.clip;
    entry.notice = V.notice({
      title: `From ${named(clip.from_device)}`, text: clip.text.trim().slice(0, 200), icon: 'copy', ms: 15000,
      lines: [{ text: 'Vault couldn\'t copy it by itself' }],
      actions: [{ label: 'Copy', kind: 'primary', icon: 'copy', onClick: async () => {
        if (unwritten === entry) unwritten = null;
        await V.copy(clip.text, { cloud: true });
        V.toast('Copied');
      } }],
      onClose: () => { entry.notice = null; },
    });
  }

  /* Something was copied here (in another app) and on another device too, both since Vault last saw this clipboard: a
     clipboard has no times, so which is newer can't be told. Neither is put over the other on this clipboard: a card
     offers Copy for the other one. On a phone what was copied here goes to the others all the same (it's the copy made
     on the device in hand, the one the owner is most likely to want everywhere; unless `send` is false: it went
     already), and the card says when it got there. On a Chromebook it doesn't (its copy may be from the morning, and
     the PC puts what comes over its own newer one): the card offers Send mine. Neither it nor anything else Vault
     knows of now is put here by itself after that. */
  function clash(clip, here, { send = true, held = false } = {}) {
    if (unwritten) forget(unwritten);
    wrote(null, newestKnown());  // (it, and whatever else came: something sent here is offered on its own card)
    const phone = V.device === 'phone';
    const why = held ? 'locked' : whyNot(here);
    const going = phone && send && !why;
    if (phone && send && why) notSent(here, why);
    // What's here is going (or went) to the others: the card says how that went once the cloud has answered.
    const told = going || !send;
    const landing = going ? sendMine(here) : !send && mine && mine.flying && mine.text === here ? mine.landed : null;
    const LINES = {
      kept: 'Not copied: you copied something here too',
      going: 'Not copied: what you copied here is on its way to your other devices',
      went: 'Not copied: what you copied here went to your other devices',
      later: 'Not copied: what you copied here goes to your other devices when you\'re back online',
    };
    const card = V.notice({
      title: `From ${named(clip.from_device)}`, text: clip.text.trim().slice(0, 200), icon: 'copy', ms: 15000,
      lines: [{ text: LINES[!told ? 'kept' : landing ? 'going' : 'went'] }],
      actions: [
        { label: 'Copy', kind: 'primary', icon: 'copy', onClick: async () => {
          await V.copy(clip.text, { cloud: true });
          V.toast('Copied');
        } },
        !phone && send && !why ? { label: 'Send mine', icon: 'upload', onClick: () => share(here) } : null,
      ],
    });
    if (landing) landing.then((got) => card.update({ lines: [{ text: LINES[got ? 'went' : 'later'] }] }));
  }

  /* An automatic look found words it won't send by itself (`why`: they look like a password or a code, they're long,
     or a locked note was open: see hush()), but one tap sends them (the owner's choice, as with the box or the
     button). */
  const NOT_SENT = {
    secret: 'Not sent by itself (it looks like a password or code).',
    long: 'Not sent by itself (too long to send by itself).',
    locked: 'Not sent by itself (a locked note was open).',
  };
  function notSent(here, why = 'secret') {
    if (!NOT_SENT[why]) return;
    V.toast(NOT_SENT[why], { action: 'Send', onAction: () => share(here) });
  }

  /* A clip from another device newer than `at` that "in step" puts on this clipboard (now, or the next time Vault is
     in front): that's what will be there. */
  const comingAfter = (at) => stepping() && V.data.clips.some((c) => c.from_device !== V.device
    && Date.parse(c.created_at) > Date.parse(at || ''));

  /* Something sent to this device (js/arrive.js) onto its clipboard: words, or a picture as PNG (the only kind Chrome
     writes; `png` may be a promise, so its turn is kept while it's made). Says 'copied'; 'older' (something newer is on
     the clipboard already, or about to be: that stays); 'away' (Vault isn't in front: nothing is tried, the next time
     it is); 'refused' (the browser wouldn't, in front); or 'failed' (not a picture it could read). With "in step" on,
     what was copied here since Vault last looked is read first: it's newer, so it stays (and goes to the others). */
  function put({ text, png, at }) {
    if (stepping()) step();
    return chain(async () => {
      if (older(at) || comingAfter(at)) return 'older';
      if (!inFront()) return 'away';
      let picture = null;
      if (png) {
        try {
          picture = await png;
        } catch (error) {
          return 'failed';
        }
        if (!(picture instanceof Blob)) return 'failed';
        // Making it took a moment: a Copy pressed meanwhile (or a newer clip) stays on the clipboard.
        if (older(at) || comingAfter(at)) return 'older';
        if (!inFront()) return 'away';
      }
      try {
        if (picture) await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': picture })]);
        else await navigator.clipboard.writeText(text);
      } catch (error) {
        return inFront() ? 'refused' : 'away';
      }
      wrote(picture ? '' : text, at);
      return 'copied';
    });
  }

  /* Copy pressed on a card (js/arrive.js): a tap, which Chrome lets write. Words, or a picture as PNG (`png` may still
     be being made: the write starts now, inside the tap). Says 'copied', 'refused' or 'failed' (not a picture). */
  async function tap({ text, png }) {
    if (!png) {
      await V.copy(String(text || ''), { cloud: true });
      return 'copied';
    }
    copying();
    let made = true;
    const picture = Promise.resolve(png).then((blob) => {
      if (!(blob instanceof Blob)) throw new Error('Not a picture');
      return blob;
    }).catch((error) => { made = false; throw error; });
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': picture })]);
    } catch (error) {
      return made ? 'refused' : 'failed';  // (the clipboard is as it was: so is what Vault knows of it)
    }
    wrote('');  // a picture: no words to find there on coming back
    return 'copied';
  }

  /* Vault is about to copy something itself (a Copy button: util.js's V.copy; Ctrl+C in a note; Copy on a card): the
     newest thing on this clipboard, newer than every clip and arrival Vault knows of, so none of those goes over it.
     Before the write starts, as a picture still being made for the clipboard looks again just before it's written. */
  function copying() {
    wrote(null, newestKnown());
  }

  /* ...and the words are on the clipboard now (only once they are: if the write failed, what's there is as it was;
     copying() came first). `cloud`: they came from the cloud (a clip, something sent here), so "in step" doesn't send
     them up again. Else they're Vault's own words, copied here after everything Vault knows of: with "in step" on they
     go to the other devices now (their time in the cloud is when they were copied, so what was sent after them goes
     over them, and nothing from before), or when the cloud's back if they're still what's on this clipboard. Never
     while a locked note's words show (hush()): then they're only noted. */
  function copied(text, { cloud = false } = {}) {
    const clean = String(text || '').trim();
    if (cloud || !stepping() || !clean) {
      if (clean || cloud) wrote(clean);
      return;
    }
    if (print(clean) === stored(SEEN)) return;  // (copied again: it went already)
    wrote(clean);
    lookedNow();
    if (quiet) return;
    store(HUSH, '');  // (what's on the clipboard now is known: these words, not a locked note's)
    if (mayShare(clean)) sendMine(clean);
  }

  /* This device's words on their way to the others (only the newest): copied here, or in Vault, or shared to Vault
     from the share sheet (`always`). `flying` while the cloud is being asked (`landed`: whether they got there); if it
     couldn't be, they're tried again when it's back (retryMine(), from 'status' below). `after`: the newest clip Vault
     knew of when they were copied. Says (a promise) whether they got there this time. */
  let mine = null;  // { text, always, flying, landed, after }
  let lastSent = null;  // { text, at }: the last of them that got there, and when (performance.now())
  function sendMine(text, { now = true, always = false } = {}) {
    const entry = { text, always, flying: false, landed: null, after: newest(V.data.clips.map((c) => c.created_at)) };
    mine = entry;
    return attempt(entry, { now });
  }

  function attempt(entry, { now }) {
    entry.flying = true;
    entry.landed = V.cloud.insertClip(entry.text).then((shared) => {
      if (mine === entry) mine = null;
      lastSent = { text: entry.text, at: performance.now() };
      // (Sent just now: the cloud's time on them is when they were copied. Sent later, when the cloud was back: not.
      // Shared from the share sheet: they may not be on this clipboard at all.)
      if (now && !entry.always && shared && shared.created_at) wrote(null, shared.created_at);
      return true;
    }, () => {
      entry.flying = false;  // (when the cloud's back)
      return false;
    });
    return entry.landed;
  }

  /* The cloud's back (a sync went through): words that couldn't go are tried again. Shared from the share sheet: they
     go, whatever is on this clipboard now. Copied here: only while Vault is in front (a sync also runs while it's out of
     sight: then at one once it's back), only if a fresh look finds them still on this clipboard (else something was
     copied since: that's what goes, if anything), and only if nothing from another device came since they were copied
     (that's newer: the look puts it here instead, and these words would go over it everywhere with a later time). */
  function retryMine() {
    const entry = mine;
    if (!entry || entry.flying || !V.data.user) return;
    if (entry.always) { attempt(entry, { now: false }); return; }
    if (!stepping()) { mine = null; return; }
    if (!inFront()) return;
    chain(async () => {
      if (mine !== entry || entry.flying || !inFront()) return;
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        return;  // (tried again at the next sync)
      }
      const was = Date.parse(entry.after || '');
      const newer = V.data.clips.some((c) => c.from_device !== V.device
        && (!Number.isFinite(was) || Date.parse(c.created_at || '') > was));
      if (mine !== entry) return;
      if (here !== entry.text || newer) mine = null;
      else attempt(entry, { now: false });
    });
  }

  // On their way right now, or got there a moment ago: a look and a share asked for at the same time (the icon's "Send
  // clipboard", a tap on Send) send them once. (Not words still waiting for the cloud: a tap sends those now.)
  const onItsWay = (text) => (!!mine && mine.flying && mine.text === text)
    || (!!lastSent && lastSent.text === text && performance.now() - lastSent.at < 10000);

  /* What a look found copied here went from here already: on its way, or the newest clip there is (shared from the
     share sheet, say, then copied too). Sending it again would only make a second copy. */
  function sentAlready(text) {
    const newestClip = V.data.clips[0];
    return onItsWay(text)
      || (!!newestClip && newestClip.from_device === V.device && newestClip.text.trim() === text);
  }

  /* Words shared to Vault from Android's share sheet (js/send.js): on the other devices' clipboards at once, as
     "Copy on all my devices" would (sharing them was the tap). Says 'sent', or 'later' when the cloud can't be reached
     now (or hasn't answered within SHARE_WAIT): they go by themselves when it's back. Never anything mayShare refuses
     (the sheet offers that as a choice). Nothing on this clipboard is touched: finding them on it at the next look
     sends nothing again (sentAlready). */
  const SHARE_WAIT = 4000;
  async function shareShared(text) {
    const clean = String(text || '').trim();
    if (!clean || !mayShare(clean)) return 'refused';
    if (lastSent && lastSent.text === clean && performance.now() - lastSent.at < 10000) return 'sent';  // (a look's)
    const sent = sendMine(clean, { always: true });
    const slow = new Promise((done) => setTimeout(() => done(false), SHARE_WAIT));
    return (await Promise.race([sent, slow])) ? 'sent' : 'later';
  }

  /* Ctrl+C or Ctrl+X in Vault itself (a note, a chat): Vault's own words, as with a Copy button. What they are is read
     from the clipboard once the browser has put them there. (Not V.copy's own stand-in for a refused write.) */
  function copyEvent(event) {
    if (event.target && event.target.closest && event.target.closest('[data-vault-copy]')) return;
    copying();
    if (!stepping()) return;
    setTimeout(() => chain(async () => {
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        return;  // (seen as something copied here, the next time Vault looks)
      }
      if (here) copied(here);
    }), 0);
  }
  document.addEventListener('copy', copyEvent);
  document.addEventListener('cut', copyEvent);

  /* The first look on a phone or a Chromebook that never switched "in step" on or off: as switching it on does, what's
     on the clipboard now is where it starts. That was copied before, so it's never sent by itself (one tap sends it:
     it may be what the owner opened Vault for), and nothing Vault knew of before goes over it either (only what comes
     from now on). (Not offered while it may be a locked note's words: hush().) */
  function begin(here, { held = false } = {}) {
    store(SEEN, here ? print(here) : '');
    lookedNow();
    const last = newest(V.data.clips.map((c) => c.created_at));
    if (last) wrote(null, last);
    store(AUTO, 'on');
    redraw();
    if (here && !held && mayShare(here)) {
      V.toast('Your clipboard now goes to your other devices when you open Vault. Send what\'s on it now?',
        { action: 'Send', onAction: () => share(here) });
    }
  }

  let busy = null;
  let missed = false;  // a look on coming back that never got the focus (look(), then chance())
  /* Vault came to the front: what was copied here since the last look goes to the others; if nothing was, the newest
     from elsewhere is put here. If both came since the last look, what's here goes and a card offers the other
     (clash). Never waits for the cloud: a write that comes meanwhile (something sent here) isn't held up by a slow
     network; what couldn't go is sent when the cloud's back (sendMine). Where Chrome blocks Vault from the clipboard,
     nothing is read: one that never decided is as if switched off, one switched on says why once (blocked()). */
  function step() {
    if (!stepping() || !V.data.user || !inFront() || busy) return busy;
    missed = false;
    busy = chain(async () => {
      if ((await askRead()) === 'denied') {
        if (!undecided()) blocked();
        if (unwritten) offerCopy(unwritten);  // (a tap on Copy still writes)
        return;
      }
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        // Not allowed (no permission yet, or the phone wants a tap): one tap does it. Offered each time Vault comes
        // back on one switched on; once on this device for one that never decided (it stays so: it starts at the
        // first look that can read), and never where Chrome said no just now ("Block"): a Send that can't work.
        if ((await askRead()) === 'denied') { if (!undecided()) blocked(); } else if (undecided()) offerTapOnce();
        else offerTap();
        if (unwritten) offerCopy(unwritten);  // (and one for the clip that's waiting)
        return;
      }
      // While a locked note's words show, or at the first look since (they may still be on the clipboard), what's
      // copied here is only noted, never sent by itself (hush()).
      const held = hushed();
      if (!quiet) store(HUSH, '');
      if (undecided()) return begin(here, { held });
      // The newest clip, if it's from elsewhere and not on this clipboard (nor older than what is).
      const latest = V.data.clips[0];
      const theirs = latest && latest.from_device !== V.device && print(latest.text.trim()) !== stored(SEEN)
        && !older(latest.created_at) ? latest : null;
      const since = !!theirs && cameSince(theirs);
      const fresh = !!here && print(here) !== stored(SEEN);  // copied here (in another app) since the last look
      lookedNow();
      if (fresh) {
        store(SEEN, print(here));
        const went = sentAlready(here);
        if (theirs && print(theirs.text.trim()) === print(here)) wrote(null, theirs.created_at);  // the same words
        else if (since) clash(theirs, here, { send: !went, held });
        else {
          // Copied here after everything Vault knew of when it last looked: the newest, so nothing that came before
          // goes over it; and it goes to the others (the cloud's time on it, once it's there, is newer still).
          wrote(null, newestKnown());
          if (went) return;
          const why = held ? 'locked' : whyNot(here);
          if (!why) sendMine(here);
          else notSent(here, why);
        }
        return;
      }
      if (theirs) await takeNow(theirs);
      else if (unwritten) forget(unwritten);
    }).finally(() => { busy = null; });
    return busy;
  }

  /* Coming back to Vault: the page shows a moment before it has the focus the clipboard needs, so it looks again a few
     times until it has (each look is one read: Android says so in a little note). If it never had it by then, the
     next click or key in Vault looks (chance). */
  let tries = 0;
  let again = null;
  function look() {
    clearTimeout(again);
    tries = 0;
    const go = () => {
      if (!stepping() || !V.data.user) return;
      if (!inFront()) {
        if (++tries < 6) again = setTimeout(go, 300);
        else missed = true;
        return;
      }
      step();
    };
    go();
  }

  /* A click or a key in Vault after a look that never got the focus: it looks now. And while a clip waits: tried again
     (after that key's own copy, if it was Ctrl+C: newer). Its card's Copy too is the way once it's up (a tap there
     copies it by itself). */
  function chance(event) {
    if (missed) {
      missed = false;
      setTimeout(() => { if (stepping()) step(); }, 0);
      return;
    }
    if (!unwritten) return;
    const card = unwritten.notice && unwritten.notice.el;
    if (card && event && card.contains(event.target)) return;
    setTimeout(() => { if (unwritten && stepping()) step(); }, 0);
  }
  document.addEventListener('pointerdown', chance, true);
  document.addEventListener('keydown', chance, true);

  // When reading by itself isn't allowed, a tap is: offered once each time Vault comes back.
  let offered = false;
  function offerTap() {
    if (offered) return;
    offered = true;
    V.toast('Send what you copied to your other devices?', { action: 'Send', onAction: shareMine });
  }

  // ...and on a phone or a Chromebook that never switched "in step" on (it may never be allowed): once on this device.
  const TAP_OFFERED = 'vault-clip-tap-offered';
  let tapOffered = false;
  function offerTapOnce() {
    if (tapOffered || stored(TAP_OFFERED) === '1') return;
    tapOffered = true;
    store(TAP_OFFERED, '1');
    offerTap();
  }

  // Until Vault has the focus the clipboard needs (or `ms` went by): it has only just come to the front.
  const inFrontSoon = (ms) => new Promise((done) => {
    const until = performance.now() + ms;
    const check = () => (inFront() || performance.now() >= until ? done() : setTimeout(check, 100));
    check();
  });

  /* The home screen icon's "Send clipboard" (at the start, or with Vault already open: js/start.js): what's on this
     clipboard goes now, as the newest (nothing from elsewhere is put over it). After a look that's going on (one at a
     time), so what that look sent isn't sent twice. */
  async function sendNow() {
    await inFrontSoon(2000);
    return chain(async () => {
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        if ((await askRead()) === 'denied') blocked({ again: true });  // (asked for: said each time)
        else offerTap();
        return;
      }
      if (here && onItsWay(here)) return V.toast('Ready to paste on your other devices');
      if (here) {
        store(SEEN, print(here));
        wrote(null, newestKnown());
      }
      lookedNow();
      share(here);  // (not waited for: nothing else on this clipboard waits for the cloud)
    });
  }

  async function turnOn() {
    try {
      const here = String((await navigator.clipboard.readText()) || '').trim();
      store(SEEN, here ? print(here) : '');
      lookedNow();
    } catch (error) {
      return V.toast('Vault wasn\'t allowed to use the clipboard. Allow it in Chrome\'s site settings for Vault, then try again.');
    }
    store(AUTO, 'on');
    redraw();
    if (!(await take(V.data.clips[0]))) V.toast('On. Copy something on another device, then open Vault here.');
  }

  // Drawn again only while the Clipboard tab is showing (the tabs share one page).
  const redraw = () => { if (root && root.isConnected && root.dataset.tab === 'clips') render(root); };

  function stepCard() {
    if (!canStep()) return null;
    // ("Keep this phone's / Chromebook's / browser's clipboard": V.deviceName would say "this your Chromebook's".)
    const here = V.device === 'phone' ? 'phone' : V.deviceLabel(V.device) === 'Chromebook' ? 'Chromebook' : 'browser';
    const on = stepping();
    return V.h('div.card.switches.clip-step', {},
      V.h('label.switch-row', {},
        V.h('span.switch-text', {}, V.h('strong', { text: `Keep this ${here}'s clipboard in step` }),
          V.h('span', { text: on ? `Copy on any device, then open Vault here: it's ready to paste. What you copy here goes to your other devices when you open Vault (never passwords or codes).`
            : `Off: after copying, open Vault and tap Share my clipboard. Switched on, opening Vault for a second is enough (a ${here} only lets Vault use the clipboard while Vault is open).` })),
        V.h('input.switch', { type: 'checkbox', checked: on, 'aria-label': `Keep this ${here}'s clipboard in step`, onchange: (event) => {
          if (event.target.checked) { event.target.checked = false; turnOn(); } else { store(AUTO, 'off'); redraw(); }
        } })));
  }

  async function share(text) {
    const clean = String(text || '').trim();
    if (!clean) return V.toast('The clipboard is empty.');
    if (clean.length > 100000) return V.toast('That\'s too much text for the clipboard. Send it from the Send tab.');
    try {
      await V.cloud.insertClip(clean);
      if (mine && mine.text === clean && !mine.flying) mine = null;  // (waiting for the cloud: it's there now)
      V.toast('Ready to paste on your other devices');
    } catch (error) {
      V.problem(error);
    }
  }

  async function shareMine() {
    try {
      const text = String((await navigator.clipboard.readText()) || '').trim();
      if (text && onItsWay(text)) return V.toast('Ready to paste on your other devices');  // (a look sent it just now)
      if (text) store(SEEN, print(text));  // so coming back doesn't send it again
      lookedNow();
      await share(text);
    } catch (error) {
      V.toast('Vault wasn\'t allowed to read the clipboard. Paste into the box below instead.');
      if (parts) parts.paste.focus();
    }
  }

  function item(clip) {
    const mineHere = clip.from_device === V.device;
    return V.h('div.clip', {},
      V.h('div.clip-from', { dataset: { from: clip.from_device } }, V.icon(V.deviceIcon(clip.from_device)),
        V.h('span', { text: from(clip.from_device) + ' · ' + V.ago(clip.created_at) })),
      V.h('div.clip-text', { text: clip.text.length > 800 ? clip.text.slice(0, 800) + '...' : clip.text }),
      V.h('div.clip-actions', {},
        V.button(mineHere ? 'Copy' : 'Copy here', { icon: 'copy', kind: mineHere ? 'quiet' : '', onClick: async () => {
          await V.copy(clip.text, { cloud: true }); V.toast('Copied');
        } }),
        V.isLink(clip.text) ? V.button('Open', { icon: 'open', kind: 'quiet', onClick: () => {
          if (V.desktop) V.pc.call('openLink', { url: clip.text.trim() }).catch(V.problem);
          else window.open(clip.text.trim(), '_blank', 'noopener');
        } }) : null));
  }

  function switches() {
    if (!V.desktop || !V.prefs) return null;
    const toggle = (name, label, hint) => V.h('label.switch-row', {},
      V.h('span.switch-text', {}, V.h('strong', { text: label }), V.h('span', { text: hint })),
      V.h('input.switch', { type: 'checkbox', checked: V.prefs[name], onchange: async (event) => {
        V.prefs[name] = event.target.checked;
        await V.pc.call('setPref', { name, value: event.target.checked }).catch(V.problem);
      } }));
    return V.h('div.card.switches', {},
      toggle('clipboardShare', 'Share what I copy on this PC', 'Not passwords, keys or what password managers hide'),
      toggle('clipboardReceive', V.send.targets().includes('web') ? `Copy what my phone and ${V.deviceName('web')} share`
        : 'Copy what my phone shares', 'Straight onto this PC\'s clipboard'));
  }

  function draw() {
    if (!parts || !root || !root.isConnected || root.dataset.tab !== 'clips') return;
    const latest = latestElsewhere();
    V.clear(parts.latest, latest ? V.h('div.card.latest', {},
      V.h('h2.section', { text: `Latest from ${V.DEVICES.includes(latest.from_device) ? V.deviceName(latest.from_device) : 'another device'}` }),
      item(latest)) : V.h('div.card.latest.empty-latest', {},
      V.h('p', { text: V.desktop ? 'Nothing from your phone yet. On the phone, open Vault > Clipboard > Share my clipboard.'
        : 'Nothing from your PC yet. Copy something there and it shows up here.' })));
    V.clear(parts.history, V.data.clips.length ? V.data.clips.map(item) : null);
  }

  function render(container) {
    root = container;
    const paste = V.h('textarea.field', { rows: 2, placeholder: V.desktop ? 'Paste here to send it to your phone\'s Vault' : 'Or paste here', 'aria-label': 'Text to share' });
    parts = { latest: V.h('div'), history: V.h('div.clips'), paste };
    V.clear(container, V.h('div.page', {},
      V.h('div.page-head', {}, V.h('h1', { text: 'Shared clipboard' }), V.statusPill()),
      switches(),
      stepCard(),
      parts.latest,
      V.desktop ? null : V.button('Share my clipboard with the PC', { kind: 'primary wide-btn', icon: 'upload', onClick: shareMine }),
      V.h('div.send-row', {}, paste, V.button('Share', { icon: 'send', onClick: () => { share(paste.value); paste.value = ''; } })),
      V.h('h2.section', { text: 'Recent' }),
      parts.history));
    draw();
  }

  let looked = false;  // the first look comes once the clips are in, after starting
  V.on('data', (table) => {
    if (table !== 'clips') return;
    draw();
    if (!looked && V.data.user) { looked = true; step(); }
  });
  V.on('back', look);
  V.on('away', () => { offered = false; clearTimeout(again); });
  window.addEventListener('focus', look);
  V.on('clip-in', (clip) => {
    if (clip.from_device === V.device) return;
    const name = named(clip.from_device);
    if (V.desktop) {
      // (Not over something newer that was sent here and copied: js/send.js's arrivals.)
      if (V.prefs && V.prefs.clipboardReceive && !older(clip.created_at)) {
        V.pc.setClipboard(clip.text).then(() => {
          wrote(clip.text, clip.created_at);
          return V.pc.notify(`Copied from ${name}`, clip.text.slice(0, 120));
        }).catch(() => {});
      }
    } else if (stepping()) {
      take(clip);  // (not in front: it waits for the next time Vault is)
    } else if (!V.away()) {
      V.toast(`${name.charAt(0).toUpperCase() + name.slice(1)} copied: ${clip.text.slice(0, 60)}`,
        { action: 'Copy', onAction: () => V.copy(clip.text, { cloud: true }) });
    }
  });

  // What the PC copied while the cloud couldn't be reached goes when it's back (only the newest).
  let unsent = null;
  async function sendCopied(text) {
    unsent = text;
    try {
      const shared = await V.cloud.insertClip(text);
      if (unsent === text) unsent = null;
      // Copied on the PC: the newest there, so a file sent a moment earlier isn't put over it.
      if (shared && shared.created_at) wrote(text, shared.created_at);
    } catch (error) { /* tried again when the cloud's back */ }
  }
  V.on('pc:clipboard', ({ text }) => { if (V.prefs && V.prefs.clipboardShare && V.data.user) sendCopied(text); });
  V.on('status', (state) => {
    if (state !== 'synced' && state !== 'held') return;
    if (unsent) sendCopied(unsent);
    retryMine();
  });

  return {
    render, share, mayShare, step, sendNow, shareShared, wrote, older, put, tap, copying, copied,
    quiet: hush,  // (js/editor.js, while a locked note's words show)
    // What's been put on this clipboard (and the look at it on coming back) finished first.
    settled: () => Promise.all([busy, writing]).then(() => {}, () => {}),
  };
})();
