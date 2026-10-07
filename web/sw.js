// Offline shell: cache-first for static files, network-first for the API (falls back to cache for GET).
const CACHE = 'tw-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname.startsWith('/api/admin') || u.pathname.startsWith('/api/vault') || u.pathname === '/api/me') return; // never cache sensitive data
    e.respondWith(fetch(r).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); return res; }).catch(() => caches.match(r)));
    return;
  }
  e.respondWith(caches.match(r).then((hit) => hit || fetch(r)));
});
