import { NextResponse } from "next/server";
import { big, bigOrNull, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { fileAccess, folderInSpace, requireCan, requireDeleteForever, requireEdit, requireNotShareRoot } from "@/lib/space";
import { keyFromRequest } from "@/lib/filecrypt";
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

// GET /api/files/:id → metadata (+ chunk count for downloading; `unlocked` for encrypted files)
export async function GET(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    await fileAccess(uid, id, "view");
    const file = await prisma.file.findUnique({
      where: { id: big(id) },
      select: { ...fileOutSelect, chunkCount: true },
    });
    if (!file) throw new HttpError(404, "File not found");
    const out = fileOut(file);
    return NextResponse.json({
      ...out,
      chunkCount: file.chunkCount,
      unlocked: out.encrypted ? keyFromRequest(req, uid, id) != null : true,
    });
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/files/:id { name?, folderId?, starred? } → rename, move (within the same space), star
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    const body = await readJson(req);
    const { space, file } = await fileAccess(uid, id, "view");
    if ("name" in body || "folderId" in body) {
      requireEdit(space, file.userId);
      requireNotShareRoot(space, "file", file.id);
    }
    // Stars are shared within a team, so they need the right to add things. They belong to the owner,
    // so they can't be changed through a share.
    if ("starred" in body) {
      if (space.share) throw new HttpError(403, "You can't star items someone shared with you");
      requireCan(space, "upload");
    }

    if ("name" in body) {
      const name = cleanName(body.name);
      await prisma.file.update({ where: { id: big(id) }, data: { name } });
    }
    if ("folderId" in body) {
      const folderId = parseId(body.folderId);
      if (folderId ? !(await folderInSpace(space, folderId)) : !!space.share) {
        throw new HttpError(
          404,
          space.share
            ? "You can only move it to a folder inside what was shared with you."
            : "Folder not found here. Files can only be moved within the same space.",
        );
      }
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
    const { space, file } = await fileAccess(uid, id, "view");
    requireNotShareRoot(space, "file", file.id);
    if (new URL(req.url).searchParams.get("forever") === "1") {
      requireDeleteForever(space, file.userId);
      await deleteForever(space, [big(id)], []);
    } else {
      requireEdit(space, file.userId);
      await trashFiles(space, [big(id)]);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
