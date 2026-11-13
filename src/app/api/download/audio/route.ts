// GET /api/download/audio?url= — YouTube audio formats listing (MP3).
import { NextRequest } from "next/server";
import { ytInfoWithFallback, type FormatEntry, type YtInfo } from "@/lib/media/ytdlp";
import { cacheInfo } from "@/lib/media/formatcache";
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
    const info: YtInfo = await ytInfoWithFallback(url);
    cacheInfo(url, info);
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
    trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url, platform: "youtube", status: 200 });
    return new Response(
      JSON.stringify({
        status: "ok",
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        channel: info.channel,
        backup: false,
        _backup_url: url,
        best_audio: rows[0] || null,
        all_audio_formats: rows,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    const msg = (e as Error).message || "Extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/audio", method: "GET", url, platform: "youtube", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
