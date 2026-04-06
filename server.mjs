import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const EVENT_ID = String(process.env.DG_EVENT_ID || "539");

const API_SEARCH = "https://admin.dg-edge.com/api/b.events.searchPlayers";
const API_PLAYER_PAGE =
  "https://admin.dg-edge.com/api/b.events.retrievePlayerPage";

const CACHE_FILE = process.env.CACHE_FILE || "./cache.json";
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS || 60 * 60 * 1000);
const PAGE_AUTO_REFRESH_MS = Number(process.env.PAGE_AUTO_REFRESH_MS || 60000);

let csrfToken = process.env.DG_CSRF_TOKEN || "";
let lastUpdated = null;
let lastError = null;
let cachedRows = [];
let refreshPromise = null;
let isRefreshing = false;

// ---- utils
function readPsids() {
  console.log("Reading psids from psids.txt");
  return fs
    .readFileSync("./psids.txt", "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildHeaders() {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: "https://www.dg-edge.com",
    referer: "https://www.dg-edge.com/",
    "user-agent": "Mozilla/5.0",
    "x-csrf-token": csrfToken,
    cookie: process.env.DG_COOKIE || "",
  };
}

async function fetchJson(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(bodyObj),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${txt.slice(0, 300)}`);
  }

  return await res.json();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(date) {
  if (!date) return "never";

  const d = new Date(date);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function timeToMs(time) {
  if (time == null) return Number.POSITIVE_INFINITY;
  if (typeof time === "number") return time;

  const s = String(time).trim();
  const m = s.match(/^(\d+):(\d{2})\.(\d{1,3})$/);
  if (!m) return Number.POSITIVE_INFINITY;

  const minutes = parseInt(m[1], 10);
  const seconds = parseInt(m[2], 10);
  const millis = parseInt(m[3].padEnd(3, "0"), 10);
  return minutes * 60000 + seconds * 1000 + millis;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCachePayload() {
  return {
    eventId: EVENT_ID,
    lastUpdated: lastUpdated ? lastUpdated.toISOString() : null,
    lastError,
    rows: cachedRows,
  };
}

function ensureCacheDirExists() {
  const dir = path.dirname(CACHE_FILE);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveCacheToFile() {
  ensureCacheDirExists();
  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify(getCachePayload(), null, 2),
    "utf8",
  );
}

function loadCacheFromFile() {
  if (!fs.existsSync(CACHE_FILE)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    cachedRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    lastError = parsed?.lastError ?? null;
    lastUpdated = parsed?.lastUpdated ? new Date(parsed.lastUpdated) : null;

    console.log(`Cache loaded from file: ${CACHE_FILE}`);
    return true;
  } catch (e) {
    console.error("Failed to load cache file:", e);
    lastError = `Cache file read error: ${e?.message ?? String(e)}`;
    return false;
  }
}

function getCacheFileMtimeMs() {
  if (!fs.existsSync(CACHE_FILE)) {
    return null;
  }

  const stat = fs.statSync(CACHE_FILE);
  return stat.mtimeMs;
}

function isCacheExpired() {
  const mtimeMs = getCacheFileMtimeMs();
  if (mtimeMs == null) {
    return true;
  }

  const age = Date.now() - mtimeMs;
  return age > CACHE_MAX_AGE_MS;
}

function hasUsableCache() {
  return fs.existsSync(CACHE_FILE) || cachedRows.length > 0;
}

function setNoCacheHeaders(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

// ---- API calls
async function searchPlayer(psid) {
  console.log(`Searching player: ${psid}`);
  const body = {
    query: psid,
    options: { eventId: EVENT_ID },
    language: "EN",
    version: 158,
    cookieVersion: null,
    ajax_referer: `/events/dailies/${EVENT_ID}`,
    tz: "Europe/Stockholm",
  };

  const json = await fetchJson(API_SEARCH, body);

  if (json?.csrfToken && typeof json.csrfToken === "string") {
    csrfToken = json.csrfToken;
  }

  if (!json?.success) {
    throw new Error(`searchPlayers: success=false for ${psid}`);
  }

  const payload = Array.isArray(json.payload) ? json.payload : [];
  const hit =
    payload.find(
      (p) => String(p?.onlineId ?? "").toLowerCase() === psid.toLowerCase(),
    ) ?? payload[0];

  return {
    playerId: hit?.id ?? null,
    nickname: hit?.nickname ?? null,
    onlineId: hit?.onlineId ?? psid,
  };
}

async function retrievePlayerPage(playerId) {
  console.log(`Retrieving player page for playerId: ${playerId}`);
  const body = {
    eventId: EVENT_ID,
    playerId,
    filters: {
      region: 0,
      countryCode: "0",
      dr: 0,
      sr: 0,
      controllerType: 0,
      vr: 0,
      tm: 0,
      car: 0,
      freshness: 0,
    },
    language: "EN",
    version: 158,
    cookieVersion: null,
    ajax_referer: `/events/dailies/${EVENT_ID}`,
    tz: "Europe/Stockholm",
  };

  const json = await fetchJson(API_PLAYER_PAGE, body);

  if (json?.csrfToken && typeof json.csrfToken === "string") {
    csrfToken = json.csrfToken;
  }

  if (!json?.success) {
    throw new Error(
      `retrievePlayerPage: success=false for playerId=${playerId}`,
    );
  }

  return json;
}

// ---- matching + row building
function findPlayerEntry(pageJson, playerId) {
  console.log(`Finding player entry for playerId: ${playerId}`);
  const list = pageJson?.payload?.list;
  if (!Array.isArray(list)) return null;

  return (
    list.find((item) => item?.playerId === playerId) ||
    list.find((item) => item?.player?.playerId === playerId) ||
    list.find((item) => item?.player?.id === playerId) ||
    null
  );
}

function buildRowFromEntry(onlineIdFallback, playerId, entry) {
  console.log(`Building row for playerId: ${playerId}`);
  if (!entry) {
    return {
      onlineId: onlineIdFallback,
      nickname: null,
      playerId,
      position: null,
      countryCode: null,
      DR: null,
      SR: null,
      time: null,
      timeMS: Number.POSITIVE_INFINITY,
      carBrand: null,
      carName: null,
      timestamp: null,
      status: "Nincs még futott idő",
    };
  }

  const p = entry.player ?? {};
  const c = entry.car ?? {};

  return {
    onlineId: p.onlineId ?? onlineIdFallback,
    nickname: p.nickname ?? null,
    playerId,
    position: entry.position ?? null,
    countryCode: p.countryCode ?? null,
    DR: p.DR ?? null,
    SR: p.SR ?? null,
    time: entry.time ?? null,
    timeMS: entry.timeMS ?? timeToMs(entry.time),
    carBrand: c.brand ?? null,
    carName: c.name ?? null,
    timestamp: entry.timestamp ?? null,
    status: "ok",
  };
}

// ---- HTML
function renderHtml() {
  console.log("Rendering HTML");
  const updated = formatDateTime(lastUpdated);
  const err = lastError
    ? `<p style="color:#b00020; text-align:center; font-weight:700;">Last error: ${escapeHtml(lastError)}</p>`
    : "";

  const refreshBanner = isRefreshing
    ? `
      <div style="
        background:#fff3cd;
        border:2px solid #ffcc00;
        color:#856404;
        padding:14px 18px;
        border-radius:10px;
        margin:16px auto;
        width:80%;
        font-weight:700;
        text-align:center;
        box-shadow:0 2px 8px rgba(0,0,0,0.08);
      ">
        ⏳ A lista frissítése jelenleg folyamatban van, kis türelmet...
        <div style="font-size:12px; margin-top:8px; font-weight:500;">
          Az oldal 60 másodpercenként automatikusan frissül.
        </div>
      </div>
    `
    : "";

  const autoRefreshScript = isRefreshing
    ? `
      <script>
        setTimeout(() => {
          window.location.reload();
        }, ${PAGE_AUTO_REFRESH_MS});
      </script>
    `
    : "";

  const rowsHtml = cachedRows
    .map((r, idx) => {
      const nameCell = `
      <div style="font-weight:700">${escapeHtml(r.nickname ?? "")}</div>
      <div style="font-size:12px; opacity:.75">${escapeHtml(
        r.onlineId ?? "",
      )}</div>
    `;

      const carCell = `
      <div>${escapeHtml(r.carBrand ?? "")}</div>
      <div style="font-size:12px; opacity:.75">${escapeHtml(
        r.carName ?? "",
      )}</div>
    `;

      const ratingCell = `${escapeHtml(r.DR ?? "")} / ${escapeHtml(
        r.SR ?? "",
      )}`;

      return `
      <tr>
        <td>${idx + 1}</td>
        <td>${nameCell}</td>
        <td>${ratingCell}</td>
        <td style="font-variant-numeric: tabular-nums">
          ${escapeHtml(r.time ?? "N/A")}
          <div style="font-size:12px; opacity:.75">${escapeHtml(
            r.timestamp ?? "",
          )}</div>
        </td>
        <td>${carCell}</td>
      </tr>
    `;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Phoenix League - Kvalifikáció</title>
  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      padding: 16px;
    }
    .meta {
      display:flex;
      gap:12px;
      align-items:center;
      justify-content:center;
      flex-wrap:wrap;
      margin-bottom:12px;
    }
    .pill {
      background:#eee;
      padding:6px 10px;
      border-radius:999px;
      font-size:12px;
    }
    table {
      border-collapse: collapse;
      width: 80%;
      margin: 20px auto;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 10px;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: #f6f6f6;
      text-align:left;
    }
    h1 {
      text-align:center;
    }
  </style>
</head>
<body>
  <h1>Phoenix League - Kvalifikáció</h1>

  <div class="meta">
    <span class="pill">Utolsó frissítés: ${escapeHtml(updated)}</span>
    <span class="pill">Regisztrált versenyzők száma: ${cachedRows.length}</span>
    <span class="pill">Futott idők száma: ${cachedRows.filter((r) => r.time !== null).length}</span>
  </div>

  ${err}
  ${refreshBanner}

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Pilóta</th>
        <th>DR/SR</th>
        <th>Időeredmény</th>
        <th>Autó</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="5">Nincsenek adatok.</td></tr>`}
    </tbody>
  </table>

  ${autoRefreshScript}
</body>
</html>`;
}

// ---- cache refresh
async function updateCache() {
  console.log("--------------------------------");
  console.log("Updating cache...");

  isRefreshing = true;

  try {
    lastError = null;
    const psids = readPsids();
    const rows = [];

    for (const psid of psids) {
      try {
        const sp = await searchPlayer(psid);

        if (!sp.playerId) {
          rows.push({
            onlineId: sp.onlineId,
            nickname: sp.nickname,
            playerId: null,
            position: null,
            countryCode: null,
            DR: null,
            SR: null,
            time: null,
            timeMS: Number.POSITIVE_INFINITY,
            carBrand: null,
            carName: null,
            timestamp: null,
            status: "Nem vett részt az eseményen még",
          });
          continue;
        }

        const page = await retrievePlayerPage(sp.playerId);
        const entry = findPlayerEntry(page, sp.playerId);
        const row = buildRowFromEntry(sp.onlineId, sp.playerId, entry);
        rows.push(row);

        await delay(250);
      } catch (e) {
        rows.push({
          onlineId: psid,
          nickname: null,
          playerId: null,
          position: null,
          countryCode: null,
          DR: null,
          SR: null,
          time: null,
          timeMS: Number.POSITIVE_INFINITY,
          carBrand: null,
          carName: null,
          timestamp: null,
          status: `error: ${e?.message ?? String(e)}`,
        });
      }
    }

    rows.sort((a, b) => a.timeMS - b.timeMS);

    cachedRows = rows;
    lastUpdated = new Date();

    saveCacheToFile();
    console.log("Cache updated and saved to file.");
  } catch (e) {
    lastError = e?.message ?? String(e);
    console.error("updateCache failed:", e);

    try {
      saveCacheToFile();
    } catch (writeErr) {
      console.error("Failed to save cache after error:", writeErr);
    }
  } finally {
    isRefreshing = false;
  }
}

function startRefreshInBackground(force = false) {
  if (refreshPromise) {
    return refreshPromise;
  }

  if (!force && !isCacheExpired()) {
    return null;
  }

  refreshPromise = (async () => {
    try {
      await updateCache();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function ensureFreshCacheForForceRefresh() {
  if (refreshPromise) {
    await refreshPromise;
    return;
  }

  refreshPromise = (async () => {
    try {
      await updateCache();
    } finally {
      refreshPromise = null;
    }
  })();

  await refreshPromise;
}

// ---- routes
app.get("/", async (req, res) => {
  try {
    setNoCacheHeaders(res);
    loadCacheFromFile();

    const cacheExpired = isCacheExpired();

    if (cacheExpired) {
      if (hasUsableCache()) {
        startRefreshInBackground(false);
      } else {
        await ensureFreshCacheForForceRefresh();
      }
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(renderHtml());
  } catch (e) {
    res
      .status(500)
      .send(`Server error: ${escapeHtml(e?.message ?? String(e))}`);
  }
});

app.get("/health", async (req, res) => {
  try {
    setNoCacheHeaders(res);
    loadCacheFromFile();

    const cacheExpired = isCacheExpired();

    if (cacheExpired) {
      if (hasUsableCache()) {
        startRefreshInBackground(false);
      } else {
        await ensureFreshCacheForForceRefresh();
      }
    }

    res.json({
      ok: true,
      eventId: EVENT_ID,
      lastUpdated,
      lastError,
      count: cachedRows.length,
      cacheFile: CACHE_FILE,
      cacheExpired: isCacheExpired(),
      isRefreshing,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      eventId: EVENT_ID,
      error: e?.message ?? String(e),
    });
  }
});

app.get("/refresh", async (req, res) => {
  if (req.query.key !== process.env.REFRESH_KEY) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  try {
    setNoCacheHeaders(res);
    await ensureFreshCacheForForceRefresh();

    res.json({
      ok: true,
      forced: true,
      eventId: EVENT_ID,
      lastUpdated,
      lastError,
      count: cachedRows.length,
      isRefreshing,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      forced: true,
      eventId: EVENT_ID,
      error: e?.message ?? String(e),
    });
  }
});

// ---- start
(async () => {
  loadCacheFromFile();

  if (!hasUsableCache()) {
    try {
      await ensureFreshCacheForForceRefresh();
    } catch (e) {
      console.error("Initial cache warm-up failed:", e);
    }
  }

  app.listen(PORT, () => {
    console.log(`Open: http://localhost:${PORT}`);
  });
})();
