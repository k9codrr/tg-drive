import type { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { big, fileOut, fileOutSelect, prisma } from "@/lib/db";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOC_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt", "md", "rtf", "odt", "ods", "odp"];

function typeFilter(type: string): Prisma.FileWhereInput | null {
  switch (type) {
    case "image":
    case "video":
    case "audio":
      return { mime: { startsWith: `${type}/` } };
    case "document":
      return {
        OR: [
          { mime: { in: ["application/pdf", "text/csv"] } },
          { mime: { contains: "officedocument" } },
          { mime: { contains: "msword" } },
          { mime: { contains: "ms-excel" } },
          { mime: { contains: "ms-powerpoint" } },
          { mime: { contains: "opendocument" } },
          ...DOC_EXT.map((e) => ({ name: { endsWith: `.${e}`, mode: "insensitive" as const } })),
        ],
      };
    default:
      return null;
  }
}

// GET /api/search?q=report        → your files whose name contains the text (any folder)
// GET /api/search?type=image      → all images (also video | audio | document), newest first
// GET /api/search?recent=1        → your most recently added files
// q and type can be combined.
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    const type = typeFilter(sp.get("type") ?? "");
    const recent = sp.get("recent") === "1";
    if (!q && !type && !recent) return NextResponse.json({ files: [] });

    const where: Prisma.FileWhereInput = { userId: big(uid), AND: [] };
    const and = where.AND as Prisma.FileWhereInput[];
    if (q) and.push({ name: { contains: q, mode: "insensitive" } });
    if (type) and.push(type);
    if (recent) and.push({ status: "ready" });

    const files = await prisma.file.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: recent ? 100 : 300,
      select: fileOutSelect,
    });
    return NextResponse.json({ files: files.map(fileOut) });
  } catch (e) {
    return fail(e);
  }
}
