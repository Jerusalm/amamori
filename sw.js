const CACHE_NAME = 'amamori-cache-v2';
const PRECACHE_URLS = [
    './',
    './index.html',
    './script.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// インストール時にキャッシュ
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_URLS))
            .catch(err => console.error('キャッシュ登録失敗:', err))
    );
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// フェッチ：APIは常にネットワーク優先、それ以外はキャッシュ優先
self.addEventListener('fetch', (event) => {
    if (event.request.url.includes('api.open-meteo.com')) {
        event.respondWith(fetch(event.request));
        return;
    }
    event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request))
    );
});

// バックグラウンド通知（プッシュ通知）の受信イベント
self.addEventListener('push', function(event) {
    let title = '☔ 雨守アラート';
    let options = {
        body: '雨が近づいています！傘を用意してください。',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [200, 100, 200]
    };
    if (event.data) {
        try {
            const data = event.data.json();
            title = data.title || title;
            options.body = data.body || options.body;
        } catch (e) {
            options.body = event.data.text();
        }
    }
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// 通知がクリックされた時の挙動
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./index.html');
        })
    );
});
