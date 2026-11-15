import { NextResponse, type NextRequest } from "next/server";
import { big, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=report  → your files whose name contains the text (any folder)
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    if (!q) return NextResponse.json({ files: [] });
    const files = await prisma.file.findMany({
      where: { userId: big(uid), name: { contains: q, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: fileOutSelect,
    });
    return NextResponse.json({ files: files.map(fileOut) });
  } catch (e) {
    return fail(e);
  }
}
