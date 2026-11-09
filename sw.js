/* Áurea: service worker mínimo para que la app sea instalable y abra sin conexión.
   Páginas: primero la red (siempre la versión más nueva) y, si no hay internet, la copia guardada. */
const CACHE = 'aurea-v3';
const SHELL = ['./', 'index.html', 'app.html', 'firebase-config.js', 'app-en.js', 'landing-en.js', 'manifest.webmanifest', 'icons/aurea-192.png', 'icons/aurea-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.includes('/pago/') || u.pathname.startsWith('/__/')) return;
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok && res.type === 'basic') { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || (r.mode === 'navigate' ? caches.match('app.html') : undefined)))
  );
});
