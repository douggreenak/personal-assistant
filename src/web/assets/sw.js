// Keeps the app shell available when the phone is offline or the server is restarting. API calls are never cached.
const CACHE = 'assistant-shell-v1';
const SHELL = ['/', '/assets/app.js', '/assets/styles.css', '/assets/fonts/roboto-flex.woff2', '/assets/icon.svg', '/assets/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (!(r.mode === 'navigate' || u.pathname.startsWith('/assets/'))) return;   // only the shell: pages and static files
  e.respondWith(fetch(r).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r.mode === 'navigate' ? '/' : r, copy)); } return res; }).catch(() => caches.match(r.mode === 'navigate' ? '/' : r).then((m) => m || Response.error())));   // network first, cache when offline
});
