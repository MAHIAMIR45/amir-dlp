// GET /api/admin/ping — registers the admin's own IP in analytics
// (port of /admin/ping).
import { NextRequest } from "next/server";
import { bumpAdminPage, getClientIp } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  bumpAdminPage();
  return new Response(JSON.stringify({ ok: true, ip: getClientIp(req.headers) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
