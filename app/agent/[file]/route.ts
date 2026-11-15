// GET /agent/<file> → the PC drive scripts, so a new PC can set itself up from the web app without a copy
// of this repo (the "Add this PC" command downloads install.ps1 from here, and install.ps1 fetches the rest).
// Public on purpose: the scripts contain no secrets; the device password is passed on the command line.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

const FILES = new Set(["install.ps1", "mount.ps1", "tgd.ps1", "tgd.cmd"]);

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILES.has(file)) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(join(process.cwd(), "drive-agent", file));
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
