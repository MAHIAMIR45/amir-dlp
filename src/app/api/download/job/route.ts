// GET /api/download/job?id= — live status of a download job.
import { NextRequest } from "next/server";
import { getJob } from "@/lib/media/dljobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") || "").trim();
  const job = id ? getJob(id) : null;
  if (!job) {
    return new Response(
      JSON.stringify({
        id,
        state: "error",
        ready: false,
        error: "This download session has expired. Please go back and start again.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response(
    JSON.stringify({
      id: job.id,
      state: job.state,
      ready: job.state === "done",
      pct: job.pct,
      gotBytes: job.gotBytes,
      estBytes: job.estBytes,
      size: job.size,
      speedBps: job.speedBps,
      etaSec: job.etaSec,
      note: job.note,
      error: job.error,
      filename: job.filename,
      contentType: job.contentType,
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
