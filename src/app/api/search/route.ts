import { NextRequest } from "next/server";
import { ytSearch } from "@/lib/media/ytdlp";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const query = (req.nextUrl.searchParams.get("q") || "").trim();
  const limit = Math.min(20, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "12", 10) || 12));

  if (!query) {
    trackRequest({ headers: req.headers, path: "/api/search", method: "GET", url: null, platform: "other", status: 400 });
    return new Response(JSON.stringify({ error: "Query is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { results } = await ytSearch(query, limit);
    trackRequest({ headers: req.headers, path: "/api/search", method: "GET", url: query, platform: "other", status: 200 });
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    trackRequest({
      headers: req.headers,
      path: "/api/search",
      method: "GET",
      url: query,
      platform: "other",
      status: 500,
      error: (e as Error).message,
    });
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
