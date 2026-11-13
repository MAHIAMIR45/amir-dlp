// POST /api/admin/login — admin authentication (port of /admin/login).
// Default credentials: amir / amir (overridable via env).
import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { makeSessionToken } from "@/lib/adminAuth";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";

const ADMIN_USER = process.env.ADMIN_USER || "amir";
const ADMIN_PASS = process.env.ADMIN_PASS || "amir";

export async function POST(req: NextRequest) {
  let username = "";
  let password = "";
  try {
    const body = (await req.json()) as { username?: string; password?: string };
    username = (body.username || "").trim();
    password = body.password || "";
  } catch {
    return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const store = await cookies();
    store.set("amir_admin_session", makeSessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    trackRequest({ headers: req.headers, path: "/api/admin/login", method: "POST", url: null, platform: "admin_page", status: 200 });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  trackRequest({ headers: req.headers, path: "/api/admin/login", method: "POST", url: null, platform: "admin_page", status: 401, error: "invalid credentials" });
  return new Response(JSON.stringify({ success: false, error: "Invalid credentials" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
