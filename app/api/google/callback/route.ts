import { NextResponse, type NextRequest } from "next/server";
import { openString, sealString } from "@/lib/crypto";
import { big, prisma } from "@/lib/db";
import {
  appUrl,
  createFolder,
  exchangeCode,
  fetchQuota,
  STATE_COOKIE,
  userInfo,
} from "@/lib/google";
import { can } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { teamRole } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/google/callback?code=…&state=… → saves the connected Google account
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const back = (query: string) => {
    const res = NextResponse.redirect(`${appUrl(origin)}/?${query}`);
    res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  try {
    const uid = await requireUser(req);
    const p = req.nextUrl.searchParams;
    if (p.get("error")) return back(`gerror=${encodeURIComponent(p.get("error")!)}`);
    const code = p.get("code");
    const state = p.get("state");
    if (!code || !state || state !== req.cookies.get(STATE_COOKIE)?.value) {
      return back("gerror=Login%20expired%2C%20please%20try%20again");
    }

    // "<uuid>.t<teamId>" = connecting a team account; check the user is still an admin there.
    const teamMatch = /\.t(\d+)$/.exec(state);
    const teamId = teamMatch ? big(teamMatch[1]) : null;
    if (teamId) {
      const m = await teamRole(uid, teamId);
      if (!m || !can(m.role, "manageTeam")) return back("gerror=Only%20team%20admins%20can%20connect%20team%20storage");
    }

    const tokens = await exchangeCode(code, origin);
    const profile = await userInfo(tokens.access_token);
    const email = profile.email.toLowerCase();
    // Private accounts are unique per (user, email), team accounts per (team, email).
    const where = teamId ? { teamId, email } : { userId: big(uid), teamId: null, email };
    const existing = await prisma.googleAccount.findFirst({
      where,
      select: { id: true, refreshToken: true, rootFolderId: true },
    });

    const refresh = tokens.refresh_token ?? (existing ? openString(existing.refreshToken) : null);
    if (!refresh) {
      return back(
        "gerror=" +
          encodeURIComponent(
            "Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
          ),
      );
    }

    const rootFolder = existing?.rootFolderId || (await createFolder(tokens.access_token, "TG Drive"));
    const quota = await fetchQuota(tokens.access_token);

    const fields = {
      name: profile.name ?? null,
      refreshToken: sealString(refresh),
      accessToken: sealString(tokens.access_token),
      accessExpires: new Date(Date.now() + tokens.expires_in * 1000),
      rootFolderId: rootFolder,
      quotaLimit: quota.limit == null ? null : BigInt(quota.limit),
      quotaUsage: BigInt(quota.usage),
      quotaUpdatedAt: new Date(),
      needsReauth: false,
    };
    if (existing) await prisma.googleAccount.update({ where: { id: existing.id }, data: fields });
    else await prisma.googleAccount.create({ data: { userId: big(uid), teamId, email, ...fields } });

    return back(`connected=${encodeURIComponent(email)}${teamId ? `&team=${teamId}` : ""}`);
  } catch (e) {
    console.error(e);
    return back(`gerror=${encodeURIComponent(e instanceof Error ? e.message : "Google login failed")}`);
  }
}
