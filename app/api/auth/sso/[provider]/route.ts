import { NextResponse, type NextRequest } from "next/server";
import { provider, SSO_COOKIE, startLogin } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only same-site paths, so the sign-in can't be used to redirect somewhere else. */
const safeNext = (v: string | null) => (v && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : "/");

// GET /api/auth/sso/<google|microsoft|oidc>[?next=/path] → off to the provider's sign-in page
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const p = provider((await params).provider);
    const { url, cookie } = await startLogin(p, req.nextUrl.origin, safeNext(req.nextUrl.searchParams.get("next")));
    const res = NextResponse.redirect(url);
    res.cookies.set(SSO_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // must survive the provider's redirect back to us
      path: "/api/auth/sso",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const m = e instanceof Error ? e.message : "Sign-in failed";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(m)}`, req.url));
  }
}
