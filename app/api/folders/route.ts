import { NextResponse } from "next/server";
import { ensureFolder, folderExists } from "@/lib/db";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

// POST /api/folders
//   { parentId, name }          → create one folder (returns existing if same name)
//   { parentId, path: "a/b/c" } → create the whole chain (used by folder uploads)
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    let id = parseId(body.parentId);
    if (id && !(await folderExists(uid, id))) throw new HttpError(404, "Parent folder not found");

    const parts =
      typeof body.path === "string"
        ? body.path.split("/").filter(Boolean).map(cleanName)
        : [cleanName(body.name)];
    if (!parts.length) throw new HttpError(400, "Empty path");

    for (const part of parts) id = await ensureFolder(uid, id, part);
    return NextResponse.json({ id });
  } catch (e) {
    return fail(e);
  }
}
