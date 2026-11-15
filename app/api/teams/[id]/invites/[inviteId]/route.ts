import { NextResponse } from "next/server";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { cancelInvite } from "@/lib/teams";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; inviteId: string }> };

// DELETE /api/teams/:id/invites/:inviteId → cancel a pending invite
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const p = await params;
    const id = parseId(p.id);
    const inviteId = parseId(p.inviteId);
    if (!id || !inviteId) throw new HttpError(400, "Invalid id");
    await cancelInvite(uid, id, inviteId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
