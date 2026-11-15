import { NextResponse } from "next/server";
import { isUniqueViolation } from "./db";
import { TelegramRateLimit } from "./telegram";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function fail(e: unknown) {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  if (e instanceof TelegramRateLimit) {
    return NextResponse.json(
      { error: e.message, retryAfter: e.retryAfter },
      { status: 429, headers: { "Retry-After": String(e.retryAfter) } },
    );
  }
  if (isUniqueViolation(e)) {
    return NextResponse.json({ error: "An item with that name already exists here" }, { status: 409 });
  }
  console.error(e);
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "Server error" },
    { status: 500 },
  );
}

/** Numeric id or null for root. Accepts "", "root", null. */
export function parseId(v: unknown): string | null {
  if (v == null || v === "" || v === "root") return null;
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new HttpError(400, "Invalid id");
  return s;
}

export function cleanName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "Name is required");
  const n = v.trim();
  if (!n || n.length > 255 || n.includes("/") || n === "." || n === "..") {
    throw new HttpError(400, "Invalid name");
  }
  return n;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
