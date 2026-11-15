// Storage target labels and <option> lists, shared by the drive and the PC drive screen.
import { formatBytes, type Pool } from "./lib";

const KIND_LABEL = { telegram: "Telegram", s3: "S3", webdav: "WebDAV" } as const;

export function storageLabel(v: string, pool: Pool | null) {
  if (v === "telegram") return "Telegram";
  if (v === "r2" || v === "s3") return "S3 / R2";
  if (v === "webdav") return "WebDAV";
  if (v === "gdrive") return "Google Drive";
  const conn = /^conn:(\d+)$/.exec(v);
  if (conn) {
    const c = [...(pool?.connections?.mine ?? []), ...(pool?.connections?.offered ?? [])].find((x) => x.id === conn[1]);
    return c ? `${KIND_LABEL[c.kind]}: ${c.name}` : "a storage connection";
  }
  const id = v.replace(/^gdrive:/, "");
  const acct = pool?.google.find((g) => g.id === id) ?? pool?.offeredGoogle?.find((g) => g.id === id);
  return acct ? `Google Drive (${acct.email})` : "Google Drive";
}

/**
 * Upload targets. The generic ones ("Telegram", "S3 / R2", "WebDAV") pick your own connection of that
 * kind, else one a team offers you, else the server's; the specific ones pin a single place.
 */
export function StorageOptions({ pool, current }: { pool: Pool | null; current: string }) {
  const google = pool?.google ?? [];
  const offeredGoogle = pool?.offeredGoogle ?? [];
  const conns = [...(pool?.connections?.mine ?? []), ...(pool?.connections?.offered ?? [])];
  const hasS3 = !!pool?.r2.configured || conns.some((c) => c.kind === "s3");
  const hasDav = conns.some((c) => c.kind === "webdav");
  const known = [
    "gdrive",
    "telegram",
    ...(hasS3 ? ["r2"] : []),
    ...(hasDav ? ["webdav"] : []),
    ...google.map((g) => `gdrive:${g.id}`),
    ...offeredGoogle.map((g) => `gdrive:${g.id}`),
    ...conns.map((c) => `conn:${c.id}`),
  ];
  const free = (n: number | null) => (n == null ? "unlimited" : `${formatBytes(n)} free`);
  return (
    <>
      <option value="gdrive">Google Drive (most free space)</option>
      {google.map((g) => (
        <option key={g.id} value={`gdrive:${g.id}`} disabled={g.needsReauth}>
          Google: {g.email} ({g.needsReauth ? "reconnect needed" : free(g.free)})
        </option>
      ))}
      {offeredGoogle.map((g) => (
        <option key={g.id} value={`gdrive:${g.id}`}>
          Google ({g.team ?? "team"}): {g.email} ({free(g.free)})
        </option>
      ))}
      <option value="telegram">Telegram (best available)</option>
      {hasS3 && <option value="r2">S3 / R2 (best available)</option>}
      {hasDav && <option value="webdav">WebDAV (best available)</option>}
      {conns.map((c) => (
        <option key={c.id} value={`conn:${c.id}`}>
          {KIND_LABEL[c.kind]}: {c.name}
          {c.teamName ? ` (${c.teamName})` : ""}
        </option>
      ))}
      {!known.includes(current) && <option value={current}>{storageLabel(current, pool)}</option>}
    </>
  );
}
