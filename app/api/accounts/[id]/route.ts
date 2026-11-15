import { NextResponse } from "next/server";
import { openString } from "@/lib/crypto";
import { big, prisma } from "@/lib/db";
import { revokeToken } from "@/lib/google";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { can } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { teamRole } from "@/lib/space";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Your private account, or a team account you administer. */
async function manageable(uid: string, id: string) {
  const acct = await prisma.googleAccount.findUnique({
    where: { id: big(id) },
    select: { id: true, email: true, refreshToken: true, userId: true, teamId: true },
  });
  if (!acct) throw new HttpError(404, "Account not found");
  if (acct.teamId != null) {
    const m = await teamRole(uid, acct.teamId);
    if (!m) throw new HttpError(404, "Account not found");
    if (!can(m.role, "manageTeam")) throw new HttpError(403, "Only team admins can manage the team's Google accounts");
  } else if (String(acct.userId) !== uid) {
    throw new HttpError(404, "Account not found");
  }
  return acct;
}

// PATCH /api/accounts/:id { offerToMembers } → (team accounts) let members use it for their private files
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const acct = await manageable(uid, id);
    if (acct.teamId == null) throw new HttpError(400, "Only team accounts can be offered to members");
    const body = await readJson(req);
    await prisma.googleAccount.update({ where: { id: acct.id }, data: { offerToMembers: body.offerToMembers === true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/accounts/:id → disconnect a Google account (only if no files are stored in it)
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const acct = await manageable(uid, id);

    const n = await prisma.file.count({ where: { gdAccountId: big(id) } });
    if (n > 0) {
      throw new HttpError(
        409,
        `${n} file(s) are stored in ${acct.email}. Move them to other storage (Change storage…) or delete them before disconnecting.`,
      );
    }
    try {
      await revokeToken(openString(acct.refreshToken));
    } catch {
      /* ignore */
    }
    await prisma.googleAccount.delete({ where: { id: big(id) } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
