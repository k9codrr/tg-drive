import { NextResponse, type NextRequest } from "next/server";
import { big, bigOrNull, byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { folderAccess, spaceFor, spaceOut, spaceSql, spaceWhere } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/list?folder=<id>       → contents of a folder (its space is worked out from the folder)
// GET /api/list[?team=<teamId>]   → top of your private space, or of a team you're in
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const sp = req.nextUrl.searchParams;
    const folderId = parseId(sp.get("folder"));
    const space = folderId ? (await folderAccess(uid, folderId)).space : await spaceFor(uid, sp.get("team"));
    const where = spaceWhere(space);

    let breadcrumbs: { id: string; name: string }[] = [];
    if (folderId) {
      // Walk up to the root. Recursive CTE, so it stays raw (still parameterized).
      const chain = await prisma.$queryRaw<{ id: bigint; name: string; trashed: boolean }[]>`
        WITH RECURSIVE chain AS (
          SELECT id, name, parent_id, trashed_at, 0 AS depth FROM folders
          WHERE id = ${big(folderId)} AND ${spaceSql(space)}
          UNION ALL
          SELECT f.id, f.name, f.parent_id, f.trashed_at, c.depth + 1
          FROM folders f JOIN chain c ON f.id = c.parent_id
        )
        SELECT id, name, trashed_at IS NOT NULL AS trashed FROM chain ORDER BY depth DESC`;
      if (!chain.length) throw new HttpError(404, "Folder not found");
      // Shared with you: the path starts at the shared folder (nothing above it is shown).
      const root = space.share?.root;
      const from = root?.kind === "folder" ? chain.findIndex((c) => c.id === root.id) : 0;
      const visible = chain.slice(Math.max(0, from));
      if (visible.some((c) => c.trashed)) throw new HttpError(404, "This folder is in the trash");
      breadcrumbs = visible.map((r) => ({ id: String(r.id), name: r.name }));
    }

    const parent = bigOrNull(folderId);
    const [folders, files, stats] = await Promise.all([
      prisma.folder.findMany({
        where: { ...where, parentId: parent, trashedAt: null },
        select: { id: true, name: true, createdAt: true, starred: true, userId: true },
      }),
      prisma.file.findMany({
        where: { ...where, folderId: parent, trashedAt: null, transferOf: null },
        select: fileOutSelect,
      }),
      // Totals of the whole space (for a share: just this folder, the rest of the space isn't yours).
      prisma.file.aggregate({
        where: { ...where, ...(space.share ? { folderId: parent } : {}), status: "ready", trashedAt: null, transferOf: null },
        _count: { _all: true },
        _sum: { size: true },
      }),
    ]);

    return NextResponse.json({
      folderId,
      space: spaceOut(space),
      breadcrumbs,
      folders: byName(folders).map((f) => ({
        id: String(f.id),
        name: f.name,
        createdAt: f.createdAt,
        starred: f.starred,
        ownerId: f.userId == null ? null : String(f.userId),
      })),
      files: byName(files).map(fileOut),
      stats: { files: stats._count._all, bytes: Number(stats._sum.size ?? 0) },
    });
  } catch (e) {
    return fail(e);
  }
}
