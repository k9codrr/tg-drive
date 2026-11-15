import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { restoreFile, restoreFolder } from "@/lib/trash";

export const runtime = "nodejs";
export const maxDuration = 60;

const ids = (v: unknown) => (Array.isArray(v) ? v.map((x) => parseId(x)).filter((x): x is string => !!x) : []);

// POST /api/trash/restore { files: [ids], folders: [ids] } → put items back where they were
// (into My Drive if their folder is gone; a folder whose name is taken comes back as "name (restored)")
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    const files = ids(body.files);
    const folders = ids(body.folders);
    if (!files.length && !folders.length) throw new HttpError(400, "Nothing to restore");
    let failed = 0;
    for (const id of folders) await restoreFolder(uid, BigInt(id)).catch(() => failed++);
    for (const id of files) await restoreFile(uid, BigInt(id)).catch(() => failed++);
    return NextResponse.json({ ok: true, restored: files.length + folders.length - failed, failed });
  } catch (e) {
    return fail(e);
  }
}
