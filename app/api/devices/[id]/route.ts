import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { forgetDeviceCache } from "@/lib/devices";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { cleanAllowList } from "@/lib/netacl";
import { checkMountStorage } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/devices/:id { storage?: "same" | <target>, allowedIps?: "1.2.3.4, 10.0.0.0/8" | null }
// Where this PC's drive stores new files ("same" = the account's PC drive setting), and which addresses
// may use this device password (empty = any).
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const body = await readJson(req);
    const data: { storage?: string | null; allowedIps?: string | null } = {};
    if ("storage" in body) {
      const v = await checkMountStorage(uid, body.storage ?? "same");
      data.storage = v === "same" ? null : v;
    }
    if ("allowedIps" in body) {
      try {
        data.allowedIps = cleanAllowList(body.allowedIps);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Invalid address list");
      }
    }
    const { count } = await prisma.deviceToken.updateMany({ where: { id: big(id), userId: big(uid) }, data });
    if (!count) throw new HttpError(404, "Device not found");
    forgetDeviceCache();
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    return fail(e);
  }
}

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
