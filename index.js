import { buildPushHTTPRequest } from "@pushforge/builder";

const RAIN_THRESHOLD = 50;      // 降水確率(%) これ以上を「雨」とみなす
const ALERT_LEAD_MINUTES = 5;   // 何分前にアラートを送るか

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Register-Secret",
  };
}

// 天気コードが「雨」を示すかどうか（雪は除く）
// weather_codeそのものが雨を示していれば、降水確率のしきい値に関係なく雨判定とする
function isRainCode(code) {
  if (code === null || code === undefined) return false;
  if (code >= 51 && code <= 57) return true; // 弱い雨
  if (code >= 61 && code <= 67) return true; // 雨
  if (code === 80 || code === 81 || code === 82) return true; // にわか雨
  if (code >= 95) return true; // 雷雨
  return false;
}

export default {
  // ブラウザからの登録リクエストを受け取る窓口
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const secret = request.headers.get("X-Register-Secret");
      if (!env.REGISTER_SECRET || secret !== env.REGISTER_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Bad Request: invalid JSON", { status: 400, headers: corsHeaders() });
      }

      if (!body.subscription || typeof body.latitude !== "number" || typeof body.longitude !== "number") {
        return new Response("Bad Request: missing fields", { status: 400, headers: corsHeaders() });
      }

      await env.RAIN_KV.put("subscription", JSON.stringify({
        subscription: body.subscription,
        latitude: body.latitude,
        longitude: body.longitude,
      }));

      return new Response("OK", { status: 200, headers: corsHeaders() });
    }

    return new Response("雨守 push worker is running.", { status: 200, headers: corsHeaders() });
  },

  // Cronトリガーから毎分呼ばれる
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRainAndNotify(env));
  },
};

async function checkRainAndNotify(env) {
  const stored = await env.RAIN_KV.get("subscription", "json");
  if (!stored) return; // まだ誰も登録していない

  const { subscription, latitude, longitude } = stored;

  // weather_code も併せて取得する
  const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=precipitation_probability,weather_code&timezone=auto`;

  let data;
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) return;
    data = await res.json();
  } catch (e) {
    console.error("Open-Meteo取得エラー:", e);
    return;
  }

  if (!data.hourly || !data.hourly.time || !data.hourly.precipitation_probability) return;

  const times = data.hourly.time.map((t) => new Date(t).getTime());
  const probs = data.hourly.precipitation_probability;
  const codes = data.hourly.weather_code || [];
  const now = Date.now();

  function interpolateProb(targetMs) {
    if (times.length < 2) return 0;
    if (targetMs <= times[0]) return probs[0];
    if (targetMs >= times[times.length - 1]) return probs[probs.length - 1];
    for (let i = 0; i < times.length - 1; i++) {
      if (targetMs >= times[i] && targetMs <= times[i + 1]) {
        const ratio = (targetMs - times[i]) / (times[i + 1] - times[i]);
        return probs[i] + (probs[i + 1] - probs[i]) * ratio;
      }
    }
    return 0;
  }

  // weather_codeは補間せず、直前の時間帯の値をそのまま使う
  function nearestCode(targetMs) {
    if (codes.length === 0) return null;
    let nearestIndex = 0;
    for (let i = 0; i < times.length; i++) {
      if (times[i] <= targetMs) {
        nearestIndex = i;
      } else {
        break;
      }
    }
    return codes[nearestIndex];
  }

  function isRainingAt(targetMs) {
    return interpolateProb(targetMs) >= RAIN_THRESHOLD || isRainCode(nearestCode(targetMs));
  }

  const currentProb = interpolateProb(now);
  const isRainingNow = isRainingAt(now);

  let minutesAhead = null;
  if (!isRainingNow) {
    for (let m = 1; m <= ALERT_LEAD_MINUTES; m++) {
      if (isRainingAt(now + m * 60000)) {
        minutesAhead = m;
        break;
      }
    }
  }

  const stateRaw = await env.RAIN_KV.get("alert_state", "json");
  const state = stateRaw || { startedAlerted: false, imminentAlerted: false };

  let title = null;
  let body = null;

  if (isRainingNow) {
    if (!state.startedAlerted) {
      title = "☔ 雨守アラート";
      body = "雨が降り始めました！洗濯物を取り込んでください";
      state.startedAlerted = true;
    }
    state.imminentAlerted = false;
  } else if (minutesAhead !== null) {
    if (!state.imminentAlerted) {
      title = "☔ 雨守アラート";
      body = `あと${minutesAhead}分で雨が降りそうです！洗濯物を取り込んでください`;
      state.imminentAlerted = true;
    }
    state.startedAlerted = false;
  } else {
    state.startedAlerted = false;
    state.imminentAlerted = false;
  }

  await env.RAIN_KV.put("alert_state", JSON.stringify(state));

  if (!title) return; // 送るものがなければ終了

  try {
    const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
      privateJWK: JSON.parse(env.VAPID_PRIVATE_KEY),
      subscription,
      message: {
        payload: { title, body },
        adminContact: "mailto:example@example.com",
        options: { urgency: "high", ttl: 300 },
      },
    });

    const pushRes = await fetch(endpoint, { method: "POST", headers, body: pushBody });

    // 購読が失効していたら掃除しておく
    if (pushRes.status === 404 || pushRes.status === 410) {
      await env.RAIN_KV.delete("subscription");
    }
  } catch (e) {
    console.error("push送信エラー:", e);
  }
}
