// GET /api/download/mp4 — start a WhatsApp-safe MP4 download job and show
// the live progress page (polls /api/download/job, serves /api/download/file).
// Engine: yt-dlp + cookies (python bridge on z.ai, standalone binary on Vercel).
import { NextRequest } from "next/server";
import { startDlJob } from "@/lib/media/dljobs";
import { progressPageHtml, jsonError } from "@/lib/media/streaming";
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

  if (!url || !/youtu\.be|youtube\.com/i.test(url)) {
    trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 400 });
    return jsonError("A valid YouTube url is required");
  }

  // Copy-safe when the selected video format is avc1 and audio mp4a — the
  // finalisation then remuxes losslessly (fast); otherwise re-encodes.
  const canCopy = vid ? !acodec || acodec.startsWith("mp4a") : false;

  const safeName =
    `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video"}` +
    `${height ? ` ${height}p` : ""}.mp4`;

  const job = startDlJob({
    mode: "mp4",
    url,
    videoFormatId: vid,
    audioFormatId: aid,
    height,
    canCopy,
    filename: safeName,
    durationSec: dur && Number.isFinite(dur) ? dur : null,
  });
  trackRequest({ headers: req.headers, path: "/api/download/mp4", method: "GET", url, platform: "youtube", status: 200 });
  return progressPageHtml(job.id, safeName, "mp4");
}
