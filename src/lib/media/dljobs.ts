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
import { getNextCookie, markCookieGood, resolvePython } from "./ytdlp";

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

  return new Promise((resolve) => {
    const outBase = args.out_base;
    const script = path.join(process.cwd(), "python", "download.py");
    const proc = spawn(resolvePython(), [script, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });
    job.proc = proc;
    let buf = "";
    let result: YtDlpResult | null = null;
    let settled = false;
    const finish = (r: YtDlpResult) => {
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
    proc.stderr!.on("data", () => {}); // yt-dlp is quiet; keep pipe drained

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
      finish({ ok: false, error: `python spawn failed: ${e.message}` });
    });
    proc.on("close", () => {
      clearTimeout(timer);
      if (result) {
        finish(result);
        return;
      }
      finish({ ok: false, error: "yt-dlp download failed (no result)" });
    });
  });
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
      "ffmpeg",
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
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    const codecs = await probeCodecs(downloadedPath);
    if (codecs && codecs.video === "h264" && codecs.audio === "aac") {
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
