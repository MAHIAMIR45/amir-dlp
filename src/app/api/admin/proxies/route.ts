// GET  /api/admin/proxies          — proxy pool status (public: pool holds
//                                    only public proxy addresses, no secrets)
// POST /api/admin/proxies          — refresh the pool: fetch free public
//                                    proxy lists, CONNECT-validate each one
//                                    against YouTube, speed-check survivors
//                                    and persist them to the runtime pool
//                                    (/tmp/ytdl_proxy_pool.txt).
//
// Why: YouTube challenges datacenter IPs (Render free) at the player API.
// The extraction walk routes through these proxies as fallback routes, so
// a fresh pool of working proxies keeps downloads alive while the server's
// own IP is flagged. Refresh is throttled (one every 120s) so it cannot be
// abused as a scanner. The validation core lives in lib/media/engine.ts
// (shared with the automatic background refresh).
import { proxyPoolStatus, refreshProxyPool } from "@/lib/media/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const _g = globalThis as unknown as { __proxyRefreshBusy?: boolean; __proxyRefreshAt?: number };

export async function GET() {
  return new Response(JSON.stringify(proxyPoolStatus(), null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST() {
  if (_g.__proxyRefreshBusy) {
    return new Response(JSON.stringify({ status: "error", error: "refresh already running" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (_g.__proxyRefreshAt && Date.now() - _g.__proxyRefreshAt < 120_000) {
    return new Response(
      JSON.stringify({ status: "error", error: "refresh throttled — try again in a couple of minutes" }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }
  _g.__proxyRefreshBusy = true;
  _g.__proxyRefreshAt = Date.now();

  try {
    const healthy = await refreshProxyPool();
    return new Response(
      JSON.stringify({
        status: "ok",
        healthy,
        pool: proxyPoolStatus(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ status: "error", error: String((e as Error).message || e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  } finally {
    _g.__proxyRefreshBusy = false;
  }
}
