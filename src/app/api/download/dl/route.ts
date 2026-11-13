// GET /api/download/dl?t= — proxy a registered media URL by short token.
// Tokens are created server-side only (no SSRF surface); Range passes
// through so large files can resume.
import { NextRequest } from "next/server";
import { resolveMediaEntry } from "@/lib/media/tokenstore";
import { jsonError, proxyMedia } from "@/lib/media/streaming";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("t") || "").trim();
  const entry = token ? resolveMediaEntry(token) : null;
  if (!entry) {
    return jsonError("This download link has expired. Please fetch the formats again.", 404);
  }
  const isAudio = !entry.fid;
  const filename = isAudio ? `audio-${token}.m4a` : `video-${entry.fid || token}.mp4`;
  return proxyMedia(entry.u, filename, isAudio ? "audio/mp4" : "video/mp4", {
    referer: "https://www.youtube.com/",
    rangeHeader: req.headers.get("range"),
  });
}
