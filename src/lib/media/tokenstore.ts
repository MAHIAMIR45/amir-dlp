// Short-token store for long media URLs (port of _register_media_url).
// googlevideo signed URLs can exceed 4KB — embedding two of them in one
// query string breaks request-line limits, so we register each URL under a
// short random token. Tokens are only created server-side, which also
// removes any SSRF surface on the proxy route.
import { randomBytes } from "node:crypto";

interface MediaEntry {
  u: string;
  y?: string | null;
  fid?: string | null;
  h?: number | null;
  exp: number;
}

const g = globalThis as unknown as { __mediaTokens?: Map<string, MediaEntry> };
const store: Map<string, MediaEntry> = g.__mediaTokens || new Map();
g.__mediaTokens = store;

const TTL = 3 * 3600 * 1000;

export function registerMediaUrl(
  mediaUrl: string,
  yurl?: string | null,
  fid?: string | null,
  height?: number | null
): string {
  const token = randomBytes(8).toString("hex");
  const now = Date.now();
  store.set(token, { u: mediaUrl, y: yurl || null, fid: fid || null, h: height || null, exp: now + TTL });
  // prune expired
  for (const [k, v] of store) {
    if ((v.exp || 0) <= now) store.delete(k);
  }
  return token;
}

export function resolveMediaEntry(token: string): MediaEntry | null {
  const e = store.get(token);
  if (!e) return null;
  if ((e.exp || 0) <= Date.now()) {
    store.delete(token);
    return null;
  }
  return e;
}

export function dlPath(token: string): string {
  return `/api/download/dl?t=${token}`;
}
