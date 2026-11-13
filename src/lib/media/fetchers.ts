// TikTok / Pinterest / Facebook API clients — ported from the original Flask app.py.
// YouTube downloads intentionally do NOT use backup APIs: they go through
// yt-dlp with the cookie pool (see lib/media/ytdlp.ts).
import { bytesToHuman, USER_AGENT } from "./urls";

const TIKTOK_API_URL = "https://api.nexray.eu.cc/downloader/tiktok";
const TIKTOK_BACKUP_API_URL = "https://mkzstyleee.vercel.app/download/tiktok";
const TIKTOK_BACKUP_API_URL_V2 = "https://mkzstyleee.vercel.app/download/tiktok-v2";
const TIKTOK_BACKUP_APIKEY = "FREE-XODVNWPL-ERUF";
const TIKTOK_BACKUP_API_URL_2 = "https://jerrycoder.oggyapi.workers.dev/down/tiktok";

const PINTEREST_API_URL = "https://api.nexray.eu.cc/downloader/pinterest";
const PINTEREST_BACKUP_API_URL = "https://mkzstyleee.vercel.app/download/pinterest";
const PINTEREST_BACKUP_APIKEY = "FREE-XODVNWPL-ERUF";
const PINTEREST_BACKUP_API_URL_2 = "https://api.theresav.eu/api/download/pinterest";
const PINTEREST_BACKUP_APIKEY_2 = "QkX9K";

const FACEBOOK_API_URL = "https://api.theresav.eu/api/download/facebook";
const FACEBOOK_APIKEY = "QkX9K";
const FACEBOOK_BACKUP_API_URL = "https://eliteprotech-apis.zone.id/facebook1";
const FACEBOOK_BACKUP_API_URL_2 = "https://jerrycoder.oggyapi.workers.dev/down/fb";

async function fetchJson(apiUrl: string, timeoutMs: number, extraHeaders?: Record<string, string>) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl, {
      signal: ctl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(extraHeaders || {}) },
    });
    const text = await res.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { _nonjson: text.slice(0, 300) };
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return payload;
  } finally {
    clearTimeout(t);
  }
}

// ── TikTok ────────────────────────────────────────────────────────────

export interface TiktokResult extends Record<string, unknown> {
  title?: string;
  cover?: string;
  play?: string;
  hdplay?: string;
  music?: string;
  size_nowm_hd?: number;
  size_nowm?: number;
  hd_size?: number;
  size?: number;
  author?: { name?: string; nickname?: string } | string;
  music_info?: { url?: string; size?: number } | null;
  duration?: string | number;
}

export async function fetchTiktokResult(url: string): Promise<TiktokResult> {
  const quoted = encodeURIComponent(url);
  // Primary: nexray
  try {
    const payload = await fetchJson(`${TIKTOK_API_URL}?url=${quoted}`, 30_000);
    if (payload.status === true && payload.result) {
      return payload.result as TiktokResult;
    }
    console.log(`[TikTok] Primary API error: ${JSON.stringify(payload).slice(0, 200)}`);
  } catch (e) {
    console.log(`[TikTok] Primary API failed: ${(e as Error).message}`);
  }

  // Backup 1 & 2 (mkzstyleee)
  for (const api of [TIKTOK_BACKUP_API_URL, TIKTOK_BACKUP_API_URL_V2]) {
    try {
      const payload = await fetchJson(`${api}?url=${quoted}&apikey=${TIKTOK_BACKUP_APIKEY}`, 60_000);
      if (payload.status === true || payload.success === true) {
        const result = (payload.result || payload.data || payload) as TiktokResult;
        if (typeof result === "object") return result;
      }
    } catch (e) {
      console.log(`[TikTok] Backup ${api} failed: ${(e as Error).message}`);
    }
  }

  // Backup 3 (jerrycoder)
  try {
    const payload = await fetchJson(`${TIKTOK_BACKUP_API_URL_2}?url=${quoted}`, 60_000);
    if (String(payload.status).toLowerCase() === "success" && payload.result) {
      const data = ((payload.result as Record<string, unknown>).data || {}) as Record<string, unknown>;
      const play = String(data.play || "").trim();
      if (play) {
        return {
          id: data.id as string,
          title: (data.title as string) || "TikTok video",
          cover: (data.cover as string) || (data.origin_cover as string) || "",
          duration: Number(data.duration || 0),
          play,
          wmplay: String(data.wmplay || "").trim() || undefined,
          hdplay: String(data.hdplay || "").trim() || undefined,
          music: String(data.music || "").trim() || undefined,
          size: data.size as number,
          hd_size: data.hd_size as number,
          source: "jerrycoder",
        };
      }
    }
  } catch (e) {
    console.log(`[TikTok] Backup 3 failed: ${(e as Error).message}`);
  }

  throw new Error("All TikTok APIs failed (primary and backups)");
}

export function buildTiktokResponse(url: string, result: TiktokResult) {
  const title = result.title || "TikTok video";
  const author = (result.author || {}) as { name?: string; nickname?: string };
  const audio = result.music_info || ({} as { url?: string; size?: number });
  const videoSize = result.size_nowm_hd || result.size_nowm;
  const audioSize = (audio as { size?: number }).size;

  const videoFormat = {
    format_id: "tiktok-nowm-hd",
    ext: "mp4",
    quality: "HD",
    height: null as number | null,
    filesize: videoSize,
    filesize_human: bytesToHuman(Number(videoSize)) || "Unknown",
    format_note: "No watermark · Video + Audio",
    has_audio: true,
    download_url: `/api/download/tiktok/file?url=${encodeURIComponent(url)}&type=video`,
  };
  const audioFormat = {
    format_id: "tiktok-audio",
    ext: "mp3",
    quality: "Audio",
    filesize: audioSize,
    filesize_human: bytesToHuman(Number(audioSize)) || "Unknown",
    format_note: "Original sound",
    download_url: `/api/download/tiktok/file?url=${encodeURIComponent(url)}&type=audio`,
  };

  return {
    status: "ok",
    platform: "tiktok",
    url,
    title,
    thumbnail: result.cover || "",
    channel: author.name || author.nickname || (typeof author === "string" ? author : "") || "",
    duration: typeof result.duration === "number" ? `${result.duration}s` : result.duration || "",
    formats: {
      video_audio: [videoFormat],
      audio_only: [audioFormat],
    },
  };
}

// ── Pinterest ─────────────────────────────────────────────────────────

export interface PinterestResult extends Record<string, unknown> {
  title?: string;
  download_url?: string;
  video?: string;
  download_urls?: string[];
  image_url?: string;
  images?: { image_url?: string }[];
}

export async function fetchPinterestResult(url: string): Promise<PinterestResult> {
  const quoted = encodeURIComponent(url);
  try {
    const payload = await fetchJson(`${PINTEREST_API_URL}?url=${quoted}`, 60_000);
    if (payload.status === true && payload.result) return payload.result as PinterestResult;
    console.log(`[Pinterest] Primary API error: ${JSON.stringify(payload).slice(0, 200)}`);
  } catch (e) {
    console.log(`[Pinterest] Primary API failed: ${(e as Error).message}`);
  }
  try {
    const payload = await fetchJson(
      `${PINTEREST_BACKUP_API_URL}?url=${quoted}&apikey=${PINTEREST_BACKUP_APIKEY}`,
      60_000
    );
    if (payload.status === true || payload.success === true) {
      const result = (payload.result || payload.data || payload) as PinterestResult;
      if (typeof result === "object") return result;
    }
  } catch (e) {
    console.log(`[Pinterest] Backup 1 failed: ${(e as Error).message}`);
  }
  try {
    const payload = await fetchJson(
      `${PINTEREST_BACKUP_API_URL_2}?url=${quoted}`,
      60_000,
      { "x-apikey": PINTEREST_BACKUP_APIKEY_2 }
    );
    if (payload.status === true || payload.success === true) {
      const result = (payload.result || payload.data || payload) as PinterestResult;
      if (typeof result === "object") return result;
    }
  } catch (e) {
    console.log(`[Pinterest] Backup 2 failed: ${(e as Error).message}`);
  }
  throw new Error("All Pinterest APIs failed (primary and backups)");
}

export function buildPinterestResponse(url: string, result: PinterestResult) {
  const mediaUrl = result.download_url || result.video || (result.download_urls || [])[0];
  return {
    status: "ok",
    platform: "pinterest",
    url,
    title: result.title || "Pinterest video",
    thumbnail: (result.images || [])[0]?.image_url || result.image_url || "",
    channel: "",
    formats: {
      video_audio: mediaUrl
        ? [
            {
              format_id: "pinterest-video",
              ext: "mp4",
              quality: "HD",
              height: null as number | null,
              filesize_human: "Unknown",
              format_note: "Video + Audio",
              has_audio: true,
              download_url: `/api/download/pinterest/file?url=${encodeURIComponent(url)}`,
            },
          ]
        : [],
      audio_only: [],
    },
  };
}

// ── Facebook ──────────────────────────────────────────────────────────

export interface FacebookResult extends Record<string, unknown> {
  title?: string;
  download_url?: string;
  download_urls?: string[];
  image_url?: string;
  images?: { image_url?: string }[];
  qualities?: { quality?: string; url?: string }[];
}

export async function fetchFacebookResult(url: string): Promise<FacebookResult> {
  const quoted = encodeURIComponent(url);
  const tryFetch = async (api: string, headers?: Record<string, string>) => {
    const payload = await fetchJson(`${api}?url=${quoted}`, 60_000, headers);
    if (payload.status === true || payload.success === true) {
      const result = (payload.result || payload.data || payload) as FacebookResult;
      if (typeof result === "object") return result;
    }
    throw new Error(
      String(payload.message || payload.error || "Facebook API returned no result").slice(0, 200)
    );
  };

  try {
    return await tryFetch(FACEBOOK_API_URL, { "x-apikey": FACEBOOK_APIKEY });
  } catch (e) {
    console.log(`[Facebook] Primary failed: ${(e as Error).message}`);
  }
  try {
    return await tryFetch(FACEBOOK_BACKUP_API_URL);
  } catch (e) {
    console.log(`[Facebook] Backup 1 failed: ${(e as Error).message}`);
  }
  try {
    return await tryFetch(FACEBOOK_BACKUP_API_URL_2);
  } catch (e) {
    console.log(`[Facebook] Backup 2 failed: ${(e as Error).message}`);
  }
  throw new Error("All Facebook APIs failed (primary and backups)");
}

function pickBestFacebookQuality(qualities: { quality?: string; url?: string }[]) {
  let best: { quality?: string; url?: string } | null = null;
  let bestVal = -1;
  for (const q of qualities) {
    const m = String(q.quality || "").match(/(\d+)/);
    const v = m ? parseInt(m[1], 10) : 0;
    if (v > bestVal && q.url) {
      bestVal = v;
      best = q;
    }
  }
  return best;
}

export function buildFacebookResponse(url: string, result: FacebookResult) {
  const qualities = result.qualities || [];
  const mediaUrl =
    result.download_url ||
    (result.download_urls || [])[0] ||
    (qualities.length ? pickBestFacebookQuality(qualities)?.url : undefined);

  return {
    status: "ok",
    platform: "facebook",
    url,
    title: result.title || "Facebook video",
    thumbnail: "",
    channel: "",
    formats: {
      video_audio: mediaUrl
        ? [
            {
              format_id: "facebook-video",
              ext: "mp4",
              quality: qualities.length ? String(pickBestFacebookQuality(qualities)?.quality || "HD") : "HD",
              height: null as number | null,
              filesize_human: "Unknown",
              format_note: "Video + Audio",
              has_audio: true,
              download_url: `/api/download/facebook/file?url=${encodeURIComponent(url)}&type=video`,
            },
          ]
        : [],
      audio_only: [],
    },
  };
}

