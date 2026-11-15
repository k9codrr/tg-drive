// Moving a file's bytes to another storage (Telegram ⇄ R2 ⇄ Google Drive).
//
// The copy is written into a hidden row (transfer_of = original) one 4 MB piece at a time, so a move
// can be spread over many short requests (serverless time limits) and resumes after a crash. When the
// copy is complete it is swapped in under the original id (links, folder, star, trash state stay the
// same) and the old bytes are deleted.
//
// The same machinery encrypts a plain file or removes a file's encryption (`change`): the bytes are
// decrypted with the old key and/or encrypted with a new one on their way into the copy. A plain move
// of an encrypted file copies the encrypted bytes as they are (and keeps its encryption settings).
import { Prisma } from "@prisma/client";
import { collectRefs, deleteRefs, purgeStorage } from "./cleanup";
import { CHUNK_SIZE } from "./config";
import { big, prisma } from "./db";
import { accessTokenFor, downloadRange, pickAccount, putResumableSafe, refreshQuota, startResumable } from "./google";
import { HttpError } from "./http";
import { asFileEnc, checkNewPassword, ctr, type FileEnc, newFileEnc, pendingKey, sealPending } from "./filecrypt";
import { type ChunkedBackend, forgetFileStore, readChunk, storeChunk } from "./store";
import { type Space, spaceSql, spaceWhere } from "./space";
import { chunkStoreFor, type Target } from "./storage";

const LOCK_MS = 2 * 60_000;

const fileSelect = {
  id: true,
  userId: true,
  teamId: true,
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
  encryption: true,
  connectionId: true,
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
  encryption: Prisma.JsonValue;
  connectionId: bigint | null;
};

/** Encrypt a plain file (with a new password), or decrypt an encrypted one (with its unlocked key). */
export type EncChange = { mode: "encrypt"; password: string } | { mode: "decrypt"; key: Buffer };

const toJson = (e: FileEnc | null) => (e ? (e as unknown as Prisma.InputJsonValue) : Prisma.DbNull);
const withoutPending = (e: FileEnc | null): FileEnc | null => {
  if (!e) return null;
  const { pending: _p, ...rest } = e;
  void _p;
  return rest;
};

/** True if the file already lives where the target says ("telegram"/"r2"/"webdav" = any store of that kind). */
export function isOn(f: { backend: string; gdAccountId: bigint | null; connectionId: bigint | null }, t: Target) {
  if (t.backend === "conn") return f.connectionId != null && String(f.connectionId) === t.connectionId;
  if (t.backend === "r2") return f.backend === "r2" || f.backend === "s3";
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
/**
 * `space` is the file's space (the caller checked the user may move storage there); `uid` is the user
 * doing it — a move to Google uses *their* connected accounts.
 */
export async function transferStep(
  space: Space,
  fileId: bigint,
  target: Target,
  deadline: number,
  change: EncChange | null = null,
) {
  const uid = space.uid;
  const orig = await prisma.file.findFirst({
    where: { id: fileId, ...spaceWhere(space), transferOf: null },
    select: fileSelect,
  });
  if (!orig) throw new HttpError(404, "File not found");
  const size = Number(orig.size);
  if (orig.status !== "ready") throw new HttpError(409, `${orig.name} hasn't finished uploading`);
  const origEnc = asFileEnc(orig.encryption);
  if (change?.mode === "encrypt" && origEnc) throw new HttpError(409, `${orig.name} is already encrypted`);
  if (change?.mode === "decrypt" && !origEnc) throw new HttpError(409, `${orig.name} isn't encrypted`);
  if (change?.mode === "encrypt") checkNewPassword(change.password);
  if (!change && isOn(orig, target)) return { done: true, skipped: true, copied: size, size };

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
      const encryption =
        change?.mode === "encrypt" ? (await newFileEnc(change.password)).enc : change?.mode === "decrypt" ? null : origEnc;
      const store =
        target.backend === "gdrive"
          ? { backend: "gdrive", connectionId: null }
          : await chunkStoreFor(space, target, 0).catch(() => ({ backend: "telegram", connectionId: null }));
      await prisma.file.update({
        where: { id: fileId },
        data: {
          encryption: toJson(encryption),
          backend: store.backend,
          connectionId: store.connectionId,
          gdAccountId: target.backend === "gdrive" && target.accountId ? big(target.accountId) : null,
          gdFileId: null,
          gdUploadUrl: null,
          transferLock: null,
        },
      });
      finished = true;
      return { done: true, copied: 0, size };
    }

    // The copy ends up encrypted when encrypting, plain when decrypting, else like the original.
    const wantEncrypted = change ? change.mode === "encrypt" : !!origEnc;
    let copy = await prisma.file.findFirst({ where: { transferOf: fileId }, select: fileSelect });
    if (copy && (!isOn(copy, target) || !!asFileEnc(copy.encryption) !== wantEncrypted)) {
      // A move to somewhere else was started earlier: throw that copy away.
      await purgeStorage([String(copy.id)]);
      await prisma.file.delete({ where: { id: copy.id } });
      copy = null;
    }
    if (!copy) copy = await createCopy(space, orig, target, change, origEnc);

    // What happens to the bytes on their way into the copy (at their offset `pos`).
    const copyEnc = asFileEnc(copy.encryption);
    const copyKey = change?.mode === "encrypt" && copyEnc ? pendingKey(copyEnc) : null;
    const xform = (bytes: Buffer, pos: number) => {
      if (change?.mode === "decrypt" && origEnc) return ctr(change.key, origEnc, pos, bytes);
      if (copyKey && copyEnc) return ctr(copyKey, copyEnc, pos, bytes);
      return bytes; // a plain move: encrypted bytes stay encrypted, unchanged
    };

    const total = Math.ceil(size / CHUNK_SIZE);
    if (copy.backend === "gdrive") {
      let pos = Number(copy.uploadedBytes);
      while (pos < size && Date.now() < deadline) {
        const end = Math.min(size, pos + CHUNK_SIZE) - 1;
        const bytes = xform(await readRange(orig, pos, end), pos);
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
        const bytes = xform(await readRange(orig, start, Math.min(size, start + CHUNK_SIZE) - 1), start);
        await storeChunk(uid, copy.id, idx, copy.backend as ChunkedBackend, bytes, { waitOnRateLimit: true });
        have.add(idx);
        // Keeps updated_at fresh, so a long move isn't mistaken for an abandoned one.
        await prisma.file.update({ where: { id: copy.id }, data: { uploadedBytes: { increment: bytes.length } } });
      }
    }

    await swapIn(orig, copy, !!change);
    finished = true;
    return { done: true, copied: size, size };
  } finally {
    if (!finished) await prisma.file.updateMany({ where: { id: fileId }, data: { transferLock: null } }).catch(() => {});
  }
}

async function createCopy(
  space: Space,
  orig: Row & { folderId: bigint | null; teamId: bigint | null },
  target: Target,
  change: EncChange | null,
  origEnc: FileEnc | null,
) {
  const uid = space.uid;
  const size = Number(orig.size);
  // Encrypting: the new key is kept (sealed with the server key) in the hidden copy while the move runs,
  // because the move spans many requests; it's dropped when the copy is swapped in.
  let encryption: FileEnc | null = origEnc;
  if (change?.mode === "encrypt") {
    const { key, enc } = await newFileEnc(change.password);
    encryption = { ...enc, pending: sealPending(key) };
  } else if (change?.mode === "decrypt") encryption = null;
  const base = {
    encryption: toJson(encryption),
    userId: big(uid),
    teamId: orig.teamId,
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
    const account = await pickAccount(uid, size, target.accountId, space.kind === "team" ? space.teamId : null);
    const { token, row: acct } = await accessTokenFor(account.id);
    const url = await startResumable(token, { name: orig.name, mime: orig.mime, size, parentId: acct.rootFolderId || null });
    return prisma.file.create({
      data: { ...base, backend: "gdrive", gdAccountId: big(account.id), gdUploadUrl: url },
      select: fileSelect,
    });
  }
  // Telegram / S3 / WebDAV: resolved like an upload (own connection → team's → server's).
  const store = await chunkStoreFor(space, target, size);
  return prisma.file.create({
    data: { ...base, backend: store.backend, connectionId: store.connectionId },
    select: fileSelect,
  });
}

/** Puts the finished copy's bytes under the original id, then deletes the old bytes. */
async function swapIn(orig: Row, copy: Row, encChanged: boolean) {
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
        connectionId: copy.connectionId,
        uploadedBytes: copy.backend === "gdrive" ? orig.size : BigInt(0),
        transferLock: null,
        ...(encChanged ? { encryption: toJson(withoutPending(asFileEnc(copy.encryption))) } : {}),
      },
    }),
    // A new key (or none): keys wrapped for shares of the old one no longer apply.
    ...(encChanged ? [prisma.share.updateMany({ where: { fileId: orig.id }, data: { keyWrap: Prisma.DbNull } })] : []),
    prisma.file.delete({ where: { id: copy.id } }),
  ]);
  forgetFileStore(orig.id);
  await deleteRefs(old).catch((e) => console.warn("[transfer] old bytes not deleted:", e));
  const accounts = new Set([orig.gdAccountId, copy.gdAccountId].filter((a) => a != null).map(String));
  await Promise.allSettled([...accounts].map((a) => refreshQuota(a)));
}

/** Files (not in the trash, finished) that a move of these files/folders would touch. */
export async function filesToMove(space: Space, fileIds: bigint[], folderIds: bigint[], target: Target) {
  let inside: bigint[] = [];
  if (folderIds.length) {
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders WHERE id = ANY(${folderIds}) AND ${spaceSql(space)} AND trashed_at IS NULL
        UNION ALL
        SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.trashed_at IS NULL
      )
      SELECT id FROM files WHERE folder_id IN (SELECT id FROM tree)`;
    inside = rows.map((r) => r.id);
  }
  const files = await prisma.file.findMany({
    where: {
      ...spaceWhere(space),
      id: { in: [...fileIds, ...inside] },
      status: "ready",
      trashedAt: null,
      transferOf: null,
    },
    select: { id: true, name: true, size: true, backend: true, gdAccountId: true, connectionId: true },
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
