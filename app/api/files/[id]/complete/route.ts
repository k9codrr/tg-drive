import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { refreshQuota } from "@/lib/google";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/files/:id/complete → mark ready once everything is stored
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const file = await prisma.file.findFirst({
      where: { id: big(id), userId: big(uid) },
      select: {
        size: true,
        chunkCount: true,
        backend: true,
        gdAccountId: true,
        gdFileId: true,
        uploadedBytes: true,
        _count: { select: { chunks: true } },
      },
    });
    if (!file) throw new HttpError(404, "File not found");

    if (file.backend === "gdrive" && file.chunkCount > 0) {
      if (file.uploadedBytes !== file.size || !file.gdFileId) {
        throw new HttpError(409, "Drive upload is not finished");
      }
      await prisma.file.update({ where: { id: big(id) }, data: { status: "ready", gdUploadUrl: null } });
      if (file.gdAccountId != null) await refreshQuota(String(file.gdAccountId)).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    const stored = file._count.chunks;
    if (stored !== file.chunkCount) {
      throw new HttpError(409, `Only ${stored}/${file.chunkCount} chunks uploaded`);
    }
    await prisma.file.update({ where: { id: big(id) }, data: { status: "ready" } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
