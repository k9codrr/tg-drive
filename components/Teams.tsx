"use client";

import { ArrowLeft, Check, LogOut, Mail, Pencil, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { can, canManage, type Role, ROLE_INFO, ROLES } from "../lib/rbac";
import { api, formatBytes, msg } from "./drive/lib";
import ConnectionsPanel from "./Connections";
import { Modal } from "./drive/ui";

export type TeamSummary = { id: string; name: string; role: Role; members: number };
type Invite = { id: string; role: Role; createdAt: string; team: { id: string; name: string }; invitedBy: string };
type Member = { userId: string; name: string | null; email: string; role: Role; joinedAt: string; you: boolean };
type PendingInvite = { id: string; email: string; role: Role; createdAt: string; invitedBy: string };
type Detail = {
  id: string;
  name: string;
  role: Role;
  stats: { files: number; bytes: number };
  members: Member[];
  invites: PendingInvite[];
  sso: { domain: string | null; role: Role };
};

/** Teams screen: your teams and invites; open one to manage members, roles and invites. */
export default function TeamsModal({
  initialTeam,
  myId,
  onClose,
  onChanged,
  onOpen,
}: {
  initialTeam: string | null;
  myId: string | null;
  onClose: () => void;
  /** Something changed; `left` = id of a team you're no longer in (left or deleted). */
  onChanged: (left?: string) => void;
  onOpen: (teamId: string) => void;
}) {
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [selected, setSelected] = useState<string | null>(initialTeam);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const loadTeams = useCallback(async () => {
    try {
      const r = await api<{ teams: TeamSummary[]; invites: Invite[] }>("/api/teams");
      setTeams(r.teams);
      setInvites(r.invites);
    } catch (e) {
      setError(msg(e));
    }
  }, []);
  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    }
  };

  const create = () =>
    run(async () => {
      const t = await api<{ id: string }>("/api/teams", { method: "POST", body: JSON.stringify({ name: newName }) });
      setNewName("");
      await loadTeams();
      onChanged();
      setSelected(t.id);
    });

  const answer = (inv: Invite, accept: boolean) =>
    run(async () => {
      await api(`/api/invites/${inv.id}`, { method: "POST", body: JSON.stringify({ accept }) });
      await loadTeams();
      onChanged();
    });

  if (selected) {
    return (
      <TeamDetail
        teamId={selected}
        myId={myId}
        onBack={() => {
          setSelected(null);
          void loadTeams();
        }}
        onClose={onClose}
        onChanged={onChanged}
        onOpen={onOpen}
      />
    );
  }

  return (
    <Modal title="Teams" onClose={onClose} wide>
      <p className="muted small">
        A team has its own shared space next to My Drive. Everyone in it sees the same files; what each person can
        do depends on their role.
      </p>

      {invites.length > 0 && (
        <>
          <h3 className="small">Invites for you</h3>
          {invites.map((inv) => (
            <div className="acct" key={inv.id}>
              <div className="acctTop">
                <strong className="withIcon">
                  <Mail size={16} aria-hidden /> {inv.team.name}
                </strong>
                <span className="badge">{ROLE_INFO[inv.role]?.label ?? inv.role}</span>
              </div>
              <div className="muted small">
                {inv.invitedBy} invited you · {new Date(inv.createdAt).toLocaleDateString()}
              </div>
              <div className="modalActions">
                <button type="button" className="btn primary" onClick={() => void answer(inv, true)}>
                  <Check size={16} aria-hidden /> Join
                </button>
                <button type="button" className="btn ghost" onClick={() => void answer(inv, false)}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <h3 className="small">Your teams</h3>
      {teams == null ? (
        <p className="muted">Loading…</p>
      ) : teams.length === 0 ? (
        <p className="muted small">You're not in any team yet. Create one below.</p>
      ) : (
        teams.map((t) => (
          <div className="acct" key={t.id}>
            <div className="acctTop">
              <strong className="withIcon">
                <Users size={16} aria-hidden /> {t.name}
              </strong>
              <span className="badge">{ROLE_INFO[t.role].label}</span>
            </div>
            <div className="muted small">
              {t.members} member{t.members === 1 ? "" : "s"}
            </div>
            <div className="modalActions">
              <button type="button" className="btn" onClick={() => onOpen(t.id)}>
                Open files
              </button>
              <button type="button" className="btn ghost" onClick={() => setSelected(t.id)}>
                Members & settings
              </button>
            </div>
          </div>
        ))
      )}

      <form
        className="modalActions"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New team name" aria-label="New team name" maxLength={80} />
        <button className="btn primary" type="submit" disabled={!newName.trim()}>
          <Plus size={16} aria-hidden /> Create team
        </button>
      </form>

      {error && (
        <p className="fieldError" role="alert">
          {error}
        </p>
      )}

      <RolesTable />
    </Modal>
  );
}

function RolesTable() {
  return (
    <details className="acct">
      <summary className="small">What each role can do</summary>
      <ul className="small" style={{ paddingLeft: 18, marginTop: 8 }}>
        {ROLES.map((r) => (
          <li key={r}>
            <strong>{ROLE_INFO[r].label}</strong>: {ROLE_INFO[r].summary}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TeamDetail({
  teamId,
  myId,
  onBack,
  onClose,
  onChanged,
  onOpen,
}: {
  teamId: string;
  myId: string | null;
  onBack: () => void;
  onClose: () => void;
  onChanged: (left?: string) => void;
  onOpen: (teamId: string) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(`/api/teams/${teamId}`));
    } catch (e) {
      setError(msg(e));
    }
  }, [teamId]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(msg(e));
    }
  };

  const role = d?.role ?? "viewer";
  const invitable = ROLES.filter((r) => r !== "owner" && canManage(role, null, r));

  const sendInvite = () =>
    run(async () => {
      const r = await api<{ hasAccount: boolean }>(`/api/teams/${teamId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role: inviteRole }),
      });
      setNote(
        r.hasAccount
          ? `Invited ${email}. They'll see it in their notifications.`
          : `Invited ${email}. They'll see the invite after they sign up with that email.`,
      );
      setEmail("");
      await load();
    });

  const setRole = (m: Member, next: Role) => {
    if (next === "owner" && !window.confirm(`Make ${m.name || m.email} the owner? You'll become an admin.`)) return;
    void run(async () => {
      await api(`/api/teams/${teamId}/members/${m.userId}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      await load();
      onChanged();
    }, `${m.name || m.email} is now ${ROLE_INFO[next].label}.`);
  };

  const remove = (m: Member) => {
    const self = m.you;
    const q = self ? `Leave ${d?.name}? You'll lose access to its files.` : `Remove ${m.name || m.email} from ${d?.name}? Files they added stay in the team.`;
    if (!window.confirm(q)) return;
    void run(async () => {
      await api(`/api/teams/${teamId}/members/${m.userId}`, { method: "DELETE" });
      if (self) {
        onChanged(teamId);
        onBack();
        return;
      }
      await load();
      onChanged();
    });
  };

  const cancelInvite = (i: PendingInvite) =>
    run(async () => {
      await api(`/api/teams/${teamId}/invites/${i.id}`, { method: "DELETE" });
      await load();
    });

  const rename = () =>
    run(async () => {
      await api(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify({ name: renaming }) });
      setRenaming(null);
      await load();
      onChanged();
    });

  const deleteTeam = () => {
    if (!d) return;
    const typed = window.prompt(
      `This deletes "${d.name}" and all ${d.stats.files} file(s) in it, for good. Type the team name to confirm.`,
    );
    if (typed !== d.name) return;
    void run(async () => {
      await api(`/api/teams/${teamId}`, { method: "DELETE" });
      onChanged(teamId);
      onBack();
    });
  };

  const me = d?.members.find((m) => m.you || m.userId === myId);

  return (
    <Modal
      title={
        <span className="withIcon">
          <button type="button" className="linkBtn" onClick={onBack} aria-label="Back to teams">
            <ArrowLeft size={18} aria-hidden />
          </button>
          {d?.name ?? "Team"}
        </span>
      }
      onClose={onClose}
      wide
    >
      {!d ? (
        error ? (
          <p className="fieldError" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : (
        <>
          <div className="acctTop">
            <span className="muted small">
              You're <strong>{ROLE_INFO[role].label}</strong> · {d.stats.files.toLocaleString()} files ·{" "}
              {formatBytes(d.stats.bytes)}
            </span>
            <button type="button" className="btn" onClick={() => onOpen(teamId)}>
              Open files
            </button>
          </div>

          {can(role, "manageTeam") &&
            (renaming == null ? (
              <button type="button" className="linkBtn small" onClick={() => setRenaming(d.name)}>
                <Pencil size={14} aria-hidden /> Rename team
              </button>
            ) : (
              <form
                className="modalActions"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename();
                }}
              >
                <input value={renaming} onChange={(e) => setRenaming(e.target.value)} aria-label="Team name" maxLength={80} autoFocus />
                <button className="btn primary" type="submit">
                  Save
                </button>
                <button className="btn ghost" type="button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ))}

          {invitable.length > 0 && (
            <form
              className="modalActions"
              onSubmit={(e) => {
                e.preventDefault();
                void sendInvite();
              }}
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email to invite"
                aria-label="Email to invite"
              />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Role">
                {invitable.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_INFO[r].label}
                  </option>
                ))}
              </select>
              <button className="btn primary" type="submit" disabled={!email.trim()}>
                <UserPlus size={16} aria-hidden /> Invite
              </button>
            </form>
          )}

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

          <h3 className="small">Members ({d.members.length})</h3>
          {d.members.map((m) => {
            const options = ROLES.filter((r) => r === m.role || canManage(role, m.role, r));
            const editable = !m.you && options.length > 1;
            const removable = !m.you && canManage(role, m.role, null);
            return (
              <div className="acct" key={m.userId}>
                <div className="acctTop">
                  <strong>
                    {m.name || m.email}
                    {m.you ? " (you)" : ""}
                  </strong>
                  {editable ? (
                    <select value={m.role} onChange={(e) => setRole(m, e.target.value as Role)} aria-label={`Role of ${m.name || m.email}`}>
                      {options.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_INFO[r].label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="badge">{ROLE_INFO[m.role].label}</span>
                  )}
                </div>
                <div className="acctTop">
                  <span className="muted small">
                    {m.email} · joined {new Date(m.joinedAt).toLocaleDateString()}
                  </span>
                  {removable && (
                    <button type="button" className="linkBtn small danger" onClick={() => remove(m)}>
                      <X size={14} aria-hidden /> Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {d.invites.length > 0 && (
            <>
              <h3 className="small">Pending invites</h3>
              {d.invites.map((i) => (
                <div className="acct" key={i.id}>
                  <div className="acctTop">
                    <strong className="withIcon">
                      <Mail size={16} aria-hidden /> {i.email}
                    </strong>
                    <span className="badge">{ROLE_INFO[i.role]?.label ?? i.role}</span>
                  </div>
                  <div className="acctTop">
                    <span className="muted small">
                      invited by {i.invitedBy} · {new Date(i.createdAt).toLocaleDateString()}
                    </span>
                    {(canManage(role, i.role, null) || can(role, "manageTeam")) && (
                      <button type="button" className="linkBtn small danger" onClick={() => void cancelInvite(i)}>
                        Cancel invite
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {can(role, "manageTeam") && (
            <TeamSync
              key={`${d.sso.domain}|${d.sso.role}`}
              current={d.sso}
              invitable={ROLES.filter((r) => r !== "owner" && r !== "admin")}
              onSave={(body) =>
                run(async () => {
                  await api(`/api/teams/${teamId}`, { method: "PATCH", body: JSON.stringify(body) });
                  await load();
                }, body.ssoDomain ? `People from ${body.ssoDomain} who sign in with SSO now join automatically.` : "Team sync turned off.")
              }
            />
          )}

          <ConnectionsPanel teamId={teamId} teamName={d.name} />

          <RolesTable />

          <div className="modalActions">
            {me && me.role !== "owner" && (
              <button type="button" className="btn ghost" onClick={() => remove(me)}>
                <LogOut size={16} aria-hidden /> Leave team
              </button>
            )}
            {can(role, "deleteTeam") && (
              <button type="button" className="btn ghost danger" onClick={deleteTeam}>
                <Trash2 size={16} aria-hidden /> Delete team
              </button>
            )}
          </div>
          <p className="muted small">
            Files stay stored where they were uploaded (for example in the uploader's Google Drive or Telegram). If
            someone leaves, their uploads stay in the team.
          </p>
        </>
      )}
    </Modal>
  );
}

/** Team sync: SSO users with a verified email at the team's domain join automatically. */
function TeamSync({
  current,
  invitable,
  onSave,
}: {
  current: { domain: string | null; role: Role };
  invitable: Role[];
  onSave: (body: { ssoDomain: string; ssoRole: Role }) => void;
}) {
  const [domain, setDomain] = useState(current.domain ?? "");
  const [joinRole, setJoinRole] = useState<Role>(current.role);
  return (
    <form
      className="acct formStack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ssoDomain: domain.trim(), ssoRole: joinRole });
      }}
    >
      <strong className="small">Team sync (single sign-on)</strong>
      <p className="muted small">
        Everyone who signs in with SSO (Google / Microsoft / your company login) using a verified email at this domain
        joins the team automatically. It must be your own email&apos;s domain; public ones like gmail.com aren&apos;t
        allowed.
      </p>
      <div className="modalActions">
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com (empty = off)" aria-label="Email domain" />
        <select value={joinRole} onChange={(e) => setJoinRole(e.target.value as Role)} aria-label="Role for people who join this way">
          {invitable.map((r) => (
            <option key={r} value={r}>
              join as {ROLE_INFO[r].label}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Save
        </button>
      </div>
    </form>
  );
}
