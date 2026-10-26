/* Vault's service worker (the phone): keeps a copy of the app so it opens with no internet, and takes what
   Android's share sheet sends to Vault (manifest.webmanifest's share_target) into IndexedDB's "shared" store for
   the page (V.send.takeShared). The cloud itself is never cached here: only the app's own files. */
'use strict';

const CACHE = 'vault-1.0.0';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'vendor/supabase.js', 'vendor/qrcode.js',
  'js/util.js', 'js/db.js', 'js/lock.js', 'js/cloud.js', 'js/notes.js', 'js/editor.js', 'js/send.js', 'js/clips.js',
  'js/settings.js', 'js/start.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n.startsWith('vault-') && n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

function keepShared(entry) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vault', 1);
    request.onupgradeneeded = () => {
      for (const name of ['notes', 'folders', 'transfers', 'clips', 'meta', 'outgoing', 'files', 'shared']) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: name === 'meta' || name === 'files' ? 'key' : 'id' });
        }
      }
    };
    request.onsuccess = () => {
      const tx = request.result.transaction('shared', 'readwrite');
      tx.objectStore('shared').put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
  for (const client of open) client.postMessage({ vault: 'shared' });
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(shared(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The app's own files: the saved copy at once, refreshed in the background for next time.
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const kept = await cache.match(event.request, { ignoreSearch: true });
    const fresh = fetch(event.request).then((response) => {
      if (response.ok && response.type === 'basic') cache.put(event.request, response.clone());
      return response;
    }).catch(() => kept);
    return kept || fresh;
  }));
});
