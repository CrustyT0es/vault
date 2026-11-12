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
  // (1.22.5) Keys of earlier PINs (their salts: the settings row's extra.pin_old, and a PIN made here by an older Wefty
  // that the cloud's replaced, meta 'pin-orphans') that open notes still sealed with them: found with the PIN typed
  // (the same digits kept) or the old PIN asked for (tryOld). Only ever used to open: a note opened with one is sealed
  // again with the PIN in use now.
  let oldKeys = [];
  // (1.22.5, SEC-03) Wrong PINs, kept on this device (a reload doesn't start them again): after TRIES_FREE in a row,
  // each next try waits, longer each time (WAIT_FIRST, doubling, WAIT_MOST at most).
  const TRIES = 'wefty-pin-tries';
  const TRIES_FREE = 5;
  const WAIT_FIRST = 30000;
  const WAIT_MOST = 3600000;

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

  /* A key for `pin` that opens `check` (made with `salt`), or null. */
  async function keyFor(pin, salt, check) {
    try {
      const tried = await derive(pin, unb64(salt));
      return (await open(tried, check)) === CHECK ? tried : null;
    } catch (error) {
      return null;
    }
  }
  /* The earlier PINs' salts and checks (see oldKeys). */
  async function earlier() {
    const extra = (V.data.settings || {}).extra || {};
    const kept = Array.isArray(extra.pin_old) ? extra.pin_old : [];
    const here = V.db ? (await V.db.meta('pin-orphans').catch(() => null)) || [] : [];
    return [...kept, ...here].filter((one) => one && typeof one.salt === 'string' && typeof one.check === 'string'
      && one.salt !== currentSalt());
  }
  async function findOld(pin) {
    const found = [];
    for (const one of await earlier()) {
      const made = await keyFor(pin, one.salt, one.check);
      if (made) found.push(made);
    }
    return found;
  }

  /* -- wrong PINs (SEC-03) */
  let triesHere = null;  // (the same, in memory, only where storage can't be used: a private window)
  const tries = () => {
    try {
      const kept = JSON.parse(localStorage.getItem(TRIES) || 'null');
      return kept && typeof kept === 'object' ? { n: Number(kept.n) || 0, until: Number(kept.until) || 0 } : { n: 0, until: 0 };
    } catch (error) {
      return triesHere || { n: 0, until: 0 };
    }
  };
  const triesWrite = (value) => {
    triesHere = value;
    try {
      if (value) localStorage.setItem(TRIES, JSON.stringify(value));
      else localStorage.removeItem(TRIES);
    } catch (error) { /* a private window: this page only (triesHere) */ }
  };
  function wrongPin() {
    const n = tries().n + 1;
    const wait = n >= TRIES_FREE ? Math.min(WAIT_MOST, WAIT_FIRST * 2 ** (n - TRIES_FREE)) : 0;
    triesWrite({ n, until: wait ? Date.now() + wait : 0 });
  }
  function rightPin() {
    triesWrite(null);
  }
  /* How long until the PIN can be tried again (0: now). */
  const waitLeft = () => Math.max(0, tries().until - Date.now());
  /* That wait in words: "30 seconds", "2 minutes", "1 hour". */
  function waitWords(ms = waitLeft()) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    return '1 hour';
  }

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

  /* Opens `payload` with the PIN in use now, else an earlier PIN's key: { text, old } (old: it needs sealing again). */
  async function openAny(payload) {
    const current = usable();
    try {
      return { text: await open(current, payload), old: false };
    } catch (error) {
      for (const earlierKey of oldKeys) {
        try { return { text: await open(earlierKey, payload), old: true }; } catch (again) { /* the next one */ }
      }
      throw error;
    }
  }

  return {
    hasPin: () => !!(V.data.settings && V.data.settings.pin_salt && V.data.settings.pin_check),
    unlocked: () => fresh(),
    forget: () => { key = null; keySalt = null; oldKeys = []; },
    touch: () => { if (key) lastUse = Date.now(); },
    waitLeft,
    waitWords,
    /* "Too many wrong PINs. Try again in 2 minutes." while a wait is on, else ''. */
    waitSaid: () => (waitLeft() ? `Too many wrong PINs. Try again in ${waitWords()}.` : ''),
    /* Whether there's an earlier PIN a note may still be sealed with (see tryOld). */
    hasEarlier: async () => (await earlier()).length > 0,

    /* (1.22.5) A new PIN, not used yet: { values: the settings row's new columns, key }. It's used (`adopt`) only
       once the cloud took it (V.cloud.setPin): a PIN the cloud turned down never seals anything. */
    async prepare(pin) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const made = await derive(pin, salt);
      return { values: { pin_salt: b64(salt), pin_check: await seal(made, CHECK) }, key: made };
    },
    adopt(prepared) {
      key = prepared.key;
      keySalt = prepared.values.pin_salt;
      oldKeys = prepared.oldKeys || oldKeys;
      lastUse = Date.now();
      rightPin();
    },
    /* A new PIN used at once (the settings row's new columns), as before 1.22.5: what's left of it is for tests that
       set a PIN up quickly. The app's own ways use prepare, V.cloud.setPin, then adopt; a PIN sent from here by
       V.cloud.saveSettings never goes over the cloud's either (js/cloud.js's unsentPin). */
    async make(pin) {
      const prepared = await this.prepare(pin);
      this.adopt(prepared);
      return prepared.values;
    },

    async unlock(pin) {
      if (waitLeft()) return false;  // (SEC-03: callers say how long first; this is the backstop)
      const settings = V.data.settings || {};
      const tried = settings.pin_salt && settings.pin_check ? await keyFor(pin, settings.pin_salt, settings.pin_check) : null;
      if (!tried) { wrongPin(); return false; }
      rightPin();
      key = tried;
      keySalt = settings.pin_salt;
      lastUse = Date.now();
      oldKeys = await findOld(pin);  // (an earlier PIN of the same digits: its notes open too)
      return true;
    },

    /* (1.22.5) The PIN a note was locked with before (its salt kept in pin_old, or a PIN made here that the cloud's
       replaced): true when it opens one of them. */
    async tryOld(pin) {
      if (waitLeft()) return false;
      const found = await findOld(pin);
      if (!found.length) { wrongPin(); return false; }
      rightPin();
      oldKeys = [...oldKeys, ...found];
      return true;
    },

    async encrypt(text) {
      return seal(usable(), text);
    },

    async decrypt(payload) {
      return (await openAny(payload)).text;
    },
    openAny,

    /* Changing the PIN: every locked note is opened (with the PIN in use, or an earlier one it opens) and sealed again
       with the new one, here, in memory. Nothing is used until the cloud took the new PIN: `adopt(result)` then (see
       js/settings.js). One that can't be opened at all stays as it is. Null when `oldPin` isn't the PIN. */
    async rekey(oldPin, newPin, notes) {
      if (!(await this.unlock(oldPin))) return null;
      const from = keySalt;
      const prepared = await this.prepare(newPin);
      const changed = [];
      for (const note of notes) {
        if (!note.locked || !note.secret) continue;
        let text;
        try { text = (await openAny(note.secret)).text; } catch (error) { continue; }
        changed.push({ ...note, secret: await seal(prepared.key, text) });
      }
      // (the old PIN's key stays for opening only: a note a device that was offline seals with it still opens)
      return { ...prepared, settings: prepared.values, notes: changed, from, oldKeys: [key, ...oldKeys] };
    },

    /* The PIN pad, as a promise of the PIN (or null). `make` asks twice and warns it can't be recovered. */
    askPin({ title = 'Enter your PIN', make = false, hint = '' } = {}) {
      return new Promise((resolve) => {
        let first = null;
        let answer = null;
        const dots = V.h('div.pin-dots');
        const note = V.h('p.hint', {
          text: make ? 'At least 4 digits. Wefty can\'t get locked notes back if you forget it, so pick one you\'ll remember.' : hint,
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
