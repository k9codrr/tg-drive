// Unlocking, re-keying and password changes for encrypted files (crypto itself: filecrypt.ts).
import type { Prisma } from "@prisma/client";
import { big, prisma } from "./db";
import { asFileEnc, asSlot, checkNewPassword, type FileEnc, requireKey, unwrapKey, wrapKey } from "./filecrypt";
import { HttpError } from "./http";
import { fileAccess, requireNotShareRoot } from "./space";

// Brute-force guard: 5 wrong passwords per user and file per 10 minutes (per server process).
const g = globalThis as unknown as { tgdFileUnlockFails?: Map<string, { n: number; at: number }> };
const fails = (g.tgdFileUnlockFails ??= new Map());
const WINDOW = 10 * 60_000;

export function guard(key: string) {
  const f = fails.get(key);
  if (f && Date.now() - f.at < WINDOW && f.n >= 5) {
    throw new HttpError(429, "Too many wrong passwords. Try again in a few minutes.");
  }
  return {
    fail() {
      const cur = f && Date.now() - f.at < WINDOW ? f : { n: 0, at: Date.now() };
      fails.set(key, { n: cur.n + 1, at: cur.at });
    },
    ok() {
      fails.delete(key);
    },
  };
}

export async function fileEnc(id: string | bigint): Promise<FileEnc | null> {
  const f = await prisma.file.findUnique({ where: { id: big(id) }, select: { encryption: true } });
  return asFileEnc(f?.encryption);
}

/**
 * The key of an encrypted file you can see, from a password: the file's own password, or the password
 * of a share of this file made to you.
 */
export async function unlockFile(uid: string, id: string, password: unknown) {
  await fileAccess(uid, id, "view");
  const enc = await fileEnc(id);
  if (!enc) throw new HttpError(400, "This file isn't encrypted");
  if (typeof password !== "string" || !password) throw new HttpError(400, "Enter the password");
  const g = guard(`${uid}:${id}`);

  let key = await unwrapKey(enc.slots.owner, password);
  if (!key) {
    const shares = await prisma.share.findMany({
      where: {
        fileId: big(id),
        sharedWith: big(uid),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { keyWrap: true },
    });
    for (const s of shares) {
      const slot = asSlot(s.keyWrap);
      if (slot && (key = await unwrapKey(slot, password))) break;
    }
  }
  if (!key) {
    g.fail();
    throw new HttpError(403, "Wrong password");
  }
  g.ok();
  return key;
}

/** New file password (needs edit rights and the file unlocked). Share passwords keep working. */
export async function changeFilePassword(req: Request, uid: string, id: string, newPassword: unknown) {
  const { space, file } = await fileAccess(uid, id, "edit");
  requireNotShareRoot(space, "file", file.id);
  const enc = await fileEnc(id);
  if (!enc) throw new HttpError(400, "This file isn't encrypted");
  const key = requireKey(req, uid, id);
  const next: FileEnc = { ...enc, slots: { owner: await wrapKey(key, checkNewPassword(newPassword)) } };
  await prisma.file.update({ where: { id: big(id) }, data: { encryption: next as unknown as Prisma.InputJsonValue } });
}
