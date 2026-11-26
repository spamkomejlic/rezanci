// Service worker: lets the operator pages open with no network, so the work at the jig goes on when the Wi-Fi drops.
// It keeps a copy of the page files only, with the text of the operator guide. It never touches an API call or a moderator page.
// With a network, each file comes from the server (so the running code is always the deployed code) and the copy
// is renewed. With no network, or no answer in 5 seconds, the copy is used.
const CACHE = 'shell-1';
const SHELL = ['/', '/capture', '/join', '/app.css', '/ui.js', '/i18n.js', '/app.js', '/capture.js', '/join.js',
  '/jpeg.js', '/quality.js', '/queue.js', '/scan.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest',
  '/help/operator', '/help/help.css', '/help/page.js', '/help/text.js'];

self.addEventListener('install', event =>
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(url.pathname, { signal: AbortSignal.timeout(5000) });
      if (!fresh.ok) return (await cache.match(url.pathname)) ?? fresh;
      await cache.put(url.pathname, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(url.pathname)) ?? Response.error();
    }
  })());
});
