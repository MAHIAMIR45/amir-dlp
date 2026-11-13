// GET /api/download/facebook?url= — Facebook info via backup API chain.
import { NextRequest } from "next/server";
import { fetchFacebookResult, buildFacebookResponse } from "@/lib/media/fetchers";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) {
    trackRequest({ headers: req.headers, path: "/api/download/facebook", method: "GET", url: null, platform: "facebook", status: 400 });
    return new Response(JSON.stringify({ status: "error", error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await fetchFacebookResult(url);
    trackRequest({ headers: req.headers, path: "/api/download/facebook", method: "GET", url, platform: "facebook", status: 200 });
    return new Response(JSON.stringify(buildFacebookResponse(url, result)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = (e as Error).message || "Facebook extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/facebook", method: "GET", url, platform: "facebook", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
