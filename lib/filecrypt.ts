// Per-file password encryption.
//
// Each encrypted file has its own random 256-bit key (the "file key"). The bytes are encrypted with
// AES-256-CTR under that key before they are stored anywhere (Telegram, R2, Google Drive). CTR keeps
// the size and byte offsets unchanged, so chunked uploads, Google resumable uploads, range requests and
// video seeking work exactly as for plain files. (Telegram/R2 chunks are additionally sealed with
// ENCRYPTION_KEY using AES-GCM when that's set, which also detects tampering there; Google Drive copies
// have no such check.)
//
// The file key is never stored as is: only wrapped (AES-256-GCM) with a key derived from a password by
// scrypt — the owner's password ("owner" slot), and one per share of the file (shares.key_wrap, with
// the share's password). Without one of those passwords nobody can read the bytes, including someone
// with the database and the server secret.
//
// While you use a file, the server needs its key. After you enter a password, the key is handed to your
// browser in an HttpOnly cookie, sealed with the server secret, only sent to that file's URLs
// (/api/files/<id>/…), and valid for UNLOCK_SECONDS. "Lock" deletes it.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import type { NextResponse } from "next/server";
import { readCookie } from "./auth";
import { openString, sealString } from "./crypto";
import { HttpError } from "./http";

export const UNLOCK_SECONDS = 60 * 60;
const KEY_COOKIE = "tgdk";
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

export type Slot = { kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; key: string };
export type FileEnc = {
  v: 1;
  alg: "aes-256-ctr";
  nonce: string; // 16 bytes, base64: the CTR start block
  slots: { owner: Slot };
  /** Only on a copy being written by an encrypt/re-key move: its key, sealed with the server key. */
  pending?: string;
};

export function asFileEnc(v: unknown): FileEnc | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Partial<FileEnc>;
  return e.v === 1 && e.alg === "aes-256-ctr" && typeof e.nonce === "string" && e.slots?.owner ? (e as FileEnc) : null;
}

export function asSlot(v: unknown): Slot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<Slot>;
  return s.kdf === "scrypt" && s.salt && s.iv && s.key ? (s as Slot) : null;
}

function kdf(password: string, salt: Buffer, s: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCb(password.normalize("NFC"), salt, 32, { ...s, maxmem: 128 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export function checkNewPassword(v: unknown): string {
  const p = typeof v === "string" ? v : "";
  if (p.length < 8 || p.length > 200) throw new HttpError(400, "Use a password of 8 to 200 characters");
  return p;
}

/** Wraps a file key with a password. */
export async function wrapKey(fileKey: Buffer, password: string): Promise<Slot> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await kdf(password, salt, SCRYPT);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const wrapped = Buffer.concat([c.update(fileKey), c.final(), c.getAuthTag()]);
  return { kdf: "scrypt", ...SCRYPT, salt: salt.toString("base64"), iv: iv.toString("base64"), key: wrapped.toString("base64") };
}

/** The file key, or null if the password is wrong. */
export async function unwrapKey(slot: Slot, password: string): Promise<Buffer | null> {
  const kek = await kdf(password, Buffer.from(slot.salt, "base64"), slot);
  const data = Buffer.from(slot.key, "base64");
  try {
    const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(slot.iv, "base64"));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

/** New encryption settings for a file: a fresh key, wrapped with the owner's password. */
export async function newFileEnc(password: string) {
  const key = randomBytes(32);
  const enc: FileEnc = {
    v: 1,
    alg: "aes-256-ctr",
    nonce: randomBytes(16).toString("base64"),
    slots: { owner: await wrapKey(key, password) },
  };
  return { key, enc };
}

/** Encrypts or decrypts (CTR is symmetric) `data` that sits at byte `offset` of the file. */
export function ctr(key: Buffer, enc: FileEnc, offset: number, data: Buffer): Buffer {
  if (!data.length) return data;
  const block = BigInt(Math.floor(offset / 16));
  const start = BigInt(`0x${Buffer.from(enc.nonce, "base64").toString("hex")}`);
  const counter = (start + block) % (BigInt(1) << BigInt(128));
  const iv = Buffer.from(counter.toString(16).padStart(32, "0"), "hex");
  const c = createCipheriv("aes-256-ctr", key, iv);
  const skip = offset % 16;
  if (skip) c.update(Buffer.alloc(skip));
  return Buffer.concat([c.update(data), c.final()]);
}

// ---------- the unlock cookie ----------

const cookiePath = (fileId: string | bigint) => `/api/files/${fileId}`;

/** Gives the browser the file's key for an hour (see the top of this file). */
export function setKeyCookie(res: NextResponse, uid: string, fileId: string | bigint, key: Buffer) {
  const value = sealString(JSON.stringify({ u: uid, f: String(fileId), k: key.toString("base64"), e: Date.now() + UNLOCK_SECONDS * 1000 }));
  res.cookies.set(KEY_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: cookiePath(fileId),
    maxAge: UNLOCK_SECONDS,
  });
}

export function clearKeyCookie(res: NextResponse, fileId: string | bigint) {
  res.cookies.set(KEY_COOKIE, "", { path: cookiePath(fileId), maxAge: 0 });
}

/** The file key from the request's unlock cookie, or null (not unlocked, expired, or someone else's). */
export function keyFromRequest(req: Request, uid: string, fileId: string | bigint): Buffer | null {
  const raw = readCookie(req.headers.get("cookie"), KEY_COOKIE);
  if (!raw) return null;
  try {
    const v = JSON.parse(openString(raw)) as { u: string; f: string; k: string; e: number };
    if (v.u !== uid || v.f !== String(fileId) || v.e < Date.now()) return null;
    return Buffer.from(v.k, "base64");
  } catch {
    return null;
  }
}

/** The key needed to read/write an encrypted file; 423 (with { encrypted: true }) if it isn't unlocked. */
export function requireKey(req: Request, uid: string, fileId: string | bigint): Buffer {
  const k = keyFromRequest(req, uid, fileId);
  if (!k) throw new HttpError(423, "This file is encrypted. Enter its password to open it.", { locked: true, encrypted: true, fileId: String(fileId) });
  return k;
}

/** Key of a copy being written by an encrypt/re-key move (sealed in its row while the move runs). */
export function pendingKey(enc: FileEnc): Buffer {
  if (!enc.pending) throw new Error("No pending key");
  return Buffer.from(openString(enc.pending), "base64");
}
export const sealPending = (key: Buffer) => sealString(key.toString("base64"));
