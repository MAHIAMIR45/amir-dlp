// GET /api/download/pinterest?url= — Pinterest info via backup API chain.
import { NextRequest } from "next/server";
import { fetchPinterestResult, buildPinterestResponse } from "@/lib/media/fetchers";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const url = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!url) {
    trackRequest({ headers: req.headers, path: "/api/download/pinterest", method: "GET", url: null, platform: "pinterest", status: 400 });
    return new Response(JSON.stringify({ status: "error", error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await fetchPinterestResult(url);
    trackRequest({ headers: req.headers, path: "/api/download/pinterest", method: "GET", url, platform: "pinterest", status: 200 });
    return new Response(JSON.stringify(buildPinterestResponse(url, result)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = (e as Error).message || "Pinterest extraction failed";
    trackRequest({ headers: req.headers, path: "/api/download/pinterest", method: "GET", url, platform: "pinterest", status: 502 });
    return new Response(JSON.stringify({ status: "error", error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
