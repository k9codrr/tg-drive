import { NextResponse } from "next/server";
import { big, prisma } from "@/lib/db";
import { accessTokenFor, downloadRange, putResumable, queryResumable } from "@/lib/google";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { fileAccess } from "@/lib/space";
import { asFileEnc, ctr, requireKey } from "@/lib/filecrypt";
import { readChunk, storeChunk } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string; idx: string }> };

async function parse(params: Ctx["params"]) {
  const p = await params;
  const id = parseId(p.id);
  const idx = Number(p.idx);
  if (!id || !Number.isInteger(idx) || idx < 0) throw new HttpError(400, "Invalid chunk");
  return { id, idx };
}

/** Reading needs download rights; writing needs upload rights, and only while the file is uploading. */
async function loadFile(uid: string, id: string, mode: "read" | "write") {
  await fileAccess(uid, id, mode === "write" ? "upload" : "download");
  const file = await prisma.file.findUnique({
    where: { id: big(id) },
    select: {
      size: true,
      chunkSize: true,
      chunkCount: true,
      status: true,
      backend: true,
      gdAccountId: true,
      gdFileId: true,
      gdUploadUrl: true,
      uploadedBytes: true,
      encryption: true,
    },
  });
  if (!file) throw new HttpError(404, "File not found");
  return file;
}

type FileRow = Awaited<ReturnType<typeof loadFile>>;

function chunkBounds(file: FileRow, idx: number) {
  const size = Number(file.size);
  const chunkSize = file.chunkSize;
  const count = file.chunkCount;
  if (idx >= count) throw new HttpError(400, "Chunk index out of range");
  const start = idx * chunkSize;
  const length = idx < count - 1 ? chunkSize : size - start;
  return { size, start, length };
}

// PUT /api/files/:id/chunks/:idx   body = raw bytes of that chunk (≤ 4 MB)
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const { id, idx } = await parse(params);
    const file = await loadFile(uid, id, "write");
    const { size, start, length } = chunkBounds(file, idx);
    if (file.status !== "uploading" && file.backend !== "gdrive") {
      const existing = await prisma.chunk.count({ where: { fileId: big(id), idx } });
      if (!existing) throw new HttpError(409, "This file is already finished");
    }

    if (file.backend === "gdrive") return await putDriveChunk(req, uid, id, file, start, length, size);

    const fileId = big(id);
    const existing = await prisma.chunk.count({ where: { fileId, idx } });
    if (existing) return NextResponse.json({ ok: true, skipped: true }); // idempotent retry

    const raw = Buffer.from(await req.arrayBuffer());
    if (raw.byteLength !== length) {
      throw new HttpError(400, `Chunk size mismatch (got ${raw.byteLength}, expected ${length})`);
    }

    await storeChunk(uid, fileId, idx, file.backend === "r2" ? "r2" : "telegram", sealed(req, uid, id, file, start, raw));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** Encrypted files: the bytes at `offset`, encrypted with the file's key (from the unlock cookie). */
function sealed(req: Request, uid: string, id: string, file: FileRow, offset: number, raw: Buffer) {
  const enc = asFileEnc(file.encryption);
  return enc ? ctr(requireKey(req, uid, id), enc, offset, raw) : raw;
}

async function putDriveChunk(req: Request, uid: string, id: string, file: FileRow, start: number, length: number, size: number) {
  const uploaded = Number(file.uploadedBytes);
  if (file.status === "ready" || start + length <= uploaded) {
    return NextResponse.json({ ok: true, skipped: true }); // already stored (retry)
  }
  if (start !== uploaded) throw new HttpError(409, "Drive chunks must be uploaded in order");
  if (!file.gdUploadUrl) throw new HttpError(409, "Upload session missing — start the upload again");

  const plain = Buffer.from(await req.arrayBuffer());
  if (plain.byteLength !== length) {
    throw new HttpError(400, `Chunk size mismatch (got ${plain.byteLength}, expected ${length})`);
  }
  const raw = sealed(req, uid, id, file, start, plain);

  const url = file.gdUploadUrl;
  let result;
  try {
    result = await putResumable(url, raw, start, size);
  } catch (e) {
    // Maybe Drive got the bytes but the response was lost — ask it.
    const status = await queryResumable(url, size).catch(() => null);
    if (!status || (!status.done && status.received < start + length)) throw e;
    result = status;
  }

  await prisma.file.update({
    where: { id: big(id) },
    data: {
      uploadedBytes: BigInt(start + length),
      ...(result.done ? { gdFileId: result.fileId } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}

// GET /api/files/:id/chunks/:idx → raw (decrypted) bytes of that chunk
export async function GET(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const { id, idx } = await parse(params);
    let out: Buffer;

    const file = await loadFile(uid, id, "read");
    if (file.backend === "gdrive") {
      if (!file.gdFileId || file.gdAccountId == null) throw new HttpError(404, "File not found in Drive");
      const { start, length } = chunkBounds(file, idx);
      const { token } = await accessTokenFor(String(file.gdAccountId));
      out = await downloadRange(token, file.gdFileId, start, start + length - 1);
    } else {
      const data = await readChunk(big(id), idx);
      if (!data) throw new HttpError(404, "Chunk not found");
      out = data;
    }

    // CTR works the same in both directions: this decrypts.
    const { start: offset } = chunkBounds(file, idx);
    out = sealed(req, uid, id, file, offset, out);
    return new Response(new Uint8Array(out), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(out.byteLength),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
