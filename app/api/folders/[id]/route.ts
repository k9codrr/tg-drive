import { NextResponse } from "next/server";
import { purgeStorage } from "@/lib/cleanup";
import { clearFolderCache } from "@/lib/dav/fs";
import { big, prisma } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/folders/:id  { name } → rename
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const name = cleanName((await readJson(req)).name);
    const { count } = await prisma.folder.updateMany({
      where: { id: big(id), userId: big(uid) },
      data: { name },
    });
    clearFolderCache(); // old path must stop resolving on the WebDAV drive
    if (!count) throw new HttpError(404, "Folder not found");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/folders/:id → deletes the folder, all subfolders, files and their stored bytes
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    // Recursive CTE: Prisma has no tree queries, so this one stays raw (still parameterized).
    const files = await prisma.$queryRaw<{ id: bigint }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders WHERE id = ${big(id)} AND user_id = ${big(uid)}
        UNION ALL
        SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
      )
      SELECT id FROM files WHERE folder_id IN (SELECT id FROM tree)`;
    await purgeStorage(files.map((f) => String(f.id)));
    // Subfolders, files and chunks go with it (ON DELETE CASCADE).
    const { count } = await prisma.folder.deleteMany({ where: { id: big(id), userId: big(uid) } });
    clearFolderCache(); // the WebDAV drive must not keep writing into the deleted folder
    if (!count) throw new HttpError(404, "Folder not found");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
