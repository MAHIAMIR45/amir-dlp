// GET /api/admin/stats — analytics snapshot (port of /admin/api/stats).
import { NextRequest } from "next/server";
import { isAdminRequest, unauthorized } from "@/lib/adminAuth";
import { getStats } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  return new Response(JSON.stringify(getStats()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
