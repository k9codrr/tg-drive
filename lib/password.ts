import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

// scrypt password hashing: "scrypt$N$r$p$salt$hash" (base64)
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, Number(n), Number(r), Number(p));
  return got.length === expected.length && timingSafeEqual(got, expected);
}
