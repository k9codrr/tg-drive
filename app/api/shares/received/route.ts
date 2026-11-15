import { NextResponse } from "next/server";
import { fail } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { receivedShares } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/shares/received → files and folders shared with you ("Shared with me")
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json({ shares: await receivedShares(uid) });
  } catch (e) {
    return fail(e);
  }
}
