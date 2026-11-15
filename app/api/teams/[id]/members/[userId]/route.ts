import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { changeRole, removeMember } from "@/lib/teams";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; userId: string }> };

async function ids(params: Ctx["params"]) {
  const p = await params;
  const id = parseId(p.id);
  const userId = parseId(p.userId);
  if (!id || !userId) throw new HttpError(400, "Invalid id");
  return { id, userId };
}

// PATCH /api/teams/:id/members/:userId { role } → change a member's role ("owner" hands over ownership)
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const { id, userId } = await ids(params);
    await changeRole(uid, id, userId, (await readJson(req)).role);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/teams/:id/members/:userId → remove a member, or leave (your own id)
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const { id, userId } = await ids(params);
    await removeMember(uid, id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
