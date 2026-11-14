// GET /api/debug/net — network egress diagnostics for the deploy host.
//   ?udp=1   UDP DNS query to 1.1.1.1:53 (Cloudflare WARP tunnels need UDP)
//   &tcp=1   TCP connect to engage.cloudflareclient.com:2408
//   &host=<h>&port=<p>  custom TCP probe
// Read-only diagnostics — reports success/latency only.
import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function udpDnsProbe(timeoutMs = 8000): Promise<{ ok: boolean; ms: number; detail: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = dgram.createSocket("udp4");
    // A minimal DNS query for cloudflare.com A record
    const q = Buffer.from([
      0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x0a, 0x63, 0x6c, 0x6f, 0x75, 0x64, 0x66, 0x6c, 0x61, 0x72, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00,
      0x00, 0x01, 0x00, 0x01,
    ]);
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - t0, detail });
    };
    const timer = setTimeout(() => finish(false, "udp timeout (egress may be blocked)"), timeoutMs);
    sock.on("message", () => {
      clearTimeout(timer);
      finish(true, "udp reply received");
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      finish(false, `udp error: ${e.message}`);
    });
    sock.send(q, 53, "1.1.1.1", (err) => {
      if (err) {
        clearTimeout(timer);
        finish(false, `udp send failed: ${err.message}`);
      }
    });
  });
}

function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; detail: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - t0, detail });
    };
    const timer = setTimeout(() => finish(false, "tcp connect timeout"), timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      finish(true, "tcp connected");
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      finish(false, `tcp error: ${e.message}`);
    });
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const results: Record<string, unknown> = {};

  if (sp.get("warp") === "1") {
    // Trace through the local wireproxy tunnel: warp=on proves the tunnel
    // is up and carrying traffic; ip= shows the WARP egress address.
    // (Node fetch cannot dial socks5 — spawn curl like the pool probes do.)
    const t0 = Date.now();
    results.warp_tunnel = await new Promise<Record<string, unknown>>((resolve) => {
      try {
        const p = spawn(
          "curl",
          ["-sS", "-m", "12", "-x", "socks5://127.0.0.1:40000", "https://www.cloudflare.com/cdn-cgi/trace"],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 16_000 }
        );
        let out = "";
        p.stdout!.on("data", (d) => (out += d.toString()));
        p.on("error", (e) => resolve({ ok: false, error: e.message }));
        p.on("close", () => {
          const pick = (k: string) => out.split("\n").find((l) => l.startsWith(k + "="))?.trim();
          resolve({
            ok: pick("warp") === "warp=on",
            ms: Date.now() - t0,
            warp: pick("warp") || null,
            ip: pick("ip") || null,
            loc: pick("loc") || null,
          });
        });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  }

  if (sp.get("udp") === "1") results.udp_dns_1_1_1_1 = await udpDnsProbe();
  const tcpHost = sp.get("host");
  if (tcpHost) {
    const port = Number(sp.get("port") || "443");
    results[`tcp_${tcpHost}:${port}`] = await tcpProbe(tcpHost, port);
  } else if (sp.get("tcp") === "1") {
    results.tcp_warp_2408 = await tcpProbe("engage.cloudflareclient.com", 2408);
  }

  if (!Object.keys(results).length) {
    results.hint = "add ?udp=1 and/or &tcp=1 (or &host=..&port=..)";
  }
  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
