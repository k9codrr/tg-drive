// Storing and reading the bytes of one 4 MB chunk, shared by the web upload API and the WebDAV drive.
import { decrypt, encrypt, encryptionEnabled } from "./crypto";
import { prisma } from "./db";
import { r2Get, r2Key, r2Put } from "./r2";
import { fetchChunk, sendChunk, TelegramRateLimit } from "./telegram";

export type ChunkedBackend = "telegram" | "r2";

/**
 * Encrypts (if enabled), uploads and records one chunk. Idempotent per (fileId, idx).
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

  let row: { r2Key: string | null; tgFileId: string | null; tgMessageId: bigint | null };
  if (backend === "r2") {
    const key = r2Key(uid, String(fileId), idx);
    await r2Put(key, payload);
    row = { r2Key: key, tgFileId: null, tgMessageId: null };
  } else {
    const tg = await withRateLimit(() => sendChunk(payload, `f${fileId}_c${idx}.bin`), !!opts.waitOnRateLimit);
    row = { r2Key: null, tgFileId: tg.fileId, tgMessageId: BigInt(tg.messageId) };
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
    select: { tgFileId: true, r2Key: true, encrypted: true },
  });
  if (!row) return null;
  const data = row.r2Key
    ? await r2Get(row.r2Key)
    : await withRateLimit(() => fetchChunk(String(row.tgFileId)), true);
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
