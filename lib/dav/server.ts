// WebDAV server for mounting TG Drive as a drive letter (via rclone + WinFsp).
// Runs next to Next.js (started from instrumentation.ts) because Next route handlers can't
// receive WebDAV methods like PROPFIND, MKCOL and MOVE.
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { purgeStorage } from "../cleanup";
import { CHUNK_SIZE } from "../config";
import { big, isForeignKeyViolation, isUniqueViolation, prisma } from "../db";
import { verifyBasicAuth } from "../devices";
import type { Prisma } from "@prisma/client";
import {
  accessTokenFor,
  downloadRange,
  driveRetry,
  pickAccount,
  putResumableSafe,
  startResumable,
  uploadMultipart,
} from "../google";
import { telegramConfigured, withGoogleFallback } from "../storage";
import { type ChunkedBackend, readChunk, storeChunk } from "../store";
import {
  children,
  clearFolderCache,
  deleteNode,
  type FileNode,
  folderIdFor,
  isInside,
  mimeFor,
  type Node,
  resolve,
} from "./fs";

const PREFIX = "/dav";
const ALLOW = "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, MKCOL, DELETE, MOVE";

class DavError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function startDavServer(port: number) {
  const g = globalThis as unknown as { tgdDavServer?: http.Server };
  if (g.tgdDavServer) return;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof DavError ? e.status : 500;
      if (status >= 500) console.error(`[dav] ${req.method} ${req.url}:`, e);
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(e instanceof Error ? e.message : "Server error");
    });
  });
  server.requestTimeout = 0; // big uploads can take a long time
  server.on("error", (e) => {
    g.tgdDavServer = undefined;
    console.error(`[dav] could not start on port ${port}: ${e.message}`);
  });
  server.listen(port, "127.0.0.1", () => console.log(`[dav] WebDAV drive on http://127.0.0.1:${port}${PREFIX}`));
  g.tgdDavServer = server;
}

// ---------- request routing ----------

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segs = segsOf(url.pathname);
  if (!segs) return empty(res, 404);

  if (req.method === "OPTIONS") {
    await drain(req);
    res.writeHead(200, { DAV: "1", Allow: ALLOW, "MS-Author-Via": "DAV", "Content-Length": "0" });
    return void res.end();
  }

  const uid = await verifyBasicAuth(req.headers.authorization);
  if (!uid) {
    await drain(req);
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="TG Drive"', "Content-Length": "0" });
    return void res.end();
  }

  switch (req.method) {
    case "PROPFIND":
      return propfind(uid, segs, req, res);
    case "GET":
    case "HEAD":
      return get(uid, segs, req, res);
    case "PUT":
      return put(uid, segs, req, res);
    case "MKCOL":
      return mkcol(uid, segs, req, res);
    case "DELETE":
      return del(uid, segs, req, res);
    case "MOVE":
      return move(uid, segs, req, res);
    case "PROPPATCH":
      return proppatch(segs, req, res);
    default:
      await drain(req);
      res.writeHead(405, { Allow: ALLOW, "Content-Length": "0" });
      return void res.end();
  }
}

function segsOf(pathname: string): string[] | null {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  let parts: string[];
  try {
    parts = pathname.slice(PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new DavError(400, "Bad path encoding");
  }
  if (parts.some((p) => p === "." || p === ".." || p.includes("/") || p.length > 255)) {
    throw new DavError(400, "Bad path");
  }
  return parts;
}

function hrefOf(segs: string[], dir: boolean) {
  const path = segs.map(encodeURIComponent).join("/");
  return `${PREFIX}/${path}${dir && segs.length ? "/" : ""}`;
}

async function drain(req: IncomingMessage) {
  for await (const _ of req) void _;
}

function empty(res: ServerResponse, status: number, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...headers, "Content-Length": "0" });
  res.end();
}

// ---------- PROPFIND (list / stat) ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

const etagOf = (n: Node) => `"${n.kind === "file" ? "f" : "d"}${n.id ?? 0}-${n.updatedAt.getTime()}"`;

function responseXml(segs: string[], node: Node, quota?: { used: number; available: number }) {
  const dir = node.kind === "folder";
  const props = [
    `<d:displayname>${esc(node.name)}</d:displayname>`,
    `<d:resourcetype>${dir ? "<d:collection/>" : ""}</d:resourcetype>`,
    `<d:getlastmodified>${node.updatedAt.toUTCString()}</d:getlastmodified>`,
    `<d:creationdate>${node.createdAt.toISOString()}</d:creationdate>`,
    `<d:getetag>${esc(etagOf(node))}</d:getetag>`,
  ];
  if (node.kind === "file") {
    props.push(`<d:getcontentlength>${node.size}</d:getcontentlength>`);
    props.push(`<d:getcontenttype>${esc(node.mime)}</d:getcontenttype>`);
  }
  if (quota) {
    props.push(`<d:quota-used-bytes>${quota.used}</d:quota-used-bytes>`);
    props.push(`<d:quota-available-bytes>${quota.available}</d:quota-available-bytes>`);
  }
  return (
    `<d:response><d:href>${esc(hrefOf(segs, dir))}</d:href>` +
    `<d:propstat><d:prop>${props.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
    `</d:response>`
  );
}

/**
 * Space shown for the drive in Windows. Free space is what the drive can actually write to:
 *   Google:   free space across the connected Google accounts (new files go there first)
 *   Telegram: no real cap, so an allowance (DAV_TELEGRAM_QUOTA_GB, default 1024) minus what you
 *             already store there; 0 if Telegram isn't configured.
 * R2 isn't counted: the drive never writes there unless DAV_BACKEND=r2.
 */
async function driveQuota(uid: string) {
  const userId = big(uid);
  const [used, tgUsed, google] = await Promise.all([
    prisma.file.aggregate({ where: { userId, status: "ready", trashedAt: null, transferOf: null }, _sum: { size: true } }),
    prisma.file.aggregate({ where: { userId, backend: "telegram" }, _sum: { size: true } }),
    prisma.googleAccount.findMany({ where: { userId, needsReauth: false }, select: { quotaLimit: true, quotaUsage: true } }),
  ]);
  const tgAllowance = Number(process.env.DAV_TELEGRAM_QUOTA_GB || 1024) * 1024 ** 3;
  const tgFree = telegramConfigured() ? Math.max(0, tgAllowance - Number(tgUsed._sum.size ?? 0)) : 0;
  // Unlimited Google accounts are shown as 100 TB.
  const gFree = google.reduce(
    (sum, a) => sum + (a.quotaLimit == null ? 100 * 1024 ** 4 : Math.max(0, Number(a.quotaLimit) - Number(a.quotaUsage))),
    0,
  );
  return { used: Number(used._sum.size ?? 0), available: gFree + tgFree };
}

async function propfind(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  await drain(req);
  const node = await resolve(uid, segs);
  if (!node) return empty(res, 404);

  const parts: string[] = [];
  let quota: { used: number; available: number } | undefined;
  if (!segs.length) quota = await driveQuota(uid);
  parts.push(responseXml(segs, node, quota));
  if (node.kind === "folder" && req.headers.depth !== "0") {
    for (const child of await children(uid, node.id)) parts.push(responseXml([...segs, child.name], child));
  }
  const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${parts.join("")}</d:multistatus>`;
  res.writeHead(207, {
    "Content-Type": 'application/xml; charset="utf-8"',
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

async function proppatch(segs: string[], req: IncomingMessage, res: ServerResponse) {
  // Accept and ignore (e.g. clients trying to set modification times).
  await drain(req);
  const body =
    `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response>` +
    `<d:href>${esc(hrefOf(segs, false))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status>` +
    `</d:propstat></d:response></d:multistatus>`;
  res.writeHead(207, { "Content-Type": 'application/xml; charset="utf-8"', "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}

// ---------- GET / HEAD (read, with Range) ----------

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "bad";
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "bad";
  return { start, end };
}

async function get(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  await drain(req);
  const node = await resolve(uid, segs);
  if (!node) return empty(res, 404);
  if (node.kind === "folder") return empty(res, req.method === "HEAD" ? 200 : 405);

  const size = Number(node.size);
  const headers: Record<string, string> = {
    "Content-Type": node.mime,
    "Last-Modified": node.updatedAt.toUTCString(),
    ETag: etagOf(node),
    "Accept-Ranges": "bytes",
  };
  const range = parseRange(req.headers.range, size);
  if (range === "bad") return empty(res, 416, { "Content-Range": `bytes */${size}` });

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers["Content-Length"] = String(length);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || length === 0) return void res.end();

  await streamRange(node, start, end, res);
  res.end();
}

async function write(res: ServerResponse, buf: Buffer) {
  if (res.destroyed) throw new DavError(499, "Client went away");
  if (!res.write(buf)) await once(res, "drain");
}

/** Streams bytes [start, end] of a file, fetching the next chunk while the current one is sent. */
async function streamRange(file: FileNode, start: number, end: number, res: ServerResponse) {
  if (file.backend === "gdrive") {
    if (!file.gdFileId || file.gdAccountId == null) throw new DavError(404, "File not found in Google Drive");
    const { token } = await accessTokenFor(String(file.gdAccountId));
    for (let pos = start; pos <= end; pos += CHUNK_SIZE) {
      await write(res, await downloadRange(token, file.gdFileId, pos, Math.min(end, pos + CHUNK_SIZE - 1)));
    }
    return;
  }

  const cs = file.chunkSize;
  const first = Math.floor(start / cs);
  const last = Math.floor(end / cs);
  const fetchIdx = (idx: number) =>
    readChunk(file.id, idx).then((b) => {
      if (!b) throw new DavError(500, `Chunk ${idx} of ${file.name} is missing`);
      return b;
    });
  let next = fetchIdx(first);
  for (let idx = first; idx <= last; idx++) {
    const current = await next;
    if (idx < last) next = fetchIdx(idx + 1);
    const base = idx * cs;
    const from = Math.max(start, base) - base;
    const to = Math.min(end, base + cs - 1) - base;
    await write(res, current.subarray(from, to + 1));
  }
}

// ---------- PUT (write a whole file) ----------

const validName = (name: string) => {
  const n = name.trim();
  if (!n || n.length > 255 || n === "." || n === ".." || n !== name) throw new DavError(400, "Invalid name");
  return n;
};

/**
 * Where the drive writes a new file. For now: the Google account with the most free space; if no Google
 * account can take it (none connected, full, needs reconnecting) or the size isn't known up front,
 * Telegram. Never R2. DAV_BACKEND=telegram|r2 overrides this.
 */
type Dest =
  | { backend: "gdrive"; accountId: string; token: string; parent: string | null }
  | { backend: ChunkedBackend };

async function pickDest(uid: string, size: number | null): Promise<Dest> {
  const forced = process.env.DAV_BACKEND;
  if (forced === "telegram" || forced === "r2") return { backend: forced };
  if (size == null) return { backend: "telegram" };
  return withGoogleFallback<Dest>(
    { backend: "gdrive", accountId: null, auto: true },
    async () => {
      const a = await pickAccount(uid, size, null);
      const { token, row } = await accessTokenFor(a.id);
      return { backend: "gdrive", accountId: a.id, token, parent: row.rootFolderId || null };
    },
    async () => ({ backend: "telegram" }),
  );
}

/** Reads a request body in pieces of exactly `size` bytes (the last one may be shorter). */
async function* pieces(req: IncomingMessage, size: number) {
  const pending: Buffer[] = [];
  let buffered = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    pending.push(part);
    buffered += part.length;
    while (buffered >= size) {
      const all = Buffer.concat(pending);
      pending.length = 0;
      const rest = all.subarray(size);
      if (rest.length) pending.push(Buffer.from(rest));
      buffered = rest.length;
      yield all.subarray(0, size);
    }
  }
  if (buffered > 0) yield Buffer.concat(pending);
}

async function put(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  if (!segs.length) throw new DavError(405, "Cannot write to the root");
  const name = validName(segs[segs.length - 1]);
  const parent = await folderIdFor(uid, segs.slice(0, -1));
  if (parent === undefined) throw new DavError(409, "Parent folder does not exist");
  const lenHeader = req.headers["content-length"];
  const declared = lenHeader != null ? Number(lenHeader) : null;
  if (declared != null && (!Number.isSafeInteger(declared) || declared < 0)) throw new DavError(400, "Bad Content-Length");

  // Previous versions (and leftovers of failed uploads) are replaced once the new one is complete.
  // Both lookups run in parallel: every database query is a network round trip.
  const [clash, previous] = await Promise.all([
    prisma.folder.count({ where: { userId: big(uid), parentId: parent, name, trashedAt: null } }),
    prisma.file.findMany({
      where: { userId: big(uid), folderId: parent, name, trashedAt: null, transferOf: null },
      select: { id: true },
    }),
  ]);
  if (clash) throw new DavError(405, "A folder with that name exists");

  const mime = mimeFor(name);
  const base = { userId: big(uid), name, folderId: parent, mime, chunkSize: CHUNK_SIZE };
  type Extra = Omit<Prisma.FileUncheckedCreateInput, "userId" | "name" | "folderId" | "mime" | "chunkSize">;
  const createRow = (data: Extra) =>
    prisma.file.create({ data: { ...base, ...data }, select: { id: true } }).catch((e) => {
      // The parent folder was deleted (or the cached id was stale): a client error, not a crash.
      if (isForeignKeyViolation(e)) {
        clearFolderCache();
        throw new DavError(409, "Parent folder does not exist");
      }
      throw e;
    });

  let fileId: bigint | null = null;
  try {
    if (declared === 0) {
      await drain(req);
      await createRow({ size: BigInt(0), chunkCount: 0, status: "ready", backend: "telegram" });
    } else {
      const dest = await pickDest(uid, declared);
      if (dest.backend === "gdrive" && declared != null) {
        const meta = { name, mime, parentId: dest.parent };
        if (declared <= CHUNK_SIZE) {
          // Small file: one request.
          const parts: Buffer[] = [];
          for await (const part of req as AsyncIterable<Buffer>) parts.push(part);
          const body = Buffer.concat(parts);
          if (body.length !== declared) throw new DavError(400, "Upload was cut short");
          const driveId = await driveRetry(() => uploadMultipart(dest.token, meta, body));
          await createRow({
            size: BigInt(declared),
            chunkCount: 1,
            status: "ready",
            backend: "gdrive",
            gdAccountId: big(dest.accountId),
            gdFileId: driveId,
            uploadedBytes: BigInt(declared),
          });
        } else {
          // Big file: resumable upload, streamed 4 MB at a time.
          const url = await driveRetry(() => startResumable(dest.token, { ...meta, size: declared }));
          const row = await createRow({
            size: BigInt(declared),
            chunkCount: Math.ceil(declared / CHUNK_SIZE),
            status: "uploading",
            backend: "gdrive",
            gdAccountId: big(dest.accountId),
            gdUploadUrl: url,
          });
          fileId = row.id;
          let pos = 0;
          let driveId: string | null = null;
          for await (const piece of pieces(req, CHUNK_SIZE)) {
            if (pos + piece.length > declared) throw new DavError(400, "Upload is bigger than declared");
            driveId = await putResumableSafe(url, piece, pos, declared);
            pos += piece.length;
          }
          if (pos !== declared || !driveId) throw new DavError(400, "Upload was cut short");
          await prisma.file.update({
            where: { id: row.id },
            data: { status: "ready", gdFileId: driveId, gdUploadUrl: null, uploadedBytes: BigInt(declared) },
          });
        }
      } else {
        // Telegram (or R2 when forced): 4 MB chunks.
        const backend = dest.backend as ChunkedBackend;
        let idx = 0;
        let total = 0;
        let last: Buffer | null = null;
        for await (const piece of pieces(req, CHUNK_SIZE)) {
          // Hold one piece back so the final one also marks the file ready (one query instead of two).
          if (last) {
            fileId ??= (await createRow({ size: BigInt(declared ?? 0), chunkCount: 0, status: "uploading", backend })).id;
            await storeChunk(uid, fileId, idx++, backend, last, { waitOnRateLimit: true });
          }
          last = Buffer.from(piece);
          total += piece.length;
        }
        if (declared != null && declared !== total) throw new DavError(400, "Upload was cut short");
        fileId ??= (await createRow({ size: BigInt(total), chunkCount: 0, status: "uploading", backend })).id;
        if (last) await storeChunk(uid, fileId, idx++, backend, last, { waitOnRateLimit: true, finish: { size: total } });
        else await prisma.file.update({ where: { id: fileId }, data: { size: BigInt(0), chunkCount: 0, status: "ready" } });
      }
    }
  } catch (e) {
    if (fileId != null) {
      const failed = fileId;
      await purgeStorage([String(failed)]).catch(() => {});
      await prisma.file.delete({ where: { id: failed } }).catch(() => {});
    }
    throw e;
  }

  if (previous.length) {
    await purgeStorage(previous.map((f) => String(f.id))).catch((e) => console.warn("[dav] purge failed:", e));
    await prisma.file.deleteMany({ where: { id: { in: previous.map((f) => f.id) } } });
  }
  empty(res, previous.length ? 204 : 201);
}

// ---------- MKCOL / DELETE / MOVE ----------

async function mkcol(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  await drain(req);
  if (!segs.length) return empty(res, 405);
  const name = validName(segs[segs.length - 1]);
  const parent = await folderIdFor(uid, segs.slice(0, -1));
  if (parent === undefined) return empty(res, 409);
  if (await resolve(uid, segs)) return empty(res, 405);
  try {
    await prisma.folder.create({ data: { userId: big(uid), parentId: parent, name } });
  } catch (e) {
    if (isUniqueViolation(e)) return empty(res, 405);
    throw e;
  }
  empty(res, 201);
}

async function del(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  await drain(req);
  if (!segs.length) return empty(res, 403);
  const node = await resolve(uid, segs);
  if (!node) return empty(res, 404);
  const parent = await folderIdFor(uid, segs.slice(0, -1));
  await deleteNode(uid, parent ?? null, node);
  empty(res, 204);
}

async function move(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  await drain(req);
  const destHeader = req.headers.destination;
  if (!destHeader || !segs.length) return empty(res, 400);
  const dest = segsOf(new URL(String(destHeader), "http://localhost").pathname);
  if (!dest || !dest.length) return empty(res, 502);
  if (dest.join("/") === segs.join("/")) return empty(res, 403);

  const node = await resolve(uid, segs);
  if (!node) return empty(res, 404);
  const destParent = await folderIdFor(uid, dest.slice(0, -1));
  if (destParent === undefined) return empty(res, 409);
  const destName = validName(dest[dest.length - 1]);
  if (node.kind === "folder" && node.id != null && (await isInside(destParent, node.id))) return empty(res, 403);

  const overwrite = String(req.headers.overwrite ?? "T").toUpperCase() !== "F";
  const existing = await resolve(uid, dest);
  if (existing) {
    if (!overwrite) return empty(res, 412);
    await deleteNode(uid, destParent, existing);
  }

  if (node.kind === "folder") {
    await prisma.folder.update({ where: { id: node.id! }, data: { parentId: destParent, name: destName } });
    clearFolderCache();
  } else {
    try {
      await prisma.file.update({ where: { id: node.id }, data: { folderId: destParent, name: destName } });
    } catch (e) {
      if (!isForeignKeyViolation(e)) throw e;
      clearFolderCache();
      return empty(res, 409);
    }
  }
  empty(res, existing ? 204 : 201);
}
