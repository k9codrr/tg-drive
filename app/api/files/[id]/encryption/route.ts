import { NextResponse } from "next/server";
import { changeFilePassword } from "@/lib/encryption";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/files/:id/encryption { password } → new password for an encrypted file (it must be unlocked).
// To encrypt a plain file or remove encryption, use POST /api/files/:id/transfer with `encryption`.
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    await changeFilePassword(req, uid, id, (await readJson(req)).password);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
