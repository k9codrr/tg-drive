// Client-side data helpers for the drive UI: API calls, chunked upload/download, file kinds.

export type Folder = { id: string; name: string; createdAt: string };
export type FileItem = {
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
export type GoogleAccount = {
  id: string;
  email: string;
  name: string | null;
  limit: number | null;
  used: number;
  free: number | null;
  needsReauth: boolean;
  app: { files: number; bytes: number };
};
export type Pool = {
  user: { email: string; name: string | null };
  r2: { configured: boolean; used: number; files: number; limit: number; free: number };
  googleConfigured: boolean;
  telegram: { configured: boolean; files: number; bytes: number };
  google: GoogleAccount[];
  totals: { googleLimit: number; googleUsed: number; googleFree: number; unlimitedGoogle: boolean; storedByApp: number };
};
export type Listing = {
  folderId: string | null;
  breadcrumbs: { id: string; name: string }[];
  folders: Folder[];
  files: FileItem[];
  stats: { files: number; bytes: number };
};
export type Pending = { file: File; dir: string }; // dir = relative folder path ("" = current folder)

const PARALLEL_CHUNKS = 2;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** JSON API call with friendly errors. Network failures and 5xx are retried a couple of times for GETs. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const isGet = !init?.method || init.method === "GET";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    } catch {
      if (isGet && attempt < 2) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw new ApiError(0, navigator.onLine ? "Can't reach the server. Check that TG Drive is running." : "You're offline.");
    }
    if (res.status === 401) {
      window.location.href = "/login";
      throw new ApiError(401, "Your session expired. Please sign in again.");
    }
    if (isGet && res.status >= 500 && attempt < 2) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fallback =
        res.status === 502 || res.status === 503 || res.status === 504
          ? "The server isn't responding right now. Try again in a moment."
          : res.status === 404
            ? "That item no longer exists."
            : `Something went wrong (HTTP ${res.status}).`;
      throw new ApiError(res.status, data.error || fallback);
    }
    return data as T;
  }
}

// ---------- upload / download ----------

async function putChunk(id: string, idx: number, blob: Blob, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (signal?.aborted) throw new Error("Cancelled");
    let res: Response;
    try {
      res = await fetch(`/api/files/${id}/chunks/${idx}`, { method: "PUT", body: blob, signal });
    } catch {
      if (signal?.aborted) throw new Error("Cancelled");
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
  throw new Error("Upload failed after several retries. Check your connection and try again.");
}

export async function uploadFile(
  file: File,
  folderId: string | null,
  dest: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
) {
  const init = await api<{ id: string; chunkSize: number; chunkCount: number; sequential: boolean }>("/api/files", {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || mimeFromName(file.name),
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
      await putChunk(init.id, i, blob, signal);
      uploaded += blob.size;
      onProgress(uploaded);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(init.sequential ? 1 : PARALLEL_CHUNKS, init.chunkCount) }, worker),
    );
    await api(`/api/files/${init.id}/complete`, { method: "POST" });
  } catch (e) {
    // Don't leave a half-uploaded file behind.
    await fetch(`/api/files/${init.id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}

/** Downloads by fetching each part with retries (survives rate limits and short outages). */
export async function downloadFile(file: { id: string }, onProgress: (pct: number, name: string) => void) {
  const meta = await api<FileItem & { chunkCount: number }>(`/api/files/${file.id}`);
  if (meta.status !== "ready") throw new Error("This file hasn't finished uploading yet.");
  const parts: Blob[] = [];
  let got = 0;
  for (let i = 0; i < meta.chunkCount; i++) {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await fetch(`/api/files/${file.id}/chunks/${i}`);
      } catch {
        res = null;
      }
      if (res?.ok) break;
      const data = res ? await res.clone().json().catch(() => ({})) : {};
      await sleep(res?.status === 429 ? (Number(data.retryAfter) || 5) * 1000 : 1500 * (attempt + 1));
    }
    if (!res || !res.ok) throw new Error(`Couldn't download part ${i + 1} of ${meta.chunkCount}. Try again.`);
    const blob = await res.blob();
    parts.push(blob);
    got += blob.size;
    onProgress(Math.round((got / Math.max(1, meta.size)) * 100), meta.name);
  }
  saveBlob(new Blob(parts, { type: meta.mime }), meta.name);
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const contentUrl = (id: string) => `/api/files/${id}/content`;

/** Fetches (part of) a file's bytes for the viewer. */
export async function fetchBytes(id: string, maxBytes?: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(contentUrl(id), {
    headers: maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : undefined,
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Couldn't load the file (HTTP ${res.status})`);
  }
  return res.arrayBuffer();
}

/** Reads dropped files AND folders (recursively), keeping relative paths. */
export function collectDropped(dt: DataTransfer): Promise<Pending[]> {
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

// ---------- file kinds ----------

export type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "text"
  | "code"
  | "archive"
  | "font"
  | "app"
  | "other";

const EXT: Record<string, Kind> = {};
const add = (k: Kind, list: string) => list.split(" ").forEach((e) => (EXT[e] = k));
add("image", "png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff");
add("video", "mp4 webm mov mkv avi m4v ogv 3gp wmv flv");
add("audio", "mp3 wav ogg oga flac aac m4a opus wma");
add("pdf", "pdf");
add("doc", "doc docx odt rtf pages");
add("sheet", "xls xlsx xlsm ods csv tsv numbers");
add("slides", "ppt pptx odp key");
add("text", "txt md markdown log ini cfg conf env");
add(
  "code",
  "js mjs cjs ts tsx jsx json jsonc html htm css scss less xml yml yaml toml py rb go rs java kt kts c h cpp hpp cc cs php swift dart sh bash ps1 bat cmd sql graphql vue svelte lua r pl prisma dockerfile gradle",
);
add("archive", "zip rar 7z tar gz tgz bz2 xz zst");
add("font", "ttf otf woff woff2");
add("app", "exe msi apk dmg deb rpm appimage iso");

export const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
};

export function kindOf(mime: string, name: string): Kind {
  const byExt = EXT[extOf(name)];
  if (byExt) return byExt;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("xml")) return "code";
  if (mime.includes("zip") || mime.includes("compressed")) return "archive";
  return "other";
}

export const KIND_LABEL: Record<Kind, string> = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  doc: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  text: "Text",
  code: "Code",
  archive: "Archive",
  font: "Font",
  app: "App",
  other: "File",
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
export const mimeFromName = (name: string) => MIME_BY_EXT[extOf(name)] ?? "application/octet-stream";
/** The recorded type, or one worked out from the name for older uploads that have none. */
export const mimeOf = (f: { mime: string; name: string }) =>
  f.mime && f.mime !== "application/octet-stream" ? f.mime : mimeFromName(f.name);

/** Whether the browser can show an image thumbnail directly. */
export const canThumb = (f: FileItem) =>
  f.status === "ready" &&
  f.size > 0 &&
  f.size <= 20 * 1024 * 1024 &&
  /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mimeOf(f));
