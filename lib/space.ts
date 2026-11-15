// Spaces: every file and folder is either in a user's private space (team_id NULL, user_id = owner) or
// in a team's space (team_id set, user_id = whoever created it). Every API route resolves the space
// first and filters with spaceWhere()/spaceSql(), so a query can never reach another space's items.
//
// Access to an item comes from (1) owning the private space, (2) team membership (role), or (3) a share
// of that item or a folder above it (share permission). In case 3 the Space carries `share`, and
// requireCan() checks the share permission instead of a role.
import { Prisma } from "@prisma/client";
import { big, prisma } from "./db";
import { HttpError } from "./http";
import { type Action, can, isRole, isSharePerm, type Role, SHARE_INFO, SHARE_RANK, shareAllows, type SharePerm } from "./rbac";

export type ShareGrant = {
  shareId: string;
  permission: SharePerm;
  root: { kind: "file" | "folder"; id: bigint };
  by: string; // who shared it
};

/** `uid` = the person acting; `owner` = whose private space it is (differs when acting through a share). */
export type Space = (
  | { kind: "personal"; uid: string; owner: string }
  | { kind: "team"; uid: string; teamId: bigint; role: Role; name: string }
) & { share?: ShareGrant };

export const personal = (uid: string): Space => ({ kind: "personal", uid, owner: uid });

/** The user's role in a team, or null if they're not a member. */
export async function teamRole(uid: string, teamId: bigint) {
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: big(uid) } },
    select: { role: true, team: { select: { name: true } } },
  });
  if (!m || !isRole(m.role)) return null;
  return { role: m.role, name: m.team.name };
}

async function teamSpace(uid: string, teamId: bigint): Promise<Space> {
  const m = await teamRole(uid, teamId);
  // Not a member: answer like the team doesn't exist.
  if (!m) throw new HttpError(404, "Team not found");
  return { kind: "team", uid, teamId, role: m.role, name: m.name };
}

/** Space from a request parameter: empty/"me" = private, a numeric id = that team. */
export async function spaceFor(uid: string, team: unknown): Promise<Space> {
  if (team == null || team === "" || team === "me") return personal(uid);
  const s = String(team);
  if (!/^\d+$/.test(s)) throw new HttpError(400, "Invalid team");
  return teamSpace(uid, BigInt(s));
}

/** Prisma filter for the items of a space. */
export function spaceWhere(space: Space) {
  return space.kind === "personal" ? { userId: big(space.owner), teamId: null } : { teamId: space.teamId };
}

/** The same filter in raw SQL (for recursive CTEs). `t` is an optional table alias. */
export function spaceSql(space: Space, t?: string) {
  const col = (c: string) => Prisma.raw(t ? `${t}.${c}` : c);
  return space.kind === "personal"
    ? Prisma.sql`${col("user_id")} = ${big(space.owner)} AND ${col("team_id")} IS NULL`
    : Prisma.sql`${col("team_id")} = ${space.teamId}`;
}

/**
 * Fields for creating an item in a space. In a private space the owner owns everything (also what a
 * share recipient adds); in a team, user_id records who created it.
 */
export function spaceData(space: Space) {
  return space.kind === "personal"
    ? { userId: big(space.owner), teamId: null }
    : { userId: big(space.uid), teamId: space.teamId };
}

/** Throws 403 unless the space allows the action (your own private space allows everything). */
export function requireCan(space: Space, action: Action) {
  if (space.share) {
    if (!shareAllows(space.share.permission, action)) {
      throw new HttpError(403, `This was shared with you as “${SHARE_INFO[space.share.permission].label}”, which doesn't allow this`);
    }
    return;
  }
  if (space.kind === "personal") return;
  if (!can(space.role, action)) {
    throw new HttpError(403, `Your role in ${space.name} (${space.role}) doesn't allow this`);
  }
}

const isCreator = (space: Space, creatorId: bigint | null) => creatorId != null && String(creatorId) === space.uid;

/** Editing an item: your own needs editOwn, someone else's needs editAny. */
export function requireEdit(space: Space, creatorId: bigint | null) {
  requireCan(space, isCreator(space, creatorId) ? "editOwn" : "editAny");
}

/** Deleting for good: your own items as for editing, anyone's needs deleteForever. */
export function requireDeleteForever(space: Space, creatorId: bigint | null) {
  requireCan(space, isCreator(space, creatorId) ? "editOwn" : "deleteForever");
}

/** The item someone shared with you can only be renamed, moved or trashed with Full access. */
export function requireNotShareRoot(space: Space, kind: "file" | "folder", id: bigint | string) {
  const root = space.share?.root;
  if (root && root.kind === kind && root.id === big(id)) requireCan(space, "share");
}

// ---------- shares ----------

type ShareRow = {
  id: bigint;
  permission: string;
  file_id: bigint | null;
  folder_id: bigint | null;
  has_password: boolean;
  unlocked_until: Date | null;
  by_name: string | null;
  by_email: string | null;
};

/**
 * The best share giving `uid` access to a file (fileId + its folder) or a folder: shares of the item
 * itself or of any folder above it, not expired. A password-protected share only counts once unlocked;
 * if that's all there is, a 423 tells the client which share to unlock.
 */
async function findShare(uid: string, fileId: bigint | null, folderId: bigint | null): Promise<ShareGrant | null> {
  const rows = await prisma.$queryRaw<ShareRow[]>`
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM folders WHERE id = ${folderId}
      UNION ALL
      SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
    )
    SELECT s.id, s.permission, s.file_id, s.folder_id, s.password_hash IS NOT NULL AS has_password,
           s.unlocked_until, u.name AS by_name, u.email AS by_email
    FROM shares s LEFT JOIN users u ON u.id = s.shared_by
    WHERE s.shared_with = ${big(uid)}
      AND (s.expires_at IS NULL OR s.expires_at > now())
      AND (s.file_id = ${fileId} OR s.folder_id IN (SELECT id FROM up))`;
  if (!rows.length) return null;
  const now = Date.now();
  const usable = rows
    .filter((r) => isSharePerm(r.permission))
    .filter((r) => !r.has_password || (r.unlocked_until && r.unlocked_until.getTime() > now))
    .sort((a, b) => SHARE_RANK[b.permission as SharePerm] - SHARE_RANK[a.permission as SharePerm]);
  const best = usable[0];
  if (!best) {
    const locked = rows[0];
    throw new HttpError(423, "This share is protected with a password. Enter it to open it.", {
      locked: true,
      shareId: String(locked.id),
    });
  }
  return {
    shareId: String(best.id),
    permission: best.permission as SharePerm,
    root: best.file_id != null ? { kind: "file", id: best.file_id } : { kind: "folder", id: best.folder_id! },
    by: best.by_name || best.by_email || "Someone",
  };
}

/** Space of an existing item (by its user_id/team_id), checking the user may see it. */
async function spaceOfItem(
  uid: string,
  item: { userId: bigint | null; teamId: bigint | null; trashedAt: Date | null },
  what: string,
  share: () => Promise<ShareGrant | null>,
): Promise<Space> {
  if (item.teamId != null) {
    const m = await teamRole(uid, item.teamId);
    if (m) return { kind: "team", uid, teamId: item.teamId, role: m.role, name: m.name };
  } else if (item.userId != null && String(item.userId) === uid) {
    return personal(uid);
  }
  // Not yours and not your team's: maybe it was shared with you (never while in the trash).
  const grant = item.trashedAt ? null : await share();
  if (!grant) throw new HttpError(404, `${what} not found`);
  return item.teamId != null
    ? { kind: "team", uid, teamId: item.teamId, role: "viewer", name: "", share: grant }
    : { kind: "personal", uid, owner: String(item.userId), share: grant };
}

/** Loads a file the user can see, with its space. Checks `action` (view by default). */
export async function fileAccess(uid: string, id: string | bigint, action: Action | "edit" = "view") {
  const file = await prisma.file.findUnique({
    where: { id: big(id) },
    select: { id: true, userId: true, teamId: true, transferOf: true, folderId: true, trashedAt: true },
  });
  if (!file || file.transferOf != null) throw new HttpError(404, "File not found");
  const space = await spaceOfItem(uid, file, "File", () => findShare(uid, file.id, file.folderId));
  if (action === "edit") {
    requireEdit(space, file.userId);
    requireNotShareRoot(space, "file", file.id);
  } else requireCan(space, action);
  return { space, file };
}

/** Loads a folder the user can see, with its space. Checks `action` (view by default). */
export async function folderAccess(
  uid: string,
  id: string | bigint,
  action: Action | "edit" = "view",
  opts: { live?: boolean } = {},
) {
  const folder = await prisma.folder.findUnique({
    where: { id: big(id) },
    select: { id: true, userId: true, teamId: true, trashedAt: true },
  });
  if (!folder || (opts.live && folder.trashedAt)) throw new HttpError(404, "Folder not found");
  const space = await spaceOfItem(uid, folder, "Folder", () => findShare(uid, null, folder.id));
  if (action === "edit") {
    requireEdit(space, folder.userId);
    requireNotShareRoot(space, "folder", folder.id);
  } else requireCan(space, action);
  return { space, folder };
}

/** True if folder `id` is `rootId` or somewhere inside it. */
async function folderWithin(id: bigint, rootId: bigint) {
  const [row] = await prisma.$queryRaw<{ ok: boolean }[]>`
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM folders WHERE id = ${id}
      UNION ALL
      SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${rootId}) AS ok`;
  return !!row?.ok;
}

/**
 * Whether a folder is in this space, not in the trash, and (when acting through a share) inside the
 * shared folder, so a recipient can't move things somewhere they can't see.
 */
export async function folderInSpace(space: Space, id: string | bigint) {
  const n = await prisma.folder.count({ where: { id: big(id), ...spaceWhere(space), trashedAt: null } });
  if (!n) return false;
  const root = space.share?.root;
  if (!root) return true;
  return root.kind === "folder" && folderWithin(big(id), root.id);
}

/** Find-or-create a folder by name inside parent (null = the space's root). */
export async function ensureFolderIn(space: Space, parentId: string | null, name: string): Promise<string> {
  const live = { ...spaceWhere(space), parentId: parentId == null ? null : big(parentId), name, trashedAt: null };
  const found = await prisma.folder.findFirst({ where: live, select: { id: true } });
  if (found) return String(found.id);
  try {
    const created = await prisma.folder.create({
      data: { ...spaceData(space), parentId: parentId == null ? null : big(parentId), name },
      select: { id: true },
    });
    return String(created.id);
  } catch (e) {
    // Created by a parallel request in the meantime (unique folder-name indexes).
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const again = await prisma.folder.findFirst({ where: live, select: { id: true } });
    if (!again) throw new Error("Could not create folder");
    return String(again.id);
  }
}

/** For JSON responses: what the client needs to know about the space (and the share, if any). */
export function spaceOut(space: Space) {
  if (space.share) {
    return {
      shared: {
        permission: space.share.permission,
        by: space.share.by,
        rootKind: space.share.root.kind,
        rootId: String(space.share.root.id),
      },
    };
  }
  return space.kind === "personal" ? null : { id: String(space.teamId), name: space.name, role: space.role };
}

/**
 * Deleting/trashing a team folder you created is "editing your own item" — unless it contains things
 * other people added. Then it needs the right to edit anyone's items, so a member can't remove other
 * members' files by deleting the folder around them. (Through a share, Edit covers everything inside.)
 */
export async function requireFolderRemoval(space: Space, folderId: bigint, creatorId: bigint | null, forever: boolean) {
  if (forever) requireDeleteForever(space, creatorId);
  else requireEdit(space, creatorId);
  requireNotShareRoot(space, "folder", folderId);
  if (space.share || space.kind === "personal" || can(space.role, forever ? "deleteForever" : "editAny")) return;
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
    WITH RECURSIVE tree AS (
      SELECT id, user_id FROM folders WHERE id = ${folderId}
      UNION ALL
      SELECT f.id, f.user_id FROM folders f JOIN tree t ON f.parent_id = t.id
    )
    SELECT (SELECT count(*) FROM tree WHERE user_id IS DISTINCT FROM ${big(space.uid)})
         + (SELECT count(*) FROM files WHERE folder_id IN (SELECT id FROM tree)
              AND user_id IS DISTINCT FROM ${big(space.uid)}) AS n`;
  if (Number(row?.n ?? 0) > 0) {
    throw new HttpError(403, "This folder contains items other people added. Ask a manager or admin to delete it.");
  }
}
