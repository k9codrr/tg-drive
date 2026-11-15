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
import { requireUser } from "@/lib/session";

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

    const tokens = await exchangeCode(code, origin);
    const profile = await userInfo(tokens.access_token);
    const email = profile.email.toLowerCase();
    const key = { userId_email: { userId: big(uid), email } };
    const existing = await prisma.googleAccount.findUnique({
      where: key,
      select: { refreshToken: true, rootFolderId: true },
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
    await prisma.googleAccount.upsert({
      where: key,
      create: { userId: big(uid), email, ...fields },
      update: fields,
    });

    return back(`connected=${encodeURIComponent(email)}`);
  } catch (e) {
    console.error(e);
    return back(`gerror=${encodeURIComponent(e instanceof Error ? e.message : "Google login failed")}`);
  }
}
