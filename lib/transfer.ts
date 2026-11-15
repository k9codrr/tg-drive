// Moving a file's bytes to another storage (Telegram ⇄ R2 ⇄ Google Drive).
//
// The copy is written into a hidden row (transfer_of = original) one 4 MB piece at a time, so a move
// can be spread over many short requests (serverless time limits) and resumes after a crash. When the
// copy is complete it is swapped in under the original id (links, folder, star, trash state stay the
// same) and the old bytes are deleted.
import { collectRefs, deleteRefs, purgeStorage } from "./cleanup";
import { CHUNK_SIZE } from "./config";
import { big, prisma } from "./db";
import { accessTokenFor, downloadRange, pickAccount, putResumableSafe, refreshQuota, startResumable } from "./google";
import { HttpError } from "./http";
import { r2Configured, r2Usage } from "./r2";
import { readChunk, storeChunk } from "./store";
import type { Target } from "./storage";

const LOCK_MS = 2 * 60_000;

const fileSelect = {
  id: true,
  userId: true,
  name: true,
  mime: true,
  size: true,
  status: true,
  folderId: true,
  chunkSize: true,
  chunkCount: true,
  backend: true,
  gdAccountId: true,
  gdFileId: true,
  gdUploadUrl: true,
  uploadedBytes: true,
} as const;
type Row = {
  id: bigint;
  name: string;
  mime: string;
  size: bigint;
  chunkSize: number;
  chunkCount: number;
  backend: string;
  gdAccountId: bigint | null;
  gdFileId: string | null;
  gdUploadUrl: string | null;
  uploadedBytes: bigint;
};

/** True if the file already lives where the target says. */
export function isOn(f: { backend: string; gdAccountId: bigint | null }, t: Target) {
  if (f.backend !== t.backend) return false;
  return t.backend !== "gdrive" || t.accountId == null || String(f.gdAccountId) === t.accountId;
}

/** Reads bytes [start, end] of a stored file, whatever its chunk size or backend. */
async function readRange(f: Row, start: number, end: number): Promise<Buffer> {
  if (f.backend === "gdrive") {
    if (!f.gdFileId || f.gdAccountId == null) throw new HttpError(404, `${f.name} is missing in Google Drive`);
    const { token } = await accessTokenFor(String(f.gdAccountId));
    return downloadRange(token, f.gdFileId, start, end);
  }
  const parts: Buffer[] = [];
  for (let idx = Math.floor(start / f.chunkSize); idx * f.chunkSize <= end; idx++) {
    const data = await readChunk(f.id, idx);
    if (!data) throw new HttpError(500, `Part ${idx + 1} of ${f.name} is missing`);
    const base = idx * f.chunkSize;
    parts.push(data.subarray(Math.max(0, start - base), Math.min(data.length, end - base + 1)));
  }
  return Buffer.concat(parts);
}

/**
 * Copies as much as fits before `deadline` (ms timestamp). Returns progress; `done` once the file
 * has been switched over to the new storage.
 */
export async function transferStep(uid: string, fileId: bigint, target: Target, deadline: number) {
  const userId = big(uid);
  const orig = await prisma.file.findFirst({ where: { id: fileId, userId, transferOf: null }, select: fileSelect });
  if (!orig) throw new HttpError(404, "File not found");
  const size = Number(orig.size);
  if (orig.status !== "ready") throw new HttpError(409, `${orig.name} hasn't finished uploading`);
  if (isOn(orig, target)) return { done: true, skipped: true, copied: size, size };

  // One mover per file at a time.
  const { count } = await prisma.file.updateMany({
    where: { id: fileId, OR: [{ transferLock: null }, { transferLock: { lt: new Date(Date.now() - LOCK_MS) } }] },
    data: { transferLock: new Date() },
  });
  if (!count) throw new HttpError(409, `${orig.name} is already being moved`);

  let finished = false;
  try {
    // Empty files have no stored bytes: just relabel them.
    if (size === 0) {
      await prisma.file.update({
        where: { id: fileId },
        data: {
          backend: target.backend,
          gdAccountId: target.backend === "gdrive" && target.accountId ? big(target.accountId) : null,
          gdFileId: null,
          gdUploadUrl: null,
          transferLock: null,
        },
      });
      finished = true;
      return { done: true, copied: 0, size };
    }

    let copy = await prisma.file.findFirst({ where: { transferOf: fileId }, select: fileSelect });
    if (copy && !isOn(copy, target)) {
      // A move to somewhere else was started earlier: throw that copy away.
      await purgeStorage([String(copy.id)]);
      await prisma.file.delete({ where: { id: copy.id } });
      copy = null;
    }
    if (!copy) copy = await createCopy(uid, orig, target);

    const total = Math.ceil(size / CHUNK_SIZE);
    if (copy.backend === "gdrive") {
      let pos = Number(copy.uploadedBytes);
      while (pos < size && Date.now() < deadline) {
        const end = Math.min(size, pos + CHUNK_SIZE) - 1;
        const bytes = await readRange(orig, pos, end);
        if (!copy.gdUploadUrl) throw new HttpError(409, "Upload session missing");
        const driveId = await putResumableSafe(copy.gdUploadUrl, bytes, pos, size);
        pos = end + 1;
        await prisma.file.update({
          where: { id: copy.id },
          data: { uploadedBytes: BigInt(pos), ...(driveId ? { gdFileId: driveId } : {}) },
        });
        if (driveId) copy.gdFileId = driveId;
      }
      if (pos < size) return { done: false, copied: pos, size };
      if (!copy.gdFileId) throw new HttpError(502, "Google Drive didn't confirm the upload");
    } else {
      const have = new Set(
        (await prisma.chunk.findMany({ where: { fileId: copy.id }, select: { idx: true } })).map((c) => c.idx),
      );
      for (let idx = 0; idx < total; idx++) {
        if (have.has(idx)) continue;
        if (Date.now() >= deadline) return { done: false, copied: have.size * CHUNK_SIZE, size };
        const start = idx * CHUNK_SIZE;
        const bytes = await readRange(orig, start, Math.min(size, start + CHUNK_SIZE) - 1);
        await storeChunk(uid, copy.id, idx, copy.backend as "telegram" | "r2", bytes, { waitOnRateLimit: true });
        have.add(idx);
        // Keeps updated_at fresh, so a long move isn't mistaken for an abandoned one.
        await prisma.file.update({ where: { id: copy.id }, data: { uploadedBytes: { increment: bytes.length } } });
      }
    }

    await swapIn(orig, copy);
    finished = true;
    return { done: true, copied: size, size };
  } finally {
    if (!finished) await prisma.file.updateMany({ where: { id: fileId }, data: { transferLock: null } }).catch(() => {});
  }
}

async function createCopy(uid: string, orig: Row & { folderId: bigint | null }, target: Target) {
  const size = Number(orig.size);
  const base = {
    userId: big(uid),
    name: orig.name,
    folderId: orig.folderId,
    size: orig.size,
    mime: orig.mime,
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.ceil(size / CHUNK_SIZE),
    status: "uploading",
    transferOf: orig.id,
  };
  if (target.backend === "gdrive") {
    const account = await pickAccount(uid, size, target.accountId);
    const { token, row: acct } = await accessTokenFor(account.id);
    const url = await startResumable(token, { name: orig.name, mime: orig.mime, size, parentId: acct.rootFolderId || null });
    return prisma.file.create({
      data: { ...base, backend: "gdrive", gdAccountId: big(account.id), gdUploadUrl: url },
      select: fileSelect,
    });
  }
  if (target.backend === "r2") {
    if (!r2Configured()) throw new HttpError(400, "Cloudflare R2 is not configured");
    if ((await r2Usage(uid)).free < size) throw new HttpError(507, "Not enough free space in Cloudflare R2");
  }
  return prisma.file.create({ data: { ...base, backend: target.backend }, select: fileSelect });
}

/** Puts the finished copy's bytes under the original id, then deletes the old bytes. */
async function swapIn(orig: Row, copy: Row) {
  const old = await collectRefs([String(orig.id)]);
  await prisma.$transaction([
    prisma.chunk.deleteMany({ where: { fileId: orig.id } }),
    prisma.$executeRaw`UPDATE chunks SET file_id = ${orig.id} WHERE file_id = ${copy.id}`,
    prisma.file.update({
      where: { id: orig.id },
      data: {
        backend: copy.backend,
        chunkSize: copy.chunkSize,
        chunkCount: copy.chunkCount,
        gdAccountId: copy.gdAccountId,
        gdFileId: copy.gdFileId,
        gdUploadUrl: null,
        uploadedBytes: copy.backend === "gdrive" ? orig.size : BigInt(0),
        transferLock: null,
      },
    }),
    prisma.file.delete({ where: { id: copy.id } }),
  ]);
  await deleteRefs(old).catch((e) => console.warn("[transfer] old bytes not deleted:", e));
  const accounts = new Set([orig.gdAccountId, copy.gdAccountId].filter((a) => a != null).map(String));
  await Promise.allSettled([...accounts].map((a) => refreshQuota(a)));
}

/** Files (not in the trash, finished) that a move of these files/folders would touch. */
export async function filesToMove(uid: string, fileIds: bigint[], folderIds: bigint[], target: Target) {
  const userId = big(uid);
  let inside: bigint[] = [];
  if (folderIds.length) {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders WHERE id = ANY(${folderIds}) AND user_id = ${userId} AND trashed_at IS NULL
        UNION ALL
        SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.trashed_at IS NULL
      )
      SELECT id FROM files WHERE folder_id IN (SELECT id FROM tree)`;
    inside = rows.map((r) => r.id);
  }
  const files = await prisma.file.findMany({
    where: {
      userId,
      id: { in: [...fileIds, ...inside] },
      status: "ready",
      trashedAt: null,
      transferOf: null,
    },
    select: { id: true, name: true, size: true, backend: true, gdAccountId: true },
  });
  return files
    .filter((f) => !isOn(f, target))
    .map((f) => ({ id: String(f.id), name: f.name, size: Number(f.size) }));
}

/** Deletes copies from moves that were abandoned (no progress for 2 days). */
export async function purgeAbandonedCopies() {
  const old = await prisma.file.findMany({
    where: { transferOf: { not: null }, updatedAt: { lt: new Date(Date.now() - 2 * 86_400_000) } },
    select: { id: true },
  });
  if (!old.length) return 0;
  await purgeStorage(old.map((f) => String(f.id)));
  await prisma.file.deleteMany({ where: { id: { in: old.map((f) => f.id) } } });
  return old.length;
}
