// IP allow lists for the WebDAV server: single addresses or CIDR ranges, IPv4 and IPv6.
//   "203.0.113.7", "198.51.100.0/24", "2001:db8::/32", "::1"
import { isIP } from "node:net";

type Rule = { v: 4 | 6; net: bigint; bits: number };

function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const kind = isIP(ip);
  if (kind === 4) return { v: 4, n: ip.split(".").reduce((a, p) => (a << BigInt(8)) + BigInt(Number(p)), BigInt(0)) };
  if (kind !== 6) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return toBig(mapped[1]);
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << BigInt(16)) + BigInt(parseInt(g || "0", 16)), BigInt(0)) };
}

/** Parses "a, b/24, c" (commas, spaces or new lines). Throws a readable error for a bad entry. */
export function parseAllowList(text: string | null | undefined): Rule[] {
  const out: Rule[] = [];
  for (const raw of (text ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [addr, bitsStr] = raw.split("/");
    const ip = toBig(addr);
    if (!ip) throw new Error(`“${raw}” is not an IP address or range`);
    const max = ip.v === 4 ? 32 : 128;
    const bits = bitsStr == null ? max : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`“${raw}” has a bad prefix length`);
    const shift = BigInt(max - bits);
    out.push({ v: ip.v, bits, net: (ip.n >> shift) << shift });
  }
  return out;
}

/** True if the list is empty (no restriction) or the address matches an entry. */
export function ipAllowed(ip: string, rules: Rule[]) {
  if (!rules.length) return true;
  const a = toBig(ip);
  if (!a) return false;
  return rules.some((r) => {
    if (r.v !== a.v) return false;
    const shift = BigInt((a.v === 4 ? 32 : 128) - r.bits);
    return (a.n >> shift) << shift === r.net;
  });
}

/** Normalises an entered list (validated) for storage, or null when empty. */
export function cleanAllowList(v: unknown): string | null {
  const text = typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : "";
  parseAllowList(text);
  const list = text.split(/[\s,]+/).filter(Boolean);
  return list.length ? list.join(", ").slice(0, 2000) : null;
}

/**
 * The client's address. Proxy headers are only believed when DAV_TRUST_PROXY says a proxy is in front:
 *   "cloudflare" → CF-Connecting-IP (Cloudflare Tunnel / proxy), "true" → first X-Forwarded-For entry.
 * Otherwise anyone could claim any address in a header.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketIp: string | undefined) {
  const trust = process.env.DAV_TRUST_PROXY;
  const h = (k: string) => {
    const v = headers[k];
    return (Array.isArray(v) ? v[0] : v)?.trim();
  };
  let ip: string | undefined;
  if (trust === "cloudflare") ip = h("cf-connecting-ip");
  else if (trust === "true") ip = h("x-forwarded-for")?.split(",")[0]?.trim();
  ip ||= socketIp || "";
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}
