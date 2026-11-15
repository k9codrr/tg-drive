import { NextResponse } from "next/server";
import { byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { requireCan, spaceFor, spaceOut, spaceWhere } from "@/lib/space";
import { emptyTrash, purgeExpiredTrash, TRASH_DAYS } from "@/lib/trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/trash[?team=<id>] → what was trashed in that space (top-level items only), newest first
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const space = await spaceFor(uid, new URL(req.url).searchParams.get("team"));
    const where = spaceWhere(space);
    // The server also purges on a timer; this catches up where no timer runs (e.g. on Vercel).
    void purgeExpiredTrash().catch(() => {});
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({
        where: { ...where, trashRoot: true },
        select: { id: true, name: true, createdAt: true, trashedAt: true, starred: true, userId: true },
      }),
      prisma.file.findMany({ where: { ...where, trashRoot: true }, orderBy: { trashedAt: "desc" }, select: fileOutSelect }),
    ]);
    return NextResponse.json({
      days: TRASH_DAYS,
      space: spaceOut(space),
      folders: byName(folders).map(({ userId, ...f }) => ({
        ...f,
        id: String(f.id),
        ownerId: userId == null ? null : String(userId),
      })),
      files: files.map(fileOut),
    });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/trash[?team=<id>] → empty the trash (deletes everything in it for good; admins in a team)
export async function DELETE(req: Request) {
  try {
    const uid = await requireUser(req);
    const space = await spaceFor(uid, new URL(req.url).searchParams.get("team"));
    requireCan(space, "deleteForever");
    const deleted = await emptyTrash(space);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return fail(e);
  }
}
