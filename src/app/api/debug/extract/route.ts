// GET /api/debug/extract — production extraction diagnostics.
//
// Why: the FC runtime has no readable stdout logs. This route lets the
// developer inspect WHY YouTube extraction fails on the published server:
//   ?url=<youtube-url>          run ONE live extraction attempt (default URL)
//   &cookie=<basename|first>    which cookie file to use (default: first)
//   &client=<name|none>         player client override (default: none)
//   &log=1                      tail the extraction debug log instead
//
// Read-only diagnostics — never exposes cookie contents, only timings,
// errors and which JS runtimes exist on the server.
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { resolvePython, readExtractDebug, ipChallengedRecently } from "@/lib/media/ytdlp";
import { cliBaseArgs, proxyPoolStatus, useCliEngine, writableCookiePath, ytDlpCliPath } from "@/lib/media/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cookieDir(): string {
  return path.join(process.cwd(), "python", "cookies");
}

function listCookies(): string[] {
  try {
    return fs
      .readdirSync(cookieDir())
      .filter((n) => n.toLowerCase().endsWith(".txt"))
      .sort();
  } catch {
    return [];
  }
}

function runOne(args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Record<string, unknown>) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const script = path.join(process.cwd(), "python", "extract.py");
      const proc = spawn(resolvePython(), [script, JSON.stringify(args)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH || "/usr/bin:/bin" },
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", () => {});
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `killed after ${timeoutMs}ms` });
      }, timeoutMs);
      proc.on("error", (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `spawn failed: ${e.message}` });
      });
      proc.on("close", () => {
        clearTimeout(timer);
        const text = out.trim();
        const i = text.indexOf("{");
        if (i < 0) return finish({ ok: false, error: "no JSON output", raw: text.slice(0, 200) });
        try {
          finish(JSON.parse(text.slice(i)));
        } catch {
          finish({ ok: false, error: "bad JSON", raw: text.slice(0, 200) });
        }
      });
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  if (sp.get("log") === "1") {
    return new Response(JSON.stringify({ log: readExtractDebug() }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = sp.get("url") || "https://youtu.be/KGn-erOG-Bs";
  const cookies = listCookies();
  const which = sp.get("cookie") || cookies[0] || "";
  const cookiePath = which && which !== "none" ? path.join(cookieDir(), which) : null;
  const clientParam = sp.get("client");
  const client = !clientParam || clientParam === "none" ? null : clientParam;

  const envInfo = {
    engine: useCliEngine() ? "cli" : "python",
    python: resolvePython(),
    cwd: process.cwd(),
    cookies: cookies.map((c) => {
      try {
        return `${c} (${fs.statSync(path.join(cookieDir(), c)).size}B)`;
      } catch {
        return c;
      }
    }),
    tmp_writable: (() => {
      try {
        const p = path.join(os.tmpdir(), ".dl_probe");
        fs.writeFileSync(p, "x");
        fs.unlinkSync(p);
        return true;
      } catch {
        return false;
      }
    })(),
    node_version: process.version,
    proxy_pool: proxyPoolStatus(),
  };

  // Vercel has no python3 — run the standalone yt-dlp binary instead of
  // extract.py and return a COMPACT summary (the -J payload is huge).
  // During an active server-IP challenge, do NOT spawn another attempt —
  // every debug visit otherwise hammers the player API and extends the flag.
  const attempt = ipChallengedRecently()
    ? ({ ok: false, error: "skipped: server-IP challenge cooldown active (waiting it out)" } as Record<string, unknown>)
    : useCliEngine()
    ? await runCliOne(url, cookiePath, client, 40_000)
    : await runOne({ mode: "info", url, cookiefile: cookiePath, client }, 40_000);

  return new Response(
    JSON.stringify({ env: envInfo, url, cookie: cookiePath ? which : null, client, attempt }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function runCliOne(
  url: string,
  cookiePath: string | null,
  client: string | null,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Record<string, unknown>) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const argv = [
        ytDlpCliPath(),
        ...cliBaseArgs(),
        "--ignore-no-formats-error",
        "--socket-timeout",
        "25",
        "--no-playlist",
        "-J",
      ];
      const ck = writableCookiePath(cookiePath);
      if (ck) argv.push("--cookies", ck);
      if (client) argv.push("--extractor-args", `youtube:player_client=${client}`);
      argv.push(url);
      const proc = spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d.toString()));
      proc.stderr.on("data", (d) => (err += d.toString()));
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `killed after ${timeoutMs}ms` });
      }, timeoutMs);
      proc.on("error", (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `spawn failed: ${e.message}` });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        const i = out.indexOf("{");
        if (code !== 0 && i < 0) {
          const errLine = err.split("\n").filter((l) => l.startsWith("ERROR:")).pop();
          return finish({ ok: false, error: (errLine || err || `exit ${code}`).slice(0, 300) });
        }
        try {
          const info = JSON.parse(out.slice(i));
          finish({
            ok: true,
            title: info.title ?? null,
            extractor: info.extractor_key ?? null,
            formats: (info.formats || []).length,
            duration: info.duration ?? null,
          });
        } catch {
          finish({ ok: false, error: "bad JSON output", raw: out.slice(0, 200) });
        }
      });
    } catch (e) {
      finish({ ok: false, error: (e as Error).message });
    }
  });
}
