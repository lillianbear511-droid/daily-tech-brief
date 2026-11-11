/* Service worker.
   - Shell (html/css/js/data): network-first, so a new build shows up on the
     first open.
   - Media (audio/icons): cache COMPLETE 200 responses only. While online,
     byte-range requests go straight to the network and the server's own 206
     is handed back untouched. Only a genuine network failure falls back to
     slicing a cached copy.

   Why we stopped synthesising 206s: iOS Safari's media loader is picky about
   responses a service worker builds by hand (streaming, header set, timing
   against a cache that is still being written). It has cut playback short
   after a few seconds twice, while the identical mp3 played fine through the
   server's own 206. Chrome never reproduces it. So the rule is simple: do
   not get between Safari and the server while online. Slicing is an offline
   fallback, not the normal path. */
const V = 'dtb-v12';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './assess.js', './coach.js', './manifest.json',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // addAll rejects the whole install if one file 404s, which leaves the old
  // worker running forever. Each URL fails on its own instead.
  e.waitUntil(
    caches.open(V)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isMedia = p => /\/audio\//.test(p) || /\/icons\//.test(p);

/* "bytes=0-1023" | "bytes=1024-" | "bytes=-500" */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start, end;
  if (a === '') {
    const n = parseInt(b, 10);
    if (!n) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === '' ? size - 1 : Math.min(parseInt(b, 10), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end };
}

async function slice(res, rangeHeader) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const r = parseRange(rangeHeader, size);
  if (!r) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`,
        'Content-Length': '0',
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/mpeg',
      },
    });
  }
  const body = buf.slice(r.start, r.end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      // Pages answers with audio/mp3; Safari's media loader is happier with
      // the canonical type when the response comes from a service worker.
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

/* Only trust entries we wrote ourselves, with the exact byte count recorded.
   A cache row left half-written (an abandoned prefetch) is worse than no
   cache at all: slicing it produces a Content-Range whose total is the short
   length, and the player stops after those few seconds. */
function complete(res) {
  const n = Number(res.headers.get('X-DTB-Size'));
  const len = Number(res.headers.get('Content-Length'));
  return n > 0 && (!len || n === len);
}

async function media(request, cache) {
  const key = new Request(request.url);
  const range = request.headers.get('range');

  // ONLINE PLAYBACK. Hand Safari the server's own 206 untouched. Do not read
  // the cache here — a cache entry can still be mid-write when the user taps
  // play on a freshly pushed issue, and any synthesised response risks
  // truncating playback. This is the path that broke twice before.
  if (range) {
    const fresh = await fetch(request).catch(() => null);
    if (fresh) return fresh;
    // Genuinely offline: only now is a cached copy worth slicing.
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit && hit.status === 200 && complete(hit)) return slice(hit, range);
    return hit || Response.error();
  }

  // ignoreVary: GitHub Pages sends Vary: Accept-Encoding, which would
  // otherwise stop a plain fetch() from ever matching the media request.
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit && hit.status === 200 && complete(hit)) return hit;

  const fresh = await fetch(request).catch(() => null);
  if (!fresh) return hit || Response.error();

  // Buffer the entire body BEFORE writing. Remembering a live stream means a
  // client that drops the response (prefetch never reads it) can leave a
  // truncated row behind. A byte array is atomic and always complete.
  if (fresh.status === 200) {
    try {
      const buf = await fresh.clone().arrayBuffer();
      const headers = new Headers(fresh.headers);
      // The bytes are decoded already; keeping an encoding header would make
      // the next reader try to decode them a second time.
      headers.delete('Content-Encoding');
      headers.delete('Transfer-Encoding');
      headers.set('Content-Length', String(buf.byteLength));
      headers.set('X-DTB-Size', String(buf.byteLength));
      await cache.put(key, new Response(buf, { status: 200, headers }));
    } catch { /* quota or aborted body */ }
  }
  return fresh;
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (isMedia(url.pathname)) {
    e.respondWith(caches.open(V).then(c => media(request, c)));
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
