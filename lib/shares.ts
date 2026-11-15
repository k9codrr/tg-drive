// Sharing one file or folder with one person. Access checks for shared items live in space.ts
// (findShare); this file creates, lists, changes and removes shares.
//
// Passwords: a share can have a password. The recipient sees it in their notification and in "Shared
// with me" (nobody else does, apart from the person who set it), and must enter it once to open the item;
// it then stays unlocked for UNLOCK_HOURS. It's stored as a scrypt hash (to check it) and sealed with the
// server key (so it can be shown to the recipient).
//
// For a password-encrypted file the share password is also real encryption: sharing it requires a share
// password and the file's own password, and the file's key is wrapped with the share password
// (shares.key_wrap). Unlocking the share unwraps the key and unlocks the file for the recipient.
import type { Prisma } from "@prisma/client";
import { openString, sealString } from "./crypto";
import { unlockFile } from "./encryption";
import { asFileEnc, asSlot, checkNewPassword, unwrapKey, wrapKey } from "./filecrypt";
import { big, prisma } from "./db";
import { HttpError } from "./http";
import { hashPassword, verifyPassword } from "./password";
import { isSharePerm, SHARE_INFO, SHARE_RANK, type SharePerm } from "./rbac";
import { fileAccess, folderAccess, requireCan, type Space } from "./space";
import { notify } from "./teams";

const UNLOCK_HOURS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Item = { kind: "file" | "folder"; id: string };

/** Parses { file: id } or { folder: id } (body or query). */
export function itemOf(v: { file?: unknown; folder?: unknown }): Item {
  const raw = v.file ?? v.folder;
  const s = raw == null ? "" : String(raw);
  if (!/^\d+$/.test(s) || (v.file != null && v.folder != null)) throw new HttpError(400, "Pick one file or folder");
  return { kind: v.file != null ? "file" : "folder", id: s };
}

/**
 * Loads an item and checks you may share it: anything in your private space; in a team, your own
 * items (members) or anyone's (managers and up); through a share, only with Full access.
 */
async function shareable(uid: string, item: Item) {
  const { space, creatorId, name } =
    item.kind === "file"
      ? await fileAccess(uid, item.id, "view").then(async (r) => ({
          space: r.space,
          creatorId: r.file.userId,
          name: (await prisma.file.findUnique({ where: { id: big(item.id) }, select: { name: true } }))!.name,
        }))
      : await folderAccess(uid, item.id, "view", { live: true }).then(async (r) => ({
          space: r.space,
          creatorId: r.folder.userId,
          name: (await prisma.folder.findUnique({ where: { id: big(item.id) }, select: { name: true } }))!.name,
        }));
  if (space.kind === "team" && !space.share) {
    requireCan(space, creatorId != null && String(creatorId) === uid ? "share" : "editAny");
  } else {
    requireCan(space, "share");
  }
  return { space, name };
}

/** Through a share you can pass on at most what you were given. */
function checkPermission(space: Space, permission: unknown): SharePerm {
  if (!isSharePerm(permission)) throw new HttpError(400, "Pick a permission: view, download, edit or full");
  if (space.share && SHARE_RANK[permission] > SHARE_RANK[space.share.permission]) {
    throw new HttpError(403, `You can share it with at most “${SHARE_INFO[space.share.permission].label}”`);
  }
  return permission;
}

function parseExpiry(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "Invalid expiry date");
  if (d.getTime() <= Date.now()) throw new HttpError(400, "The expiry date must be in the future");
  return d;
}

async function passwordFields(v: unknown) {
  if (v == null || v === "") return { passwordHash: null, passwordSealed: null, unlockedUntil: null };
  const p = String(v);
  if (p.length < 4 || p.length > 200) throw new HttpError(400, "The password must be 4 to 200 characters");
  return { passwordHash: await hashPassword(p), passwordSealed: sealString(p), unlockedUntil: null };
}

const reveal = (sealed: string | null) => {
  if (!sealed) return null;
  try {
    return openString(sealed);
  } catch {
    return null;
  }
};

/**
 * For an encrypted file: the file key wrapped with the share password. Needs a share password and the
 * file's password (or the password of the share through which you got it). Null for anything else.
 */
async function keyWrapFor(uid: string, item: Item, sharePassword: unknown, filePassword: unknown) {
  if (item.kind !== "file") return null;
  const f = await prisma.file.findUnique({ where: { id: big(item.id) }, select: { encryption: true } });
  if (!asFileEnc(f?.encryption)) return null;
  if (typeof sharePassword !== "string" || !sharePassword) {
    throw new HttpError(400, "This file is encrypted: give the share a password (they'll use it to decrypt it)");
  }
  if (typeof filePassword !== "string" || !filePassword) {
    throw new HttpError(400, "This file is encrypted: enter its password so it can be shared", { needFilePassword: true });
  }
  checkNewPassword(sharePassword); // it protects the file's key: at least 8 characters
  const key = await unlockFile(uid, item.id, filePassword);
  return (await wrapKey(key, sharePassword)) as unknown as Prisma.InputJsonValue;
}

const describe = (permission: SharePerm, expiresAt: Date | null, hasPassword: boolean) =>
  [
    `Can: ${SHARE_INFO[permission].label}`,
    expiresAt ? `until ${expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : null,
    hasPassword ? "password protected" : null,
  ]
    .filter(Boolean)
    .join(" · ");

async function nameOfUser(uid: string) {
  const u = await prisma.user.findUnique({ where: { id: big(uid) }, select: { name: true, email: true } });
  return u ? u.name || u.email : "Someone";
}

// ---------- create / list / change / remove ----------

export async function createShare(
  uid: string,
  body: {
    file?: unknown;
    folder?: unknown;
    email?: unknown;
    permission?: unknown;
    password?: unknown;
    expiresAt?: unknown;
    filePassword?: unknown;
  },
) {
  const item = itemOf(body);
  const { space, name } = await shareable(uid, item);
  const permission = checkPermission(space, body.permission ?? "view");
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter the email of the person to share with");
  const to = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!to) throw new HttpError(404, "No TG Drive account uses that email. Ask them to sign up first.");
  if (String(to.id) === uid) throw new HttpError(400, "That's you");
  if (space.kind === "personal" && String(to.id) === space.owner) throw new HttpError(400, "They own it already");

  const expiresAt = parseExpiry(body.expiresAt);
  const pw = await passwordFields(body.password);
  const keyWrap = await keyWrapFor(uid, item, body.password, body.filePassword);
  const target = item.kind === "file" ? { fileId: big(item.id) } : { folderId: big(item.id) };
  const existing = await prisma.share.findFirst({ where: { ...target, sharedWith: to.id }, select: { id: true } });
  const data = { permission, expiresAt, sharedBy: big(uid), ...pw, ...(keyWrap ? { keyWrap } : {}) };
  const row = existing
    ? await prisma.share.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.share.create({ data: { ...target, sharedWith: to.id, ...data }, select: { id: true } });

  const by = await nameOfUser(uid);
  await notify(
    to.id,
    "share",
    `${by} shared “${name}” with you`,
    describe(permission, expiresAt, !!pw.passwordHash),
    { shareId: String(row.id), itemKind: item.kind, itemId: item.id },
  );
  return { id: String(row.id), updated: !!existing };
}

/** Who an item is shared with (for people allowed to share it). */
export async function sharesOf(uid: string, item: Item) {
  await shareable(uid, item);
  const rows = await prisma.share.findMany({
    where: item.kind === "file" ? { fileId: big(item.id) } : { folderId: big(item.id) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      permission: true,
      expiresAt: true,
      createdAt: true,
      sharedBy: true,
      passwordHash: true,
      passwordSealed: true,
      recipient: { select: { id: true, name: true, email: true } },
      sender: { select: { name: true, email: true } },
    },
  });
  return rows.map((r) => ({
    id: String(r.id),
    permission: r.permission,
    expiresAt: r.expiresAt,
    expired: !!r.expiresAt && r.expiresAt.getTime() <= Date.now(),
    createdAt: r.createdAt,
    to: { id: String(r.recipient.id), name: r.recipient.name, email: r.recipient.email },
    by: r.sender ? r.sender.name || r.sender.email : null,
    hasPassword: !!r.passwordHash,
    // Only the person who set the password sees it here (and the recipient, in their own views).
    password: String(r.sharedBy) === uid ? reveal(r.passwordSealed) : null,
  }));
}

async function loadShare(id: string) {
  const s = await prisma.share.findUnique({
    where: { id: big(id) },
    select: {
      id: true,
      fileId: true,
      folderId: true,
      sharedWith: true,
      permission: true,
      expiresAt: true,
      passwordHash: true,
      file: { select: { name: true } },
      folder: { select: { name: true } },
    },
  });
  if (!s) throw new HttpError(404, "Share not found");
  const item: Item = s.fileId != null ? { kind: "file", id: String(s.fileId) } : { kind: "folder", id: String(s.folderId) };
  return { ...s, item, name: s.file?.name ?? s.folder?.name ?? "item" };
}

export async function updateShare(
  uid: string,
  id: string,
  body: { permission?: unknown; expiresAt?: unknown; password?: unknown; filePassword?: unknown },
) {
  const s = await loadShare(id);
  const { space } = await shareable(uid, s.item);
  const data: Record<string, unknown> = {};
  if ("permission" in body) data.permission = checkPermission(space, body.permission);
  if ("expiresAt" in body) data.expiresAt = parseExpiry(body.expiresAt);
  if ("password" in body) {
    // Encrypted file: the new password must re-wrap its key (so it can't be removed, and needs the file password).
    const keyWrap = await keyWrapFor(uid, s.item, body.password, body.filePassword);
    Object.assign(data, await passwordFields(body.password), keyWrap ? { keyWrap } : {});
  }
  if (!Object.keys(data).length) return;
  const after = await prisma.share.update({
    where: { id: s.id },
    data,
    select: { permission: true, expiresAt: true, passwordHash: true },
  });
  const by = await nameOfUser(uid);
  await notify(
    s.sharedWith,
    "share.changed",
    `${by} changed your access to “${s.name}”`,
    describe(after.permission as SharePerm, after.expiresAt, !!after.passwordHash),
    { shareId: String(s.id), itemKind: s.item.kind, itemId: s.item.id },
  );
}

/** Revoke (people allowed to share the item) or remove from your own list (the recipient). */
export async function deleteShare(uid: string, id: string) {
  const s = await loadShare(id);
  const recipient = String(s.sharedWith) === uid;
  if (!recipient) await shareable(uid, s.item);
  await prisma.share.delete({ where: { id: s.id } });
  if (!recipient) {
    const by = await nameOfUser(uid);
    await notify(s.sharedWith, "share.revoked", `${by} stopped sharing “${s.name}” with you`);
  }
}

// ---------- the recipient's side ----------

/** Everything shared with you (not expired, not in the owner's trash). */
export async function receivedShares(uid: string) {
  const rows = await prisma.share.findMany({
    where: { sharedWith: big(uid), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      permission: true,
      expiresAt: true,
      createdAt: true,
      passwordHash: true,
      passwordSealed: true,
      unlockedUntil: true,
      sender: { select: { name: true, email: true } },
      file: {
        select: {
          id: true,
          name: true,
          size: true,
          mime: true,
          status: true,
          createdAt: true,
          backend: true,
          trashedAt: true,
          transferOf: true,
          encryption: true,
        },
      },
      folder: { select: { id: true, name: true, createdAt: true, trashedAt: true } },
    },
  });
  const now = Date.now();
  return rows
    .filter((r) => (r.file ? !r.file.trashedAt && r.file.transferOf == null : r.folder && !r.folder.trashedAt))
    .map((r) => ({
      id: String(r.id),
      permission: r.permission,
      expiresAt: r.expiresAt,
      sharedAt: r.createdAt,
      by: r.sender ? r.sender.name || r.sender.email : "Someone",
      locked: !!r.passwordHash && !(r.unlockedUntil && r.unlockedUntil.getTime() > now),
      hasPassword: !!r.passwordHash,
      password: reveal(r.passwordSealed), // you're the recipient: you may see it
      file: r.file
        ? {
            id: String(r.file.id),
            name: r.file.name,
            size: Number(r.file.size),
            mime: r.file.mime,
            status: r.file.status,
            createdAt: r.file.createdAt,
            backend: r.file.backend,
            encrypted: r.file.encryption != null,
          }
        : null,
      folder: r.folder ? { id: String(r.folder.id), name: r.folder.name, createdAt: r.folder.createdAt } : null,
    }));
}

/** Passwords of shares you received, by share id (used to show them in your notifications). */
export async function passwordsFor(uid: string, shareIds: string[]) {
  if (!shareIds.length) return new Map<string, string>();
  const rows = await prisma.share.findMany({
    where: { id: { in: shareIds.map(big) }, sharedWith: big(uid), passwordSealed: { not: null } },
    select: { id: true, passwordSealed: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    const p = reveal(r.passwordSealed);
    if (p) out.set(String(r.id), p);
  }
  return out;
}

// Brute-force guard: at most 5 wrong passwords per share per 10 minutes (per server process).
const g = globalThis as unknown as { tgdUnlockFails?: Map<string, { n: number; at: number }> };
const fails = (g.tgdUnlockFails ??= new Map());
const FAIL_WINDOW = 10 * 60_000;

/** Returns { ok, file? } — for an encrypted file, its unwrapped key so the route can unlock it too. */
export async function unlockShare(
  uid: string,
  id: string,
  password: unknown,
): Promise<{ ok: true; file?: { id: string; key: Buffer } }> {
  const s = await prisma.share.findUnique({
    where: { id: big(id) },
    select: { id: true, sharedWith: true, passwordHash: true, expiresAt: true, fileId: true, keyWrap: true },
  });
  if (!s || String(s.sharedWith) !== uid) throw new HttpError(404, "Share not found");
  if (s.expiresAt && s.expiresAt.getTime() <= Date.now()) throw new HttpError(410, "This share has expired");
  if (!s.passwordHash) return { ok: true };
  const f = fails.get(id);
  if (f && Date.now() - f.at < FAIL_WINDOW && f.n >= 5) {
    throw new HttpError(429, "Too many wrong passwords. Try again in a few minutes.");
  }
  if (typeof password !== "string" || !(await verifyPassword(password, s.passwordHash))) {
    const cur = f && Date.now() - f.at < FAIL_WINDOW ? f : { n: 0, at: Date.now() };
    fails.set(id, { n: cur.n + 1, at: cur.at });
    throw new HttpError(403, "Wrong password");
  }
  fails.delete(id);
  await prisma.share.update({
    where: { id: s.id },
    data: { unlockedUntil: new Date(Date.now() + UNLOCK_HOURS * 3_600_000) },
  });
  const slot = asSlot(s.keyWrap);
  const key = slot && s.fileId != null ? await unwrapKey(slot, password) : null;
  return key && s.fileId != null ? { ok: true, file: { id: String(s.fileId), key } } : { ok: true };
}
