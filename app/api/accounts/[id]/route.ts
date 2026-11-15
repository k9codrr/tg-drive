import { NextResponse } from "next/server";
import { openString } from "@/lib/crypto";
import { big, prisma } from "@/lib/db";
import { revokeToken } from "@/lib/google";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/accounts/:id → disconnect a Google account (only if no files are stored in it)
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const acct = await prisma.googleAccount.findFirst({
      where: { id: big(id), userId: big(uid) },
      select: { email: true, refreshToken: true },
    });
    if (!acct) throw new HttpError(404, "Account not found");

    const n = await prisma.file.count({ where: { gdAccountId: big(id) } });
    if (n > 0) {
      throw new HttpError(
        409,
        `${n} file(s) are stored in ${acct.email}. Delete or download them before disconnecting.`,
      );
    }
    try {
      await revokeToken(openString(acct.refreshToken));
    } catch {
      /* ignore */
    }
    await prisma.googleAccount.delete({ where: { id: big(id) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
