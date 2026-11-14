// GET /api/download/raw?url=<youtube>&format_id=<fid>&ext=<mp4|webm|m4a|...>&native=1
// Download ONE exact stream in its original format (video-only mp4/webm,
// audio-only m4a/opus, combined progressive) via the yt-dlp job pipeline —
// chunked Range requests defeat the CDN throttle that stalls proxy streams
// partway through big files.
import { NextRequest } from "next/server";
import { normalizeUrl, isYoutubeUrl, safeFilename } from "@/lib/media/urls";
import { ytInfoWithFallback } from "@/lib/media/ytdlp";
import { cacheInfo, getCachedInfo } from "@/lib/media/formatcache";
import { startDlJob } from "@/lib/media/dljobs";
import { jsonError, progressPageHtml } from "@/lib/media/streaming";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("url") || "").trim();
  const formatId = (req.nextUrl.searchParams.get("format_id") || "").trim();
  const ext = (req.nextUrl.searchParams.get("ext") || "").trim().toLowerCase();
  if (!raw) return jsonError("url parameter required", 400);
  if (!formatId) return jsonError("format_id parameter required", 400);

  const url = normalizeUrl(raw);
  if (!isYoutubeUrl(url)) return jsonError("A YouTube URL is required", 400);

  const fail = (message: string, status = 502) => {
    trackRequest({
      headers: req.headers,
      path: "/api/download/raw",
      method: "GET",
      url: raw,
      status,
      error: message,
    });
    return jsonError(message, status);
  };

  // resolve title (cache first — the listing call already extracted it)
  let info = getCachedInfo(url);
  if (!info) {
    try {
      info = await ytInfoWithFallback(url);
      cacheInfo(url, info);
    } catch (e) {
      return fail(`Download could not start: ${(e as Error).message}`, 502);
    }
  }

  const all = [...(info.combined || []), ...(info.video_only || []), ...(info.audio_only || [])];
  const fmt = all.find((f) => f.format_id === formatId) || null;
  const outExt = ext || fmt?.ext || "mp4";
  const isAudio = ["m4a", "mp3", "opus", "ogg", "wav", "weba"].includes(outExt);
  const filename = safeFilename(info.title || "youtube-stream", outExt);

  const job = startDlJob({
    mode: "raw",
    url,
    videoFormatId: formatId,
    rawFallback: isAudio ? "bestaudio/best" : "best",
    filename,
    durationSec: info.duration_sec ?? null,
    estBytes: fmt?.filesize ?? null,
  });

  trackRequest({ headers: req.headers, path: "/api/download/raw", method: "GET", url: raw, status: 200 });
  return progressPageHtml(job.id, filename, "raw");
}
