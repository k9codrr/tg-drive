import { NextResponse } from "next/server";
import { listForTeam } from "@/lib/connections";
import { big, prisma } from "@/lib/db";
import { googleConfigured } from "@/lib/google";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/teams/:id/storage → the team's storage: connections (Telegram/S3/WebDAV) and Google accounts.
// Files in the team's folders use these first; ones marked "offered" members may also use privately.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid team");
    const conns = await listForTeam(uid, id); // checks membership
    const google = await prisma.googleAccount.findMany({
      where: { teamId: big(id) },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, quotaLimit: true, quotaUsage: true, needsReauth: true, offerToMembers: true },
    });
    return NextResponse.json({
      ...conns,
      googleConfigured: googleConfigured(),
      google: google.map((g) => ({
        id: String(g.id),
        email: g.email,
        limit: g.quotaLimit == null ? null : Number(g.quotaLimit),
        used: Number(g.quotaUsage),
        needsReauth: g.needsReauth,
        offerToMembers: g.offerToMembers,
      })),
    });
  } catch (e) {
    return fail(e);
  }
}
