// GET /api/download/mp3 — full-song MP3 download.
//  • z.ai (long-running host): background job + live progress page
//  • Vercel (serverless): everything completes inside THIS request and the
//    finished MP3 streams back directly
// Engine: yt-dlp + cookies, ffmpeg conversion locally.
import { NextRequest } from "next/server";
import { runDownloadSync, startDlJob } from "@/lib/media/dljobs";
import { progressPageHtml, jsonError, htmlErrorPage, serveTempFile } from "@/lib/media/streaming";
import { useCliEngine, isServerlessHost } from "@/lib/media/engine";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const url = (sp.get("url") || "").trim();
  const fmt = sp.get("fmt") || sp.get("format_id") || null;
  const abr = sp.get("quality") || sp.get("abr") || "128";
  const title = sp.get("title") || "song";
  const dur = sp.get("dur") ? Number(sp.get("dur")) : null;

  // The browser navigates directly to this URL — show a friendly HTML page
  // on failures instead of raw JSON. API clients keep getting JSON.
  const wantsHtml = (req.headers.get("accept") || "").includes("text/html");
  const fail = (msg: string, status = 502) => (wantsHtml ? htmlErrorPage(msg, status) : jsonError(msg, status));

  if (!url || !/youtu\.be|youtube\.com/i.test(url)) {
    trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 400 });
    return fail("A valid YouTube url is required", 400);
  }

  const safeName =
    `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "song"}` +
    ` ${abr}kbps.mp3`;

  const jobOpts = {
    mode: "mp3" as const,
    url,
    audioFormatId: fmt,
    filename: safeName,
    durationSec: dur && Number.isFinite(dur) ? dur : null,
  };

  try {
    if (useCliEngine() && isServerlessHost()) {
      // Serverless mode — one request, one file.
      const r = await runDownloadSync(jobOpts);
      if (!r.ok || !r.filePath || !r.size) {
        trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 502 });
        return fail(r.error || "Download failed — please try again.");
      }
      trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 200 });
      return serveTempFile(r.filePath, r.size, r.contentType || "audio/mpeg", safeName);
    }

    // Long-running host — background job with a live progress page.
    const job = startDlJob(jobOpts);
    trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 200 });
    return progressPageHtml(job.id, safeName, "mp3");
  } catch (e) {
    trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 500 });
    return fail(`Download failed: ${(e as Error).message}`, 500);
  }
}
