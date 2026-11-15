import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { fail, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { passwordsFor } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/notifications → your latest 50 notifications and how many are unread.
// Share notifications carry the share's password (if any) — read live from the share, only for you as
// its recipient, and never stored in the notification itself.
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const userId = big(uid);
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, kind: true, title: true, body: true, data: true, readAt: true, createdAt: true },
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    const shareIdOf = (d: unknown) =>
      d && typeof d === "object" && "shareId" in d ? String((d as { shareId: unknown }).shareId) : null;
    const pw = await passwordsFor(
      uid,
      items.filter((n) => n.kind === "share" || n.kind === "share.changed").map((n) => shareIdOf(n.data)).filter((x): x is string => !!x),
    );
    return NextResponse.json({
      unread,
      items: items.map((n) => {
        const sid = shareIdOf(n.data);
        return { ...n, id: String(n.id), password: sid ? (pw.get(sid) ?? null) : null };
      }),
    });
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/notifications { ids: [..] } or { all: true } → mark as read
export async function PATCH(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    const ids = Array.isArray(body.ids)
      ? body.ids
          .map((x: unknown) => parseId(x))
          .filter((x: string | null): x is string => !!x)
          .map((x: string) => big(x))
      : [];
    await prisma.notification.updateMany({
      where: { userId: big(uid), readAt: null, ...(body.all === true ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
