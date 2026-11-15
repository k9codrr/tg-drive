import { NextResponse } from "next/server";
import { CHUNK_SIZE } from "@/lib/config";
import { big, bigOrNull, folderExists, prisma } from "@/lib/db";
import { accessTokenFor, pickAccount, startResumable } from "@/lib/google";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { r2Configured, r2Usage } from "@/lib/r2";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/files  { name, size, mime, folderId, target } → start an upload
//   target: "telegram" (default) | "r2" | "gdrive" (account with most free space) | "gdrive:<accountId>"
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    const body = await readJson(req);
    const name = cleanName(body.name);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "Invalid size");
    const folderId = parseId(body.folderId);
    if (folderId && !(await folderExists(uid, folderId))) throw new HttpError(404, "Folder not found");
    const mime =
      typeof body.mime === "string" && body.mime && body.mime.length < 200
        ? body.mime
        : "application/octet-stream";

    const target = typeof body.target === "string" ? body.target : "telegram";
    const backend =
      target === "telegram" ? "telegram" : target === "r2" ? "r2" : target === "gdrive" || target.startsWith("gdrive:") ? "gdrive" : null;
    if (!backend) throw new HttpError(400, "Unknown upload target");

    // CHUNK_SIZE (4 MB) is a multiple of 256 KB, as Drive resumable uploads require.
    const chunkCount = Math.ceil(size / CHUNK_SIZE);
    const base = {
      userId: big(uid),
      name,
      folderId: bigOrNull(folderId),
      size: BigInt(size),
      mime,
      chunkSize: CHUNK_SIZE,
      chunkCount,
    };

    if (backend === "r2") {
      if (!r2Configured()) throw new HttpError(400, "Cloudflare R2 is not configured");
      const usage = await r2Usage(uid);
      if (size > usage.free) throw new HttpError(507, "Not enough free space in Cloudflare R2");
    }

    if (backend !== "gdrive" || chunkCount === 0) {
      const row = await prisma.file.create({
        data: { ...base, status: chunkCount === 0 ? "ready" : "uploading", backend },
        select: { id: true },
      });
      return NextResponse.json({ id: String(row.id), chunkSize: CHUNK_SIZE, chunkCount, backend, sequential: false });
    }

    const preferred = target.startsWith("gdrive:") ? parseId(target.slice(7)) : null;
    const account = await pickAccount(uid, size, preferred);
    const { token, row: acct } = await accessTokenFor(account.id);
    const uploadUrl = await startResumable(token, {
      name,
      mime,
      size,
      parentId: acct.rootFolderId || null,
    });

    const row = await prisma.file.create({
      data: {
        ...base,
        status: "uploading",
        backend: "gdrive",
        gdAccountId: big(account.id),
        gdUploadUrl: uploadUrl,
      },
      select: { id: true },
    });
    return NextResponse.json({
      id: String(row.id),
      chunkSize: CHUNK_SIZE,
      chunkCount,
      backend: "gdrive",
      account: account.email,
      sequential: true, // Drive resumable uploads must be sent in order
    });
  } catch (e) {
    return fail(e);
  }
}
