import { NextResponse } from "next/server";
import { signupPolicy } from "@/lib/session";
import { passwordLoginEnabled, providers } from "@/lib/sso";

export const dynamic = "force-dynamic";

// GET /api/auth/config → what the login page offers: sign-up / invite code, password sign-in, SSO buttons
export async function GET() {
  return NextResponse.json({
    signup: signupPolicy(),
    password: passwordLoginEnabled(),
    sso: providers().map((p) => ({ id: p.id, name: p.name })),
  });
}
