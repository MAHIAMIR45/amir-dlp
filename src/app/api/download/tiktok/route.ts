// GET /api/download/tiktok?url= — TikTok info via the backup API chain.
import { NextRequest } from "next/server";
import { fetchTiktokResult, buildTiktokResponse } from "@/lib/media/fetchers";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) {
    trackRequest({ headers: req.headers, path: "/api/download/tiktok", method: "GET", url: null, platform: "tiktok", status: 400 });
    return new Response(JSON.stringify({ status: "error", error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await fetchTiktokResult(url);
    trackRequest({ headers: req.headers, path: "/api/download/tiktok", method: "GET", url, platform: "tiktok", status: 200 });
    return new Response(JSON.stringify(buildTiktokResponse(url, result)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = (e as Error).message || "TikTok extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/tiktok", method: "GET", url, platform: "tiktok", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
