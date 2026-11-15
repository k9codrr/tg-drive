// Minimal Telegram Bot API client used as the storage backend.
// Credentials come from a storage connection (lib/connections.ts) or, by default, from the environment.
const API = "https://api.telegram.org";

export type TelegramCreds = { botToken: string; chatId: string };

export class TelegramRateLimit extends Error {
  constructor(public retryAfter: number) {
    super(`Telegram rate limit: retry after ${retryAfter}s`);
  }
}

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** The server's own bot (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) unless a connection's creds are given. */
const credsOf = (c?: TelegramCreds | null): TelegramCreds =>
  c ?? { botToken: env("TELEGRAM_BOT_TOKEN"), chatId: env("TELEGRAM_CHAT_ID") };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(creds: TelegramCreds, method: string, body: () => BodyInit, json = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/bot${creds.botToken}/${method}`, {
      method: "POST",
      body: body(),
      headers: json ? { "Content-Type": "application/json" } : undefined,
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) return data.result as T;

    const retryAfter = Number(data?.parameters?.retry_after ?? 0);
    if (res.status === 429 && retryAfter) {
      // Short waits are absorbed here; long ones are passed back to the browser.
      if (retryAfter <= 10 && attempt < 2) {
        await sleep(retryAfter * 1000 + 250);
        continue;
      }
      throw new TelegramRateLimit(retryAfter);
    }
    throw new Error(`Telegram ${method} failed: ${data?.description ?? `HTTP ${res.status}`}`);
  }
}

/** Upload one chunk as a document. Returns ids needed to fetch/delete it later. */
export async function sendChunk(data: Uint8Array, filename: string, conn?: TelegramCreds | null) {
  const c = credsOf(conn);
  const result = await call<{ message_id: number; document?: { file_id: string } }>(
    c,
    "sendDocument",
    () => {
      const form = new FormData();
      form.append("chat_id", c.chatId);
      form.append("disable_notification", "true");
      form.append(
        "document",
        new Blob([new Uint8Array(data)], { type: "application/octet-stream" }),
        filename,
      );
      return form;
    },
  );
  if (!result.document) throw new Error("Telegram did not return a document");
  return { fileId: result.document.file_id, messageId: result.message_id };
}

/** Download a chunk's bytes (Bot API allows up to 20 MB per file; chunks are 4 MB). */
export async function fetchChunk(fileId: string, conn?: TelegramCreds | null): Promise<Buffer> {
  const c = credsOf(conn);
  const f = await call<{ file_path?: string }>(
    c,
    "getFile",
    () => JSON.stringify({ file_id: fileId }),
    true,
  );
  if (!f.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`${API}/file/bot${c.botToken}/${f.file_path}`);
  if (!res.ok) throw new Error(`Telegram download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort delete of stored messages (errors are logged, not thrown). */
export async function deleteMessages(ids: number[], conn?: TelegramCreds | null) {
  if (!ids.length) return;
  const c = credsOf(conn);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      await call(
        c,
        "deleteMessages",
        () => JSON.stringify({ chat_id: c.chatId, message_ids: batch }),
        true,
      );
    } catch (e) {
      console.warn("deleteMessages failed (ignored):", e);
    }
  }
}

/** Checks a bot can post to (and delete from) the chat: used when someone adds a Telegram connection. */
export async function testTelegram(c: TelegramCreds) {
  const me = await call<{ username?: string }>(c, "getMe", () => "{}", true);
  const sent = await sendChunk(new TextEncoder().encode("TG Drive connection test"), "tgdrive-test.txt", c);
  await deleteMessages([sent.messageId], c);
  return { bot: me.username ? `@${me.username}` : "bot" };
}
