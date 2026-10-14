// キャッシュ優先。ファイルを変えたら VERSION を上げる
// Leaflet は vendor/ に同梱。地図タイルはキャッシュしない。data/ は取得時にキャッシュ
const VERSION = 'tabigoyomi-v35';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './logic.js',
  './themes/seasons.js',
  './data/lists.json',
  './data/seasons-coords.json',
  './data/foods.json',
  './data/kana.json',
  './vendor/leaflet.css',
  './vendor/leaflet.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 区画のデータ（data/spots/）は、取得したときにキャッシュする
  if (url.origin === self.location.origin && url.pathname.includes('/data/spots/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request, { cache: 'reload' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

// 「着きました」の通知を押したら、開いているアプリに戻る（なければ開く）
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const c = list.find((w) => 'focus' in w);
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
