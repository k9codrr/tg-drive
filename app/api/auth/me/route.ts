import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { fail, HttpError } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/me → the signed-in user
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const u = await prisma.user.findUnique({
      where: { id: big(uid) },
      select: { id: true, email: true, name: true },
    });
    if (!u) throw new HttpError(401, "Account not found");
    return NextResponse.json({ id: String(u.id), email: u.email, name: u.name ?? null });
  } catch (e) {
    return fail(e);
  }
}
