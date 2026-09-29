/**
 * Service worker: makes FlixDrive installable and lets the app shell open
 * without a network.
 *
 * Deliberately narrow. Only the shell below is cached, and always
 * network-first, so a deploy is picked up on the next load rather than after
 * a cache expiry. Nothing under /api is ever touched: responses there are
 * per-user and authorised, and a cached copy served to the next account on a
 * shared machine would be a data leak. Media is range-requested and far too
 * large to cache anyway.
 */
const CACHE = 'flixdrive-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // share.html and reset.html are not shell: they go straight to the network.
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) ||
        (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
  );
});
