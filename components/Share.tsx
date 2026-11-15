"use client";

import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, Share2, Trash2, Wand2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { SHARE_INFO, SHARE_PERMS, SHARE_RANK, type SharePerm } from "../lib/rbac";
import { api, msg } from "./drive/lib";
import { Modal } from "./drive/ui";

type ShareRow = {
  id: string;
  permission: SharePerm;
  expiresAt: string | null;
  expired: boolean;
  to: { id: string; name: string | null; email: string };
  by: string | null;
  hasPassword: boolean;
  password: string | null;
};

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** A date picked in the form means "until the end of that day". */
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** A readable random password (no look-alike characters). */
export function makePassword(len = 12) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

/** Shows a secret masked, with reveal and copy. */
export function Secret({ value }: { value: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <span className="withIcon small" style={{ gap: 6 }}>
      <KeyRound size={14} aria-hidden />
      <code style={{ userSelect: show ? "text" : "none" }}>{show ? value : "•".repeat(Math.min(12, value.length))}</code>
      <button type="button" className="linkBtn small" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
      </button>
      <button
        type="button"
        className="linkBtn small"
        aria-label="Copy password"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {})
        }
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </span>
  );
}

/**
 * "Share" dialog for one file or folder: who has access, and a form to add someone.
 * `maxPermission` caps what you can hand out (when it was itself shared with you).
 */
export default function ShareDialog({
  item,
  maxPermission,
  onClose,
}: {
  item: { kind: "file" | "folder"; id: string; name: string; encrypted?: boolean };
  maxPermission?: SharePerm | null;
  onClose: () => void;
}) {
  const encrypted = !!item.encrypted;
  const [filePassword, setFilePassword] = useState("");
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<SharePerm>("download");
  const [usePassword, setUsePassword] = useState(encrypted);
  const [password, setPassword] = useState(() => (encrypted ? makePassword() : ""));
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const options = SHARE_PERMS.filter((p) => !maxPermission || SHARE_RANK[p] <= SHARE_RANK[maxPermission]);
  const qs = `${item.kind}=${item.id}`;

  const load = useCallback(async () => {
    try {
      setRows((await api<{ shares: ShareRow[] }>(`/api/shares?${qs}`)).shares);
    } catch (e) {
      setError(msg(e));
    }
  }, [qs]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      await load();
    } catch (e) {
      setError(msg(e));
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await run(async () => {
      const r = await api<{ updated: boolean }>("/api/shares", {
        method: "POST",
        body: JSON.stringify({
          [item.kind]: item.id,
          email,
          permission,
          password: usePassword ? password : null,
          expiresAt: endOfDay(expires),
          ...(encrypted ? { filePassword } : {}),
        }),
      });
      setNote(
        `${r.updated ? "Updated the share for" : "Shared with"} ${email}. They got a notification${
          usePassword ? " with the password (only they can see it)" : ""
        }.`,
      );
      setEmail("");
      setPassword(encrypted ? makePassword() : "");
      setUsePassword(encrypted);
      setExpires("");
    });
    setBusy(false);
  };

  const patch = (s: ShareRow, body: Record<string, unknown>, done: string) =>
    run(() => api(`/api/shares/${s.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(() => {}), done);

  const revoke = (s: ShareRow) => {
    if (!window.confirm(`Stop sharing “${item.name}” with ${s.to.name || s.to.email}?`)) return;
    void run(() => api(`/api/shares/${s.id}`, { method: "DELETE" }).then(() => {}), `Stopped sharing with ${s.to.email}.`);
  };

  const changePassword = (s: ShareRow) => {
    const p = window.prompt(
      encrypted
        ? "New password for this share (at least 8 characters):"
        : "New password for this share (leave empty to remove it):",
      makePassword(),
    );
    if (p == null) return;
    if (encrypted && !p) return setError("Shares of encrypted files need a password.");
    const fp = encrypted ? window.prompt("The file's own password (to re-wrap its key):") : null;
    if (encrypted && !fp) return;
    void patch(
      s,
      { password: p || null, ...(fp ? { filePassword: fp } : {}) },
      p ? "Password changed. They were notified." : "Password removed.",
    );
  };

  return (
    <Modal title={`Share “${item.name}”`} onClose={onClose} wide>
      <form onSubmit={add} className="formStack">
        <div className="modalActions">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email of a TG Drive user"
            aria-label="Email to share with"
            required
          />
          <select value={permission} onChange={(e) => setPermission(e.target.value as SharePerm)} aria-label="Permission">
            {options.map((p) => (
              <option key={p} value={p}>
                {SHARE_INFO[p].label}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small">{SHARE_INFO[permission].summary}</p>

        {encrypted && (
          <>
            <p className="small">
              <Lock size={14} aria-hidden /> This file is encrypted. The share password below is what decrypts it for them, so
              it&apos;s required. To create it, enter the file&apos;s own password:
            </p>
            <input
              type="password"
              value={filePassword}
              onChange={(e) => setFilePassword(e.target.value)}
              placeholder="File password"
              aria-label="The file's password"
              autoComplete="off"
              required
            />
          </>
        )}
        <label className="withIcon small">
          <input type="checkbox" checked={usePassword} disabled={encrypted} onChange={(e) => {
            setUsePassword(e.target.checked);
            if (e.target.checked && !password) setPassword(makePassword());
          }} />
          <Lock size={14} aria-hidden /> Protect with a password
        </label>
        {usePassword && (
          <div className="modalActions">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Share password"
              minLength={encrypted ? 8 : 4}
              maxLength={200}
              required
            />
            <button type="button" className="btn ghost" onClick={() => setPassword(makePassword())}>
              <Wand2 size={16} aria-hidden /> New
            </button>
          </div>
        )}
        {usePassword && (
          <p className="muted small">
            Only they will see this password, in their notification. They enter it once to open the item.
          </p>
        )}

        <label className="small">
          Access ends{" "}
          <input type="date" value={expires} min={tomorrow()} onChange={(e) => setExpires(e.target.value)} aria-label="Access ends on" />{" "}
          {expires ? (
            <button type="button" className="linkBtn small" onClick={() => setExpires("")}>
              never
            </button>
          ) : (
            <span className="muted">(never)</span>
          )}
        </label>

        <div className="modalActions end">
          <button className="btn primary" disabled={busy || !email.trim()}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden /> : <Share2 size={16} aria-hidden />} Share
          </button>
        </div>
      </form>

      {error && (
        <p className="fieldError" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="muted small" role="status">
          <Check size={14} aria-hidden /> {note}
        </p>
      )}

      <h3 className="small">People with access</h3>
      {rows == null ? (
        <p className="muted small">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted small">Not shared with anyone yet.</p>
      ) : (
        rows.map((s) => (
          <div className="acct" key={s.id}>
            <div className="acctTop">
              <strong>{s.to.name || s.to.email}</strong>
              <select
                value={s.permission}
                onChange={(e) => void patch(s, { permission: e.target.value }, `Changed to ${SHARE_INFO[e.target.value as SharePerm].label}.`)}
                aria-label={`Permission for ${s.to.email}`}
              >
                {SHARE_PERMS.filter((p) => options.includes(p) || p === s.permission).map((p) => (
                  <option key={p} value={p} disabled={!options.includes(p)}>
                    {SHARE_INFO[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="muted small">
              {s.to.email}
              {s.by ? ` · shared by ${s.by}` : ""}
              {s.expired ? " · expired" : ""}
            </div>
            <div className="acctTop">
              <label className="small">
                Until{" "}
                <input
                  type="date"
                  defaultValue={dateInput(s.expiresAt)}
                  min={tomorrow()}
                  aria-label={`Access for ${s.to.email} ends on`}
                  onBlur={(e) => {
                    if (e.target.value !== dateInput(s.expiresAt)) {
                      void patch(s, { expiresAt: endOfDay(e.target.value) }, "Expiry saved.");
                    }
                  }}
                />
              </label>
              <span className="withIcon">
                {s.password ? <Secret value={s.password} /> : s.hasPassword ? <span className="small muted"><Lock size={14} aria-hidden /> password set</span> : null}
                <button type="button" className="linkBtn small" onClick={() => changePassword(s)}>
                  {s.hasPassword ? "Change password" : "Add password"}
                </button>
                <button type="button" className="linkBtn small danger" onClick={() => revoke(s)}>
                  <Trash2 size={14} aria-hidden /> Remove
                </button>
              </span>
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}

/**
 * Asks for a password, then calls onUnlocked: a protected share (`shareId`) or an encrypted file (`fileId`,
 * which also accepts the password of a share of it made to you).
 */
export function UnlockDialog({
  shareId,
  fileId,
  name,
  onClose,
  onUnlocked,
}: {
  shareId?: string;
  fileId?: string;
  name?: string;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const url = fileId ? `/api/files/${fileId}/unlock` : `/api/shares/${shareId}/unlock`;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(url, { method: "POST", body: JSON.stringify({ password: value }) });
      onUnlocked();
      onClose();
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={name ? `Unlock “${name}”` : fileId ? "Unlock encrypted file" : "Unlock shared item"} onClose={onClose}>
      <form onSubmit={submit} className="formStack">
        <label htmlFor={id} className="fieldLabel">
          Password
        </label>
        <input id={id} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus autoComplete="off" />
        <p className="muted small">
          {fileId
            ? "This file is encrypted. Enter its password, or the password of the share you received. It stays unlocked in this browser for an hour."
            : "The password is in the notification you got about this share, and in Shared with me."}
        </p>
        {error && (
          <p className="fieldError" role="alert">
            {error}
          </p>
        )}
        <div className="modalActions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !value}>
            {busy && <Loader2 size={16} className="spin" aria-hidden />}
            Unlock
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** New password (typed twice) for encrypting a file, uploading encrypted files or changing a password. */
export function SetPasswordDialog({
  title,
  intro,
  confirmText,
  onClose,
  onSubmit,
}: {
  title: string;
  intro: string;
  confirmText: string;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void> | void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (a.length < 8) return setError("Use at least 8 characters.");
    if (a !== b) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(a);
      onClose();
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="formStack">
        <p className="muted small">{intro}</p>
        <label className="fieldLabel">
          Password
          <input type={show ? "text" : "password"} value={a} onChange={(e) => setA(e.target.value)} autoFocus autoComplete="new-password" />
        </label>
        <label className="fieldLabel">
          Same password again
          <input type={show ? "text" : "password"} value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" />
        </label>
        <div className="modalActions">
          <button type="button" className="linkBtn small" onClick={() => setShow((x) => !x)}>
            {show ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />} {show ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            className="linkBtn small"
            onClick={() => {
              const p = makePassword(16);
              setA(p);
              setB(p);
              setShow(true);
            }}
          >
            <Wand2 size={14} aria-hidden /> Suggest one
          </button>
        </div>
        <p className="small" role="note">
          <Lock size={14} aria-hidden /> A forgotten password can&apos;t be recovered: without it nobody can open the file, not
          you and not the server admin. Keep it somewhere safe.
        </p>
        {error && (
          <p className="fieldError" role="alert">
            {error}
          </p>
        )}
        <div className="modalActions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !a}>
            {busy && <Loader2 size={16} className="spin" aria-hidden />}
            {confirmText}
          </button>
        </div>
      </form>
    </Modal>
  );
}
