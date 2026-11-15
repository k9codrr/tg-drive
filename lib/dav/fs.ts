// Path ⇄ database mapping for the WebDAV drive. A path is a list of names under the user's root.
import type { Prisma } from "@prisma/client";
import { big, prisma } from "../db";
import { personal } from "../space";
import { trashFiles, trashFolder } from "../trash";

export const fileSelect = {
  id: true,
  name: true,
  size: true,
  mime: true,
  backend: true,
  chunkSize: true,
  chunkCount: true,
  gdAccountId: true,
  gdFileId: true,
  createdAt: true,
  updatedAt: true,
  encryption: true, // password-encrypted files can't be read on the PC drive
} satisfies Prisma.FileSelect;

export type FileNode = { kind: "file" } & Prisma.FileGetPayload<{ select: typeof fileSelect }>;
export type FolderNode = { kind: "folder"; id: bigint | null; name: string; createdAt: Date; updatedAt: Date };
export type Node = FileNode | FolderNode;

const ROOT: FolderNode = { kind: "folder", id: null, name: "", createdAt: new Date(0), updatedAt: new Date(0) };

// Short-lived cache of folder path → id (every path lookup would otherwise walk the tree in the DB).
// Kept on globalThis so the web API (bundled separately by Next) clears the same cache the DAV server reads.
const g = globalThis as unknown as { tgdFolderCache?: Map<string, { id: bigint; at: number }> };
const folderCache = (g.tgdFolderCache ??= new Map());
const FOLDER_CACHE_MS = 15_000;
export function clearFolderCache() {
  folderCache.clear();
}

/** Folder id for a path ([] = root → null). undefined when it doesn't exist. */
export async function folderIdFor(uid: string, segs: string[]): Promise<bigint | null | undefined> {
  let parent: bigint | null = null;
  for (let i = 0; i < segs.length; i++) {
    const key = `${uid}/${segs.slice(0, i + 1).join("/")}`;
    const hit = folderCache.get(key);
    if (hit && Date.now() - hit.at < FOLDER_CACHE_MS) {
      parent = hit.id;
      continue;
    }
    const f: { id: bigint } | null = await prisma.folder.findFirst({
      where: { userId: big(uid), teamId: null, parentId: parent, name: segs[i], trashedAt: null },
      select: { id: true },
    });
    if (!f) return undefined;
    folderCache.set(key, { id: f.id, at: Date.now() });
    parent = f.id;
  }
  return parent;
}

/** The folder or file at a path, or null. If several files share a name, the newest wins. */
export async function resolve(uid: string, segs: string[]): Promise<Node | null> {
  if (!segs.length) return ROOT;
  const parent = await folderIdFor(uid, segs.slice(0, -1));
  if (parent === undefined) return null;
  const name = segs[segs.length - 1];
  const folder = await prisma.folder.findFirst({
    where: { userId: big(uid), teamId: null, parentId: parent, name, trashedAt: null },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  if (folder) return { kind: "folder", ...folder };
  const file = await prisma.file.findFirst({
    where: { userId: big(uid), teamId: null, folderId: parent, name, status: "ready", trashedAt: null, transferOf: null },
    orderBy: { createdAt: "desc" },
    select: fileSelect,
  });
  return file ? { kind: "file", ...file } : null;
}

/** Contents of a folder (only finished files; one entry per name). */
export async function children(uid: string, folderId: bigint | null): Promise<Node[]> {
  const [folders, files] = await Promise.all([
    prisma.folder.findMany({
      where: { userId: big(uid), teamId: null, parentId: folderId, trashedAt: null },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    }),
    prisma.file.findMany({
      where: { userId: big(uid), teamId: null, folderId, status: "ready", trashedAt: null, transferOf: null },
      orderBy: { createdAt: "desc" },
      select: fileSelect,
    }),
  ]);
  const out: Node[] = folders.map((f) => ({ kind: "folder" as const, ...f }));
  const taken = new Set(folders.map((f) => f.name));
  for (const f of files) {
    if (taken.has(f.name)) continue;
    taken.add(f.name);
    out.push({ kind: "file", ...f });
  }
  return out;
}

/**
 * "Deletes" from the drive by moving to the trash (restorable from the web app for 30 days): a file
 * (and older copies with the same name) or a whole folder tree.
 */
export async function deleteNode(uid: string, parentId: bigint | null, node: Node) {
  if (node.kind === "file") {
    const same = await prisma.file.findMany({
      where: { userId: big(uid), teamId: null, folderId: parentId, name: node.name, trashedAt: null, transferOf: null },
      select: { id: true },
    });
    await trashFiles(
      personal(uid),
      same.map((f) => f.id),
    );
    return;
  }
  if (node.id == null) throw new Error("Cannot delete the root");
  await trashFolder(personal(uid), node.id);
}

/** True if `folderId` is `ancestorId` or somewhere inside it. */
export async function isInside(folderId: bigint | null, ancestorId: bigint) {
  let p = folderId;
  for (let guard = 0; p != null && guard < 1000; guard++) {
    if (p === ancestorId) return true;
    const row: { parentId: bigint | null } | null = await prisma.folder.findUnique({
      where: { id: p },
      select: { parentId: true },
    });
    p = row?.parentId ?? null;
  }
  return false;
}

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", html: "text/html", css: "text/css", csv: "text/csv",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", json: "application/json",
  xml: "application/xml", pdf: "application/pdf", zip: "application/zip", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFor(name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}
