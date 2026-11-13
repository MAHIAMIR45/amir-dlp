// Engine selection layer — the yt-dlp engine can run in two modes:
//
//  1. "python"  — spawn python3 + python/extract.py / download.py (the
//     original setup; used on z.ai where a real python3 + venv exists).
//  2. "cli"     — spawn the yt-dlp standalone binary (bin/yt-dlp, a
//     self-contained yt-dlp build that needs NO python interpreter).
//     Used on Vercel where no python3 exists in the Node runtime.
//
// BOTH modes are 100% yt-dlp + cookies — no third-party download APIs.
// Selection: VERCEL=1 → cli · YTDL_ENGINE=cli|python forces a mode ·
// otherwise (z.ai / local dev) → python.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function useCliEngine(): boolean {
  const forced = (process.env.YTDL_ENGINE || "").toLowerCase();
  if (forced === "cli") return true;
  if (forced === "python") return false;
  return process.env.VERCEL === "1";
}

function ensureExec(p: string): void {
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      /* read-only fs — nothing to do */
    }
  }
}

/** Absolute path of the bundled yt-dlp standalone binary. */
export function ytDlpCliPath(): string {
  const p = path.join(process.cwd(), "bin", "yt-dlp");
  ensureExec(p);
  return p;
}

/**
 * ffmpeg binary resolution order:
 *   1. $FFMPEG_PATH (explicit override)
 *   2. ffmpeg-static npm package (bundled with the repo on Vercel)
 *   3. system ffmpeg (z.ai / local dev)
 */
export function resolveFfmpegBin(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) {
      ensureExec(p);
      return p;
    }
  } catch {
    /* not installed */
  }
  return "ffmpeg";
}

/** Args that must ALWAYS precede the rest of every CLI invocation. */
export function cliBaseArgs(): string[] {
  // yt-dlp's CLI defaults to the deno JS runtime only; YouTube's nsig
  // challenge needs node (or another runtime) or formats go missing.
  return ["--js-runtimes", "node", "--js-runtimes", "bun"];
}

/**
 * yt-dlp writes cookie updates back to the cookiefile after every
 * extraction. On Vercel the bundle (/var/task) is READ-ONLY, so the
 * cookie must be copied to a writable temp path first — otherwise the
 * run crashes with "Read-only file system".
 */
export function writableCookiePath(cookiefile: string | null | undefined): string | null {
  if (!cookiefile) return null;
  try {
    if (cookiefile.startsWith(os.tmpdir())) return cookiefile;
  } catch {
    /* fall through */
  }
  try {
    const dest = path.join(os.tmpdir(), `ck_${crypto.randomBytes(4).toString("hex")}_${path.basename(cookiefile)}`);
    fs.copyFileSync(cookiefile, dest);
    return dest;
  } catch {
    return cookiefile;
  }
}
