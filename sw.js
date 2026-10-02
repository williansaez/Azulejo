// Azulejo das Palavras - service worker (funcionamento offline)
// Ao publicar uma nova versão, aumente o número abaixo.
const VERSION = 'azulejo-v6';
const DICT = ['./dicionario/index.json'];
for (let n = 4; n <= 13; n++) DICT.push('./dicionario/' + n + '.json');
const FILES = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon.png', ...DICT];

// Guarda cada ficheiro em separado: se um falhar, os outros ficam na cache
// e a instalação continua (o que faltar é guardado quando for pedido).
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fontes do Google: guardar na cache à primeira utilização
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Dicionário (ficheiros grandes, só mudam com uma nova VERSION): cache primeiro
  if (url.pathname.includes('/dicionario/') && url.pathname.endsWith('.json')) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
    return;
  }
  // Ficheiros do jogo: rede primeiro (para receber atualizações), cache se estiver offline
  e.respondWith(fetch(req).then(r => {
    const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r;
  }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
});
