// The server's own Cloudflare R2 bucket, configured in the environment (R2_*). Files are stored as 4 MB
// chunk objects u/<userId>/<fileId>/<chunkIndex>. (Buckets people connect themselves: lib/connections.ts.)
import { big, prisma } from "./db";
import { HttpError } from "./http";
import { type S3Config, s3Delete, s3Get, s3Put } from "./s3";

const GB = 1024 ** 3;

export function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function cfg(): S3Config {
  if (!r2Configured()) throw new HttpError(400, "Cloudflare R2 is not configured");
  return {
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
    bucket: process.env.R2_BUCKET!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    style: "path",
  };
}

/** Object key of one chunk (also used for S3 / WebDAV connections). */
export function r2Key(uid: string, fileId: string, idx: number) {
  return `u/${uid}/${fileId}/${idx}`;
}

export const r2Put = (key: string, data: Uint8Array) => s3Put(cfg(), key, data);
export const r2Get = (key: string) => s3Get(cfg(), key);
export async function r2Delete(keys: string[]) {
  if (!keys.length || !r2Configured()) return;
  await s3Delete(cfg(), keys);
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
