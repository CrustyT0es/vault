/* Vault: the shared clipboard. The newest 30 bits of copied text, from either device (the clips table keeps them).
   On the PC the app watches the clipboard itself (vault/desktop.py: never what password managers mark private, or
   anything that looks like a password or a key) and puts what the phone shares on it; both can be switched off in
   Settings. A phone can't watch its clipboard, so there it's a button, and a toast when the PC shares something. */
'use strict';

V.clips = (() => {
  let root = null;
  let parts = null;

  const latestFrom = (device) => V.data.clips.find((c) => c.from_device === device);

  async function share(text) {
    const clean = String(text || '').trim();
    if (!clean) return V.toast('The clipboard is empty.');
    if (clean.length > 100000) return V.toast('That\'s too much text for the clipboard. Send it from the Send tab.');
    try {
      await V.cloud.insertClip(clean);
      V.toast(`Shared with ${V.otherName}`);
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
      V.h('div.clip-from', {}, V.icon(clip.from_device === 'pc' ? 'pc' : 'phone'),
        V.h('span', { text: (clip.from_device === 'pc' ? 'PC' : 'Phone') + ' · ' + V.ago(clip.created_at) })),
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
      toggle('clipboardReceive', 'Copy what my phone shares', 'Straight onto this PC\'s clipboard'));
  }

  function draw() {
    if (!parts || !root || !root.isConnected || root.dataset.tab !== 'clips') return;
    const latest = latestFrom(V.other);
    V.clear(parts.latest, latest ? V.h('div.card.latest', {},
      V.h('div.section', { text: `Latest from ${V.otherName}` }),
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
      V.h('h1', { text: 'Shared clipboard' }),
      switches(),
      parts.latest,
      V.desktop ? null : V.button('Share my clipboard with the PC', { kind: 'primary wide-btn', icon: 'upload', onClick: shareMine }),
      V.h('div.send-row', {}, paste, V.button('Share', { icon: 'send', onClick: () => { share(paste.value); paste.value = ''; } })),
      V.h('h3.section', { text: 'Recent' }),
      parts.history));
    draw();
  }

  V.on('data', (table) => { if (table === 'clips') draw(); });
  V.on('clip-in', (clip) => {
    if (clip.from_device === V.device) return;
    if (V.desktop) {
      if (V.prefs && V.prefs.clipboardReceive) {
        V.pc.setClipboard(clip.text).then(() => V.pc.notify('Copied from your phone', clip.text.slice(0, 120))).catch(() => {});
      }
    } else if (!document.hidden) {
      V.toast('Your PC copied: ' + clip.text.slice(0, 60), { action: 'Copy', onAction: () => V.copy(clip.text) });
    }
  });
  V.on('pc:clipboard', ({ text }) => { if (V.prefs && V.prefs.clipboardShare && V.data.user) V.cloud.insertClip(text).catch(() => {}); });

  return { render, share };
})();
