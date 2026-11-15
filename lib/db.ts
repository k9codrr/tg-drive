import { Prisma, PrismaClient } from "@prisma/client";

// One PrismaClient per process (reused across hot reloads in dev).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Route params / session ids are numeric strings; the DB uses BIGINT ids. */
export const big = (id: string | number | bigint) => BigInt(id);
export const bigOrNull = (id: string | null | undefined) => (id == null ? null : BigInt(id));

/** True for a unique-constraint violation. */
export function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** A row points at a parent that no longer exists (e.g. its folder was deleted mid-request). */
export function isForeignKeyViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

/** Columns needed by fileOut() (file + the Google account's email). */
export const fileOutSelect = {
  id: true,
  name: true,
  size: true,
  mime: true,
  status: true,
  folderId: true,
  createdAt: true,
  backend: true,
  starred: true,
  trashedAt: true,
  gdAccount: { select: { email: true } },
} satisfies Prisma.FileSelect;

export type FileOutRow = Prisma.FileGetPayload<{ select: typeof fileOutSelect }>;

export function fileOut(r: FileOutRow) {
  return {
    id: String(r.id),
    name: r.name,
    size: Number(r.size),
    mime: r.mime,
    status: r.status,
    folderId: r.folderId == null ? null : String(r.folderId),
    createdAt: r.createdAt,
    backend: r.backend ?? "telegram",
    account: r.gdAccount?.email ?? null,
    starred: r.starred,
    trashedAt: r.trashedAt,
  };
}

/** Case-insensitive sort by name (the DB used ORDER BY lower(name)). */
export function byName<T extends { name: string }>(rows: T[]) {
  return rows.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Find-or-create a folder by name inside parent (null = root) for a user. */
export async function ensureFolder(uid: string, parentId: string | null, name: string): Promise<string> {
  const where = { userId: big(uid), parentId: bigOrNull(parentId), name };
  const live = { ...where, trashedAt: null };
  const found = await prisma.folder.findFirst({ where: live, select: { id: true } });
  if (found) return String(found.id);
  try {
    const created = await prisma.folder.create({ data: where, select: { id: true } });
    return String(created.id);
  } catch (e) {
    // Created by a parallel request in the meantime (unique index folders_user_parent_name).
    if (!isUniqueViolation(e)) throw e;
    const again = await prisma.folder.findFirst({ where: live, select: { id: true } });
    if (!again) throw new Error("Could not create folder");
    return String(again.id);
  }
}

export async function folderExists(uid: string, id: string) {
  const n = await prisma.folder.count({ where: { id: big(id), userId: big(uid), trashedAt: null } });
  return n > 0;
}
