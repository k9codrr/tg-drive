// Where new uploads go.
//
// Each user has a default (users.default_storage, changed from the web app):
//   "gdrive"            Google account with the most free space (yours, then your team's); Telegram if none fits
//   "gdrive:<account>"  that Google account only
//   "telegram"          Telegram: your own bot → one your team offers → the server's (lib/connections.ts)
//   "r2"                S3 storage: your own bucket → one your team offers → the server's R2
//   "webdav"            a WebDAV server you (or your team) connected
//   "conn:<id>"         that storage connection only
// In a team's folders the team's own storage comes first (see resolveStore).
import { type ChunkStore, type ConnKind, resolveStore } from "./connections";
import { big, prisma } from "./db";
import { googleConfigured } from "./google";
import { HttpError } from "./http";
import { r2Usage } from "./r2";
import { personal, type Space } from "./space";

export type Target = {
  backend: "telegram" | "r2" | "gdrive" | "webdav" | "conn";
  accountId: string | null; // gdrive:<id>
  connectionId: string | null; // conn:<id>
  auto: boolean;
};

export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export function parseTarget(v: unknown): Target {
  const s = typeof v === "string" ? v : "";
  const t = (backend: Target["backend"], extra: Partial<Target> = {}): Target => ({
    backend,
    accountId: null,
    connectionId: null,
    auto: false,
    ...extra,
  });
  if (s === "telegram") return t("telegram");
  if (s === "r2" || s === "s3") return t("r2");
  if (s === "webdav") return t("webdav");
  if (s === "gdrive") return t("gdrive", { auto: true });
  const m = /^gdrive:(\d+)$/.exec(s);
  if (m) return t("gdrive", { accountId: m[1] });
  const c = /^conn:(\d+)$/.exec(s);
  if (c) return t("conn", { connectionId: c[1] });
  throw new HttpError(400, "Unknown storage target");
}

/**
 * Where the chunks of a non-Google upload go (Telegram / S3 / WebDAV): a store from resolveStore, or a
 * clear error if there's none. The server's R2 also checks its space limit.
 */
export async function chunkStoreFor(space: Space, t: Target, size: number): Promise<ChunkStore> {
  let kind: ConnKind;
  if (t.backend === "conn") {
    const row = await prisma.storageConnection.findUnique({ where: { id: big(t.connectionId!) }, select: { kind: true } });
    if (!row) throw new HttpError(404, "That storage connection no longer exists");
    kind = row.kind as ConnKind;
  } else if (t.backend === "telegram" || t.backend === "webdav") kind = t.backend;
  else if (t.backend === "r2") kind = "s3";
  else throw new Error("not a chunked target");
  const store = await resolveStore(space, kind, size, t.connectionId);
  if (!store) {
    throw new HttpError(
      400,
      kind === "telegram"
        ? "No Telegram storage is set up. Connect a bot under Storage → Connections."
        : kind === "s3"
          ? "No S3 / R2 storage is set up. Connect a bucket under Storage → Connections."
          : "No WebDAV server is connected. Add one under Storage → Connections.",
    );
  }
  if (store.backend === "r2" && store.connectionId == null && (await r2Usage(space.uid)).free < size) {
    throw new HttpError(507, "Not enough free space in Cloudflare R2");
  }
  return store;
}

export async function getDefaultStorage(uid: string) {
  const u = await prisma.user.findUnique({ where: { id: big(uid) }, select: { defaultStorage: true } });
  return u?.defaultStorage || "gdrive";
}

/** Checks a target value is usable by this user (their Google account / a connection they may use). */
async function checkTarget(uid: string, value: unknown) {
  const t = parseTarget(value);
  if (t.accountId) {
    const ok = await usableGoogleIds(uid);
    if (!ok.includes(t.accountId)) throw new HttpError(404, "Google account not found");
  }
  if (t.connectionId) await chunkStoreFor(personal(uid), t, 0);
  return t;
}

/** Google accounts usable for the user's private files: their own, and ones their teams offer. */
async function usableGoogleIds(uid: string) {
  const teams = (await prisma.teamMember.findMany({ where: { userId: big(uid) }, select: { teamId: true } })).map((m) => m.teamId);
  const rows = await prisma.googleAccount.findMany({
    where: { OR: [{ userId: big(uid), teamId: null }, ...(teams.length ? [{ teamId: { in: teams }, offerToMembers: true }] : [])] },
    select: { id: true },
  });
  return rows.map((r) => String(r.id));
}

export async function setDefaultStorage(uid: string, value: unknown) {
  await checkTarget(uid, value);
  await prisma.user.update({ where: { id: big(uid) }, data: { defaultStorage: String(value) } });
}

// ---- PC drive (T:) storage ----
// users.mount_storage: "same" (follow the web default) or a target. device_tokens.storage overrides
// it for one PC (NULL = use the account setting).

/** Validates a PC-drive storage value: "same" or a storage target. */
export async function checkMountStorage(uid: string, value: unknown): Promise<string> {
  if (value === "same") return "same";
  await checkTarget(uid, value);
  return String(value);
}

export async function setMountStorage(uid: string, value: unknown) {
  const v = await checkMountStorage(uid, value);
  await prisma.user.update({ where: { id: big(uid) }, data: { mountStorage: v } });
}

/** The target the PC drive writes to, for a user and (optionally) a device's own override. */
export async function mountTarget(uid: string, deviceStorage: string | null): Promise<{ value: string; target: Target }> {
  const u = await prisma.user.findUnique({
    where: { id: big(uid) },
    select: { defaultStorage: true, mountStorage: true },
  });
  let v = deviceStorage && deviceStorage !== "same" ? deviceStorage : u?.mountStorage || "same";
  if (v === "same") v = u?.defaultStorage || "gdrive";
  try {
    return { value: v, target: parseTarget(v) };
  } catch {
    return { value: "gdrive", target: parseTarget("gdrive") };
  }
}

// ---- Names that are never uploaded ----

export const DEFAULT_EXCLUDE = ["node_modules", ".next"];

export function parseExclude(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const x of list) {
    const n = String(x).trim();
    if (!n || n.length > 100 || n.includes("/") || n.includes("\\") || n === "." || n === "..") continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.slice(0, 50);
}

export async function getUploadExclude(uid: string): Promise<string[]> {
  const u = await prisma.user.findUnique({ where: { id: big(uid) }, select: { uploadExclude: true } });
  return parseExclude(u?.uploadExclude ?? DEFAULT_EXCLUDE.join(","));
}

// The PC drive checks the list on every request, so it's cached briefly. On globalThis: the web API
// (which changes it) and the DAV server are bundled separately by Next.
const gx = globalThis as unknown as { tgdExcludeCache?: Map<string, { list: string[]; at: number }> };
const excludeCache = (gx.tgdExcludeCache ??= new Map());

export async function cachedUploadExclude(uid: string): Promise<string[]> {
  const hit = excludeCache.get(uid);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = await getUploadExclude(uid);
  excludeCache.set(uid, { list, at: Date.now() });
  return list;
}

export async function setUploadExclude(uid: string, value: unknown) {
  await prisma.user.update({ where: { id: big(uid) }, data: { uploadExclude: parseExclude(value).join(",") } });
  excludeCache.delete(uid);
}

/** True if any folder/file name on the path is excluded (matching ignores case, like Windows). */
export function isExcludedPath(segs: string[], exclude: string[]) {
  if (!exclude.length) return false;
  const set = new Set(exclude.map((x) => x.toLowerCase()));
  return segs.some((s) => set.has(s.toLowerCase()));
}

/** Resolves "default" (or nothing) to the user's saved default. */
export async function resolveTarget(uid: string, v: unknown): Promise<Target> {
  if (v == null || v === "" || v === "default") return parseTarget(await getDefaultStorage(uid));
  return parseTarget(v);
}

/**
 * Runs `withGoogle` for Google targets. When the target is the automatic "gdrive" (most free) and no
 * Google account can take the file (none connected, all full, or needing reconnection), falls back to
 * Telegram — never to R2.
 */
export async function withGoogleFallback<T>(
  target: Target,
  withGoogle: () => Promise<T>,
  withTelegram: () => Promise<T>,
): Promise<T> {
  if (target.backend !== "gdrive") throw new Error("not a Google target");
  // withTelegram resolves Telegram itself (your bot → team's → server's) and says so if there's none.
  if (!googleConfigured()) {
    if (target.auto) return withTelegram();
    throw new HttpError(400, "Google Drive is not set up on this server");
  }
  try {
    return await withGoogle();
  } catch (e) {
    const noRoom = e instanceof HttpError && [400, 409, 507].includes(e.status);
    if (target.auto && noRoom) return withTelegram();
    throw e;
  }
}
