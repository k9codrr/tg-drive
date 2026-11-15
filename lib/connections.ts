// Storage people connect themselves, per user or per team:
//   telegram  a bot + a chat (channel/group) it can post to
//   s3        an S3-compatible bucket: Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO, ...
//   webdav    a folder on a WebDAV server: Nextcloud, ownCloud, Synology, a NAS, ...
// (Google accounts have their own table, google_accounts, which also has team accounts.)
//
// Which one an upload uses (resolveStore):
//   team files:     the team's own connection → the uploader's own → one the team offers → the server's
//   private files:  your own connection → one a team of yours offers to members → the server's
// "The server's" = TELEGRAM_* / R2_* in the environment, set up by whoever runs TG Drive.
//
// Credentials are sealed with SESSION_SECRET in the database and never sent to browsers.
import { openString, sealString } from "./crypto";
import { big, prisma } from "./db";
import { HttpError } from "./http";
import { r2Configured } from "./r2";
import { can } from "./rbac";
import { type S3Config, testS3 } from "./s3";
import { type Space, teamRole } from "./space";
import { type TelegramCreds, testTelegram } from "./telegram";
import { testWebdav, type WebdavConfig } from "./webdav-client";

export type ConnKind = "telegram" | "s3" | "webdav";
export const CONN_KINDS: ConnKind[] = ["telegram", "s3", "webdav"];
export type ConnConfig =
  | { kind: "telegram"; cfg: TelegramCreds }
  | { kind: "s3"; cfg: S3Config }
  | { kind: "webdav"; cfg: WebdavConfig };

/** Backend name stored on files using each kind (server-env storage: "telegram" / "r2"). */
export const BACKEND_OF: Record<ConnKind, "telegram" | "s3" | "webdav"> = { telegram: "telegram", s3: "s3", webdav: "webdav" };

const str = (v: unknown, what: string, max = 500) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > max) throw new HttpError(400, `${what} is required`);
  return s;
};

function httpsUrl(v: unknown, what: string) {
  const s = str(v, what, 1000);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${what} must be a full URL, like https://…`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && process.env.ALLOW_HTTP_STORAGE === "true")) {
    throw new HttpError(400, `${what} must start with https:// (set ALLOW_HTTP_STORAGE=true on the server to allow http)`);
  }
  return s;
}

/** Validates the form a user filled in, and returns the config plus a non-secret summary. */
export function parseConfig(kind: unknown, raw: Record<string, unknown>): { conf: ConnConfig; summary: string } {
  if (kind === "telegram") {
    const botToken = str(raw.botToken, "Bot token", 200);
    if (!/^\d+:[\w-]{20,}$/.test(botToken)) throw new HttpError(400, "That doesn't look like a bot token (123456:ABC…)");
    const chatId = str(raw.chatId, "Chat id", 100);
    if (!/^(-?\d+|@[\w]{4,})$/.test(chatId)) throw new HttpError(400, "Chat id is a number like -1001234567890, or @channelname");
    return { conf: { kind, cfg: { botToken, chatId } }, summary: `chat ${chatId}` };
  }
  if (kind === "s3") {
    const endpoint = httpsUrl(raw.endpoint, "Endpoint");
    const bucket = str(raw.bucket, "Bucket", 200);
    const cfg: S3Config = {
      endpoint,
      region: (typeof raw.region === "string" && raw.region.trim()) || "auto",
      bucket,
      accessKeyId: str(raw.accessKeyId, "Access key id", 200),
      secretAccessKey: str(raw.secretAccessKey, "Secret access key", 300),
      style: raw.style === "virtual" ? "virtual" : "path",
      prefix: typeof raw.prefix === "string" && raw.prefix.trim() ? raw.prefix.trim().replace(/^\/+|\/+$/g, "") : undefined,
    };
    return { conf: { kind, cfg }, summary: `${new URL(endpoint).host} · ${bucket}${cfg.prefix ? `/${cfg.prefix}` : ""}` };
  }
  if (kind === "webdav") {
    const url = httpsUrl(raw.url, "Folder URL");
    const cfg: WebdavConfig = { url, username: str(raw.username, "Username", 200), password: str(raw.password, "Password", 500) };
    const u = new URL(url);
    return { conf: { kind, cfg }, summary: `${u.host}${u.pathname}`.replace(/\/$/, "") };
  }
  throw new HttpError(400, "Pick telegram, s3 or webdav");
}

export async function testConnection(c: ConnConfig): Promise<string> {
  if (c.kind === "telegram") return `posted and deleted a test message as ${(await testTelegram(c.cfg)).bot}`;
  if (c.kind === "s3") {
    await testS3(c.cfg);
    return "wrote, read and deleted a test object";
  }
  await testWebdav(c.cfg);
  return "wrote, read and deleted a test file";
}

// ---------- reading configs (cached; they're needed for every chunk) ----------

const g = globalThis as unknown as { tgdConnCache?: Map<string, { conf: ConnConfig; at: number }> };
const cache = (g.tgdConnCache ??= new Map());
const CACHE_MS = 5 * 60_000;
export const forgetConnection = (id: bigint | string) => cache.delete(String(id));

/** Decrypted config of a connection (for the storage drivers). */
export async function connConfig(id: bigint | string): Promise<ConnConfig> {
  const hit = cache.get(String(id));
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.conf;
  const row = await prisma.storageConnection.findUnique({ where: { id: big(id) }, select: { kind: true, config: true } });
  if (!row) throw new Error(`Storage connection ${id} no longer exists`);
  const conf = { kind: row.kind, cfg: JSON.parse(openString(row.config)) } as ConnConfig;
  cache.set(String(id), { conf, at: Date.now() });
  return conf;
}

// ---------- who may use / manage what ----------

/** Teams the user is in, with their role. */
async function myTeams(uid: string) {
  return prisma.teamMember.findMany({ where: { userId: big(uid) }, select: { teamId: true, role: true } });
}

/** Connections usable for uploads in this space, in the order they're preferred (see the top of the file). */
async function candidates(space: Space, kind: ConnKind) {
  const uid = big(space.uid);
  const sel = { id: true, limitBytes: true, teamId: true, userId: true } as const;
  const own = () => prisma.storageConnection.findMany({ where: { kind, userId: uid, teamId: null }, select: sel, orderBy: { createdAt: "asc" } });
  const offered = async () => {
    const teams = (await myTeams(space.uid)).map((t) => t.teamId);
    if (!teams.length) return [];
    return prisma.storageConnection.findMany({
      where: { kind, teamId: { in: teams }, offerToMembers: true },
      select: sel,
      orderBy: { createdAt: "asc" },
    });
  };
  if (space.kind === "team" && !space.share) {
    const team = await prisma.storageConnection.findMany({ where: { kind, teamId: space.teamId }, select: sel, orderBy: { createdAt: "asc" } });
    return [...team, ...(await own()), ...(await offered())];
  }
  return [...(await own()), ...(await offered())];
}

async function usedBytes(connectionId: bigint) {
  const r = await prisma.file.aggregate({ where: { connectionId }, _sum: { size: true } });
  return Number(r._sum.size ?? 0);
}

export type ChunkStore = { backend: "telegram" | "r2" | "s3" | "webdav"; connectionId: bigint | null };

/** The server's own storage of that kind (environment), if it's set up. */
export function serverStore(kind: ConnKind): ChunkStore | null {
  if (kind === "telegram") return process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? { backend: "telegram", connectionId: null } : null;
  if (kind === "s3") return r2Configured() ? { backend: "r2", connectionId: null } : null;
  return null; // there is no server WebDAV storage
}

/**
 * Where an upload of `size` bytes of this kind goes in this space (see the top of the file). A specific
 * connection can be asked for with `connectionId` (it must be usable here). Null = nothing available.
 */
export async function resolveStore(space: Space, kind: ConnKind, size: number, connectionId?: string | null): Promise<ChunkStore | null> {
  const list = await candidates(space, kind);
  const pick = connectionId ? list.filter((c) => String(c.id) === connectionId) : list;
  if (connectionId && !pick.length) throw new HttpError(404, "That storage connection isn't available here");
  for (const c of pick) {
    if (c.limitBytes != null && (await usedBytes(c.id)) + size > Number(c.limitBytes)) continue;
    return { backend: BACKEND_OF[kind], connectionId: c.id };
  }
  if (connectionId) throw new HttpError(507, "That storage connection is full (its limit is reached)");
  return serverStore(kind);
}

/** May the user manage (add/change/remove) connections of this team? Admins and the owner. */
async function requireTeamAdmin(uid: string, teamId: bigint) {
  const m = await teamRole(uid, teamId);
  if (!m) throw new HttpError(404, "Team not found");
  if (!can(m.role, "manageTeam")) throw new HttpError(403, "Only team admins can manage the team's storage");
}

async function loadForManage(uid: string, id: string) {
  const row = await prisma.storageConnection.findUnique({ where: { id: big(id) }, select: { id: true, userId: true, teamId: true } });
  if (!row) throw new HttpError(404, "Connection not found");
  if (row.teamId != null) await requireTeamAdmin(uid, row.teamId);
  else if (String(row.userId) !== uid) throw new HttpError(404, "Connection not found");
  return row;
}

// ---------- listing ----------

const outSelect = {
  id: true,
  kind: true,
  name: true,
  summary: true,
  teamId: true,
  offerToMembers: true,
  limitBytes: true,
  lastError: true,
  checkedAt: true,
  createdAt: true,
  team: { select: { name: true } },
} as const;

async function out(rows: Awaited<ReturnType<typeof prisma.storageConnection.findMany<{ select: typeof outSelect }>>>) {
  const used = rows.length
    ? await prisma.file.groupBy({
        by: ["connectionId"],
        where: { connectionId: { in: rows.map((r) => r.id) } },
        _sum: { size: true },
        _count: { _all: true },
      })
    : [];
  return rows.map((r) => {
    const u = used.find((x) => x.connectionId === r.id);
    return {
      id: String(r.id),
      kind: r.kind as ConnKind,
      name: r.name,
      summary: r.summary,
      teamId: r.teamId == null ? null : String(r.teamId),
      teamName: r.team?.name ?? null,
      offerToMembers: r.offerToMembers,
      limit: r.limitBytes == null ? null : Number(r.limitBytes),
      used: Number(u?._sum.size ?? 0),
      files: u?._count._all ?? 0,
      lastError: r.lastError,
      checkedAt: r.checkedAt,
      createdAt: r.createdAt,
    };
  });
}

/** Your own connections, plus the ones your teams offer to members (usable for your private files). */
export async function listForUser(uid: string) {
  const teams = (await myTeams(uid)).map((t) => t.teamId);
  const [mine, offered] = await Promise.all([
    prisma.storageConnection.findMany({ where: { userId: big(uid), teamId: null }, select: outSelect, orderBy: { createdAt: "asc" } }),
    teams.length
      ? prisma.storageConnection.findMany({ where: { teamId: { in: teams }, offerToMembers: true }, select: outSelect, orderBy: { createdAt: "asc" } })
      : Promise.resolve([]),
  ]);
  return { mine: await out(mine), offered: await out(offered) };
}

/** A team's connections (members can see them; admins manage them). */
export async function listForTeam(uid: string, teamId: string) {
  const m = await teamRole(uid, big(teamId));
  if (!m) throw new HttpError(404, "Team not found");
  const rows = await prisma.storageConnection.findMany({ where: { teamId: big(teamId) }, select: outSelect, orderBy: { createdAt: "asc" } });
  return { canManage: can(m.role, "manageTeam"), connections: await out(rows) };
}

// ---------- add / change / remove ----------

function parseLimit(v: unknown): bigint | null {
  if (v == null || v === "") return null;
  const gb = Number(v);
  if (!Number.isFinite(gb) || gb <= 0) throw new HttpError(400, "The limit must be a positive number of GB");
  return BigInt(Math.round(gb * 1024 ** 3));
}

/** Adds a connection after testing it (a failing test is reported and nothing is saved). */
export async function addConnection(uid: string, body: Record<string, unknown>) {
  const teamId = body.teamId == null || body.teamId === "" ? null : String(body.teamId);
  if (teamId) await requireTeamAdmin(uid, big(teamId));
  const { conf, summary } = parseConfig(body.kind, (body.config ?? {}) as Record<string, unknown>);
  const name = (typeof body.name === "string" && body.name.trim().slice(0, 80)) || defaultName(conf.kind);
  let result: string;
  try {
    result = await testConnection(conf);
  } catch (e) {
    throw new HttpError(400, `Test failed, nothing saved: ${e instanceof Error ? e.message : String(e)}`);
  }
  const row = await prisma.storageConnection.create({
    data: {
      kind: conf.kind,
      name,
      userId: big(uid),
      teamId: teamId ? big(teamId) : null,
      offerToMembers: !!teamId && body.offerToMembers === true,
      config: sealString(JSON.stringify(conf.cfg)),
      summary,
      limitBytes: parseLimit(body.limitGB),
      checkedAt: new Date(),
    },
    select: { id: true },
  });
  return { id: String(row.id), test: result };
}

const defaultName = (k: ConnKind) => (k === "telegram" ? "Telegram bot" : k === "s3" ? "S3 bucket" : "WebDAV server");

/** Rename, offer to members, change the limit, or replace the credentials (tested again). */
export async function updateConnection(uid: string, id: string, body: Record<string, unknown>) {
  const row = await loadForManage(uid, id);
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 80);
  if ("offerToMembers" in body) {
    if (row.teamId == null) throw new HttpError(400, "Only team storage can be offered to members");
    data.offerToMembers = body.offerToMembers === true;
  }
  if ("limitGB" in body) data.limitBytes = parseLimit(body.limitGB);
  if (body.config && typeof body.config === "object") {
    const cur = await prisma.storageConnection.findUnique({ where: { id: row.id }, select: { kind: true } });
    const { conf, summary } = parseConfig(cur!.kind, body.config as Record<string, unknown>);
    try {
      await testConnection(conf);
    } catch (e) {
      throw new HttpError(400, `Test failed, nothing changed: ${e instanceof Error ? e.message : String(e)}`);
    }
    Object.assign(data, { config: sealString(JSON.stringify(conf.cfg)), summary, lastError: null, checkedAt: new Date() });
  }
  await prisma.storageConnection.update({ where: { id: row.id }, data });
  forgetConnection(row.id);
}

/** Runs the test again and records the result. */
export async function retestConnection(uid: string, id: string) {
  const row = await loadForManage(uid, id);
  forgetConnection(row.id);
  try {
    const result = await testConnection(await connConfig(row.id));
    await prisma.storageConnection.update({ where: { id: row.id }, data: { lastError: null, checkedAt: new Date() } });
    return { ok: true, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.storageConnection.update({ where: { id: row.id }, data: { lastError: message.slice(0, 500), checkedAt: new Date() } });
    return { ok: false, result: message };
  }
}

/** Removes a connection; refused while files are stored in it (move them to other storage first). */
export async function removeConnection(uid: string, id: string) {
  const row = await loadForManage(uid, id);
  const n = await prisma.file.count({ where: { connectionId: row.id } });
  if (n) throw new HttpError(409, `${n} file(s) are stored there. Move them to other storage first (Change storage…).`);
  await prisma.storageConnection.delete({ where: { id: row.id } });
  forgetConnection(row.id);
}
