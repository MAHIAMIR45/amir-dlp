#!/usr/bin/env python3
"""
yt-dlp bridge for the Next.js Media Downloader.

Called by the Node API routes as:
    python3 extract.py '<json-args>'

Args JSON:
    {"mode": "search", "q": "...", "limit": 12}
    {"mode": "info",   "url": "https://...", "cookiefile": "/path/or/null", "client": "tv"|null}

Output: single JSON object on stdout.

Modes:
  search -> flat YouTube search (fast, works on datacenter IPs)
  info   -> full extraction with format categorisation
            (combined / video_only / audio_only entries)

This is a port of the relevant parts of the original Flask app.py:
  - build_format_entry / parse_formats / format_duration / format_filesize
  - yt-dlp player-client + cookie fallbacks happen in Node (route layer),
    each invocation of this script performs exactly ONE attempt.
"""

import json
import os
import shutil
import sys
import threading
import time


def _ensure_yt_dlp():
    """Make `import yt_dlp` work on ANY runtime.

    Order of preference:
      1. interpreter's own site-packages / PYTHONPATH — the z.ai publish
         pipeline installs requirements.txt (yt-dlp[default]) into the
         deploy artifact, so production normally succeeds here.
      2. vendored copy in python/_vendor/cp<XY> — full yt-dlp + deps
         shipped inside the project as a fallback (pip state outside the
         project does not survive publishing).
    """
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


class WarningCollector:
    """Collect yt-dlp warnings/errors so we can report WHY extraction
    produced no formats (bot check, 429 rate limit, etc.) instead of a
    generic "no formats" message."""

    def __init__(self):
        self.messages = []

    def debug(self, msg):
        pass

    def warning(self, msg):
        self.messages.append(msg)

    def error(self, msg):
        self.messages.append(msg)


def format_duration(seconds):
    if not seconds:
        return "N/A"
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_filesize(size):
    if not size:
        return None
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    elif size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    else:
        return f"{size / (1024 * 1024 * 1024):.2f} GB"


def build_format_entry(fmt):
    vcodec = fmt.get("vcodec") or "none"
    acodec = fmt.get("acodec") or "none"
    has_video = vcodec not in (None, "none")
    has_audio = acodec not in (None, "none")
    height = fmt.get("height")
    width = fmt.get("width")
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    # Portrait videos (Shorts/reels, e.g. 720x1280): YouTube names the quality
    # by the SHORT side ("720p"), not the raw pixel height ("1280p"). Some
    # player clients even report portrait dims swapped, so always use min().
    is_portrait = bool(width and height and width != height)
    eff_height = min(width, height) if is_portrait else height
    return {
        "format_id": fmt.get("format_id"),
        "ext": fmt.get("ext"),
        "resolution": fmt.get("resolution")
        or (f"{width}x{height}" if width and height else "audio only"),
        "height": eff_height,
        "width": width,
        "fps": fmt.get("fps"),
        "vcodec": vcodec,
        "acodec": acodec,
        "abr": fmt.get("abr") or 0,
        "vbr": fmt.get("vbr"),
        "tbr": fmt.get("tbr"),
        "filesize": size,
        "filesize_human": format_filesize(size),
        "format_note": (fmt.get("format_note") or "") + (" · portrait" if is_portrait else ""),
        "has_video": has_video,
        "has_audio": has_audio,
        "url": fmt.get("url"),
    }


def parse_formats(info):
    combined, video_only, audio_only = [], [], []
    seen = set()
    for fmt in info.get("formats", []) or []:
        if not fmt.get("url"):
            continue
        fid = fmt.get("format_id")
        if fid in seen:
            continue
        seen.add(fid)
        entry = build_format_entry(fmt)
        if entry["has_video"] and entry["has_audio"]:
            combined.append(entry)
        elif entry["has_video"]:
            video_only.append(entry)
        elif entry["has_audio"]:
            audio_only.append(entry)

    combined.sort(key=lambda x: x.get("height") or 0, reverse=True)
    video_only.sort(key=lambda x: x.get("height") or 0, reverse=True)
    audio_only.sort(key=lambda x: x.get("abr") or 0, reverse=True)
    return combined, video_only, audio_only


def run_search(q, limit):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": limit,
        "socket_timeout": 20,
    }
    result = {}

    def _run():
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                result["info"] = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
        except Exception as e:
            result["error"] = e

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=30)
    if t.is_alive():
        return {"ok": False, "error": "Search timed out after 30s"}
    if "error" in result:
        raise result["error"]

    videos = []
    for entry in (result.get("info") or {}).get("entries", []) or []:
        if not entry:
            continue
        vid_id = entry.get("id", "")
        thumbnails = entry.get("thumbnails") or []
        thumb = (
            thumbnails[-1].get("url")
            if thumbnails
            else f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"
        )
        videos.append(
            {
                "id": vid_id,
                "title": entry.get("title", ""),
                "thumbnail": thumb,
                "duration": format_duration(entry.get("duration")),
                "channel": entry.get("channel") or entry.get("uploader") or "",
                "views": entry.get("view_count"),
                "url": entry.get("url") or f"https://www.youtube.com/watch?v={vid_id}",
            }
        )
    return {"ok": True, "results": videos}


def _detect_js_runtimes():
    """Which external JS runtimes exist on THIS server (diagnostics)."""
    return {name: bool(shutil.which(name)) for name in ("node", "bun", "deno", "quickjs")}


def _run_info_inner(url, cookiefile, client, logger):
    opts = {
        "quiet": True,
        "no_warnings": False,
        "socket_timeout": 25,
        # Skip yt-dlp's format selection entirely: we only need the raw
        # format list (the selector can fail on exotic codec combinations).
        "skip_unavailable_formats": True,
        "ignore_no_formats_error": True,
        # yt-dlp >= 2025.05 needs a JavaScript runtime for YouTube's
        # nsig challenge; without one "some formats may be missing".
        # Node exists in the dev sandbox; the published FC runtime only
        # ships bun — enable both, yt-dlp picks whichever it finds.
        "js_runtimes": {"node": {}, "bun": {}},
        "logger": logger,
    }
    if cookiefile:
        opts["cookiefile"] = cookiefile
    # Walk modes from the Node layer:
    #   "full"     = default extraction (no overrides)
    #   "fullskip" = skip the watch page, keep the player configs (the
    #                request shape that returns FULL format lists)
    #   other      = explicit player client override
    ea = {}
    if client == "fullskip":
        ea["player_skip"] = ["webpage"]
    elif client and client not in ("full",):
        ea["player_client"] = [client]
    if ea:
        opts["extractor_args"] = {"youtube": ea}

    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except Exception as e:
            # ignore_no_formats_error may still raise on hard blocks
            msg = str(e)
            if "Requested format is not available" in msg or "no formats" in msg.lower():
                info = None
            else:
                return {"ok": False, "error": msg[:400]}

    if info is None:
        return {"ok": False, "error": "No formats found for this video"}

    combined, video_only, audio_only = parse_formats(info)
    if not (combined or video_only or audio_only):
        # Report the REAL reason (bot check / 429) when we can see it
        joined = " ".join(logger.messages)
        for pat, label in [
            (r"HTTP Error 429|Too Many Requests", "YouTube is rate-limiting this server (HTTP 429) — please wait about a minute and try again"),
            (r"[Ss]ign in to confirm|not a bot", "YouTube is asking to verify this session (bot check) — all cookies are being challenged right now, please try again in a few minutes"),
            (r"No supported JavaScript runtime", "yt-dlp has no JavaScript runtime available"),
        ]:
            if pat in joined:
                return {"ok": False, "error": label}
        return {"ok": False, "error": "No downloadable formats (YouTube may be blocking this server)"}

    return {
        "ok": True,
        "title": info.get("title"),
        "thumbnail": info.get("thumbnail"),
        "duration": format_duration(info.get("duration")),
        "duration_sec": info.get("duration"),
        "channel": info.get("uploader") or info.get("channel") or "",
        "description": (info.get("description") or "")[:300],
        "combined": combined,
        "video_only": video_only,
        "audio_only": audio_only,
    }


# Hard internal cap for ONE extraction attempt. The Node layer also kills
# this process (25s), but on some runtimes SIGKILL arrives late — the
# script must finish ITSELF so every attempt stays truly bounded and the
# request always returns well before the ~180s gateway timeout.
INFO_WATCHDOG_S = 22


def run_info(url, cookiefile, client):
    logger = WarningCollector()
    started = time.time()
    box = {}

    def _work():
        try:
            box["out"] = _run_info_inner(url, cookiefile, client, logger)
        except Exception as e:  # pragma: no cover
            box["out"] = {"ok": False, "error": str(e)[:400]}

    t = threading.Thread(target=_work, daemon=True)
    t.start()
    t.join(INFO_WATCHDOG_S)
    took = round(time.time() - started, 1)
    if t.is_alive():
        return {
            "ok": False,
            "error": f"extraction timed out after {INFO_WATCHDOG_S}s on this server",
            "warn": logger.messages[:6],
            "js": _detect_js_runtimes(),
            "took": took,
        }
    out = box.get("out") or {"ok": False, "error": "extraction produced no result"}
    out["took"] = took
    out["js"] = _detect_js_runtimes()
    if not out.get("ok"):
        out["warn"] = logger.messages[:6]
    return out


def main():
    try:
        args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad args: {e}"}))
        return

    mode = args.get("mode", "search")
    try:
        if mode == "search":
            out = run_search(args.get("q", ""), int(args.get("limit", 12)))
        elif mode == "info":
            out = run_info(
                args.get("url", ""),
                args.get("cookiefile"),
                args.get("client"),
            )
        else:
            out = {"ok": False, "error": f"unknown mode {mode}"}
    except Exception as e:
        out = {"ok": False, "error": str(e)[:400]}

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
