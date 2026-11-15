import { NextResponse, type NextRequest } from "next/server";
import { setSession } from "@/lib/session";
import { finishLogin, provider, signInWith, SSO_COOKIE } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const safeNext = (v: string) => (/^\/(?!\/)[^\s\\]*$/.test(v) ? v : "/");

// GET /api/auth/sso/<provider>/callback?code=…&state=… → signs you in (creating/linking the account)
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const clear = (res: NextResponse) => {
    res.cookies.set(SSO_COOKIE, "", { path: "/api/auth/sso", maxAge: 0 });
    return res;
  };
  try {
    if (!process.env.SESSION_SECRET) throw new Error("Server not configured: set SESSION_SECRET");
    const p = provider((await params).provider);
    const id = await finishLogin(p, req.nextUrl.origin, req.nextUrl.searchParams, req.cookies.get(SSO_COOKIE)?.value);
    const uid = await signInWith(p, id);
    const res = NextResponse.redirect(new URL(safeNext(id.next), req.url));
    await setSession(res, uid);
    return clear(res);
  } catch (e) {
    console.warn("[sso] sign-in failed:", e);
    const m = e instanceof Error ? e.message : "Sign-in failed";
    return clear(NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(m)}`, req.url)));
  }
}
