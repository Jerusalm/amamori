let latitude = null;
let longitude = null;
let hasAlerted = false;
let weatherInterval = null;
let countdownInterval = null;
let lastRainState = false;

const RAIN_THRESHOLD = 50; // 降水確率(%) これ以上を「雨」とみなす

// PWA登録
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker 登録完了', reg))
            .catch(err => console.error('Service Worker 登録スキップ', err));
    });
}

// 🔔 プッシュ通知許可
function requestNotificationPermission() {
    if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                alert('🔔 通知が許可されました！');
            }
        });
    }
}

// アラート通知
function playAlertNotification(message) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.4;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 300);
    } catch(e) { console.error(e); }

    if ("vibrate" in navigator) {
        navigator.vibrate(200);
    }

    if ('Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker.ready.then(registration => {
            registration.showNotification('☔ 雨守アラート', {
                body: message || '雨予報を検知しました。',
                icon: 'icon-192.png',
                badge: 'icon-192.png'
            }).catch(e => console.error(e));
        });
    }
}

function playAlertSound() {
    playAlertNotification("テスト通知が正常に動作しています。");
}

// 位置情報を取得
function initLocation() {
    if (document.getElementById("location")) {
        document.getElementById("location").textContent = "📍現在地取得中...";
    }

    navigator.geolocation.getCurrentPosition(
        function (pos) {
            latitude = pos.coords.latitude;
            longitude = pos.coords.longitude;

            if (document.getElementById("location")) {
                document.getElementById("location").textContent = "📍現在地";
            }

            updateWeather();

            if (weatherInterval) clearInterval(weatherInterval);
            weatherInterval = setInterval(updateWeather, 600000);
        },
        function (error) {
            console.error("位置情報エラー:", error);
            latitude = 35.6812;
            longitude = 139.7671;
            if (document.getElementById("location")) {
                document.getElementById("location").textContent = "📍位置情報未許可（テスト用座標）";
            }
            updateWeather();
        },
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 }
    );
}

// 天気コード → 表示テキスト（雪と雨を区別）
function weatherCodeToText(code) {
    if (code === 0) return "☀️ 快晴";
    if (code >= 1 && code <= 3) return "⛅ 曇り";
    if (code === 45 || code === 48) return "🌫️ 霧";
    if (code >= 51 && code <= 57) return "🌦 弱い雨";
    if (code >= 61 && code <= 67) return "🌧 雨";
    if (code === 80 || code === 81 || code === 82) return "🌧 にわか雨";
    if (code >= 71 && code <= 77) return "🌨 雪";
    if (code === 85 || code === 86) return "🌨 にわか雪";
    if (code >= 95) return "⛈ 雷雨";
    return "❓ 不明";
}

// 時間別アイコン（雪と雨を区別）
function hourlyIcon(code, prob) {
    if (code >= 71 && code <= 77) return "🌨";
    if (code === 85 || code === 86) return "🌨";
    if (prob >= RAIN_THRESHOLD) return "🌧";
    if (prob >= 20) return "⛅";
    return "☀️";
}

// メイン天気更新
async function updateWeather() {
    if (latitude === null || longitude === null) return;

    console.log("更新：" + new Date().toLocaleTimeString());
    const status = document.getElementById("updateStatus");
    if (status) status.textContent = "🔄 更新中...";

    const url =
`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&hourly=precipitation_probability,weather_code&timezone=auto&past_days=1`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("APIエラー");
        const data = await response.json();

        if (document.getElementById("temperature")) {
            document.getElementById("temperature").textContent = data.current.temperature_2m + "℃";
        }

        if (document.getElementById("weather")) {
            document.getElementById("weather").textContent = weatherCodeToText(data.current.weather_code);
        }

        const times = data.hourly.time;
        const rain = data.hourly.precipitation_probability;
        const codes = data.hourly.weather_code;

        if (countdownInterval) clearInterval(countdownInterval);

        function updateCountdowns() {
            const now = new Date();
            const currentProb = getInterpolatedRainProbability(now, times, rain);
            if (document.getElementById("rain")) {
                document.getElementById("rain").textContent = "現在の降水確率：" + Math.round(currentProb) + "%";
            }

            let info = analyzeRainTimeline(now, times, rain);

            const alertEl = document.getElementById("rainAlert");
            const timeEl = document.getElementById("rainTime");
            const warningEl = document.getElementById("warning");

            if (alertEl && timeEl && warningEl) {
                if (info.isRainingNow) {
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
            }

            let html = "<h3>これから6時間</h3>";
            let currentIndex = times.findIndex(t => new Date(t) >= now);
            if (currentIndex === -1) currentIndex = 0;

            for (let i = 0; i < 6; i++) {
                const targetIndex = currentIndex + i;
                if (targetIndex >= times.length) break;
                const hour = new Date(times[targetIndex]).getHours();
                const prob = rain[targetIndex];
                const code = codes ? codes[targetIndex] : null;
                const icon = hourlyIcon(code, prob);
                html += `<p>${hour}時 ${icon} ${prob}%</p>`;
            }
            if (document.getElementById("hourly")) {
                document.getElementById("hourly").innerHTML = html;
            }
        }

        updateCountdowns();
        countdownInterval = setInterval(updateCountdowns, 60000);

        if (status) {
            status.textContent = "✅ " + new Date().toLocaleTimeString() + " 更新完了";
            setTimeout(() => { status.textContent = ""; }, 3000);
        }

    } catch (e) {
        console.error(e);
        if (status) status.textContent = "❌ 更新失敗";
    }
}

function getInterpolatedRainProbability(targetDate, times, rain) {
    const targetMs = targetDate.getTime();

    if (times.length === 0) return 0;
    const firstMs = new Date(times[0]).getTime();
    const lastMs = new Date(times[times.length - 1]).getTime();
    if (targetMs <= firstMs) return rain[0];
    if (targetMs >= lastMs) return rain[rain.length - 1];

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

// 「何分前から雨」「あと何分で雨」を、APIが持つデータの範囲いっぱいまで
// 1分刻みで前後に探索する（固定60分キャップを廃止）
function analyzeRainTimeline(now, times, rain) {
    if (times.length === 0) {
        return { isRainingNow: false, upcomingRain: false, minutes: 0, probability: 0 };
    }

    const dataStartMs = new Date(times[0]).getTime();
    const dataEndMs = new Date(times[times.length - 1]).getTime();
    const nowMs = now.getTime();

    const currentProb = getInterpolatedRainProbability(now, times, rain);

    if (currentProb >= RAIN_THRESHOLD) {
        // データの開始時刻まで、1分ずつ遡って雨が続いている範囲を探す
        let minutesAgo = 0;
        while (true) {
            const checkMs = nowMs - (minutesAgo + 1) * 60000;
            if (checkMs < dataStartMs) break;
            const p = getInterpolatedRainProbability(new Date(checkMs), times, rain);
            if (p < RAIN_THRESHOLD) break;
            minutesAgo++;
        }
        return {
            isRainingNow: true,
            upcomingRain: false,
            minutes: minutesAgo,
            probability: Math.round(currentProb)
        };
    } else {
        // 「あと○分で雨」は直近24時間以内の予報に限定する
        // （Open-Meteoはforecast_days未指定だと最大7日先まで返すため、
        //   無制限にすると「あと2989分」のような実用的でない表示になる）
        const LOOKAHEAD_LIMIT_MS = 24 * 60 * 60000;
        const lookaheadEndMs = Math.min(dataEndMs, nowMs + LOOKAHEAD_LIMIT_MS);

        let minutesAhead = 0;
        while (true) {
            minutesAhead++;
            const checkMs = nowMs + minutesAhead * 60000;
            if (checkMs > lookaheadEndMs) {
                minutesAhead = null; // 24時間以内には見つからず
                break;
            }
            const p = getInterpolatedRainProbability(new Date(checkMs), times, rain);
            if (p >= RAIN_THRESHOLD) break;
        }
        if (minutesAhead !== null) {
            const futureProb = getInterpolatedRainProbability(new Date(nowMs + minutesAhead * 60000), times, rain);
            return {
                isRainingNow: false,
                upcomingRain: true,
                minutes: minutesAhead,
                probability: Math.round(futureProb)
            };
        }
    }

    return { isRainingNow: false, upcomingRain: false, minutes: 0, probability: Math.round(currentProb) };
}

initLocation();
