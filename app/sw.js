const VERSION = 'wt-v21';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './storage.js',
  './github.js',
  './names.js',
  './manifest.webmanifest',
  './routines.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(async cache => {
      // Cache per asset, not all-or-nothing: one 404 must not fail the
      // whole install and leave the previous SW (or none) in place.
      await Promise.all(APP_SHELL.map(async url => {
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
          else console.warn('SW install: skipping', url, res.status);
        } catch (err) {
          console.warn('SW install: skipping', url, err);
        }
      }));
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/routines.json')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
