// Saves the app on the iPad so it opens without internet.
// Change the version number whenever you upload new app files.
const VERSION = 'expobooth-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'csv.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'pdf.min.js', 'pdf.worker.min.js',
  'jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache =>
    cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('expobooth-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(caches.open(VERSION).then(async cache =>
    (await cache.match(event.request, { ignoreSearch: true })) ?? fetch(event.request)));
});
