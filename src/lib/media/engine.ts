// Engine selection layer — the yt-dlp engine can run in two modes:
//
//  1. "python"  — spawn python3 + python/extract.py / download.py (the
//     original setup; used on z.ai where a real python3 + venv exists).
//  2. "cli"     — spawn the yt-dlp standalone binary (bin/yt-dlp, a
//     self-contained yt-dlp build that needs NO python interpreter).
//     Used on Vercel where no python3 exists in the Node runtime.
//
// BOTH modes are 100% yt-dlp + cookies — no third-party download APIs.
// Selection: VERCEL=1 or RENDER=true → cli · YTDL_ENGINE=cli|python forces
// a mode · otherwise (z.ai / local dev) → python.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function useCliEngine(): boolean {
  const forced = (process.env.YTDL_ENGINE || "").toLowerCase();
  if (forced === "cli") return true;
  if (forced === "python") return false;
  // Serverless / container hosts ship no python3 in the Node runtime →
  // use the self-contained yt-dlp binary (Vercel, Render, etc.).
  return process.env.VERCEL === "1" || process.env.RENDER === "true";
}

/**
 * True ONLY on hosts where in-memory job state cannot survive between
 * requests (Vercel lambdas) → downloads must finish inside one request.
 * Render is a persistent server: it keeps the job + progress-page flow,
 * which avoids holding a single HTTP request open for minutes (Render's
 * proxy would cut long requests mid-download).
 */
export function isServerlessHost(): boolean {
  return process.env.VERCEL === "1";
}

function ensureExec(p: string): void {
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      /* read-only fs — nothing to do */
    }
  }
}

/** Absolute path of the bundled yt-dlp standalone binary. */
export function ytDlpCliPath(): string {
  const p = path.join(process.cwd(), "bin", "yt-dlp");
  ensureExec(p);
  return p;
}

/**
 * ffmpeg binary resolution order:
 *   1. $FFMPEG_PATH (explicit override)
 *   2. ffmpeg-static npm package (bundled with the repo on Vercel)
 *   3. system ffmpeg (z.ai / local dev)
 */
export function resolveFfmpegBin(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) {
      ensureExec(p);
      return p;
    }
  } catch {
    /* not installed */
  }
  return "ffmpeg";
}

/** Args that must ALWAYS precede the rest of every CLI invocation. */
export function cliBaseArgs(): string[] {
  // yt-dlp's CLI defaults to the deno JS runtime only; YouTube's nsig
  // challenge needs node (or another runtime) or formats go missing.
  // Hosts without bun (Render native) can override via YTDL_JS_RUNTIMES=node.
  const env = (process.env.YTDL_JS_RUNTIMES || "").trim();
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((rt) => ["--js-runtimes", rt]);
  }
  return ["--js-runtimes", "node", "--js-runtimes", "bun"];
}

/**
 * yt-dlp writes cookie updates back to the cookiefile after every
 * extraction. On Vercel the bundle (/var/task) is READ-ONLY, so the
 * cookie must be copied to a writable temp path first — otherwise the
 * run crashes with "Read-only file system".
 */
export function writableCookiePath(cookiefile: string | null | undefined): string | null {
  if (!cookiefile) return null;
  try {
    if (cookiefile.startsWith(os.tmpdir())) return cookiefile;
  } catch {
    /* fall through */
  }
  try {
    const dest = path.join(os.tmpdir(), `ck_${crypto.randomBytes(4).toString("hex")}_${path.basename(cookiefile)}`);
    fs.copyFileSync(cookiefile, dest);
    return dest;
  } catch {
    return cookiefile;
  }
}

// ── Outbound proxy pool ────────────────────────────────────────────────
// YouTube challenges datacenter IPs (Render free etc.) at the player API:
// "Failed to extract any player response" no matter which cookie is used.
// Routing the SAME yt-dlp + cookies extraction through a proxy gives it a
// different outbound IP. Sources (merged, deduped):
//   1. YTDL_PROXIES env  — comma/newline separated, user-provided (best:
//      paid residential/ISP proxies are stable; free public ones rotate)
//   2. python/proxies.txt — one host:port per line, "#" comments allowed
//      (bootstrap pool; can be refreshed at runtime via /api/admin/proxies)
// Rotation mirrors the cookie pool: last-good first, failures cool down so
// dead proxies are skipped fast. All traffic stays HTTPS (CONNECT tunnel)
// — the proxy sees only the domain, never cookie contents.
export interface ProxySlot {
  url: string;
  deadUntil: number;
}

interface ProxyState {
  slots: ProxySlot[] | null;
  idx: number;
  lastGood: string | null;
  mtimeKey: string;
}

const _gp = globalThis as unknown as { __mediaProxyState?: ProxyState };

function proxyState(): ProxyState {
  if (!_gp.__mediaProxyState) _gp.__mediaProxyState = { slots: null, idx: 0, lastGood: null, mtimeKey: "" };
  return _gp.__mediaProxyState;
}

/** Writable runtime pool file — admin refresh writes here first. */
export function runtimeProxyPoolPath(): string {
  return path.join(os.tmpdir(), "ytdl_proxy_pool.txt");
}

function parseProxyLines(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((s) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)); // bare ip:port → http://
}

function loadProxies(): ProxySlot[] {
  const st = proxyState();
  const seedFile = path.join(process.cwd(), "python", "proxies.txt");
  const runtimeFile = runtimeProxyPoolPath();
  let key = "";
  try {
    key = `${fs.statSync(seedFile).mtimeMs || 0}|${fs.statSync(runtimeFile).mtimeMs || 0}`;
  } catch {
    /* missing files → mtime 0 */
  }
  if (st.slots && st.mtimeKey === key) return st.slots;

  const urls: string[] = [];
  const env = (process.env.YTDL_PROXIES || "").trim();
  if (env) urls.push(...parseProxyLines(env));
  try {
    urls.push(...parseProxyLines(fs.readFileSync(seedFile, "utf-8")));
  } catch {
    /* no seed file */
  }
  // Runtime-maintained pool (admin refresh) takes precedence: read it LAST
  // and if non-empty, use it INSTEAD of the seed (it is fresher).
  let runtime: string[] = [];
  try {
    runtime = parseProxyLines(fs.readFileSync(runtimeFile, "utf-8"));
  } catch {
    /* no runtime pool yet */
  }
  const final = runtime.length ? runtime : urls;
  st.mtimeKey = key;
  st.slots = [...new Set(final)].map((url) => ({ url, deadUntil: 0 }));
  st.idx = 0;
  if (st.lastGood && !st.slots.some((s) => s.url === st.lastGood)) st.lastGood = null;
  return st.slots;
}

function healthySlots(): ProxySlot[] {
  const now = Date.now();
  return loadProxies().filter((s) => s.deadUntil < now);
}

/** Next proxy to try — last-good first, then round-robin over healthy. */
export function getNextProxy(): string | null {
  const slots = loadProxies();
  const st = proxyState();
  if (st.lastGood) {
    const g = slots.find((s) => s.url === st.lastGood);
    if (g && g.deadUntil < Date.now()) return g.url;
    st.lastGood = null;
  }
  const h = healthySlots();
  if (!h.length) return null;
  const slot = h[st.idx % h.length];
  st.idx = (st.idx + 1) % Math.max(1, h.length);
  return slot.url;
}

export function markProxyGood(url: string): void {
  const st = proxyState();
  st.lastGood = url;
  const slot = loadProxies().find((s) => s.url === url);
  if (slot) slot.deadUntil = 0;
}

export function markProxyDead(url: string, ms: number): void {
  const st = proxyState();
  if (st.lastGood === url) st.lastGood = null;
  const slot = loadProxies().find((s) => s.url === url);
  if (slot) slot.deadUntil = Date.now() + ms;
}

export function healthyProxyCount(): number {
  return healthySlots().length;
}

// ── Background pool refresh ────────────────────────────────────────────
// Free public proxies die within hours. When the walk finds no healthy
// proxy (or the global walk failed), fetch fresh lists, CONNECT-validate
// them against YouTube and swap the pool — throttled so parallel requests
// cannot stampede. Mirrors POST /api/admin/proxies (which calls this too).
const _gRefresh = globalThis as unknown as {
  __proxyPoolRefreshBusy?: boolean;
  __proxyPoolRefreshAt?: number;
};

const PROXY_LIST_SOURCES = [
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt",
];

async function fetchTextTimeout(url: string, timeoutMs: number): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/** CONNECT-check one proxy against youtube.com/generate_204. */
function checkProxyAlive(proxy: string, timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        "curl",
        ["-x", proxy, "--max-time", String(timeoutSec), "-o", "/dev/null", "-sS", "-w", "%{http_code}", "https://www.youtube.com/generate_204"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: (timeoutSec + 4) * 1000 }
      );
      let out = "";
      proc.stdout!.on("data", (d) => (out += d.toString()));
      proc.on("error", () => resolve(false));
      proc.on("close", () => resolve(out.trim() === "204"));
    } catch {
      resolve(false);
    }
  });
}

/** CDN throughput probe — media downloads die on proxies slower than this. */
function proxyThroughput(proxy: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        "curl",
        ["-x", proxy, "--max-time", "12", "-o", "/dev/null", "-sS", "-w", "%{speed_download}", "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 16_000 }
      );
      let out = "";
      proc.stdout!.on("data", (d) => (out += d.toString()));
      proc.on("error", () => resolve(0));
      proc.on("close", () => {
        const v = parseFloat(out.trim());
        resolve(Number.isFinite(v) ? v : 0);
      });
    } catch {
      resolve(0);
    }
  });
}

async function runMap<T, R>(items: T[], conc: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Fetch + validate a fresh pool. Returns the number of healthy proxies
 * written (0 = sources unreachable / nothing validated).
 */
export async function refreshProxyPool(): Promise<number> {
  const raw = new Set<string>();
  for (const u of PROXY_LIST_SOURCES) {
    const txt = await fetchTextTimeout(u, 20_000);
    txt
      .split(/[\n,]+/)
      .forEach((l) => {
        const s = l.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s)) raw.add(s);
      });
  }
  const candidates = [...raw].sort(() => Math.random() - 0.5).slice(0, 220);
  if (!candidates.length) return 0;

  const alive: string[] = [];
  const flags = await runMap(candidates, 16, (c) => checkProxyAlive(`http://${c}`, 8));
  candidates.forEach((c, i) => {
    if (flags[i]) alive.push(c);
  });
  if (!alive.length) return 0;

  // Throughput filter — keep proxies that can actually move media bytes.
  const speeds = await runMap(alive.slice(0, 60), 16, (p) => proxyThroughput(`http://${p}`));
  const ranked = alive
    .slice(0, 60)
    .map((p, i) => ({ p, v: speeds[i] || 0 }))
    .sort((a, b) => b.v - a.v);
  const usable = ranked.filter((x) => x.v >= 60_000).slice(0, 28).map((x) => x.p);
  const final = usable.length ? usable : ranked.slice(0, 12).map((x) => x.p);

  // Persist to the runtime pool (app dir may be read-only on some hosts).
  const poolFile = runtimeProxyPoolPath();
  const body = final.join("\n") + (final.length ? "\n" : "");
  try {
    fs.writeFileSync(poolFile, body);
  } catch {
    try {
      fs.writeFileSync(path.join(process.cwd(), "python", "proxies.txt"), body);
    } catch {
      /* read-only fs — pool stays in-memory only for this boot */
    }
  }
  // Force the next loadProxies() to re-read (mtime may not change fast enough)
  proxyState().mtimeKey = "";
  proxyState().slots = null;
  return final.length;
}

/** Fire-and-forget refresh — throttled to one run per 10 minutes. */
export function refreshProxyPoolAsync(): void {
  const g = _gRefresh;
  if (g.__proxyPoolRefreshBusy) return;
  if (g.__proxyPoolRefreshAt && Date.now() - g.__proxyPoolRefreshAt < 600_000) return;
  g.__proxyPoolRefreshBusy = true;
  g.__proxyPoolRefreshAt = Date.now();
  console.log("[proxies] background pool refresh starting");
  refreshProxyPool()
    .then((n) => console.log(`[proxies] background refresh done: ${n} healthy`))
    .catch((e) => console.log(`[proxies] background refresh failed: ${(e as Error).message}`))
    .finally(() => {
      g.__proxyPoolRefreshBusy = false;
    });
}

/** Debug/admin snapshot — never exposes more than host:port of public pool. */
export function proxyPoolStatus(): {
  total: number;
  healthy: number;
  lastGood: string | null;
  sources: string[];
  proxies: string[];
} {
  const slots = loadProxies();
  const now = Date.now();
  const sources: string[] = [];
  if ((process.env.YTDL_PROXIES || "").trim()) sources.push("env:YTDL_PROXIES");
  try {
    fs.accessSync(path.join(process.cwd(), "python", "proxies.txt"));
    sources.push("python/proxies.txt");
  } catch {
    /* absent */
  }
  try {
    fs.accessSync(runtimeProxyPoolPath());
    sources.push("runtime pool");
  } catch {
    /* absent */
  }
  return {
    total: slots.length,
    healthy: slots.filter((s) => s.deadUntil < now).length,
    lastGood: proxyState().lastGood,
    sources,
    proxies: slots.map((s) => `${s.url}${s.deadUntil >= now ? " (cooling)" : ""}`),
  };
}
