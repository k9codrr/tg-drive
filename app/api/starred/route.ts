import { NextResponse } from "next/server";
import { byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { spaceFor, spaceWhere } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/starred[?team=<id>] → starred folders and files (not in the trash) of your private space or a team
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const where = spaceWhere(await spaceFor(uid, new URL(req.url).searchParams.get("team")));
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({
        where: { ...where, starred: true, trashedAt: null },
        select: { id: true, name: true, createdAt: true, starred: true, parentId: true },
      }),
      prisma.file.findMany({
        where: { ...where, starred: true, trashedAt: null, transferOf: null },
        select: fileOutSelect,
      }),
    ]);
    return NextResponse.json({
      folders: byName(folders).map((f) => ({
        ...f,
        id: String(f.id),
        parentId: f.parentId == null ? null : String(f.parentId),
      })),
      files: byName(files).map(fileOut),
    });
  } catch (e) {
    return fail(e);
  }
}
