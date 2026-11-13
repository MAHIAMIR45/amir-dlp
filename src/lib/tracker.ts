// Analytics tracker — port of the admin panel + analytics system in app.py.
// In-memory state with JSON persistence to data/admin_data.json, geo lookup
// via ipwho.is, and API health monitoring.
import fs from "node:fs";
import path from "node:path";
import { detectPlatform, flagEmoji, USER_AGENT } from "./media/urls";

export interface RequestRecord {
  ip: string;
  country: string;
  country_code: string;
  city: string;
  isp: string;
  region: string;
  path: string;
  method: string;
  url: string;
  platform: string;
  status: number | null;
  error: string;
  ua: string;
  referrer: string;
  time: string;
  ts: number;
}

interface SessionRecord {
  first_seen: string;
  last_seen: string;
  first_ts: number;
  last_ts: number;
  count: number;
  country: string;
  country_code: string;
  city: string;
  isp: string;
  region: string;
  ua: string;
  platforms: Record<string, number>;
  paths: Record<string, number>;
  requests: { url: string; path: string; platform: string; status: number | null; time: string; method: string }[];
}

interface HealthStatus {
  name: string;
  platform: string;
  status: "up" | "down" | "degraded";
  latency: number | null;
  last_check: string;
  last_ok?: string;
  error?: string;
  probe_ok?: boolean;
}

interface TrackerState {
  requestLog: RequestRecord[];
  platformCounts: Record<string, number>;
  platformErrors: Record<string, number>;
  ipSessions: Record<string, SessionRecord>;
  countryCache: Record<string, GeoInfo>;
  hourlyTraffic: Record<string, number>;
  dailyTraffic: Record<string, number>;
  processStart: Date;
  healthStatus: Record<string, HealthStatus>;
  healthRunning: boolean;
  persistTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  loaded: boolean;
}

interface GeoInfo {
  country: string;
  country_code: string;
  city: string;
  isp: string;
  region: string;
}

const g = globalThis as unknown as { __trackerState?: TrackerState };

function state(): TrackerState {
  if (g.__trackerState) return g.__trackerState;
  const s: TrackerState = {
    requestLog: [],
    platformCounts: { youtube: 0, tiktok: 0, pinterest: 0, facebook: 0, other: 0, admin_page: 0, unknown: 0 },
    platformErrors: {},
    ipSessions: {},
    countryCache: {},
    hourlyTraffic: {},
    dailyTraffic: {},
    processStart: new Date(),
    healthStatus: {},
    healthRunning: false,
    persistTimer: null,
    healthTimer: null,
    loaded: false,
  };
  g.__trackerState = s;
  loadPersisted(s);
  ensureTimers(s);
  return s;
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "admin_data.json");

function loadPersisted(s: TrackerState) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (Array.isArray(raw.ip_sessions)) {
      // older format (python) uses dict; ours uses dict as well
      s.ipSessions = raw.ip_sessions || {};
    }
    s.platformCounts = { ...s.platformCounts, ...(raw.platform_counts || {}) };
    s.platformErrors = raw.platform_errors || {};
    s.dailyTraffic = raw.daily_traffic || {};
    s.healthStatus = raw.health_status || {};
    if (raw.process_start) {
      const d = new Date(String(raw.process_start).replace(" ", "T"));
      if (!Number.isNaN(d.getTime())) s.processStart = d;
    }
    // rehydrate requestLog from sessions (best effort, last 200)
    const reqs: RequestRecord[] = [];
    for (const [, sess] of Object.entries(s.ipSessions)) {
      for (const r of sess.requests || []) {
        reqs.push({
          ip: "",
          country: sess.country || "",
          country_code: sess.country_code || "",
          city: sess.city || "",
          isp: sess.isp || "",
          region: sess.region || "",
          path: r.path || "",
          method: r.method || "GET",
          url: r.url || "",
          platform: r.platform || "other",
          status: r.status ?? null,
          error: "",
          ua: sess.ua || "",
          referrer: "",
          time: r.time || "",
          ts: 0,
        });
      }
    }
    s.requestLog = reqs.slice(-200);
    s.loaded = true;
  } catch {
    /* fresh start */
  }
}

function persist(s: TrackerState) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const snapshot = {
      platform_counts: s.platformCounts,
      platform_errors: s.platformErrors,
      ip_sessions: s.ipSessions,
      daily_traffic: s.dailyTraffic,
      health_status: s.healthStatus,
      process_start: fmtDateTime(s.processStart),
    };
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, DATA_FILE);
  } catch {
    /* ignore */
  }
}

function ensureTimers(s: TrackerState) {
  if (!s.persistTimer) {
    s.persistTimer = setInterval(() => persist(s), 30_000);
    s.persistTimer.unref?.();
  }
  if (!s.healthTimer) {
    s.healthTimer = setInterval(() => {
      void runHealthCheck();
    }, 45_000);
    s.healthTimer.unref?.();
    void runHealthCheck(); // first check right away (async, non-blocking)
  }
}

export function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Geo lookup ────────────────────────────────────────────────────────

const LOCAL_GEO: GeoInfo = { country: "Local/Unknown", country_code: "XX", city: "", isp: "", region: "" };

async function lookupCountry(ip: string): Promise<GeoInfo> {
  if (!ip || ["127.0.0.1", "0.0.0.0", "::1", "localhost"].includes(ip)) return LOCAL_GEO;
  const s = state();
  if (s.countryCache[ip]) return s.countryCache[ip];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(`https://ipwho.is/${ip}`, { signal: ctl.signal, headers: { "User-Agent": USER_AGENT } });
      const data = (await res.json()) as Record<string, unknown>;
      const conn = (data.connection || {}) as Record<string, unknown>;
      const info: GeoInfo = {
        country: (data.country as string) || "Unknown",
        country_code: String(data.country_code || "XX").toUpperCase(),
        city: (data.city as string) || "",
        isp: (conn.isp as string) || "",
        region: (data.region as string) || "",
      };
      if (Object.keys(s.countryCache).length < 5000) s.countryCache[ip] = info;
      return info;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return { country: "Unknown", country_code: "XX", city: "", isp: "", region: "" };
  }
}

export function getClientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for") || headers.get("x-real-ip");
  if (fwd) return fwd.split(",")[0].trim();
  return "0.0.0.0";
}

// ── Track ─────────────────────────────────────────────────────────────

export function trackRequest(opts: {
  headers: Headers;
  path: string;
  method: string;
  url?: string | null;
  platform?: string | null;
  status?: number | null;
  error?: string | null;
}): RequestRecord {
  const s = state();
  const { headers, path: reqPath, method } = opts;
  const ip = getClientIp(headers);
  const now = new Date();
  const hourKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}`;
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const platform = opts.url ? detectPlatform(opts.url) : opts.platform || "unknown";
  const geo: GeoInfo = { country: "Unknown", country_code: "XX", city: "", isp: "", region: "" };
  const ua = (headers.get("user-agent") || "").slice(0, 200);
  const referrer = (headers.get("referer") || "").slice(0, 200);
  const time = fmtDateTime(now);

  const rec: RequestRecord = {
    ip,
    country: geo.country,
    country_code: geo.country_code,
    city: geo.city,
    isp: geo.isp,
    region: geo.region,
    path: reqPath,
    method,
    url: (opts.url || "").slice(0, 300),
    platform,
    status: opts.status ?? null,
    error: (opts.error || "").slice(0, 200),
    ua,
    referrer,
    time,
    ts: now.getTime(),
  };

  // update aggregates synchronously; geo enriched async
  s.requestLog.push(rec);
  if (s.requestLog.length > 3000) s.requestLog = s.requestLog.slice(-3000);
  const key = platform in s.platformCounts ? platform : "other";
  s.platformCounts[key] = (s.platformCounts[key] || 0) + 1;
  if (rec.error) s.platformErrors[platform] = (s.platformErrors[platform] || 0) + 1;
  s.hourlyTraffic[hourKey] = (s.hourlyTraffic[hourKey] || 0) + 1;
  s.dailyTraffic[dayKey] = (s.dailyTraffic[dayKey] || 0) + 1;

  let sess = s.ipSessions[ip];
  if (!sess) {
    sess = {
      first_seen: time,
      last_seen: time,
      first_ts: now.getTime(),
      last_ts: now.getTime(),
      count: 1,
      country: geo.country,
      country_code: geo.country_code,
      city: geo.city,
      isp: geo.isp,
      region: geo.region,
      ua,
      platforms: { [platform]: 1 },
      paths: { [reqPath]: 1 },
      requests: [{ url: rec.url, path: reqPath, platform, status: rec.status, time, method }],
    };
    s.ipSessions[ip] = sess;
  } else {
    sess.last_seen = time;
    sess.last_ts = now.getTime();
    sess.count += 1;
    sess.platforms[platform] = (sess.platforms[platform] || 0) + 1;
    sess.paths[reqPath] = (sess.paths[reqPath] || 0) + 1;
    sess.requests.push({ url: rec.url, path: reqPath, platform, status: rec.status, time, method });
    sess.requests = sess.requests.slice(-30);
    if (!sess.ua) sess.ua = ua;
  }

  // enrich geo asynchronously (updates record + session in place)
  void lookupCountry(ip).then((info) => {
    rec.country = info.country;
    rec.country_code = info.country_code;
    rec.city = info.city;
    rec.isp = info.isp;
    rec.region = info.region;
    sess.country = info.country;
    sess.country_code = info.country_code;
    sess.city = info.city;
    sess.isp = info.isp;
    sess.region = info.region;
  });

  return rec;
}

// ── Stats / sessions / requests ───────────────────────────────────────

export function getStats() {
  const s = state();
  const total = Object.values(s.platformCounts).reduce((a, v) => a + v, 0);
  const sessions = Object.values(s.ipSessions);
  const hourlyEntries = Object.entries(s.hourlyTraffic).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-24);
  const countries: Record<string, { country: string; count: number; ips: number }> = {};
  for (const sess of sessions) {
    const code = sess.country_code || "XX";
    if (!countries[code]) countries[code] = { country: sess.country || "Unknown", count: 0, ips: 0 };
    countries[code].count += sess.count || 1;
    countries[code].ips += 1;
  }
  const cc = Object.entries(countries)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 40)
    .map(([code, v]) => ({ code, country: v.country, count: v.count, ips: v.ips, flag: flagEmoji(code) }));

  return {
    total_requests: total,
    platform_counts: s.platformCounts,
    platform_errors: s.platformErrors,
    unique_ips: sessions.length,
    countries: cc,
    hourly_traffic: Object.fromEntries(hourlyEntries),
    daily_traffic: Object.fromEntries(
      Object.entries(s.dailyTraffic).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30)
    ),
    uptime: (Date.now() - s.processStart.getTime()) / 1000,
    process_start: fmtDateTime(s.processStart),
  };
}

export function getSessions(limit: number) {
  const s = state();
  const sorted = Object.entries(s.ipSessions)
    .sort((a, b) => (a[1].last_seen < b[1].last_seen ? 1 : -1))
    .slice(0, limit);
  const out = sorted.map(([ip, sess]) => {
    const reqs = sess.requests || [];
    const duration =
      sess.first_ts && sess.last_ts && sess.last_ts > sess.first_ts
        ? Math.floor((sess.last_ts - sess.first_ts) / 1000)
        : 0;
    return {
      ip,
      ...sess,
      flag: flagEmoji(sess.country_code),
      request_count: reqs.length,
      duration_seconds: duration,
    };
  });
  return { sessions: out, total: Object.keys(s.ipSessions).length };
}

export function getRequests(limit: number, platform?: string | null) {
  const s = state();
  let items = platform ? s.requestLog.filter((r) => r.platform === platform) : s.requestLog;
  items = items.slice(-limit);
  items = [...items].reverse();
  return { requests: items, total_filtered: items.length };
}

export function bumpAdminPage() {
  const s = state();
  s.platformCounts.admin_page = (s.platformCounts.admin_page || 0) + 1;
}

// ── Health monitor ────────────────────────────────────────────────────

const HEALTH_TARGETS: { name: string; platform: string; build: (u: string) => string; headers?: Record<string, string> }[] = [
  { name: "Nexray TikTok", platform: "tiktok", build: (u) => `https://api.nexray.eu.cc/downloader/tiktok?url=${u}` },
  { name: "TikTok Backup 1", platform: "tiktok", build: (u) => `https://mkzstyleee.vercel.app/download/tiktok?url=${u}&apikey=FREE-XODVNWPL-ERUF` },
  { name: "TikTok Backup 2", platform: "tiktok", build: (u) => `https://mkzstyleee.vercel.app/download/tiktok-v2?url=${u}&apikey=FREE-XODVNWPL-ERUF` },
  { name: "TikTok Backup 3 (jerrycoder)", platform: "tiktok", build: (u) => `https://jerrycoder.oggyapi.workers.dev/down/tiktok?url=${u}` },
  { name: "Nexray Pinterest", platform: "pinterest", build: (u) => `https://api.nexray.eu.cc/downloader/pinterest?url=${u}` },
  { name: "Pinterest Backup 1", platform: "pinterest", build: (u) => `https://mkzstyleee.vercel.app/download/pinterest?url=${u}&apikey=FREE-XODVNWPL-ERUF` },
  { name: "Pinterest Backup 2 (theresav)", platform: "pinterest", build: (u) => `https://api.theresav.eu/api/download/pinterest?url=${u}`, headers: { "x-apikey": "QkX9K" } },
  { name: "Facebook (theresav)", platform: "facebook", build: (u) => `https://api.theresav.eu/api/download/facebook?url=${u}`, headers: { "x-apikey": "QkX9K" } },
  { name: "Facebook Backup (elitepro)", platform: "facebook", build: (u) => `https://eliteprotech-apis.zone.id/facebook1?url=${u}` },
  { name: "Facebook Backup 2 (jerrycoder)", platform: "facebook", build: (u) => `https://jerrycoder.oggyapi.workers.dev/down/fb?url=${u}` },
  { name: "Nexray YouTube", platform: "youtube", build: (u) => `https://api.nexray.eu.cc/downloader/v1/ytmp4?url=${u}` },
];

const PROBE_URLS: Record<string, string> = {
  tiktok: "https://www.tiktok.com/@willsmith/video/7126995370870933806",
  pinterest: "https://www.pinterest.com/pin/824758858221769000/",
  facebook: "https://www.facebook.com/watch/?v=10156908315493390",
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};

async function checkSingle(target: (typeof HEALTH_TARGETS)[number], encoded: string) {
  const s = state();
  const now = fmtDateTime(new Date());
  const prev = s.healthStatus[target.name];
  let latency: number | null = null;
  let error: string | undefined;
  let okFlag = false;
  let rateLimited = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    const start = Date.now();
    try {
      const res = await fetch(target.build(encoded), {
        signal: ctl.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(target.headers || {}) },
      });
      latency = Date.now() - start;
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        rateLimited = res.status === 429 || res.status === 403;
      } else {
        const payload = (await res.json()) as Record<string, unknown>;
        okFlag = payload.status === true || payload.success === true;
      }
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    error = error || (e as Error).message;
  }
  const status: HealthStatus["status"] = okFlag ? "up" : rateLimited ? "down" : error && !latency ? "down" : "degraded";
  s.healthStatus[target.name] = {
    name: target.name,
    platform: target.platform,
    status,
    latency,
    last_check: now,
    last_ok: status === "up" ? now : prev?.last_ok,
    probe_ok: okFlag,
    error,
  };
}

export async function runHealthCheck() {
  const s = state();
  if (s.healthRunning) return;
  s.healthRunning = true;
  try {
    const encoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(PROBE_URLS)) encoded[k] = encodeURIComponent(v);
    await Promise.all(
      HEALTH_TARGETS.map((t) =>
        checkSingle(t, encoded[t.platform] || encoded.youtube).catch(() => {})
      )
    );
  } finally {
    s.healthRunning = false;
  }
}

export function getHealth() {
  const s = state();
  return {
    apis: Object.values(s.healthStatus),
    last_check: fmtDateTime(new Date()),
  };
}
