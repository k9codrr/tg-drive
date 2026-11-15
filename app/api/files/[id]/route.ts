import { NextResponse } from "next/server";
import { big, bigOrNull, fileOut, fileOutSelect, folderExists, prisma } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { deleteForever, trashFiles } from "@/lib/trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

async function fileId(params: Ctx["params"]) {
  const id = parseId((await params).id);
  if (!id) throw new HttpError(400, "Invalid id");
  return id;
}

async function assertOwned(uid: string, id: string) {
  const n = await prisma.file.count({ where: { id: big(id), userId: big(uid) } });
  if (!n) throw new HttpError(404, "File not found");
}

// GET /api/files/:id → metadata (+ chunk count for downloading)
export async function GET(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    const file = await prisma.file.findFirst({
      where: { id: big(id), userId: big(uid) },
      select: { ...fileOutSelect, chunkCount: true },
    });
    if (!file) throw new HttpError(404, "File not found");
    return NextResponse.json({ ...fileOut(file), chunkCount: file.chunkCount });
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/files/:id { name?, folderId?, starred? } → rename, move, star
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    const body = await readJson(req);
    await assertOwned(uid, id);
    if ("name" in body) {
      const name = cleanName(body.name);
      await prisma.file.update({ where: { id: big(id) }, data: { name } });
    }
    if ("folderId" in body) {
      const folderId = parseId(body.folderId);
      if (folderId && !(await folderExists(uid, folderId))) throw new HttpError(404, "Folder not found");
      await prisma.file.update({ where: { id: big(id) }, data: { folderId: bigOrNull(folderId) } });
    }
    if ("starred" in body) {
      await prisma.file.update({ where: { id: big(id) }, data: { starred: body.starred === true } });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/files/:id            → moves the file to the trash
// DELETE /api/files/:id?forever=1  → removes the stored bytes and the DB rows for good
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    await assertOwned(uid, id);
    if (new URL(req.url).searchParams.get("forever") === "1") await deleteForever(uid, [big(id)], []);
    else await trashFiles(uid, [big(id)]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
