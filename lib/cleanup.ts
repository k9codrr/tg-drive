// Removes the stored bytes (Telegram messages, R2 objects, Drive files) for a set of files.
// Everything here is best-effort: the database rows are deleted afterwards regardless.
import { big, prisma } from "./db";
import { deleteDriveFiles } from "./google";
import { r2Delete } from "./r2";
import { deleteMessages } from "./telegram";

export async function purgeStorage(fileIds: string[]) {
  if (!fileIds.length) return;
  const ids = fileIds.map(big);
  const [chunks, drive] = await Promise.all([
    prisma.chunk.findMany({ where: { fileId: { in: ids } }, select: { tgMessageId: true, r2Key: true } }),
    prisma.file.findMany({
      where: { id: { in: ids }, gdFileId: { not: null }, gdAccountId: { not: null } },
      select: { gdAccountId: true, gdFileId: true },
    }),
  ]);
  await Promise.all([
    deleteMessages(chunks.filter((c) => c.tgMessageId != null).map((c) => Number(c.tgMessageId))),
    r2Delete(chunks.filter((c) => c.r2Key != null).map((c) => String(c.r2Key))),
    deleteDriveFiles(drive.map((f) => ({ accountId: String(f.gdAccountId), fileId: String(f.gdFileId) }))),
  ]);
}
