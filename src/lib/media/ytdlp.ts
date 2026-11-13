// yt-dlp bridge — spawns the Python extract.py script.
// Ports the cookie-pool + player-client fallback strategy from app.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  const out = await runPython({ mode: "search", q, limit }, 40_000);
  if (out.ok) {
    return { results: (out.results as SearchVideo[]) || [] };
  }
  throw new Error((out.error as string) || "Search failed");
}

const FALLBACK_CLIENTS = ["tv", "web_safari", "android", "ios", "mweb"];
// extract.py has an INTERNAL 22s watchdog, so every attempt ends itself.
// JS-side timeout is 25s (3s grace over the python watchdog).
const EXTRACT_TIMEOUT = 25_000;
const MEDIACONNECT_TIMEOUT = 28_000;
// Total walk budget: worst case = budget + one overrunning attempt.
// MUST stay well under the ~180s gateway (ALB) timeout — a request that
// outlives it returns an opaque HTML 502 and the phone spins forever.
const EXTRACT_BUDGET = 60_000;

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

  // R1: last-known-good cookie with the default client — instant warm path
  if (st_lastGood() && inBudget()) {
    const r = await attempt(st_lastGood(), null);
    if (r) return r;
    if (rateLimitedRecently()) throw new Error(lastError);
  }

  // R2: remaining healthy cookies sequentially (default client)
  const others = healthy().filter((c) => c.file !== st_lastGood());
  for (const c of others) {
    if (!inBudget() || rateLimitedRecently()) break;
    const r = await attempt(c.file, null);
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
