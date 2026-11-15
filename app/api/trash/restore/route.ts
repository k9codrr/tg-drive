import { NextResponse } from "next/server";
import { fail, HttpError, parseId, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { fileAccess, folderAccess, requireEdit } from "@/lib/space";
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
    // Each item is checked on its own: restoring needs the same right as trashing it did.
    const restore = async (kind: "file" | "folder", id: string) => {
      if (kind === "folder") {
        const { space, folder } = await folderAccess(uid, id, "view");
        requireEdit(space, folder.userId);
        await restoreFolder(space, BigInt(id));
      } else {
        const { space, file } = await fileAccess(uid, id, "view");
        requireEdit(space, file.userId);
        await restoreFile(space, BigInt(id));
      }
    };
    for (const id of folders) await restore("folder", id).catch(() => failed++);
    for (const id of files) await restore("file", id).catch(() => failed++);
    return NextResponse.json({ ok: true, restored: files.length + folders.length - failed, failed });
  } catch (e) {
    return fail(e);
  }
}
