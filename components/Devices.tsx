"use client";

import { Check, Copy, KeyRound, Laptop, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "./drive/ui";

type Device = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
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

/** "PC drive" screen: device passwords for mounting TG Drive as a Windows drive letter. */
export default function DevicesModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await call<{ email: string; devices: Device[] }>("/api/devices");
      setEmail(d.email);
      setDevices(d.devices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    try {
      const c = await call<Created>("/api/devices", { method: "POST", body: JSON.stringify({ name: name || "My PC" }) });
      setCreated(c);
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (d: Device) => {
    if (!window.confirm(`Revoke "${d.name}"? That PC's drive stops working.`)) return;
    try {
      await call(`/api/devices/${d.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setupCommand = created
    ? `powershell -ExecutionPolicy Bypass -File drive-agent\\install.ps1 -Email "${email}" -Password "${created.token}"`
    : "";

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

        {created ? (
          <div className="acct">
            <div className="acctTop">
              <strong className="withIcon"><KeyRound size={16} aria-hidden /> Password for “{created.name}”</strong>
              <span className="muted small">shown once, copy it now</span>
            </div>
            <p className="small">Run this in the tg-drive folder on that PC (PowerShell):</p>
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
              </div>
            </div>
          ))
        )}
    </Modal>
  );
}
