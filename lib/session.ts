import type { NextResponse } from "next/server";
import { COOKIE, createToken, readCookie, SESSION_DAYS, verifyToken } from "./auth";
import { HttpError } from "./http";

/** User id from the session cookie, or a 401 error. Call at the top of every API route. */
export async function requireUser(req: Request): Promise<string> {
  const uid = await verifyToken(readCookie(req.headers.get("cookie"), COOKIE));
  if (!uid) throw new HttpError(401, "Not signed in");
  return uid;
}

export async function setSession(res: NextResponse, userId: string) {
  res.cookies.set(COOKIE, await createToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSession(res: NextResponse) {
  res.cookies.set(COOKIE, "", { path: "/", maxAge: 0 });
}

export function signupPolicy() {
  return {
    allowed: process.env.ALLOW_SIGNUP !== "false",
    needsCode: !!process.env.SIGNUP_CODE,
  };
}
