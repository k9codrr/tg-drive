import { NextResponse } from "next/server";
import { big, byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { emptyTrash, purgeExpiredTrash, TRASH_DAYS } from "@/lib/trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/trash → what you trashed (top-level items only), newest first
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const userId = big(uid);
    // The server also purges on a timer; this catches up where no timer runs (e.g. on Vercel).
    void purgeExpiredTrash().catch(() => {});
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({
        where: { userId, trashRoot: true },
        select: { id: true, name: true, createdAt: true, trashedAt: true, starred: true },
      }),
      prisma.file.findMany({ where: { userId, trashRoot: true }, orderBy: { trashedAt: "desc" }, select: fileOutSelect }),
    ]);
    return NextResponse.json({
      days: TRASH_DAYS,
      folders: byName(folders).map((f) => ({ ...f, id: String(f.id) })),
      files: files.map(fileOut),
    });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/trash → empty the trash (deletes everything in it for good)
export async function DELETE(req: Request) {
  try {
    const uid = await requireUser(req);
    const deleted = await emptyTrash(uid);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return fail(e);
  }
}
