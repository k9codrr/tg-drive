// Team roles and what each one may do. This file is the single source of truth: API routes call
// can()/canManage() and the UI shows ROLE_INFO, so the two can't drift apart.
//
//              view  upload  edit own  edit others  move storage  delete forever  invite  manage team  delete team
//   owner       ✓      ✓        ✓          ✓             ✓              ✓             ✓         ✓            ✓
//   admin       ✓      ✓        ✓          ✓             ✓              ✓             ✓         ✓
//   manager     ✓      ✓        ✓          ✓             ✓                            ✓
//   member      ✓      ✓        ✓
//   viewer      ✓
//
// "edit" = rename, move, star, put in the trash and restore. Invites and role changes only go to roles
// below your own (see canManage); only the owner can hand over ownership.

export const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const RANK: Record<Role, number> = { owner: 5, admin: 4, manager: 3, member: 2, viewer: 1 };

export type Action =
  | "view" // list, open in the viewer
  | "download" // save a copy
  | "share" // share an item with someone (your own items; anyone's needs editAny too)
  | "upload" // add files and folders
  | "editOwn" // rename/move/trash/restore items you created
  | "editAny" // the same for anyone's items
  | "moveStorage" // move bytes between Telegram / Google / R2
  | "deleteForever" // delete anyone's items for good, empty the team trash
  | "invite" // invite people, change roles of / remove members below you
  | "manageTeam" // rename the team
  | "deleteTeam";

const MIN_ROLE: Record<Action, Role> = {
  view: "viewer",
  download: "viewer",
  share: "member",
  upload: "member",
  editOwn: "member",
  editAny: "manager",
  moveStorage: "manager",
  deleteForever: "admin",
  invite: "manager",
  manageTeam: "admin",
  deleteTeam: "owner",
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export const can = (role: Role, action: Action) => RANK[role] >= RANK[MIN_ROLE[action]];

/**
 * May `actor` give someone the role `next`? `current` is that person's role now (null for a new invite).
 * You can only act on people below you and only hand out roles below yours; the owner can also make
 * someone else owner (handing over ownership).
 */
export function canManage(actor: Role, current: Role | null, next: Role | null) {
  if (!can(actor, "invite")) return false;
  if (current && RANK[current] >= RANK[actor]) return false;
  if (next == null) return true; // removing
  if (next === "owner") return actor === "owner";
  return RANK[next] < RANK[actor];
}

export const ROLE_INFO: Record<Role, { label: string; summary: string }> = {
  owner: { label: "Owner", summary: "Everything, including deleting the team and handing over ownership." },
  admin: { label: "Admin", summary: "Manage members and the team, delete anything for good." },
  manager: { label: "Manager", summary: "Edit and organise everyone's files, invite members and viewers." },
  member: { label: "Member", summary: "Upload, and edit or delete what they added. See everything." },
  viewer: { label: "Viewer", summary: "Open and download only." },
};

// ---------- Sharing one file or folder with a person ----------
// A share gives one person access to one item (a folder: everything inside it too), whatever space it's in.

export const SHARE_PERMS = ["view", "download", "edit", "full"] as const;
export type SharePerm = (typeof SHARE_PERMS)[number];
export const SHARE_RANK: Record<SharePerm, number> = { view: 1, download: 2, edit: 3, full: 4 };
export const isSharePerm = (v: unknown): v is SharePerm =>
  typeof v === "string" && (SHARE_PERMS as readonly string[]).includes(v);

export const SHARE_INFO: Record<SharePerm, { label: string; summary: string }> = {
  view: { label: "View", summary: "Open and preview in the browser. No download buttons." },
  download: { label: "View & download", summary: "Open, preview and download." },
  edit: {
    label: "Edit",
    summary: "Also rename, move and trash items, and (in a folder) upload and create folders.",
  },
  full: { label: "Full access", summary: "Everything Edit allows, plus sharing it with others." },
};

/** What a share permission allows. Deleting for good, storage moves and team settings never come with a share. */
const SHARE_MIN: Record<Action, SharePerm | null> = {
  view: "view",
  download: "download",
  upload: "edit",
  editOwn: "edit",
  editAny: "edit",
  share: "full",
  moveStorage: null,
  deleteForever: null,
  invite: null,
  manageTeam: null,
  deleteTeam: null,
};
export const shareAllows = (perm: SharePerm, action: Action) => {
  const min = SHARE_MIN[action];
  return min != null && SHARE_RANK[perm] >= SHARE_RANK[min];
};
