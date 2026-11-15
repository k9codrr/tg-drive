"use client";

import { Check, Cloud, Copy, EyeOff, Globe, KeyRound, Laptop, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Pool } from "./drive/lib";
import { StorageOptions, storageLabel } from "./drive/storage";
import { Modal } from "./drive/ui";

type Device = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  storage: string | null;
  allowedIps: string | null;
  lastIp: string | null;
};
type Created = { id: string; name: string; token: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

/** "PC drive" screen: device passwords for mounting TG Drive as a Windows drive letter, and where it stores files. */
export default function DevicesModal({
  pool,
  onClose,
  onChanged,
}: {
  pool: Pool | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [mountStorage, setMountStorage] = useState(pool?.mountStorage ?? "same");
  const [exclude, setExclude] = useState((pool?.uploadExclude ?? ["node_modules", ".next"]).join(", "));
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [davUrl, setDavUrl] = useState<string | null>(null);
  const [davOpen, setDavOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await call<{ email: string; mountStorage: string; devices: Device[]; davUrl: string | null; davOpen: boolean }>(
        "/api/devices",
      );
      setEmail(d.email);
      setDavUrl(d.davUrl);
      setDavOpen(d.davOpen);
      setMountStorage(d.mountStorage);
      setDevices(d.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (text: string) => {
    setSaved(text);
    setTimeout(() => setSaved((s) => (s === text ? null : s)), 2500);
  };

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = () =>
    run(async () => {
      const c = await call<Created>("/api/devices", { method: "POST", body: JSON.stringify({ name: name || "My PC" }) });
      setCreated(c);
      setName("");
      await load();
    });

  const revoke = (d: Device) => {
    if (!window.confirm(`Revoke "${d.name}"? That PC's drive stops working.`)) return;
    void run(async () => {
      await call(`/api/devices/${d.id}`, { method: "DELETE" });
      await load();
    });
  };

  const chooseMount = (v: string) =>
    run(async () => {
      const prev = mountStorage;
      setMountStorage(v);
      try {
        await call("/api/settings", { method: "PATCH", body: JSON.stringify({ mountStorage: v }) });
      } catch (e) {
        setMountStorage(prev);
        throw e;
      }
      onChanged?.();
      flash("PC drive storage saved");
    });

  const chooseDevice = (d: Device, v: string) =>
    run(async () => {
      await call(`/api/devices/${d.id}`, { method: "PATCH", body: JSON.stringify({ storage: v }) });
      setDevices((list) => list?.map((x) => (x.id === d.id ? { ...x, storage: v === "same" ? null : v } : x)) ?? list);
      flash(`Saved for ${d.name}`);
    });

  const setIps = (d: Device) => {
    const v = window.prompt(
      `Addresses allowed to use “${d.name}” (IPs or ranges, comma separated; empty = any):\ne.g. 203.0.113.7, 192.168.1.0/24`,
      d.allowedIps ?? (d.lastIp ? d.lastIp : ""),
    );
    if (v == null) return;
    void run(async () => {
      await call(`/api/devices/${d.id}`, { method: "PATCH", body: JSON.stringify({ allowedIps: v.trim() || null }) });
      await load();
      flash(v.trim() ? `${d.name} now only works from ${v.trim()}` : `${d.name} works from any address`);
    });
  };

  const saveExclude = () =>
    run(async () => {
      const r = await call<{ uploadExclude: string[] }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ uploadExclude: exclude }),
      });
      setExclude(r.uploadExclude.join(", "));
      onChanged?.();
      flash("Skip list saved");
    });

  const webDefault = pool?.defaultStorage ?? "gdrive";
  const accountChoice = mountStorage === "same" ? webDefault : mountStorage;

  // With a public WebDAV address, any PC can set up from the web (the script is downloaded from this site).
  // Without one, the drive only works on the PC running TG Drive, from its repo folder.
  const agent = typeof window !== "undefined" ? `${window.location.origin}/agent` : "";
  const setupCommand = !created
    ? ""
    : davUrl
      ? `powershell -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; ` +
        `& ([scriptblock]::Create((irm '${agent}/install.ps1'))) -Email '${email}' -Password '${created.token}' ` +
        `-Url '${davUrl}' -Source '${agent}'"`
      : `powershell -ExecutionPolicy Bypass -File drive-agent\\install.ps1 -Email "${email}" -Password "${created.token}"`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the text is selectable */
    }
  };

  return (
    <Modal title="Use as a drive on your PC" onClose={onClose} wide>
      <p className="muted small">
        Mount TG Drive as drive <strong>T:</strong> in Windows. Drag files in from Explorer and open them from any
        app. Each PC gets its own password, so you can revoke one without affecting the others.
      </p>

      <div className="acct">
        <div className="acctTop">
          <strong className="withIcon">
            <Cloud size={16} aria-hidden /> Where files copied to T: are stored
          </strong>
        </div>
        <label className="destPick" style={{ width: "100%" }}>
          <span className="sr">Storage for files copied to the PC drive</span>
          <select value={mountStorage} onChange={(e) => void chooseMount(e.target.value)} style={{ width: "100%" }}>
            <option value="same">Same as web uploads ({storageLabel(webDefault, pool)})</option>
            <StorageOptions pool={pool} current={mountStorage === "same" ? "gdrive" : mountStorage} />
          </select>
        </label>
        <p className="muted small">
          Applies to every PC unless you pick something else for one PC below. If the chosen storage is full or not
          set up, the file goes to the Google account with the most free space, then Telegram, so copies never get
          stuck. Files already on the drive stay where they are (use “Change storage” in the web app to move them).
        </p>
      </div>

      <div className="acct">
        <div className="acctTop">
          <strong className="withIcon">
            <EyeOff size={16} aria-hidden /> Never upload these folders or files
          </strong>
        </div>
        <form
          className="modalActions"
          onSubmit={(e) => {
            e.preventDefault();
            void saveExclude();
          }}
        >
          <input
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            placeholder="node_modules, .next"
            aria-label="Names to skip, separated by commas"
          />
          <button className="btn" type="submit">
            Save
          </button>
        </form>
        <p className="muted small">
          Anything with one of these names, and everything inside it, is skipped when you upload a folder in the
          browser or copy it to T:. Matching ignores upper/lower case.
        </p>
      </div>

      {created ? (
        <div className="acct">
          <div className="acctTop">
            <strong className="withIcon"><KeyRound size={16} aria-hidden /> Password for “{created.name}”</strong>
            <span className="muted small">shown once, copy it now</span>
          </div>
          <p className="small">
            {davUrl
              ? "On that PC, open PowerShell and run this (installs WinFsp + rclone and mounts T:):"
              : "Run this in the tg-drive folder on that PC (PowerShell):"}
          </p>
          <pre className="code" onClick={copy} title="Click to copy">
            {setupCommand}
          </pre>
          <div className="modalActions">
            <button type="button" className="btn primary" onClick={copy}>
              {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
              {copied ? "Copied" : "Copy command"}
            </button>
            <button type="button" className="btn" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="modalActions"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Device name, e.g. Lenovo laptop"
            aria-label="Device name"
          />
          <button className="btn primary" type="submit">
            <Plus size={16} aria-hidden /> Add this PC
          </button>
        </form>
      )}

      {error && (
        <p className="fieldError" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="muted small" role="status">
          <Check size={14} aria-hidden /> {saved}
        </p>
      )}

      {devices == null ? (
        <p className="muted">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="muted small">No devices yet.</p>
      ) : (
        devices.map((d) => (
          <div className="acct" key={d.id}>
            <div className="acctTop">
              <strong className="withIcon"><Laptop size={16} aria-hidden /> {d.name}</strong>
              <button type="button" className="linkBtn small danger" onClick={() => revoke(d)}>
                Revoke
              </button>
            </div>
            <div className="muted small">
              added {new Date(d.createdAt).toLocaleDateString()} ·{" "}
              {d.lastUsedAt ? `last used ${new Date(d.lastUsedAt).toLocaleString()}` : "never used"}
              {d.lastIp ? ` from ${d.lastIp}` : ""}
            </div>
            <div className="acctTop">
              <span className="small withIcon">
                <Shield size={14} aria-hidden /> {d.allowedIps ? `Only from ${d.allowedIps}` : "Any address"}
              </span>
              <button type="button" className="linkBtn small" onClick={() => setIps(d)}>
                Limit addresses
              </button>
            </div>
            <label className="destPick" style={{ width: "100%", marginTop: 8 }}>
              <span className="small muted">Stores new files in</span>
              <select value={d.storage ?? "same"} onChange={(e) => void chooseDevice(d, e.target.value)}>
                <option value="same">Account setting ({storageLabel(accountChoice, pool)})</option>
                <StorageOptions pool={pool} current={d.storage ?? "gdrive"} />
              </select>
            </label>
          </div>
        ))
      )}
      <OtherApps email={email} davUrl={davUrl} davOpen={davOpen} />
    </Modal>
  );
}

/** How to use the drive from other machines and apps (Finder, Linux, phones, …). */
function OtherApps({ email, davUrl, davOpen }: { email: string; davUrl: string | null; davOpen: boolean }) {
  const url = davUrl ?? "https://YOUR-TG-DRIVE-ADDRESS/dav/";
  return (
    <details className="acct">
      <summary className="withIcon">
        <Globe size={16} aria-hidden /> Use it from other computers, phones and apps
      </summary>
      <p className="small">
        TG Drive is a standard <strong>WebDAV</strong> server. Any WebDAV app can open it with:
      </p>
      <ul className="small" style={{ paddingLeft: 18 }}>
        <li>
          Address: <code>{url}</code>
          {!davUrl && " (ask whoever runs TG Drive for the address; they set DAV_PUBLIC_URL)"}
        </li>
        <li>
          User name: <code>{email || "your email"}</code>
        </li>
        <li>Password: a device password from “Add this PC” above (one per device, so you can revoke it)</li>
      </ul>
      {!davOpen && !davUrl && (
        <p className="small muted">
          Right now the server only accepts connections from the computer it runs on. Whoever runs TG Drive can open it
          up: see “External access” in the README (a Cloudflare tunnel, or DAV_HOST with DAV_ALLOW_IPS).
        </p>
      )}
      <ul className="small" style={{ paddingLeft: 18 }}>
        <li>
          <strong>Windows</strong>: the PC drive above (rclone, best), or File Explorer → This PC → Map network drive → the
          address.
        </li>
        <li>
          <strong>macOS</strong>: Finder → Go → Connect to Server (⌘K) → the address.
        </li>
        <li>
          <strong>Linux</strong>: Files → Other Locations → <code>davs://</code> + the address without https://, or mount with
          davfs2 / <code>rclone mount</code>.
        </li>
        <li>
          <strong>iPhone / iPad</strong>: the Documents app by Readdle (Add Connection → WebDAV), or FE File Explorer.
        </li>
        <li>
          <strong>Android</strong>: Solid Explorer, CX File Explorer or Material Files → add WebDAV.
        </li>
        <li>
          <strong>Other tools</strong>: Cyberduck, WinSCP, rclone (<code>rclone config</code> → webdav, vendor “other”).
        </li>
      </ul>
      <p className="small muted">
        Use “Limit addresses” on a device to make its password work only from known IPs. Always use an https:// address
        from outside your network.
      </p>
    </details>
  );
}
