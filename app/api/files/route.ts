import { NextResponse } from "next/server";
import { CHUNK_SIZE } from "@/lib/config";
import { big, bigOrNull, folderExists, prisma } from "@/lib/db";
import { accessTokenFor, pickAccount, startResumable } from "@/lib/google";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import { r2Configured, r2Usage } from "@/lib/r2";
import { requireUser } from "@/lib/session";
import { resolveTarget, withGoogleFallback } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/files  { name, size, mime, folderId, target } → start an upload
//   target: "default" (the user's saved default, normally Google) | "gdrive" (account with most free
//   space, Telegram if none can take it) | "gdrive:<accountId>" | "telegram" | "r2"
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
      typeof body.mime === "string" && body.mime && body.mime.length < 200 ? body.mime : "application/octet-stream";

    const target = await resolveTarget(uid, body.target);

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

    const chunked = async (backend: "telegram" | "r2") => {
      const row = await prisma.file.create({
        data: { ...base, status: chunkCount === 0 ? "ready" : "uploading", backend },
        select: { id: true },
      });
      return NextResponse.json({ id: String(row.id), chunkSize: CHUNK_SIZE, chunkCount, backend, sequential: false });
    };

    if (target.backend === "r2") {
      if (!r2Configured()) throw new HttpError(400, "Cloudflare R2 is not configured");
      const usage = await r2Usage(uid);
      if (size > usage.free) throw new HttpError(507, "Not enough free space in Cloudflare R2");
      return await chunked("r2");
    }
    if (target.backend === "telegram" || chunkCount === 0) return await chunked("telegram");

    return await withGoogleFallback<Response>(
      target,
      async () => {
        const account = await pickAccount(uid, size, target.accountId);
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
      },
      () => chunked("telegram"),
    );
  } catch (e) {
    return fail(e);
  }
}
