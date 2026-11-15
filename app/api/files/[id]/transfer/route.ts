import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { requireKey } from "@/lib/filecrypt";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { fileAccess, requireCan } from "@/lib/space";
import { parseTarget } from "@/lib/storage";
import { type EncChange, transferStep } from "@/lib/transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

// POST /api/files/:id/transfer { target?, encryption? } → copies part of the file (about 40 s of work
// per call) and returns { done, copied, size }. Call again until done; then the file lives on the new
// storage / with its new encryption and the old copy is deleted. Safe to repeat, or to resume later.
//   target:     where to move it (needs the right to move storage); omitted = stay where it is
//   encryption: { mode: "encrypt", password } → encrypt a plain file
//               { mode: "decrypt" }           → remove encryption (the file must be unlocked)
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const body = await readJson(req);

    const enc = body.encryption && typeof body.encryption === "object" ? (body.encryption as Record<string, unknown>) : null;
    let change: EncChange | null = null;
    if (enc?.mode === "encrypt") change = { mode: "encrypt", password: String(enc.password ?? "") };
    else if (enc?.mode === "decrypt") change = { mode: "decrypt", key: requireKey(req, uid, id) };
    else if (enc) throw new HttpError(400, "encryption.mode must be encrypt or decrypt");

    const { space } = await fileAccess(uid, id, change ? "edit" : "moveStorage");
    let target;
    if (body.target != null) {
      target = parseTarget(body.target);
      if (change) requireCan(space, "moveStorage");
    } else {
      if (!change) throw new HttpError(400, "Pick a storage target");
      const f = await prisma.file.findUnique({ where: { id: big(id) }, select: { backend: true, gdAccountId: true } });
      target = parseTarget(f?.backend === "gdrive" ? `gdrive:${f.gdAccountId}` : (f?.backend ?? "telegram"));
    }
    const result = await transferStep(space, BigInt(id), target, Date.now() + 40_000, change);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
