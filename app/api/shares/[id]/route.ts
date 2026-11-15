import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { deleteShare, updateShare } from "@/lib/shares";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function shareId(params: Ctx["params"]) {
  const id = parseId((await params).id);
  if (!id) throw new HttpError(400, "Invalid share");
  return id;
}

// PATCH /api/shares/:id { permission?, expiresAt? (null = never), password? (null/"" = remove) }
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await updateShare(uid, await shareId(params), await readJson(req));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/shares/:id → stop sharing (or, as the recipient, remove it from "Shared with me")
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await deleteShare(uid, await shareId(params));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
