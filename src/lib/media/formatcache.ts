// In-memory cache of yt-dlp extraction results, keyed by video URL.
//
// Why: clicking a quality download used to re-run the full extraction
// (up to ~85s of retries). With this cache the listing response stores its
// extraction and the /api/download/mp4 route reuses it instantly, so the
// browser download starts within seconds.
import type { YtInfo } from "./ytdlp";

interface CacheEntry {
  info: YtInfo;
  fetchedAt: number;
}

const TTL_MS = 3 * 60 * 60 * 1000; // YouTube stream URLs live ~6h; be safe
const MAX_ENTRIES = 300;

const cache = new Map<string, CacheEntry>();

function prune(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.fetchedAt > TTL_MS) cache.delete(k);
  }
  if (cache.size > MAX_ENTRIES) {
    // drop oldest entries beyond the cap
    const keys = [...cache.keys()].slice(0, cache.size - MAX_ENTRIES);
    for (const k of keys) cache.delete(k);
  }
}

export function cacheInfo(url: string, info: YtInfo): void {
  if (!url || !info) return;
  cache.set(url, { info, fetchedAt: Date.now() });
  prune();
}

export function getCachedInfo(url: string): YtInfo | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > TTL_MS) {
    cache.delete(url);
    return null;
  }
  // touch: keep freshly-used entries alive
  hit.fetchedAt = Date.now();
  return hit.info;
}

export function findFormat(url: string, formatId: string | null): { url: string } | null {
  if (!formatId) return null;
  const info = getCachedInfo(url);
  if (!info) return null;
  const all = [...(info.combined || []), ...(info.video_only || []), ...(info.audio_only || [])];
  const hitFmt = all.find((f) => f.format_id === formatId && f.url);
  return hitFmt ? { url: hitFmt.url as string } : null;
}
