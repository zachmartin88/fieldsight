// FieldSight service worker.
//  - App shell: served from cache, refreshed in the background (works with no signal).
//  - Crop tiles (the fixed 0.01° lookup tiles): cache-first. They never change, so anything fetched
//    while driving is kept (recent cache, trimmed), and routes saved for offline live in their own
//    cache until deleted.
const SHELL = 'fs-shell-v6';
const RECENT = 'fs-tiles-recent';
const SAVED = 'fs-tiles-saved';
const RECENT_MAX = 5000;

const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'data.js', 'fields.js', 'offline.js', 'cdl-classes.js', 'palette.js', 'regions.js', 'share.js', 'album.js', 'data/states.json',
  'config.js', 'icon.svg', 'manifest.webmanifest',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/leaflet-rotate@0.2.8/dist/leaflet-rotate-src.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('fs-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Must match tileCacheKey() in offline.js.
function tileKey(url) {
  const u = new URL(url);
  if (!/getmap/i.test(u.searchParams.get('REQUEST') || '')) return null;
  if (!/tiff/i.test(u.searchParams.get('FORMAT') || '')) return null;
  const service = /icrop/.test(u.pathname) ? 'icrop' : /cdlall/.test(u.pathname) ? 'cdlall' : null;
  if (!service) return null;
  const q = new URLSearchParams(u.search);
  q.sort();
  return `https://fieldsight.tiles/${service}?${q}`;
}

let puts = 0;
async function trimRecent() {
  const c = await caches.open(RECENT);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - RECENT_MAX; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  const key = tileKey(url);
  if (key) {
    e.respondWith((async () => {
      const hit = (await caches.match(key, { cacheName: SAVED })) || (await caches.match(key, { cacheName: RECENT }));
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        const c = await caches.open(RECENT);
        await c.put(key, res.clone());
        if (++puts % 100 === 0) trimRecent();
      }
      return res;
    })());
    return;
  }

  // Map-server capabilities: network first, cached copy when offline.
  if (/REQUEST=GetCapabilities/i.test(url)) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // App shell: network first (so updates show up), cached copy when offline or very slow.
  const sameOrigin = new URL(url).origin === self.location.origin;
  if (sameOrigin || SHELL_FILES.includes(url)) {
    e.respondWith((async () => {
      // Always revalidate with the server so a new deploy shows up on the next load.
      const network = (sameOrigin ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req)).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      });
      const slow = new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await Promise.race([network, slow]);
        if (res) return res;
      } catch { /* offline */ }
      return (await caches.match(req, { ignoreSearch: sameOrigin })) || network;
    })());
  }
});
