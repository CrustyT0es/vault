/* Vault: this device's own copy of everything (IndexedDB), so the app opens at once and works offline.
   notes / folders / transfers / clips: rows as the cloud has them, plus _dirty (changed here, not sent yet).
   meta: small values (when each table was last checked, the PIN's check). outgoing: files waiting for the internet.
   files: pictures already downloaded, by their cloud path. shared: what Android's share sheet handed the app. */
'use strict';

V.db = (() => {
  const STORES = ['notes', 'folders', 'transfers', 'clips', 'meta', 'outgoing', 'files', 'shared'];
  let opening = null;
  let latest = null;  // the connection in use

  /* Opened without a version number (whatever version is there) and upgraded only when a store is missing, so an
     older or newer Vault and the service worker never fail on each other's version; closed when another one needs to
     upgrade it (it would wait for this one otherwise). */
  function connect(version) {
    return new Promise((resolve, reject) => {
      const request = version ? indexedDB.open('vault', version) : indexedDB.open('vault');
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, { keyPath: name === 'meta' || name === 'files' ? 'key' : 'id' });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); if (latest === db) opening = null; };
        latest = db;
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Vault is open in another tab that needs closing first.'));
    });
  }

  function open() {
    if (opening) return opening;
    opening = connect().then((db) => {
      if (STORES.every((name) => db.objectStoreNames.contains(name))) return db;
      const next = db.version + 1;
      db.close();
      return connect(next);
    });
    opening.catch(() => { opening = null; });
    return opening;
  }

  async function run(store, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const request = work(tx.objectStore(store));
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('The save was stopped'));
    });
  }

  return {
    open,
    all: (store) => run(store, 'readonly', (s) => s.getAll()).then((rows) => rows || []),
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
    putMany: (store, values) => run(store, 'readwrite', (s) => { for (const value of values) s.put(value); }),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => run(store, 'readwrite', (s) => s.clear()),
    async meta(key, value) {
      if (value === undefined) {
        const row = await run('meta', 'readonly', (s) => s.get(key));
        return row ? row.value : undefined;
      }
      return run('meta', 'readwrite', (s) => s.put({ key, value }));
    },
    async wipe() {  // signing out: nothing of the owner's stays on the device
      for (const name of STORES) await run(name, 'readwrite', (s) => s.clear());
    },
  };
})();
