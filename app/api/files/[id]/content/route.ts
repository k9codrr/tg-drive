// GET /api/files/:id/content → the file's bytes, streamed, with HTTP Range support.
// Used by the in-app viewer: <img>/<video>/<audio>/PDF can start showing (and seek) without the
// whole file being downloaded first.  ?download=1 sends it as an attachment instead.
import { CHUNK_SIZE } from "@/lib/config";
import { mimeFor } from "@/lib/dav/fs";
import { big, prisma } from "@/lib/db";
import { accessTokenFor, downloadRange } from "@/lib/google";
import { fail, HttpError, parseId } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { fileAccess } from "@/lib/space";
import { asFileEnc, ctr, type FileEnc, requireKey } from "@/lib/filecrypt";
import { readChunk } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

// Types the browser may render inline. Anything else (HTML, SVG documents, scripts…) is sent as a
// download or plain text, so a file can never run code on this site.
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/|audio\/|application\/pdf$)/;

function parseRange(header: string | null, size: number) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "bad" as const;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "bad" as const;
  return { start, end };
}

export async function GET(req: Request, { params }: Ctx) {
  try {
    const uid = await requireUser(req);
    const id = parseId((await params).id);
    if (!id) throw new HttpError(400, "Invalid id");
    // Opening in the viewer needs "view"; ?download=1 needs the right to download.
    await fileAccess(uid, id, new URL(req.url).searchParams.get("download") === "1" ? "download" : "view");
    const file = await prisma.file.findUnique({
      where: { id: big(id) },
      select: {
        id: true,
        name: true,
        mime: true,
        size: true,
        status: true,
        chunkSize: true,
        backend: true,
        gdAccountId: true,
        gdFileId: true,
        updatedAt: true,
        encryption: true,
      },
    });
    if (!file) throw new HttpError(404, "File not found");
    // Encrypted: needs the unlock cookie (423 otherwise, before anything is streamed).
    const enc = asFileEnc(file.encryption);
    const crypt = enc ? { enc, key: requireKey(req, uid, id) } : null;
    if (file.status !== "ready") throw new HttpError(409, "This file hasn't finished uploading");

    const size = Number(file.size);
    const url = new URL(req.url);
    const asDownload = url.searchParams.get("download") === "1";
    // Older uploads may have no type recorded: work it out from the name.
    const mime = file.mime && file.mime !== "application/octet-stream" ? file.mime : mimeFor(file.name);
    const inline = !asDownload && INLINE.test(mime);
    const isSvg = mime === "image/svg+xml";
    const contentType = inline || isSvg || asDownload ? mime : "text/plain; charset=utf-8";
    const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ETag: `"f${file.id}-${file.updatedAt.getTime()}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
    };
    // Never let a stored file run scripts or load things when opened directly.
    if (!inline || isSvg) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

    const range = parseRange(req.headers.get("range"), size);
    if (range === "bad") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = String(length);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    if (length === 0) return new Response(null, { status: range ? 206 : 200, headers });

    const stream = streamBytes(file, start, end, req.signal, crypt);
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch (e) {
    return fail(e);
  }
}

type Row = {
  id: bigint;
  name: string;
  chunkSize: number;
  backend: string | null;
  gdAccountId: bigint | null;
  gdFileId: string | null;
};

/** Streams bytes [start, end], fetching the next chunk while the current one is sent. */
function streamBytes(
  file: Row,
  start: number,
  end: number,
  signal: AbortSignal,
  crypt: { enc: FileEnc; key: Buffer } | null,
): ReadableStream<Uint8Array> {
  let pos = start;
  let token: string | null = null;
  const cs = file.backend === "gdrive" ? CHUNK_SIZE : file.chunkSize;
  let next: Promise<Buffer> | null = null;

  // Every piece is decrypted at its own offset (CTR), so ranges and seeking work for encrypted files too.
  const fetchAt = async (p: number): Promise<Buffer> => {
    const data = await fetchRaw(p);
    return crypt ? ctr(crypt.key, crypt.enc, p, data) : data;
  };
  const fetchRaw = async (p: number): Promise<Buffer> => {
    if (file.backend === "gdrive") {
      if (!file.gdFileId || file.gdAccountId == null) throw new HttpError(404, "File not found in Google Drive");
      token ??= (await accessTokenFor(String(file.gdAccountId))).token;
      return downloadRange(token, file.gdFileId, p, Math.min(end, p + cs - 1));
    }
    const idx = Math.floor(p / cs);
    const data = await readChunk(file.id, idx);
    if (!data) throw new HttpError(500, `Part ${idx + 1} of ${file.name} is missing`);
    const base = idx * cs;
    return data.subarray(p - base, Math.min(end, base + cs - 1) - base + 1);
  };
  const nextPos = (p: number) => (file.backend === "gdrive" ? p + cs : (Math.floor(p / cs) + 1) * cs);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || pos > end) return controller.close();
      try {
        const current = await (next ?? fetchAt(pos));
        const after = nextPos(pos);
        next = after <= end && !signal.aborted ? fetchAt(after) : null;
        next?.catch(() => {}); // surfaced on the next pull
        controller.enqueue(new Uint8Array(current));
        pos = after;
        if (pos > end) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      next = null;
    },
  });
}
