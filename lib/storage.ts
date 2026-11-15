// Where new uploads go.
//
// Each user has a default (users.default_storage, changed from the web app):
//   "gdrive"            Google account with the most free space; Telegram if no Google account can take it
//   "gdrive:<account>"  that Google account only
//   "telegram"          Telegram
//   "r2"                Cloudflare R2 (only ever used when chosen explicitly)
import { big, prisma } from "./db";
import { googleConfigured } from "./google";
import { HttpError } from "./http";

export type Target = { backend: "telegram" | "r2" | "gdrive"; accountId: string | null; auto: boolean };

export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export function parseTarget(v: unknown): Target {
  const s = typeof v === "string" ? v : "";
  if (s === "telegram") return { backend: "telegram", accountId: null, auto: false };
  if (s === "r2") return { backend: "r2", accountId: null, auto: false };
  if (s === "gdrive") return { backend: "gdrive", accountId: null, auto: true };
  const m = /^gdrive:(\d+)$/.exec(s);
  if (m) return { backend: "gdrive", accountId: m[1], auto: false };
  throw new HttpError(400, "Unknown storage target");
}

export async function getDefaultStorage(uid: string) {
  const u = await prisma.user.findUnique({ where: { id: big(uid) }, select: { defaultStorage: true } });
  return u?.defaultStorage || "gdrive";
}

export async function setDefaultStorage(uid: string, value: unknown) {
  const t = parseTarget(value);
  if (t.accountId) {
    const n = await prisma.googleAccount.count({ where: { id: big(t.accountId), userId: big(uid) } });
    if (!n) throw new HttpError(404, "Google account not found");
  }
  await prisma.user.update({ where: { id: big(uid) }, data: { defaultStorage: String(value) } });
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
  if (!googleConfigured()) {
    if (target.auto && telegramConfigured()) return withTelegram();
    throw new HttpError(400, "Google Drive is not set up on this server");
  }
  try {
    return await withGoogle();
  } catch (e) {
    const noRoom = e instanceof HttpError && [400, 409, 507].includes(e.status);
    if (target.auto && noRoom && telegramConfigured()) return withTelegram();
    throw e;
  }
}
