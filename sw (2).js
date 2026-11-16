/* Service worker : met l'appli en cache pour qu'elle marche sans connexion.
 * Quand tu modifies un fichier, change le numéro de version ci-dessous (v1 -> v2). */
const CACHE = 'pdf-facile-v2';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'pdf-lib.min.js',
  'pdfjs.js',
  'pdfjs-worker.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache d'abord (rapide + hors connexion), puis mise à jour discrète en arrière-plan
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => null);
      return hit || net.then(res => res || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
