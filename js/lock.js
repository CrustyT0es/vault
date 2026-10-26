/* Vault: locked notes. A locked note's words are encrypted on the device (AES-GCM, with a key made from the
   owner's PIN by PBKDF2) before they go anywhere; the cloud only ever holds the scrambled text in `secret`.
   The settings row keeps a salt and a short encrypted check, so a PIN can be tested without any note. A forgotten
   PIN can't be got round: that's the point, and setting one says so. Unlocked stays unlocked UNLOCK_MINUTES. */
'use strict';

V.lock = (() => {
  const ROUNDS = 310000;
  const CHECK = 'vault-pin-ok';
  const UNLOCK_MINUTES = 5;
  let key = null;
  let keySalt = null;  // the PIN salt the key was made with: a PIN changed on the other device makes it useless
  let lastUse = 0;

  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  async function derive(pin, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(withKey, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, withKey, new TextEncoder().encode(text));
    const out = new Uint8Array(12 + sealed.byteLength);
    out.set(iv);
    out.set(new Uint8Array(sealed), 12);
    return 'v1:' + b64(out);
  }

  async function open(withKey, payload) {
    if (!payload || !payload.startsWith('v1:')) throw new Error('This locked note is damaged.');
    const bytes = unb64(payload.slice(3));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, withKey, bytes.slice(12));
    return new TextDecoder().decode(plain);
  }

  const currentSalt = () => (V.data.settings || {}).pin_salt || null;
  const fresh = () => !!key && keySalt === currentSalt() && Date.now() - lastUse < UNLOCK_MINUTES * 60000;

  /* Sealing and opening need the key of the PIN in use now (however long ago it was unlocked: an open note stays
     open while it's on screen); asking for the PIN again is down to `unlocked`. */
  function usable() {
    if (!key) throw new Error('Unlock with your PIN first.');
    if (keySalt !== currentSalt()) {
      key = null;
      throw new Error('Your PIN was changed on your other device. Unlock the note again with the new PIN.');
    }
    lastUse = Date.now();
    return key;
  }

  return {
    hasPin: () => !!(V.data.settings && V.data.settings.pin_salt && V.data.settings.pin_check),
    unlocked: () => fresh(),
    forget: () => { key = null; keySalt = null; },
    touch: () => { if (key) lastUse = Date.now(); },

    /* A new PIN: returns the settings row's new values. */
    async make(pin) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const made = await derive(pin, salt);
      const values = { pin_salt: b64(salt), pin_check: await seal(made, CHECK) };
      key = made;
      keySalt = values.pin_salt;
      lastUse = Date.now();
      return values;
    },

    async unlock(pin) {
      const settings = V.data.settings || {};
      try {
        const tried = await derive(pin, unb64(settings.pin_salt));
        if (await open(tried, settings.pin_check) !== CHECK) return false;
        key = tried;
        keySalt = settings.pin_salt;
        lastUse = Date.now();
        return true;
      } catch (error) {
        return false;
      }
    },

    async encrypt(text) {
      return seal(usable(), text);
    },

    async decrypt(payload) {
      return open(usable(), payload);
    },

    /* Changing the PIN: every locked note is opened with the old key and sealed again with the new one. */
    async rekey(oldPin, newPin, notes) {
      if (!(await this.unlock(oldPin))) return null;
      const oldKey = key;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const newKey = await derive(newPin, salt);
      const changed = [];
      for (const note of notes) {
        if (!note.locked || !note.secret) continue;
        changed.push({ ...note, secret: await seal(newKey, await open(oldKey, note.secret)) });
      }
      const settings = { pin_salt: b64(salt), pin_check: await seal(newKey, CHECK) };
      key = newKey;
      keySalt = settings.pin_salt;
      lastUse = Date.now();
      return { settings, notes: changed };
    },

    /* The PIN pad, as a promise of the PIN (or null). `make` asks twice and warns it can't be recovered. */
    askPin({ title = 'Enter your PIN', make = false } = {}) {
      return new Promise((resolve) => {
        let first = null;
        let answer = null;
        const dots = V.h('div.pin-dots');
        const note = V.h('p.hint', {
          text: make ? 'At least 4 digits. Vault can\'t get locked notes back if you forget it, so pick one you\'ll remember.' : '',
        });
        const heading = V.h('p.pin-title', { text: make ? 'Pick a PIN for locked notes' : '' });
        let typed = '';
        const draw = () => {
          V.clear(dots, [...typed].map(() => V.h('span.dot.full')), typed ? null : V.h('span.dot'));
        };
        const press = async (digit) => {
          if (digit === 'back') typed = typed.slice(0, -1);
          else if (digit === 'ok') return submit();
          else if (typed.length < 12) typed += digit;
          draw();
        };
        const submit = () => {
          if (typed.length < 4) { note.textContent = 'At least 4 digits.'; return; }
          if (make && first === null) {
            first = typed; typed = ''; draw();
            heading.textContent = 'Type it once more';
            return;
          }
          if (make && typed !== first) {
            first = null; typed = ''; draw();
            heading.textContent = 'They didn\'t match. Pick a PIN';
            return;
          }
          answer = typed;
          sheet.close();
        };
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];
        const pad = V.h('div.pin-pad', {}, keys.map((k) => V.h('button.pin-key' + (k === 'ok' ? '.go' : ''), {
          type: 'button', onclick: () => press(k), 'aria-label': k === 'back' ? 'Delete' : k === 'ok' ? 'OK' : k,
        }, k === 'back' ? V.icon('back') : k === 'ok' ? V.icon('check') : k)));
        const typing = (event) => {
          if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key); }
          else if (event.key === 'Backspace') { event.preventDefault(); press('back'); }
          else if (event.key === 'Enter') { event.preventDefault(); submit(); }
        };
        document.addEventListener('keydown', typing, true);
        const sheet = V.sheet({
          title, content: [heading, dots, note, pad],
          onClose: () => { document.removeEventListener('keydown', typing, true); resolve(answer); },
        });
        draw();
      });
    },
  };
})();
