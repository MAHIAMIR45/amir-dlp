// GET /api/admin/health — API health status (port of /admin/api/health).
import { NextRequest } from "next/server";
import { isAdminRequest, unauthorized } from "@/lib/adminAuth";
import { getHealth, runHealthCheck } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  void runHealthCheck(); // refresh in background
  return new Response(JSON.stringify(getHealth()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
