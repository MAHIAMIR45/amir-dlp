// yt-dlp bridge — spawns the Python extract.py script (z.ai) OR the
// standalone yt-dlp binary (Vercel). Ports the cookie-pool + player-client
// fallback strategy from app.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  cliBaseArgs,
  ensureProxyPoolOnce,
  loadProxies,
  getNextProxy,
  healthyProxyCount,
  isLocalProxy,
  markProxyDead,
  markProxyGood,
  refreshProxyPoolAsync,
  useCliEngine,
  writableCookiePath,
  ytDlpCliPath,
} from "./engine";

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
  /** The route (proxy/cookie/client-walk) that produced this result —
   *  the download engine pins it first so format ids stay valid. */
  route?: { proxy: string | null; cookiefile: string | null; client: string | null };
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
  const proxy = (args.proxy as string | null) || null;
  const argv = [
    ytDlpCliPath(),
    ...cliBaseArgs(),
    "--ignore-no-formats-error",
    "--socket-timeout",
    "25",
    "--no-playlist",
  ];
  // Walk modes:
  //  · "fastskip" = player_skip=webpage,configs — the FASTEST shape. On a
  //                 CLEAN exit IP it returns the COMPLETE list (verified:
  //                 48 formats / 4K in 8s through a validated proxy).
  //  · "full"     = completely default (watch page + configs + default
  //                 client walk). Complete lists but the 1-2MB watch page
  //                 is too slow through ~40KB/s public proxies.
  //  · "fullskip" = player_skip=webpage ONLY (configs still fetched).
  //                 Default client order + signature timestamp from the
  //                 configs — the validated fallback when fastskip serves
  //                 a challenge-lite list.
  //  · (default)  = player_skip=webpage,configs + optional client walk —
  //                 fastest, but challenge-lite/degraded on flagged IPs.
  if (client === "full") {
    // no extractor-args at all
  } else if (client === "fastskip") {
    argv.push("--extractor-args", "youtube:player_skip=webpage,configs");
  } else if (client === "fullskip") {
    argv.push("--extractor-args", "youtube:player_skip=webpage");
  } else {
    argv.push(
      "--extractor-args",
      "youtube:player_skip=webpage,configs",
    );
  }
  argv.push("-J");
  const ck = writableCookiePath(cookiefile);
  if (ck) argv.push("--cookies", ck);
  if (client && client !== "full" && client !== "fullskip") argv.push("--extractor-args", `youtube:player_client=${client}`);
  if (proxy) argv.push("--proxy", proxy);
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
    if (/[Ss]ign in to confirm|not a bot/i.test(joined) || /failed to extract any player response/i.test(joined)) {
      return { ok: false, error: "YouTube is temporarily blocking this server's extraction — please wait a minute and try again (a retry usually succeeds)" };
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

// ── Server-IP challenge awareness ──────────────────────────────────────
// "Failed to extract any player response" on a FULL client walk (all 7
// player clients refused) means YouTube is challenging the SERVER's IP —
// the same cookies extract fine from a residential IP. Two levels:
//   directBlocked — the server's OWN IP is challenged (10 min): skip
//     direct attempts and route the walk through the proxy pool instead.
//   ipChallenged  — EVERYTHING failed (direct AND every healthy proxy):
//     global 5-min fail-fast so retries don't fight a losing battle.
const _gBlock = globalThis as unknown as {
  __ytIpChallengeUntil?: number;
  __ytDirectBlockedUntil?: number;
};
const IP_CHALLENGE_COOLDOWN_MS = 300_000; // 5 min — challenges usually decay
const DIRECT_BLOCKED_MS = 1_800_000; // 30 min — remember the direct IP is flagged (the challenge persists for hours, and every re-probe costs users ~50s)

export function markIpChallenged(): void {
  _gBlock.__ytIpChallengeUntil = Date.now() + IP_CHALLENGE_COOLDOWN_MS;
}

export function ipChallengedRecently(): boolean {
  return (_gBlock.__ytIpChallengeUntil || 0) > Date.now();
}

export function markDirectBlocked(): void {
  _gBlock.__ytDirectBlockedUntil = Date.now() + DIRECT_BLOCKED_MS;
}

export function directBlockedRecently(): boolean {
  return (_gBlock.__ytDirectBlockedUntil || 0) > Date.now();
}

// Render's datacenter IP has been player-challenged for days at a stretch;
// the flag outlives redeploys and every cold-boot probe costs the FIRST
// visitor ~50s of doomed direct walking before the proxy rounds take over.
// Assume blocked at boot — after 30 min the flag decays and one natural
// probe happens; a CLEAN direct IP then takes over automatically.
if (process.env.RENDER === "true" && !directBlockedRecently()) markDirectBlocked();

/** Either YouTube-side throttle is active — stop walking immediately. */
function blockedRecently(): boolean {
  return rateLimitedRecently() || ipChallengedRecently();
}

export function isIpChallenge(err: string): boolean {
  return /failed to extract any player response/i.test(err);
}

/** The proxy itself refused/dropped the tunnel (CONNECT 403, dead host) —
 *  these proxies can list but cannot move media; cool them down. */
export function isProxyConnError(err: string): boolean {
  return /unable to connect to proxy|tunnel connection failed|proxy.+refused|proxy.+timeout/i.test(err);
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

const FALLBACK_CLIENTS = ["tv", "web_safari", "android", "ios", "mweb", "web", "tv_embedded"];
// Client-walk recipes for the PROXY_ROUNDS below. yt-dlp stops at the
// first client that yields ANY playable formats — through flagged IPs that
// is often a lite client (mweb/tv) with a crippled list — so the retry
// must EXCLUDE the clients that already "succeeded" degraded.
// "full" = default extraction (no extractor-args): through clean proxy IPs
// it returns the complete format list (verified 47 formats/1080p) while
// the fast player_skip walk gets degraded lists even from clean IPs.
const PROXY_WALKS = ["full", "full", "ios,android,tv", "mweb,web"];

/**
 * A challenge-lite player response: extraction "succeeded" but YouTube
 * only served a tiny combined-format list (usually just 360p itag 18)
 * with no DASH streams. A healthy response carries many video-only
 * formats. Accept these as a LAST resort but keep walking for better.
 */
export function isDegradedInfo(info: YtInfo | null | undefined): boolean {
  if (!info || !info.ok) return false;
  const vo = info.video_only?.length || 0;
  const ao = info.audio_only?.length || 0;
  const co = info.combined?.length || 0;
  if (vo >= 3) return false; // full adaptive (DASH) list
  if (ao >= 2 && co >= 1) return false; // reasonable audio + video rows
  // A healthy player response carries a DASH video-only list; responses
  // with a handful of HLS/combined itags and no video-only rows are the
  // lite serving — keep walking for the complete list.
  return true;
}
// Slow shared-CPU hosts (Render free) need bigger values — one yt-dlp spawn
// costs 10-20s there and a 7-client walk needs 60-120s, so the fast-host
// caps killed EVERY attempt mid-flight and the user just saw endless
// loading. Env vars (set on the Render service) win; defaults below mirror
// them so a lost env var cannot regress this again:
//   YTDL_EXTRACT_TIMEOUT_MS  per-attempt cap (Render default 120s)
//   YTDL_MEDIACONNECT_TIMEOUT_MS  mediaconnect attempt cap (Render 130s)
//   YTDL_EXTRACT_BUDGET_MS   total walk budget (Render 210s — the frontend
//                            aborts at 240s, keep 30s of headroom)
//   YTDL_SEARCH_TIMEOUT_MS   ytsearch cap (default 40s / Render 80s)
const ON_RENDER = process.env.RENDER === "true";
const EXTRACT_TIMEOUT = Number(process.env.YTDL_EXTRACT_TIMEOUT_MS || "") || (ON_RENDER ? 120_000 : 25_000);
const MEDIACONNECT_TIMEOUT = Number(process.env.YTDL_MEDIACONNECT_TIMEOUT_MS || "") || (ON_RENDER ? 130_000 : 28_000);
// Total walk budget: worst case = budget + one overrunning attempt.
// On Vercel this MUST stay under the function limit — a request that
// outlives it returns an opaque HTML 502 and the phone spins forever.
// Render web services allow very long requests (no lambda cap).
const EXTRACT_BUDGET = Number(process.env.YTDL_EXTRACT_BUDGET_MS || "") || (ON_RENDER ? 210_000 : 60_000);
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
    // yt-dlp gave up on EVERY internal player client — IP/cookie challenged
    /failed to extract any player response/i.test(err) ||
    // soft-block symptom: extraction succeeded but YouTube returned no
    // playable streams for this client/cookie combo
    /no downloadable formats|may be blocking/i.test(err)
  );
}

export function isRateLimitError(err: string): boolean {
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
  // Fail-fast flags only apply when there is NO alternative route: with
  // healthy proxies available, a direct-IP 429/challenge must not stop the
  // walk — those blocks are per-EXIT-IP and the proxies have other IPs.
  const haveProxies = healthyProxyCount() > 0;
  if (rateLimitedRecently() && !haveProxies) {
    throw new Error(
      "YouTube is rate-limiting this server (HTTP 429). Please wait about a minute and try again."
    );
  }
  if (ipChallengedRecently() && !haveProxies) {
    // Pool empty as well? Kick a background refresh so the NEXT request has
    // routes to try instead of the same dead state.
    refreshProxyPoolAsync();
    throw new Error(
      "YouTube is challenging this server's connection right now — please wait about 5 minutes and try again."
    );
  }

  const budgetStart = Date.now();
  // Best DEGRADED result seen so far — returned only if nothing better
  // arrives within the budget (a 360p-only listing beats an error page).
  let bestDegraded: YtInfo | null = null;
  const keepDegraded = (r: YtInfo): void => {
    const n = (r.video_only?.length || 0) + (r.audio_only?.length || 0) + (r.combined?.length || 0);
    const prev = bestDegraded
      ? (bestDegraded.video_only?.length || 0) + (bestDegraded.audio_only?.length || 0) + (bestDegraded.combined?.length || 0)
      : -1;
    if (n > prev) bestDegraded = r;
  };
  // Never START an attempt that cannot finish: with less than MIN_ATTEMPT_MS
  // left in the budget the next spawn would just be killed mid-flight and the
  // user would see a confusing "extraction timed out after 8s" error. Skip
  // it instead — one meaningful attempt is worth more than a doomed one.
  const MIN_ATTEMPT_MS = 30_000;
  const inBudget = () => EXTRACT_BUDGET - (Date.now() - budgetStart) >= MIN_ATTEMPT_MS;
  const remaining = () => EXTRACT_BUDGET - (Date.now() - budgetStart);
  let lastError = "extraction failed";
  // Per-attempt diagnostics — written to /tmp/extract_debug.log so the
  // /api/debug/extract route can show WHY production extraction fails
  // (FC runtime has no readable stdout logs).
  const tried: { src: string; ok: boolean; err: string; secs: number; js?: Record<string, boolean> }[] = [];

  const attempt = async (cookiefile: string | null, client: string | null, proxy: string | null = null, capMs: number | null = null): Promise<YtInfo | null> => {
    const t0 = Date.now();
    const cap = capMs ?? (client === "mediaconnect" ? MEDIACONNECT_TIMEOUT : EXTRACT_TIMEOUT);
    const t = Math.min(cap, remaining());
    const out = (await runPython({ mode: "info", url, cookiefile, client, proxy }, t)) as unknown as YtInfo & { took?: number; js?: Record<string, boolean> };
    const secs = Math.round(((Date.now() - t0) / 1000) * 10) / 10;
    const src = `${cookiefile ? cookiefile.split("/").pop() || cookiefile : `client=${client || "default"}`}${proxy ? "@proxy" : ""}`;
    if (out.ok) {
      tried.push({ src, ok: true, err: "", secs, js: out.js });
      writeExtractDebug(url, tried);
      if (cookiefile) markCookieGood(cookiefile);
      if (proxy) markProxyGood(proxy);
      // Pin the route that produced this result so the download phase
      // (different request) walks the SAME proxy/cookie/client first —
      // re-extraction through a different route invalidates format ids.
      out.route = { proxy: proxy || null, cookiefile: cookiefile || null, client: client || null };
      return out;
    }
    lastError = out.error || lastError;
    tried.push({ src, ok: false, err: (out.error || "").slice(0, 120), secs, js: out.js });
    console.log(`[extract] ${src} failed (${secs}s): ${lastError.slice(0, 100)}`);

    // TIMED-OUT PROXY = black-holed tunnel (the proxy accepted TCP but never
    // answers). Without cooling it down it stayed "healthy" and every later
    // batch re-picked it, burning 60-90s of the budget EACH time — the exact
    // "stuck for minutes with nothing happening" the API users reported.
    // The LOCAL WARP tunnel gets a SHORT cooldown: it is the dedicated exit
    // and standalone retries through it succeed 3/3 — an in-walk challenge
    // flake must simply be retried, not benched.
    if (proxy && /^extraction timed out/i.test(lastError)) {
      markProxyDead(proxy, isLocalProxy(proxy) ? 20_000 : 600_000);
      return null;
    }

    // 429 / throttle: blocks are per EXIT-IP.
    //  · direct → flag the server IP AND set the global 75s cooldown —
    //    remaining DIRECT rounds are skipped, but the proxy rounds still
    //    run (their IPs are throttled independently).
    //  · through a proxy → just cool THIS proxy down; the walk moves on.
    if (isRateLimitError(lastError)) {
      if (proxy) {
        markProxyDead(proxy, 90_000);
      } else {
        markRateLimited();
        markDirectBlocked();
      }
      return null;
    }
    // The FRIENDLY wording ("YouTube is temporarily blocking this server's
    // extraction") wraps the raw sign-in/challenge errors. Through a proxy
    // it means THAT exit IP is challenged — without matching it here the
    // flagged proxy stayed in rotation and later attempts re-hit it
    // (15-40s wasted each time, the exact slowness users reported).
    const softChallenged = /temporarily blocking this server|may be blocking this server/i.test(lastError);
    if (isIpChallenge(lastError) || (proxy && (isBotChallenge(lastError) || softChallenged))) {
      if (proxy) {
        // WARP: challenge flakes are transient (standalone retries pass) —
        // 20s cooldown so the very next batch retries it. Public proxies:
        // 10 min (their exits stay flagged).
        markProxyDead(proxy, isLocalProxy(proxy) ? 20_000 : 600_000);
      } else {
        markDirectBlocked();
        if (!healthyProxyCount()) markIpChallenged();
      }
      return null;
    }
    // Same friendly wording on a DIRECT route = the server IP got the soft
    // challenge — skip direct for a while so the proxy rounds take over.
    if (!proxy && softChallenged) {
      markDirectBlocked();
      return null;
    }
    // Proxy tunnel refused/dropped — the proxy cannot carry this traffic
    // (some allow the player API but 403 googlevideo CONNECTs). Cool it so
    // later walks skip straight to usable proxies.
    if (proxy && isProxyConnError(lastError)) {
      markProxyDead(proxy, 600_000);
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

  // Throw the FRIENDLY wording for YouTube-side blocks — the raw yt-dlp
  // error (with its "please report this issue" boilerplate) confuses users.
  const throwBlocked = (): never => {
    if (!healthyProxyCount()) refreshProxyPoolAsync();
    if (isIpChallenge(lastError)) {
      throw new Error(
        "YouTube is challenging this server's connection right now — please wait about 5 minutes and try again."
      );
    }
    throw new Error(lastError);
  };

  // Full-quality result → accept and stop. Degraded (challenge-lite,
  // 360p-only) result → remember it as a fallback and KEEP WALKING — a
  // later route/client often returns the complete format list, and the
  // user explicitly wants every quality, not just the first response.
  const accept = (r: YtInfo | null): r is YtInfo => {
    if (!r) return false;
    if (!isDegradedInfo(r)) return true;
    keepDegraded(r);
    return false;
  };

  // R1: last-known-good cookie + internal client walk — warm path.
  // Skipped while the server's own IP is known to be challenged (R3
  // proxies take over until the flag decays).
  if (!directBlockedRecently() && st_lastGood() && inBudget()) {
    const r = await attempt(st_lastGood(), CLIENT_WALK);
    if (accept(r)) return r;
    if (blockedRecently() && !haveProxies) throwBlocked();
    // The fast walk returned only a challenge-lite list (or nothing) —
    // one "fullskip" (skip watch page, keep configs → signature timestamp
    // → default client walk returns the FULL list) upgrade shot.
    if (inBudget() && !blockedRecently()) {
      const rf = await attempt(st_lastGood(), "fullskip");
      if (accept(rf)) return rf;
    }
  }

  // R2: remaining healthy cookies sequentially (internal client walk)
  if (!directBlockedRecently()) {
    const others = healthy().filter((c) => c.file !== st_lastGood());
    for (const c of others) {
      if (!inBudget() || blockedRecently() || directBlockedRecently()) break;
      const r = await attempt(c.file, CLIENT_WALK);
      if (accept(r)) return r;
    }
  }
  if (blockedRecently() && !haveProxies) throwBlocked();

  // R3: PROXY rounds — the server IP is flagged (direct rounds refused or
  // skipped): route the SAME cookie through the proxy pool. PROXIES ARE
  // RACED IN PARALLEL (challenge/429 enforcement is per EXIT-IP, so
  // racing is safe) — this turns the old 2-4 minute sequential walk into
  // roughly one attempt-length. Each batch rotates the player-client
  // subset ("full" = default extraction, the ONLY shape that returns the
  // complete format list from clean IPs). A proxy that hard-fails is
  // cooled down; when the pool is exhausted a background refresh fetches
  // a fresh pool for the next request. Runs even when the DIRECT rounds
  // got 429'd/challenged — those blocks do not affect proxy exit IPs.
  const proxyCookie = st_lastGood() || assigned;
  // EMPTY POOL (boot + dead seed, everything cooled): await ONE validated
  // pool build instead of failing with no routes. Bounded to 80s so the
  // walk still has budget to race the freshly validated proxies.
  if (!healthyProxyCount()) {
    await ensureProxyPoolOnce(80_000);
  }
  // 512MB Render instance: 2 concurrent yt-dlp spawns peak ~300MB — 3 would
  // risk the OOM killer. Bigger hosts race 3.
  const RACE = ON_RENDER ? 2 : 3;
  // 60s covers every validated success (28-40s) with headroom; a black-holed
  // proxy then wastes only one 60s slot before its 10-min cooldown kicks in
  // (see the timeout handling in attempt()).
  const PROXY_CAP = ON_RENDER ? 60_000 : 40_000;
  // Round recipes: cookieLESS default extraction is the VALIDATED recipe
  // through clean proxy IPs (cookies + datacenter-exit combos trigger the
  // "sign in to confirm" challenge; without cookies the same proxy returns
  // the full 47-format list). Cookie batches ride along for age-gated
  // videos, then alternate client walks as fallbacks.
  const PROXY_ROUNDS: { walk: string; ck: string | null }[] = [
    // fastskip FIRST: probe-validated clean exits return the complete list
    // in a fraction of the time (no configs/watch-page fetch — verified
    // 48 formats/4K in 8s). fullskip stays as the signature-timestamp
    // fallback, then the full default shape, then a key-client walk.
    { walk: "fastskip", ck: null },
    { walk: "fullskip", ck: null },
    { walk: "fastskip", ck: proxyCookie },
    { walk: "full", ck: null },
    { walk: "ios,android,tv", ck: null },
  ];
  let walkIdx = 0;
  for (;;) {
    // NOTE: rateLimitedRecently() intentionally NOT checked here — a 429 on
    // the server's own IP has nothing to do with the proxies' exit IPs.
    if (!inBudget()) break;
    // Pool drained mid-walk (every exit cooled down): build ONE fresh
    // validated pool right now (dedup'd + bounded) instead of breaking
    // out with routes left unused. Free lists decay within the hour, so
    // a mid-walk rebuild is often the difference between success and a
    // dead spinner.
    if (healthyProxyCount() < 2) {
      const built = await ensureProxyPoolOnce(70_000);
      if (!built && !healthyProxyCount()) break; // nothing validated — stop
    }
    // Pool running low → refresh in the background (throttled 10 min) so a
    // fresh pool is ready before the current one fully dies.
    if (healthyProxyCount() < 4) refreshProxyPoolAsync();
    const batch: string[] = [];
    // The local WARP tunnel is the PRIMARY exit: when healthy it ALWAYS
    // gets a batch slot (round-robin would otherwise skip it for spans).
    const warpSlot = loadProxies().find(
      (s) => isLocalProxy(s.url) && s.deadUntil < Date.now()
    );
    if (warpSlot && ON_RENDER) batch.push(warpSlot.url);
    for (let i = 0; i < RACE; i++) {
      const p = getNextProxy();
      if (p && !batch.includes(p)) batch.push(p);
    }
    if (!batch.length) break;
    // MIX recipes across the batch (one fullskip = fast, one full = the
    // validated complete-list shape): free-proxy exits are flaky, so every
    // batch must maximise the chance that at least ONE member returns the
    // complete format list instead of both betting on the same recipe.
    const results = await Promise.all(
      batch.map((p, i) => {
        const round = PROXY_ROUNDS[(walkIdx + i) % PROXY_ROUNDS.length];
        // The LOCAL WARP tunnel is a dedicated, fast link (multi-MB/s): the
        // FULL default walk (watch page + configs → signature timestamp) is
        // the shape VERIFIED to return the complete list from its SG egress
        // (fastskip gets challenge-lite there even though it works from
        // other clean exits). Free proxies stay on the fast recipes.
        if (isLocalProxy(p)) {
          // Full walk + a 90s cap: watch page + configs through the tunnel
          // plus Render's slow spawns — verified 49 formats when allowed
          // to finish (standalone runs succeed 3/3).
          return attempt(null, "full", p, ON_RENDER ? 90_000 : PROXY_CAP);
        }
        return attempt(round.ck, round.walk, p, PROXY_CAP);
      })
    );
    walkIdx += batch.length;
    const full = results.find((r) => r && !isDegradedInfo(r));
    if (full) return full;
    for (const r of results) {
      if (r) keepDegraded(r);
    }
    if (!healthyProxyCount()) break; // direct rounds / pool refresh take over
  }

  // R4: mediaconnect without cookies (best single shot on clean IPs)
  if (!directBlockedRecently() && inBudget() && !blockedRecently()) {
    const r = await attempt(null, "mediaconnect");
    if (accept(r)) return r;
  }

  // R5: player-client walk on the assigned cookie
  if (assigned && !directBlockedRecently() && inBudget() && !blockedRecently()) {
    for (const client of clients) {
      if (!inBudget() || blockedRecently()) break;
      const r = await attempt(assigned, client);
      if (accept(r)) return r;
    }
  }

  // R6: remaining cookies × key clients, budget allowing — even a
  // soft-cooled cookie is better than giving up with an empty pool.
  if (!directBlockedRecently() && inBudget() && !blockedRecently()) {
    const pool = loadCookies().filter((c) => c.file !== assigned);
    outer: for (const c of pool) {
      for (const client of ["tv", "web_safari", null]) {
        if (!inBudget() || blockedRecently()) break outer;
        const r = await attempt(c.file, client);
        if (accept(r)) return r;
      }
    }
  }

  // R7: no-cookie client walk as a last resort
  if (!directBlockedRecently() && inBudget() && !blockedRecently()) {
    for (const client of clients) {
      if (!inBudget() || blockedRecently()) break;
      const r = await attempt(null, client);
      if (accept(r)) return r;
    }
  }

  writeExtractDebug(url, tried);
  const totalSecs = Math.round(((Date.now() - budgetStart) / 1000) * 10) / 10;
  const summary = tried.map((t) => `${t.src}:${t.ok ? "OK" : "FAIL"} ${t.secs}s`).join(", ");
  console.log(`[extract] ALL failed for ${url} after ${totalSecs}s — ${lastError} [${summary}]`);
  // A degraded (challenge-lite) listing is still a WORKING listing — the
  // user gets its qualities rather than a dead spinner. The walk above
  // already tried everything for a better list.
  if (bestDegraded) {
    const d = bestDegraded as YtInfo;
    console.log(
      `[extract] returning DEGRADED fallback: vo=${d.video_only?.length || 0} ao=${d.audio_only?.length || 0} co=${d.combined?.length || 0} (${totalSecs}s)`
    );
    return d;
  }
  // Friendly user-facing messages for the common YouTube-side blocks.
  if (/failed to extract any player response/i.test(lastError)) {
    throw new Error(
      "YouTube is challenging this server's connection right now — please wait about 5 minutes and try again."
    );
  }
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
