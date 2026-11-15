import { NextResponse } from "next/server";
import { fail, readJson } from "@/lib/http";
import { ROLE_INFO, ROLES } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import { createTeam, myTeams } from "@/lib/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/teams → { teams: yours with your role, invites: waiting for you, roles: what each role can do }
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json({ ...(await myTeams(uid)), roles: ROLES.map((r) => ({ role: r, ...ROLE_INFO[r] })) });
  } catch (e) {
    return fail(e);
  }
}

// POST /api/teams { name } → new team; you are its owner
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json(await createTeam(uid, (await readJson(req)).name));
  } catch (e) {
    return fail(e);
  }
}
