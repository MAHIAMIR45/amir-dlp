// GET  /api/admin/proxies          — proxy pool status (public: pool holds
//                                    only public proxy addresses, no secrets)
// POST /api/admin/proxies          — refresh the pool: fetch free public
//                                    proxy lists, CONNECT-validate each one
//                                    against YouTube, keep the survivors in
//                                    the runtime pool (/tmp/ytdl_proxy_pool.txt).
//
// Why: YouTube challenges datacenter IPs (Render free) at the player API.
// The extraction walk routes through these proxies as fallback routes, so
// a fresh pool of working proxies keeps downloads alive while the server's
// own IP is flagged. Refresh is throttled (one every 120s) so it cannot be
// abused as a scanner.
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { proxyPoolStatus, runtimeProxyPoolPath } from "@/lib/media/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LISTS = [
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
];

const _g = globalThis as unknown as { __proxyRefreshBusy?: boolean; __proxyRefreshAt?: number };

function fetchText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    fetch(url, { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((txt) => {
        clearTimeout(t);
        resolve(txt);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

/** CONNECT-check one proxy against YouTube's generate_204. */
function checkProxy(proxy: string, timeoutSec: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(
        "curl",
        ["-x", proxy, "--max-time", String(timeoutSec), "-o", "/dev/null", "-sS", "-w", "%{http_code}", "https://www.youtube.com/generate_204"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: (timeoutSec + 4) * 1000 }
      );
      let out = "";
      proc.stdout!.on("data", (d) => (out += d.toString()));
      proc.on("error", () => finish(null));
      proc.on("close", () => finish(out.trim() === "204" ? proxy : null));
    } catch {
      finish(null);
    }
  });
}

/**
 * Speed-check a connected proxy: pull a ~100KB YouTube-CDN image through it
 * and report bytes/sec. Media downloads through the pool die on slow
 * proxies (they crawl at <100KB/s and hit the attempt cap), so only keep
 * proxies whose CDN throughput is usable.
 */
function speedProxy(proxy: string): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: number) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn(
        "curl",
        ["-x", proxy, "--max-time", "15", "-o", "/dev/null", "-sS", "-w", "%{speed_download}", "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 19_000 }
      );
      let out = "";
      proc.stdout!.on("data", (d) => (out += d.toString()));
      proc.on("error", () => finish(0));
      proc.on("close", () => {
        const v = parseFloat(out.trim());
        finish(Number.isFinite(v) ? v : 0);
      });
    } catch {
      finish(0);
    }
  });
}

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
    // 1. Collect candidates from the public lists (shuffle, cap 200)
    const raw = new Set<string>();
    for (const u of DEFAULT_LISTS) {
      try {
        const txt = await fetchText(u, 20_000);
        txt.split("\n").forEach((l) => {
          const s = l.trim();
          if (s && !s.startsWith("#") && /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s)) raw.add(s);
        });
      } catch {
        /* one list failing is fine */
      }
    }
    const candidates = [...raw].sort(() => Math.random() - 0.5).slice(0, 200);

    // 2. Validate with bounded concurrency (curl processes, ~5MB each)
    const survivors: string[] = [];
    const CONC = 12;
    let idx = 0;
    let done = 0;
    const worker = async () => {
      while (idx < candidates.length && survivors.length < 25) {
        const c = candidates[idx++];
        const ok = await checkProxy(c, 10);
        done++;
        if (ok) survivors.push(ok);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));

    // 3. Persist to the runtime pool (app dir may be read-only)
    const poolFile = runtimeProxyPoolPath();
    let where = poolFile;
    try {
      fs.writeFileSync(poolFile, survivors.join("\n") + (survivors.length ? "\n" : ""));
    } catch {
      where = path.join(process.cwd(), "python", "proxies.txt");
      try {
        fs.writeFileSync(where, survivors.join("\n") + (survivors.length ? "\n" : ""));
        where = "python/proxies.txt (app dir)";
      } catch {
        where = "(nowhere — fs read-only)";
      }
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        fetched: raw.size,
        checked: done,
        healthy: survivors.length,
        written_to: where,
        pool: proxyPoolStatus(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } finally {
    _g.__proxyRefreshBusy = false;
  }
}
