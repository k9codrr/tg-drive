// Google OAuth + Drive v3 helpers (no SDK, plain fetch).
import { openString, sealString } from "./crypto";
import type { GoogleAccount } from "@prisma/client";
import { big, prisma } from "./db";
import { HttpError } from "./http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// drive.file = the app can only see/manage files it created (non-sensitive scope,
// no Google verification needed). about.get (storage quota) works with it.
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

export const STATE_COOKIE = "tgd_oauth_state";
const QUOTA_TTL_MS = 5 * 60 * 1000;

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new HttpError(500, `${name} is not set`);
  return v;
}

export function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function appUrl(fallbackOrigin: string) {
  return (process.env.APP_URL || fallbackOrigin).replace(/\/+$/, "");
}

export function redirectUri(fallbackOrigin: string) {
  return `${appUrl(fallbackOrigin)}/api/google/callback`;
}

export function authUrl(state: string, origin: string) {
  const p = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account", // always returns a refresh token + lets you pick another account
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function errText(res: Response) {
  const t = await res.text().catch(() => "");
  try {
    const j = JSON.parse(t);
    return j.error?.message || j.error_description || j.error || t;
  } catch {
    return t || `HTTP ${res.status}`;
  }
}

export async function exchangeCode(code: string, origin: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed: ${await errText(res)}`);
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

export async function userInfo(token: string) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Could not read Google profile: ${await errText(res)}`);
  return (await res.json()) as { email: string; name?: string };
}

export async function revokeToken(token: string) {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

/** Valid access token for an account, refreshing it when needed. */
export async function accessTokenFor(id: string): Promise<{ token: string; row: GoogleAccount }> {
  const row = await prisma.googleAccount.findUnique({ where: { id: big(id) } });
  if (!row) throw new HttpError(404, "Google account not found");

  if (row.accessToken && row.accessExpires && row.accessExpires.getTime() > Date.now() + 60_000) {
    return { token: openString(row.accessToken), row };
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: openString(row.refreshToken),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      await prisma.googleAccount.update({ where: { id: big(id) }, data: { needsReauth: true } });
      throw new HttpError(409, `Google account ${row.email} needs to be reconnected`);
    }
    throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  await prisma.googleAccount.update({
    where: { id: big(id) },
    data: {
      accessToken: sealString(data.access_token),
      accessExpires: new Date(Date.now() + Number(data.expires_in) * 1000),
      needsReauth: false,
    },
  });
  return { token: String(data.access_token), row };
}

// ---------- Drive ----------

export async function fetchQuota(token: string) {
  const res = await fetch(`${DRIVE}/about?fields=storageQuota`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read Drive quota: ${await errText(res)}`);
  const { storageQuota: q } = (await res.json()) as { storageQuota: { limit?: string; usage?: string } };
  // limit is missing for unlimited (some Workspace) accounts. usage = Drive + Gmail + Photos.
  return { limit: q.limit != null ? Number(q.limit) : null, usage: Number(q.usage ?? 0) };
}

export async function refreshQuota(id: string) {
  const { token } = await accessTokenFor(id);
  const q = await fetchQuota(token);
  await prisma.googleAccount.update({
    where: { id: big(id) },
    data: {
      quotaLimit: q.limit == null ? null : BigInt(q.limit),
      quotaUsage: BigInt(q.usage),
      quotaUpdatedAt: new Date(),
    },
  });
  return q;
}

/** Refresh quotas that are older than 5 minutes (or all, if force). Errors are swallowed. */
export async function refreshStaleQuotas(uid: string, force = false, ids?: bigint[]) {
  const rows = await prisma.googleAccount.findMany({
    where: { needsReauth: false, ...(ids ? { id: { in: ids } } : { userId: big(uid), teamId: null }) },
    select: { id: true, quotaUpdatedAt: true },
  });
  const stale = rows.filter(
    (r) => force || !r.quotaUpdatedAt || Date.now() - r.quotaUpdatedAt.getTime() > QUOTA_TTL_MS,
  );
  await Promise.allSettled(stale.map((r) => refreshQuota(String(r.id))));
}

export function freeBytes(r: Pick<GoogleAccount, "quotaLimit" | "quotaUsage">) {
  return r.quotaLimit == null ? Number.POSITIVE_INFINITY : Number(r.quotaLimit) - Number(r.quotaUsage);
}

/**
 * Google accounts an upload may use, in groups by preference: in a team's folders the team's accounts,
 * then your own, then accounts your teams offer to members; for your private files your own, then
 * offered ones. (`teamId` = the team space being uploaded to, if any.)
 */
async function accountGroups(uid: string, teamId: bigint | null) {
  const sel = { id: true, email: true, quotaLimit: true, quotaUsage: true } as const;
  const memberOf = (await prisma.teamMember.findMany({ where: { userId: big(uid) }, select: { teamId: true } })).map((m) => m.teamId);
  const [team, own, offered] = await Promise.all([
    teamId ? prisma.googleAccount.findMany({ where: { needsReauth: false, teamId }, select: sel }) : Promise.resolve([]),
    prisma.googleAccount.findMany({ where: { needsReauth: false, userId: big(uid), teamId: null }, select: sel }),
    memberOf.length
      ? prisma.googleAccount.findMany({ where: { needsReauth: false, teamId: { in: memberOf }, offerToMembers: true }, select: sel })
      : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  return [team, own, offered].map((g) => g.filter((r) => !seen.has(String(r.id)) && seen.add(String(r.id))));
}

/** Choose the account with the most free space that fits `size` (in the first group that has room). */
export async function pickAccount(uid: string, size: number, preferredId: string | null, teamId: bigint | null = null) {
  const groups = await accountGroups(uid, teamId);
  const all = groups.flat();
  await refreshStaleQuotas(uid, false, all.map((r) => r.id));
  const fresh = await prisma.googleAccount.findMany({
    where: { id: { in: all.map((r) => r.id) } },
    select: { id: true, email: true, quotaLimit: true, quotaUsage: true },
  });
  type Acct = (typeof all)[number];
  const latest = (r: Acct): Acct => fresh.find((f) => f.id === r.id) ?? r;
  let rows = all.map(latest);
  if (!preferredId) {
    // First group with an account that fits; else fall through to the "not enough space" error below.
    const group = groups.map((g) => g.map(latest)).find((g) => g.some((r) => freeBytes(r) >= size));
    if (group) rows = group;
  }
  const candidates = preferredId ? rows.filter((r) => String(r.id) === preferredId) : rows;
  if (!candidates.length) {
    throw new HttpError(400, preferredId ? "That Google account is not available" : "No Google account connected");
  }
  const best = candidates.reduce((a, b) => (freeBytes(b) > freeBytes(a) ? b : a));
  if (freeBytes(best) < size) {
    throw new HttpError(507, "Not enough free space in the connected Google account(s)");
  }
  // Reserve the space so parallel uploads don't over-fill one account.
  await prisma.googleAccount.update({
    where: { id: best.id },
    data: { quotaUsage: { increment: BigInt(size) } },
  });
  return { id: String(best.id), email: best.email };
}

export async function createFolder(token: string, name: string) {
  const res = await fetch(`${DRIVE}/files?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!res.ok) throw new Error(`Could not create Drive folder: ${await errText(res)}`);
  return String(((await res.json()) as { id: string }).id);
}

/** Starts a resumable upload session; returns the session URL. */
export async function startResumable(
  token: string,
  meta: { name: string; mime: string; size: number; parentId: string | null },
) {
  const res = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": meta.mime,
      "X-Upload-Content-Length": String(meta.size),
    },
    body: JSON.stringify({
      name: meta.name,
      mimeType: meta.mime,
      ...(meta.parentId ? { parents: [meta.parentId] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Google Drive upload init failed: ${await errText(res)}`);
  const location = res.headers.get("location");
  if (!location) throw new Error("Google Drive did not return an upload URL");
  return location;
}

type ResumableResult = { done: true; fileId: string } | { done: false; received: number };

function parseRange(h: string | null) {
  const m = h?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

async function resumableResult(res: Response): Promise<ResumableResult> {
  if (res.status === 308) return { done: false, received: parseRange(res.headers.get("range")) };
  if (res.ok) {
    const j = (await res.json()) as { id: string };
    return { done: true, fileId: String(j.id) };
  }
  throw new Error(`Google Drive upload failed (HTTP ${res.status}): ${await errText(res)}`);
}

/** Send bytes [start, start+len) of a total-size upload. Chunks must be multiples of 256 KB (except the last). */
export async function putResumable(url: string, bytes: Uint8Array, start: number, total: number) {
  const end = start + bytes.byteLength - 1;
  const res = await fetch(url, {
    method: "PUT",
    redirect: "manual", // Drive answers 308 "Resume Incomplete" — not a redirect
    headers: { "Content-Range": `bytes ${start}-${end}/${total}` },
    body: new Uint8Array(bytes),
  });
  return resumableResult(res);
}

/** Ask Drive how many bytes of a resumable upload it has. */
export async function queryResumable(url: string, total: number) {
  const res = await fetch(url, {
    method: "PUT",
    redirect: "manual",
    headers: { "Content-Range": `bytes */${total}` },
  });
  return resumableResult(res);
}

export async function downloadRange(token: string, fileId: string, start: number, end: number) {
  const res = await fetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`Google Drive download failed: ${await errText(res)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return res.status === 200 ? buf.subarray(start, end + 1) : buf;
}

/** Best-effort delete of Drive files, grouped by account. */
export async function deleteDriveFiles(items: { accountId: string; fileId: string }[]) {
  const byAccount = new Map<string, string[]>();
  for (const it of items) byAccount.set(it.accountId, [...(byAccount.get(it.accountId) ?? []), it.fileId]);
  for (const [accountId, fileIds] of byAccount) {
    try {
      const { token } = await accessTokenFor(accountId);
      for (let i = 0; i < fileIds.length; i += 5) {
        await Promise.allSettled(
          fileIds.slice(i, i + 5).map((fid) =>
            fetch(`${DRIVE}/files/${encodeURIComponent(fid)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            }),
          ),
        );
      }
      await refreshQuota(accountId).catch(() => {});
    } catch (e) {
      console.warn("Drive delete failed (ignored):", e);
    }
  }
}

/** Google answers 429 / 403 rateLimitExceeded / 5xx when busy: those are worth retrying. */
export class DriveBusy extends Error {}

/** Runs a Drive call, retrying "busy" answers and network errors with exponential backoff. */
export async function driveRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof DriveBusy || (e instanceof TypeError && /fetch/i.test(e.message));
      if (!retryable || attempt >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500));
    }
  }
}

async function driveFail(res: Response, what: string): Promise<never> {
  const text = await errText(res);
  if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota exceeded|userRateLimit/i.test(text))) {
    throw new DriveBusy(`${what}: ${text}`);
  }
  throw new Error(`${what}: ${text}`);
}

/** Uploads a whole small file in one request (multipart). Returns the Drive file id. */
export async function uploadMultipart(
  token: string,
  meta: { name: string; mime: string; parentId: string | null },
  bytes: Uint8Array,
) {
  const boundary = `tgd${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: meta.name, mimeType: meta.mime, ...(meta.parentId ? { parents: [meta.parentId] } : {}) }) +
      `\r\n--${boundary}\r\nContent-Type: ${meta.mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, Buffer.from(bytes), tail]),
  });
  if (!res.ok) await driveFail(res, "Google Drive upload failed");
  return String(((await res.json()) as { id: string }).id);
}

/**
 * Sends one piece of a resumable upload, retrying when Drive is busy. If the answer is lost, asks Drive
 * how much it has, so a piece is never sent twice. Returns the Drive file id when the upload completes.
 */
export async function putResumableSafe(url: string, bytes: Uint8Array, start: number, total: number) {
  return driveRetry(async () => {
    let result: ResumableResult;
    try {
      result = await putResumable(url, bytes, start, total);
    } catch (e) {
      const status = await queryResumable(url, total).catch(() => null);
      if (!status || (!status.done && status.received < start + bytes.byteLength)) {
        throw e instanceof Error && /HTTP (429|5\d\d)/.test(e.message) ? new DriveBusy(e.message) : e;
      }
      result = status;
    }
    return result.done ? result.fileId : null;
  });
}
