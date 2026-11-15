import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { parseTarget } from "@/lib/storage";
import { filesToMove } from "@/lib/transfer";

export const runtime = "nodejs";
export const maxDuration = 60;

const ids = (v: unknown) =>
  Array.isArray(v)
    ? v
        .map((x) => parseId(x))
        .filter((x): x is string => !!x)
        .map((x) => BigInt(x))
    : [];

// POST /api/transfer { files: [ids], folders: [ids], target } → the files that need moving
// (folders are expanded; files already on the target are left out). Then call
// POST /api/files/:id/transfer for each until it says done.
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    const target = parseTarget(body.target);
    const files = ids(body.files);
    const folders = ids(body.folders);
    if (!files.length && !folders.length) throw new HttpError(400, "Nothing selected");
    return NextResponse.json({ files: await filesToMove(uid, files, folders, target) });
  } catch (e) {
    return fail(e);
  }
}
