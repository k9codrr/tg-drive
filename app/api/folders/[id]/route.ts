import { NextResponse } from "next/server";
import { clearFolderCache } from "@/lib/dav/fs";
import { big, prisma } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
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
    const data: { name?: string; starred?: boolean } = {};
    if ("name" in body) data.name = cleanName(body.name);
    if ("starred" in body) data.starred = body.starred === true;
    const { count } = await prisma.folder.updateMany({
      where: { id: big(id), userId: big(uid) },
      data,
    });
    clearFolderCache(); // old path must stop resolving on the WebDAV drive
    if (!count) throw new HttpError(404, "Folder not found");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/folders/:id            → moves the folder (and everything in it) to the trash
// DELETE /api/folders/:id?forever=1  → deletes it, all subfolders, files and their stored bytes for good
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const n = await prisma.folder.count({ where: { id: big(id), userId: big(uid) } });
    if (!n) throw new HttpError(404, "Folder not found");
    if (new URL(req.url).searchParams.get("forever") === "1") await deleteForever(uid, [], [big(id)]);
    else await trashFolder(uid, big(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
