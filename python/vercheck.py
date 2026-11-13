#!/usr/bin/env python3
"""Print "<yt-dlp version> <python version>" — used by /api/version.

Same bootstrap order as extract.py/download.py: PYTHONPATH/site-packages
first, vendored python/_vendor/cp<XY> fallback. Reports the module the
extraction/download bridges will actually run.
"""
import os
import sys


def _ensure_yt_dlp():
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

    print(f"{yt_dlp.version.__version__} {sys.version.split()[0]}")
except Exception as e:  # pragma: no cover
    print(f"unavailable ({e})")
