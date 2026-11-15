import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { forgetDeviceCache } from "@/lib/devices";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/devices/:id → revoke a device password
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const { count } = await prisma.deviceToken.deleteMany({ where: { id: big(id), userId: big(uid) } });
    if (!count) throw new HttpError(404, "Device not found");
    forgetDeviceCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
