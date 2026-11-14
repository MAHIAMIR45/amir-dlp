// GET /api/debug/slow?ms=N — sleeps N milliseconds then responds.
// Diagnostic endpoint: measures the host's proxy request timeout precisely
// (Render cuts long-held requests at some limit — this finds it exactly).
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const ms = Math.min(300_000, Math.max(0, Number(req.nextUrl.searchParams.get("ms") || "0") || 0));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  return new Response(JSON.stringify({ sleptMs: Date.now() - t0 }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
