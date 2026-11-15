import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { fail, HttpError, readJson } from "@/lib/http";
import { verifyPassword } from "@/lib/password";
import { setSession } from "@/lib/session";

export const runtime = "nodejs";

// POST /api/auth/login { email, password }
export async function POST(req: Request) {
  try {
    if (!process.env.SESSION_SECRET) throw new HttpError(500, "Server not configured: set SESSION_SECRET");
    const body = await readJson(req);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const [user] = email
      ? [await prisma.user.findUnique({ where: { email } })]
      : [];
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!ok || !user) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      throw new HttpError(401, "Wrong email or password");
    }

    const res = NextResponse.json({
      ok: true,
      user: { id: String(user.id), email: user.email, name: user.name ?? null },
    });
    await setSession(res, String(user.id));
    return res;
  } catch (e) {
    return fail(e);
  }
}
