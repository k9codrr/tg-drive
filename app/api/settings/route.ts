import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { fail, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { parseExclude, setDefaultStorage, setMountStorage, setUploadExclude } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function current(uid: string) {
  const u = await prisma.user.findUnique({
    where: { id: big(uid) },
    select: { defaultStorage: true, mountStorage: true, uploadExclude: true },
  });
  return {
    defaultStorage: u?.defaultStorage || "gdrive",
    mountStorage: u?.mountStorage || "same",
    uploadExclude: parseExclude(u?.uploadExclude ?? ""),
  };
}

// GET /api/settings → { defaultStorage, mountStorage, uploadExclude }
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json(await current(uid));
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/settings, any of:
//   defaultStorage: "gdrive" | "gdrive:<accountId>" | "telegram" | "r2"   (web uploads)
//   mountStorage:   "same" | same values as defaultStorage                 (PC drive T:)
//   uploadExclude:  ["node_modules", ".next", …] or "a,b,c"                (never uploaded)
export async function PATCH(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    if ("defaultStorage" in body) await setDefaultStorage(uid, body.defaultStorage);
    if ("mountStorage" in body) await setMountStorage(uid, body.mountStorage);
    if ("uploadExclude" in body) await setUploadExclude(uid, body.uploadExclude);
    return NextResponse.json(await current(uid));
  } catch (e) {
    return fail(e);
  }
}
