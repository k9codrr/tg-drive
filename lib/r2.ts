// Cloudflare R2 (S3-compatible) storage. Files are stored as 4 MB chunk objects:
//   u/<userId>/<fileId>/<chunkIndex>
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { big, prisma } from "./db";
import { HttpError } from "./http";

let client: AwsClient | null = null;
const GB = 1024 ** 3;

export function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function r2() {
  if (!r2Configured()) throw new HttpError(400, "Cloudflare R2 is not configured");
  if (!client) {
    client = new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      service: "s3",
      region: "auto",
    });
  }
  return client;
}

function objectUrl(key: string) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(
    process.env.R2_BUCKET!,
  )}/${path}`;
}

export function r2Key(uid: string, fileId: string, idx: number) {
  return `u/${uid}/${fileId}/${idx}`;
}

export async function r2Put(key: string, data: Uint8Array) {
  const body = new Uint8Array(data);
  // Sign, then send the raw bytes ourselves: aws4fetch re-wraps the body as a stream,
  // which goes out chunked (no Content-Length) and R2 rejects it with 411.
  const signed = await r2().sign(objectUrl(key), {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!res.ok) throw new Error(`R2 upload failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

export async function r2Get(key: string): Promise<Buffer> {
  const res = await r2().fetch(objectUrl(key));
  if (!res.ok) throw new Error(`R2 download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort delete (errors are logged, not thrown). Uses S3 DeleteObjects: up to 1000 keys per request. */
export async function r2Delete(keys: string[]) {
  if (!keys.length || !r2Configured()) return;
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += 1000) batches.push(keys.slice(i, i + 1000));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        await r2DeleteMany(batch);
      } catch (e) {
        console.warn("R2 bulk delete failed, deleting one by one:", e);
        await r2DeleteEach(batch);
      }
    }),
  );
}

async function r2DeleteMany(keys: string[]) {
  const xmlEsc = (k: string) => k.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>` +
    keys.map((k) => `<Object><Key>${xmlEsc(k)}</Key></Object>`).join("") +
    `</Delete>`;
  const md5 = createHash("md5").update(body).digest("base64");
  const bucketUrl = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(process.env.R2_BUCKET!)}`;
  const res = await r2().fetch(`${bucketUrl}?delete`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/xml", "Content-MD5": md5 },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text}`);
  const errors = (text.match(/<Error>/g) ?? []).length;
  if (errors) console.warn(`R2 delete: ${errors} of ${keys.length} objects failed (ignored)`);
}

async function r2DeleteEach(keys: string[]) {
  for (let i = 0; i < keys.length; i += 32) {
    const results = await Promise.allSettled(
      keys.slice(i, i + 32).map((k) => r2().fetch(objectUrl(k), { method: "DELETE" })),
    );
    for (const r of results) if (r.status === "rejected") console.warn("R2 delete failed (ignored):", r.reason);
  }
}

/**
 * Limits keep you inside the free tier by default:
 *   R2_TOTAL_LIMIT_GB  (default 10) — cap for the whole app, all users together
 *   R2_USER_LIMIT_GB   (optional)   — cap per user
 */
export function r2Limits() {
  const total = Number(process.env.R2_TOTAL_LIMIT_GB || 10) * GB;
  const perUser = process.env.R2_USER_LIMIT_GB ? Number(process.env.R2_USER_LIMIT_GB) * GB : null;
  return { total, perUser };
}

/** Bytes used/reserved in R2 (uploads in progress count too). */
export async function r2Usage(uid: string) {
  const userId = big(uid);
  const [all, own, files] = await Promise.all([
    prisma.file.aggregate({ where: { backend: "r2" }, _sum: { size: true } }),
    prisma.file.aggregate({ where: { backend: "r2", userId }, _sum: { size: true } }),
    prisma.file.count({ where: { backend: "r2", userId, status: "ready" } }),
  ]);
  const mine = Number(own._sum.size ?? 0);
  const total = Number(all._sum.size ?? 0);
  const { total: totalLimit, perUser } = r2Limits();
  let free = totalLimit - total;
  if (perUser != null) free = Math.min(free, perUser - mine);
  return {
    used: mine,
    files,
    limit: perUser ?? totalLimit,
    free: Math.max(0, free),
  };
}
