import { NextResponse } from "next/server";
import { big, byName, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/starred → your starred folders and files (not in the trash)
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const userId = big(uid);
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({
        where: { userId, starred: true, trashedAt: null },
        select: { id: true, name: true, createdAt: true, starred: true, parentId: true },
      }),
      prisma.file.findMany({
        where: { userId, starred: true, trashedAt: null, transferOf: null },
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
