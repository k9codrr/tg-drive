"use client";

import { Eye, EyeOff, HardDrive, KeyRound, Loader2 } from "lucide-react";
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
  const [showPw, setShowPw] = useState(false);
  const [sso, setSso] = useState<{ id: string; name: string }[]>([]);
  const [passwordOn, setPasswordOn] = useState(true);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("mode") === "signup") setMode("signup");
    if (qs.get("error")) setError(qs.get("error")!); // from a failed single sign-on
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((d) => {
        setPolicy(d.signup);
        setSso(Array.isArray(d.sso) ? d.sso : []);
        setPasswordOn(d.password !== false);
      })
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
    if (!res) {
      setError(navigator.onLine ? "Can't reach the server. Check that TG Drive is running and try again." : "You're offline. Connect to the internet and try again.");
      setBusy(false);
      return;
    }
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(
      data.error ||
        (res.status >= 500 ? "The server had a problem. Try again in a moment." : "Something went wrong, try again"),
    );
    setBusy(false);
  }

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
  };

  return (
    <div className="loginWrap">
      <form className="loginCard" onSubmit={submit}>
        <div className="loginBrand">
          <span className="brandMark" aria-hidden>
            <HardDrive size={18} />
          </span>
          <h1>TG Drive</h1>
        </div>
        <p className="muted">
          {signup ? "Create your account" : "Sign in to your storage"}: Telegram, Cloudflare R2 and Google Drive in
          one place.
        </p>

        {sso.length > 0 && (
          <div className="formStack">
            {sso.map((p) => (
              <a key={p.id} className="btn" href={`/api/auth/sso/${p.id}`}>
                <KeyRound size={16} aria-hidden /> Continue with {p.name}
              </a>
            ))}
            {passwordOn && <p className="muted small" style={{ textAlign: "center" }}>or with email and password</p>}
          </div>
        )}
        {!passwordOn && error && (
          <p className="loginError" role="alert">
            {error}
          </p>
        )}
        {passwordOn && (
        <>
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
          <input placeholder="Name (optional)" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        )}
        <input
          type="email"
          required
          autoFocus={sso.length === 0}
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <div className="pwField">
          <input
            type={showPw ? "text" : "password"}
            required
            minLength={signup ? 8 : undefined}
            placeholder={signup ? "Password (min 8 characters)" : "Password"}
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? "new-password" : "current-password"}
          />
          <button
            type="button"
            className="iconBtn"
            onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? "Hide password" : "Show password"}
            title={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />}
          </button>
        </div>
        {signup && (
          <input
            type={showPw ? "text" : "password"}
            required
            placeholder="Confirm password"
            aria-label="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        )}
        {signup && policy?.needsCode && (
          <input required placeholder="Invite code" aria-label="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        {error && (
          <p className="loginError" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy && <Loader2 size={16} className="spin" aria-hidden />}
          {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
        </button>
        {policy && !policy.allowed && <p className="muted small">New sign-ups are closed on this server.</p>}
        </>
        )}
      </form>
    </div>
  );
}
