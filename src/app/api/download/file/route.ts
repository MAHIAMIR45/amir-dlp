// GET /api/download/file?id= — serve a completed download job's file with
// Content-Length (the phone's download manager shows a real total).
// The file stays available for retries until the job TTL cleans it up.
import fs from "node:fs";
import { NextRequest } from "next/server";
import { getJob } from "@/lib/media/dljobs";
import { contentDisposition } from "@/lib/media/streaming";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function serveJobFile(filePath: string, size: number, contentType: string, filename: string): Response {
  const nodeStream = fs.createReadStream(filePath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      nodeStream.on("error", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
  const safeName = filename;
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      // RFC 5987: the raw Hindi/Arabic title crashes the ByteString header.
      "Content-Disposition": contentDisposition(safeName),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") || "").trim();
  const job = id ? getJob(id) : null;
  if (!job || job.state !== "done" || !job.filePath) {
    return new Response(
      JSON.stringify({ status: "error", error: job?.error || "Download not ready or expired. Please start again." }),
      {
        status: job ? 410 : 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
  let size = job.size;
  try {
    if (!size) size = fs.statSync(job.filePath).size;
  } catch {
    return new Response(JSON.stringify({ status: "error", error: "Download expired. Please start again." }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }
  return serveJobFile(job.filePath, size, job.contentType, job.filename);
}
