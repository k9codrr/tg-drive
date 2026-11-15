import { NextResponse } from "next/server";
import { unlockFile } from "@/lib/encryption";
import { clearKeyCookie, setKeyCookie, UNLOCK_SECONDS } from "@/lib/filecrypt";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function fileId(params: Ctx["params"]) {
  const id = parseId((await params).id);
  if (!id) throw new HttpError(400, "Invalid id");
  return id;
}

// POST /api/files/:id/unlock { password } → unlocks an encrypted file in this browser for an hour
// (the file's password, or the password of a share of it made to you)
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = await fileId(params);
    const key = await unlockFile(uid, id, (await readJson(req)).password);
    const res = NextResponse.json({ ok: true, seconds: UNLOCK_SECONDS });
    setKeyCookie(res, uid, id, key);
    return res;
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/files/:id/unlock → lock it again now
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    await requireUser(req);
    const res = NextResponse.json({ ok: true });
    clearKeyCookie(res, await fileId(params));
    return res;
  } catch (e) {
    return fail(e);
  }
}
