// GET /api/download/mp4 — WhatsApp-safe MP4 download.
//  • z.ai (long-running host): background job + live progress page
//  • Vercel (serverless): the whole download finishes inside THIS request
//    and the file streams back directly (no cross-request job state exists)
// Engine: yt-dlp + cookies in both modes.
import { NextRequest } from "next/server";
import { runDownloadSync, startDlJob } from "@/lib/media/dljobs";
import { progressPageHtml, jsonError, htmlErrorPage, serveTempFile } from "@/lib/media/streaming";
import { useCliEngine } from "@/lib/media/engine";
import { trackRequest } from "@/lib/tracker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const url = (sp.get("url") || "").trim();
  const vid = sp.get("vid") || null;
  const aid = sp.get("aid") || null;
  const height = sp.get("height") ? Number(sp.get("height")) : null;
  const acodec = (sp.get("ac") || "").toLowerCase();
  const title = sp.get("title") || "video";
  const dur = sp.get("dur") ? Number(sp.get("dur")) : null;

  // The browser navigates directly to this URL — show a friendly HTML page
  // on failures instead of raw JSON. API clients (curl/wget, no Accept:
  // text/html) keep getting JSON.
  const wantsHtml = (req.headers.get("accept") || "").includes("text/html");
  const fail = (msg: string, status = 502) => (wantsHtml ? htmlErrorPage(msg, status) : jsonError(msg, status));

  if (!url || !/youtu\.be|youtube\.com/i.test(url)) {
    trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 400 });
    return fail("A valid YouTube url is required", 400);
  }

  // Copy-safe when the selected video format is avc1 and audio mp4a — the
  // finalisation then remuxes losslessly (fast); otherwise re-encodes.
  const canCopy = vid ? !acodec || acodec.startsWith("mp4a") : false;

  const safeName =
    `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video"}` +
    `${height ? ` ${height}p` : ""}.mp4`;

  const jobOpts = {
    mode: "mp4" as const,
    url,
    videoFormatId: vid,
    audioFormatId: aid,
    height,
    canCopy,
    filename: safeName,
    durationSec: dur && Number.isFinite(dur) ? dur : null,
  };

  try {
    if (useCliEngine()) {
      // Serverless mode — one request, one file.
      const r = await runDownloadSync(jobOpts);
      if (!r.ok || !r.filePath || !r.size) {
        trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 502 });
        return fail(r.error || "Download failed — please try again.");
      }
      trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 200 });
      return serveTempFile(r.filePath, r.size, r.contentType || "video/mp4", safeName);
    }

    // Long-running host — background job with a live progress page.
    const job = startDlJob(jobOpts);
    trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 200 });
    return progressPageHtml(job.id, safeName, "mp4");
  } catch (e) {
    trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 500 });
    return fail(`Download failed: ${(e as Error).message}`, 500);
  }
}
