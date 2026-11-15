// Per-device app passwords used by the WebDAV drive (HTTP Basic auth: email + device password).
import { createHash, randomBytes } from "node:crypto";
import { big, prisma } from "./db";
import { ipAllowed, parseAllowList } from "./netacl";

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

type Cached = { uid: string; email: string; tokenId: bigint; storage: string | null; allowedIps: string | null; at: number };
// Kept on globalThis: Next bundles API routes and the DAV server (instrumentation) separately,
// and revoking in one must clear the cache the other uses.
const g = globalThis as unknown as {
  tgdDeviceCache?: Map<string, Cached>;
  tgdDeviceTouched?: Map<bigint, { at: number; ip: string }>;
};
const cache = (g.tgdDeviceCache ??= new Map<string, Cached>());
const touched = (g.tgdDeviceTouched ??= new Map<bigint, { at: number; ip: string }>());
const CACHE_MS = 60_000;
const TOUCH_MS = 5 * 60_000;

export type DeviceAuth = { uid: string; deviceId: string; storage: string | null };

/** Checks an "Authorization: Basic …" header. Returns the user id, or null. */
export async function verifyBasicAuth(header: string | undefined | null): Promise<string | null> {
  const d = await verifyDevice(header);
  return d && d !== "blocked" ? d.uid : null;
}

/**
 * Like verifyBasicAuth, plus which device it is and where that PC stores new files. With `ip`, a
 * device restricted to certain addresses only works from those (returns "blocked" otherwise).
 */
export async function verifyDevice(header: string | undefined | null, ip?: string): Promise<DeviceAuth | null | "blocked"> {
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
      select: { id: true, userId: true, storage: true, allowedIps: true, user: { select: { email: true } } },
    });
    if (!row) {
      cache.delete(h);
      return null;
    }
    hit = {
      uid: String(row.userId),
      email: row.user.email.toLowerCase(),
      tokenId: row.id,
      storage: row.storage,
      allowedIps: row.allowedIps,
      at: Date.now(),
    };
    cache.set(h, hit);
  }
  if (hit.email !== email) return null;
  if (ip != null && hit.allowedIps) {
    let ok = false;
    try {
      ok = ipAllowed(ip, parseAllowList(hit.allowedIps));
    } catch {
      ok = false;
    }
    if (!ok) return "blocked";
  }

  // Last use (and address) is written at most every few minutes, or when the address changes.
  const last = touched.get(hit.tokenId);
  const where = ip ?? last?.ip ?? "";
  if (!last || Date.now() - last.at > TOUCH_MS || last.ip !== where) {
    touched.set(hit.tokenId, { at: Date.now(), ip: where });
    prisma.deviceToken
      .update({ where: { id: hit.tokenId }, data: { lastUsedAt: new Date(), ...(ip ? { lastIp: ip } : {}) } })
      .catch(() => {});
  }
  return { uid: hit.uid, deviceId: String(hit.tokenId), storage: hit.storage };
}

/** Revoked tokens (and changed device settings) must take effect immediately, not after the cache expires. */
export function forgetDeviceCache() {
  cache.clear();
}
