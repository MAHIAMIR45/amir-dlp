#!/usr/bin/env python3
"""
yt-dlp DOWNLOAD bridge for the Next.js Media Downloader.

The listing/extraction side stays in extract.py. This script uses yt-dlp's
own downloader to fetch the media bytes — its chunked Range requests,
retries and fragment concurrency defeat YouTube's throttling that breaks
plain ffmpeg HTTP reads on long ("full song") transfers.

Called by Node (dljobs.ts) as:
    python3 download.py '<json-args>'

Args JSON:
    {"mode": "mp4",  "url": "...", "format": "136+140/...",
     "cookiefile": "/path/or/null", "out_base": "/tmp/ytdl_x",
     "concurrency": 4}
    {"mode": "mp3",  "url": "...", "format": "140/bestaudio/best", ...}

Output: JSON lines on stdout.
    {"type":"progress","pct":42.5,"downloaded":123,"total":456,"speed":789.0}
    ...
    {"ok": true, "path": "/tmp/ytdl_x.mp4", "size": 123456}
    {"ok": false, "error": "..."}

100% yt-dlp + cookies. No third-party download APIs.
"""

import glob
import json
import os
import sys
import threading


def _ensure_yt_dlp():
    """Same bootstrap as extract.py: PYTHONPATH first, vendored fallback."""
    try:
        import yt_dlp  # noqa: F401

        return
    except Exception:
        pass
    vendor = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "_vendor",
        f"cp{sys.version_info.major}{sys.version_info.minor}",
    )
    if os.path.isdir(vendor):
        for name in [m for m in sys.modules if m == "yt_dlp" or m.startswith("yt_dlp.")]:
            del sys.modules[name]
        if vendor not in sys.path:
            sys.path.insert(0, vendor)


_ensure_yt_dlp()

try:
    import yt_dlp
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"yt_dlp import failed: {e}"}))
    sys.exit(0)


class ProgressReporter:
    """Aggregated progress across the video and audio downloads (mp4 mode
    downloads two streams; mp3 mode one). Emits one JSON line per update."""

    def __init__(self, two_streams):
        self.two_streams = two_streams
        self.lock = threading.Lock()
        self.parts = {}  # format_id -> {"pct", "downloaded", "total", "speed"}

    def _emit(self):
        with self.lock:
            if not self.parts:
                return
            if self.two_streams:
                pcts = [v["pct"] for v in self.parts.values()] or [0.0]
                pct = min(100.0, sum(pcts) / max(1, len(pcts)))
            else:
                pct = max(self.parts.values(), key=lambda v: v["pct"])["pct"]
            downloaded = sum(v["downloaded"] for v in self.parts.values())
            total = sum(v["total"] for v in self.parts.values() if v["total"])
            speed = sum(v["speed"] for v in self.parts.values())
            line = json.dumps({
                "type": "progress",
                "pct": round(pct, 1),
                "downloaded": downloaded,
                "total": total or None,
                "speed": round(speed, 0),
            })
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def hook(self, d):
        try:
            status = d.get("status")
            if status not in ("downloading", "finished"):
                return
            fmt = (d.get("info_dict") or {}).get("format_id") or "main"
            downloaded = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            speed = d.get("speed") or 0.0
            pct = 100.0 if status == "finished" else (
                (downloaded / total * 100.0) if total else 0.0
            )
            with self.lock:
                self.parts[fmt] = {
                    "pct": pct,
                    "downloaded": downloaded,
                    "total": total,
                    "speed": speed if status == "downloading" else 0.0,
                }
            self._emit()
        except Exception:
            pass


def find_output(out_base):
    """The exact final extension depends on the source (mp4/webm/m4a...)."""
    hits = sorted(glob.glob(out_base + ".*"))
    hits = [h for h in hits if not h.endswith(".part") and not h.endswith(".ytdl")]
    return hits[0] if hits else None


def run_once(fmt, url, cookiefile, out_base, concurrency, reporter, player_client):
    """One yt-dlp attempt with a specific player client (None = default)."""
    ydl_opts = {
        "format": fmt,
        "outtmpl": out_base + ".%(ext)s",
        "cookiefile": cookiefile,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 15,
        "fragment_retries": 15,
        "concurrent_fragment_downloads": concurrency,
        # 10 MB ranged chunks: every chunk restarts at full speed, which
        # defeats YouTube's throttle that stalls plain single-connection
        # reads partway through long songs.
        "http_chunk_size": 10485760,
        "progress_hooks": [reporter.hook],
        "overwrites": True,
        # Same critical options as extract.py:
        #  • js_runtimes: yt-dlp >= 2025.05 needs a JS runtime for YouTube's
        #    nsig challenge — without it formats exist but none are
        #    downloadable ("Requested format is not available").
        #  • skip_unavailable_formats keeps exotic codec combos from
        #    killing the format selector.
        "skip_unavailable_formats": True,
        "ignore_no_formats_error": True,
        "js_runtimes": {"node": {}},
    }
    if player_client:
        ydl_opts["extractor_args"] = {"youtube": {"player_client": [player_client]}}

    # Do NOT force the merge container: for avc1+aac yt-dlp merges to mp4
    # anyway, and for incompatible (vp9/opus) fallbacks it would fail —
    # those get merged to mkv/webm and re-encoded by the Node job runner.
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


def main():
    args = json.loads(sys.argv[1])
    mode = args.get("mode", "mp4")
    url = args.get("url") or ""
    fmt = args.get("format") or ("bestaudio/best" if mode == "mp3" else "bestvideo+bestaudio/best")
    cookiefile = args.get("cookiefile") or None
    out_base = args.get("out_base") or ("/tmp/ytdl_%d" % os.getpid())
    concurrency = int(args.get("concurrency") or 4)

    if cookiefile and not os.path.exists(cookiefile):
        cookiefile = None

    reporter = ProgressReporter(two_streams="+" in fmt)

    # Player-client rotation mirrors extract.py: a cookie/client combo can
    # soft-block; another client usually still yields playable streams.
    clients = [None, "tv", "web_safari", "android", "mweb", "ios"]

    path = None
    last_error = "yt-dlp download failed"
    for client in clients:
        try:
            reporter.parts.clear()
            run_once(fmt, url, cookiefile, out_base, concurrency, reporter, client)
            path = find_output(out_base)
            if path and os.path.getsize(path) > 0:
                break
            last_error = "yt-dlp produced no output file"
        except yt_dlp.utils.DownloadError as e:
            last_error = str(e)[:500]
            continue
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            continue

    if path and os.path.getsize(path) > 0:
        print(json.dumps({
            "ok": True,
            "path": path,
            "size": os.path.getsize(path),
            "ext": os.path.splitext(path)[1].lstrip("."),
        }))
    else:
        print(json.dumps({"ok": False, "error": last_error}))


if __name__ == "__main__":
    main()
