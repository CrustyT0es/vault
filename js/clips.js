/* Vault: the shared clipboard. The newest 30 bits of copied text, from any device (the clips table keeps them).
   On the PC the app watches the clipboard itself (vault/desktop.py: never what password managers mark private, or
   anything that looks like a password or a key) and puts what the others share on it; both can be switched off in
   Settings. A phone or a Chromebook (any browser: 'web' in util.js's V.device) can only touch its clipboard while
   Vault is in front, so with "Keep this clipboard in step" on, that's when it happens: something new copied here goes
   to the others, else the newest from elsewhere is put on this clipboard, ready to paste. Without it there's a
   button, and a toast when another device shares something. Its clips say where they came from. */
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
  const KEY = /sk-ant-|\b(?=[\w\-+=]*\d)(?=[\w\-+=]*[A-Za-z])[\w\-+=]{24,}/;
  const CARD = /\b\d(?:[ .-]{0,2}\d){12,18}\b/g;
  const CUE = /\b(?:pass ?words?|passcodes?|pwd|pin|wi-?fi (?:key|password)|security code|cvv)\s*(?:is|:|=|-)\s*\S/i;

  function luhn(number) {
    const digits = number.replace(/\D/g, '').split('').map(Number).reverse();
    if (digits.length < 13 || digits.length > 19) return false;
    return digits.reduce((sum, d, i) => sum + (i % 2 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0) % 10 === 0;
  }

  function mayShare(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 20000 || clean.includes('sk-ant-')) return false;
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
  const stored = (key) => { try { return localStorage.getItem(key); } catch (error) { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch (error) { /* a private window */ } };
  const canStep = () => !V.desktop && !!(navigator.clipboard && navigator.clipboard.readText && navigator.clipboard.writeText);
  const stepping = () => canStep() && stored(AUTO) === 'on';
  const inFront = () => !V.away() && document.hasFocus();

  function print(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return (hash >>> 0).toString(36) + '.' + text.length;
  }

  /* The newest clip from elsewhere onto this clipboard, unless it's there already. */
  async function take(clip) {
    if (!clip || clip.from_device === V.device || print(clip.text.trim()) === stored(SEEN)) return false;
    try {
      await navigator.clipboard.writeText(clip.text);
    } catch (error) {
      return false;  // not in front after all: the next time it is
    }
    store(SEEN, print(clip.text.trim()));
    V.toast(`Copied from ${named(clip.from_device)}: ${clip.text.trim().slice(0, 40)}`);
    return true;
  }

  let busy = null;
  /* Vault came to the front: what was copied here since the last look goes to the others; if nothing was, the newest
     from elsewhere is put here. */
  function step() {
    if (!stepping() || !V.data.user || !inFront() || busy) return busy;
    busy = (async () => {
      let here;
      try {
        here = String((await navigator.clipboard.readText()) || '').trim();
      } catch (error) {
        return;  // not allowed right now
      }
      if (here && print(here) !== stored(SEEN)) {
        store(SEEN, print(here));
        if (mayShare(here)) await V.cloud.insertClip(here).catch(() => {});
        return;
      }
      await take(V.data.clips[0]);
    })().finally(() => { busy = null; });
    return busy;
  }

  async function turnOn() {
    try {
      const here = String((await navigator.clipboard.readText()) || '').trim();
      store(SEEN, here ? print(here) : '');
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
      const text = await navigator.clipboard.readText();
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
          await V.copy(clip.text); V.toast('Copied');
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
  V.on('back', step);
  window.addEventListener('focus', step);
  V.on('clip-in', (clip) => {
    if (clip.from_device === V.device) return;
    const name = named(clip.from_device);
    if (V.desktop) {
      if (V.prefs && V.prefs.clipboardReceive) {
        V.pc.setClipboard(clip.text).then(() => V.pc.notify(`Copied from ${name}`, clip.text.slice(0, 120))).catch(() => {});
      }
    } else if (stepping()) {
      if (inFront()) take(clip);  // else when Vault is next in front
    } else if (!V.away()) {
      V.toast(`${name.charAt(0).toUpperCase() + name.slice(1)} copied: ${clip.text.slice(0, 60)}`,
        { action: 'Copy', onAction: () => V.copy(clip.text) });
    }
  });

  // What the PC copied while the cloud couldn't be reached goes when it's back (only the newest).
  let unsent = null;
  async function sendCopied(text) {
    unsent = text;
    try {
      await V.cloud.insertClip(text);
      if (unsent === text) unsent = null;
    } catch (error) { /* tried again when the cloud's back */ }
  }
  V.on('pc:clipboard', ({ text }) => { if (V.prefs && V.prefs.clipboardShare && V.data.user) sendCopied(text); });
  V.on('status', (state) => { if (state === 'synced' && unsent) sendCopied(unsent); });

  return { render, share, mayShare, step };
})();
