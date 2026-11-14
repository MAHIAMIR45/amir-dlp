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
    .filter((s) => s && !s.startsWith("#"));
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
