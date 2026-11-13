// GET /api/download/facebook/file?url=&type=video|audio — proxy FB media.
// Facebook APIs return a single combined video (video+audio); type=audio
// falls back to the same video stream (most phones extract audio on save).
import { NextRequest } from "next/server";
import { fetchFacebookResult, type FacebookResult } from "@/lib/media/fetchers";
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
    const r: FacebookResult = await fetchFacebookResult(url);
    const qualities = r.qualities || [];
    const mediaUrl = String(
      r.download_url || (r.download_urls || [])[0] || qualities[0]?.url || ""
    ).trim();
    if (!mediaUrl) return jsonError("Facebook media URL not found — try again in a moment.");
    trackRequest({ headers: req.headers, path: "/api/download/facebook/file", method: "GET", url, platform: "facebook", status: 200 });
    return proxyMedia(mediaUrl, `facebook-${type === "audio" ? "audio" : "video"}-${Date.now()}.mp4`, "video/mp4", {
      referer: "https://www.facebook.com/",
      rangeHeader: req.headers.get("range"),
    });
  } catch (e) {
    trackRequest({ headers: req.headers, path: "/api/download/facebook/file", method: "GET", url, platform: "facebook", status: 502 });
    return jsonError((e as Error).message || "Facebook download failed");
  }
}
