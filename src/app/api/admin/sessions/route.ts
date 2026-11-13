// GET /api/admin/sessions?limit=100 — visitor profiles (port of /admin/api/sessions).
import { NextRequest } from "next/server";
import { isAdminRequest, unauthorized } from "@/lib/adminAuth";
import { getSessions } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const limit = Math.min(500, Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "100", 10) || 100));
  return new Response(JSON.stringify(getSessions(limit)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
