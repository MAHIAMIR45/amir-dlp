"use client";

// Admin login — port of templates/admin_login.html.
import { useState } from "react";

export default function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showError, setShowError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowError(false);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      setShowError(true);
    } catch {
      setShowError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="al-wrap">
      <div className="al-grid" />
      <div className="al-glow al-glow-1" />
      <div className="al-glow al-glow-2" />

      <div className="al-card">
        <div className="al-logo">
          <div className="al-mark">EP</div>
          <h1>Admin Control</h1>
          <p>EliteProtech Downloader · Restricted</p>
        </div>
        <div className={`al-error${showError ? " show" : ""}`}>Invalid username or password</div>
        <form onSubmit={submit}>
          <div className="al-field">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="Enter username"
            />
          </div>
          <div className="al-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Enter password"
            />
          </div>
          <button className="al-btn" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign In →"}
          </button>
        </form>
        <div className="al-foot">Authorized personnel only</div>
      </div>
    </div>
  );
}
