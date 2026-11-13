// URL helpers — ported from the original Flask app.py
import { URL } from "node:url";

export function normalizeUrl(link: string): string {
  let l = (link || "").trim();
  if (l.startsWith("https:/") && !l.startsWith("https://")) {
    l = "https://" + l.slice(7);
  } else if (l.startsWith("http:/") && !l.startsWith("http://")) {
    l = "http://" + l.slice(6);
  } else if (!l.startsWith("http")) {
    l = "https://" + l;
  }
  return l;
}

function hostOf(link: string): string {
  try {
    return (new URL(normalizeUrl(link)).hostname || "").toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

export function isTiktokUrl(link: string): boolean {
  const h = hostOf(link);
  return h === "tiktok.com" || h.endsWith(".tiktok.com");
}

export function isPinterestUrl(link: string): boolean {
  const h = hostOf(link);
  return (
    h === "pinterest.com" ||
    h.endsWith(".pinterest.com") ||
    h.endsWith(".pinimg.com") ||
    h === "pin.it"
  );
}

export function isFacebookUrl(link: string): boolean {
  const h = hostOf(link);
  return (
    h === "facebook.com" ||
    h.endsWith(".facebook.com") ||
    h === "fb.watch" ||
    h.endsWith(".fb.watch")
  );
}

export function isYoutubeUrl(link: string): boolean {
  const h = hostOf(link);
  return h === "youtube.com" || h === "www.youtube.com" || h === "m.youtube.com" || h === "youtu.be";
}

export function detectPlatform(url: string): string {
  if (!url) return "other";
  const h = hostOf(url);
  if (h.endsWith(".tiktok.com") || h === "tiktok.com") return "tiktok";
  if (h.endsWith(".pinterest.com") || h.endsWith(".pinimg.com") || h === "pin.it") return "pinterest";
  if (h.endsWith(".facebook.com") || h.endsWith(".fb.watch") || h === "facebook.com" || h === "fb.watch")
    return "facebook";
  if (h.endsWith(".youtube.com") || h === "youtu.be") return "youtube";
  return "other";
}

export function flagEmoji(countryCode?: string | null): string {
  const code = (countryCode || "XX").toUpperCase();
  if (code.length !== 2) return "\u{1F310}";
  try {
    const a = code.charCodeAt(0);
    const b = code.charCodeAt(1);
    return String.fromCodePoint(0x1f1e6 + a - 65) + String.fromCodePoint(0x1f1e6 + b - 65);
  } catch {
    return "\u{1F310}";
  }
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds) return "N/A";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatFilesize(size?: number | null): string | null {
  if (!size) return null;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function bytesToHuman(bytes?: number | null): string | null {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function safeFilename(title: string, ext: string): string {
  const base = (title || "video")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
  return `${base || "media"}.${ext}`;
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";
