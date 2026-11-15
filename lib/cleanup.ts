// Removes the stored bytes (Telegram messages, R2/S3 objects, WebDAV files, Drive files) for a set of files.
// Everything here is best-effort: the database rows are deleted afterwards regardless.
import { connConfig } from "./connections";
import { big, prisma } from "./db";
import { deleteDriveFiles } from "./google";
import { r2Delete } from "./r2";
import { s3Delete } from "./s3";
import { deleteMessages } from "./telegram";
import { davDelete } from "./webdav-client";

/** Chunk refs per place: key "env" = the server's own Telegram/R2, else a connection id. */
type Place = { tgMessageIds: number[]; keys: string[] };
export type StorageRefs = {
  places: Map<string, Place>;
  drive: { accountId: string; fileId: string }[];
};

/** Where the bytes of these files live (read before the rows change or go away). */
export async function collectRefs(fileIds: string[]): Promise<StorageRefs> {
  const places = new Map<string, Place>();
  if (!fileIds.length) return { places, drive: [] };
  const ids = fileIds.map(big);
  const [chunks, drive] = await Promise.all([
    prisma.chunk.findMany({
      where: { fileId: { in: ids } },
      select: { tgMessageId: true, r2Key: true, file: { select: { connectionId: true } } },
    }),
    prisma.file.findMany({
      where: { id: { in: ids }, gdFileId: { not: null }, gdAccountId: { not: null } },
      select: { gdAccountId: true, gdFileId: true },
    }),
  ]);
  for (const c of chunks) {
    const k = c.file.connectionId == null ? "env" : String(c.file.connectionId);
    const p = places.get(k) ?? { tgMessageIds: [], keys: [] };
    if (c.tgMessageId != null) p.tgMessageIds.push(Number(c.tgMessageId));
    if (c.r2Key != null) p.keys.push(c.r2Key);
    places.set(k, p);
  }
  return { places, drive: drive.map((f) => ({ accountId: String(f.gdAccountId), fileId: String(f.gdFileId) })) };
}

export async function deleteRefs(refs: StorageRefs) {
  const jobs: Promise<unknown>[] = [deleteDriveFiles(refs.drive)];
  for (const [k, p] of refs.places) {
    if (k === "env") {
      jobs.push(deleteMessages(p.tgMessageIds), r2Delete(p.keys));
      continue;
    }
    jobs.push(
      (async () => {
        const c = await connConfig(k);
        if (c.kind === "telegram") await deleteMessages(p.tgMessageIds, c.cfg);
        else if (c.kind === "s3") await s3Delete(c.cfg, p.keys);
        else await davDelete(c.cfg, p.keys);
      })().catch((e) => console.warn(`Cleanup on connection ${k} failed (ignored):`, e)),
    );
  }
  await Promise.all(jobs);
}

export async function purgeStorage(fileIds: string[]) {
  if (!fileIds.length) return;
  await deleteRefs(await collectRefs(fileIds));
}
