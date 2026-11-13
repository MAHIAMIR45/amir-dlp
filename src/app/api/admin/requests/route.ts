// GET /api/admin/requests?limit=200&platform=... — request log (port of /admin/api/requests).
import { NextRequest } from "next/server";
import { isAdminRequest, unauthorized } from "@/lib/adminAuth";
import { getRequests } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const limit = Math.min(2000, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "200", 10) || 200));
  const platform = req.nextUrl.searchParams.get("platform") || null;
  return new Response(JSON.stringify(getRequests(limit, platform)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
