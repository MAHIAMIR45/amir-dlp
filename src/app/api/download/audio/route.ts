// GET /api/download/audio?url= — YouTube audio formats listing (MP3).
// Cache-first: a repeat listing for the same video returns INSTANTLY from
// the in-memory cache (API-style usage — no re-extraction every call).
import { NextRequest } from "next/server";
import { isDegradedInfo, ytInfoWithFallback, type FormatEntry, type YtInfo } from "@/lib/media/ytdlp";
import { cacheInfo, getCachedInfo } from "@/lib/media/formatcache";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function sanitizeTitle(t: string | null | undefined): string {
  return (
    (t || "audio")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "audio"
  );
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

function audioListingResponse(info: YtInfo, url: string, fromCache: boolean): Response {
  const title = sanitizeTitle(info.title);
  const dur = info.duration_sec ?? null;
  const rows = (info.audio_only || []).map((f) => ({
    format_id: f.format_id,
    ext: "mp3",
    height: null as number | null,
    fps: null as number | null,
    vcodec: f.vcodec,
    acodec: f.acodec,
    abr: f.abr,
    filesize: f.filesize,
    filesize_human: f.filesize_human,
    format_note: f.format_note || "Audio",
    has_audio: true,
    url: f.url,
    download_url: mp3Link(url, f, title, dur),
  }));
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
      best_audio: rows[0] || null,
      all_audio_formats: rows,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) {
    trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url: null, platform: "youtube", status: 400 });
    return new Response(JSON.stringify({ status: "error", error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Cache-first: a previous FULL (non-degraded) listing for this exact
    // URL answers instantly — repeat API calls must not re-walk YouTube.
    const cached = getCachedInfo(url);
    if (cached && !isDegradedInfo(cached)) {
      trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url, platform: "youtube", status: 200 });
      return audioListingResponse(cached, url, true);
    }
    const info: YtInfo = await ytInfoWithFallback(url);
    cacheInfo(url, info);
    trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url, platform: "youtube", status: 200 });
    return audioListingResponse(info, url, false);
  } catch (e) {
    const msg = (e as Error).message || "Extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url, platform: "youtube", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
