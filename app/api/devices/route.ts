import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { createDevice } from "@/lib/devices";
import { fail, HttpError, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/devices → devices that can mount your drive
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    const [user, rows] = await Promise.all([
      prisma.user.findUnique({ where: { id: big(uid) }, select: { email: true } }),
      prisma.deviceToken.findMany({
        where: { userId: big(uid) },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      }),
    ]);
    return NextResponse.json({
      email: user?.email ?? "",
      devices: rows.map((d) => ({ ...d, id: String(d.id) })),
    });
  } catch (e) {
    return fail(e);
  }
}

// POST /api/devices { name } → new device password (shown once)
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) throw new HttpError(400, "Give the device a name");
    return NextResponse.json(await createDevice(uid, name));
  } catch (e) {
    return fail(e);
  }
}
