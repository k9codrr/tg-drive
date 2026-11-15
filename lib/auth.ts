// Session tokens "<userId>.<expiry>.<hmac>" signed with SESSION_SECRET.
// Uses Web Crypto only, so it also runs in middleware (edge runtime).
export const COOKIE = "tgd_session";
export const SESSION_DAYS = 30;
const enc = new TextEncoder();

async function hmac(message: string): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function createToken(userId: string, days = SESSION_DAYS) {
  const exp = Date.now() + days * 24 * 60 * 60 * 1000;
  return `${userId}.${exp}.${await hmac(`session:${userId}:${exp}`)}`;
}

/** Returns the user id if the token is valid, otherwise null. */
export async function verifyToken(token?: string | null): Promise<string | null> {
  try {
    if (!token) return null;
    const [uid, exp, sig] = token.split(".");
    if (!uid || !/^\d+$/.test(uid) || !exp || !sig || Number(exp) < Date.now()) return null;
    return safeEqual(sig, await hmac(`session:${uid}:${exp}`)) ? uid : null;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
