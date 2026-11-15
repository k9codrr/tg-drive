"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import DevicesModal from "./Devices";

type Folder = { id: string; name: string; createdAt: string };
type FileItem = {
  id: string;
  name: string;
  size: number;
  mime: string;
  status: string;
  folderId: string | null;
  createdAt: string;
  backend: string;
  account: string | null;
};
type GoogleAccount = {
  id: string;
  email: string;
  name: string | null;
  limit: number | null;
  used: number;
  free: number | null;
  needsReauth: boolean;
  app: { files: number; bytes: number };
};
type Pool = {
  user: { email: string; name: string | null };
  r2: { configured: boolean; used: number; files: number; limit: number; free: number };
  googleConfigured: boolean;
  telegram: { configured: boolean; files: number; bytes: number };
  google: GoogleAccount[];
  totals: { googleLimit: number; googleUsed: number; googleFree: number; unlimitedGoogle: boolean; storedByApp: number };
};
type Listing = {
  folderId: string | null;
  breadcrumbs: { id: string; name: string }[];
  folders: Folder[];
  files: FileItem[];
  stats: { files: number; bytes: number };
};
type JobStatus = "queued" | "uploading" | "done" | "error";
type Job = { key: string; label: string; size: number; done: number; status: JobStatus; error?: string };
type Pending = { file: File; dir: string }; // dir = relative folder path ("" = current folder)
type Batch = { items: Pending[]; keys: string[]; target: string | null; dest: string };

const PARALLEL_CHUNKS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Session expired");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

// ---------- upload / download helpers ----------

async function putChunk(id: string, idx: number, blob: Blob) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api/files/${id}/chunks/${idx}`, { method: "PUT", body: blob });
    } catch {
      await sleep(2000 * (attempt + 1)); // network blip
      continue;
    }
    if (res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    if (res.status === 429) {
      await sleep((Number(data.retryAfter) || 5) * 1000 + 500); // Telegram rate limit
      continue;
    }
    if (res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
  }
  throw new Error("Upload failed after several retries");
}

async function uploadFile(
  file: File,
  folderId: string | null,
  dest: string,
  onProgress: (bytes: number) => void,
) {
  const init = await api<{ id: string; chunkSize: number; chunkCount: number; sequential: boolean }>("/api/files", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      folderId,
      target: dest,
    }),
  });
  let next = 0;
  let uploaded = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= init.chunkCount) return;
      const blob = file.slice(i * init.chunkSize, Math.min(file.size, (i + 1) * init.chunkSize));
      await putChunk(init.id, i, blob);
      uploaded += blob.size;
      onProgress(uploaded);
    }
  };
  await Promise.all(Array.from({ length: Math.min(init.sequential ? 1 : PARALLEL_CHUNKS, init.chunkCount) }, worker));
  await api(`/api/files/${init.id}/complete`, { method: "POST" });
}

async function downloadFile(file: { id: string }, onProgress: (text: string) => void) {
  const meta = await api<FileItem & { chunkCount: number }>(`/api/files/${file.id}`);
  if (meta.status !== "ready") throw new Error("File upload is not finished");
  const parts: Blob[] = [];
  let got = 0;
  for (let i = 0; i < meta.chunkCount; i++) {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`/api/files/${file.id}/chunks/${i}`);
      if (res.ok) break;
      const data = await res.clone().json().catch(() => ({}));
      await sleep(res.status === 429 ? (Number(data.retryAfter) || 5) * 1000 : 1500 * (attempt + 1));
    }
    if (!res || !res.ok) throw new Error(`Failed to fetch part ${i + 1}/${meta.chunkCount}`);
    const blob = await res.blob();
    parts.push(blob);
    got += blob.size;
    onProgress(`Downloading ${meta.name} — ${Math.round((got / Math.max(1, meta.size)) * 100)}%`);
  }
  const url = URL.createObjectURL(new Blob(parts, { type: meta.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = meta.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Reads dropped files AND folders (recursively), keeping relative paths. */
function collectDropped(dt: DataTransfer): Promise<Pending[]> {
  // webkitGetAsEntry must be called synchronously inside the drop event
  const entries = Array.from(dt.items)
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => !!e);
  const plainFiles = Array.from(dt.files);

  return (async () => {
    if (!entries.length) return plainFiles.map((file) => ({ file, dir: "" }));
    const out: Pending[] = [];
    const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ file, dir });
      } else if (entry.isDirectory) {
        const sub = dir ? `${dir}/${entry.name}` : entry.name;
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, sub);
        }
      }
    };
    for (const e of entries) await walk(e, "");
    return out;
  })();
}

// ---------- component ----------

export default function Drive() {
  const [folderId, setFolderId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("f"),
  );
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileItem[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pool, setPool] = useState<Pool | null>(null);
  const [showStorage, setShowStorage] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [dest, setDest] = useState("telegram");

  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const folderRef = useRef<string | null>(folderId);
  const queue = useRef<Batch[]>([]);
  const running = useRef(false);
  const dragDepth = useRef(0);
  folderRef.current = folderId;

  const load = useCallback(async (id: string | null = folderRef.current) => {
    setLoading(true);
    try {
      const d = await api<Listing>(`/api/list?folder=${id ?? ""}`);
      if (folderRef.current === id) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(folderId);
  }, [folderId, load]);

  const loadPool = useCallback(async (refresh = false) => {
    try {
      setPool(await api<Pool>(`/api/accounts${refresh ? "?refresh=1" : ""}`));
    } catch (e) {
      setError(msg(e));
    }
  }, []);

  useEffect(() => {
    void loadPool();
    try {
      const saved = localStorage.getItem("tgd_dest");
      if (saved) setDest(saved);
    } catch {
      /* storage unavailable */
    }
    // Result of the Google login redirect
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const gerror = params.get("gerror");
    if (connected || gerror) {
      if (connected) setNotice(`Connected ${connected}`);
      if (gerror) setError(`Google: ${gerror}`);
      setShowStorage(true);
      params.delete("connected");
      params.delete("gerror");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `/?${qs}` : "/");
    }
  }, [loadPool]);

  // If the chosen destination account disappears, fall back to Telegram
  useEffect(() => {
    if (!pool) return;
    const ok =
      dest === "telegram" ||
      (dest === "r2" && pool.r2.configured) ||
      (dest === "gdrive" && pool.google.some((g) => !g.needsReauth)) ||
      pool.google.some((g) => `gdrive:${g.id}` === dest && !g.needsReauth);
    if (!ok) setDest("telegram");
  }, [pool, dest]);

  const chooseDest = (v: string) => {
    setDest(v);
    try {
      localStorage.setItem("tgd_dest", v);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const onPop = () => setFolderId(new URLSearchParams(window.location.search).get("f"));
    window.addEventListener("popstate", onPop);
    dirInput.current?.setAttribute("webkitdirectory", "");
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (id: string | null) => {
    setResults(null);
    setQuery("");
    setFolderId(id);
    window.history.pushState(null, "", id ? `/?f=${id}` : "/");
  };

  // ----- uploads -----
  const patchJob = (key: string, patch: Partial<Job>) =>
    setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  const runQueue = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const batch = queue.current.shift()!;
        const dirCache = new Map<string, string | null>([["", batch.target]]);
        for (let i = 0; i < batch.items.length; i++) {
          const { file, dir } = batch.items[i];
          const key = batch.keys[i];
          patchJob(key, { status: "uploading" });
          try {
            let parent = dirCache.get(dir);
            if (parent === undefined) {
              const r = await api<{ id: string }>("/api/folders", {
                method: "POST",
                body: JSON.stringify({ parentId: batch.target, path: dir }),
              });
              parent = r.id;
              dirCache.set(dir, parent);
            }
            await uploadFile(file, parent, batch.dest, (n) => patchJob(key, { done: n }));
            patchJob(key, { status: "done", done: file.size });
          } catch (e) {
            patchJob(key, { status: "error", error: msg(e) });
          }
          if (batch.items.length <= 20 && folderRef.current === batch.target) load();
        }
        load();
        void loadPool();
      }
    } finally {
      running.current = false;
    }
  };

  const enqueue = (items: Pending[]) => {
    if (!items.length) return;
    const stamp = Date.now();
    const newJobs: Job[] = items.map((p, i) => ({
      key: `${stamp}-${i}-${Math.random().toString(36).slice(2)}`,
      label: p.dir ? `${p.dir}/${p.file.name}` : p.file.name,
      size: p.file.size,
      done: 0,
      status: "queued",
    }));
    queue.current.push({ items, keys: newJobs.map((j) => j.key), target: folderRef.current, dest });
    setJobs((js) => [...js, ...newJobs]);
    void runQueue();
  };

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    enqueue(list.map((file) => ({ file, dir: "" })));
  };

  const onPickFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    enqueue(
      list.map((file) => {
        const parts = (file.webkitRelativePath || file.name).split("/");
        parts.pop();
        return { file, dir: parts.join("/") };
      }),
    );
  };

  // ----- drag & drop -----
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    collectDropped(e.dataTransfer).then(enqueue).catch((err) => setError(msg(err)));
  };

  // ----- actions -----
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    }
  };

  const newFolder = () =>
    run(async () => {
      const name = window.prompt("Folder name");
      if (!name?.trim()) return;
      await api("/api/folders", { method: "POST", body: JSON.stringify({ parentId: folderId, name }) });
      await load();
    });

  const renameItem = (kind: "folders" | "files", id: string, current: string) =>
    run(async () => {
      const name = window.prompt("New name", current);
      if (!name?.trim() || name === current) return;
      await api(`/api/${kind}/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await load();
      if (results) await search();
    });

  const deleteItem = (kind: "folders" | "files", id: string, name: string) =>
    run(async () => {
      const what = kind === "folders" ? `folder "${name}" and everything inside it` : `"${name}"`;
      if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
      await api(`/api/${kind}/${id}`, { method: "DELETE" });
      await load();
      void loadPool();
      if (results) setResults(results.filter((f) => f.id !== id));
    });

  const download = (f: FileItem) =>
    run(async () => {
      setToast(`Downloading ${f.name}…`);
      try {
        await downloadFile(f, setToast);
      } finally {
        setToast(null);
      }
    });

  const search = async () => {
    const q = query.trim();
    if (!q) return setResults(null);
    await run(async () => {
      const r = await api<{ files: FileItem[] }>(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(r.files);
    });
  };

  const disconnect = (a: GoogleAccount) =>
    run(async () => {
      if (!window.confirm(`Disconnect ${a.email}?`)) return;
      await api(`/api/accounts/${a.id}`, { method: "DELETE" });
      await loadPool();
    });

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  // ----- render -----
  const crumbs = data?.breadcrumbs ?? [];
  const here = crumbs.length ? crumbs[crumbs.length - 1].name : "My Drive";
  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "uploading").length;
  const failedJobs = jobs.filter((j) => j.status === "error").length;

  const fileRow = (f: FileItem, showLocation = false) => (
    <tr key={`file-${f.id}`}>
      <td className="name">
        <span className="icon">{iconFor(f.mime, f.name)}</span>
        <span className="label" title={f.name}>
          {f.name}
        </span>
        <span className={`where ${f.backend}`} title={f.account ?? (f.backend === "r2" ? "Cloudflare R2" : "Telegram")}>
          {f.backend === "gdrive"
            ? `Drive${f.account ? ` · ${f.account.split("@")[0]}` : ""}`
            : f.backend === "r2"
              ? "R2"
              : "TG"}
        </span>
        {f.status !== "ready" && <span className="badge">incomplete</span>}
        {showLocation && (
          <button className="link small" onClick={() => navigate(f.folderId)}>
            open folder
          </button>
        )}
      </td>
      <td className="size">{formatBytes(f.size)}</td>
      <td className="date">{new Date(f.createdAt).toLocaleDateString()}</td>
      <td className="rowActions">
        <button onClick={() => download(f)} disabled={f.status !== "ready"}>
          Download
        </button>
        <button onClick={() => renameItem("files", f.id, f.name)}>Rename</button>
        <button className="danger" onClick={() => deleteItem("files", f.id, f.name)}>
          Delete
        </button>
      </td>
    </tr>
  );

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="topbar">
        <button className="brand" onClick={() => navigate(null)}>
          ✈️ TG Drive
        </button>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) setResults(null);
            }}
            placeholder="Search files…"
          />
        </form>
        <div className="actions">
          <select
            className="dest"
            value={dest}
            onChange={(e) => chooseDest(e.target.value)}
            title="Where new uploads are stored"
          >
            <option value="telegram">Save to: Telegram</option>
            {pool?.r2.configured && (
              <option value="r2">Save to: Cloudflare R2 ({formatBytes(pool.r2.free)} free)</option>
            )}
            {pool && pool.google.some((g) => !g.needsReauth) && (
              <option value="gdrive">Save to: Google Drive (most free)</option>
            )}
            {pool?.google
              .filter((g) => !g.needsReauth)
              .map((g) => (
                <option key={g.id} value={`gdrive:${g.id}`}>
                  Save to: {g.email} ({g.free == null ? "unlimited" : `${formatBytes(g.free)} free`})
                </option>
              ))}
          </select>
          <button onClick={() => setShowStorage(true)}>Storage</button>
          <button onClick={() => setShowDevices(true)}>PC drive</button>
          <button className="primary" onClick={() => fileInput.current?.click()}>
            Upload files
          </button>
          <button onClick={() => dirInput.current?.click()}>Upload folder</button>
          <button onClick={newFolder}>New folder</button>
          <button className="ghost" onClick={logout} title={pool?.user.email ?? ""}>
            Log out{pool ? ` (${pool.user.name || pool.user.email.split("@")[0]})` : ""}
          </button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={onPickFiles} />
        <input ref={dirInput} type="file" multiple hidden onChange={onPickFolder} />
      </header>

      <main className="content">
        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error} <span className="muted">(tap to dismiss)</span>
          </div>
        )}

        {results ? (
          <>
            <div className="crumbs">
              <button className="link" onClick={() => setResults(null)}>
                ← Back
              </button>
              <span className="muted">
                {results.length} result{results.length === 1 ? "" : "s"} for “{query}”
              </span>
            </div>
            <table className="list">
              <tbody>{results.map((f) => fileRow(f, true))}</tbody>
            </table>
          </>
        ) : (
          <>
            <nav className="crumbs">
              <button className="link" onClick={() => navigate(null)}>
                My Drive
              </button>
              {crumbs.map((c) => (
                <span key={c.id}>
                  <span className="sep">/</span>
                  <button className="link" onClick={() => navigate(c.id)}>
                    {c.name}
                  </button>
                </span>
              ))}
              {loading && <span className="muted"> loading…</span>}
            </nav>

            {data && data.folders.length + data.files.length === 0 && !loading ? (
              <div className="empty" onClick={() => fileInput.current?.click()}>
                <div className="emptyIcon">⬆️</div>
                <p>
                  Drag &amp; drop files or whole folders here
                  <br />
                  <span className="muted">or click to choose files</span>
                </p>
              </div>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="size">Size</th>
                    <th className="date">Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data?.folders.map((f) => (
                    <tr key={`folder-${f.id}`} className="folderRow">
                      <td className="name">
                        <button className="link folderLink" onClick={() => navigate(f.id)}>
                          <span className="icon">📁</span>
                          <span className="label">{f.name}</span>
                        </button>
                      </td>
                      <td className="size">—</td>
                      <td className="date">{new Date(f.createdAt).toLocaleDateString()}</td>
                      <td className="rowActions">
                        <button onClick={() => renameItem("folders", f.id, f.name)}>Rename</button>
                        <button className="danger" onClick={() => deleteItem("folders", f.id, f.name)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {data?.files.map((f) => fileRow(f))}
                </tbody>
              </table>
            )}
          </>
        )}
      </main>

      <footer className="footer muted">
        {data ? `${data.stats.files} files · ${formatBytes(data.stats.bytes)} stored` : ""}
        {pool && pool.google.length > 0 && (
          <>
            {" · "}
            {pool.totals.unlimitedGoogle ? "unlimited" : formatBytes(pool.totals.googleFree)} free across{" "}
            {pool.google.length} Google account{pool.google.length === 1 ? "" : "s"} + Telegram
          </>
        )}
      </footer>

      {jobs.length > 0 && (
        <aside className="uploads">
          <div className="uploadsHead">
            <strong>
              {activeJobs ? `Uploading ${activeJobs}…` : "Uploads finished"}
              {failedJobs ? ` · ${failedJobs} failed` : ""}
            </strong>
            {!activeJobs && (
              <button className="link small" onClick={() => setJobs([])}>
                Clear
              </button>
            )}
          </div>
          <ul>
            {jobs.slice(-200).map((j) => (
              <li key={j.key} className={j.status}>
                <div className="jobLine">
                  <span className="label" title={j.label}>
                    {j.label}
                  </span>
                  <span className="muted">
                    {j.status === "error"
                      ? "failed"
                      : j.status === "done"
                        ? "✓"
                        : j.status === "queued"
                          ? "waiting"
                          : `${Math.round((j.done / Math.max(1, j.size)) * 100)}%`}
                  </span>
                </div>
                <div className="bar">
                  <div style={{ width: `${(j.done / Math.max(1, j.size)) * 100}%` }} />
                </div>
                {j.error && <div className="jobError">{j.error}</div>}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {toast && <div className="toast">{toast}</div>}
      {notice && (
        <div className="toast ok" onClick={() => setNotice(null)}>
          ✓ {notice}
        </div>
      )}

      {showStorage && (
        <div className="modalBack" onClick={() => setShowStorage(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHead">
              <h2>Storage pool{pool ? ` · ${pool.user.email}` : ""}</h2>
              <button className="ghost" onClick={() => setShowStorage(false)}>
                ✕
              </button>
            </div>

            {pool ? (
              <>
                <div className="poolSummary">
                  <div>
                    <div className="big">
                      {pool.totals.unlimitedGoogle ? "∞" : formatBytes(pool.totals.googleFree)}
                    </div>
                    <div className="muted">free in Google Drive</div>
                  </div>
                  <div>
                    <div className="big">∞</div>
                    <div className="muted">Telegram (no fixed cap)</div>
                  </div>
                  {pool.r2.configured && (
                    <div>
                      <div className="big">{formatBytes(pool.r2.free)}</div>
                      <div className="muted">free in Cloudflare R2</div>
                    </div>
                  )}
                  <div>
                    <div className="big">{formatBytes(pool.totals.storedByApp)}</div>
                    <div className="muted">stored by this app</div>
                  </div>
                </div>

                <div className="acct">
                  <div className="acctTop">
                    <strong>✈️ Telegram</strong>
                    <span className="muted">
                      {pool.telegram.configured ? "connected via bot" : "not configured"}
                    </span>
                  </div>
                  <div className="muted small">
                    {pool.telegram.files} files · {formatBytes(pool.telegram.bytes)}
                  </div>
                </div>

                {pool.r2.configured && (
                  <div className="acct">
                    <div className="acctTop">
                      <strong>☁️ Cloudflare R2</strong>
                      <span className="muted">fast &amp; reliable</span>
                    </div>
                    <div className="bar big">
                      <div
                        style={{ width: `${Math.min(100, (pool.r2.used / Math.max(1, pool.r2.limit)) * 100)}%` }}
                        className={pool.r2.free < pool.r2.limit * 0.1 ? "full" : ""}
                      />
                    </div>
                    <div className="muted small">
                      {formatBytes(pool.r2.free)} free · you use {formatBytes(pool.r2.used)} ({pool.r2.files} files)
                    </div>
                  </div>
                )}

                {pool.google.map((g) => {
                  const pct = g.limit ? Math.min(100, (g.used / g.limit) * 100) : 0;
                  return (
                    <div className="acct" key={g.id}>
                      <div className="acctTop">
                        <strong title={g.name ?? ""}>🟢 {g.email}</strong>
                        <button className="link small danger" onClick={() => disconnect(g)}>
                          Disconnect
                        </button>
                      </div>
                      {g.needsReauth ? (
                        <div className="small warn">
                          Access expired —{" "}
                          <a href="/api/google/connect" className="inlineLink">
                            reconnect
                          </a>
                        </div>
                      ) : (
                        <>
                          <div className="bar big">
                            <div style={{ width: `${pct}%` }} className={pct > 90 ? "full" : ""} />
                          </div>
                          <div className="muted small">
                            {g.limit == null
                              ? `${formatBytes(g.used)} used · unlimited`
                              : `${formatBytes(g.free ?? 0)} free of ${formatBytes(g.limit)}`}
                            {" · "}
                            {g.app.files} files ({formatBytes(g.app.bytes)}) from this app
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                <div className="modalActions">
                  {pool.googleConfigured ? (
                    <a className="button primary" href="/api/google/connect">
                      + Connect Google account
                    </a>
                  ) : (
                    <span className="muted small">
                      Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Google accounts.
                    </span>
                  )}
                  <button onClick={() => loadPool(true)}>Refresh</button>
                </div>
                <p className="muted small">
                  Google storage is shared by Drive, Gmail and Photos. Each account&apos;s free space is shown as Google
                  reports it. Files go into a “TG Drive” folder in that Drive.
                </p>
              </>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
        </div>
      )}

      {showDevices && <DevicesModal onClose={() => setShowDevices(false)} />}

      {dragging && (
        <div className="dropOverlay">
          <div>
            Drop to upload into <strong>{here}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

function iconFor(mime: string, name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜️";
  if (["js", "ts", "tsx", "jsx", "py", "java", "go", "rs", "c", "cpp", "json", "html", "css", "sh"].includes(ext))
    return "🧩";
  return "📄";
}
