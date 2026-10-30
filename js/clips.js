/* Vault: the shared clipboard. The newest 30 bits of copied text, from any device (the clips table keeps them).
   On the PC the app watches the clipboard itself (vault/desktop.py: never what password managers mark private, or
   anything that looks like a password or a key) and puts what the others share on it; both can be switched off in
   Settings. A phone or a Chromebook (any browser: 'web' in util.js's V.device) can only touch its clipboard while
   Vault is in front, so with "Keep this clipboard in step" on, that's when it happens: something new copied here goes
   to the others, else the newest from elsewhere is put on this clipboard, ready to paste (and has the focus: one that
   can't go on yet is tried again at the next click or key in Vault, then a card offers Copy). When both happened since
   Vault last looked (a clipboard has no times, so which is newer can't be told), neither goes over the other: a card
   offers Copy, and Send for what's here. Without it there's a button, and a toast when another device shares
   something. Its clips say where they came from. */
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

  function mayShare(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 20000 || clean.includes('sk-ant-') || GOOGLE_KEY.test(clean)) return false;
    const words = clean.replace(LINKS, ' ');  // a long web address isn't a key
    if (CUE.test(words) || KEY.test(words) || (words.match(CARD) || []).some(luhn)) return false;
    // A short run of letters, digits and symbols with no spaces is how passwords look.
    return !(!/\s/.test(clean) && clean.length >= 8 && /\d/.test(clean) && /[A-Za-z]/.test(clean)
      && /[^A-Za-z0-9]/.test(clean) && !/^(?:https?:\/\/|www\.)/i.test(clean) && !clean.includes('@'));
  }

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
  const stepping = () => canStep() && stored(AUTO) === 'on';
  const inFront = () => !V.away() && document.hasFocus();

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
     clipboard has no times, so which is newer can't be told. Neither goes over the other by itself (what's here isn't
     sent to the others either, where it would go over that device's copy): a card offers Copy for the clip, and Send
     for what's here. Neither it nor anything else Vault knows of now is put here by itself after that. */
  function clash(clip, here) {
    if (unwritten) forget(unwritten);
    wrote(null, newestKnown());  // (it, and whatever else came: something sent here is offered on its own card)
    V.notice({
      title: `From ${named(clip.from_device)}`, text: clip.text.trim().slice(0, 200), icon: 'copy', ms: 15000,
      lines: [{ text: 'Not copied: you copied something here too' }],
      actions: [
        { label: 'Copy', kind: 'primary', icon: 'copy', onClick: async () => {
          await V.copy(clip.text, { cloud: true });
          V.toast('Copied');
        } },
        mayShare(here) ? { label: 'Send mine', icon: 'upload', onClick: () => share(here) } : null,
      ],
    });
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
     over them, and nothing from before), or when the cloud's back if they're still what's on this clipboard. */
  function copied(text, { cloud = false } = {}) {
    const clean = String(text || '').trim();
    if (cloud || !stepping() || !clean) {
      if (clean || cloud) wrote(clean);
      return;
    }
    if (print(clean) === stored(SEEN)) return;  // (copied again: it went already)
    wrote(clean);
    lookedNow();
    if (mayShare(clean)) sendMine(clean);
  }

  let mine = null;  // Vault's own words that couldn't go up yet (only the newest)
  function sendMine(text, { now = true } = {}) {
    mine = text;
    V.cloud.insertClip(text).then((shared) => {
      if (mine === text) mine = null;
      // (Sent just now: the cloud's time on them is when they were copied. Sent later, when the cloud was back: not.)
      if (now && shared && shared.created_at) wrote(null, shared.created_at);
    }, () => { /* when the cloud's back */ });
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

  let busy = null;
  /* Vault came to the front: what was copied here since the last look goes to the others; if nothing was, the newest
     from elsewhere is put here. If both came since the last look, a card offers both (clash). Never waits for the
     cloud: a write that comes meanwhile (something sent here) isn't held up by a slow network. */
  function step() {
    if (!stepping() || !V.data.user || !inFront() || busy) return busy;
    busy = chain(async () => {
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        offerTap();  // not allowed (no permission yet, or the phone wants a tap): one tap does it
        if (unwritten) offerCopy(unwritten);  // (and one for the clip that's waiting)
        return;
      }
      // The newest clip, if it's from elsewhere and not on this clipboard (nor older than what is).
      const latest = V.data.clips[0];
      const theirs = latest && latest.from_device !== V.device && print(latest.text.trim()) !== stored(SEEN)
        && !older(latest.created_at) ? latest : null;
      const since = !!theirs && cameSince(theirs);
      const fresh = !!here && print(here) !== stored(SEEN);  // copied here (in another app) since the last look
      lookedNow();
      if (fresh) {
        store(SEEN, print(here));
        if (theirs && print(theirs.text.trim()) === print(here)) wrote(null, theirs.created_at);  // the same words
        else if (since) clash(theirs, here);
        else {
          // Copied here after everything Vault knew of when it last looked: the newest, so nothing that came before
          // goes over it; and it goes to the others (the cloud's time on it, once it's there, is newer still).
          wrote(null, newestKnown());
          if (mayShare(here)) {
            V.cloud.insertClip(here).then((shared) => { if (shared && shared.created_at) wrote(null, shared.created_at); },
              () => { /* not shared: it stays here all the same */ });
          }
        }
        return;
      }
      if (theirs) await takeNow(theirs);
      else if (unwritten) forget(unwritten);
    }).finally(() => { busy = null; });
    return busy;
  }

  /* Coming back to Vault: the page shows a moment before it has the focus the clipboard needs, so it looks again a few
     times until it has (each look is one read: Android says so in a little note). */
  let tries = 0;
  let again = null;
  function look() {
    clearTimeout(again);
    tries = 0;
    const go = () => {
      if (!stepping() || !V.data.user) return;
      if (!inFront()) { if (++tries < 6) again = setTimeout(go, 300); return; }
      step();
    };
    go();
  }

  /* A click or a key in Vault while a clip waits: tried again (after that key's own copy, if it was Ctrl+C: newer).
     Its card's Copy too is the way once it's up (a tap there copies it by itself). */
  function chance(event) {
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

  /* The home screen icon's "Send clipboard" (and the Clipboard tab's button): what's on this clipboard goes now. */
  async function sendNow() {
    let here;
    try {
      here = String((await navigator.clipboard.readText()) || '').trim();
    } catch (error) {
      offerTap();
      return;
    }
    if (here) store(SEEN, print(here));
    lookedNow();
    await share(here);
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
    const here = V.device === 'phone' ? 'phone' : V.deviceName(V.device);
    const on = stepping();
    return V.h('div.card.switches.clip-step', {},
      V.h('label.switch-row', {},
        V.h('span.switch-text', {}, V.h('strong', { text: `Keep this ${here}'s clipboard in step` }),
          V.h('span', { text: on ? `Copy on any device, then open Vault here: it's ready to paste. What you copy here goes to your other devices when you open Vault (never passwords or codes).`
            : `Copy on one device, paste on another. A ${here} only lets Vault use the clipboard while Vault is open, so open it for a second after copying.` })),
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
      V.toast('Ready to paste on your other devices');
    } catch (error) {
      V.problem(error);
    }
  }

  async function shareMine() {
    try {
      const text = String((await navigator.clipboard.readText()) || '').trim();
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
    if (!mine) return;
    if (stepping() && V.data.user && print(mine) === stored(SEEN)) sendMine(mine, { now: false });
    else mine = null;  // (something else is on this clipboard since: that's what goes, if anything)
  });

  return {
    render, share, mayShare, step, sendNow, wrote, older, put, tap, copying, copied,
    // What's been put on this clipboard (and the look at it on coming back) finished first.
    settled: () => Promise.all([busy, writing]).then(() => {}, () => {}),
  };
})();
