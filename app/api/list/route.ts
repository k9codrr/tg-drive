import { NextResponse, type NextRequest } from "next/server";
import { big, bigOrNull, byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/list?folder=<id>  → contents of one of your folders (root if empty)
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const userId = big(uid);
    const folderId = parseId(req.nextUrl.searchParams.get("folder"));

    let breadcrumbs: { id: string; name: string }[] = [];
    if (folderId) {
      // Walk up to the root. Recursive CTE, so it stays raw (still parameterized).
      const chain = await prisma.$queryRaw<{ id: bigint; name: string; trashed: boolean }[]>`
        WITH RECURSIVE chain AS (
          SELECT id, name, parent_id, trashed_at, 0 AS depth FROM folders
          WHERE id = ${big(folderId)} AND user_id = ${userId}
          UNION ALL
          SELECT f.id, f.name, f.parent_id, f.trashed_at, c.depth + 1
          FROM folders f JOIN chain c ON f.id = c.parent_id
        )
        SELECT id, name, trashed_at IS NOT NULL AS trashed FROM chain ORDER BY depth DESC`;
      if (!chain.length) throw new HttpError(404, "Folder not found");
      if (chain.some((c) => c.trashed)) throw new HttpError(404, "This folder is in the trash");
      breadcrumbs = chain.map((r) => ({ id: String(r.id), name: r.name }));
    }

    const parent = bigOrNull(folderId);
    const [folders, files, stats] = await Promise.all([
      prisma.folder.findMany({
        where: { userId, parentId: parent, trashedAt: null },
        select: { id: true, name: true, createdAt: true, starred: true },
      }),
      prisma.file.findMany({
        where: { userId, folderId: parent, trashedAt: null, transferOf: null },
        select: fileOutSelect,
      }),
      prisma.file.aggregate({
        where: { userId, status: "ready", trashedAt: null, transferOf: null },
        _count: { _all: true },
        _sum: { size: true },
      }),
    ]);

    return NextResponse.json({
      folderId,
      breadcrumbs,
      folders: byName(folders).map((f) => ({ id: String(f.id), name: f.name, createdAt: f.createdAt, starred: f.starred })),
      files: byName(files).map(fileOut),
      stats: { files: stats._count._all, bytes: Number(stats._sum.size ?? 0) },
    });
  } catch (e) {
    return fail(e);
  }
}
