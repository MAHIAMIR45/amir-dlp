// Streaming helpers — proxy upstream media and ffmpeg merged downloads.
// Ports _proxy_tiktok_media / _serve_tempfile / merge behaviour from app.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { USER_AGENT } from "./urls";

export function jsonError(message: string, status = 502): Response {
  return new Response(JSON.stringify({ status: "error", error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Friendly HTML error page for "native" downloads (browser navigates to the
 * download URL instead of fetch+blob). Shows the message and goes back
 * automatically so the app stays usable.
 */
export function htmlErrorPage(message: string, status = 502): Response {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download failed</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0d0f14;color:#e8eaf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{max-width:430px;margin:16px;padding:28px;border-radius:16px;background:#171a21;text-align:center;border:1px solid #262b36}h1{font-size:1.15rem;margin:0 0 10px}p{color:#9aa3b2;font-size:.9rem;line-height:1.55;margin:6px 0}.hint{opacity:.55;font-size:.8rem;margin-top:14px}</style></head><body><div class="box"><h1>&#10060; Download failed</h1><p>${safe}</p><p class="hint">Going back&hellip;</p></div><script>setTimeout(function(){history.back();},2600);</script></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Self-contained progress page for job-based downloads. Polls
 * /api/download/job?id=… and shows live %, size, speed and ETA; when the
 * merge finishes it navigates to /api/download/file?id=… which serves the
 * completed file with Content-Length — the phone's download manager then
 * shows a real total and the download cannot be truncated mid-way.
 */
export function progressPageHtml(jobId: string, filename: string, kind: "mp4" | "mp3" | "raw"): Response {
  const safeName = filename
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preparing download…</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0d0f14;color:#e8eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{width:min(430px,92vw);margin:16px;padding:28px;border-radius:16px;background:#171a21;text-align:center;border:1px solid #262b36}
h1{font-size:1.05rem;margin:0 0 6px}
.fname{color:#9aa3b2;font-size:.82rem;word-break:break-all;margin-bottom:18px}
.pct{font-size:2.2rem;font-weight:800;background:linear-gradient(90deg,#ff2d2d,#ff6b35);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.bar{height:10px;border-radius:6px;background:#262b36;overflow:hidden;margin:14px 0}
.bar>div{height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,#ff2d2d,#ff6b35);transition:width .5s ease}
.bar.ind>div{width:40%;animation:ind 1.4s ease-in-out infinite}
@keyframes ind{0%{margin-left:-40%}100%{margin-left:100%}}
.meta{color:#9aa3b2;font-size:.85rem;line-height:1.6}
.note{color:#f5a524;font-size:.8rem;margin-top:8px;min-height:1em}
.btn{display:inline-block;margin-top:16px;padding:10px 22px;border-radius:10px;background:linear-gradient(90deg,#ff2d2d,#ff6b35);color:#fff;font-weight:700;text-decoration:none;border:0;cursor:pointer;font-size:.9rem}
.ok{color:#22c55e;font-size:1.6rem;font-weight:800}
.err{color:#ff6b6b;font-size:.9rem;line-height:1.6}
.hint{opacity:.55;font-size:.75rem;margin-top:14px}
</style></head><body><div class="box">
<div id="view"><h1>Preparing your ${kind === "mp3" ? "MP3" : kind === "raw" ? "download" : "WhatsApp-ready MP4"}…</h1>
<div class="fname">${safeName}</div>
<div class="pct" id="pct">0%</div>
<div class="bar" id="bar"><div id="fill"></div></div>
<div class="meta" id="meta">Contacting YouTube via yt-dlp + cookies…</div>
<div class="note" id="note"></div></div>
</div>
<script>
(function(){
  var id=${JSON.stringify(jobId)};
  var pctEl=document.getElementById("pct"),fillEl=document.getElementById("fill"),barEl=document.getElementById("bar"),
      metaEl=document.getElementById("meta"),noteEl=document.getElementById("note"),viewEl=document.getElementById("view");
  function mb(n){return (n/1048576).toFixed(1)+" MB"}
  function fmtEta(s){if(!s||s<0)return"";if(s<60)return Math.round(s)+"s left";var m=Math.floor(s/60);return m+"m "+Math.round(s%60)+"s left"}
  function poll(){
    fetch("/api/download/job?id="+id,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
      if(j.ready){
        pctEl.textContent="100%";fillEl.style.width="100%";barEl.classList.remove("ind");
        viewEl.innerHTML='<div class="ok">✔ Ready</div><h1 style="margin-top:10px">Starting download…</h1><div class="fname">'+${JSON.stringify(safeName)}+'</div><div class="meta">'+mb(j.size||0)+' · ${kind === "mp3" ? "MP3 audio" : kind === "raw" ? "original format file" : "WhatsApp-ready MP4"}</div><a class="btn" href="/api/download/file?id='+id+'">⬇ Save file</a><div class="hint">Download runs in your notification bar — you can close this page.</div>';
        window.location.assign("/api/download/file?id="+id);
        return;
      }
      if(j.state==="error"){
        viewEl.innerHTML='<div class="err">❌ '+j.error+'</div><button class="btn" onclick="history.back()">Go back & retry</button>';
        setTimeout(function(){history.back()},6000);
        return;
      }
      if(j.pct>0){
        barEl.classList.remove("ind");
        pctEl.textContent=Math.round(j.pct)+"%";fillEl.style.width=j.pct+"%";
      } else {
        barEl.classList.add("ind");pctEl.textContent="…";
      }
      var bits=[];
      if(j.estBytes){bits.push(mb(j.gotBytes||0)+" of ~"+mb(j.estBytes))}
      else if(j.gotBytes){bits.push(mb(j.gotBytes))}
      if(j.speedBps){bits.push(mb(j.speedBps)+"/s")}
      var eta=fmtEta(j.etaSec);if(eta){bits.push(eta)}
      metaEl.textContent=bits.join(" · ")||"Downloading & merging on the server…";
      noteEl.textContent=j.note||"";
      setTimeout(poll,800);
    }).catch(function(){
      metaEl.textContent="Reconnecting…";
      setTimeout(poll,1500);
    });
  }
  poll();
})();
</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Proxy a remote media URL as a browser download.
 * Passes Range through so large files can resume.
 */
export async function proxyMedia(
  mediaUrl: string,
  filename: string,
  contentType: string,
  opts?: { expectedSize?: number | null; referer?: string; rangeHeader?: string | null }
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: opts?.referer || "https://www.tiktok.com/",
  };
  if (opts?.rangeHeader) headers["Range"] = opts.rangeHeader;

  let upstream: Response;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90_000);
    try {
      upstream = await fetch(mediaUrl, { signal: ctl.signal, headers });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.log(`[Proxy] upstream open failed: ${(e as Error).message}`);
    return jsonError(`Upstream unavailable: ${(e as Error).message}`);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonError("Upstream media unavailable");
  }

  const outHeaders = new Headers({
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": upstream.headers.get("Content-Type") || contentType,
  });
  const cl = upstream.headers.get("Content-Length");
  if (cl) outHeaders.set("Content-Length", cl);
  else if (opts?.expectedSize) outHeaders.set("Content-Length", String(opts.expectedSize));
  const cr = upstream.headers.get("Content-Range");
  if (cr) outHeaders.set("Content-Range", cr);
  const ar = upstream.headers.get("Accept-Ranges");
  if (ar) outHeaders.set("Accept-Ranges", ar);

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// ── ffmpeg helpers ────────────────────────────────────────────────────

import { resolveFfmpegBin } from "./engine";

function ffmpegBin(): string {
  return resolveFfmpegBin();
}

function ffmpegHeaders(): string {
  return `User-Agent: ${USER_AGENT}\r\nReferer: https://www.youtube.com/\r\n`;
}

const FFMPEG_TIMEOUT_MS = 600_000; // 10 min hard cap
export { FFMPEG_TIMEOUT_MS };

/**
 * ffmpeg HTTP input options for googlevideo/CDN streams.
 * Reconnect flags survive YouTube's mid-transfer connection resets, which
 * previously killed long ("full song") stream-piped downloads halfway.
 */
export function httpInput(url: string): string[] {
  return [
    "-reconnect", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_http_error", "429,403,500,502,503",
    "-reconnect_delay_max", "10",
    "-headers", ffmpegHeaders(),
    "-i", url,
  ];
}

export interface FfmpegResult {
  ok: boolean;
  filePath?: string;
  size?: number;
  error?: string;
}

/** WhatsApp-safe MP4: H.264 (avc1) + AAC (mp4a), even dims, faststart. */
export function mergeArgs(
  videoUrl: string,
  audioUrl: string,
  copy: boolean,
  forPipe = false,
  forProgress = false
): string[] {
  const base = [
    "-y",
    "-loglevel", "error",
    // -progress emits machine-readable progress key=value lines to stdout
    ...(forProgress ? (["-progress", "pipe:1", "-nostats"] as const) : []),
    ...httpInput(videoUrl),
    ...httpInput(audioUrl),
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    "-f", "mp4",
  ] as unknown as string[];
  if (forPipe) {
    // Pipe output is non-seekable: plain MP4 needs to seek (mdat size patch
    // + faststart). Fragmented MP4 streams progressively instead and is
    // still a standard MP4/H.264/AAC file WhatsApp accepts.
    base.push("-movflags", "+frag_keyframe+empty_moov+default_base_moof");
  } else {
    base.push("-movflags", "+faststart");
  }
  if (copy) {
    // Source is already avc1 + aac — stream copy is fast and lossless.
    return [...base, "-c", "copy", "-max_muxing_queue_size", "2048"];
  }
  // Re-encode anything non-WhatsApp-safe (vp9/av01 webm etc.) to H.264/AAC.
  // Forced 2s keyframes keep fragments flowing quickly over the pipe.
  // Cap at 1080p — WhatsApp's own max — so 4K inputs don't OOM the encoder
  // and transcode way faster.
  return [
    ...base,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-vf",
    "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-max_muxing_queue_size", "2048",
  ];
}

/**
 * Download video+audio (direct URLs, must be reachable from this server) and
 * merge into a WhatsApp-safe MP4 temp file. Caller streams then deletes it.
 *
 * When `copy` is set and the source is already avc1+aac the merge is a fast
 * stream copy; any ffmpeg failure automatically falls back to a full
 * re-encode so the output is ALWAYS a playable, WhatsApp-compatible MP4.
 */
export async function ffmpegMergeVideoAudio(
  videoUrl: string,
  audioUrl: string,
  onLog?: (line: string) => void,
  opts?: { copy?: boolean }
): Promise<FfmpegResult> {
  if (opts?.copy) {
    const fast = await runFfmpegToFile(mergeArgs(videoUrl, audioUrl, true), ".mp4", onLog);
    if (fast.ok) return fast;
    console.log(`[ffmpeg] copy merge failed (${fast.error}) — retrying with re-encode`);
    if (onLog) onLog("copy merge failed — re-encoding to WhatsApp-safe H.264/AAC");
  }
  return runFfmpegToFile(mergeArgs(videoUrl, audioUrl, false), ".mp4", onLog);
}

/** Convert an audio stream URL to MP3 (best-effort 128k). */
export function ffmpegAudioToMp3(audioUrl: string, onLog?: (line: string) => void): Promise<FfmpegResult> {
  return runFfmpegToFile(
    [
      "-y",
      "-loglevel", "error",
      ...httpInput(audioUrl),
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "128k",
      "-ar", "44100",
      "-f", "mp3",
    ],
    ".mp3",
    onLog
  );
}

/** Remux a combined (video+audio) stream URL into a clean MP4 without re-encoding. */
export function ffmpegRemuxCombined(streamUrl: string, onLog?: (line: string) => void): Promise<FfmpegResult> {
  return runFfmpegToFile(
    [
      "-y",
      "-loglevel", "error",
      ...httpInput(streamUrl),
      "-c", "copy",
      "-movflags", "+faststart",
      "-f", "mp4",
    ],
    ".mp4",
    onLog
  );
}

/**
 * LIVE-STREAMING merge — the WhatsApp-safe MP4 is piped to the browser the
 * moment ffmpeg starts producing data, so the phone's download manager shows
 * real progress instead of waiting for the whole server-side merge.
 *
 * Returns a streaming Response, or null when ffmpeg failed to start
 * (headers were not sent yet, so the caller can still fall back / error).
 */
export async function ffmpegStreamMerge(
  videoUrl: string,
  audioUrl: string,
  filename: string,
  opts?: { copy?: boolean }
): Promise<Response | null> {
  const trySpawn = (copy: boolean): ReturnType<typeof spawn> => {
    const args = [
      ...mergeArgs(videoUrl, audioUrl, copy, true),
      "pipe:1",
    ];
    return spawn(ffmpegBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  const FIRST_CHUNK_MS = 20_000;

  const waitFirstChunk = (proc: ReturnType<typeof spawn>): Promise<{ chunk: Buffer | null; stderr: string }> =>
    new Promise((resolve) => {
      let stderr = "";
      let done = false;
      const finish = (chunk: Buffer | null) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ chunk, stderr });
        }
      };
      proc.stderr!.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      proc.stdout!.once("data", (d) => finish(d as Buffer));
      proc.stdout!.once("close", () => finish(null));
      proc.on("close", () => finish(null));
      proc.on("error", () => finish(null));
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(null);
      }, FIRST_CHUNK_MS);
    });

  // Attempt 1: fast stream-copy when the sources are already H.264/AAC.
  let proc = trySpawn(!!opts?.copy);
  let first = await waitFirstChunk(proc);
  if (!first.chunk && opts?.copy) {
    console.log(`[ffmpeg-stream] copy merge failed to start (${first.stderr.slice(-200)}) — retrying with re-encode`);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    proc = trySpawn(false);
    first = await waitFirstChunk(proc);
  }
  if (!first.chunk) {
    console.log(`[ffmpeg-stream] merge failed to start: ${first.stderr.slice(-300)}`);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    return null;
  }

  console.log(`[ffmpeg-stream] streaming merge started (${opts?.copy ? "copy" : "re-encode"})`);
  const active = proc;
  const firstChunk = first.chunk;
  const killQuietly = () => {
    try {
      active.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  // Hard runtime cap so zombie transcodes can't linger.
  const killTimer = setTimeout(killQuietly, FFMPEG_TIMEOUT_MS);
  const clearKill = () => clearTimeout(killTimer);

  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        controller.enqueue(new Uint8Array(firstChunk));
      } catch {
        killQuietly();
        return;
      }
      active.stdout!.on("data", (d) => {
        try {
          controller.enqueue(new Uint8Array(d as Buffer));
        } catch {
          killQuietly();
        }
      });
      active.stdout!.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      active.stdout!.on("error", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      active.on("close", (code) => {
        clearKill();
        if (code !== 0) console.log(`[ffmpeg-stream] ffmpeg exited ${code} mid-stream (download truncated)`);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      clearKill();
      killQuietly();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Download a remote stream to a temp file with node fetch (proper UA +
 * redirects). Used before local-file ffmpeg merges — ffmpeg's own HTTP
 * client fails (exit 8) on some CDN URLs that node handles fine.
 */
export async function fetchToFile(mediaUrl: string, suffix: string, timeoutMs = 240_000): Promise<{ filePath: string; size: number } | null> {
  const tmp = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetch(mediaUrl, {
        signal: ctl.signal,
        headers: { "User-Agent": USER_AGENT, Referer: "https://www.youtube.com/" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok || !upstream.body) return null;
    const file = fs.createWriteStream(tmp);
    const reader = upstream.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((res) => file.once("drain", res));
      }
    }
    await new Promise<void>((res) => file.end(res));
    if (size === 0) {
      fs.unlinkSync(tmp);
      return null;
    }
    return { filePath: tmp, size };
  } catch (e) {
    console.log(`[fetchToFile] failed: ${(e as Error).message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Merge two ALREADY-DOWNLOADED local files into a WhatsApp-safe MP4. */
export async function ffmpegMergeLocalFiles(
  videoPath: string,
  audioPath: string | null,
  opts?: { copy?: boolean }
): Promise<FfmpegResult> {
  const base = [
    "-y",
    "-loglevel", "error",
    "-i", videoPath,
  ];
  if (audioPath) base.push("-i", audioPath);
  base.push("-map", "0:v:0");
  if (audioPath) base.push("-map", "1:a:0");
  base.push("-movflags", "+faststart", "-f", "mp4");
  if (audioPath) base.push("-shortest");
  const copyArgs = [...base, "-c", "copy", "-max_muxing_queue_size", "2048"];
  const encArgs = [
    ...base,
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
    "-max_muxing_queue_size", "2048",
  ];
  if (opts?.copy && audioPath) {
    const fast = await runFfmpegToFile(copyArgs, ".mp4");
    if (fast.ok) return fast;
    console.log(`[ffmpeg] local copy merge failed (${fast.error}) — re-encoding`);
  }
  return runFfmpegToFile(encArgs, ".mp4");
}

function runFfmpegToFile(
  args: string[],
  suffix: string,
  onLog?: (line: string) => void
): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`);
    const proc = spawn(ffmpegBin(), [...args, tmp], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (r: FfmpegResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    proc.stderr!.on("data", (d) => {
      const line = d.toString();
      stderr += line;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      if (onLog) onLog(line.trim());
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 60000} minutes` });
    }, FFMPEG_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `ffmpeg spawn failed: ${e.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `ffmpeg failed (${code}): ${stderr.slice(-300)}` });
        return;
      }
      let size = 0;
      try {
        size = fs.statSync(tmp).size;
      } catch {
        finish({ ok: false, error: "ffmpeg output missing" });
        return;
      }
      if (size === 0) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: "ffmpeg produced empty output" });
        return;
      }
      finish({ ok: true, filePath: tmp, size });
    });
  });
}

/** Stream a temp file with Content-Length, then delete it. */
export function serveTempFile(filePath: string, size: number, contentType: string, filename: string): Response {
  const nodeStream = fs.createReadStream(filePath);
  let deleted = false;
  const cleanup = () => {
    if (deleted) return;
    deleted = true;
    nodeStream.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  };
  nodeStream.on("error", cleanup);
  nodeStream.on("close", cleanup);

  // Explicit web ReadableStream wrapper: handles client aborts cleanly
  // (cancel -> delete temp file) and never leaks ERR_INVALID_STATE.
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      nodeStream.on("error", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        cleanup();
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}

export function jsonInfo(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
