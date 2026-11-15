import { NextResponse } from "next/server";
import { retestConnection } from "@/lib/connections";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// POST /api/connections/:id/test → { ok, result } (also recorded as the connection's last check)
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    return NextResponse.json(await retestConnection(uid, id));
  } catch (e) {
    return fail(e);
  }
}
