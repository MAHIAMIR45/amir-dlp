// Download jobs — reliable yt-dlp downloads with live progress + local
// ffmpeg WhatsApp post-processing.
//
// Why: the previous flow let ffmpeg read the googlevideo URLs directly.
// YouTube throttles/stalls plain single-connection HTTP reads on this
// server partway through long transfers, so "full song" merges died at
// ~50% and the phone showed "31.89 MB / ? — failed".
//
// The fix (still 100% yt-dlp + cookies, no third-party APIs):
//   1) yt-dlp's own downloader fetches the streams — chunked Range
//      requests + concurrent fragments + retries defeat the throttle
//      (cookie rotation via the same cookie pool as extraction)
//   2) ffmpeg merges/converts the LOCAL files into a WhatsApp-safe MP4
//      (faststart remux when already H.264/AAC, auto re-encode otherwise)
//   3) the finished file is served with Content-Length + Range support
//
// Phases reported on the progress page:
//   mp4:  0–88% yt-dlp download · 88–96% merge/faststart · 100% ready
//   mp3:  0–80% yt-dlp download · 80–100% mp3 conversion

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliBaseArgs, resolveFfmpegBin, useCliEngine, writableCookiePath, ytDlpCliPath } from "./engine";
import { getNextCookie, ipChallengedRecently, isIpChallenge, markCookieBlocked, markCookieGood, markIpChallenged, resolvePython } from "./ytdlp";

export interface DlJob {
  id: string;
  state: "running" | "done" | "error";
  note?: string;
  filename: string;
  contentType: string;
  filePath?: string;
  size?: number;
  error?: string;
  createdAt: number;
  pct: number; // 0..100
  gotBytes: number;
  estBytes?: number;
  speedBps?: number;
  etaSec?: number;
}

interface JobInternal extends DlJob {
  proc?: ReturnType<typeof spawn>;
}

const g = globalThis as unknown as {
  __dlJobs?: Map<string, JobInternal>;
  __dlJobsTimer?: NodeJS.Timeout;
};

function jobMap(): Map<string, JobInternal> {
  if (!g.__dlJobs) g.__dlJobs = new Map();
  return g.__dlJobs;
}

const JOB_TTL_MS = 15 * 60 * 1000; // keep finished files for retries/resumes
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // hard cap per job

function ensureCleanup(): void {
  if (g.__dlJobsTimer) return;
  const t = setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobMap()) {
      if (now - j.createdAt > JOB_TTL_MS) {
        if (j.proc) {
          try {
            j.proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
        if (j.filePath) {
          try {
            fs.unlinkSync(j.filePath);
          } catch {
            /* ignore */
          }
        }
        jobMap().delete(id);
      }
    }
  }, 60_000);
  t.unref?.();
  g.__dlJobsTimer = t;
}

export function getJob(id: string): DlJob | null {
  const j = jobMap().get(id);
  if (!j) return null;
  // file vanished (tmp cleaner) → treat as expired
  if (j.state === "done" && j.filePath && !fs.existsSync(j.filePath)) {
    return { ...j, state: "error", error: "This download has expired. Please go back and retry." };
  }
  return { ...j };
}

export interface StartDlJobOpts {
  mode: "mp4" | "mp3" | "raw";
  url: string; // YouTube watch URL (yt-dlp resolves + downloads with cookies)
  videoFormatId?: string | null;
  audioFormatId?: string | null;
  height?: number | null;
  canCopy?: boolean;
  // raw mode: exact single-format download, served in its original format
  rawFallback?: string; // yt-dlp fallback after the exact id (e.g. bestaudio)
  contentType?: string; // for raw mode serving
  filename: string;
  durationSec?: number | null;
  estBytes?: number | null;
}

/** Kick off a download job. Returns immediately; the job runs in background. */
export function startDlJob(opts: StartDlJobOpts): DlJob {
  ensureCleanup();
  const id = crypto.randomBytes(16).toString("hex");
  const job: JobInternal = {
    id,
    state: "running",
    filename: opts.filename,
    contentType:
      opts.contentType || (opts.mode === "mp3" ? "audio/mpeg" : "video/mp4"),
    createdAt: Date.now(),
    pct: 0,
    gotBytes: 0,
    estBytes: opts.estBytes || undefined,
  };
  jobMap().set(id, job);
  console.log(
    `[job ${id}] started (${opts.mode}, vid=${opts.videoFormatId || "-"} aud=${opts.audioFormatId || "-"}) for ${opts.filename}`
  );
  void runJob(job, opts);
  return { ...job };
}

// ── progress helpers ──────────────────────────────────────────────────

function setPhase(job: JobInternal, pct: number, downloaded?: number, speed?: number, total?: number): void {
  job.pct = Math.max(0, Math.min(100, pct));
  if (downloaded !== undefined) job.gotBytes = downloaded;
  if (speed !== undefined && speed > 0) {
    job.speedBps = Math.round(speed);
    const doneFrac = job.pct / 100;
    const est = total || job.estBytes;
    if (est && doneFrac > 0.005) {
      const remaining = Math.max(0, est * (1 - doneFrac));
      job.etaSec = Math.max(1, Math.round(remaining / job.speedBps));
    }
  }
}

// ── yt-dlp download phase (python/download.py) ────────────────────────

interface YtDlpResult {
  ok: boolean;
  path?: string;
  size?: number;
  ext?: string;
  error?: string;
}

function runYtDlpDownload(
  job: JobInternal,
  opts: StartDlJobOpts,
  pctFrom: number,
  pctTo: number
): Promise<YtDlpResult> {
  // yt-dlp format selector: exact ids first (fast path when the cached
  // extraction used the same player client), then constraint-based
  // fallbacks that survive client switches. Never trust ids alone —
  // "Requested format is not available" must not kill the download.
  let format: string;
  if (opts.mode === "mp3") {
    format = `${opts.audioFormatId || "bestaudio"}/bestaudio/best`;
  } else if (opts.mode === "raw") {
    const id = opts.videoFormatId || opts.audioFormatId;
    format = id ? `${id}/${opts.rawFallback || "best"}` : opts.rawFallback || "best";
  } else {
    const h = opts.height ? `[height<=${opts.height}]` : "";
    const parts: string[] = [];
    if (opts.videoFormatId && opts.audioFormatId) {
      parts.push(`${opts.videoFormatId}+${opts.audioFormatId}`);
    }
    parts.push(`bestvideo${h}[vcodec^=avc1]+bestaudio[acodec^=mp4a]`);
    parts.push(`bestvideo${h}+bestaudio`);
    parts.push(`best${h}`);
    parts.push("best");
    format = parts.join("/");
  }

  const args = {
    mode: opts.mode,
    url: opts.url,
    format,
    cookiefile: getNextCookie(),
    out_base: path.join(os.tmpdir(), `ytdl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`),
    concurrency: 4,
  };

  // CLI engine (Vercel): the download phase gets the SAME resilience as
  // the info phase — a client/cookie walk with per-attempt spawns. On
  // serverless IPs the default client gets bot-checked intermittently
  // while tv/web_safari etc. pass, so a single default-client spawn made
  // downloads fail at random. (The single-spawn path below stays for the
  // python engine on z.ai.)
  if (useCliEngine()) return runYtDlpDownloadCli(job, opts, format, pctFrom, pctTo, args.cookiefile);

  const useCli = useCliEngine();
  return new Promise((resolve) => {
    const outBase = args.out_base;
    const script = path.join(process.cwd(), "python", "download.py");
    const spawnOpts = {
      stdio: ["ignore", "pipe", "pipe"] as const,
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    };
    const proc = useCli
      ? spawn(
          ytDlpCliPath(),
          [
            ...cliBaseArgs(),
            "--newline",
            "--concurrent-fragments",
            "4",
            "--socket-timeout",
            "25",
            "--retries",
            "3",
            "--no-playlist",
            "--ffmpeg-location",
            resolveFfmpegBin(),
            ...(() => {
              const ck = writableCookiePath(args.cookiefile);
              return ck ? ["--cookies", ck] : [];
            })(),
            "-f",
            format,
            "-o",
            `${outBase}.%(ext)s`,
            opts.url,
          ],
          spawnOpts
        )
      : spawn(resolvePython(), [script, JSON.stringify(args)], spawnOpts);
    job.proc = proc;
    let buf = "";
    let stderrTail = "";
    let result: YtDlpResult | null = null;
    let settled = false;
    const finish = (r: YtDlpResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const span = pctTo - pctFrom;
    const UNIT: Record<string, number> = { KiB: 1024, MiB: 1048576, GiB: 1073741824 };
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (useCli) {
          // "[download]  34.5% of   10.00MiB at  1.20MiB/s ETA 00:05"
          const m = t.match(/^\[download\]\s+([\d.]+)% of\s+~?([\d.]+)(KiB|MiB|GiB)(?:\s+at\s+([\d.]+)(KiB|MiB|GiB)\/s)?/);
          if (m) {
            const pct = parseFloat(m[1]);
            const total = parseFloat(m[2]) * UNIT[m[3]];
            const speed = m[4] ? parseFloat(m[4]) * UNIT[m[5]] : undefined;
            setPhase(job, pctFrom + (pct / 100) * span, Math.round((total * pct) / 100), speed, total);
          }
          continue;
        }
        if (!t.startsWith("{")) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.type === "progress") {
            const scaled = pctFrom + ((msg.pct as number) / 100) * span;
            setPhase(job, scaled, msg.downloaded, msg.speed, msg.total || undefined);
          } else if (msg.ok === true) {
            result = { ok: true, path: msg.path, size: msg.size, ext: msg.ext };
          } else if (msg.ok === false && !result) {
            result = { ok: false, error: msg.error };
          }
        } catch {
          /* ignore non-JSON noise */
        }
      }
    });
    proc.stderr!.on("data", (d) => {
      // keep a small tail for error reporting (CLI engine)
      stderrTail += d.toString();
      if (stderrTail.length > 800) stderrTail = stderrTail.slice(-800);
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "Download timed out after 10 minutes" });
    }, JOB_TIMEOUT_MS);

    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `${useCli ? "yt-dlp" : "python"} spawn failed: ${e.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (result) {
        finish(result);
        return;
      }
      if (useCli) {
        // CLI mode: locate the final merged file next to out_base
        try {
          const dir = path.dirname(outBase);
          const base = path.basename(outBase);
          const files = fs
            .readdirSync(dir)
            .filter((f) => f.startsWith(base) && !f.endsWith(".part") && !f.endsWith(".ytdl"))
            .map((f) => path.join(dir, f));
          let best: string | null = null;
          let bestSize = 0;
          for (const f of files) {
            const st = fs.statSync(f);
            if (st.isFile() && st.size > bestSize) {
              bestSize = st.size;
              best = f;
            }
          }
          if (best && bestSize > 0) {
            finish({ ok: true, path: best, size: bestSize, ext: best.slice(best.lastIndexOf(".") + 1) });
            return;
          }
          finish({
            ok: false,
            error: `yt-dlp download failed (exit ${code}): ${stderrTail.slice(-300).trim() || "no output file"}`,
          });
          return;
        } catch (e) {
          finish({ ok: false, error: `yt-dlp output lookup failed: ${(e as Error).message}` });
          return;
        }
      }
      finish({ ok: false, error: "yt-dlp download failed (no result)" });
    });
  });
}

// ── CLI download walk (Vercel) ────────────────────────────────────────
// Each attempt is a full yt-dlp spawn. yt-dlp's youtube extractor accepts
// a comma-separated player_client list and merges/skips per client, so a
// bot-check on one client no longer kills the run. Cookie rotation and
// no-cookie fallbacks mirror the info-phase strategy (ytInfoWithFallback).

const DL_CLIENT_WALK = "tv,web_safari,android,ios,mweb,web";

function cliErrSummary(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.startsWith("ERROR:"));
  if (lines.length) return lines[lines.length - 1].replace(/^ERROR:\s*/, "").slice(0, 300);
  return stderr.trim().slice(-300);
}

/** Human-friendly wording for the download error page (bot-check etc.). */
function friendlyDlError(err: string): string {
  if (/sign in to confirm|not a bot/i.test(err)) {
    return "YouTube is challenging this server's connection (bot check). Please go back and try again — it usually passes on a retry.";
  }
  if (/429|too many requests/i.test(err)) {
    return "YouTube is rate-limiting this server (HTTP 429). Please wait about a minute and try again.";
  }
  if (/failed to extract any player response/i.test(err)) {
    return "YouTube is challenging this server's connection right now — please wait about 5 minutes and try again.";
  }
  if (/requested format/i.test(err)) {
    return "The selected quality is no longer available. Please go back, refresh the formats and try again.";
  }
  return err;
}

/** Locate the finished file for one attempt (largest non-partial output). */
function pickFinalFile(base: string): YtDlpResult | null {
  try {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
    let best: string | null = null;
    let bestSize = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile() && st.size > bestSize) {
        bestSize = st.size;
        best = path.join(dir, f);
      }
    }
    if (best && bestSize > 0) {
      return { ok: true, path: best, size: bestSize, ext: best.slice(best.lastIndexOf(".") + 1) };
    }
  } catch {
    /* dir vanished */
  }
  return null;
}

function spawnCliDownload(
  argv: string[],
  timeoutMs: number,
  onProgress: (pct: number, total: number, downloaded: number, speed?: number) => void
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stderr = "";
    let buf = "";
    let timedOut = false;
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
        // Own process group: on timeout kill yt-dlp AND its JS-runtime children
        // (node/bun) — a lingering child otherwise holds the stdio pipes open
        // and delays 'close' after every timed-out attempt.
        detached: true,
      });
    } catch (e) {
      resolve({ code: 1, stderr: String((e as Error).message || e), timedOut: false });
      return;
    }
    const UNIT: Record<string, number> = { KiB: 1024, MiB: 1048576, GiB: 1073741824 };
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        // "[download]  34.5% of   10.00MiB at  1.20MiB/s ETA 00:05"
        const m = line
          .trim()
          .match(/^\[download\]\s+([\d.]+)% of\s+~?([\d.]+)(KiB|MiB|GiB)(?:\s+at\s+([\d.]+)(KiB|MiB|GiB)\/s)?/);
        if (m) {
          const total = parseFloat(m[2]) * UNIT[m[3]];
          const downloaded = (total * parseFloat(m[1])) / 100;
          const speed = m[4] ? parseFloat(m[4]) * UNIT[m[5]] : undefined;
          onProgress(parseFloat(m[1]), total, downloaded, speed);
        }
      }
    });
    proc.stderr!.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
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
        resolve({ code: 1, stderr: stderr || e.message, timedOut });
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stderr, timedOut });
      }
    });
  });
}

async function runYtDlpDownloadCli(
  job: JobInternal,
  opts: StartDlJobOpts,
  format: string,
  pctFrom: number,
  pctTo: number,
  firstCookie: string | null = null
): Promise<YtDlpResult> {
  const span = pctTo - pctFrom;
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  const ck1 = firstCookie || getNextCookie();
  const ck2 = getNextCookie();
  const attempts: { ck: string | null; ca: string | null; label: string }[] = [];
  if (ck1) attempts.push({ ck: ck1, ca: DL_CLIENT_WALK, label: `${path.basename(ck1)}+clients` });
  if (ck2 && ck2 !== ck1) attempts.push({ ck: ck2, ca: DL_CLIENT_WALK, label: `${path.basename(ck2)}+clients` });
  if (ck1) attempts.push({ ck: ck1, ca: null, label: `${path.basename(ck1)}+default` });
  attempts.push({ ck: null, ca: "tv,web_safari,android", label: "no-cookie+clients" });
  attempts.push({ ck: null, ca: "mediaconnect", label: "no-cookie+mediaconnect" });

  let lastErr = "";
  for (let i = 0; i < attempts.length; i++) {
    const at = attempts[i];
    const remaining = deadline - Date.now();
    if (remaining < 20_000) break;
    // Server-IP challenge active (info phase already got refused): more
    // download attempts only deepen YouTube's flag — stop right away.
    if (ipChallengedRecently()) break;
    // 429 during the walk: stop — more attempts only extend the throttle
    if (i > 0 && /429|too many requests/i.test(lastErr)) break;

    const myBase = path.join(os.tmpdir(), `ytdl_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.a${i}`);
    const argv = [
      ytDlpCliPath(),
      ...cliBaseArgs(),
      "--newline",
      "--concurrent-fragments",
      "4",
      "--socket-timeout",
      "25",
      "--retries",
      "3",
      "--no-playlist",
      "--ffmpeg-location",
      resolveFfmpegBin(),
    ];
    const ck = at.ck ? writableCookiePath(at.ck) : null;
    if (ck) argv.push("--cookies", ck);
    if (at.ca) argv.push("--extractor-args", `youtube:player_client=${at.ca}`);
    argv.push("-f", format, "-o", `${myBase}.%(ext)s`, opts.url);

    const t0 = Date.now();
    const r = await spawnCliDownload(argv, Math.min(remaining, 180_000), (pct, _total, downloaded, speed) => {
      setPhase(job, pctFrom + (pct / 100) * span, downloaded, speed);
    });
    const done = pickFinalFile(myBase);
    if (done) {
      if (at.ck) markCookieGood(at.ck);
      console.log(`[dl-walk ${i}] ${at.label} OK in ${Math.round(((Date.now() - t0) / 1000) * 10) / 10}s (${done.size} bytes)`);
      return done;
    }
    lastErr = r.timedOut ? "attempt timed out" : r.stderr.trim() ? cliErrSummary(r.stderr) : `exit ${r.code}`;
    console.log(`[dl-walk ${i}] ${at.label} failed in ${Math.round(((Date.now() - t0) / 1000) * 10) / 10}s: ${lastErr.slice(0, 120)}`);
    // All player clients refused with this cookie = server-IP challenge —
    // cool down globally so the NEXT user request fails fast and gently.
    if (isIpChallenge(lastErr)) {
      markIpChallenged();
      break;
    }
    // A challenged cookie cools down so later requests start elsewhere
    if (at.ck && /sign in to confirm|not a bot/i.test(lastErr)) markCookieBlocked(at.ck, 120_000);
  }
  return { ok: false, error: `yt-dlp download failed: ${friendlyDlError(lastErr || "no output file")}` };
}

// ── local ffmpeg post-processing ──────────────────────────────────────

function tmpOut(suffix: string): string {
  return path.join(os.tmpdir(), `job_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${suffix}`);
}

/** Fast WhatsApp-safe faststart remux of an already H.264/AAC mp4. */
function faststartRemux(inputPath: string): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const out = tmpOut(".mp4");
  return new Promise((resolve) => {
    const proc = spawn(
      resolveFfmpegBin(),
      ["-y", "-loglevel", "error", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", out],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let settled = false;
    const finish = (r: { ok: boolean; filePath?: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    proc.on("error", (e) => finish({ ok: false, error: e.message }));
    proc.on("close", (code) => {
      if (code !== 0) {
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `faststart remux failed (${code})` });
        return;
      }
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (!size) {
        finish({ ok: false, error: "faststart remux produced empty output" });
        return;
      }
      finish({ ok: true, filePath: out });
    });
  });
}

/**
 * Probe the actual video/audio codecs of a downloaded file (ffprobe).
 * WhatsApp-safe = H.264 video + AAC audio. Returns null on any failure so
 * callers fall back to the safe (re-encode) path.
 */
function probeCodecs(
  filePath: string
): Promise<{ video: string; audio: string } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    let settled = false;
    const finish = (r: { video: string; audio: string } | null) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    proc.on("error", () => finish(null));
    proc.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = j.streams?.[0]?.codec_name || "";
        if (!v) return finish(null);
        // audio codec via second probe
        const p2 = spawn(
          "ffprobe",
          [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "json",
            filePath,
          ],
          { stdio: ["ignore", "pipe", "ignore"] }
        );
        let out2 = "";
        p2.stdout!.on("data", (d) => (out2 += d.toString()));
        p2.on("error", () => finish({ video: v, audio: "" }));
        p2.on("close", () => {
          try {
            const j2 = JSON.parse(out2);
            const a = j2.streams?.[0]?.codec_name || "";
            finish({ video: v, audio: a });
          } catch {
            finish({ video: v, audio: "" });
          }
        });
      } catch {
        finish(null);
      }
    });
    proc.stdout!.on("data", (d) => (out += d.toString()));
  });
}

/**
 * Re-encode ANY downloaded media file (mp4/webm/mkv, any codecs) into a
 * WhatsApp-safe MP4 (H.264 high + AAC, ≤1080p, faststart). Progress maps
 * onto [pctFrom, pctTo] via ffmpeg -progress out_time.
 */
function reencodeLocal(
  job: JobInternal,
  inputPath: string,
  durationSec: number | null,
  pctFrom: number,
  pctTo: number
): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const out = tmpOut(".mp4");
  const args = [
    "-y",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-nostats",
    "-i", inputPath,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-vf",
    "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4",
    out,
  ];
  return new Promise((resolve) => {
    const proc = spawn(resolveFfmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    job.proc = proc;
    let buf = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { ok: boolean; filePath?: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const span = pctTo - pctFrom;
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        let m: RegExpMatchArray | null;
        let outSec: number | null = null;
        if ((m = t.match(/out_time_us=(\d+)/))) outSec = parseInt(m[1], 10) / 1e6;
        else if ((m = t.match(/out_time_ms=(\d+)/))) outSec = parseInt(m[1], 10) / 1e6;
        if (outSec !== null && durationSec && durationSec > 0) {
          setPhase(job, pctFrom + (outSec / durationSec) * span);
        }
      }
    });
    proc.stderr!.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "re-encode timed out" });
    }, JOB_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `re-encode failed (${code}): ${stderr.slice(-200)}` });
        return;
      }
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (!size) {
        finish({ ok: false, error: "re-encode produced empty output" });
        return;
      }
      finish({ ok: true, filePath: out });
    });
  });
}

/** Convert a downloaded audio file to MP3 with progress on [pctFrom, pctTo]. */
function audioToMp3Local(
  job: JobInternal,
  inputPath: string,
  durationSec: number | null,
  pctFrom: number,
  pctTo: number
): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const out = tmpOut(".mp3");
  const args = [
    "-y",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-nostats",
    "-i", inputPath,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", "44100",
    "-f", "mp3",
    out,
  ];
  return new Promise((resolve) => {
    const proc = spawn(resolveFfmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    job.proc = proc;
    let buf = "";
    let settled = false;
    const finish = (r: { ok: boolean; filePath?: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const span = pctTo - pctFrom;
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        let m: RegExpMatchArray | null;
        let outSec: number | null = null;
        if ((m = t.match(/out_time_us=(\d+)/))) outSec = parseInt(m[1], 10) / 1e6;
        else if ((m = t.match(/out_time_ms=(\d+)/))) outSec = parseInt(m[1], 10) / 1e6;
        if (outSec !== null && durationSec && durationSec > 0) {
          setPhase(job, pctFrom + (outSec / durationSec) * span);
        }
      }
    });
    proc.stderr!.on("data", () => {});
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: "mp3 conversion timed out" });
    }, JOB_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `mp3 conversion failed (${code})` });
        return;
      }
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (!size) {
        finish({ ok: false, error: "mp3 conversion produced empty output" });
        return;
      }
      finish({ ok: true, filePath: out });
    });
  });
}

// ── the job runner ────────────────────────────────────────────────────

function cleanupFile(p?: string | null): void {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

const EXT_CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

function extContentType(ext: string): string {
  return EXT_CONTENT_TYPES[ext.toLowerCase()] || "application/octet-stream";
}

function finalizeDone(job: JobInternal, filePath: string): void {
  job.state = "done";
  job.filePath = filePath;
  job.pct = 100;
  job.note = undefined;
  try {
    job.size = fs.statSync(filePath).size;
  } catch {
    job.size = undefined;
  }
  console.log(`[job ${job.id}] done (${job.size} bytes)`);
}

async function runJob(job: JobInternal, opts: StartDlJobOpts): Promise<void> {
  const durationSec = opts.durationSec ? Math.round(opts.durationSec) : null;
  let downloadedPath: string | null = null;
  try {
    job.note = opts.mode === "mp3" ? "Fetching audio via yt-dlp + cookies…" : "Fetching streams via yt-dlp + cookies…";

    // ── phase 1: yt-dlp download (chunked ranges defeat the throttle) ──
    const dl = await runYtDlpDownload(job, opts, 0, opts.mode === "mp3" ? 80 : 88);
    if (!dl.ok || !dl.path) {
      job.state = "error";
      job.error = dl.error || "yt-dlp download failed";
      console.log(`[job ${job.id}] download failed: ${job.error}`);
      return;
    }
    downloadedPath = dl.path;

    // ── raw mode: serve the original file as-is (no conversion) ──────
    if (opts.mode === "raw") {
      if (dl.ext) job.contentType = extContentType(dl.ext);
      finalizeDone(job, downloadedPath);
      return;
    }

    if (dl.size) job.estBytes = opts.mode === "mp3" ? Math.round(dl.size * 1.0) : Math.round(dl.size * 1.005);
    job.speedBps = undefined;
    job.etaSec = undefined;

    if (opts.mode === "mp3") {
      // ── phase 2: local mp3 conversion ────────────────────────────────
      job.note = "Converting to MP3…";
      const r = await audioToMp3Local(job, downloadedPath, durationSec, 80, 100);
      if (r.ok && r.filePath) {
        finalizeDone(job, r.filePath);
      } else {
        job.state = "error";
        job.error = r.error || "MP3 conversion failed";
      }
      cleanupFile(downloadedPath);
      return;
    }

    // ── phase 2 (mp4): WhatsApp-safe finalisation ─────────────────────
    // Decide by the ACTUAL codecs of the downloaded file: an exact
    // avc1+aac source is remuxed losslessly (fast); anything else
    // (vp9/av01/opus — 4K/2K rows etc.) is re-encoded to WhatsApp-safe
    // H.264/AAC. If probing fails, err on the safe side and re-encode.
    // Codec probe needs ffprobe (absent on Vercel) — when unavailable,
    // fall back to the codec info of the requested formats (canCopy).
    const codecs = await probeCodecs(downloadedPath);
    const copySafe = codecs ? codecs.video === "h264" && codecs.audio === "aac" : !!opts.canCopy;
    if (copySafe) {
      job.note = "Finalising WhatsApp-ready MP4…";
      setPhase(job, 92);
      const r = await faststartRemux(downloadedPath);
      if (r.ok && r.filePath) {
        finalizeDone(job, r.filePath);
        cleanupFile(downloadedPath);
        return;
      }
      console.log(`[job ${job.id}] faststart remux failed (${r.error}) — re-encoding`);
      job.note = "Re-encoding to WhatsApp-safe H.264/AAC…";
      const r2 = await reencodeLocal(job, downloadedPath, durationSec, 88, 98);
      if (r2.ok && r2.filePath) {
        finalizeDone(job, r2.filePath);
        cleanupFile(downloadedPath);
        return;
      }
      job.state = "error";
      job.error = r2.error || "Video conversion failed";
      cleanupFile(downloadedPath);
      return;
    }

    // non-WhatsApp-safe codecs (vp9/av01/opus etc.) → full re-encode
    job.note = "Re-encoding to WhatsApp-safe H.264/AAC…";
    const r = await reencodeLocal(job, downloadedPath, durationSec, 88, 98);
    if (r.ok && r.filePath) {
      finalizeDone(job, r.filePath);
      cleanupFile(downloadedPath);
      return;
    }
    job.state = "error";
    job.error = r.error || "Video conversion failed";
    cleanupFile(downloadedPath);
  } catch (e) {
    job.state = "error";
    job.error = (e as Error).message;
    cleanupFile(downloadedPath);
  }
}

// ── one-shot (serverless) pipeline ─────────────────────────────────────
// On Vercel the in-memory job map cannot survive across requests, so the
// download must complete INSIDE a single request. Same pipeline as runJob,
// but awaitable and returning the finished file instead of registering a job.

export interface SyncDlResult {
  ok: boolean;
  filePath?: string;
  size?: number;
  contentType?: string;
  error?: string;
}

function statSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export async function runDownloadSync(opts: StartDlJobOpts): Promise<SyncDlResult> {
  const job: JobInternal = {
    id: crypto.randomBytes(8).toString("hex"),
    state: "running",
    filename: opts.filename,
    contentType: opts.contentType || (opts.mode === "mp3" ? "audio/mpeg" : "video/mp4"),
    createdAt: Date.now(),
    pct: 0,
    gotBytes: 0,
    estBytes: opts.estBytes || undefined,
  };
  const durationSec = opts.durationSec ? Math.round(opts.durationSec) : null;
  let downloadedPath: string | null = null;
  try {
    const dl = await runYtDlpDownload(job, opts, 0, opts.mode === "mp3" ? 80 : 88);
    if (!dl.ok || !dl.path) return { ok: false, error: dl.error || "yt-dlp download failed" };
    downloadedPath = dl.path;

    if (opts.mode === "raw") {
      const ct = dl.ext ? extContentType(dl.ext) : job.contentType;
      return { ok: true, filePath: downloadedPath, size: statSize(downloadedPath), contentType: ct };
    }

    if (opts.mode === "mp3") {
      const r = await audioToMp3Local(job, downloadedPath, durationSec, 80, 100);
      cleanupFile(downloadedPath);
      if (r.ok && r.filePath) {
        return { ok: true, filePath: r.filePath, size: statSize(r.filePath), contentType: "audio/mpeg" };
      }
      return { ok: false, error: r.error || "MP3 conversion failed" };
    }

    const codecs = await probeCodecs(downloadedPath);
    const copySafe = codecs ? codecs.video === "h264" && codecs.audio === "aac" : !!opts.canCopy;
    if (copySafe) {
      const r = await faststartRemux(downloadedPath);
      if (r.ok && r.filePath) {
        cleanupFile(downloadedPath);
        return { ok: true, filePath: r.filePath, size: statSize(r.filePath), contentType: "video/mp4" };
      }
      const r2 = await reencodeLocal(job, downloadedPath, durationSec, 88, 98);
      cleanupFile(downloadedPath);
      if (r2.ok && r2.filePath) {
        return { ok: true, filePath: r2.filePath, size: statSize(r2.filePath), contentType: "video/mp4" };
      }
      return { ok: false, error: r2.error || "Video conversion failed" };
    }

    const r = await reencodeLocal(job, downloadedPath, durationSec, 88, 98);
    cleanupFile(downloadedPath);
    if (r.ok && r.filePath) {
      return { ok: true, filePath: r.filePath, size: statSize(r.filePath), contentType: "video/mp4" };
    }
    return { ok: false, error: r.error || "Video conversion failed" };
  } catch (e) {
    cleanupFile(downloadedPath);
    return { ok: false, error: (e as Error).message };
  }
}
