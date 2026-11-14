// GET /api/download/video?url= — YouTube format listing (Video+Audio /
// Video Only / Audio Only tabs). 100% yt-dlp + cookies engine.
// Cache-first: repeat listings for the same video answer instantly.
import { NextRequest } from "next/server";
import { isDegradedInfo, ytInfoWithFallback, type FormatEntry, type YtInfo } from "@/lib/media/ytdlp";
import { cacheInfo, getCachedInfo } from "@/lib/media/formatcache";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function sanitizeTitle(t: string | null | undefined): string {
  return (
    (t || "video")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "video"
  );
}

function mp4Link(url: string, row: FormatEntry, aid: string | null, acodec: string | null, title: string, dur: number | null, height?: number | null): string {
  const p = new URLSearchParams({
    url,
    vid: row.format_id || "",
    title,
    native: "1",
  });
  if (dur) p.set("dur", String(Math.round(dur)));
  if (height) p.set("height", String(height));
  if (aid) p.set("aid", aid);
  if (acodec) p.set("ac", acodec);
  return `/api/download/mp4?${p.toString()}`;
}

function mp3Link(url: string, row: FormatEntry, title: string, dur: number | null): string {
  const p = new URLSearchParams({
    url,
    fmt: row.format_id || "",
    title,
    abr: String(row.abr || 128),
    native: "1",
  });
  if (dur) p.set("dur", String(Math.round(dur)));
  return `/api/download/mp3?${p.toString()}`;
}

/** For every height keep the best variant, preferring avc1 (copy-safe). */
function pickPerHeight(list: FormatEntry[]): FormatEntry[] {
  const byH = new Map<number, FormatEntry>();
  for (const f of list) {
    const h = f.height || 0;
    if (!h) continue;
    const cur = byH.get(h);
    const fAvc = (f.vcodec || "").startsWith("avc1");
    if (!cur) {
      byH.set(h, f);
      continue;
    }
    const curAvc = (cur.vcodec || "").startsWith("avc1");
    if (fAvc && !curAvc) byH.set(h, f);
    else if (fAvc === curAvc && (f.tbr || f.vbr || 0) > (cur.tbr || cur.vbr || 0)) byH.set(h, f);
  }
  return [...byH.values()].sort((a, b) => (b.height || 0) - (a.height || 0));
}

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) {
    trackRequest({ headers: req.headers, path: "/api/download/video", method: "GET", url: null, platform: "youtube", status: 400 });
    return new Response(JSON.stringify({ status: "error", error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Cache-first: a previous FULL (non-degraded) listing answers instantly.
    const cached = getCachedInfo(url);
    if (cached && !isDegradedInfo(cached)) {
      trackRequest({ headers: req.headers, path: "/api/download/video", method: "GET", url, platform: "youtube", status: 200 });
      return videoListingResponse(cached, url, true);
    }
    const info: YtInfo = await ytInfoWithFallback(url);
    cacheInfo(url, info);
    trackRequest({ headers: req.headers, path: "/api/download/video", method: "GET", url, platform: "youtube", status: 200 });
    return videoListingResponse(info, url, false);
  } catch (e) {
    const msg = (e as Error).message || "Extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/video", method: "GET", url, platform: "youtube", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function videoListingResponse(info: YtInfo, url: string, fromCache: boolean): Response {
    const title = sanitizeTitle(info.title);
    const dur = info.duration_sec ?? null;
    const audioBest = (info.audio_only || [])[0] || null;
    const aid = audioBest?.format_id || null;
    const acodec = audioBest?.acodec || null;

    // Video+Audio rows: every height (1080/720/480/360/…) paired with the
    // best audio — downloaded as one WhatsApp-safe MP4 via the job engine.
    const sourceList: FormatEntry[] =
      info.video_only && info.video_only.length ? info.video_only : info.combined || [];
    const vaRows = pickPerHeight(sourceList).map((f) => ({
      format_id: f.format_id,
      ext: "mp4",
      height: f.height,
      fps: f.fps,
      vcodec: f.vcodec,
      acodec: acodec || f.acodec,
      abr: audioBest?.abr || 0,
      filesize: (f.filesize || 0) + (audioBest?.filesize || 0) || null,
      filesize_human: f.filesize_human,
      format_note: f.height && f.height >= 2160 ? "4K · WhatsApp-safe MP4" : "WhatsApp-safe MP4",
      has_audio: true,
      url: f.url,
      download_url: mp4Link(url, f, aid, acodec, title, dur, f.height),
    }));

    // Video Only rows: exact format ids, still merged to WhatsApp-safe MP4.
    const voRows = (info.video_only || []).map((f) => ({
      format_id: f.format_id,
      ext: "mp4",
      height: f.height,
      fps: f.fps,
      vcodec: f.vcodec,
      acodec: acodec || f.acodec,
      abr: audioBest?.abr || 0,
      filesize: (f.filesize || 0) + (audioBest?.filesize || 0) || null,
      filesize_human: f.filesize_human,
      format_note: f.format_note || "Video only",
      has_audio: true,
      url: f.url,
      download_url: mp4Link(url, f, aid, acodec, title, dur, f.height),
    }));

    // Audio Only rows: converted to MP3 via the job engine.
    const aoRows = (info.audio_only || []).map((f) => ({
      format_id: f.format_id,
      ext: "mp3",
      height: null,
      fps: null,
      vcodec: f.vcodec,
      acodec: f.acodec,
      abr: f.abr,
      filesize: f.filesize,
      filesize_human: f.filesize_human,
      format_note: f.format_note || "Audio only",
      has_audio: true,
      url: f.url,
      download_url: mp3Link(url, f, title, dur),
    }));
    // Proxy routes (tv client) often return COMBINED formats only, so the
    // MP3 tab would be empty even though the download engine can still
    // resolve bestaudio itself — synthesize one row for it.
    if (!aoRows.length && ((info.video_only || []).length || (info.combined || []).length)) {
      aoRows.push({
        format_id: "bestaudio",
        ext: "mp3",
        height: null,
        fps: null,
        vcodec: "none",
        acodec: "mp4a",
        abr: 128,
        filesize: null,
        filesize_human: null,
        format_note: "Best audio",
        has_audio: true,
        url: null,
        download_url: mp3Link(url, { format_id: "bestaudio" } as FormatEntry, title, dur),
      });
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        channel: info.channel,
        backup: false,
        _backup_url: url,
        cached: fromCache,
        formats: {
          video_audio: vaRows,
          video_only: voRows,
          audio_only: aoRows,
        },
        formats_count: vaRows.length + voRows.length + aoRows.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
}
