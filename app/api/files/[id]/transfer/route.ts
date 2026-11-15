import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { parseTarget } from "@/lib/storage";
import { transferStep } from "@/lib/transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

// POST /api/files/:id/transfer { target } → copies part of the file to the target storage (about 40 s
// of work per call) and returns { done, copied, size }. Call again until done; then the file lives on
// the new storage and the old copy is deleted. Safe to repeat, or to resume later.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    const target = parseTarget((await readJson(req)).target);
    const result = await transferStep(uid, BigInt(id), target, Date.now() + 40_000);
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
