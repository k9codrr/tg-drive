import { NextResponse } from "next/server";
import { addConnection, listForUser, serverStore } from "@/lib/connections";
import { fail, readJson } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/connections → your own storage connections, the ones your teams offer you, and what the
// server itself provides (used when you have nothing of your own)
export async function GET(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json({
      ...(await listForUser(uid)),
      server: { telegram: !!serverStore("telegram"), s3: !!serverStore("s3") },
    });
  } catch (e) {
    return fail(e);
  }
}

// POST /api/connections { kind: telegram|s3|webdav, name?, config, teamId?, offerToMembers?, limitGB? }
//   config: telegram { botToken, chatId } · s3 { endpoint, region, bucket, accessKeyId, secretAccessKey,
//   style: path|virtual, prefix? } · webdav { url, username, password }
// The connection is tested first (a small file is written, read and deleted); nothing is saved if it fails.
// With teamId it belongs to that team (team admins only).
export async function POST(req: Request) {
  try {
    const uid = await requireUser(req);
    return NextResponse.json(await addConnection(uid, await readJson(req)));
  } catch (e) {
    return fail(e);
  }
}
