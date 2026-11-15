import { NextResponse } from "next/server";
import { isUniqueViolation, prisma } from "@/lib/db";
import { fail, HttpError, readJson } from "@/lib/http";
import { hashPassword } from "@/lib/password";
import { setSession, signupPolicy } from "@/lib/session";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/signup { email, password, name?, code? }
export async function POST(req: Request) {
  try {
    if (!process.env.SESSION_SECRET) throw new HttpError(500, "Server not configured: set SESSION_SECRET");
    const policy = signupPolicy();
    if (!policy.allowed) throw new HttpError(403, "Sign-ups are closed");

    const body = await readJson(req);
    if (policy.needsCode && body.code !== process.env.SIGNUP_CODE) {
      throw new HttpError(403, "Invalid invite code");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : null;
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email");
    if (password.length < 8 || password.length > 200) {
      throw new HttpError(400, "Password must be at least 8 characters");
    }

    const passwordHash = await hashPassword(password);
    let userId: bigint;
    try {
      ({ id: userId } = await prisma.user.create({
        data: { email, name, passwordHash },
        select: { id: true },
      }));
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "An account with this email already exists");
      throw e;
    }
    const uid = String(userId);

    // The very first user inherits data uploaded before multi-user support existed.
    if ((await prisma.user.count()) === 1) {
      await prisma.$transaction([
        prisma.folder.updateMany({ where: { userId: null }, data: { userId } }),
        prisma.file.updateMany({ where: { userId: null }, data: { userId } }),
        prisma.googleAccount.updateMany({ where: { userId: null }, data: { userId } }),
      ]);
    }

    const res = NextResponse.json({ ok: true, user: { id: uid, email, name } });
    await setSession(res, uid);
    return res;
  } catch (e) {
    return fail(e);
  }
}
