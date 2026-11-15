// Teams: members, roles, invites. Permission rules live in rbac.ts; this file applies them.
import type { Prisma } from "@prisma/client";
import { purgeStorage } from "./cleanup";
import { big, isUniqueViolation, prisma } from "./db";
import { HttpError } from "./http";
import { can, canManage, isRole, type Role, ROLE_INFO } from "./rbac";
import { type Space, spaceFor } from "./space";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- notifications ----------

export async function notify(
  userId: bigint | string,
  kind: string,
  title: string,
  body?: string | null,
  data?: Prisma.InputJsonValue,
) {
  await prisma.notification
    .create({ data: { userId: big(userId), kind, title, body: body ?? null, data } })
    .catch((e) => console.warn("[notify] failed:", e));
}

const nameOf = (u: { name: string | null; email: string } | null | undefined) => (u ? u.name || u.email : "Someone");

// ---------- helpers ----------

async function teamSpace(uid: string, teamId: string): Promise<Extract<Space, { kind: "team" }>> {
  const s = await spaceFor(uid, teamId);
  if (s.kind !== "team") throw new HttpError(400, "Not a team");
  return s;
}

function requireTeamCan(s: Extract<Space, { kind: "team" }>, action: Parameters<typeof can>[1]) {
  if (!can(s.role, action)) throw new HttpError(403, `Your role (${ROLE_INFO[s.role].label}) doesn't allow this`);
}

function cleanTeamName(v: unknown) {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n || n.length > 80) throw new HttpError(400, "Give the team a name (up to 80 characters)");
  return n;
}

function parseRole(v: unknown): Role {
  if (!isRole(v)) throw new HttpError(400, "Unknown role");
  return v;
}

async function me(uid: string) {
  const u = await prisma.user.findUnique({ where: { id: big(uid) }, select: { name: true, email: true } });
  if (!u) throw new HttpError(401, "Account not found");
  return u;
}

// ---------- reading ----------

/** Teams you're in, and invites waiting for you. */
export async function myTeams(uid: string) {
  const user = await me(uid);
  const [memberships, invites] = await Promise.all([
    prisma.teamMember.findMany({
      where: { userId: big(uid) },
      orderBy: { createdAt: "asc" },
      select: { role: true, team: { select: { id: true, name: true, _count: { select: { members: true } } } } },
    }),
    prisma.teamInvite.findMany({
      where: { email: user.email.toLowerCase() },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        createdAt: true,
        team: { select: { id: true, name: true } },
        inviter: { select: { name: true, email: true } },
      },
    }),
  ]);
  return {
    teams: memberships.map((m) => ({
      id: String(m.team.id),
      name: m.team.name,
      role: m.role,
      members: m.team._count.members,
    })),
    invites: invites.map((i) => ({
      id: String(i.id),
      role: i.role,
      createdAt: i.createdAt,
      team: { id: String(i.team.id), name: i.team.name },
      invitedBy: nameOf(i.inviter),
    })),
  };
}

/** Members (and, for people who may invite, pending invites) of a team. */
export async function teamDetail(uid: string, teamId: string) {
  const s = await teamSpace(uid, teamId);
  const [members, invites, usage, team] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId: s.teamId },
      orderBy: { createdAt: "asc" },
      select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true } } },
    }),
    can(s.role, "invite")
      ? prisma.teamInvite.findMany({
          where: { teamId: s.teamId },
          orderBy: { createdAt: "desc" },
          select: { id: true, email: true, role: true, createdAt: true, inviter: { select: { name: true, email: true } } },
        })
      : Promise.resolve([]),
    prisma.file.aggregate({
      where: { teamId: s.teamId, status: "ready", trashedAt: null, transferOf: null },
      _count: { _all: true },
      _sum: { size: true },
    }),
    prisma.team.findUnique({ where: { id: s.teamId }, select: { ssoDomain: true, ssoRole: true } }),
  ]);
  return {
    id: String(s.teamId),
    sso: { domain: team?.ssoDomain ?? null, role: team?.ssoRole ?? "member" },
    name: s.name,
    role: s.role,
    stats: { files: usage._count._all, bytes: Number(usage._sum.size ?? 0) },
    members: members.map((m) => ({
      userId: String(m.user.id),
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt,
      you: String(m.user.id) === uid,
    })),
    invites: invites.map((i) => ({
      id: String(i.id),
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      invitedBy: nameOf(i.inviter),
    })),
  };
}

// ---------- team ----------

export async function createTeam(uid: string, name: unknown) {
  const n = cleanTeamName(name);
  const team = await prisma.team.create({
    data: { name: n, createdBy: big(uid), members: { create: { userId: big(uid), role: "owner" } } },
    select: { id: true },
  });
  return { id: String(team.id), name: n };
}

/** Rename and/or set team sync (SSO domain + role for people who join through it). Admins only. */
export async function updateTeam(uid: string, teamId: string, body: Record<string, unknown>) {
  const s = await teamSpace(uid, teamId);
  requireTeamCan(s, "manageTeam");
  if ("name" in body) await prisma.team.update({ where: { id: s.teamId }, data: { name: cleanTeamName(body.name) } });
  if ("ssoDomain" in body || "ssoRole" in body) {
    const cur = await prisma.team.findUnique({ where: { id: s.teamId }, select: { ssoDomain: true, ssoRole: true } });
    const { setTeamSso } = await import("./sso");
    await setTeamSso(
      (await me(uid)).email,
      s.teamId,
      "ssoDomain" in body ? body.ssoDomain : cur?.ssoDomain,
      "ssoRole" in body ? body.ssoRole : cur?.ssoRole,
    );
  }
}

/** Deletes the team and everything stored in it (all files, also in its trash), for good. */
export async function deleteTeam(uid: string, teamId: string) {
  const s = await teamSpace(uid, teamId);
  requireTeamCan(s, "deleteTeam");
  const [files, members] = await Promise.all([
    prisma.file.findMany({ where: { teamId: s.teamId }, select: { id: true } }),
    prisma.teamMember.findMany({ where: { teamId: s.teamId, userId: { not: big(uid) } }, select: { userId: true } }),
  ]);
  await purgeStorage(files.map((f) => String(f.id)));
  await prisma.team.delete({ where: { id: s.teamId } }); // members, invites, folders, files cascade
  const by = nameOf(await me(uid));
  await Promise.all(members.map((m) => notify(m.userId, "team.deleted", `${by} deleted the team ${s.name}`)));
}

// ---------- invites ----------

export async function invite(uid: string, teamId: string, emailIn: unknown, roleIn: unknown) {
  const s = await teamSpace(uid, teamId);
  const email = typeof emailIn === "string" ? emailIn.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email");
  const role = parseRole(roleIn ?? "member");
  if (role === "owner") throw new HttpError(400, "Invite them first, then hand over ownership");
  if (!canManage(s.role, null, role)) {
    throw new HttpError(403, `As ${ROLE_INFO[s.role].label} you can't invite someone as ${ROLE_INFO[role].label}`);
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    const already = await prisma.teamMember.count({ where: { teamId: s.teamId, userId: existing.id } });
    if (already) throw new HttpError(409, "They're already in this team");
  }
  let row;
  try {
    row = await prisma.teamInvite.create({
      data: { teamId: s.teamId, email, role, invitedBy: big(uid) },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "That email already has an invite to this team");
    throw e;
  }
  // People who already have an account get an in-app notification; others see the invite when they
  // sign up with that email.
  if (existing) {
    const by = nameOf(await me(uid));
    await notify(existing.id, "team.invite", `${by} invited you to ${s.name}`, `Role: ${ROLE_INFO[role].label}`, {
      teamId: String(s.teamId),
      inviteId: String(row.id),
    });
  }
  return { id: String(row.id), email, role, hasAccount: !!existing };
}

export async function cancelInvite(uid: string, teamId: string, inviteId: string) {
  const s = await teamSpace(uid, teamId);
  const inv = await prisma.teamInvite.findFirst({ where: { id: big(inviteId), teamId: s.teamId }, select: { role: true } });
  if (!inv) throw new HttpError(404, "Invite not found");
  if (!canManage(s.role, isRole(inv.role) ? inv.role : "viewer", null) && !can(s.role, "manageTeam")) {
    throw new HttpError(403, "You can't cancel this invite");
  }
  await prisma.teamInvite.delete({ where: { id: big(inviteId) } });
}

/** Accept or decline an invite addressed to your email. */
export async function answerInvite(uid: string, inviteId: string, accept: boolean) {
  const user = await me(uid);
  const inv = await prisma.teamInvite.findUnique({
    where: { id: big(inviteId) },
    select: { id: true, teamId: true, email: true, role: true, invitedBy: true, team: { select: { name: true } } },
  });
  if (!inv || inv.email !== user.email.toLowerCase()) throw new HttpError(404, "Invite not found");
  if (accept) {
    const role = isRole(inv.role) && inv.role !== "owner" ? inv.role : "member";
    await prisma.$transaction([
      prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: inv.teamId, userId: big(uid) } },
        create: { teamId: inv.teamId, userId: big(uid), role },
        update: {},
      }),
      prisma.teamInvite.delete({ where: { id: inv.id } }),
    ]);
  } else {
    await prisma.teamInvite.delete({ where: { id: inv.id } });
  }
  // Mark the matching invite notification as read.
  await prisma.notification
    .updateMany({
      where: { userId: big(uid), kind: "team.invite", readAt: null, data: { path: ["inviteId"], equals: inviteId } },
      data: { readAt: new Date() },
    })
    .catch(() => {});
  if (inv.invitedBy != null) {
    await notify(
      inv.invitedBy,
      accept ? "team.joined" : "team.declined",
      `${nameOf(user)} ${accept ? "joined" : "declined your invite to"} ${inv.team.name}`,
      null,
      { teamId: String(inv.teamId) },
    );
  }
  return { teamId: String(inv.teamId), accepted: accept };
}

// ---------- members ----------

export async function changeRole(uid: string, teamId: string, memberId: string, roleIn: unknown) {
  const s = await teamSpace(uid, teamId);
  const next = parseRole(roleIn);
  if (memberId === uid) throw new HttpError(400, "You can't change your own role");
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: s.teamId, userId: big(memberId) } },
    select: { role: true },
  });
  if (!m || !isRole(m.role)) throw new HttpError(404, "Member not found");
  if (!canManage(s.role, m.role, next)) {
    throw new HttpError(403, `As ${ROLE_INFO[s.role].label} you can't make a ${ROLE_INFO[m.role].label} a ${ROLE_INFO[next].label}`);
  }
  if (next === "owner") {
    // Handing over ownership: there's always exactly one owner; you become an admin.
    await prisma.$transaction([
      prisma.teamMember.update({ where: { teamId_userId: { teamId: s.teamId, userId: big(memberId) } }, data: { role: "owner" } }),
      prisma.teamMember.update({ where: { teamId_userId: { teamId: s.teamId, userId: big(uid) } }, data: { role: "admin" } }),
    ]);
  } else {
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: s.teamId, userId: big(memberId) } }, data: { role: next } });
  }
  const by = nameOf(await me(uid));
  await notify(memberId, "team.role", `${by} made you ${ROLE_INFO[next].label} in ${s.name}`, ROLE_INFO[next].summary, {
    teamId: String(s.teamId),
  });
}

/**
 * Removes a member (or yourself: leaving). Their uploads stay in the team. Files stay stored where they
 * were uploaded — e.g. in that person's Google Drive — so they can't disconnect that Google account
 * while team files are still stored in it.
 */
export async function removeMember(uid: string, teamId: string, memberId: string) {
  const s = await teamSpace(uid, teamId);
  const self = memberId === uid;
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: s.teamId, userId: big(memberId) } },
    select: { role: true },
  });
  if (!m || !isRole(m.role)) throw new HttpError(404, "Member not found");
  if (self) {
    if (m.role === "owner") throw new HttpError(400, "Hand over ownership to someone else first, or delete the team");
  } else if (!canManage(s.role, m.role, null)) {
    throw new HttpError(403, `As ${ROLE_INFO[s.role].label} you can't remove a ${ROLE_INFO[m.role].label}`);
  }
  await prisma.teamMember.delete({ where: { teamId_userId: { teamId: s.teamId, userId: big(memberId) } } });
  if (!self) {
    const by = nameOf(await me(uid));
    await notify(memberId, "team.removed", `${by} removed you from ${s.name}`);
  }
}
