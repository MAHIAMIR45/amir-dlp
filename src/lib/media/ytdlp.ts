// yt-dlp bridge — spawns the Python extract.py script (z.ai) OR the
// standalone yt-dlp binary (Vercel). Ports the cookie-pool + player-client
// fallback strategy from app.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliBaseArgs, useCliEngine, writableCookiePath, ytDlpCliPath } from "./engine";

export interface SearchVideo {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  channel: string;
  views?: number | null;
  url: string;
}

export interface FormatEntry {
  format_id: string | null;
  ext: string | null;
  resolution: string | null;
  height: number | null;
  width: number | null;
  fps: number | null;
  vcodec: string;
  acodec: string;
  abr: number;
  vbr?: number | null;
  tbr?: number | null;
  filesize: number | null;
  filesize_human: string | null;
  format_note: string;
  has_video: boolean;
  has_audio: boolean;
  url: string | null;
}

export interface YtInfo {
  ok: boolean;
  error?: string;
  title?: string;
  thumbnail?: string;
  duration?: string;
  duration_sec?: number | null;
  channel?: string;
  description?: string;
  combined?: FormatEntry[];
  video_only?: FormatEntry[];
  audio_only?: FormatEntry[];
}

const _PY_CANDIDATES = ["/home/z/.venv/bin/python3", "python3", "/usr/bin/python3"];
let _pyPath: string | null = null;
let _pyChecked = false;

/** Resolve the python3 interpreter (exported — shared by dljobs + version route). */
export function resolvePython(): string {
  if (_pyChecked && _pyPath) return _pyPath;
  _pyChecked = true;
  for (const c of _PY_CANDIDATES) {
    try {
      if (c.startsWith("/")) {
        if (fs.existsSync(c)) {
          _pyPath = c;
          return _pyPath;
        }
      } else {
        // bare name — check PATH
        const dirs = (process.env.PATH || "").split(":");
        if (dirs.some((d) => fs.existsSync(path.join(d, c)))) {
          _pyPath = c;
          return _pyPath;
        }
      }
    } catch {
      /* keep trying */
    }
  }
  _pyPath = "/home/z/.venv/bin/python3";
  return _pyPath;
}

function scriptPath(): string {
  return path.join(process.cwd(), "python", "extract.py");
}

function runPython(args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  if (useCliEngine()) return runCliEngine(args, timeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Record<string, unknown>) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(resolvePython(), [scriptPath(), JSON.stringify(args)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", () => {});
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      proc.on("error", (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `python spawn failed: ${e.message}` });
      });
      proc.on("close", () => {
        clearTimeout(timer);
        const text = out.trim();
        const jsonStart = text.indexOf("{");
        if (jsonStart < 0) {
          finish({ ok: false, error: "empty yt-dlp output" });
          return;
        }
        try {
          finish(JSON.parse(text.slice(jsonStart)));
        } catch {
          finish({ ok: false, error: "bad yt-dlp JSON output" });
        }
      });
    } catch (e) {
      finish({ ok: false, error: `spawn error: ${(e as Error).message}` });
    }
  });
}

// ── CLI engine (Vercel: standalone yt-dlp binary — no python runtime) ─

function formatDurCli(sec: unknown): string {
  const n = typeof sec === "number" ? Math.floor(sec) : 0;
  if (!n || n <= 0) return "N/A";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function humanSizeCli(size: unknown): string | null {
  const n = typeof size === "number" ? size : 0;
  if (!n || n <= 0) return null;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildFormatEntryCli(fmt: any): FormatEntry {
  const vcodec = fmt.vcodec || "none";
  const acodec = fmt.acodec || "none";
  const hasVideo = !!vcodec && vcodec !== "none";
  const hasAudio = !!acodec && acodec !== "none";
  const width = typeof fmt.width === "number" ? fmt.width : null;
  const height = typeof fmt.height === "number" ? fmt.height : null;
  // Portrait videos (Shorts): YouTube names quality by the SHORT side.
  const portrait = !!(width && height && width !== height);
  const effHeight = portrait ? Math.min(width as number, height as number) : height;
  const size = fmt.filesize || fmt.filesize_approx || null;
  return {
    format_id: fmt.format_id ?? null,
    ext: fmt.ext ?? null,
    resolution: fmt.resolution || (width && height ? `${width}x${height}` : "audio only"),
    height: effHeight,
    width,
    fps: fmt.fps ?? null,
    vcodec,
    acodec,
    abr: fmt.abr || 0,
    vbr: fmt.vbr ?? null,
    tbr: fmt.tbr ?? null,
    filesize: size,
    filesize_human: humanSizeCli(size),
    format_note: (fmt.format_note || "") + (portrait ? " · portrait" : ""),
    has_video: hasVideo,
    has_audio: hasAudio,
    url: fmt.url ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function spawnCli(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
        // Own process group so a timeout can kill yt-dlp AND its JS-runtime
        // children (node/bun). Without this a lingering child holds the stdio
        // pipes open and delays 'close' by ~10s after every timed-out attempt
        // (visible on slow shared-CPU hosts like Render free).
        detached: true,
      });
    } catch (e) {
      resolve({ code: 1, stdout: "", stderr: String((e as Error).message || e), timedOut: false });
      return;
    }
    proc.stdout!.on("data", (d) => (stdout += d.toString()));
    proc.stderr!.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL"); // negative pid = whole group
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      try {
        proc.stdout!.destroy();
        proc.stderr!.destroy();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: 1, stdout, stderr: stderr || e.message, timedOut });
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout, stderr, timedOut });
      }
    });
  });
}

function cliErrorFrom(stderr: string, fallback: string): string {
  const lines = stderr.split("\n").filter((l) => l.startsWith("ERROR:"));
  if (lines.length) return lines[lines.length - 1].replace(/^ERROR:\s*/, "").slice(0, 400);
  const tail = stderr.trim().slice(-300);
  return tail || fallback;
}

function runCliEngine(args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  if (args.mode === "search") {
    return runCliSearch(String(args.q || ""), Number(args.limit || 12), timeoutMs);
  }
  return runCliInfo(args, timeoutMs);
}

async function runCliInfo(args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const url = String(args.url || "");
  const cookiefile = (args.cookiefile as string | null) || null;
  const client = (args.client as string | null) || null;
  const argv = [ytDlpCliPath(), ...cliBaseArgs(), "--ignore-no-formats-error", "--socket-timeout", "25", "--no-playlist", "-J"];
  const ck = writableCookiePath(cookiefile);
  if (ck) argv.push("--cookies", ck);
  if (client) argv.push("--extractor-args", `youtube:player_client=${client}`);
  argv.push(url);
  const r = await spawnCli(argv, timeoutMs);
  if (r.timedOut) {
    return { ok: false, error: `extraction timed out after ${Math.round(timeoutMs / 1000)}s on this server` };
  }
  if (r.code !== 0) {
    return { ok: false, error: cliErrorFrom(r.stderr, "extraction failed") };
  }
  let info: Record<string, any>;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "bad yt-dlp JSON output" };
  }
  const combined: FormatEntry[] = [];
  const video_only: FormatEntry[] = [];
  const audio_only: FormatEntry[] = [];
  const seen = new Set<string>();
  for (const fmt of (info.formats || []) as any[]) {
    if (!fmt || !fmt.url) continue;
    const fid = String(fmt.format_id ?? "");
    if (fid && seen.has(fid)) continue;
    if (fid) seen.add(fid);
    const entry = buildFormatEntryCli(fmt);
    if (entry.has_video && entry.has_audio) combined.push(entry);
    else if (entry.has_video) video_only.push(entry);
    else if (entry.has_audio) audio_only.push(entry);
  }
  const byHeight = (a: FormatEntry, b: FormatEntry) => (b.height || 0) - (a.height || 0);
  combined.sort(byHeight);
  video_only.sort(byHeight);
  audio_only.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  if (!(combined.length || video_only.length || audio_only.length)) {
    const joined = r.stderr;
    if (/HTTP Error 429|Too Many Requests/i.test(joined)) {
      return { ok: false, error: "YouTube is rate-limiting this server (HTTP 429) — please wait about a minute and try again" };
    }
    if (/[Ss]ign in to confirm|not a bot/i.test(joined)) {
      return { ok: false, error: "YouTube is asking to verify this session (bot check) — all cookies are being challenged right now, please try again in a few minutes" };
    }
    return { ok: false, error: "No downloadable formats (YouTube may be blocking this server)" };
  }
  return {
    ok: true,
    title: info.title ?? null,
    thumbnail: info.thumbnail ?? null,
    duration: formatDurCli(info.duration),
    duration_sec: typeof info.duration === "number" ? info.duration : null,
    channel: info.uploader || info.channel || "",
    description: String(info.description || "").slice(0, 300),
    combined,
    video_only,
    audio_only,
  };
}

async function runCliSearch(q: string, limit: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const argv = [
    ytDlpCliPath(),
    ...cliBaseArgs(),
    "--flat-playlist",
    "--socket-timeout",
    "20",
    "--no-playlist",
    "-J",
    `ytsearch${limit}:${q}`,
  ];
  const r = await spawnCli(argv, timeoutMs);
  if (r.timedOut) return { ok: false, error: "Search timed out" };
  if (r.code !== 0) return { ok: false, error: cliErrorFrom(r.stderr, "Search failed") };
  let data: Record<string, any>;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "bad yt-dlp JSON output" };
  }
  const videos: SearchVideo[] = [];
  for (const entry of (data.entries || []) as any[]) {
    if (!entry) continue;
    const vidId = String(entry.id || "");
    const thumbs = entry.thumbnails || [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`;
    videos.push({
      id: vidId,
      title: entry.title || "",
      thumbnail: thumb,
      duration: formatDurCli(entry.duration),
      channel: entry.channel || entry.uploader || "",
      views: typeof entry.view_count === "number" ? entry.view_count : null,
      url: entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${vidId}`,
    });
  }
  return { ok: true, results: videos };
}

// ── Cookie pool (smart rotation + cooldown), port of CookiePool ───────
// Multiple cookies: every cookies*.txt dropped into python/cookies/ is used.
// The cookie that last SUCCEEDED is remembered and always tried first, so
// warm requests extract in ~5s instead of walking dead cookies for 85s.
// A cookie that gets blocked cools down before it is tried again.
// State lives on globalThis so Next.js dev-mode module reloads don't reset
// the rotation (otherwise every request started from cookie #1 again).
interface CookieSlot {
  file: string;
  blockedUntil: number;
}
interface CookieState {
  pool: CookieSlot[] | null;
  idx: number;
  lastGood: string | null; // file path of the cookie that last worked
}
const _g = globalThis as unknown as { __mediaCookieState?: CookieState };

function cookieState(): CookieState {
  if (!_g.__mediaCookieState) _g.__mediaCookieState = { pool: null, idx: 0, lastGood: null };
  return _g.__mediaCookieState;
}

function loadCookies(): CookieSlot[] {
  const st = cookieState();
  if (st.pool) return st.pool;
  const dir = path.join(process.cwd(), "python", "cookies");
  const slots: CookieSlot[] = [];
  try {
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".txt"))
      .sort();
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        if (fs.statSync(f).size > 0) slots.push({ file: f, blockedUntil: 0 });
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    /* no cookies dir */
  }
  if (slots.length) console.log(`[cookies] pool loaded: ${slots.length} cookie file(s)`);
  st.pool = slots;
  return slots;
}

export function getNextCookie(): string | null {
  const st = cookieState();
  const pool = loadCookies().filter((c) => c.blockedUntil < Date.now());
  if (!pool.length) return null;
  // Prefer the cookie that last succeeded; otherwise rotate round-robin.
  if (st.lastGood) {
    const good = pool.find((c) => c.file === st.lastGood);
    if (good) {
      console.log(`[cookies] using last-good ${path.basename(good.file)} (${pool.length} available)`);
      return good.file;
    }
  }
  const slot = pool[st.idx % pool.length];
  st.idx = (st.idx + 1) % pool.length;
  console.log(`[cookies] using ${path.basename(slot.file)} (${pool.length} available)`);
  return slot.file;
}

export function markCookieBlocked(file: string, cooldownMs = 600_000): void {
  const slot = loadCookies().find((c) => c.file === file);
  if (slot) {
    slot.blockedUntil = Date.now() + cooldownMs;
    const st = cookieState();
    if (st.lastGood === file) st.lastGood = null; // it stopped working
    console.log(`[cookies] ${path.basename(file)} cooling down ${Math.round(cooldownMs / 1000)}s`);
  }
}

export function markCookieGood(file: string): void {
  const st = cookieState();
  st.lastGood = file;
  const slot = loadCookies().find((c) => c.file === file);
  if (slot) slot.blockedUntil = 0;
}

// ── Rate-limit (429) awareness ─────────────────────────────────────────
// Retrying while YouTube is 429-ing the server IP makes the block WORSE.
// Detect it, cool down globally, and fail fast with a clear message.
const _gRate = globalThis as unknown as { __ytRateLimitedUntil?: number };
const RATE_COOLDOWN_MS = 75_000;

function markRateLimited(): void {
  _gRate.__ytRateLimitedUntil = Date.now() + RATE_COOLDOWN_MS;
}

function rateLimitedRecently(): boolean {
  return (_gRate.__ytRateLimitedUntil || 0) > Date.now();
}

// ── Public API ────────────────────────────────────────────────────────

export async function ytSearch(q: string, limit = 12): Promise<{ results: SearchVideo[] }> {
  const searchTimeout = Number(process.env.YTDL_SEARCH_TIMEOUT_MS || "") || 40_000;
  const out = await runPython({ mode: "search", q, limit }, searchTimeout);
  if (out.ok) {
    return { results: (out.results as SearchVideo[]) || [] };
  }
  throw new Error((out.error as string) || "Search failed");
}

const FALLBACK_CLIENTS = ["tv", "web_safari", "android", "ios", "mweb"];
// extract.py has an INTERNAL 22s watchdog (python engine), so every attempt
// ends itself; the JS-side caps below are the hard limits for the CLI engine.
// Slow shared-CPU hosts (Render free) need bigger values — override via env:
//   YTDL_EXTRACT_TIMEOUT_MS  per-attempt cap (default 25s)
//   YTDL_MEDIACONNECT_TIMEOUT_MS  mediaconnect attempt cap (default 28s)
//   YTDL_EXTRACT_BUDGET_MS   total walk budget (default 60s)
//   YTDL_SEARCH_TIMEOUT_MS   ytsearch cap (default 40s)
const EXTRACT_TIMEOUT = Number(process.env.YTDL_EXTRACT_TIMEOUT_MS || "") || 25_000;
const MEDIACONNECT_TIMEOUT = Number(process.env.YTDL_MEDIACONNECT_TIMEOUT_MS || "") || 28_000;
// Total walk budget: worst case = budget + one overrunning attempt.
// On Vercel this MUST stay under the function limit — a request that
// outlives it returns an opaque HTML 502 and the phone spins forever.
// Render web services allow very long requests (no 60s lambda cap),
// so production there raises the budget via env (currently 120s).
const EXTRACT_BUDGET = Number(process.env.YTDL_EXTRACT_BUDGET_MS || "") || 60_000;
// One yt-dlp invocation walks these clients INTERNALLY (comma list) and
// stops at the first client that yields playable formats. On slow shared-CPU
// hosts (Render free) every spawn costs ~10-20s, so a comma-list attempt is
// far cheaper than JS-level per-client attempts: one process does the whole
// walk instead of five.
const CLIENT_WALK = FALLBACK_CLIENTS.join(",");

function isBlockError(err: string): boolean {
  return (
    /sign in to confirm/i.test(err) ||
    /cookie/i.test(err) ||
    /nsig|n challenge/i.test(err) ||
    /not a bot|bot check/i.test(err) ||
    // soft-block symptom: extraction succeeded but YouTube returned no
    // playable streams for this client/cookie combo
    /no downloadable formats|may be blocking/i.test(err)
  );
}

function isRateLimitError(err: string): boolean {
  return /429|too many requests|rate.limit/i.test(err);
}

function isBotChallenge(err: string): boolean {
  return /sign in to confirm|not a bot|bot check/i.test(err);
}

/**
 * Full extraction with cookie/client fallbacks — all SEQUENTIAL.
 * (Parallel cookie racing amplified YouTube 429 rate-limits on this IP —
 * one request at a time keeps the IP healthy.)
 *
 * Strategy (fast first):
 *   R1: last-known-good cookie, default client      (~5s warm path)
 *   R2: other healthy cookies, default client
 *   R3: mediaconnect client, no cookie
 *   R4: player-client walk on the assigned cookie
 *   R5: remaining cookies × key clients (budget allowing)
 *
 * 429 → global cooldown + abort remaining rounds (retries worsen it).
 * Soft "no formats" → 2 min cookie cooldown, not a hard block.
 * Bot challenge with cookie → 10 min cookie cooldown.
 */
export async function ytInfoWithFallback(url: string): Promise<YtInfo> {
  if (rateLimitedRecently()) {
    throw new Error(
      "YouTube is rate-limiting this server (HTTP 429). Please wait about a minute and try again."
    );
  }

  const budgetStart = Date.now();
  const inBudget = () => Date.now() - budgetStart < EXTRACT_BUDGET;
  const remaining = () => Math.max(8_000, EXTRACT_BUDGET - (Date.now() - budgetStart));
  let lastError = "extraction failed";
  // Per-attempt diagnostics — written to /tmp/extract_debug.log so the
  // /api/debug/extract route can show WHY production extraction fails
  // (FC runtime has no readable stdout logs).
  const tried: { src: string; ok: boolean; err: string; secs: number; js?: Record<string, boolean> }[] = [];

  const attempt = async (cookiefile: string | null, client: string | null): Promise<YtInfo | null> => {
    const t0 = Date.now();
    const t = client === "mediaconnect" ? Math.min(MEDIACONNECT_TIMEOUT, remaining()) : Math.min(EXTRACT_TIMEOUT, remaining());
    const out = (await runPython({ mode: "info", url, cookiefile, client }, t)) as unknown as YtInfo & { took?: number; js?: Record<string, boolean> };
    const secs = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
    const src = cookiefile ? cookiefile.split("/").pop() || cookiefile : `client=${client || "default"}`;
    if (out.ok) {
      tried.push({ src, ok: true, err: "", secs, js: out.js });
      writeExtractDebug(url, tried);
      if (cookiefile) markCookieGood(cookiefile);
      return out;
    }
    lastError = out.error || lastError;
    tried.push({ src, ok: false, err: (out.error || "").slice(0, 120), secs, js: out.js });
    console.log(`[extract] ${src} failed (${secs}s): ${lastError.slice(0, 100)}`);

    // 429: cool the whole pool down and stop retrying — more attempts
    // right now only extend YouTube's throttle.
    if (isRateLimitError(lastError)) {
      markRateLimited();
      return null;
    }
    if (cookiefile) {
      if (isBotChallenge(lastError)) markCookieBlocked(cookiefile, 600_000); // 10 min
      else if (isBlockError(lastError)) markCookieBlocked(cookiefile, 120_000); // soft 2 min
    }
    return null;
  };

  const healthy = () => loadCookies().filter((c) => c.blockedUntil < Date.now());
  const assigned = getNextCookie();
  const clients = [...FALLBACK_CLIENTS, null];

  // R1: last-known-good cookie + internal client walk — warm path
  if (st_lastGood() && inBudget()) {
    const r = await attempt(st_lastGood(), CLIENT_WALK);
    if (r) return r;
    if (rateLimitedRecently()) throw new Error(lastError);
  }

  // R2: remaining healthy cookies sequentially (internal client walk)
  const others = healthy().filter((c) => c.file !== st_lastGood());
  for (const c of others) {
    if (!inBudget() || rateLimitedRecently()) break;
    const r = await attempt(c.file, CLIENT_WALK);
    if (r) return r;
  }
  if (rateLimitedRecently()) throw new Error(lastError);

  // R3: mediaconnect without cookies (best single shot on clean IPs)
  if (inBudget() && !rateLimitedRecently()) {
    const r = await attempt(null, "mediaconnect");
    if (r) return r;
  }

  // R4: player-client walk on the assigned cookie
  if (assigned && inBudget() && !rateLimitedRecently()) {
    for (const client of clients) {
      if (!inBudget() || rateLimitedRecently()) break;
      const r = await attempt(assigned, client);
      if (r) return r;
    }
  }

  // R5: remaining cookies × key clients, budget allowing — even a
  // soft-cooled cookie is better than giving up with an empty pool.
  if (inBudget() && !rateLimitedRecently()) {
    const pool = loadCookies().filter((c) => c.file !== assigned);
    outer: for (const c of pool) {
      for (const client of ["tv", "web_safari", null]) {
        if (!inBudget() || rateLimitedRecently()) break outer;
        const r = await attempt(c.file, client);
        if (r) return r;
      }
    }
  }

  // R6: no-cookie client walk as a last resort
  if (inBudget() && !rateLimitedRecently()) {
    for (const client of clients) {
      if (!inBudget() || rateLimitedRecently()) break;
      const r = await attempt(null, client);
      if (r) return r;
    }
  }

  writeExtractDebug(url, tried);
  const totalSecs = Math.round(((Date.now() - budgetStart) / 1000) * 10) / 10;
  const summary = tried.map((t) => `${t.src}:${t.ok ? "OK" : "FAIL"} ${t.secs}s`).join(", ");
  console.log(`[extract] ALL failed for ${url} after ${totalSecs}s — ${lastError} [${summary}]`);
  throw new Error(lastError);
}

// ── extraction debug log (observability on the published runtime) ─────
import os from "node:os";

const DEBUG_LOG = path.join(os.tmpdir(), "extract_debug.log");

function writeExtractDebug(url: string, tried: { src: string; ok: boolean; err: string; secs: number; js?: Record<string, boolean> }[]): void {
  try {
    const line =
      `${new Date().toISOString()} ${url}\n` +
      tried.map((t) => `  ${t.ok ? "OK  " : "FAIL"} ${t.src} ${t.secs}s ${t.err ? `— ${t.err}` : ""} js=${JSON.stringify(t.js || {})}\n`).join("") +
      "\n";
    fs.appendFileSync(DEBUG_LOG, line);
    // keep the file small (last ~64KB)
    try {
      if (fs.statSync(DEBUG_LOG).size > 64_000) {
        const txt = fs.readFileSync(DEBUG_LOG, "utf-8");
        fs.writeFileSync(DEBUG_LOG, txt.slice(-32_000));
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* best effort only */
  }
}

export function readExtractDebug(): string {
  try {
    return fs.readFileSync(DEBUG_LOG, "utf-8").slice(-8_000);
  } catch {
    return "(no extract debug log yet)";
  }
}

function st_lastGood(): string | null {
  return cookieState().lastGood;
}
