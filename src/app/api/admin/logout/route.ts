// POST /api/admin/logout — clear the admin session cookie.
import { NextRequest } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const store = await cookies();
  store.delete("amir_admin_session");
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
