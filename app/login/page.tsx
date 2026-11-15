"use client";

import { useEffect, useState, type FormEvent } from "react";

type Mode = "login" | "signup";

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [policy, setPolicy] = useState<{ allowed: boolean; needsCode: boolean } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "signup") setMode("signup");
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((d) => setPolicy(d.signup))
      .catch(() => setPolicy({ allowed: true, needsCode: false }));
  }, []);

  const signup = mode === "signup";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (signup && password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    const res = await fetch(signup ? "/api/auth/signup" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signup ? { name, email, password, code } : { email, password }),
    }).catch(() => null);
    if (res?.ok) {
      window.location.href = "/";
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    setError(data.error || "Something went wrong, try again");
    setBusy(false);
  }

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
  };

  return (
    <div className="loginWrap">
      <form className="loginCard" onSubmit={submit}>
        <h1>✈️ TG Drive</h1>
        <p className="muted">
          {signup ? "Create your account" : "Sign in to your storage"}: Telegram, Cloudflare R2 and Google Drive in
          one place.
        </p>

        {policy?.allowed && (
          <div className="tabs">
            <button type="button" className={!signup ? "active" : ""} onClick={() => switchMode("login")}>
              Sign in
            </button>
            <button type="button" className={signup ? "active" : ""} onClick={() => switchMode("signup")}>
              Sign up
            </button>
          </div>
        )}

        {signup && (
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        )}
        <input
          type="email"
          required
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          type="password"
          required
          minLength={signup ? 8 : undefined}
          placeholder={signup ? "Password (min 8 characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={signup ? "new-password" : "current-password"}
        />
        {signup && (
          <input
            type="password"
            required
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        )}
        {signup && policy?.needsCode && (
          <input required placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        <button className="primary" disabled={busy}>
          {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
        </button>
        {error && <p className="error">{error}</p>}
        {policy && !policy.allowed && <p className="muted small">New sign-ups are closed on this server.</p>}
      </form>
    </div>
  );
}
