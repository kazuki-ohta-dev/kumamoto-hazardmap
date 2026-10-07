/* Service Worker：アプリ本体はネットワーク優先（更新をすぐ反映）、地図タイルは保存済みならそれを返す */
const SHELL = 'hm-shell-v2';
const TILES = 'hm-tiles-v1';
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'data/kumamoto_municipalities.geojson', 'data/shelters_kumamoto.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'disaportaldata.gsi.go.jp'];
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('hm-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(tile(req)); return; }
  if (url.origin === location.origin) { e.respondWith(shell(req)); }
});

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response(EMPTY_PNG, { headers: { 'Content-Type': 'image/png', 'X-HM-Missing': '1' } });
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
  }
}
