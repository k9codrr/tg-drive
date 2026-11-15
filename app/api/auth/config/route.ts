import { NextResponse } from "next/server";
import { signupPolicy } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/auth/config → whether the login page should offer sign-up / an invite-code field
export async function GET() {
  return NextResponse.json({ signup: signupPolicy() });
}
