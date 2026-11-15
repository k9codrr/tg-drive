import { NextResponse, type NextRequest } from "next/server";
import { authUrl, googleConfigured, STATE_COOKIE } from "@/lib/google";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/google/connect → sends the user to Google's account picker / consent screen
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?gerror=Google%20login%20is%20not%20configured", req.url));
  }
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authUrl(state, req.nextUrl.origin));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
