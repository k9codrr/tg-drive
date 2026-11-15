import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { getDefaultStorage, setDefaultStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings → { defaultStorage }
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json({ defaultStorage: await getDefaultStorage(uid) });
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/settings { defaultStorage: "gdrive" | "gdrive:<accountId>" | "telegram" | "r2" }
export async function PATCH(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    if ("defaultStorage" in body) await setDefaultStorage(uid, body.defaultStorage);
    return NextResponse.json({ defaultStorage: await getDefaultStorage(uid) });
  } catch (e) {
    return fail(e);
  }
}
