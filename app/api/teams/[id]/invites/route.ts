import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { invite } from "@/lib/teams";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/teams/:id/invites { email, role } → invite someone (managers and up; only to roles below yours)
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid team");
    const body = await readJson(req);
    return NextResponse.json(await invite(uid, id, body.email, body.role));
  } catch (e) {
    return fail(e);
  }
}
