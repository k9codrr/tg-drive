import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { answerInvite } from "@/lib/teams";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/invites/:id { accept: true | false } → join the team, or decline
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid invite");
    return NextResponse.json(await answerInvite(uid, id, (await readJson(req)).accept === true));
  } catch (e) {
    return fail(e);
  }
}
