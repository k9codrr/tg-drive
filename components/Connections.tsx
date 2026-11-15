"use client";

import { Check, Cloud, HardDrive, Loader2, Plus, RefreshCw, Send, Server, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { api, type Connection, formatBytes, msg } from "./drive/lib";

type Kind = Connection["kind"];
type Preset = {
  id: string;
  label: string;
  kind: Kind;
  defaults?: Record<string, string>;
  guide: ReactNode;
};

const ol = (items: ReactNode[]) => (
  <ol className="small" style={{ paddingLeft: 18, margin: "6px 0" }}>
    {items.map((x, i) => (
      <li key={i} style={{ marginBottom: 3 }}>
        {x}
      </li>
    ))}
  </ol>
);

/** Step-by-step setup for each kind of storage. */
const PRESETS: Preset[] = [
  {
    id: "telegram",
    label: "Telegram bot",
    kind: "telegram",
    guide: ol([
      <>In Telegram, open <strong>@BotFather</strong>, send <code>/newbot</code>, pick a name. Copy the <strong>bot token</strong> it gives you (<code>123456:ABC…</code>).</>,
      <>Create a <strong>private channel</strong> (New Channel → Private). This is where your files are kept, 4 MB per message.</>,
      <>Channel → Administrators → <strong>Add admin</strong> → your bot, with “Post messages” and “Delete messages”.</>,
      <>Get the channel's <strong>chat id</strong>: post anything in it, then open <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> and copy <code>chat.id</code> (starts with <code>-100</code>). Or forward a channel post to <strong>@userinfobot</strong>.</>,
      <>Paste both below. TG Drive posts and deletes a test message to check it works.</>,
    ]),
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    kind: "s3",
    defaults: { region: "auto", style: "path", endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" },
    guide: ol([
      <>Cloudflare dashboard → <strong>R2</strong> → <strong>Create bucket</strong> (e.g. <code>tgdrive</code>). 10 GB are free each month.</>,
      <>R2 → <strong>Manage R2 API tokens</strong> → Create API token → permission <strong>Object Read &amp; Write</strong>, limited to that bucket.</>,
      <>Copy the <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> (shown once).</>,
      <>The endpoint is <code>https://&lt;ACCOUNT_ID&gt;.r2.cloudflarestorage.com</code>; your account id is on the R2 overview page. Region <code>auto</code>.</>,
    ]),
  },
  {
    id: "aws",
    label: "Amazon S3",
    kind: "s3",
    defaults: { region: "us-east-1", style: "virtual", endpoint: "https://s3.us-east-1.amazonaws.com" },
    guide: ol([
      <>AWS console → <strong>S3</strong> → Create bucket (keep “Block all public access” on). Note its region.</>,
      <>IAM → Users → Create user → attach a policy allowing <code>s3:PutObject</code>, <code>s3:GetObject</code>, <code>s3:DeleteObject</code> on <code>arn:aws:s3:::BUCKET/*</code>.</>,
      <>That user → Security credentials → <strong>Create access key</strong> (“Application running outside AWS”).</>,
      <>Endpoint <code>https://s3.&lt;region&gt;.amazonaws.com</code>, the same region, style “bucket in host name”.</>,
    ]),
  },
  {
    id: "b2",
    label: "Backblaze B2",
    kind: "s3",
    defaults: { region: "us-west-004", style: "path", endpoint: "https://s3.us-west-004.backblazeb2.com" },
    guide: ol([
      <>Backblaze → <strong>Buckets</strong> → Create a Bucket (private). Its page shows the <strong>S3 endpoint</strong>, e.g. <code>s3.us-west-004.backblazeb2.com</code>.</>,
      <><strong>Application Keys</strong> → Add a New Application Key, limited to that bucket, Read and Write.</>,
      <>Use <strong>keyID</strong> as access key and <strong>applicationKey</strong> as secret. Region = the middle part of the endpoint (<code>us-west-004</code>).</>,
    ]),
  },
  {
    id: "wasabi",
    label: "Wasabi",
    kind: "s3",
    defaults: { region: "us-east-1", style: "path", endpoint: "https://s3.us-east-1.wasabisys.com" },
    guide: ol([
      <>Wasabi console → <strong>Create Bucket</strong>, note the region.</>,
      <>Access Keys → <strong>Create New Access Key</strong> (or a sub-user with access to the bucket only).</>,
      <>Endpoint <code>https://s3.&lt;region&gt;.wasabisys.com</code>.</>,
    ]),
  },
  {
    id: "s3",
    label: "Other S3 (MinIO, …)",
    kind: "s3",
    defaults: { region: "us-east-1", style: "path" },
    guide: ol([
      <>Any S3-compatible service works: create a bucket and an access key that can read, write and delete objects in it.</>,
      <>Self-hosted MinIO: endpoint is your server's URL (<code>https://minio.example.com</code>), style “path”.</>,
    ]),
  },
  {
    id: "nextcloud",
    label: "Nextcloud / ownCloud",
    kind: "webdav",
    defaults: { url: "https://cloud.example.com/remote.php/dav/files/USERNAME/TGDrive" },
    guide: ol([
      <>In Nextcloud, create a folder for TG Drive, e.g. <code>TGDrive</code>.</>,
      <>Settings → Security → <strong>Create new app password</strong> (don't use your normal password).</>,
      <>Folder URL: <code>https://YOUR-SERVER/remote.php/dav/files/USERNAME/TGDrive</code> (Files → Settings shows the WebDAV address).</>,
    ]),
  },
  {
    id: "webdav",
    label: "Other WebDAV (Synology, NAS, …)",
    kind: "webdav",
    defaults: { url: "https://nas.example.com:5006/TGDrive" },
    guide: ol([
      <>Turn on the WebDAV server on your NAS (Synology: Package Center → <strong>WebDAV Server</strong>, enable HTTPS, port 5006).</>,
      <>Create a shared folder for TG Drive and a user that can read/write it.</>,
      <>Folder URL: <code>https://YOUR-NAS:5006/FOLDER</code>. It must be reachable from the TG Drive server (an IP address works, e.g. <code>https://203.0.113.5:5006/TGDrive</code>).</>,
    ]),
  },
];

const KIND_ICON: Record<Kind, typeof Send> = { telegram: Send, s3: Cloud, webdav: Server };
const KIND_LABEL: Record<Kind, string> = { telegram: "Telegram", s3: "S3", webdav: "WebDAV" };

type TeamGoogle = { id: string; email: string; limit: number | null; used: number; needsReauth: boolean; offerToMembers: boolean };

/**
 * Storage connections for you (no teamId) or for a team (teamId). Lists them with status and usage, and
 * has a form with a setup walkthrough for each kind.
 */
export default function ConnectionsPanel({ teamId, teamName }: { teamId?: string; teamName?: string }) {
  const [mine, setMine] = useState<Connection[] | null>(null);
  const [offered, setOffered] = useState<Connection[]>([]);
  const [server, setServer] = useState<{ telegram: boolean; s3: boolean } | null>(null);
  const [canManage, setCanManage] = useState(!teamId);
  const [google, setGoogle] = useState<TeamGoogle[]>([]);
  const [googleOn, setGoogleOn] = useState(false);
  const [adding, setAdding] = useState<Preset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (teamId) {
        const r = await api<{ canManage: boolean; connections: Connection[]; google: TeamGoogle[]; googleConfigured: boolean }>(
          `/api/teams/${teamId}/storage`,
        );
        setMine(r.connections);
        setCanManage(r.canManage);
        setGoogle(r.google);
        setGoogleOn(r.googleConfigured);
      } else {
        const r = await api<{ mine: Connection[]; offered: Connection[]; server: { telegram: boolean; s3: boolean } }>("/api/connections");
        setMine(r.mine);
        setOffered(r.offered);
        setServer(r.server);
      }
    } catch (e) {
      setError(msg(e));
    }
  }, [teamId]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
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

  const test = (c: Connection) =>
    run(async () => {
      const r = await api<{ ok: boolean; result: string }>(`/api/connections/${c.id}/test`, { method: "POST" });
      if (r.ok) setNote(`${c.name}: OK, ${r.result}.`);
      else throw new Error(`${c.name}: ${r.result}`);
    });
  const remove = (c: Connection) => {
    if (!window.confirm(`Remove “${c.name}”? (Only possible when no files are stored in it.)`)) return;
    void run(() => api(`/api/connections/${c.id}`, { method: "DELETE" }), `Removed ${c.name}.`);
  };
  const patch = (c: Connection, body: Record<string, unknown>, done: string) =>
    run(() => api(`/api/connections/${c.id}`, { method: "PATCH", body: JSON.stringify(body) }), done);
  const setLimit = (c: Connection) => {
    const v = window.prompt("Most TG Drive may store there, in GB (empty = no limit):", c.limit ? String(Math.round(c.limit / 1024 ** 3)) : "");
    if (v == null) return;
    void patch(c, { limitGB: v.trim() || null }, "Limit saved.");
  };

  const order = teamId
    ? `Files in ${teamName ?? "this team"}'s folders are stored here first. Admins can offer a connection to members, who then also use it for their private files when they have none of their own.`
    : "Your uploads use your own storage first. If you have none of a kind, storage your team admins offer you is used, then the server's own.";

  return (
    <section className="formStack" aria-label={teamId ? "Team storage" : "Your storage connections"}>
      <h3 className="small withIcon">
        <HardDrive size={16} aria-hidden /> {teamId ? "Team storage" : "Your own storage"}
      </h3>
      <p className="muted small">{order}</p>

      {mine == null ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          {mine.length === 0 && <p className="muted small">No connections yet.</p>}
          {mine.map((c) => (
            <ConnRow key={c.id} c={c}>
              {canManage && (
                <>
                  <button type="button" className="linkBtn small" onClick={() => void test(c)}>
                    <RefreshCw size={14} aria-hidden /> Test
                  </button>
                  <button type="button" className="linkBtn small" onClick={() => setLimit(c)}>
                    Limit
                  </button>
                  {teamId && (
                    <label className="small withIcon">
                      <input
                        type="checkbox"
                        checked={c.offerToMembers}
                        onChange={(e) =>
                          void patch(c, { offerToMembers: e.target.checked }, e.target.checked ? "Members can now use it for private files." : "No longer offered to members.")
                        }
                      />
                      Offer to members
                    </label>
                  )}
                  <button type="button" className="linkBtn small danger" onClick={() => remove(c)}>
                    <Trash2 size={14} aria-hidden /> Remove
                  </button>
                </>
              )}
            </ConnRow>
          ))}
        </>
      )}

      {teamId && (
        <>
          <h4 className="small">Team Google accounts</h4>
          {google.length === 0 && <p className="muted small">None yet.</p>}
          {google.map((g) => (
            <div className="acct" key={g.id}>
              <div className="acctTop">
                <strong className="withIcon">
                  <Cloud size={16} aria-hidden /> {g.email}
                </strong>
                <span className="muted small">
                  {g.needsReauth ? "reconnect needed" : g.limit == null ? "unlimited" : `${formatBytes(Math.max(0, g.limit - g.used))} free`}
                </span>
              </div>
              {canManage && (
                <div className="modalActions">
                  <label className="small withIcon">
                    <input
                      type="checkbox"
                      checked={g.offerToMembers}
                      onChange={(e) =>
                        void run(() => api(`/api/accounts/${g.id}`, { method: "PATCH", body: JSON.stringify({ offerToMembers: e.target.checked }) }), "Saved.")
                      }
                    />
                    Offer to members
                  </label>
                  <button
                    type="button"
                    className="linkBtn small danger"
                    onClick={() => window.confirm(`Disconnect ${g.email} from the team?`) && void run(() => api(`/api/accounts/${g.id}`, { method: "DELETE" }), "Disconnected.")}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ))}
          {canManage && googleOn && (
            <a className="btn" href={`/api/google/connect?team=${teamId}`}>
              <Plus size={16} aria-hidden /> Connect a Google account to the team
            </a>
          )}
        </>
      )}

      {!teamId && offered.length > 0 && (
        <>
          <h4 className="small">Offered by your teams</h4>
          {offered.map((c) => (
            <ConnRow key={c.id} c={c} />
          ))}
        </>
      )}

      {!teamId && server && (
        <p className="muted small">
          Server storage: Telegram {server.telegram ? "available" : "not set up"} · R2 {server.s3 ? "available" : "not set up"}.
        </p>
      )}

      {canManage &&
        (adding ? (
          <AddForm preset={adding} teamId={teamId} onCancel={() => setAdding(null)} onAdded={(t) => {
            setAdding(null);
            setNote(`Connected. Test: ${t}.`);
            void load();
          }} />
        ) : (
          <div className="formStack">
            <span className="small">Connect storage:</span>
            <div className="modalActions" style={{ flexWrap: "wrap" }}>
              {PRESETS.map((p) => {
                const Icon = KIND_ICON[p.kind];
                return (
                  <button key={p.id} type="button" className="btn ghost" onClick={() => setAdding(p)}>
                    <Icon size={15} aria-hidden /> {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

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
    </section>
  );
}

function ConnRow({ c, children }: { c: Connection; children?: ReactNode }) {
  const Icon = KIND_ICON[c.kind];
  return (
    <div className="acct">
      <div className="acctTop">
        <strong className="withIcon">
          <Icon size={16} aria-hidden /> {c.name}
        </strong>
        <span className="badge">{KIND_LABEL[c.kind]}</span>
      </div>
      <div className="muted small">
        {c.summary}
        {c.teamName ? ` · team ${c.teamName}` : ""} · {c.files} file{c.files === 1 ? "" : "s"}, {formatBytes(c.used)}
        {c.limit != null ? ` of ${formatBytes(c.limit)}` : ""}
      </div>
      {c.lastError && (
        <p className="fieldError small" role="alert">
          Last check failed: {c.lastError}
        </p>
      )}
      {children && <div className="modalActions">{children}</div>}
    </div>
  );
}

function AddForm({
  preset,
  teamId,
  onCancel,
  onAdded,
}: {
  preset: Preset;
  teamId?: string;
  onCancel: () => void;
  onAdded: (testResult: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ ...(preset.defaults ?? {}) });
  const [name, setName] = useState(preset.label);
  const [offer, setOffer] = useState(false);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const field = (k: string, label: string, opts: { type?: string; placeholder?: string } = {}) => (
    <label className="fieldLabel" key={k}>
      {label}
      <input type={opts.type ?? "text"} value={f[k] ?? ""} onChange={set(k)} placeholder={opts.placeholder} autoComplete="off" required={k !== "prefix"} />
    </label>
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ test: string }>("/api/connections", {
        method: "POST",
        body: JSON.stringify({ kind: preset.kind, name, config: f, teamId, offerToMembers: offer, limitGB: limit || null }),
      });
      onAdded(r.test);
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  };

  return (
    <form className="formStack acct" onSubmit={submit}>
      <strong>Connect {preset.label}</strong>
      {preset.guide}
      <label className="fieldLabel">
        Name in TG Drive
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      {preset.kind === "telegram" && (
        <>
          {field("botToken", "Bot token", { type: "password", placeholder: "123456789:AA…" })}
          {field("chatId", "Chat id", { placeholder: "-1001234567890" })}
        </>
      )}
      {preset.kind === "s3" && (
        <>
          {field("endpoint", "Endpoint URL")}
          {field("bucket", "Bucket")}
          {field("region", "Region")}
          {field("accessKeyId", "Access key id")}
          {field("secretAccessKey", "Secret access key", { type: "password" })}
          <label className="fieldLabel">
            Address style
            <select value={f.style ?? "path"} onChange={set("style")}>
              <option value="path">endpoint/bucket (R2, B2, Wasabi, MinIO)</option>
              <option value="virtual">bucket in host name (AWS)</option>
            </select>
          </label>
          {field("prefix", "Folder inside the bucket (optional)", { placeholder: "tgdrive" })}
        </>
      )}
      {preset.kind === "webdav" && (
        <>
          {field("url", "Folder URL")}
          {field("username", "Username")}
          {field("password", "Password (an app password if the server has them)", { type: "password" })}
        </>
      )}
      <label className="fieldLabel">
        Limit in GB (optional)
        <input type="number" min="1" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="no limit" />
      </label>
      {teamId && (
        <label className="small withIcon">
          <input type="checkbox" checked={offer} onChange={(e) => setOffer(e.target.checked)} /> Offer to members for their private files
        </label>
      )}
      <p className="muted small">Credentials are stored encrypted on the server and never shown again.</p>
      {error && (
        <p className="fieldError" role="alert">
          {error}
        </p>
      )}
      <div className="modalActions end">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          {busy && <Loader2 size={16} className="spin" aria-hidden />} Test & connect
        </button>
      </div>
    </form>
  );
}
