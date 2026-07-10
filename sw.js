// バックグラウンド通知（プッシュ通知）の受信イベント
self.addEventListener('push', function(event) {
    let title = '☔ 雨守アラート';
    let options = {
        body: '雨が近づいています！傘を用意してください。',
        icon: 'https://flaticon.com',
        badge: 'https://flaticon.com',
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
        clients.openWindow('./index.html')
    );
});