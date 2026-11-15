// S3-compatible object storage: Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO, ... Used by the
// server's own R2 (lib/r2.ts, from the environment) and by S3 storage connections (lib/connections.ts).
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

export type S3Config = {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com, https://s3.eu-west-1.amazonaws.com, ...
  region: string; // "auto" for R2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "path" = endpoint/bucket/key (R2, MinIO, B2); "virtual" = bucket.endpoint/key (AWS default). */
  style: "path" | "virtual";
  prefix?: string; // optional folder inside the bucket
};

const clients = new Map<string, AwsClient>();
function client(c: S3Config) {
  const k = `${c.accessKeyId}:${c.region}`;
  let cl = clients.get(k);
  if (!cl) {
    cl = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: "s3", region: c.region || "auto" });
    clients.set(k, cl);
  }
  return cl;
}

function bucketUrl(c: S3Config) {
  const ep = new URL(c.endpoint);
  return c.style === "virtual"
    ? `${ep.protocol}//${c.bucket}.${ep.host}`
    : `${ep.protocol}//${ep.host}/${encodeURIComponent(c.bucket)}`;
}

function objectUrl(c: S3Config, key: string) {
  const full = c.prefix ? `${c.prefix.replace(/^\/+|\/+$/g, "")}/${key}` : key;
  return `${bucketUrl(c)}/${full.split("/").map(encodeURIComponent).join("/")}`;
}

export async function s3Put(c: S3Config, key: string, data: Uint8Array) {
  const body = new Uint8Array(data);
  // Sign, then send the raw bytes ourselves: aws4fetch re-wraps the body as a stream, which goes out
  // chunked (no Content-Length) and R2 rejects it with 411.
  const signed = await client(c).sign(objectUrl(c, key), {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!res.ok) throw new Error(`S3 upload failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
}

export async function s3Get(c: S3Config, key: string): Promise<Buffer> {
  const res = await client(c).fetch(objectUrl(c, key));
  if (!res.ok) throw new Error(`S3 download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort delete (errors are logged, not thrown). DeleteObjects: up to 1000 keys per request. */
export async function s3Delete(c: S3Config, keys: string[]) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      await deleteMany(c, batch);
    } catch (e) {
      console.warn("S3 bulk delete failed, deleting one by one:", e);
      for (let j = 0; j < batch.length; j += 32) {
        const results = await Promise.allSettled(
          batch.slice(j, j + 32).map((k) => client(c).fetch(objectUrl(c, k), { method: "DELETE" })),
        );
        for (const r of results) if (r.status === "rejected") console.warn("S3 delete failed (ignored):", r.reason);
      }
    }
  }
}

async function deleteMany(c: S3Config, keys: string[]) {
  const xmlEsc = (k: string) => k.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const full = (k: string) => (c.prefix ? `${c.prefix.replace(/^\/+|\/+$/g, "")}/${k}` : k);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>` +
    keys.map((k) => `<Object><Key>${xmlEsc(full(k))}</Key></Object>`).join("") +
    `</Delete>`;
  const md5 = createHash("md5").update(body).digest("base64");
  const res = await client(c).fetch(`${bucketUrl(c)}/?delete`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/xml", "Content-MD5": md5 },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  const errors = (text.match(/<Error>/g) ?? []).length;
  if (errors) console.warn(`S3 delete: ${errors} of ${keys.length} objects failed (ignored)`);
}

/** Writes, reads back and deletes a small object: used when someone adds an S3 connection. */
export async function testS3(c: S3Config) {
  const key = `tgdrive-test-${Date.now()}.txt`;
  const data = new TextEncoder().encode("TG Drive connection test");
  await s3Put(c, key, data);
  const back = await s3Get(c, key);
  await s3Delete(c, [key]);
  if (!back.equals(Buffer.from(data))) throw new Error("The test file came back different");
}
