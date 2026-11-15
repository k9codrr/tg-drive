import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Optional AES-256-GCM encryption of every chunk before it reaches Telegram.
// Layout: [12-byte IV][ciphertext][16-byte auth tag]

function key(): Buffer | null {
  const k = process.env.ENCRYPTION_KEY;
  return k ? createHash("sha256").update(k).digest() : null;
}

export function encryptionEnabled() {
  return !!process.env.ENCRYPTION_KEY;
}

export function encrypt(data: Buffer): Buffer {
  const k = key();
  if (!k) throw new Error("ENCRYPTION_KEY is not set");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]);
}

// ---- Sealing small secrets (Google tokens) in the DB, keyed off SESSION_SECRET ----
function tokenKey() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return createHash("sha256").update(`tokens:${s}`).digest();
}

export function sealString(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString("base64");
}

export function openString(sealed: string): string {
  const data = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", tokenKey(), data.subarray(0, 12));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]).toString("utf8");
}

export function decrypt(data: Buffer): Buffer {
  const k = key();
  if (!k) throw new Error("This file is encrypted but ENCRYPTION_KEY is not set");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(12, data.length - 16);
  const d = createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
