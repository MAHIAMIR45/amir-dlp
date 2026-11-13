// GET /api/download/tiktok/file?url=&type=video|audio — proxy the TikTok
// media through this server as a browser download (Range supported).
import { NextRequest } from "next/server";
import { fetchTiktokResult, type TiktokResult } from "@/lib/media/fetchers";
import { jsonError, proxyMedia } from "@/lib/media/streaming";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const url = (sp.get("url") || "").trim();
  const type = (sp.get("type") || "video").toLowerCase();
  if (!url) return jsonError("url is required", 400);

  try {
    const r: TiktokResult = await fetchTiktokResult(url);
    const mediaUrl =
      type === "audio"
        ? String(r.music || r.music_info?.url || "").trim()
        : String(r.hdplay || r.play || "").trim();
    if (!mediaUrl) return jsonError(`TikTok ${type} URL not found — try again in a moment.`);
    const filename =
      type === "audio"
        ? `tiktok-audio-${Date.now()}.mp3`
        : `tiktok-video-${Date.now()}.mp4`;
    trackRequest({ headers: req.headers, path: "/api/download/tiktok/file", method: "GET", url, platform: "tiktok", status: 200 });
    return proxyMedia(mediaUrl, filename, type === "audio" ? "audio/mpeg" : "video/mp4", {
      expectedSize: type === "audio" ? r.music_info?.size ?? null : r.size_nowm_hd ?? r.size_nowm ?? null,
      referer: "https://www.tiktok.com/",
      rangeHeader: req.headers.get("range"),
    });
  } catch (e) {
    trackRequest({ headers: req.headers, path: "/api/download/tiktok/file", method: "GET", url, platform: "tiktok", status: 502 });
    return jsonError((e as Error).message || "TikTok download failed");
  }
}
