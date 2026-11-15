// Storing chunks on someone else's WebDAV server (Nextcloud, ownCloud, Synology, a NAS, another TG Drive,
// ...). Chunks are plain files inside the folder the connection points at: <url>/u<uid>/f<fileId>/<idx>.
export type WebdavConfig = {
  url: string; // folder URL, e.g. https://cloud.example.com/remote.php/dav/files/alice/TGDrive
  username: string;
  password: string;
};

const TIMEOUT_MS = 120_000;

function base(c: WebdavConfig) {
  return c.url.replace(/\/+$/, "");
}
const urlOf = (c: WebdavConfig, key: string) => `${base(c)}/${key.split("/").map(encodeURIComponent).join("/")}`;

function headers(c: WebdavConfig, extra: Record<string, string> = {}) {
  const auth = Buffer.from(`${c.username}:${c.password}`).toString("base64");
  return { Authorization: `Basic ${auth}`, ...extra };
}

async function req(c: WebdavConfig, method: string, url: string, body?: Uint8Array, extra?: Record<string, string>) {
  return fetch(url, {
    method,
    headers: headers(c, extra),
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
}

// Folders we already created (per server + path), so each chunk upload doesn't re-check them.
const made = new Set<string>();

/** Creates the folders on the way to `key` (MKCOL; "already exists" answers are fine). */
async function ensureDirs(c: WebdavConfig, key: string) {
  const parts = key.split("/").slice(0, -1);
  let path = "";
  for (const p of parts) {
    path = path ? `${path}/${p}` : p;
    const id = `${base(c)}|${path}`;
    if (made.has(id)) continue;
    const res = await req(c, "MKCOL", `${urlOf(c, path)}/`);
    // 201 created, 405 exists, 301/302 some servers redirect to the trailing-slash form.
    if (![201, 405, 301, 302].includes(res.status) && !res.ok) {
      throw new Error(`WebDAV couldn't create folder ${path}: HTTP ${res.status}`);
    }
    made.add(id);
  }
}

export async function davPut(c: WebdavConfig, key: string, data: Uint8Array) {
  await ensureDirs(c, key);
  const res = await req(c, "PUT", urlOf(c, key), data, { "Content-Type": "application/octet-stream" });
  if (!res.ok) throw new Error(`WebDAV upload failed: HTTP ${res.status}`);
}

export async function davGet(c: WebdavConfig, key: string): Promise<Buffer> {
  const res = await req(c, "GET", urlOf(c, key));
  if (!res.ok) throw new Error(`WebDAV download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort delete of chunk files (errors are logged, not thrown). */
export async function davDelete(c: WebdavConfig, keys: string[]) {
  for (let i = 0; i < keys.length; i += 16) {
    const results = await Promise.allSettled(keys.slice(i, i + 16).map((k) => req(c, "DELETE", urlOf(c, k))));
    for (const r of results) if (r.status === "rejected") console.warn("WebDAV delete failed (ignored):", r.reason);
  }
}

/** Writes, reads back and deletes a small file: used when someone adds a WebDAV connection. */
export async function testWebdav(c: WebdavConfig) {
  const res = await req(c, "PROPFIND", `${base(c)}/`, undefined, { Depth: "0" });
  if (res.status === 401) throw new Error("The server refused the username or password (HTTP 401)");
  if (res.status === 404) throw new Error("That folder doesn't exist on the server (HTTP 404). Create it first.");
  if (res.status !== 207 && !res.ok) throw new Error(`The server didn't answer as WebDAV (HTTP ${res.status})`);
  const key = `tgdrive-test-${Date.now()}.txt`;
  const data = new TextEncoder().encode("TG Drive connection test");
  await davPut(c, key, data);
  const back = await davGet(c, key);
  await davDelete(c, [key]);
  if (!back.equals(Buffer.from(data))) throw new Error("The test file came back different");
}
