/* Service worker.
   - Shell (html/css/js): network-first, so a new build shows up on the first open.
   - Media (audio/icons): cache-first, so practice works on the subway.
   Cache is never wiped on activate, so offline keeps working across updates. */
const V = 'dtb-v5';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isMedia = p => /\/audio\//.test(p) || /\/icons\//.test(p);

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (isMedia(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(V);
      const hit = await cache.match(request);
      if (hit) return hit;
      const fresh = await fetch(request).catch(() => null);
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh || Response.error();
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(V);
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    } catch {
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
