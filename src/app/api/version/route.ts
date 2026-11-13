// GET /api/version — diagnostic info (port of /version in app.py).
import { NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { runHealthCheck } from "@/lib/tracker";
import { resolvePython } from "@/lib/media/ytdlp";
import { useCliEngine, ytDlpCliPath } from "@/lib/media/engine";
const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let cachedVersion: Record<string, unknown> | null = null;

export async function GET(req: NextRequest) {
  if (!cachedVersion) {
    let ytdlpVer = "unknown";
    let pyVer = "unknown";
    const engine = useCliEngine() ? "cli" : "python";
    try {
      if (useCliEngine()) {
        // Vercel: standalone yt-dlp binary — no python interpreter involved.
        const { stdout } = await execFileAsync(ytDlpCliPath(), ["--version"], { timeout: 15000 });
        ytdlpVer = stdout.trim().split("\n")[0] || "unknown";
        pyVer = "bundled";
      } else {
        // vercheck.py self-loads the vendored yt-dlp — same module the
        // extraction/download bridges run, on ANY python3 interpreter.
        const { stdout } = await execFileAsync(
          resolvePython(),
          [path.join(process.cwd(), "python", "vercheck.py")],
          { timeout: 15000 }
        );
        const line = stdout.trim().split("\n").pop() || "";
        if (!line.startsWith("unavailable")) {
          const parts = line.split(/\s+/);
          ytdlpVer = parts[0] || "unknown";
          pyVer = parts[1] || "unknown";
        }
      }
    } catch {
      /* ignore */
    }
    let versionRaw = "unknown";
    try {
      const fs = await import("node:fs");
      const v = fs.readFileSync(`${process.cwd()}/Amir-yt/VERSION`, "utf-8").trim();
      if (v) versionRaw = v;
    } catch {
      /* ignore */
    }
    // Cache only successful probes so a cold-start failure retries later.
    if (ytdlpVer !== "unknown") {
      cachedVersion = {
        version: versionRaw,
        yt_dlp: ytdlpVer,
        python: pyVer,
        framework: "nextjs-16",
        engine,
      };
    }
  }
  void runHealthCheck();
  return new Response(
    JSON.stringify(cachedVersion || { version: "unknown", yt_dlp: "unknown", python: "unknown", framework: "nextjs-16", engine: useCliEngine() ? "cli" : "python" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
