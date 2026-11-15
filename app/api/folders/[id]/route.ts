import { NextResponse } from "next/server";
import { clearFolderCache } from "@/lib/dav/fs";
import { big, prisma } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { folderAccess, requireCan, requireEdit, requireFolderRemoval, requireNotShareRoot } from "@/lib/space";
import { deleteForever, trashFolder } from "@/lib/trash";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/folders/:id  { name?, starred? } → rename, star
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const body = await readJson(req);
    const { space, folder } = await folderAccess(uid, id, "view");
    const data: { name?: string; starred?: boolean } = {};
    if ("name" in body) {
      requireEdit(space, folder.userId);
      requireNotShareRoot(space, "folder", folder.id);
      data.name = cleanName(body.name);
    }
    if ("starred" in body) {
      if (space.share) throw new HttpError(403, "You can't star items someone shared with you");
      requireCan(space, "upload"); // stars are shared within a team
      data.starred = body.starred === true;
    }
    await prisma.folder.update({ where: { id: big(id) }, data });
    clearFolderCache(); // old path must stop resolving on the WebDAV drive
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/folders/:id            → moves the folder (and everything in it) to the trash
// DELETE /api/folders/:id?forever=1  → deletes it, all subfolders, files and their stored bytes for good
// In a team, members may only remove folders they created that hold nothing added by others.
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const { space, folder } = await folderAccess(uid, id, "view");
    const forever = new URL(req.url).searchParams.get("forever") === "1";
    await requireFolderRemoval(space, big(id), folder.userId, forever);
    if (forever) await deleteForever(space, [], [big(id)]);
    else await trashFolder(space, big(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
