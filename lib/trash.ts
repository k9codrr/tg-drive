// Trash: moving files/folders to the trash, restoring them, deleting forever, and the 30-day purge.
//
// Trashing a folder stamps the folder and everything inside it with the same trashed_at, and marks
// only the folder as trash_root (that's what the Trash view lists). Restoring clears exactly the rows
// with that stamp, so things that were trashed separately earlier stay in the trash.
//
// Everything works on a Space (private or team); permission checks are done by the callers.
import { purgeStorage } from "./cleanup";
import { clearFolderCache } from "./dav/fs";
import { big, isUniqueViolation, prisma } from "./db";
import { HttpError } from "./http";
import { personal, type Space, spaceSql, spaceWhere } from "./space";

export const TRASH_DAYS = 30;

/** Moves files to the trash. Returns how many were moved. */
export async function trashFiles(space: Space, ids: bigint[]) {
  if (!ids.length) return 0;
  const { count } = await prisma.file.updateMany({
    where: { id: { in: ids }, ...spaceWhere(space), trashedAt: null, transferOf: null },
    data: { trashedAt: new Date(), trashRoot: true },
  });
  return count;
}

/** Moves a folder and everything in it to the trash. */
export async function trashFolder(space: Space, id: bigint) {
  const at = new Date();
  const n = await prisma.$executeRaw`
    WITH RECURSIVE tree AS (
      SELECT id FROM folders WHERE id = ${id} AND ${spaceSql(space)} AND trashed_at IS NULL
      UNION ALL
      SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.trashed_at IS NULL
    ),
    ff AS (
      UPDATE files SET trashed_at = ${at}, trash_root = false
      WHERE folder_id IN (SELECT id FROM tree) AND trashed_at IS NULL
    )
    UPDATE folders SET trashed_at = ${at}, trash_root = (id = ${id})
    WHERE id IN (SELECT id FROM tree)`;
  clearFolderCache();
  if (!n) throw new HttpError(404, "Folder not found");
}

/** Whether a folder exists in the space and is not in the trash. */
async function liveFolder(space: Space, id: bigint | null) {
  if (id == null) return true;
  return (await prisma.folder.count({ where: { id, ...spaceWhere(space), trashedAt: null } })) > 0;
}

export async function restoreFile(space: Space, id: bigint) {
  const f = await prisma.file.findFirst({ where: { id, ...spaceWhere(space), trashRoot: true }, select: { folderId: true } });
  if (!f) throw new HttpError(404, "Not in the trash");
  // If its folder is gone (trashed too), it comes back to the top of the space.
  const folderId = (await liveFolder(space, f.folderId)) ? f.folderId : null;
  await prisma.file.update({ where: { id }, data: { trashedAt: null, trashRoot: false, folderId } });
  return { folderId: folderId == null ? null : String(folderId) };
}

export async function restoreFolder(space: Space, id: bigint) {
  const f = await prisma.folder.findFirst({
    where: { id, ...spaceWhere(space), trashRoot: true },
    select: { name: true, parentId: true, trashedAt: true },
  });
  if (!f || !f.trashedAt) throw new HttpError(404, "Not in the trash");
  const parentId = (await liveFolder(space, f.parentId)) ? f.parentId : null;

  // A live folder with the same name may exist by now: use "name (restored)", "(restored 2)"…
  for (let n = 0; n < 50; n++) {
    const name = n === 0 ? f.name : `${f.name} (restored${n > 1 ? ` ${n}` : ""})`;
    try {
      await prisma.$transaction([
        prisma.folder.update({ where: { id }, data: { name, parentId, trashedAt: null, trashRoot: false } }),
        prisma.$executeRaw`
          WITH RECURSIVE tree AS (
            SELECT id FROM folders WHERE parent_id = ${id} AND trashed_at = ${f.trashedAt}
            UNION ALL
            SELECT c.id FROM folders c JOIN tree t ON c.parent_id = t.id WHERE c.trashed_at = ${f.trashedAt}
          ),
          ff AS (
            UPDATE files SET trashed_at = NULL, trash_root = false
            WHERE trashed_at = ${f.trashedAt} AND trash_root = false
              AND (folder_id = ${id} OR folder_id IN (SELECT id FROM tree))
          )
          UPDATE folders SET trashed_at = NULL, trash_root = false WHERE id IN (SELECT id FROM tree)`,
      ]);
      clearFolderCache();
      return { name, parentId: parentId == null ? null : String(parentId) };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new HttpError(409, "Couldn't restore: too many folders with that name");
}

/** Every file id inside the given folders (recursively, whatever their trash state). */
async function filesUnder(space: Space, folderIds: bigint[]) {
  if (!folderIds.length) return [];
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM folders WHERE id = ANY(${folderIds}) AND ${spaceSql(space)}
      UNION ALL
      SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
    )
    SELECT id FROM files WHERE folder_id IN (SELECT id FROM tree)`;
  return rows.map((r) => r.id);
}

/** Deletes files and folders for good: stored bytes first, then the rows. */
export async function deleteForever(space: Space, fileIds: bigint[], folderIds: bigint[]) {
  const where = spaceWhere(space);
  const ownFiles = fileIds.length
    ? (await prisma.file.findMany({ where: { id: { in: fileIds }, ...where }, select: { id: true } })).map((f) => f.id)
    : [];
  const inside = await filesUnder(space, folderIds);
  const all = [...new Set([...ownFiles, ...inside].map(String))];
  // Copies being built for a storage move go too.
  const copies = all.length
    ? await prisma.file.findMany({ where: { transferOf: { in: all.map(big) } }, select: { id: true } })
    : [];
  await purgeStorage([...all, ...copies.map((c) => String(c.id))]);
  if (ownFiles.length) await prisma.file.deleteMany({ where: { id: { in: ownFiles }, ...where } });
  // Subfolders, files and chunks go with the folders (ON DELETE CASCADE).
  if (folderIds.length) await prisma.folder.deleteMany({ where: { id: { in: folderIds }, ...where } });
  clearFolderCache();
}

export async function emptyTrash(space: Space) {
  const where = spaceWhere(space);
  const [files, folders] = await Promise.all([
    prisma.file.findMany({ where: { ...where, trashRoot: true }, select: { id: true } }),
    prisma.folder.findMany({ where: { ...where, trashRoot: true }, select: { id: true } }),
  ]);
  await deleteForever(
    space,
    files.map((f) => f.id),
    folders.map((f) => f.id),
  );
  return files.length + folders.length;
}

/** Deletes everything that has been in the trash for more than TRASH_DAYS (all users and teams). */
export async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86_400_000);
  const sel = { id: true, userId: true, teamId: true } as const;
  const [files, folders] = await Promise.all([
    prisma.file.findMany({ where: { trashRoot: true, trashedAt: { lt: cutoff } }, select: sel }),
    prisma.folder.findMany({ where: { trashRoot: true, trashedAt: { lt: cutoff } }, select: sel }),
  ]);
  const bySpace = new Map<string, { space: Space; files: bigint[]; folders: bigint[] }>();
  const slot = (r: { userId: bigint | null; teamId: bigint | null }) => {
    const k = r.teamId != null ? `t${r.teamId}` : `u${r.userId}`;
    if (!bySpace.has(k)) {
      // The purge acts with no particular user: a team space only needs its id for filtering.
      const space: Space =
        r.teamId != null
          ? { kind: "team", uid: "0", teamId: r.teamId, role: "owner", name: "" }
          : personal(String(r.userId));
      bySpace.set(k, { space, files: [], folders: [] });
    }
    return bySpace.get(k)!;
  };
  files.filter((f) => f.teamId != null || f.userId != null).forEach((f) => slot(f).files.push(f.id));
  folders.filter((f) => f.teamId != null || f.userId != null).forEach((f) => slot(f).folders.push(f.id));
  for (const { space, files: fs, folders: ds } of bySpace.values()) {
    await deleteForever(space, fs, ds).catch((e) => console.warn("[trash] purge failed:", e));
  }
  return files.length + folders.length;
}
