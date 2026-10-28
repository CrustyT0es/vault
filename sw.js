/* Vault's service worker (the phone): keeps one whole version of the app so it opens with no internet, puts a new
   version in place only when the page says it's a good moment, and takes what Android's share sheet sends to Vault
   (manifest.webmanifest's share_target) into IndexedDB's "shared" store for the page (V.send.takeShared). The cloud
   itself is never cached here: only the app's own files.

   A new version: `python -m vault.publish` writes its build into BUILD (so this file changes with every publish, which
   is what makes the browser install it) and lists every file with its sha256 and size in version.json. This worker
   installs only when version.json is from the same publish and every file matches it, each fetched past the browser's
   own cache (GitHub Pages lets files be kept for 10 minutes, and an update filled from there installed the old files).
   Anything wrong and nothing changes: the old version keeps running and the next check tries again. Then it waits:
   js/update.js says "update-now" at a safe moment (the app in the background, nothing being typed) and reloads. */
'use strict';

const BUILD = '1.4.0-11c35381f851';  // publish.py writes the build here; vault/web's own copy (never published as is) never installs
const CACHE = 'vault-' + BUILD;
const LEGACY = /^vault-1\.0\.\d+$/;  // Vault 1.0.x's caches: its pages can't say "update-now", so it switches itself
const KEPT = /^vault-(\d+(?:\.\d+)+)-[0-9a-f]{12}$/;  // a version kept here since (vault-<version>-<hash>)
const STORES = ['notes', 'folders', 'transfers', 'clips', 'meta', 'outgoing', 'files', 'shared'];

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Whether version a comes before b (1.9.2 before 1.10.0). */
function older(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const step = (x[i] || 0) - (y[i] || 0);
    if (step) return step < 0;
  }
  return false;
}

async function install() {
  const reply = await fetch('version.json', { cache: 'no-store' });
  if (!reply.ok) throw new Error('version.json: ' + reply.status);
  const listing = await reply.json();
  if (listing.build !== BUILD) throw new Error('version.json is from another publish: trying again later');
  // Never back to an older version than one this phone already has (publish.py refuses that too; a rollback is a
  // newer version with the old code).
  const have = (await caches.keys()).map((name) => KEPT.exec(name)).filter(Boolean).map((found) => found[1]);
  if (have.some((version) => older(listing.version, version))) throw new Error('Vault ' + listing.version + ' is older');
  // All at once (one at a time took 9 s at a phone's 150 ms a request: long enough for the app to be closed first).
  const fetched = await Promise.all(Object.entries(listing.files || {}).filter(([path]) => path !== 'sw.js')
    .map(async ([path, want]) => {
      const response = await fetch(path, { cache: 'reload' });
      if (!response.ok) throw new Error(path + ': ' + response.status);
      const body = await response.arrayBuffer();
      if (body.byteLength !== want.size || await sha256(body) !== want.sha256) throw new Error(path + ' doesn\'t match version.json');
      return [path, body, response.headers.get('Content-Type') || ''];
    }));
  const cache = await caches.open(CACHE);
  for (const [path, body, type] of fetched) {
    const kept = () => new Response(body, { headers: { 'Content-Type': type } });
    await cache.put(path, kept());
    if (path === 'index.html') await cache.put('./', kept());
  }
  await cache.put('version.json', new Response(JSON.stringify(listing), { headers: { 'Content-Type': 'application/json' } }));
  // Only once, from Vault 1.0.x: its page can't pick the moment, so this version takes over by itself.
  if ((await caches.keys()).some((name) => LEGACY.test(name))) await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.has(CACHE).then((had) => install().catch(async (error) => {
    if (!had) await caches.delete(CACHE);  // half a version is never left behind
    throw error;
  })));
});

self.addEventListener('message', (event) => {
  const said = event.data || {};
  if (said.vault === 'update-now') self.skipWaiting();
  if (said.vault === 'build' && event.ports && event.ports[0]) event.ports[0].postMessage({ build: BUILD });
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n.startsWith('vault-') && n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

/* Opened without a version number (whatever version the page's db.js has made) and closed straight after, so it
   never fails on a newer database or holds up a newer page's upgrade. */
function keepShared(entry) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vault');
    request.onupgradeneeded = () => {  // only when there's no database yet
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: name === 'meta' || name === 'files' ? 'key' : 'id' });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      try {
        const tx = db.transaction('shared', 'readwrite');
        tx.objectStore('shared').put(entry);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('not kept')); };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

async function shared(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size !== undefined);
  await keepShared({
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '',
    files: files.map((f) => new File([f], f.name || 'file', { type: f.type || 'application/octet-stream' })),
  });
  const open = await self.clients.matchAll({ type: 'window' });
  // A share from Android's share sheet is a navigation: the page it opens takes it. The page it replaces must not
  // (it would take it from IndexedDB and then be gone), so only a share sent by fetch() tells open pages.
  if (request.mode !== 'navigate') for (const client of open) client.postMessage({ vault: 'shared' });
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(shared(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // This version's own files, nothing refreshed in the background: new code only ever comes as a whole checked version.
  event.respondWith(caches.open(CACHE)
    .then((cache) => cache.match(event.request, { ignoreSearch: true }))
    .then((kept) => kept || fetch(event.request)));
});

/* A reminder's notification tapped (js/reminders.js): Vault comes to the front with that note, or opens with it. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
    const page = open.find((client) => 'focus' in client);
    if (page) {
      if (data.id) page.postMessage({ vault: 'open-note', id: data.id });
      return page.focus();
    }
    const own = new URL(String(data.url || './'), self.registration.scope);
    return self.clients.openWindow(own.origin === self.location.origin ? own.href : './');
  }));
});
