// Admin session token helpers (HMAC of the secret + date, httpOnly cookie).
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.ADMIN_SECRET_KEY || "amir-admin-panel-secret-2026";

export function makeSessionToken(): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHmac("sha256", SECRET).update(`admin|${day}`).digest("hex");
}

export function verifySessionToken(token: string): boolean {
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(makeSessionToken());
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isAdminRequest(req: Request): boolean {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)amir_admin_session=([^;]+)/);
  if (!match) return false;
  return verifySessionToken(match[1]);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
