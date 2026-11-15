import { NextResponse } from "next/server";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { ensureFolderIn, folderAccess, requireCan, spaceFor } from "@/lib/space";

export const runtime = "nodejs";

// POST /api/folders
//   { parentId, name }          → create one folder (returns existing if same name)
//   { parentId, path: "a/b/c" } → create the whole chain (used by folder uploads)
//   At the top level (no parentId) `team` picks the space: omitted = your private space.
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    let id = parseId(body.parentId);
    const space = id
      ? (await folderAccess(uid, id, "upload", { live: true })).space
      : await spaceFor(uid, body.team);
    requireCan(space, "upload");

    const parts =
      typeof body.path === "string"
        ? body.path.split("/").filter(Boolean).map(cleanName)
        : [cleanName(body.name)];
    if (!parts.length) throw new HttpError(400, "Empty path");

    for (const part of parts) id = await ensureFolderIn(space, id, part);
    return NextResponse.json({ id });
  } catch (e) {
    return fail(e);
  }
}
