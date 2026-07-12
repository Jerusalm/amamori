let latitude = null;
let longitude = null;
let hasAlertedImminent = false; // 「あと○分で雨」の直前アラートを鳴らしたか
let hasAlertedStarted = false;  // 「雨が降り始めた」アラートを鳴らしたか
let weatherInterval = null;
let countdownInterval = null;
let lastRainState = false;

const RAIN_THRESHOLD = 50;   // 降水確率(%) これ以上を「雨」とみなす
const ALERT_LEAD_MINUTES = 5; // 雨が降り出す何分前にアラートを鳴らすか

// ↓↓↓ Cloudflare Workerをデプロイしたら、この3つを書き換えてください ↓↓↓
const WORKER_URL = "https://amamori-push-worker.jerusalm.workers.dev";
const VAPID_PUBLIC_KEY = "BJE59toyWxRwVx9CvEAN3_7GCf39rjZLfguavCmdroCUM7waG4ON_GobLyrXNoV8swiFiBMZ3Qaz1Z63gaXexy0";
const REGISTER_SECRET = "BRrgFE3kKgjDLeYZayauIJPlvsag1gpN";
// ↑↑↑ ここまで ↑↑↑

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
                subscribeToPush(); // 許可されたらバックグラウンド購読も開始
            }
        });
    }
}

// Base64URL文字列をpushManager.subscribeが要求するUint8Arrayに変換
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// アプリを閉じていても届く「バックグラウンドプッシュ」の購読処理
async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (latitude === null || longitude === null) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY_HERE') {
        console.warn('VAPID_PUBLIC_KEYが未設定のため、バックグラウンド通知は無効です。');
        return;
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }

        await registerWithWorker(subscription);
    } catch (e) {
        console.error('プッシュ購読エラー:', e);
    }
}

// 購読情報と現在地をCloudflare Workerに送って保存してもらう
async function registerWithWorker(subscription) {
    try {
        const res = await fetch(`${WORKER_URL}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Register-Secret': REGISTER_SECRET
            },
            body: JSON.stringify({
                subscription: subscription.toJSON(),
                latitude,
                longitude
            })
        });
        if (!res.ok) {
            console.error('サーバーへの登録に失敗:', res.status);
        }
    } catch (e) {
        console.error('サーバーへの登録エラー:', e);
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

            subscribeToPush(); // 既に通知許可済みなら、最新の位置で購読/再登録する

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

// 天気コードが「雨（雪ではない）」を示すかどうか
// weather_codeそのものが「今、雨が降っている」ことを示している場合、
// 降水確率のしきい値に関係なく雨判定とするために使用する
function isRainCode(code) {
    if (code === null || code === undefined) return false;
    if (code >= 51 && code <= 57) return true; // 弱い雨
    if (code >= 61 && code <= 67) return true; // 雨
    if (code === 80 || code === 81 || code === 82) return true; // にわか雨
    if (code >= 95) return true; // 雷雨
    return false;
}

// 時間別アイコン（雪と雨を区別）
function hourlyIcon(code, prob) {
    if (code >= 71 && code <= 77) return "🌨";
    if (code === 85 || code === 86) return "🌨";
    if (prob >= RAIN_THRESHOLD) return "🌧";
    if (prob >= 20) return "⛅";
    return "☀️";
}

// 分数を「○時間○分」形式に整形する
function formatMinutes(min) {
    if (min < 60) return `${min}分`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}時間` : `${h}時間${m}分`;
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
        const currentWeatherCode = data.current.weather_code;

        if (countdownInterval) clearInterval(countdownInterval);

        function updateCountdowns() {
            const now = new Date();
            const currentProb = getInterpolatedRainProbability(now, times, rain);
            if (document.getElementById("rain")) {
                document.getElementById("rain").textContent = "現在の降水確率：" + Math.round(currentProb) + "%";
            }

            // 「今まさに雨が降っているか」は現在の天気コードも判定材料にする。
            // 降水確率がしきい値未満でも、天気コードが雨を示していれば雨扱いにする。
            let info = analyzeRainTimeline(now, times, rain, codes, currentWeatherCode);

            const alertEl = document.getElementById("rainAlert");
            const timeEl = document.getElementById("rainTime");
            const warningEl = document.getElementById("warning");

            if (alertEl && timeEl && warningEl) {
                if (info.isRainingNow) {
                    alertEl.textContent = `🚨 雨が降っています (${info.probability}%)`;
                    alertEl.style.color = "red";
                    timeEl.textContent = `${formatMinutes(info.minutes)}前から雨が降っています`;
                    warningEl.textContent = "☂ 洗濯物を取り込みましょう";

                    // 5分前アラートを取りこぼした場合の保険として、
                    // 実際に降り始めたタイミングでも一度だけ鳴らす
                    if (!hasAlertedStarted) {
                        playAlertNotification(`雨が降り始めました！洗濯物を取り込んでください`);
                        hasAlertedStarted = true;
                    }
                    hasAlertedImminent = false; // 次回のために解除
                    lastRainState = true;
                } else if (info.upcomingRain) {
                    alertEl.textContent = `⚠️ 雨が近づいています (${info.probability}%)`;
                    alertEl.style.color = "#ff6600";
                    timeEl.textContent = `あと ${formatMinutes(info.minutes)} で雨が降る予報です`;
                    warningEl.textContent = "☂ 傘を持って行きましょう";

                    // あと5分以内に迫った時だけアラートを鳴らす
                    if (info.minutes <= ALERT_LEAD_MINUTES && !hasAlertedImminent) {
                        playAlertNotification(`あと${info.minutes}分で雨が降りそうです！洗濯物を取り込んでください`);
                        hasAlertedImminent = true;
                    }
                    hasAlertedStarted = false; // 次回のために解除
                    lastRainState = true;
                } else {
                    hasAlertedImminent = false;
                    hasAlertedStarted = false;
                    alertEl.style.color = "green";
                    timeEl.textContent = "";

                    if (lastRainState) {
                        alertEl.textContent = "✨ 雨は止みました";
                        warningEl.textContent = "もう安心です";
                        setTimeout(() => {
                            if (alertEl.textContent === "✨ 雨は止みました") {
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

// 指定した時刻に最も近い（かつそれ以前の）時間帯の天気コードを取得する。
// 降水確率と違ってweather_codeは補間せず、直前の時間帯の値をそのまま使う。
function getNearestWeatherCode(targetDate, times, codes) {
    if (!codes || times.length === 0) return null;
    const targetMs = targetDate.getTime();

    let nearestIndex = 0;
    for (let i = 0; i < times.length; i++) {
        const tMs = new Date(times[i]).getTime();
        if (tMs <= targetMs) {
            nearestIndex = i;
        } else {
            break;
        }
    }
    return codes[nearestIndex];
}

// 「何分前から雨」「あと何分で雨」を、APIが持つデータの範囲いっぱいまで
// 1分刻みで前後に探索する（固定60分キャップを廃止）
// codes / currentWeatherCode を渡すことで、降水確率だけでなく
// 天気コード自体が雨を示している場合も「雨が降っている」と判定する
function analyzeRainTimeline(now, times, rain, codes, currentWeatherCode) {
    if (times.length === 0) {
        return { isRainingNow: false, upcomingRain: false, minutes: 0, probability: 0 };
    }

    const dataStartMs = new Date(times[0]).getTime();
    const dataEndMs = new Date(times[times.length - 1]).getTime();
    const nowMs = now.getTime();

    const currentProb = getInterpolatedRainProbability(now, times, rain);

    // 降水確率がしきい値以上、または現在の天気コード自体が雨を示していれば「雨が降っている」
    const isRainingByProb = currentProb >= RAIN_THRESHOLD;
    const isRainingByCode = isRainCode(currentWeatherCode);

    if (isRainingByProb || isRainingByCode) {
        // データの開始時刻まで、1分ずつ遡って雨が続いている範囲を探す
        // （確率・天気コードのどちらかが雨を示している間は「降り続けている」とみなす）
        let minutesAgo = 0;
        while (true) {
            const checkMs = nowMs - (minutesAgo + 1) * 60000;
            if (checkMs < dataStartMs) break;
            const checkDate = new Date(checkMs);
            const p = getInterpolatedRainProbability(checkDate, times, rain);
            const c = getNearestWeatherCode(checkDate, times, codes);
            if (p < RAIN_THRESHOLD && !isRainCode(c)) break;
            minutesAgo++;
        }
        return {
            isRainingNow: true,
            upcomingRain: false,
            minutes: minutesAgo,
            probability: Math.round(currentProb)
        };
    } else {
        // 「あと○分で雨」は直近2時間以内の予報に限定する
        // （それより先の予報はまだ不確実な上、実用的でないため対象外とする）
        const LOOKAHEAD_LIMIT_MS = 2 * 60 * 60000;
        const lookaheadEndMs = Math.min(dataEndMs, nowMs + LOOKAHEAD_LIMIT_MS);

        let minutesAhead = 0;
        while (true) {
            minutesAhead++;
            const checkMs = nowMs + minutesAhead * 60000;
            if (checkMs > lookaheadEndMs) {
                minutesAhead = null; // 2時間以内には見つからず
                break;
            }
            const checkDate = new Date(checkMs);
            const p = getInterpolatedRainProbability(checkDate, times, rain);
            const c = getNearestWeatherCode(checkDate, times, codes);
            if (p >= RAIN_THRESHOLD || isRainCode(c)) break;
        }
        if (minutesAhead !== null) {
            const futureDate = new Date(nowMs + minutesAhead * 60000);
            const futureProb = getInterpolatedRainProbability(futureDate, times, rain);
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
