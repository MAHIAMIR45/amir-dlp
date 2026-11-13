// GET /api/download/mp3 — start a full-song MP3 download job and show the
// live progress page. Engine: yt-dlp + cookies, ffmpeg conversion locally.
import { NextRequest } from "next/server";
import { startDlJob } from "@/lib/media/dljobs";
import { progressPageHtml, jsonError } from "@/lib/media/streaming";
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

  if (!url || !/youtu\.be|youtube\.com|sample|demo/i.test(url)) {
    trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 400 });
    return jsonError("A valid YouTube url is required");
  }

  const safeName =
    `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "song"}` +
    ` ${abr}kbps.mp3`;

  const job = startDlJob({
    mode: "mp3",
    url,
    audioFormatId: fmt,
    filename: safeName,
    durationSec: dur && Number.isFinite(dur) ? dur : null,
  });
  trackRequest({ headers: req.headers, path: "/api/download/mp3", method: "GET", url, platform: "youtube", status: 200 });
  return progressPageHtml(job.id, safeName, "mp3");
}
