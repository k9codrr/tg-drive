// WebDAV server for mounting TG Drive as a drive letter (via rclone + WinFsp).
// Runs next to Next.js (started from instrumentation.ts) because Next route handlers can't
// receive WebDAV methods like PROPFIND, MKCOL and MOVE.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { purgeStorage } from "../cleanup";
import { CHUNK_SIZE } from "../config";
import { big, isForeignKeyViolation, isUniqueViolation, prisma } from "../db";
import { type DeviceAuth, verifyDevice } from "../devices";
import { clientIp, ipAllowed, parseAllowList } from "../netacl";
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
import { r2Configured, r2Usage } from "../r2";
import { personal } from "../space";
import {
  cachedUploadExclude,
  isExcludedPath,
  chunkStoreFor,
  mountTarget,
  parseTarget,
  type Target,
  telegramConfigured,
  withGoogleFallback,
} from "../storage";
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

// ---------- who may connect ----------
// DAV_HOST        address to listen on: 127.0.0.1 (default, this PC only) or 0.0.0.0 / :: (the network)
// DAV_ALLOW_IPS   only these addresses/ranges may connect at all ("203.0.113.7, 10.0.0.0/8"; empty = any)
// DAV_TRUST_PROXY "cloudflare" or "true" when a proxy/tunnel is in front (see lib/netacl.ts)
// Each device password can also be limited to certain addresses (PC drive screen), and an address with
// many failed logins is locked out for a while.

let serverRules: ReturnType<typeof parseAllowList> = [];
try {
  serverRules = parseAllowList(process.env.DAV_ALLOW_IPS);
} catch (e) {
  // A typo must not open the server to everyone: refuse every connection and say why.
  console.error(`[dav] DAV_ALLOW_IPS is invalid (${e instanceof Error ? e.message : e}); refusing all connections`);
  serverRules = parseAllowList("255.255.255.255/32");
}

const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { n: number; at: number }>();
const lockedOut = (ip: string) => {
  const f = failures.get(ip);
  return !!f && Date.now() - f.at < FAIL_WINDOW_MS && f.n >= FAIL_LIMIT;
};
function recordFailure(ip: string) {
  const f = failures.get(ip);
  const cur = f && Date.now() - f.at < FAIL_WINDOW_MS ? f : { n: 0, at: Date.now() };
  failures.set(ip, { n: cur.n + 1, at: cur.at });
  if (failures.size > 10_000) failures.clear();
}

export function startDavServer(port: number) {
  const g = globalThis as unknown as { tgdDavServer?: http.Server };
  if (g.tgdDavServer) return;
  const host = process.env.DAV_HOST || "127.0.0.1";
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
  server.listen(port, host, () => {
    console.log(`[dav] WebDAV drive on http://${host.includes(":") ? `[${host}]` : host}:${port}${PREFIX}`);
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      console.log(
        `[dav] listening beyond this PC${serverRules.length ? `, allowed: ${process.env.DAV_ALLOW_IPS}` : " (no DAV_ALLOW_IPS: any address)"}. ` +
          "Put it behind HTTPS (e.g. a Cloudflare tunnel): passwords are sent with every request.",
      );
    }
  });
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

  const ip = clientIp(req.headers, req.socket.remoteAddress);
  if (!ipAllowed(ip, serverRules)) {
    await drain(req);
    return empty(res, 403);
  }
  if (lockedOut(ip)) {
    await drain(req);
    return empty(res, 429, { "Retry-After": String(FAIL_WINDOW_MS / 1000) });
  }

  const device = await verifyDevice(req.headers.authorization, ip);
  if (device === "blocked") {
    // Right password, but this device may only be used from other addresses.
    await drain(req);
    console.warn(`[dav] device password used from ${ip}, which isn't in its allowed addresses`);
    return empty(res, 403);
  }
  if (!device) {
    await drain(req);
    if (req.headers.authorization) recordFailure(ip);
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="TG Drive"', "Content-Length": "0" });
    return void res.end();
  }
  const { uid } = device;

  // Excluded names (node_modules, .next, … set per account) are never stored. Writes to them are
  // accepted and dropped so copies from Explorer neither stall nor fail.
  if (isExcludedPath(segs, await cachedUploadExclude(uid))) return excluded(uid, segs, req, res);

  switch (req.method) {
    case "PROPFIND":
      return propfind(device, segs, req, res);
    case "GET":
    case "HEAD":
      return get(uid, segs, req, res);
    case "PUT":
      return put(device, segs, req, res);
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

// ---------- excluded paths ----------

// rclone checks a file right after uploading it (PROPFIND) and retries the upload if it isn't there.
// So for a skipped file we remember its size for a while and answer that check. Nothing is stored,
// and skipped names never show up in folder listings.
const gs = globalThis as unknown as { tgdSkipped?: Map<string, { size: number; at: number }> };
const skipped = (gs.tgdSkipped ??= new Map<string, { size: number; at: number }>());
const SKIP_MS = 15 * 60_000;

async function excluded(uid: string, segs: string[], req: IncomingMessage, res: ServerResponse) {
  const key = `${uid}/${segs.join("/").toLowerCase()}`;
  const now = Date.now();
  if (skipped.size > 5000) for (const [k, v] of skipped) if (now - v.at > SKIP_MS) skipped.delete(k);

  switch (req.method) {
    case "PUT": {
      let size = 0;
      for await (const part of req as AsyncIterable<Buffer>) size += part.length;
      skipped.set(key, { size, at: now });
      return empty(res, 201);
    }
    case "MKCOL":
      await drain(req);
      return empty(res, 201);
    case "DELETE":
      await drain(req);
      skipped.delete(key);
      return empty(res, 204);
    case "PROPFIND": {
      await drain(req);
      const hit = skipped.get(key);
      const at = new Date(hit?.at ?? now);
      const name = segs[segs.length - 1];
      // A remembered file; anything else looks like an empty folder (so files can go "inside" it).
      const node: Node =
        hit && now - hit.at < SKIP_MS
          ? {
              kind: "file",
              id: BigInt(0),
              name,
              size: BigInt(hit.size),
              mime: mimeFor(name),
              backend: "skipped",
              chunkSize: 0,
              chunkCount: 0,
              gdAccountId: null,
              gdFileId: null,
              encryption: null,
              createdAt: at,
              updatedAt: at,
            }
          : { kind: "folder", id: null, name, createdAt: at, updatedAt: at };
      const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responseXml(segs, node)}</d:multistatus>`;
      res.writeHead(207, { "Content-Type": 'application/xml; charset="utf-8"', "Content-Length": String(Buffer.byteLength(body)) });
      return void res.end(body);
    }
    case "PROPPATCH":
      return proppatch(segs, req, res);
    default:
      await drain(req);
      return empty(res, 404);
  }
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
 *   R2:       counted only when this PC's drive stores new files in R2 (R2 has a set limit).
 * Google and Telegram are always counted: the drive falls back to them when the chosen storage is full.
 */
async function driveQuota(device: DeviceAuth) {
  const { uid } = device;
  const userId = big(uid);
  const [used, tgUsed, google, mount] = await Promise.all([
    prisma.file.aggregate({ where: { userId, teamId: null, status: "ready", trashedAt: null, transferOf: null }, _sum: { size: true } }),
    prisma.file.aggregate({ where: { userId, backend: "telegram" }, _sum: { size: true } }),
    prisma.googleAccount.findMany({ where: { userId, needsReauth: false }, select: { quotaLimit: true, quotaUsage: true } }),
    mountTarget(uid, device.storage),
  ]);
  const r2Free =
    mount.target.backend === "r2" && r2Configured() ? (await r2Usage(uid)).free : 0;
  const tgAllowance = Number(process.env.DAV_TELEGRAM_QUOTA_GB || 1024) * 1024 ** 3;
  const tgFree = telegramConfigured() ? Math.max(0, tgAllowance - Number(tgUsed._sum.size ?? 0)) : 0;
  // Unlimited Google accounts are shown as 100 TB.
  const gFree = google.reduce(
    (sum, a) => sum + (a.quotaLimit == null ? 100 * 1024 ** 4 : Math.max(0, Number(a.quotaLimit) - Number(a.quotaUsage))),
    0,
  );
  return { used: Number(used._sum.size ?? 0), available: gFree + tgFree + r2Free };
}

async function propfind(device: DeviceAuth, segs: string[], req: IncomingMessage, res: ServerResponse) {
  const { uid } = device;
  await drain(req);
  const node = await resolve(uid, segs);
  if (!node) return empty(res, 404);

  const parts: string[] = [];
  let quota: { used: number; available: number } | undefined;
  if (!segs.length) quota = await driveQuota(device);
  parts.push(responseXml(segs, node, quota));
  if (node.kind === "folder" && req.headers.depth !== "0") {
    const exclude = await cachedUploadExclude(uid);
    for (const child of await children(uid, node.id)) {
      if (isExcludedPath([child.name], exclude)) continue; // e.g. node_modules uploaded before the rule
      parts.push(responseXml([...segs, child.name], child));
    }
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
  // Encrypted with a password: only the web app can unlock it (the drive never has the password).
  if (node.encryption != null && req.method === "GET") {
    throw new DavError(403, "This file is password-encrypted. Open it in the TG Drive web app.");
  }

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
 * Where the drive writes a new file: this PC's own choice, else the account's "PC drive storage"
 * setting, else the web default (see mountTarget). Telegram / S3 / WebDAV resolve like web uploads
 * (your own connection → one your team offers → the server's). If that storage can't take the file
 * (not set up, full, needs reconnecting) it falls back to the automatic choice (Google with most free
 * space → Telegram), so a write never gets stuck retrying. DAV_BACKEND=telegram|r2 overrides everything.
 */
type Dest =
  | { backend: "gdrive"; accountId: string; token: string; parent: string | null }
  | { backend: ChunkedBackend; connectionId: bigint | null };

async function googleDest(uid: string, size: number, accountId: string | null): Promise<Dest> {
  const a = await pickAccount(uid, size, accountId);
  const { token, row } = await accessTokenFor(a.id);
  return { backend: "gdrive", accountId: a.id, token, parent: row.rootFolderId || null };
}

function autoDest(uid: string, size: number): Promise<Dest> {
  return withGoogleFallback<Dest>(
    parseTarget("gdrive"),
    () => googleDest(uid, size, null),
    () => chunkStoreFor(personal(uid), parseTarget("telegram"), size),
  );
}

async function pickDest(device: DeviceAuth, size: number): Promise<Dest> {
  const forced = process.env.DAV_BACKEND;
  if (forced === "telegram" || forced === "r2") return { backend: forced, connectionId: null };
  const { value, target } = await mountTarget(device.uid, device.storage);
  const fallback = (why: string) => {
    console.warn(`[dav] storage "${value}" can't take this file (${why}); using the automatic choice`);
    return autoDest(device.uid, size);
  };
  return destFor(device.uid, target, size, fallback);
}

async function destFor(uid: string, t: Target, size: number, fallback: (why: string) => Promise<Dest>): Promise<Dest> {
  if (t.backend !== "gdrive") {
    try {
      return await chunkStoreFor(personal(uid), t, size);
    } catch (e) {
      return fallback(e instanceof Error ? e.message : String(e));
    }
  }
  if (t.auto) return autoDest(uid, size);
  try {
    return await googleDest(uid, size, t.accountId);
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

/** Reads a request body in pieces of exactly `size` bytes (the last one may be shorter). */
async function* pieces(body: AsyncIterable<Buffer>, size: number) {
  const pending: Buffer[] = [];
  let buffered = 0;
  for await (const part of body) {
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

/**
 * Saves a body of unknown length (chunked transfer encoding) to a temp file: Google needs the size up
 * front. Returns the size and a reader over the saved copy.
 */
async function spool(req: IncomingMessage) {
  const path = join(tmpdir(), `tgd-put-${randomBytes(8).toString("hex")}`);
  const cleanup = () => rm(path, { force: true }).catch(() => {});
  try {
    await pipeline(req, createWriteStream(path));
  } catch (e) {
    await cleanup();
    throw e;
  }
  const { size } = await stat(path);
  return { size, body: createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>, cleanup };
}

async function put(device: DeviceAuth, segs: string[], req: IncomingMessage, res: ServerResponse) {
  const { uid } = device;
  if (!segs.length) throw new DavError(405, "Cannot write to the root");
  const name = validName(segs[segs.length - 1]);
  const parent = await folderIdFor(uid, segs.slice(0, -1));
  if (parent === undefined) throw new DavError(409, "Parent folder does not exist");
  const lenHeader = req.headers["content-length"];
  const given = lenHeader != null ? Number(lenHeader) : null;
  if (given != null && (!Number.isSafeInteger(given) || given < 0)) throw new DavError(400, "Bad Content-Length");

  // Previous versions (and leftovers of failed uploads) are replaced once the new one is complete.
  // Both lookups run in parallel: every database query is a network round trip.
  const [clash, previous] = await Promise.all([
    prisma.folder.count({ where: { userId: big(uid), teamId: null, parentId: parent, name, trashedAt: null } }),
    prisma.file.findMany({
      where: { userId: big(uid), teamId: null, folderId: parent, name, trashedAt: null, transferOf: null },
      select: { id: true },
    }),
  ]);
  if (clash) throw new DavError(405, "A folder with that name exists");

  const mime = mimeFor(name);
  const base = { userId: big(uid), teamId: null, name, folderId: parent, mime, chunkSize: CHUNK_SIZE };
  type Extra = Omit<Prisma.FileUncheckedCreateInput, "userId" | "teamId" | "name" | "folderId" | "mime" | "chunkSize">;
  const createRow = (data: Extra) =>
    prisma.file.create({ data: { ...base, ...data }, select: { id: true } }).catch((e) => {
      // The parent folder was deleted (or the cached id was stale): a client error, not a crash.
      if (isForeignKeyViolation(e)) {
        clearFolderCache();
        throw new DavError(409, "Parent folder does not exist");
      }
      throw e;
    });

  // Body of unknown length: save it to a temp file first so its size is known.
  let declared = given ?? 0;
  let body: AsyncIterable<Buffer> = req as AsyncIterable<Buffer>;
  let cleanup: (() => Promise<void>) | null = null;
  if (given == null) {
    const sp = await spool(req);
    declared = sp.size;
    body = sp.body;
    cleanup = sp.cleanup;
  }

  let fileId: bigint | null = null;
  try {
    if (declared === 0) {
      for await (const _ of body) void _;
      await createRow({ size: BigInt(0), chunkCount: 0, status: "ready", backend: "telegram" });
    } else {
      const dest = await pickDest(device, declared);
      if (dest.backend === "gdrive") {
        const meta = { name, mime, parentId: dest.parent };
        if (declared <= CHUNK_SIZE) {
          // Small file: one request.
          const parts: Buffer[] = [];
          for await (const part of body) parts.push(part);
          const bytes = Buffer.concat(parts);
          if (bytes.length !== declared) throw new DavError(400, "Upload was cut short");
          const driveId = await driveRetry(() => uploadMultipart(dest.token, meta, bytes));
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
          for await (const piece of pieces(body, CHUNK_SIZE)) {
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
        // Telegram or R2: 4 MB chunks.
        const backend = dest.backend as ChunkedBackend;
        const connectionId = "connectionId" in dest ? dest.connectionId : null;
        let idx = 0;
        let total = 0;
        let last: Buffer | null = null;
        for await (const piece of pieces(body, CHUNK_SIZE)) {
          // Hold one piece back so the final one also marks the file ready (one query instead of two).
          if (last) {
            fileId ??= (await createRow({ size: BigInt(declared), chunkCount: 0, status: "uploading", backend, connectionId })).id;
            await storeChunk(uid, fileId, idx++, backend, last, { waitOnRateLimit: true });
          }
          last = Buffer.from(piece);
          total += piece.length;
        }
        if (declared !== total) throw new DavError(400, "Upload was cut short");
        fileId ??= (await createRow({ size: BigInt(total), chunkCount: 0, status: "uploading", backend, connectionId })).id;
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
  } finally {
    await cleanup?.();
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
    await prisma.folder.create({ data: { userId: big(uid), teamId: null, parentId: parent, name } });
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
