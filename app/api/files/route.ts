import { NextResponse } from "next/server";
import { CHUNK_SIZE } from "@/lib/config";
import { big, bigOrNull, prisma } from "@/lib/db";
import { accessTokenFor, pickAccount, startResumable } from "@/lib/google";
import { cleanName, fail, HttpError, parseId, readJson } from "@/lib/http";
import type { ChunkStore } from "@/lib/connections";
import { checkNewPassword, newFileEnc, setKeyCookie } from "@/lib/filecrypt";
import { requireUser } from "@/lib/session";
import { folderAccess, requireCan, spaceData, spaceFor } from "@/lib/space";
import { chunkStoreFor, parseTarget, resolveTarget, withGoogleFallback } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/files  { name, size, mime, folderId, team?, target, encryption?: { password } } → start an upload
//   With `encryption`, the file is encrypted with its own key, wrapped with that password (lib/filecrypt.ts);
//   the response unlocks it for the uploader so the chunks that follow can be encrypted.
//   The file goes into folderId's space, or (at the top level) your private space / team `team`.
//   Bytes are stored with the uploader's storage (their Google accounts / default), also in teams.
//   target: "default" (the user's saved default, normally Google) | "gdrive" (account with most free
//   space, Telegram if none can take it) | "gdrive:<accountId>" | "telegram" | "r2"
export async function POST(req: Request) {
  try {
    return await start(req);
  } catch (e) {
    return fail(e);
  }
}

/** Errors thrown here are turned into responses by POST. */
async function start(req: Request): Promise<NextResponse> {
  const uid = await requireUser(req);
  const body = await readJson(req);
  const name = cleanName(body.name);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "Invalid size");
  const folderId = parseId(body.folderId);
  const space = folderId
    ? (await folderAccess(uid, folderId, "upload", { live: true })).space
    : await spaceFor(uid, body.team);
  requireCan(space, "upload");
  const mime =
    typeof body.mime === "string" && body.mime && body.mime.length < 200 ? body.mime : "application/octet-stream";

  const target = await resolveTarget(uid, body.target);
  const encReq = body.encryption && typeof body.encryption === "object" ? (body.encryption as { password?: unknown }) : null;
  const crypt = encReq ? await newFileEnc(checkNewPassword(encReq.password)) : null;
  // The new file's id is only known once its row exists: unlock it on the way out.
  const done = (res: NextResponse, id: string) => {
    if (crypt) setKeyCookie(res, uid, id, crypt.key);
    return res;
  };

  // CHUNK_SIZE (4 MB) is a multiple of 256 KB, as Drive resumable uploads require.
  const chunkCount = Math.ceil(size / CHUNK_SIZE);
  const base = {
    ...spaceData(space),
    name,
    folderId: bigOrNull(folderId),
    size: BigInt(size),
    mime,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    ...(crypt ? { encryption: crypt.enc } : {}),
  };

  // Telegram / S3 / WebDAV: the store (which connection, or the server's own) is fixed on the file row.
  const chunked = async (store: ChunkStore) => {
    const row = await prisma.file.create({
      data: { ...base, status: chunkCount === 0 ? "ready" : "uploading", backend: store.backend, connectionId: store.connectionId },
      select: { id: true },
    });
    return done(
      NextResponse.json({ id: String(row.id), chunkSize: CHUNK_SIZE, chunkCount, backend: store.backend, sequential: false }),
      String(row.id),
    );
  };

  // Empty files store nothing.
  if (chunkCount === 0) return await chunked({ backend: "telegram", connectionId: null });
  if (target.backend !== "gdrive") return await chunked(await chunkStoreFor(space, target, size));

  const teamId = space.kind === "team" && !space.share ? space.teamId : null;
  return await withGoogleFallback<NextResponse>(
    target,
    async () => {
      const account = await pickAccount(uid, size, target.accountId, teamId);
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
      return done(NextResponse.json({
        id: String(row.id),
        chunkSize: CHUNK_SIZE,
        chunkCount,
        backend: "gdrive",
        account: account.email,
        sequential: true, // Drive resumable uploads must be sent in order
      }), String(row.id));
    },
    async () => chunked(await chunkStoreFor(space, parseTarget("telegram"), size)),
  );
}
