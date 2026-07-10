let latitude = null;
let longitude = null;
let hasAlerted = false;
let weatherInterval = null;
let countdownInterval = null;
let lastRainState = false;

// PWA: Service Workerの登録処理
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker 登録完了', reg))
            .catch(err => console.error('Service Worker 登録失敗', err));
    });
}

// 🔔 プッシュ通知・プッシュ許可申請
function requestNotificationPermission() {
    if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                alert('🔔 通知が許可されました！バックグラウンドでも動作します。');
            }
        });
    }
}

// 📱 バイブレーションと音声の統合アラート
function playAlertNotification(message) {
    // 1. 音声再生
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.4;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 300);

    // 2. スマホのバイブレーション（PWA/Android対応）
    if ("vibrate" in navigator) {
        navigator.vibrate([200, 100, 200]);
    }

    // 3. PWA用バックグラウンド通知のトリガー（Service Worker経由）
    if ('Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker.ready.then(registration => {
            registration.showNotification('☔ 雨守アラート', {
                body: message || '雨予報を検知しました。',
                icon: 'https://flaticon.com',
                vibrate: [200, 100, 200]
            });
        });
    }
}

function playAlertSound() {
    playAlertNotification("テスト通知が正常に動作しています。");
}

// メイン天気更新処理
async function updateWeather() {
    if (latitude === null || longitude === null) return;

    console.log("更新：" + new Date().toLocaleTimeString());
    const status = document.getElementById("updateStatus");
    if (status) status.textContent = "🔄 更新中...";

    // 🗺 雨雲レーダーを現在地の座標に自動更新して連動
    const radarUrl = `https://yahoo.co.jp{latitude}&lon=${longitude}&zoom=11`;
    document.getElementById("radarFrame").src = radarUrl;

    // 「○分前から雨」を正確に割り出すため past_days=1 を付与
    const url =
`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&hourly=precipitation_probability&timezone=auto&past_days=1`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("APIエラー");
        const data = await response.json();

        document.getElementById("temperature").textContent = data.current.temperature_2m + "℃";
        const code = data.current.weather_code;
        let weather = "☀️ 晴れ";
        if (code >= 1 && code <= 3) weather = "⛅ 曇り";
        if (code >= 51) weather = "🌧 雨";
        document.getElementById("weather").textContent = weather;

        const times = data.hourly.time;
        const rain = data.hourly.precipitation_probability;

        if (countdownInterval) clearInterval(countdownInterval);

        // 1分間隔のリアルタイム高精度演算ループ
        function updateCountdowns() {
            const now = new Date();
            const currentProb = getInterpolatedRainProbability(now, times, rain);
            document.getElementById("rain").textContent = "現在の降水確率：" + Math.round(currentProb) + "%";

            // 境界時間を探すタイムライン解析（3番の機能）
            let info = analyzeRainTimeline(now, times, rain);

            const alertEl = document.getElementById("rainAlert");
            const timeEl = document.getElementById("rainTime");
            const warningEl = document.getElementById("warning");

            if (info.isRainingNow) {
                // 【⏰ 3. ○分前から雨 の表示】
                alertEl.textContent = `🚨 雨が降っています (${info.probability}%)`;
                alertEl.style.color = "red";
                timeEl.textContent = `${info.minutes}分前から雨が降っています`;
                warningEl.textContent = "☂ 傘を差しましょう";

                if (!hasAlerted) {
                    playAlertNotification(`${info.minutes}分前から雨が降り始めています！`);
                    hasAlerted = true;
                }
                lastRainState = true;

            } else if (info.upcomingRain) {
                // 【あと○分で雨 の表示】
                alertEl.textContent = `⚠️ 雨が近づいています (${info.probability}%)`;
                alertEl.style.color = "#ff6600";
                timeEl.textContent = `あと ${info.minutes} 分で雨が降る予報です`;
                warningEl.textContent = "☂ 傘を持って行きましょう";

                if (!hasAlerted) {
                    playAlertNotification(`あと ${info.minutes} 分で雨が降る予報です！`);
                    hasAlerted = true;
                }
                lastRainState = true;

            } else {
                // 【雨は止みました の表示】
                hasAlerted = false;
                alertEl.style.color = "green";
                timeEl.textContent = "";

                if (lastRainState) {
                    alertEl.textContent = "✨ 雨は止みました";
                    warningEl.textContent = "もう安心です";
                    setTimeout(() => {
                        if (!hasAlerted && alertEl.textContent === "✨ 雨は止みました") {
                            alertEl.textContent = "✅ 雨の心配はありません";
                            warningEl.textContent = "今日は安心です";
                        }
                    }, 30000);
                } else {
                    alertEl.textContent = "✅ 雨の心配はありません";
                    warningEl.textContent = "今日は安心です";
                }
                lastRainState = false;
            }

            // 6時間予報の構築
            let html = "<h3>これから6時間</h3>";
            let currentIndex = times.findIndex(t => new Date(t) >= now);
            if (currentIndex === -1) currentIndex = 0;

            for (let i = 0; i < 6; i++) {
                const targetIndex = currentIndex + i;
                if (targetIndex >= times.length) break;
                const hour = new Date(times[targetIndex]).getHours();
                const prob = rain[targetIndex];
                let icon = "☀️";
                if (prob >= 20) icon = "⛅";
                if (prob >= 50) icon = "🌧";
                html += `<p>${hour}時 ${icon} ${prob}%</p>`;
            }
            document.getElementById("hourly").innerHTML = html;
        }

        updateCountdowns();
        countdownInterval = setInterval(updateCountdowns, 60000); // 1分ごとの描画更新

        document.getElementById("location").textContent = "📍現在地";
        if (status) {
            status.textContent = "✅ " + new Date().toLocaleTimeString() + " 更新完了";
            setTimeout(() => { status.textContent = ""; }, 3000);
        }

    } catch (e) {
        console.error(e);
        document.getElementById("location").textContent = "通信エラー";
        if (status) status.textContent = "❌ 更新失敗";
    }
}

// 線形補間関数
function getInterpolatedRainProbability(targetDate, times, rain) {
    const targetMs = targetDate.getTime();
    for (let i = 0; i < times.length - 1; i++) {
        const t1 = new Date(times[i]).getTime();
        const t2 = new Date(times[i+1]).getTime();
        if (targetMs >= t1 && targetMs <= t2) {
            const p1 = rain[i];
            const p2 = rain[i+1];
            return p1 + (p2 - p1) * ((targetMs - t1) / (t2 - t1));
        }
    }
    return 0;
}

// 過去・未来のタイムライン解析
function analyzeRainTimeline(now, times, rain) {
    const nowMs = now.getTime();
    let timeline = [];
    // 過去60分前から未来360分後までを1分単位でスキャン
    for (let min = -60; min <= 360; min++) {
        const simDate = new Date(nowMs + min * 60000);
        const prob = getInterpolatedRainProbability(simDate, times, rain);
        timeline.push({ diffMinutes: min, prob: prob });
    }

    const currentProb = timeline.find(t => t.diffMinutes === 0).prob;

    if (currentProb >= 50) {
        // 現在50%以上（雨）の場合、過去に向かって「最初に50%を跨いだ時間」を逆算
        let startMin = 0;
        for (let min = 0; min >= -60; min--) {
            const item = timeline.find(t => t.diffMinutes === min);
            if (item && item.prob >= 50) {
                startMin = min;
            } else {
                break;
            }
        }
        return { isRainingNow: true, upcomingRain: false, minutes: Math.abs(startMin), probability: Math.round(currentProb) };
    } else {
        // 現在50%未満の場合、未来に向かって「最初に50%を超える時間」を算出
        const match = timeline.find(t => t.diffMinutes > 0 && t.prob >= 50);
        if (match) {
            return { isRainingNow: false, upcomingRain: true, minutes: match.diffMinutes, probability: Math.round(match.prob) };
        }
    }
    return { isRainingNow: false, upcomingRain: false, minutes: 0, probability: Math.round(currentProb) };
}

// 位置情報トリガー（API読み込みは10分に1回、画面処理は1分に1回）
navigator.geolocation.getCurrentPosition(
    function (pos) {
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
        updateWeather();
        if (weatherInterval) clearInterval(weatherInterval);
        weatherInterval = setInterval(updateWeather, 600000);
    },
    function () {
        console.log("位置情報を許可してください。");
    }
);