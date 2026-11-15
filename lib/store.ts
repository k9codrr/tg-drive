// Storing and reading the bytes of one 4 MB chunk, shared by the web upload API, the WebDAV drive and
// storage moves. Where a chunk goes follows its file: files.backend + files.connection_id
//   telegram (no connection)  the server's bot (TELEGRAM_*)      telegram + connection  that bot
//   r2                         the server's R2 bucket (R2_*)     s3 + connection        that bucket
//   webdav + connection        that WebDAV folder
// Chunk rows keep tg_file_id/tg_message_id (Telegram) or r2_key (an object key, for r2/s3/webdav).
import { connConfig } from "./connections";
import { decrypt, encrypt, encryptionEnabled } from "./crypto";
import { prisma } from "./db";
import { r2Get, r2Key, r2Put } from "./r2";
import { s3Get, s3Put } from "./s3";
import { fetchChunk, sendChunk, type TelegramCreds, TelegramRateLimit } from "./telegram";
import { davGet, davPut } from "./webdav-client";

export type ChunkedBackend = "telegram" | "r2" | "s3" | "webdav";

// files.connection_id per file, cached briefly (it's needed for every chunk). It only changes when a
// storage move swaps a copy in, which calls forgetFileStore().
const g = globalThis as unknown as { tgdFileConn?: Map<string, { conn: bigint | null; at: number }> };
const fileConn = (g.tgdFileConn ??= new Map());
const FILE_CONN_MS = 60_000;
export const forgetFileStore = (fileId: bigint) => fileConn.delete(String(fileId));

async function connectionOf(fileId: bigint): Promise<bigint | null> {
  const hit = fileConn.get(String(fileId));
  if (hit && Date.now() - hit.at < FILE_CONN_MS) return hit.conn;
  const f = await prisma.file.findUnique({ where: { id: fileId }, select: { connectionId: true } });
  const conn = f?.connectionId ?? null;
  if (fileConn.size > 10_000) fileConn.clear();
  fileConn.set(String(fileId), { conn, at: Date.now() });
  return conn;
}

async function telegramCreds(conn: bigint | null): Promise<TelegramCreds | null> {
  if (conn == null) return null; // the server's bot
  const c = await connConfig(conn);
  if (c.kind !== "telegram") throw new Error(`Connection ${conn} isn't a Telegram connection`);
  return c.cfg;
}

/** Writes an object-style chunk (r2 / s3 / webdav) and returns its key. */
async function putObject(conn: bigint | null, key: string, data: Buffer) {
  if (conn == null) return r2Put(key, data);
  const c = await connConfig(conn);
  if (c.kind === "s3") return s3Put(c.cfg, key, data);
  if (c.kind === "webdav") return davPut(c.cfg, key, data);
  throw new Error(`Connection ${conn} can't store objects`);
}

async function getObject(conn: bigint | null, key: string) {
  if (conn == null) return r2Get(key);
  const c = await connConfig(conn);
  if (c.kind === "s3") return s3Get(c.cfg, key);
  if (c.kind === "webdav") return davGet(c.cfg, key);
  throw new Error(`Connection ${conn} can't store objects`);
}

/**
 * Encrypts (if ENCRYPTION_KEY is set), uploads and records one chunk. Idempotent per (fileId, idx).
 * With `finish`, this is the file's last chunk: the chunk row and the file's "ready" status are
 * written in one statement (saves a database round trip per small file).
 */
export async function storeChunk(
  uid: string,
  fileId: bigint,
  idx: number,
  backend: ChunkedBackend,
  raw: Buffer,
  opts: { waitOnRateLimit?: boolean; finish?: { size: number } } = {},
) {
  const encrypted = encryptionEnabled();
  const payload = encrypted ? encrypt(raw) : raw;
  const conn = await connectionOf(fileId);

  let row: { r2Key: string | null; tgFileId: string | null; tgMessageId: bigint | null };
  if (backend === "telegram") {
    const creds = await telegramCreds(conn);
    const tg = await withRateLimit(() => sendChunk(payload, `f${fileId}_c${idx}.bin`, creds), !!opts.waitOnRateLimit);
    row = { r2Key: null, tgFileId: tg.fileId, tgMessageId: BigInt(tg.messageId) };
  } else {
    const key = r2Key(uid, String(fileId), idx);
    await putObject(conn, key, payload);
    row = { r2Key: key, tgFileId: null, tgMessageId: null };
  }

  if (opts.finish) {
    await prisma.$executeRaw`
      WITH c AS (
        INSERT INTO chunks (file_id, idx, size, encrypted, tg_file_id, tg_message_id, r2_key)
        VALUES (${fileId}, ${idx}, ${raw.byteLength}, ${encrypted}, ${row.tgFileId}, ${row.tgMessageId}, ${row.r2Key})
        ON CONFLICT DO NOTHING
      )
      UPDATE files
      SET size = ${BigInt(opts.finish.size)}, chunk_count = ${idx + 1}, status = 'ready', updated_at = now()
      WHERE id = ${fileId}`;
    return;
  }
  await prisma.chunk.createMany({
    data: { fileId, idx, size: raw.byteLength, encrypted, ...row },
    skipDuplicates: true,
  });
}

/** Raw (decrypted) bytes of one stored chunk. */
export async function readChunk(fileId: bigint, idx: number): Promise<Buffer | null> {
  const row = await prisma.chunk.findUnique({
    where: { fileId_idx: { fileId, idx } },
    // The connection comes with the chunk (same query), so reads are never stale after a storage move.
    select: { tgFileId: true, r2Key: true, encrypted: true, file: { select: { connectionId: true } } },
  });
  if (!row) return null;
  const conn = row.file.connectionId;
  const data = row.r2Key
    ? await getObject(conn, row.r2Key)
    : await withRateLimit(async () => fetchChunk(String(row.tgFileId), await telegramCreds(conn)), true);
  return row.encrypted ? decrypt(data) : data;
}

/** The browser retries rate limits itself; background clients (the drive) wait here instead. */
async function withRateLimit<T>(fn: () => Promise<T>, wait: boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!wait || !(e instanceof TelegramRateLimit) || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, e.retryAfter * 1000 + 500));
    }
  }
}
