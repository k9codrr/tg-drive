// Per-device app passwords used by the WebDAV drive (HTTP Basic auth: email + device password).
import { createHash, randomBytes } from "node:crypto";
import { big, prisma } from "./db";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a device password. The plain token is returned once and never stored. */
export async function createDevice(uid: string, name: string) {
  const token = `tgd_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.deviceToken.create({
    data: { userId: big(uid), name, tokenHash: hash(token) },
    select: { id: true, name: true, createdAt: true },
  });
  return { id: String(row.id), name: row.name, createdAt: row.createdAt, token };
}

type Cached = { uid: string; email: string; tokenId: bigint; at: number };
// Kept on globalThis: Next bundles API routes and the DAV server (instrumentation) separately,
// and revoking in one must clear the cache the other uses.
const g = globalThis as unknown as { tgdDeviceCache?: Map<string, Cached>; tgdDeviceTouched?: Map<bigint, number> };
const cache = (g.tgdDeviceCache ??= new Map<string, Cached>());
const touched = (g.tgdDeviceTouched ??= new Map<bigint, number>());
const CACHE_MS = 60_000;
const TOUCH_MS = 5 * 60_000;

/** Checks an "Authorization: Basic …" header. Returns the user id, or null. */
export async function verifyBasicAuth(header: string | undefined | null): Promise<string | null> {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  const email = decoded.slice(0, i).trim().toLowerCase();
  const token = decoded.slice(i + 1);
  if (!token.startsWith("tgd_")) return null;

  const h = hash(token);
  let hit = cache.get(h);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    const row = await prisma.deviceToken.findUnique({
      where: { tokenHash: h },
      select: { id: true, userId: true, user: { select: { email: true } } },
    });
    if (!row) {
      cache.delete(h);
      return null;
    }
    hit = { uid: String(row.userId), email: row.user.email.toLowerCase(), tokenId: row.id, at: Date.now() };
    cache.set(h, hit);
  }
  if (hit.email !== email) return null;

  const last = touched.get(hit.tokenId) ?? 0;
  if (Date.now() - last > TOUCH_MS) {
    touched.set(hit.tokenId, Date.now());
    prisma.deviceToken
      .update({ where: { id: hit.tokenId }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }
  return hit.uid;
}

/** Revoked tokens must stop working immediately, not after the cache expires. */
export function forgetDeviceCache() {
  cache.clear();
}
