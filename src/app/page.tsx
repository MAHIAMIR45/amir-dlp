"use client";

// Media Downloader — Next.js port of the original Flask templates
// (templates/index.html + admin_login.html + admin_dashboard.html).
// Single-page app: Home (search + downloads), API Docs, Admin panel.

import { useCallback, useEffect, useRef, useState } from "react";
import AdminLogin from "@/components/admin/AdminLogin";
import AdminDashboard from "@/components/admin/AdminDashboard";

// ── types ──────────────────────────────────────────────────────────────
interface SearchVideo {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  channel: string;
  views?: number | null;
  url: string;
}
interface FormatEntry {
  format_id: string | null;
  ext: string | null;
  height: number | null;
  fps: number | null;
  vcodec: string;
  acodec: string;
  abr: number;
  filesize: number | null;
  filesize_human: string | null;
  format_note: string;
  has_video?: boolean;
  has_audio?: boolean;
  quality?: string;
  url: string;
  download_url?: string;
}
interface VideoInfo {
  status?: string;
  error?: string;
  title?: string;
  thumbnail?: string;
  duration?: string;
  channel?: string;
  backup?: boolean;
  _backup_url?: string;
  formats?: {
    video_audio?: FormatEntry[];
    combined?: FormatEntry[];
    video_only?: FormatEntry[];
    audio_only?: FormatEntry[];
  };
  formats_count?: number;
}
interface AudioInfo {
  status?: string;
  error?: string;
  title?: string;
  thumbnail?: string;
  duration?: string;
  channel?: string;
  backup?: boolean;
  _backup_url?: string;
  best_audio?: FormatEntry | null;
  all_audio_formats?: FormatEntry[];
}
interface TiktokInfo {
  status?: string;
  error?: string;
  title?: string;
  thumbnail?: string;
  channel?: string;
  duration?: string;
  formats?: {
    video_audio?: (FormatEntry & { filesize_human?: string })[];
    audio_only?: (FormatEntry & { filesize_human?: string })[];
  };
}
interface PinterestInfo {
  status?: string;
  error?: string;
  title?: string;
  thumbnail?: string;
  channel?: string;
  formats?: {
    video_audio?: FormatEntry[];
  };
}

type PageId = "home" | "docs" | "admin";
type ModalKind = "tiktok" | "pinterest" | "audio" | "video";

const API_TIMEOUT = 160000;

async function fetchJSON<T>(path: string, timeout = API_TIMEOUT): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, { signal: ctl.signal });
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function fmtViews(n?: number | null): string {
  if (!n) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B views";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M views";
  if (n >= 1e3) return Math.round(n / 1e3) + "K views";
  return n + " views";
}

function isTikTokUrl(url: string): boolean {
  return /(^|\/\/)(www\.|m\.|vm\.|vt\.)?tiktok\.com(?:\/|$)/i.test(url.trim());
}
function isPinterestUrl(url: string): boolean {
  return /(^|\/\/)((www\.|[a-z-]+\.)?pinterest\.com|pin\.it|.*pinimg\.com)(?:\/|$)/i.test(url.trim());
}

// ═══════════════════════════════════════════════════════════════════════
export default function Home() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminAuthed, setAdminAuthed] = useState<boolean | null>(null);

  // home state
  const [searchInput, setSearchInput] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [sectionLabel, setSectionLabel] = useState("");
  const [videos, setVideos] = useState<SearchVideo[]>([]);

  // modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalKind, setModalKind] = useState<ModalKind>("video");
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState("");
  const [videoData, setVideoData] = useState<VideoInfo | null>(null);
  const [audioData, setAudioData] = useState<AudioInfo | null>(null);
  const [tiktokData, setTiktokData] = useState<TiktokInfo | null>(null);
  const [pinterestData, setPinterestData] = useState<PinterestInfo | null>(null);
  const [videoTab, setVideoTab] = useState<"va" | "vonly" | "aonly">("va");

  const [baseUrl, setBaseUrl] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const directUrlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBaseUrl(window.location.origin);
  }, []);

  const showPage = useCallback((id: PageId) => {
    setActivePage(id);
    setMenuOpen(false);
    window.scrollTo(0, 0);
    if (id === "admin" && adminAuthed === null) {
      // probe session
      fetch("/api/admin/stats")
        .then((r) => setAdminAuthed(r.ok))
        .catch(() => setAdminAuthed(false));
    }
  }, [adminAuthed]);

  // ── modal openers (ported) ───────────────────────────────────────────
  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const openTikTok = useCallback(async (url: string) => {
    setModalKind("tiktok");
    setModalLoading(true);
    setModalError("");
    setTiktokData(null);
    openModal();
    try {
      const d = await fetchJSON<TiktokInfo>("/api/download/tiktok?url=" + encodeURIComponent(url));
      setTiktokData(d);
    } catch (e) {
      setModalError((e as Error).name === "AbortError" ? "Timed out — try again in a moment." : (e as Error).message);
    } finally {
      setModalLoading(false);
    }
  }, [openModal]);

  const openPinterest = useCallback(async (url: string) => {
    setModalKind("pinterest");
    setModalLoading(true);
    setModalError("");
    setPinterestData(null);
    openModal();
    try {
      const d = await fetchJSON<PinterestInfo>("/api/download/pinterest?url=" + encodeURIComponent(url));
      setPinterestData(d);
    } catch (e) {
      setModalError((e as Error).name === "AbortError" ? "Timed out — try again in a moment." : (e as Error).message);
    } finally {
      setModalLoading(false);
    }
  }, [openModal]);

  const openAudio = useCallback(async (url: string) => {
    setModalKind("audio");
    setModalLoading(true);
    setModalError("");
    setAudioData(null);
    openModal();
    try {
      const d = await fetchJSON<AudioInfo>("/api/download/audio?url=" + encodeURIComponent(url));
      setAudioData(d);
    } catch (e) {
      setModalError((e as Error).message);
    } finally {
      setModalLoading(false);
    }
  }, [openModal]);

  const openVideo = useCallback(async (url: string) => {
    if (isTikTokUrl(url)) {
      void openTikTok(url);
      return;
    }
    if (isPinterestUrl(url)) {
      void openPinterest(url);
      return;
    }
    setModalKind("video");
    setModalLoading(true);
    setModalError("");
    setVideoData(null);
    setVideoTab("va");
    openModal();
    try {
      const d = await fetchJSON<VideoInfo>("/api/download/video?url=" + encodeURIComponent(url));
      setVideoData(d);
    } catch (e) {
      setModalError(
        (e as Error).name === "AbortError"
          ? "Timed out after " + API_TIMEOUT / 1000 + "s — YouTube is slow or blocking this server. Try again or use a different video."
          : (e as Error).message
      );
    } finally {
      setModalLoading(false);
    }
  }, [openModal, openTikTok, openPinterest]);

  // ── search (ported doSearch) ─────────────────────────────────────────
  const doSearch = useCallback(async () => {
    const q = searchInputRef.current?.value.trim() || "";
    if (!q) return;
    setLoading(true);
    setVideos([]);
    setSectionLabel("");
    try {
      const d = await fetchJSON<{ results: SearchVideo[]; error?: string }>("/api/search?q=" + encodeURIComponent(q));
      setLoading(false);
      if (d.error) {
        setSectionLabel("Error: " + d.error);
        return;
      }
      setSectionLabel(`${d.results.length} results for "${q}"`);
      setVideos(d.results);
    } catch (e) {
      setLoading(false);
      setSectionLabel(
        "Failed: " + ((e as Error).name === "AbortError" ? `Timed out after ${API_TIMEOUT / 1000}s` : (e as Error).message)
      );
    }
  }, []);

  const loadDirect = useCallback(() => {
    const u = directUrlRef.current?.value.trim() || "";
    if (!u) return;
    void openVideo(u);
  }, [openVideo]);

  // ── download click interception (ported) ─────────────────────────────
  useEffect(() => {
    async function handler(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const a = target.closest ? (target.closest("a.dl-btn,a.dl-btn-a") as HTMLAnchorElement | null) : null;
      if (!a || !a.hasAttribute("download") || !a.getAttribute("href")) return;
      if (a.classList.contains("dl-loading")) return;

      // Native download flow (Video+Audio MP4): hand the URL straight to the
      // phone's download manager — progress shows in the notification bar
      // immediately, nothing is buffered in page memory. The server streams
      // the merged MP4 as ffmpeg produces it, so the download starts fast.
      if (a.dataset.native === "1") {
        e.preventDefault();
        const original = a.innerHTML;
        a.classList.add("dl-loading");
        a.innerHTML = '<span class="dl-spinner"></span> Starting…';
        const u = new URL(a.href, window.location.origin);
        u.searchParams.set("native", "1");
        window.location.assign(u.toString());
        // the page stays put on success (attachment); restore the button either way
        setTimeout(() => {
          a.classList.remove("dl-loading");
          a.innerHTML = original;
        }, 4000);
        return;
      }

      e.preventDefault();
      const original = a.innerHTML;
      a.classList.add("dl-loading");
      a.innerHTML = '<span class="dl-spinner"></span> Preparing…';

      try {
        const resp = await fetch(a.href, { credentials: "include", headers: { Accept: "*/*" } });
        if (!resp.ok) {
          let msg = "Download failed. Please try another quality or reload the video.";
          try {
            const j = await resp.json();
            if (j && j.error) msg = j.error;
          } catch {
            /* ignore */
          }
          alert(msg);
          return;
        }
        const ct = resp.headers.get("Content-Type") || "";
        if (ct.indexOf("json") >= 0) {
          let msg = "Download failed. Please try another quality or reload.";
          try {
            const j = await resp.json();
            if (j && j.error) msg = j.error;
          } catch {
            /* ignore */
          }
          alert(msg);
          return;
        }
        const blob = await resp.blob();
        const urlBlob = URL.createObjectURL(blob);
        const t = document.createElement("a");
        t.href = urlBlob;
        t.download = a.getAttribute("download") || "youtube-video.mp4";
        document.body.appendChild(t);
        t.click();
        t.remove();
        setTimeout(() => URL.revokeObjectURL(urlBlob), 4000);
      } catch {
        alert("Download failed — please try again.");
      } finally {
        a.classList.remove("dl-loading");
        a.innerHTML = original;
      }
    }
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // ── shared bits ──────────────────────────────────────────────────────
  const logoSvg = (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="26" y2="26">
          <stop offset="0%" stopColor="#ff2d2d" />
          <stop offset="100%" stopColor="#ff6b35" />
        </linearGradient>
      </defs>
      <rect width="26" height="26" rx="6" fill="url(#lg)" />
      <polygon points="10,7 21,13 10,19" fill="white" />
    </svg>
  );

  // ── modal content renderers (ported HTML) ────────────────────────────
  const spinHtml = (color: string) => (
    <div className="modal-spin">
      <div className="spin" style={{ borderTopColor: color }} />
      <br />
      Loading available qualities…
    </div>
  );

  const fmtRow = (f: FormatEntry, badge: string) => {
    const label =
      badge === "Video+Audio"
        ? f.height
          ? f.height >= 2160
            ? "4K"
            : f.height >= 1440
              ? "2K"
              : f.height >= 1080
                ? "Full HD"
                : f.height >= 720
                  ? "HD"
                  : f.height >= 480
                    ? "SD"
                    : "Low"
          : ""
        : "";
    const det = [
      f.ext,
      f.height ? f.height + "p" : null,
      f.fps ? f.fps + "fps" : null,
      f.vcodec && f.vcodec !== "none" ? f.vcodec.split(".")[0] : null,
      f.acodec && f.acodec !== "none" ? f.acodec.split(".")[0] : null,
      f.abr ? f.abr + " kbps" : null,
      f.filesize_human,
    ]
      .filter(Boolean)
      .join(" · ");
    const downloadUrl = f.download_url || f.url;
    return (
      <div className="qrow" key={`${badge}-${f.format_id}-${f.height}-${f.abr}`}>
        <div className="qbadge">
          <div className="qres">{f.height ? f.height + "p" : (f.ext || "").toUpperCase()}</div>
          <div className="qfps">{f.fps ? f.fps + "fps" : f.abr ? f.abr + "kbps" : ""}</div>
        </div>
        <div className="qinfo">
          <div className="ql">{(label || badge) + " · " + det}</div>
        </div>
        <a
          className="dl-btn"
          href={downloadUrl}
          download
          data-native={
            badge === "Video+Audio" || badge === "Video Only" || badge === "Audio Only" ? "1" : undefined
          }
        >
          ⬇ Download
        </a>
      </div>
    );
  };

  const renderModal = () => {
    if (modalLoading) {
      const colors: Record<ModalKind, string> = {
        tiktok: "#ff6b6b",
        pinterest: "#e60023",
        audio: "#00e676",
        video: "#ff2d2d",
      };
      return spinHtml(colors[modalKind]);
    }
    if (modalError) {
      return <div className="err-box">❌ {modalError}</div>;
    }

    if (modalKind === "tiktok" && tiktokData) {
      const d = tiktokData;
      if (d.status !== "ok") {
        return <div className="err-box">❌ {d.error || "TikTok video could not be loaded"}</div>;
      }
      const video = (d.formats?.video_audio || [])[0];
      const audio = (d.formats?.audio_only || [])[0];
      if (!video && !audio) {
        return <div className="err-box">❌ No downloadable TikTok media was found.</div>;
      }
      return (
        <>
          {d.thumbnail ? (
             
            <img className="modal-thumb" src={d.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          ) : null}
          <div className="modal-title">{d.title || "TikTok video"}</div>
          <div className="modal-meta">
            <span style={{ color: "#ff6b6b", fontWeight: 700 }}>TikTok</span> · {d.channel || ""} · {d.duration || ""}
          </div>
          <div className="ftabs">
            <button className="ftab active">Downloads</button>
          </div>
          <div className="fpanel active" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {video ? (
              <div className="qrow">
                <div className="qbadge">
                  <div className="qres">HD</div>
                  <div className="qfps">MP4</div>
                </div>
                <div className="qinfo">
                  <div className="ql">TikTok · No watermark · Video + Audio · {video.filesize_human || ""}</div>
                </div>
                <a className="dl-btn" href={video.download_url || video.url} download>
                  ⬇ Download
                </a>
              </div>
            ) : null}
            {audio ? (
              <div className="afmt-row">
                <div className="afmt-info">
                  <div className="afmt-top">
                    <span className="abadge">Audio</span>Original Sound
                  </div>
                  <div className="afmt-detail">MP3 · {audio.filesize_human || ""}</div>
                </div>
                <a className="dl-btn-a" href={audio.download_url || audio.url} download>
                  ⬇ Download
                </a>
              </div>
            ) : null}
          </div>
        </>
      );
    }

    if (modalKind === "pinterest" && pinterestData) {
      const d = pinterestData;
      if (d.status !== "ok") {
        return <div className="err-box">❌ {d.error || "Pinterest video could not be loaded"}</div>;
      }
      const video = (d.formats?.video_audio || [])[0];
      if (!video || !video.download_url) {
        return <div className="err-box">❌ No downloadable Pinterest video was found.</div>;
      }
      return (
        <>
          {d.thumbnail ? (
             
            <img className="modal-thumb" src={d.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          ) : null}
          <div className="modal-title">{d.title || "Pinterest video"}</div>
          <div className="modal-meta">
            <span style={{ color: "#e60023", fontWeight: 700 }}>Pinterest</span> · {d.channel || ""}
          </div>
          <div className="ftabs">
            <button className="ftab active">Downloads</button>
          </div>
          <div className="fpanel active" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div className="qrow">
              <div className="qbadge">
                <div className="qres">Video</div>
                <div className="qfps">MP4</div>
              </div>
              <div className="qinfo">
                <div className="ql">Pinterest · Video + Audio</div>
              </div>
              <a className="dl-btn" href={video.download_url} download>
                ⬇ Download
              </a>
            </div>
          </div>
        </>
      );
    }

    if (modalKind === "audio" && audioData) {
      const d = audioData;
      if (d.status === "error") {
        return <div className="err-box">❌ {d.error}</div>;
      }
      if (!d.best_audio) {
        if (d.backup) {
          return (
            <div className="err-box">
              ❌ yt-dlp is blocked on this server.
              <br />
              <a
                className="dl-btn"
                style={{ marginTop: 10, width: "100%", justifyContent: "center" }}
                href={`/api/download/mp3?url=${encodeURIComponent(d._backup_url || "")}&quality=128&native=1`}
                download="youtube-audio.mp3"
                data-native="1"
              >
                ⬇ Download via Backup API (.mp3)
              </a>
            </div>
          );
        }
        return <div className="err-box">❌ No audio formats were found for this video.</div>;
      }
      const b = d.best_audio;
      const all = d.all_audio_formats || [];
      return (
        <>
          {d.thumbnail ? (
             
            <img className="modal-thumb" src={d.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          ) : null}
          <div className="modal-title">{d.title}</div>
          <div className="modal-meta">
            {d.channel || ""} · {d.duration}
          </div>
          <div className="audio-hero">
            <div className="audio-hero-title">🎵 Best Audio</div>
            <div className="audio-stats">
              <div className="astat">
                <label>Format</label>
                <span>{b.format_id}</span>
              </div>
              <div className="astat">
                <label>Codec</label>
                <span>{b.acodec || "—"}</span>
              </div>
              <div className="astat">
                <label>Bitrate</label>
                <span>{b.abr ? b.abr + " kbps" : "—"}</span>
              </div>
              <div className="astat">
                <label>Size</label>
                <span>{b.filesize_human || "—"}</span>
              </div>
            </div>
            <a className="dl-btn" href={b.url} download data-native="1" style={{ width: "100%", justifyContent: "center" }}>
              ⬇ Download Best Audio (.mp3 · 128kbps)
            </a>
          </div>
          {all.length > 1 ? (
            <>
              <div
                style={{
                  fontSize: ".75rem",
                  fontWeight: 700,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: ".5px",
                  margin: "14px 0 9px",
                }}
              >
                All Formats
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {all.map((f, i) => {
                  const det = [
                    f.ext,
                    f.acodec && f.acodec !== "none" ? f.acodec.split(".")[0] : null,
                    f.abr ? f.abr + " kbps" : null,
                    f.filesize_human,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <div className="afmt-row" key={`af-${i}`}>
                      <div className="afmt-info">
                        <div className="afmt-top">
                          <span className="abadge">Audio</span>
                          {f.abr ? f.abr + " kbps" : "—"}
                        </div>
                        <div className="afmt-detail">{det}</div>
                      </div>
                      <a className="dl-btn-a" href={f.url} download data-native="1">
                        ⬇ Download MP3
                      </a>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      );
    }

    if (modalKind === "video" && videoData) {
      const d = videoData;
      if (d.status === "error") {
        return <div className="err-box">❌ {d.error}</div>;
      }
      const merged = (d.formats?.video_audio as FormatEntry[]) || [];
      const combined = (d.formats?.combined as FormatEntry[]) || [];
      const vonly = (d.formats?.video_only as FormatEntry[]) || [];
      const aonly = (d.formats?.audio_only as FormatEntry[]) || [];
      const avFormats = merged.length ? merged : combined;

      const hasVa = avFormats.length > 0;
      const hasVonly = vonly.length > 0;
      const hasAonly = aonly.length > 0;
      const activeTab = !hasVa && hasVonly ? "vonly" : !hasVa && !hasVonly && hasAonly ? "aonly" : videoTab;

      return (
        <>
          {d.thumbnail ? (
             
            <img className="modal-thumb" src={d.thumbnail} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          ) : null}
          <div className="modal-title">{d.title}</div>
          <div className="modal-meta">
            {d.channel || ""} · {d.duration}
          </div>
          <div className="ftabs">
            {hasVa ? (
              <button className={`ftab${activeTab === "va" ? " active" : ""}`} onClick={() => setVideoTab("va")}>
                Video+Audio<span className="fcnt">{avFormats.length}</span>
              </button>
            ) : null}
            {hasVonly ? (
              <button className={`ftab${activeTab === "vonly" ? " active" : ""}`} onClick={() => setVideoTab("vonly")}>
                Video Only<span className="fcnt">{vonly.length}</span>
              </button>
            ) : null}
            {hasAonly ? (
              <button className={`ftab${activeTab === "aonly" ? " active" : ""}`} onClick={() => setVideoTab("aonly")}>
                Audio Only<span className="fcnt">{aonly.length}</span>
              </button>
            ) : null}
          </div>
          {hasVa ? (
            <div className={`fpanel${activeTab === "va" ? " active" : ""}`}>
              {avFormats.map((f, i) => (
                <div key={`va-${i}`}>{fmtRow(f, "Video+Audio")}</div>
              ))}
            </div>
          ) : null}
          {hasVonly ? (
            <div className={`fpanel${activeTab === "vonly" ? " active" : ""}`}>
              {vonly.map((f, i) => (
                <div key={`vo-${i}`}>{fmtRow(f, "Video Only")}</div>
              ))}
            </div>
          ) : null}
          {hasAonly ? (
            <div className={`fpanel${activeTab === "aonly" ? " active" : ""}`}>
              {aonly.map((f, i) => (
                <div key={`ao-${i}`}>{fmtRow(f, "Audio Only")}</div>
              ))}
            </div>
          ) : null}
        </>
      );
    }

    return null;
  };

  return (
    <div className="md-app" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* ── NAV ── */}
      <nav>
        <div className="logo">
          {logoSvg}
          Media Downloader
        </div>

        <div className="nav-links">
          <button className={`nav-btn${activePage === "home" ? " active" : ""}`} onClick={() => showPage("home")}>
            Home
          </button>
          <button className={`nav-btn${activePage === "docs" ? " active" : ""}`} onClick={() => showPage("docs")}>
            API Docs
          </button>
          <button className={`nav-btn admin-btn${activePage === "admin" ? " active" : ""}`} onClick={() => showPage("admin")}>
            👑 Admin
          </button>
        </div>

        <button className="hamburger" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
          <span></span>
          <span></span>
          <span></span>
        </button>
      </nav>

      <div className={`mobile-menu${menuOpen ? " open" : ""}`}>
        <button className={`mobile-nav-btn${activePage === "home" ? " active" : ""}`} onClick={() => showPage("home")}>
          Home
        </button>
        <button className={`mobile-nav-btn${activePage === "docs" ? " active" : ""}`} onClick={() => showPage("docs")}>
          API Docs
        </button>
        <button className={`mobile-nav-btn admin-btn${activePage === "admin" ? " active" : ""}`} onClick={() => showPage("admin")}>
          👑 Admin Panel
        </button>
      </div>

      {/* ════ HOME PAGE ════ */}
      <div className={`page${activePage === "home" ? " active" : ""}`} style={{ flex: 1, display: activePage === "home" ? "block" : undefined }}>
        <div className="hero">
          <h1>
            Download YouTube &amp; TikTok
            <br />
            <em>Videos &amp; Audio</em>
          </h1>
          <p>Search YouTube or paste a YouTube/TikTok link — download quickly with audio.</p>
          <div className="platform-note">
            <b>Supports</b> YouTube videos · TikTok videos · TikTok audio
          </div>

          {/* Search */}
          <div className="search-wrap">
            <div className="search-row">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" stroke="#7878a0" strokeWidth="2" />
                <path d="M16.5 16.5L21 21" stroke="#7878a0" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doSearch();
                }}
                placeholder="Search YouTube videos…"
                autoComplete="off"
              />
              <button onClick={() => void doSearch()}>Search</button>
            </div>
          </div>

          <div className="url-divider">or paste a link</div>

          <div className="url-row">
            <input
              ref={directUrlRef}
              type="text"
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadDirect();
              }}
              placeholder="Paste YouTube or TikTok link…"
            />
            <button onClick={loadDirect}>Load</button>
          </div>
        </div>

        <div className={`loader${loading ? " on" : ""}`}>
          <div className="spin" />
          <br />
          Searching…
        </div>
        <p className="section-label">{sectionLabel}</p>
        <div className="results-grid">
          {videos.map((v, i) => (
            <div className="card" key={v.id || i}>
              <div className="thumb">
                { }
                <img
                  src={v.thumbnail}
                  alt=""
                  loading="lazy"
                  onError={(e) => ((e.target as HTMLImageElement).parentElement!.style.background = "#111")}
                />
                {v.duration && v.duration !== "N/A" ? <div className="dur">{v.duration}</div> : null}
              </div>
              <div className="card-body">
                <div className="card-title">{v.title}</div>
                <div className="card-meta">
                  <span>{v.channel || ""}</span>
                  {v.views ? (
                    <>
                      <span className="dot" />
                      <span>{fmtViews(v.views)}</span>
                    </>
                  ) : null}
                </div>
                <div className="card-btns">
                  <button className="btn-a" onClick={() => void openAudio(v.url)}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
                    </svg>
                    Audio
                  </button>
                  <button className="btn-v" onClick={() => void openVideo(v.url)}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7L8 5z" />
                    </svg>
                    Video
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ════ DOCS PAGE ════ */}
      <DocsPage active={activePage === "docs"} baseUrl={baseUrl} />

      {/* ════ ADMIN PAGE ════ */}
      <div className={`page${activePage === "admin" ? " active" : ""}`} style={{ flex: 1 }}>
        <div className="admin-scope">
          {adminAuthed === true ? (
            <AdminDashboard onLogout={() => setAdminAuthed(false)} />
          ) : adminAuthed === false ? (
            <AdminLogin onSuccess={() => setAdminAuthed(true)} />
          ) : (
            <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b1120", color: "#8a97ad" }}>
              <div className="loading-row">
                <div className="spinner" /> Checking session…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── MODAL ── */}
      <div
        className={`overlay${modalOpen ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        <div className="modal">
          <button className="modal-x" onClick={closeModal}>
            ✕
          </button>
          <div>{renderModal()}</div>
        </div>
      </div>

      {/* ── FOOTER ── */}
      <footer className="md-footer">
        Made with <span className="heart">♥</span> by <strong>Mian Amir</strong>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// DOCS PAGE (ported)
// ═══════════════════════════════════════════════════════════════════════
function DocsPage({ active, baseUrl }: { active: boolean; baseUrl: string }) {
  const [testUrl, setTestUrl] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const [testVisible, setTestVisible] = useState(false);

  const testApi = async (type: "audio" | "video") => {
    const u = testUrl.trim();
    if (!u) return;
    const path =
      type === "audio"
        ? "/api/download/audio?url=" + encodeURIComponent(u)
        : "/api/download/video?url=" + encodeURIComponent(u);
    setTestVisible(true);
    setTestOutput("Loading…");
    try {
      const d = await fetchJSON<unknown>(path);
      setTestOutput(JSON.stringify(d, null, 2));
    } catch (e) {
      setTestOutput(
        "Error: " + ((e as Error).name === "AbortError" ? `Timed out after ${API_TIMEOUT / 1000}s` : (e as Error).message)
      );
    }
  };

  return (
    <div className={`page${active ? " active" : ""}`} style={{ flex: 1 }}>
      <div className="docs-wrap">
        <div className="docs-hero">
          <h2>
            API <em>Documentation</em>
          </h2>
          <p>YouTube and TikTok download endpoints. Use them in bots, scripts, or apps.</p>
        </div>

        {/* Base URL */}
        <div className="base-url-card">
          <span className="label">Base URL</span>
          <code>{baseUrl}</code>
        </div>

        {/* GET /api/search */}
        <div className="ep-card">
          <div className="ep-head">
            <span className="method get">GET</span>
            <span className="ep-path">/api/search</span>
            <span className="ep-tag">Search</span>
          </div>
          <div className="ep-body">
            <h4>Query Parameters</h4>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Param</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
                <tr>
                  <td className="pname">q</td>
                  <td>string</td>
                  <td>
                    <span className="preq">Yes</span>
                  </td>
                  <td>Search keyword or phrase</td>
                </tr>
                <tr>
                  <td className="pname">limit</td>
                  <td>integer</td>
                  <td>
                    <span className="popt">No</span>
                  </td>
                  <td>Number of results (default: 12, max: 20)</td>
                </tr>
              </tbody>
            </table>
            <h4>Example Response</h4>
            <div className="codeblock">{`{
  "results": [
    {
      "id":        "dQw4w9WgXcQ",
      "title":     "Never Gonna Give You Up",
      "thumbnail": "https://i.ytimg.com/vi/...",
      "duration":  "3:33",
      "channel":   "Rick Astley",
      "views":     1400000000,
      "url":       "https://youtube.com/watch?v=dQw4w9WgXcQ"
    }
  ]
}`}</div>
          </div>
        </div>

        {/* GET /api/download/audio */}
        <div className="ep-card">
          <div className="ep-head">
            <span className="method get">GET</span>
            <span className="ep-path">/api/download/audio?url={"{youtube_url}"}</span>
            <span className="ep-tag">Audio</span>
          </div>
          <div className="ep-body">
            <h4>Query Parameter</h4>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Param</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
                <tr>
                  <td className="pname">url</td>
                  <td>string</td>
                  <td>
                    <span className="preq">Yes</span>
                  </td>
                  <td>Full YouTube URL (youtu.be or youtube.com/watch)</td>
                </tr>
              </tbody>
            </table>
            <h4>Example Request</h4>
            <div className="codeblock">{`GET /api/download/audio?url=https://youtu.be/HNMP1UdjOsE`}</div>
            <br />
            <h4>Example Response</h4>
            <div className="codeblock">{`{
  "status":    "ok",
  "title":     "Video Title",
  "thumbnail": "https://...",
  "duration":  "3:45",
  "channel":   "Channel Name",
  "best_audio": {
    "format_id":      "251",
    "ext":            "webm",
    "acodec":         "opus",
    "abr":            96,
    "filesize_human": "5.2 MB",
    "url":            "/api/download/dl?t=..."
  },
  "all_audio_formats": [ ... ]
}`}</div>
          </div>
        </div>

        {/* GET /api/download/video */}
        <div className="ep-card">
          <div className="ep-head">
            <span className="method get">GET</span>
            <span className="ep-path">/api/download/video?url={"{youtube_url}"}</span>
            <span className="ep-tag">Video</span>
          </div>
          <div className="ep-body">
            <h4>Path &amp; Query Parameters</h4>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Param</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
                <tr>
                  <td className="pname">url</td>
                  <td>string</td>
                  <td>
                    <span className="preq">Yes</span>
                  </td>
                  <td>Full YouTube URL (youtu.be or youtube.com/watch)</td>
                </tr>
                <tr>
                  <td className="pname">height</td>
                  <td>integer / &quot;best&quot;</td>
                  <td>
                    <span className="popt">No</span>
                  </td>
                  <td>
                    Use <span className="pname">/api/download/mp4?url=...&amp;height=720</span> to download a merged
                    Video+Audio MP4 at that quality
                  </td>
                </tr>
              </tbody>
            </table>
            <h4>Without <code style={{ color: "#82b1ff" }}>&amp;height</code> — Returns JSON with all formats</h4>
            <div className="codeblock">{`GET /api/download/video?url=https://youtu.be/HNMP1UdjOsE

{
  "status":          "ok",
  "title":           "Video Title",
  "duration":        "1:04",
  "formats": {
    "video_audio":   [ /* merged MP4 downloads */ ],
    "combined":      [ /* streams with video + audio */ ],
    "video_only":    [ /* high-quality video streams */ ],
    "audio_only":    [ /* audio streams */ ]
  },
  "formats_count":   23
}`}</div>
            <br />
            <h4>With <code style={{ color: "#82b1ff" }}>&amp;height=720</code> — Downloads merged MP4 file</h4>
            <div className="codeblock">{`GET /api/download/mp4?url=https://youtu.be/HNMP1UdjOsE&height=720

→ Response: binary video/mp4 file (Content-Disposition: attachment)
→ Video and audio are merged server-side before download`}</div>
            <div className="tip">
              <strong>Bot usage:</strong>
              <br />
              <code>wget &quot;BASE_URL/api/download/mp4?url=YOUTUBE_URL&amp;height=1080&quot; -O output.mp4</code>
              <br />
              <br />
              Supported height values: <code>2160</code> · <code>1440</code> · <code>1080</code> · <code>720</code> ·{" "}
              <code>480</code> · <code>360</code> · <code>240</code> · <code>best</code>
            </div>
          </div>
        </div>

        {/* GET /api/download/tiktok */}
        <div className="ep-card">
          <div className="ep-head">
            <span className="method get">GET</span>
            <span className="ep-path">/api/download/tiktok?url={"{tiktok_url}"}</span>
            <span className="ep-tag">TikTok</span>
          </div>
          <div className="ep-body">
            <h4>Query Parameter</h4>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Param</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
                <tr>
                  <td className="pname">url</td>
                  <td>string</td>
                  <td>
                    <span className="preq">Yes</span>
                  </td>
                  <td>Full TikTok URL, including www, vm, or vt links</td>
                </tr>
              </tbody>
            </table>
            <h4>Example Request</h4>
            <div className="codeblock">{`GET /api/download/tiktok?url=https://www.tiktok.com/@creator/video/123456789`}</div>
            <br />
            <h4>Response</h4>
            <div className="codeblock">{`{
  "status": "ok",
  "platform": "tiktok",
  "formats": {
    "video_audio": [ /* no-watermark MP4 */ ],
    "audio_only":  [ /* original sound MP3 */ ]
  }
}`}</div>
            <div className="tip">
              <strong>Website:</strong> Paste any TikTok link in the home page input. The site shows a no-watermark video
              and original audio download.
            </div>
          </div>
        </div>

        {/* GET /api/download/pinterest */}
        <div className="ep-card">
          <div className="ep-head">
            <span className="method get">GET</span>
            <span className="ep-path">/api/download/pinterest?url={"{pinterest_url}"}</span>
            <span className="ep-tag">Pinterest</span>
          </div>
          <div className="ep-body">
            <h4>Query Parameter</h4>
            <table className="ptable">
              <tbody>
                <tr>
                  <th>Param</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
                <tr>
                  <td className="pname">url</td>
                  <td>string</td>
                  <td>
                    <span className="preq">Yes</span>
                  </td>
                  <td>Full Pinterest URL, including pin.it short links</td>
                </tr>
              </tbody>
            </table>
            <h4>Example Request</h4>
            <div className="codeblock">{`GET /api/download/pinterest?url=https://pin.it/1XtzdYaOq`}</div>
            <br />
            <h4>Response</h4>
            <div className="codeblock">{`{
  "status": "ok",
  "platform": "pinterest",
  "formats": {
    "video_audio": [ /* Pinterest video MP4 */ ]
  }
}`}</div>
            <div className="tip">
              <strong>Website:</strong> Paste any Pinterest link in the home page input. The site shows a Pinterest video
              download.
            </div>
          </div>
        </div>

        {/* ── Live Test ── */}
        <div className="ep-card">
          <div className="ep-head">
            <span style={{ fontSize: ".95rem", fontWeight: 700 }}>🧪 Live Test</span>
          </div>
          <div className="ep-body">
            <div className="test-row">
              <input
                type="text"
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
                placeholder="Paste a YouTube, TikTok or Pinterest URL to test…"
              />
              <button className="tbtn-a" onClick={() => void testApi("audio")}>
                Test Audio
              </button>
              <button className="tbtn-v" onClick={() => void testApi("video")}>
                Test Video
              </button>
            </div>
            {testVisible ? (
              <div
                className="codeblock"
                style={{ maxHeight: 380, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: ".74rem" }}
              >
                {testOutput}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
