// Offline shell: cache-first for static files; network-first for the PUBLIC catalog API only.
// Everything else under /api/ (wallet, orders, addresses, notifications, vendor/driver data...) is per-user
// and is never stored: a shared device must not expose the previous user's data offline.
const PUBLIC_API = ['/api/features', '/api/zones', '/api/products', '/api/sync', '/api/announcements'];
const CACHE = 'tw-v2'; // bumped: activation deletes the old cache, which may hold per-user data cached by v1
const SHELL = ['/', '/config.js', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    if (!PUBLIC_API.includes(u.pathname)) return; // not public: let it hit the network, never cache
    e.respondWith(fetch(r).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); return res; }).catch(() => caches.match(r)));
    return;
  }
  e.respondWith(caches.match(r).then((hit) => hit || fetch(r)));
});
