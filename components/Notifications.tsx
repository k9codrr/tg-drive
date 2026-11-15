"use client";

import { Bell, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate, msg } from "./drive/lib";
import { Secret } from "./Share";

type Note = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  data: { teamId?: string; inviteId?: string; shareId?: string; itemKind?: "file" | "folder"; itemId?: string } | null;
  password: string | null; // share password, only ever sent to you as the recipient
  readAt: string | null;
  createdAt: string;
};

const POLL_MS = 60_000;

/** Bell in the top bar: unread count, and a panel with your notifications (team invites can be answered here). */
export default function NotificationsBell({
  onChanged,
  onOpenTeam,
  onOpenShare,
}: {
  onChanged: () => void;
  onOpenTeam: (teamId: string) => void;
  onOpenShare: (kind: "file" | "folder", id: string) => void;
}) {
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ unread: number; items: Note[] }>("/api/notifications");
      setItems(r.items);
      setUnread(r.unread);
    } catch {
      /* the bell just stays as it was */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markAll = async () => {
    try {
      await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ all: true }) });
      setItems((list) => list.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      setUnread(0);
    } catch (e) {
      setError(msg(e));
    }
  };

  const markRead = (n: Note) => {
    if (n.readAt) return;
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    setUnread((u) => Math.max(0, u - 1));
    void api("/api/notifications", { method: "PATCH", body: JSON.stringify({ ids: [n.id] }) }).catch(() => {});
  };

  const answer = async (n: Note, accept: boolean) => {
    if (!n.data?.inviteId) return;
    setError(null);
    try {
      await api(`/api/invites/${n.data.inviteId}`, { method: "POST", body: JSON.stringify({ accept }) });
      setAnswered((a) => ({ ...a, [n.id]: accept ? "Joined" : "Declined" }));
      markRead(n);
      onChanged();
    } catch (e) {
      setError(msg(e));
    }
  };

  const r = btn.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="iconBtn"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Notifications"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
        style={{ position: "relative" }}
      >
        <Bell size={18} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 999,
              background: "var(--danger)",
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "16px",
              textAlign: "center",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          className="menu"
          role="dialog"
          aria-label="Notifications"
          style={{
            top: (r?.bottom ?? 48) + 6,
            right: Math.max(16, window.innerWidth - (r?.right ?? window.innerWidth - 16)),
            width: "min(360px, calc(100vw - 32px))",
            maxHeight: "70vh",
            overflow: "auto",
          }}
        >
          <div className="acctTop" style={{ padding: "4px 8px" }}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <button type="button" className="linkBtn small" onClick={() => void markAll()}>
                <Check size={14} aria-hidden /> Mark all read
              </button>
            )}
          </div>
          {error && (
            <p className="fieldError" role="alert" style={{ padding: "0 8px" }}>
              {error}
            </p>
          )}
          {items.length === 0 ? (
            <p className="muted small" style={{ padding: 8 }}>
              Nothing yet. Team invites, shares and changes to your access show up here.
            </p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className="acct"
                style={{ padding: "8px", opacity: n.readAt ? 0.75 : 1 }}
                onMouseEnter={() => markRead(n)}
              >
                <div className="acctTop">
                  <strong style={{ whiteSpace: "normal" }}>{n.title}</strong>
                  {!n.readAt && <span className="badge warn">new</span>}
                </div>
                {n.body && <div className="small muted">{n.body}</div>}
                {n.password && (
                  <div title="Only you can see this password">
                    <Secret value={n.password} />
                  </div>
                )}
                {(n.kind === "share" || n.kind === "share.changed") && n.data?.itemKind && n.data.itemId && (
                  <button
                    type="button"
                    className="linkBtn small"
                    onClick={() => {
                      setOpen(false);
                      onOpenShare(n.data!.itemKind!, n.data!.itemId!);
                    }}
                  >
                    Open
                  </button>
                )}
                <div className="small muted">{formatDate(n.createdAt)}</div>
                {n.kind === "team.invite" && n.data?.inviteId && (
                  <div className="modalActions">
                    {answered[n.id] ? (
                      <span className="small muted">{answered[n.id]}</span>
                    ) : (
                      <>
                        <button type="button" className="btn primary" onClick={() => void answer(n, true)}>
                          Join
                        </button>
                        <button type="button" className="btn ghost" onClick={() => void answer(n, false)}>
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                )}
                {n.data?.teamId && (n.kind === "team.role" || n.kind === "team.joined" || answered[n.id] === "Joined") && (
                  <button
                    type="button"
                    className="linkBtn small"
                    onClick={() => {
                      setOpen(false);
                      onOpenTeam(n.data!.teamId!);
                    }}
                  >
                    Open team
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
