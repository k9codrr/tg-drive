import { NextResponse } from "next/server";
import { removeConnection, updateConnection } from "@/lib/connections";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

async function connId(params: Ctx["params"]) {
  const id = parseId((await params).id);
  if (!id) throw new HttpError(400, "Invalid id");
  return id;
}

// PATCH /api/connections/:id { name?, offerToMembers?, limitGB?, config? } (new config is tested first)
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await updateConnection(uid, await connId(params), await readJson(req));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/connections/:id → remove (refused while files are stored there)
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await removeConnection(uid, await connId(params));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
