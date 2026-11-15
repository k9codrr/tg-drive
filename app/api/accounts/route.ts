import { NextResponse, type NextRequest } from "next/server";
import { big, prisma } from "@/lib/db";
import { googleConfigured, refreshStaleQuotas } from "@/lib/google";
import { fail, HttpError } from "@/lib/http";
import { listForUser, serverStore } from "@/lib/connections";
import { r2Configured, r2Usage } from "@/lib/r2";
import { requireUser } from "@/lib/session";
import { parseExclude } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/accounts[?refresh=1] → your storage pool: the server's Telegram + R2, your Google accounts, Google
// accounts your teams offer you, and storage connections (yours + offered by your teams)
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const userId = big(uid);
    if (googleConfigured()) await refreshStaleQuotas(uid, req.nextUrl.searchParams.get("refresh") === "1");

    const memberOf = (await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } })).map((m) => m.teamId);
    const [user, accounts, usage, r2, connections, offeredGoogle] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, defaultStorage: true, mountStorage: true, uploadExclude: true } }),
      prisma.googleAccount.findMany({
        where: { userId, teamId: null },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          name: true,
          quotaLimit: true,
          quotaUsage: true,
          quotaUpdatedAt: true,
          needsReauth: true,
        },
      }),
      prisma.file.groupBy({
        by: ["backend", "gdAccountId"],
        where: { userId, status: "ready", transferOf: null },
        _count: { _all: true },
        _sum: { size: true },
      }),
      r2Configured() ? r2Usage(uid) : Promise.resolve(null),
      listForUser(uid),
      memberOf.length
        ? prisma.googleAccount.findMany({
            where: { teamId: { in: memberOf }, offerToMembers: true, needsReauth: false },
            select: { id: true, email: true, quotaLimit: true, quotaUsage: true, team: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);
    if (!user) throw new HttpError(401, "Account not found");

    const sum = (backend: string, accountId?: string) =>
      usage
        .filter((r) => r.backend === backend && (accountId == null || String(r.gdAccountId) === accountId))
        .reduce(
          (a, r) => ({ files: a.files + r._count._all, bytes: a.bytes + Number(r._sum.size ?? 0) }),
          { files: 0, bytes: 0 },
        );
    const tg = sum("telegram");

    const google = accounts.map((a) => {
      const limit = a.quotaLimit == null ? null : Number(a.quotaLimit);
      const used = Number(a.quotaUsage);
      return {
        id: String(a.id),
        email: a.email,
        name: a.name || null,
        limit,
        used,
        free: limit == null ? null : Math.max(0, limit - used),
        needsReauth: a.needsReauth,
        updatedAt: a.quotaUpdatedAt,
        app: sum("gdrive", String(a.id)),
      };
    });
    const active = google.filter((g) => !g.needsReauth);

    return NextResponse.json({
      user: { id: String(user.id), email: user.email, name: user.name ?? null },
      defaultStorage: user.defaultStorage,
      mountStorage: user.mountStorage,
      uploadExclude: parseExclude(user.uploadExclude),
      googleConfigured: googleConfigured(),
      // "configured" = some Telegram storage is usable: the server's, your own bot, or one a team offers.
      telegram: {
        configured: !!serverStore("telegram") || [...connections.mine, ...connections.offered].some((c) => c.kind === "telegram"),
        server: !!serverStore("telegram"),
        ...tg,
      },
      connections,
      offeredGoogle: offeredGoogle.map((g) => {
        const limit = g.quotaLimit == null ? null : Number(g.quotaLimit);
        return {
          id: String(g.id),
          email: g.email,
          team: g.team?.name ?? null,
          free: limit == null ? null : Math.max(0, limit - Number(g.quotaUsage)),
        };
      }),
      r2: r2 ? { configured: true, ...r2 } : { configured: false, used: 0, files: 0, limit: 0, free: 0 },
      google,
      totals: {
        googleLimit: active.reduce((s, g) => s + (g.limit ?? 0), 0),
        googleUsed: active.reduce((s, g) => s + g.used, 0),
        googleFree: active.reduce((s, g) => s + (g.free ?? 0), 0),
        unlimitedGoogle: active.some((g) => g.limit == null),
        storedByApp: tg.bytes + (r2?.used ?? 0) + google.reduce((s, g) => s + g.app.bytes, 0),
      },
    });
  } catch (e) {
    return fail(e);
  }
}
