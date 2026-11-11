/* Service worker.
   - Shell (html/css/js): network-first, so a new build shows up on the first open.
   - Media (audio/icons): keep the COMPLETE file, then answer Safari's byte-range
     requests out of that copy ourselves.

   Why the range handling: iOS Safari and macOS Safari fetch media with a
   `Range: bytes=...` header and refuse to play anything that is not a 206 with
   a matching Content-Range. Two ways to get this wrong, both fatal:
     a) caching the network's 206 — you store a fragment under the file's URL,
        and every later play decodes garbage;
     b) handing a cached 200 to a range request — Chrome tolerates it, Safari
        does not.
   So: never store a 206, never return a whole file to a range request. */
const V = 'dtb-v11';
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
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  const body = buf.slice(r.start, r.end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function media(request, cache) {
  const key = new Request(request.url);
  // ignoreVary: GitHub Pages sends Vary: Accept-Encoding, which would otherwise
  // stop a plain fetch() from ever matching the media loader's request.
  const hit = await cache.match(key, { ignoreVary: true });

  if (hit && hit.status === 200) {
    const range = request.headers.get('range');
    return range ? slice(hit, range) : hit;
  }

  const fresh = await fetch(request).catch(() => null);
  if (!fresh) return hit || Response.error();

  // Only a complete 200 is safe to keep.
  if (fresh.status === 200) {
    try { await cache.put(key, fresh.clone()); } catch { /* quota */ }
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
