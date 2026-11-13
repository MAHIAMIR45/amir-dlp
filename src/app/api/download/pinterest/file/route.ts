// GET /api/download/pinterest/file?url= — proxy the Pinterest media.
import { NextRequest } from "next/server";
import { fetchPinterestResult, type PinterestResult } from "@/lib/media/fetchers";
import { jsonError, proxyMedia } from "@/lib/media/streaming";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) return jsonError("url is required", 400);
  try {
    const r: PinterestResult = await fetchPinterestResult(url);
    const mediaUrl = String(r.download_url || r.video || (r.download_urls || [])[0] || "").trim();
    if (!mediaUrl) return jsonError("Pinterest media URL not found — try again in a moment.");
    trackRequest({ headers: req.headers, path: "/api/download/pinterest/file", method: "GET", url, platform: "pinterest", status: 200 });
    return proxyMedia(mediaUrl, `pinterest-video-${Date.now()}.mp4`, "video/mp4", {
      referer: "https://www.pinterest.com/",
      rangeHeader: req.headers.get("range"),
    });
  } catch (e) {
    trackRequest({ headers: req.headers, path: "/api/download/pinterest/file", method: "GET", url, platform: "pinterest", status: 502 });
    return jsonError((e as Error).message || "Pinterest download failed");
  }
}
