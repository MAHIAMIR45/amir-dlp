"use client";

// Admin dashboard — port of templates/admin_dashboard.html.
// Views: overview, traffic, health, sessions, requests.
import { useCallback, useEffect, useRef, useState } from "react";

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  facebook: "Facebook",
  other: "Other",
  unknown: "Unknown",
  admin_page: "Admin",
};
const PLATFORM_PILL: Record<string, string> = {
  youtube: "yt",
  tiktok: "tt",
  pinterest: "pi",
  facebook: "fb",
  other: "ot",
  unknown: "ot",
  admin_page: "ot",
};
const PLATFORM_COLOR: Record<string, string> = {
  youtube: "#ef4444",
  tiktok: "#06b6d4",
  pinterest: "#ec4899",
  facebook: "#3b82f6",
  other: "#8a97ad",
};

interface Stats {
  total_requests: number;
  platform_counts: Record<string, number>;
  platform_errors: Record<string, number>;
  unique_ips: number;
  countries: { code: string; country: string; count: number; ips: number; flag: string }[];
  hourly_traffic: Record<string, number>;
  daily_traffic: Record<string, number>;
  uptime: number;
  process_start: string;
}
interface HealthApi {
  name: string;
  platform: string;
  status: "up" | "down" | "degraded";
  latency: number | null;
  last_check: string;
  error?: string;
}
interface SessionRow {
  ip: string;
  flag?: string;
  country: string;
  country_code: string;
  city: string;
  isp: string;
  region: string;
  ua: string;
  count: number;
  duration_seconds: number;
  first_seen: string;
  platforms: Record<string, number>;
  requests: { url: string; path: string; platform: string; status: number | null; time: string; method: string }[];
}
interface RequestRow {
  time: string;
  ip: string;
  country: string;
  country_code: string;
  platform: string;
  method: string;
  status: number | null;
  error?: string;
  url?: string;
  path?: string;
}

type ViewId = "overview" | "traffic" | "health" | "sessions" | "requests";

function fetchJSON(url: string) {
  return fetch(url).then(async (res) => {
    if (res.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function fmtHMS(secs?: number | null) {
  if (secs === null || secs === undefined) return "—";
  if (secs < 5) return "just now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function flagOf(code?: string) {
  return code && code.length === 2
    ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)))
    : "🌐";
}

export default function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<ViewId>("overview");
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<{ apis: HealthApi[] } | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [platformFilter, setPlatformFilter] = useState("");
  const [liveLabel, setLiveLabel] = useState("Live");
  const [openSessions, setOpenSessions] = useState<Record<string, boolean>>({});
  const viewRef = useRef<ViewId>("overview");
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const loadOverview = useCallback(async () => {
    try {
      const s = (await fetchJSON("/api/admin/stats")) as Stats;
      setStats(s);
    } catch {
      /* ignore */
    }
  }, []);

  const loadSessionsOverview = useCallback(async () => {
    try {
      const d = (await fetchJSON("/api/admin/sessions?limit=50")) as { sessions: SessionRow[] };
      setSessions(d.sessions || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const h = (await fetchJSON("/api/admin/health")) as { apis: HealthApi[] };
      setHealth(h);
    } catch {
      /* ignore */
    }
  }, []);

  const loadSessions = loadSessionsOverview;

  const loadRequests = useCallback(async () => {
    try {
      const d = (await fetchJSON("/api/admin/requests?limit=200" + (platformFilter ? "&platform=" + platformFilter : ""))) as {
        requests: RequestRow[];
      };
      setRequests(d.requests || []);
    } catch {
      /* ignore */
    }
  }, [platformFilter]);

  const refreshAll = useCallback(async () => {
    try {
      await loadOverview();
    } catch {
      /* ignore */
    }
    try {
      await loadSessionsOverview();
    } catch {
      /* ignore */
    }
    setLiveLabel("Updated " + new Date().toLocaleTimeString());
  }, [loadOverview, loadSessionsOverview]);

  // initial load + ping
  useEffect(() => {
    fetch("/api/admin/ping").catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch on mount
    void loadOverview();
     
    void loadSessionsOverview();
  }, [loadOverview, loadSessionsOverview]);

  // view-specific loads
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch on view change
    if (view === "traffic") void loadOverview();
     
    if (view === "health") void loadHealth();
     
    if (view === "sessions") void loadSessions();
     
    if (view === "requests") void loadRequests();
  }, [view, loadOverview, loadHealth, loadSessions, loadRequests]);

  // auto refresh overview every 10s
  useEffect(() => {
    const t = setInterval(() => {
      if (viewRef.current === "overview") void refreshAll();
    }, 10000);
    return () => clearInterval(t);
  }, [refreshAll]);

  const logout = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    onLogout();
  };

  const pc = stats?.platform_counts || {};
  const rps = stats && stats.uptime > 0 ? (stats.total_requests / stats.uptime).toFixed(2) : "0";
  const touched = ["youtube", "tiktok", "pinterest", "facebook"].filter((p) => (pc[p] || 0) > 0).length;

  const order: [string, string, string][] = [
    ["youtube", "YouTube", "#ef4444"],
    ["tiktok", "TikTok", "#06b6d4"],
    ["pinterest", "Pinterest", "#ec4899"],
    ["facebook", "Facebook", "#3b82f6"],
    ["other", "Other", "#8a97ad"],
  ];

  const renderSessionCard = (s: SessionRow, idx: number) => {
    const isOpen = !!openSessions[`${s.ip}-${idx}`];
    const plats =
      Object.entries(s.platforms || {}).map(([p, c]) => (
        <span key={p} className={`pill ${PLATFORM_PILL[p] || "ot"}`}>
          {PLATFORM_LABEL[p] || p} ×{c}
        </span>
      )) || <span className="mutedtxt">—</span>;
    const reqs = s.requests || [];
    const uaShort = (s.ua || "").slice(0, 60);
    return (
      <div
        key={`${s.ip}-${idx}`}
        className={`session-card${isOpen ? " open" : ""}`}
        onClick={() => setOpenSessions((m) => ({ ...m, [`${s.ip}-${idx}`]: !m[`${s.ip}-${idx}`] }))}
      >
        <div className="session-head">
          <div className="session-flag" title={s.country}>
            {s.flag || flagOf(s.country_code)}
          </div>
          <div className="session-id">
            <div className="ip">{s.ip}</div>
            <div className="loc">
              {s.city || "—"} · {s.isp || s.region || ""}
              {s.ua ? " · " + uaShort + ((s.ua || "").length > 60 ? "…" : "") : ""}
            </div>
          </div>
          <div className="stat-chip">
            <div className="v">{s.count}</div>
            <div className="l">Requests</div>
          </div>
          <div className="stat-chip">
            <div className="v">{fmtHMS(s.duration_seconds)}</div>
            <div className="l">On site</div>
          </div>
          <div className="stat-chip">
            <div className="v">{reqs.length}</div>
            <div className="l">Logged</div>
          </div>
          <div className="stat-chip">
            <div className="v" style={{ fontSize: 13, fontFamily: "monospace" }}>
              {(s.first_seen || "").split(" ")[1] || ""}
            </div>
            <div className="l">Start</div>
          </div>
          <div style={{ color: "var(--amuted)", fontSize: 14, transition: "transform .2s", transform: isOpen ? "rotate(90deg)" : "none" }}>
            ▶
          </div>
        </div>
        <div className="session-body">
          <div className="platform-map">{plats}</div>
          <div className="mini-grid">
            <div className="m-chip">
              <b>{s.country}</b>
              <span>Country</span>
            </div>
            <div className="m-chip">
              <b>{s.country_code || "—"}</b>
              <span>Code</span>
            </div>
            <div className="m-chip">
              <b>{s.city || "—"}</b>
              <span>City</span>
            </div>
            <div className="m-chip">
              <b>{s.isp || "—"}</b>
              <span>ISP</span>
            </div>
            <div className="m-chip">
              <b>{s.region || "—"}</b>
              <span>Region</span>
            </div>
            <div className="m-chip">
              <b>{fmtHMS(s.duration_seconds)}</b>
              <span>Duration</span>
            </div>
            <div className="m-chip">
              <b>{s.count}</b>
              <span>Total reqs</span>
            </div>
          </div>
          <div className="req-list" style={{ marginTop: 14 }}>
            {reqs.length ? (
              reqs.map((r, i) => (
                <div className="req-item" key={i}>
                  <span className="time">{r.time || "—"}</span>
                  <span className="method">{r.method || "GET"}</span>
                  <span className="url" title={r.url || r.path || ""}>
                    {r.url || r.path || ""}
                  </span>
                  <span className="st">
                    {r.status !== undefined && r.status !== null ? (
                      <b className={r.status >= 400 ? "status-err" : "status-ok"}>{r.status}</b>
                    ) : null}
                  </span>
                </div>
              ))
            ) : (
              <div className="mutedtxt">No requests recorded</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="dash">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">EP</div>
          <div>
            <b>EliteProtech</b>
            <small>Admin Panel</small>
          </div>
        </div>
        <nav className="dash-nav">
          <a className={view === "overview" ? "active" : ""} onClick={() => setView("overview")}>
            <span className="ico">📊</span> Overview
          </a>
          <a className={view === "traffic" ? "active" : ""} onClick={() => setView("traffic")}>
            <span className="ico">🌍</span> Traffic / Countries
          </a>
          <a className={view === "health" ? "active" : ""} onClick={() => setView("health")}>
            <span className="ico">🩺</span> API Health
          </a>
          <a className={view === "sessions" ? "active" : ""} onClick={() => setView("sessions")}>
            <span className="ico">🖥️</span> Visitor Profiles
          </a>
          <a className={view === "requests" ? "active" : ""} onClick={() => setView("requests")}>
            <span className="ico">🕸️</span> Request Log
          </a>
        </nav>
        <div className="spacer" />
        <button className="logout-btn" onClick={() => void logout()}>
          <span className="ico">⏻</span> Logout
        </button>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1>Command Center</h1>
            <div className="sub">Real-time analytics · every IP has a full profile</div>
          </div>
          <div className="header-row">
            <div className="live">
              <span className="ldot" />
              <span>{liveLabel}</span>
            </div>
            <button className="dbtn ghost" onClick={() => void refreshAll()}>
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* OVERVIEW */}
        <div className={view === "overview" ? "" : "hidden"}>
          <div className="dgrid g4">
            <div className="dcard stat">
              <div className="label">Total Requests</div>
              <div className="value">
                {(stats?.total_requests ?? 0).toLocaleString()} <small>req/min ~{rps}</small>
              </div>
              <div className="trend">all platforms</div>
            </div>
            <div className="dcard stat">
              <div className="label">Unique Visitors</div>
              <div className="value">
                {(stats?.unique_ips ?? 0).toLocaleString()} <small>visitors</small>
              </div>
              <div className="trend">active IPs</div>
            </div>
            <div className="dcard stat">
              <div className="label">Platforms Hit</div>
              <div className="value">{touched}/4</div>
              <div className="trend">yt/tt/pin/fb</div>
            </div>
            <div className="dcard stat">
              <div className="label">Uptime</div>
              <div className="value">{fmtHMS(stats?.uptime)}</div>
              <div className="trend">since start</div>
            </div>
          </div>

          <div className="section-title">Platform Distribution</div>
          <div className="dgrid g2">
            <div className="dcard">
              <h3>🎬 Requests by Platform</h3>
              {order.map(([k, lbl, color]) => {
                const v = pc[k] || 0;
                const max = Math.max(1, ...order.map(([kk]) => pc[kk] || 0));
                const pct = Math.round((v / max) * 100);
                return (
                  <div className="bar-row" key={k}>
                    <div className="lbl">
                      <span>{lbl}</span>
                      <span>
                        {v.toLocaleString()} · {pct}%
                      </span>
                    </div>
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="dcard">
              <h3>🕐 Hourly Traffic</h3>
              <div className="chart">
                {(() => {
                  const hourly = Object.entries(stats?.hourly_traffic || {});
                  const hm = Math.max(1, ...hourly.map(([, v]) => v));
                  if (!hourly.length)
                    return (
                      <span className="mutedtxt" style={{ flex: 1, textAlign: "center", padding: 30 }}>
                        No traffic yet
                      </span>
                    );
                  return hourly.map(([k, v]) => {
                    const hh = k.split("T")[1] || k;
                    return (
                      <div className="bar-c" key={k} title={`${k}: ${v}`}>
                        <div className="h" style={{ height: `${Math.max(2, (v / hm) * 100)}%` }} />
                        <div className="lbl">{hh}</div>
                      </div>
                    );
                  });
                })()}
              </div>
              <div className="stats-note">Last 24 hours request volume</div>
            </div>
          </div>

          <div className="section-title">
            👥 Visitor Profiles{" "}
            <span className="mutedtxt" style={{ fontSize: 12, fontWeight: 400 }}>
              · click a profile to expand raw requests
            </span>
          </div>
          <div>{sessions.length ? sessions.map((s, i) => renderSessionCard(s, i)) : <div className="dcard mutedtxt">No visitors yet.</div>}</div>
        </div>

        {/* TRAFFIC */}
        <div className={view === "traffic" ? "" : "hidden"}>
          <div className="section-title">Top Countries</div>
          <div className="dcard">
            {stats?.countries?.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>Flag</th>
                      <th>Country</th>
                      <th>Code</th>
                      <th>Requests</th>
                      <th>Visitors</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {stats.countries.map((c) => {
                      const max = Math.max(1, ...stats.countries.map((x) => x.count));
                      const pct = Math.round((c.count / max) * 100);
                      return (
                        <tr key={c.code}>
                          <td>
                            <span className="flag">{c.flag}</span>
                          </td>
                          <td>
                            <b>{c.country}</b>
                          </td>
                          <td className="mono mutedtxt">{c.code}</td>
                          <td>
                            <b>{c.count.toLocaleString()}</b>
                          </td>
                          <td className="mutedtxt">{c.ips}</td>
                          <td style={{ width: "35%" }}>
                            <div className="bar">
                              <div className="bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mutedtxt">No traffic recorded yet.</div>
            )}
          </div>
          <div className="section-title">Daily Traffic</div>
          <div className="dcard">
            <div className="chart" style={{ height: 150 }}>
              {(() => {
                const daily = Object.entries(stats?.daily_traffic || {}).slice(-15);
                const dm = Math.max(1, ...daily.map(([, v]) => v));
                if (!daily.length)
                  return (
                    <span className="mutedtxt" style={{ flex: 1, textAlign: "center", padding: 30 }}>
                      No data
                    </span>
                  );
                return daily.map(([k, v]) => {
                  const d = k.slice(5);
                  return (
                    <div className="bar-c" key={k} title={`${k}: ${v}`}>
                      <div className="h" style={{ height: `${Math.max(2, (v / dm) * 100)}%` }} />
                      <div className="lbl">{d}</div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>

        {/* HEALTH */}
        <div className={view === "health" ? "" : "hidden"}>
          <div className="section-title">API Health Status</div>
          <div className="dcard">
            {!health?.apis?.length ? (
              <div className="mutedtxt">Health checks running... refresh shortly.</div>
            ) : (
              health.apis.map((a) => (
                <div className="health-item" key={a.name}>
                  <div className={`status-dot ${a.status}`} />
                  <div className="health-info">
                    <div className="name">
                      {a.name}{" "}
                      <span className={`pill ${PLATFORM_PILL[a.platform] || "ot"}`}>{PLATFORM_LABEL[a.platform] || a.platform}</span>
                    </div>
                    <div className="meta">
                      Last check: {a.last_check || "—"}
                      {a.error ? (
                        <>
                          {" · "}
                          <span style={{ color: "var(--ared)" }}>{a.error}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="latency">{a.status === "down" ? "DOWN" : a.latency !== null ? a.latency + "ms" : "—"}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* SESSIONS */}
        <div className={view === "sessions" ? "" : "hidden"}>
          <div className="section-title">
            Visitor Profiles{" "}
            <span className="mutedtxt" style={{ fontSize: 12, fontWeight: 400 }}>
              · per IP · click to expand raw requests
            </span>
          </div>
          <div>
            {sessions.length ? (
              sessions.map((s, i) => renderSessionCard(s, i))
            ) : (
              <div className="dcard mutedtxt">No visitors yet — jaldi kisi ko site use karne dein.</div>
            )}
          </div>
        </div>

        {/* REQUESTS */}
        <div className={view === "requests" ? "" : "hidden"}>
          <div className="section-title">Request Log</div>
          <div className="dcard">
            <div className="filter" style={{ marginBottom: 12, marginLeft: 0 }}>
              <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
                <option value="">All platforms</option>
                <option value="youtube">YouTube</option>
                <option value="tiktok">TikTok</option>
                <option value="pinterest">Pinterest</option>
                <option value="facebook">Facebook</option>
                <option value="other">Other</option>
              </select>
              <button className="dbtn ghost" onClick={() => void loadRequests()}>
                Filter
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>IP</th>
                    <th>Country</th>
                    <th>Platform</th>
                    <th>Method</th>
                    <th>Status</th>
                    <th>Path / URL</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.length ? (
                    requests.map((r, i) => (
                      <tr key={i}>
                        <td className="mutedtxt" style={{ whiteSpace: "nowrap" }}>
                          {r.time}
                        </td>
                        <td className="mono">{r.ip}</td>
                        <td>
                          <span className="flag" style={{ fontSize: 15 }}>
                            {flagOf(r.country_code)}
                          </span>{" "}
                          {r.country}
                        </td>
                        <td>
                          <span className={`pill ${PLATFORM_PILL[r.platform] || "ot"}`}>{PLATFORM_LABEL[r.platform] || r.platform}</span>
                        </td>
                        <td className="mono">{r.method || "GET"}</td>
                        <td className={r.status !== null && r.status >= 400 ? "status-err" : "status-ok"}>
                          {r.status ?? "—"}
                          {r.error ? <span className="error-text">{r.error}</span> : null}
                        </td>
                        <td
                          className="mono"
                          style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={r.url || r.path || ""}
                        >
                          {r.url || r.path || ""}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="mutedtxt">
                        No requests
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
