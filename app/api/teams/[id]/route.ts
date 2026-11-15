import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { deleteTeam, teamDetail, updateTeam } from "@/lib/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

async function teamId(params: Ctx["params"]) {
  const id = parseId((await params).id);
  if (!id) throw new HttpError(400, "Invalid team");
  return id;
}

// GET /api/teams/:id → members, your role, pending invites (if you may invite), usage
export async function GET(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json(await teamDetail(uid, await teamId(params)));
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/teams/:id { name?, ssoDomain?, ssoRole? } → rename / team sync settings (admins and the owner).
// ssoDomain: people who sign in with SSO and a verified email at this domain join automatically as
// ssoRole. Must be the admin's own email domain, not a public one like gmail.com; "" turns it off.
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await updateTeam(uid, await teamId(params), await readJson(req));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/teams/:id → delete the team and all its files for good (owner only)
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    await deleteTeam(uid, await teamId(params));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
