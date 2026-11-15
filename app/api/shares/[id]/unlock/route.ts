import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { setKeyCookie } from "@/lib/filecrypt";
import { requireUser } from "@/lib/session";
import { unlockShare } from "@/lib/shares";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/shares/:id/unlock { password } → opens a password-protected share for 12 hours.
// For an encrypted file it also unlocks the file in this browser (for an hour).
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid share");
    const r = await unlockShare(uid, id, (await readJson(req)).password);
    const res = NextResponse.json({ ok: true, fileUnlocked: !!r.file });
    if (r.file) setKeyCookie(res, uid, r.file.id, r.file.key);
    return res;
  } catch (e) {
    return fail(e);
  }
}
