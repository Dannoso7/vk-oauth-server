import express from "express";

const app = express();

/**
 * НАСТРОЙКИ (вставь свои):
 * VK_CLIENT_ID и VK_CLIENT_SECRET берёшь в настройках VK приложения.
 * PUBLIC_BASE_URL — адрес твоего сервера в интернете (https обязателен для VK redirect).
 * APP_DEEPLINK — куда возвращаем в APK (deeplink твоего приложения).
 */
const VK_CLIENT_ID = process.env.VK_CLIENT_ID || "PASTE_CLIENT_ID";
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET || "PASTE_CLIENT_SECRET";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://YOUR-DOMAIN.COM"; // <-- обязательно https
const APP_DEEPLINK = process.env.APP_DEEPLINK || "myapp://auth";                 // <-- deeplink твоего APK

// VK OAuth endpoints (классическая схема: authorize -> access_token)
const VK_AUTHORIZE_URL = "https://oauth.vk.com/authorize";
const VK_TOKEN_URL = "https://oauth.vk.com/access_token";
const VK_API = "https://api.vk.com/method/";
const VK_API_V = "5.131";

// Простое in-memory хранилище тикетов (для MVP).
// Для продакшена лучше Redis/DB.
const tickets = new Map(); // ticket -> { createdAt, token, userId, groups }

function now() { return Date.now(); }
function uid() {
  return (globalThis.crypto?.randomUUID?.() ?? ("t_" + Math.random().toString(16).slice(2))) + "_" + now();
}
function cleanTickets() {
  const ttlMs = 5 * 60 * 1000; // 5 минут
  const t = now();
  for (const [k, v] of tickets.entries()) {
    if (t - v.createdAt > ttlMs) tickets.delete(k);
  }
}
setInterval(cleanTickets, 30_000).unref();

function buildUrl(base, params) {
  const u = new URL(base);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET" });
  const j = await r.json();
  return j;
}

async function vkCall(method, params) {
  const url = buildUrl(VK_API + method, { ...params, v: VK_API_V });
  const j = await fetchJson(url);
  if (j.error) throw new Error(j.error.error_msg || "VK API error");
  return j.response;
}

// 1) старт OAuth (всегда браузер)
app.get("/vk/start", (req, res) => {
  if (VK_CLIENT_ID.includes("PASTE") || VK_CLIENT_SECRET.includes("PASTE") || PUBLIC_BASE_URL.includes("YOUR-DOMAIN")) {
    return res.status(500).send(
      "Server is not configured. Set VK_CLIENT_ID, VK_CLIENT_SECRET, PUBLIC_BASE_URL env vars."
    );
  }

  const redirectUri = `${PUBLIC_BASE_URL}/vk/callback`;

  // state нужен, чтобы понимать куда возвращать (apk/web)
  // by default считаем APK
  const state = req.query.platform === "web" ? "web" : "apk";

  const url = buildUrl(VK_AUTHORIZE_URL, {
    client_id: VK_CLIENT_ID,
    display: "page",              // браузерная страница
    redirect_uri: redirectUri,
    scope: "groups",              // чтобы получить админские сообщества
    response_type: "code",
    v: VK_API_V,
    state
  });

  res.redirect(url);
});

// 2) callback: code -> token, потом получаем админские сообщества, выдаём ticket
app.get("/vk/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state || "apk";
    if (!code) return res.status(400).send("No code");

    const redirectUri = `${PUBLIC_BASE_URL}/vk/callback`;

    // обмен code -> token
    const tokenUrl = buildUrl(VK_TOKEN_URL, {
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code
    });

    const tokenResp = await fetchJson(tokenUrl);
    if (tokenResp.error) {
      return res.status(400).send(`VK token error: ${tokenResp.error_description || tokenResp.error}`);
    }

    const accessToken = tokenResp.access_token;
    const userId = tokenResp.user_id;

    // Берём сообщества, где админ
    const groupsResp = await vkCall("groups.get", {
      access_token: accessToken,
      filter: "admin",
      extended: 1,
      fields: "name,screen_name,photo_50",
      count: 200
    });

    const groups = Array.isArray(groupsResp?.items) ? groupsResp.items : [];

    // Создаём одноразовый ticket (чтобы не светить токен в deeplink)
    const ticket = uid();
    tickets.set(ticket, { createdAt: now(), token: accessToken, userId, groups });

    if (state === "web") {
      // веб-возврат (если вдруг используешь в браузере)
      const webReturn = `${PUBLIC_BASE_URL}/web-return.html?ticket=${encodeURIComponent(ticket)}`;
      return res.redirect(webReturn);
    }

    // Возврат в APK (deeplink твоего приложения)
    const appReturn = `${APP_DEEPLINK}?ticket=${encodeURIComponent(ticket)}`;
    return res.redirect(appReturn);
  } catch (e) {
    res.status(500).send(`Callback error: ${e.message || e}`);
  }
});

// 3) Забрать ticket (одноразово)
app.get("/vk/ticket/:ticket", (req, res) => {
  const t = req.params.ticket;
  const data = tickets.get(t);
  if (!data) return res.status(404).json({ error: "ticket_not_found" });

  tickets.delete(t); // одноразовый
  res.json({
    userId: data.userId,
    groups: data.groups
  });
});

app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("VK bridge listening on", PORT));