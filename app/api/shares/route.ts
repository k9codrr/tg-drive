import { NextResponse, type NextRequest } from "next/server";
import { fail, readJson } from "@/lib/http";
import { SHARE_INFO, SHARE_PERMS } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { createShare, itemOf, sharesOf } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/shares?file=<id> | ?folder=<id> → who it's shared with (needs the right to share it)
export async function GET(req: NextRequest) {
  try {
    const uid = await requireUser(req);
    const sp = req.nextUrl.searchParams;
    const item = itemOf({ file: sp.get("file") ?? undefined, folder: sp.get("folder") ?? undefined });
    return NextResponse.json({
      shares: await sharesOf(uid, item),
      permissions: SHARE_PERMS.map((p) => ({ permission: p, ...SHARE_INFO[p] })),
    });
  } catch (e) {
    return fail(e);
  }
}

// POST /api/shares { file | folder, email, permission: view|download|edit|full, password?, expiresAt? }
// Shares with an existing account (sharing again with the same person updates their share).
// The recipient gets an in-app notification, with the password if one is set.
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json(await createShare(uid, await readJson(req)));
  } catch (e) {
    return fail(e);
  }
}
