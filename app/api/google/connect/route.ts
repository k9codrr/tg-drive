import { NextResponse, type NextRequest } from "next/server";
import { authUrl, googleConfigured, STATE_COOKIE } from "@/lib/google";
import { big } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { teamRole } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/google/connect[?team=<id>] → sends the user to Google's account picker / consent screen.
// With `team`, the account is connected to that team (team admins only).
export async function GET(req: NextRequest) {
  let uid: string;
  try {
    uid = await requireUser(req);
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const team = req.nextUrl.searchParams.get("team");
  if (team) {
    const m = /^\d+$/.test(team) ? await teamRole(uid, big(team)) : null;
    if (!m || !can(m.role, "manageTeam")) {
      return NextResponse.redirect(new URL("/?gerror=Only%20team%20admins%20can%20connect%20team%20storage", req.url));
    }
  }
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?gerror=Google%20login%20is%20not%20configured", req.url));
  }
  // The team travels in the state cookie (checked again in the callback).
  const state = team ? `${crypto.randomUUID()}.t${team}` : crypto.randomUUID();
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
