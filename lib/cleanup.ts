// Removes the stored bytes (Telegram messages, R2 objects, Drive files) for a set of files.
// Everything here is best-effort: the database rows are deleted afterwards regardless.
import { big, prisma } from "./db";
import { deleteDriveFiles } from "./google";
import { r2Delete } from "./r2";
import { deleteMessages } from "./telegram";

export type StorageRefs = {
  tgMessageIds: number[];
  r2Keys: string[];
  drive: { accountId: string; fileId: string }[];
};

/** Where the bytes of these files live (read before the rows change or go away). */
export async function collectRefs(fileIds: string[]): Promise<StorageRefs> {
  if (!fileIds.length) return { tgMessageIds: [], r2Keys: [], drive: [] };
  const ids = fileIds.map(big);
  const [chunks, drive] = await Promise.all([
    prisma.chunk.findMany({ where: { fileId: { in: ids } }, select: { tgMessageId: true, r2Key: true } }),
    prisma.file.findMany({
      where: { id: { in: ids }, gdFileId: { not: null }, gdAccountId: { not: null } },
      select: { gdAccountId: true, gdFileId: true },
    }),
  ]);
  return {
    tgMessageIds: chunks.filter((c) => c.tgMessageId != null).map((c) => Number(c.tgMessageId)),
    r2Keys: chunks.filter((c) => c.r2Key != null).map((c) => String(c.r2Key)),
    drive: drive.map((f) => ({ accountId: String(f.gdAccountId), fileId: String(f.gdFileId) })),
  };
}

export async function deleteRefs(refs: StorageRefs) {
  await Promise.all([deleteMessages(refs.tgMessageIds), r2Delete(refs.r2Keys), deleteDriveFiles(refs.drive)]);
}

export async function purgeStorage(fileIds: string[]) {
  if (!fileIds.length) return;
  await deleteRefs(await collectRefs(fileIds));
}
